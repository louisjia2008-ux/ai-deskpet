import Foundation

/// Graded voice (doc §8.3). effectsOnly is the default (动作音效/短哼声); full enables spoken
/// sentences (朗读/对话/庆祝); muted is silent.
public enum VoiceLevel: String, CaseIterable, Sendable {
    case muted, effectsOnly, full
    public var label: String {
        switch self {
        case .muted: return "静音"
        case .effectsOnly: return "默认（音效）"
        case .full: return "完整语音"
        }
    }
}

/// What kind of utterance this is — decides whether it needs full voice or just an effect.
public enum SpeechKind: String, Sendable {
    case chatter       // 日常短句
    case quick         // 快速问答回复
    case reading       // 朗读较长内容
    case reminder      // 重要提醒
    case celebration   // 大任务庆祝
}

/// Expressive tags passed to the synth (doc §8.4 情绪/强度/速度).
public struct VoiceTags: Sendable, Equatable {
    public var emotion: PetEmotion
    public var intensity: Double   // 0…1
    public var speed: Double       // 0.5…2.0 multiplier
    public init(emotion: PetEmotion = .neutral, intensity: Double = 0.8, speed: Double = 1.0) {
        self.emotion = emotion; self.intensity = intensity; self.speed = speed
    }

    /// Map emotion + tags to synth multipliers (rate, pitch, volume). Pure & testable.
    public func synthParams() -> (rate: Double, pitch: Double, volume: Double) {
        let (baseRate, basePitch): (Double, Double)
        switch emotion {
        case .happy:    (baseRate, basePitch) = (1.10, 1.12)
        case .excited:  (baseRate, basePitch) = (1.18, 1.18)
        case .shy:      (baseRate, basePitch) = (0.98, 1.08)
        case .sad:      (baseRate, basePitch) = (0.88, 0.90)
        case .sleepy:   (baseRate, basePitch) = (0.82, 0.86)
        case .thinking: (baseRate, basePitch) = (0.95, 0.98)
        case .neutral:  (baseRate, basePitch) = (1.00, 1.00)
        }
        let rate = max(0.5, min(2.0, baseRate * speed))
        let volume = max(0.4, min(1.0, 0.8 + 0.2 * intensity))
        return (rate, basePitch, volume)
    }
}

/// The concrete thing to do for an utterance.
public enum VoiceAction: Equatable, Sendable {
    case silent
    case effect(String)
    case speak(text: String, rate: Double, pitch: Double, volume: Double)
}

/// Pure decision: given the level, whether the environment forces mute, and the utterance kind,
/// decide silent / effect / speak (doc §8.3). Auto-mute always wins (doc §8.3 自动静音).
public enum VoicePolicy {
    public static func decide(level: VoiceLevel, autoMuted: Bool,
                              kind: SpeechKind, text: String, tags: VoiceTags) -> VoiceAction {
        if level == .muted || autoMuted { return .silent }
        switch level {
        case .muted:
            return .silent
        case .effectsOnly:
            switch kind {
            case .chatter, .quick: return .effect("chirp")
            case .reminder:        return .effect("ding")
            case .celebration:     return .effect("fanfare")
            case .reading:         return .silent   // don't read text aloud at this level
            }
        case .full:
            let p = tags.synthParams()
            return .speak(text: text, rate: p.rate, pitch: p.pitch, volume: p.volume)
        }
    }
}
