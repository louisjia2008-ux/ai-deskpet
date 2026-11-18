import Foundation

/// Graded perception (doc §11.4) with hard boundaries (doc §11.5). The policy is the single
/// gatekeeper deciding what the pet may observe; callers MUST consult it before reading anything.
public enum PerceptionLevel: Int, Comparable, Sendable, CaseIterable {
    case off = 0     // perceive nothing
    case app = 1     // L1: current app identity only (no content)
    case title = 2   // L2: window titles, whitelisted apps, ephemeral
    case screen = 3  // L3: screen understanding, explicit per-use trigger only
    public static func < (l: Self, r: Self) -> Bool { l.rawValue < r.rawValue }
    public var label: String {
        switch self {
        case .off: return "关闭"
        case .app: return "L1 当前应用"
        case .title: return "L2 窗口标题"
        case .screen: return "L3 屏幕理解"
        }
    }
}

public struct PerceptionPolicy: Sendable, Equatable {
    /// Highest level the user has enabled. Default L1 only (doc §11.4 默认开启 当前 App).
    public var maxLevel: PerceptionLevel = .app
    /// Apps for which window-title reading (L2) is allowed.
    public var titleWhitelist: Set<String> = []

    public init() {}

    public var canReadApp: Bool { maxLevel >= .app }

    public func canReadTitle(ofBundleID bundleID: String?) -> Bool {
        guard maxLevel >= .title, let id = bundleID else { return false }
        return titleWhitelist.contains(id)
    }

    /// L3 is gated by BOTH the enabled level AND an explicit per-use consent (doc §11.4/§11.5).
    /// There is no way to read the screen without a fresh, explicit user action.
    public func canReadScreen(explicitConsent: Bool) -> Bool {
        maxLevel >= .screen && explicitConsent
    }

    /// Hard rule (doc §11.5): screen-understanding output is ephemeral — it must never be
    /// written to long-term memory or the chat database.
    public func screenTextMayPersist() -> Bool { false }
}
