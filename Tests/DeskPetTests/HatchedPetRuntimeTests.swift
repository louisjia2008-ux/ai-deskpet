import XCTest
@testable import DeskPet

@MainActor
final class HatchedPetRuntimeTests: XCTestCase {
    private var root: URL {
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }

    private func assetRoot(_ name: String) -> URL {
        root.appendingPathComponent("Assets/\(name)")
    }

    private func manifestURL(assetName: String, petID: String) -> URL {
        assetRoot(assetName).appendingPathComponent("approved/clips/\(petID.replacingOccurrences(of: "-", with: "_"))_manifest.json")
    }

    private func loadManifest(assetName: String, petID: String) throws -> CharacterVisualManifest {
        let data = try Data(contentsOf: manifestURL(assetName: assetName, petID: petID))
        return try JSONDecoder().decode(CharacterVisualManifest.self, from: data)
    }

    func testHatchedGirlManifestProvidesAtLeastFiftyInteractionStates() throws {
        let manifest = try loadManifest(assetName: "HatchedGirl", petID: "hatched-girl")

        XCTAssertEqual(manifest.character.id, "hatched-girl")
        XCTAssertGreaterThanOrEqual(manifest.resolvedInteractionStates.count, 50)
        XCTAssertNoThrow(try CharacterVisualSystemLoader.validate(manifest))
        for state in manifest.resolvedInteractionStates {
            XCTAssertNotNil(manifest.clip(id: state.clipID), "missing clip for \(state.id)")
        }
    }

    func testHatchedDragonManifestProvidesAtLeastFiftyInteractionStates() throws {
        let manifest = try loadManifest(assetName: "HatchedDragon", petID: "hatched-dragon")

        XCTAssertEqual(manifest.character.id, "hatched-dragon")
        XCTAssertGreaterThanOrEqual(manifest.resolvedInteractionStates.count, 50)
        XCTAssertNoThrow(try CharacterVisualSystemLoader.validate(manifest))
        for state in manifest.resolvedInteractionStates {
            XCTAssertNotNil(manifest.clip(id: state.clipID), "missing clip for \(state.id)")
        }
    }

    func testHatchedPetCatalogEntriesLoadWhenSelected() throws {
        for (assetName, petID, displayName) in [
            ("HatchedGirl", "hatched-girl", "Hatched Girl"),
            ("HatchedDragon", "hatched-dragon", "Hatched Dragon")
        ] {
            let catalog = CharacterAssetCatalog(entries: [
                CharacterAssetCatalogEntry(
                    characterID: petID,
                    displayName: displayName,
                    locations: [
                        CharacterVisualManifestLocation(
                            manifestURL: manifestURL(assetName: assetName, petID: petID),
                            assetRootURL: assetRoot(assetName))
                    ])
            ])

            let loaded = try XCTUnwrap(CharacterVisualSystemLoader.load(catalog: catalog,
                                                                        selectedDefaultCharacterID: petID))
            XCTAssertEqual(loaded.characterID, petID)
            XCTAssertFalse(loaded.loadedFallbackCharacter)
            XCTAssertGreaterThanOrEqual(loaded.manifest.resolvedInteractionStates.count, 50)
        }
    }

    func testRuntimeCatalogDefaultsToGirlAndIgnoresRetiredPlaceholders() {
        let defaults = UserDefaults.standard
        let original = defaults.string(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        defaults.removeObject(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        defer {
            if let original {
                defaults.set(original, forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
            } else {
                defaults.removeObject(forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
            }
        }

        XCTAssertNotNil(CharacterAssetCatalog.runtimeDefault(preferredCharacterID: "hatched-girl")
            .entries.first(where: { $0.characterID == "hatched-girl" }),
            "HatchedGirl must remain registered as the primary character")

        defaults.set("lumi-scholar", forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        XCTAssertEqual(CharacterAssetCatalog.runtimeDefault().entries.first?.characterID, "hatched-girl")

        defaults.set("default_blue_white_v2", forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        XCTAssertEqual(CharacterAssetCatalog.runtimeDefault().entries.first?.characterID, "hatched-girl")

        defaults.set("hatched-dragon", forKey: CharacterAssetCatalog.selectedCharacterDefaultsKey)
        XCTAssertEqual(CharacterAssetCatalog.runtimeDefault().entries.first?.characterID, "hatched-dragon")
    }

    func testInteractionStateResolvesToRendererIntent() throws {
        let manifest = try loadManifest(assetName: "HatchedGirl", petID: "hatched-girl")
        let state = try XCTUnwrap(manifest.interactionState(id: "girl_tool_running"))
        let intent = state.intent(source: .userInteraction, now: 42)

        XCTAssertEqual(state.clipID, "task_running")
        XCTAssertEqual(intent.state, .taskRunning)
        XCTAssertEqual(intent.emotion, .curious)
        XCTAssertEqual(intent.createdAt, 42)
    }

    func testCompanionDragonUsesSmallPetScale() {
        XCTAssertLessThanOrEqual(PetScene.dragonVisualSize.height,
                                 PetScene.footprint.height * 0.55)
        XCTAssertLessThanOrEqual(PetScene.companionDragonScale, 0.30)
    }

    func testDirectionalMovementClipsHaveDistinctFrames() throws {
        for assetName in ["HatchedGirl", "HatchedDragon"] {
            for clipID in ["move_right", "move_left"] {
                let clipRoot = assetRoot(assetName)
                    .appendingPathComponent("approved/clips")
                    .appendingPathComponent(clipID)
                let frameURLs = try FileManager.default.contentsOfDirectory(
                    at: clipRoot,
                    includingPropertiesForKeys: nil)
                    .filter { $0.lastPathComponent.hasPrefix("frame_") }
                    .sorted { $0.lastPathComponent < $1.lastPathComponent }

                XCTAssertEqual(frameURLs.count, 8, "\(assetName) \(clipID) must keep an 8-frame movement loop")
                let uniqueFrames = Set(try frameURLs.map { try Data(contentsOf: $0) })
                XCTAssertGreaterThanOrEqual(uniqueFrames.count, 6,
                                            "\(assetName) \(clipID) must not be a mostly static loop")
            }
        }
    }

    func testPetSceneLoadsGirlAndDragonTogether() throws {
        CharacterVisualSystemLoader.resetForTests()
        let scene = PetScene(size: CGSize(width: 320, height: 260))

        let girl = scene.diagnostics()
        let dragon = scene.companionDragonDiagnosticsForTests()

        XCTAssertEqual(girl.characterID, "hatched-girl")
        XCTAssertTrue(girl.resourceLoaded)
        XCTAssertEqual(dragon.characterID, "hatched-dragon")
        XCTAssertTrue(dragon.resourceLoaded)
    }
}
