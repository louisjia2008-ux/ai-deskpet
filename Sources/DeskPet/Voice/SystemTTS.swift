import AVFoundation
import AICore

/// System TTS via AVSpeechSynthesizer — the documented fallback (doc §8.4 系统 TTS 作为故障回退),
/// and today's working voice until a local neural model is wired. Out-of-process by nature.
@MainActor
final class SystemTTSProvider {
    private let synth = AVSpeechSynthesizer()
    var isAvailable: Bool { true }

    /// rate/pitch/volume are multipliers from VoiceTags.synthParams().
    func speak(_ text: String, rate: Double, pitch: Double, volume: Double, language: String = "zh-CN") {
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: language)
        // AVSpeech default rate is ~0.5 of the 0…1 range; scale by our multiplier.
        u.rate = Float(min(1.0, max(0.0, Double(AVSpeechUtteranceDefaultSpeechRate) * rate)))
        u.pitchMultiplier = Float(min(2.0, max(0.5, pitch)))
        u.volume = Float(min(1.0, max(0.0, volume)))
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
}

/// Slot for the isolated local-AI TTS helper (doc §8.4 模型与桌宠主进程隔离). It will follow the
/// same out-of-process pattern as `DeskPetLLM` once a neural TTS model is selected (M7-era asset).
/// Until then it reports unavailable so VoiceService transparently falls back to system TTS.
@MainActor
final class LocalAITTSProvider {
    var isAvailable: Bool { false }
    func speak(_ text: String, rate: Double, pitch: Double, volume: Double) { /* neural model TBD */ }
    func stop() {}
}
