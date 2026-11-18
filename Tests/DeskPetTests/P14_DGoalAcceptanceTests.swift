import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14-D — Goal + Acceptance Criteria.

@MainActor
final class P14_DGoalAcceptanceTests: XCTestCase {

    // MARK: D-01 — Model final answer + unmet criterion != completed.

    func testD01_modelDoneAloneDoesNotSatisfyGoal() {
        let taskID = UUID()
        let goal = Goal(taskID: taskID,
                        objective: "查找今天的日历事件并总结",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "calendar.queried",
                                               kind: .toolOutcome,
                                               description: "调用了日历工具并返回结果"),
                            AcceptanceCriterion(criterionID: "summary.produced",
                                               kind: .artifactExists,
                                               description: "已生成摘要"),
                        ])
        let evaluator = AcceptanceEvaluator()
        XCTAssertTrue(evaluator.modelReportsCompletionButCriteriaIncomplete(goal: goal))
        let eval = evaluator.mayComplete(goal: goal)
        if case .unsatisfied(let missing) = eval {
            XCTAssertEqual(missing.count, 2)
        } else {
            XCTFail("Expected .unsatisfied; got \(eval)")
        }
    }

    // MARK: D-02 — All criteria satisfied → exactly one completed state.

    func testD02_allCriteriaSatisfied_evaluatorReturnsAllSatisfied() {
        let taskID = UUID()
        var goal = Goal(taskID: taskID,
                        objective: "summary",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "a",
                                               kind: .toolOutcome,
                                               description: "tool A done"),
                            AcceptanceCriterion(criterionID: "b",
                                               kind: .artifactExists,
                                               description: "summary done"),
                        ])
        goal.acceptanceCriteria[0].satisfy(satisfier: "tool:list_today_calendar_events")
        goal.acceptanceCriteria[1].satisfy(satisfier: "runtime")
        let evaluator = AcceptanceEvaluator()
        let eval = evaluator.mayComplete(goal: goal)
        XCTAssertEqual(eval, .allSatisfied)
        XCTAssertTrue(eval.isTerminalEligible)
    }

    // MARK: D-03 — User-approval criterion cannot self-satisfy.

    func testD03_userApprovalCriterionCannotSelfSatisfy() {
        let taskID = UUID()
        let goal = Goal(taskID: taskID,
                        objective: "destructive action needs approval",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "user.approval",
                                               kind: .userApproval,
                                               description: "user must approve"),
                        ])
        let evaluator = AcceptanceEvaluator()
        let eval = evaluator.mayComplete(goal: goal)
        if case .waitingForUser(let missing) = eval {
            XCTAssertEqual(missing.count, 1)
            XCTAssertEqual(missing.first?.kind, .userApproval)
        } else {
            XCTFail("Expected .waitingForUser; got \(eval)")
        }
    }

    // MARK: D-04 — Criterion result persists across restart.

    func testD04_criterionResultPersistsAcrossRestart() async throws {
        let dir = p14_makeTempDir("d04")
        let store = GoalStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        var goal = Goal(taskID: taskID,
                        objective: "durable criterion",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "c1",
                                               kind: .toolOutcome,
                                               description: "tool ran"),
                        ])
        goal.acceptanceCriteria[0].satisfy(satisfier: "tool:test")
        await store.upsert(goal)
        let store2 = GoalStore(baseDirectory: dir)
        await store2.load()
        let loaded = await store2.goal(id: goal.id)
        XCTAssertNotNil(loaded)
        XCTAssertTrue(loaded?.acceptanceCriteria[0].satisfied ?? false)
        XCTAssertEqual(loaded?.acceptanceCriteria[0].satisfier, "tool:test")
    }

    // MARK: D-05 — Retry does not erase already-satisfied criteria unless invalidated.

    func testD05_retryDoesNotEraseSatisfiedCriteriaByDefault() {
        let taskID = UUID()
        var goal = Goal(taskID: taskID,
                        objective: "retry semantics",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "a",
                                               kind: .toolOutcome,
                                               description: "tool A"),
                            AcceptanceCriterion(criterionID: "b",
                                               kind: .toolOutcome,
                                               description: "tool B"),
                        ])
        goal.acceptanceCriteria[0].satisfy()
        let stillSatisfied = goal.acceptanceCriteria[0].satisfied
        XCTAssertTrue(stillSatisfied)
        goal.acceptanceCriteria[0].invalidate()
        XCTAssertFalse(goal.acceptanceCriteria[0].satisfied)
    }

    // MARK: D-06 — Cancelled task cannot later satisfy itself.

    func testD06_cancelledTaskCannotComplete() async throws {
        let dir = p14_makeTempDir("d06")
        let taskStore = DurableTaskStore(baseDirectory: dir)
        await taskStore.load()
        let taskID = UUID()
        _ = await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "cancel"))
        _ = await taskStore.applyTransition(taskID: taskID, to: .running)
        _ = await taskStore.applyTransition(taskID: taskID, to: .cancelled)
        // Cancelled is terminal — applyTransition to .completed must be rejected.
        let r = await taskStore.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(r)
    }

    // MARK: D-07 — Human-required criterion is clearly represented as waiting.

    func testD07_humanRequiredCriterionIsWaiting() {
        let taskID = UUID()
        let goal = Goal(taskID: taskID,
                        objective: "approval needed",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "tool.done",
                                               kind: .toolOutcome,
                                               description: "tool done",
                                               satisfied: true),
                            AcceptanceCriterion(criterionID: "user.approval",
                                               kind: .userApproval,
                                               description: "user must approve"),
                            AcceptanceCriterion(criterionID: "user.confirmation",
                                               kind: .userConfirmation,
                                               description: "user must confirm"),
                        ])
        let evaluator = AcceptanceEvaluator()
        let eval = evaluator.mayComplete(goal: goal)
        if case .waitingForUser(let missing) = eval {
            XCTAssertEqual(missing.count, 2)
            let kinds = Set(missing.map { $0.kind })
            XCTAssertEqual(kinds, [.userApproval, .userConfirmation])
        } else {
            XCTFail("Expected .waitingForUser; got \(eval)")
        }
    }
}
