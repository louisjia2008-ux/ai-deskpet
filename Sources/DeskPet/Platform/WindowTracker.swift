import AppKit

/// P18 — Abstraction over the window tracker so unit tests can swap a deterministic
/// stub for the production CGWindowList-driven implementation without needing
/// TCC / Accessibility authorization.
@MainActor
public protocol WindowTrackerProviding: AnyObject {
    var accessibilityTrusted: Bool { get }
    func windowSurfaces(minWidth: CGFloat, minHeight: CGFloat) -> [Surface]
    func allSurfaces() -> [Surface]
    func frontmostWindowTitle() -> String?
    func isFullscreenWindowPresent(tolerance: CGFloat) -> Bool
}

extension WindowTrackerProviding {
    /// Default no-arg convenience so existing call sites compile unchanged.
    public func windowSurfaces() -> [Surface] {
        windowSurfaces(minWidth: 120, minHeight: 80)
    }

    /// Default no-arg convenience for fullscreen check.
    public func isFullscreenWindowPresent() -> Bool {
        isFullscreenWindowPresent(tolerance: 2)
    }

    /// Default single-fetch snapshot for stubs: composes from the separate calls.
    /// Production `WindowTracker` overrides with one CGWindowList copy.
    public func snapshot() -> (surfaces: [Surface], windowSurfaces: [Surface], fullscreen: Bool) {
        (allSurfaces(), windowSurfaces(), isFullscreenWindowPresent())
    }
}

/// Reads geometry of other apps' visible windows so the pet can perch on their top edges.
/// Uses CGWindowList (no special permission) as the baseline; Accessibility (AXUIElement)
/// can refine this later. We only READ geometry — never move, close, or focus any window.
@MainActor
public final class WindowTracker: WindowTrackerProviding {

    private let screens: ScreenManager
    private let ownPID = ProcessInfo.processInfo.processIdentifier

    public init(screens: ScreenManager) { self.screens = screens }

    /// Has the user granted Accessibility? Without it we degrade to CGWindowList geometry only.
    public var accessibilityTrusted: Bool { AXIsProcessTrusted() }

    /// Single-fetch snapshot: one CGWindowList call serving surfaces + title +
    /// fullscreen, so the 1Hz tick doesn't pay 3 full copies per second.
    public struct WindowListSnapshot: Sendable {
        public var surfaces: [Surface]
        public var frontmostTitle: String?
        public var fullscreenPresent: Bool
    }

    public func snapshot(minWidth: CGFloat = 120, minHeight: CGFloat = 80,
                         tolerance: CGFloat = 2) -> WindowListSnapshot {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let infos = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            return WindowListSnapshot(surfaces: [], frontmostTitle: nil, fullscreenPresent: false)
        }
        return WindowListSnapshot(
            surfaces: Self.surfaces(from: infos, screens: screens, ownPID: ownPID,
                                    minWidth: minWidth, minHeight: minHeight),
            frontmostTitle: Self.frontmostTitle(from: infos, ownPID: ownPID),
            fullscreenPresent: Self.fullscreenPresent(from: infos, tolerance: tolerance)
        )
    }

    /// Top-edge surfaces of normal, on-screen, sufficiently large windows (excluding our own).
    public func windowSurfaces(minWidth: CGFloat = 120, minHeight: CGFloat = 80) -> [Surface] {
        snapshot(minWidth: minWidth, minHeight: minHeight).surfaces
    }

    /// Everything the pet may stand on right now: window tops + screen floors.
    public func allSurfaces() -> [Surface] {
        windowSurfaces() + screens.screenSurfaces()
    }

    /// Title of the frontmost normal window, if exposed by the system (L2, doc §11.4). Often
    /// empty without Screen Recording permission — callers must tolerate nil.
    public func frontmostWindowTitle() -> String? {
        snapshot().frontmostTitle
    }

    /// Best-effort fullscreen detection (doc §5.4 强制收敛): a normal window whose CG bounds
    /// cover an entire display frame (not just the visibleFrame). No special permission needed.
    public func isFullscreenWindowPresent(tolerance: CGFloat = 2) -> Bool {
        snapshot(tolerance: tolerance).fullscreenPresent
    }

    // MARK: - Shared single-fetch parsers (pure over one CGWindowList copy)

    static func surfaces(from infos: [[String: Any]], screens: ScreenManager, ownPID: pid_t,
                         minWidth: CGFloat, minHeight: CGFloat) -> [Surface] {
        var out: [Surface] = []
        for info in infos {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            if let pid = info[kCGWindowOwnerPID as String] as? Int32, pid == ownPID { continue }
            guard let b = info[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"],
                  w >= minWidth, h >= minHeight else { continue }
            let number = (info[kCGWindowNumber as String] as? Int).map(String.init) ?? UUID().uuidString
            out.append(screens.windowTopSurface(cgBounds: CGRect(x: x, y: y, width: w, height: h),
                                                id: "win-\(number)"))
        }
        return out
    }

    static func frontmostTitle(from infos: [[String: Any]], ownPID: pid_t) -> String? {
        for info in infos {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  (info[kCGWindowOwnerPID as String] as? Int32) != ownPID else { continue }
            if let name = info[kCGWindowName as String] as? String, !name.isEmpty { return name }
        }
        return nil
    }

    static func fullscreenPresent(from infos: [[String: Any]], tolerance: CGFloat) -> Bool {
        let fullSizes = NSScreen.screens.map(\.frame.size)
        for info in infos {
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let b = info[kCGWindowBounds as String] as? [String: CGFloat],
                  let w = b["Width"], let h = b["Height"] else { continue }
            if fullSizes.contains(where: { abs($0.width - w) <= tolerance && abs($0.height - h) <= tolerance }) {
                return true
            }
        }
        return false
    }
}
