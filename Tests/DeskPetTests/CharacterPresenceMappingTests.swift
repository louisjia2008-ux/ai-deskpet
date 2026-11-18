import XCTest
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

final class CharacterPresenceMappingTests: XCTestCase {

    private let mapping = CharacterPresenceMapping.live
    private let baseContext = CharacterPresenceRenderContext()

    // MARK: Semantic → state/priority table

    func testEveryMappedSustainedStateResolvesToAvailableClipOrMixerPose() {
        // Sustained semantically-mapped states must resolve to either a LumiScholar manifest clip or
        // a documented mixer case. We probe the LumiScholar manifest directly for clip coverage.
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Assets/LumiScholar/approved/clips/lumi_scholar_manifest.json")
        guard let data = try? Data(contentsOf: url),
              let manifest = try? JSONDecoder().decode(CharacterVisualManifest.self, from: data) else {
            XCTFail("LumiScholar manifest missing for mapping coverage test")
            return
        }
        let manifestStateIDs = Set(manifest.clips.map(\.state))

        let speakingIntent = mapping.intent(for: .speaking, context: baseContext)
        XCTAssertEqual(speakingIntent.state, .speaking)
        XCTAssertFalse(manifestStateIDs.contains(.speaking), ".speaking is a mixer pose (no Lumi clip)")

        let listeningIntent = mapping.intent(for: .attentiveLite, context: baseContext)
        XCTAssertEqual(listeningIntent.state, .listening)
        XCTAssertFalse(manifestStateIDs.contains(.listening), ".listening is a mixer pose")

        let workingIntent = mapping.intent(for: .working, context: baseContext)
        XCTAssertEqual(workingIntent.state, .taskRunning)
        XCTAssertTrue(manifestStateIDs.contains(.taskRunning), "Lumi must ship task_running for .working")

        let waitingIntent = mapping.intent(for: .waiting, context: baseContext)
        XCTAssertEqual(waitingIntent.state, .taskWaiting)
        XCTAssertTrue(manifestStateIDs.contains(.taskWaiting), "Lumi must ship task_waiting for .waiting")

        let reviewIntent = mapping.intent(for: .review, context: baseContext)
        XCTAssertEqual(reviewIntent.state, .taskReview)
        XCTAssertTrue(manifestStateIDs.contains(.taskReview), "Lumi must ship task_review for .review")

        let successIntent = mapping.intent(for: .success, context: baseContext)
        XCTAssertEqual(successIntent.state, .jump)
        XCTAssertTrue(manifestStateIDs.contains(.jump), "Lumi must ship jump for .success")

        let failureIntent = mapping.intent(for: .failure, context: baseContext)
        XCTAssertEqual(failureIntent.state, .taskFailed)
        XCTAssertTrue(manifestStateIDs.contains(.taskFailed), "Lumi must ship task_failed for .failure")

        let idleIntent = mapping.intent(for: .idle, context: baseContext)
        XCTAssertEqual(idleIntent.state, .idle)
        XCTAssertTrue(manifestStateIDs.contains(.idle), "Lumi must ship idle for .idle")

        let sleepingIntent = mapping.intent(for: .sleeping, context: baseContext)
        XCTAssertEqual(sleepingIntent.state, .sleeping)
        XCTAssertFalse(manifestStateIDs.contains(.sleeping), ".sleeping is a mixer pose")
    }

    func testThinkingDistinctFromWaitingClipAndMixerCase() {
        var ctx = baseContext
        ctx.reduceMotion = false
        let thinking = mapping.intent(for: .thinking, context: ctx)
        let waiting = mapping.intent(for: .waiting, context: ctx)
        XCTAssertEqual(thinking.state, .thinking)
        XCTAssertEqual(waiting.state, .taskWaiting)
        XCTAssertNotEqual(thinking.state, waiting.state,
                          "thinking and waiting must be distinguishable in the renderer state machine")
    }

    func testReduceMotionThinkingUsesStaticLookPose() {
        var ctx = baseContext
        ctx.reduceMotion = true
        let thinkingRM = mapping.intent(for: .thinking, context: ctx)
        XCTAssertEqual(thinkingRM.state, .look1125, "RM thinking must resolve to a static look pose")
    }

    func testReduceMotionOffUsesThinkingSway() {
        var ctx = baseContext
        ctx.reduceMotion = false
        let thinkingRM = mapping.intent(for: .thinking, context: ctx)
        XCTAssertEqual(thinkingRM.state, .thinking, "non-RM thinking must use the thinking mixer pose")
    }

    func testRecoveryIntentIsNeutralBriefAndBelowThinkingPriority() {
        var ctx = baseContext
        ctx.emotion = .neutral
        ctx.intensity = 0.35
        let recovery = mapping.intent(for: .recovery, context: ctx)
        XCTAssertEqual(recovery.state, .reacting)
        XCTAssertEqual(recovery.emotion, .neutral)
        XCTAssertEqual(recovery.intensity ?? -1, 0.35, accuracy: 0.0001)
        XCTAssertNotNil(recovery.duration)
        XCTAssertLessThan(recovery.duration ?? 0, 1.0)
        XCTAssertLessThan(recovery.priority, CharacterAnimationIntent.defaultPriority(for: .thinking),
                          "recovery beat must rank below thinking so a fresh thinking intent can replace it")
    }

    func testSuccessIntentIsJumpOneShot() {
        let intent = mapping.intent(for: .success, context: baseContext)
        XCTAssertEqual(intent.state, .jump)
        XCTAssertNotNil(intent.duration, ".success (jump) must be a one-shot with a finite duration")
        XCTAssertLessThan(intent.duration ?? 0, 2.0)
    }

    func testSleepingPriorityExceedsLocomotionReassert() {
        let sleeping = mapping.intent(for: .sleeping, context: baseContext)
        XCTAssertGreaterThan(sleeping.priority, 35,
                             ".sleeping must outrank p35 locomotion re-assert so it cannot be clobbered")
    }

    func testAttentiveStateResolvesToListeningIntent() {
        let liteIntent = mapping.intent(for: .attentiveLite, context: baseContext)
        let fullIntent = mapping.intent(for: .attentive, context: baseContext)
        XCTAssertEqual(liteIntent.state, .listening)
        XCTAssertEqual(fullIntent.state, .listening)
        XCTAssertEqual(liteIntent.priority, fullIntent.priority)
    }

    func testNeutralResetMirrorsLegacyCancelledConvention() {
        let now: TimeInterval = 12.5
        let reset = mapping.neutralReset(now: now)
        XCTAssertEqual(reset.state, .idle)
        // R1-1: neutral-reset priority was raised from the legacy p50 to p59 so it can clear
        // sustained taskRunning p55 / taskReview p58 / taskWaiting p50 / listening p45 — but
        // still loses to legitimate one-shots (jump 68, speaking 60, taskFailed 70, dragged 90).
        XCTAssertEqual(reset.priority, 59, "neutral reset must be at the policy's neutralResetPriority (p59)")
        XCTAssertGreaterThan(reset.priority, CharacterAnimationIntent.defaultPriority(for: .taskRunning),
                             "neutral reset must beat sustained taskRunning so it can clear stale working visuals")
        XCTAssertLessThan(reset.priority, CharacterAnimationIntent.defaultPriority(for: .jump),
                          "neutral reset must lose to transient jump so a real jump is not clobbered")
        XCTAssertEqual(reset.emotion, .neutral)
        XCTAssertEqual(reset.duration ?? 0, 0.2, accuracy: 0.0001)
        XCTAssertEqual(reset.createdAt, now)
    }

    func testWakeGreetIsHappyGreetOneShot() {
        let greet = mapping.wakeGreet(now: 4.0)
        XCTAssertEqual(greet.state, .greet)
        XCTAssertEqual(greet.emotion, .happy)
        XCTAssertNotNil(greet.duration)
        XCTAssertEqual(greet.createdAt, 4.0)
    }
}
