import Foundation
import PetAgentRuntime

// P16 — pure, dependency-free tunables for the character presence coordinator. Keeps every
// magic number (dwell, cooldowns, thresholds, priorities) in one testable place so the
// coordinator itself stays a derivation + dispatcher. The clock is injectable for tests.

/// Inputs the pure policy needs to evaluate time-based rules. Centralized so the coordinator
/// can build it from its injected sources and tests can construct instances directly.
struct CharacterPresencePolicyContext {
    var now: Date
    var hasActiveTask: Bool
    var hasWaitingTask: Bool
    var isResponding: Bool
    var chatVisible: Bool
    var chatAttentive: Bool          // expanded / taskHUD (vs capsuleIdle / capsuleActive / hidden)
    var machineState: CharacterBehaviorState
    var lastUserInteractionAt: Date?
    var lastChatVisibilityChangeAt: Date?
    var lastTaskActivityAt: Date?
    var lastRespondingFallingEdgeAt: Date?
    var reduceMotion: Bool

    var lastWakeSourceAt: Date? {
        var candidates: [Date] = []
        if let lastUserInteractionAt { candidates.append(lastUserInteractionAt) }
        if let lastChatVisibilityChangeAt, chatVisible { candidates.append(lastChatVisibilityChangeAt) }
        if let lastTaskActivityAt, hasActiveTask || hasWaitingTask { candidates.append(lastTaskActivityAt) }
        if let lastRespondingFallingEdgeAt, isResponding { candidates.append(lastRespondingFallingEdgeAt) }
        return candidates.max()
    }
}

struct CharacterPresencePolicy: Equatable, Sendable {
    // MARK: Sustain dwell + cooldowns (from plan §1.5)
    var sustainedMinDwell: TimeInterval = 1.5
    var successCooldown: TimeInterval = 8.0
    var failureCooldown: TimeInterval = 5.0
    var recoveryCooldown: TimeInterval = 2.0
    var failureBeat: TimeInterval = 2.0
    var recoveryBeat: TimeInterval = 0.5
    var sleepAfterThreshold: TimeInterval = 300.0
    var greetOnWakeCooldown: TimeInterval = 30.0

    // MARK: Intent priorities (from plan §1.3 table)
    var prioritySleeping: Int = 40
    var priorityListening: Int = 45
    var priorityRecovery: Int = 46
    var priorityGreet: Int = 44
    var priorityThinking: Int = 50
    var priorityWaiting: Int = 50
    var priorityWorking: Int = 55
    var priorityReview: Int = 58
    var prioritySpeaking: Int = 60
    var prioritySuccess: Int = 68
    var priorityFailure: Int = 70
    var priorityDragged: Int = 90
    var priorityReactionBeat: Int = 46

    // MARK: One-shot durations
    var jumpDuration: TimeInterval = 0.78
    var failureDuration: TimeInterval = 1.45
    var successIdleResetDuration: TimeInterval = 0.20
    var reactionBeatDuration: TimeInterval = 0.30
    var neutralResetDuration: TimeInterval = 0.20
    /// Priority used by `mapping.neutralReset` to clear sustained working/review/waiting/listening
    /// after a terminal transition. Must beat `taskRunning` (55) / `taskReview` (58) / `taskWaiting`
    /// (50) / `listening` (45) but lose to legitimate one-shots and higher-priority transients:
    /// `jump` (68), `speaking` (60), `taskFailed` (70), `dragged` (90). Chosen at 59 so the
    /// priority-arbitration in `CharacterAnimationStateMachine.apply` rejects it while a real
    /// higher-priority intent is active.
    var neutralResetPriority: Int = 59
    var greetDuration: TimeInterval = 0.72

    static let `default` = CharacterPresencePolicy()
}
