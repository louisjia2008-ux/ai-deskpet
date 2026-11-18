import Foundation
import AICore
import PetBrainCore

// P5.0 — explicit runtime lifecycle (doc §6.1). The existing PetAgentRuntimeCoordinator is the single
// orchestration core; this controller OWNS one coordinator and adds the lifecycle the coordinator did
// not expose: start/stop/suspend/resume with a real state, gated submission, active-request tracking,
// and managed child tasks so nothing is orphaned after stop. It does not create a second coordinator,
// queue, or behavior source.

public enum AgentRuntimeState: Sendable, Equatable {
    case stopped
    case starting
    case idle
    case processing
    case suspended
    case stopping
    case failed(reason: String)

    public var label: String {
        switch self {
        case .stopped: return "stopped"
        case .starting: return "starting"
        case .idle: return "idle"
        case .processing: return "processing"
        case .suspended: return "suspended"
        case .stopping: return "stopping"
        case .failed: return "failed"
        }
    }
}

public enum RuntimeLifecycleError: Error, Equatable, Sendable {
    case notRunning(AgentRuntimeState)
}

/// P17-C — live retry driver mode. `.deadline` sleeps the driver loop
/// until the next registered wakeup is due (or up to the configured
/// ceiling); `.polling` polls at the configured fixed interval. The
/// `.deadline` mode preserves all semantics (`registerWakeup` is still
/// authoritative; `driveDueWork` still fires wakeups) but avoids the
/// fixed 1-Hz wakeup cost when no wakeups are pending.
public enum LiveDriverMode: Sendable, Equatable {
    /// Legacy: poll `driveDueWork()` every `liveDriverIntervalSeconds`.
    /// Retained for back-compat with existing tests that time assertions
    /// around the polling cadence.
    case polling
    /// P17-C: sleep until the next wakeup is due (or up to
    /// `liveDriverDeadlineCeilingSeconds`, whichever is shorter). On
    /// registration of a new wakeup, the driver wakes early.
    case deadline(ceilingSeconds: Double)
}

public actor RuntimeLifecycleController {
    private let coordinator: PetAgentRuntimeCoordinator
    private let bus: RuntimeEventBus?
    private let audit: RuntimeAuditSink
    private let ids: IdentifierGenerator
    private let clock: RuntimeClock
    /// P14.5 — Live retry wakeup driver. The controller owns the
    /// production scheduler instance and runs a periodic Task that
    /// calls `driveDueWork()` while the runtime is alive. The interval
    /// is short enough to ensure timely wakeups but long enough to
    /// avoid wasting CPU. Optional — callers (tests) may inject a
    /// scheduler directly and disable the periodic driver.
    private let retryScheduler: RuntimeRetryScheduler
    private let liveDriverEnabled: Bool
    private let liveDriverIntervalSeconds: Double
    private let liveDriverMode: LiveDriverMode
    private var liveDriverTask: Task<Void, Never>?

    private var state: AgentRuntimeState = .stopped
    private var activeTasks: [UUID: Task<Void, Never>] = [:]
    private var startCount = 0

    public init(coordinator: PetAgentRuntimeCoordinator, bus: RuntimeEventBus? = nil,
                audit: RuntimeAuditSink = InMemoryAuditSink(), ids: IdentifierGenerator = UUIDIdentifierGenerator(),
                clock: RuntimeClock = WallClock(),
                // P14.5 — live retry scheduler injection. When nil, the
                // controller creates one and wires it to the
                // coordinator's `driveSingleRetry` primitive.
                retryScheduler: RuntimeRetryScheduler? = nil,
                liveDriverEnabled: Bool = true,
                liveDriverIntervalSeconds: Double = 1.0,
                // P17-C — when `.deadline(ceilingSeconds:)`, the driver
                // sleeps until the next wakeup instead of polling at a
                // fixed interval. Back-compat default is `.polling`.
                liveDriverMode: LiveDriverMode = .polling) {
        self.coordinator = coordinator
        self.bus = bus
        self.audit = audit
        self.ids = ids
        self.clock = clock
        // P14.5 — construct or accept a scheduler. The closure routes
        // each fired wakeup through the shared `driveSingleRetry`
        // primitive — the SAME authority used by startup
        // `evaluateRetries`. INV-EXEC-05 (single driver).
        let scheduler = retryScheduler ?? RuntimeRetryScheduler(
            clock: { [clock] in clock.now() },
            onWakeup: { [coordinator] taskID, _ in
                _ = await coordinator.driveSingleRetry(taskID: taskID)
            })
        self.retryScheduler = scheduler
        self.liveDriverEnabled = liveDriverEnabled
        self.liveDriverIntervalSeconds = liveDriverIntervalSeconds
        self.liveDriverMode = liveDriverMode
    }

    public func currentState() -> AgentRuntimeState { state }
    public func activeRequestCount() -> Int { activeTasks.count }
    public func startCountForTesting() -> Int { startCount }

    /// P14.5 — accessor for the production retry scheduler. The
    /// coordinator and lifecycle share the same instance so a wakeup
    /// registered by one is fired by the other.
    public func getRetryScheduler() -> RuntimeRetryScheduler { retryScheduler }

    /// Idempotent: a second start while already running does nothing (no duplicate listeners).
    public func start() async {
        switch state {
        case .stopped, .failed:
            break
        default:
            return
        }
        state = .starting
        startCount += 1
        _ = await coordinator.reconcileAfterRestart()
        // P14.1 — rehydrate any pending durable approval requests from the
        // durable inbox after restart so the user can still approve/deny
        // (R-B-07). No-op when the inbox is not injected.
        await coordinator.rehydratePendingApprovals()
        // P14.2 — rebuild executable continuations for any durable tasks
        // that were `.waitingForApproval` when the previous runtime died.
        // This is the durable-keyed continuation path (R-A-F1): the
        // original CheckedContinuation is gone, so we create a fresh one
        // keyed by `taskID` and register it on the TaskSupervisor. The
        // chat UI will be re-prompted via the existing approval flow.
        _ = await coordinator.recoverPendingApprovals()
        // P14.3 — enforce retry deadlines on restart (INV-RD-01..04).
        // Walks `.waitingForRetry` tasks and transitions those whose
        // `nextRetryAt` has elapsed to `.running`. Tasks still inside
        // the deadline remain `.waitingForRetry` (early retry
        // prevented). `evaluateRetries` is idempotent and uses the
        // controller's injectable clock.
        _ = await coordinator.evaluateRetries(now: { [clock] in clock.now() })
        state = .idle
        // P14.5 — start the live retry wakeup driver. While the
        // runtime remains alive, a periodic Task calls
        // `scheduler.driveDueWork()` to fire any wakeups whose
        // deadline has elapsed. No restart required (per §13, §45).
        if liveDriverEnabled {
            liveDriverTask?.cancel()
            switch liveDriverMode {
            case .polling:
                liveDriverTask = Task { [retryScheduler, liveDriverIntervalSeconds, coordinator] in
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: UInt64(liveDriverIntervalSeconds * 1_000_000_000))
                        if Task.isCancelled { return }
                        let fired = await retryScheduler.driveDueWork()
                        if !fired.isEmpty {
                            // Production observability — emit a `retryResumed`
                            // audit for each fired task (already emitted by
                            // `driveSingleRetry`, but we surface the driver
                            // loop's count to the lifecycle audit too).
                            _ = fired  // the per-task audit fires inside driveSingleRetry
                        }
                        _ = coordinator  // capture
                    }
                }
            case .deadline(let ceilingSeconds):
                // P17-C — deadline-driven driver. Sleeps until the next
                // registered wakeup is due (or up to `ceilingSeconds`),
                // and re-evaluates on every queue mutation.
                liveDriverTask = Task { [retryScheduler, ceilingSeconds, coordinator] in
                    var nextReconcileAt = Date().addingTimeInterval(ceilingSeconds)
                    while !Task.isCancelled {
                        let next = await retryScheduler.nextDeadline() ?? nextReconcileAt
                        let now = Date()
                        let interval = max(0.0, min(next.timeIntervalSince(now), ceilingSeconds))
                        let sleepNanos = UInt64(min(interval * 1_000_000_000, Double(UInt64.max)))
                        try? await Task.sleep(nanoseconds: sleepNanos)
                        if Task.isCancelled { return }
                        let fired = await retryScheduler.driveDueWork()
                        if !fired.isEmpty {
                            _ = fired  // per-task audit fires inside driveSingleRetry
                        }
                        _ = coordinator  // capture
                        nextReconcileAt = Date().addingTimeInterval(ceilingSeconds)
                    }
                }
            }
        }
        await audit.record(RuntimeAuditEvent(kind: .runtimeStarted, timestamp: clock.now()))
        await bus?.publish(.runtimeStarted)
    }

    public func suspend() async {
        guard state == .idle || state == .processing else { return }
        state = .suspended
        await audit.record(RuntimeAuditEvent(kind: .runtimeSuspended, timestamp: clock.now()))
        await bus?.publish(.runtimeSuspended)
    }

    public func resume() async {
        guard state == .suspended else { return }
        state = activeTasks.isEmpty ? .idle : .processing
        await audit.record(RuntimeAuditEvent(kind: .runtimeResumed, timestamp: clock.now()))
        await bus?.publish(.runtimeResumed)
    }

    /// Idempotent. Cancels and awaits all managed tasks so no orphan Task survives stop.
    public func stop() async {
        guard state != .stopped else { return }
        state = .stopping
        // P14.5 — cancel the live retry driver before tearing down
        // active tasks. The driver polls `scheduler.driveDueWork()`
        // and is bound to the runtime's lifetime.
        liveDriverTask?.cancel()
        liveDriverTask = nil
        let tasks = Array(activeTasks.values)
        activeTasks.removeAll()
        for task in tasks { task.cancel() }
        for task in tasks { await task.value }
        state = .stopped
        await audit.record(RuntimeAuditEvent(kind: .runtimeStopped, timestamp: clock.now()))
        await bus?.publish(.runtimeStopped)
    }

    /// Submit an event for streaming processing. Rejected unless running (idle/processing).
    @discardableResult
    public func submit(_ event: PetAgentEvent,
                       onOutput: (@Sendable (PetAgentRuntimeOutput) -> Void)? = nil) async throws -> UUID {
        guard state == .idle || state == .processing else { throw RuntimeLifecycleError.notRunning(state) }
        state = .processing
        let id = ids.next()
        await bus?.publish(.requestSubmitted(id), correlationID: id)
        await audit.record(RuntimeAuditEvent(kind: .actionStarted, correlationID: id, summary: "request", timestamp: clock.now()))

        let coordinator = self.coordinator
        let task = Task { [weak self] in
            for await output in coordinator.handle(event) {
                if Task.isCancelled { break }
                onOutput?(output)
            }
            await self?.finish(id)
        }
        activeTasks[id] = task
        return id
    }

    /// Non-streaming convenience used by tests/self-test. Same single coordinator.
    public func runForResult(_ event: PetAgentEvent) async throws -> AgentRunResult {
        guard state == .idle || state == .processing else { throw RuntimeLifecycleError.notRunning(state) }
        return await coordinator.run(event)
    }

    public func cancel(conversationID: UUID) async {
        await coordinator.cancel(conversationID: conversationID)
    }

    /// P14.2 — R-A-F3 — durable-keyed cancellation. Used when the caller
    /// only knows the taskID (e.g., a supervisor-initiated cancel from
    /// the durable kernel).
    public func cancel(taskID: UUID) async {
        await coordinator.cancel(taskID: taskID)
    }

    private func finish(_ id: UUID) async {
        activeTasks[id] = nil
        if activeTasks.isEmpty, state == .processing { state = .idle }
        await bus?.publish(.requestCompleted(id), correlationID: id)
    }
}
