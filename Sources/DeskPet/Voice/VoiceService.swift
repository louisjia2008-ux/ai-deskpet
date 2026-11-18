import Foundation
import AICore

/// Orchestrates voice (doc §8.3/§8.4): applies the level + auto-mute policy, prefers the isolated
/// local-AI TTS, and falls back to system TTS. The graded-voice brain lives in `VoicePolicy`.
@MainActor
final class VoiceService {
    var level: VoiceLevel = .effectsOnly

    private let system = SystemTTSProvider()
    private let localAI = LocalAITTSProvider()
    private let effects = SoundEffects()

    /// `autoMuted` comes from the live behavior context (meeting/fullscreen/deep night/focus/quiet).
    func utter(_ text: String, kind: SpeechKind, emotion: PetEmotion, autoMuted: Bool) {
        let action = VoicePolicy.decide(level: level, autoMuted: autoMuted, kind: kind,
                                        text: text, tags: VoiceTags(emotion: emotion))
        switch action {
        case .silent:
            break
        case .effect(let name):
            effects.play(name)
        case .speak(let t, let rate, let pitch, let volume):
            if localAI.isAvailable {
                localAI.speak(t, rate: rate, pitch: pitch, volume: volume)
            } else {
                system.speak(t, rate: rate, pitch: pitch, volume: volume)  // fallback (doc §8.4)
            }
        }
    }

    func stop() { localAI.stop(); system.stop() }
}
