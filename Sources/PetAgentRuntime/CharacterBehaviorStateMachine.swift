import Foundation

// P5.0 — high-level character behavior state machine (doc §6.7). This orchestrates *what the
// character is doing* (companion behavior), above the existing visual animation state machine and
// the movement state machine. Transitions are explicit: an illegal transition throws and is audited;
// it never silently corrupts state. Each state has a semantic entry presentation command that the app
// maps to a concrete CharacterPresentationDriver call.

public enum CharacterBehaviorState: String, Sendable, Codable, CaseIterable, Equatable {
    case dormant
    case idle
    case observing
    case listening
    case thinking
    case speaking
    case acting
    case waitingForPermission
    case interrupted
    case errorRecovery
    case sleeping

    /// In these states ambient/proactive behavior must be suppressed.
    public var suppressesAmbient: Bool { self == .sleeping || self == .dormant }
}

public enum CharacterBehaviorEvent: Sendable, Equatable {
    case start
    case userLooked
    case userMessage
    case beginThinking
    case beginSpeaking
    case beginActing
    case needPermission
    case permissionResolved
    case finished
    case interrupt
    case recoverFromError
    case recovered
    case sleep
    case wake
    case shutdown

    public var label: String {
        switch self {
        case .start: return "start"
        case .userLooked: return "userLooked"
        case .userMessage: return "userMessage"
        case .beginThinking: return "beginThinking"
        case .beginSpeaking: return "beginSpeaking"
        case .beginActing: return "beginActing"
        case .needPermission: return "needPermission"
        case .permissionResolved: return "permissionResolved"
        case .finished: return "finished"
        case .interrupt: return "interrupt"
        case .recoverFromError: return "recoverFromError"
        case .recovered: return "recovered"
        case .sleep: return "sleep"
        case .wake: return "wake"
        case .shutdown: return "shutdown"
        }
    }
}

public enum BehaviorTransitionError: Error, Equatable, Sendable {
    case invalid(from: CharacterBehaviorState, event: String)
}

/// Semantic entry command for a state. The app maps it to concrete driver calls; the runtime never
/// names a sprite or animation resource.
public struct BehaviorPresentationCommand: Sendable, Equatable {
    public var expression: CharacterExpression
    public var motion: CharacterMotion
    public var speaking: Bool
    public init(expression: CharacterExpression, motion: CharacterMotion, speaking: Bool = false) {
        self.expression = expression
        self.motion = motion
        self.speaking = speaking
    }
}

public struct CharacterBehaviorStateMachine: Sendable {
    public private(set) var state: CharacterBehaviorState

    public init(state: CharacterBehaviorState = .dormant) { self.state = state }

    /// Apply an event. Returns the new state, or throws `BehaviorTransitionError.invalid` for an
    /// illegal transition (the caller audits it).
    @discardableResult
    public mutating func handle(_ event: CharacterBehaviorEvent) throws -> CharacterBehaviorState {
        guard let next = Self.next(from: state, event: event) else {
            throw BehaviorTransitionError.invalid(from: state, event: event.label)
        }
        state = next
        return next
    }

    public func canHandle(_ event: CharacterBehaviorEvent) -> Bool {
        Self.next(from: state, event: event) != nil
    }

    public static func next(from: CharacterBehaviorState,
                            event: CharacterBehaviorEvent) -> CharacterBehaviorState? {
        switch (from, event) {
        case (_, .shutdown):
            return .dormant

        case (.dormant, .start):
            return .idle

        case (.idle, .userLooked):
            return .observing

        case (.idle, .userMessage), (.observing, .userMessage):
            return .listening

        case (.sleeping, .userMessage):     // a direct tap/message wakes the character
            return .listening

        case (.listening, .beginThinking):
            return .thinking

        // P16 — production-viable starts (scheduled tasks begin from .idle or .observing without
        // requiring a chat-message first). Keeps the layered invariant: each transition has at
        // least one producer.
        case (.idle, .beginThinking), (.observing, .beginThinking):
            return .thinking

        case (.idle, .beginActing), (.observing, .beginActing):
            return .acting

        case (.thinking, .finished):
            // Inference ended without a spoken reply (empty / suppressed response).
            return .idle

        case (.acting, .beginSpeaking):
            // Task completed into a streaming reply — speak.
            return .speaking

        case (.thinking, .beginSpeaking):
            return .speaking

        case (.thinking, .beginActing):
            return .acting

        case (.thinking, .needPermission), (.acting, .needPermission):
            return .waitingForPermission

        // P16 — production-viable starts. Allow a scheduled/background waitingForPermission to
        // emerge from observing even before .thinking/.acting has run (e.g. autonomous
        // permission-gated step before any speech).
        case (.idle, .needPermission), (.observing, .needPermission),
             (.listening, .needPermission):
            return .waitingForPermission

        case (.waitingForPermission, .permissionResolved):
            return .acting

        // R2-4: a waiting task can disappear without an approvalResolved first
        // (user deletes it from Task Center, or a terminal lands directly from
        // waiting). Without this row the machine strands in `.waitingForPermission`
        // and reconcile re-asserts `taskWaiting` p50 forever, even after the pet
        // has been moved to a different visual by a higher-priority transient.
        case (.waitingForPermission, .finished):
            return .idle

        case (.speaking, .finished), (.acting, .finished),
             (.observing, .finished), (.listening, .finished):
            return .idle

        case (.idle, .sleep):
            return .sleeping

        case (.sleeping, .wake):
            return .idle

        case (.interrupted, .recovered), (.errorRecovery, .recovered):
            return .idle

        case (_, .interrupt) where from != .dormant && from != .sleeping:
            return .interrupted

        case (_, .recoverFromError) where from != .dormant:
            return .errorRecovery

        default:
            return nil
        }
    }

    public static func presentationCommand(for state: CharacterBehaviorState) -> BehaviorPresentationCommand {
        switch state {
        case .dormant:
            return BehaviorPresentationCommand(expression: .neutral, motion: .idle)
        case .idle:
            return BehaviorPresentationCommand(expression: .neutral, motion: .breathe)
        case .observing:
            return BehaviorPresentationCommand(expression: .curious, motion: .blink)
        case .listening:
            return BehaviorPresentationCommand(expression: .curious, motion: .idle)
        case .thinking:
            return BehaviorPresentationCommand(expression: .thinking, motion: .taskWaiting)
        case .speaking:
            return BehaviorPresentationCommand(expression: .happy, motion: .speaking, speaking: true)
        case .acting:
            return BehaviorPresentationCommand(expression: .thinking, motion: .taskRunning)
        case .waitingForPermission:
            return BehaviorPresentationCommand(expression: .concerned, motion: .taskReview)
        case .interrupted:
            return BehaviorPresentationCommand(expression: .surprised, motion: .tapReaction)
        case .errorRecovery:
            return BehaviorPresentationCommand(expression: .concerned, motion: .taskFailed)
        case .sleeping:
            return BehaviorPresentationCommand(expression: .sleepy, motion: .sleep)
        }
    }
}
