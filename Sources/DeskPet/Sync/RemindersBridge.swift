import Foundation
#if canImport(EventKit)
import EventKit
#endif

/// Optional, opt-in mirror to Apple Reminders (doc §9.2 — 按需导入/导出/同步完成状态). The pet's
/// local store stays the source of truth. Never runs unprompted; degrades silently if access is
/// denied (doc §14.2 可降级). Calendar read + full Reminders/Calendar sync are deferred to M7/M8.
@MainActor
final class RemindersBridge {

    enum Result { case unavailable, denied, ok(Int) }

#if canImport(EventKit)
    private let store = EKEventStore()

    private func ensureAccess() async -> Bool {
        (try? await store.requestFullAccessToReminders()) ?? false
    }

    /// Sendable extract so non-Sendable EKReminder never crosses the actor boundary.
    private struct Snapshot: Sendable { var title: String; var due: Date?; var priority: Int; var id: String }

    /// Import incomplete reminders as PetTasks (skipping ones already mirrored by reminderID).
    func importReminders(existing: [PetTask]) async -> (Result, [PetTask]) {
        guard await ensureAccess() else { return (.denied, []) }
        let known = Set(existing.compactMap(\.reminderID))
        let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let snaps: [Snapshot] = await withCheckedContinuation { cont in
            store.fetchReminders(matching: pred) { reminders in
                let mapped = (reminders ?? []).map {
                    Snapshot(title: $0.title ?? "未命名提醒",
                             due: $0.dueDateComponents?.date,
                             priority: $0.priority,
                             id: $0.calendarItemIdentifier)
                }
                cont.resume(returning: mapped)
            }
        }
        var imported: [PetTask] = []
        for s in snaps where !known.contains(s.id) {
            var t = PetTask(title: s.title)
            t.due = s.due
            t.priority = s.priority >= 5 ? .high : (s.priority == 0 ? .normal : .low)
            t.reminderID = s.id
            imported.append(t)
        }
        return (.ok(imported.count), imported)
    }

    /// Export a task to Reminders, returning its reminder identifier to store back locally.
    func export(_ task: PetTask) async -> (Result, String?) {
        guard await ensureAccess() else { return (.denied, nil) }
        guard let cal = store.defaultCalendarForNewReminders() else { return (.unavailable, nil) }
        let r = EKReminder(eventStore: store)
        r.calendar = cal
        r.title = task.title
        if let due = task.due {
            r.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
        }
        do { try store.save(r, commit: true); return (.ok(1), r.calendarItemIdentifier) }
        catch { return (.unavailable, nil) }
    }
#else
    func importReminders(existing: [PetTask]) async -> (Result, [PetTask]) { (.unavailable, []) }
    func export(_ task: PetTask) async -> (Result, String?) { (.unavailable, nil) }
#endif
}
