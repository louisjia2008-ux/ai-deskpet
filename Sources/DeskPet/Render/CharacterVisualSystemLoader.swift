import Foundation

struct CharacterVisualManifestLocation: Equatable {
    var manifestURL: URL
    var assetRootURL: URL
}

struct CharacterAssetCatalogEntry: Equatable {
    var characterID: String
    var displayName: String
    var locations: [CharacterVisualManifestLocation]
}

struct CharacterAssetCatalog: Equatable {
    static let defaultCharacterID = "hatched-girl"
    static let selectedCharacterDefaultsKey = "DeskPet.selectedCharacterID"
    private static let retiredPlaceholderCharacterIDs: Set<String> = [
        "lumi-scholar",
        "default_blue_white_v2"
    ]

    var entries: [CharacterAssetCatalogEntry]

    static func runtimeDefault(preferredCharacterID: String? = nil) -> CharacterAssetCatalog {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        var entries: [CharacterAssetCatalogEntry] = []

        entries.append(CharacterAssetCatalogEntry(
            characterID: "hatched-girl",
            displayName: "Hatched Girl",
            locations: locations(
                bundleRootName: "HatchedGirl",
                manifestRelativePath: "approved/clips/hatched_girl_manifest.json",
                sourceRoots: [
                    cwd.appendingPathComponent("Assets/HatchedGirl"),
                    cwd.appendingPathComponent("DeskPet/Assets/HatchedGirl")
                ])))

        entries.append(CharacterAssetCatalogEntry(
            characterID: "hatched-dragon",
            displayName: "Hatched Dragon",
            locations: locations(
                bundleRootName: "HatchedDragon",
                manifestRelativePath: "approved/clips/hatched_dragon_manifest.json",
                sourceRoots: [
                    cwd.appendingPathComponent("Assets/HatchedDragon"),
                    cwd.appendingPathComponent("DeskPet/Assets/HatchedDragon")
                ])))

        entries.append(CharacterAssetCatalogEntry(
            characterID: "lumi-scholar",
            displayName: "Lumi Scholar",
            locations: locations(
                bundleRootName: "LumiScholar",
                manifestRelativePath: "approved/clips/lumi_scholar_manifest.json",
                sourceRoots: [
                    cwd.appendingPathComponent("Assets/LumiScholar"),
                    cwd.appendingPathComponent("DeskPet/Assets/LumiScholar")
                ])))

        entries.append(CharacterAssetCatalogEntry(
            characterID: "default_blue_white_v2",
            displayName: "Default Blue White Companion V2",
            locations: locations(
                bundleRootName: "CharacterV2",
                manifestRelativePath: "manifests/character_v2_manifest.json",
                sourceRoots: [
                    cwd.appendingPathComponent("Assets/CharacterV2"),
                    cwd.appendingPathComponent("DeskPet/Assets/CharacterV2")
                ])))

        let selected = preferredCharacterID ?? UserDefaults.standard.string(forKey: selectedCharacterDefaultsKey)
        if let selected,
           !retiredPlaceholderCharacterIDs.contains(selected),
           let selectedIndex = entries.firstIndex(where: { $0.characterID == selected }) {
            let selectedEntry = entries.remove(at: selectedIndex)
            entries.insert(selectedEntry, at: 0)
        }

        return CharacterAssetCatalog(entries: entries)
    }

    private static func locations(bundleRootName: String,
                                  manifestRelativePath: String,
                                  sourceRoots: [URL]) -> [CharacterVisualManifestLocation] {
        var values: [CharacterVisualManifestLocation] = []
        if let bundleRoot = Bundle.main.resourceURL?.appendingPathComponent(bundleRootName) {
            values.append(CharacterVisualManifestLocation(
                manifestURL: bundleRoot.appendingPathComponent(manifestRelativePath),
                assetRootURL: bundleRoot))
        }
        values.append(contentsOf: sourceRoots.map {
            CharacterVisualManifestLocation(
                manifestURL: $0.appendingPathComponent(manifestRelativePath),
                assetRootURL: $0)
        })
        var seen = Set<String>()
        return values.filter { seen.insert($0.manifestURL.path).inserted }
    }
}

struct LoadedCharacterVisualSystem: Equatable {
    var manifest: CharacterVisualManifest
    var manifestPath: String
    var assetRootPath: String
    var characterID: String
    var selectedDefaultCharacterID: String
    var fallbackReason: String?
    /// P19.2 — secondary asset root used to resolve injected CharacterV2
    /// clip frames. When nil, frame lookups fall back to `assetRootPath`.
    var secondaryAssetRootPath: String? = nil

    var loadedFallbackCharacter: Bool {
        characterID != selectedDefaultCharacterID
    }
}

enum CharacterVisualSystemValidationError: LocalizedError, Equatable {
    case missingClip(String)
    case invalidClip(String)
    case duplicateClip(String)
    case invalidHabitat(String)
    case invalidFallback(String)

    var errorDescription: String? {
        switch self {
        case .missingClip(let id):
            return "Character visual manifest is missing required clip \(id)"
        case .invalidClip(let id):
            return "Character visual clip \(id) has invalid fps, frames, pivot, or hitbox"
        case .duplicateClip(let id):
            return "Character visual manifest contains duplicate clip \(id)"
        case .invalidHabitat(let id):
            return "Character visual habitat \(id) is missing anchor, hitbox, or placeholder metadata"
        case .invalidFallback(let id):
            return "Character visual clip \(id) has invalid or unsafe fallback metadata"
        }
    }
}

@MainActor
enum CharacterVisualSystemLoader {
    private static var cached: LoadedCharacterVisualSystem?
    private static var cachedFallbackReason: String?

    static func loadDefault() -> CharacterVisualManifest? {
        loadDefaultSystem()?.manifest
    }

    static func loadDefaultSystem() -> LoadedCharacterVisualSystem? {
        if let cached { return cached }
        let loaded = load(catalog: .runtimeDefault())
        cached = loaded
        return loaded
    }

    static func load(catalog: CharacterAssetCatalog,
                     selectedDefaultCharacterID: String = CharacterAssetCatalog.defaultCharacterID) -> LoadedCharacterVisualSystem? {
        let decoder = JSONDecoder()
        var fallbackReasons: [String] = []

        for entry in catalog.entries {
            var entryFailures: [String] = []
            for location in entry.locations {
                let path = location.manifestURL.path
                guard FileManager.default.fileExists(atPath: path) else {
                    continue
                }
                do {
                    let data = try Data(contentsOf: location.manifestURL)
                    let manifest = try decoder.decode(CharacterVisualManifest.self, from: data)
                    try validate(manifest)
                    try validateFrameReferences(manifest, assetRootURL: location.assetRootURL)
                    guard manifest.character.id == entry.characterID else {
                        throw CharacterVisualSystemValidationError.invalidClip(
                            "manifest character id \(manifest.character.id) does not match catalog \(entry.characterID)")
                    }
                    let reason = fallbackReasons.isEmpty ? nil : fallbackReasons.joined(separator: " | ")
                    cachedFallbackReason = reason
                    NSLog("[DeskPet] Loaded \(entry.displayName) manifest from \(path)")
                    return LoadedCharacterVisualSystem(
                        manifest: manifest,
                        manifestPath: path,
                        assetRootPath: location.assetRootURL.path,
                        characterID: entry.characterID,
                        selectedDefaultCharacterID: selectedDefaultCharacterID,
                        fallbackReason: reason)
                } catch {
                    let message = "\(entry.displayName) manifest failed at \(path): \(error.localizedDescription)"
                    entryFailures.append(message)
                    NSLog("[DeskPet] \(message)")
                }
            }
            if !entryFailures.isEmpty {
                fallbackReasons.append(entryFailures.joined(separator: " | "))
            } else {
                let searched = entry.locations.map(\.manifestURL.path).joined(separator: " | ")
                fallbackReasons.append("\(entry.displayName) manifest not found. searched=\(searched)")
            }
        }
        cachedFallbackReason = fallbackReasons.isEmpty
            ? "Character visual manifest not found; using legacy static PNG animation config"
            : fallbackReasons.joined(separator: " | ")
        NSLog("[DeskPet] \(cachedFallbackReason ?? "")")
        return nil
    }

    static func fallbackReason() -> String? {
        cachedFallbackReason
    }

    static func resetForTests() {
        cached = nil
        cachedFallbackReason = nil
    }

    static func validate(_ manifest: CharacterVisualManifest) throws {
        let requiredStates: Set<CharacterAnimationState> = [
            .idle,
            .blink,
            .idleLookAround,
            .startMoving,
            .stopMoving,
            .startMovingLeft,
            .startMovingRight,
            .stopMovingLeft,
            .stopMovingRight,
            .turnLeftToFront,
            .walkLeft,
            .walkRight,
            .briskWalkLeft,
            .briskWalkRight,
            .runLeft,
            .runRight
        ]
        var seen = Set<String>()
        for clip in manifest.clips {
            guard seen.insert(clip.id).inserted else { throw CharacterVisualSystemValidationError.duplicateClip(clip.id) }
            guard isValid(clip) else { throw CharacterVisualSystemValidationError.invalidClip(clip.id) }
        }
        let presentStates = Set(manifest.clips.map(\.state))
        for state in requiredStates where !presentStates.contains(state) {
            throw CharacterVisualSystemValidationError.missingClip(state.rawValue)
        }
        for clip in manifest.clips {
            guard isValidFallback(for: clip, manifest: manifest) else {
                throw CharacterVisualSystemValidationError.invalidFallback(clip.id)
            }
        }
        for state in manifest.resolvedInteractionStates {
            guard !state.id.isEmpty,
                  !state.displayName.isEmpty,
                  !state.category.isEmpty,
                  !state.trigger.isEmpty,
                  manifest.clip(id: state.clipID) != nil else {
                throw CharacterVisualSystemValidationError.invalidClip("interaction state \(state.id)")
            }
        }
        guard isUnitPoint(manifest.habitat.anchor),
              manifest.habitat.hitbox.width > 0,
              manifest.habitat.hitbox.height > 0 else {
            throw CharacterVisualSystemValidationError.invalidHabitat(manifest.habitat.id)
        }
    }

    private static func isValid(_ clip: CharacterVisualClip) -> Bool {
        let baseFps = clip.resolvedBaseFps
        let minFps = clip.minFps ?? baseFps
        let maxFps = clip.maxFps ?? baseFps
        let validFps = clip.fps > 0
            && baseFps > 0
            && minFps > 0
            && maxFps > 0
            && minFps <= baseFps
            && baseFps <= maxFps
        let validEvents = clip.events.allSatisfy { $0.frame >= 0 && $0.frame < clip.frames.count }
        let validContacts = (clip.footContacts ?? []).allSatisfy { $0.frame >= 0 && $0.frame < clip.frames.count }
        return validFps
            && !clip.frames.isEmpty
            && isUnitPoint(clip.pivot)
            && clip.hitbox.width > 0
            && clip.hitbox.height > 0
            && clip.hitbox.x >= 0
            && clip.hitbox.y >= 0
            && clip.hitbox.x + clip.hitbox.width <= 1
            && clip.hitbox.y + clip.hitbox.height <= 1
            && validEvents
            && validContacts
    }

    private static func validateFrameReferences(_ manifest: CharacterVisualManifest,
                                                assetRootURL: URL) throws {
        for clip in manifest.clips where !clip.placeholder {
            for frameID in clip.frames {
                let path = assetRootURL
                    .appendingPathComponent("approved/clips")
                    .appendingPathComponent(clip.id)
                    .appendingPathComponent("\(frameID).png")
                    .path
                guard FileManager.default.fileExists(atPath: path) else {
                    throw CharacterVisualSystemValidationError.invalidClip("\(clip.id) missing frame \(frameID)")
                }
            }
        }
    }

    private static func isValidFallback(for clip: CharacterVisualClip, manifest: CharacterVisualManifest) -> Bool {
        guard let fallback = clip.fallback else { return true }
        guard let fallbackClip = manifest.clip(id: fallback.clipID), fallbackClip.id != clip.id else { return false }
        if let direction = clip.direction,
           let fallbackDirection = fallbackClip.direction,
           direction != fallbackDirection {
            return false
        }
        if clip.assetStatus == .approved {
            return false
        }
        if clip.direction != nil,
           fallbackClip.direction == nil,
           !allowedDirectionlessFallbackModes.contains(fallback.mode) {
            return false
        }
        return true
    }

    private static let allowedDirectionlessFallbackModes: Set<String> = [
        "TEMP_LEGACY_DIRECTIONLESS_FALLBACK",
        "TEMP_IDLE_QUALITY_FALLBACK",
        "TEMP_LOCOMOTION_ALIAS_FALLBACK"
    ]

    private static func isUnitPoint(_ point: CharacterVisualPoint) -> Bool {
        point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    }

}
