import AppKit

/// Full-overlay content view that is transparent to the mouse EXCEPT over the pet's current
/// occupancy or native UI region. Cross-application passthrough is owned by the
/// controller through NSWindow.ignoresMouseEvents; returning nil alone is insufficient.
@MainActor
protocol OverlayContentDelegate: AnyObject {
    func overlayMouseDown(atLocal point: CGPoint)
    func overlayMouseDragged(atLocal point: CGPoint)
    func overlayMouseUp(atLocal point: CGPoint)
}

@MainActor
final class OverlayContentView: NSView {

    weak var delegate: OverlayContentDelegate?
    /// Pet rect in this view's local coordinates; supplied by the controller each tick.
    var petRectProvider: () -> CGRect = { .zero }
    /// Alpha-aware character hit test. Falls back to the rect provider only when not supplied.
    var petHitTestProvider: ((CGPoint) -> Bool)?
    /// When false (full passthrough / work-first without modifier) nothing is hit.
    var interactionEnabled: Bool = false

    var nativeUIProvider: ((CGPoint) -> NSView?)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard interactionEnabled else { return nil }
        if let ui = nativeUIProvider?(point) { return ui }
        if let petHitTestProvider {
            return petHitTestProvider(point) ? self : nil
        }
        guard petRectProvider().contains(point) else { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        delegate?.overlayMouseDown(atLocal: convert(event.locationInWindow, from: nil))
    }
    override func mouseDragged(with event: NSEvent) {
        delegate?.overlayMouseDragged(atLocal: convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) {
        delegate?.overlayMouseUp(atLocal: convert(event.locationInWindow, from: nil))
    }

    override var isFlipped: Bool { false }  // bottom-left origin, matches AppKit global coords
}
