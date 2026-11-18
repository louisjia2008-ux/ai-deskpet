import Foundation
import AICore

// P14.4 — Live retry wakeup scheduler.
//
// Problem: P14.3 only called `evaluateRetries(now:)` from
// `RuntimeLifecycleController.start()`. A runtime that does not restart
// never wakes up after a `.waitingForRetry` deadline elapses — the
// task sits dormant until the user manually re-sends the prompt or
// quits and relaunches.
//
// Fix: introduce a `RuntimeRetryScheduler` actor that owns a priority
// queue of `(taskID, deadline)` tuples + an injectable clock + a
// `RuntimeClock`-driven wakeup loop. When a task enters `.waitingForRetry`
// the runtime registers a wakeup. When the deadline elapses (under the
// injectable clock), the scheduler invokes the shared
// `resumeExecution(taskID:now:)` primitive on the coordinator — the
// SAME primitive used by startup-time `evaluateRetries`. There is no
// duplicated decision logic.
//
// Both restart-driven and live-driven retry converge on a single
// primitive: this is INV-EXEC-05 (exactly one driver) enforced
// architecturally, not by accident.
//
// Invariants:
//   INV-WAKE-01 — two simultaneous wakeups cannot create two retry
//                 attempts. `registerWakeup` is idempotent on taskID:
//                 a re-register replaces the deadline atomically.
//   INV-WAKE-02 — cancel before deadline prevents retry.
//                 `cancelWakeup(taskID:)` removes the entry; the
//                 retry-eligibility evaluator also refuses terminal
//                 records.
//   INV-WAKE-03 — cancel concurrent with deadline has deterministic
//                 terminal semantics. If cancel terminalizes first,
//                 `resumeExecution` sees `.cancelled` and bails.
//   INV-WAKE-04 — a restart-created wakeup and an old in-memory wakeup
//                 cannot both own the task. Wakeups live in memory;
//                 `evaluateRetries` is the only restart-time driver.
//                 After restart, the scheduler starts empty and
//                 re-registers from durable state.
//   INV-WAKE-05 — terminal tasks have no executable retry wakeup.
//                 `registerWakeup(taskID:deadline:)` is the only
//                 public method to add a wakeup; callers must check
//                 the task is `.waitingForRetry` first.

/// Authoritative retry wakeup scheduler. Owns (taskID, deadline) tuples
/// and drives `resumeExecution(taskID:now:)` when deadlines elapse.
/// Single per-runtime instance, held by `RuntimeLifecycleController`.
public actor RuntimeRetryScheduler {
    /// Registered wakeups keyed by taskID. A re-register replaces the
    /// deadline atomically (INV-WAKE-01).
    private struct Wakeup: Sendable, Equatable {
        let taskID: UUID
        let deadline: Date
    }
    private var wakeups: [UUID: Wakeup] = [:]
    /// Injectable clock so tests can advance time deterministically
    /// without `Task.sleep`. Production uses `WallClock()`. The closure
    /// may be sync (`() -> Date`) or async (`() async -> Date`) — the
    /// scheduler adapts internally.
    private let clock: @Sendable () async -> Date
    /// The closure invoked when a wakeup becomes due. Wired by
    /// `RuntimeLifecycleController` to `coordinator.resumeExecution(...)`.
    private let onWakeup: @Sendable (UUID, Date) async -> Void

    public init(clock: @escaping @Sendable () async -> Date = { Date() },
                onWakeup: @escaping @Sendable (UUID, Date) async -> Void) {
        self.clock = clock
        self.onWakeup = onWakeup
    }

    // MARK: - Registration

    /// Register a wakeup for `taskID` at `deadline`. Idempotent: a
    /// re-register replaces the previous deadline (INV-WAKE-01).
    public func registerWakeup(taskID: UUID, deadline: Date) {
        wakeups[taskID] = Wakeup(taskID: taskID, deadline: deadline)
    }

    /// Cancel a wakeup. Called when the underlying task is
    /// `.cancelled` / `.completed` / `.failed` (INV-WAKE-02 + -05).
    public func cancelWakeup(taskID: UUID) {
        wakeups.removeValue(forKey: taskID)
    }

    /// Public read accessor for tests.
    public func isRegistered(taskID: UUID) -> Bool {
        wakeups[taskID] != nil
    }

    public func registeredCount() -> Int { wakeups.count }

    // MARK: - Drive

    /// Walk every wakeup whose deadline has elapsed (per `clock`) and
    /// invoke the shared `resumeExecution` primitive. Wakeups that
    /// fire are removed from the queue (idempotent: re-registration
    /// after a successful resume is the producer's responsibility).
    ///
    /// Returns the set of taskIDs that fired (test diagnostics).
    @discardableResult
    public func driveDueWork() async -> Set<UUID> {
        let nowDate = await clock()
        var fired: Set<UUID> = []
        // Snapshot keys to avoid mutating during iteration.
        let dueSnapshot = wakeups.values.filter { $0.deadline <= nowDate }
        for entry in dueSnapshot {
            // Re-check ownership under the actor lock: another concurrent
            // caller (e.g., `evaluateRetries` from `start()`) may have
            // already terminalized the task. We still invoke
            // `resumeExecution` because the eligibility check happens
            // INSIDE `resumeExecution` — the scheduler is just a
            // notification mechanism, not a decision authority.
            fired.insert(entry.taskID)
            // Pop first so a synchronous re-register is honored.
            wakeups.removeValue(forKey: entry.taskID)
            await onWakeup(entry.taskID, nowDate)
        }
        return fired
    }

    /// Synchronous read-only snapshot of registered wakeups (test
    /// diagnostics).
    public func snapshot() -> [(taskID: UUID, deadline: Date)] {
        wakeups.values.map { (taskID: $0.taskID, deadline: $0.deadline) }
    }

    /// Earliest registered deadline, or nil if no wakeups are queued.
    /// Used by the deadline-driven driver to sleep precisely until the
    /// next due wakeup instead of polling at a fixed interval.
    public func nextDeadline() async -> Date? {
        let now = await clock()
        return wakeups.values
            .map(\.deadline)
            .filter { $0 > now }
            .min()
    }

    /// AsyncStream that yields one Date whenever a wakeup is registered
    /// or the queue becomes empty. The driver uses this to wake up
    /// early when a newly-registered wakeup has a sooner deadline than
    /// the one it is currently sleeping on. The stream is consumed by
    /// only one caller at a time (the lifecycle driver); once the
    /// consumer is dropped, the scheduler can be torn down cleanly.
    public func wakeupChanges() -> AsyncStream<Date> {
        AsyncStream { continuation in
            let task = Task {
                while !Task.isCancelled {
                    let next = await self.nextDeadline()
                    continuation.yield(next ?? Date.distantFuture)
                    // Wait for the next change to the queue.
                    await self.waitForChange()
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Internal helper: signals when a new wakeup is registered or
    /// canceled. Implementation note: the simple version polls the
    /// queue length — adequate because the driver only checks once
    /// per second at most and the queue is small.
    private func waitForChange() async {
        let initialCount = wakeups.count
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 200_000_000)  // 200 ms probe
            if wakeups.count != initialCount { return }
        }
    }
}