import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// MARK: - Fake runtime components (replace the old FakeGateway entirely)

private struct FakeContextBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event { return AgentContext(userText: message.text) }
        return AgentContext()
    }
}

private struct FakeReasoningModel: StructuredDecisionProviding {
    let decision: AgentDecision
    var source: DecisionSource = .modelStructured
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: decision, decisionSource: source, modelProvider: "fake")
    }
}

private actor FakeCapabilityBroker: CapabilityGate {
    let grantIDs: Set<String>
    private(set) var seen: [String] = []
    init(grant: Set<String>) { self.grantIDs = grant }
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen.append(capabilityID)
        return grantIDs.contains(capabilityID)
            ? .granted(CapabilityToken(raw: "tok", taskID: taskID, expiresAt: .distantFuture))
            : .denied(reason: "not granted")
    }
    func sawCount() -> Int { seen.count }
}

private actor AskUserCapabilityBroker: CapabilityGate {
    private(set) var seen: [String] = []
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen.append(capabilityID)
        return .askUser
    }
    func sawCount() -> Int { seen.count }
}

private actor FakeToolExecutor: ToolExecuting {
    private(set) var executed: [String] = []
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        executed.append(step.capabilityID)
        return ToolOutcome(ok: true, output: "did \(step.capabilityID)")
    }
    func count() async -> Int { executed.count }
}

private actor RecordingLedgerStore: AgentTaskLedgerPersisting {
    private(set) var stored: [AgentTaskLedgerEvent] = []
    var failAppend = false
    func append(_ event: AgentTaskLedgerEvent) async throws {
        if failAppend { throw NSError(domain: "ledger", code: 1) }
        if let op = event.operationID, stored.contains(where: { $0.operationID == op }) { return }
        stored.append(event)
    }
    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] {
        stored.filter { $0.taskID == taskID }.sorted { $0.sequence < $1.sequence }
    }
    func activeTasks() async throws -> [AgentTaskSnapshot] {
        let grouped = Dictionary(grouping: stored, by: \.taskID)
        return grouped.values.compactMap { events in
            guard let last = events.max(by: { $0.sequence < $1.sequence }),
                  !last.state.isTerminal else { return nil }
            return AgentTaskSnapshot(taskID: last.taskID, attemptID: last.attemptID,
                                     conversationID: last.conversationID,
                                     userMessageID: last.userMessageID,
                                     assistantMessageID: last.assistantMessageID,
                                     state: last.state, lastSequence: last.sequence,
                                     retryOfTaskID: last.retryOfTaskID,
                                     regeneratedFromMessageID: last.regeneratedFromMessageID,
                                     updatedAt: last.updatedAt)
        }
    }
    func hasOperationID(_ operationID: String) async throws -> Bool {
        stored.contains { $0.operationID == operationID }
    }
    func setFailAppend(_ value: Bool) { failAppend = value }
    func allEvents() async -> [AgentTaskLedgerEvent] { stored }
}

private struct EmptyMemoryRepo: PetBrainRepository {
    func memoryHints(forCloud: Bool) async -> [String] { [] }
}

private struct FakeConversationProvider: ConversationGenerating {
    var reply: String = "streamed reply"
    var emotion: PetEmotion = .neutral
    var viaCloud: Bool = false
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.metadata(viaCloud ? .trueStreaming : .nonStreaming))
            continuation.yield(.delta(sequence: 1, text: reply))
            continuation.yield(.completed(emotion: emotion, viaCloud: viaCloud))
            continuation.finish()
        }
    }
}

private struct SlowConversationProvider: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                continuation.yield(.metadata(.trueStreaming))
                continuation.yield(.delta(sequence: 1, text: "first"))
                try? await Task.sleep(nanoseconds: 80_000_000)
                if Task.isCancelled {
                    continuation.finish()
                    return
                }
                continuation.yield(.delta(sequence: 2, text: "second"))
                continuation.yield(.completed(emotion: .neutral, viaCloud: false))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private func policy(allowTools: Bool = true) -> AgentPolicy {
    AgentPolicy(allowTools: allowTools, maxSteps: 4, tier: .developerID)
}

private func respondDecision(_ text: String = "", _ emotion: PetEmotion = .neutral) -> AgentDecision {
    .respond(ConversationResponseDecision(text: text, emotion: emotion))
}

private func planDecision(_ goal: String, _ capabilities: [String]) -> AgentDecision {
    .proposePlan(AgentPlanProposal(goal: goal, steps: capabilities.enumerated().map { index, capability in
        AgentPlanProposalStep(id: "step-\(index + 1)", description: "执行 \(capability)", capabilityID: capability)
    }))
}

// MARK: - Scenario A: pure chat (no tool request)

final class ScenarioAChatTests: XCTestCase {
    func testPureChatProducesPresentationAndNoSideEffects() async {
        let exec = FakeToolExecutor()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("在呢，一起加油", .happy)),
            conversation: FakeConversationProvider(),
            gate: FakeCapabilityBroker(grant: []), executor: exec, policy: policy())
        let r = await c.run(.userMessage(text: "你好", conversationClass: .normal))
        let execCount = await exec.count()
        XCTAssertNotNil(r.presentation)
        XCTAssertTrue(r.executedSteps.isEmpty)         // no tools in chat (Scenario A)
        XCTAssertEqual(execCount, 0)
        XCTAssertTrue((r.presentation?.bubbles.joined() ?? "").contains("一起加油"))
    }

    func testStreamingRespondUsesConversationProviderAndNoSideEffects() async {
        let broker = FakeCapabilityBroker(grant: [])
        let exec = FakeToolExecutor()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: FakeConversationProvider(reply: "流式回复"),
            gate: broker, executor: exec, policy: policy())

        var events: [PetAgentRuntimeOutput] = []
        for await output in c.handle(.userMessage(text: "你好", conversationClass: .normal)) {
            events.append(output)
        }

        let nonActivityKinds = events.filter {
            if case .taskActivity = $0 { return false }
            return true
        }.map(\.testKind)
        let activityKinds = events.compactMap { output -> AgentTaskEventKind? in
            if case .taskActivity(let event) = output { return event.kind }
            return nil
        }
        let brokerSaw = await broker.sawCount()
        let execCount = await exec.count()
        XCTAssertEqual(nonActivityKinds, ["taskStarted", "providerMetadata", "responseStarted", "providerMetadata", "responseDelta", "responseCompleted", "presentation"])
        XCTAssertTrue(activityKinds.contains(.taskCreated))
        XCTAssertTrue(activityKinds.contains(.taskSucceeded))
        XCTAssertEqual(brokerSaw, 0)
        XCTAssertEqual(execCount, 0)
    }

    func testMultiDeltaOrderAndNonStreamingMetadataIsHonest() async {
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: FakeConversationProvider(reply: "完整回复"),
            gate: FakeCapabilityBroker(grant: []), executor: FakeToolExecutor(), policy: policy())

        var metadata: [ConversationProviderStreamingCapability] = []
        var deltas: [(Int, String)] = []
        var completed = 0
        for await output in c.handle(.userMessage(text: "你好", conversationClass: .normal)) {
            switch output {
            case .providerMetadata(let capability): metadata.append(capability)
            case .responseDelta(_, let sequence, let text): deltas.append((sequence, text))
            case .responseCompleted: completed += 1
            default: break
            }
        }

        XCTAssertTrue(metadata.contains(.nonStreaming))
        XCTAssertEqual(deltas.map(\.0), [1])
        XCTAssertEqual(deltas.map(\.1).joined(), "完整回复")
        XCTAssertEqual(completed, 1)
    }

    func testCancelAfterFirstDeltaDoesNotComplete() async {
        let conversationID = UUID()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: SlowConversationProvider(),
            gate: FakeCapabilityBroker(grant: []), executor: FakeToolExecutor(), policy: policy())

        var events: [PetAgentRuntimeOutput] = []
        for await output in c.handle(.userMessage(text: "讲久一点", conversationID: conversationID,
                                                 conversationClass: .normal)) {
            events.append(output)
            if case .responseDelta = output {
                await c.cancel(conversationID: conversationID)
                await c.cancel(conversationID: conversationID)
            }
        }

        let kinds = events.map(\.testKind)
        XCTAssertTrue(kinds.contains("cancelled"))
        XCTAssertFalse(kinds.contains("responseCompleted"))
    }
}

final class DurableLedgerTests: XCTestCase {
    private func event(taskID: UUID = UUID(), attemptID: UUID = UUID(), sequence: Int,
                       state: AgentTaskState, kind: RuntimeLedgerEventKind,
                       operationID: String? = nil) -> AgentTaskLedgerEvent {
        AgentTaskLedgerEvent(taskID: taskID, attemptID: attemptID, conversationID: UUID(),
                             userMessageID: UUID(), state: state, kind: kind,
                             sequence: sequence, operationID: operationID)
    }

    func testJSONLedgerReloadActiveAndOperationIdempotency() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-ledger-\(UUID().uuidString).json")
        let store = JSONAgentTaskLedgerStore(fileURL: url)
        let taskID = UUID(), attemptID = UUID()
        try await store.append(event(taskID: taskID, attemptID: attemptID, sequence: 0,
                                     state: .running, kind: .started))
        try await store.append(event(taskID: taskID, attemptID: attemptID, sequence: 1,
                                     state: .running, kind: .responseDelta, operationID: "op-1"))

        let reloaded = JSONAgentTaskLedgerStore(fileURL: url)
        let reloadedEvents = try await reloaded.events(for: taskID)
        let hasOperation = try await reloaded.hasOperationID("op-1")
        let active = try await reloaded.activeTasks()
        XCTAssertEqual(reloadedEvents.count, 2)
        XCTAssertTrue(hasOperation)
        XCTAssertEqual(active.first?.state, .running)

        try await reloaded.append(event(taskID: taskID, attemptID: attemptID, sequence: 2,
                                        state: .running, kind: .responseDelta, operationID: "op-1"))
        let dedupedEvents = try await reloaded.events(for: taskID)
        XCTAssertEqual(dedupedEvents.count, 2)

        try await reloaded.append(event(taskID: taskID, attemptID: attemptID, sequence: 2,
                                        state: .succeeded, kind: .completed))
        let activeAfterCompletion = try await reloaded.activeTasks()
        XCTAssertTrue(activeAfterCompletion.isEmpty)
    }

    func testJSONLedgerMigratesLegacyDecisionSource() async throws {
        let taskID = UUID()
        let attemptID = UUID()
        let conversationID = UUID()
        let userMessageID = UUID()
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("legacy-ledger-\(UUID().uuidString)", isDirectory: true)
        let url = dir.appendingPathComponent("agent_task_ledger.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let legacy = """
        [
          {
            "attemptID" : "\(attemptID.uuidString)",
            "conversationID" : "\(conversationID.uuidString)",
            "createdAt" : "2026-06-18T16:31:58Z",
            "decisionSource" : "ruleBasedStub",
            "id" : "\(UUID().uuidString)",
            "kind" : "created",
            "providerStreamingCapability" : "nonStreaming",
            "sequence" : 0,
            "state" : "queued",
            "taskID" : "\(taskID.uuidString)",
            "updatedAt" : "2026-06-18T16:31:58Z",
            "userMessageID" : "\(userMessageID.uuidString)"
          }
        ]
        """
        try legacy.write(to: url, atomically: true, encoding: .utf8)

        let store = JSONAgentTaskLedgerStore(fileURL: url)
        let migrated = try await store.events(for: taskID)
        XCTAssertEqual(migrated.first?.decisionSource, .ruleBasedFallback)

        try await store.append(event(taskID: taskID, attemptID: attemptID, sequence: 1,
                                     state: .running, kind: .started))
        let appended = try await store.events(for: taskID)
        XCTAssertEqual(appended.count, 2)
    }

    func testJSONLedgerCreatesMissingParentDirectoryForInjectedFileURL() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ledger-missing-parent-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("nested", isDirectory: true)
            .appendingPathComponent("agent_task_ledger.json")
        let store = JSONAgentTaskLedgerStore(fileURL: url)

        try await store.append(event(sequence: 0, state: .running, kind: .started))

        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testCoordinatorReconcileMarksRunningInterruptedButPreservesApprovalWait() async {
        // P14.1 — R-B-06 closure: the coordinator now consults
        // `RecoveryClassifier`. A running task is marked `.interruptedByRestart`
        // with state `.recovering` (not `.failed`) so the runtime can resume it
        // on a future launch. An `.awaitingPermission` task is left untouched
        // (no new events emitted).
        let runningLedger = RecordingLedgerStore()
        let taskID = UUID(), attemptID = UUID()
        try? await runningLedger.append(AgentTaskLedgerEvent(taskID: taskID, attemptID: attemptID,
                                                            conversationID: UUID(), userMessageID: UUID(),
                                                            assistantMessageID: UUID(), state: .running,
                                                            kind: .started, sequence: 0))
        let c = PetAgentRuntimeCoordinator(context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("x", .neutral)),
            conversation: FakeConversationProvider(), gate: FakeCapabilityBroker(grant: []),
            executor: FakeToolExecutor(), policy: policy(), ledger: runningLedger)
        _ = await c.reconcileAfterRestart()
        let runningEvents = await runningLedger.allEvents()
        XCTAssertEqual(runningEvents.last?.kind, .interruptedByRestart)
        XCTAssertEqual(runningEvents.last?.state, .recovering)

        let waitingLedger = RecordingLedgerStore()
        try? await waitingLedger.append(AgentTaskLedgerEvent(taskID: UUID(), attemptID: UUID(),
                                                            conversationID: UUID(), userMessageID: UUID(),
                                                            state: .awaitingPermission,
                                                            kind: .waitingForApproval, sequence: 0))
        let waitingCoordinator = PetAgentRuntimeCoordinator(context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("x", .neutral)),
            conversation: FakeConversationProvider(), gate: FakeCapabilityBroker(grant: []),
            executor: FakeToolExecutor(), policy: policy(), ledger: waitingLedger)
        _ = await waitingCoordinator.reconcileAfterRestart()
        let waitingEvents = await waitingLedger.allEvents()
        XCTAssertEqual(waitingEvents.count, 1)
    }

    func testLedgerAppendFailureEmitsFailedNotCompleted() async {
        let ledger = RecordingLedgerStore()
        await ledger.setFailAppend(true)
        let c = PetAgentRuntimeCoordinator(context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: FakeConversationProvider(), gate: FakeCapabilityBroker(grant: []),
            executor: FakeToolExecutor(), policy: policy(), ledger: ledger)
        var kinds: [String] = []
        for await output in c.handle(.userMessage(text: "你好", conversationClass: .normal)) {
            kinds.append(output.testKind)
        }
        XCTAssertEqual(kinds, ["failed"])
    }
}

@MainActor
final class RetryRegenerateChatModelTests: XCTestCase {
    private func makeChat(reply: String = "新的回复") -> ChatModel {
        let runtime = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: FakeConversationProvider(reply: reply),
            gate: FakeCapabilityBroker(grant: []), executor: FakeToolExecutor(),
            policy: policy(), ledger: RecordingLedgerStore())
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                                  repository: EmptyMemoryRepo())
        let store = ChatStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-\(UUID().uuidString).json"))
        return ChatModel(runtime: runtime,
                         services: services,
                         store: store,
                         activityStore: AgentTaskActivityStore(persistence: nil))
    }

    func testRetryCreatesNewAssistantAttemptWithoutDuplicatingUser() async throws {
        let chat = makeChat(reply: "retry ok")
        let user = ChatMessage(role: .user, text: "你好")
        let oldTaskID = UUID()
        let oldAttemptID = UUID()
        let failed = ChatMessage(role: .pet, text: "失败", status: .failed,
                                 taskID: oldTaskID, attemptID: oldAttemptID)
        chat.conversation.messages = [user, failed]

        chat.retry(failed)
        await waitForChatCondition {
            chat.conversation.messages.last?.retryOfMessageID == failed.id
                && chat.conversation.messages.last?.status == .completed
        }

        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .user }.count, 1)
        let retried = chat.conversation.messages.last
        XCTAssertEqual(retried?.role, .pet)
        XCTAssertEqual(retried?.status, .completed)
        XCTAssertEqual(retried?.retryOfMessageID, failed.id)
        XCTAssertEqual(retried?.taskID, oldTaskID)
        XCTAssertNotEqual(retried?.attemptID, oldAttemptID)
    }

    func testRegenerateCreatesLinkedAssistantWithoutDuplicatingUser() async throws {
        let chat = makeChat(reply: "regenerated")
        let user = ChatMessage(role: .user, text: "讲个笑话")
        let oldAssistant = ChatMessage(role: .pet, text: "旧回复", status: .completed)
        chat.conversation.messages = [user, oldAssistant]

        chat.regenerate(oldAssistant)
        await waitForChatCondition {
            chat.conversation.messages.last?.regeneratedFromMessageID == oldAssistant.id
                && chat.conversation.messages.last?.status == .completed
        }

        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .user }.count, 1)
        let regenerated = chat.conversation.messages.last
        XCTAssertEqual(regenerated?.role, .pet)
        XCTAssertEqual(regenerated?.status, .completed)
        XCTAssertEqual(regenerated?.regeneratedFromMessageID, oldAssistant.id)
        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .pet }.count, 2)
    }

    func testPendingMessageReconcilesToInterruptedOnRestart() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-restart-\(UUID().uuidString).json")
        let store = ChatStore(fileURL: url)
        var conversation = Conversation(kind: .normal)
        conversation.messages = [
            ChatMessage(role: .user, text: "长回复"),
            ChatMessage(role: .pet, text: "", status: .pending)
        ]
        try store.save([conversation])

        let runtime = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: FakeConversationProvider(),
            gate: FakeCapabilityBroker(grant: []), executor: FakeToolExecutor(),
            policy: policy(), ledger: RecordingLedgerStore())
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                                  repository: EmptyMemoryRepo())
        _ = ChatModel(runtime: runtime,
                      services: services,
                      store: store,
                      activityStore: AgentTaskActivityStore(persistence: nil))

        let reloaded = ChatStore(fileURL: url).load()
        XCTAssertEqual(reloaded.first?.messages.last?.status, .interrupted)
    }

    func testSendWithLegacyLedgerDoesNotSurfaceTaskRecordFailure() async throws {
        let taskID = UUID()
        let attemptID = UUID()
        let conversationID = UUID()
        let userMessageID = UUID()
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-legacy-ledger-\(UUID().uuidString)", isDirectory: true)
        let ledgerURL = dir.appendingPathComponent("agent_task_ledger.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let legacy = """
        [
          {
            "attemptID" : "\(attemptID.uuidString)",
            "conversationID" : "\(conversationID.uuidString)",
            "createdAt" : "2026-06-18T16:31:58Z",
            "decisionSource" : "ruleBasedStub",
            "id" : "\(UUID().uuidString)",
            "kind" : "created",
            "providerStreamingCapability" : "nonStreaming",
            "sequence" : 0,
            "state" : "queued",
            "taskID" : "\(taskID.uuidString)",
            "updatedAt" : "2026-06-18T16:31:58Z",
            "userMessageID" : "\(userMessageID.uuidString)"
          }
        ]
        """
        try legacy.write(to: ledgerURL, atomically: true, encoding: .utf8)
        let runtime = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("", .neutral)),
            conversation: FakeConversationProvider(reply: "在呢"),
            gate: FakeCapabilityBroker(grant: []), executor: FakeToolExecutor(),
            policy: policy(), ledger: JSONAgentTaskLedgerStore(fileURL: ledgerURL))
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                                  repository: EmptyMemoryRepo())
        let store = ChatStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-\(UUID().uuidString).json"))
        let chat = ChatModel(runtime: runtime,
                             services: services,
                             store: store,
                             activityStore: AgentTaskActivityStore(persistence: nil))

        chat.send("你好")
        await waitForChatCondition {
            chat.conversation.messages.contains {
                $0.role == .pet && $0.text.contains("在呢") && $0.status == .completed
            }
        }

        XCTAssertFalse(chat.conversation.messages.contains {
            $0.role == .pet && $0.text == "任务记录写入失败"
        })
        XCTAssertTrue(chat.conversation.messages.contains {
            $0.role == .pet && $0.text.contains("在呢") && $0.status == .completed
        })
    }
}

@MainActor
private func waitForChatCondition(_ predicate: @MainActor @escaping () -> Bool,
                                  timeout: TimeInterval = 2.0) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if predicate() { return }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

// MARK: - Scenario B: capability task — model/planner cannot bypass the broker

final class ScenarioBCapabilityTests: XCTestCase {

    func testGrantedCapabilityExecutesViaBrokerThenExecutor() async {
        let broker = FakeCapabilityBroker(grant: ["reminders.create"])
        let exec = FakeToolExecutor()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: planDecision("设提醒", ["reminders.create"])),
            conversation: FakeConversationProvider(),
            gate: broker, executor: exec, policy: policy())
        let r = await c.run(.userMessage(text: "帮我设个提醒", conversationClass: .normal))
        let execCount = await exec.count()
        let brokerSaw = await broker.sawCount()
        XCTAssertEqual(r.executedSteps, ["reminders.create"])
        XCTAssertEqual(execCount, 1)
        XCTAssertEqual(brokerSaw, 1)                    // went through the broker
        XCTAssertEqual(r.taskState, .succeeded)
    }

    func testDeniedCapabilityNeverExecutesDeterministicState() async {
        let broker = FakeCapabilityBroker(grant: [])    // deny everything
        let exec = FakeToolExecutor()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: planDecision("上传文件", ["network.upload"])),
            conversation: FakeConversationProvider(),
            gate: broker, executor: exec, policy: policy())
        let r = await c.run(.userMessage(text: "上传", conversationClass: .normal))
        let execCount = await exec.count()
        XCTAssertEqual(execCount, 0)                    // executor NEVER reached (§3, §6.3)
        XCTAssertEqual(r.deniedSteps, ["network.upload"])
        XCTAssertEqual(r.taskState, .partiallySucceeded)  // deterministic (§6.13)
    }

    func testToolsDisallowedDowngradesToDecline() async {
        let exec = FakeToolExecutor()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: planDecision("x", ["reminders.create"])),
            conversation: FakeConversationProvider(),
            gate: FakeCapabilityBroker(grant: ["reminders.create"]), executor: exec, policy: policy(allowTools: false))
        let r = await c.run(.userMessage(text: "设提醒", conversationClass: .normal))
        let execCount = await exec.count()
        XCTAssertEqual(execCount, 0)                    // policy forbids tools → no execution
        XCTAssertTrue(r.executedSteps.isEmpty)
    }

    func testAskUserFailsClosedAndNeverExecutes() async {
        let broker = AskUserCapabilityBroker()
        let exec = FakeToolExecutor()
        let c = PetAgentRuntimeCoordinator(
            context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: planDecision("设提醒", ["reminders.create"])),
            conversation: FakeConversationProvider(),
            gate: broker, executor: exec, policy: policy())

        var outputs: [PetAgentRuntimeOutput] = []
        for await output in c.handle(.userMessage(text: "明天早上提醒我交物理报告",
                                                 conversationClass: .normal)) {
            outputs.append(output)
        }

        let brokerSaw = await broker.sawCount()
        let execCount = await exec.count()
        XCTAssertEqual(brokerSaw, 1)
        XCTAssertEqual(execCount, 0)
        XCTAssertTrue(outputs.contains { if case .waitingForApproval("reminders.create") = $0 { true } else { false } })
        // P16 GAP-01: when the loop blocks on user approval, the coordinator
        // short-circuits converse() so we never emit a `.presentation` event
        // that contradicts the visible TaskActivityCard copy. The companion
        // approval card drives the UI; this test only needs to assert the
        // canonical `waitingForApproval` event is emitted and the runtime
        // does not surface any extra assistant bubble.
        XCTAssertFalse(outputs.contains {
            if case .presentation(let p) = $0 {
                return p.bubbles.joined().contains("审批界面尚未完成")
                    || p.bubbles.joined().contains("尚未完成")
            }
            return false
        })
    }
}

private extension PetAgentRuntimeOutput {
    var testKind: String {
        switch self {
        case .taskStarted: return "taskStarted"
        case .taskActivity: return "taskActivity"
        case .providerMetadata: return "providerMetadata"
        case .loopStateChanged: return "loopStateChanged"
        case .planUpdated: return "planUpdated"
        case .responseStarted: return "responseStarted"
        case .responseDelta: return "responseDelta"
        case .responseCompleted: return "responseCompleted"
        case .presentation: return "presentation"
        case .waitingForApproval: return "waitingForApproval"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .typedFailed: return "typedFailed"
        }
    }
}

// MARK: - Scenario C: proactive policy gating (no side effects either way)

final class ScenarioCProactiveTests: XCTestCase {
    private func inputs(busy: Bool = false, mode: ProactiveMode = .companion, cooldown: Bool = false,
                        privacy: Double = 0, urgency: Double = 0.3, value: Double = 0.7) -> ProactiveInputs {
        ProactiveInputs(urgency: urgency, companionshipValue: value, interruptionCost: 0.2,
                        privacyRisk: privacy, userBusy: busy, mode: mode, cooldownActive: cooldown)
    }

    func testAllowsCompanionship() {
        XCTAssertEqual(ProactivePolicyEngine.decide(inputs()), .allow)
    }
    func testDefersWhenUserBusy() {
        if case .deferred = ProactivePolicyEngine.decide(inputs(busy: true)) {} else { XCTFail() }
    }
    func testSuppressesOnCooldown() {
        if case .suppress = ProactivePolicyEngine.decide(inputs(cooldown: true)) {} else { XCTFail() }
    }
    func testDeniesOnPrivacyRisk() {
        if case .deny = ProactivePolicyEngine.decide(inputs(privacy: 0.9)) {} else { XCTFail() }
    }
    func testCriticalUrgencyOverridesQuiet() {
        XCTAssertEqual(ProactivePolicyEngine.decide(inputs(mode: .quiet, urgency: 0.95)), .allow)
    }
    func testRuntimeProactiveSuppressionHasNoPresentation() async {
        let c = PetAgentRuntimeCoordinator(context: FakeContextBuilder(),
            model: FakeReasoningModel(decision: respondDecision("x", .neutral)),
            conversation: FakeConversationProvider(),
            gate: FakeCapabilityBroker(grant: []), executor: FakeToolExecutor(), policy: policy())
        let r = await c.runProactive(inputs(cooldown: true))
        XCTAssertNil(r.presentation)                   // suppressed → no side effect, no surface
    }
}

// MARK: - Generic reliability semantics (migrated, vendor-neutral)

final class RuntimeReliabilityTests: XCTestCase {

    func testTaskLedgerHappyAndRebuild() {
        var co = AgentTaskCoordinator(definition: AgentTaskDefinition(goal: "g", workspace: "w"))
        co.start(); co.approve(); co.ingest(.stateChanged(.preparing)); co.ingest(.stateChanged(.running))
        co.ingest(.stateChanged(.succeeded))
        XCTAssertEqual(co.state, .succeeded)
        XCTAssertEqual(co.ledger.rebuiltState(), .succeeded)
    }
    func testOperationIdempotency() {
        var co = AgentTaskCoordinator(definition: AgentTaskDefinition(goal: "g", workspace: "w"))
        co.start(); co.approve(); co.ingest(.stateChanged(.preparing)); co.ingest(.stateChanged(.running))
        XCTAssertEqual(co.ingest(.fileChangeProposed(DiffRef(id: "d"), operationID: "op")), .applied)
        XCTAssertEqual(co.ingest(.fileChangeProposed(DiffRef(id: "d"), operationID: "op")), .ignoredDuplicate)
    }
    func testTerminalStateResolverFirstWins() {
        XCTAssertEqual(TerminalStateResolver.resolve(current: .succeeded, incoming: .cancelled), .succeeded)
        XCTAssertEqual(TerminalStateResolver.resolve(current: .running, incoming: .failed), .failed)
    }
    func testTaskStateReducerRejectsInvalid() {
        XCTAssertEqual(TaskStateReducer.reduce(.draft, .stateChanged(.running)), .draft)   // invalid skip
        XCTAssertEqual(TaskStateReducer.reduce(.running, .stateChanged(.succeeded)), .succeeded)
    }
    func testCoordinatorTerminalActivityPreservesPartialState() {
        let partial = ConversePipelineHelpers.terminalActivityDescriptor(for: .partiallySucceeded,
                                                                           stopReason: .completed)
        XCTAssertEqual(partial.kind, .taskPartiallySucceeded)
        XCTAssertEqual(partial.title, "任务部分完成")
        XCTAssertEqual(partial.failureCategory, .unknown)

        let failed = ConversePipelineHelpers.terminalActivityDescriptor(for: .failed,
                                                                          stopReason: .toolFailure)
        XCTAssertEqual(failed.kind, .taskFailed)
        XCTAssertEqual(failed.failureCategory, .toolFailed)

        let cancelled = ConversePipelineHelpers.terminalActivityDescriptor(for: .cancelled,
                                                                             stopReason: .cancelled)
        XCTAssertEqual(cancelled.kind, .taskCancelled)
        XCTAssertEqual(cancelled.failureCategory, .cancelled)
    }
    func testDedupOrderingBackpressureBackoff() {
        var d = EventDeduplicator(); XCTAssertTrue(d.accept(seq: 1)); XCTAssertFalse(d.accept(seq: 1))
        var s = EventSequencer(); XCTAssertTrue(s.inOrder(seq: 2)); XCTAssertFalse(s.inOrder(seq: 1))
        var q = RuntimeEventQueue<Int>(capacity: 2); q.enqueue(1); q.enqueue(2); q.enqueue(3)
        XCTAssertEqual(q.dropped, 1)
        let b = BackoffPolicy(base: 1, multiplier: 2, cap: 3, maxAttempts: 5)
        XCTAssertEqual(b.delay(attempt: 0), 1); XCTAssertEqual(b.delay(attempt: 5), nil); XCTAssertEqual(b.delay(attempt: 4), 3)
    }
    func testCancellationIdempotency() {
        var co = AgentTaskCoordinator(definition: AgentTaskDefinition(goal: "g", workspace: "w", rollbackOnCancel: false))
        co.start(); co.approve(); co.ingest(.stateChanged(.preparing)); co.ingest(.stateChanged(.running))
        co.cancel()
        XCTAssertEqual(co.state, .cancelled)
        XCTAssertEqual(co.cancel(), .rejectedTransition(from: .cancelled, to: .cancelling))  // no-op when terminal
    }
}
