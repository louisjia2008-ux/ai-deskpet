import Foundation
import Combine
import AICore

/// Shared app state for the main window (tasks + focus). The desktop pet keeps its own
/// PetState; this is the "tool pages" side (doc §13.3 — 工具页面时角色留在桌面).
@MainActor
final class AppModel: ObservableObject {

    @Published var tasks: [PetTask] = []
    @Published var draft: TaskDraft?          // pending NL draft awaiting confirmation
    /// P18.6 — observable durable-persistence failure. `nil` when the last save
    /// reached disk; a user-facing message when it did not, so the task list is
    /// never silently divergent from disk without the UI being able to say so.
    @Published private(set) var lastPersistenceError: String?
    /// P18.6 — non-nil when the tasks file existed but could not be decoded and was
    /// quarantined at load; lets the UI surface a recovery notice instead of
    /// presenting a silently-empty list as genuine.
    @Published private(set) var loadCorruptionQuarantineURL: URL?
    let focus = FocusEngine()
    /// Fired when a task transitions to done (doc §10.3 完成任务 → 关系增长).
    var onTaskCompleted: () -> Void = {}

    private let store: TaskStore

    init(store: TaskStore = TaskStore()) {
        self.store = store
        tasks = store.load()
        loadCorruptionQuarantineURL = store.lastLoadCorruptionURL
    }

    // MARK: Tasks

    func add(_ task: PetTask) { tasks.insert(task, at: 0); persist() }

    func toggleDone(_ task: PetTask) {
        guard let i = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks[i].done.toggle()
        if tasks[i].done { onTaskCompleted() }
        persist()
    }

    func delete(_ task: PetTask) { tasks.removeAll { $0.id == task.id }; persist() }

    func update(_ task: PetTask) {
        guard let i = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks[i] = task; persist()
    }

    /// Top tasks for the desktop "today" summary (doc §13.2 — 今日前三项).
    var topOpenTasks: [PetTask] {
        tasks.filter { !$0.done }
            .sorted { lhs, rhs in
                if lhs.priority != rhs.priority { return lhs.priority == .high }
                return (lhs.due ?? .distantFuture) < (rhs.due ?? .distantFuture)
            }
    }

    // MARK: NL draft (doc §9.3 — propose, never auto-commit)

    func makeDraft(from text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        draft = TaskDraftParser.parse(t)
    }

    func confirmDraft() {
        guard let d = draft else { return }
        add(d.makeTask())
        draft = nil
    }

    func discardDraft() { draft = nil }

    // MARK: Focus integration

    func startFocus(mode: FocusMode, task: PetTask?) {
        focus.start(mode: mode, taskID: task?.id)
    }

    /// Tally how many times a given focus length has been completed (drives habit suggestions).
    private var focusCompletions: [Int: Int] = [:]
    func recordFocusCompletion(minutes: Int) -> Int {
        let n = (focusCompletions[minutes] ?? 0) + 1
        focusCompletions[minutes] = n
        return n
    }

    private func persist() {
        do {
            try store.save(tasks)
            lastPersistenceError = nil
        } catch {
            // Durable write failed. In-memory `tasks` is optimistically current;
            // disclose the failure rather than letting the UI imply it was saved.
            lastPersistenceError = SealedStore.describe(error, fallback: "任务保存失败")
        }
    }
}
