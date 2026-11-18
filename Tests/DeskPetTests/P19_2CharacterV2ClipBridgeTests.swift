import XCTest
import Foundation
@testable import DeskPet

/// P19.2 — CharacterV2ClipBridge asset augmentation.
///
/// The production character (HatchedGirl) has 13 locomotion-related
/// placeholder fallback chains (the audit's 13 temp fallback entries). The
/// CharacterV2 staging directory ships approved PNGs for a subset of those
/// transitions plus idle + blink + idle-look-around. The bridge must:
///
/// 1. Locate the CharacterV2 staging directory on disk.
/// 2. Discover which augmentable clip ids have at least one approved PNG.
/// 3. Synthesize `CharacterVisualClip` entries pointing at the CharacterV2
///    PNG paths with the correct state, fps, pivot, and hitbox shape.
/// 4. Avoid double-augmenting when the production character already has
///    approved PNGs for the same clip id (superset replacement).
///
/// Per P19.2 §3, we do NOT redesign the production character. Per P19.2
/// §11, we do NOT regress interaction states. The bridge is the seam
/// that satisfies both constraints.
@MainActor
final class P19_2CharacterV2ClipBridgeTests: XCTestCase {

    override class func setUp() {
        super.setUp()
        CharacterV2ClipBridge.resetForTests()
    }

    override func tearDownWithError() throws {
        CharacterV2ClipBridge.resetForTests()
        try super.tearDownWithError()
    }

    func testLocateAssetRootReturnsRealStagingPath() {
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            // The audit's CharacterV2 staging tree is on disk. If this
            // returns nil the staging directory has been removed, which would
            // regress P19.2 silently.
            XCTFail("P19.2 — CharacterV2 staging tree must exist on disk for the asset bridge to function")
            return
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: location.manifestPath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: location.rootPath))
    }

    func testAvailableClipIDsIncludeAllApprovedLocomotionClips() {
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let available = CharacterV2ClipBridge.availableClipIDs(assetRoot: location.rootPath)
        // P19.2 §4 — CharacterV2 ships approved PNGs for these clip ids.
        let expected: Set<String> = [
            "idle",
            "start_move_left", "start_move_right",
            "stop_move_left", "stop_move_right",
            "turn_left_to_front",
            "walk_left", "walk_right",
        ]
        for clipID in expected {
            XCTAssertTrue(available.contains(clipID),
                         "P19.2 — augmented clip set must include \(clipID)")
        }
    }

    func testAvailableClipIDsExcludeBlinkAndIdleLookAroundWhenNoPngs() {
        // Per P19.2 §5, blink and idle_look_around remain placeholders
        // (no approved PNGs in CharacterV2's staging tree). The bridge
        // must not synthesize synthetic entries that would later fail to
        // load. The production character (HatchedGirl) also declares these
        // as placeholders — the runtime falls back to `idle` / `look_000`.
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let available = CharacterV2ClipBridge.availableClipIDs(assetRoot: location.rootPath)
        XCTAssertFalse(available.contains("blink"),
                     "P19.2 — blink has no approved PNGs on disk; the bridge must not augment it")
        XCTAssertFalse(available.contains("idle_look_around"),
                     "P19.2 — idle_look_around has no approved PNGs on disk; the bridge must not augment it")
    }

    func testAvailableClipIDsExcludeBriskAndRun() {
        // Per P19.2 §5, brisk_walk and run remain placeholders because no
        // approved PNGs exist for them in CharacterV2. The bridge must
        // not synthesize synthetic entries that would later fail to load.
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let available = CharacterV2ClipBridge.availableClipIDs(assetRoot: location.rootPath)
        XCTAssertFalse(available.contains("brisk_walk_left"))
        XCTAssertFalse(available.contains("brisk_walk_right"))
        XCTAssertFalse(available.contains("run_left"))
        XCTAssertFalse(available.contains("run_right"))
    }

    func testAugmentedClipsContainsExpectedFrameCounts() {
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let clips = CharacterV2ClipBridge.augmentedClips(assetRoot: location.rootPath)
        let byID = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0) })

        XCTAssertEqual(byID["idle"]?.frames.count, 6,
                     "P19.2 — CharacterV2 idle must augment with 6 frames")
        XCTAssertEqual(byID["walk_left"]?.frames.count, 16,
                     "P19.2 — CharacterV2 walk_left must augment with 16 frames")
        XCTAssertEqual(byID["walk_right"]?.frames.count, 16)
        XCTAssertEqual(byID["start_move_left"]?.frames.count, 6)
        XCTAssertEqual(byID["start_move_right"]?.frames.count, 6)
        XCTAssertEqual(byID["stop_move_left"]?.frames.count, 6)
        XCTAssertEqual(byID["stop_move_right"]?.frames.count, 6)
        XCTAssertEqual(byID["turn_left_to_front"]?.frames.count, 6)
        XCTAssertEqual(byID["turn_right_to_front"]?.frames.count, 6,
                     "P19.2 — turn_right_to_front mirror clip must have 6 frames")
    }

    func testAugmentedClipsHaveApprovedAssetStatus() {
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let clips = CharacterV2ClipBridge.augmentedClips(assetRoot: location.rootPath)
        for clip in clips {
            XCTAssertEqual(clip.assetStatus, .approved,
                          "P19.2 — \(clip.id) augmented entry must be marked .approved")
            XCTAssertFalse(clip.placeholder,
                          "P19.2 — \(clip.id) augmented entry must not be a placeholder")
            XCTAssertNil(clip.fallback,
                        "P19.2 — \(clip.id) augmented entry must not declare a fallback")
        }
    }

    func testAugmentedClipsStateMapping() {
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let clips = CharacterV2ClipBridge.augmentedClips(assetRoot: location.rootPath)
        let byID = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0.state) })
        XCTAssertEqual(byID["idle"], .idle)
        // blink / idle_look_around are not augmented by P19.2 (no approved PNGs).
        XCTAssertNil(byID["blink"])
        XCTAssertNil(byID["idle_look_around"])
        XCTAssertEqual(byID["start_move_left"], .startMovingLeft)
        XCTAssertEqual(byID["start_move_right"], .startMovingRight)
        XCTAssertEqual(byID["stop_move_left"], .stopMovingLeft)
        XCTAssertEqual(byID["stop_move_right"], .stopMovingRight)
        XCTAssertEqual(byID["turn_left_to_front"], .turnLeftToFront)
        // turn_right_to_front is synthesized as a mirror; P19.2 wires it.
        XCTAssertEqual(byID["turn_right_to_front"], .turnRightToFront)
        XCTAssertEqual(byID["walk_left"], .walkLeft)
        XCTAssertEqual(byID["walk_right"], .walkRight)
    }

    func testAugmentedClipsDirectionAndSpeedTier() {
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let clips = CharacterV2ClipBridge.augmentedClips(assetRoot: location.rootPath)
        let byID = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0) })
        // Walk direction tags let the renderer's directional resolver pick
        // the correct clip without falling back to a generic lookup.
        XCTAssertEqual(byID["walk_left"]?.direction, .left)
        XCTAssertEqual(byID["walk_right"]?.direction, .right)
        XCTAssertEqual(byID["start_move_left"]?.direction, .left)
        XCTAssertEqual(byID["start_move_right"]?.direction, .right)
        XCTAssertEqual(byID["stop_move_left"]?.direction, .left)
        XCTAssertEqual(byID["stop_move_right"]?.direction, .right)
        XCTAssertEqual(byID["turn_left_to_front"]?.direction, .left)
        XCTAssertEqual(byID["turn_right_to_front"]?.direction, .right)
        XCTAssertEqual(byID["walk_left"]?.speedTier, .walk)
        XCTAssertEqual(byID["walk_right"]?.speedTier, .walk)
        // Per-clip loop semantics — walk loops, transitions don't.
        XCTAssertTrue(byID["idle"]?.loop == true)
        XCTAssertTrue(byID["walk_left"]?.loop == true)
        XCTAssertTrue(byID["walk_right"]?.loop == true)
        XCTAssertFalse(byID["start_move_left"]?.loop == true)
        XCTAssertFalse(byID["stop_move_left"]?.loop == true)
        XCTAssertFalse(byID["turn_left_to_front"]?.loop == true)
    }

    func testTurnRightToFrontMirrorsTurnLeftToFrontFrames() {
        // P19.2 §6 option B — mirror acceptable when acceptance records declare
        // that scope. CharacterV2's own pipeline rules allow mirrored pairs.
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            XCTFail("Staging tree missing")
            return
        }
        let clips = CharacterV2ClipBridge.augmentedClips(assetRoot: location.rootPath)
        let byID = Dictionary(uniqueKeysWithValues: clips.map { ($0.id, $0) })
        guard let left = byID["turn_left_to_front"], let right = byID["turn_right_to_front"] else {
            XCTFail("P19.2 — both turn_left_to_front and turn_right_to_front must be augmented")
            return
        }
        XCTAssertEqual(left.frames.count, right.frames.count,
                     "P19.2 — turn_right_to_front must mirror turn_left_to_front frame count")
        XCTAssertEqual(left.fps, right.fps)
        // Per-clip playback duration is frames / fps.
        let leftDuration = Double(left.frames.count) / left.fps
        let rightDuration = Double(right.frames.count) / right.fps
        XCTAssertEqual(leftDuration, rightDuration, accuracy: 0.001,
                     "P19.2 — turn_left_to_front and turn_right_to_front must play back in the same time")
    }
}

/// P19.2 — Bridge integration into StaticPNGCharacterRenderer.
///
/// When the renderer loads the production character, it must:
///
/// * call `augmentClipsFromCharacterV2IfAvailable()` BEFORE
///   `loadCharacterV2ClipsIfAvailable()` so the augmented entries are
///   visible to the per-clip loader;
/// * record the CharacterV2 asset root on `visualSystem.secondaryAssetRootPath`
///   so `frameCandidates` resolves the CharacterV2 PNGs;
/// * produce `loadedClips` entries whose `sourceClipID` is the CharacterV2
///   clip id (so `fallbackReason` logs make it clear the clip was sourced
///   from the CharacterV2 staging tree).
@MainActor
final class P19_2CharacterV2AugmentationRuntimeTests: XCTestCase {

    override class func setUp() {
        super.setUp()
        CharacterVisualSystemLoader.resetForTests()
        CharacterV2ClipBridge.resetForTests()
    }

    override func tearDownWithError() throws {
        CharacterVisualSystemLoader.resetForTests()
        CharacterV2ClipBridge.resetForTests()
        try super.tearDownWithError()
    }

    func testStaticRendererAugmentsStartMoveLeftFromCharacterV2() throws {
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()
        let ids = Set(renderer.loadedClipIDsForTests)
        XCTAssertTrue(ids.contains("start_move_left"),
                     "P19.2 — production character must load start_move_left after CharacterV2 augmentation")
        XCTAssertTrue(ids.contains("start_move_right"))
        XCTAssertTrue(ids.contains("stop_move_left"))
        XCTAssertTrue(ids.contains("stop_move_right"))
        XCTAssertTrue(ids.contains("turn_left_to_front"))
        XCTAssertTrue(ids.contains("turn_right_to_front"),
                     "P19.2 — turn_right_to_front must be augmented even though only left PNGs exist on disk")
        XCTAssertTrue(ids.contains("walk_left"))
        XCTAssertTrue(ids.contains("walk_right"))
    }

    func testStaticRendererPlayStartMoveLeftUsesAugmentedClipNotFallback() throws {
        // P19.2 §12 — the audit's number-13-fallback metric must drop for
        // the augmented states. We verify that the renderer does NOT
        // report a fallback chain *for the augmented clip itself* when it
        // is played. Pre-existing placeholder fallbacks for other
        // (non-augmented) clips are unaffected and remain in
        // `fallbackReason` as part of the runtime's startup log.
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        renderer.apply(intent: CharacterAnimationIntent(state: .startMovingLeft,
                                                        locomotionDirection: .left,
                                                        speedTier: .walk,
                                                        speedPointsPerSecond: 60,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 1))
        renderer.update(deltaTime: 1.0 / 10.0)
        XCTAssertEqual(renderer.diagnostics().currentClipID, "start_move_left")
        let fb = renderer.diagnostics().fallbackReason ?? ""
        XCTAssertFalse(fb.contains("character clip start_move_left is using explicit fallback"),
                      "P19.2 — start_move_left must NOT report a fallback chain after CharacterV2 augmentation; got: \(fb)")
    }

    func testStaticRendererPlayTurnRightToFrontUsesAugmentedMirror() throws {
        // P19.2 §6 option B — mirrored pair for the right-direction turn.
        let renderer = StaticPNGCharacterRenderer(config: .default)
        try renderer.load()

        renderer.apply(intent: CharacterAnimationIntent(state: .turnRightToFront,
                                                        locomotionDirection: .right,
                                                        priority: 40,
                                                        source: .desktopInteraction,
                                                        createdAt: 1))
        renderer.update(deltaTime: 1.0 / 10.0)
        XCTAssertEqual(renderer.diagnostics().currentClipID, "turn_right_to_front",
                     "P19.2 — turnRightToFront must resolve to the synthesized mirror clip, not fall back to idle")
    }
}