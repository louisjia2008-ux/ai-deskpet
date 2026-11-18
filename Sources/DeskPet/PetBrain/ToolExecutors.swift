import Foundation
import AICore
import PetBrainCore
import PetAgentRuntime
#if canImport(EventKit)
import EventKit
#endif

// P2 — the real tool execution layer. The agentic loop's single `ToolExecuting` seam is split by
// capability: OS-bound capabilities (timer / reminders / calendar) run IN-PROCESS because EventKit
// needs the app's TCC identity; everything else stays in the isolated out-of-process runner. Neither
// executor ever sees the model, memory DB, or persona — only a granted step + token.

/// Capability → executor routing. Default in-process set = the OS-bound capabilities.
final class CompositeToolExecutor: ToolExecuting, @unchecked Sendable {
    static let defaultInProcessCapabilities: Set<String> = [
        "get_current_datetime",
        "timer.local",
        "reminder.local.create", "reminders.create",
        "calendar.event.create",
        "reminders.read", "calendar.events.read",
        "schedule.create",
    ]

    private let inProcess: ToolExecuting
    private let isolated: ToolExecuting
    private let inProcessCapabilities: Set<String>

    init(inProcess: ToolExecuting, isolated: ToolExecuting,
         inProcessCapabilities: Set<String> = CompositeToolExecutor.defaultInProcessCapabilities) {
        self.inProcess = inProcess
        self.isolated = isolated
        self.inProcessCapabilities = inProcessCapabilities
    }

    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        if inProcessCapabilities.contains(step.capabilityID) {
            return await inProcess.execute(step: step, token: token)
        }
        return await isolated.execute(step: step, token: token)
    }
}

// MARK: - EventKit seam (testable)

/// Short human-readable failure carried out of the EventKit seam.
struct ToolFailure: Error, Equatable { let message: String }

/// Minimal Sendable surface over EventKit so the in-process executor is unit-testable with a fake.
/// Each call returns either an identifier/summary or a short failure.
protocol EventKitAccess: Sendable {
    func createReminder(title: String, due: Date?, notes: String?) async -> Result<String, ToolFailure>
    func createCalendarEvent(title: String, start: Date, end: Date, notes: String?) async -> Result<String, ToolFailure>
    func readReminders(limit: Int) async -> Result<[String], ToolFailure>
    func readCalendarEvents(daysAhead: Int, limit: Int) async -> Result<[String], ToolFailure>
}

// MARK: - In-process executor

final class InProcessToolExecutor: ToolExecuting, @unchecked Sendable {
    private let eventKit: EventKitAccess
    private let clock: RuntimeClock
    private let timeZoneProvider: @Sendable () -> TimeZone
    /// Schedules a real timer that surfaces a reminder to the user (e.g. the pet speaks). Injected so
    /// the executor stays free of UI/app singletons and is testable.
    private let scheduleTimer: @Sendable (TimeInterval, String) -> Void
    /// Registers a recurring/one-shot scheduled task (P5). Agent-created tasks are always notifyOnly.
    private let scheduleCreate: @Sendable (ScheduledTask) async -> Bool

    init(eventKit: EventKitAccess,
         clock: RuntimeClock = WallClock(),
         timeZoneProvider: @escaping @Sendable () -> TimeZone = { .current },
         scheduleTimer: @escaping @Sendable (TimeInterval, String) -> Void,
         scheduleCreate: @escaping @Sendable (ScheduledTask) async -> Bool = { _ in false }) {
        self.eventKit = eventKit
        self.clock = clock
        self.timeZoneProvider = timeZoneProvider
        self.scheduleTimer = scheduleTimer
        self.scheduleCreate = scheduleCreate
    }

    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        // Token gate (defense in depth): in-process path must enforce the same
        // expiry + capability binding as the isolated runner. Expired or
        // cross-capability tokens fail closed before touching EventKit.
        guard Date() < token.expiresAt else {
            return ToolOutcome(ok: false, output: "", error: "token expired")
        }
        if let bound = token.capabilityID, bound != step.capabilityID {
            return ToolOutcome(ok: false, output: "", error: "token not bound to \(step.capabilityID)")
        }
        let p = step.params
        switch step.capabilityID {
        case "get_current_datetime":
            return Self.currentDateTimeOutcome(now: clock.now(), timeZone: timeZoneProvider())

        case "timer.local":
            guard let raw = p["durationSeconds"] ?? p["seconds"], let secs = Int(raw), secs > 0 else {
                return ToolOutcome(ok: false, output: "", error: "invalid durationSeconds")
            }
            let title = p["title"].flatMap { $0.isEmpty ? nil : $0 } ?? "时间到啦"
            scheduleTimer(TimeInterval(secs), title)
            return ToolOutcome(ok: true, output: "已设定 \(secs) 秒后提醒：\(title)")

        case "reminder.local.create", "reminders.create":
            guard let title = nonEmpty(p["title"]) else {
                return ToolOutcome(ok: false, output: "", error: "missing title")
            }
            let due = Self.parseDate(p["resolvedDate"])
            switch await eventKit.createReminder(title: title, due: due, notes: nonEmpty(p["notes"])) {
            case .success(let id): return ToolOutcome(ok: true, output: "已创建提醒「\(title)」 id=\(id)")
            case .failure(let e): return ToolOutcome(ok: false, output: "", error: e.message)
            }

        case "calendar.event.create":
            guard let title = nonEmpty(p["title"]) else {
                return ToolOutcome(ok: false, output: "", error: "missing title")
            }
            guard let start = Self.parseDate(p["startDate"]) else {
                return ToolOutcome(ok: false, output: "", error: "invalid startDate")
            }
            let end = Self.parseDate(p["endDate"]) ?? start.addingTimeInterval(3600)
            switch await eventKit.createCalendarEvent(title: title, start: start, end: end, notes: nonEmpty(p["notes"])) {
            case .success(let id): return ToolOutcome(ok: true, output: "已创建日程「\(title)」 id=\(id)")
            case .failure(let e): return ToolOutcome(ok: false, output: "", error: e.message)
            }

        case "reminders.read":
            switch await eventKit.readReminders(limit: 10) {
            case .success(let items):
                return ToolOutcome(ok: true, output: items.isEmpty ? "没有未完成的提醒" : items.joined(separator: "\n"))
            case .failure(let e): return ToolOutcome(ok: false, output: "", error: e.message)
            }

        case "calendar.events.read":
            switch await eventKit.readCalendarEvents(daysAhead: 7, limit: 10) {
            case .success(let items):
                return ToolOutcome(ok: true, output: items.isEmpty ? "未来七天没有日程" : items.joined(separator: "\n"))
            case .failure(let e): return ToolOutcome(ok: false, output: "", error: e.message)
            }

        case "schedule.create":
            guard let title = nonEmpty(p["title"]), let prompt = nonEmpty(p["prompt"]) else {
                return ToolOutcome(ok: false, output: "", error: "missing title or prompt")
            }
            guard let schedule = Self.parseSchedule(p) else {
                return ToolOutcome(ok: false, output: "", error: "invalid schedule")
            }
            // Agent-created tasks can never self-authorize unattended effects (P4/P5 invariant).
            let task = ScheduledTask(title: title, prompt: prompt, schedule: schedule,
                                     autonomy: .notifyOnly, source: .agent)
            let ok = await scheduleCreate(task)
            return ok ? ToolOutcome(ok: true, output: "已创建定时任务「\(title)」")
                      : ToolOutcome(ok: false, output: "", error: "排程失败")

        default:
            return ToolOutcome(ok: false, output: "", error: "in-process executor cannot handle \(step.capabilityID)")
        }
    }

    private func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }

    static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: raw) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: raw)
    }

    static func currentDateTimeOutcome(now: Date, timeZone: TimeZone) -> ToolOutcome {
        let iso = ISO8601DateFormatter()
        iso.timeZone = timeZone
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = timeZone
        local.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"
        let isoString = iso.string(from: now)
        let localString = local.string(from: now)
        let payload: [String: String] = [
            "status": "success",
            "timestamp": isoString,
            "iso8601": isoString,
            "timezone": timeZone.identifier,
            "local_time": localString,
            "local": localString,
        ]
        let data = (try? JSONEncoder().encode(payload)) ?? Data()
        let output = String(data: data, encoding: .utf8) ?? local.string(from: now)
        return ToolOutcome(ok: true, output: output)
    }

    static func parseSchedule(_ p: [String: String]) -> Schedule? {
        switch p["scheduleKind"] {
        case "everySeconds":
            guard let s = p["seconds"].flatMap(Int.init), s > 0 else { return nil }
            return .everySeconds(s)
        case "dailyAt":
            guard let h = p["hour"].flatMap(Int.init), (0...23).contains(h),
                  let m = p["minute"].flatMap(Int.init), (0...59).contains(m) else { return nil }
            return .dailyAt(hour: h, minute: m)
        case "oneShot":
            guard let date = parseDate(p["date"]) else { return nil }
            return .oneShot(date)
        default:
            return nil
        }
    }
}

// MARK: - Live EventKit implementation

#if canImport(EventKit)
/// Real EventKit access. Reuses the access pattern from `RemindersBridge`. Runs on the main actor;
/// degrades to a clear error when access is denied (never crashes, never prompts unprompted twice).
@MainActor
final class LiveEventKitAccess: EventKitAccess {
    private let store = EKEventStore()

    private func ensureReminderAccess() async -> Bool {
        (try? await store.requestFullAccessToReminders()) ?? false
    }
    private func ensureEventAccess() async -> Bool {
        (try? await store.requestFullAccessToEvents()) ?? false
    }

    func createReminder(title: String, due: Date?, notes: String?) async -> Result<String, ToolFailure> {
        guard await ensureReminderAccess() else { return .failure(ToolFailure(message: "提醒权限未授予")) }
        guard let cal = store.defaultCalendarForNewReminders() else { return .failure(ToolFailure(message: "没有可用的提醒列表")) }
        let r = EKReminder(eventStore: store)
        r.calendar = cal; r.title = title; r.notes = notes
        if let due { r.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due) }
        do { try store.save(r, commit: true); return .success(r.calendarItemIdentifier) }
        catch { return .failure(ToolFailure(message: "保存提醒失败：\(error.localizedDescription)")) }
    }

    func createCalendarEvent(title: String, start: Date, end: Date, notes: String?) async -> Result<String, ToolFailure> {
        guard await ensureEventAccess() else { return .failure(ToolFailure(message: "日历权限未授予")) }
        guard let cal = store.defaultCalendarForNewEvents else { return .failure(ToolFailure(message: "没有可用的日历")) }
        let e = EKEvent(eventStore: store)
        e.calendar = cal; e.title = title; e.startDate = start; e.endDate = end; e.notes = notes
        do { try store.save(e, span: .thisEvent, commit: true); return .success(e.eventIdentifier ?? "saved") }
        catch { return .failure(ToolFailure(message: "保存日程失败：\(error.localizedDescription)")) }
    }

    func readReminders(limit: Int) async -> Result<[String], ToolFailure> {
        guard await ensureReminderAccess() else { return .failure(ToolFailure(message: "提醒权限未授予")) }
        let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let titles: [String] = await withCheckedContinuation { c in
            store.fetchReminders(matching: pred) { rs in
                c.resume(returning: (rs ?? []).prefix(limit).map { $0.title ?? "未命名提醒" })
            }
        }
        return .success(titles)
    }

    func readCalendarEvents(daysAhead: Int, limit: Int) async -> Result<[String], ToolFailure> {
        guard await ensureEventAccess() else { return .failure(ToolFailure(message: "日历权限未授予")) }
        let now = Date()
        let end = Calendar.current.date(byAdding: .day, value: max(1, daysAhead), to: now) ?? now
        let pred = store.predicateForEvents(withStart: now, end: end, calendars: nil)
        let df = DateFormatter(); df.dateFormat = "MM-dd HH:mm"
        let items = store.events(matching: pred).prefix(limit).map { "\(df.string(from: $0.startDate)) \($0.title ?? "")" }
        return .success(Array(items))
    }
}
#else
final class LiveEventKitAccess: EventKitAccess {
    func createReminder(title: String, due: Date?, notes: String?) async -> Result<String, ToolFailure> { .failure(ToolFailure(message: "EventKit 不可用")) }
    func createCalendarEvent(title: String, start: Date, end: Date, notes: String?) async -> Result<String, ToolFailure> { .failure(ToolFailure(message: "EventKit 不可用")) }
    func readReminders(limit: Int) async -> Result<[String], ToolFailure> { .failure(ToolFailure(message: "EventKit 不可用")) }
    func readCalendarEvents(daysAhead: Int, limit: Int) async -> Result<[String], ToolFailure> { .failure(ToolFailure(message: "EventKit 不可用")) }
}
#endif
