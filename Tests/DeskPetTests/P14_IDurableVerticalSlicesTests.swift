import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14-I — End-to-end durable vertical slices.
//
// Slice 1: Multi-step read-only Goal → Task → Attempt → Tool → Checkpoint → Acceptance → Complete.
// Slice 2: Wait-for-approval Goal → restart → still waiting → approval arrives → continue → complete.
// Slice 3: Interruption / restart / resume (true Runtime A → Runtime B).

@MainActor
final class P14_IDurableVerticalSlicesTests: XCTestCase {

    // MARK: Slice 1 — Multi-step read-only Goal.

    func testSlice1_multiStepReadOnlyGoal() async throws {
        let baseDir = p14_makeTempDir("slice1")
        let taskStore = DurableTaskStore(baseDirectory: baseDir)
        let goalStore = GoalStore(baseDirectory: baseDir.appendingPathComponent("goals"))
        await taskStore.load()
        await goalStore.load()
        let taskID = UUID()
        // Step 1: Create the Goal with three acceptance criteria.
        var goal = Goal(taskID: taskID,
                        objective: "查找今天的日历事件并生成摘要",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "calendar.queried",
                                               kind: .toolOutcome,
                                               description: "调用日历工具并获得结果"),
                            AcceptanceCriterion(criterionID: "summary.produced",
                                               kind: .artifactExists,
                                               description: "生成摘要"),
                            AcceptanceCriterion(criterionID: "audit.persisted",
                                               kind: .runtimeInvariant,
                                               description: "审计日志中记录了一次 toolSucceeded 事件"),
                        ])
        _ = await taskStore.upsert(DurableTaskRecord(taskID: taskID,
                                                      goalID: goal.id,
                                                      title: goal.objective))
        await goalStore.upsert(goal)
        // Step 2: Task transitions through the state machine.
        _ = await taskStore.applyTransition(taskID: taskID, to: .running)
        // Step 3: Simulate a tool execution by satisfying criterion #1 via the
        // goal store, mirroring what the runtime would do.
        var updated = await goalStore.satisfy(criterionID: "calendar.queried",
                                               goalID: goal.id,
                                               satisfier: "tool:list_today_calendar_events")
        XCTAssertNotNil(updated)
        // Step 4: Persist the synthetic artifact criterion.
        updated = await goalStore.satisfy(criterionID: "summary.produced",
                                           goalID: goal.id,
                                           satisfier: "runtime")
        XCTAssertNotNil(updated)
        // Step 5: Persist the audit-log invariant.
        updated = await goalStore.satisfy(criterionID: "audit.persisted",
                                           goalID: goal.id,
                                           satisfier: "audit")
        XCTAssertNotNil(updated)
        // Step 6: Evaluator confirms completion eligibility.
        let evaluator = AcceptanceEvaluator()
        let eval = evaluator.mayComplete(goal: updated!)
        XCTAssertEqual(eval, .allSatisfied)
        // Step 7: Task transitions to .completed.
        _ = await taskStore.applyTransition(taskID: taskID, to: .completed)
        let final = await taskStore.task(id: taskID)
        XCTAssertEqual(final?.status, .completed)
    }

    // MARK: Slice 2 — Wait-for-approval Goal + restart.

    func testSlice2_waitForApprovalAcrossRestart() async throws {
        let baseDir = p14_makeTempDir("slice2")
        let taskStore = DurableTaskStore(baseDirectory: baseDir)
        let goalStore = GoalStore(baseDirectory: baseDir.appendingPathComponent("goals"))
        let inboxURL = baseDir.appendingPathComponent("inbox.jsonl")
        let inboxA = DurableInboxStore(baseDirectory: inboxURL)
        await taskStore.load()
        await goalStore.load()
        await inboxA.load()
        let taskID = UUID()
        // Goal requires (1) tool ran, (2) user approval.
        var goal = Goal(taskID: taskID,
                        objective: "生成一个破坏性操作的提议",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "tool.ran",
                                               kind: .toolOutcome,
                                               description: "工具执行完毕"),
                            AcceptanceCriterion(criterionID: "user.approval",
                                               kind: .userApproval,
                                               description: "用户必须批准"),
                        ])
        await goalStore.upsert(goal)
        // Task reaches waitingForApproval.
        _ = await taskStore.upsert(DurableTaskRecord(taskID: taskID,
                                                      goalID: goal.id,
                                                      title: goal.objective))
        _ = await taskStore.applyTransition(taskID: taskID, to: .running)
        _ = await taskStore.applyTransition(taskID: taskID, to: .waitingForApproval)
        // Criterion #1 is satisfied by the tool; #2 is not.
        goal = (await goalStore.satisfy(criterionID: "tool.ran",
                                         goalID: goal.id,
                                         satisfier: "tool:test"))!
        let preRestart = AcceptanceEvaluator().mayComplete(goal: goal)
        if case .waitingForUser = preRestart {
            // Good — only user-approval remains.
        } else {
            XCTFail("Expected .waitingForUser; got \(preRestart)")
        }
        // === Restart ===
        let taskStoreB = DurableTaskStore(baseDirectory: baseDir)
        let goalStoreB = GoalStore(baseDirectory: baseDir.appendingPathComponent("goals"))
        let inboxB = DurableInboxStore(baseDirectory: inboxURL)
        await taskStoreB.load()
        await goalStoreB.load()
        await inboxB.load()
        let loadedTask = await taskStoreB.task(id: taskID)
        XCTAssertEqual(loadedTask?.status, .waitingForApproval,
                       "waitingForApproval must survive restart")
        let loadedGoal = await goalStoreB.goal(id: goal.id)
        XCTAssertNotNil(loadedGoal)
        // User approval arrives via the inbox.
        _ = await inboxB.appendIfNew(InboxEvent(taskID: taskID,
                                                  kind: .approvalDecision,
                                                  payload: .bool(true)))
        let pending = await inboxB.unconsumedEvents(forTask: taskID)
        XCTAssertEqual(pending.count, 1)
        // Consume and satisfy the criterion.
        await inboxB.consume(eventID: pending[0].eventID, attemptID: UUID())
        var finalGoal = await goalStoreB.satisfy(criterionID: "user.approval",
                                                  goalID: goal.id,
                                                  satisfier: "user")
        XCTAssertNotNil(finalGoal)
        let eval = AcceptanceEvaluator().mayComplete(goal: finalGoal!)
        XCTAssertEqual(eval, .allSatisfied)
        // Task terminalizes.
        _ = await taskStoreB.applyTransition(taskID: taskID, to: .running)
        _ = await taskStoreB.applyTransition(taskID: taskID, to: .completed)
        let final = await taskStoreB.task(id: taskID)
        XCTAssertEqual(final?.status, .completed)
    }

    // MARK: Slice 3 — Interruption / restart / resume (true Runtime A → Runtime B).

    func testSlice3_interruptionRestartResume() async throws {
        let baseDir = p14_makeTempDir("slice3")
        let seDir = baseDir.appendingPathComponent("se")
        let taskID = UUID()
        let runID = UUID()
        let opID = "op-slice3"
        let toolID = ToolID(rawValue: "side.effect.tool")
        let args: AgentJSONValue = .object(["step": .number(1)])
        // === Runtime A ===
        // Step 1: Persist the task as running with attempt 1.
        let taskStoreA = DurableTaskStore(baseDirectory: baseDir)
        await taskStoreA.load()
        _ = await taskStoreA.upsert(DurableTaskRecord(taskID: taskID, title: "multi-step"))
        _ = await taskStoreA.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: runID)
        _ = await taskStoreA.applyTransition(taskID: taskID, to: .running)
        // Step 2: Complete the first tool side-effect durably.
        let ledgerA = AgentSideEffectLedgerStore(baseDirectory: seDir)
        _ = try await ledgerA.begin(operationID: opID,
                                    idempotencyKey: "k-slice3",
                                    taskID: taskID,
                                    runID: runID,
                                    toolID: toolID,
                                    capabilityID: nil,
                                    operationKind: "tool.write",
                                    arguments: args)
        try await ledgerA.complete(operationID: opID,
                                    taskID: taskID,
                                    runID: runID,
                                    status: .succeeded,
                                    result: ToolExecutionResult(status: .success,
                                                               userSafeSummary: "step 1 ok",
                                                               structuredData: .object(["ok": .bool(true)])))
        // Step 3: Runtime A "dies" — task is left in .running.
        // === Runtime B (brand-new actor against the same root) ===
        let taskStoreB = DurableTaskStore(baseDirectory: baseDir)
        await taskStoreB.load()
        let loaded = await taskStoreB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .running,
                       "Runtime B must observe the active state from Runtime A")
        // Step 4: Classifier marks the active run as interrupted.
        let classifier = RecoveryClassifier()
        let cls = await classifier.classify(loaded!)
        XCTAssertEqual(cls.action, .markInterrupted)
        _ = await taskStoreB.applyTransition(taskID: taskID, to: .interrupted)
        // Step 5: Resume from checkpoint — new attempt with new runID.
        let newRunID = UUID()
        let newAttemptID = UUID()
        _ = await taskStoreB.recordNewAttempt(taskID: taskID, attemptID: newAttemptID, runID: newRunID)
        _ = await taskStoreB.applyTransition(taskID: taskID, to: .running)
        // Step 6: Re-running the same idempotency key within the SAME runID
        // would observe .alreadySucceeded. The resumed attempt uses a NEW
        // runID (per INV-DUR-02), so a fresh .started is expected. The
        // runtime's contract is: before re-executing, it consults the
        // canonical result boundary (P13) — which is a separate, prior
        // gate. Here we verify the durable ledger correctly distinguishes
        // new-run from prior-run and does not silently treat them as the
        // same record.
        let ledgerB = AgentSideEffectLedgerStore(baseDirectory: seDir)
        let resumed = try await ledgerB.begin(operationID: opID,
                                               idempotencyKey: "k-slice3",
                                               taskID: taskID,
                                               runID: newRunID,
                                               toolID: toolID,
                                               capabilityID: nil,
                                               operationKind: "tool.write",
                                               arguments: args)
        if case .started = resumed {
            // Good — new runID, new attempt record.
        } else {
            XCTFail("Expected .started for new runID; got \(resumed)")
        }
        // Cross-check: re-using the SAME runID observes .alreadySucceeded.
        let sameRunResumed = try await ledgerB.begin(operationID: opID,
                                                      idempotencyKey: "k-slice3",
                                                      taskID: taskID,
                                                      runID: runID, // Runtime A's runID
                                                      toolID: toolID,
                                                      capabilityID: nil,
                                                      operationKind: "tool.write",
                                                      arguments: args)
        if case .alreadySucceeded = sameRunResumed {
            // Good — Runtime A's success is durable and observed.
        } else {
            XCTFail("Expected .alreadySucceeded for Runtime A's runID; got \(sameRunResumed)")
        }
        // Step 7: Continue from checkpoint — final answer.
        _ = await taskStoreB.applyTransition(taskID: taskID, to: .completed)
        let final = await taskStoreB.task(id: taskID)
        XCTAssertEqual(final?.status, .completed)
        XCTAssertEqual(final?.attemptCount, 2,
                       "Retry created exactly one new attempt")
    }
}
