import CoreGraphics
import Foundation

enum CharacterLocomotionPhase: Equatable {
    case idle
    case starting(target: CharacterLocomotionTarget, startedAt: TimeInterval)
    case walking(target: CharacterLocomotionTarget)
    case stopping(direction: CharacterLocomotionDirection, startedAt: TimeInterval, nextTarget: CharacterLocomotionTarget?)
    case returningToFront(direction: CharacterLocomotionDirection, startedAt: TimeInterval)
}

struct CharacterLocomotionTarget: Equatable {
    var direction: CharacterLocomotionDirection
    var speedTier: CharacterLocomotionSpeedTier
    var speedPointsPerSecond: Double
}

struct CharacterLocomotionTiming: Equatable {
    var startDuration: TimeInterval = 0.6
    var stopDuration: TimeInterval = 0.6
    var turnToFrontDuration: TimeInterval = 0.6
    var enterWalkingDelay: TimeInterval = 0.12
    var returnIdleDelay: TimeInterval = 0.18
}

struct CharacterLocomotionSpeedThresholds: Equatable {
    var idle: Double = 5
    var slowWalk: Double = 35
    var walk: Double = 85
    var briskWalk: Double = 130

    func tier(for speed: Double) -> CharacterLocomotionSpeedTier {
        switch max(0, speed) {
        case ..<idle:
            return .idle
        case ..<slowWalk:
            return .slowWalk
        case ..<walk:
            return .walk
        case ..<briskWalk:
            return .briskWalk
        default:
            return .run
        }
    }
}

/// Converts high-level desktop movement into visual clip states.
/// Root motion stays in PetStateMachine; this controller only selects animation.
final class CharacterLocomotionController {
    private(set) var phase: CharacterLocomotionPhase = .idle
    private let timing: CharacterLocomotionTiming
    private let thresholds: CharacterLocomotionSpeedThresholds
    private var aboveWalkSince: TimeInterval?
    private var belowIdleSince: TimeInterval?
    private var pendingTarget: CharacterLocomotionTarget?

    init(timing: CharacterLocomotionTiming = CharacterLocomotionTiming(),
         thresholds: CharacterLocomotionSpeedThresholds = CharacterLocomotionSpeedThresholds()) {
        self.timing = timing
        self.thresholds = thresholds
    }

    func update(activity: PetActivity,
                facing: CGFloat,
                speedPointsPerSecond: Double = 0,
                now: TimeInterval) -> CharacterAnimationIntent? {
        switch activity {
        case .wander, .recalling:
            return move(direction: normalized(facing), speedPointsPerSecond: speedPointsPerSecond, now: now)
        case .idle:
            return stop(now: now)
        case .pickedUp, .falling:
            phase = .idle
            return nil
        }
    }

    /// True while the controller is in the steady walking phase (used by PetScene to re-issue the
    /// walk visual after a higher-priority agent intent has expired mid-walk).
    var isWalking: Bool {
        if case .walking = phase { return true }
        return false
    }

    /// Re-issue the current walk intent. Returns nil unless the controller is `.walking` so it
    /// never resurrects a stray `.walking` after the locomotion has transitioned to `.stopping`/.
    /// `.idle`. p35 — the renderer's FSM rejects this while a legit higher-priority intent is active.
    func reassertWalkingIntent(now: TimeInterval) -> CharacterAnimationIntent? {
        guard case let .walking(target) = phase else { return nil }
        return moveIntent(target: target, now: now)
    }

    func tick(now: TimeInterval) -> CharacterAnimationIntent? {
        switch phase {
        case .starting(let target, let startedAt) where now - startedAt >= timing.startDuration:
            phase = .walking(target: target)
            return moveIntent(target: target, now: now)
        case .stopping(let direction, let startedAt, let nextTarget) where now - startedAt >= timing.stopDuration:
            if let nextTarget {
                phase = .starting(target: nextTarget, startedAt: now)
                return startIntent(target: nextTarget, now: now)
            } else if timing.turnToFrontDuration > 0 {
                // P19.2 — both left and right stops now route through the
                // turn animation (left → `turnLeftToFront`, right →
                // `turnRightToFront`). The pre-P19.2 implementation only
                // turned left; right stops snapped straight to idle. With
                // the CharacterV2 clip bridge synthesising the right mirror,
                // we can now offer the symmetric behaviour.
                phase = .returningToFront(direction: direction, startedAt: now)
                return turnToFrontIntent(direction: direction, now: now)
            } else {
                phase = .idle
                return CharacterAnimationIntent(state: .idle,
                                                priority: CharacterAnimationIntent.defaultPriority(for: .idle),
                                                source: .desktopInteraction,
                                                createdAt: now)
            }
        case .returningToFront(_, let startedAt) where now - startedAt >= timing.turnToFrontDuration:
            phase = .idle
            return CharacterAnimationIntent(state: .idle,
                                            priority: CharacterAnimationIntent.defaultPriority(for: .idle),
                                            source: .desktopInteraction,
                                            createdAt: now)
        default:
            return nil
        }
    }

    func cancel() {
        phase = .idle
    }

    func speedTier(for speedPointsPerSecond: Double) -> CharacterLocomotionSpeedTier {
        thresholds.tier(for: speedPointsPerSecond)
    }

    private func move(direction: CharacterLocomotionDirection,
                      speedPointsPerSecond: Double,
                      now: TimeInterval) -> CharacterAnimationIntent? {
        let target = CharacterLocomotionTarget(direction: direction,
                                               speedTier: speedTier(for: speedPointsPerSecond),
                                               speedPointsPerSecond: speedPointsPerSecond)
        guard target.speedTier != .idle else {
            aboveWalkSince = nil
            pendingTarget = nil
            return stop(now: now)
        }
        belowIdleSince = nil

        switch phase {
        case .idle:
            guard walkingHysteresisSatisfied(for: target, now: now) else { return nil }
            phase = .starting(target: target, startedAt: now)
            return startIntent(target: target, now: now)
        case .returningToFront:
            guard walkingHysteresisSatisfied(for: target, now: now) else { return nil }
            phase = .starting(target: target, startedAt: now)
            return startIntent(target: target, now: now)
        case .stopping(_, _, _):
            guard walkingHysteresisSatisfied(for: target, now: now) else { return nil }
            phase = .starting(target: target, startedAt: now)
            return startIntent(target: target, now: now)
        case .starting(let current, _) where current.direction != target.direction || current.speedTier != target.speedTier:
            phase = .starting(target: target, startedAt: now)
            return startIntent(target: target, now: now)
        case .walking(let current) where current.direction != target.direction:
            phase = .stopping(direction: current.direction, startedAt: now, nextTarget: target)
            return stopIntent(direction: current.direction, now: now)
        case .walking(let current) where current.speedTier != target.speedTier:
            phase = .walking(target: target)
            return moveIntent(target: target, now: now)
        default:
            return nil
        }
    }

    private func stop(now: TimeInterval) -> CharacterAnimationIntent? {
        switch phase {
        case .starting(let target, _), .walking(let target):
            aboveWalkSince = nil
            pendingTarget = nil
            if timing.returnIdleDelay > 0 {
                if belowIdleSince == nil {
                    belowIdleSince = now
                    return nil
                }
                guard let belowIdleSince, now - belowIdleSince >= timing.returnIdleDelay else {
                    return nil
                }
            }
            self.belowIdleSince = nil
            phase = .stopping(direction: target.direction, startedAt: now, nextTarget: nil)
            return stopIntent(direction: target.direction, now: now)
        default:
            belowIdleSince = nil
            return nil
        }
    }

    private func walkingHysteresisSatisfied(for target: CharacterLocomotionTarget,
                                            now: TimeInterval) -> Bool {
        if pendingTarget != target {
            pendingTarget = target
            aboveWalkSince = now
            return timing.enterWalkingDelay <= 0
        }
        guard let aboveWalkSince else {
            self.aboveWalkSince = now
            return timing.enterWalkingDelay <= 0
        }
        return now - aboveWalkSince >= timing.enterWalkingDelay
    }

    private func startIntent(target: CharacterLocomotionTarget, now: TimeInterval) -> CharacterAnimationIntent {
        CharacterAnimationIntent(state: target.direction == .left ? .startMovingLeft : .startMovingRight,
                                 locomotionDirection: target.direction,
                                 speedTier: target.speedTier,
                                 speedPointsPerSecond: target.speedPointsPerSecond,
                                 priority: 35,
                                 duration: timing.startDuration,
                                 source: .desktopInteraction,
                                 createdAt: now)
    }

    private func stopIntent(direction: CharacterLocomotionDirection, now: TimeInterval) -> CharacterAnimationIntent {
        CharacterAnimationIntent(state: direction == .left ? .stopMovingLeft : .stopMovingRight,
                                 locomotionDirection: direction,
                                 priority: 35,
                                 duration: timing.stopDuration,
                                 source: .desktopInteraction,
                                 createdAt: now)
    }

    private func turnToFrontIntent(direction: CharacterLocomotionDirection, now: TimeInterval) -> CharacterAnimationIntent {
        // P19.2 — emit the direction-correct turn state. The previous
        // implementation always emitted `.turnLeftToFront` even for
        // right-direction stops (an asymmetry documented in the
        // CharacterLocomotionController audit). The CharacterV2 clip
        // bridge synthesizes a `turn_right_to_front` mirror clip so the
        // direction now resolves to a distinct (mirrored) animation.
        CharacterAnimationIntent(state: direction == .left ? .turnLeftToFront : .turnRightToFront,
                                 locomotionDirection: direction,
                                 priority: 35,
                                 duration: timing.turnToFrontDuration,
                                 source: .desktopInteraction,
                                 createdAt: now)
    }

    private func moveIntent(target: CharacterLocomotionTarget, now: TimeInterval) -> CharacterAnimationIntent {
        CharacterAnimationIntent(state: state(for: target),
                                 locomotionDirection: target.direction,
                                 speedTier: target.speedTier,
                                 speedPointsPerSecond: target.speedPointsPerSecond,
                                 priority: 35,
                                 source: .desktopInteraction,
                                 createdAt: now)
    }

    private func state(for target: CharacterLocomotionTarget) -> CharacterAnimationState {
        switch (target.direction, target.speedTier) {
        case (.left, .briskWalk):
            return .briskWalkLeft
        case (.right, .briskWalk):
            return .briskWalkRight
        case (.left, .run):
            return .runLeft
        case (.right, .run):
            return .runRight
        case (.left, _):
            return .walkLeft
        case (.right, _):
            return .walkRight
        }
    }

    private func normalized(_ direction: CGFloat) -> CharacterLocomotionDirection {
        direction < 0 ? .left : .right
    }
}
