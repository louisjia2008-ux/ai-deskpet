import CoreGraphics
import Foundation
import SpriteKit

enum DragonRendererSelection: String, Equatable {
    case pngDragonV1
    case vectorFallback
}

struct DragonAnimationDiagnostics: Equatable {
    var renderer: String
    var selectedRenderer: DragonRendererSelection
    var state: DragonAnimationState
    var currentClipID: String?
    var currentFrameIndex: Int
    var flagRawValue: String?
    var runtimeEnabled: Bool
    var resourceLoaded: Bool
    var manifestLoadResult: DragonV1ManifestLoadResult
    var manifestResolvedPath: String?
    var manifestCandidatePaths: [String]
    var loadedClipFrameCounts: [String: Int]
    var loadedClipDirectoryPaths: [String: String]
    var fallbackReason: String?
}

@MainActor
final class StaticPNGDragonRenderer: SKNode {
    private static let runtimeScale: CGFloat = 0.16

    private let sprite = SKSpriteNode()
    private var stateMachine = DragonAnimationStateMachine()
    private var animationPlayer = PetAnimationPlayer()
    private var asset: LoadedDragonV1Asset?
    private var activeClipID: String?
    private var activeFrameIndex: Int = 0
    private var fallbackReason: String?
    private var manifestLoadResult: DragonV1ManifestLoadResult = .notAttempted
    private var manifestCandidatePaths: [String]
    private let flagSnapshot: DragonV1RuntimeFlagSnapshot
    private let runtimeEnabled: Bool
    private let assetRoot: URL?

    init(enabled: Bool = DragonV1RuntimeConfig.isEnabled, assetRoot: URL? = nil) {
        self.flagSnapshot = DragonV1RuntimeConfig.snapshot()
        self.runtimeEnabled = enabled
        self.assetRoot = assetRoot
        self.manifestCandidatePaths = DragonV1AssetLoader.manifestCandidatePaths(assetRoot: assetRoot)
        super.init()
        setScale(Self.runtimeScale)
        sprite.anchorPoint = CGPoint(x: 0.5, y: 0.0)
        sprite.zPosition = 2
        addChild(sprite)
    }

    required init?(coder aDecoder: NSCoder) { nil }

    var isActive: Bool {
        runtimeEnabled && asset != nil
    }

    func loadIfEnabled() {
        manifestCandidatePaths = DragonV1AssetLoader.manifestCandidatePaths(assetRoot: assetRoot)
        guard runtimeEnabled else {
            manifestLoadResult = .disabled
            fallbackReason = "DragonV1 runtime assets disabled; set DESKPET_ENABLE_DRAGON_V1_ASSETS=1 to enable."
            isHidden = true
            debugLog(rendererSelectionLogLine())
            return
        }
        do {
            asset = try DragonV1AssetLoader.load(assetRoot: assetRoot)
            manifestLoadResult = .loaded
            fallbackReason = nil
            isHidden = false
            updateSpriteTexture(deltaTime: 0)
            debugLog(rendererSelectionLogLine())
        } catch {
            asset = nil
            manifestLoadResult = classifyLoadFailure(error)
            fallbackReason = rejectionAwareFallbackReason(for: error)
            isHidden = true
            debugLog(rendererSelectionLogLine())
        }
    }

    func setFeet(to point: CGPoint, facing: CGFloat) {
        position = point
        xScale = facing < 0 ? -Self.runtimeScale : Self.runtimeScale
        yScale = Self.runtimeScale
    }

    func transition(to state: DragonAnimationState) {
        stateMachine.transition(to: state)
        if activeClipID != asset?.clip(for: stateMachine.state)?.definition.name {
            animationPlayer.reset()
        }
    }

    func startFlyingLeft() {
        stateMachine.startFlyingLeft()
        animationPlayer.reset()
    }

    func startFlyingRight() {
        stateMachine.startFlyingRight()
        animationPlayer.reset()
    }

    func land() {
        stateMachine.land()
        animationPlayer.reset()
    }

    func applyMotion(horizontalDelta: CGFloat, moving: Bool, facing: CGFloat) {
        guard moving else {
            switch stateMachine.state {
            case .takeoff, .flyLeft, .flyRight:
                land()
            case .idleHover, .land:
                break
            }
            return
        }

        let target: DragonAnimationState
        if horizontalDelta < -0.2 {
            target = .flyLeft
        } else if horizontalDelta > 0.2 {
            target = .flyRight
        } else {
            target = facing < 0 ? .flyLeft : .flyRight
        }

        switch stateMachine.state {
        case .idleHover, .land:
            if target == .flyLeft {
                startFlyingLeft()
            } else {
                startFlyingRight()
            }
        case .takeoff:
            break
        case .flyLeft where target == .flyRight:
            transition(to: .flyRight)
        case .flyRight where target == .flyLeft:
            transition(to: .flyLeft)
        case .flyLeft, .flyRight:
            break
        }
    }

    func update(deltaTime: TimeInterval) {
        guard isActive else { return }
        let previousState = stateMachine.state
        stateMachine.update(deltaTime: deltaTime)
        if stateMachine.state != previousState {
            animationPlayer.reset()
        }
        updateSpriteTexture(deltaTime: deltaTime)
    }

    func diagnostics() -> DragonAnimationDiagnostics {
        DragonAnimationDiagnostics(renderer: "StaticPNGDragonRenderer",
                                   selectedRenderer: isActive ? .pngDragonV1 : .vectorFallback,
                                   state: stateMachine.state,
                                   currentClipID: activeClipID,
                                   currentFrameIndex: activeFrameIndex,
                                   flagRawValue: flagSnapshot.flagRawValue,
                                   runtimeEnabled: runtimeEnabled,
                                   resourceLoaded: asset != nil,
                                   manifestLoadResult: manifestLoadResult,
                                   manifestResolvedPath: asset?.manifestPath,
                                   manifestCandidatePaths: manifestCandidatePaths,
                                   loadedClipFrameCounts: loadedClipFrameCounts(),
                                   loadedClipDirectoryPaths: loadedClipDirectoryPaths(),
                                   fallbackReason: fallbackReason ?? DragonV1AssetLoader.fallbackReason())
    }

    #if DEBUG
    static func runtimeSmokeDiagnostics(enabled: Bool = DragonV1RuntimeConfig.isEnabled,
                                        assetRoot: URL? = nil) -> DragonAnimationDiagnostics {
        let renderer = StaticPNGDragonRenderer(enabled: enabled, assetRoot: assetRoot)
        renderer.loadIfEnabled()
        return renderer.diagnostics()
    }
    #endif

    private func updateSpriteTexture(deltaTime: TimeInterval) {
        guard let clip = asset?.clip(for: stateMachine.state),
              !clip.frames.isEmpty else {
            activeClipID = nil
            activeFrameIndex = 0
            sprite.texture = nil
            return
        }

        activeFrameIndex = animationPlayer.advance(clipID: clip.definition.name,
                                                   frameCount: clip.frames.count,
                                                   fps: clip.definition.fps,
                                                   loop: clip.definition.loop,
                                                   deltaTime: deltaTime)
        let frame = clip.frames[activeFrameIndex]
        sprite.texture = frame.texture
        sprite.size = CGSize(width: clip.definition.canvasSize.width,
                             height: clip.definition.canvasSize.height)
        activeClipID = clip.definition.name
    }

    private func loadedClipFrameCounts() -> [String: Int] {
        guard let asset else { return [:] }
        return Dictionary(uniqueKeysWithValues: asset.clips.values.map { clip in
            (clip.definition.name, clip.frames.count)
        })
    }

    private func loadedClipDirectoryPaths() -> [String: String] {
        guard let asset else { return [:] }
        return Dictionary(uniqueKeysWithValues: asset.clips.values.map { clip in
            (clip.definition.name, clip.resolvedDirectoryPath)
        })
    }

    private func clipFrameCountsDescription() -> String {
        loadedClipFrameCounts()
            .map { "\($0.key)=\($0.value)" }
            .sorted()
            .joined(separator: ",")
    }

    private func clipDirectoryDescription() -> String {
        loadedClipDirectoryPaths()
            .map { "\($0.key)=\($0.value)" }
            .sorted()
            .joined(separator: ",")
    }

    private func classifyLoadFailure(_ error: Error) -> DragonV1ManifestLoadResult {
        if let loadError = error as? DragonV1AssetLoadError {
            return loadError.loadResult
        }
        return DragonV1AssetLoader.fallbackResult() ?? .manifestInvalid
    }

    private func rejectionAwareFallbackReason(for error: Error) -> String {
        let result = classifyLoadFailure(error)
        let hasRejectedMetadata = DragonV1AssetLoader.hasRejectedApprovedMetadata(assetRoot: assetRoot)
        if hasRejectedMetadata, result == .manifestMissing || result == .manifestInvalid {
            return "dragonV1RejectedOrNoAcceptedManifest"
        }
        return error.localizedDescription
    }

    private func rendererSelectionLogLine() -> String {
        let selectedRenderer = isActive ? DragonRendererSelection.pngDragonV1.rawValue : DragonRendererSelection.vectorFallback.rawValue
        let manifestPath = asset?.manifestPath ?? "<none>"
        let fallback = fallbackReason ?? "<none>"
        let clips = clipFrameCountsDescription()
        let clipDirectories = clipDirectoryDescription()
        return "flagKey=\(DragonV1RuntimeConfig.environmentKey) flagRawValue=\(flagValueDescription()) featureFlagEnabled=\(runtimeEnabled) manifestLoadResult=\(manifestLoadResult.rawValue) selectedRenderer=\(selectedRenderer) manifestResolvedPath=\(manifestPath) clips=\(clips.isEmpty ? "<none>" : clips) clipDirectories=\(clipDirectories.isEmpty ? "<none>" : clipDirectories) fallbackReason=\(fallback) manifestCandidates=\(manifestCandidatePaths.joined(separator: " | "))"
    }

    private func flagValueDescription() -> String {
        flagSnapshot.flagRawValue ?? "<nil>"
    }

    private func debugLog(_ message: @autoclosure () -> String) {
        #if DEBUG
        NSLog("[DeskPet][DragonV1] \(message())")
        #endif
    }
}
