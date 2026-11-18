import Foundation

/// Tracks how engaged the user is so proactivity can self-tune (doc §8.1 自适应黏人).
/// Interactions raise it; ignored bubbles lower it; it drifts back to a calm baseline.
@MainActor
final class EngagementTracker {
    private(set) var score: Double = 0.4
    private let baseline = 0.4

    func interaction() { score = min(1, score + 0.25) }
    func ignored() { score = max(0, score - 0.12) }
    func decay(dt: TimeInterval) {
        let rate = 0.01 * dt
        if score > baseline { score = max(baseline, score - rate) }
        else if score < baseline { score = min(baseline, score + rate) }
    }
}

enum IdleKind: Equatable, Sendable { case read, sleep, play }

/// What the pet should proactively do this moment.
enum ProactiveDecision: Equatable, Sendable {
    case none
    case speak(SpeechCategory)
    case idleEntertain(IdleKind)
}

/// The proactivity brain (doc §8.1/§8.2). Deterministic given injected time + rolls so its
/// cadence, the "max 2 then quiet period" rule, and convergence are unit-testable.
@MainActor
final class ProactivityEngine {

    // Tunables
    var minInterval: TimeInterval = 30      // very engaged
    var maxInterval: TimeInterval = 120     // ignored / calm
    var quietPeriod: TimeInterval = 90      // after 2 consecutive bubbles (doc §8.2)
    var idleEntertainAfter: TimeInterval = 25

    private var lastSpeak: TimeInterval = -.greatestFiniteMagnitude
    private var lastActivity: TimeInterval = 0
    private var consecutive = 0
    private var quietUntil: TimeInterval = 0

    /// Base interval scaled by engagement and context talkativeness.
    func speakInterval(engagement: Double, context: BehaviorContext) -> TimeInterval {
        let e = max(0, min(1, engagement))
        let base = maxInterval - (maxInterval - minInterval) * e
        return base * context.talkativenessMultiplier
    }

    /// Call when the user responds (pet/drag) — exits quiet period, resets the consecutive run.
    func registerInteraction(now: TimeInterval) {
        consecutive = 0
        quietUntil = 0
        lastActivity = now
    }

    func decide(now: TimeInterval,
                context: BehaviorContext,
                engagement: Double,
                roll: @autoclosure () -> Double) -> ProactiveDecision {
        // Hard convergence: stay visual-only, never speak; may quietly self-entertain.
        if context.shouldConverge {
            consecutive = 0
            return idleDecision(now: now, roll: roll())
        }
        if now < quietUntil { return idleDecision(now: now, roll: roll()) }

        if now - lastSpeak >= speakInterval(engagement: engagement, context: context) {
            lastSpeak = now
            lastActivity = now
            consecutive += 1
            if consecutive >= 2 { quietUntil = now + quietPeriod; consecutive = 0 }
            return .speak(SpeechLibrary.pickCategory(roll: roll()))
        }
        return idleDecision(now: now, roll: roll())
    }

    /// When the user has been ignoring the pet, it entertains itself (doc §8.1 转为看书/睡觉/自己玩).
    private func idleDecision(now: TimeInterval, roll: Double) -> ProactiveDecision {
        guard now - lastActivity >= idleEntertainAfter else { return .none }
        lastActivity = now
        let kinds: [IdleKind] = [.read, .sleep, .play]
        return .idleEntertain(kinds[min(kinds.count - 1, Int(roll * Double(kinds.count)))])
    }
}
