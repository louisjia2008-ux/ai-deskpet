import Foundation
import AICore

// PetBrain Protocol v0.1 (doc 02). Pure value types. PetBrainCore imports only Foundation + AICore
// (itself UI-free); never SwiftUI/AppKit/ScreenCaptureKit/external-runtime/persistence (gate D1).

public enum DialogueRoute: String, Sendable, Codable, Equatable {
    case character, desktopAssistant, agent
}

public enum DialogueIntent: String, Sendable, Codable, Equatable {
    case smalltalk, knowledge, emotionalSupport, clickInteraction
    case assistantAction    // 提醒/日历/打开/计时/总结选中
    case agentTask          // 多步骤/工具循环
}

/// Conversation privacy class that reaches the planner (mirrors the chat layer).
public enum ConversationClass: String, Sendable, Codable, Equatable {
    case normal, temporary, privateChat
}

/// Unified entry into PetBrain (doc 02 §2). P1 only exercises `userMessage`/`petClicked`.
public struct InputEvent: Sendable, Equatable {
    public var id: UUID
    public var timestamp: Date
    public var kind: Kind
    public var conversationClass: ConversationClass
    public var useScreen: Bool

    public enum Kind: Sendable, Equatable {
        case userMessage(text: String)
        case petClicked
    }

    public init(id: UUID = UUID(), timestamp: Date = Date(), kind: Kind,
                conversationClass: ConversationClass = .normal, useScreen: Bool = false) {
        self.id = id; self.timestamp = timestamp; self.kind = kind
        self.conversationClass = conversationClass; self.useScreen = useScreen
    }
}

/// What a ModelProvider needs to answer. Built by the runtime AFTER the planner decides route.
public struct ModelRequest: Sendable, Equatable {
    public struct Turn: Sendable, Equatable {
        public enum Role: Sendable, Equatable { case user, pet }
        public var role: Role; public var text: String
        public init(role: Role, text: String) { self.role = role; self.text = text }
    }
    public var text: String
    public var history: [Turn]
    public var memoryHints: [String]
    public var route: DialogueRoute
    public var isPrivate: Bool
    public var useScreen: Bool
    public var requiresMemory: Bool
    public init(text: String, history: [Turn] = [], memoryHints: [String] = [],
                route: DialogueRoute, isPrivate: Bool = false, useScreen: Bool = false,
                requiresMemory: Bool = false) {
        self.text = text; self.history = history; self.memoryHints = memoryHints
        self.route = route; self.isPrivate = isPrivate; self.useScreen = useScreen
        self.requiresMemory = requiresMemory
    }
}

/// Pre-render structured output from a model/route. Facts here are authoritative and must survive
/// rendering unchanged (doc §14.5).
public struct SemanticResponse: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable { case chat, plan, unavailable, permissionRequest, error }
    public var text: String
    public var kind: Kind
    public var route: DialogueRoute
    public var emotionProposal: EmotionProposal?
    public var suggestions: [String]
    public var viaCloud: Bool
    public init(text: String, kind: Kind, route: DialogueRoute,
                emotionProposal: EmotionProposal? = nil, suggestions: [String] = [], viaCloud: Bool = false) {
        self.text = text; self.kind = kind; self.route = route
        self.emotionProposal = emotionProposal; self.suggestions = suggestions; self.viaCloud = viaCloud
    }
}

public enum CharacterSpeakingMode: String, Sendable, Codable, Equatable {
    case casual, emotionalSupport, tutor, focusedAssistant
    case agentWorking, taskCompletion, warning, permissionRequest, failureRecovery
    /// Serious modes get a zeroed expression budget (no cute particles/emoji).
    public var isSerious: Bool {
        switch self {
        case .warning, .permissionRequest, .failureRecovery, .agentWorking: return true
        default: return false
        }
    }
}

/// Semantic animation intent only — the model never names concrete resources (doc §14.6).
public enum AnimationIntent: String, Sendable, Codable, Equatable {
    case listen, think, explain, encourage, celebrateSoft, concerned
    case prepareToWork, working, requestPermission, taskSucceeded, taskFailed
}

/// The ONLY thing the UI consumes (doc §14, decision 13). UI never sees raw model output.
public struct CharacterPresentation: Sendable, Equatable {
    public enum Priority: Int, Sendable, Equatable { case low, normal, high }
    public var bubbles: [String]
    public var speakingMode: CharacterSpeakingMode
    public var emotion: PetEmotion           // AICore enum — resolved display emotion
    public var animationIntent: AnimationIntent
    public var suggestions: [String]
    public var viaCloud: Bool
    public var priority: Priority
    public init(bubbles: [String], speakingMode: CharacterSpeakingMode, emotion: PetEmotion,
                animationIntent: AnimationIntent, suggestions: [String] = [],
                viaCloud: Bool = false, priority: Priority = .normal) {
        self.bubbles = bubbles; self.speakingMode = speakingMode; self.emotion = emotion
        self.animationIntent = animationIntent; self.suggestions = suggestions
        self.viaCloud = viaCloud; self.priority = priority
    }
}

public struct DialoguePlan: Sendable, Equatable {
    public var route: DialogueRoute
    public var intent: DialogueIntent
    public var confidence: Double
    public var speakingMode: CharacterSpeakingMode
    public var animationIntent: AnimationIntent
    public var requiresMemory: Bool
}

// Agent seam — P1 only defines the contract; no runtime is attached (D2).
public struct AgentRequest: Sendable, Equatable { public var goal: String
    public init(goal: String) { self.goal = goal } }
public enum AgentStartResult: Sendable, Equatable { case unavailable(reason: String); case started(sessionID: UUID) }

/// Capability seam — P1 only declares; nothing is executed (C2, P2 implements the Broker).
public struct CapabilityRequest: Sendable, Equatable {
    public var capability: String; public var reason: String
    public init(capability: String, reason: String) { self.capability = capability; self.reason = reason }
}
