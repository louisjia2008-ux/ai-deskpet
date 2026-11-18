import Foundation
import AICore
import PetBrainCore

// MARK: - Pure helpers for the agentic loop (doc §10 plan execution).
//
// `runAgenticLoop` runs in two phases:
//   * Decide: model/structured provider returns `AgentDecision`
//     (proposePlan / delegate / terminal). The pure helper translates the
//     decision into a `LoopStep` the actor's `await` path executes.
//   * Execute: side effects (gate + tool / delegate) produce `observations`
//     that fold back into the next Decide.
//
// The loop also has three bookkeeping decisions (all pure, all covered by
// tests in AgenticLoopMathTests):
//   * Did the step produce any new tool calls, or did the model repeat
//     itself? (progress guard — break the loop on no-progress.)
//   * Have we exhausted any of the four budgets (iterations / tool calls /
//     wall clock / task-state lifecycle)? (budget guard.)
//   * After the loop ends, what's the terminal state? (state picker from
//     executed/denied/cancelled.)
//
// Everything that touches `await` (recording the ledger, gate evaluation,
// durable mirror) stays on the actor. These helpers operate on already-
////available values and are fully synchronous.

enum AgenticLoopMath {

    /// What step the loop should take on this iteration based on the
    /// decision the provider returned.
    enum LoopStep: Equatable {
        case executePlan(AgentPlanProposal)
        case delegate(DelegationDecision)
        case terminal(AgentDecision)
    }

    /// Translate the provider's `AgentDecision` into the per-iteration step.
    static func step(from decision: AgentDecision) -> LoopStep {
        switch decision {
        case .proposePlan(let proposal): return .executePlan(proposal)
        case .delegate(let d): return .delegate(d)
        default: return .terminal(decision)
        }
    }

    /// Build an `AgentPlan` from a proposal; falls back to an empty plan
    /// when the planner rejects the shape (the inline loop did the same).
    static func makePlan(from proposal: AgentPlanProposal, fallbackGoal: String) -> AgentPlan {
        AgentPlanner.plan(from: .proposePlan(proposal)) ?? AgentPlan(goal: fallbackGoal, steps: [])
    }

    /// Did the next proposal already cover everything we've already
    /// executed? If so the model is stuck — break the loop.
    static func isNoProgress(next: AgentDecision, executedSignatures: Set<String>) -> Bool {
        guard case .proposePlan(let nextPlan) = next, !nextPlan.steps.isEmpty else {
            return false
        }
        return nextPlan.steps.allSatisfy { step in
            executedSignatures.contains(StepSignature.compute(step))
        }
    }

    /// Any of the three numeric budgets exhausted? Pure check (no clock;
    /// the actor passes the elapsed value in).
    static func isBudgetExhausted(executedCount: Int,
                                 iterationIndex: Int,
                                 maxToolCalls: Int,
                                 maxIterations: Int,
                                 elapsedSeconds: TimeInterval,
                                 maxWallClock: TimeInterval) -> Bool {
        if executedCount >= maxToolCalls { return true }
        if iterationIndex + 1 >= maxIterations { return true }
        if elapsedSeconds >= maxWallClock { return true }
        return false
    }

    /// Compute the terminal `PlanRunResult` after the loop body exits
    /// naturally. Denied → `.partiallySucceeded`, otherwise `.succeeded`.
    /// The actor folds this into the terminal ledger record.
    static func terminalState(denied: [String]) -> AgentTaskState {
        denied.isEmpty ? .succeeded : .partiallySucceeded
    }

    /// Pure: was the loop cancelled mid-iteration?
    static func shouldCancelMidIteration(cancelled: Bool,
                                        taskCancelled: Bool,
                                        attemptTerminalized: Bool) -> Bool {
        cancelled || taskCancelled || attemptTerminalized
    }

    /// Final observation summary emitted when the agentic loop reaches a
    /// terminal decision. Mirrors the inline `terminalPresentation` logic
    /// (decline/askClarification → own text, else build a summary).
    static func terminalPresentationSummary(decision: AgentDecision?,
                                            goal: String,
                                            executed: [String],
                                            denied: [String]) -> String {
        switch decision {
        case .respond(let r) where !r.text.isEmpty:
            return r.text
        case .askClarification(let c):
            return c.question
        case .decline(let d):
            return d.reason
        default:
            if denied.isEmpty {
                return "完成了 \(executed.count) 步：\(goal)"
            } else {
                return "完成 \(executed.count) 步，\(denied.count) 步被权限拦下：\(goal)"
            }
        }
    }
}

/// Pure signature for the "did we already run this step?" dedup. The inline
/// loop had this as a private static func; pulling it out lets the no-
/// progress test construct signatures directly without invoking the actor.
enum StepSignature {
    static func compute(_ step: AgentPlanStep) -> String {
        let params = step.params.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        return "\(step.capabilityID)|\(params)"
    }

    static func compute(_ step: AgentPlanProposalStep) -> String {
        let params = step.arguments.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        return "\(step.capabilityID)|\(params)"
    }
}

// MARK: - Per-iteration ledger payload (pure aggregation).
//
// `runAgenticLoop` wrote three near-identical `try? await record(kind:...,`
// blocks (one per iteration arm). They share every conversation/parent/
// retry/iteration argument; only the kind, operationID template, and
// outputSequence vary. This struct captures the shared fields once so the
// actor's record() call is a one-liner. The actor still owns the actual
// persistence — this is a value aggregator, not a write.
struct AgenticLoopIterationContext: Sendable {
    var taskID: UUID
    var attemptID: UUID
    var conversationID: UUID
    var userMessageID: UUID
    var retryOfTaskID: UUID?
    var regeneratedFromMessageID: UUID?
    var parentTaskID: UUID?
    var source: DecisionSource
    /// The shared `0`-based iteration index inside `runAgenticLoop`'s `for`.
    var iteration: Int

    /// Build the per-iteration operationID the legacy inline code emitted
    /// ("iter-<taskID>-<iteration>" / "delegate-<taskID>-<iteration>"). Pure
    /// so it can be unit-tested without invoking the actor.
    func operationID(prefix: String) -> String {
        "\(prefix)-\(taskID)-\(iteration)"
    }
}

// MARK: - Bounded tool-loop terminal record payload (pure aggregation).
//
// `runBoundedToolLoop` wrote one 22-field `try? await record(kind:...,`
// block when the loop completed. Every field is a deterministic
// projection from the `AgentLoopRunResult` + the surrounding event args;
// only the `modelProvider` comes from the original `AgentLoopDecisionResult`.
// This struct captures the inputs once and exposes a single field-by-field
// value aggregator the actor can hand straight to `record(...)`. Tests pin
// the field selection so future tweaks are intentional.
struct BoundedToolLoopTerminalRecord: Sendable {
    var kind: RuntimeLedgerEventKind
    var state: AgentTaskState
    var terminal: Bool
    var agentLoopState: String
    var stopReason: AgentLoopStopReason
    var iterationCount: Int?
    var toolCallCount: Int?
    var usedToolNames: [String]
    var toolStatuses: [String]?
    var planID: String?
    var planVersion: Int?
    var planStepCount: Int?
    var planRiskLevel: String?
    var planApprovalRequired: Bool?
    var planApprovalGranted: Bool?
    var planReplanCount: Int?
    var planResultItemCount: Int?
    var planResultTruncated: Bool?
    var modelProvider: String

    /// Pure projection from the loop result. `kind` is `.toolObserved`
    /// when the loop completed cleanly and `.failed` otherwise (mirrors the
    /// inline production branch). `terminal` follows `terminalState.isTerminal`.
    static func project(loop: AgentLoopRunResult,
                        modelProvider: String) -> BoundedToolLoopTerminalRecord {
        let completed = loop.stopReason == .completed
        return BoundedToolLoopTerminalRecord(
            kind: completed ? .toolObserved : .failed,
            state: loop.terminalState,
            terminal: loop.terminalState.isTerminal,
            agentLoopState: "completed:\(loop.stopReason.rawValue)",
            stopReason: loop.stopReason,
            iterationCount: loop.iterationCount,
            toolCallCount: loop.toolCallCount,
            usedToolNames: loop.usedToolNames,
            toolStatuses: loop.toolStatuses.map(\.rawValue),
            planID: loop.planID,
            planVersion: loop.planVersion,
            planStepCount: loop.planStepCount,
            planRiskLevel: loop.planRiskLevel,
            planApprovalRequired: loop.planApprovalRequired,
            planApprovalGranted: loop.planApprovalGranted,
            planReplanCount: loop.planReplanCount,
            planResultItemCount: loop.planResultItemCount,
            planResultTruncated: loop.planResultTruncated,
            modelProvider: modelProvider)
    }
}

// MARK: - Local-discovery workflow terminal record (pure aggregation).
//
// `runLocalDiscoveryWorkflow` is already cleanly factored: the actual
// decision loop lives in `LocalDiscoveryWorkflow.run(...)`. The coordinator's
// wrapper only does activity emission + one ledger record + acceptance gating
// + converse handoff. The one big inline call is the terminal `record(kind:`
// — 16 fields, all derivable from the loop result plus a fixed
// `modelProvider`. This struct lifts that projection so the wrapper reads as
// a sequence of clearly-named steps; tests pin the field mapping so the
// inline 16-field call stays gone.
struct LocalDiscoveryTerminalRecord: Sendable {
    var kind: RuntimeLedgerEventKind
    var state: AgentTaskState
    var terminal: Bool
    var agentLoopState: String
    var stopReason: AgentLoopStopReason
    var iterationCount: Int?
    var toolCallCount: Int?
    var usedToolNames: [String]
    var toolStatuses: [String]?
    var modelProvider: String

    /// Pure projection. Mirrors `BoundedToolLoopTerminalRecord.project(_:)`
    /// but for the local-discovery branch: planID/planVersion/etc are nil
    /// (the workflow does not produce a structured plan), and the
    /// `agentLoopState` prefix differs (`localDiscovery:` instead of
    /// `completed:`) so log readers can tell branches apart.
    static func project(loop: AgentLoopRunResult,
                        modelProvider: String) -> LocalDiscoveryTerminalRecord {
        let completed = loop.stopReason == .completed
        return LocalDiscoveryTerminalRecord(
            kind: completed ? .toolObserved : .failed,
            state: loop.terminalState,
            terminal: loop.terminalState.isTerminal,
            agentLoopState: "localDiscovery:\(loop.stopReason.rawValue)",
            stopReason: loop.stopReason,
            iterationCount: loop.iterationCount,
            toolCallCount: loop.toolCallCount,
            usedToolNames: loop.usedToolNames,
            toolStatuses: loop.toolStatuses.map(\.rawValue),
            modelProvider: modelProvider)
    }
}

// MARK: - Cancellation record payload (pure aggregation).
//
// `runBoundedToolLoop` + `cancel(conversationID:)` + `cancel(taskID:)` all
// emit the same `kind:.cancelled, state:.cancelled, cancelReason: "..."` record
// before mirroring into the durable kernel. The fields are: attemptID,
// conversationID, userMessageID, assistantMessageID, cancelReason.
// Pure aggregation so the actor's caller only needs to assemble a struct.
// (Defined for documentation; the coordinator's helper inlining was
// scrapped during the structural recovery — see the `P-DSK-02` notes in
// the worktree history.)
struct CancellationRecord: Sendable {
    var kind: RuntimeLedgerEventKind
    var state: AgentTaskState
    var taskID: UUID
    var attemptID: UUID
    var conversationID: UUID
    var userMessageID: UUID
    var assistantMessageID: UUID
    var cancelReason: String
    var terminal: Bool

    /// The shared shape used by every cancel site (uniform `cancelReason`
    /// is overridden by the caller for branch-specific labels).
    static func userCancelled(taskID: UUID,
                              attemptID: UUID,
                              conversationID: UUID,
                              userMessageID: UUID,
                              assistantMessageID: UUID,
                              reason: String) -> CancellationRecord {
        CancellationRecord(kind: .cancelled, state: .cancelled,
                           taskID: taskID, attemptID: attemptID,
                           conversationID: conversationID,
                           userMessageID: userMessageID,
                           assistantMessageID: assistantMessageID,
                           cancelReason: reason, terminal: true)
    }
}