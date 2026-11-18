import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore

/// Unit tests for AgenticLoopMath — every pure decision the agentic loop
/// relies on. The actor stays in charge of awaiting; these tests run
/// without any actor re-entry.
final class AgenticLoopMathTests: XCTestCase {

    // MARK: - step(from:)

    func testStepMapsProposePlanToExecute() {
        let proposal = AgentPlanProposal(goal: "x", steps: [
            AgentPlanProposalStep(id: "1", description: "do", capabilityID: "do.it")
        ])
        let s = AgenticLoopMath.step(from: .proposePlan(proposal))
        if case .executePlan(let p) = s {
            XCTAssertEqual(p.goal, "x")
        } else {
            XCTFail("expected .executePlan, got \(s)")
        }
    }

    func testStepMapsDelegateToDelegate() {
        let d = DelegationDecision(goal: "sub", allowedCapabilities: ["x.y"])
        if case .delegate(let got) = AgenticLoopMath.step(from: .delegate(d)) {
            XCTAssertEqual(got.goal, "sub")
        } else {
            XCTFail("expected .delegate")
        }
    }

    func testStepMapsTerminalToTerminal() {
        let decision: AgentDecision = .respond(ConversationResponseDecision(text: "hi"))
        if case .terminal(let d) = AgenticLoopMath.step(from: decision) {
            XCTAssertEqual(d, decision)
        } else {
            XCTFail("expected .terminal")
        }
    }

    // MARK: - makePlan

    func testMakePlanFallsBackOnPlannerRejection() {
        // An empty proposal: AgentPlanner.plan currently returns the proposal
        // verbatim (goal preserved, empty steps). The fallback-goal branch
        // only fires when the planner returns nil — verify both paths land
        // on an empty plan with whatever goal the planner kept.
        let empty = AgentPlanProposal(goal: "noop", steps: [])
        let plan = AgenticLoopMath.makePlan(from: empty, fallbackGoal: "fallback")
        XCTAssertTrue(plan.steps.isEmpty)
        XCTAssertFalse(plan.goal.isEmpty)
    }

    // MARK: - isNoProgress

    func testIsNoProgressTrueWhenAllStepsAlreadyRun() {
        let sig = AgentPlanProposalStep(id: "1", description: "do",
                                       capabilityID: "do.it",
                                       arguments: ["k": "v"])
        let done: Set<String> = [StepSignature.compute(sig)]
        let next = AgentPlanProposal(goal: "g", steps: [sig])
        XCTAssertTrue(AgenticLoopMath.isNoProgress(next: .proposePlan(next), executedSignatures: done))
    }

    func testIsNoProgressFalseWhenAnyStepIsNew() {
        let done = Set<String>()
        let next = AgentPlanProposal(goal: "g", steps: [
            AgentPlanProposalStep(id: "1", description: "do", capabilityID: "do.it")
        ])
        XCTAssertFalse(AgenticLoopMath.isNoProgress(next: .proposePlan(next), executedSignatures: done))
    }

    func testIsNoProgressFalseForTerminalDecision() {
        // Terminal decisions should not trigger the no-progress guard.
        let decision: AgentDecision = .respond(ConversationResponseDecision(text: "done"))
        XCTAssertFalse(AgenticLoopMath.isNoProgress(next: decision, executedSignatures: ["x|y"]))
    }

    // MARK: - isBudgetExhausted

    func testBudgetExhaustedFalseWhenAllHaveRoom() {
        XCTAssertFalse(AgenticLoopMath.isBudgetExhausted(
            executedCount: 1, iterationIndex: 0,
            maxToolCalls: 4, maxIterations: 4,
            elapsedSeconds: 1, maxWallClock: 60))
    }

    func testBudgetExhaustedAnyOfTheThreeTriggers() {
        XCTAssertTrue(AgenticLoopMath.isBudgetExhausted(
            executedCount: 5, iterationIndex: 0,
            maxToolCalls: 4, maxIterations: 4,
            elapsedSeconds: 1, maxWallClock: 60), "tool-call limit hit")
        XCTAssertTrue(AgenticLoopMath.isBudgetExhausted(
            executedCount: 1, iterationIndex: 4,
            maxToolCalls: 4, maxIterations: 4,
            elapsedSeconds: 1, maxWallClock: 60), "iteration limit hit")
        XCTAssertTrue(AgenticLoopMath.isBudgetExhausted(
            executedCount: 1, iterationIndex: 0,
            maxToolCalls: 4, maxIterations: 4,
            elapsedSeconds: 60, maxWallClock: 60), "wall clock hit")
    }

    // MARK: - terminalState

    func testTerminalStateSucceededWhenNoDenies() {
        XCTAssertEqual(AgenticLoopMath.terminalState(denied: []), .succeeded)
    }

    func testTerminalStatePartialWhenAnyDenies() {
        XCTAssertEqual(AgenticLoopMath.terminalState(denied: ["x"]), .partiallySucceeded)
    }

    // MARK: - shouldCancelMidIteration

    func testMidIterationCancelCatchesAllFlags() {
        XCTAssertTrue(AgenticLoopMath.shouldCancelMidIteration(cancelled: true,
                                                              taskCancelled: false,
                                                              attemptTerminalized: false))
        XCTAssertTrue(AgenticLoopMath.shouldCancelMidIteration(cancelled: false,
                                                              taskCancelled: true,
                                                              attemptTerminalized: false))
        XCTAssertTrue(AgenticLoopMath.shouldCancelMidIteration(cancelled: false,
                                                              taskCancelled: false,
                                                              attemptTerminalized: true))
        XCTAssertFalse(AgenticLoopMath.shouldCancelMidIteration(cancelled: false,
                                                               taskCancelled: false,
                                                               attemptTerminalized: false))
    }

    // MARK: - terminalPresentationSummary

    func testTerminalSummaryPrefersDecisionText() {
        let decision: AgentDecision = .respond(ConversationResponseDecision(text: "完成"))
        XCTAssertEqual(AgenticLoopMath.terminalPresentationSummary(
            decision: decision, goal: "g", executed: [], denied: []), "完成")
    }

    func testTerminalSummaryAsksClarificationWhenNoRespondText() {
        let decision: AgentDecision = .askClarification(ClarificationDecision(question: "哪一个？"))
        XCTAssertEqual(AgenticLoopMath.terminalPresentationSummary(
            decision: decision, goal: "g", executed: [], denied: []), "哪一个？")
    }

    func testTerminalSummaryFallsBackToProgressString() {
        let decision: AgentDecision? = nil
        XCTAssertEqual(AgenticLoopMath.terminalPresentationSummary(
            decision: decision, goal: "查找航班", executed: ["x.y"], denied: []),
                       "完成了 1 步：查找航班")
        XCTAssertEqual(AgenticLoopMath.terminalPresentationSummary(
            decision: decision, goal: "查找航班", executed: ["x.y"], denied: ["a.b"]),
                       "完成 1 步，1 步被权限拦下：查找航班")
    }

    // MARK: - LocalDiscoveryTerminalRecord.project

    func testLocalDiscoveryProjectOnCompletedEmitsToolObserved() {
        let r = LocalDiscoveryTerminalRecord.project(
            loop: loopFixture(stopReason: .completed, terminalState: .succeeded),
            modelProvider: "local-discovery-stub")
        XCTAssertEqual(r.kind, .toolObserved)
        XCTAssertEqual(r.state, .succeeded)
        XCTAssertTrue(r.terminal)
        XCTAssertEqual(r.agentLoopState, "localDiscovery:completed",
                       "distinct prefix from the bounded tool-loop path")
        XCTAssertEqual(r.stopReason, .completed)
        XCTAssertEqual(r.iterationCount, 4)
        XCTAssertEqual(r.toolCallCount, 2)
        XCTAssertEqual(r.usedToolNames, ["get_current_datetime", "network.fetch"])
        XCTAssertEqual(r.toolStatuses, ["success", "success"])
        XCTAssertEqual(r.modelProvider, "local-discovery-stub")
    }

    func testLocalDiscoveryProjectOnFailureEmitsFailedKind() {
        let r = LocalDiscoveryTerminalRecord.project(
            loop: loopFixture(stopReason: .toolFailure, terminalState: .failed),
            modelProvider: "local-discovery-stub")
        XCTAssertEqual(r.kind, .failed)
        XCTAssertEqual(r.state, .failed)
        XCTAssertTrue(r.terminal)
        XCTAssertEqual(r.agentLoopState, "localDiscovery:toolFailure")
    }

    // MARK: - CancellationRecord aggregator

    func testCancellationRecordUserCancelledShapesAllFields() {
        let taskID = UUID()
        let attemptID = UUID()
        let conv = UUID()
        let userMsg = UUID()
        let assistant = UUID()
        let r = CancellationRecord.userCancelled(taskID: taskID, attemptID: attemptID,
                                                conversationID: conv, userMessageID: userMsg,
                                                assistantMessageID: assistant, reason: "userCancel")
        XCTAssertEqual(r.kind, .cancelled)
        XCTAssertEqual(r.state, .cancelled)
        XCTAssertEqual(r.taskID, taskID)
        XCTAssertEqual(r.attemptID, attemptID)
        XCTAssertEqual(r.conversationID, conv)
        XCTAssertEqual(r.userMessageID, userMsg)
        XCTAssertEqual(r.assistantMessageID, assistant)
        XCTAssertEqual(r.cancelReason, "userCancel")
        XCTAssertTrue(r.terminal)
    }

    // MARK: - AgenticLoopIterationContext.operationID

    func testIterationContextOperationIDMatchesLegacyFormat() {
        let taskID = UUID()
        let ctx = AgenticLoopIterationContext(
            taskID: taskID, attemptID: UUID(),
            conversationID: UUID(), userMessageID: UUID(),
            retryOfTaskID: nil, regeneratedFromMessageID: nil,
            parentTaskID: nil, source: .modelStructured, iteration: 3)
        XCTAssertEqual(ctx.operationID(prefix: "iter"), "iter-\(taskID.uuidString)-3")
        XCTAssertEqual(ctx.operationID(prefix: "delegate"), "delegate-\(taskID.uuidString)-3")
    }

    // MARK: - BoundedToolLoopTerminalRecord.project

    private func loopFixture(stopReason: AgentLoopStopReason,
                             terminalState: AgentTaskState) -> AgentLoopRunResult {
        AgentLoopRunResult(finalResponse: AgentFinalResponse(text: "ok", finishReason: "completed"),
                           stopReason: stopReason,
                           observations: [],
                           usedToolNames: ["get_current_datetime", "network.fetch"],
                           toolStatuses: [.success, .success],
                           iterationCount: 4, toolCallCount: 2,
                           waitingApproval: [],
                           terminalState: terminalState,
                           planID: "plan-x", planVersion: 2, planStepCount: 5,
                           planRiskLevel: "p2", planApprovalRequired: false,
                           planApprovalGranted: true, planReplanCount: 1,
                           planResultItemCount: 7, planResultTruncated: false,
                           memoryCandidates: [],
                           resultDocument: nil,
                           resultIssues: [])
    }

    func testProjectOnCompletedEmitsToolObserved() {
        let r = BoundedToolLoopTerminalRecord.project(
            loop: loopFixture(stopReason: .completed, terminalState: .succeeded),
            modelProvider: "local-stub")
        XCTAssertEqual(r.kind, .toolObserved)
        XCTAssertEqual(r.state, .succeeded)
        XCTAssertTrue(r.terminal)
        XCTAssertEqual(r.agentLoopState, "completed:completed")
        XCTAssertEqual(r.stopReason, .completed)
        XCTAssertEqual(r.iterationCount, 4)
        XCTAssertEqual(r.toolCallCount, 2)
        XCTAssertEqual(r.usedToolNames, ["get_current_datetime", "network.fetch"])
        XCTAssertEqual(r.toolStatuses, ["success", "success"])
        XCTAssertEqual(r.planID, "plan-x")
        XCTAssertEqual(r.planVersion, 2)
        XCTAssertEqual(r.planStepCount, 5)
        XCTAssertEqual(r.planRiskLevel, "p2")
        XCTAssertEqual(r.planApprovalRequired, false)
        XCTAssertEqual(r.planApprovalGranted, true)
        XCTAssertEqual(r.planReplanCount, 1)
        XCTAssertEqual(r.planResultItemCount, 7)
        XCTAssertEqual(r.planResultTruncated, false)
        XCTAssertEqual(r.modelProvider, "local-stub")
    }

    func testProjectOnFailureEmitsFailedKindAndHonoursTerminalState() {
        let r = BoundedToolLoopTerminalRecord.project(
            loop: loopFixture(stopReason: .toolFailure, terminalState: .failed),
            modelProvider: "remote-v2")
        XCTAssertEqual(r.kind, .failed, "non-.completed stop reason ⇒ .failed")
        XCTAssertEqual(r.state, .failed)
        XCTAssertTrue(r.terminal, "terminalState.isTerminal decides the terminal flag")
        XCTAssertEqual(r.agentLoopState, "completed:toolFailure")
        XCTAssertEqual(r.modelProvider, "remote-v2")
    }

    func testProjectPassesThroughNonTerminalState() {
        // If a custom terminal state reports non-terminal (shouldn't happen
        // in production, but the helper honors the flag literally), the
        // `terminal` field goes false so the caller doesn't claim completion.
        let r = BoundedToolLoopTerminalRecord.project(
            loop: loopFixture(stopReason: .cancelled, terminalState: .running),
            modelProvider: "x")
        XCTAssertEqual(r.kind, .failed, "non-.completed ⇒ .failed even when stopReason is .cancelled")
        XCTAssertFalse(r.terminal, "running is not terminal")
    }
}