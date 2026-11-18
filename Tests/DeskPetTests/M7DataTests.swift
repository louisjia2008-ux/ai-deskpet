import XCTest
import Foundation
@testable import DeskPet
@testable import AICore

final class EncryptedBackupTests: XCTestCase {
    override func setUp() {
        super.setUp()
        EncryptedBackup._pbkdf2IterationsOverride = 1_000
    }

    override func tearDown() {
        EncryptedBackup._pbkdf2IterationsOverride = nil
        super.tearDown()
    }

    func testRoundTripDecryptsToSamePlaintext() throws {
        let secret = Data("队长的任务和记忆".utf8)
        let fixturePassphrase = ["fixture", "passphrase"].joined(separator: "-")
        let pkg = try EncryptedBackup.seal(secret, password: fixturePassphrase, manifest: ["x": secret.count], version: 1)
        let out = try EncryptedBackup.open(pkg, password: fixturePassphrase)
        XCTAssertEqual(out, secret)
    }

    func testWrongPasswordFails() throws {
        let pkg = try EncryptedBackup.seal(Data("data".utf8), password: "right", manifest: [:], version: 1)
        XCTAssertThrowsError(try EncryptedBackup.open(pkg, password: "wrong")) { err in
            XCTAssertEqual(err as? EncryptedBackup.BackupError, .badPassword)
        }
    }

    func testAuthenticatedMetadataRejectsTampering() throws {
        let fixturePassphrase = ["fixture", "metadata"].joined(separator: "-")
        var package = try EncryptedBackup.seal(Data("data".utf8),
                                               password: fixturePassphrase,
                                               manifest: ["tasks.json": 4],
                                               version: 1)
        package.manifest["tasks.json"] = 5
        XCTAssertThrowsError(try EncryptedBackup.open(package, password: fixturePassphrase))
    }

    func testPasswordIsNotStoredInPackage() throws {
        let fixturePassphrase = ["fixture", "not", "stored"].joined(separator: "-")
        let pkg = try EncryptedBackup.seal(Data("data".utf8), password: fixturePassphrase, manifest: [:], version: 1)
        let encoded = try JSONEncoder().encode(pkg)
        let text = String(data: encoded, encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains(fixturePassphrase))   // password never written (doc §15.2)
    }
}

final class SyncPolicyMergeTests: XCTestCase {

    func testDefaultClassification() {
        let p = SyncPolicy()
        XCTAssertTrue(p.maySync(.tasks))
        XCTAssertTrue(p.maySync(.relationship))
        XCTAssertFalse(p.maySync(.chat))     // opt-in only (doc §15.1)
        XCTAssertFalse(p.maySync(.memory))
    }

    func testICloudMasterSwitchGatesEverything() {
        var p = SyncPolicy()
        p.iCloudEnabled = false
        XCTAssertFalse(p.maySync(.tasks))
    }

    func testAffinityMergeNeverRegresses() {
        let a = RelationshipState(score: 120)
        let b = RelationshipState(score: 40)
        XCTAssertEqual(MergeRules.mergeAffinity(a, b).score, 120)   // higher wins (doc §15.1)
        XCTAssertEqual(MergeRules.mergeAffinity(b, a).score, 120)
    }

    func testAccessoryMergeIsUnion() {
        let merged = MergeRules.mergeAccessories([.hairclip], [.glasses, .cape])
        XCTAssertEqual(merged, [.hairclip, .glasses, .cape])
    }

    func testMigrationGate() {
        XCTAssertEqual(MigrationCheck.evaluate(backupVersion: 1, current: 1), .ok)
        XCTAssertEqual(MigrationCheck.evaluate(backupVersion: 0, current: 1), .migrate(from: 0))
        XCTAssertEqual(MigrationCheck.evaluate(backupVersion: 2, current: 1), .incompatibleNewer(2))
    }
}

@MainActor
final class BackupServiceTests: XCTestCase {
    override func setUp() {
        super.setUp()
        EncryptedBackup._pbkdf2IterationsOverride = 1_000
    }

    override func tearDown() {
        EncryptedBackup._pbkdf2IterationsOverride = nil
        super.tearDown()
    }

    func testExportThenRestoreReproducesFiles() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-backup-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Seed a data file.
        let tasksURL = dir.appendingPathComponent("tasks.json")
        let original = Data(#"[{"title":"原始任务"}]"#.utf8)
        try original.write(to: tasksURL)

        let svc = BackupService(directory: dir)
        let folder = dir.appendingPathComponent("out", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let bak = try svc.export(password: "pw", to: folder)

        // Inspect shows the manifest before restoring.
        let contents = try svc.inspect(at: bak, password: "pw")
        XCTAssertEqual(contents.version, SchemaVersion.current)
        XCTAssertNotNil(contents.entries["tasks.json"])

        // Mutate the live file, then restore brings the original back.
        try Data(#"[{"title":"被改坏了"}]"#.utf8).write(to: tasksURL)
        try svc.restore(from: bak,
                        password: "pw",
                        categories: nil,
                        expectedDigest: contents.sourceDigest)
        XCTAssertEqual(try Data(contentsOf: tasksURL), original)
    }

    func testRestoreWithWrongPasswordKeepsCurrentData() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-backup2-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let tasksURL = dir.appendingPathComponent("tasks.json")
        try Data("seed".utf8).write(to: tasksURL)
        let svc = BackupService(directory: dir)
        let bak = try svc.export(password: "correct", to: dir)

        let current = Data("current".utf8)
        try current.write(to: tasksURL)
        XCTAssertThrowsError(try svc.restore(from: bak, password: "WRONG", categories: nil))
        XCTAssertEqual(try Data(contentsOf: tasksURL), current)   // unchanged on failure
    }

    func testRestoreRejectsUnknownOrTraversalEntries() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-backup-invalid-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let passphrase = ["fixture", "restore"].joined(separator: "-")
        let payload = try JSONEncoder().encode(["../escape": Data("no".utf8)])
        let package = try EncryptedBackup.seal(payload,
                                               password: passphrase,
                                               manifest: ["../escape": 2],
                                               version: SchemaVersion.current)
        let url = dir.appendingPathComponent("hostile.deskpetbak")
        try JSONEncoder().encode(package).write(to: url)
        let service = BackupService(directory: dir)
        XCTAssertThrowsError(try service.restore(from: url,
                                                 password: passphrase,
                                                 categories: nil)) { error in
            XCTAssertEqual(error as? BackupService.RestoreError, .invalidContents)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath:
            dir.deletingLastPathComponent().appendingPathComponent("escape").path))
    }

    func testRestoreRejectsFileChangedAfterPreview() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-backup-race-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data("[]".utf8).write(to: dir.appendingPathComponent("tasks.json"))
        let service = BackupService(directory: dir)
        let url = try service.export(password: "pw", to: dir)
        let preview = try service.inspect(at: url, password: "pw")
        var replacement = try Data(contentsOf: url)
        replacement.append(0x20)
        try replacement.write(to: url, options: .atomic)
        XCTAssertThrowsError(try service.restore(from: url,
                                                 password: "pw",
                                                 expectedDigest: preview.sourceDigest)) { error in
            XCTAssertEqual(error as? BackupService.RestoreError, .packageChanged)
        }
    }
}
