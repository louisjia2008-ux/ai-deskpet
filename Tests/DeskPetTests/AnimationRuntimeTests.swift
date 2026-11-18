import XCTest
import CoreGraphics
@testable import DeskPet

final class AnimationRuntimeTests: XCTestCase {
    func testActorLogicalSizeStableAcrossFrames() {
        let canonical = CharacterAnimationConfig.default.footprint
        let frames = (0..<16).map {
            PetAnimationFrame(id: "frame_\($0)", logicalSize: canonical, sourcePath: "frame_\($0).png")
        }
        let clip = PetAnimationClip(id: "walk_right",
                                    frames: frames,
                                    fps: 10,
                                    loop: true,
                                    canonicalLogicalSize: canonical)

        XCTAssertTrue(clip.frames.allSatisfy { $0.logicalSize == canonical })
        XCTAssertEqual(clip.canonicalLogicalSize, canonical)
    }

    func testIdleAndWalkShareCanonicalLogicalHeight() {
        let scale = PetScaleController()
        let idle = scale.visualSize(for: CharacterAnimationConfig.default.footprint)
        let walk = scale.visualSize(for: CharacterAnimationConfig.default.footprint)

        XCTAssertEqual(idle.height, walk.height)
    }

    func testHysteresisPreventsRapidStateFlapping() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.1,
                                              stopDuration: 0.1,
                                              enterWalkingDelay: 0.12,
                                              returnIdleDelay: 0.18))

        XCTAssertNil(controller.update(activity: .wander, facing: 1, speedPointsPerSecond: 60, now: 1.0))
        XCTAssertNil(controller.update(activity: .wander, facing: 1, speedPointsPerSecond: 60, now: 1.08))
        let start = controller.update(activity: .wander, facing: 1, speedPointsPerSecond: 60, now: 1.13)
        XCTAssertEqual(start?.state, .startMovingRight)
        _ = controller.tick(now: 1.24)

        XCTAssertNil(controller.update(activity: .idle, facing: 1, now: 1.25))
        XCTAssertNil(controller.update(activity: .idle, facing: 1, now: 1.36))
        let stop = controller.update(activity: .idle, facing: 1, now: 1.44)
        XCTAssertEqual(stop?.state, .stopMovingRight)
    }

    @MainActor
    func testOverlayMovementSpeedUsesGlobalFeetDelta() {
        let previous = CGPoint(x: 240, y: 24)
        let current = CGPoint(x: 238, y: 24)

        let speed = OverlayWindowController.movementSpeedPointsPerSecond(from: previous,
                                                                         to: current,
                                                                         dt: 1.0 / 30.0)

        XCTAssertEqual(speed, 60, accuracy: 0.001)
        XCTAssertEqual(OverlayWindowController.movementSpeedPointsPerSecond(from: previous,
                                                                            to: current,
                                                                            dt: 0),
                       0)
    }

    func testFrameIndexAdvancesDeterministicallyWithTimeAccumulator() {
        var player = PetAnimationPlayer()

        XCTAssertEqual(player.advance(clipID: "walk", frameCount: 4, fps: 10, loop: true, deltaTime: 0.01), 0)
        XCTAssertEqual(player.advance(clipID: "walk", frameCount: 4, fps: 10, loop: true, deltaTime: 0.04), 0)
        XCTAssertEqual(player.advance(clipID: "walk", frameCount: 4, fps: 10, loop: true, deltaTime: 0.05), 0)
        XCTAssertEqual(player.advance(clipID: "walk", frameCount: 4, fps: 10, loop: true, deltaTime: 0.01), 1)
        XCTAssertEqual(player.advance(clipID: "walk", frameCount: 4, fps: 10, loop: true, deltaTime: 0.30), 3)
        XCTAssertEqual(player.advance(clipID: "idle", frameCount: 2, fps: 8, loop: true, deltaTime: 0.20), 0)
    }
}
