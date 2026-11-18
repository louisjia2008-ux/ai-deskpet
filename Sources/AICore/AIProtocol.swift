import Foundation

/// Wire protocol shared by the app and the isolated LLM helper. Newline-delimited JSON over
/// stdio. Kept tiny and Codable so both processes agree on the contract (doc §11.2).

public enum AIRequestKind: String, Codable, Sendable {
    case chat        // continuous conversation in the main window
    case quick       // short desktop-bubble question
}

/// One prior turn for context.
public struct AITurn: Codable, Sendable, Equatable {
    public enum Role: String, Codable, Sendable { case user, pet }
    public var role: Role
    public var text: String
    public init(role: Role, text: String) { self.role = role; self.text = text }
}

/// What the pet is allowed to perceive for this request (doc §11.4). Only ever populated with
/// data the PerceptionPolicy permits; raw screenshots never travel — only OCR'd text, ephemerally.
public struct PerceivedContext: Codable, Sendable, Equatable {
    public var frontmostApp: String?      // L1
    public var windowTitle: String?       // L2 (whitelisted)
    public var screenText: String?        // L3 (explicit consent; never persisted)
    public var memoryHints: [String]      // active long-term memories (doc §12.1), cloud-gated by caller
    /// P18 — freshness seam. Captured/expires timestamps for the *most-recent* snapshot
    /// contributing to this context. Backward-compatible: omitted on the wire → defaults
    /// to `.distantPast`, which `AwarenessFreshness.compute(... )` classifies as `.expired`
    /// so legacy senders that don't stamp freshness get the conservative path.
    public var capturedAt: Date = .distantPast
    public var expiresAt: Date = .distantPast
    public init(frontmostApp: String? = nil, windowTitle: String? = nil,
                screenText: String? = nil, memoryHints: [String] = [],
                capturedAt: Date = .distantPast, expiresAt: Date = .distantPast) {
        self.frontmostApp = frontmostApp
        self.windowTitle = windowTitle
        self.screenText = screenText
        self.memoryHints = memoryHints
        self.capturedAt = capturedAt
        self.expiresAt = expiresAt
    }
}

public struct AIRequest: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var id: String
    public var kind: AIRequestKind
    public var prompt: String
    public var history: [AITurn]
    public var context: PerceivedContext
    public init(id: String = UUID().uuidString, kind: AIRequestKind, prompt: String,
                history: [AITurn] = [], context: PerceivedContext = .init(),
                protocolVersion: Int = IPCProtocol.version) {
        self.protocolVersion = protocolVersion
        self.id = id; self.kind = kind; self.prompt = prompt
        self.history = history; self.context = context
    }
    // Backward compatible: legacy payloads without protocolVersion decode as 0.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = (try? c.decodeIfPresent(Int.self, forKey: .protocolVersion)) ?? 0
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(AIRequestKind.self, forKey: .kind)
        prompt = try c.decode(String.self, forKey: .prompt)
        history = (try? c.decodeIfPresent([AITurn].self, forKey: .history)) ?? []
        context = (try? c.decodeIfPresent(PerceivedContext.self, forKey: .context)) ?? .init()
    }
}

/// Pet emotions/actions the renderer understands. The AI MUST return values from these enums;
/// anything else is normalized to a safe default (doc §11.5 结构化输出并枚举校验).
public enum PetEmotion: String, Codable, CaseIterable, Sendable {
    case neutral, happy, shy, sad, excited, thinking, sleepy
}
public enum PetAction: String, Codable, CaseIterable, Sendable {
    case none, wave, nod, cheer, read, play, point

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        // Read historical persisted actions without reviving a second character.
        if value == "hugDragon" { self = .play; return }
        guard let action = Self(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unknown pet action")
        }
        self = action
    }
}

public struct AIResponse: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var id: String
    public var ok: Bool
    public var reply: String
    public var emotion: PetEmotion
    public var action: PetAction
    public var suggestions: [String]
    public var error: String?
    public init(id: String, ok: Bool = true, reply: String,
                emotion: PetEmotion = .neutral, action: PetAction = .none,
                suggestions: [String] = [], error: String? = nil,
                protocolVersion: Int = IPCProtocol.version) {
        self.protocolVersion = protocolVersion
        self.id = id; self.ok = ok; self.reply = reply
        self.emotion = emotion; self.action = action
        self.suggestions = suggestions; self.error = error
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = (try? c.decodeIfPresent(Int.self, forKey: .protocolVersion)) ?? 0
        id = try c.decode(String.self, forKey: .id)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        reply = (try? c.decodeIfPresent(String.self, forKey: .reply)) ?? ""
        emotion = (try? c.decodeIfPresent(PetEmotion.self, forKey: .emotion)) ?? .neutral
        action = (try? c.decodeIfPresent(PetAction.self, forKey: .action)) ?? .none
        suggestions = (try? c.decodeIfPresent([String].self, forKey: .suggestions)) ?? []
        error = try? c.decodeIfPresent(String.self, forKey: .error) ?? nil
    }
}
