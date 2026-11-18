import AppKit

/// Default-level audio cues (doc §8.3 动作音效/小龙叫声/翻书/魔法声). Placeholder: plays a bundled
/// sound if present, otherwise stays silent (no annoying system beeps). Real effect assets are an
/// art-stage deliverable (doc §19), like the placeholder sprite.
@MainActor
final class SoundEffects {
    func play(_ name: String) {
        guard let url = Bundle.main.url(forResource: name, withExtension: "aiff")
            ?? Bundle.main.url(forResource: name, withExtension: "wav"),
              let sound = NSSound(contentsOf: url, byReference: true) else { return }
        sound.play()
    }
}
