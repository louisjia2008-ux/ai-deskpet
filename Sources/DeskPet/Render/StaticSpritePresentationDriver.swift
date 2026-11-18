import Foundation
import AICore
import PetBrainCore
import PetAgentRuntime

// P5.0 — app-side bridge implementing the runtime's CharacterPresentationDriver by driving the
// EXISTING PetRenderer through the overlay's existing semantic methods. One-way only:
//   Runtime → CharacterPresentationDriver → OverlayWindowController/PetRenderer.
// The overlay never reaches back into the runtime. No new character-presentation state source is
// created; this only translates runtime commands into the overlay calls that already exist.
@MainActor
final class StaticSpritePresentationDriver: CharacterPresentationDriver {
    private weak var overlay: OverlayWindowController?
    private(set) var lastExpression: CharacterExpression = .neutral
    private(set) var lastMotion: CharacterMotion = .idle
    private(set) var isSpeaking = false
    private(set) var reduceMotion = false

    init(overlay: OverlayWindowController?) { self.overlay = overlay }

    func setExpression(_ expression: CharacterExpression) async {
        lastExpression = expression
        overlay?.reactPet(emotion: Self.petEmotion(for: expression), action: .none)
    }

    func playMotion(_ motion: CharacterMotion) async {
        lastMotion = motion
        overlay?.handleAgentAnimationEvent(Self.animationEvent(for: motion))
    }

    func setSpeaking(_ isSpeaking: Bool) async {
        self.isSpeaking = isSpeaking
        overlay?.handleAgentAnimationEvent(isSpeaking ? .responseStarted : .responseFinished(emotion: .neutral))
    }

    func setAttentionTarget(_ target: AttentionTarget?) async {
        // Look-target wiring is deferred (P5.1); the renderer's setLookTarget is window-local and
        // needs coordinate mapping. Recorded only this round.
    }

    func updateEmotion(_ state: EmotionState) async {
        overlay?.reactPet(emotion: state.dominant, action: .none)
    }

    func resetToIdle() async {
        isSpeaking = false
        overlay?.handleAgentAnimationEvent(.thinkingFinished)
    }

    func setReduceMotion(_ reduce: Bool) async { reduceMotion = reduce }

    private static func petEmotion(for expression: CharacterExpression) -> PetEmotion {
        switch expression {
        case .neutral: return .neutral
        case .happy: return .happy
        case .curious: return .thinking
        case .thinking: return .thinking
        case .concerned: return .sad
        case .sleepy: return .sleepy
        case .surprised: return .excited
        }
    }

    private static func animationEvent(for motion: CharacterMotion) -> PetAgentAnimationEvent {
        switch motion {
        case .greet, .wave:
            return .greeting
        case .taskWaiting:
            return .providerWaiting
        case .taskRunning:
            return .taskRunning
        case .taskReview:
            return .taskReview
        case .taskFailed:
            return .terminalFailure
        case .success:
            return .taskSucceeded
        case .speaking: return .responseStarted
        case .nod, .tapReaction: return .userMessageReceived
        case .shakeHead: return .responseFailed
        case .sleep: return .responseCancelled
        case .idle, .blink, .breathe, .wake: return .thinkingFinished
        }
    }
}
