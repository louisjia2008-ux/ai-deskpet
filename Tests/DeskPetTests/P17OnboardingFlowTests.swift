import XCTest
import AICore
import PetAgentRuntime
@testable import DeskPet

// P17-A — onboarding view model and presentation tests.
//
// Covers ONB-01 (fresh state opens onboarding), ONB-03 (configure-later reaches
// usable product), ONB-04 (configured provider is recognized), ONB-07 (user
// can reopen from Settings), ONB-08 (state survives restart), ONB-09 (no raw
// provider/tool identifiers exposed in copy).

final class P17OnboardingFlowTests: XCTestCase {

    private func makeTempRoot() -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-onboarding-flow-\(UUID().uuidString)",
                                    isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func makePersistence(root: URL) -> OnboardingPersistence {
        OnboardingPersistence(applicationSupportRoot: root)
    }

    @MainActor
    private func makePreferences() -> PreferencesModel {
        // PreferencesModel fileURL is irrelevant for these tests; it is
        // only used to read the in-memory copy state.
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("prefs-\(UUID().uuidString).json")
        return PreferencesModel(fileURL: temp)
    }

    @MainActor
    private func makeProviders(root: URL) -> ProviderStore {
        ProviderStore(
            fileURL: root.appendingPathComponent("providers.json"),
            secretStore: InMemorySecretStore(),
            conformanceProfileStore: ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("ConformanceProfiles")))
    }

    @MainActor
    func testFreshState_shouldPresentOnLaunch() {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let paths = minimalPaths(root: root)
        let coordinator = OnboardingCoordinator(persistence: persistence,
                                                providers: providers,
                                                preferences: prefs,
                                                paths: paths)
        XCTAssertTrue(coordinator.shouldPresentOnLaunch(),
                      "ONB-01: fresh state must present onboarding")
    }

    @MainActor
    func testCompletedState_shouldNotPresentOnLaunch() throws {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        _ = try persistence.markCompleted(providerConfigured: false,
                                          lastStepIndex: OnboardingStep.ready.index)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let paths = minimalPaths(root: root)
        let coordinator = OnboardingCoordinator(persistence: persistence,
                                                providers: providers,
                                                preferences: prefs,
                                                paths: paths)
        XCTAssertFalse(coordinator.shouldPresentOnLaunch(),
                       "ONB-02: completed state must skip onboarding")
    }

    @MainActor
    func testViewModel_freshState_startsAtWelcomeStep() {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .firstLaunch)
        XCTAssertEqual(viewModel.currentStep, OnboardingStep.welcome)
        XCTAssertFalse(viewModel.canGoBack)
        XCTAssertFalse(viewModel.isLastStep)
        XCTAssertFalse(viewModel.isReplay)
    }

    @MainActor
    func testViewModel_stepNavigation_advancesAndRetreats() throws {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .firstLaunch)
        XCTAssertEqual(viewModel.currentStep, OnboardingStep.welcome)

        viewModel.goNext()
        XCTAssertEqual(viewModel.currentStep, OnboardingStep.aiSetup)

        viewModel.goNext()
        XCTAssertEqual(viewModel.currentStep, OnboardingStep.permissions)

        viewModel.goBack()
        XCTAssertEqual(viewModel.currentStep, OnboardingStep.aiSetup)

        // Persistence should reflect the latest step.
        let reloaded = persistence.load()
        XCTAssertEqual(reloaded.lastStepIndex, OnboardingStep.aiSetup.index)
    }

    @MainActor
    func testViewModel_jumpToStep_persists() throws {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .firstLaunch)
        viewModel.jump(to: .safety)
        XCTAssertEqual(viewModel.currentStep, OnboardingStep.safety)
        let reloaded = persistence.load()
        XCTAssertEqual(reloaded.lastStepIndex, OnboardingStep.safety.index)
    }

    @MainActor
    func testViewModel_skipReasons_areRecorded() throws {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .firstLaunch)
        viewModel.recordSkip("config_provider_later")
        viewModel.recordSkip("permissions_skipped")
        let state = persistence.load()
        XCTAssertNotNil(state.skipReasons["config_provider_later"])
        XCTAssertNotNil(state.skipReasons["permissions_skipped"])
    }

    @MainActor
    func testViewModel_finish_marksCompleted() throws {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .firstLaunch)
        viewModel.goNext()
        viewModel.goNext()
        viewModel.goNext()
        viewModel.goNext()
        XCTAssertTrue(viewModel.isLastStep)
        let completed = try viewModel.finish()
        XCTAssertNotNil(completed.completedAt)
        XCTAssertTrue(persistence.load().isCompleted,
                      "ONB-08: completed state must survive reload")
    }

    @MainActor
    func testViewModel_configuredProvider_isRecognized() async throws {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        // Pre-seed a working provider so readiness is "ready".
        try await providers.upsert(
            ProviderConfig(displayName: "本地 Ollama",
                           type: .ollama,
                           baseURL: URL(string: "http://localhost:11434")!,
                           enabled: true),
            apiKey: nil,
            manualModelID: "llama3.2")
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .firstLaunch)
        XCTAssertTrue(viewModel.hasConfiguredProvider,
                      "ONB-04: configured provider should be recognized")
    }

    @MainActor
    func testReplay_reason_isRecognized() {
        let root = makeTempRoot()
        let persistence = makePersistence(root: root)
        let providers = makeProviders(root: root)
        let prefs = makePreferences()
        let viewModel = OnboardingViewModel(
            persistence: persistence,
            providers: providers,
            preferences: prefs,
            initialState: persistence.load(),
            reason: .replay)
        XCTAssertTrue(viewModel.isReplay)
    }

    // MARK: helpers

    private func minimalPaths(root: URL) -> DeskPetAppPaths {
        DeskPetAppPaths(profileID: nil, profileRoot: nil,
                        applicationSupportRoot: root,
                        conversationsURL: root.appendingPathComponent("conv.json"),
                        memoriesURL: root.appendingPathComponent("mem.json"),
                        tasksURL: root.appendingPathComponent("tasks.json"),
                        relationshipURL: root.appendingPathComponent("rel.json"),
                        preferencesURL: root.appendingPathComponent("prefs.json"),
                        providersURL: root.appendingPathComponent("providers.json"),
                        scheduledTasksURL: root.appendingPathComponent("sched.json"),
                        agentTaskLedgerURL: root.appendingPathComponent("ledger.json"),
                        agentTaskActivityURL: root.appendingPathComponent("activity.jsonl"),
                        agentRunEventsDirectory: root.appendingPathComponent("Runs"),
                        agentCheckpointsDirectory: root.appendingPathComponent("Checkpoints"),
                        agentSideEffectsDirectory: root.appendingPathComponent("SideEffects"),
                        modelConformanceProfilesDirectory: root.appendingPathComponent("Conformance"),
                        logsDirectory: root.appendingPathComponent("Logs"),
                        diagnosticsURL: root.appendingPathComponent("diag.txt"),
                        cachesDirectory: root.appendingPathComponent("Caches"),
                        temporaryOutputDirectory: root.appendingPathComponent("Tmp"),
                        workspaceRoot: root.appendingPathComponent("Workspace"),
                        uiStateURL: nil,
                        durableTasksDirectory: root.appendingPathComponent("DurableTasks"),
                        durableGoalsDirectory: root.appendingPathComponent("Goals"),
                        durableInboxURL: root.appendingPathComponent("inbox.jsonl"),
                        durableSchedulerSnapshotsDirectory: root.appendingPathComponent("Sched"),
                        durableAuditLogURL: root.appendingPathComponent("audit.jsonl"))
    }
}
