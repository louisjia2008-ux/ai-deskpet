import CoreGraphics
import Foundation
import AICore
import PetBrainCore

enum CharacterAnimationState: String, Codable, CaseIterable, Equatable {
    case loading
    case idle
    case blink
    case idleLookAround
    case greet
    case jump
    case taskWaiting
    case taskRunning
    case taskReview
    case taskFailed
    case look000 = "look_000"
    case look0225 = "look_022_5"
    case look045 = "look_045"
    case look0675 = "look_067_5"
    case look090 = "look_090"
    case look1125 = "look_112_5"
    case look135 = "look_135"
    case look1575 = "look_157_5"
    case look180 = "look_180"
    case look2025 = "look_202_5"
    case look225 = "look_225"
    case look2475 = "look_247_5"
    case look270 = "look_270"
    case look2925 = "look_292_5"
    case look315 = "look_315"
    case look3375 = "look_337_5"
    case startMoving
    case startMovingLeft
    case startMovingRight
    case walkLeft
    case walkRight
    case briskWalkLeft
    case briskWalkRight
    case runLeft
    case runRight
    case stopMoving
    case stopMovingLeft
    case stopMovingRight
    case turnLeftToFront
    /// P19.2 — mirror of `turnLeftToFront` for right-direction stops. The
    /// animation runtime previously emitted `turnLeftToFront` for both
    /// directions (an asymmetry documented in the CharacterLocomotionController
    /// audit). CharacterV2 supplies left-side turn frames; the bridge
    /// synthesizes a `turn_right_to_front` clip that mirrors them, so this
    /// state is the runtime's way of asking for the right-side mirror.
    case turnRightToFront
    case listening
    case thinking
    case speaking
    case reacting
    case sleeping
    case dragged
    case falling
    case landing
    case unavailable

    /// True for any state used as a locomotion visual (start/walk/brisk/run/stop/turn).
    /// P16: also consulted by `PetScene.update` to decide whether to re-assert the walk
    /// visual after a higher-priority intent has cleared.
    var isLocomotionVisual: Bool {
        switch self {
        case .startMoving, .startMovingLeft, .startMovingRight,
             .walkLeft, .walkRight, .briskWalkLeft, .briskWalkRight,
             .runLeft, .runRight, .stopMoving, .stopMovingLeft, .stopMovingRight,
             .turnLeftToFront, .turnRightToFront:
            return true
        default:
            return false
        }
    }
}

enum CharacterLocomotionDirection: String, Codable, Equatable {
    case left
    case right
}

enum CharacterLocomotionSpeedTier: String, Codable, CaseIterable, Equatable {
    case idle
    case slowWalk
    case walk
    case briskWalk
    case run
}

enum CharacterAnimationEmotion: String, Codable, CaseIterable, Equatable {
    case neutral
    case happy
    case curious
    case surprised
    case sad
    case annoyed
    case sleepy

    init(petEmotion: PetEmotion) {
        switch petEmotion {
        case .neutral: self = .neutral
        case .happy, .excited: self = .happy
        case .shy: self = .curious
        case .sad: self = .sad
        case .thinking: self = .curious
        case .sleepy: self = .sleepy
        }
    }
}

enum CharacterInterruptPolicy: String, Codable, Equatable {
    case ignoreIfLowerPriority
    case interruptLowerPriority
    case replaceSameKind
    case alwaysInterrupt
}

enum CharacterAnimationIntentSource: String, Codable, Equatable {
    case agentRuntime
    case runtimeLifecycle
    case userInteraction
    case desktopInteraction
    case autonomy
    case rendererFallback
}

struct CharacterAnimationIntent: Codable, Equatable {
    var state: CharacterAnimationState
    var emotion: CharacterAnimationEmotion?
    var locomotionDirection: CharacterLocomotionDirection?
    var speedTier: CharacterLocomotionSpeedTier?
    var speedPointsPerSecond: Double?
    var intensity: Double
    var priority: Int
    var interruptPolicy: CharacterInterruptPolicy
    var duration: TimeInterval?
    var source: CharacterAnimationIntentSource
    var createdAt: TimeInterval

    init(state: CharacterAnimationState,
         emotion: CharacterAnimationEmotion? = nil,
         locomotionDirection: CharacterLocomotionDirection? = nil,
         speedTier: CharacterLocomotionSpeedTier? = nil,
         speedPointsPerSecond: Double? = nil,
         intensity: Double = 1,
         priority: Int? = nil,
         interruptPolicy: CharacterInterruptPolicy = .interruptLowerPriority,
         duration: TimeInterval? = nil,
         source: CharacterAnimationIntentSource,
         createdAt: TimeInterval = Date().timeIntervalSinceReferenceDate) {
        self.state = state
        self.emotion = emotion
        self.locomotionDirection = locomotionDirection
        self.speedTier = speedTier
        self.speedPointsPerSecond = speedPointsPerSecond.map { max(0, $0) }
        self.intensity = max(0, min(1, intensity))
        self.priority = priority ?? Self.defaultPriority(for: state)
        self.interruptPolicy = interruptPolicy
        self.duration = duration
        self.source = source
        self.createdAt = createdAt
    }

    static func defaultPriority(for state: CharacterAnimationState) -> Int {
        switch state {
        case .unavailable: return 100
        case .dragged: return 90
        case .falling, .landing: return 80
        case .reacting, .taskFailed: return 70
        case .jump: return 68
        case .speaking: return 60
        case .taskReview: return 58
        case .taskRunning: return 55
        case .thinking, .taskWaiting: return 50
        case .listening: return 45
        case .greet: return 44
        case .sleeping: return 35
        case .startMoving, .startMovingLeft, .startMovingRight,
             .walkLeft, .walkRight, .briskWalkLeft, .briskWalkRight,
             .runLeft, .runRight, .stopMoving, .stopMovingLeft, .stopMovingRight,
             .turnLeftToFront, .turnRightToFront:
            return 30
        case .blink, .idleLookAround,
             .look000, .look0225, .look045, .look0675,
             .look090, .look1125, .look135, .look1575,
             .look180, .look2025, .look225, .look2475,
             .look270, .look2925, .look315, .look3375:
            return 12
        case .idle: return 10
        case .loading: return 5
        }
    }
}

struct CharacterAnimationConfig: Codable, Equatable {
    struct Range: Codable, Equatable {
        var min: Double
        var max: Double
    }
    struct Asset: Codable, Equatable {
        var name: String
        var relativePath: String
        var sha256: String
        var pixelWidth: Int
        var pixelHeight: Int
    }
    struct Breathing: Codable, Equatable {
        var amplitude: Double
        var durationRange: Range
        var reduceMotionAmplitude: Double
    }
    struct Idle: Codable, Equatable {
        var swayAngleDegreesRange: Range
        var intervalRange: Range
        var microMovementPoints: Double
    }
    struct Reactions: Codable, Equatable {
        var clickCompression: Double
        var happyJumpHeight: Double
        var annoyedShakePoints: Double
        var cooldown: Double
        var maxDuration: Double
    }
    struct Drag: Codable, Equatable {
        var tiltLimitDegrees: Double
        var smoothing: Double
        var releaseDuration: Double
    }
    struct Speaking: Codable, Equatable {
        var motionAmplitude: Double
        var textFallbackLevel: Double
        var releaseDuration: Double
    }
    struct Sleep: Codable, Equatable {
        var idleRate: Double
        var sinkPoints: Double
    }
    struct Canvas: Codable, Equatable {
        var logicalWidth: Double
        var logicalHeight: Double
        var alphaHitThreshold: UInt8
    }

    var version: Int
    var asset: Asset
    var canvas: Canvas
    var breathing: Breathing
    var idle: Idle
    var reactions: Reactions
    var drag: Drag
    var speaking: Speaking
    var sleep: Sleep

    static let `default` = CharacterAnimationConfig(
        version: 1,
        asset: Asset(
            name: "character_anchor_rgba_v3.png",
            relativePath: "Characters/Default/character_anchor_rgba_v3.png",
            sha256: "96a7ad41707ee544ac44912bc443e361ad761907af0d35624e5dacd036a6fa7a",
            pixelWidth: 1024,
            pixelHeight: 1536),
        canvas: Canvas(logicalWidth: 160, logicalHeight: 240, alphaHitThreshold: 18),
        breathing: Breathing(amplitude: 0.018,
                             durationRange: Range(min: 2.8, max: 4.4),
                             reduceMotionAmplitude: 0.006),
        idle: Idle(swayAngleDegreesRange: Range(min: -1.6, max: 1.6),
                   intervalRange: Range(min: 4.5, max: 8.5),
                   microMovementPoints: 1.8),
        reactions: Reactions(clickCompression: 0.035,
                              happyJumpHeight: 10,
                              annoyedShakePoints: 4,
                              cooldown: 0.35,
                              maxDuration: 0.75),
        drag: Drag(tiltLimitDegrees: 7,
                   smoothing: 0.18,
                   releaseDuration: 0.32),
        speaking: Speaking(motionAmplitude: 0.014,
                           textFallbackLevel: 0.28,
                           releaseDuration: 0.22),
        sleep: Sleep(idleRate: 0.42, sinkPoints: 4))

    var footprint: CGSize {
        CGSize(width: canvas.logicalWidth, height: canvas.logicalHeight)
    }
}

struct CharacterPose: Equatable {
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    var rotation: CGFloat = 0
    var offset: CGPoint = .zero

    static let canonical = CharacterPose()
}

struct CharacterAnimationDiagnostics: Equatable {
    var renderer: String
    var state: CharacterAnimationState
    var currentIntent: CharacterAnimationIntent?
    var currentClipID: String?
    var frameInterval: TimeInterval
    var reduceMotion: Bool
    var resourceLoaded: Bool
    var fallbackReason: String?
    var characterID: String? = nil
    var manifestPath: String? = nil
    var assetRootPath: String? = nil
    var selectedDefaultCharacterID: String? = nil
    var loadedFallbackCharacter: Bool = false
    var activeFramePath: String? = nil
}

struct CharacterVisualPoint: Codable, Equatable {
    var x: Double
    var y: Double
}

struct CharacterVisualRect: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

struct CharacterVisualShadow: Codable, Equatable {
    var width: Double
    var height: Double
    var alpha: Double
}

struct CharacterVisualFrameEvent: Codable, Equatable {
    var frame: Int
    var type: String
    var foot: String?
}

struct CharacterVisualFootContact: Codable, Equatable {
    var frame: Int
    var foot: String
}

struct CharacterVisualSpeedRange: Codable, Equatable {
    var min: Double
    var max: Double
}

struct CharacterVisualFallback: Codable, Equatable {
    var clipID: String
    var mode: String
    var notes: String?
}

enum CharacterVisualAssetStatus: String, Codable, Equatable {
    case approved
    case legacy
    case placeholder
}

struct CharacterVisualClip: Codable, Equatable {
    var id: String
    var state: CharacterAnimationState
    var category: String?
    var direction: CharacterLocomotionDirection?
    var speedTier: CharacterLocomotionSpeedTier?
    var fps: Double
    var baseFps: Double?
    var minFps: Double?
    var maxFps: Double?
    var loop: Bool
    var placeholder: Bool
    var assetStatus: CharacterVisualAssetStatus?
    var required: Bool?
    var minFrameCount: Int?
    var targetFrameCount: Int?
    var speedRange: CharacterVisualSpeedRange?
    var frames: [String]
    var pivot: CharacterVisualPoint
    var hitbox: CharacterVisualRect
    var shadow: CharacterVisualShadow?
    var events: [CharacterVisualFrameEvent]
    var footContacts: [CharacterVisualFootContact]?
    var fallback: CharacterVisualFallback?
    var notes: String?

    var resolvedBaseFps: Double {
        baseFps ?? fps
    }

    func effectiveFps(forSpeed speed: Double?) -> Double {
        let base = resolvedBaseFps
        let minValue = minFps ?? base
        let maxValue = maxFps ?? base
        guard let speed, let speedRange, speedRange.max > speedRange.min else {
            return max(minValue, min(base, maxValue))
        }
        let ratio = max(0, min(1, (speed - speedRange.min) / (speedRange.max - speedRange.min)))
        return max(minValue, min(minValue + (maxValue - minValue) * ratio, maxValue))
    }
}

struct CharacterVisualHabitat: Codable, Equatable {
    var id: String
    var placeholder: Bool
    var style: String
    var anchor: CharacterVisualPoint
    var hitbox: CharacterVisualRect
    var resources: [String]
    var notes: String?
}

struct CharacterInteractionStateSpec: Codable, Equatable {
    var id: String
    var displayName: String
    var category: String
    var trigger: String
    var clipID: String
    var state: CharacterAnimationState
    var emotion: CharacterAnimationEmotion?
    var intensity: Double?
    var priority: Int?
    var duration: TimeInterval?
    var loop: Bool?
    var notes: String?

    func intent(source: CharacterAnimationIntentSource = .userInteraction,
                now: TimeInterval = Date().timeIntervalSinceReferenceDate) -> CharacterAnimationIntent {
        CharacterAnimationIntent(state: state,
                                 emotion: emotion,
                                 intensity: intensity ?? 1,
                                 priority: priority,
                                 duration: duration,
                                 source: source,
                                 createdAt: now)
    }
}

struct CharacterVisualCanvas: Codable, Equatable {
    var spriteWidth: Int
    var spriteHeight: Int
    var columns: Int?
    var rows: Int?
    var anchor: CharacterVisualPoint?
    var baseline: String?

    func logicalSize(preservingHeight height: CGFloat) -> CGSize? {
        guard spriteWidth > 0, spriteHeight > 0, height > 0 else { return nil }
        return CGSize(width: CGFloat(spriteWidth) / CGFloat(spriteHeight) * height,
                      height: height)
    }
}

struct CharacterVisualProvenance: Codable, Equatable {
    var source: String?
    var sourcePetJSON: String?
    var sourceSpritesheet: String?
    var petJSONSHA256: String?
    var spritesheetSHA256: String?
    var spritesheetPathFromPetJSON: String?
    var spriteVersionNumber: Int?
}

struct CharacterVisualManifest: Codable, Equatable {
    struct Character: Codable, Equatable {
        var id: String
        var displayName: String
        var canonicalScale: String
        var asymmetricFeatures: [String]
        var runtimeFallback: String
    }

    struct Pipeline: Codable, Equatable {
        var candidatePath: String
        var reviewPath: String
        var approvedPath: String
        var ruleSummary: [String]
    }

    var schemaVersion: Int
    var manifestID: String
    var character: Character
    var canvas: CharacterVisualCanvas?
    var provenance: CharacterVisualProvenance?
    var pipeline: Pipeline
    var clips: [CharacterVisualClip]
    var interactionStates: [CharacterInteractionStateSpec]?
    var habitat: CharacterVisualHabitat

    var resolvedInteractionStates: [CharacterInteractionStateSpec] {
        interactionStates ?? []
    }

    func interactionState(id: String) -> CharacterInteractionStateSpec? {
        resolvedInteractionStates.first { $0.id == id }
    }

    func clip(for state: CharacterAnimationState) -> CharacterVisualClip? {
        clips.first { $0.state == state }
    }

    func clip(id: String) -> CharacterVisualClip? {
        clips.first { $0.id == id }
    }

    func clip(for state: CharacterAnimationState,
              direction: CharacterLocomotionDirection?,
              speedTier: CharacterLocomotionSpeedTier?) -> CharacterVisualClip? {
        let candidates = clips.filter { $0.state == state }
        if let direction, let speedTier,
           let exact = candidates.first(where: { $0.direction == direction && $0.speedTier == speedTier }) {
            return exact
        }
        if let direction,
           let directional = candidates.first(where: { $0.direction == direction }) {
            return directional
        }
        return candidates.first
    }
}

struct CharacterLookPose: Equatable {
    var angleDegrees: Double
    var state: CharacterAnimationState
    var clipID: String
}

enum CharacterLookPoseResolver {
    static let poses: [CharacterLookPose] = [
        CharacterLookPose(angleDegrees: 0, state: .look000, clipID: "look_000"),
        CharacterLookPose(angleDegrees: 22.5, state: .look0225, clipID: "look_022_5"),
        CharacterLookPose(angleDegrees: 45, state: .look045, clipID: "look_045"),
        CharacterLookPose(angleDegrees: 67.5, state: .look0675, clipID: "look_067_5"),
        CharacterLookPose(angleDegrees: 90, state: .look090, clipID: "look_090"),
        CharacterLookPose(angleDegrees: 112.5, state: .look1125, clipID: "look_112_5"),
        CharacterLookPose(angleDegrees: 135, state: .look135, clipID: "look_135"),
        CharacterLookPose(angleDegrees: 157.5, state: .look1575, clipID: "look_157_5"),
        CharacterLookPose(angleDegrees: 180, state: .look180, clipID: "look_180"),
        CharacterLookPose(angleDegrees: 202.5, state: .look2025, clipID: "look_202_5"),
        CharacterLookPose(angleDegrees: 225, state: .look225, clipID: "look_225"),
        CharacterLookPose(angleDegrees: 247.5, state: .look2475, clipID: "look_247_5"),
        CharacterLookPose(angleDegrees: 270, state: .look270, clipID: "look_270"),
        CharacterLookPose(angleDegrees: 292.5, state: .look2925, clipID: "look_292_5"),
        CharacterLookPose(angleDegrees: 315, state: .look315, clipID: "look_315"),
        CharacterLookPose(angleDegrees: 337.5, state: .look3375, clipID: "look_337_5")
    ]

    static var clipIDs: [String] { poses.map(\.clipID) }

    static func normalizedDegrees(_ degrees: Double) -> Double {
        let wrapped = degrees.truncatingRemainder(dividingBy: 360)
        return wrapped < 0 ? wrapped + 360 : wrapped
    }

    static func nearestPose(for degrees: Double) -> CharacterLookPose {
        let normalized = normalizedDegrees(degrees)
        let index = Int((normalized / 22.5).rounded()) % poses.count
        return poses[index]
    }

    static func angleDegrees(from vector: CGVector) -> Double {
        guard vector.dx != 0 || vector.dy != 0 else { return 0 }
        let radians = atan2(Double(vector.dy), Double(vector.dx))
        return normalizedDegrees(radians * 180 / .pi)
    }
}

struct PetAnimationFrame: Equatable {
    var id: String
    var logicalSize: CGSize
    var sourcePath: String
}

struct PetAnimationClip: Equatable {
    var id: String
    var frames: [PetAnimationFrame]
    var fps: Double
    var loop: Bool
    var canonicalLogicalSize: CGSize
}

struct PetAnimationManifest: Equatable {
    var clips: [PetAnimationClip]
    var canonicalLogicalSize: CGSize
}

struct PetAnimationPlayer: Equatable {
    private(set) var activeClipID: String?
    private(set) var frameIndex: Int = 0
    private var accumulator: TimeInterval = 0

    mutating func reset(clipID: String? = nil) {
        activeClipID = clipID
        frameIndex = 0
        accumulator = 0
    }

    mutating func advance(clipID: String,
                          frameCount: Int,
                          fps: Double,
                          loop: Bool,
                          deltaTime: TimeInterval) -> Int {
        guard frameCount > 0 else {
            reset(clipID: nil)
            return 0
        }
        guard fps > 0 else {
            reset(clipID: clipID)
            return 0
        }
        if activeClipID != clipID {
            reset(clipID: clipID)
            return 0
        }

        accumulator += max(0, min(deltaTime, 0.25))
        let frameDuration = 1.0 / fps
        while accumulator + 0.000_000_001 >= frameDuration {
            accumulator -= frameDuration
            if loop {
                frameIndex = (frameIndex + 1) % frameCount
            } else {
                frameIndex = min(frameIndex + 1, frameCount - 1)
            }
        }
        return min(frameIndex, frameCount - 1)
    }
}

typealias PetLocomotionController = CharacterLocomotionController

enum PetAgentAnimationEvent: Equatable {
    case greeting
    case providerWaiting
    case taskRunning
    case taskReview
    case taskSucceeded
    case terminalFailure
    case userMessageReceived
    case listeningStarted
    case thinkingStarted
    case thinkingFinished
    case responseStarted
    case responseDelta
    case responseFinished(emotion: PetEmotion)
    case responseFailed
    case responseCancelled
    case emotionChanged(PetEmotion)
}

enum AgentAnimationEventMapper {
    static func intent(for event: PetAgentAnimationEvent,
                       now: TimeInterval = Date().timeIntervalSinceReferenceDate) -> CharacterAnimationIntent {
        switch event {
        case .greeting:
            CharacterAnimationIntent(state: .greet, emotion: .happy, priority: 45,
                                     duration: 0.72, source: .agentRuntime, createdAt: now)
        case .providerWaiting:
            CharacterAnimationIntent(state: .taskWaiting, emotion: .curious, priority: 50,
                                     source: .agentRuntime, createdAt: now)
        case .taskRunning:
            CharacterAnimationIntent(state: .taskRunning, emotion: .curious, priority: 55,
                                     source: .agentRuntime, createdAt: now)
        case .taskReview:
            CharacterAnimationIntent(state: .taskReview, emotion: .curious, priority: 58,
                                     source: .agentRuntime, createdAt: now)
        case .taskSucceeded:
            CharacterAnimationIntent(state: .jump, emotion: .happy, priority: 68,
                                     duration: 0.78, source: .agentRuntime, createdAt: now)
        case .terminalFailure:
            CharacterAnimationIntent(state: .taskFailed, emotion: .sad, intensity: 0.7,
                                     priority: 70, duration: 1.45, source: .agentRuntime, createdAt: now)
        case .userMessageReceived, .listeningStarted:
            CharacterAnimationIntent(state: .listening, emotion: .curious, priority: 45,
                                     duration: 0.6, source: .agentRuntime, createdAt: now)
        case .thinkingStarted:
            CharacterAnimationIntent(state: .taskWaiting, emotion: .curious, priority: 50,
                                     source: .agentRuntime, createdAt: now)
        case .thinkingFinished:
            CharacterAnimationIntent(state: .idle, priority: 10, duration: 0.2,
                                     source: .agentRuntime, createdAt: now)
        case .responseStarted, .responseDelta:
            CharacterAnimationIntent(state: .speaking, priority: 60, duration: 0.9,
                                     source: .agentRuntime, createdAt: now)
        case .responseFinished(let emotion):
            CharacterAnimationIntent(state: .jump, emotion: CharacterAnimationEmotion(petEmotion: emotion),
                                     intensity: 0.55, priority: 68, duration: 0.78,
                                     source: .agentRuntime, createdAt: now)
        case .responseFailed:
            CharacterAnimationIntent(state: .taskFailed, emotion: .sad, intensity: 0.7,
                                     priority: 70, duration: 1.45, source: .agentRuntime, createdAt: now)
        case .responseCancelled:
            CharacterAnimationIntent(state: .idle, emotion: .neutral, priority: 50,
                                     duration: 0.2, source: .agentRuntime, createdAt: now)
        case .emotionChanged(let emotion):
            CharacterAnimationIntent(state: .reacting, emotion: CharacterAnimationEmotion(petEmotion: emotion),
                                     intensity: 0.5, priority: 40, duration: 0.5,
                                     source: .agentRuntime, createdAt: now)
        }
    }
}
