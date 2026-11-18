import Foundation
import AICore
import CryptoKit

/// Local encrypted backup/restore (doc §15.2). Operates at the file level over the DeskPet support
/// directory so it captures exactly the persisted data (private chats / screenshots / OCR / voice
/// are never persisted, so they can't leak into a backup). Restore snapshots current files first
/// for a rollback path (doc §15.2 可回滚).
@MainActor
final class BackupService {
    static let maximumPackageBytes = 64 * 1024 * 1024
    static let maximumPlaintextBytes = 48 * 1024 * 1024
    static let maximumEntryBytes = 32 * 1024 * 1024

    /// Category → backing file. Used for partial restore.
    static let categoryFiles: [SyncCategory: String] = [
        .tasks: "tasks.json",
        .memory: "memories.json",
        .chat: "conversations.json",
        .relationship: "relationship.json",
        .settings: "preferences.json",
    ]

    private let dir: URL
    init(directory: URL? = nil) {
        if let directory { self.dir = directory }
        else {
            self.dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    struct Contents {
        var createdAt: Date
        var version: Int
        var entries: [String: Int]
        var sourceDigest: Data
    }

    // MARK: Export

    /// Bundle existing data files, encrypt with `password`, write a `.deskpetbak` to `folder`.
    func export(password: String, to folder: URL) throws -> URL {
        var payload: [String: Data] = [:]
        var manifest: [String: Int] = [:]
        for file in Set(Self.categoryFiles.values) {
            let url = try destinationURL(for: file)
            if let data = try? Data(contentsOf: url) {
                guard data.count <= Self.maximumEntryBytes else {
                    throw RestoreError.inputTooLarge
                }
                payload[file] = data
                manifest[file] = data.count
            }
        }
        let plaintext = try JSONEncoder().encode(payload)
        let package = try EncryptedBackup.seal(plaintext, password: password,
                                               manifest: manifest, version: SchemaVersion.current)
        let out = folder.appendingPathComponent("DeskPet-\(Self.stamp()).deskpetbak")
        try JSONEncoder().encode(package).write(to: out, options: .atomic)
        return out
    }

    // MARK: Inspect (show manifest before restoring, doc §15.2)

    func inspect(at url: URL, password: String) throws -> Contents {
        let loaded = try loadPackage(url)
        let payload = try decodedPayload(from: loaded.package, password: password)
        return Contents(createdAt: loaded.package.createdAt,
                        version: loaded.package.version,
                        entries: payload.mapValues(\.count),
                        sourceDigest: loaded.digest)
    }

    // MARK: Restore

    /// Decrypt, run the migration gate, snapshot current files, then write the chosen categories
    /// (nil = full restore). Throws on bad password or an incompatible newer backup.
    func restore(from url: URL,
                 password: String,
                 categories: Set<SyncCategory>? = nil,
                 expectedDigest: Data? = nil) throws {
        let loaded = try loadPackage(url)
        if let expectedDigest, expectedDigest != loaded.digest {
            throw RestoreError.packageChanged
        }
        let package = loaded.package
        switch MigrationCheck.evaluate(backupVersion: package.version) {
        case .incompatibleNewer(let v):
            throw RestoreError.incompatibleNewer(v)        // keep current data (rollback path)
        case .ok, .migrate:
            break                                          // v1: migration is identity
        }
        let payload = try decodedPayload(from: package, password: password)

        let wanted: Set<String>
        if let categories { wanted = Set(categories.compactMap { Self.categoryFiles[$0] }) }
        else { wanted = Set(Self.categoryFiles.values).intersection(payload.keys) }
        try commit(payload: payload, files: wanted)
    }

    enum RestoreError: Error, Equatable {
        case incompatibleNewer(Int)
        case inputTooLarge
        case invalidContents
        case unsafeDestination
        case packageChanged
    }

    // MARK: Helpers

    private func loadPackage(_ url: URL) throws -> (package: EncryptedBackup.Package, digest: Data) {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let size = values.fileSize,
              size <= Self.maximumPackageBytes else {
            throw RestoreError.inputTooLarge
        }
        let data = try Data(contentsOf: url)
        guard data.count <= Self.maximumPackageBytes else { throw RestoreError.inputTooLarge }
        let package = try JSONDecoder().decode(EncryptedBackup.Package.self, from: data)
        return (package, Data(SHA256.hash(data: data)))
    }

    private func decodedPayload(from package: EncryptedBackup.Package,
                                password: String) throws -> [String: Data] {
        let plaintext = try EncryptedBackup.open(package, password: password)
        guard plaintext.count <= Self.maximumPlaintextBytes else { throw RestoreError.inputTooLarge }
        let payload = try JSONDecoder().decode([String: Data].self, from: plaintext)
        let allowed = Set(Self.categoryFiles.values)
        guard payload.count <= allowed.count,
              Set(payload.keys).isSubset(of: allowed),
              package.manifest == payload.mapValues(\.count),
              payload.allSatisfy({ !$0.key.contains("/") &&
                                   !$0.key.contains("\\") &&
                                   $0.key.count <= 64 &&
                                   $0.value.count <= Self.maximumEntryBytes }),
              payload.values.reduce(0, { partial, data in
                  let (sum, overflow) = partial.addingReportingOverflow(data.count)
                  return overflow ? Int.max : sum
              }) <= Self.maximumPlaintextBytes else {
            throw RestoreError.invalidContents
        }
        for file in payload.keys { _ = try destinationURL(for: file) }
        return payload
    }

    private func destinationURL(for file: String) throws -> URL {
        let allowed = Set(Self.categoryFiles.values)
        guard allowed.contains(file),
              file == URL(fileURLWithPath: file).lastPathComponent,
              !file.contains("/"),
              !file.contains("\\") else {
            throw RestoreError.unsafeDestination
        }
        let root = dir.standardizedFileURL.resolvingSymlinksInPath()
        let candidate = dir.appendingPathComponent(file).standardizedFileURL
        guard candidate.deletingLastPathComponent().resolvingSymlinksInPath() == root else {
            throw RestoreError.unsafeDestination
        }
        if FileManager.default.fileExists(atPath: candidate.path) {
            let values = try candidate.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
            guard values.isSymbolicLink != true, values.isRegularFile == true else {
                throw RestoreError.unsafeDestination
            }
        }
        return candidate
    }

    private func commit(payload: [String: Data], files: Set<String>) throws {
        let selected = files.sorted().filter { payload[$0] != nil }
        guard !selected.isEmpty else { return }
        let transactionRoot = dir.appendingPathComponent(".restore-\(UUID().uuidString)", isDirectory: true)
        let stagedRoot = transactionRoot.appendingPathComponent("staged", isDirectory: true)
        let rollbackRoot = transactionRoot.appendingPathComponent("rollback", isDirectory: true)
        try FileManager.default.createDirectory(at: stagedRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: rollbackRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: transactionRoot) }

        var originallyAbsent = Set<String>()
        for file in selected {
            let destination = try destinationURL(for: file)
            let staged = stagedRoot.appendingPathComponent(file)
            try payload[file]!.write(to: staged, options: [.atomic])
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.copyItem(at: destination,
                                                 to: rollbackRoot.appendingPathComponent(file))
            } else {
                originallyAbsent.insert(file)
            }
        }

        var committed: [String] = []
        do {
            for file in selected {
                let destination = try destinationURL(for: file)
                let staged = stagedRoot.appendingPathComponent(file)
                try Data(contentsOf: staged).write(to: destination, options: [.atomic])
                committed.append(file)
            }
        } catch {
            for file in committed.reversed() {
                guard let destination = try? destinationURL(for: file) else { continue }
                if originallyAbsent.contains(file) {
                    try? FileManager.default.removeItem(at: destination)
                } else {
                    let rollback = rollbackRoot.appendingPathComponent(file)
                    if let original = try? Data(contentsOf: rollback) {
                        try? original.write(to: destination, options: [.atomic])
                    }
                }
            }
            throw error
        }
    }

    private static func stamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"; return f.string(from: Date())
    }
}
