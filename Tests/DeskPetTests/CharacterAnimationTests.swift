import XCTest
import CryptoKit
import Foundation
@testable import DeskPet
@testable import AICore

@MainActor
final class CharacterAnimationStateMachineTests: XCTestCase {

    func testSpeakingDoesNotOverrideDragged() {
        let machine = CharacterAnimationStateMachine(reactionCooldown: 0.2)
        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .dragged,
                                                             priority: 90,
                                                             source: .desktopInteraction,
                                                             createdAt: 10), now: 10))
        XCTAssertFalse(machine.apply(CharacterAnimationIntent(state: .speaking,
                                                              priority: 60,
                                                              source: .agentRuntime,
                                                              createdAt: 10.1), now: 10.1))
        XCTAssertEqual(machine.state, .dragged)
    }

    func testLandingRestoresIdleAfterDuration() {
        let machine = CharacterAnimationStateMachine(reactionCooldown: 0.2)
        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .idle,
                                                             source: .runtimeLifecycle,
                                                             createdAt: 1), now: 1))
        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .landing,
                                                             priority: 80,
                                                             duration: 0.3,
                                                             source: .desktopInteraction,
                                                             createdAt: 2), now: 2))
        machine.update(now: 2.31)
        XCTAssertEqual(machine.state, .idle)
    }

    func testRepeatedClickReactionIsDebounced() {
        let machine = CharacterAnimationStateMachine(reactionCooldown: 0.35)
        let first = CharacterAnimationIntent(state: .reacting,
                                             emotion: .neutral,
                                             priority: 70,
                                             duration: 0.3,
                                             source: .userInteraction,
                                             createdAt: 1)
        XCTAssertTrue(machine.apply(first, now: 1))
        let duplicate = CharacterAnimationIntent(state: .reacting,
                                                 emotion: .neutral,
                                                 priority: 70,
                                                 duration: 0.3,
                                                 source: .userInteraction,
                                                 createdAt: 1.1)
        XCTAssertFalse(machine.apply(duplicate, now: 1.1))
    }
}

final class CharacterAnimationConfigTests: XCTestCase {
    func testDefaultConfigJSONDecodesAndMatchesFormalAsset() throws {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Resources/CharacterAnimation/default_character_animation.json")
        let data = try Data(contentsOf: url)
        let config = try JSONDecoder().decode(CharacterAnimationConfig.self, from: data)
        XCTAssertEqual(config.asset.relativePath, "Characters/Default/character_anchor_rgba_v3.png")
        XCTAssertEqual(config.asset.sha256, "96a7ad41707ee544ac44912bc443e361ad761907af0d35624e5dacd036a6fa7a")
        XCTAssertGreaterThan(config.breathing.amplitude, 0)
        XCTAssertGreaterThan(config.canvas.logicalHeight, config.canvas.logicalWidth)
    }

    func testFormalAssetChecksum() throws {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Resources/Characters/Default/character_anchor_rgba_v3.png")
        let data = try Data(contentsOf: url)
        let digest = SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertEqual(digest, CharacterAnimationConfig.default.asset.sha256)
    }

    func testProductionConfigDoesNotReferencePlaceholder() throws {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Resources/CharacterAnimation/default_character_animation.json")
        let text = try String(contentsOf: url, encoding: .utf8).lowercased()
        XCTAssertFalse(text.contains("placeholder"))
        XCTAssertFalse(text.contains("mock"))
    }
}

final class AlphaHitMaskTests: XCTestCase {
    func testAlphaHitMaskRejectsTransparentPixels() {
        let mask = AlphaHitMask(width: 2, height: 2, threshold: 10, alpha: [
            0, 255,
            20, 0
        ])
        XCTAssertFalse(mask.contains(pixelX: 0, pixelY: 0))
        XCTAssertTrue(mask.contains(pixelX: 1, pixelY: 0))
        XCTAssertTrue(mask.contains(pixelX: 0, pixelY: 1))
        XCTAssertFalse(mask.contains(pixelX: 1, pixelY: 1))
        XCTAssertFalse(mask.contains(pixelX: 3, pixelY: 0))
    }
}

final class AgentAnimationEventMapperTests: XCTestCase {
    func testRuntimeEventsMapToWhitelistedAnimationIntents() {
        let thinking = AgentAnimationEventMapper.intent(for: .thinkingStarted, now: 1)
        XCTAssertEqual(thinking.state, .taskWaiting)
        XCTAssertEqual(thinking.emotion, .curious)
        XCTAssertEqual(thinking.priority, 50)

        let finished = AgentAnimationEventMapper.intent(for: .responseFinished(emotion: .excited), now: 2)
        XCTAssertEqual(finished.state, .jump)
        XCTAssertEqual(finished.emotion, .happy)
    }
}

final class CharacterLocomotionControllerTests: XCTestCase {
    func testMovingRightStartsThenWalksThenStops() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.2,
                                              stopDuration: 0.25,
                                              enterWalkingDelay: 0,
                                              returnIdleDelay: 0))

        let start = controller.update(activity: .wander, facing: 1, speedPointsPerSecond: 60, now: 1)
        XCTAssertEqual(start?.state, .startMovingRight)

        XCTAssertNil(controller.tick(now: 1.1))
        let walk = controller.tick(now: 1.21)
        XCTAssertEqual(walk?.state, .walkRight)
        XCTAssertEqual(walk?.speedTier, .walk)

        let stop = controller.update(activity: .idle, facing: 1, now: 2)
        XCTAssertEqual(stop?.state, .stopMovingRight)

        // P19.2 — right-direction stops now route through `turnRightToFront`
        // before returning to idle. The pre-P19.2 implementation snapped
        // straight to idle for right stops (an asymmetry). The first tick
        // after the stop duration emits the turn intent; the tick after
        // `turnToFrontDuration` (0.6 s default) emits the idle reset.
        let turn = controller.tick(now: 2.26)
        XCTAssertEqual(turn?.state, .turnRightToFront)
        XCTAssertNil(controller.tick(now: 2.5),
                     "Mid-turn tick should not emit anything yet")
        let idle = controller.tick(now: 2.87)
        XCTAssertEqual(idle?.state, .idle)
    }

    func testMovingLeftUsesIndependentWalkLeftState() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.1,
                                              stopDuration: 0.1,
                                              enterWalkingDelay: 0,
                                              returnIdleDelay: 0))

        _ = controller.update(activity: .recalling, facing: -1, speedPointsPerSecond: 60, now: 1)
        let walk = controller.tick(now: 1.11)
        XCTAssertEqual(walk?.state, .walkLeft)
        XCTAssertEqual(walk?.locomotionDirection, .left)
    }

    func testMovingLeftStopsThenTurnsBackToFront() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.1,
                                              stopDuration: 0.1,
                                              turnToFrontDuration: 0.6,
                                              enterWalkingDelay: 0,
                                              returnIdleDelay: 0))

        _ = controller.update(activity: .recalling, facing: -1, speedPointsPerSecond: 60, now: 1)
        _ = controller.tick(now: 1.11)

        let stopLeft = controller.update(activity: .idle, facing: -1, now: 2)
        XCTAssertEqual(stopLeft?.state, .stopMovingLeft)

        let turn = controller.tick(now: 2.11)
        XCTAssertEqual(turn?.state, .turnLeftToFront)
        XCTAssertEqual(turn?.locomotionDirection, .left)

        let idle = controller.tick(now: 2.72)
        XCTAssertEqual(idle?.state, .idle)
    }

    func testHighSpeedRightUsesRunRight() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.1,
                                              stopDuration: 0.1,
                                              enterWalkingDelay: 0,
                                              returnIdleDelay: 0))

        _ = controller.update(activity: .recalling, facing: 1, speedPointsPerSecond: 150, now: 1)
        let run = controller.tick(now: 1.11)
        XCTAssertEqual(run?.state, .runRight)
        XCTAssertEqual(run?.speedTier, .run)
    }

    func testHighSpeedLeftUsesRunLeft() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.1,
                                              stopDuration: 0.1,
                                              enterWalkingDelay: 0,
                                              returnIdleDelay: 0))

        _ = controller.update(activity: .recalling, facing: -1, speedPointsPerSecond: 150, now: 1)
        let run = controller.tick(now: 1.11)
        XCTAssertEqual(run?.state, .runLeft)
        XCTAssertEqual(run?.speedTier, .run)
    }

    func testSpeedTierThresholds() {
        let controller = CharacterLocomotionController()
        XCTAssertEqual(controller.speedTier(for: 0), .idle)
        XCTAssertEqual(controller.speedTier(for: 20), .slowWalk)
        XCTAssertEqual(controller.speedTier(for: 60), .walk)
        XCTAssertEqual(controller.speedTier(for: 100), .briskWalk)
        XCTAssertEqual(controller.speedTier(for: 150), .run)
    }

    func testDirectionChangeStopsThenStartsOppositeDirection() {
        let controller = CharacterLocomotionController(
            timing: CharacterLocomotionTiming(startDuration: 0.1,
                                              stopDuration: 0.1,
                                              enterWalkingDelay: 0,
                                              returnIdleDelay: 0))

        _ = controller.update(activity: .wander, facing: 1, speedPointsPerSecond: 60, now: 1)
        _ = controller.tick(now: 1.11)

        let stopRight = controller.update(activity: .wander, facing: -1, speedPointsPerSecond: 60, now: 1.2)
        XCTAssertEqual(stopRight?.state, .stopMovingRight)

        let startLeft = controller.tick(now: 1.31)
        XCTAssertEqual(startLeft?.state, .startMovingLeft)

        let walkLeft = controller.tick(now: 1.42)
        XCTAssertEqual(walkLeft?.state, .walkLeft)
    }
}

@MainActor
final class CharacterVisualManifestTests: XCTestCase {
    private func loadManifest() throws -> CharacterVisualManifest {
        let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Assets/CharacterV2/manifests/character_v2_manifest.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(CharacterVisualManifest.self, from: data)
    }

    func testCharacterV2ManifestDecodesAndValidates() throws {
        let manifest = try loadManifest()

        XCTAssertEqual(manifest.schemaVersion, 2)
        XCTAssertEqual(manifest.manifestID, "deskpet_character_v2_p6_2_locomotion")
        XCTAssertNotNil(manifest.clip(for: .walkLeft))
        XCTAssertNotNil(manifest.clip(for: .walkRight))
        XCTAssertNotNil(manifest.clip(for: .runLeft))
        XCTAssertNotNil(manifest.clip(for: .runRight))
        XCTAssertNotNil(manifest.clip(for: .turnLeftToFront))
        XCTAssertEqual(manifest.clip(for: .idle)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .walkLeft)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .walkRight)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .startMovingLeft)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .startMovingRight)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .stopMovingLeft)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .stopMovingRight)?.assetStatus, .approved)
        XCTAssertEqual(manifest.clip(for: .turnLeftToFront)?.assetStatus, .approved)
        XCTAssertNil(manifest.clip(for: .walkLeft)?.fallback)
        XCTAssertNil(manifest.clip(for: .walkRight)?.fallback)
        XCTAssertNil(manifest.clip(for: .startMovingLeft)?.fallback)
        XCTAssertNil(manifest.clip(for: .startMovingRight)?.fallback)
        XCTAssertNil(manifest.clip(for: .stopMovingLeft)?.fallback)
        XCTAssertNil(manifest.clip(for: .stopMovingRight)?.fallback)
        XCTAssertNil(manifest.clip(for: .turnLeftToFront)?.fallback)
        XCTAssertEqual(manifest.clip(for: .walkLeft)?.frames.count, 16)
        XCTAssertEqual(manifest.clip(for: .walkRight)?.frames.count, 16)
        XCTAssertEqual(manifest.clip(for: .startMovingLeft)?.frames.count, 6)
        XCTAssertEqual(manifest.clip(for: .startMovingRight)?.frames.count, 6)
        XCTAssertEqual(manifest.clip(for: .stopMovingLeft)?.frames.count, 6)
        XCTAssertEqual(manifest.clip(for: .stopMovingRight)?.frames.count, 6)
        XCTAssertEqual(manifest.clip(for: .turnLeftToFront)?.frames.count, 6)
        XCTAssertFalse(manifest.habitat.placeholder)
        XCTAssertEqual(manifest.habitat.resources, [
            "approved/habitat/habitat_blue_white_magic_book_soft_bed_20260620_02.png"
        ])
        XCTAssertNoThrow(try CharacterVisualSystemLoader.validate(manifest))
    }

    func testWalkLeftAndWalkRightUseApprovedRuntimeFrameNames() throws {
        let manifest = try loadManifest()

        let left = try XCTUnwrap(manifest.clip(for: .walkLeft))
        let right = try XCTUnwrap(manifest.clip(for: .walkRight))
        let approvedRuntimeFrames = (0..<16).map { String(format: "frame_%03d", $0) }
        XCTAssertEqual(left.frames, approvedRuntimeFrames)
        XCTAssertEqual(right.frames, approvedRuntimeFrames)
        XCTAssertEqual(left.assetStatus, .approved)
        XCTAssertEqual(right.assetStatus, .approved)
        XCTAssertEqual(left.direction, .left)
        XCTAssertEqual(right.direction, .right)
    }

    func testRunLeftAndRunRightDoNotFallbackAcrossDirection() throws {
        let manifest = try loadManifest()
        let left = try XCTUnwrap(manifest.clip(for: .runLeft))
        let right = try XCTUnwrap(manifest.clip(for: .runRight))

        XCTAssertEqual(left.fallback?.clipID, "walk_left")
        XCTAssertEqual(right.fallback?.clipID, "walk_right")
        XCTAssertNotEqual(left.fallback?.clipID, "run_right")
        XCTAssertNotEqual(right.fallback?.clipID, "run_left")
    }

    func testManifestRejectsOppositeDirectionFallback() throws {
        var manifest = try loadManifest()
        let index = try XCTUnwrap(manifest.clips.firstIndex(where: { $0.id == "run_left" }))
        manifest.clips[index].fallback = CharacterVisualFallback(
            clipID: "walk_right",
            mode: "TEMP_LEGACY_SAME_DIRECTION_FALLBACK",
            notes: "invalid test fallback")

        XCTAssertThrowsError(try CharacterVisualSystemLoader.validate(manifest))
    }

    func testManifestRejectsMissingLeftClip() throws {
        var manifest = try loadManifest()
        manifest.clips.removeAll { $0.id == "walk_left" }

        XCTAssertThrowsError(try CharacterVisualSystemLoader.validate(manifest))
    }

    func testDynamicFpsInterpolatesAndClamps() throws {
        let manifest = try loadManifest()
        let walk = try XCTUnwrap(manifest.clip(id: "walk_right"))

        XCTAssertEqual(walk.effectiveFps(forSpeed: 35), 8, accuracy: 0.001)
        XCTAssertEqual(walk.effectiveFps(forSpeed: 60), 10, accuracy: 0.001)
        XCTAssertEqual(walk.effectiveFps(forSpeed: 120), 12, accuracy: 0.001)
    }

    func testStaticRendererLoadsGeneratedFrameClips() throws {
        CharacterVisualSystemLoader.resetForTests()
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        let ids = renderer.loadedClipIDsForTests
        XCTAssertTrue(ids.contains("move_left"))
        XCTAssertTrue(ids.contains("move_right"))
        XCTAssertTrue(ids.contains("move_left_brisk"))
        XCTAssertTrue(ids.contains("move_right_brisk"))
        XCTAssertTrue(ids.contains("move_left_fast"))
        XCTAssertTrue(ids.contains("move_right_fast"))
        XCTAssertTrue(ids.contains("start_move"))
        XCTAssertTrue(ids.contains("stop_move"))
        XCTAssertTrue(ids.contains("start_move_left"))
        XCTAssertTrue(ids.contains("start_move_right"))
        XCTAssertTrue(ids.contains("stop_move_left"))
        XCTAssertTrue(ids.contains("stop_move_right"))
        XCTAssertTrue(ids.contains("turn_left_to_front"))
    }

    func testStaticRendererSwitchesToManifestWalkClip() throws {
        CharacterVisualSystemLoader.resetForTests()
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        renderer.apply(intent: CharacterAnimationIntent(state: .walkRight,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 1))
        renderer.update(deltaTime: 1.0 / 10.0)

        XCTAssertEqual(renderer.diagnostics().currentClipID, "move_right")
    }

    func testStaticRendererWalkLeftDoesNotLoadWalkRight() throws {
        CharacterVisualSystemLoader.resetForTests()
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        renderer.apply(intent: CharacterAnimationIntent(state: .walkLeft,
                                                        locomotionDirection: .left,
                                                        speedTier: .walk,
                                                        speedPointsPerSecond: 60,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 1))
        renderer.update(deltaTime: 1.0 / 10.0)

        XCTAssertEqual(renderer.diagnostics().currentClipID, "move_left")
    }

    func testStaticRendererRunLeftDoesNotLoadRunRight() throws {
        CharacterVisualSystemLoader.resetForTests()
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        renderer.apply(intent: CharacterAnimationIntent(state: .runLeft,
                                                        locomotionDirection: .left,
                                                        speedTier: .run,
                                                        speedPointsPerSecond: 150,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 1))
        renderer.update(deltaTime: 1.0 / 10.0)

        XCTAssertEqual(renderer.diagnostics().currentClipID, "move_left_fast")
        XCTAssertNotEqual(renderer.diagnostics().currentClipID, "move_right_fast")
    }

    func testStaticRendererUsesDirectionalStartAndStopClips() throws {
        CharacterVisualSystemLoader.resetForTests()
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        renderer.apply(intent: CharacterAnimationIntent(state: .startMovingRight,
                                                        locomotionDirection: .right,
                                                        speedTier: .walk,
                                                        speedPointsPerSecond: 60,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 1))
        renderer.update(deltaTime: 1.0 / 10.0)
        XCTAssertEqual(renderer.diagnostics().currentClipID, "start_move_right")
        // P19.2 — start_move_right is augmented from CharacterV2's approved
        // PNGs, so the runtime no longer logs a fallback chain for it. The
        // pre-P19.2 expectation that "fallbackReason contains
        // start_move_right" is obsolete.
        XCTAssertFalse(renderer.diagnostics().fallbackReason?.contains("character clip start_move_right is using explicit fallback") ?? true,
                     "P19.2 — start_move_right must NOT report a fallback chain after CharacterV2 augmentation")

        renderer.apply(intent: CharacterAnimationIntent(state: .startMovingLeft,
                                                        locomotionDirection: .left,
                                                        speedTier: .walk,
                                                        speedPointsPerSecond: 60,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 2))
        renderer.update(deltaTime: 1.0 / 10.0)
        XCTAssertEqual(renderer.diagnostics().currentClipID, "start_move_left")

        renderer.apply(intent: CharacterAnimationIntent(state: .stopMovingRight,
                                                        locomotionDirection: .right,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 3))
        renderer.update(deltaTime: 1.0 / 10.0)
        XCTAssertEqual(renderer.diagnostics().currentClipID, "stop_move_right")
        // P19.2 — stop_move_right is augmented from CharacterV2's approved
        // PNGs (same reasoning as start_move_right above).
        XCTAssertFalse(renderer.diagnostics().fallbackReason?.contains("character clip stop_move_right is using explicit fallback") ?? true,
                     "P19.2 — stop_move_right must NOT report a fallback chain after CharacterV2 augmentation")

        renderer.apply(intent: CharacterAnimationIntent(state: .turnLeftToFront,
                                                        locomotionDirection: .left,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 4))
        renderer.update(deltaTime: 1.0 / 10.0)
        XCTAssertEqual(renderer.diagnostics().currentClipID, "turn_left_to_front")
    }
}
