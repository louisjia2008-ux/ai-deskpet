import AppKit
import CoreGraphics
import Foundation
import ImageIO
import SpriteKit

enum CharacterRendererLoadError: LocalizedError, Equatable {
    case missingResource(requested: String, searched: [String], renderer: String)
    case unreadableImage(path: String, renderer: String)
    case unreadableAlpha(path: String, renderer: String)
    case incompleteClip(clipID: String, frameID: String, searched: [String])

    var errorDescription: String? {
        switch self {
        case .missingResource(let requested, let searched, let renderer):
            return "\(renderer) could not find \(requested). searched=\(searched.joined(separator: " | "))"
        case .unreadableImage(let path, let renderer):
            return "\(renderer) could not decode image at \(path)"
        case .unreadableAlpha(let path, let renderer):
            return "\(renderer) could not build alpha hit mask for \(path)"
        case .incompleteClip(let clipID, let frameID, let searched):
            return "StaticPNGCharacterRenderer could not load character clip \(clipID) frame \(frameID). searched=\(searched.joined(separator: " | "))"
        }
    }
}

struct AlphaHitMask: Equatable {
    let width: Int
    let height: Int
    let threshold: UInt8
    private let alpha: [UInt8]

    init(width: Int, height: Int, threshold: UInt8, alpha: [UInt8]) {
        self.width = width
        self.height = height
        self.threshold = threshold
        self.alpha = alpha
    }

    func contains(pixelX: Int, pixelY: Int) -> Bool {
        guard pixelX >= 0, pixelY >= 0, pixelX < width, pixelY < height else { return false }
        return alpha[pixelY * width + pixelX] > threshold
    }

    static func from(cgImage: CGImage, threshold: UInt8) -> AlphaHitMask? {
        let width = cgImage.width
        let height = cgImage.height
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
        guard let context = CGContext(data: &pixels,
                                      width: width,
                                      height: height,
                                      bitsPerComponent: 8,
                                      bytesPerRow: bytesPerRow,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return nil
        }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        var alpha = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                alpha[y * width + x] = pixels[y * bytesPerRow + x * bytesPerPixel + 3]
            }
        }
        return AlphaHitMask(width: width, height: height, threshold: threshold, alpha: alpha)
    }
}

private struct LoadedCharacterFrame {
    var texture: SKTexture
    var logicalSize: CGSize
    var hitMask: AlphaHitMask?
    var sourcePath: String
}

private struct LoadedCharacterClip {
    var definition: CharacterVisualClip
    var frames: [LoadedCharacterFrame]
    var sourceClipID: String

    func frameIndex(elapsedSinceStart: TimeInterval, fps: Double) -> Int {
        guard !frames.isEmpty else { return 0 }
        let raw = Int(floor(max(0, elapsedSinceStart) * fps))
        if definition.loop {
            return raw % frames.count
        }
        return min(raw, frames.count - 1)
    }
}

@MainActor
final class StaticPNGCharacterRenderer: SKNode {
    private let config: CharacterAnimationConfig
    // P19.2 — `var` so the CharacterV2 augmentation seam can rebind the
    // visual system after injecting the CharacterV2 clip entries. The
    // mutator only runs during `load()` and the setter is never reachable
    // from outside the renderer.
    private var visualSystem: LoadedCharacterVisualSystem?
    private var visualManifest: CharacterVisualManifest? { visualSystem?.manifest }
    private let stateMachine: CharacterAnimationStateMachine
    private let mixer: CharacterAnimationMixer
    private let groundShadow = SKShapeNode(ellipseOf: CGSize(width: 92, height: 18))
    private let transitionSprite = SKSpriteNode()
    private let sprite = SKSpriteNode()
    private var baseTexture: SKTexture?
    private var baseLogicalSize: CGSize
    private var baseHitMask: AlphaHitMask?
    private var hitMask: AlphaHitMask?
    private var loadedPath: String?
    private var fallbackReason: String?
    private var loadedClips: [String: LoadedCharacterClip] = [:]
    private var activeClipID: String?
    private var activeFrameIndex: Int = 0
    private var animationPlayer = PetAnimationPlayer()
    private var elapsed: TimeInterval = Date().timeIntervalSinceReferenceDate
    private var lastFrameInterval: TimeInterval = 0
    private var speakingLevel: Float = 0
    private var lookTarget: CGPoint?
    private var lastFeet: CGPoint?
    private var dragVelocity: CGVector = .zero
    private var isReduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    /// Cache for the per-frame reduce-motion query (a synchronous IPC to the
    /// workspace service — must not run at 30Hz). Re-read at most every 2s.
    private var reduceMotionLastCheck: TimeInterval = 0
    private static let reduceMotionCacheTTL: TimeInterval = 2.0
    private var facing: CGFloat = 1
    private var currentClipID: String?
    private var idleScheduler: IdleScheduler

    init(config: CharacterAnimationConfig = .default,
         characterID: String? = nil,
         idleScheduler: IdleScheduler? = nil) {
        self.config = config
        if let characterID {
            self.visualSystem = CharacterVisualSystemLoader.load(
                catalog: CharacterAssetCatalog.runtimeDefault(preferredCharacterID: characterID),
                selectedDefaultCharacterID: characterID)
        } else {
            self.visualSystem = CharacterVisualSystemLoader.loadDefaultSystem()
        }
        self.stateMachine = CharacterAnimationStateMachine(reactionCooldown: config.reactions.cooldown)
        self.mixer = CharacterAnimationMixer(config: config)
        self.baseLogicalSize = Self.logicalSize(config: config, visualSystem: visualSystem)
        let now = Date().timeIntervalSinceReferenceDate
        self.elapsed = now
        self.idleScheduler = idleScheduler ?? IdleScheduler(now: now)
        super.init()
        buildGroundShadow()
        transitionSprite.anchorPoint = CGPoint(x: 0.5, y: 0.0)
        transitionSprite.size = baseLogicalSize
        transitionSprite.zPosition = 0.95
        transitionSprite.alpha = 0
        transitionSprite.isHidden = true
        sprite.anchorPoint = CGPoint(x: 0.5, y: 0.0)
        sprite.size = baseLogicalSize
        sprite.zPosition = 1
        addChild(groundShadow)
        addChild(transitionSprite)
        addChild(sprite)
    }

    required init?(coder aDecoder: NSCoder) { nil }

    var footprint: CGSize { baseLogicalSize }
    var resourceLoaded: Bool { loadedPath != nil }
    var resourcePath: String? { loadedPath }
    var animationState: CharacterAnimationState { stateMachine.state }

    func load() throws {
        if visualSystem != nil {
            augmentClipsFromCharacterV2IfAvailable()
            loadCharacterV2ClipsIfAvailable()
            if seedBaseTextureFromLoadedVisualClip() {
                _ = stateMachine.apply(CharacterAnimationIntent(state: .idle, source: .runtimeLifecycle), now: elapsed)
                NSLog("[DeskPet] StaticPNGCharacterRenderer loaded canonical character visual system \(visualSystem?.characterID ?? "unknown") from \(visualSystem?.manifestPath ?? "unknown")")
                return
            }
        }

        let candidates = resourceCandidates()
        guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            let error = CharacterRendererLoadError.missingResource(
                requested: config.asset.relativePath,
                searched: candidates,
                renderer: "StaticPNGCharacterRenderer")
            fallbackReason = error.localizedDescription
            NSLog("[DeskPet] \(error.localizedDescription)")
            throw error
        }
        guard let image = NSImage(contentsOfFile: path),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            let error = CharacterRendererLoadError.unreadableImage(path: path, renderer: "StaticPNGCharacterRenderer")
            fallbackReason = error.localizedDescription
            NSLog("[DeskPet] \(error.localizedDescription)")
            throw error
        }
        guard let mask = AlphaHitMask.from(cgImage: cgImage, threshold: config.canvas.alphaHitThreshold) else {
            let error = CharacterRendererLoadError.unreadableAlpha(path: path, renderer: "StaticPNGCharacterRenderer")
            fallbackReason = error.localizedDescription
            NSLog("[DeskPet] \(error.localizedDescription)")
            throw error
        }
        baseTexture = SKTexture(cgImage: cgImage)
        sprite.texture = baseTexture
        sprite.size = baseLogicalSize
        baseHitMask = mask
        hitMask = mask
        loadedPath = path
        fallbackReason = nil
        loadCharacterV2ClipsIfAvailable()
        _ = stateMachine.apply(CharacterAnimationIntent(state: .idle, source: .rendererFallback), now: elapsed)
        NSLog("[DeskPet] StaticPNGCharacterRenderer loaded \(config.asset.name) from \(path)")
    }

    func apply(intent: CharacterAnimationIntent) {
        var normalizedIntent = intent
        normalizedIntent.createdAt = elapsed
        _ = stateMachine.apply(normalizedIntent, now: elapsed)
    }

    func setState(_ state: CharacterAnimationState) {
        apply(intent: CharacterAnimationIntent(state: state, source: .runtimeLifecycle, createdAt: elapsed))
    }

    func setEmotion(_ emotion: CharacterAnimationEmotion) {
        apply(intent: CharacterAnimationIntent(state: .reacting, emotion: emotion, priority: 40,
                                               duration: 0.5, source: .runtimeLifecycle, createdAt: elapsed))
    }

    func setSpeakingLevel(_ level: Float) {
        speakingLevel = max(0, min(1, level))
    }

    func setLookTarget(_ target: CGPoint?) {
        lookTarget = target
    }

    func setFeet(to point: CGPoint, facing: CGFloat) {
        if let lastFeet {
            let dt = max(lastFrameInterval, 1.0 / 30.0)
            dragVelocity = CGVector(dx: (point.x - lastFeet.x) / dt, dy: (point.y - lastFeet.y) / dt)
        }
        lastFeet = point
        position = point
        self.facing = facing < 0 ? -1 : 1
    }

    func update(deltaTime: TimeInterval) {
        lastFrameInterval = deltaTime
        elapsed += deltaTime
        if elapsed - reduceMotionLastCheck >= Self.reduceMotionCacheTTL {
            reduceMotionLastCheck = elapsed
            isReduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        }
        stateMachine.update(now: elapsed)
        scheduleAmbientIdleIfNeeded()
        if stateMachine.state != .speaking {
            speakingLevel = max(0, speakingLevel - Float(deltaTime / config.speaking.releaseDuration))
        }
        updateSpriteTexture(for: stateMachine.state, deltaTime: deltaTime)
        let pose = mixer.pose(elapsed: elapsed,
                              state: stateMachine.state,
                              emotion: stateMachine.emotion,
                              intent: stateMachine.currentIntent,
                              speakingLevel: speakingLevel,
                              dragVelocity: dragVelocity,
                              reduceMotion: isReduceMotion)
        let clipDirection = activeClipID.flatMap { loadedClips[$0]?.definition.direction }
        sprite.xScale = (clipDirection == nil ? facing : 1) * pose.scaleX
        sprite.yScale = pose.scaleY
        sprite.zRotation = pose.rotation
        sprite.position = pose.offset
        updateGroundShadow(for: pose, state: stateMachine.state)

        if lookTarget != nil, stateMachine.state != .dragged {
            sprite.zRotation += CGFloat(sin(elapsed * 0.7)) * 0.004
        }
    }

    func hitTest(_ scenePoint: CGPoint) -> Bool {
        let local = convert(scenePoint, from: parent ?? self)
        return hitTestLocal(local)
    }

    func hitTestLocal(_ local: CGPoint) -> Bool {
        guard let hitMask else { return false }
        let width = baseLogicalSize.width
        let height = baseLogicalSize.height
        guard local.x >= -width / 2, local.x <= width / 2, local.y >= 0, local.y <= height else {
            return false
        }
        let normalizedX = (local.x + width / 2) / width
        let normalizedY = local.y / height
        let pixelX = Int((normalizedX * CGFloat(hitMask.width - 1)).rounded())
        let pixelY = Int(((1 - normalizedY) * CGFloat(hitMask.height - 1)).rounded())
        return hitMask.contains(pixelX: pixelX, pixelY: pixelY)
    }

    func setVisible(_ visible: Bool, animated: Bool) {
        let target: CGFloat = visible ? 1 : 0
        if animated {
            run(.fadeAlpha(to: target, duration: 0.4))
        } else {
            alpha = target
        }
    }

    func shutdown() {
        removeAllActions()
        sprite.removeAllActions()
        speakingLevel = 0
        stateMachine.forceIdle()
    }

    func diagnostics() -> CharacterAnimationDiagnostics {
        CharacterAnimationDiagnostics(renderer: "StaticPNGCharacterRenderer",
                                      state: stateMachine.state,
                                      currentIntent: stateMachine.currentIntent,
                                      currentClipID: currentClipID,
                                      frameInterval: lastFrameInterval,
                                      reduceMotion: isReduceMotion,
                                      resourceLoaded: loadedPath != nil || !loadedClips.isEmpty,
                                      fallbackReason: fallbackReason ?? visualSystem?.fallbackReason ?? CharacterVisualSystemLoader.fallbackReason(),
                                      characterID: visualSystem?.characterID,
                                      manifestPath: visualSystem?.manifestPath,
                                      assetRootPath: visualSystem?.assetRootPath,
                                      selectedDefaultCharacterID: visualSystem?.selectedDefaultCharacterID,
                                      loadedFallbackCharacter: visualSystem?.loadedFallbackCharacter ?? false,
                                      activeFramePath: activeFramePath())
    }

    var loadedClipIDsForTests: [String] {
        loadedClips.values.map(\.definition.id).sorted()
    }

    private func buildGroundShadow() {
        groundShadow.fillColor = SKColor(calibratedRed: 0.08, green: 0.12, blue: 0.18, alpha: 0.22)
        groundShadow.strokeColor = .clear
        groundShadow.position = CGPoint(x: 0, y: 3)
        groundShadow.zPosition = -1
        groundShadow.alpha = 0.72
    }

    private func scheduleAmbientIdleIfNeeded() {
        guard stateMachine.state == .idle else {
            // Track non-idle entry so the post-sustained settle debounce
            // applies when we return to idle.
            idleScheduler.noteNonIdle(at: elapsed)
            return
        }
        guard let event = idleScheduler.tick(now: elapsed, state: stateMachine.state) else { return }
        switch event {
        case .blink:
            _ = stateMachine.apply(CharacterAnimationIntent(state: .blink,
                                                            priority: 14,
                                                            duration: 0.14,
                                                            source: .rendererFallback,
                                                            createdAt: elapsed),
                                   now: elapsed)
        case .lookAround:
            _ = stateMachine.apply(CharacterAnimationIntent(state: .idleLookAround,
                                                            priority: 13,
                                                            duration: 0.8,
                                                            source: .rendererFallback,
                                                            createdAt: elapsed),
                                   now: elapsed)
        }
    }

    private func updateGroundShadow(for pose: CharacterPose, state: CharacterAnimationState) {
        let lift = max(0, pose.offset.y)
        let isLocomotion = state == .walkLeft || state == .walkRight
            || state == .briskWalkLeft || state == .briskWalkRight
            || state == .runLeft || state == .runRight
        let walkPulse = isLocomotion ? CGFloat(0.04 * sin(elapsed * 2 * Double.pi * 1.8)) : 0
        let scale = max(0.82, 1.0 - lift / 80.0 + walkPulse)
        groundShadow.xScale = scale
        groundShadow.yScale = max(0.72, 1.0 - lift / 130.0)
        groundShadow.alpha = max(0.36, 0.72 - lift / 90.0)
    }

    private func updateSpriteTexture(for state: CharacterAnimationState, deltaTime: TimeInterval) {
        let requestedClip = lookClipOverride()
            ?? visualManifest?.clip(for: state,
                                    direction: stateMachine.currentIntent?.locomotionDirection,
                                    speedTier: stateMachine.currentIntent?.speedTier)
        guard let requestedClip, let clip = loadedClips[requestedClip.id] else {
            activeClipID = nil
            activeFrameIndex = 0
            animationPlayer.reset()
            currentClipID = requestedClip?.id
            sprite.texture = baseTexture
            sprite.size = baseLogicalSize
            hitMask = baseHitMask
            return
        }

        if activeClipID != clip.definition.id {
            let previousDefinition = activeClipID.flatMap { loadedClips[$0]?.definition }
            if let duration = transitionDuration(from: previousDefinition, to: clip.definition) {
                beginCrossfade(duration: duration)
            } else {
                sprite.removeAction(forKey: "clipCrossfadeIn")
                transitionSprite.removeAction(forKey: "clipCrossfadeOut")
                transitionSprite.isHidden = true
                transitionSprite.alpha = 0
                sprite.alpha = 1
            }
            activeClipID = clip.definition.id
            animationPlayer.reset()
        }
        let fps = clip.definition.effectiveFps(forSpeed: stateMachine.currentIntent?.speedPointsPerSecond)
        activeFrameIndex = animationPlayer.advance(clipID: clip.definition.id,
                                                   frameCount: clip.frames.count,
                                                   fps: fps,
                                                   loop: clip.definition.loop,
                                                   deltaTime: deltaTime)

        let frame = clip.frames[activeFrameIndex]
        sprite.texture = frame.texture
        sprite.size = frame.logicalSize
        hitMask = frame.hitMask ?? hitMask
        currentClipID = clip.definition.id
    }

    private func lookClipOverride() -> CharacterVisualClip? {
        // Attentive gaze: also fire while listening (chat expanded) so the character
        // visibly faces the floating chat panel. Otherwise the pose is buried by idle.
        let gazeEligible = stateMachine.state == .idle || stateMachine.state == .listening
        guard gazeEligible,
              let lookTarget,
              let visualManifest else { return nil }
        let vector = CGVector(dx: lookTarget.x - position.x,
                              dy: lookTarget.y - position.y)
        let angle = CharacterLookPoseResolver.angleDegrees(from: vector)
        return visualManifest.clip(id: CharacterLookPoseResolver.nearestPose(for: angle).clipID)
    }

    private func beginCrossfade(duration: TimeInterval) {
        guard let texture = sprite.texture else { return }
        transitionSprite.texture = texture
        transitionSprite.size = sprite.size
        transitionSprite.position = sprite.position
        transitionSprite.xScale = sprite.xScale
        transitionSprite.yScale = sprite.yScale
        transitionSprite.zRotation = sprite.zRotation
        transitionSprite.alpha = max(sprite.alpha, 1)
        transitionSprite.isHidden = false
        transitionSprite.removeAction(forKey: "clipCrossfadeOut")
        sprite.removeAction(forKey: "clipCrossfadeIn")
        sprite.alpha = 0
        transitionSprite.run(.sequence([
            .fadeOut(withDuration: duration),
            .hide()
        ]), withKey: "clipCrossfadeOut")
        sprite.run(.fadeAlpha(to: 1, duration: duration), withKey: "clipCrossfadeIn")
    }

    private func transitionDuration(from oldClip: CharacterVisualClip?,
                                    to newClip: CharacterVisualClip) -> TimeInterval? {
        guard let oldClip else { return nil }
        // P19.2 — slightly longer crossfades on locomotion-to-locomotion
        // transitions so the new start/walk/stop/turn clips (which are
        // visually different from the production character's previous
        // fallback targets) blend smoothly instead of popping. Idle↔locomotion
        // transitions keep the original 0.10/0.12 values to preserve the
        // pre-P19.2 perceived responsiveness.
        if oldClip.state == .idle, newClip.state.isLocomotionVisual {
            return 0.10
        }
        if oldClip.state.isLocomotionVisual, newClip.state == .idle {
            return 0.12
        }
        if oldClip.state.isLocomotionVisual, newClip.state.isLocomotionVisual {
            return 0.08
        }
        return nil
    }

    private func loadCharacterV2ClipsIfAvailable() {
        guard let visualManifest else { return }
        for clip in visualManifest.clips {
            do {
                if let loaded = try loadClipResolvingFallback(clip, visited: []) {
                    loadedClips[clip.id] = loaded
                }
            } catch {
                fallbackReason = error.localizedDescription
                NSLog("[DeskPet] \(error.localizedDescription)")
            }
        }
    }

    /// P19.2 — augment the loaded production manifest with CharacterV2's
    /// approved locomotion + idle + blink + idle-look-around clips. This
    /// replaces the 13 placeholder fallback chains the audit identified
    /// without changing the production character's body / interaction states.
    ///
    /// The injected entries are appended to `visualSystem.manifest.clips` and
    /// marked `assetStatus = .approved` + `placeholder = false`. When the
    /// renderer later resolves a frame for an injected clip id, it falls
    /// through to `frameCandidates(clipID:frameID:)` which checks both the
    /// primary `assetRootPath` AND `secondaryAssetRootPath`.
    ///
    /// The injected set is a *superset replacement*: if the loaded manifest
    /// already declares an approved clip for the same id, the existing entry
    /// is kept (CharacterV2 augmentation is non-destructive).
    private func augmentClipsFromCharacterV2IfAvailable() {
        guard var system = visualSystem else { return }
        guard let location = CharacterV2ClipBridge.locateAssetRoot() else {
            return
        }
        let augmented = CharacterV2ClipBridge.augmentedClips(assetRoot: location.rootPath)
        guard !augmented.isEmpty else { return }
        // P19.2 §12 — augmentable clip ids must REPLACE the production
        // character's placeholder entries (which the audit identified as
        // 13 `TEMP_LOCOMOTION_ALIAS_FALLBACK` chains). The merge is a
        // *placeholder-supersedence*: any production-character entry that
        // is marked `placeholder = true` for an augmented id is replaced
        // by the CharacterV2 approved entry. Non-placeholder production
        // entries (e.g. interaction-state bindings) are preserved untouched.
        var replaced = 0
        let augmentedByID = Dictionary(uniqueKeysWithValues: augmented.map { ($0.id, $0) })
        let merged = system.manifest.clips.map { existing -> CharacterVisualClip in
            if let replacement = augmentedByID[existing.id],
               existing.placeholder {
                replaced += 1
                return replacement
            }
            return existing
        }
        // Any augmented id that the production character did not declare
        // is appended (covers new ids like `turn_right_to_front`).
        let existingIDs = Set(system.manifest.clips.map(\.id))
        let mergedWithAdditions = merged + augmented.filter { !existingIDs.contains($0.id) }
        system.manifest = CharacterVisualManifest(
            schemaVersion: system.manifest.schemaVersion,
            manifestID: system.manifest.manifestID,
            character: system.manifest.character,
            canvas: system.manifest.canvas,
            provenance: system.manifest.provenance,
            pipeline: system.manifest.pipeline,
            clips: mergedWithAdditions,
            interactionStates: system.manifest.interactionStates,
            habitat: system.manifest.habitat)
        system.secondaryAssetRootPath = location.rootPath
        visualSystem = system
        NSLog("[DeskPet] P19.2 augmented production character with \(augmented.count) CharacterV2 clip(s) (\(replaced) superseded, \(mergedWithAdditions.count - merged.count) added) from \(location.rootPath)")
    }

    private func seedBaseTextureFromLoadedVisualClip() -> Bool {
        guard let visualManifest else { return false }
        let idleClipID = visualManifest.clip(for: .idle, direction: nil, speedTier: nil)?.id ?? "idle"
        guard let clip = loadedClips[idleClipID] ?? loadedClips.values.first,
              let frame = clip.frames.first else {
            return false
        }
        baseTexture = frame.texture
        sprite.texture = frame.texture
        sprite.size = frame.logicalSize
        baseLogicalSize = frame.logicalSize
        baseHitMask = frame.hitMask
        hitMask = frame.hitMask
        loadedPath = frame.sourcePath
        currentClipID = clip.definition.id
        activeClipID = clip.definition.id
        activeFrameIndex = 0
        if fallbackReason == nil {
            fallbackReason = visualSystem?.fallbackReason
        }
        return true
    }

    private func activeFramePath() -> String? {
        guard let activeClipID,
              let clip = loadedClips[activeClipID],
              clip.frames.indices.contains(activeFrameIndex) else {
            return loadedPath
        }
        return clip.frames[activeFrameIndex].sourcePath
    }

    private func loadClipResolvingFallback(_ clip: CharacterVisualClip, visited: Set<String>) throws -> LoadedCharacterClip? {
        guard !visited.contains(clip.id) else { return nil }
        if clip.id == "idle", clip.placeholder {
            return loadStaticBaseClip(for: clip)
        }
        if clip.placeholder {
            return try loadFallbackClip(for: clip, visited: visited)
        }
        do {
            let frames = try loadFrames(for: clip)
            NSLog("[DeskPet] Loaded character clip \(clip.id) frames=\(frames.count)")
            return LoadedCharacterClip(definition: clip, frames: frames, sourceClipID: clip.id)
        } catch {
            guard clip.fallback != nil else { throw error }
            fallbackReason = error.localizedDescription
            NSLog("[DeskPet] \(error.localizedDescription)")
            return try loadFallbackClip(for: clip, visited: visited)
        }
    }

    private func loadFallbackClip(for clip: CharacterVisualClip, visited: Set<String>) throws -> LoadedCharacterClip? {
        guard let fallback = clip.fallback,
              let fallbackDefinition = visualManifest?.clip(id: fallback.clipID) else {
            return nil
        }
        guard let loaded = try loadClipResolvingFallback(fallbackDefinition, visited: visited.union([clip.id])) else {
            return nil
        }
        let reason = "\(fallback.mode): character clip \(clip.id) is using explicit fallback \(fallback.clipID)"
        fallbackReason = [fallbackReason, reason].compactMap { $0 }.joined(separator: " | ")
        NSLog("[DeskPet] \(reason)")
        return LoadedCharacterClip(definition: clip, frames: loaded.frames, sourceClipID: loaded.sourceClipID)
    }

    private func loadStaticBaseClip(for clip: CharacterVisualClip) -> LoadedCharacterClip? {
        guard let baseTexture, let loadedPath else { return nil }
        let frame = LoadedCharacterFrame(texture: baseTexture,
                                         logicalSize: baseLogicalSize,
                                         hitMask: baseHitMask,
                                         sourcePath: loadedPath)
        return LoadedCharacterClip(definition: clip, frames: [frame], sourceClipID: clip.id)
    }

    private func loadClip(_ clip: CharacterVisualClip) throws -> LoadedCharacterClip {
        let frames = try loadFrames(for: clip)
        NSLog("[DeskPet] Loaded character clip \(clip.id) frames=\(frames.count)")
        return LoadedCharacterClip(definition: clip, frames: frames, sourceClipID: clip.id)
    }

    private func loadFrames(for clip: CharacterVisualClip) throws -> [LoadedCharacterFrame] {
        var frames: [LoadedCharacterFrame] = []
        for frameID in clip.frames {
            let candidates = frameCandidates(clipID: clip.id, frameID: frameID)
            guard let path = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
                throw CharacterRendererLoadError.incompleteClip(clipID: clip.id, frameID: frameID, searched: candidates)
            }
            guard let image = NSImage(contentsOfFile: path),
                  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                throw CharacterRendererLoadError.unreadableImage(path: path, renderer: "StaticPNGCharacterRenderer")
            }
            frames.append(LoadedCharacterFrame(
                texture: SKTexture(cgImage: cgImage),
                logicalSize: baseLogicalSize,
                hitMask: AlphaHitMask.from(cgImage: cgImage, threshold: config.canvas.alphaHitThreshold),
                sourcePath: path))
        }
        return frames
    }

    private func resourceCandidates() -> [String] {
        var paths: [String] = []
        if let bundlePath = Bundle.main.resourceURL?.appendingPathComponent(config.asset.relativePath).path {
            paths.append(bundlePath)
        }
        let cwd = FileManager.default.currentDirectoryPath
        paths.append(URL(fileURLWithPath: cwd).appendingPathComponent("Resources/\(config.asset.relativePath)").path)
        paths.append(URL(fileURLWithPath: cwd).appendingPathComponent("DeskPet/Resources/\(config.asset.relativePath)").path)
        return Array(NSOrderedSet(array: paths)) as? [String] ?? paths
    }

    private func frameCandidates(clipID: String, frameID: String) -> [String] {
        var paths: [String] = []
        if let visualSystem {
            paths.append(URL(fileURLWithPath: visualSystem.assetRootPath)
                .appendingPathComponent("approved/clips/\(clipID)/\(frameID).png")
                .path)
            // P19.2 — secondary asset root used for CharacterV2-augmented
            // clips. The augmented manifest declares clip ids (e.g.
            // `start_move_left`) that do not exist in the production
            // character's directory tree; their PNGs live under the
            // CharacterV2 staging root, which is recorded as
            // `secondaryAssetRootPath` by `augmentClipsFromCharacterV2IfAvailable`.
            if let secondary = visualSystem.secondaryAssetRootPath {
                paths.append(URL(fileURLWithPath: secondary)
                    .appendingPathComponent("approved/clips/\(clipID)/\(frameID).png")
                    .path)
            }
            if let bundlePath = Bundle.main.resourceURL?
                .appendingPathComponent("\(visualSystem.manifest.character.id == "lumi-scholar" ? "LumiScholar" : "CharacterV2")/approved/clips/\(clipID)/\(frameID).png")
                .path {
                paths.append(bundlePath)
            }
            return Array(NSOrderedSet(array: paths)) as? [String] ?? paths
        }
        let relative = "CharacterV2/approved/clips/\(clipID)/\(frameID).png"
        let assetRelative = "Assets/\(relative)"
        let cwd = FileManager.default.currentDirectoryPath
        paths.append(URL(fileURLWithPath: cwd).appendingPathComponent(assetRelative).path)
        paths.append(URL(fileURLWithPath: cwd).appendingPathComponent("DeskPet/\(assetRelative)").path)
        return Array(NSOrderedSet(array: paths)) as? [String] ?? paths
    }

    private static func logicalSize(config: CharacterAnimationConfig,
                                    visualSystem: LoadedCharacterVisualSystem?) -> CGSize {
        visualSystem?.manifest.canvas?.logicalSize(preservingHeight: config.footprint.height)
            ?? config.footprint
    }
}
