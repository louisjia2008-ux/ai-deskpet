import XCTest
import Foundation
import AICore
@testable import DeskPet
@testable import PetAgentRuntime

@MainActor
final class P61AcceptanceInfrastructureTests: XCTestCase {
    private func dataRoot(_ label: String = UUID().uuidString) -> URL {
        URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("deskpet-p61-\(label)", isDirectory: true)
    }

    func testAutomationEnvironmentRoutesMutablePathsUnderProfileRoot() throws {
        let env = try DeskPetAppEnvironment.automation(profileID: "p6_1_profile",
                                                       dataRoot: dataRoot())
        let profileRoot = try XCTUnwrap(env.paths.profileRoot)
        let mutablePaths = [
            env.paths.applicationSupportRoot,
            env.paths.conversationsURL,
            env.paths.memoriesURL,
            env.paths.tasksURL,
            env.paths.relationshipURL,
            env.paths.preferencesURL,
            env.paths.providersURL,
            env.paths.scheduledTasksURL,
            env.paths.agentTaskLedgerURL,
            env.paths.agentTaskActivityURL,
            env.paths.agentRunEventsDirectory,
            env.paths.logsDirectory,
            env.paths.diagnosticsURL,
            env.paths.cachesDirectory,
            env.paths.temporaryOutputDirectory,
            env.paths.workspaceRoot,
            try XCTUnwrap(env.paths.uiStateURL),
        ]

        XCTAssertEqual(env.automationProfileID, "p6_1_profile")
        XCTAssertTrue(env.secretStore is InMemorySecretStore)
        for path in mutablePaths {
            XCTAssertTrue(path.path == profileRoot.path || path.path.hasPrefix(profileRoot.path + "/"),
                          "\(path.path) escaped \(profileRoot.path)")
            XCTAssertFalse(path.path.contains("/Library/Application Support/DeskPet"),
                           "\(path.path) should not use the normal DeskPet Application Support root")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: profileRoot.appendingPathComponent(".deskpet-automation-profile").path))
    }

    func testAutomationEnvironmentRejectsUnsafeRootsAndProfiles() {
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "../bad",
                                                                  dataRoot: dataRoot("bad-profile")))
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "p61",
                                                                  dataRoot: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)))
        XCTAssertThrowsError(try DeskPetAppEnvironment.cleanAutomationProfileRoot(URL(fileURLWithPath: "/", isDirectory: true)))
    }

    func testAutomationUIStatePersistsInProfileFileAndSurvivesRestart() throws {
        let env = try DeskPetAppEnvironment.automation(profileID: "ui_state",
                                                       dataRoot: dataRoot())
        let ui = AppUIStateStore(backend: env.uiStateBackend)

        ui.setSection(.providers)
        ui.setWindowMode(.expanded)
        ui.floatingAnchor = CGPoint(x: 42, y: 84)

        let reloaded = AppUIStateStore(backend: env.uiStateBackend)
        XCTAssertEqual(reloaded.sectionRaw, AppSection.providers.rawValue)
        XCTAssertEqual(reloaded.windowModeRaw, WindowMode.expanded.rawValue)
        XCTAssertEqual(reloaded.floatingAnchor, CGPoint(x: 42, y: 84))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(env.paths.uiStateURL).path))
    }

    func testAutomationProfileStoresRoundTripWithoutNormalPaths() async throws {
        let env = try DeskPetAppEnvironment.automation(profileID: "round_trip",
                                                       dataRoot: dataRoot())
        let paths = env.paths

        let task = PetTask(title: "isolated task")
        try TaskStore(fileURL: paths.tasksURL).save([task])
        XCTAssertEqual(TaskStore(fileURL: paths.tasksURL).load().first?.title, "isolated task")

        let conversation = Conversation(kind: .normal,
                                        title: "isolated chat",
                                        messages: [ChatMessage(role: .user, text: "hello")])
        try ChatStore(fileURL: paths.conversationsURL).save([conversation])
        XCTAssertEqual(ChatStore(fileURL: paths.conversationsURL).load().first?.title, "isolated chat")

        let memory = MemoryItem(text: "以后默认用中文回复",
                                category: .preference,
                                source: .explicit,
                                scope: .procedural)
        try MemoryStore(fileURL: paths.memoriesURL).save([memory])
        XCTAssertEqual(MemoryStore(fileURL: paths.memoriesURL).load().first?.text, memory.text)

        let relationship = RelationshipSnapshot()
        try RelationshipStore(fileURL: paths.relationshipURL).save(relationship)
        XCTAssertEqual(RelationshipStore(fileURL: paths.relationshipURL).load(), relationship)

        let prefs = PreferencesModel(fileURL: paths.preferencesURL)
        prefs.setMemoryEnabled(false)
        XCTAssertFalse(PreferencesModel(fileURL: paths.preferencesURL).prefs.permissions.memoryEnabled)

        let scheduled = ScheduledTask(title: "isolated scheduled",
                                      prompt: "ping",
                                      schedule: .everySeconds(60),
                                      createdAt: Date())
        try ScheduledTaskStore(fileURL: paths.scheduledTasksURL).save([scheduled])
        XCTAssertEqual(ScheduledTaskStore(fileURL: paths.scheduledTasksURL).load().first?.title, "isolated scheduled")

        let providers = ProviderStore(fileURL: paths.providersURL, secretStore: env.secretStore)
        let providerID = providers.configureAutomationOllama(modelID: "qwen3.5:0.8b")
        let reloadedProviders = ProviderStore(fileURL: paths.providersURL, secretStore: InMemorySecretStore())
        XCTAssertEqual(reloadedProviders.defaults.companionModelProviderID, providerID)
        XCTAssertEqual(reloadedProviders.defaults.companionModelID, "qwen3.5:0.8b")
        XCTAssertEqual(reloadedProviders.provider(id: providerID)?.baseURL.absoluteString, "http://localhost:11434")

        let taskID = UUID()
        let runID = UUID()
        let ledger = JSONAgentTaskLedgerStore(fileURL: paths.agentTaskLedgerURL)
        try await ledger.append(AgentTaskLedgerEvent(taskID: taskID,
                                                     attemptID: runID,
                                                     conversationID: UUID(),
                                                     userMessageID: UUID(),
                                                     state: .running,
                                                     kind: .started,
                                                     sequence: 0))
        let reloadedLedgerEvents = try await JSONAgentTaskLedgerStore(fileURL: paths.agentTaskLedgerURL)
            .events(for: taskID)
        XCTAssertEqual(reloadedLedgerEvents.count, 1)

        let activityPersistence = JSONLAgentTaskActivityEventStore(fileURL: paths.agentTaskActivityURL)
        let activity = AgentTaskActivityEvent(taskID: taskID,
                                              runID: runID,
                                              sequenceNumber: 0,
                                              kind: .taskCreated,
                                              presentation: .init(title: "isolated activity"))
        try await activityPersistence.append(activity)
        let reloadedActivityEvents = try await JSONLAgentTaskActivityEventStore(fileURL: paths.agentTaskActivityURL)
            .loadEvents()
        XCTAssertEqual(reloadedActivityEvents.first?.presentation.title, "isolated activity")
    }
}
