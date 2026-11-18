#if PHASE_HARNESS && DEBUG
import AppKit
import Foundation
import AICore
import PetAgentRuntime

enum P7AppRecoveryHarness {
    enum Phase: String {
        case seed
        case reload
    }

    static var requestedPhase: Phase? {
        guard let raw = ProcessInfo.processInfo.environment["DESKPET_P7_APP_RECOVERY_HARNESS_PHASE"] else {
            return nil
        }
        return Phase(rawValue: raw)
    }

    static var additionalTool: AnyAgentTool {
        AnyAgentTool(P7AppRecoveryWriteTool())
    }

    @MainActor
    static func runIfRequested(paths: DeskPetAppPaths,
                               activityStore: AgentTaskActivityStore,
                               providers: ProviderStore,
                               toolRegistry: ToolRegistry,
                               appGate: BrokerCapabilityGate,
                               checkpointStore: AgentCheckpointStore,
                               sideEffectLedgerStore: AgentSideEffectLedgerStore,
                               conformanceProfileStore: ModelConformanceProfileStore) async {
        guard let phase = requestedPhase else { return }
        do {
            let evidence: P7AppRecoveryEvidence
            switch phase {
            case .seed:
                evidence = try await seed(paths: paths,
                                          activityStore: activityStore,
                                          providers: providers,
                                          toolRegistry: toolRegistry,
                                          appGate: appGate,
                                          checkpointStore: checkpointStore,
                                          conformanceProfileStore: conformanceProfileStore)
            case .reload:
                evidence = try await reload(paths: paths,
                                            activityStore: activityStore,
                                            providers: providers,
                                            toolRegistry: toolRegistry,
                                            appGate: appGate,
                                            checkpointStore: checkpointStore,
                                            sideEffectLedgerStore: sideEffectLedgerStore,
                                            conformanceProfileStore: conformanceProfileStore)
            }
            let evidenceURL = try write(evidence: evidence, paths: paths)
            writeStderr("P7_APP_RECOVERY_HARNESS phase=\(phase.rawValue) ok=true evidence=\(evidenceURL.path)\n")
            NSApp.terminate(nil)
        } catch {
            let evidence = P7AppRecoveryEvidence(phase: phase.rawValue,
                                                 ok: false,
                                                 processID: ProcessInfo.processInfo.processIdentifier,
                                                 applicationSupportRoot: paths.applicationSupportRoot.path,
                                                 profileRoot: paths.profileRoot?.path,
                                                 error: String(describing: error))
            let evidenceURL = try? write(evidence: evidence, paths: paths)
            writeStderr("P7_APP_RECOVERY_HARNESS phase=\(phase.rawValue) ok=false error=\(error) evidence=\(evidenceURL?.path ?? "unwritten")\n")
            exit(1)
        }
    }

    @MainActor
    private static func seed(paths: DeskPetAppPaths,
                             activityStore: AgentTaskActivityStore,
                             providers: ProviderStore,
                             toolRegistry: ToolRegistry,
                             appGate: BrokerCapabilityGate,
                             checkpointStore: AgentCheckpointStore,
                             conformanceProfileStore: ModelConformanceProfileStore) async throws -> P7AppRecoveryEvidence {
        let metadata = P7AppRecoveryMetadata(taskID: UUID(),
                                             runID: UUID(),
                                             conversationID: UUID(),
                                             providerID: "p7.app.provider",
                                             modelID: "p7-app-model",
                                             counterPath: paths.applicationSupportRoot
                                                .appendingPathComponent("p7_app_recovery_counter_\(UUID().uuidString).txt")
                                                .path,
                                             phaseAProcessID: ProcessInfo.processInfo.processIdentifier)
        let document = resultDocument(taskID: metadata.taskID,
                                      runID: metadata.runID,
                                      revision: 31)
        let events = [
            event(.taskStarted,
                  taskID: metadata.taskID,
                  runID: metadata.runID,
                  sequence: 1,
                  payload: .task(.init(title: "P7 app recovery",
                                       status: "running",
                                       conversationID: metadata.conversationID))),
            event(.modelResponseStreaming,
                  taskID: metadata.taskID,
                  runID: metadata.runID,
                  sequence: 2,
                  payload: .model(.init(provider: "ollama",
                                        modelID: metadata.modelID,
                                        safeSummary: "app process recovery text"))),
            event(.toolSucceeded,
                  taskID: metadata.taskID,
                  runID: metadata.runID,
                  sequence: 3,
                  payload: .tool(.init(toolID: "get_current_datetime",
                                       toolCallID: "app-process-tool",
                                       displayName: "日期时间"))),
            event(.stepStarted,
                  taskID: metadata.taskID,
                  runID: metadata.runID,
                  sequence: 4,
                  payload: .step(.init(stepID: "app-process-pending",
                                       title: "等待恢复继续"))),
            resultEvent(document: document, sequence: 5),
        ]
        for envelope in events {
            activityStore.publish(envelope)
        }
        let checkpoint = try await awaitCheckpoint(store: checkpointStore,
                                                   taskID: metadata.taskID,
                                                   runID: metadata.runID,
                                                   minimumSequence: 5)
        try require(checkpoint.conversationID == metadata.conversationID, "phase A checkpoint conversation mismatch")
        try require(checkpoint.accumulatedAssistantText == "app process recovery text", "phase A checkpoint text mismatch")
        try require(checkpoint.pendingStepIDs == ["app-process-pending"], "phase A pending step missing")
        try require(checkpoint.currentUIRevision == 31, "phase A UI revision missing")

        let firstWrite = try await executeWrite(metadata: metadata,
                                                toolRegistry: toolRegistry,
                                                appGate: appGate)
        try require(firstWrite == 1, "phase A durable write did not return count=1")

        let provider = ProviderConfig(id: metadata.providerID,
                                      displayName: "P7 App Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://127.0.0.1:11434")!,
                                      defaultModelID: metadata.modelID,
                                      enabled: true,
                                      capabilities: [.chat, .streaming, .toolCalling])
        _ = await providers.upsert(provider, manualModelID: metadata.modelID)
        providers.setDefault(role: .tool, providerID: metadata.providerID, modelID: metadata.modelID)
        let profile = ModelConformanceProfile(providerID: metadata.providerID,
                                              providerType: .ollama,
                                              modelID: metadata.modelID,
                                              adapterVersion: ProviderType.ollama.rawValue,
                                              capabilities: [.chat, .streaming, .toolCalling],
                                              toolCalling: .structuredJSONFallback,
                                              trueStreamingSupported: true,
                                              supportsParallelToolCalls: false,
                                              allowedRoles: [.responder, .toolCaller],
                                              maxAutonomousSteps: 2,
                                              lastVerifiedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                              evidenceSummary: "P7 app process recovery harness")
        try await conformanceProfileStore.save(profile)
        try write(metadata: metadata, paths: paths)

        let taskVisible = activityStore.task(id: metadata.taskID) != nil
        let canonicalVisible = activityStore.canonicalTask(id: metadata.taskID) != nil
        return P7AppRecoveryEvidence(phase: Phase.seed.rawValue,
                                     ok: true,
                                     processID: ProcessInfo.processInfo.processIdentifier,
                                     applicationSupportRoot: paths.applicationSupportRoot.path,
                                     profileRoot: paths.profileRoot?.path,
                                     taskID: metadata.taskID,
                                     runID: metadata.runID,
                                     conversationID: metadata.conversationID,
                                     checkpointLastSequence: checkpoint.lastSequence,
                                     checkpointText: checkpoint.accumulatedAssistantText,
                                     pendingStepIDs: checkpoint.pendingStepIDs,
                                     completedToolCallIDs: checkpoint.completedToolCallIDs,
                                     currentUIRevision: checkpoint.currentUIRevision,
                                     counterValue: try String(contentsOfFile: metadata.counterPath, encoding: .utf8),
                                     writeResultCount: firstWrite,
                                     providerDefaultProviderID: providers.defaults.toolModelProviderID,
                                     providerDefaultModelID: providers.defaults.toolModelID,
                                     routeAppliedProfileID: profile.id,
                                     activityTaskVisible: taskVisible,
                                     canonicalTaskVisible: canonicalVisible,
                                     visibleWindowCount: visibleWindowCount())
    }

    @MainActor
    private static func reload(paths: DeskPetAppPaths,
                               activityStore: AgentTaskActivityStore,
                               providers: ProviderStore,
                               toolRegistry: ToolRegistry,
                               appGate: BrokerCapabilityGate,
                               checkpointStore: AgentCheckpointStore,
                               sideEffectLedgerStore: AgentSideEffectLedgerStore,
                               conformanceProfileStore: ModelConformanceProfileStore) async throws -> P7AppRecoveryEvidence {
        let metadata = try loadMetadata(paths: paths)
        try require(metadata.phaseAProcessID != ProcessInfo.processInfo.processIdentifier,
                    "phase B must run in a new app process")
        let eventStore = AgentRunEventStore(baseDirectory: paths.agentRunEventsDirectory)
        let restored = try await AgentRecoveryBootstrap().load(taskID: metadata.taskID,
                                                               runID: metadata.runID,
                                                               eventStore: eventStore,
                                                               checkpointStore: checkpointStore,
                                                               sideEffectLedgerStore: sideEffectLedgerStore,
                                                               conformanceProfileStore: conformanceProfileStore)
        let checkpoint = restored.checkpoint
        try require(checkpoint.conversationID == metadata.conversationID, "phase B checkpoint conversation mismatch")
        try require(checkpoint.lastSequence == 5, "phase B checkpoint sequence mismatch")
        try require(checkpoint.accumulatedAssistantText == "app process recovery text", "phase B checkpoint text mismatch")
        try require(checkpoint.completedToolCallIDs == ["app-process-tool"], "phase B completed tool missing")
        try require(checkpoint.pendingStepIDs == ["app-process-pending"], "phase B pending step missing")
        try require(checkpoint.currentUIRevision == 31, "phase B UI revision missing")
        let persistedActivity = try await JSONLAgentTaskActivityEventStore(fileURL: paths.agentTaskActivityURL)
            .loadEvents()
        activityStore.hydrate(persistedActivity)
        let taskVisible = activityStore.task(id: metadata.taskID) != nil
        let canonicalVisible = activityStore.canonicalTask(id: metadata.taskID) != nil
        try require(taskVisible, "phase B activity projection did not reload persisted task")
        try require(canonicalVisible, "phase B canonical activity projection did not reload persisted task")

        let replayedWrite = try await executeWrite(metadata: metadata,
                                                   toolRegistry: toolRegistry,
                                                   appGate: appGate)
        let counterValue = try String(contentsOfFile: metadata.counterPath, encoding: .utf8)
        try require(replayedWrite == 1, "phase B durable write was not replayed from ledger")
        try require(counterValue == "1", "phase B repeated a side effect")

        let policy = try await conformanceProfileStore.routingPolicy()
        let allowed = await ModelRouter().route(.tool,
                                                providers: providers.providers,
                                                defaults: providers.defaults,
                                                secretStore: providers.secretStore,
                                                conformancePolicy: policy,
                                                requestedAutonomousSteps: 2)
        let selection: ModelRouter.Selection
        switch allowed {
        case .success(let value):
            selection = value
        case .failure(let error):
            throw P7AppRecoveryHarnessError.assertion("phase B router denied allowed route: \(error)")
        }
        try require(selection.provider.id == metadata.providerID, "phase B router did not use persisted provider")
        try require(selection.conformance?.maxAutonomousSteps == 2, "phase B router did not apply max step profile")
        try require(selection.conformance?.parallelToolCallsAllowed == false, "phase B router did not apply parallel-tool profile")

        let deniedSteps = await ModelRouter().route(.tool,
                                                    providers: providers.providers,
                                                    defaults: providers.defaults,
                                                    secretStore: providers.secretStore,
                                                    conformancePolicy: policy,
                                                    requestedAutonomousSteps: 3)
        let deniedStepReason = try conformanceReason(from: deniedSteps,
                                                     containing: "autonomous_step_limit")
        let deniedParallel = await ModelRouter().route(.tool,
                                                       providers: providers.providers,
                                                       defaults: providers.defaults,
                                                       secretStore: providers.secretStore,
                                                       conformancePolicy: policy,
                                                       requestedAutonomousSteps: 2,
                                                       requiresParallelToolCalls: true)
        let deniedParallelReason = try conformanceReason(from: deniedParallel,
                                                         containing: "parallel_tool_calls_disabled")

        let ledger = try await sideEffectLedgerStore.loadLedger(taskID: metadata.taskID,
                                                               runID: metadata.runID)
        return P7AppRecoveryEvidence(phase: Phase.reload.rawValue,
                                     ok: true,
                                     processID: ProcessInfo.processInfo.processIdentifier,
                                     phaseAProcessID: metadata.phaseAProcessID,
                                     applicationSupportRoot: paths.applicationSupportRoot.path,
                                     profileRoot: paths.profileRoot?.path,
                                     taskID: metadata.taskID,
                                     runID: metadata.runID,
                                     conversationID: metadata.conversationID,
                                     checkpointLastSequence: checkpoint.lastSequence,
                                     checkpointText: checkpoint.accumulatedAssistantText,
                                     pendingStepIDs: checkpoint.pendingStepIDs,
                                     completedToolCallIDs: checkpoint.completedToolCallIDs,
                                     currentUIRevision: checkpoint.currentUIRevision,
                                     recoveryStrategy: restored.recoveryPlan.strategy.rawValue,
                                     recoveryWarnings: restored.warnings.map(\.rawValue).sorted(),
                                     counterValue: counterValue,
                                     writeResultCount: replayedWrite,
                                     durableLedgerStatuses: ledger.records.map(\.status.rawValue),
                                     providerDefaultProviderID: providers.defaults.toolModelProviderID,
                                     providerDefaultModelID: providers.defaults.toolModelID,
                                     routeAppliedProfileID: selection.conformance?.appliedProfileID,
                                     routeMaxAutonomousSteps: selection.conformance?.maxAutonomousSteps,
                                     routeDeniedSteps: deniedStepReason,
                                     routeDeniedParallel: deniedParallelReason,
                                     activityTaskVisible: taskVisible,
                                     canonicalTaskVisible: canonicalVisible,
                                     visibleWindowCount: visibleWindowCount())
    }

    private static func executeWrite(metadata: P7AppRecoveryMetadata,
                                     toolRegistry: ToolRegistry,
                                     appGate: BrokerCapabilityGate) async throws -> Double {
        await appGate.setTrustReversible(true)
        let request = AgentToolCallRequest(callID: "p7-app-write",
                                           toolName: P7AppRecoveryWriteTool.manifest.id.rawValue,
                                           arguments: .object(["counterPath": .string(metadata.counterPath)]),
                                           userVisibleSummary: "写入一次")
        let context = ToolExecutionContext(taskID: metadata.taskID,
                                           runID: metadata.runID,
                                           turnID: metadata.runID,
                                           callID: "p7-app-write",
                                           toolID: P7AppRecoveryWriteTool.manifest.id)
        switch await toolRegistry.executeTool(request: request, context: context) {
        case .success(let result):
            guard case .object(let object) = result.structuredData,
                  case .number(let count)? = object["count"] else {
                throw P7AppRecoveryHarnessError.assertion("durable write returned no count")
            }
            return count
        case .failure(let error):
            throw P7AppRecoveryHarnessError.assertion("durable write failed: \(error)")
        }
    }

    private static func conformanceReason(from result: Result<ModelRouter.Selection, ModelRouter.RoleRoutingError>,
                                          containing expected: String) throws -> String {
        guard case .failure(.conformanceDenied(let reason)) = result,
              reason.contains(expected) else {
            throw P7AppRecoveryHarnessError.assertion("expected conformance denial containing \(expected)")
        }
        return reason
    }

    private static func awaitCheckpoint(store: AgentCheckpointStore,
                                        taskID: UUID,
                                        runID: UUID,
                                        minimumSequence: UInt64) async throws -> AgentCheckpoint {
        for _ in 0..<80 {
            if let checkpoint = try await store.load(taskID: taskID, runID: runID),
               checkpoint.lastSequence >= minimumSequence {
                return checkpoint
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        throw P7AppRecoveryHarnessError.assertion("checkpoint was not persisted")
    }

    private static func event(_ kind: AgentEventKind,
                              taskID: UUID,
                              runID: UUID,
                              sequence: UInt64,
                              payload: AgentEventPayload = .empty) -> AgentEventEnvelope {
        AgentEventEnvelope(taskID: taskID,
                           runID: runID,
                           sequence: sequence,
                           timestamp: Date(timeIntervalSince1970: 1_800_000_000 + TimeInterval(sequence)),
                           source: .runtime,
                           kind: kind,
                           payload: payload)
    }

    private static func resultDocument(taskID: UUID,
                                       runID: UUID,
                                       revision: Int) -> AgentResultDocument {
        AgentResultDocument(id: "p7-app-result",
                            taskID: taskID,
                            runID: runID,
                            revision: revision,
                            title: "P7 恢复结果",
                            summary: "App process UI snapshot restore",
                            status: .completed,
                            generatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                            sections: [
                                AgentResultSection(id: "summary",
                                                   component: .text(.init("restored"))),
                            ])
    }

    private static func resultEvent(document: AgentResultDocument,
                                    sequence: UInt64) -> AgentEventEnvelope {
        event(.resultSnapshot,
              taskID: document.taskID,
              runID: document.runID,
              sequence: sequence,
              payload: .result(.init(title: document.title,
                                     summary: document.summary,
                                     document: document,
                                     eventKind: .snapshot)))
    }

    private static func metadataURL(paths: DeskPetAppPaths) -> URL {
        paths.applicationSupportRoot.appendingPathComponent("p7_app_recovery_metadata.json")
    }

    private static func evidenceURL(phase: String, paths: DeskPetAppPaths) -> URL {
        let directory = ProcessInfo.processInfo.environment["DESKPET_P7_APP_RECOVERY_EVIDENCE_DIR"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? paths.logsDirectory
        return directory.appendingPathComponent("p7_app_recovery_\(phase).json")
    }

    private static func write(metadata: P7AppRecoveryMetadata, paths: DeskPetAppPaths) throws {
        let url = metadataURL(paths: paths)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(metadata).write(to: url, options: .atomic)
    }

    private static func loadMetadata(paths: DeskPetAppPaths) throws -> P7AppRecoveryMetadata {
        let url = metadataURL(paths: paths)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw P7AppRecoveryHarnessError.assertion("missing metadata at \(url.path)")
        }
        return try JSONDecoder().decode(P7AppRecoveryMetadata.self, from: Data(contentsOf: url))
    }

    @discardableResult
    private static func write(evidence: P7AppRecoveryEvidence, paths: DeskPetAppPaths) throws -> URL {
        let url = evidenceURL(phase: evidence.phase, paths: paths)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(evidence).write(to: url, options: .atomic)
        return url
    }

    @MainActor
    private static func visibleWindowCount() -> Int {
        NSApp.windows.filter { $0.isVisible }.count
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition {
            throw P7AppRecoveryHarnessError.assertion(message)
        }
    }

    private static func writeStderr(_ string: String) {
        FileHandle.standardError.write(Data(string.utf8))
    }
}

private struct P7AppRecoveryMetadata: Codable {
    var taskID: UUID
    var runID: UUID
    var conversationID: UUID
    var providerID: String
    var modelID: String
    var counterPath: String
    var phaseAProcessID: Int32
}

private struct P7AppRecoveryEvidence: Codable {
    var phase: String
    var ok: Bool
    var processID: Int32
    var phaseAProcessID: Int32?
    var applicationSupportRoot: String
    var profileRoot: String?
    var taskID: UUID?
    var runID: UUID?
    var conversationID: UUID?
    var checkpointLastSequence: UInt64?
    var checkpointText: String?
    var pendingStepIDs: [String]
    var completedToolCallIDs: [String]
    var currentUIRevision: Int?
    var recoveryStrategy: String?
    var recoveryWarnings: [String]
    var counterValue: String?
    var writeResultCount: Double?
    var durableLedgerStatuses: [String]
    var providerDefaultProviderID: String?
    var providerDefaultModelID: String?
    var routeAppliedProfileID: String?
    var routeMaxAutonomousSteps: Int?
    var routeDeniedSteps: String?
    var routeDeniedParallel: String?
    var activityTaskVisible: Bool
    var canonicalTaskVisible: Bool
    var visibleWindowCount: Int
    var error: String?

    init(phase: String,
         ok: Bool,
         processID: Int32,
         phaseAProcessID: Int32? = nil,
         applicationSupportRoot: String,
         profileRoot: String? = nil,
         taskID: UUID? = nil,
         runID: UUID? = nil,
         conversationID: UUID? = nil,
         checkpointLastSequence: UInt64? = nil,
         checkpointText: String? = nil,
         pendingStepIDs: [String] = [],
         completedToolCallIDs: [String] = [],
         currentUIRevision: Int? = nil,
         recoveryStrategy: String? = nil,
         recoveryWarnings: [String] = [],
         counterValue: String? = nil,
         writeResultCount: Double? = nil,
         durableLedgerStatuses: [String] = [],
         providerDefaultProviderID: String? = nil,
         providerDefaultModelID: String? = nil,
         routeAppliedProfileID: String? = nil,
         routeMaxAutonomousSteps: Int? = nil,
         routeDeniedSteps: String? = nil,
         routeDeniedParallel: String? = nil,
         activityTaskVisible: Bool = false,
         canonicalTaskVisible: Bool = false,
         visibleWindowCount: Int = 0,
         error: String? = nil) {
        self.phase = phase
        self.ok = ok
        self.processID = processID
        self.phaseAProcessID = phaseAProcessID
        self.applicationSupportRoot = applicationSupportRoot
        self.profileRoot = profileRoot
        self.taskID = taskID
        self.runID = runID
        self.conversationID = conversationID
        self.checkpointLastSequence = checkpointLastSequence
        self.checkpointText = checkpointText
        self.pendingStepIDs = pendingStepIDs
        self.completedToolCallIDs = completedToolCallIDs
        self.currentUIRevision = currentUIRevision
        self.recoveryStrategy = recoveryStrategy
        self.recoveryWarnings = recoveryWarnings
        self.counterValue = counterValue
        self.writeResultCount = writeResultCount
        self.durableLedgerStatuses = durableLedgerStatuses
        self.providerDefaultProviderID = providerDefaultProviderID
        self.providerDefaultModelID = providerDefaultModelID
        self.routeAppliedProfileID = routeAppliedProfileID
        self.routeMaxAutonomousSteps = routeMaxAutonomousSteps
        self.routeDeniedSteps = routeDeniedSteps
        self.routeDeniedParallel = routeDeniedParallel
        self.activityTaskVisible = activityTaskVisible
        self.canonicalTaskVisible = canonicalTaskVisible
        self.visibleWindowCount = visibleWindowCount
        self.error = error
    }
}

private enum P7AppRecoveryHarnessError: Error, CustomStringConvertible {
    case assertion(String)

    var description: String {
        switch self {
        case .assertion(let message):
            return message
        }
    }
}

private struct P7AppRecoveryWriteInput: Codable, Sendable {
    var counterPath: String
}

private struct P7AppRecoveryWriteTool: AgentTool {
    static let manifest = ToolManifest(id: "p7.app_recovery_write_counter",
                                       displayName: "P7 app recovery write counter",
                                       shortDescription: "Increments an app-process recovery counter once.",
                                       category: .files,
                                       riskLevel: .externalSideEffectReversible,
                                       permissionRequirement: .capability("filesystem.workspace.write"),
                                       inputSchema: ToolJSONSchema(type: .object,
                                                                   properties: [
                                                                    "counterPath": ToolJSONSchema(type: .string),
                                                                   ],
                                                                   required: ["counterPath"]),
                                       outputContract: ToolOutputContract(description: "Counter result"),
                                       userVisibleExecutionSummary: "写入恢复计数")

    func execute(input: P7AppRecoveryWriteInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let url = URL(fileURLWithPath: input.counterPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let current = Int((try? String(contentsOf: url, encoding: .utf8)) ?? "0") ?? 0
        let next = current + 1
        try "\(next)".write(to: url, atomically: true, encoding: .utf8)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "写入完成",
                                   structuredData: .object(["count": .number(Double(next))]))
    }
}
#endif
