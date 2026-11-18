import Foundation

/// One-time transactional migration (D6): back up JSON → build a temp SQLite DB → validate counts →
/// atomic switch into place → keep JSON read-only as a one-version rollback path. No long-term dual
/// write. Runs at the P1→P2 boundary; not auto-invoked during normal P1 runs.
@MainActor
enum JSONToSQLiteMigration {

    /// JSON file → SQLite collection (each top-level array element becomes a document).
    static let map: [(file: String, collection: String)] = [
        ("tasks.json", "tasks"),
        ("memories.json", "memory"),
        ("conversations.json", "conversations"),
        ("relationship.json", "relationship"),
        ("preferences.json", "preferences"),
    ]

    struct Report: Equatable { var migrated: [String: Int]; var dbPath: String }
    enum MigrationError: Error, Equatable { case validationFailed(String), io(String) }

    /// `dir` = support directory holding the JSON files; produces `deskpet.db` there.
    @discardableResult
    static func run(in dir: URL) throws -> Report {
        let fm = FileManager.default
        let finalDB = dir.appendingPathComponent("deskpet.db")
        let tempDB = dir.appendingPathComponent("deskpet.db.migrating")
        let backupDB = dir.appendingPathComponent("deskpet.db.pre-migration-backup")
        try? fm.removeItem(at: tempDB)

        // Expected counts + content hashes straight from the JSON arrays.
        // Unreadable-but-existing JSON is a hard error (fail closed) rather than
        // silently skipped — otherwise `expected` would be empty and an empty DB
        // would "validate" (vacuum-pass data loss).
        var expected: [String: Int] = [:]
        var expectedHash: [String: UInt64] = [:]
        var payloads: [(collection: String, docs: [String])] = []
        for entry in map {
            let url = dir.appendingPathComponent(entry.file)
            guard fm.fileExists(atPath: url.path) else { continue }
            guard let data = try? Data(contentsOf: url),
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                throw MigrationError.io("unreadable \(entry.file): refusing to migrate partial data")
            }
            let docs: [String] = arr.compactMap { obj in
                (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) }
            }
            guard docs.count == arr.count else {
                throw MigrationError.io("unserializable entries in \(entry.file)")
            }
            expected[entry.collection] = docs.count
            expectedHash[entry.collection] = docs.sorted().joined().hashFNV1a
            payloads.append((entry.collection, docs))
        }

        // Build the temp DB in a single transaction.
        let storage = try SQLiteStorage(path: tempDB.path)
        do {
            try storage.begin()
            for p in payloads {
                for (i, json) in p.docs.enumerated() {
                    try storage.put(collection: p.collection, id: "\(p.collection)-\(i)", json: json)
                }
            }
            try storage.setMeta("schema_version", "1")
            try storage.setMeta("migrated_at", ISO8601DateFormatter().string(from: Date()))
            try storage.commit()
        } catch {
            storage.rollback(); storage.close()
            try? fm.removeItem(at: tempDB)
            throw MigrationError.io("\(error)")
        }

        // Validate counts + content hashes before the atomic switch.
        for (collection, n) in expected where storage.count(collection: collection) != n {
            storage.close(); try? fm.removeItem(at: tempDB)
            throw MigrationError.validationFailed("\(collection): expected \(n), got \(storage.count(collection: collection))")
        }
        for p in payloads {
            let got = storage.all(collection: p.collection).sorted().joined().hashFNV1a
            guard got == expectedHash[p.collection] else {
                storage.close(); try? fm.removeItem(at: tempDB)
                throw MigrationError.validationFailed("\(p.collection): content hash mismatch")
            }
        }
        storage.close()

        // Atomic switch with rollback: keep the previous DB as a backup until the
        // new one is in place. Never delete-then-move (a crash in between = no DB).
        do {
            if fm.fileExists(atPath: finalDB.path) {
                try? fm.removeItem(at: backupDB)
                try fm.moveItem(at: finalDB, to: backupDB)
            }
            try fm.moveItem(at: tempDB, to: finalDB)
            try? fm.removeItem(at: backupDB)
        } catch {
            // Best-effort restore of the previous DB.
            if fm.fileExists(atPath: backupDB.path), !fm.fileExists(atPath: finalDB.path) {
                try? fm.moveItem(at: backupDB, to: finalDB)
            }
            try? fm.removeItem(at: tempDB)
            throw MigrationError.io("atomic switch failed: \(error)")
        }
        return Report(migrated: expected, dbPath: finalDB.path)
    }
}

private extension String {
    /// FNV-1a 64-bit — stable across runs, no CryptoKit dependency for the app target.
    var hashFNV1a: UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        for b in utf8 {
            h ^= UInt64(b)
            h = h &* 0x100000001b3
        }
        return h
    }
}
