import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore
@testable import DeskPet

final class P7RecoveryConformanceTests: XCTestCase {
    func testAppRestartReplayRestoresTerminalStateAndUISnapshot() async throws {
        let taskID = UUID()
        let runID = UUID()
        let document = p7Document(taskID: taskID, runID: runID, revision: 2)
        let events = [
            p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p7ResultEvent(document: document, sequence: 2),
            p7Event(.taskSucceeded, taskID: taskID, runID: runID, sequence: 3,
                    payload: .task(.init(title: "完成", status: "succeeded"))),
        ]
        let directory = URL(fileURLWithPath: "/private/tmp/deskpet-p7-events-\(UUID().uuidString)", isDirectory: true)
        let store = AgentRunEventStore(baseDirectory: directory)
        for event in events {
            try await store.append(event)
        }

        let reloadedStore = AgentRunEventStore(baseDirectory: directory)
        let loaded = try await reloadedStore.loadEvents(runID: runID)
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: loaded)
        let plan = AgentRecoveryPlanner().plan(from: checkpoint)

        XCTAssertEqual(checkpoint.projection.state, .succeeded)
        XCTAssertEqual(checkpoint.resultDocument?.id, "p7-result")
        XCTAssertEqual(checkpoint.resultDocument?.revision, 2)
        XCTAssertEqual(checkpoint.replayState.visibleEvents.map(\.kind), [.taskStarted, .resultSnapshot, .taskSucceeded])
        XCTAssertEqual(plan.strategy, .replayOnly)
        XCTAssertFalse(plan.shouldEmitRecoveryEvents)
    }

    func testCancellationReplayDoesNotResumeOrEmitFurtherEvents() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p7Event(.taskCancelled, taskID: taskID, runID: runID, sequence: 2,
                    payload: .failure(.init(phase: "runtime",
                                            category: "cancelled",
                                            safeSummary: "user cancelled",
                                            recoverable: false,
                                            retryable: false))),
        ]

        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: events)
        let plan = AgentRecoveryPlanner().plan(from: checkpoint)

        XCTAssertEqual(checkpoint.projection.state, AgentRunState.cancelled)
        XCTAssertEqual(plan.strategy, AgentRecoveryStrategy.replayOnly)
        XCTAssertFalse(plan.shouldEmitRecoveryEvents)
        XCTAssertFalse(plan.shouldRepeatSideEffects)
    }

    func testToolCompletedButModelMissingResumesSynthesisWithoutRepeatingSideEffect() {
        let taskID = UUID()
        let runID = UUID()
        var ledger = AgentSideEffectLedger()
        XCTAssertTrue(ledger.recordStart(operationID: "write-calendar-1",
                                         taskID: taskID,
                                         runID: runID,
                                         toolID: "calendar.event.create",
                                         arguments: .object(["title": .string("Demo")]),
                                         at: Date(timeIntervalSince1970: 10)))
        XCTAssertTrue(ledger.recordCompletion(operationID: "write-calendar-1",
                                              status: .succeeded,
                                              result: .object(["id": .string("event-1")]),
                                              at: Date(timeIntervalSince1970: 11)))
        XCTAssertFalse(ledger.shouldExecute(operationID: "write-calendar-1"))

        let toolExecutionID = UUID()
        let events = [
            p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p7Event(.toolStarted, taskID: taskID, runID: runID, sequence: 2,
                    payload: .tool(.init(toolID: "calendar.event.create",
                                         toolCallID: "call-1",
                                         toolExecutionID: toolExecutionID,
                                         displayName: "创建日历"))),
            p7Event(.toolSucceeded, taskID: taskID, runID: runID, sequence: 3,
                    payload: .tool(.init(toolID: "calendar.event.create",
                                         toolCallID: "call-1",
                                         toolExecutionID: toolExecutionID,
                                         displayName: "创建日历"))),
            p7Event(.observationProduced, taskID: taskID, runID: runID, sequence: 4),
        ]

        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: events,
                                                             sideEffectLedger: ledger)
        let plan = AgentRecoveryPlanner().plan(from: checkpoint)

        XCTAssertEqual(checkpoint.phase, .awaitingModelSynthesis)
        XCTAssertEqual(checkpoint.completedToolCallIDs, ["call-1"])
        XCTAssertEqual(checkpoint.completedSideEffectOperationIDs, ["write-calendar-1"])
        XCTAssertEqual(plan.strategy, .resumeModelSynthesis)
        XCTAssertFalse(plan.shouldRepeatSideEffects)
    }

    func testDuplicateEventsAndSideEffectLedgerAreIdempotent() {
        let taskID = UUID()
        let runID = UUID()
        let eventID = UUID()
        let first = p7Event(.taskStarted, id: eventID, taskID: taskID, runID: runID, sequence: 1)
        let duplicate = p7Event(.taskStarted, id: eventID, taskID: taskID, runID: runID, sequence: 1)
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: [first, duplicate])
        XCTAssertEqual(checkpoint.eventCount, 1)
        XCTAssertEqual(checkpoint.replayState.allEvents.count, 1)

        var ledger = AgentSideEffectLedger()
        XCTAssertTrue(ledger.recordStart(operationID: "op-1",
                                         taskID: taskID,
                                         runID: runID,
                                         toolID: "filesystem.workspace.write",
                                         arguments: .object(["path": .string("a.txt")])))
        XCTAssertFalse(ledger.recordStart(operationID: "op-1",
                                          taskID: taskID,
                                          runID: runID,
                                          toolID: "filesystem.workspace.write",
                                          arguments: .object(["path": .string("a.txt")])))
        XCTAssertTrue(ledger.recordCompletion(operationID: "op-1",
                                              status: .succeeded,
                                              result: .object(["ok": .bool(true)])))
        XCTAssertFalse(ledger.recordCompletion(operationID: "op-1",
                                               status: .succeeded,
                                               result: .object(["ok": .bool(true)])))
        XCTAssertEqual(ledger.records.count, 1)
    }

    func testProviderStreamInterruptedRecoveryUsesConformanceProfile() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p7Event(.modelRequestStarted, taskID: taskID, runID: runID, sequence: 2),
            p7Event(.modelResponseStreaming, taskID: taskID, runID: runID, sequence: 3,
                    payload: .model(.init(provider: "minimax", modelID: "minimax-m3", safeSummary: "delta"))),
        ]
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: events)
        let streamingProfile = ModelConformanceProfile(providerType: .openAICompatible,
                                                       modelID: "minimax-m3",
                                                       capabilities: [.chat, .streaming],
                                                       toolCalling: .structuredJSONFallback,
                                                       trueStreamingSupported: true)
        let nonStreamingProfile = ModelConformanceProfile(providerType: .customHTTP,
                                                          modelID: "legacy",
                                                          capabilities: [.chat],
                                                          toolCalling: .unsupported,
                                                          trueStreamingSupported: false)

        XCTAssertEqual(checkpoint.phase, .providerStreamInterrupted)
        XCTAssertEqual(AgentRecoveryPlanner().plan(from: checkpoint,
                                                   providerConformance: streamingProfile).strategy,
                       .retryProviderStream)
        XCTAssertEqual(AgentRecoveryPlanner().plan(from: checkpoint,
                                                   providerConformance: nonStreamingProfile).strategy,
                       .resumeModelSynthesis)
    }

    func testConformanceProfileLimitsModelRolesToolCallingAndRequestFlags() {
        let minimax = ProviderConfig(displayName: "MiniMax",
                                     type: .openAICompatible,
                                     baseURL: URL(string: "https://api.minimaxi.com/v1")!,
                                     defaultModelID: "minimax-m3",
                                     capabilities: [.chat, .streaming, .toolCalling])
        let profile = ModelConformanceProfile.from(provider: minimax,
                                                   modelID: "minimax-m3",
                                                   verifiedAt: Date(timeIntervalSince1970: 20))
        let request = ModelConformanceRequest(requiredCapabilities: [.chat, .streaming, .toolCalling],
                                              requiredRole: .toolCaller,
                                              requiresNativeToolCalling: true,
                                              requiresTrueStreaming: true,
                                              requestedToolCalls: 2)
        let passing = ModelConformanceGate().report(profile: profile, request: request)
        XCTAssertTrue(passing.allowsRequest)
        XCTAssertEqual(profile.requiredRequestFlags["thinking.type"], "disabled")

        let limited = ModelConformanceProfile(providerType: .customHTTP,
                                              modelID: "chat-only",
                                              capabilities: [.chat],
                                              toolCalling: .unsupported,
                                              trueStreamingSupported: false,
                                              incompatibleFlags: ["native_tool_calls"],
                                              maxToolCalls: 0,
                                              allowedRoles: [.responder])
        let denied = ModelConformanceGate().report(
            profile: limited,
            request: ModelConformanceRequest(requiredCapabilities: [.chat, .toolCalling],
                                             requiredRole: .toolCaller,
                                             requiresNativeToolCalling: true,
                                             requiresTrueStreaming: true,
                                             requestedToolCalls: 1,
                                             requestFlags: ["native_tool_calls"]))

        XCTAssertFalse(denied.allowsRequest)
        XCTAssertTrue(denied.issues.contains { $0.kind == .roleDenied })
        XCTAssertTrue(denied.issues.contains { $0.kind == .unsupportedToolCalling })
        XCTAssertTrue(denied.issues.contains { $0.kind == .unsupportedStreaming })
        XCTAssertTrue(denied.issues.contains { $0.kind == .incompatibleFlag })
    }

    func testDurableCheckpointCrossInstanceRecoveryRestoresStateTextToolStepAndUISnapshot() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let conversationID = UUID()
        let document = p7Document(taskID: taskID, runID: runID, revision: 7)
        let events = [
            p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1,
                    payload: .task(.init(title: "恢复中", status: "running", conversationID: conversationID))),
            p7Event(.modelResponseStreaming, taskID: taskID, runID: runID, sequence: 2,
                    payload: .model(.init(provider: "ollama", modelID: "qwen", safeSummary: "已有文本"))),
            p7Event(.toolSucceeded, taskID: taskID, runID: runID, sequence: 3,
                    payload: .tool(.init(toolID: "get_current_datetime", toolCallID: "tool-1", displayName: "日期时间"))),
            p7Event(.stepStarted, taskID: taskID, runID: runID, sequence: 4,
                    payload: .step(.init(stepID: "pending-step", title: "继续执行"))),
            p7ResultEvent(document: document, sequence: 5),
        ]
        let eventStoreA = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        for event in events { try await eventStoreA.append(event) }
        let checkpointStoreA = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: events,
                                                             createdAt: Date(timeIntervalSince1970: 100))
        try await checkpointStoreA.save(checkpoint)

        let eventStoreB = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        let checkpointStoreB = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        let ledgerStoreB = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let profileStoreB = ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
        let restored = try await AgentRecoveryBootstrap().load(taskID: taskID,
                                                               runID: runID,
                                                               eventStore: eventStoreB,
                                                               checkpointStore: checkpointStoreB,
                                                               sideEffectLedgerStore: ledgerStoreB,
                                                               conformanceProfileStore: profileStoreB)

        XCTAssertEqual(restored.checkpoint.taskID, taskID)
        XCTAssertEqual(restored.checkpoint.runID, runID)
        XCTAssertEqual(restored.checkpoint.conversationID, conversationID)
        XCTAssertEqual(restored.checkpoint.lastSequence, 5)
        XCTAssertEqual(restored.checkpoint.accumulatedAssistantText, "已有文本")
        XCTAssertEqual(restored.checkpoint.completedToolCallIDs, ["tool-1"])
        XCTAssertEqual(restored.checkpoint.pendingStepIDs, ["pending-step"])
        XCTAssertEqual(restored.checkpoint.resultDocument?.revision, 7)
        XCTAssertEqual(restored.checkpoint.currentUIRevision, 7)
        XCTAssertEqual(restored.recoveryPlan.strategy, .requireUserReview)
    }

    func testDurableSideEffectCrashRecreateDoesNotExecuteWriteTwiceThroughToolRegistry() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let counter = root.appendingPathComponent("durable-counter.txt")
        let ledgerStoreA = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let registryA = ToolRegistry(gate: P7AllowPermissionGate(),
                                     audit: InMemoryAuditSink(),
                                     sideEffectLedgerStore: ledgerStoreA)
        try await registryA.register(P7DurableWriteTool())
        let request = AgentToolCallRequest(callID: "write-1",
                                           toolName: P7DurableWriteTool.manifest.id.rawValue,
                                           arguments: .object(["counterPath": .string(counter.path)]),
                                           userVisibleSummary: "写入一次")
        let context = ToolExecutionContext(taskID: taskID,
                                           runID: runID,
                                           turnID: runID,
                                           callID: "write-1",
                                           toolID: P7DurableWriteTool.manifest.id)
        guard case .success(let first) = await registryA.executeTool(request: request, context: context) else {
            return XCTFail("first write should succeed")
        }
        XCTAssertEqual(first.structuredData.objectValue?["count"], AgentJSONValue.number(1))

        let ledgerStoreB = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let registryB = ToolRegistry(gate: P7AllowPermissionGate(),
                                     audit: InMemoryAuditSink(),
                                     sideEffectLedgerStore: ledgerStoreB)
        try await registryB.register(P7DurableWriteTool())
        guard case .success(let second) = await registryB.executeTool(request: request, context: context) else {
            return XCTFail("second write should reuse durable result")
        }
        XCTAssertEqual(second.structuredData.objectValue?["count"], AgentJSONValue.number(1))
        XCTAssertEqual(try String(contentsOf: counter, encoding: .utf8), "1")
    }

    func testStartedSideEffectWithoutTerminalBecomesOutcomeUnknownAndDoesNotRetry() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let counter = root.appendingPathComponent("unknown-counter.txt")
        let ledgerStoreA = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let arguments: AgentJSONValue = .object(["counterPath": .string(counter.path)])
        let key = AgentSideEffectLedgerStore.idempotencyKey(taskID: taskID,
                                                           runID: runID,
                                                           toolID: P7DurableWriteTool.manifest.id,
                                                           arguments: arguments)
        let begin = try await ledgerStoreA.begin(operationID: key,
                                                 idempotencyKey: key,
                                                 taskID: taskID,
                                                 runID: runID,
                                                 toolID: P7DurableWriteTool.manifest.id,
                                                 capabilityID: "filesystem.workspace.write",
                                                 operationKind: "externalWrite",
                                                 arguments: arguments)
        XCTAssertEqual(begin, .started(operationID: key))

        let ledgerStoreB = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let registryB = ToolRegistry(gate: P7AllowPermissionGate(),
                                     audit: InMemoryAuditSink(),
                                     sideEffectLedgerStore: ledgerStoreB)
        try await registryB.register(P7DurableWriteTool())
        let request = AgentToolCallRequest(callID: "write-unknown",
                                           toolName: P7DurableWriteTool.manifest.id.rawValue,
                                           arguments: arguments,
                                           userVisibleSummary: "写入一次")
        let context = ToolExecutionContext(taskID: taskID,
                                           runID: runID,
                                           turnID: runID,
                                           callID: "write-unknown",
                                           toolID: P7DurableWriteTool.manifest.id)
        guard case .failure(let error) = await registryB.executeTool(request: request, context: context) else {
            return XCTFail("unknown side effect must block retry")
        }
        XCTAssertEqual(error, ToolPlatformError.executionFailed("side effect outcome unknown"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: counter.path))
        let ledger = try await ledgerStoreB.loadLedger(taskID: taskID, runID: runID)
        XCTAssertEqual(ledger.records.last?.status, .outcomeUnknown)
    }

    func testPersistedConformanceProfileRestrictsRecreatedModelRouter() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let provider = ProviderConfig(id: "local-ollama",
                                      displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://127.0.0.1:11434")!,
                                      defaultModelID: "qwen",
                                      capabilities: [.chat, .streaming, .toolCalling])
        let profile = ModelConformanceProfile(providerID: provider.id,
                                              providerType: provider.type,
                                              modelID: "qwen",
                                              adapterVersion: provider.type.rawValue,
                                              capabilities: [.chat, .streaming],
                                              toolCalling: .unsupported,
                                              trueStreamingSupported: true,
                                              supportsParallelToolCalls: false,
                                              allowedRoles: [.responder, .toolCaller],
                                              maxAutonomousSteps: 2,
                                              lastVerifiedAt: Date(timeIntervalSince1970: 1_800_000_000))
        let storeA = ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
        try await storeA.save(profile)

        let storeB = ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
        let policy = try await storeB.routingPolicy()
        let router = ModelRouter()
        let defaults = ModelRoleDefaults(toolModelProviderID: provider.id, toolModelID: "qwen")
        let result = await router.route(.tool,
                                        providers: [provider],
                                        defaults: defaults,
                                        secretStore: InMemorySecretStore(),
                                        conformancePolicy: policy,
                                        requestedAutonomousSteps: 2)
        guard case .success(let selection) = result else {
            return XCTFail("tool route should be allowed but constrained")
        }
        XCTAssertEqual(selection.conformance?.maxAutonomousSteps, 2)
        XCTAssertEqual(selection.conformance?.nativeToolCallingAllowed, false)
        XCTAssertEqual(selection.conformance?.parallelToolCallsAllowed, false)

        var forbidden = profile
        forbidden.forbiddenRoles = [.toolCaller]
        forbidden.allowedRoles = [.responder]
        try await storeB.save(forbidden)
        let deniedPolicy = try await storeB.routingPolicy()
        let denied = await router.route(.tool,
                                        providers: [provider],
                                        defaults: defaults,
                                        secretStore: InMemorySecretStore(),
                                        conformancePolicy: deniedPolicy,
                                        requestedAutonomousSteps: 2)
        guard case .failure(.conformanceDenied(let reason)) = denied else {
            return XCTFail("forbidden role must deny production router route")
        }
        XCTAssertTrue(reason.contains("role_denied"))
    }

    func testCorruptedCheckpointFallsBackToEventReplay() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let eventStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        try await eventStore.append(p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1))
        try await eventStore.append(p7Event(.taskSucceeded, taskID: taskID, runID: runID, sequence: 2,
                                            payload: .task(.init(title: "完成", status: "succeeded"))))
        let checkpointRoot = root.appendingPathComponent("checkpoints", isDirectory: true)
        let corruptURL = checkpointRoot
            .appendingPathComponent(taskID.uuidString, isDirectory: true)
            .appendingPathComponent(runID.uuidString)
            .appendingPathExtension("json")
        try FileManager.default.createDirectory(at: corruptURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not-json".utf8).write(to: corruptURL)

        let result = try await AgentRecoveryBootstrap().load(taskID: taskID,
                                                             runID: runID,
                                                             eventStore: eventStore,
                                                             checkpointStore: AgentCheckpointStore(baseDirectory: checkpointRoot),
                                                             sideEffectLedgerStore: AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true)),
                                                             conformanceProfileStore: ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true)))
        XCTAssertTrue(result.warnings.contains(.checkpointCorrupted))
        XCTAssertEqual(result.checkpoint.projection.state, .succeeded)
        XCTAssertEqual(result.checkpoint.lastSequence, 2)
    }

    func testCheckpointSequenceBehindAheadDuplicateAndGapUseSafeReplayStrategy() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p7Event(.modelResponseStreaming, taskID: taskID, runID: runID, sequence: 2,
                    payload: .model(.init(safeSummary: "a"))),
            p7Event(.modelResponseCompleted, taskID: taskID, runID: runID, sequence: 3,
                    payload: .model(.init(safeSummary: "b"))),
        ]
        let eventStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        for event in events { try await eventStore.append(event) }
        let checkpointStore = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        var behind = AgentCheckpointBuilder().checkpoint(taskID: taskID, runID: runID, events: Array(events.prefix(1)))
        behind.recoveryDisposition = "behind"
        try await checkpointStore.save(behind)
        let behindResult = try await AgentRecoveryBootstrap().load(taskID: taskID,
                                                                   runID: runID,
                                                                   eventStore: eventStore,
                                                                   checkpointStore: checkpointStore,
                                                                   sideEffectLedgerStore: AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true)),
                                                                   conformanceProfileStore: ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true)))
        XCTAssertTrue(behindResult.warnings.contains(.checkpointBehindEvents))
        XCTAssertEqual(behindResult.checkpoint.lastSequence, 3)

        var ahead = behindResult.checkpoint
        ahead.lastSequence = 99
        try await checkpointStore.save(ahead)
        let aheadResult = try await AgentRecoveryBootstrap().load(taskID: taskID,
                                                                  runID: runID,
                                                                  eventStore: eventStore,
                                                                  checkpointStore: checkpointStore,
                                                                  sideEffectLedgerStore: AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true)),
                                                                  conformanceProfileStore: ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true)))
        XCTAssertTrue(aheadResult.warnings.contains(.checkpointAheadOfEvents))
        XCTAssertEqual(aheadResult.checkpoint.lastSequence, 3)

        let duplicateRun = UUID()
        let duplicateStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("duplicate-events", isDirectory: true))
        try await duplicateStore.append(p7Event(.taskStarted, taskID: taskID, runID: duplicateRun, sequence: 1))
        try await duplicateStore.append(p7Event(.stepStarted, taskID: taskID, runID: duplicateRun, sequence: 1))
        let duplicateResult = try await AgentRecoveryBootstrap().load(taskID: taskID,
                                                                      runID: duplicateRun,
                                                                      eventStore: duplicateStore,
                                                                      checkpointStore: checkpointStore,
                                                                      sideEffectLedgerStore: AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true)),
                                                                      conformanceProfileStore: ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true)))
        XCTAssertTrue(duplicateResult.warnings.contains(.duplicateSequence))

        let gapRun = UUID()
        let gapStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("gap-events", isDirectory: true))
        try await gapStore.append(p7Event(.taskStarted, taskID: taskID, runID: gapRun, sequence: 1))
        try await gapStore.append(p7Event(.stepStarted, taskID: taskID, runID: gapRun, sequence: 3))
        let gapResult = try await AgentRecoveryBootstrap().load(taskID: taskID,
                                                                runID: gapRun,
                                                                eventStore: gapStore,
                                                                checkpointStore: checkpointStore,
                                                                sideEffectLedgerStore: AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true)),
                                                                conformanceProfileStore: ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true)))
        XCTAssertTrue(gapResult.warnings.contains(.missingSequence))
    }

    func testTerminalAndCancelledCheckpointsDoNotResumeExecution() async throws {
        let taskID = UUID()
        let completedRun = UUID()
        let cancelledRun = UUID()
        let completed = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                            runID: completedRun,
                                                            events: [
                                                                p7Event(.taskStarted, taskID: taskID, runID: completedRun, sequence: 1),
                                                                p7Event(.taskSucceeded, taskID: taskID, runID: completedRun, sequence: 2,
                                                                        payload: .task(.init(title: "完成", status: "succeeded"))),
                                                            ])
        let cancelled = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                            runID: cancelledRun,
                                                            events: [
                                                                p7Event(.taskStarted, taskID: taskID, runID: cancelledRun, sequence: 1),
                                                                p7Event(.taskCancelled, taskID: taskID, runID: cancelledRun, sequence: 2,
                                                                        payload: .failure(.init(phase: "runtime", category: "cancelled", safeSummary: "cancelled", recoverable: false, retryable: false))),
                                                            ])
        XCTAssertEqual(AgentRecoveryPlanner().plan(from: completed).strategy, .replayOnly)
        XCTAssertEqual(AgentRecoveryPlanner().plan(from: cancelled).strategy, .replayOnly)
        XCTAssertFalse(AgentRecoveryPlanner().plan(from: completed).shouldEmitRecoveryEvents)
        XCTAssertFalse(AgentRecoveryPlanner().plan(from: cancelled).shouldEmitRecoveryEvents)
    }

    func testDurableRecoveryStoresDoNotPersistSecretsOrReasoning() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: [
                                                                p7Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
                                                                p7Event(.modelResponseStreaming, taskID: taskID, runID: runID, sequence: 2,
                                                                        payload: .model(.init(safeSummary: "Bearer sk-secret1234567890 <think>hidden</think> visible"))),
                                                             ])
        try await AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true)).save(checkpoint)
        let ledgerStore = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let secretArguments: AgentJSONValue = .object([
            "Authorization": .string("Bearer sk-secret1234567890"),
            "Cookie": .string("session=super-secret-cookie"),
            "path": .string("/private/tmp/outside/id_rsa"),
        ])
        let key = AgentSideEffectLedgerStore.idempotencyKey(taskID: taskID,
                                                           runID: runID,
                                                           toolID: P7DurableWriteTool.manifest.id,
                                                           arguments: secretArguments)
        _ = try await ledgerStore.begin(operationID: key,
                                        idempotencyKey: key,
                                        taskID: taskID,
                                        runID: runID,
                                        toolID: P7DurableWriteTool.manifest.id,
                                        capabilityID: "filesystem.workspace.write",
                                        operationKind: "externalWrite",
                                        arguments: secretArguments)
        let profile = ModelConformanceProfile(providerID: "provider-secret",
                                              providerType: .openAICompatible,
                                              modelID: "minimax-m3",
                                              capabilities: [.chat],
                                              toolCalling: .unsupported,
                                              trueStreamingSupported: false,
                                              requiredRequestFlags: ["Authorization": "Bearer sk-secret1234567890"],
                                              evidenceSummary: "reasoning <think>hidden</think> visible")
        try await ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true)).save(profile)
        let raw = try p7RawText(in: root)
        XCTAssertFalse(raw.contains("sk-secret1234567890"))
        XCTAssertFalse(raw.contains("super-secret-cookie"))
        XCTAssertFalse(raw.contains("/private/tmp/outside/id_rsa"))
        XCTAssertFalse(raw.contains("<think>hidden</think>"))
    }

    @MainActor
    func testProductionActivityProjectionPersistsCheckpointFromRunEventStore() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let taskID = UUID()
        let runID = UUID()
        let conversationID = UUID()
        let runStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        let checkpointStore = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        let activityStore = AgentTaskActivityStore(persistence: nil,
                                                   eventHub: AgentEventHub(),
                                                   runEventStore: runStore,
                                                   checkpointStore: checkpointStore)
        activityStore.publish(p7Event(.taskStarted,
                                      taskID: taskID,
                                      runID: runID,
                                      sequence: 1,
                                      payload: .task(.init(title: "生产投影", status: "running", conversationID: conversationID))))
        activityStore.publish(p7Event(.modelResponseStreaming,
                                      taskID: taskID,
                                      runID: runID,
                                      sequence: 2,
                                      payload: .model(.init(provider: "ollama", modelID: "qwen", safeSummary: "生产恢复文本"))))

        let checkpoint = try await p7AwaitCheckpoint(store: checkpointStore, taskID: taskID, runID: runID)
        XCTAssertEqual(checkpoint.conversationID, conversationID)
        XCTAssertEqual(checkpoint.lastSequence, 2)
        XCTAssertEqual(checkpoint.accumulatedAssistantText, "生产恢复文本")
        _ = activityStore
    }

    @MainActor
    func testProductionProviderStorePersistsConformanceProfileForModelRouter() async throws {
        let root = p7TempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let profileStore = ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
        let providers = ProviderStore(fileURL: root.appendingPathComponent("providers.json"),
                                      secretStore: InMemorySecretStore(),
                                      conformanceProfileStore: profileStore)
        let providerID = providers.configureAutomationOllama(modelID: "qwen2.5")
        let profile = try await p7AwaitProfile(store: profileStore, providerID: providerID, modelID: "qwen2.5")
        let policy = try await profileStore.routingPolicy()

        let route = await ModelRouter().route(.companion,
                                              providers: providers.providers,
                                              defaults: providers.defaults,
                                              secretStore: providers.secretStore,
                                              conformancePolicy: policy)
        guard case .success(let selection) = route else {
            return XCTFail("production router should accept the persisted profile")
        }
        XCTAssertEqual(selection.provider.id, providerID)
        XCTAssertEqual(selection.conformance?.appliedProfileID, profile.id)
    }

    func testProcessPhaseASeedsDurableRecoveryIntegrationRootWhenEnabled() async throws {
        guard ProcessInfo.processInfo.environment["DESKPET_P7_PROCESS_INTEGRATION_PHASE"] == "seed" else {
            throw XCTSkip("Set DESKPET_P7_PROCESS_INTEGRATION_PHASE=seed to run phase A")
        }
        guard let rootPath = ProcessInfo.processInfo.environment["DESKPET_P7_PROCESS_INTEGRATION_ROOT"] else {
            throw XCTSkip("Set DESKPET_P7_PROCESS_INTEGRATION_ROOT to a unique temporary directory")
        }
        let root = URL(fileURLWithPath: rootPath, isDirectory: true)
        XCTAssertTrue(root.standardizedFileURL.path.contains("/deskpet-p7-process-"),
                      "process integration root must be unique and P7-scoped: \(root.path)")
        try? FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let metadata = P7ProcessIntegrationMetadata(taskID: UUID(),
                                                    runID: UUID(),
                                                    conversationID: UUID(),
                                                    providerID: "p7-process-provider",
                                                    modelID: "p7-process-model",
                                                    counterPath: root.appendingPathComponent("durable-counter.txt").path)
        let document = p7Document(taskID: metadata.taskID, runID: metadata.runID, revision: 21)
        let events = [
            p7Event(.taskStarted, taskID: metadata.taskID, runID: metadata.runID, sequence: 1,
                    payload: .task(.init(title: "process phase recovery",
                                         status: "running",
                                         conversationID: metadata.conversationID))),
            p7Event(.modelResponseStreaming, taskID: metadata.taskID, runID: metadata.runID, sequence: 2,
                    payload: .model(.init(provider: "ollama",
                                          modelID: metadata.modelID,
                                          safeSummary: "process phase text"))),
            p7Event(.toolSucceeded, taskID: metadata.taskID, runID: metadata.runID, sequence: 3,
                    payload: .tool(.init(toolID: "get_current_datetime",
                                         toolCallID: "process-tool",
                                         displayName: "日期时间"))),
            p7Event(.stepStarted, taskID: metadata.taskID, runID: metadata.runID, sequence: 4,
                    payload: .step(.init(stepID: "process-pending",
                                         title: "等待恢复继续"))),
            p7ResultEvent(document: document, sequence: 5),
        ]

        let eventStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        for event in events {
            try await eventStore.append(event)
        }
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: metadata.taskID,
                                                             runID: metadata.runID,
                                                             events: events)
        try await AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
            .save(checkpoint)

        let ledgerStore = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let registry = ToolRegistry(gate: P7AllowPermissionGate(),
                                    audit: InMemoryAuditSink(),
                                    sideEffectLedgerStore: ledgerStore)
        try await registry.register(P7DurableWriteTool())
        let writeRequest = AgentToolCallRequest(callID: "process-write",
                                                toolName: P7DurableWriteTool.manifest.id.rawValue,
                                                arguments: .object(["counterPath": .string(metadata.counterPath)]),
                                                userVisibleSummary: "写入一次")
        let context = ToolExecutionContext(taskID: metadata.taskID,
                                           runID: metadata.runID,
                                           turnID: metadata.runID,
                                           callID: "process-write",
                                           toolID: P7DurableWriteTool.manifest.id)
        guard case .success(let firstWrite) = await registry.executeTool(request: writeRequest, context: context) else {
            return XCTFail("phase A durable write should succeed")
        }
        XCTAssertEqual(firstWrite.structuredData.objectValue?["count"], AgentJSONValue.number(1))

        let profile = ModelConformanceProfile(providerID: metadata.providerID,
                                              providerType: .ollama,
                                              modelID: metadata.modelID,
                                              adapterVersion: ProviderType.ollama.rawValue,
                                              capabilities: [.chat, .streaming],
                                              toolCalling: .structuredJSONFallback,
                                              trueStreamingSupported: true,
                                              supportsParallelToolCalls: false,
                                              allowedRoles: [.responder, .toolCaller],
                                              maxAutonomousSteps: 2,
                                              lastVerifiedAt: Date(timeIntervalSince1970: 1_800_000_000))
        try await ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
            .save(profile)

        let metadataURL = root.appendingPathComponent("process-integration-metadata.json")
        let encoded = try JSONEncoder().encode(metadata)
        try encoded.write(to: metadataURL, options: .atomic)
    }

    func testProcessPhaseBReloadsDurableRecoveryIntegrationRootWhenEnabled() async throws {
        guard ProcessInfo.processInfo.environment["DESKPET_P7_PROCESS_INTEGRATION_PHASE"] == "reload" else {
            throw XCTSkip("Set DESKPET_P7_PROCESS_INTEGRATION_PHASE=reload to run phase B")
        }
        guard let rootPath = ProcessInfo.processInfo.environment["DESKPET_P7_PROCESS_INTEGRATION_ROOT"] else {
            throw XCTSkip("Set DESKPET_P7_PROCESS_INTEGRATION_ROOT to the phase A directory")
        }
        let root = URL(fileURLWithPath: rootPath, isDirectory: true)
        let metadataURL = root.appendingPathComponent("process-integration-metadata.json")
        let metadata = try JSONDecoder().decode(P7ProcessIntegrationMetadata.self,
                                                from: Data(contentsOf: metadataURL))

        let eventStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        let checkpointStore = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        let ledgerStore = AgentSideEffectLedgerStore(baseDirectory: root.appendingPathComponent("side-effects", isDirectory: true))
        let profileStore = ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
        let restored = try await AgentRecoveryBootstrap().load(taskID: metadata.taskID,
                                                               runID: metadata.runID,
                                                               eventStore: eventStore,
                                                               checkpointStore: checkpointStore,
                                                               sideEffectLedgerStore: ledgerStore,
                                                               conformanceProfileStore: profileStore)
        XCTAssertEqual(restored.checkpoint.conversationID, metadata.conversationID)
        XCTAssertEqual(restored.checkpoint.lastSequence, 5)
        XCTAssertEqual(restored.checkpoint.accumulatedAssistantText, "process phase text")
        XCTAssertEqual(restored.checkpoint.completedToolCallIDs, ["process-tool"])
        XCTAssertEqual(restored.checkpoint.pendingStepIDs, ["process-pending"])
        XCTAssertEqual(restored.checkpoint.resultDocument?.revision, 21)
        XCTAssertEqual(restored.checkpoint.currentUIRevision, 21)

        let registry = ToolRegistry(gate: P7AllowPermissionGate(),
                                    audit: InMemoryAuditSink(),
                                    sideEffectLedgerStore: ledgerStore)
        try await registry.register(P7DurableWriteTool())
        let writeRequest = AgentToolCallRequest(callID: "process-write",
                                                toolName: P7DurableWriteTool.manifest.id.rawValue,
                                                arguments: .object(["counterPath": .string(metadata.counterPath)]),
                                                userVisibleSummary: "写入一次")
        let context = ToolExecutionContext(taskID: metadata.taskID,
                                           runID: metadata.runID,
                                           turnID: metadata.runID,
                                           callID: "process-write",
                                           toolID: P7DurableWriteTool.manifest.id)
        guard case .success(let replayedWrite) = await registry.executeTool(request: writeRequest, context: context) else {
            return XCTFail("phase B durable write should reuse stored result")
        }
        XCTAssertEqual(replayedWrite.structuredData.objectValue?["count"], AgentJSONValue.number(1))
        XCTAssertEqual(try String(contentsOf: URL(fileURLWithPath: metadata.counterPath), encoding: .utf8), "1")

        let provider = ProviderConfig(id: metadata.providerID,
                                      displayName: "P7 Process Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://127.0.0.1:11434")!,
                                      defaultModelID: metadata.modelID,
                                      capabilities: [.chat, .streaming, .toolCalling])
        let policy = try await profileStore.routingPolicy()
        let defaults = ModelRoleDefaults(toolModelProviderID: metadata.providerID,
                                         toolModelID: metadata.modelID)
        let allowed = await ModelRouter().route(.tool,
                                                providers: [provider],
                                                defaults: defaults,
                                                secretStore: InMemorySecretStore(),
                                                conformancePolicy: policy,
                                                requestedAutonomousSteps: 2)
        guard case .success(let selection) = allowed else {
            return XCTFail("phase B router should load persisted profile")
        }
        XCTAssertEqual(selection.conformance?.maxAutonomousSteps, 2)
        XCTAssertEqual(selection.conformance?.nativeToolCallingAllowed, false)
        XCTAssertEqual(selection.conformance?.parallelToolCallsAllowed, false)

        let deniedSteps = await ModelRouter().route(.tool,
                                                    providers: [provider],
                                                    defaults: defaults,
                                                    secretStore: InMemorySecretStore(),
                                                    conformancePolicy: policy,
                                                    requestedAutonomousSteps: 3)
        guard case .failure(.conformanceDenied(let stepReason)) = deniedSteps else {
            return XCTFail("phase B router should enforce max autonomous steps")
        }
        XCTAssertTrue(stepReason.contains("autonomous_step_limit"))

        let deniedParallel = await ModelRouter().route(.tool,
                                                       providers: [provider],
                                                       defaults: defaults,
                                                       secretStore: InMemorySecretStore(),
                                                       conformancePolicy: policy,
                                                       requestedAutonomousSteps: 2,
                                                       requiresParallelToolCalls: true)
        guard case .failure(.conformanceDenied(let parallelReason)) = deniedParallel else {
            return XCTFail("phase B router should enforce parallel-tool restriction")
        }
        XCTAssertTrue(parallelReason.contains("parallel_tool_calls_disabled"))
    }
}

private struct P7ProcessIntegrationMetadata: Codable {
    var taskID: UUID
    var runID: UUID
    var conversationID: UUID
    var providerID: String
    var modelID: String
    var counterPath: String
}

private func p7Event(_ kind: AgentEventKind,
                     id: UUID = UUID(),
                     taskID: UUID,
                     runID: UUID,
                     sequence: UInt64,
                     timestamp: Date = Date(timeIntervalSince1970: 1_800_000_000),
                     source: AgentEventSource = .runtime,
                     payload: AgentEventPayload = .empty) -> AgentEventEnvelope {
    AgentEventEnvelope(id: id,
                       taskID: taskID,
                       runID: runID,
                       sequence: sequence,
                       timestamp: timestamp.addingTimeInterval(TimeInterval(sequence)),
                       source: source,
                       kind: kind,
                       payload: payload)
}

private func p7Document(taskID: UUID, runID: UUID, revision: Int) -> AgentResultDocument {
    AgentResultDocument(id: "p7-result",
                        taskID: taskID,
                        runID: runID,
                        revision: revision,
                        title: "恢复结果",
                        summary: "UI snapshot restore",
                        status: .completed,
                        generatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                        sections: [
                            AgentResultSection(id: "summary", component: .text(.init("restored"))),
                        ])
}

private func p7ResultEvent(document: AgentResultDocument,
                           sequence: UInt64) -> AgentEventEnvelope {
    p7Event(.resultSnapshot,
            taskID: document.taskID,
            runID: document.runID,
            sequence: sequence,
            payload: .result(.init(title: document.title,
                                   summary: document.summary,
                                   document: document,
                                   eventKind: .snapshot)))
}

private func p7TempRoot() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("deskpet-p7-\(UUID().uuidString)", isDirectory: true)
}

private func p7RawText(in root: URL) throws -> String {
    guard FileManager.default.fileExists(atPath: root.path) else { return "" }
    let urls = try FileManager.default.contentsOfDirectory(at: root,
                                                           includingPropertiesForKeys: [.isDirectoryKey],
                                                           options: [.skipsHiddenFiles])
    var result = ""
    for url in urls {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey])
        if values.isDirectory == true {
            result += try p7RawText(in: url)
        } else {
            result += (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        }
    }
    return result
}

private func p7AwaitCheckpoint(store: AgentCheckpointStore,
                               taskID: UUID,
                               runID: UUID) async throws -> AgentCheckpoint {
    for _ in 0..<40 {
        if let checkpoint = try await store.load(taskID: taskID, runID: runID),
           checkpoint.lastSequence >= 2 {
            return checkpoint
        }
        try await Task.sleep(nanoseconds: 25_000_000)
    }
    throw AgentDurableRecoveryStoreError.invalidDirectory
}

private func p7AwaitProfile(store: ModelConformanceProfileStore,
                            providerID: String,
                            modelID: String) async throws -> ModelConformanceProfile {
    for _ in 0..<40 {
        if let profile = try await store.loadAll().first(where: {
            $0.providerID == providerID && $0.modelID == modelID
        }) {
            return profile
        }
        try await Task.sleep(nanoseconds: 25_000_000)
    }
    throw AgentDurableRecoveryStoreError.invalidDirectory
}

private actor P7AllowPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: true,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired)
    }
}

private struct P7DurableWriteInput: Codable, Sendable {
    var counterPath: String
}

private struct P7DurableWriteTool: AgentTool {
    static let manifest = ToolManifest(id: "p7.durable_write_counter",
                                       displayName: "P7 durable write counter",
                                       shortDescription: "Increments a test counter once.",
                                       category: .files,
                                       riskLevel: .externalSideEffectReversible,
                                       permissionRequirement: .capability("filesystem.workspace.write"),
                                       inputSchema: ToolJSONSchema(type: .object,
                                                                   properties: [
                                                                    "counterPath": ToolJSONSchema(type: .string),
                                                                   ],
                                                                   required: ["counterPath"]),
                                       outputContract: ToolOutputContract(description: "Counter result"),
                                       userVisibleExecutionSummary: "写入测试计数")

    func execute(input: P7DurableWriteInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let url = URL(fileURLWithPath: input.counterPath)
        let current = Int((try? String(contentsOf: url, encoding: .utf8)) ?? "0") ?? 0
        let next = current + 1
        try "\(next)".write(to: url, atomically: true, encoding: .utf8)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "写入完成",
                                   structuredData: .object(["count": .number(Double(next))]))
    }
}

private extension AgentJSONValue {
    var objectValue: [String: AgentJSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }
}
