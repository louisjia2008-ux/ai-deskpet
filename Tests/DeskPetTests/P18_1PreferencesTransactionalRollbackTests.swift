import XCTest
import Foundation
@testable import DeskPet
@testable import AICore

/// P18.1 — APP-003 closure.
///
/// `PreferencesModel.setToolEnabled(_:_:)` previously had a transactional
/// ordering bug: mutating `@Published prefs` triggered the didSet
/// `persist()` first, writing the new value to disk, and only then
/// attempted to revert in-memory state on failure. Result: disk was
/// inconsistent with in-memory state on persistence failure.
///
/// The fix: encode and persist the candidate FIRST; only assign `prefs`
/// after the write succeeds. Disk and memory are now guaranteed
/// consistent at every observable state.
///
/// These tests verify:
/// 1. Successful enable → memory and disk both reflect enabled
/// 2. Successful disable → memory and disk both reflect disabled
/// 3. Injected persistence failure → memory unchanged, disk unchanged,
///    `lastPersistenceError` populated
/// 4. After failure, recreating the model reads the OLD value from disk
///    (restart semantics).
final class P18_1PreferencesTransactionalRollbackTests: XCTestCase {

    private var tempDir: URL!

    override func setUp() async throws {
        try await super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("p18_1-prefs-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        if let dir = tempDir {
            try? FileManager.default.removeItem(at: dir)
        }
        try await super.tearDown()
    }

    // MARK: - Happy path

    func testSuccessfulEnablePersists() async {
        let url = tempDir.appendingPathComponent("prefs.json")
        let prefs = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            XCTAssertTrue(prefs.isToolEnabled("tool-A"),
                          "default policy: tool enabled")
            prefs.setToolEnabled("tool-A", false)
            XCTAssertFalse(prefs.isToolEnabled("tool-A"),
                           "in-memory: tool-A must be disabled after setToolEnabled(false)")
        }
        // Restart: create a fresh model from the same file
        let prefs2 = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            XCTAssertFalse(prefs2.isToolEnabled("tool-A"),
                "after restart: tool-A must still be disabled (disk state matches memory)")
        }
    }

    func testSuccessfulDisablePersists() async {
        let url = tempDir.appendingPathComponent("prefs.json")
        let prefs = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            prefs.setToolEnabled("tool-B", false)
            XCTAssertFalse(prefs.isToolEnabled("tool-B"))
            prefs.setToolEnabled("tool-B", true)
            XCTAssertTrue(prefs.isToolEnabled("tool-B"))
        }
        // Restart
        let prefs2 = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            XCTAssertTrue(prefs2.isToolEnabled("tool-B"),
                "after restart: re-enabled value must persist")
        }
    }

    // MARK: - Persistence failure path

    func testFailedPersistenceLeavesMemoryAndDiskUnchanged() async {
        let url = tempDir.appendingPathComponent("prefs-fail.json")
        // Pre-populate the disk with a known initial state (default policy)
        // by writing the current default AppPreferences.
        let initialPrefs = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            // Tool-A is enabled by default (no policy override yet).
            initialPrefs.setToolEnabled("tool-A", false)
            XCTAssertFalse(initialPrefs.isToolEnabled("tool-A"),
                "initial setup: tool-A disabled and persisted")
        }

        // Create a fresh model that we will break.
        let prefs = await MainActor.run { PreferencesModel(fileURL: url) }
        // Confirm initial state is "disabled".
        let initialDiskState = await MainActor.run { prefs.isToolEnabled("tool-A") }
        XCTAssertFalse(initialDiskState, "precondition: disk has tool-A disabled")

        // Inject a persistence failure
        let injectError = NSError(domain: "P18.1Test", code: 42, userInfo: [NSLocalizedDescriptionKey: "simulated disk full"])
        await MainActor.run {
            prefs.injectPersistenceFailure { _ in throw injectError }
        }

        // Attempt to re-enable — must fail.
        await MainActor.run {
            prefs.setToolEnabled("tool-A", true)
        }

        // Verify: in-memory state is unchanged (still disabled)
        let memoryState = await MainActor.run { prefs.isToolEnabled("tool-A") }
        XCTAssertFalse(memoryState,
            "APP-003: in-memory state must NOT change when persist fails")

        // Verify: error was surfaced
        let lastError = await MainActor.run { prefs.lastPersistenceError }
        XCTAssertNotNil(lastError, "APP-003: lastPersistenceError must be populated on failure")

        // Clear the injection
        await MainActor.run {
            prefs.injectPersistenceFailure(nil)
        }

        // Verify: disk is also unchanged — restart shows the OLD value
        let prefs2 = await MainActor.run { PreferencesModel(fileURL: url) }
        let diskStateAfter = await MainActor.run { prefs2.isToolEnabled("tool-A") }
        XCTAssertFalse(diskStateAfter,
            "APP-003 (restart semantics): after persistence failure, the disk must still hold the OLD value")
    }

    func testFailedPersistenceLeavesAllOtherFieldsUnchanged() async {
        let url = tempDir.appendingPathComponent("prefs-partial.json")
        let prefs = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            prefs.setToolEnabled("tool-X", false)
            prefs.setToolEnabled("tool-Y", false)
        }
        // Snapshot the disk state for tool-X / tool-Y as "before"
        let prefsReadback = await MainActor.run { PreferencesModel(fileURL: url) }
        await MainActor.run {
            XCTAssertFalse(prefsReadback.isToolEnabled("tool-X"))
            XCTAssertFalse(prefsReadback.isToolEnabled("tool-Y"))
        }

        // Inject failure
        await MainActor.run {
            prefs.injectPersistenceFailure { _ in
                throw NSError(domain: "P18.1Test", code: 1)
            }
        }
        // Try a different tool — must fail
        await MainActor.run {
            prefs.setToolEnabled("tool-Z", false)
        }
        // Verify: in-memory unchanged for tool-Z
        let zMem = await MainActor.run { prefs.isToolEnabled("tool-Z") }
        XCTAssertTrue(zMem, "tool-Z default is enabled; failure must leave it unchanged in memory")

        // Restart: tool-Z must still be enabled on disk (not written)
        let prefsAfter = await MainActor.run { PreferencesModel(fileURL: url) }
        let zDisk = await MainActor.run { prefsAfter.isToolEnabled("tool-Z") }
        XCTAssertTrue(zDisk, "tool-Z must NOT appear in disk state after persistence failure")

        // Original tool-X / tool-Y must still be the persisted state
        let xDisk = await MainActor.run { prefsAfter.isToolEnabled("tool-X") }
        let yDisk = await MainActor.run { prefsAfter.isToolEnabled("tool-Y") }
        XCTAssertFalse(xDisk, "tool-X previous state preserved on disk")
        XCTAssertFalse(yDisk, "tool-Y previous state preserved on disk")
    }

    // MARK: - Recovery after failure

    func testSuccessfulPersistAfterFailureClearsError() async {
        let url = tempDir.appendingPathComponent("prefs-recover.json")
        let prefs = await MainActor.run { PreferencesModel(fileURL: url) }
        // First, inject failure and try to write
        await MainActor.run {
            prefs.injectPersistenceFailure { _ in
                throw NSError(domain: "P18.1Test", code: 1)
            }
            prefs.setToolEnabled("tool-A", false)
        }
        let errorAfterFail = await MainActor.run { prefs.lastPersistenceError }
        XCTAssertNotNil(errorAfterFail)

        // Clear the injection
        await MainActor.run {
            prefs.injectPersistenceFailure(nil)
        }

        // Try again — must succeed
        await MainActor.run {
            prefs.setToolEnabled("tool-A", true)
        }
        let errorAfterSuccess = await MainActor.run { prefs.lastPersistenceError }
        XCTAssertNil(errorAfterSuccess, "lastPersistenceError must clear on success")

        // Confirm: state is now persisted
        let prefsAfter = await MainActor.run { PreferencesModel(fileURL: url) }
        let aFinal = await MainActor.run { prefsAfter.isToolEnabled("tool-A") }
        XCTAssertTrue(aFinal, "tool-A must be enabled after successful persist")
    }
}

// MARK: - PreferencesModel injection seam

extension PreferencesModel {
    /// P18.1 — APP-003 test seam. Injects a closure to be invoked from
    /// inside `setToolEnabled` instead of writing to disk. Pass `nil`
    /// to clear the injection and restore normal disk persistence.
    func injectPersistenceFailure(_ handler: ((AppPreferences) throws -> Void)?) {
        _setPersistOverrideForTests(handler)
    }
}