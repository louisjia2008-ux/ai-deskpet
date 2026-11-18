import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.5 — Mandatory Retry E2E Tests (no manual state seeding).
///
/// Per §36, §37, §38, §44, §45:
///   The mandatory test must prove:
///     real provider invocation #1
///       → 429
///       → typed LlmFailure
///       → production retry policy
///       → production waitingForRetry
///       → production nextRetryAt
///       → production scheduler registration
///
///   WITHOUT:
///     applyTransition(.waitingForRetry)
///     manual nextRetryAt assignment
///     manual scheduler registration
///     direct retry-policy invocation substituting for production

/// Thread-safe clock holder that BOTH the production `RuntimeClock`
/// (sync `now()`) and the production `RuntimeRetryScheduler.clock`
/// (async `() async -> Date`) consume.
final class P14_5TestClock: RuntimeClock, @unchecked Sendable {
    private let lock = NSLock()
    private var _now: Date

    init(initial: Date) { self._now = initial }

    func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        return _now
    }

    func set(_ d: Date) {
        lock.lock(); defer { lock.unlock() }
        _now = d
    }
}

@MainActor
final class P14_5ProductionRetryHandoffTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_5-HANDOFF-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Stores + production lifecycle factory

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

    /// Build a fresh `DurableTaskStore` against the same on-disk root.
    /// Used by the restart test to construct Runtime B with a fresh
    /// actor that reads the persisted records.
    private func reopenTaskStore() async -> DurableTaskStore {
        let taskStore = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks", isDirectory: true))
        await taskStore.load()
        return taskStore
    }
    private func reopenGoalStore() async -> GoalStore {
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true))
        await goalStore.load()
        return goalStore
    }
    private func reopenInbox() async -> DurableInboxStore {
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        await inbox.load()
        return inbox
    }
    private func reopenAudit() -> DurableAuditLogStore {
        DurableAuditLogStore(url: root.appendingPathComponent("audit.jsonl"))
    }

    /// Production-style fixture: 429 on invocation #1, success on #2+.
    /// `physicalInvocationCount` increments INSIDE the provider boundary.
    actor CountingRateLimitConversation: ConversationGenerating {
        let retryAfterMs: Int
        private(set) var physicalInvocationCount: Int = 0

        init(retryAfterMs: Int = 60_000) { self.retryAfterMs = retryAfterMs }

        nonisolated func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
            let ms = self.retryAfterMs
            return AsyncThrowingStream { continuation in
                Task { await self.handleInvocation(continuation: continuation, retryAfterMs: ms) }
            }
        }

        private func handleInvocation(
            continuation: AsyncThrowingStream<ConversationChunk, Error>.Continuation,
            retryAfterMs: Int
        ) async {
            physicalInvocationCount += 1
            if physicalInvocationCount == 1 {
                let failure = LlmFailure(code: .rateLimited,
                                          message: "rate limited",
                                          httpStatus: 429,
                                          providerRetryAfterMs: retryAfterMs)
                continuation.yield(.typedError(failure))
                continuation.finish(throwing: ConversationGenerationError(message: failure.message))
            } else {
                continuation.yield(.metadata(.nonStreaming))
                continuation.yield(.delta(sequence: 1, text: "retry success"))
                continuation.yield(.completed(emotion: .neutral, viaCloud: false))
                continuation.finish()
            }
        }
    }

    private func makeCoordinator(
        taskStore: DurableTaskStore,
        goalStore: GoalStore,
        inbox: DurableInboxStore,
        audit: DurableAuditLogStore,
        conversation: ConversationGenerating,
        clock: P14_5TestClock
    ) async -> (PetAgentRuntimeCoordinator, RuntimeLifecycleController, RuntimeRetryScheduler) {
        // Build a holder that the scheduler's onWakeup closure
        // captures by reference; populate it after the coordinator is
        // constructed (so the closure can route wakeups to the
        // coordinator's `driveSingleRetry` primitive).
        final class Holder: @unchecked Sendable {
            var coordinator: PetAgentRuntimeCoordinator?
        }
        let holder = Holder()
        let scheduler = RuntimeRetryScheduler(
            clock: { @Sendable in clock.now() },
            onWakeup: { @Sendable taskID, _ in
                if let c = holder.coordinator {
                    _ = await c.driveSingleRetry(taskID: taskID)
                }
            }
        )
        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContextContext(),
            model: P14AEmptyRespondModel(),
            conversation: conversation,
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            clock: clock,
            durableTaskStore: taskStore,
            goalStore: goalStore,
            durableInboxStore: inbox,
            durableAuditLogStore: audit,
            retryPolicy: AgentRetryPolicy(maxAttempts: 3, baseDelay: 1, exponentialBackoff: false),
            retryScheduler: scheduler
        )
        holder.coordinator = coordinator
        let lifecycle = RuntimeLifecycleController(
            coordinator: coordinator,
            audit: InMemoryAuditSink(),
            ids: UUIDIdentifierGenerator(),
            clock: clock,
            retryScheduler: scheduler,
            liveDriverIntervalSeconds: 0.05
        )
        return (coordinator, lifecycle, scheduler)
    }

    // MARK: - Test 1: Retry Handoff (no manual state)

    /// P14.5 §11 / §36 — the SINGLE MOST IMPORTANT TEST.
    ///
    /// Real provider invocation #1 → 429 → typed LlmFailure →
    /// PRODUCTION retry policy decides retry → PRODUCTION `applyTransition`
    /// sets `.waitingForRetry` + `nextRetryAt` → PRODUCTION scheduler
    /// registers wakeup.
    ///
    /// The test asserts all of these WITHOUT calling `applyTransition`,
    /// `nextRetryAt = ...`, `scheduler.registerWakeup(...)`, or any
    /// direct `retryPolicy.shouldRetry(...)` substitution.
    func testRetryHandoff_NoManualState_RealProviderFlow() async throws {
        let taskID = UUID()
        let goalID = UUID()
        let conversationID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = CountingRateLimitConversation(retryAfterMs: 60_000)

        let clock = P14_5TestClock(initial: Date(timeIntervalSince1970: 10_000_000))
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)

        await goalStore.upsert(Goal(
            id: goalID, taskID: taskID, objective: "p14_5 handoff",
            acceptanceCriteria: [
                AcceptanceCriterion(criterionID: "c1",
                                    kind: .runtimeInvariant,
                                    description: "provider invocation succeeded",
                                    satisfied: false)
            ]))
        await lifecycle.start()

        // === Provider invocation #1 — REAL production path ===
        let userMessage = UserMessageEvent(
            conversationID: conversationID,
            messageID: UUID(),
            text: "p14_5 handoff step1",
            conversationClass: .normal,
            taskIDOverride: taskID
        )
        for await _ in coordinator.handle(PetAgentEvent.userMessage(userMessage)) {
            // drain
        }

        // === Assertions — NO manual state mutation in the test ===
        let physicalInvocations = await conversation.physicalInvocationCount
        let record = await taskStore.task(id: taskID)
        let schedulerCount = await scheduler.registeredCount()
        let snapshot = await scheduler.snapshot()
        let events = await audit.readAll()
        let scheduled = events.filter { $0.kind == .retryScheduled && $0.correlationID == taskID }

        XCTAssertEqual(physicalInvocations, 1,
                       "Real provider MUST have been invoked once (typed 429 emitted)")
        XCTAssertNotNil(record, "Production MUST have created a durable record")
        XCTAssertEqual(record?.status, .waitingForRetry,
                       "Production converse() catch MUST have transitioned to .waitingForRetry (not .failed)")
        XCTAssertNotNil(record?.nextRetryAt,
                        "Production MUST have persisted a nextRetryAt")
        XCTAssertEqual(record?.lastFailure?.llmFailureCode, "rateLimited",
                       "Typed LlmFailure code MUST be persisted (INV-RH-01)")
        XCTAssertEqual(schedulerCount, 1,
                       "Production MUST have registered exactly one wakeup in the scheduler")
        XCTAssertTrue(snapshot.contains(where: { $0.taskID == taskID }),
                      "Scheduler MUST hold a wakeup for the original taskID")
        XCTAssertEqual(scheduled.count, 1,
                       "Production MUST emit exactly one .retryScheduled audit event")
        XCTAssertEqual(record?.taskID, taskID, "TaskID preserved (INV-RH-05)")

        await lifecycle.stop()
    }

    // MARK: - Test 2: Live Retry E2E (production scheduler)

    /// P14.5 §37 / §16 — production scheduler drives retry without
    /// restart, without test calling business retry logic directly.
    func testProductionRateLimitAutomaticallyRetriesWithoutRestart() async throws {
        let taskID = UUID()
        let goalID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = CountingRateLimitConversation(retryAfterMs: 60_000)

        let initialTime = Date(timeIntervalSince1970: 20_000_000)
        let clock = P14_5TestClock(initial: initialTime)
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)
        await goalStore.upsert(Goal(
            id: goalID, taskID: taskID, objective: "p14_5 live",
            acceptanceCriteria: [
                AcceptanceCriterion(criterionID: "c1",
                                    kind: .runtimeInvariant,
                                    description: "ok", satisfied: false)
            ]))
        await lifecycle.start()

        // Provider #1 → 429 → .waitingForRetry (auto via converse()).
        let userMessage = UserMessageEvent(
            conversationID: UUID(), messageID: UUID(),
            text: "p14_5 live step1",
            conversationClass: .normal, taskIDOverride: taskID)
        for await _ in coordinator.handle(PetAgentEvent.userMessage(userMessage)) {
            // drain
        }
        let invocationsAfterStep1 = await conversation.physicalInvocationCount
        let statusAfterStep1 = await taskStore.task(id: taskID)?.status

        XCTAssertEqual(invocationsAfterStep1, 1,
                       "step1: provider invoked once → 429")
        XCTAssertEqual(statusAfterStep1, .waitingForRetry,
                       "step1: task is .waitingForRetry (production auto-transitioned)")

        // Advance production clock to T+30 — BEFORE deadline.
        clock.set(initialTime.addingTimeInterval(30))
        try await Task.sleep(nanoseconds: 250_000_000)
        let invocationsBeforeDeadline = await conversation.physicalInvocationCount
        XCTAssertEqual(invocationsBeforeDeadline, 1,
                       "Live wakeup before deadline MUST NOT invoke provider")

        // Advance production clock to T+61 — AFTER deadline.
        clock.set(initialTime.addingTimeInterval(61))
        try await Task.sleep(nanoseconds: 1_500_000_000)

        let invocationsAfter = await conversation.physicalInvocationCount
        XCTAssertEqual(invocationsAfter, 2,
                       "After deadline: production scheduler MUST have invoked provider (provider #2)")

        // Re-fire scheduler: no duplicate provider invocation.
        try await Task.sleep(nanoseconds: 500_000_000)
        let invocationsStable = await conversation.physicalInvocationCount
        XCTAssertEqual(invocationsStable, 2,
                       "After #2: scheduler MUST NOT duplicate provider invocation")

        let record = await taskStore.task(id: taskID)
        XCTAssertNotNil(record, "Task record preserved across retry")
        let attempts = await taskStore.attempts(forTask: taskID)
        XCTAssertEqual(attempts.count, 2,
                       "Exactly 2 attempts (initial + 1 retry), not duplicated")

        _ = scheduler; _ = record
        await lifecycle.stop()
    }

    // MARK: - Test 3: Restart Retry E2E (no manual state)

    /// P14.5 §38 — Runtime A → typed retry handoff → destroy → Runtime B
    /// startup → scheduler → provider #2.
    ///
    /// Runtime B shares the SAME durable root as Runtime A so the
    /// persisted `.waitingForRetry` record (and `nextRetryAt`) is
    /// observable on restart — exactly like production restart.
    func testRestartRetry_NoManualState_RealProviderFlow() async throws {
        let taskID = UUID()
        let goalID = UUID()
        let conversationID = UUID()
        let originalNow = Date(timeIntervalSince1970: 30_000_000)

        // SHARED durable root across Runtime A and Runtime B.
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        await goalStore.upsert(Goal(
            id: goalID, taskID: taskID, objective: "p14_5 restart",
            acceptanceCriteria: [
                AcceptanceCriterion(criterionID: "c1",
                                    kind: .runtimeInvariant,
                                    description: "ok", satisfied: false)
            ]))

        // === Runtime A ===
        let conversationA = CountingRateLimitConversation(retryAfterMs: 60_000)
        let clockA = P14_5TestClock(initial: originalNow)
        let (coordinatorA, lifecycleA, _) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversationA, clock: clockA)
        await lifecycleA.start()

        let userMessage = UserMessageEvent(
            conversationID: conversationID, messageID: UUID(),
            text: "p14_5 restart step1",
            conversationClass: .normal, taskIDOverride: taskID)
        for await _ in coordinatorA.handle(PetAgentEvent.userMessage(userMessage)) {
            // drain
        }
        let runtimeAInvocations = await conversationA.physicalInvocationCount
        XCTAssertEqual(runtimeAInvocations, 1,
                       "Runtime A: provider invoked once")

        let recordAfterFailure = await taskStore.task(id: taskID)
        XCTAssertEqual(recordAfterFailure?.status, .waitingForRetry,
                       "Runtime A: production auto-transitioned to .waitingForRetry")
        let nextRetryAt = recordAfterFailure?.nextRetryAt
        XCTAssertNotNil(nextRetryAt,
                        "Runtime A: production persisted nextRetryAt")

        await lifecycleA.stop()

        // === Runtime B ===
        // Re-open the same durable root (Runtime B's actor wraps a
        // fresh in-memory cache, but reads persisted records on
        // `load()`). This mirrors production restart.
        let taskStoreB = await reopenTaskStore()
        let goalStoreB = await reopenGoalStore()
        let inboxB = await reopenInbox()
        let auditB = reopenAudit()

        let conversationB = CountingRateLimitConversation(retryAfterMs: 60_000)
        let clockB = P14_5TestClock(initial: originalNow)
        let (_, lifecycleB, _) = await makeCoordinator(
            taskStore: taskStoreB, goalStore: goalStoreB, inbox: inboxB, audit: auditB,
            conversation: conversationB, clock: clockB)

        clockB.set(nextRetryAt!.addingTimeInterval(1.0))
        await lifecycleB.start()

        try await Task.sleep(nanoseconds: 2_000_000_000)

        let invocationsB = await conversationB.physicalInvocationCount
        let recordAfterB = await taskStoreB.task(id: taskID)
        let eventsB = await auditB.readAll()

        XCTAssertEqual(invocationsB, 1,
                       "Runtime B: provider invoked exactly once after restart")
        let totalInvocations = runtimeAInvocations + invocationsB
        XCTAssertEqual(totalInvocations, 2,
                       "Combined Runtime A + Runtime B invocation count = 2 (real retry)")

        XCTAssertNotEqual(recordAfterB?.status, .waitingForRetry,
                          "Runtime B: task is no longer .waitingForRetry (advanced past retry state). audit events: \(eventsB.count), retryResumed: \(eventsB.filter { $0.kind == .retryResumed }.count)")

        await lifecycleB.stop()
        _ = audit; _ = auditB
    }
}
