import AppKit
import Foundation
import AICore

/// Drives scheduled tasks while the app runs (mirrors `FocusEngine`'s Timer pattern). All timing
/// decisions come from the pure `ScheduleCalculator`; this class only owns the Timer, persistence,
/// and the injected `runner` that actually executes a task through the agent. macOS reality: tasks
/// only fire while the app is alive; overdue ones are realigned on launch (one-shot catches up,
/// recurring snaps to the next future slot).
@MainActor
final class TaskScheduler: ObservableObject {
    @Published private(set) var tasks: [ScheduledTask] = []
    /// P18.6 — observable durable-persistence failure for scheduled-task writes.
    @Published private(set) var lastPersistenceError: String?
    /// P18.6 — non-nil when the scheduled-tasks file existed but could not be
    /// decoded and was quarantined at load, so a corrupt schedule is surfaced as
    /// recovery state rather than silently presented as "no scheduled tasks".
    @Published private(set) var loadCorruptionQuarantineURL: URL?

    private let store: ScheduledTaskStore
    private let now: () -> Date
    private var timer: Timer?
    private var firing = false
    private var sleepObservers: [NSObjectProtocol] = []
    private var suspendedForSleep = false

    /// Executes a fired task through the agent, returning a short result summary. Injected by the app.
    var runner: (ScheduledTask) async -> String = { _ in "" }

    init(store: ScheduledTaskStore = ScheduledTaskStore(), now: @escaping () -> Date = { Date() }) {
        self.store = store
        self.now = now
        let realigned = store.load().map { ScheduleCalculator.realignOnLaunch($0, now: now()) }
        self.tasks = realigned
        loadCorruptionQuarantineURL = store.lastLoadCorruptionURL
        // Realign-on-launch rewrite: surface a write failure but keep running with
        // the in-memory realigned set.
        do {
            try store.save(realigned)
        } catch {
            lastPersistenceError = SealedStore.describe(error, fallback: "定时任务保存失败")
        }
    }

    func start(interval: TimeInterval = 30) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        observeSleepWake()
        tick()   // immediate catch-up
    }

    func stop() {
        timer?.invalidate(); timer = nil
        for o in sleepObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        sleepObservers.removeAll()
        suspendedForSleep = false
    }

    /// Sleep: timers stop firing on their own while asleep, but on wake every
    /// overdue recurring task would fire once for a stale slot. Suspend the
    /// timer and realign on wake (recurring snaps forward without firing;
    /// one-shots keep catch-up-once) — mirrors OverlayWindowController.
    private func observeSleepWake() {
        guard sleepObservers.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        sleepObservers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil,
                                                 queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.suspendForSleep() }
        })
        sleepObservers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                 queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resumeAfterWake() }
        })
    }

    private func suspendForSleep() {
        timer?.invalidate(); timer = nil
        suspendedForSleep = true
    }

    func resumeAfterWake() {
        realignForWake()
        guard suspendedForSleep else { return }
        suspendedForSleep = false
        start()
    }

    /// Sync wake-realign without timer side effects (also the test seam):
    /// recurring snaps forward, one-shots stay due for catch-up-once.
    func realignForWake() {
        tasks = tasks.map { ScheduleCalculator.realignAfterWake($0, now: now()) }
        persist()
    }

    // MARK: CRUD (shared by the UI and the schedule.create tool)

    func add(_ task: ScheduledTask) { tasks.append(task); persist() }
    func update(_ task: ScheduledTask) { if let i = index(of: task.id) { tasks[i] = task; persist() } }
    func remove(_ id: UUID) { tasks.removeAll { $0.id == id }; persist() }
    func setEnabled(_ id: UUID, _ on: Bool) {
        guard let i = index(of: id) else { return }
        tasks[i].enabled = on
        if on, tasks[i].nextFireAt == nil { tasks[i].nextFireAt = tasks[i].schedule.nextFire(after: now()) }
        persist()
    }

    // MARK: Firing

    /// Timer entry: fire due tasks once, serially, non-overlapping (fire-and-forget).
    private func tick() {
        guard !firing, !ScheduleCalculator.due(tasks, at: now()).isEmpty else { return }
        firing = true
        Task { @MainActor in
            await fireDueNow()
            firing = false
        }
    }

    /// Awaitable core (also the test seam): runs every currently-due task once and recomputes it.
    func fireDueNow() async {
        for task in ScheduleCalculator.due(tasks, at: now()) {
            let result = await runner(task)
            guard let i = index(of: task.id) else { continue }
            var updated = ScheduleCalculator.recompute(tasks[i], firedAt: now())
            updated.lastResult = result
            tasks[i] = updated
        }
        persist()
    }

    private func index(of id: UUID) -> Int? { tasks.firstIndex { $0.id == id } }
    private func persist() {
        do {
            try store.save(tasks)
            lastPersistenceError = nil
        } catch {
            lastPersistenceError = SealedStore.describe(error, fallback: "定时任务保存失败")
        }
    }
}
