import Foundation
import AICore

/// Conversation retention classes (doc §12.4). M3 implements normal/temporary/private; project
/// retention arrives with the memory milestone (M5).
enum ConversationKind: String, Codable, CaseIterable, Sendable {
    case normal       // 保存原文，可摘要归档
    case temporary    // 关闭后删除原文
    case privateChat  // 不写记忆、不上传、不搜索、关闭即清除
    case project      // 按项目长期保留

    var persists: Bool { self == .normal || self == .project }
    var label: String {
        switch self {
        case .normal: return "普通"
        case .temporary: return "临时"
        case .privateChat: return "私密"
        case .project: return "项目"
        }
    }
}

/// Assistant message lifecycle (P4.3 §6). User messages are always `.completed`.
enum MessageStatus: String, Codable, Sendable { case pending, completed, cancelled, failed, interrupted }

enum ChatActivityStatus: String, Codable, Sendable {
    case pending
    case running
    case waiting
    case succeeded
    case failed
    case cancelled
}

struct ChatActivityToolRecord: Identifiable, Codable, Equatable, Sendable {
    var key: String
    var toolID: String
    var displayName: String
    var icon: String
    var status: ChatActivityStatus
    var title: String
    /// P19.1 — optional compact one-line summary of the tool's actual result, derived
    /// from the real `AgentToolObservation.userSafeSummary` (which itself goes through
    /// `AgentPrivacyRedactor.safeSummary`). `nil` when the runtime has not surfaced a
    /// trustworthy result yet, or the value would have been fabricated from weak
    /// proxies (event count, lifecycle count). Consumers must treat absence as
    /// "no preview available" rather than "no result".
    var resultPreview: String?
    var updatedAt: Date

    var id: String { key }
}

struct ChatActivityRecord: Codable, Equatable, Sendable {
    var taskID: UUID
    var runID: UUID
    var conversationID: UUID?
    var userMessageID: UUID?
    var status: ChatActivityStatus
    var summary: String
    var detail: String?
    var tools: [ChatActivityToolRecord]
    var createdAt: Date
    var updatedAt: Date
    var completedAt: Date?
}

struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable, Sendable { case user, pet, activity }
    var id: UUID = UUID()
    var role: Role
    var text: String
    var emotion: PetEmotion?
    var viaCloud: Bool = false
    var timestamp: Date = Date()
    var status: MessageStatus = .completed
    var retryOfMessageID: UUID?
    var regeneratedFromMessageID: UUID?
    var taskID: UUID?
    var attemptID: UUID?
    var activity: ChatActivityRecord?

    init(id: UUID = UUID(), role: Role, text: String, emotion: PetEmotion? = nil, viaCloud: Bool = false,
         timestamp: Date = Date(), status: MessageStatus = .completed,
         retryOfMessageID: UUID? = nil, regeneratedFromMessageID: UUID? = nil,
         taskID: UUID? = nil, attemptID: UUID? = nil,
         activity: ChatActivityRecord? = nil) {
        self.id = id; self.role = role; self.text = text; self.emotion = emotion; self.viaCloud = viaCloud
        self.timestamp = timestamp; self.status = status
        self.retryOfMessageID = retryOfMessageID; self.regeneratedFromMessageID = regeneratedFromMessageID
        self.taskID = taskID; self.attemptID = attemptID
        self.activity = activity
    }
    /// Legacy decode (pre-P4.3 messages had no status/retry fields).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        role = try c.decode(Role.self, forKey: .role)
        text = try c.decode(String.self, forKey: .text)
        emotion = try c.decodeIfPresent(PetEmotion.self, forKey: .emotion)
        viaCloud = try c.decodeIfPresent(Bool.self, forKey: .viaCloud) ?? false
        timestamp = try c.decodeIfPresent(Date.self, forKey: .timestamp) ?? Date()
        status = try c.decodeIfPresent(MessageStatus.self, forKey: .status) ?? .completed
        retryOfMessageID = try c.decodeIfPresent(UUID.self, forKey: .retryOfMessageID)
        regeneratedFromMessageID = try c.decodeIfPresent(UUID.self, forKey: .regeneratedFromMessageID)
        taskID = try c.decodeIfPresent(UUID.self, forKey: .taskID)
        attemptID = try c.decodeIfPresent(UUID.self, forKey: .attemptID)
        activity = try c.decodeIfPresent(ChatActivityRecord.self, forKey: .activity)
    }
}

struct Conversation: Identifiable, Codable, Equatable, Sendable {
    var id: UUID = UUID()
    var kind: ConversationKind = .normal
    var title: String = "新对话"
    var messages: [ChatMessage] = []
    var archived: Bool = false
    var updatedAt: Date = Date()

    init(id: UUID = UUID(), kind: ConversationKind = .normal, title: String = "新对话",
         messages: [ChatMessage] = [], archived: Bool = false, updatedAt: Date = Date()) {
        self.id = id; self.kind = kind; self.title = title
        self.messages = messages; self.archived = archived; self.updatedAt = updatedAt
    }

    /// Resilient decoding so legacy conversations (pre-M5, without archived/updatedAt) still load.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        kind = try c.decodeIfPresent(ConversationKind.self, forKey: .kind) ?? .normal
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "新对话"
        messages = try c.decodeIfPresent([ChatMessage].self, forKey: .messages) ?? []
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    /// History turns for the model, omitting any ephemeral/private framing.
    func turns() -> [AITurn] {
        messages.compactMap { message in
            switch message.role {
            case .user:
                return AITurn(role: .user, text: message.text)
            case .pet:
                return AITurn(role: .pet, text: message.text)
            case .activity:
                return nil
            }
        }
    }
}

/// Persists only conversations whose kind allows it (doc §12.4). Private/temporary never touch disk.
@MainActor
final class ChatStore {
    private let url: URL
    private let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.prettyPrinted]; return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    init(fileURL: URL? = nil) {
        if let fileURL { self.url = fileURL }
        else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("conversations.json")
        }
    }

    /// P18.6 — set when `load()` finds an existing-but-undecodable conversations
    /// file and quarantines it, so a corrupt history is never silently reported as
    /// "no conversations" (which the next save would then make permanent).
    private(set) var lastLoadCorruptionURL: URL?

    func load() -> [Conversation] {
        lastLoadCorruptionURL = nil
        let secure: SealedStore.LoadState
        do {
            secure = try SealedStore.load(at: url)
        } catch {
            // Sealed but unreadable (no key): NOT corruption — leave bytes.
            return []
        }
        guard case .data(let data, _) = secure else { return [] }
        do {
            let convs = try decoder.decode([Conversation].self, from: data)
            SealedStore.migratePlaintext(at: url) { try save(convs) }
            return convs
        } catch {
            lastLoadCorruptionURL = DurableJSONFile.quarantineCorrupt(at: url)
            return []
        }
    }

    /// Saves only persistable conversations; the rest are dropped (never written).
    /// P18.6 — throws on encode/write failure so the caller can surface an
    /// observable persistence error instead of silently losing the write.
    /// Sealed when a key is wired (D3); fail-closed on sealed-without-key.
    func save(_ conversations: [Conversation]) throws {
        let persistable = conversations.filter { $0.kind.persists }
        let data = try encoder.encode(persistable)
        try SealedStore.save(data, to: url)
    }
}
