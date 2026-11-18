import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.5 — Retry race / cancellation / non-retryable tests.
///
/// Per §20-21:
///   INV-RACE-01: cancel before deadline → no provider #2
///   INV-RACE-02: cancel concurrent with retry wakeup → cancel wins
///   INV-RACE-05: terminal task + stale wakeup → no execution
///   INV-RH-04:    non-retryable failure stays `.failed`
///
/// These tests are PRODUCTION-WIRED — they exercise the converse()
/// catch block's retry routing logic, not the scheduler's primitive
/// directly. The scheduler's primitive-level races (WAKE-01..05) are
/// already proven by P14.4 `P14_4LiveRetryWakeupRaceTests`.

@MainActor
final class P14_5RetryRaceAndCancellationTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_5-RACE-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Fixtures

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

    /// 429 on #1, success on subsequent invocations.
    actor RateLimitConversation: ConversationGenerating {
        private(set) var physicalInvocationCount: Int = 0
        let retryAfterMs: Int
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
                let failure = LlmFailure(code: .rateLimited, message: "rl",
                                          httpStatus: 429, providerRetryAfterMs: retryAfterMs)
                continuation.yield(.typedError(failure))
                continuation.finish(throwing: ConversationGenerationError(message: failure.message))
            } else {
                continuation.yield(.metadata(.nonStreaming))
                continuation.yield(.delta(sequence: 1, text: "retry ok"))
                continuation.yield(.completed(emotion: .neutral, viaCloud: false))
                continuation.finish()
            }
        }
    }

    /// Authentication-failed conversation — NEVER retryable per
    /// `AgentRetryPolicy.shouldRetry(.authenticationFailed)` →
    /// `return false`.
    actor AuthFailConversation: ConversationGenerating {
        private(set) var physicalInvocationCount: Int = 0
        nonisolated func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
            return AsyncThrowingStream { continuation in
                Task { await self.handleInvocation(continuation: continuation) }
            }
        }
        private func handleInvocation(
            continuation: AsyncThrowingStream<ConversationChunk, Error>.Continuation
        ) async {
            physicalInvocationCount += 1
            let failure = LlmFailure(code: .authenticationFailed, message: "bad token",
                                      httpStatus: 401, providerRetryAfterMs: nil)
            continuation.yield(.typedError(failure))
            continuation.finish(throwing: ConversationGenerationError(message: failure.message))
        }
    }

    /// Production-style fixture that NEVER throws — succeeds every
    /// invocation. Used by the cancel tests where we want provider
    /// invocation to be deterministic.
    actor SuccessConversation: ConversationGenerating {
        private(set) var physicalInvocationCount: Int = 0
        nonisolated func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
            return AsyncThrowingStream { continuation in
                Task { await self.handleInvocation(continuation: continuation) }
            }
        }
        private func handleInvocation(
            continuation: AsyncThrowingStream<ConversationChunk, Error>.Continuation
        ) async {
            physicalInvocationCount += 1
            continuation.yield(.metadata(.nonStreaming))
            continuation.yield(.delta(sequence: 1, text: "ok"))
            continuation.yield(.completed(emotion: .neutral, viaCloud: false))
            continuation.finish()
        }
    }

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

    private func makeCoordinator(
        taskStore: DurableTaskStore,
        goalStore: GoalStore,
        inbox: DurableInboxStore,
        audit: DurableAuditLogStore,
        conversation: ConversationGenerating,
        clock: P14_5TestClock,
        maxAttempts: Int = 3
    ) async -> (PetAgentRuntimeCoordinator, RuntimeLifecycleController, RuntimeRetryScheduler) {
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
            retryPolicy: AgentRetryPolicy(maxAttempts: maxAttempts, baseDelay: 1, exponentialBackoff: false),
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

    // MARK: - INV-RACE-01: Cancel before retry deadline → no provider #2

    func testCancelBeforeRetryDeadlinePreventsProviderInvocation() async throws {
        let taskID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = RateLimitConversation(retryAfterMs: 60_000)
        let clock = P14_5TestClock(initial: Date(timeIntervalSince1970: 50_000_000))
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)
        await lifecycle.start()

        // Step1: provider 429 → .waitingForRetry (production auto).
        for await _ in coordinator.handle(PetAgentEvent.userMessage(
            UserMessageEvent(conversationID: UUID(), messageID: UUID(),
                              text: "step1", conversationClass: .normal,
                              taskIDOverride: taskID))) {
            // drain
        }
        let invocationsAfterStep1 = await conversation.physicalInvocationCount
        let statusAfterStep1 = await taskStore.task(id: taskID)?.status
        XCTAssertEqual(invocationsAfterStep1, 1)
        XCTAssertEqual(statusAfterStep1, .waitingForRetry)

        // Cancel the task BEFORE the deadline elapses.
        await coordinator.cancel(taskID: taskID)
        let cancelledRecord = await taskStore.task(id: taskID)
        XCTAssertEqual(cancelledRecord?.status, .cancelled,
                       "Cancel must terminalize the task to .cancelled")

        // Advance clock past the deadline.
        clock.set(clock.now().addingTimeInterval(120))
        try await Task.sleep(nanoseconds: 1_500_000_000)

        // No provider #2 — the scheduler either skips (terminal state)
        // or the wakeup fires but `driveSingleRetry` bails.
        let invocations = await conversation.physicalInvocationCount
        XCTAssertEqual(invocations, 1,
                       "Cancel before deadline MUST prevent provider #2")

        await lifecycle.stop()
    }

    // MARK: - INV-RACE-02: Cancel concurrent with retry wakeup

    func testCancelVsRetryDeadlineCannotResurrectTask() async throws {
        let taskID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = RateLimitConversation(retryAfterMs: 60_000)
        let clock = P14_5TestClock(initial: Date(timeIntervalSince1970: 60_000_000))
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)
        await lifecycle.start()

        // Step1: provider 429 → .waitingForRetry.
        for await _ in coordinator.handle(PetAgentEvent.userMessage(
            UserMessageEvent(conversationID: UUID(), messageID: UUID(),
                              text: "step1", conversationClass: .normal,
                              taskIDOverride: taskID))) {
            // drain
        }
        let statusRace02 = await taskStore.task(id: taskID)?.status
        XCTAssertEqual(statusRace02, .waitingForRetry)

        // Advance past deadline + cancel concurrently.
        clock.set(clock.now().addingTimeInterval(61))
        async let cancel: Void = coordinator.cancel(taskID: taskID)
        try await Task.sleep(nanoseconds: 200_000_000)
        _ = await cancel
        try await Task.sleep(nanoseconds: 1_500_000_000)

        // Final state is `.cancelled` (cancel won terminalization).
        let final = await taskStore.task(id: taskID)?.status
        XCTAssertEqual(final, .cancelled,
                       "Cancel concurrent with deadline: cancel MUST win terminalization")

        await lifecycle.stop()
    }

    // MARK: - INV-RACE-05: Terminal task + stale wakeup → no execution

    func testTerminalTaskIgnoresStaleRetryWakeup() async throws {
        let taskID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = SuccessConversation()
        let clock = P14_5TestClock(initial: Date(timeIntervalSince1970: 70_000_000))
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)
        await lifecycle.start()

        // Manually seed a `.waitingForRetry` record (to get a wakeup
        // registered) — this is a TEST setup, not a production retry.
        await taskStore.upsert(DurableTaskRecord(
            taskID: taskID, title: "race05", status: .waitingForRetry,
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: clock.now().addingTimeInterval(60)))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())
        await scheduler.registerWakeup(taskID: taskID, deadline: clock.now().addingTimeInterval(60))

        // Cancel the task so it becomes terminal BEFORE the deadline.
        await coordinator.cancel(taskID: taskID)
        let afterCancel = await taskStore.task(id: taskID)?.status
        XCTAssertEqual(afterCancel, .cancelled)

        // Advance clock past deadline and let driver tick.
        clock.set(clock.now().addingTimeInterval(120))
        try await Task.sleep(nanoseconds: 1_500_000_000)

        let invocations = await conversation.physicalInvocationCount
        XCTAssertEqual(invocations, 0,
                       "Terminal task + stale wakeup MUST NOT invoke provider")

        await lifecycle.stop()
    }

    // MARK: - INV-RH-04: Non-retryable failure stays .failed (not .waitingForRetry)

    func testNonRetryableFailureStaysFailed() async throws {
        let taskID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = AuthFailConversation()
        let clock = P14_5TestClock(initial: Date(timeIntervalSince1970: 80_000_000))
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)
        await lifecycle.start()

        for await _ in coordinator.handle(PetAgentEvent.userMessage(
            UserMessageEvent(conversationID: UUID(), messageID: UUID(),
                              text: "step1", conversationClass: .normal,
                              taskIDOverride: taskID))) {
            // drain
        }

        let record = await taskStore.task(id: taskID)
        let schedulerCount = await scheduler.registeredCount()

        XCTAssertEqual(record?.status, .failed,
                       "Authentication failure MUST result in .failed (not .waitingForRetry)")
        XCTAssertEqual(record?.lastFailure?.llmFailureCode, "authenticationFailed",
                       "Typed LlmFailure code MUST be persisted")
        XCTAssertEqual(schedulerCount, 0,
                       "Non-retryable failure MUST NOT register a wakeup")

        await lifecycle.stop()
    }

    // MARK: - Duplicate wakeup → one attempt (sanity check against P14.4)

    func testDuplicateRetryWakeupsCreateOneAttempt() async throws {
        let taskID = UUID()
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let conversation = SuccessConversation()
        let clock = P14_5TestClock(initial: Date(timeIntervalSince1970: 90_000_000))
        let (coordinator, lifecycle, scheduler) = await makeCoordinator(
            taskStore: taskStore, goalStore: goalStore, inbox: inbox, audit: audit,
            conversation: conversation, clock: clock)
        await lifecycle.start()

        // Register the same wakeup twice — the scheduler's
        // `registerWakeup` is idempotent on taskID (INV-WAKE-01).
        await scheduler.registerWakeup(taskID: taskID, deadline: clock.now().addingTimeInterval(60))
        await scheduler.registerWakeup(taskID: taskID, deadline: clock.now().addingTimeInterval(60))

        // Seed the durable `.waitingForRetry` record for the retry path.
        await taskStore.upsert(DurableTaskRecord(
            taskID: taskID, title: "r05", status: .waitingForRetry,
            retryPolicy: AgentRetryPolicy(maxAttempts: 3),
            nextRetryAt: clock.now().addingTimeInterval(60)))
        await taskStore.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        clock.set(clock.now().addingTimeInterval(61))
        try await Task.sleep(nanoseconds: 1_500_000_000)

        // Only ONE retry should have fired (not two).
        let attempts = await taskStore.attempts(forTask: taskID)
        XCTAssertEqual(attempts.count, 2,
                       "Duplicate wakeups MUST create exactly one retry attempt")

        await lifecycle.stop()
    }
}
