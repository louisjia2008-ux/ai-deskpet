import XCTest
import Foundation
@testable import DeskPet

@MainActor
final class SQLiteStorageTests: XCTestCase {

    func testPutAllCount() throws {
        let path = NSTemporaryDirectory() + "deskpet-sql-\(UUID().uuidString).db"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let s = try SQLiteStorage(path: path)
        try s.put(collection: "memory", id: "m1", json: #"{"text":"a"}"#)
        try s.put(collection: "memory", id: "m2", json: #"{"text":"b"}"#)
        try s.put(collection: "memory", id: "m1", json: #"{"text":"a2"}"#)   // replace
        XCTAssertEqual(s.count(collection: "memory"), 2)
        XCTAssertEqual(Set(s.all(collection: "memory")), [#"{"text":"a2"}"#, #"{"text":"b"}"#])
    }
}

@MainActor
final class JSONToSQLiteMigrationTests: XCTestCase {

    func testTransactionalMigrationPreservesDataAndKeepsJSONRollback() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-migrate-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        try Data(#"[{"title":"任务A"},{"title":"任务B"}]"#.utf8)
            .write(to: dir.appendingPathComponent("tasks.json"))
        try Data(#"[{"text":"记忆1"}]"#.utf8)
            .write(to: dir.appendingPathComponent("memories.json"))

        let report = try JSONToSQLiteMigration.run(in: dir)
        XCTAssertEqual(report.migrated["tasks"], 2)
        XCTAssertEqual(report.migrated["memory"], 1)

        // DB exists with the migrated rows…
        let db = try SQLiteStorage(path: report.dbPath)
        XCTAssertEqual(db.count(collection: "tasks"), 2)
        XCTAssertEqual(db.count(collection: "memory"), 1)
        db.close()

        // …and the original JSON is preserved as a rollback path (no destructive migration).
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("tasks.json").path))
        // No leftover temp DB.
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("deskpet.db.migrating").path))
    }
}
