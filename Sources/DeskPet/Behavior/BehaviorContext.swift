import AppKit

/// Snapshot of the environment that shapes how active/talkative the pet should be
/// (doc §2.2, §5.4, §8.1). Pure value type — the engine consumes it; ContextMonitor produces it.
struct BehaviorContext: Sendable, Equatable {
    var frontmostBundleID: String?
    var isFullscreenPresent: Bool = false
    var isDeepNight: Bool = false
    var absoluteQuiet: Bool = false
    var focusActive: Bool = false   // a focus session is running (doc §9.5 轻陪伴)

    /// Apps where the pet should stay in light-companion mode (talk far less), doc §2.2.
    static let workBundleIDs: Set<String> = [
        "com.apple.dt.Xcode", "com.apple.Terminal", "com.googlecode.iterm2",
        "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", // cursor
    ]
    var isWorkApp: Bool { frontmostBundleID.map(Self.workBundleIDs.contains) ?? false }

    /// Hard convergence → visual-only, no speaking (doc §5.4 强制收敛, §9.5 专注轻陪伴).
    var shouldConverge: Bool { isFullscreenPresent || isDeepNight || absoluteQuiet || focusActive }

    /// Multiplier on the base speak interval (>1 = quieter). Work apps reduce chatter.
    var talkativenessMultiplier: Double { isWorkApp ? 2.0 : 1.0 }
}

/// Produces BehaviorContext from the live system. Uses only permission-free signals
/// (frontmost app, clock, on-screen window geometry) and degrades gracefully (doc §14.2).
@MainActor
final class ContextMonitor {

    private let tracker: WindowTracker
    var absoluteQuiet = false
    var focusActive = false
    /// Deep-night window (local hours), doc §8.3 自动静音 深夜.
    var nightStartHour = 23
    var nightEndHour = 7

    init(tracker: WindowTracker) { self.tracker = tracker }

    func snapshot(now: Date = Date()) -> BehaviorContext {
        var ctx = BehaviorContext()
        ctx.frontmostBundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        ctx.isFullscreenPresent = tracker.isFullscreenWindowPresent()
        ctx.isDeepNight = isDeepNight(now)
        ctx.absoluteQuiet = absoluteQuiet
        ctx.focusActive = focusActive
        return ctx
    }

    private func isDeepNight(_ now: Date) -> Bool {
        let h = Calendar.current.component(.hour, from: now)
        if nightStartHour <= nightEndHour { return h >= nightStartHour && h < nightEndHour }
        return h >= nightStartHour || h < nightEndHour   // wraps past midnight
    }
}
