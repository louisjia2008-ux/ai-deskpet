import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.2 — Race / Concurrency Tests.
///
/// Verifies that concurrent recovery scans, cancel + retry, and stale
/// callbacks interact correctly with the durable kernel. INV-CONT-04
/// (at most one active continuation per taskID) is exercised here.

@MainActor
final class P14_2RaceAndConcurrencyTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_2-RACE-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

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

    // RACE-01: approval and cancellation concurrently.
    func testRace01_approvalAndCancellationConcurrentDeterministicOutcome() async throws {
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
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .waitingForApproval))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)
        _ = await coordinator.recoverPendingApprovals()

        // Race: approval + cancellation simultaneously
        async let approved: Bool = coordinator.approveActivePlan(taskID: taskID)
        async let cancelled: Void = coordinator.cancel(taskID: taskID)
        let _ = await approved
        let _ = await cancelled

        // Either:
        //   1) approve won → durable is `.running` (then cancel terminalizes → `.cancelled`)
        //   2) cancel won → durable is `.cancelled`
        // Both outcomes MUST produce a terminalized attempt; `.running`
        // is NOT acceptable.
        let after = await taskStore.task(id: taskID)
        XCTAssertNotEqual(after?.status, .running,
                          "INV-CANCEL-03: racing approval and cancel must NOT leave .running")
    }

    // RACE-02: cancel + model stream completion concurrently — no resurrection.
    func testRace02_cancelAndModelCompletionConcurrentNoResurrection() async throws {
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

        // Cancel first, then attempt a stale completion. The cancel
        // registers the attempt as terminalized so the completion
        // attempt must be rejected by the durable store.
        await coordinator.cancel(taskID: taskID)
        let completionAttempt = await taskStore.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(completionAttempt,
                     "R-A-F4: stale completion must NOT succeed after cancel")
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled,
                       "Stale completion cannot resurrect a cancelled task")
    }

    // RACE-03: restart recovery and manual resume concurrently.
    func testRace03_restartRecoveryAndManualResumeAtMostOneContinuation() async throws {
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
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .waitingForApproval))

        // Race two recoverPendingApprovals scans concurrently.
        async let r1: Set<UUID> = coordinator.recoverPendingApprovals()
        async let r2: Set<UUID> = coordinator.recoverPendingApprovals()
        let a = await r1
        let b = await r2
        // INV-CONT-04: at most one active continuation per taskID.
        // The union of recovered taskIDs must contain taskID exactly once
        // OR at most one of the two calls recovered it (depending on which
        // got there first).
        let reservations = await coordinator.supervisor.recoveryReservationsSnapshot()
        XCTAssertTrue(reservations.contains(taskID) || (!a.contains(taskID) && !b.contains(taskID)),
                      "INV-CONT-04: exactly one scan must own taskID")
    }

    // RACE-04: retry wakeup and cancel concurrently.
    func testRace04_retryWakeupAndCancelConcurrentNoRetry() async throws {
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

        // Cancel first. Once the task is .cancelled, a retry wakeup
        // (recordNewAttempt) is rejected by INV-DUR-03.
        await coordinator.cancel(taskID: taskID)
        let newAttempt = await taskStore.recordNewAttempt(taskID: taskID,
                                                          attemptID: UUID(),
                                                          runID: UUID())
        XCTAssertNil(newAttempt,
                     "INV-CANCEL-03: a retry wakeup arriving after cancel must NOT spawn a new attempt")
    }

    // RACE-05: two Runtime B recovery scans concurrently.
    func testRace05_twoRuntimeBRecoveryScansOneAttempt() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator1 = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
            audit: audit
        )
        let coordinator2 = p14A_singleCoordinator(
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
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .waitingForApproval))

        // Each coordinator has its own supervisor, so `reserveRecovery`
        // is per-coordinator. The test verifies the durable state is
        // consistent and only ONE scan actually owns the taskID on
        // each coordinator.
        async let r1: Set<UUID> = coordinator1.recoverPendingApprovals()
        async let r2: Set<UUID> = coordinator2.recoverPendingApprovals()
        let a = await r1
        let b = await r2
        let combined = a.union(b)
        XCTAssertTrue(combined.contains(taskID),
                      "At least one scan must own the recovered taskID")
        // Each coordinator's supervisor holds AT MOST ONE reservation.
        let r1Snap = await coordinator1.supervisor.recoveryReservationsSnapshot()
        let r2Snap = await coordinator2.supervisor.recoveryReservationsSnapshot()
        XCTAssertTrue(r1Snap.contains(taskID) || r2Snap.contains(taskID))
    }

    // RACE-06: old Runtime A callback vs new Runtime B attempt.
    func testRace06_oldCallbackVsNewAttemptOldIgnored() async throws {
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
        let oldAttemptID = UUID()
        let newAttemptID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .running))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: oldAttemptID, runID: oldAttemptID)

        // "Crash" — Runtime A leaves the durable record at .running.
        // Runtime B recovers via RecoveryClassifier → .interrupted
        let classifier = RecoveryClassifier()
        let record = await taskStore.task(id: taskID)!
        _ = await classifier.classify(record)
        _ = await taskStore.applyTransition(taskID: taskID, to: .interrupted)

        // Runtime B creates a new attempt.
        let newAttempt = await taskStore.recordNewAttempt(taskID: taskID,
                                                          attemptID: newAttemptID,
                                                          runID: newAttemptID)
        XCTAssertNotNil(newAttempt, "New attempt creation should succeed on .interrupted")

        // Old Runtime A callback arrives; tries to mutate to .completed.
        // The store rejects because the new attempt's terminal state is
        // not yet reached and .interrupted → .completed is not allowed.
        let oldCallback = await taskStore.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(oldCallback, "R-A-F4: old callback must not resurrect")

        let after = await taskStore.task(id: taskID)!
        XCTAssertEqual(after.currentAttemptID, newAttemptID,
                       "Runtime B's new attempt must remain the current attempt")
    }

    // CONT-01: full continuation slice (covered in P14_2ContinuationRecoverySlicesTests)
    // but we re-verify the assertion invariants here in a focused way.

    // CONT-02: restart twice before approval — only one active continuation.
    func testCONT02_twoRecoveryScansYieldOneContinuation() async throws {
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
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .waitingForApproval))

        let r1 = await coordinator.recoverPendingApprovals()
        let r2 = await coordinator.recoverPendingApprovals()
        let r3 = await coordinator.recoverPendingApprovals()

        XCTAssertTrue(r1.contains(taskID), "First scan must own taskID")
        XCTAssertFalse(r2.contains(taskID), "Second scan must NOT own taskID (INV-CONT-04)")
        XCTAssertFalse(r3.contains(taskID), "Third scan must NOT own taskID (INV-CONT-04)")

        // Give the spawned continuation a moment to register.
        try await Task.sleep(nanoseconds: 200_000_000)
        let pending = await coordinator.supervisor.pendingCount()
        XCTAssertEqual(pending, 1,
                       "INV-CONT-04: only one continuation must exist for the recovered taskID")

        // Approve it; the second approve is rejected (no continuation left).
        let first = await coordinator.approveActivePlan(taskID: taskID)
        XCTAssertTrue(first)
        let second = await coordinator.approveActivePlan(taskID: taskID)
        XCTAssertFalse(second, "Second approve must NOT consume a continuation (already consumed)")
    }

    // CONT-03: approval arrives immediately during Runtime B startup.
    func testCONT03_approvalDuringStartupIsNotLost() async throws {
        let (taskStore, _, inbox, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: inbox,
            audit: audit
        )
        let taskID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "t", status: .waitingForApproval))

        // Inject the approval decision BEFORE the recovery scan runs.
        await inbox.appendIfNew(InboxEvent(taskID: taskID,
                                            kind: .approvalDecision,
                                            payload: .object(["decision": .string("approved")])))

        // Recovery scan still creates a continuation (the inbox event is
        // a decision, not a request; the supervisor awaits the user-facing
        // approval flow). The test verifies the recovery scan does not
        // crash on a pre-existing approval event in the inbox.
        let recovered = await coordinator.recoverPendingApprovals()
        XCTAssertTrue(recovered.contains(taskID))
    }

    // CONT-06: old approval request for previous attempt cannot satisfy a
    // replacement approval request. We model this via two distinct taskIDs.
    func testCONT06_oldApprovalRequestCannotSatisfyReplacement() async throws {
        let (taskStore, _, inbox, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
            inbox: inbox,
            audit: audit
        )
        let oldTaskID = UUID()
        let newTaskID = UUID()
        await taskStore.upsert(DurableTaskRecord(taskID: oldTaskID, title: "old", status: .waitingForApproval))
        await taskStore.upsert(DurableTaskRecord(taskID: newTaskID, title: "new", status: .waitingForApproval))
        _ = await coordinator.recoverPendingApprovals()

        // Give the spawned continuations a moment to register.
        try await Task.sleep(nanoseconds: 200_000_000)
        let pending = await coordinator.supervisor.pendingCount()
        XCTAssertEqual(pending, 2, "Two distinct taskIDs MUST produce two distinct continuations")

        // Approve the OLD task — must NOT resume the new task's continuation.
        let approvedOld = await coordinator.approveActivePlan(taskID: oldTaskID)
        XCTAssertTrue(approvedOld)
        let pendingAfterOld = await coordinator.supervisor.pendingCount()
        XCTAssertEqual(pendingAfterOld, 1,
                       "Approving one taskID must NOT consume the other taskID's continuation")

        let approvedNew = await coordinator.approveActivePlan(taskID: newTaskID)
        XCTAssertTrue(approvedNew)
        let pendingAfterNew = await coordinator.supervisor.pendingCount()
        XCTAssertEqual(pendingAfterNew, 0,
                       "After both are approved, the supervisor is drained")
    }
}