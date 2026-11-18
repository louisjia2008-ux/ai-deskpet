import AppKit

/// Borderless, transparent, always-on-top window that floats over every Space and never
/// steals focus (doc §1.3 视觉自由系统克制, §14.1 不抢焦点). It can span all displays.
@MainActor
final class OverlayWindow: NSWindow {

    init(frame: CGRect) {
        super.init(contentRect: frame,
                   styleMask: [.borderless],
                   backing: .buffered,
                   defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .statusBar                       // above normal windows, below the menu bar
        ignoresMouseEvents = true                // default: click-through (work-first)
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isMovableByWindowBackground = false
        // Never become key/main → cannot steal keyboard focus from the user's app.
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
