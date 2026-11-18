import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P4 — self-evolution learning loop: reflect on a finished tool-task → suggested memories that
// (once confirmed) feed future context via memoryHints.

// MARK: - Pure reflector

final class TaskReflectorTests: XCTestCase {
    func testSuccessfulToolTaskDoesNotStoreOriginalPrompt() {
        let input = TaskReflectionInput(
            goal: "明早九点提醒我交报告", executedCapabilities: ["reminder.local.create"], succeeded: true)
        XCTAssertTrue(TaskReflector.reflect(input).isEmpty)
        XCTAssertTrue(TaskReflector.reflectCandidates(input).isEmpty)
    }

    func testDeniedTaskSuggestsAskFirstConstraint() {
        let candidates = TaskReflector.reflectCandidates(TaskReflectionInput(
            goal: "上传文件到网盘", deniedCapabilities: ["network.upload"], succeeded: false))
        XCTAssertEqual(candidates.count, 1)
        XCTAssertEqual(candidates.first?.proposedScope, .procedural)
        XCTAssertTrue(candidates.first!.summary.contains("先征得我同意"))
    }

    func testCancelledProducesNothing() {
        XCTAssertTrue(TaskReflector.reflect(TaskReflectionInput(
            goal: "g", executedCapabilities: ["timer.local"], succeeded: false, cancelled: true)).isEmpty)
    }

    func testSuccessWithoutToolsProducesNothing() {
        XCTAssertTrue(TaskReflector.reflect(TaskReflectionInput(goal: "g", succeeded: true)).isEmpty)
    }

    func testForbiddenContentFilteredOut() {
        // Goal carrying a forbidden marker must never become a memory.
        XCTAssertTrue(TaskReflector.reflect(TaskReflectionInput(
            goal: "记住我的银行卡密码", executedCapabilities: ["timer.local"], succeeded: true)).isEmpty)
    }
}

// MARK: - Coordinator → sink wiring

private struct ReflCtxBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let m) = event { return AgentContext(userText: m.text) }
        return AgentContext()
    }
}
private actor GrantAllGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .granted(CapabilityToken(raw: "t", taskID: taskID, expiresAt: .distantFuture))
    }
}
private actor NoExec: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        ToolOutcome(ok: true, output: "ok")
    }
}
private struct StubConv: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { c in c.yield(.completed(emotion: .neutral, viaCloud: false)); c.finish() }
    }
}
private actor RecordingSink: ReflectionSink {
    private(set) var inputs: [TaskReflectionInput] = []
    func reflect(_ input: TaskReflectionInput) async { inputs.append(input) }
    func all() -> [TaskReflectionInput] { inputs }
}

private struct TimerThenRespondModel: StructuredDecisionProviding {
    func decide(context: AgentContext, availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        let d: AgentDecision = context.observations.isEmpty
            ? .proposePlan(AgentPlanProposal(goal: "设个计时", steps: [
                AgentPlanProposalStep(id: "s1", description: "计时", capabilityID: "timer.local")]))
            : .respond(ConversationResponseDecision(text: "好了"))
        return StructuredDecisionResult(decision: d, decisionSource: .modelStructured, modelProvider: "m")
    }
}
private struct PureChatModel: StructuredDecisionProviding {
    func decide(context: AgentContext, availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: "你好呀")),
                                 decisionSource: .modelStructured, modelProvider: "m")
    }
}
private struct DelegToTimerModel: StructuredDecisionProviding {
    func decide(context: AgentContext, availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        let d: AgentDecision
        if !context.observations.isEmpty {
            d = .respond(ConversationResponseDecision(text: "完成"))
        } else if availableCapabilities.contains("network.fetch") {
            d = .delegate(DelegationDecision(goal: "子任务", allowedCapabilities: ["timer.local"]))
        } else {
            d = .proposePlan(AgentPlanProposal(goal: "子任务", steps: [
                AgentPlanProposalStep(id: "c1", description: "计时", capabilityID: "timer.local")]))
        }
        return StructuredDecisionResult(decision: d, decisionSource: .modelStructured, modelProvider: "m")
    }
}

private func reflPolicy() -> AgentPolicy {
    AgentPolicy(allowTools: true, maxSteps: 4, maxIterations: 5, maxToolCalls: 8, maxWallClock: 60,
                maxDelegationDepth: 1, tier: .developerID)
}

final class ReflectionSinkWiringTests: XCTestCase {
    func testToolTaskReflects() async {
        let sink = RecordingSink()
        let c = PetAgentRuntimeCoordinator(context: ReflCtxBuilder(), model: TimerThenRespondModel(),
                                           conversation: StubConv(), gate: GrantAllGate(), executor: NoExec(),
                                           policy: reflPolicy(), reflection: sink)
        _ = await c.run(.userMessage(text: "三分钟后提醒我", conversationClass: .normal))
        let inputs = await sink.all()
        XCTAssertEqual(inputs.count, 1)
        XCTAssertTrue(inputs.first!.succeeded)
        XCTAssertEqual(inputs.first!.executedCapabilities, ["timer.local"])
    }

    func testPureChatDoesNotReflect() async {
        let sink = RecordingSink()
        let c = PetAgentRuntimeCoordinator(context: ReflCtxBuilder(), model: PureChatModel(),
                                           conversation: StubConv(), gate: GrantAllGate(), executor: NoExec(),
                                           policy: reflPolicy(), reflection: sink)
        _ = await c.run(.userMessage(text: "你好", conversationClass: .normal))
        let inputs = await sink.all()
        XCTAssertTrue(inputs.isEmpty)
    }

    func testDelegatedChildWorkReflects() async {
        let sink = RecordingSink()
        let c = PetAgentRuntimeCoordinator(context: ReflCtxBuilder(), model: DelegToTimerModel(),
                                           conversation: StubConv(), gate: GrantAllGate(), executor: NoExec(),
                                           policy: reflPolicy(), reflection: sink)
        _ = await c.run(.userMessage(text: "帮我做个子任务", conversationClass: .normal))
        let inputs = await sink.all()
        XCTAssertTrue(inputs.contains { $0.executedCapabilities == ["timer.local"] && $0.succeeded })
    }
}
