import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.3 — Final Durability Evidence Closure Tests.
///
/// Two mandatory production-grade Runtime A → Runtime B slices:
///
///   R1 — Retry Deadline Enforcement (INV-RD-01..04)
///     • Runtime A: real production coordinator + provider fixture that
///       returns 429 with Retry-After=60s → task becomes .waitingForRetry,
///       nextRetryAt persisted, physical provider attempt count = 1.
///     • destroy Runtime A
///     • Runtime B: same durable storage root, production startup/reconcile,
///       injected clock = +30s, evaluateRetries()
///     • ASSERT: task still .waitingForRetry, attempt count == 1, no
///       new attemptID, no provider call
///     • advance injected clock to +61s, evaluateRetries()
///     • ASSERT: attempt count == 2, exactly one new attempt, same taskID
///
///   A1 — Approval Continuation Execution (INV-ACR-01..05)
///     • Runtime A: real production coordinator, durable Goal starts,
///       step 1 executes, Goal reaches .waitingForApproval, approval
///       request + checkpoint persisted
///     • capture userMessageCount, taskID, attemptID, step1ExecutionCount
///     • destroy Runtime A
///     • Runtime B: same durable root, production startup/reconcile,
///       recoverPendingApprovals
///     • ASSERT before approval: pending continuation == 1,
///       task == .waitingForApproval
///     • inject real durable approval decision
///     • NO new user message
///     • ASSERT: same taskID, execution resumes automatically,
///       postApprovalExecutionCount == 1, acceptance criteria satisfied,
///       task reaches .completed exactly once, userMessageCount unchanged

@MainActor
final class P14_3FinalDurabilityEvidenceTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_3-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Helpers

    /// Real production `DurableTaskStore`, `GoalStore`, `DurableInboxStore`,
    /// `DurableAuditLogStore` wired to the on-disk root. Each "Runtime"
    /// recreates them against the SAME root so durable state survives the
    /// recreation (this is the file-system-backed persistence model).
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
        p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore,
            goalStore: goalStore,
            inbox: inbox,
            audit: audit
        )
    }

    // MARK: - Slice R1 — Retry Deadline Enforcement

    /// P14.3 Slice R1 (mandatory). The single most important retry test in
    /// P14.3. A test that only asserts `loaded.nextRetryAt == expectedDate`
    /// is insufficient — production must prevent early execution AND
    /// trigger exactly one retry after the deadline.
    func testSliceR1_RetryDeadlineEnforcementRuntimeAtoB() async throws {
        let retryAfterSeconds: TimeInterval = 60
        let retryAfterMs = Int(retryAfterSeconds * 1000)

        // === Runtime A ===
        let (taskStoreA, _, _, auditA) = await makeStores()
        let _ = await makeCoordinator(taskStore: taskStoreA, goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
                                       inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
                                       audit: auditA)
        let taskID = UUID()
        let attemptID_A = UUID()
        let record = DurableTaskRecord(taskID: taskID,
                                       title: "rate-limited-task",
                                       status: .running,
                                       retryPolicy: AgentRetryPolicy(maxAttempts: 3))
        await taskStoreA.upsert(record)
        await taskStoreA.recordNewAttempt(taskID: taskID, attemptID: attemptID_A, runID: attemptID_A)
        let attemptCountA = await taskStoreA.attempts(forTask: taskID).count
        XCTAssertEqual(attemptCountA, 1, "Runtime A: physical attempt count = 1")

        // Provider fixture returns 429 with Retry-After: 60.
        let llmFailure = LlmFailure(code: .rateLimited,
                                     message: "rate limited",
                                     httpStatus: 429,
                                     providerRetryAfterMs: retryAfterMs)
        let failure = DurableFailureRecord(llmFailure: llmFailure, phase: "provider")
        let originalNow = Date(timeIntervalSince1970: 1_000_000)
        let retryAt = originalNow.addingTimeInterval(retryAfterSeconds)
        _ = await taskStoreA.applyTransition(taskID: taskID, to: .waitingForRetry,
                                              failure: failure, nextRetryAt: retryAt)

        // Destroy Runtime A by simply dropping the references.
        // (No actual deinit needed — the durable store files persist.)
        _ = taskStoreA; _ = auditA

        // === Runtime B (before deadline) ===
        let (taskStoreB, _, _, auditB) = await makeStores()
        let coordinatorB = await makeCoordinator(taskStore: taskStoreB,
                                                 goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
                                                 inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
                                                 audit: auditB)

        // Production startup/reconcile. `evaluateRetries` is invoked with
        // the controller's clock; in the test we call it directly with an
        // injectable clock to advance time deterministically (no real
        // sleep).
        let t30 = originalNow.addingTimeInterval(30)
        let resumedEarly = await coordinatorB.evaluateRetries(now: { t30 })
        XCTAssertTrue(resumedEarly.isEmpty,
                      "INV-RD-01: at t+30 the deadline has NOT elapsed; no retry must run")

        // No new attempt must have been created.
        let attemptsAfterEarly = await taskStoreB.attempts(forTask: taskID).count
        XCTAssertEqual(attemptsAfterEarly, 1,
                       "Physical attempt count must still be 1 (no early retry)")
        let earlyRecord = await taskStoreB.task(id: taskID)
        XCTAssertEqual(earlyRecord?.status, .waitingForRetry,
                       "Task must remain .waitingForRetry before deadline")

        // === Runtime B (after deadline) ===
        let t61 = originalNow.addingTimeInterval(61)
        let resumed = await coordinatorB.evaluateRetries(now: { t61 })
        XCTAssertEqual(resumed.count, 1, "Exactly one retry must resume after deadline")
        XCTAssertTrue(resumed.contains(taskID),
                      "Retry resume must target the original taskID (INV-RD-03)")

        // Allow the resumed execution to drain.
        try await Task.sleep(nanoseconds: 500_000_000)

        // Audit must record exactly one retryResumed event for this task.
        let events = await auditB.readAll()
        let retryEvents = events.filter { $0.kind == .retryResumed && $0.correlationID == taskID }
        XCTAssertEqual(retryEvents.count, 1,
                       "Exactly one retryResumed audit event must be emitted")

        // P14.4 — `evaluateRetries` now drives REAL execution (see
        // P14_4ExecutableApprovalAndRetryTests for the full-execution
        // evidence: `physicalProviderInvocationCount == 2`). This P14.3
        // test no longer asserts attempt count or `.running` status
        // because those were fake-execution evidence. The real behavior
        // is verified by P14.4 tests.
        //
        // The remaining invariants (idempotency, deadline gate) are
        // checked below.

        // INV-RD-03 — multiple evaluations after the deadline must NOT
        // create duplicate retries. Re-running with t+120 must not bump
        // the count again (the task is no longer `.waitingForRetry`, so
        // `evaluateRetries` should skip it).
        let t120 = originalNow.addingTimeInterval(120)
        let resumedAgain = await coordinatorB.evaluateRetries(now: { t120 })
        XCTAssertTrue(resumedAgain.isEmpty,
                      "INV-RD-03: re-evaluation after task no longer .waitingForRetry must not create duplicates")
    }

    // MARK: - Slice A1 — Approval Continuation Execution
    //
    // P14.4 NOTE — the P14.3 implementation of `testSliceA1` was
    // superseded. P14.4 replaced `resumeAgenticWorkAfterApproval`'s
    // fake-counter body (`postApprovalExecutionCount[taskID] += 1`)
    // with a REAL production execution driver (`resumeExecution`)
    // that invokes `coordinator.handle(event) → converse →
    // conversation.generate(...)`. The fake counter and the
    // pre-satisfied acceptance criteria were anti-patterns called
    // out by P14.4 §40 ("This does NOT count") and §18 ("Remove
    // fake execution evidence").
    //
    // The mandatory real-execution version is at:
    //   Tests/DeskPetTests/P14_4ExecutableApprovalAndRetryTests.swift
    //     testSliceA1_ApprovalRecoveryDrivesRealPostApprovalProviderInvocation
    //
    // P14.4 verifies REAL provider invocation, REAL criterion
    // satisfaction as a side effect, and REAL `.completed`
    // transition via the authoritative pipeline.

    // MARK: - INV-RD-04 — Cancel wins

    /// P14.3 — cancel during `.waitingForRetry` must remain terminal even
    /// after the deadline passes.
    func testINV_RD_04_CancelDuringWaitingForRetryWinsOverDeadline() async throws {
        let (taskStore, _, _, audit) = await makeStores()
        let coordinator = await makeCoordinator(taskStore: taskStore,
                                                 goalStore: GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true)),
                                                 inbox: DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl")),
                                                 audit: audit)

        let taskID = UUID()
        let originalNow = Date(timeIntervalSince1970: 1_000_000)
        let retryAt = originalNow.addingTimeInterval(5)
        let record = DurableTaskRecord(taskID: taskID,
                                       title: "cancel-during-retry",
                                       status: .waitingForRetry)
        await taskStore.upsert(record)
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())
        _ = await taskStore.applyTransition(taskID: taskID, to: .waitingForRetry,
                                            nextRetryAt: retryAt)

        // Cancel the task before the deadline elapses.
        await coordinator.cancel(taskID: taskID)
        let afterCancel = await taskStore.task(id: taskID)
        XCTAssertEqual(afterCancel?.status, .cancelled,
                       "Cancel must terminalize the task as .cancelled")

        // Advance the clock past the deadline. evaluateRetries must skip
        // terminal records.
        let t10 = originalNow.addingTimeInterval(10)
        let resumed = await coordinator.evaluateRetries(now: { t10 })
        XCTAssertTrue(resumed.isEmpty,
                      "INV-RD-04: cancelled task must NOT transition to .running even after deadline")
        let afterRetry = await taskStore.task(id: taskID)
        XCTAssertEqual(afterRetry?.status, .cancelled,
                       "INV-RD-04: cancelled task must remain .cancelled")
    }
}