import CoreGraphics

/// Mouse interaction policy (doc §7.1).
enum PassthroughMode: String, CaseIterable {
    case workFirst      // default: clicks pass through; modifier/hover needed to interact
    case interactFirst  // hover dwell → interactive; quick swipes still pass through
    case fullPassthrough // nothing receives the mouse

    var label: String {
        switch self {
        case .workFirst: return "工作优先（穿透）"
        case .interactFirst: return "互动优先"
        case .fullPassthrough: return "完全穿透"
        }
    }
}

/// Shared, single source of truth for the pet (doc §13.3 — one PetState, no clones).
@MainActor
final class PetState {
    /// Pet position in global AppKit coordinates (feet point).
    var position: CGPoint = .zero
    /// Facing: +1 right, -1 left.
    var facing: CGFloat = 1
    /// The "home" the pet returns to on recall / long idle.
    var home: CGPoint = .zero
    var passthrough: PassthroughMode = .workFirst
    var isHidden: Bool = false
    /// The surface the pet currently stands on, if any.
    var currentSurface: Surface?

    // Companion + M1 behavior flags
    var playfulMode: Bool = false   // 调皮模式 (opt-in; still never moves real windows/files)
    var pinned: Bool = false        // 待在这里 — stop wandering
    var followWindow: Bool = false  // 跟随当前窗口
}
