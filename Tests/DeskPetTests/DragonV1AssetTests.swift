import AppKit
import CoreGraphics
import XCTest
@testable import DeskPet

@MainActor
final class DragonV1ManifestTests: XCTestCase {
    private let fullRejectionReason = "DragonV1 wing animation and repeated wing rework attempts failed human visual review. Wings appear artificial, panel-like, disconnected, structurally incorrect, and unsuitable for desktop companion quality."

    private var workspaceRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var dragonAssetRoot: URL {
        workspaceRoot.appendingPathComponent("Assets/DragonV1")
    }

    private var approvedManifestURL: URL {
        dragonAssetRoot.appendingPathComponent("approved/manifests/dragon_v1_manifest.json")
    }

    private var approvedClipsURL: URL {
        dragonAssetRoot.appendingPathComponent("approved/clips")
    }

    private var expectedClipFrameCounts: [String: Int] {
        [
            "dragon_idle_hover": 12,
            "dragon_fly_left_loop": 12,
            "dragon_fly_right_loop": 12,
            "dragon_takeoff": 8,
            "dragon_land": 8,
        ]
    }

    func testApprovedRuntimeAssetsAreAbsentAfterHumanRejection() throws {
        let checklist = dragonAssetRoot
            .appendingPathComponent("approved/DRAGON_V1_RUNTIME_ACCEPTANCE_CHECKLIST.md")
        let text = try String(contentsOf: checklist, encoding: .utf8)

        XCTAssertFalse(FileManager.default.fileExists(atPath: approvedManifestURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: approvedClipsURL.path))
        XCTAssertTrue(text.contains("RUNTIME_HUMAN_ACCEPTANCE = FAILED"))
        XCTAssertTrue(text.contains(fullRejectionReason))
    }

    func testSyntheticAcceptedManifestDecodesAndValidates() throws {
        DragonV1AssetLoader.resetForTests()
        let data = try JSONEncoder().encode(syntheticAcceptedManifest())
        let manifest = try JSONDecoder().decode(DragonV1Manifest.self, from: data)

        XCTAssertEqual(manifest.schemaVersion, 1)
        XCTAssertEqual(manifest.dragonID, "DragonV1")
        XCTAssertEqual(manifest.humanVisualAcceptance, "ACCEPTED")
        XCTAssertEqual(manifest.acceptedReviewTimestamp, "synthetic-test-fixture")
        XCTAssertFalse(manifest.runtime.enabledByDefault)
        XCTAssertNoThrow(try DragonV1AssetLoader.validate(manifest))
    }

    func testSyntheticAcceptedManifestContainsRequiredClipsAndFrameNames() {
        let manifest = syntheticAcceptedManifest()

        for clip in manifest.clips {
            XCTAssertEqual(clip.frameCount, expectedClipFrameCounts[clip.name])
            XCTAssertEqual(clip.frames,
                           (0..<clip.frameCount).map { String(format: "frame_%03d.png", $0) })
        }
    }

    func testLoaderFallsBackWhenAssetsAreMissing() {
        DragonV1AssetLoader.resetForTests()
        let missingRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("missing-dragon-v1-assets-\(UUID().uuidString)")

        XCTAssertThrowsError(try DragonV1AssetLoader.load(assetRoot: missingRoot)) { error in
            XCTAssertTrue(error.localizedDescription.contains("manifest not found"))
        }

        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: missingRoot)
        renderer.loadIfEnabled()
        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertFalse(renderer.isActive)
    }

    func testValidAcceptedManifestFixtureCanLoadFromIsolatedRootWhenEnabled() throws {
        DragonV1AssetLoader.resetForTests()
        let root = try temporaryDragonRootWithSyntheticAssets("dragon-v1-valid-fixture")
        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: root)
        renderer.loadIfEnabled()
        renderer.update(deltaTime: 1.0 / 8.0)

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .pngDragonV1)
        XCTAssertEqual(diagnostics.manifestLoadResult, .loaded)
        XCTAssertEqual(diagnostics.manifestResolvedPath, root.appendingPathComponent("approved/manifests/dragon_v1_manifest.json").path)
        XCTAssertTrue(diagnostics.resourceLoaded)
        XCTAssertEqual(diagnostics.currentClipID, "dragon_idle_hover")
        XCTAssertEqual(diagnostics.state, .idleHover)
        XCTAssertEqual(diagnostics.loadedClipFrameCounts["dragon_idle_hover"], 12)
        XCTAssertEqual(diagnostics.loadedClipFrameCounts["dragon_land"], 8)
        XCTAssertTrue(diagnostics.loadedClipDirectoryPaths["dragon_idle_hover"]?.hasSuffix("approved/clips/dragon_idle_hover") ?? false)
    }

    func testRendererFallsBackWhenFlagEnabledButApprovedAssetsAreRejected() {
        DragonV1AssetLoader.resetForTests()
        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: dragonAssetRoot)
        renderer.loadIfEnabled()

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertFalse(renderer.isActive)
        XCTAssertEqual(diagnostics.fallbackReason, "dragonV1RejectedOrNoAcceptedManifest")
    }

    func testEnvFlagDisabledSelectsVectorFallback() {
        let renderer = StaticPNGDragonRenderer(enabled: false, assetRoot: dragonAssetRoot)
        renderer.loadIfEnabled()

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .disabled)
        XCTAssertFalse(renderer.isActive)
        XCTAssertFalse(diagnostics.runtimeEnabled)
        XCTAssertFalse(diagnostics.resourceLoaded)
    }

    func testRuntimeFlagSnapshotParsesOnlyExplicitOneAsEnabled() {
        XCTAssertFalse(DragonV1RuntimeConfig.snapshot(environment: [:]).isEnabled)
        XCTAssertFalse(DragonV1RuntimeConfig.snapshot(environment: [DragonV1RuntimeConfig.environmentKey: "true"]).isEnabled)

        let enabled = DragonV1RuntimeConfig.snapshot(environment: [DragonV1RuntimeConfig.environmentKey: "1"])
        XCTAssertTrue(enabled.isEnabled)
        XCTAssertEqual(enabled.flagRawValue, "1")
    }

    func testEnvFlagEnabledWithMissingManifestSelectsSafeFallback() {
        DragonV1AssetLoader.resetForTests()
        let missingRoot = temporaryDragonRoot("dragon-v1-missing-manifest")
        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: missingRoot)

        renderer.loadIfEnabled()

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertTrue(diagnostics.manifestCandidatePaths.contains(missingRoot.appendingPathComponent("approved/manifests/dragon_v1_manifest.json").path))
        XCTAssertTrue(diagnostics.fallbackReason?.contains("manifest not found") ?? false)
    }

    func testEnvFlagEnabledWithRejectedManifestSelectsSafeFallbackReason() throws {
        DragonV1AssetLoader.resetForTests()
        let root = temporaryDragonRoot("dragon-v1-rejected-manifest")
        let manifestRoot = root.appendingPathComponent("approved/manifests")
        let approvedRoot = root.appendingPathComponent("approved")
        try FileManager.default.createDirectory(at: manifestRoot, withIntermediateDirectories: true)
        var manifest = syntheticAcceptedManifest()
        manifest.humanVisualAcceptance = "REJECTED"
        manifest.assetStatus = "rejected"
        let data = try JSONEncoder().encode(manifest)
        try data.write(to: manifestRoot.appendingPathComponent("dragon_v1_manifest.json"))
        let statusData = try XCTUnwrap("""
        {
          "runtimeHumanAcceptance": "FAILED",
          "fallbackReason": "dragonV1RejectedOrNoAcceptedManifest"
        }
        """.data(using: .utf8))
        try statusData.write(to: approvedRoot.appendingPathComponent("DRAGON_V1_REJECTION_STATUS.json"))

        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: root)
        renderer.loadIfEnabled()

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestInvalid)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertEqual(diagnostics.fallbackReason, "dragonV1RejectedOrNoAcceptedManifest")
    }

    func testEnvFlagEnabledWithMissingClipSelectsSafeFallback() throws {
        DragonV1AssetLoader.resetForTests()
        let root = temporaryDragonRoot("dragon-v1-missing-clip")
        let manifestRoot = root.appendingPathComponent("approved/manifests")
        try FileManager.default.createDirectory(at: manifestRoot, withIntermediateDirectories: true)
        var manifest = syntheticAcceptedManifest()
        manifest.clips.removeAll { $0.name == "dragon_land" }
        let data = try JSONEncoder().encode(manifest)
        try data.write(to: manifestRoot.appendingPathComponent("dragon_v1_manifest.json"))

        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: root)
        renderer.loadIfEnabled()

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestInvalid)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertTrue(diagnostics.fallbackReason?.contains("missing required clip dragon_land") ?? false)
    }

    func testEnvFlagEnabledWithMissingFramesSelectsSafeFallback() throws {
        DragonV1AssetLoader.resetForTests()
        let root = temporaryDragonRoot("dragon-v1-missing-frames")
        let manifestRoot = root.appendingPathComponent("approved/manifests")
        try FileManager.default.createDirectory(at: manifestRoot, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(syntheticAcceptedManifest())
        try data.write(to: manifestRoot.appendingPathComponent("dragon_v1_manifest.json"))

        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: root)
        renderer.loadIfEnabled()

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .missingFrames)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertTrue(diagnostics.fallbackReason?.contains("frame_000.png") ?? false)
    }

    func testRuntimeSmokeDiagnosticsReportsRejectedApprovedFallback() {
        DragonV1AssetLoader.resetForTests()
        let diagnostics = StaticPNGDragonRenderer.runtimeSmokeDiagnostics(enabled: true, assetRoot: dragonAssetRoot)

        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertNil(diagnostics.manifestResolvedPath)
        XCTAssertTrue(diagnostics.loadedClipFrameCounts.isEmpty)
        XCTAssertEqual(diagnostics.fallbackReason, "dragonV1RejectedOrNoAcceptedManifest")
    }

    func testPetSceneKeepsVectorFallbackWhenApprovedAssetsAreRejected() {
        DragonV1AssetLoader.resetForTests()
        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: dragonAssetRoot)
        let scene = PetScene(size: CGSize(width: 320, height: 320), dragonV1Renderer: renderer)

        let diagnostics = scene.dragonDiagnosticsForTests()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertFalse(diagnostics.resourceLoaded)
    }

    func testPetSceneKeepsVectorFallbackWhenDragonV1RendererDisabled() {
        let renderer = StaticPNGDragonRenderer(enabled: false, assetRoot: dragonAssetRoot)
        let scene = PetScene(size: CGSize(width: 320, height: 320), dragonV1Renderer: renderer)

        let diagnostics = scene.dragonDiagnosticsForTests()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .disabled)
        XCTAssertFalse(diagnostics.resourceLoaded)
    }

    func testDragonRendererMotionDoesNotActivateRejectedAssets() {
        DragonV1AssetLoader.resetForTests()
        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: dragonAssetRoot)
        renderer.loadIfEnabled()

        renderer.applyMotion(horizontalDelta: -4, moving: true, facing: 1)
        renderer.update(deltaTime: 1.1)

        let diagnostics = renderer.diagnostics()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertFalse(diagnostics.resourceLoaded)
        XCTAssertNil(diagnostics.currentClipID)
    }

    func testPetSceneDragonMovementKeepsFallbackWhenApprovedAssetsAreRejected() {
        DragonV1AssetLoader.resetForTests()
        let renderer = StaticPNGDragonRenderer(enabled: true, assetRoot: dragonAssetRoot)
        let scene = PetScene(size: CGSize(width: 320, height: 320), dragonV1Renderer: renderer)

        scene.setDragonFeet(to: CGPoint(x: 180, y: 40), facing: 1)
        scene.setDragonFeet(to: CGPoint(x: 160, y: 42), facing: 1)
        scene.update(deltaTime: 1.1)

        let diagnostics = scene.dragonDiagnosticsForTests()
        XCTAssertEqual(diagnostics.selectedRenderer, .vectorFallback)
        XCTAssertEqual(diagnostics.manifestLoadResult, .manifestMissing)
        XCTAssertNil(diagnostics.currentClipID)
    }

    func testDragonFSMTransitionsThroughTakeoffFlightAndLand() {
        var machine = DragonAnimationStateMachine(takeoffDuration: 0.25, landDuration: 0.25)
        XCTAssertEqual(machine.state, .idleHover)

        machine.startFlyingLeft()
        XCTAssertEqual(machine.state, .takeoff)

        machine.update(deltaTime: 0.26)
        XCTAssertEqual(machine.state, .flyLeft)

        machine.transition(to: .flyRight)
        XCTAssertEqual(machine.state, .flyRight)

        machine.land()
        XCTAssertEqual(machine.state, .land)

        machine.update(deltaTime: 0.26)
        XCTAssertEqual(machine.state, .idleHover)
    }

    func testCharacterV2ManifestStillLoadsWithDragonAssetsPresent() throws {
        let characterV2Root = workspaceRoot.appendingPathComponent("Assets/CharacterV2")
        let catalog = CharacterAssetCatalog(entries: [
            CharacterAssetCatalogEntry(
                characterID: "default_blue_white_v2",
                displayName: "Default Blue White Companion V2",
                locations: [
                    CharacterVisualManifestLocation(
                        manifestURL: characterV2Root.appendingPathComponent("manifests/character_v2_manifest.json"),
                        assetRootURL: characterV2Root)
                ])
        ])
        let loaded = try XCTUnwrap(CharacterVisualSystemLoader.load(catalog: catalog,
                                                                    selectedDefaultCharacterID: "default_blue_white_v2"))
        let characterManifest = loaded.manifest

        XCTAssertEqual(characterManifest.manifestID, "deskpet_character_v2_p6_2_locomotion")
        XCTAssertNotNil(characterManifest.clip(for: .idle))
        XCTAssertNotNil(characterManifest.clip(for: .walkLeft))
        XCTAssertNotNil(characterManifest.clip(for: .walkRight))
    }

    func testDragonFSMDoesNotMutateCharacterScaleAnchorOrWindowSizing() {
        let characterFootprintBefore = PetScene.footprint
        let unscaledBefore = PetScene.unscaledFootprint
        let windowBefore = PetOverlayWindowMetrics.contentSize(for: characterFootprintBefore)
        let insetBefore = PetOverlayWindowMetrics.feetInset(for: windowBefore)

        var machine = DragonAnimationStateMachine(takeoffDuration: 0.1, landDuration: 0.1)
        machine.startFlyingRight()
        machine.update(deltaTime: 0.11)
        machine.transition(to: .flyLeft)
        machine.land()
        machine.update(deltaTime: 0.11)

        XCTAssertEqual(PetScene.footprint, characterFootprintBefore)
        XCTAssertEqual(PetScene.unscaledFootprint, unscaledBefore)
        XCTAssertEqual(PetOverlayWindowMetrics.contentSize(for: PetScene.footprint), windowBefore)
        XCTAssertEqual(PetOverlayWindowMetrics.feetInset(for: windowBefore), insetBefore)
    }

    private func temporaryDragonRoot(_ prefix: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    }

    private func temporaryDragonRootWithSyntheticAssets(_ prefix: String) throws -> URL {
        let root = temporaryDragonRoot(prefix)
        let manifest = syntheticAcceptedManifest()
        let manifestRoot = root.appendingPathComponent("approved/manifests")
        try FileManager.default.createDirectory(at: manifestRoot, withIntermediateDirectories: true)
        try JSONEncoder().encode(manifest)
            .write(to: manifestRoot.appendingPathComponent("dragon_v1_manifest.json"))

        let frameData = try syntheticPNGData()
        for clip in manifest.clips {
            let clipRoot = root.appendingPathComponent(clip.relativePath)
            try FileManager.default.createDirectory(at: clipRoot, withIntermediateDirectories: true)
            for frame in clip.frames {
                try frameData.write(to: clipRoot.appendingPathComponent(frame))
            }
        }

        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
        }
        return root
    }

    private func syntheticAcceptedManifest() -> DragonV1Manifest {
        let statesByClip: [String: DragonAnimationState] = [
            "dragon_idle_hover": .idleHover,
            "dragon_fly_left_loop": .flyLeft,
            "dragon_fly_right_loop": .flyRight,
            "dragon_takeoff": .takeoff,
            "dragon_land": .land,
        ]
        let clips = expectedClipFrameCounts.keys.sorted().map { name in
            let frameCount = expectedClipFrameCounts[name] ?? 0
            return DragonV1Manifest.Clip(
                name: name,
                state: statesByClip[name] ?? .idleHover,
                relativePath: "approved/clips/\(name)",
                frameCount: frameCount,
                fps: 8,
                loop: name.contains("loop") || name == "dragon_idle_hover",
                canvasSize: .init(width: 1, height: 1),
                anchorPoint: .init(x: 0.5, y: 0.5),
                frames: (0..<frameCount).map { String(format: "frame_%03d.png", $0) }
            )
        }
        return DragonV1Manifest(
            schemaVersion: 1,
            manifestID: "synthetic_dragon_v1_test_fixture",
            dragonID: "DragonV1",
            assetStatus: "accepted",
            acceptedReviewPackagePath: "synthetic-test-fixture",
            acceptedReviewTimestamp: "synthetic-test-fixture",
            humanVisualAcceptance: "ACCEPTED",
            runtime: .init(enabledByDefault: false,
                           featureGate: DragonV1RuntimeConfig.environmentKey),
            approvedRoot: "approved",
            clips: clips
        )
    }

    private func syntheticPNGData() throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: 1,
            pixelsHigh: 1,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 4,
            bitsPerPixel: 32
        ))
        bitmap.setColor(.clear, atX: 0, y: 0)
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }
}
