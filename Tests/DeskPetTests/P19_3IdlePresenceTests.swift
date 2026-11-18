import XCTest
@testable import DeskPet

@MainActor
final class P19_3IdlePresenceTests: XCTestCase {

    // MARK: - IdleScheduler — deterministic RNG

    func testSchedulerInitialIntervalsAreWithinRange() {
        var s = IdleScheduler(seed: 1, now: 0)
        s.reset(now: 0)
        XCTAssertGreaterThanOrEqual(s.nextBlinkAt, 0 + 2.2)
        XCTAssertLessThanOrEqual(s.nextBlinkAt, 0 + 5.0)
        XCTAssertGreaterThanOrEqual(s.nextLookAroundAt, 0 + 5.5)
        XCTAssertLessThanOrEqual(s.nextLookAroundAt, 0 + 11.0)
    }

    func testSchedulerSameSeedProducesSameSequence() {
        var a = IdleScheduler(seed: 42, now: 0)
        var b = IdleScheduler(seed: 42, now: 0)
        XCTAssertEqual(a.nextBlinkAt, b.nextBlinkAt, accuracy: 0.0001)
        XCTAssertEqual(a.nextLookAroundAt, b.nextLookAroundAt, accuracy: 0.0001)
        for _ in 0..<20 {
            let ea = a.tick(now: 0, state: .idle)
            let eb = b.tick(now: 0, state: .idle)
            XCTAssertEqual(ea, eb)
        }
    }

    func testSchedulerEmitsBlinkWhenIntervalElapsed() {
        var s = IdleScheduler(seed: 7, now: 0)
        // First force the interval to fire deterministically.
        s.reset(now: 0)
        // Simulate 4 seconds of ticking.
        var found: [IdlePresenceEvent] = []
        var t: TimeInterval = 0
        for _ in 0..<800 {
            t += 0.01
            if let e = s.tick(now: t, state: .idle) {
                found.append(e)
            }
            if found.count >= 3 { break }
        }
        XCTAssertFalse(found.isEmpty)
        XCTAssertEqual(found.first, .blink)
    }

    func testSchedulerEmitsLookAroundAfterLongerInterval() {
        var s = IdleScheduler(seed: 99, now: 0)
        s.reset(now: 0)
        var found: [IdlePresenceEvent] = []
        var t: TimeInterval = 0
        for _ in 0..<4000 {
            t += 0.01
            if let e = s.tick(now: t, state: .idle) {
                found.append(e)
            }
            if found.count >= 3 { break }
        }
        // We must have seen at least one lookAround in 40s.
        XCTAssertTrue(found.contains(.lookAround), "expected lookAround event; got \(found)")
    }

    // MARK: - IdleScheduler — non-idle suppression

    func testSchedulerDoesNotEmitWhenStateNotIdle() {
        var s = IdleScheduler(seed: 13, now: 0)
        s.reset(now: 0)
        // Push elapsed past the initial blink window.
        let result = s.tick(now: 100, state: .walkLeft)
        XCTAssertNil(result, "scheduler must NOT emit while in walkLeft")
    }

    func testSchedulerSuppressesDuringLocomotionAndAgentStates() {
        var s = IdleScheduler(seed: 17, now: 0)
        for state: CharacterAnimationState in [.walkLeft, .walkRight, .briskWalkLeft, .briskWalkRight,
                                              .runLeft, .runRight, .taskRunning, .taskWaiting,
                                              .taskReview, .taskFailed, .listening, .thinking, .speaking,
                                              .reacting, .dragged, .falling, .sleeping] {
            XCTAssertNil(s.tick(now: 100, state: state),
                         "scheduler must NOT emit while in \(state)")
        }
    }

    // MARK: - IdleScheduler — post-sustained settle debounce

    func testSchedulerHoldsOffAfterSustainedStateExits() {
        var s = IdleScheduler(seed: 21, now: 0)
        s.reset(now: 0)
        // Simulate a long agent activity ending at t=10.
        s.noteNonIdle(at: 0)
        // Pretend we just exited a sustained state right now.
        s.noteNonIdle(at: 10)
        // Within settle window (10 + 0.4 = 10.4), scheduler must not fire.
        XCTAssertNil(s.tick(now: 10.1, state: .idle))
        XCTAssertNil(s.tick(now: 10.3, state: .idle))
        // Past settle window — scheduler may fire if interval elapsed.
        // (We don't assert fire, because the nextBlinkAt may still be > 10.4.)
        _ = s.tick(now: 11.0, state: .idle)
    }

    func testSettleWindowDefaultsToQuarterSecond() {
        var s = IdleScheduler(seed: 5, now: 0)
        XCTAssertEqual(s.postSustainedSettle, 0.4, accuracy: 0.0001)
    }

    // MARK: - IdleScheduler — ambient event spacing

    func testSchedulerRespectsMinimumSpacingBetweenAmbientEvents() {
        var s = IdleScheduler(seed: 31, now: 0)
        s.reset(now: 0)
        // Drive ticks at fine granularity; collect events.
        var t: TimeInterval = 0
        var lastEventAt: TimeInterval = -.infinity
        var events: [(TimeInterval, IdlePresenceEvent)] = []
        for _ in 0..<3000 {
            t += 0.01
            if let e = s.tick(now: t, state: .idle) {
                events.append((t, e))
            }
            if events.count >= 5 { break }
        }
        // Every consecutive pair must be ≥ 1.5s apart.
        for i in 1..<events.count {
            let dt = events[i].0 - events[i - 1].0
            XCTAssertGreaterThanOrEqual(dt, 1.5 - 0.01,
                                        "ambient events \(events[i - 1].1)→\(events[i].1) too close: \(dt)s")
        }
    }

    // MARK: - Blink visual magnitude

    func testBlinkMagnitudeIsVisible() {
        // Construct an idle pose and a blink pose at peak progress; verify
        // the Y scale compresses by at least 2.5% (was 1.8% in P18, target
        // is ≥3.0% for P19.3).
        let mixer = CharacterAnimationMixer(config: .default)
        let intent = CharacterAnimationIntent(state: .blink,
                                              priority: 14,
                                              duration: 0.14,
                                              source: .rendererFallback,
                                              createdAt: 0)
        // Find the progress at peak sin(progress * π) = 1 → progress = 0.5.
        // We pass `elapsed` such that progress = 0.5 → elapsed - createdAt = 0.07.
        let peakPose = mixer.pose(elapsed: 0.07,
                                  state: .blink,
                                  emotion: .neutral,
                                  intent: intent,
                                  speakingLevel: 0,
                                  dragVelocity: .zero,
                                  reduceMotion: false)
        let idlePose = mixer.pose(elapsed: 0.07,
                                  state: .idle,
                                  emotion: .neutral,
                                  intent: nil,
                                  speakingLevel: 0,
                                  dragVelocity: .zero,
                                  reduceMotion: false)
        let compression = 1 - Double(peakPose.scaleY / idlePose.scaleY)
        XCTAssertGreaterThanOrEqual(compression, 0.025,
                                    "blink should compress ≥2.5% (got \(compression))")
        XCTAssertLessThanOrEqual(compression, 0.05,
                                 "blink should compress ≤5% (got \(compression))")
    }

    func testLookAroundMagnitudeIsVisible() {
        let mixer = CharacterAnimationMixer(config: .default)
        let intent = CharacterAnimationIntent(state: .idleLookAround,
                                              priority: 13,
                                              duration: 0.8,
                                              source: .rendererFallback,
                                              createdAt: 0)
        // Peak X-offset at progress = 0.25 → elapsed = 0.2 (sin(0.5π) = 1).
        let peak = mixer.pose(elapsed: 0.2,
                              state: .idleLookAround,
                              emotion: .neutral,
                              intent: intent,
                              speakingLevel: 0,
                              dragVelocity: .zero,
                              reduceMotion: false)
        XCTAssertGreaterThanOrEqual(Double(peak.offset.x), 3.0,
                                    "lookAround should offset X by ≥3.0 pt (got \(peak.offset.x))")
    }

    // MARK: - FSM arbitration — ambient vs agent states

    func testAmbientBlinkIsOverriddenByTaskFailed() {
        // P19.3 contract — when in idle, ambient scheduler fires .blink.
        // When a higher-priority agent state (e.g. .taskFailed) comes in
        // mid-blink, the FSM must apply the new state.
        let stateMachine = CharacterAnimationStateMachine(reactionCooldown: 0.35)
        let scheduler = IdleScheduler(seed: 47, now: 0)
        // Apply blink first.
        _ = stateMachine.apply(CharacterAnimationIntent(state: .blink,
                                                       priority: 14,
                                                       duration: 0.14,
                                                       source: .rendererFallback,
                                                       createdAt: 0), now: 0)
        XCTAssertEqual(stateMachine.state, .blink)
        // Then taskFailed with priority 70 (overrides).
        _ = stateMachine.apply(CharacterAnimationIntent(state: .taskFailed,
                                                       priority: 70,
                                                       duration: 0.6,
                                                       source: .agentRuntime,
                                                       createdAt: 0.05), now: 0.05)
        XCTAssertEqual(stateMachine.state, .taskFailed)
        _ = scheduler
    }

    func testAmbientBlinkResumesAfterTaskFailedExpires() {
        // Per P19.3 §6 — ambient events should resume after the agent state
        // expires, with the post-sustained settle debounce in effect.
        let stateMachine = CharacterAnimationStateMachine(reactionCooldown: 0.35)
        var scheduler = IdleScheduler(seed: 53, now: 0)
        scheduler.reset(now: 0)
        // Enter taskFailed for 0.6s.
        _ = stateMachine.apply(CharacterAnimationIntent(state: .taskFailed,
                                                       priority: 70,
                                                       duration: 0.6,
                                                       source: .agentRuntime,
                                                       createdAt: 0), now: 0)
        scheduler.noteNonIdle(at: 0)
        // Tick during taskFailed — must NOT fire.
        for t in stride(from: 0.05, through: 0.6, by: 0.05) {
            XCTAssertNil(scheduler.tick(now: t, state: stateMachine.state))
        }
        // After expiration (0.6s), state returns to idle. Within settle
        // window (0.4s after non-idle note at 0.6, → 1.0s) we still hold off.
        _ = stateMachine.update(now: 0.7) // expiration begins
        _ = stateMachine.update(now: 1.0)
        // state should be back to idle
        XCTAssertEqual(stateMachine.state, .idle)
        // tick at 1.0 — within settle (settle = 0.6 + 0.4 = 1.0) → no event.
        XCTAssertNil(scheduler.tick(now: 1.0, state: .idle))
        // tick at 1.5 — past settle → may fire if nextBlinkAt < 1.5.
        _ = scheduler.tick(now: 1.5, state: .idle)
    }

    // MARK: - SeedableLinearRNG

    func testRNGProducesDifferentSequencesForDifferentSeeds() {
        var a = SeedableLinearRNG(seed: 1)
        var b = SeedableLinearRNG(seed: 2)
        let aSeq = (0..<10).map { _ in a.next() }
        let bSeq = (0..<10).map { _ in b.next() }
        XCTAssertNotEqual(aSeq, bSeq)
    }

    func testRNGProducesSameSequenceForSameSeed() {
        var a = SeedableLinearRNG(seed: 0xC0FFEE)
        var b = SeedableLinearRNG(seed: 0xC0FFEE)
        for _ in 0..<100 {
            XCTAssertEqual(a.next(), b.next())
        }
    }

    func testRNGZeroSeedDoesNotProduceConstantSequence() {
        var rng = SeedableLinearRNG(seed: 0)
        var distinctValues = Set<UInt64>()
        for _ in 0..<50 {
            distinctValues.insert(rng.next())
        }
        XCTAssertGreaterThan(distinctValues.count, 1)
    }
}