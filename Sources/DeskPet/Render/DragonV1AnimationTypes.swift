import CoreGraphics
import Foundation

enum DragonAnimationState: String, Codable, CaseIterable, Equatable {
    case idleHover
    case takeoff
    case flyLeft
    case flyRight
    case land
}

struct DragonV1Manifest: Codable, Equatable {
    struct Runtime: Codable, Equatable {
        var enabledByDefault: Bool
        var featureGate: String
    }

    struct CanvasSize: Codable, Equatable {
        var width: Int
        var height: Int
    }

    struct AnchorPoint: Codable, Equatable {
        var x: Double
        var y: Double
    }

    struct Clip: Codable, Equatable {
        var name: String
        var state: DragonAnimationState
        var relativePath: String
        var frameCount: Int
        var fps: Double
        var loop: Bool
        var canvasSize: CanvasSize
        var anchorPoint: AnchorPoint
        var frames: [String]
    }

    var schemaVersion: Int
    var manifestID: String
    var dragonID: String
    var assetStatus: String
    var acceptedReviewPackagePath: String
    var acceptedReviewTimestamp: String
    var humanVisualAcceptance: String
    var runtime: Runtime
    var approvedRoot: String
    var clips: [Clip]

    enum CodingKeys: String, CodingKey {
        case schemaVersion
        case manifestID
        case dragonID
        case assetStatus
        case acceptedReviewPackagePath
        case acceptedReviewTimestamp
        case humanVisualAcceptance = "HUMAN_VISUAL_ACCEPTANCE"
        case runtime
        case approvedRoot
        case clips
    }

    func clip(for state: DragonAnimationState) -> Clip? {
        clips.first { $0.state == state }
    }

    func clip(named name: String) -> Clip? {
        clips.first { $0.name == name }
    }
}

enum DragonV1ManifestValidationError: LocalizedError, Equatable {
    case invalidAcceptance(String)
    case duplicateClip(String)
    case missingClip(String)
    case invalidClip(String)

    var errorDescription: String? {
        switch self {
        case .invalidAcceptance(let value):
            return "DragonV1 manifest has invalid human visual acceptance value \(value)"
        case .duplicateClip(let name):
            return "DragonV1 manifest contains duplicate clip \(name)"
        case .missingClip(let name):
            return "DragonV1 manifest is missing required clip \(name)"
        case .invalidClip(let name):
            return "DragonV1 clip \(name) has invalid frame, fps, canvas, or anchor metadata"
        }
    }
}

enum DragonV1ManifestLoadResult: String, Equatable {
    case notAttempted
    case disabled
    case loaded
    case manifestMissing
    case manifestInvalid
    case missingFrames
    case unreadableFrame
}

struct DragonAnimationStateMachine: Equatable {
    private(set) var state: DragonAnimationState = .idleHover
    private var queuedState: DragonAnimationState?
    private var remainingDuration: TimeInterval = 0
    var takeoffDuration: TimeInterval
    var landDuration: TimeInterval

    init(takeoffDuration: TimeInterval = 1.0, landDuration: TimeInterval = 1.0) {
        self.takeoffDuration = takeoffDuration
        self.landDuration = landDuration
    }

    mutating func setIdleHover() {
        enter(.idleHover)
    }

    mutating func setFlyingLeft() {
        enter(.flyLeft)
    }

    mutating func setFlyingRight() {
        enter(.flyRight)
    }

    mutating func startFlyingLeft() {
        enter(.takeoff, duration: takeoffDuration, next: .flyLeft)
    }

    mutating func startFlyingRight() {
        enter(.takeoff, duration: takeoffDuration, next: .flyRight)
    }

    mutating func land() {
        enter(.land, duration: landDuration, next: .idleHover)
    }

    mutating func transition(to requestedState: DragonAnimationState) {
        switch requestedState {
        case .idleHover:
            setIdleHover()
        case .takeoff:
            enter(.takeoff, duration: takeoffDuration, next: .idleHover)
        case .flyLeft:
            setFlyingLeft()
        case .flyRight:
            setFlyingRight()
        case .land:
            land()
        }
    }

    mutating func update(deltaTime: TimeInterval) {
        guard remainingDuration > 0 else { return }
        remainingDuration -= max(0, deltaTime)
        if remainingDuration <= 0 {
            enter(queuedState ?? .idleHover)
        }
    }

    private mutating func enter(_ nextState: DragonAnimationState,
                                duration: TimeInterval = 0,
                                next queued: DragonAnimationState? = nil) {
        state = nextState
        remainingDuration = max(0, duration)
        queuedState = queued
    }
}

struct DragonV1RuntimeFlagSnapshot: Equatable {
    var flagRawValue: String?
    var isEnabled: Bool
}

enum DragonV1RuntimeConfig {
    static let environmentKey = "DESKPET_ENABLE_DRAGON_V1_ASSETS"

    static var isEnabled: Bool {
        snapshot().isEnabled
    }

    static func snapshot(environment: [String: String] = ProcessInfo.processInfo.environment) -> DragonV1RuntimeFlagSnapshot {
        let rawValue = environment[environmentKey]
        return DragonV1RuntimeFlagSnapshot(flagRawValue: rawValue,
                                           isEnabled: rawValue == "1")
    }
}
