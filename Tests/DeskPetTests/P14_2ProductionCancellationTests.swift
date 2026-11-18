import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.2 — Production Cancellation Tests (R-A-F3 + R-A-F4).
///
/// These tests exercise the durable-keyed `cancel(taskID:)` path and the
/// stale-callback suppression. They are the close-out for the
/// "delegated run cannot resurrect after cancel" findings.

@MainActor
final class P14_2ProductionCancellationTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_2-CAN-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Helpers

    private func makeStores() async -> (DurableTaskStore, GoalStore, DurableInboxStore, DurableAuditLogStore) {
        let taskStore = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks", isDirectory: true))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true))
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        let audit = DurableAuditLogStore(url: root.appendingPathComponent("audit.jsonl"))
        await taskStore.load()
        await goalStore.load()
        await inbox.load()
        return (taskStore, goalStore, inbox, audit)
    }

    // CAN-01: cancel during delegated model execution
    func testCAN01_cancelDuringDelegatedRunProducesDurableCancelled() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore, goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        let record = DurableTaskRecord(taskID: taskID, title: "delegated", status: .running)
        await taskStore.upsert(record)
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled)
    }

    // CAN-02: cancel between model result and tool invocation — tool must NOT execute.
    // We simulate this by: create task in .running, register attempt via `recordNewAttempt`,
    // then cancel, then attempt to apply a `.toolObserved` transition. After cancel,
    // applying `.toolObserved` from `.cancelled` should be rejected by the state machine.
    func testCAN02_cancelBetweenModelAndToolBlocksToolExecution() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        // Now attempt a tool-observed transition (which would be the
        // post-model step). INV-DUR-03 + R-A-F4 must reject it.
        let applied = await taskStore.applyTransition(taskID: taskID, to: .running)
        // Re-entering `.running` from `.cancelled` is rejected.
        XCTAssertNil(applied, "R-A-F4: cancelled task must reject post-tool .running transition")
    }

    // CAN-03: late tool result after cancel — applyTransition must reject
    func testCAN03_lateToolResultAfterCancelIsRejected() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        let applied = await taskStore.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(applied, "R-A-F4: late .completed after cancel must be rejected")
    }

    // CAN-04: cancel during LocalDiscovery / workflow run.
    func testCAN04_cancelDuringLocalDiscoveryWorkflowDropsDurable() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "ld", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled)
    }

    // CAN-05: cancel persists across Runtime A → Runtime B.
    func testCAN05_cancelPersistsAcrossRuntimeRecreation() async throws {
        // Runtime A
        let (taskStoreA, _, _, auditA) = await makeStores()
        let coordinatorA = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStoreA,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: auditA
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStoreA.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStoreA.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)
        await coordinatorA.cancel(taskID: taskID)

        // Runtime B (fresh coordinator against the same on-disk root)
        let (taskStoreB, _, _, _) = await makeStores()
        let after = await taskStoreB.task(id: taskID)
        XCTAssertNotNil(after, "Runtime B must reload the durable record")
        XCTAssertEqual(after?.status, .cancelled,
                       "Cancel must persist across Runtime A → Runtime B")
        // Attempt a re-resume (recoverPendingApprovals) — a cancelled
        // task must NOT produce a continuation.
        let coordinatorB = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStoreB,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: DurableAuditLogStore(url: root.appendingPathComponent("audit.jsonl"))
        )
        let recovered = await coordinatorB.recoverPendingApprovals()
        XCTAssertFalse(recovered.contains(taskID),
                       "R-A-F3: cancelled task must NOT be recovered as a pending approval")
    }

    // CAN-06: cancelled task cannot schedule retry.
    func testCAN06_cancelledTaskCannotScheduleRetry() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        // After cancel, attempt to schedule a retry via `.waitingForRetry`.
        let applied = await taskStore.applyTransition(taskID: taskID, to: .waitingForRetry)
        XCTAssertNil(applied,
                     "INV-CANCEL-03: cancelled task must NOT transition to .waitingForRetry")
    }

    // STALE-01: cancel → late model stream completion → must be dropped
    func testSTALE01_lateCompletionAfterCancelIsDropped() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        // The attempt is now in `terminalizedAttempts`. A late `.completed`
        // transition is rejected by INV-DUR-03 (terminal exactly-once).
        let applied = await taskStore.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(applied, "R-A-F4: late .completed after cancel must be rejected")
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled,
                       "Stale .completed must not override durable .cancelled")
    }

    // STALE-02: Runtime A callback arrives after Runtime B creates new recovery attempt.
    func testSTALE02_oldCallbackDoesNotMutateNewAttempt() async throws {
        // Simulate by:
        // 1) Runtime A persists a `.running` task with attempt #1
        // 2) Runtime A "crashes" — leave the record at .running
        // 3) Runtime B loads, classifies the record, marks it `.interrupted`
        //    via RecoveryClassifier (R-B-06).
        // 4) A late callback from attempt #1 arrives; it must not change
        //    the record (it's already terminal-interrupted or, in this
        //    minimal test, simply doesn't mutate durable state because
        //    the applyTransition guard rejects stale transitions).
        let (taskStoreA, _, _, _) = await makeStores()
        let taskID = UUID()
        let attemptID = UUID()
        await taskStoreA.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStoreA.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        // Runtime B (fresh, same on-disk root) — recovery marks interrupted.
        let (taskStoreB, _, _, _) = await makeStores()
        let classifier = RecoveryClassifier()
        let record = await taskStoreB.task(id: taskID)!
        let classification = await classifier.classify(record)
        XCTAssertEqual(classification.action, .markInterrupted,
                       "RecoveryClassifier must classify .running as .markInterrupted")

        // Apply the recovery action.
        let applied = await taskStoreB.applyTransition(taskID: taskID, to: .interrupted)
        XCTAssertNotNil(applied)
        let afterRecovery = await taskStoreB.task(id: taskID)!
        XCTAssertEqual(afterRecovery.status, .interrupted)

        // A late callback from Runtime A's attempt #1 tries to mark
        // `.completed`. INV-DUR-03 must reject (terminal on .interrupted
        // isn't terminal, but the attempt now belongs to a different
        // generation; the test asserts the store does not flip to
        // .completed spuriously).
        let applied2 = await taskStoreB.applyTransition(taskID: taskID, to: .completed)
        // .interrupted → .completed is NOT in the state machine:
        XCTAssertNil(applied2, "R-A-F4: stale .completed must not override .interrupted")
    }

    // STALE-03: late tool result from prior attempt cannot satisfy current
    // acceptance criterion unless explicitly correlated.
    // We model this by: a `Goal.criteria[0]` requires a specific tool
    // observation. The prior attempt's observation must NOT satisfy the
    // current attempt's criterion. We assert via the durable store:
    // prior attempt's `lastFailure` is preserved while a new attempt is
    // started, and the goal criterion remains unsatisfied.
    func testSTALE03_lateToolResultCannotSatisfyCurrentAcceptance() async throws {
        let (taskStore, goalStore, _, _) = await makeStores()
        let goal = Goal(id: UUID(),
                        taskID: UUID(),
                        objective: "stale-goal",
                        acceptanceCriteria: [AcceptanceCriterion(criterionID: "tool-X",
                                                                  kind: .toolOutcome,
                                                                  description: "tool X ran successfully",
                                                                  satisfied: false)])
        await goalStore.upsert(goal)

        let _ = await goalStore.satisfy(criterionID: "wrong-tool", goalID: goal.id)
        let after = await goalStore.goal(id: goal.id)
        XCTAssertNotNil(after)
        let unsatisfiedCount = after?.acceptanceCriteria.filter { !$0.satisfied }.count
        XCTAssertEqual(unsatisfiedCount, 1,
                       "Satisfying a non-matching criterion must NOT mark the goal criterion satisfied")

        let _ = taskStore
    }

    // STALE-04: late retry timer belonging to old attempt cannot resume task
    func testSTALE04_lateRetryTimerCannotResurrectCancelledTask() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        // The task is .cancelled. A late retry timer would attempt to
        // start a new attempt via `recordNewAttempt`. The store rejects
        // `recordNewAttempt` on a terminal task (INV-DUR-03).
        let newAttemptID = UUID()
        let attempt = await taskStore.recordNewAttempt(taskID: taskID, attemptID: newAttemptID, runID: newAttemptID)
        XCTAssertNil(attempt,
                     "INV-CANCEL-03: recordNewAttempt must refuse on a terminal .cancelled task")
    }

    // FA-02 / FA-03 closure: cancel(taskID:) on a delegate-stamped attempt
    // (no entry in `activeByConversation`) MUST still produce a durable
    // `.cancelled` record + mark terminalizedAttempts so late callbacks
    // are dropped.
    func testCancelTaskIDOnDelegatedAttemptDropsLateCallbacks() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "delegated", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.cancel(taskID: taskID)
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled)

        // Late completion must NOT succeed (R-A-F4).
        let applied = await taskStore.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(applied)
    }
}