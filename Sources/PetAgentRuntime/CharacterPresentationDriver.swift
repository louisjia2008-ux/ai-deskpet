import Foundation
import AICore
import PetBrainCore

// P5.0 — the runtime-facing presentation abstraction (doc §6.8). The runtime never touches a sprite,
// a SwiftUI view, or a Live2D parameter; it speaks only this protocol. Concrete drivers live in the
// app layer (StaticSpritePresentationDriver) or are stubs (NoOpLive2DPresentationDriver). Driver
// methods are non-throwing async so a presentation failure can never crash the runtime.

public enum CharacterExpression: String, Sendable, Codable, CaseIterable, Equatable {
    case neutral, happy, curious, thinking, concerned, sleepy, surprised
}

public enum CharacterMotion: String, Sendable, Codable, CaseIterable, Equatable {
    case idle, blink, breathe, nod, shakeHead, wave, tapReaction, speaking, sleep, wake
    case greet, taskWaiting, taskRunning, taskReview, taskFailed, success
}

public struct AttentionTarget: Sendable, Codable, Equatable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

public protocol CharacterPresentationDriver: Sendable {
    func setExpression(_ expression: CharacterExpression) async
    func playMotion(_ motion: CharacterMotion) async
    func setSpeaking(_ isSpeaking: Bool) async
    func setAttentionTarget(_ target: AttentionTarget?) async
    func updateEmotion(_ state: EmotionState) async
    func resetToIdle() async
    func setReduceMotion(_ reduce: Bool) async
}

/// Records every command for assertions. The default test driver.
public actor RecordingPresentationDriver: CharacterPresentationDriver {
    public private(set) var expressions: [CharacterExpression] = []
    public private(set) var motions: [CharacterMotion] = []
    public private(set) var speakingHistory: [Bool] = []
    public private(set) var isSpeaking = false
    public private(set) var attention: AttentionTarget?
    public private(set) var lastEmotion: PetEmotion = .neutral
    public private(set) var resetCount = 0
    public private(set) var reduceMotion = false

    public init() {}

    public func setExpression(_ expression: CharacterExpression) async { expressions.append(expression) }
    public func playMotion(_ motion: CharacterMotion) async { motions.append(motion) }
    public func setSpeaking(_ isSpeaking: Bool) async { self.isSpeaking = isSpeaking; speakingHistory.append(isSpeaking) }
    public func setAttentionTarget(_ target: AttentionTarget?) async { attention = target }
    public func updateEmotion(_ state: EmotionState) async { lastEmotion = state.dominant }
    public func resetToIdle() async { resetCount += 1; isSpeaking = false }
    public func setReduceMotion(_ reduce: Bool) async { reduceMotion = reduce }

    public var lastExpression: CharacterExpression? { expressions.last }
    public var lastMotion: CharacterMotion? { motions.last }
}

/// STUB — Live2D is NOT integrated in P5.0. This adapter exists only to prove the seam compiles and
/// the runtime depends on the protocol, not on any Live2D SDK. It performs no rendering and does NOT
/// read the live2d_model project. Do not present this as working Live2D.
public struct NoOpLive2DPresentationDriver: CharacterPresentationDriver {
    public init() {}
    public func setExpression(_ expression: CharacterExpression) async {}
    public func playMotion(_ motion: CharacterMotion) async {}
    public func setSpeaking(_ isSpeaking: Bool) async {}
    public func setAttentionTarget(_ target: AttentionTarget?) async {}
    public func updateEmotion(_ state: EmotionState) async {}
    public func resetToIdle() async {}
    public func setReduceMotion(_ reduce: Bool) async {}
}
