import Foundation
import SQLite3

/// Minimal document store on system SQLite (D6). A SQLCipher build swaps in later (D3) with a
/// Keychain-held key; the Repository abstraction above this stays unchanged. Lives in the Main App
/// Container and is owned/written only by the app (D4). Non-Sendable; used synchronously by the
/// migration / repository on a single actor.
final class SQLiteStorage {
    private var db: OpaquePointer?
    private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    enum StorageError: Error { case open(String), exec(String) }

    init(path: String) throws {
        guard sqlite3_open(path, &db) == SQLITE_OK else {
            throw StorageError.open(String(cString: sqlite3_errmsg(db)))
        }
        try exec("""
            CREATE TABLE IF NOT EXISTS documents(
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                json TEXT NOT NULL,
                PRIMARY KEY(collection, id));
            CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY, value TEXT);
        """)
    }

    deinit { sqlite3_close(db) }
    func close() { sqlite3_close(db); db = nil }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let m = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw StorageError.exec(m)
        }
    }

    func begin() throws { try exec("BEGIN TRANSACTION;") }
    func commit() throws { try exec("COMMIT;") }
    func rollback() { try? exec("ROLLBACK;") }

    func put(collection: String, id: String, json: String) throws {
        var stmt: OpaquePointer?
        let sql = "INSERT OR REPLACE INTO documents(collection, id, json) VALUES(?,?,?);"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw StorageError.exec("prepare put") }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, collection, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, id, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, json, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw StorageError.exec("step put") }
    }

    func all(collection: String) -> [String] {
        var stmt: OpaquePointer?
        let sql = "SELECT json FROM documents WHERE collection = ? ORDER BY id;"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, collection, -1, SQLITE_TRANSIENT)
        var out: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let c = sqlite3_column_text(stmt, 0) { out.append(String(cString: c)) }
        }
        return out
    }

    func count(collection: String) -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM documents WHERE collection = ?;", -1, &stmt, nil) == SQLITE_OK
        else { return 0 }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, collection, -1, SQLITE_TRANSIENT)
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
    }

    func setMeta(_ key: String, _ value: String) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?);", -1, &stmt, nil) == SQLITE_OK
        else { throw StorageError.exec("prepare meta") }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, value, -1, SQLITE_TRANSIENT)
        _ = sqlite3_step(stmt)
    }
}
