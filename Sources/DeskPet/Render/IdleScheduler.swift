import Foundation

/// P19.3 — Idle presence scheduler.
///
/// Extracted from `StaticPNGCharacterRenderer.scheduleAmbientIdleIfNeeded` so
/// the timing rules can be unit-tested without instantiating the SpriteKit
/// renderer. The struct holds no AppKit / SpriteKit state and is safe to
/// test in isolation with an injected deterministic RNG.
///
/// Design principles (per P19.3 §6):
/// - Mostly calm: large lower bound on intervals
/// - Small bounded micro-motion: amplitudes are capped
/// - Occasional blink + occasional look-around
/// - No attention-demanding animation
///
/// Rules enforced:
/// - RandomNumberGenerator seam — tests inject deterministic RNG
/// - Post-sustained settle debounce — after leaving a sustained state the
///   scheduler waits at least `postSustainedSettle` seconds before firing
///   any ambient intent (otherwise a long agent activity followed by idle
///   would immediately fire a blink or look-around)
/// - Minimum spacing between consecutive ambient events
/// - Priority gate is enforced at the call-site (FSM); here we only emit
///   `IdlePresenceEvent` records the caller decides what to do with
struct IdleScheduler {
    var blinkIntervalRange: ClosedRange<TimeInterval> = 2.4...5.8
    var blinkInitialIntervalRange: ClosedRange<TimeInterval> = 2.2...5.0
    var lookAroundIntervalRange: ClosedRange<TimeInterval> = 7.0...13.0
    var lookAroundInitialIntervalRange: ClosedRange<TimeInterval> = 5.5...11.0
    var postSustainedSettle: TimeInterval = 0.4
    var ambientEventSpacing: TimeInterval = 1.5

    private var rng: any RandomNumberGenerator & Sendable
    private(set) var nextBlinkAt: TimeInterval
    private(set) var nextLookAroundAt: TimeInterval
    private(set) var lastAmbientAt: TimeInterval = -.infinity
    private(set) var lastNonIdleAt: TimeInterval = -.infinity

    init(rng: any RandomNumberGenerator & Sendable,
         now: TimeInterval = 0) {
        var rng = rng
        self.rng = rng
        self.nextBlinkAt = now + IdleScheduler.randomDouble(in: 2.2...5.0, using: &rng)
        self.nextLookAroundAt = now + IdleScheduler.randomDouble(in: 5.5...11.0, using: &rng)
    }

    /// Convenience initializer using a deterministic seed (for tests).
    init(seed: UInt64 = 0xC0FFEE_BEEF, now: TimeInterval = 0) {
        self.init(rng: SeedableLinearRNG(seed: seed), now: now)
    }

    mutating func noteNonIdle(at now: TimeInterval) {
        lastNonIdleAt = now
    }

    /// Tick the scheduler. Returns the next idle-presence event (if any).
    ///
    /// `state == .idle` is enforced here. Any other state (locomotion,
    /// agent-sustained, user interaction) suppresses ambient emission.
    /// The caller is still expected to track non-idle entry via
    /// `noteNonIdle(at:)` for the post-sustained settle debounce.
    mutating func tick(now: TimeInterval, state: CharacterAnimationState) -> IdlePresenceEvent? {
        // State gate: only emit while the character is in .idle. Anything
        // else (walk, agent-sustained, user interaction, blink/lookAround
        // themselves) suppresses ambient.
        guard state == .idle else { return nil }
        // Post-sustained settle: after leaving a non-idle state we hold
        // off any ambient event for postSustainedSettle seconds. The
        // scheduler treats the moment of exit as "settle start".
        let settleUntil = lastNonIdleAt + postSustainedSettle
        let inSettle = now < settleUntil
        // Spacing rule: ambient events must be at least ambientEventSpacing
        // apart so blink and look-around do not overlap in the same beat.
        let spacingOk = (now - lastAmbientAt) >= ambientEventSpacing
        guard !inSettle, spacingOk else { return nil }
        if now >= nextBlinkAt {
            nextBlinkAt = now + IdleScheduler.randomDouble(in: blinkIntervalRange, using: &rng)
            lastAmbientAt = now
            return .blink
        }
        if now >= nextLookAroundAt {
            nextLookAroundAt = now + IdleScheduler.randomDouble(in: lookAroundIntervalRange, using: &rng)
            lastAmbientAt = now
            return .lookAround
        }
        return nil
    }

    /// Reset the interval timers (used by tests).
    mutating func reset(now: TimeInterval = 0) {
        nextBlinkAt = now + IdleScheduler.randomDouble(in: blinkInitialIntervalRange, using: &rng)
        nextLookAroundAt = now + IdleScheduler.randomDouble(in: lookAroundInitialIntervalRange, using: &rng)
        lastAmbientAt = -.infinity
        lastNonIdleAt = -.infinity
    }

    static func randomDouble<G: RandomNumberGenerator>(in range: ClosedRange<Double>, using rng: inout G) -> Double {
        let n = Double(rng.next() >> 11) / Double(1 << 53)
        return range.lowerBound + (range.upperBound - range.lowerBound) * n
    }
}

enum IdlePresenceEvent: Equatable {
    case blink
    case lookAround
}

/// P19.3 — Lightweight deterministic RNG. NOT cryptographically secure.
/// Use only for idle-presence scheduling and tests.
struct SeedableLinearRNG: RandomNumberGenerator, Sendable {
    private var state: UInt64

    init(seed: UInt64) {
        self.state = seed == 0 ? 0xDEAD_BEEF_CAFE_F00D : seed
    }

    mutating func next() -> UInt64 {
        // xorshift64 — adequate for non-crypto scheduling.
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }
}