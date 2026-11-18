import Foundation
import CoreGraphics

// P16 — pure mapping from semantic "what is the character doing" to a renderer intent.
// Lives outside the coordinator so the table is testable in isolation, and so the
// coordinator stays a dispatcher. Reduce Motion chooses between a sway-based .thinking
// intent and a held static look-pose so the distinction remains readable without motion.

/// Describes the *kind* of semantic state the mapping should produce an intent for. Mirrors
/// the §1.3 contract table without using the dormant `dormant` / `curious` cases (folded
/// into idle / observing per the plan).
enum CharacterPresenceSemantic: String, Equatable, Codable, Sendable, CaseIterable {
    case idle
    case attentiveLite   // capsule active — listening, no gaze
    case attentive       // chat expanded/taskHUD — listening + gaze
    case thinking        // inference
    case working         // running
    case review          // synthesizing
    case waiting         // approval/permission/user
    case speaking
    case success         // one-shot jump
    case failure         // one-shot taskFailed
    case recovery        // one-shot .reacting(.neutral) beat
    case sleeping        // sustained .sleeping
}

/// Lightweight context passed into the mapper so the same intent can be tuned by reduce-motion
/// flag, override clip (e.g. gaze look pose for RM thinking), and emotion intensity.
struct CharacterPresenceRenderContext: Equatable {
    var reduceMotion: Bool = false
    var emotion: CharacterAnimationEmotion = .neutral
    var intensity: Double = 1.0
    var createdAt: TimeInterval = Date().timeIntervalSinceReferenceDate
    var interruptPolicy: CharacterInterruptPolicy = .interruptLowerPriority
}

struct CharacterPresenceMapping {
    let policy: CharacterPresencePolicy

    /// Default mapper using the standard policy + creator clock.
    static let live = CharacterPresenceMapping(policy: .default)

    /// Map a semantic state to a renderer intent with the supplied context.
    /// Reduce Motion swaps `.thinking` for a held static `.look1125` pose so the
    /// distinction from idle remains readable without motion.
    /// Defaults `policy` to this instance's own policy so custom-policy mappings
    /// (e.g. tests injecting non-default priorities) are honoured.
    func intent(for semantic: CharacterPresenceSemantic,
                context: CharacterPresenceRenderContext,
                policy: CharacterPresencePolicy? = nil) -> CharacterAnimationIntent {
        let effectivePolicy = policy ?? self.policy
        var effective = context
        if effective.intensity < 0 || effective.intensity > 1 {
            effective.intensity = max(0, min(1, effective.intensity))
        }
        let now = effective.createdAt
        switch semantic {
        case .idle:
            return CharacterAnimationIntent(state: .idle,
                                            priority: CharacterAnimationIntent.defaultPriority(for: .idle),
                                            source: .agentRuntime,
                                            createdAt: now)
        case .attentiveLite, .attentive:
            return CharacterAnimationIntent(state: .listening,
                                            emotion: .curious,
                                            priority: effectivePolicy.priorityListening,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .thinking:
            if effective.reduceMotion {
                return CharacterAnimationIntent(state: .look1125,
                                                priority: effectivePolicy.priorityThinking,
                                                source: .agentRuntime,
                                                createdAt: now)
            }
            return CharacterAnimationIntent(state: .thinking,
                                            emotion: .curious,
                                            priority: effectivePolicy.priorityThinking,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .working:
            return CharacterAnimationIntent(state: .taskRunning,
                                            emotion: .curious,
                                            priority: effectivePolicy.priorityWorking,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .review:
            return CharacterAnimationIntent(state: .taskReview,
                                            emotion: .curious,
                                            priority: effectivePolicy.priorityReview,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .waiting:
            return CharacterAnimationIntent(state: .taskWaiting,
                                            emotion: .curious,
                                            priority: effectivePolicy.priorityWaiting,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .speaking:
            return CharacterAnimationIntent(state: .speaking,
                                            emotion: effective.emotion,
                                            priority: effectivePolicy.prioritySpeaking,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .success:
            return CharacterAnimationIntent(state: .jump,
                                            emotion: .happy,
                                            intensity: 0.55,
                                            priority: effectivePolicy.prioritySuccess,
                                            duration: effectivePolicy.jumpDuration,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .failure:
            return CharacterAnimationIntent(state: .taskFailed,
                                            emotion: .sad,
                                            intensity: 0.7,
                                            priority: effectivePolicy.priorityFailure,
                                            duration: effectivePolicy.failureDuration,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .recovery:
            return CharacterAnimationIntent(state: .reacting,
                                            emotion: effective.emotion,
                                            intensity: 0.35,
                                            priority: effectivePolicy.priorityReactionBeat,
                                            duration: effectivePolicy.reactionBeatDuration,
                                            source: .agentRuntime,
                                            createdAt: now)
        case .sleeping:
            return CharacterAnimationIntent(state: .sleeping,
                                            emotion: .sleepy,
                                            priority: effectivePolicy.prioritySleeping,
                                            source: .agentRuntime,
                                            createdAt: now)
        }
    }

    /// Neutral reset intent: `.idle` with the same priority convention the legacy mapper
    /// used for `.responseCancelled` (priority 50).
    func neutralReset(now: TimeInterval) -> CharacterAnimationIntent {
        CharacterAnimationIntent(state: .idle,
                                 emotion: .neutral,
                                 priority: policy.neutralResetPriority,
                                 duration: policy.neutralResetDuration,
                                 source: .agentRuntime,
                                 createdAt: now)
    }

    /// Optional one-shot greeting on wake.
    func wakeGreet(now: TimeInterval) -> CharacterAnimationIntent {
        CharacterAnimationIntent(state: .greet,
                                 emotion: .happy,
                                 priority: policy.priorityGreet,
                                 duration: policy.greetDuration,
                                 source: .agentRuntime,
                                 createdAt: now)
    }
}
