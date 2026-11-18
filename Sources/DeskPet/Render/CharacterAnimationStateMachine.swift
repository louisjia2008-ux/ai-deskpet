import CoreGraphics
import Foundation

@MainActor
final class CharacterAnimationStateMachine {
    private(set) var state: CharacterAnimationState = .loading
    private(set) var emotion: CharacterAnimationEmotion = .neutral
    private(set) var currentIntent: CharacterAnimationIntent?
    private var lastStableState: CharacterAnimationState = .idle
    private var lastAcceptedByKey: [String: TimeInterval] = [:]
    private let reactionCooldown: TimeInterval

    init(reactionCooldown: TimeInterval = CharacterAnimationConfig.default.reactions.cooldown) {
        self.reactionCooldown = reactionCooldown
    }

    @discardableResult
    func apply(_ intent: CharacterAnimationIntent, now: TimeInterval) -> Bool {
        if intent.state == .reacting || intent.source == .userInteraction {
            let key = "\(intent.source.rawValue)-\(intent.state.rawValue)-\(intent.emotion?.rawValue ?? "none")"
            if let last = lastAcceptedByKey[key], now - last < reactionCooldown {
                return false
            }
            lastAcceptedByKey[key] = now
        }

        if let currentIntent {
            switch intent.interruptPolicy {
            case .ignoreIfLowerPriority, .interruptLowerPriority:
                if intent.priority < currentIntent.priority { return false }
            case .replaceSameKind:
                if intent.state != currentIntent.state && intent.priority < currentIntent.priority { return false }
            case .alwaysInterrupt:
                break
            }

            if state == .dragged && intent.state != .landing && intent.priority < CharacterAnimationIntent.defaultPriority(for: .dragged) {
                return false
            }
            if state == .speaking && intent.state == .sleeping {
                return false
            }
        }

        if isStable(state) {
            lastStableState = state
        }
        currentIntent = intent
        state = intent.state
        if let e = intent.emotion { emotion = e }
        return true
    }

    func update(now: TimeInterval) {
        guard let intent = currentIntent else {
            if state == .loading { state = .idle }
            return
        }
        guard let duration = intent.duration, now - intent.createdAt >= duration else { return }
        let next = nextStateAfterExpiring(intent)
        currentIntent = nil
        state = next
    }

    func forceIdle() {
        currentIntent = nil
        state = .idle
    }

    private func nextStateAfterExpiring(_ intent: CharacterAnimationIntent) -> CharacterAnimationState {
        switch intent.state {
        case .dragged:
            return .landing
        case .landing, .reacting, .listening, .thinking, .speaking, .falling,
             .blink, .idleLookAround, .greet, .jump, .taskFailed,
             .look000, .look0225, .look045, .look0675,
             .look090, .look1125, .look135, .look1575,
             .look180, .look2025, .look225, .look2475,
             .look270, .look2925, .look315, .look3375,
             .startMoving, .startMovingLeft, .startMovingRight,
             .stopMoving, .stopMovingLeft, .stopMovingRight,
             .turnLeftToFront, .turnRightToFront:
            return isStable(lastStableState) ? lastStableState : .idle
        case .walkLeft, .walkRight, .briskWalkLeft, .briskWalkRight, .runLeft, .runRight:
            return intent.state
        case .taskWaiting, .taskRunning, .taskReview:
            return intent.state
        case .loading, .idle, .sleeping, .unavailable:
            return .idle
        }
    }

    private func isStable(_ state: CharacterAnimationState) -> Bool {
        switch state {
        case .idle, .sleeping: return true
        default: return false
        }
    }
}

struct CharacterAnimationMixer {
    var config: CharacterAnimationConfig

    func pose(elapsed: TimeInterval,
              state: CharacterAnimationState,
              emotion: CharacterAnimationEmotion,
              intent: CharacterAnimationIntent?,
              speakingLevel: Float,
              dragVelocity: CGVector,
              reduceMotion: Bool) -> CharacterPose {
        let motionScale = reduceMotion ? 0.35 : 1
        var pose = CharacterPose.canonical

        let breathAmplitude = reduceMotion ? config.breathing.reduceMotionAmplitude : config.breathing.amplitude
        let breathRate = (state == .sleeping) ? config.sleep.idleRate : 1
        let breathPhase = sin(elapsed * (Double.pi * 2 / 3.6) * breathRate)
        pose.scaleY *= CGFloat(1 + breathPhase * breathAmplitude)
        pose.scaleX *= CGFloat(1 - breathPhase * breathAmplitude * 0.22)

        if state != .dragged && state != .falling {
            let idleAngle = degreesToRadians(1.1 * motionScale) * CGFloat(sin(elapsed * 0.55) * 0.7 + sin(elapsed * 0.23) * 0.3)
            pose.rotation += idleAngle
            let micro = CGFloat(config.idle.microMovementPoints * motionScale)
            pose.offset.x += CGFloat(sin(elapsed * 0.41)) * micro
        }

        switch state {
        case .blink:
            // P19.3 — bumped from 0.018 (1.8% compression) to 0.035 (3.5%
            // compression) so the blink reads as a real eye-close on a
            // 192-208 pt character at typical desktop distance. Combined
            // with the inverse 0.014 horizontal bulge (was 0.008) the
            // squash reads as a brief eye-close without becoming twitchy.
            // Still bounded — no anchor jump, no head movement, no face
            // scale change beyond a momentary 3.5% Y squash. Duration
            // matches the scheduler's intent duration (0.14 s) so the
            // visual curve completes in lockstep with FSM expiration.
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 0.14)
            let close = sin(progress * Double.pi)
            pose.scaleY *= CGFloat(1 - 0.035 * close)
            pose.scaleX *= CGFloat(1 + 0.014 * close)
        case .idleLookAround:
            // P19.3 — slightly more pronounced than P18 (3.5 pt X-offset
            // sway + 1.6° rotation wobble) so the look-around reads as
            // turning the head, not just body sway. Still bounded — no
            // anchor jump, no clip transition. Duration matches the
            // scheduler's intent duration (0.8 s).
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 0.8)
            pose.offset.x += CGFloat(sin(progress * Double.pi * 2)) * CGFloat(3.5 * motionScale)
            pose.rotation += degreesToRadians(1.6 * motionScale) * CGFloat(sin(progress * Double.pi))
        case .greet:
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 0.7)
            pose.offset.x += CGFloat(sin(progress * Double.pi * 2)) * CGFloat(1.6 * motionScale)
            pose.rotation += degreesToRadians(1.6 * motionScale) * CGFloat(sin(progress * Double.pi * 2))
        case .jump:
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 0.75)
            pose.offset.y += CGFloat(sin(progress * Double.pi) * config.reactions.happyJumpHeight) * CGFloat(motionScale)
            pose.scaleY *= CGFloat(1 + 0.025 * sin(progress * Double.pi * 2))
            pose.scaleX *= CGFloat(1 - 0.016 * sin(progress * Double.pi * 2))
        case .taskWaiting:
            pose.offset.y += CGFloat(sin(elapsed * 2.0) * 1.2 * motionScale)
            pose.rotation += degreesToRadians(0.9 * motionScale) * CGFloat(sin(elapsed * 1.1))
        case .taskRunning:
            pose.offset.x += CGFloat(sin(elapsed * 8.0) * 0.8 * motionScale)
            pose.rotation += degreesToRadians(1.0 * motionScale) * CGFloat(sin(elapsed * 5.0))
        case .taskReview:
            pose.rotation += degreesToRadians(1.0 * motionScale) * CGFloat(sin(elapsed * 0.9))
        case .taskFailed:
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 1.1)
            pose.offset.y -= CGFloat(1.8 * sin(progress * Double.pi)) * CGFloat(motionScale)
            pose.rotation -= degreesToRadians(1.6 * motionScale) * CGFloat(sin(progress * Double.pi))
        case .look000, .look0225, .look045, .look0675,
             .look090, .look1125, .look135, .look1575,
             .look180, .look2025, .look225, .look2475,
             .look270, .look2925, .look315, .look3375:
            break
        case .startMoving, .startMovingLeft, .startMovingRight:
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 0.22)
            let lean = sin(progress * Double.pi / 2)
            pose.rotation -= degreesToRadians(2.6 * motionScale) * CGFloat(lean)
            pose.scaleY *= CGFloat(1 - 0.018 * sin(progress * Double.pi))
            pose.scaleX *= CGFloat(1 + 0.012 * sin(progress * Double.pi))
            pose.offset.y += CGFloat(1.5 * sin(progress * Double.pi) * motionScale)
        case .walkLeft, .walkRight, .briskWalkLeft, .briskWalkRight, .runLeft, .runRight:
            let tier = intent?.speedTier ?? state.defaultSpeedTier
            let strideRate: Double
            switch tier {
            case .idle: strideRate = 1.2
            case .slowWalk: strideRate = 1.45
            case .walk: strideRate = 1.8
            case .briskWalk: strideRate = 2.15
            case .run: strideRate = 2.65
            }
            let stridePhase = elapsed * 2 * Double.pi * strideRate
            pose.offset.x += CGFloat(sin(stridePhase) * 1.1 * motionScale)
            pose.rotation += degreesToRadians((tier == .run ? 1.4 : 0.9) * motionScale) * CGFloat(sin(stridePhase))
        case .stopMoving, .stopMovingLeft, .stopMovingRight:
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: 0.28)
            let settle = sin(progress * Double.pi)
            pose.offset.y += CGFloat(1.8 * settle * motionScale)
            pose.rotation += degreesToRadians(1.2 * motionScale) * CGFloat((1 - progress) * sin(progress * Double.pi))
            pose.scaleY *= CGFloat(1 - 0.02 * settle)
            pose.scaleX *= CGFloat(1 + 0.012 * settle)
        case .turnLeftToFront, .turnRightToFront:
            break
        case .thinking:
            pose.rotation += degreesToRadians(1.4 * motionScale) * CGFloat(sin(elapsed * 1.25))
        case .speaking:
            let level = max(CGFloat(speakingLevel), CGFloat(config.speaking.textFallbackLevel))
            let amp = CGFloat(config.speaking.motionAmplitude) * level * CGFloat(motionScale)
            pose.scaleY *= 1 + CGFloat(sin(elapsed * 8.0)) * amp
            pose.scaleX *= 1 - CGFloat(sin(elapsed * 8.0)) * amp * 0.35
        case .sleeping:
            pose.offset.y -= CGFloat(config.sleep.sinkPoints) * CGFloat(motionScale)
            pose.rotation -= degreesToRadians(1.8 * motionScale)
        case .dragged:
            let speedX = max(-600, min(600, dragVelocity.dx))
            let tilt = (speedX / 600) * config.drag.tiltLimitDegrees
            pose.rotation += degreesToRadians(tilt)
            pose.scaleY *= 1.0 + CGFloat(config.breathing.reduceMotionAmplitude * 0.4 * sin(elapsed * 2.0))
        case .landing:
            let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: config.drag.releaseDuration)
            let bounce = sin(progress * Double.pi) * (reduceMotion ? 0.18 : 1)
            pose.scaleY *= CGFloat(1 - 0.035 * bounce)
            pose.scaleX *= CGFloat(1 + 0.025 * bounce)
        case .reacting:
            applyReaction(to: &pose, elapsed: elapsed, emotion: emotion, intent: intent, reduceMotion: reduceMotion)
        case .loading, .idle, .listening, .falling, .unavailable:
            break
        }

        return pose
    }

    private func applyReaction(to pose: inout CharacterPose,
                               elapsed: TimeInterval,
                               emotion: CharacterAnimationEmotion,
                               intent: CharacterAnimationIntent?,
                               reduceMotion: Bool) {
        let progress = actionProgress(intent: intent, elapsed: elapsed, fallbackDuration: config.reactions.maxDuration)
        let intensity = CGFloat(intent?.intensity ?? 1) * (reduceMotion ? 0.35 : 1)
        switch emotion {
        case .happy:
            let lift = sin(progress * Double.pi) * config.reactions.happyJumpHeight
            pose.offset.y += CGFloat(lift) * intensity
            pose.scaleY *= 1 + CGFloat(0.03 * sin(progress * Double.pi * 2)) * intensity
            pose.scaleX *= 1 - CGFloat(0.02 * sin(progress * Double.pi * 2)) * intensity
        case .annoyed:
            pose.offset.x += CGFloat(sin(progress * Double.pi * 8) * config.reactions.annoyedShakePoints) * intensity
        case .sad:
            pose.offset.y -= 2 * intensity
            pose.rotation -= degreesToRadians(1.3) * intensity
        case .sleepy:
            pose.offset.y -= CGFloat(config.sleep.sinkPoints) * intensity
        case .surprised:
            pose.scaleY *= 1 + 0.025 * intensity
        case .curious:
            pose.rotation += degreesToRadians(1.8) * intensity * CGFloat(sin(progress * Double.pi))
        case .neutral:
            let squash = CGFloat(config.reactions.clickCompression) * intensity * CGFloat(sin(progress * Double.pi))
            pose.scaleY *= 1 - squash
            pose.scaleX *= 1 + squash * 0.45
        }
    }

    private func actionProgress(intent: CharacterAnimationIntent?, elapsed: TimeInterval, fallbackDuration: TimeInterval) -> Double {
        let createdAt = intent?.createdAt ?? elapsed
        let duration = max(intent?.duration ?? fallbackDuration, 0.001)
        return max(0, min(1, (elapsed - createdAt) / duration))
    }

    private func degreesToRadians(_ degrees: Double) -> CGFloat {
        CGFloat(degrees * .pi / 180)
    }
}

private extension CharacterAnimationState {
    var defaultSpeedTier: CharacterLocomotionSpeedTier {
        switch self {
        case .briskWalkLeft, .briskWalkRight:
            return .briskWalk
        case .runLeft, .runRight:
            return .run
        case .walkLeft, .walkRight:
            return .walk
        default:
            return .idle
        }
    }
}
