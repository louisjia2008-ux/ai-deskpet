import Foundation

/// The pet owns its own task model (doc §9.2) — system Reminders/Calendar are opt-in mirrors,
/// not the source of truth.
enum TaskPriority: String, Codable, CaseIterable, Sendable {
    case low, normal, high
    var label: String {
        switch self {
        case .low: return "低"
        case .normal: return "中"
        case .high: return "高"
        }
    }
}

struct PetTask: Identifiable, Codable, Equatable, Sendable {
    var id: UUID = UUID()
    var title: String
    var subject: String?          // 科目/项目
    var priority: TaskPriority = .normal
    var due: Date?
    var estimatedMinutes: Int?    // 预计时长
    var focusRounds: Int?         // 计划专注轮次
    var notes: String?
    var done: Bool = false
    var createdAt: Date = Date()
    /// id of a linked system reminder, if mirrored (doc §9.2). Source of truth stays local.
    var reminderID: String?
}

/// A parsed-but-unconfirmed task from natural language. The user MUST confirm before it
/// becomes a PetTask (doc §9.3 — 必须先显示结构化草稿供确认).
struct TaskDraft: Equatable, Sendable {
    var title: String
    var subject: String?
    var priority: TaskPriority = .normal
    var due: Date?
    var estimatedMinutes: Int?
    var focusRounds: Int?
    var rawText: String

    func makeTask() -> PetTask {
        PetTask(title: title, subject: subject, priority: priority, due: due,
                estimatedMinutes: estimatedMinutes, focusRounds: focusRounds,
                notes: nil, done: false, createdAt: Date())
    }
}
