import CoreGraphics
import Foundation

/// Rendering abstraction so the current static PNG renderer can later be swapped for a
/// Live2D Cubism-Metal renderer without touching behavior or window code.
@MainActor
protocol PetRenderer: AnyObject {
    /// Place the pet's feet at this window-local point, facing +1/-1.
    func setFeet(to point: CGPoint, facing: CGFloat)
    /// Drive the visible pose from the high-level activity.
    func apply(activity: PetActivity)
    /// Apply a semantic animation event; concrete resources stay below this layer.
    func apply(intent: CharacterAnimationIntent)
    /// Text-driven speaking fallback or future audio RMS level.
    func setSpeakingLevel(_ level: Float)
    /// Smooth gaze/look target in renderer-local terms.
    func setLookTarget(_ target: CGPoint?)
    /// Advance renderer-owned animation state.
    func update(deltaTime: TimeInterval)
    /// Alpha-aware hit testing in scene-local coordinates.
    func hitTestCharacter(_ point: CGPoint) -> Bool
    /// Overall fade for show/hide entrances (doc §14.1 — appear naturally, not abruptly).
    func setVisible(_ visible: Bool, animated: Bool)
    /// Clear timers/actions/resources owned by the renderer.
    func shutdown()
}
