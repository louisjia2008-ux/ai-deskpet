#if PHASE_HARNESS && DEBUG
import AppKit
import Foundation
import PetAgentRuntime

@MainActor
enum P9CLocalDiscoveryAppSmokeHarness {
    enum Flow: String {
        case complete
        case cancel
    }

    static var requestedFlow: Flow? {
        guard let raw = ProcessInfo.processInfo.environment["DESKPET_P9C_APP_SMOKE_HARNESS"] else {
            return nil
        }
        return Flow(rawValue: raw)
    }

    static func runIfRequested(paths: DeskPetAppPaths,
                               chat: ChatModel,
                               activityStore: AgentTaskActivityStore) async {
        guard let flow = requestedFlow else { return }
        do {
            let artifact = try await run(flow: flow,
                                         paths: paths,
                                         chat: chat,
                                         activityStore: activityStore)
            let artifactURL = try write(artifact: artifact, paths: paths)
            FileHandle.standardError.write("P9C_APP_SMOKE flow=\(flow.rawValue) ok=\(artifact.ok) artifact=\(artifactURL.path)\n".data(using: .utf8)!)
            NSApp.terminate(nil)
        } catch {
            let artifact = snapshotArtifact(flow: flow,
                                            paths: paths,
                                            chat: chat,
                                            activityStore: activityStore,
                                            ok: false,
                                            error: String(describing: error))
            let artifactURL = try? write(artifact: artifact, paths: paths)
            FileHandle.standardError.write("P9C_APP_SMOKE flow=\(flow.rawValue) ok=false error=\(error) artifact=\(artifactURL?.path ?? "unwritten")\n".data(using: .utf8)!)
            exit(1)
        }
    }

    private static func run(flow: Flow,
                            paths: DeskPetAppPaths,
                            chat: ChatModel,
                            activityStore: AgentTaskActivityStore) async throws -> P9CAppSmokeArtifact {
        NSApp.activate(ignoringOtherApps: true)
        let text = ProcessInfo.processInfo.environment["DESKPET_P9C_APP_SMOKE_TEXT"]
            ?? "帮我找 San Jose 附近今晚还能练球、关门比较晚的高尔夫练习场。"
        let conversationID = chat.conversation.id
        chat.send(text)
        try await waitUntil(timeout: 10, description: "chat accepted P9C message") {
            chat.conversation.messages.contains { $0.role == .user && $0.text == text }
        }

        if flow == .cancel {
            try await waitUntil(timeout: 60, description: "local discovery workflow reached cancellable tool stage") {
                let run = activityStore.latestTask(conversationID: conversationID)?.latestRun
                return run?.events.contains { event in
                    event.stepID == "searchCandidates"
                        || event.stepID == "estimateDistances"
                        || event.stepID == "enrichCandidates"
                        || event.toolID?.rawValue == "local_place_search"
                        || event.toolID?.rawValue == "route_distance_estimate"
                } == true
            }
            chat.stopGenerating()
        }

        try await waitUntil(timeout: flow == .cancel ? 20 : 90,
                            description: "P9C chat flow terminal") {
            !chat.busy && activityStore.latestTask(conversationID: conversationID)?.latestRun?.status.isTerminal == true
        }

        var task = activityStore.latestTask(conversationID: conversationID)
        var run = task?.latestRun
        let checkpointStore = AgentCheckpointStore(baseDirectory: paths.agentCheckpointsDirectory)
        let terminalSequence = UInt64(run?.events.map(\.sequenceNumber).max() ?? 0)
        if let taskID = task?.taskID, let runID = run?.runID {
            try? await waitUntilAsync(timeout: 5, description: "terminal checkpoint caught up") {
                guard let checkpoint = try? await checkpointStore.load(taskID: taskID, runID: runID) else {
                    return false
                }
                return checkpoint.phase == .terminal
                    && checkpoint.lastSequence >= terminalSequence
                    && checkpoint.projection.state == run?.status.agentRunState
            }
            task = activityStore.latestTask(conversationID: conversationID)
            run = task?.latestRun
        }
        let screenshotURL = paths.applicationSupportRoot
            .appendingPathComponent("p9c_app_smoke_\(flow.rawValue)_screenshot.png")
        let screenshotCaptured = captureVisibleWindowScreenshot(to: screenshotURL)
        let traceURL = try writeTrace(run: run, flow: flow, paths: paths)
        let checkpointSummary = await makeCheckpointSummary(taskID: task?.taskID,
                                                            runID: run?.runID,
                                                            store: checkpointStore,
                                                            paths: paths)
        let ledgerSummary = makeLedgerSummary(paths: paths)
        let noSecretAssertion = noSecretsDetected(in: [traceURL,
                                                       checkpointSummary.path.map(URL.init(fileURLWithPath:)),
                                                       paths.agentTaskLedgerURL].compactMap { $0 })
        let eventKinds = run?.events.map { $0.kind.rawValue } ?? []
        let toolIDs = run?.events.compactMap { $0.toolID?.rawValue } ?? []
        let stepIDs = run?.events.compactMap(\.stepID) ?? []
        let assistantStatuses = chat.conversation.messages.map { $0.status.rawValue }
        let ok: Bool
        switch flow {
        case .complete:
            ok = run?.resultDocument != nil
                && toolIDs.contains("local_place_search")
                && (toolIDs.contains("route_distance_estimate") || stepIDs.contains("estimateDistances"))
                && stepIDs.contains("genericVerifier")
                && assistantStatuses.contains("completed")
                && checkpointSummary.phase == "terminal"
                && checkpointSummary.state == run?.status.rawValue
                && checkpointSummary.lastSequence ?? 0 >= terminalSequence
                && noSecretAssertion
        case .cancel:
            ok = run?.status == .cancelled
                && assistantStatuses.contains("cancelled")
                && run?.resultDocument == nil
                && checkpointSummary.phase == "terminal"
                && checkpointSummary.state == "cancelled"
                && checkpointSummary.lastSequence ?? 0 >= terminalSequence
                && noSecretAssertion
        }
        return P9CAppSmokeArtifact(flow: flow.rawValue,
                                   ok: ok,
                                   processID: ProcessInfo.processInfo.processIdentifier,
                                   applicationSupportRoot: paths.applicationSupportRoot.path,
                                   profileRoot: paths.profileRoot?.path,
                                   conversationID: conversationID,
                                   taskID: task?.taskID,
                                   runID: run?.runID,
                                   userMessageVisible: chat.conversation.messages.contains { $0.role == .user && $0.text == text },
                                   terminalStatus: run?.status.rawValue,
                                   resultTitle: run?.resultDocument?.title,
                                   resultStatus: run?.resultDocument?.status.rawValue,
                                   resultSummary: run?.resultDocument?.summary,
                                   eventKinds: eventKinds,
                                   stepIDs: stepIDs,
                                   toolIDs: toolIDs,
                                   assistantStatuses: assistantStatuses,
                                   screenshotPath: screenshotCaptured ? screenshotURL.path : nil,
                                   tracePath: traceURL.path,
                                   visibleWindowCount: visibleWindowCount(),
                                   checkpointSummary: checkpointSummary,
                                   ledgerSummary: ledgerSummary,
                                   noSecretAssertion: noSecretAssertion,
                                   error: ok ? nil : "acceptance predicates not satisfied")
    }

    private static func snapshotArtifact(flow: Flow,
                                         paths: DeskPetAppPaths,
                                         chat: ChatModel,
                                         activityStore: AgentTaskActivityStore,
                                         ok: Bool,
                                         error: String?) -> P9CAppSmokeArtifact {
        let conversationID = chat.conversation.id
        let task = activityStore.latestTask(conversationID: conversationID)
        let run = task?.latestRun
        let screenshotURL = paths.applicationSupportRoot
            .appendingPathComponent("p9c_app_smoke_\(flow.rawValue)_screenshot.png")
        let screenshotCaptured = captureVisibleWindowScreenshot(to: screenshotURL)
        let traceURL = try? writeTrace(run: run, flow: flow, paths: paths)
        let checkpointSummary = P9CAppSmokeCheckpointSummary(path: nil,
                                                            phase: nil,
                                                            state: nil,
                                                            lastSequence: nil,
                                                            eventCount: nil,
                                                            domainPayloadKeys: [],
                                                            localDiscoveryStage: nil,
                                                            resultStatus: nil,
                                                            completedToolCallCount: 0,
                                                            evidenceCount: 0,
                                                            currentUIRevision: nil,
                                                            error: "not loaded")
        let ledgerSummary = makeLedgerSummary(paths: paths)
        return P9CAppSmokeArtifact(flow: flow.rawValue,
                                   ok: ok,
                                   processID: ProcessInfo.processInfo.processIdentifier,
                                   applicationSupportRoot: paths.applicationSupportRoot.path,
                                   profileRoot: paths.profileRoot?.path,
                                   conversationID: conversationID,
                                   taskID: task?.taskID,
                                   runID: run?.runID,
                                   userMessageVisible: chat.conversation.messages.contains { $0.role == .user },
                                   terminalStatus: run?.status.rawValue,
                                   resultTitle: run?.resultDocument?.title,
                                   resultStatus: run?.resultDocument?.status.rawValue,
                                   resultSummary: run?.resultDocument?.summary,
                                   eventKinds: run?.events.map { $0.kind.rawValue } ?? [],
                                   stepIDs: run?.events.compactMap(\.stepID) ?? [],
                                   toolIDs: run?.events.compactMap { $0.toolID?.rawValue } ?? [],
                                   assistantStatuses: chat.conversation.messages.map { $0.status.rawValue },
                                   screenshotPath: screenshotCaptured ? screenshotURL.path : nil,
                                   tracePath: traceURL?.path,
                                   visibleWindowCount: visibleWindowCount(),
                                   checkpointSummary: checkpointSummary,
                                   ledgerSummary: ledgerSummary,
                                   noSecretAssertion: traceURL.map { noSecretsDetected(in: [$0, paths.agentTaskLedgerURL]) } ?? false,
                                   error: error)
    }

    private static func waitUntil(timeout: TimeInterval,
                                  description: String,
                                  predicate: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw P9CAppSmokeHarnessError.timeout(description)
    }

    private static func waitUntilAsync(timeout: TimeInterval,
                                       description: String,
                                       predicate: @escaping () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw P9CAppSmokeHarnessError.timeout(description)
    }

    private static func write(artifact: P9CAppSmokeArtifact,
                              paths: DeskPetAppPaths) throws -> URL {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p9c_app_smoke_\(artifact.flow)_artifact.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(artifact).write(to: url, options: .atomic)
        return url
    }

    private static func writeTrace(run: AgentTaskRunActivity?,
                                   flow: Flow,
                                   paths: DeskPetAppPaths) throws -> URL {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p9c_app_smoke_\(flow.rawValue)_events.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let trace = (run?.events ?? []).map(P9CAppSmokeEventTrace.init(event:))
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(trace).write(to: url, options: .atomic)
        return url
    }

    private static func captureVisibleWindowScreenshot(to url: URL) -> Bool {
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }),
              let view = window.contentView else { return false }
        view.displayIfNeeded()
        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        view.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func visibleWindowCount() -> Int {
        NSApp.windows.filter(\.isVisible).count
    }

    private static func makeCheckpointSummary(taskID: UUID?,
                                              runID: UUID?,
                                              store: AgentCheckpointStore,
                                              paths: DeskPetAppPaths) async -> P9CAppSmokeCheckpointSummary {
        guard let taskID, let runID else {
            return P9CAppSmokeCheckpointSummary(path: nil,
                                                phase: nil,
                                                state: nil,
                                                lastSequence: nil,
                                                eventCount: nil,
                                                domainPayloadKeys: [],
                                                localDiscoveryStage: nil,
                                                resultStatus: nil,
                                                completedToolCallCount: 0,
                                                evidenceCount: 0,
                                                currentUIRevision: nil,
                                                error: "missing task or run")
        }
        let path = paths.agentCheckpointsDirectory
            .appendingPathComponent(taskID.uuidString, isDirectory: true)
            .appendingPathComponent("\(runID.uuidString).json")
            .path
        do {
            guard let checkpoint = try await store.load(taskID: taskID, runID: runID) else {
                return P9CAppSmokeCheckpointSummary(path: path,
                                                    phase: nil,
                                                    state: nil,
                                                    lastSequence: nil,
                                                    eventCount: nil,
                                                    domainPayloadKeys: [],
                                                    localDiscoveryStage: nil,
                                                    resultStatus: nil,
                                                    completedToolCallCount: 0,
                                                    evidenceCount: 0,
                                                    currentUIRevision: nil,
                                                    error: "missing checkpoint")
            }
            let localDiscoveryStage: String?
            if let payload = checkpoint.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey],
               let snapshot = try? LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload) {
                localDiscoveryStage = snapshot.currentStage.rawValue
            } else {
                localDiscoveryStage = nil
            }
            return P9CAppSmokeCheckpointSummary(path: path,
                                                phase: checkpoint.phase.rawValue,
                                                state: checkpoint.projection.state.rawValue,
                                                lastSequence: checkpoint.lastSequence,
                                                eventCount: checkpoint.eventCount,
                                                domainPayloadKeys: checkpoint.domainPayloads.keys.sorted(),
                                                localDiscoveryStage: localDiscoveryStage,
                                                resultStatus: checkpoint.resultDocument?.status.rawValue,
                                                completedToolCallCount: checkpoint.completedToolCallIDs.count,
                                                evidenceCount: checkpoint.evidenceIDs.count,
                                                currentUIRevision: checkpoint.currentUIRevision,
                                                error: nil)
        } catch {
            return P9CAppSmokeCheckpointSummary(path: path,
                                                phase: nil,
                                                state: nil,
                                                lastSequence: nil,
                                                eventCount: nil,
                                                domainPayloadKeys: [],
                                                localDiscoveryStage: nil,
                                                resultStatus: nil,
                                                completedToolCallCount: 0,
                                                evidenceCount: 0,
                                                currentUIRevision: nil,
                                                error: String(describing: error))
        }
    }

    private static func makeLedgerSummary(paths: DeskPetAppPaths) -> P9CAppSmokeLedgerSummary {
        let url = paths.agentTaskLedgerURL
        let data = try? Data(contentsOf: url)
        let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return P9CAppSmokeLedgerSummary(path: url.path,
                                        exists: data != nil,
                                        byteCount: data?.count ?? 0,
                                        eventCount: text.components(separatedBy: "\"kind\"").count - 1)
    }

    private static func noSecretsDetected(in urls: [URL]) -> Bool {
        let forbidden = ["authorization", "cookie", "api_key", "apikey", "sk-", "bearer "]
        for url in urls {
            guard let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8)?.lowercased() else {
                continue
            }
            if forbidden.contains(where: { text.contains($0) }) {
                return false
            }
        }
        return true
    }
}

private struct P9CAppSmokeArtifact: Codable, Sendable {
    var flow: String
    var ok: Bool
    var processID: Int32
    var applicationSupportRoot: String
    var profileRoot: String?
    var conversationID: UUID?
    var taskID: UUID?
    var runID: UUID?
    var userMessageVisible: Bool
    var terminalStatus: String?
    var resultTitle: String?
    var resultStatus: String?
    var resultSummary: String?
    var eventKinds: [String]
    var stepIDs: [String]
    var toolIDs: [String]
    var assistantStatuses: [String]
    var screenshotPath: String?
    var tracePath: String?
    var visibleWindowCount: Int
    var checkpointSummary: P9CAppSmokeCheckpointSummary
    var ledgerSummary: P9CAppSmokeLedgerSummary
    var noSecretAssertion: Bool
    var error: String?

    init(flow: String,
         ok: Bool,
         processID: Int32,
         applicationSupportRoot: String,
         profileRoot: String? = nil,
         conversationID: UUID? = nil,
         taskID: UUID? = nil,
         runID: UUID? = nil,
         userMessageVisible: Bool = false,
         terminalStatus: String? = nil,
         resultTitle: String? = nil,
         resultStatus: String? = nil,
         resultSummary: String? = nil,
         eventKinds: [String] = [],
         stepIDs: [String] = [],
         toolIDs: [String] = [],
         assistantStatuses: [String] = [],
         screenshotPath: String? = nil,
         tracePath: String? = nil,
         visibleWindowCount: Int = 0,
         checkpointSummary: P9CAppSmokeCheckpointSummary = .empty,
         ledgerSummary: P9CAppSmokeLedgerSummary = .empty,
         noSecretAssertion: Bool = false,
         error: String? = nil) {
        self.flow = flow
        self.ok = ok
        self.processID = processID
        self.applicationSupportRoot = applicationSupportRoot
        self.profileRoot = profileRoot
        self.conversationID = conversationID
        self.taskID = taskID
        self.runID = runID
        self.userMessageVisible = userMessageVisible
        self.terminalStatus = terminalStatus
        self.resultTitle = resultTitle
        self.resultStatus = resultStatus
        self.resultSummary = resultSummary
        self.eventKinds = eventKinds
        self.stepIDs = stepIDs
        self.toolIDs = toolIDs
        self.assistantStatuses = assistantStatuses
        self.screenshotPath = screenshotPath
        self.tracePath = tracePath
        self.visibleWindowCount = visibleWindowCount
        self.checkpointSummary = checkpointSummary
        self.ledgerSummary = ledgerSummary
        self.noSecretAssertion = noSecretAssertion
        self.error = error
    }
}

private struct P9CAppSmokeCheckpointSummary: Codable, Sendable {
    static let empty = P9CAppSmokeCheckpointSummary(path: nil,
                                                   phase: nil,
                                                   state: nil,
                                                   lastSequence: nil,
                                                   eventCount: nil,
                                                   domainPayloadKeys: [],
                                                   localDiscoveryStage: nil,
                                                   resultStatus: nil,
                                                   completedToolCallCount: 0,
                                                   evidenceCount: 0,
                                                   currentUIRevision: nil,
                                                   error: nil)

    var path: String?
    var phase: String?
    var state: String?
    var lastSequence: UInt64?
    var eventCount: Int?
    var domainPayloadKeys: [String]
    var localDiscoveryStage: String?
    var resultStatus: String?
    var completedToolCallCount: Int
    var evidenceCount: Int
    var currentUIRevision: Int?
    var error: String?
}

private struct P9CAppSmokeLedgerSummary: Codable, Sendable {
    static let empty = P9CAppSmokeLedgerSummary(path: nil,
                                                exists: false,
                                                byteCount: 0,
                                                eventCount: 0)

    var path: String?
    var exists: Bool
    var byteCount: Int
    var eventCount: Int
}

private struct P9CAppSmokeEventTrace: Codable, Sendable {
    var sequenceNumber: Int
    var kind: String
    var title: String
    var detail: String?
    var stepID: String?
    var toolID: String?
    var source: String

    init(event: AgentTaskActivityEvent) {
        self.sequenceNumber = event.sequenceNumber
        self.kind = event.kind.rawValue
        self.title = event.presentation.title
        self.detail = event.presentation.detail
        self.stepID = event.stepID
        self.toolID = event.toolID?.rawValue
        self.source = event.source?.rawValue ?? "unknown"
    }
}

private enum P9CAppSmokeHarnessError: Error, CustomStringConvertible {
    case timeout(String)

    var description: String {
        switch self {
        case .timeout(let value):
            return "timeout: \(value)"
        }
    }
}

private extension AgentTaskStatus {
    var agentRunState: AgentRunState {
        switch self {
        case .created:
            return .created
        case .queued:
            return .queued
        case .planning:
            return .planning
        case .waitingForApproval:
            return .awaitingApproval
        case .waitingForPermission:
            return .awaitingPermission
        case .waitingForUser:
            return .awaitingUserInput
        case .running:
            return .running
        case .paused:
            return .interrupted
        case .synthesizing:
            return .streaming
        case .partiallySucceeded:
            return .partiallySucceeded
        case .succeeded:
            return .succeeded
        case .failed:
            return .failed
        case .cancelled:
            return .cancelled
        case .interrupted:
            return .interrupted
        case .unknown:
            return .unknown
        }
    }
}
#endif
