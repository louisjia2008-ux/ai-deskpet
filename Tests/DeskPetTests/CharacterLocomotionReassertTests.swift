import XCTest
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

@MainActor
final class CharacterLocomotionReassertTests: XCTestCase {

    private func controller() -> CharacterLocomotionController {
        CharacterLocomotionController()
    }

    /// Walk the controller through its hysteresis + start phase into the `.walking` phase by
    /// issuing two `update(activity: .wander)` calls (priming + hysteresis-past) and ticking past
    /// the start duration (0.6s).
    private func walk(controller c: CharacterLocomotionController,
                      now start: TimeInterval,
                      speed: Double = 60) {
        c.update(activity: .wander, facing: 1, speedPointsPerSecond: speed, now: start)
        c.update(activity: .wander, facing: 1, speedPointsPerSecond: speed, now: start + 0.2)
        c.tick(now: start + 0.9)
    }

    func testIsWalkingTrueWhileWalking() {
        let c = controller()
        walk(controller: c, now: 0)
        XCTAssertTrue(c.isWalking)
    }

    func testIsWalkingFalseWhenIdle() {
        let c = controller()
        XCTAssertFalse(c.isWalking)
        walk(controller: c, now: 0)
        XCTAssertTrue(c.isWalking)
        // A second idle update after the return-idle debounce moves phase to .stopping, where
        // `isWalking` must be false.
        c.update(activity: .idle, facing: 1, speedPointsPerSecond: 0, now: 10)
        c.update(activity: .idle, facing: 1, speedPointsPerSecond: 0, now: 10.25)
        XCTAssertFalse(c.isWalking)
    }

    func testReassertWalkingIntentReturnsNilWhileIdle() {
        let c = controller()
        XCTAssertNil(c.reassertWalkingIntent(now: 0))
    }

    func testReassertWalkingIntentReturnsWalkWhileWalking() {
        let c = controller()
        walk(controller: c, now: 0)
        XCTAssertTrue(c.isWalking, "controller should be in .walking phase")
        let intent = c.reassertWalkingIntent(now: 0.95)
        XCTAssertNotNil(intent)
        XCTAssertEqual(intent?.state, .walkRight)
        XCTAssertEqual(intent?.priority, 35)
        XCTAssertNil(intent?.duration)
    }

    func testReassertWalkingIntentAfterStoppingReturnsNil() {
        let c = controller()
        walk(controller: c, now: 0)
        XCTAssertTrue(c.isWalking)
        c.update(activity: .idle, facing: 1, speedPointsPerSecond: 0, now: 10)
        c.update(activity: .idle, facing: 1, speedPointsPerSecond: 0, now: 10.25)
        XCTAssertFalse(c.isWalking)
        XCTAssertNil(c.reassertWalkingIntent(now: 10.3))
    }

    func testReassertDoesNotMutatePhase() {
        let c = controller()
        walk(controller: c, now: 0)
        XCTAssertTrue(c.isWalking)
        _ = c.reassertWalkingIntent(now: 0.95)
        XCTAssertTrue(c.isWalking)
    }

    func testPetSceneReassertsWalkAfterOneShotIntentExpiresMidWalk() {
        let scene = PetScene(size: CGSize(width: 320, height: 320))
        scene.setFeet(to: CGPoint(x: 160, y: 80), facing: 1)
        scene.setMovementSpeedPointsPerSecond(60)
        // Drive into .walking once.
        scene.apply(activity: .wander)
        scene.update(deltaTime: 0.2)
        scene.apply(activity: .wander)
        // Now feed the controller every frame (mirrors production `syncRenderer`).
        for _ in 0..<30 {
            scene.apply(activity: .wander)
            scene.update(deltaTime: 0.05)
        }
        let beforeWalk = scene.diagnostics().state
        XCTAssertTrue([CharacterAnimationState.walkLeft, .walkRight].contains(beforeWalk),
                      "expected walk visual before one-shot, got \(beforeWalk)")
        // High-priority transient jump p68.
        scene.apply(intent: CharacterAnimationIntent(state: .jump,
                                                     priority: 68,
                                                     duration: 0.78,
                                                     source: .agentRuntime,
                                                     createdAt: 0))
        for _ in 0..<20 {
            scene.apply(activity: .wander)
            scene.update(deltaTime: 0.05)
        }
        let after = scene.diagnostics().state
        XCTAssertTrue([CharacterAnimationState.walkLeft, .walkRight].contains(after),
                      "expected walk visual re-asserted after one-shot expired, got \(after)")
    }

    func testPetSceneDoesNotReassertWalkWhileLocomotionStops() {
        let scene = PetScene(size: CGSize(width: 320, height: 320))
        scene.setFeet(to: CGPoint(x: 160, y: 80), facing: 1)
        scene.setMovementSpeedPointsPerSecond(60)
        scene.apply(activity: .wander)
        scene.update(deltaTime: 0.2)
        scene.apply(activity: .wander)
        for _ in 0..<30 {
            scene.apply(activity: .wander)
            scene.update(deltaTime: 0.05)
        }
        // Now signal .idle every frame so the controller runs through its stop sequence.
        for _ in 0..<30 {
            scene.apply(activity: .idle)
            scene.update(deltaTime: 0.05)
        }
        let after = scene.diagnostics().state
        let locomotionStates: [CharacterAnimationState] = [
            .walkLeft, .walkRight, .startMoving, .startMovingLeft, .startMovingRight,
            .stopMoving, .stopMovingLeft, .stopMovingRight, .turnLeftToFront,
            .briskWalkLeft, .briskWalkRight, .runLeft, .runRight
        ]
        XCTAssertFalse(locomotionStates.contains(after),
                       "expected non-locomotion visual after stop sequence, got \(after)")
    }

    func testSuppressWanderBlocksIdleToWanderTransition() {
        let machine = PetStateMachine(state: PetState())
        machine.suppressWander = true
        for _ in 0..<200 {
            machine.tick(dt: 0.1, walkSpeed: 60)
        }
        XCTAssertEqual(machine.activity, .idle)
    }

    func testHoldStillTransitionsToIdleImmediately() {
        let machine = PetStateMachine(state: PetState())
        for _ in 0..<60 {
            machine.tick(dt: 0.1, walkSpeed: 60)
        }
        machine.holdStill()
        XCTAssertEqual(machine.activity, .idle)
    }

    func testSuppressWanderDoesNotBlockRecall() {
        let machine = PetStateMachine(state: PetState())
        machine.suppressWander = true
        machine.recall()
        XCTAssertEqual(machine.activity, .recalling)
    }
}
