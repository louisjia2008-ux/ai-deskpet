import XCTest
import Foundation
@testable import DeskPet

@MainActor
final class LumiScholarRuntimeTests: XCTestCase {
    private var root: URL {
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }

    private var manifestURL: URL {
        root.appendingPathComponent("Assets/LumiScholar/approved/clips/lumi_scholar_manifest.json")
    }

    private func loadManifestJSON() throws -> [String: Any] {
        let data = try Data(contentsOf: manifestURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func loadManifest() throws -> CharacterVisualManifest {
        let data = try Data(contentsOf: manifestURL)
        return try JSONDecoder().decode(CharacterVisualManifest.self, from: data)
    }

    func testLumiScholarManifestDecodes() throws {
        let manifest = try loadManifest()

        XCTAssertEqual(manifest.schemaVersion, 2)
        XCTAssertEqual(manifest.character.id, "lumi-scholar")
        XCTAssertEqual(manifest.character.displayName, "Lumi Scholar")
        XCTAssertEqual(manifest.canvas?.spriteWidth, 192)
        XCTAssertEqual(manifest.canvas?.spriteHeight, 208)
        XCTAssertNoThrow(try CharacterVisualSystemLoader.validate(manifest))
    }

    func testAllReferencedLumiFramesExist() throws {
        let manifest = try loadManifest()
        let clipsRoot = root.appendingPathComponent("Assets/LumiScholar/approved/clips")

        for clip in manifest.clips where !clip.placeholder {
            for frameID in clip.frames {
                let frame = clipsRoot
                    .appendingPathComponent(clip.id)
                    .appendingPathComponent("\(frameID).png")
                XCTAssertTrue(FileManager.default.fileExists(atPath: frame.path), "missing \(frame.path)")
            }
        }
    }

    func testLumiStateNamesAreUnique() throws {
        let manifest = try loadManifest()
        let states = manifest.clips.map(\.state.rawValue)

        XCTAssertEqual(states.count, Set(states).count)
    }

    func testMoveRightAndTaskRunningAreDistinct() throws {
        let manifest = try loadManifest()
        let moveRight = try XCTUnwrap(manifest.clip(id: "move_right"))
        let taskRunning = try XCTUnwrap(manifest.clip(id: "task_running"))

        XCTAssertEqual(moveRight.state, .walkRight)
        XCTAssertEqual(taskRunning.state, .taskRunning)
        XCTAssertNotEqual(moveRight.id, taskRunning.id)
        XCTAssertNil(taskRunning.direction)
    }

    func testEmptyGridCellsAreExcluded() throws {
        let reportURL = root.appendingPathComponent("Assets/LumiScholar/qa/import_report.json")
        let data = try Data(contentsOf: reportURL)
        let report = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let skipped = try XCTUnwrap(report["skipped_blank_cells"] as? [[String: Any]])
        let alpha = try XCTUnwrap(report["alpha_validation"] as? [String: Any])
        let exported = try XCTUnwrap(alpha["exported_frame_count"] as? Int)

        XCTAssertEqual(exported, 74)
        XCTAssertEqual(skipped.count, 14)
        XCTAssertEqual(exported + skipped.count, 8 * 11)
    }

    func testLookDirectionsContainExactly16ValidPoses() throws {
        let manifestJSON = try loadManifestJSON()
        let directions = try XCTUnwrap(manifestJSON["lookDirections"] as? [[String: Any]])
        let ids = directions.compactMap { $0["clipID"] as? String }

        XCTAssertEqual(ids, CharacterLookPoseResolver.clipIDs)
        XCTAssertEqual(ids.count, 16)
        for id in ids {
            let clip = try XCTUnwrap(try loadManifest().clip(id: id))
            XCTAssertEqual(clip.frames, ["frame_000"])
            XCTAssertFalse(clip.loop)
        }
    }

    func testLookAngleWrapAroundChoosesNearestPose() {
        XCTAssertEqual(CharacterLookPoseResolver.nearestPose(for: 360).clipID, "look_000")
        XCTAssertEqual(CharacterLookPoseResolver.nearestPose(for: -1).clipID, "look_000")
        XCTAssertEqual(CharacterLookPoseResolver.nearestPose(for: 348.8).clipID, "look_000")
        XCTAssertEqual(CharacterLookPoseResolver.nearestPose(for: 337.5).clipID, "look_337_5")
    }

    func testOneShotStatesReturnToIdle() {
        let machine = CharacterAnimationStateMachine(reactionCooldown: 0)
        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .idle,
                                                             source: .runtimeLifecycle,
                                                             createdAt: 1), now: 1))
        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .jump,
                                                             priority: 68,
                                                             duration: 0.5,
                                                             source: .agentRuntime,
                                                             createdAt: 2), now: 2))
        machine.update(now: 2.51)
        XCTAssertEqual(machine.state, .idle)

        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .taskFailed,
                                                             priority: 70,
                                                             duration: 0.5,
                                                             source: .agentRuntime,
                                                             createdAt: 3), now: 3))
        machine.update(now: 3.51)
        XCTAssertEqual(machine.state, .idle)
    }

    func testTerminalFailureCannotRemainTaskRunning() {
        let machine = CharacterAnimationStateMachine(reactionCooldown: 0)
        XCTAssertTrue(machine.apply(CharacterAnimationIntent(state: .idle,
                                                             source: .runtimeLifecycle,
                                                             createdAt: 1), now: 1))
        XCTAssertTrue(machine.apply(AgentAnimationEventMapper.intent(for: .taskRunning, now: 2), now: 2))
        XCTAssertEqual(machine.state, .taskRunning)

        XCTAssertTrue(machine.apply(AgentAnimationEventMapper.intent(for: .terminalFailure, now: 3), now: 3))
        XCTAssertEqual(machine.state, .taskFailed)
        machine.update(now: 4.5)
        XCTAssertEqual(machine.state, .idle)
        XCTAssertNotEqual(machine.state, .taskRunning)
    }

    func testDefaultRuntimeCharacterLoadsHatchedGirl() throws {
        let defaults = UserDefaults.standard
        let original = defaults.string(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        defaults.removeObject(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        defer {
            CharacterVisualSystemLoader.resetForTests()
            if let original {
                defaults.set(original, forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
            } else {
                defaults.removeObject(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
            }
        }

        CharacterVisualSystemLoader.resetForTests()
        let loaded = try XCTUnwrap(CharacterVisualSystemLoader.loadDefaultSystem())

        XCTAssertEqual(loaded.characterID, "hatched-girl")
        XCTAssertFalse(loaded.loadedFallbackCharacter)
        XCTAssertEqual(loaded.manifest.clip(id: "move_right")?.state, .walkRight)
        XCTAssertEqual(loaded.manifest.clip(id: "task_running")?.state, .taskRunning)
        XCTAssertGreaterThanOrEqual(loaded.manifest.resolvedInteractionStates.count, 50)
    }

    /// Regression guard for replacing the old placeholder default with the hatched pets.
    /// The girl is the production main pet, and the dragon is loaded as the companion in PetScene.
    func testProductionDefaultsPinHatchedPetsAsDefaultCharacters() throws {
        XCTAssertEqual(CharacterAssetCatalog.defaultCharacterID, "hatched-girl")

        let defaults = UserDefaults.standard
        let original = defaults.string(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        defaults.removeObject(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        defer {
            CharacterVisualSystemLoader.resetForTests()
            if let original {
                defaults.set(original, forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
            } else {
                defaults.removeObject(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
            }
        }

        XCTAssertEqual(CharacterAssetCatalog.runtimeDefault().entries.first?.characterID,
                       "hatched-girl",
                       "runtime default catalog must put HatchedGirl first when no override is set")

        CharacterVisualSystemLoader.resetForTests()
        let scene = PetScene(size: CGSize(width: 320, height: 260))
        XCTAssertEqual(scene.diagnostics().characterID, "hatched-girl")
        XCTAssertEqual(scene.companionDragonDiagnosticsForTests().characterID, "hatched-dragon")
        XCTAssertTrue(scene.diagnostics().resourceLoaded)
        XCTAssertTrue(scene.companionDragonDiagnosticsForTests().resourceLoaded)
    }

    func testCorruptedLumiManifestFallsBackToCharacterV2() throws {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-lumi-corrupt-\(UUID().uuidString)")
        let lumiRoot = temp.appendingPathComponent("LumiScholar")
        let manifestDir = lumiRoot.appendingPathComponent("approved/clips")
        try FileManager.default.createDirectory(at: manifestDir, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: manifestDir.appendingPathComponent("lumi_scholar_manifest.json"))

        let characterV2Root = root.appendingPathComponent("Assets/CharacterV2")
        let catalog = CharacterAssetCatalog(entries: [
            CharacterAssetCatalogEntry(
                characterID: "lumi-scholar",
                displayName: "Lumi Scholar",
                locations: [
                    CharacterVisualManifestLocation(
                        manifestURL: manifestDir.appendingPathComponent("lumi_scholar_manifest.json"),
                        assetRootURL: lumiRoot)
                ]),
            CharacterAssetCatalogEntry(
                characterID: "default_blue_white_v2",
                displayName: "Default Blue White Companion V2",
                locations: [
                    CharacterVisualManifestLocation(
                        manifestURL: characterV2Root.appendingPathComponent("manifests/character_v2_manifest.json"),
                        assetRootURL: characterV2Root)
                ])
        ])

        let loaded = try XCTUnwrap(CharacterVisualSystemLoader.load(catalog: catalog))
        XCTAssertEqual(loaded.characterID, "default_blue_white_v2")
        XCTAssertTrue(loaded.loadedFallbackCharacter)
        XCTAssertTrue(loaded.fallbackReason?.contains("Lumi Scholar manifest failed") ?? false)
    }

    func testCharacterV2FallbackBehaviorRemainsUnchanged() throws {
        let characterV2Root = root.appendingPathComponent("Assets/CharacterV2")
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
        XCTAssertEqual(loaded.characterID, "default_blue_white_v2")
        XCTAssertFalse(loaded.loadedFallbackCharacter)
        XCTAssertNotNil(loaded.manifest.clip(id: "walk_left"))
        XCTAssertNotNil(loaded.manifest.clip(id: "walk_right"))
    }

    func testBuildConfigurationCopiesLumiAssetsIntoAppBundle() throws {
        let project = try String(contentsOf: root.appendingPathComponent("project.yml"), encoding: .utf8)
        let buildScript = try String(contentsOf: root.appendingPathComponent("scripts/build_app.sh"), encoding: .utf8)

        XCTAssertTrue(project.contains("Assets/LumiScholar"))
        XCTAssertTrue(buildScript.contains("Resources/LumiScholar"))
    }

    func testContactSheetIsNotRuntimeSpriteSource() throws {
        let manifestJSON = try loadManifestJSON()
        let runtimeReferences = try JSONSerialization.data(
            withJSONObject: [
                "clips": manifestJSON["clips"] ?? [],
                "lookDirections": manifestJSON["lookDirections"] ?? []
            ],
            options: [.sortedKeys])
        let text = String(data: runtimeReferences, encoding: .utf8) ?? ""

        XCTAssertFalse(text.contains("contact_sheet"))
        XCTAssertFalse(text.contains("lumi_scholar_runtime_review"))
        XCTAssertFalse(text.contains(".gif"))
        XCTAssertFalse(text.contains(".webp"))
        XCTAssertFalse(text.contains("review/"))
    }
}
