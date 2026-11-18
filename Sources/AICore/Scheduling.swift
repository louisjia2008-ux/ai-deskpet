import Foundation

// P5 — scheduled / recurring agent tasks. Pure value types + pure calculation here so all timing
// logic is unit-testable; the Timer-driven scheduler (app side) is a thin wrapper over these.

/// What an unattended scheduled run may do without a person present. `.notifyOnly` defers every P1+
/// effect to a confirmation prompt; `.preauthorized` lets the listed capabilities run unattended
/// (still never beyond the tier ceiling — the broker rejects permanently-denied ones first).
public enum ScheduledAutonomy: Sendable, Equatable, Codable {
    case notifyOnly
    case preauthorized(Set<String>)
}

/// When a task fires. Deliberately small (cron-lite); fuller cron/weekly is deferred.
public enum Schedule: Sendable, Equatable, Codable {
    case oneShot(Date)
    case everySeconds(Int)
    case dailyAt(hour: Int, minute: Int)

    public var isRecurring: Bool {
        switch self {
        case .oneShot: return false
        case .everySeconds, .dailyAt: return true
        }
    }

    /// Missed-fire policy for this schedule kind (see `MissedFirePolicy`).
    public var missedFirePolicy: MissedFirePolicy {
        switch self {
        case .oneShot: return .catchUpOnce
        case .everySeconds, .dailyAt: return .skipToNext
        }
    }

    /// The next fire strictly after `reference`, or nil if it can never fire again (a past one-shot).
    public func nextFire(after reference: Date, calendar: Calendar = .current) -> Date? {
        switch self {
        case .oneShot(let date):
            return date > reference ? date : nil
        case .everySeconds(let seconds):
            let step = max(1, seconds)
            return reference.addingTimeInterval(TimeInterval(step))
        case .dailyAt(let hour, let minute):
            var comps = DateComponents()
            comps.hour = min(max(hour, 0), 23)
            comps.minute = min(max(minute, 0), 59)
            comps.second = 0
            // `nextDate` returns the next match strictly after `reference`.
            return calendar.nextDate(after: reference, matching: comps,
                                     matchingPolicy: .nextTime, direction: .forward)
        }
    }
}

/// What happens to a fire that was missed while the app was asleep/quit.
/// One-shots catch up once (the intent is still valid); recurring tasks skip
/// the stale backlog and snap to the next future slot (we never replay).
public enum MissedFirePolicy: String, Sendable, Equatable, Codable {
    case catchUpOnce
    case skipToNext
}

public enum ScheduledTaskSource: String, Sendable, Equatable, Codable { case user, agent }

/// A persisted scheduled task: an instruction the agent runs when due, optionally repeating.
public struct ScheduledTask: Identifiable, Sendable, Equatable, Codable {
    public var id: UUID
    public var title: String
    public var prompt: String                 // the instruction fed to the agent when it fires
    public var schedule: Schedule
    public var autonomy: ScheduledAutonomy
    public var enabled: Bool
    public var source: ScheduledTaskSource
    public var createdAt: Date
    public var lastFiredAt: Date?
    public var nextFireAt: Date?
    public var lastResult: String?

    public init(id: UUID = UUID(), title: String, prompt: String, schedule: Schedule,
                autonomy: ScheduledAutonomy = .notifyOnly, enabled: Bool = true,
                source: ScheduledTaskSource = .user, createdAt: Date = Date(),
                lastFiredAt: Date? = nil, nextFireAt: Date? = nil, lastResult: String? = nil) {
        self.id = id; self.title = title; self.prompt = prompt; self.schedule = schedule
        self.autonomy = autonomy; self.enabled = enabled; self.source = source
        self.createdAt = createdAt; self.lastFiredAt = lastFiredAt
        self.nextFireAt = nextFireAt ?? schedule.nextFire(after: createdAt)
        self.lastResult = lastResult
    }
}

/// Pure scheduling decisions: which tasks are due, and how a task's next fire is recomputed. No
/// side effects, no Timer — the app-side `TaskScheduler` calls these with an injected clock.
public enum ScheduleCalculator {
    /// Enabled tasks whose nextFireAt has arrived (`<= now`).
    public static func due(_ tasks: [ScheduledTask], at now: Date) -> [ScheduledTask] {
        tasks.filter { task in
            guard task.enabled, let next = task.nextFireAt else { return false }
            return next <= now
        }
    }

    /// After a task fires at `firedAt`, update its bookkeeping: recurring → next future slot; one-shot
    /// → disabled (it cannot fire again). Returns a fresh value (caller persists it).
    public static func recompute(_ task: ScheduledTask, firedAt: Date,
                                 calendar: Calendar = .current) -> ScheduledTask {
        var updated = task
        updated.lastFiredAt = firedAt
        let next = task.schedule.nextFire(after: firedAt, calendar: calendar)
        updated.nextFireAt = next
        if next == nil { updated.enabled = false }      // exhausted one-shot
        return updated
    }

    /// On launch, realign a possibly-overdue task. One-shot still in the future keeps its time; an
    /// overdue one-shot stays due (so it fires once on catch-up). Recurring tasks skip any missed
    /// backlog and snap to the next future slot — we never replay a recurring backlog.
    public static func realignOnLaunch(_ task: ScheduledTask, now: Date,
                                       calendar: Calendar = .current) -> ScheduledTask {
        guard task.enabled else { return task }
        var updated = task
        switch task.schedule {
        case .oneShot:
            // Keep nextFireAt as-is: future → waits; past → remains due → fires once on catch-up.
            if updated.nextFireAt == nil { updated.nextFireAt = task.schedule.nextFire(after: task.createdAt) }
        case .everySeconds, .dailyAt:
            if let next = updated.nextFireAt, next > now { break }     // already aligned to the future
            updated.nextFireAt = task.schedule.nextFire(after: now, calendar: calendar)
        }
        return updated
    }

    /// After wake from sleep: same policy as launch-realign. Recurring tasks snap
    /// forward WITHOUT firing for the stale slot (their intent is time-anchored);
    /// overdue one-shots stay due and fire once on the next tick. Pure — the
    /// app-side scheduler calls this before resuming its timer.
    public static func realignAfterWake(_ task: ScheduledTask, now: Date,
                                        calendar: Calendar = .current) -> ScheduledTask {
        realignOnLaunch(task, now: now, calendar: calendar)
    }
}
