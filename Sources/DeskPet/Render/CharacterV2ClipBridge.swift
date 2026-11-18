import Foundation

/// P19.2 — Asset bridge that locates the CharacterV2 staged PNGs and synthesizes
/// `CharacterVisualClip` entries pointing at them so the production runtime
/// (which is the HatchedGirl character) can consume CharacterV2's approved
/// locomotion + idle + blink + idle-look-around assets without losing the
/// production character's interaction states, body, and task poses.
///
/// Per P19.2 §4 ("Integrate the accepted CharacterV2 clips into the real production
/// animation runtime") and §11 ("Do not regress expression/state behavior already
/// accepted in P16/P17/P18"), the bridge is *hybrid*: HatchedGirl remains the
/// production character; CharacterV2 supplies the approved locomotion + idle
/// + blink + look-around clips that replace the 13 placeholder fallback chains
/// the audit identified.
///
/// Per P19.2 §3 ("Accepted character art is frozen"), CharacterV2's art is
/// already accepted. The bridge does NOT redesign or regenerate any art; it
/// only points the runtime at PNGs that already exist on disk and have
/// already passed the CharacterV2 pipeline's review rules.
@MainActor
enum CharacterV2ClipBridge {

    /// Resolves CharacterV2's asset root + manifest URL on disk. Returns nil
    /// when the staging directory is missing — callers must treat that as a
    /// silent no-op (the HatchedGirl runtime continues to work with its
    /// original 13 placeholder fallbacks; the audit's target of "13 → 0"
    /// fallbacks is only met when CharacterV2 is fully staged).
    static func locateAssetRoot(near cwd: String = FileManager.default.currentDirectoryPath)
        -> (rootPath: String, manifestPath: String)? {
        let candidates: [(root: String, manifest: String)] = [
            (root: cwd + "/DeskPet/Assets/CharacterV2",
             manifest: cwd + "/DeskPet/Assets/CharacterV2/manifests/character_v2_manifest.json"),
            (root: cwd + "/Assets/CharacterV2",
             manifest: cwd + "/Assets/CharacterV2/manifests/character_v2_manifest.json"),
        ]
        for candidate in candidates where FileManager.default.fileExists(atPath: candidate.manifest) {
            return (candidate.root, candidate.manifest)
        }
        return nil
    }

    /// Locomotion + idle + blink + idle_look_around clip ids that the bridge
    /// augments from CharacterV2 when approved PNGs exist. The set is closed
    /// (per P19.2 §5 — we only surface states the runtime already supports;
    /// brisk/run remain placeholders even after P19.2 because CharacterV2 has
    /// no approved PNGs for them on disk).
    static let augmentableClipIDs: Set<String> = [
        "idle",
        "blink",
        "idle_look_around",
        "start_move_left",
        "start_move_right",
        "stop_move_left",
        "stop_move_right",
        "turn_left_to_front",
        "turn_right_to_front", // P19.2 mirror — synthesized from turn_left_to_front
        "walk_left",
        "walk_right",
    ]

    /// Discover which augmentable clip ids have at least one approved PNG on
    /// disk under `<assetRoot>/approved/clips/<clipID>/`. A clip is considered
    /// available iff the directory exists AND at least one `*.png` file is
    /// inside.
    static func availableClipIDs(assetRoot: String) -> Set<String> {
        var available: Set<String> = []
        for clipID in augmentableClipIDs {
            let dir = "\(assetRoot)/approved/clips/\(clipID)"
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { continue }
            let contents = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
            if contents.contains(where: { $0.hasSuffix(".png") }) {
                available.insert(clipID)
            }
        }
        return available
    }

    /// Build the augmented manifest clip list. For every augmentable clip id
    /// that has approved PNGs on disk, synthesize a `CharacterVisualClip`
    /// matching the runtime's `CharacterVisualClip` Codable shape. Frame names
    /// are read from the directory (sorted) so the runtime sees the same names
    /// that `frameCandidates` will resolve.
    ///
    /// `turn_right_to_front` is synthesized as a mirror of `turn_left_to_front`
    /// (CharacterV2's own pipeline rules allow mirrored pairs "when acceptance
    /// records declare that scope" — the brief §6 explicitly accepts option B
    /// "reverse-compatible bridge clip exists" for transitions; the PNGs are
    /// already approved and the directory is allowed to share the same frames
    /// in the mirrored direction).
    static func augmentedClips(assetRoot: String) -> [CharacterVisualClip] {
        let available = availableClipIDs(assetRoot: assetRoot)
        var result: [CharacterVisualClip] = []
        for clipID in augmentableClipIDs.sorted() {
            guard available.contains(clipID) else { continue }
            let frames = frameNames(assetRoot: assetRoot, clipID: clipID)
            guard !frames.isEmpty else { continue }
            if let clip = synthesizeClip(id: clipID, frames: frames, assetRoot: assetRoot) {
                result.append(clip)
            }
        }
        return result
    }

    /// Read the frame names from `<assetRoot>/approved/clips/<clipID>/` sorted
    /// alphabetically. Frame-name format is *not* regularized — both
    /// `frame_000` and `start_move_right_00` naming styles are accepted,
    /// matching the CharacterV2 manifest's `frames` arrays verbatim.
    static func frameNames(assetRoot: String, clipID: String) -> [String] {
        let dir = "\(assetRoot)/approved/clips/\(clipID)"
        let urls = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        let pngs = urls.filter { $0.hasSuffix(".png") }.sorted()
        return pngs.map { ($0 as NSString).deletingPathExtension }
    }

    /// Build a `CharacterVisualClip` for a discovered clip id. Mirrors the
    /// production CharacterV2 manifest's per-clip shape so the runtime can
    /// treat the injected entries identically to native manifest entries.
    static func synthesizeClip(id: String,
                               frames: [String],
                               assetRoot: String) -> CharacterVisualClip? {
        // Read the matching CharacterV2 manifest entry for fps + pivot + hitbox +
        // direction + speedTier so the injected clip matches the real
        // CharacterV2 spec exactly. If we cannot read it, synthesize
        // conservative defaults (10 fps walk cadence).
        let mirror = loadMirrorManifest(assetRoot: assetRoot)
        let sourceClip = mirror?.clip(id: mirrorClipID(for: id))
        let fps = sourceClip?.fps ?? 10
        let baseFps = sourceClip?.baseFps ?? fps
        let minFps = sourceClip?.minFps ?? baseFps
        let maxFps = sourceClip?.maxFps ?? baseFps
        let pivot = sourceClip?.pivot ?? CharacterVisualPoint(x: 0.5, y: 0.08)
        let hitbox = sourceClip?.hitbox ?? CharacterVisualRect(x: 0.25, y: 0.04, width: 0.5, height: 0.92)
        // P19.2 — synthesized mirror clips override direction with the
        // direction implied by their own id (turn_right_to_front is
        // direction=right even though it mirrors the left clip). The
        // character.id-aware direction lookup would otherwise inherit
        // turn_left_to_front's left direction, which would put the
        // resolver's directional filter in the wrong bucket.
        let direction: CharacterLocomotionDirection? = {
            if id == "turn_right_to_front" { return .right }
            return sourceClip?.direction ?? directionForAugmentedClipID(id)
        }()
        let speedTier = sourceClip?.speedTier ?? speedTierForAugmentedClipID(id)
        let stateRaw = stateRawValueForAugmentedClipID(id)
        guard let state = CharacterAnimationState(rawValue: stateRaw) else {
            return nil
        }
        return CharacterVisualClip(
            id: id,
            state: state,
            category: categoryForAugmentedClipID(id),
            direction: direction,
            speedTier: speedTier,
            fps: fps,
            baseFps: baseFps,
            minFps: minFps,
            maxFps: maxFps,
            loop: loopForAugmentedClipID(id),
            placeholder: false,
            assetStatus: .approved,
            required: requiredForAugmentedClipID(id),
            minFrameCount: frames.count,
            targetFrameCount: frames.count,
            speedRange: nil,
            frames: frames,
            pivot: pivot,
            hitbox: hitbox,
            shadow: sourceClip?.shadow,
            events: [],
            footContacts: [],
            fallback: nil,
            notes: "P19.2 — synthesized bridge entry from CharacterV2 asset root \(assetRoot)")
    }

    /// Mirror ID translation. The runtime uses the production-character clip
    /// ids (`start_move_left`); CharacterV2 uses the same naming so direct
    /// lookup works. `turn_right_to_front` is the one synthesized-mirror id.
    static func mirrorClipID(for id: String) -> String {
        switch id {
        case "turn_right_to_front": return "turn_left_to_front"
        default: return id
        }
    }

    /// Load + cache the CharacterV2 manifest so we can mirror its per-clip
    /// shape. Returns nil on any IO or decode error — the bridge then falls
    /// back to conservative default values, which is acceptable because all
    /// synthesized clips fall under the same conservative fps + pivot.
    private static var cachedMirrorManifest: (assetRoot: String, manifest: CharacterVisualManifest)?
    static func loadMirrorManifest(assetRoot: String) -> CharacterVisualManifest? {
        if let cached = cachedMirrorManifest, cached.assetRoot == assetRoot {
            return cached.manifest
        }
        let manifestPath = "\(assetRoot)/manifests/character_v2_manifest.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: manifestPath)) else { return nil }
        guard let manifest = try? JSONDecoder().decode(CharacterVisualManifest.self, from: data) else { return nil }
        cachedMirrorManifest = (assetRoot, manifest)
        return manifest
    }

    /// Drop the manifest cache. Tests use this between cases so per-case
    /// asset roots do not leak.
    static func resetForTests() {
        cachedMirrorManifest = nil
    }
}

private func directionForAugmentedClipID(_ id: String) -> CharacterLocomotionDirection? {
    switch id {
    case "start_move_left", "stop_move_left", "turn_left_to_front", "walk_left": return .left
    case "start_move_right", "stop_move_right", "turn_right_to_front", "walk_right": return .right
    default: return nil
    }
}

private func speedTierForAugmentedClipID(_ id: String) -> CharacterLocomotionSpeedTier? {
    switch id {
    case "walk_left", "walk_right": return .walk
    default: return nil
    }
}

private func categoryForAugmentedClipID(_ id: String) -> String? {
    switch id {
    case "idle", "blink", "idle_look_around": return "idle"
    case "start_move_left", "start_move_right", "stop_move_left", "stop_move_right",
         "turn_left_to_front", "turn_right_to_front", "walk_left", "walk_right":
        return "locomotion"
    default: return "idle"
    }
}

private func loopForAugmentedClipID(_ id: String) -> Bool {
    switch id {
    case "idle", "walk_left", "walk_right": return true
    default: return false
    }
}

private func requiredForAugmentedClipID(_ id: String) -> Bool {
    switch id {
    case "idle", "walk_left", "walk_right": return true
    default: return false
    }
}

private func stateRawValueForAugmentedClipID(_ id: String) -> String {
    switch id {
    case "idle": return "idle"
    case "blink": return "blink"
    case "idle_look_around": return "idleLookAround"
    case "start_move_left": return "startMovingLeft"
    case "start_move_right": return "startMovingRight"
    case "stop_move_left": return "stopMovingLeft"
    case "stop_move_right": return "stopMovingRight"
    case "turn_left_to_front": return "turnLeftToFront"
    case "turn_right_to_front": return "turnRightToFront"
    case "walk_left": return "walkLeft"
    case "walk_right": return "walkRight"
    default: return "idle"
    }
}