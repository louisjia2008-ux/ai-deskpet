import XCTest
@testable import DeskPet

// P17-A — onboarding persistence and schema tests.
//
// Covers ONB-02 (completed state skips onboarding), ONB-08 (onboarding state
// survives restart), ONB-10 (no secrets written to onboarding persistence).

final class P17OnboardingStateTests: XCTestCase {

    private func makeTempRoot() -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-onboarding-tests-\(UUID().uuidString)",
                                    isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    func testFreshState_isNotCompleted() {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)
        let state = persistence.load()
        XCTAssertNil(state.completedAt, "Fresh state must not be completed")
        XCTAssertFalse(state.isCompleted)
        XCTAssertEqual(state.schemaVersion, OnboardingSchema.currentSchemaVersion)
        XCTAssertEqual(state.contentVersion, OnboardingSchema.currentContentVersion)
    }

    func testMarkCompleted_persists_andIsReloadable() throws {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)

        let completed = try persistence.markCompleted(
            providerConfigured: false,
            lastStepIndex: OnboardingStep.ready.index)
        XCTAssertNotNil(completed.completedAt)
        XCTAssertTrue(completed.isCompleted)
        XCTAssertEqual(completed.lastStepIndex, OnboardingStep.ready.index)
        XCTAssertFalse(completed.providerConfiguredOnCompletion)

        // Re-load: same content (allow 1-second precision loss from ISO8601 roundtrip)
        let reloaded = persistence.load()
        XCTAssertNotNil(reloaded.completedAt)
        let delta = abs(reloaded.completedAt!.timeIntervalSince(completed.completedAt!))
        XCTAssertLessThan(delta, 1.0, "Completed-at must roundtrip within 1 second")
        XCTAssertEqual(reloaded.lastStepIndex, completed.lastStepIndex)
        XCTAssertTrue(reloaded.isCompleted)
    }

    func testReset_removesCompletion() throws {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)
        _ = try persistence.markCompleted(providerConfigured: true, lastStepIndex: 4)
        XCTAssertTrue(persistence.load().isCompleted)

        let fresh = try persistence.reset()
        XCTAssertFalse(fresh.isCompleted)
        XCTAssertNil(fresh.completedAt)
        XCTAssertEqual(fresh.lastStepIndex, 0)
    }

    func testRecordShown_updatesLastStepIndex() throws {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)
        _ = try persistence.recordShown(stepIndex: OnboardingStep.permissions.index)
        let state = persistence.load()
        XCTAssertEqual(state.lastStepIndex, OnboardingStep.permissions.index)
        XCTAssertNotNil(state.lastShownAt)
        XCTAssertFalse(state.isCompleted, "Recording shown does not complete onboarding")
    }

    func testIsCompleted_requiresCurrentContentVersion() {
        var state = OnboardingState()
        state.completedAt = Date()
        XCTAssertTrue(state.isCompleted)

        // Simulate a user who completed onboarding at contentVersion = 0
        // before we shipped v1. They should be shown onboarding again.
        state.contentVersion = 0
        XCTAssertFalse(state.isCompleted, "Stale content version must invalidate completion")
    }

    func testOnboardingFile_isHumanReadableJSON() throws {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)
        _ = try persistence.markCompleted(providerConfigured: true, lastStepIndex: 3)
        let data = try Data(contentsOf: persistence.fileURL)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertNotNil(json?["completedAt"])
        XCTAssertNotNil(json?["schemaVersion"])
        XCTAssertNil(json?["apiKey"])
        XCTAssertNil(json?["secret"])
        XCTAssertNil(json?["password"], "No password-like keys should be persisted.")
    }

    func testCorruptFile_loadsAsFreshState() throws {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("{not valid json".utf8).write(to: persistence.fileURL)

        let state = persistence.load()
        XCTAssertNil(state.completedAt)
        XCTAssertFalse(state.isCompleted)
    }

    func testAtomicSave_doesNotLeavePartialFile() throws {
        let root = makeTempRoot()
        let persistence = OnboardingPersistence(applicationSupportRoot: root)
        _ = try persistence.markCompleted(providerConfigured: false, lastStepIndex: 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: persistence.fileURL.path))

        // No temp file should remain.
        let tempPath = persistence.fileURL.path + ".tmp"
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempPath),
                       "Atomic save must not leave a stray temp file.")
    }
}
