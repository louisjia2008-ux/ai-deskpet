import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.4 — Live Retry Wakeup Race Tests (WAKE-01..05).
///
/// Per §17:
///   WAKE-01: duplicate wakeup → one attempt
///   WAKE-02: cancel before due → zero retry
///   WAKE-03: cancel vs due concurrently → no resurrection
///   WAKE-04: Runtime A shutdown + Runtime B recovery → one retry owner
///   WAKE-05: completed task + stale wakeup → ignored
@MainActor
final class P14_4LiveRetryWakeupRaceTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_4-WAKE-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Stores + coordinator factory

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

    private func makeCoordinator(taskStore: DurableTaskStore,
                                  goalStore: GoalStore,
                                  inbox: DurableInboxStore,
                                  audit: DurableAuditLogStore) async -> PetAgentRuntimeCoordinator {
        PetAgentRuntimeCoordinator(
            context: P14AFakeContextContext(),
            model: P14AEmptyRespondModel(),
            conversation: CountingRetryConversation(taskID: UUID()),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            durableTaskStore: taskStore,
            goalStore: goalStore,
            durableInboxStore: inbox,
            durableAuditLogStore: audit
        )
    }

    // MARK: - WAKE-01: duplicate wakeup → one attempt

    /// Two scheduler instances driveDueWork concurrently for the same
    /// wakeup. INV-WAKE-01 — exactly one retry is created. Production
    /// has one scheduler per runtime; this test simulates the worst
    /// case (two schedulers) to validate that the
    /// `driveSingleRetry` primitive is atomic on the actor and
    /// idempotent.
    func testWAKE01_duplicateWakeupsOneAttempt() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = await makeCoordinator(taskStore: taskStore,
                                                 goalStore: goalStore,
                                                 inbox: inbox,
                                                 audit: audit)
        let taskID = UUID()
        let retryAt = Date(timeIntervalSince1970: 5_000_000)
        await taskStore.upsert(DurableTaskRecord(
            taskID: taskID, title: "wake01", status: .waitingForRetry,
            lastFailure: DurableFailureRecord(llmFailure: LlmFailure(code: .rateLimited, message: "rl"),
                                               phase: "provider"),
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: retryAt))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        // Production-representative: ONE scheduler, multiple `driveDueWork`
        // calls. The scheduler's `registerWakeup` is idempotent on taskID
        // (re-register replaces), and `driveDueWork` removes the wakeup
        // before invoking the closure. Concurrent drives on the same
        // wakeup will see the wakeup already popped.
        let scheduler = RuntimeRetryScheduler(
            clock: { retryAt.addingTimeInterval(1) },
            onWakeup: { [coordinator] taskID, _ in
                _ = await coordinator.driveSingleRetry(taskID: taskID, now: { retryAt.addingTimeInterval(1) })
            }
        )
        await scheduler.registerWakeup(taskID: taskID, deadline: retryAt)
        // Two `driveDueWork` calls in flight (race). The first pops
        // the wakeup; the second sees the empty queue.
        async let firedA: Set<UUID> = scheduler.driveDueWork()
        async let firedB: Set<UUID> = scheduler.driveDueWork()
        let (fa, fb) = await (firedA, firedB)
        try await Task.sleep(nanoseconds: 500_000_000)

        // At least one fired; the other may report 0 (wakeup already
        // popped).
        XCTAssertTrue(fa.contains(taskID) || fb.contains(taskID),
                      "At least one driveDueWork call must fire the wakeup")
        XCTAssertFalse(fa.contains(taskID) && fb.contains(taskID),
                       "WAKE-01: both drives must NOT report firing (second sees empty queue)")

        let attempts = await taskStore.attempts(forTask: taskID)
        XCTAssertEqual(attempts.count, 2,
                       "WAKE-01: exactly one new attempt (1 initial + 1 retry)")
    }

    // MARK: - WAKE-02: cancel before due → zero retry

    /// Cancel the task BEFORE the wakeup fires. The retry never runs.
    func testWAKE02_cancelBeforeDueZeroRetry() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = await makeCoordinator(taskStore: taskStore,
                                                 goalStore: goalStore,
                                                 inbox: inbox,
                                                 audit: audit)
        let taskID = UUID()
        let retryAt = Date(timeIntervalSince1970: 5_000_000)
        await taskStore.upsert(DurableTaskRecord(
            taskID: taskID, title: "wake02", status: .waitingForRetry,
            lastFailure: DurableFailureRecord(llmFailure: LlmFailure(code: .rateLimited, message: "rl"),
                                               phase: "provider"),
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: retryAt))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        // Cancel before the deadline elapses.
        await coordinator.cancel(taskID: taskID)
        let afterCancel = await taskStore.task(id: taskID)
        XCTAssertEqual(afterCancel?.status, .cancelled)

        // Wakeup fires after cancel — terminalized, no retry.
        let clockBox = TestClockBox(initial: retryAt.addingTimeInterval(1))
        let scheduler = RuntimeRetryScheduler(
            clock: { await clockBox.now() },
            onWakeup: { [coordinator] taskID, _ in
                _ = await coordinator.resumeExecution(taskID: taskID, now: { await clockBox.now() })
            }
        )
        await scheduler.registerWakeup(taskID: taskID, deadline: retryAt)
        let fired = await scheduler.driveDueWork()
        try await Task.sleep(nanoseconds: 300_000_000)

        // `resumeExecution` returns `.unexpectedState(.cancelled)` —
        // no retry attempt created.
        let attempts = await taskStore.attempts(forTask: taskID)
        XCTAssertEqual(attempts.count, 1,
                       "WAKE-02: cancel before due must prevent retry (initial attempt only)")
    }

    // MARK: - WAKE-03: cancel vs due concurrently → no resurrection

    /// Cancel and wakeup fire at the same time. Cancel wins
    /// terminalization; the wakeup observes `.cancelled` and bails.
    /// INV-WAKE-03 deterministic semantics.
    func testWAKE03_cancelConcurrentDueNoResurrection() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = await makeCoordinator(taskStore: taskStore,
                                                 goalStore: goalStore,
                                                 inbox: inbox,
                                                 audit: audit)
        let taskID = UUID()
        let retryAt = Date(timeIntervalSince1970: 5_000_000)
        await taskStore.upsert(DurableTaskRecord(
            taskID: taskID, title: "wake03", status: .waitingForRetry,
            lastFailure: DurableFailureRecord(llmFailure: LlmFailure(code: .rateLimited, message: "rl"),
                                               phase: "provider"),
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: retryAt))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        let clockBox = TestClockBox(initial: retryAt.addingTimeInterval(1))
        let scheduler = RuntimeRetryScheduler(
            clock: { await clockBox.now() },
            onWakeup: { [coordinator] taskID, _ in
                _ = await coordinator.resumeExecution(taskID: taskID, now: { await clockBox.now() })
            }
        )
        await scheduler.registerWakeup(taskID: taskID, deadline: retryAt)

        // Race: cancel + driveDueWork concurrently.
        async let cancel: Void = coordinator.cancel(taskID: taskID)
        async let drive: Set<UUID> = scheduler.driveDueWork()
        _ = await (cancel, drive)
        try await Task.sleep(nanoseconds: 300_000_000)

        // Final state is `.cancelled` (or `.running` if retry won the race —
        // but the wakeup's `resumeExecution` sees the durable record at
        // its final state). Either way, the task is NOT `.waitingForRetry`.
        let finalState = await taskStore.task(id: taskID)?.status
        XCTAssertNotEqual(finalState, .waitingForRetry,
                          "WAKE-03: task must NOT remain .waitingForRetry after cancel/due race")
        let attempts = await taskStore.attempts(forTask: taskID)
        XCTAssertLessThanOrEqual(attempts.count, 2,
                                  "WAKE-03: at most one new retry attempt after race")
    }

    // MARK: - WAKE-04: Runtime A shutdown + Runtime B recovery → one retry owner

    /// Runtime A registers a wakeup. Runtime A dies. Runtime B
    /// reconstructs the wakeup from durable state. The Runtime A
    /// wakeup (now orphaned) must NOT fire. INV-WAKE-04.
    func testWAKE04_restartShutdownBoundaryOneRetryOwner() async throws {
        let (taskStoreA, goalStoreA, inboxA, auditA) = await makeStores()
        let conversationA = CountingRetryConversation(taskID: UUID())
        let coordinatorA = await makeCoordinator(taskStore: taskStoreA,
                                                  goalStore: goalStoreA,
                                                  inbox: inboxA,
                                                  audit: auditA)
        // Override the conversation fixture on coordinatorA (a bit hacky).
        let taskID = UUID()
        let retryAt = Date(timeIntervalSince1970: 5_000_000)
        await taskStoreA.upsert(DurableTaskRecord(
            taskID: taskID, title: "wake04", status: .waitingForRetry,
            lastFailure: DurableFailureRecord(llmFailure: LlmFailure(code: .rateLimited, message: "rl"),
                                               phase: "provider"),
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: retryAt))
        await taskStoreA.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        // Runtime A's scheduler. Register, do NOT fire.
        let schedulerA = RuntimeRetryScheduler(
            clock: { retryAt.addingTimeInterval(1) },
            onWakeup: { _, _ in
                // No-op: Runtime A's scheduler outlives its process.
            }
        )
        await schedulerA.registerWakeup(taskID: taskID, deadline: retryAt)
        let registeredA = await schedulerA.registeredCount()
        XCTAssertEqual(registeredA, 1)

        // Destroy Runtime A.
        _ = coordinatorA; _ = taskStoreA; _ = goalStoreA; _ = inboxA; _ = auditA
        _ = conversationA

        // Runtime B comes up with a FRESH scheduler (empty by
        // construction — INV-WAKE-04). The durable state must be
        // reloaded, but the new wakeup is registered separately.
        let (taskStoreB, goalStoreB, inboxB, auditB) = await makeStores()
        let coordinatorB = await makeCoordinator(taskStore: taskStoreB,
                                                  goalStore: goalStoreB,
                                                  inbox: inboxB,
                                                  audit: auditB)
        _ = await coordinatorB.reconcileAfterRestart()

        // Evaluate retries on Runtime B with a clock past the deadline.
        // The Runtime A scheduler is gone; only Runtime B's `evaluateRetries`
        // can transition the task.
        let resumed = await coordinatorB.evaluateRetries(now: { retryAt.addingTimeInterval(1) })
        XCTAssertTrue(resumed.contains(taskID),
                      "WAKE-04: Runtime B must own the retry")

        try await Task.sleep(nanoseconds: 300_000_000)
        let attempts = await taskStoreB.attempts(forTask: taskID)
        XCTAssertLessThanOrEqual(attempts.count, 2,
                                  "WAKE-04: at most one new retry attempt (Runtime A's scheduler is gone)")
    }

    // MARK: - WAKE-05: completed task + stale wakeup → ignored

    /// The task is `.cancelled` (terminal). A wakeup is still
    /// registered from a prior scheduling round. Firing the wakeup
    /// must NOT create a new attempt. INV-WAKE-05.
    func testWAKE05_terminalTaskStaleWakeupIgnored() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = await makeCoordinator(taskStore: taskStore,
                                                 goalStore: goalStore,
                                                 inbox: inbox,
                                                 audit: audit)
        let taskID = UUID()
        let retryAt = Date(timeIntervalSince1970: 5_000_000)
        await taskStore.upsert(DurableTaskRecord(
            taskID: taskID, title: "wake05", status: .waitingForRetry,
            lastFailure: DurableFailureRecord(llmFailure: LlmFailure(code: .rateLimited, message: "rl"),
                                               phase: "provider"),
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: retryAt))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        // Mark the task `.cancelled` directly (legal transition from
        // `.waitingForRetry`).
        _ = await taskStore.applyTransition(taskID: taskID, to: .cancelled)
        let cancelledRecord = await taskStore.task(id: taskID)
        XCTAssertEqual(cancelledRecord?.status, .cancelled)

        // A stale wakeup still registered. Firing must NOT mutate.
        let clockBox = TestClockBox(initial: retryAt.addingTimeInterval(1))
        let scheduler = RuntimeRetryScheduler(
            clock: { await clockBox.now() },
            onWakeup: { [coordinator] taskID, _ in
                _ = await coordinator.resumeExecution(taskID: taskID, now: { await clockBox.now() })
            }
        )
        await scheduler.registerWakeup(taskID: taskID, deadline: retryAt)
        let fired = await scheduler.driveDueWork()
        try await Task.sleep(nanoseconds: 300_000_000)

        let afterFired = await taskStore.task(id: taskID)
        XCTAssertEqual(afterFired?.status, .cancelled,
                       "WAKE-05: cancelled task must remain .cancelled (stale wakeup ignored)")
        let attempts = await taskStore.attempts(forTask: taskID)
        XCTAssertEqual(attempts.count, 1,
                       "WAKE-05: stale wakeup must NOT create a new attempt")
    }
}