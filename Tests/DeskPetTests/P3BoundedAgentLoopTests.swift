import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

private enum P3TestError: Error {
    case provider
}

private func p3Context(_ text: String = "test") -> AgentContext {
    AgentContext(userText: text)
}

private func p3Final(_ text: String) -> AgentLoopDecisionResult {
    AgentLoopDecisionResult(decision: .finalResponse(AgentFinalResponse(text: text)),
                            decisionSource: .modelStructured,
                            modelProvider: "p3-script")
}

private func p3Tool(_ toolName: String,
                    callID: String,
                    args: [String: AgentJSONValue] = [:],
                    summary: String = "正在读取当前应用状态") -> AgentLoopDecisionResult {
    AgentLoopDecisionResult(decision: .toolCall(AgentToolCallRequest(
        callID: callID,
        toolName: toolName,
        arguments: .object(args),
        userVisibleSummary: summary)),
        decisionSource: .modelStructured,
        modelProvider: "p3-script")
}

private actor P3ScriptedLoopProvider: AgentLoopDecisionProviding {
    private var decisions: [AgentLoopDecisionResult]
    private let delayNanos: UInt64
    private(set) var contexts: [AgentLoopDecisionContext] = []

    init(_ decisions: [AgentLoopDecisionResult], delayNanos: UInt64 = 0) {
        self.decisions = decisions
        self.delayNanos = delayNanos
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        contexts.append(context)
        if delayNanos > 0 {
            try await Task.sleep(nanoseconds: delayNanos)
        }
        guard !decisions.isEmpty else { return p3Final("done") }
        return decisions.removeFirst()
    }

    func callCount() -> Int { contexts.count }
    func lastContext() -> AgentLoopDecisionContext? { contexts.last }
}

private actor P3Gate: CapabilityGate {
    enum Mode { case allow, deny, askUser }
    private let mode: Mode
    private(set) var seen: [String] = []

    init(_ mode: Mode = .allow) {
        self.mode = mode
    }

    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen.append(capabilityID)
        switch mode {
        case .allow:
            return .granted(CapabilityToken(raw: "tok-\(capabilityID)", taskID: taskID, expiresAt: .distantFuture))
        case .deny:
            return .denied(reason: "denied")
        case .askUser:
            return .askUser
        }
    }

    func count() -> Int { seen.count }
}

private actor P3Executor: ToolExecuting {
    private var outcomes: [ToolOutcome]
    private let delayNanos: UInt64
    private(set) var executed: [String] = []
    private var active = 0
    private(set) var maxActive = 0

    init(outcomes: [ToolOutcome] = [ToolOutcome(ok: true, output: "ok")],
         delayNanos: UInt64 = 0) {
        self.outcomes = outcomes
        self.delayNanos = delayNanos
    }

    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        active += 1
        maxActive = max(maxActive, active)
        defer { active -= 1 }
        executed.append(step.capabilityID)
        if delayNanos > 0 {
            try? await Task.sleep(nanoseconds: delayNanos)
        }
        guard !outcomes.isEmpty else { return ToolOutcome(ok: true, output: "ok") }
        return outcomes.removeFirst()
    }

    func count() -> Int { executed.count }
    func maxActiveCount() -> Int { maxActive }
}

private func p3Limits(maxIterations: Int = 4,
                      maxToolCalls: Int = 3,
                      modelTimeout: TimeInterval = 0.2,
                      toolTimeout: TimeInterval = 0.2,
                      observationLimit: Int = 2_048) -> AgentLoopLimits {
    AgentLoopLimits(maxIterations: maxIterations,
                    maxToolCalls: maxToolCalls,
                    modelRequestTimeout: modelTimeout,
                    toolExecutionTimeout: toolTimeout,
                    maxObservationCharacters: observationLimit)
}

private func p3Controller(provider: any AgentLoopDecisionProviding,
                          gate: any CapabilityGate = P3Gate(),
                          executor: any ToolExecuting = P3Executor(),
                          limits: AgentLoopLimits = p3Limits()) -> AgentLoopController {
    AgentLoopController(provider: provider,
                        gate: gate,
                        executor: executor,
                        policy: AgentPolicy(allowTools: true, maxSteps: 4,
                                            maxIterations: limits.maxIterations,
                                            maxToolCalls: limits.maxToolCalls,
                                            maxWallClock: limits.turnDeadline,
                                            tier: .developerID),
                        limits: limits)
}

final class P3BoundedAgentLoopControllerTests: XCTestCase {
    func testDirectFinalResponseDoesNotCallTool() async {
        let exec = P3Executor()
        let controller = p3Controller(provider: P3ScriptedLoopProvider([p3Final("直接回复")]),
                                      executor: exec)
        let result = await controller.run(agentContext: p3Context(), taskID: UUID())

        let execCount = await exec.count()
        XCTAssertEqual(result.finalResponse?.text, "直接回复")
        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertEqual(execCount, 0)
    }

    func testSingleToolThenFinalResponse() async {
        let exec = P3Executor(outcomes: [ToolOutcome(ok: true, output: "status ok")])
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-1"),
            p3Final("读完了")
        ])
        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.usedToolNames, ["state.read"])
        XCTAssertEqual(result.toolStatuses, [.success])
        XCTAssertEqual(result.finalResponse?.text, "读完了")
        XCTAssertEqual(result.toolCallCount, 1)
    }

    func testTwoDifferentToolsRunSeriallyThenFinish() async {
        let exec = P3Executor(outcomes: [
            ToolOutcome(ok: true, output: "state ok"),
            ToolOutcome(ok: true, output: "timer ok")
        ])
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-a"),
            p3Tool("timer.local", callID: "call-b",
                   args: ["durationSeconds": .number(1), "title": .string("短计时")],
                   summary: "正在设置计时器"),
            p3Final("全部完成")
        ])

        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        let maxActive = await exec.maxActiveCount()
        XCTAssertEqual(result.usedToolNames, ["state.read", "timer.local"])
        XCTAssertEqual(result.toolCallCount, 2)
        XCTAssertEqual(maxActive, 1)
    }

    func testUnknownToolBecomesObservationAndIsNotExecuted() async {
        let exec = P3Executor()
        let provider = P3ScriptedLoopProvider([
            p3Tool("unknown.tool", callID: "call-unknown"),
            p3Final("没有这个工具")
        ])

        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        let execCount = await exec.count()
        XCTAssertEqual(execCount, 0)
        XCTAssertEqual(result.observations.first?.status, .failed)
        XCTAssertEqual(result.stopReason, .toolFailure)
        XCTAssertEqual(result.finalResponse?.text, "工具执行失败，我先基于已有结果回答。")
    }

    func testInvalidArgumentsDoNotReachExecutor() async {
        let exec = P3Executor()
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-bad-args",
                   args: ["nested": .object(["x": .string("y")])]),
            p3Final("参数错误已处理")
        ])

        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        let execCount = await exec.count()
        XCTAssertEqual(execCount, 0)
        XCTAssertEqual(result.observations.first?.status, .failed)
        XCTAssertEqual(result.stopReason, .toolFailure)
        XCTAssertEqual(result.finalResponse?.text, "工具执行失败，我先基于已有结果回答。")
    }

    func testCapabilityGateDeniedFeedsObservationToFinalDecision() async {
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-denied"),
            p3Final("权限不足，所以只能说明限制")
        ])

        let result = await p3Controller(provider: provider, gate: P3Gate(.deny))
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.observations.first?.status, .denied)
        XCTAssertEqual(result.stopReason, .permissionDenied)
        XCTAssertEqual(result.finalResponse?.text, "权限未允许，我不能继续执行该工具。")
    }

    func testCapabilityGateAskUserStopsWithoutExecution() async {
        let exec = P3Executor()
        let result = await p3Controller(provider: P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-approval")
        ]), gate: P3Gate(.askUser), executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        let execCount = await exec.count()
        XCTAssertEqual(execCount, 0)
        XCTAssertEqual(result.waitingApproval, ["state.read"])
        XCTAssertEqual(result.stopReason, .permissionDenied)
    }

    func testToolFailureCanStillProduceFinalExplanation() async {
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-fail"),
            p3Final("工具失败，但我可以解释")
        ])
        let exec = P3Executor(outcomes: [ToolOutcome(ok: false, output: "", error: "failed")])

        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.observations.first?.status, .failed)
        XCTAssertEqual(result.stopReason, .toolFailure)
        XCTAssertEqual(result.finalResponse?.text, "工具执行失败，我先基于已有结果回答。")
    }

    func testToolTimeoutBecomesTimeoutObservation() async {
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-slow"),
            p3Final("工具超时了")
        ])
        let exec = P3Executor(delayNanos: 200_000_000)

        let result = await p3Controller(provider: provider,
                                        executor: exec,
                                        limits: p3Limits(toolTimeout: 0.02))
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.observations.first?.status, .timeout)
        XCTAssertEqual(result.stopReason, .toolTimeout)
        XCTAssertEqual(result.finalResponse?.text, "工具执行超时，我先基于已知结果回答。")
    }

    func testModelRequestTimeoutStopsTurn() async {
        let provider = P3ScriptedLoopProvider([p3Final("too late")], delayNanos: 200_000_000)

        let result = await p3Controller(provider: provider,
                                        limits: p3Limits(modelTimeout: 0.02))
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.stopReason, .modelTimeout)
        XCTAssertNil(result.finalResponse)
    }

    func testCancellationStopsTurnAndClearsTerminalState() async {
        let result = await p3Controller(provider: P3ScriptedLoopProvider([p3Final("no")]))
            .run(agentContext: p3Context(), taskID: UUID(), isCancelled: { true })

        XCTAssertEqual(result.stopReason, .cancelled)
        XCTAssertEqual(result.terminalState, .cancelled)
    }

    func testMalformedJSONDecisionRepairsOnceThenSucceeds() async {
        let provider = RawAgentLoopDecisionProvider { context, _ in
            context.repairAttempt == 0
                ? "{not json"
                : #"{"type":"final","text":"修复成功"}"#
        }

        let result = await p3Controller(provider: provider)
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.finalResponse?.text, "修复成功")
        XCTAssertEqual(result.stopReason, .completed)
    }

    func testMalformedJSONAfterRepairStopsSafely() async {
        let provider = RawAgentLoopDecisionProvider { _, _ in "{not json" }

        let result = await p3Controller(provider: provider)
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.stopReason, .malformedDecision)
        XCTAssertEqual(result.terminalState, .failed)
    }

    func testRepeatedIdenticalToolCallIsBlocked() async {
        let exec = P3Executor(outcomes: [
            ToolOutcome(ok: true, output: "first")
        ])
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-1"),
            p3Tool("state.read", callID: "call-2"),
            p3Final("should not need this")
        ])

        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        let execCount = await exec.count()
        XCTAssertEqual(execCount, 1)
        XCTAssertEqual(result.stopReason, .repeatedToolCall)
    }

    func testMaxIterationsStopsRunaway() async {
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-1"),
            p3Tool("timer.local", callID: "call-2", args: ["durationSeconds": .number(1)]),
            p3Tool("calendar.events.read", callID: "call-3")
        ])

        let result = await p3Controller(provider: provider,
                                        limits: p3Limits(maxIterations: 2, maxToolCalls: 3))
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.stopReason, .iterationLimit)
        XCTAssertEqual(result.toolCallCount, 2)
    }

    func testMaxToolCallsStopsRunaway() async {
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-1"),
            p3Tool("timer.local", callID: "call-2", args: ["durationSeconds": .number(1)])
        ])

        let result = await p3Controller(provider: provider,
                                        limits: p3Limits(maxIterations: 4, maxToolCalls: 1))
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.stopReason, .toolCallLimit)
        XCTAssertEqual(result.toolCallCount, 1)
    }

    func testObservationIsTruncated() async {
        let huge = String(repeating: "visible observation chunk ", count: 12)
        let limits = p3Limits(observationLimit: 128)
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-huge"),
            p3Final("done")
        ])
        let exec = P3Executor(outcomes: [ToolOutcome(ok: true, output: huge)])

        let result = await p3Controller(provider: provider,
                                        executor: exec,
                                        limits: limits)
            .run(agentContext: p3Context(), taskID: UUID())

        XCTAssertEqual(result.observations.first?.isTruncated, true)
        XCTAssertLessThanOrEqual(result.observations.first?.userSafeSummary.count ?? 999,
                                 limits.maxObservationCharacters)
    }

    func testObservationRedactsSensitiveFieldsAndPaths() async {
        let output = "Bearer " + "sk-" + String(repeating: "x", count: 32) + " at /private/tmp/fixture-secret.txt"
        let provider = P3ScriptedLoopProvider([
            p3Tool("state.read", callID: "call-secret"),
            p3Final("done")
        ])
        let exec = P3Executor(outcomes: [ToolOutcome(ok: true, output: output)])

        let result = await p3Controller(provider: provider, executor: exec)
            .run(agentContext: p3Context(), taskID: UUID())

        let summary = result.observations.first?.userSafeSummary ?? ""
        XCTAssertFalse(summary.contains("sk-" + String(repeating: "x", count: 32)))
        XCTAssertFalse(summary.contains("/private/tmp/fixture-secret.txt"))
        XCTAssertTrue(summary.contains("[redacted"))
    }

    func testReasoningFieldsAndThinkTagsAreRemovedFromFinalText() throws {
        let result = try AgentLoopDecisionParser.parse(raw: """
        {"type":"final","text":"<think>内部推理</think>好的","reasoning_content":"secret"}
        """)
        guard case .finalResponse(let final) = result.decision else {
            return XCTFail("expected final")
        }
        XCTAssertEqual(final.text, "好的")
        XCTAssertFalse(final.text.contains("内部推理"))
    }
}

private struct P3StructuredModel: StructuredDecisionProviding {
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        if context.observations.isEmpty {
            return StructuredDecisionResult(decision: .proposePlan(AgentPlanProposal(goal: "read", steps: [
                AgentPlanProposalStep(id: "s1", description: "读取状态", capabilityID: "state.read")
            ])), decisionSource: .modelStructured, modelProvider: "p3-structured")
        }
        return StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: "final once")),
                                        decisionSource: .modelStructured,
                                        modelProvider: "p3-structured")
    }
}

private actor P3Ledger: AgentTaskLedgerPersisting {
    private(set) var stored: [AgentTaskLedgerEvent] = []

    func append(_ event: AgentTaskLedgerEvent) async throws { stored.append(event) }
    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] { stored.filter { $0.taskID == taskID } }
    func activeTasks() async throws -> [AgentTaskSnapshot] { [] }
    func hasOperationID(_ operationID: String) async throws -> Bool { stored.contains { $0.operationID == operationID } }
    func all() -> [AgentTaskLedgerEvent] { stored }
}

private struct P3RuntimeContext: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event { return AgentContext(userText: message.text) }
        return AgentContext()
    }
}

private struct P3Conversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.delta(sequence: 1, text: "fallback"))
            continuation.yield(.completed(emotion: .neutral, viaCloud: false))
            continuation.finish()
        }
    }
}

private func p3RuntimeCoordinator(ledger: AgentTaskLedgerPersisting = NoopAgentTaskLedgerStore(),
                                  executor: any ToolExecuting = P3Executor()) -> PetAgentRuntimeCoordinator {
    PetAgentRuntimeCoordinator(context: P3RuntimeContext(),
                               model: P3StructuredModel(),
                               conversation: P3Conversation(),
                               gate: P3Gate(.allow),
                               executor: executor,
                               policy: AgentPolicy(allowTools: true, maxSteps: 4,
                                                   maxIterations: 4, maxToolCalls: 3,
                                                   tier: .developerID),
                               ledger: ledger)
}

@MainActor
final class P3BoundedAgentLoopIntegrationTests: XCTestCase {
    func testCoordinatorWritesLedgerLoopMetadataWithoutSensitivePayloads() async {
        let ledger = P3Ledger()
        let coordinator = p3RuntimeCoordinator(ledger: ledger, executor: P3Executor(outcomes: [
            ToolOutcome(ok: true, output: "Bearer " + "sk-" + String(repeating: "x", count: 32))
        ]))

        var finalText = ""
        for await output in coordinator.handle(.userMessage(text: "读状态", conversationClass: .normal)) {
            if case .responseDelta(_, _, let text) = output { finalText += text }
        }

        let events = await ledger.all()
        XCTAssertEqual(finalText, "final once")
        XCTAssertTrue(events.contains { $0.stopReason == .completed })
        XCTAssertTrue(events.contains { $0.usedToolNames?.contains("state.read") == true })
        let encoded = String(data: (try? JSONEncoder().encode(events)) ?? Data(), encoding: .utf8) ?? ""
        XCTAssertFalse(encoded.contains("sk-secret"))
        XCTAssertFalse(encoded.contains("Bearer"))
    }

    func testChatModelClearsLoadingStateAndOnlyAddsOneAssistantFinalMessage() async {
        let chat = makeChatModel(runtime: p3RuntimeCoordinator())
        chat.send("读状态")

        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        XCTAssertFalse(chat.busy)
        XCTAssertNil(chat.transientStatusText)
        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .pet }.count, 1)
        XCTAssertFalse(chat.conversation.messages.contains { $0.text.contains("call-") })
    }

    func testChatModelCancelClearsTransientLoadingState() async {
        let slow = P3Executor(delayNanos: 300_000_000)
        let chat = makeChatModel(runtime: p3RuntimeCoordinator(executor: slow))
        chat.send("读状态")
        try? await Task.sleep(nanoseconds: 30_000_000)
        chat.stopGenerating()

        await waitUntil { !chat.busy }
        XCTAssertNil(chat.transientStatusText)
    }

    func testControlPanelAndFloatingEntrypointsShareChatModelSourceOfTruth() async {
        let providers = ProviderStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json"),
                                      secretStore: InMemorySecretStore())
        let chat = makeChatModel(runtime: p3RuntimeCoordinator())
        let controlPanel = CompanionChatViewModel(chat: chat, providers: providers)

        controlPanel.chat.send("控制面板发出")
        await waitUntil { chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed } }

        let before = chat.conversation.messages.count
        chat.send("浮动聊天发出", kind: .chat, useScreen: false)
        await waitUntil { chat.conversation.messages.count > before && !chat.busy }

        XCTAssertTrue(controlPanel.messages.elementsEqual(chat.conversation.messages))
    }

    private func makeChatModel(runtime: PetAgentRuntimeCoordinator) -> ChatModel {
        let memoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("p3-memory-\(UUID().uuidString).json")
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing-deskpet-llm")),
                                  repository: JSONMemoryRepository(MemoryModel(store: MemoryStore(fileURL: memoryURL))))
        let store = ChatStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("p3-chat-\(UUID().uuidString).json"))
        return ChatModel(runtime: runtime,
                         services: services,
                         store: store,
                         activityStore: AgentTaskActivityStore(persistence: nil))
    }

    private func waitUntil(_ predicate: @MainActor @escaping () -> Bool,
                           timeout: TimeInterval = 2,
                           file: StaticString = #filePath,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out waiting for predicate", file: file, line: line)
    }
}
