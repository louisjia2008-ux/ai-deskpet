import AppKit
import Foundation
import SpriteKit

enum DragonV1AssetLoadError: LocalizedError, Equatable {
    case missingManifest(searched: [String])
    case invalidManifest(String)
    case missingFrame(clip: String, frame: String, searched: [String])
    case unreadableFrame(path: String)

    var errorDescription: String? {
        switch self {
        case .missingManifest(let searched):
            return "DragonV1 manifest not found. searched=\(searched.joined(separator: " | "))"
        case .invalidManifest(let reason):
            return "DragonV1 manifest is invalid: \(reason)"
        case .missingFrame(let clip, let frame, let searched):
            return "DragonV1 clip \(clip) is missing \(frame). searched=\(searched.joined(separator: " | "))"
        case .unreadableFrame(let path):
            return "DragonV1 frame could not be decoded at \(path)"
        }
    }

    var loadResult: DragonV1ManifestLoadResult {
        switch self {
        case .missingManifest:
            return .manifestMissing
        case .invalidManifest:
            return .manifestInvalid
        case .missingFrame:
            return .missingFrames
        case .unreadableFrame:
            return .unreadableFrame
        }
    }
}

struct LoadedDragonV1Frame {
    var texture: SKTexture
    var sourcePath: String
}

struct LoadedDragonV1Clip {
    var definition: DragonV1Manifest.Clip
    var frames: [LoadedDragonV1Frame]
    var resolvedDirectoryPath: String
}

struct LoadedDragonV1Asset {
    var manifest: DragonV1Manifest
    var manifestPath: String
    var clips: [DragonAnimationState: LoadedDragonV1Clip]

    func clip(for state: DragonAnimationState) -> LoadedDragonV1Clip? {
        clips[state]
    }
}

@MainActor
enum DragonV1AssetLoader {
    private static var cached: LoadedDragonV1Asset?
    private static var cachedFallbackReason: String?
    private static var cachedFallbackResult: DragonV1ManifestLoadResult?

    static func loadDefault() throws -> LoadedDragonV1Asset {
        if let cached { return cached }
        let asset = try load(assetRoot: nil)
        cached = asset
        cachedFallbackReason = nil
        cachedFallbackResult = nil
        return asset
    }

    static func load(assetRoot: URL?) throws -> LoadedDragonV1Asset {
        let manifestPaths = manifestCandidates(assetRoot: assetRoot)
        guard let manifestURL = manifestPaths.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            let error = DragonV1AssetLoadError.missingManifest(searched: manifestPaths.map(\.path))
            cachedFallbackReason = error.localizedDescription
            cachedFallbackResult = error.loadResult
            throw error
        }

        do {
            let data = try Data(contentsOf: manifestURL)
            let manifest = try JSONDecoder().decode(DragonV1Manifest.self, from: data)
            try validate(manifest)
            let usesExplicitAssetRoot = assetRoot != nil
            let resolvedAssetRoot = assetRoot ?? dragonAssetRoot(forManifestAt: manifestURL)
            let loadedClips = try Dictionary(uniqueKeysWithValues: manifest.clips.map { clip in
                (clip.state, try loadClip(clip,
                                          assetRoot: resolvedAssetRoot,
                                          includeDefaultFallbacks: !usesExplicitAssetRoot))
            })
            cachedFallbackReason = nil
            cachedFallbackResult = nil
            return LoadedDragonV1Asset(manifest: manifest,
                                       manifestPath: manifestURL.path,
                                       clips: loadedClips)
        } catch let error as DragonV1AssetLoadError {
            cachedFallbackReason = error.localizedDescription
            cachedFallbackResult = error.loadResult
            throw error
        } catch let error as DragonV1ManifestValidationError {
            let loadError = DragonV1AssetLoadError.invalidManifest(error.localizedDescription)
            cachedFallbackReason = loadError.localizedDescription
            cachedFallbackResult = loadError.loadResult
            throw loadError
        } catch {
            let loadError = DragonV1AssetLoadError.invalidManifest(error.localizedDescription)
            cachedFallbackReason = loadError.localizedDescription
            cachedFallbackResult = loadError.loadResult
            throw loadError
        }
    }

    static func manifestCandidatePaths(assetRoot: URL?) -> [String] {
        manifestCandidates(assetRoot: assetRoot).map(\.path)
    }

    static func hasRejectedApprovedMetadata(assetRoot: URL?) -> Bool {
        rejectionMetadataCandidates(assetRoot: assetRoot).contains { url in
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
            return text.contains("RUNTIME_HUMAN_ACCEPTANCE = FAILED")
                || text.contains("\"runtimeHumanAcceptance\": \"FAILED\"")
                || text.contains("\"runtime_human_acceptance\": \"FAILED\"")
        }
    }

    static func fallbackReason() -> String? {
        cachedFallbackReason
    }

    static func fallbackResult() -> DragonV1ManifestLoadResult? {
        cachedFallbackResult
    }

    static func resetForTests() {
        cached = nil
        cachedFallbackReason = nil
        cachedFallbackResult = nil
    }

    static func validate(_ manifest: DragonV1Manifest) throws {
        guard manifest.humanVisualAcceptance == "ACCEPTED" else {
            throw DragonV1ManifestValidationError.invalidAcceptance(manifest.humanVisualAcceptance)
        }
        let required: Set<String> = [
            "dragon_idle_hover",
            "dragon_fly_left_loop",
            "dragon_fly_right_loop",
            "dragon_takeoff",
            "dragon_land",
        ]
        var seen = Set<String>()
        for clip in manifest.clips {
            guard seen.insert(clip.name).inserted else {
                throw DragonV1ManifestValidationError.duplicateClip(clip.name)
            }
            guard clip.frameCount > 0,
                  clip.frames.count == clip.frameCount,
                  clip.fps > 0,
                  clip.canvasSize.width > 0,
                  clip.canvasSize.height > 0,
                  clip.anchorPoint.x >= 0,
                  clip.anchorPoint.y >= 0,
                  clip.anchorPoint.x <= Double(clip.canvasSize.width),
                  clip.anchorPoint.y <= Double(clip.canvasSize.height) else {
                throw DragonV1ManifestValidationError.invalidClip(clip.name)
            }
        }
        let present = Set(manifest.clips.map(\.name))
        for name in required where !present.contains(name) {
            throw DragonV1ManifestValidationError.missingClip(name)
        }
    }

    private static func loadClip(_ clip: DragonV1Manifest.Clip,
                                 assetRoot: URL,
                                 includeDefaultFallbacks: Bool) throws -> LoadedDragonV1Clip {
        var frames: [LoadedDragonV1Frame] = []
        var resolvedDirectoryPath: String?
        for frame in clip.frames {
            let candidates = frameCandidates(clip: clip,
                                             frame: frame,
                                             assetRoot: assetRoot,
                                             includeDefaultFallbacks: includeDefaultFallbacks)
            guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
                throw DragonV1AssetLoadError.missingFrame(clip: clip.name, frame: frame, searched: candidates)
            }
            guard let image = NSImage(contentsOfFile: path),
                  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                throw DragonV1AssetLoadError.unreadableFrame(path: path)
            }
            if resolvedDirectoryPath == nil {
                resolvedDirectoryPath = URL(fileURLWithPath: path).deletingLastPathComponent().path
            }
            frames.append(LoadedDragonV1Frame(texture: SKTexture(cgImage: cgImage), sourcePath: path))
        }
        return LoadedDragonV1Clip(definition: clip,
                                  frames: frames,
                                  resolvedDirectoryPath: resolvedDirectoryPath ?? assetRoot.appendingPathComponent(clip.relativePath).path)
    }

    private static func manifestCandidates(assetRoot: URL?) -> [URL] {
        var paths: [URL] = []
        if let assetRoot {
            return [assetRoot.appendingPathComponent("approved/manifests/dragon_v1_manifest.json")]
        }
        if let bundlePath = Bundle.main.resourceURL?
            .appendingPathComponent("DragonV1/approved/manifests/dragon_v1_manifest.json") {
            paths.append(bundlePath)
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        paths.append(cwd.appendingPathComponent("Assets/DragonV1/approved/manifests/dragon_v1_manifest.json"))
        paths.append(cwd.appendingPathComponent("DeskPet/Assets/DragonV1/approved/manifests/dragon_v1_manifest.json"))
        return unique(urls: paths)
    }

    private static func rejectionMetadataCandidates(assetRoot: URL?) -> [URL] {
        let metadataNames = [
            "DRAGON_V1_REJECTION_STATUS.json",
            "DRAGON_V1_RUNTIME_ACCEPTANCE_CHECKLIST.md",
        ]
        if let assetRoot {
            return metadataNames.map { assetRoot.appendingPathComponent("approved").appendingPathComponent($0) }
        }

        var paths: [URL] = []
        for name in metadataNames {
            if let bundlePath = Bundle.main.resourceURL?
                .appendingPathComponent("DragonV1/approved")
                .appendingPathComponent(name) {
                paths.append(bundlePath)
            }
            let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            paths.append(cwd.appendingPathComponent("Assets/DragonV1/approved").appendingPathComponent(name))
            paths.append(cwd.appendingPathComponent("DeskPet/Assets/DragonV1/approved").appendingPathComponent(name))
        }
        return unique(urls: paths)
    }

    private static func frameCandidates(clip: DragonV1Manifest.Clip,
                                        frame: String,
                                        assetRoot: URL,
                                        includeDefaultFallbacks: Bool) -> [String] {
        var paths: [URL] = []
        paths.append(assetRoot.appendingPathComponent(clip.relativePath).appendingPathComponent(frame))
        guard includeDefaultFallbacks else {
            return unique(urls: paths).map(\.path)
        }
        if let bundlePath = Bundle.main.resourceURL?
            .appendingPathComponent("DragonV1")
            .appendingPathComponent(clip.relativePath)
            .appendingPathComponent(frame) {
            paths.append(bundlePath)
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        paths.append(cwd.appendingPathComponent("Assets/DragonV1")
            .appendingPathComponent(clip.relativePath)
            .appendingPathComponent(frame))
        paths.append(cwd.appendingPathComponent("DeskPet/Assets/DragonV1")
            .appendingPathComponent(clip.relativePath)
            .appendingPathComponent(frame))
        return unique(urls: paths).map(\.path)
    }

    private static func dragonAssetRoot(forManifestAt manifestURL: URL) -> URL {
        manifestURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func unique(urls: [URL]) -> [URL] {
        var seen = Set<String>()
        return urls.filter { seen.insert($0.path).inserted }
    }
}
