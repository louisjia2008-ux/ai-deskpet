import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P1 — the gated agentic loop: propose → gate → execute → observe → re-decide, bounded by budgets
// and a no-progress guard. Every step still passes the CapabilityGate; the model only proposes.

// MARK: - Fakes (file-scoped; deliberately separate from PetAgentRuntimeTests' private fakes)

private struct LoopContextBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let m) = event { return AgentContext(userText: m.text) }
        return AgentContext()
    }
}

private func planFor(_ caps: [String], goal: String = "目标") -> AgentDecision {
    .proposePlan(AgentPlanProposal(goal: goal, steps: caps.enumerated().map { i, c in
        AgentPlanProposalStep(id: "s-\(i)", description: "执行 \(c)", capabilityID: c)
    }))
}
private func respond(_ text: String) -> AgentDecision { .respond(ConversationResponseDecision(text: text)) }

/// A model whose decision depends on how many observations it has already seen — i.e. on the loop
/// round. Counts its own invocations so tests can prove the loop did (or did not) re-decide.
private actor ScriptedModel: StructuredDecisionProviding {
    enum Mode {
        case branchOnObservations(first: [String], finalText: String)  // plan once, then respond
        case escalating([String])                                      // a fresh cap every round
        case fixed([String])                                           // same plan forever
    }
    private let mode: Mode
    private var calls = 0
    init(_ mode: Mode) { self.mode = mode }
    func callCount() -> Int { calls }

    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        calls += 1
        let round = context.observations.count
        let decision: AgentDecision
        switch mode {
        case .branchOnObservations(let first, let finalText):
            decision = context.observations.isEmpty ? planFor(first) : respond(finalText)
        case .escalating(let caps):
            decision = planFor([caps[min(round, caps.count - 1)]], goal: "g-\(round)")
        case .fixed(let caps):
            decision = planFor(caps)
        }
        return StructuredDecisionResult(decision: decision, decisionSource: .modelStructured, modelProvider: "scripted")
    }
}

private actor GrantAllBroker: CapabilityGate {
    private(set) var seen = 0
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen += 1
        return .granted(CapabilityToken(raw: "tok", taskID: taskID, expiresAt: .distantFuture))
    }
    func sawCount() -> Int { seen }
}

private actor AskUserBroker: CapabilityGate {
    private(set) var seen = 0
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen += 1; return .askUser
    }
    func sawCount() -> Int { seen }
}

private actor CountingExecutor: ToolExecuting {
    private(set) var executed: [String] = []
    var stepDelayNanos: UInt64 = 0
    init(stepDelayNanos: UInt64 = 0) { self.stepDelayNanos = stepDelayNanos }
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        if stepDelayNanos > 0 { try? await Task.sleep(nanoseconds: stepDelayNanos) }
        executed.append(step.capabilityID)
        return ToolOutcome(ok: true, output: "did \(step.capabilityID)")
    }
    func count() -> Int { executed.count }
}

private struct StubConversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { c in
            c.yield(.delta(sequence: 1, text: "conv"))
            c.yield(.completed(emotion: .neutral, viaCloud: false))
            c.finish()
        }
    }
}

private func loopPolicy(maxIterations: Int = 3, maxToolCalls: Int = 8,
                        maxWallClock: TimeInterval = 60) -> AgentPolicy {
    AgentPolicy(allowTools: true, maxSteps: 4, maxIterations: maxIterations,
                maxToolCalls: maxToolCalls, maxWallClock: maxWallClock, tier: .developerID)
}

private func makeCoordinator(model: any StructuredDecisionProviding, gate: any CapabilityGate,
                             executor: any ToolExecuting, policy: AgentPolicy) -> PetAgentRuntimeCoordinator {
    PetAgentRuntimeCoordinator(context: LoopContextBuilder(), model: model,
                               conversation: StubConversation(), gate: gate,
                               executor: executor, policy: policy)
}

private extension AgentRunResult {
    var bubbleText: String { presentation?.bubbles.joined() ?? "" }
}

// MARK: - Tests

final class AgenticLoopTests: XCTestCase {

    /// Executes a step, feeds the observation back, and the model — now seeing the result — converges
    /// to a final spoken answer. Proves the observe→re-decide cycle actually runs.
    func testMultiStepConvergesAfterObservation() async {
        let model = ScriptedModel(.branchOnObservations(first: ["timer.local"], finalText: "汇总完成"))
        let exec = CountingExecutor()
        let c = makeCoordinator(model: model, gate: GrantAllBroker(), executor: exec,
                                policy: loopPolicy(maxIterations: 5))
        let r = await c.run(.userMessage(text: "做点事", conversationClass: .normal))

        let execCount = await exec.count(); let calls = await model.callCount()
        XCTAssertEqual(r.executedSteps, ["timer.local"])
        XCTAssertEqual(execCount, 1)
        XCTAssertEqual(calls, 2)                          // initial decide + one re-decide
        XCTAssertEqual(r.taskState, .succeeded)
        XCTAssertTrue(r.bubbleText.contains("汇总完成"))   // terminal model text is surfaced
    }

    /// A model that never converges is stopped by maxIterations — no runaway loop.
    func testBudgetMaxIterationsStopsRunaway() async {
        let caps = ["timer.local", "reminder.local.create", "calendar.event.create",
                    "calendar.event.modify", "application.launch"]
        let exec = CountingExecutor()
        let c = makeCoordinator(model: ScriptedModel(.escalating(caps)), gate: GrantAllBroker(),
                                executor: exec, policy: loopPolicy(maxIterations: 3, maxToolCalls: 99))
        let r = await c.run(.userMessage(text: "无限做", conversationClass: .normal))

        let execCount = await exec.count()
        XCTAssertEqual(execCount, 3)                     // exactly maxIterations rounds executed
        XCTAssertEqual(r.executedSteps.count, 3)
    }

    /// maxToolCalls caps cumulative executed steps even when iterations would allow more.
    func testBudgetMaxToolCallsStopsRunaway() async {
        let caps = ["timer.local", "reminder.local.create", "calendar.event.create", "application.launch"]
        let exec = CountingExecutor()
        let c = makeCoordinator(model: ScriptedModel(.escalating(caps)), gate: GrantAllBroker(),
                                executor: exec, policy: loopPolicy(maxIterations: 99, maxToolCalls: 2))
        _ = await c.run(.userMessage(text: "无限做", conversationClass: .normal))

        let execCount = await exec.count()
        XCTAssertEqual(execCount, 2)
    }

    /// askUser without an approval channel fails closed as a terminal permission failure. It must not
    /// publish a fake wait state that the app cannot resume.
    func testAskUserFailsClosedAndStopsLoop() async {
        let model = ScriptedModel(.branchOnObservations(first: ["reminder.local.create"], finalText: "x"))
        let broker = AskUserBroker()
        let exec = CountingExecutor()
        let c = makeCoordinator(model: model, gate: broker, executor: exec, policy: loopPolicy())
        let r = await c.run(.userMessage(text: "提醒我交报告", conversationClass: .normal))

        let execCount = await exec.count(); let brokerSaw = await broker.sawCount()
        let calls = await model.callCount()
        XCTAssertEqual(execCount, 0)
        XCTAssertEqual(brokerSaw, 1)
        // P15 — when the gate returns `.askUser`, the runtime now surfaces
        // the wait via `waitingApproval` so the upstream coordinator can
        // emit `.waitingForApproval(...)` and a user-facing approval
        // presentation. See testAskUserFailsClosedAndNeverExecutes.
        XCTAssertEqual(Set(r.waitingApproval), Set(["reminder.local.create"]))
        XCTAssertEqual(r.taskState, .failed)
        XCTAssertEqual(r.stopReason, .permissionDenied)
        XCTAssertEqual(calls, 1)                          // never re-decided past the approval wait
        // P16 GAP-01: placeholder text replaced with TaskActivityCard-friendly copy.
        // Coordinator short-circuits converse() in production for waitingApproval
        // so this bubbleText is only set for tests that bypass converse().
        XCTAssertTrue(r.bubbleText.contains("需要你的允许才能继续"))
    }

    /// A model that keeps proposing the SAME (already-executed) plan is stopped by the no-progress
    /// guard — well before the iteration budget.
    func testNoProgressGuardStopsRepeatedPlan() async {
        let model = ScriptedModel(.fixed(["timer.local"]))
        let exec = CountingExecutor()
        let c = makeCoordinator(model: model, gate: GrantAllBroker(), executor: exec,
                                policy: loopPolicy(maxIterations: 5))
        _ = await c.run(.userMessage(text: "重复做", conversationClass: .normal))

        let execCount = await exec.count(); let calls = await model.callCount()
        XCTAssertEqual(execCount, 1)                      // executed once, not 5 times
        XCTAssertLessThan(calls, 5)                       // stopped before exhausting the iteration budget
    }

    /// Cancelling the wrapping task is observed at the next iteration boundary; the loop returns a
    /// cancelled presentation instead of continuing.
    func testCancellationAtIterationBoundary() async {
        let caps = ["timer.local", "reminder.local.create", "calendar.event.create"]
        let exec = CountingExecutor(stepDelayNanos: 150_000_000)   // 150ms per step
        let c = makeCoordinator(model: ScriptedModel(.escalating(caps)), gate: GrantAllBroker(),
                                executor: exec, policy: loopPolicy(maxIterations: 5))
        let task = Task { await c.run(.userMessage(text: "慢慢做", conversationClass: .normal)) }
        try? await Task.sleep(nanoseconds: 40_000_000)            // cancel mid first step
        task.cancel()
        let r = await task.value

        let execCount = await exec.count()
        XCTAssertTrue(r.bubbleText.contains("已取消"))
        XCTAssertLessThanOrEqual(execCount, 1)                    // stopped early, didn't drain the loop
    }
}
