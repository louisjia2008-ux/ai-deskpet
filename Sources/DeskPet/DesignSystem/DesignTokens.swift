import SwiftUI

// P5.1 — 间距 / 圆角 / 字体 / 动效 Tokens。集中所有 magic numbers，保证全局一致。
// P17 — spacing/radius re-valued onto the 4pt grid; DSFont now references SwiftUI text
// styles so Dynamic Type applies automatically. Old key names preserved as aliases so the
// ~100 existing call sites compile unchanged; new code uses the role names.

enum DSSpacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

enum DSRadius {
    /// 6 — buttons, nav items, icon chips.
    static let control: CGFloat = 6
    /// Semantic alias of `control`.
    static let small: CGFloat = control
    /// 10 — text inputs, cards, metric chips, chat bubbles (unified — CI-01).
    static let input: CGFloat = 10
    /// Semantic alias of `input`.
    static let regular: CGFloat = input
    /// 8 — historical value kept for source-compatibility (alias of `regular` after P17).
    static let card: CGFloat = input
    /// 16 — floating chat panel, popovers, sheets, onboarding content blocks.
    static let panel: CGFloat = 16
    /// Semantic alias of `panel`.
    static let large: CGFloat = panel
    /// 999 — StatusPill, capsule chrome.
    static let capsule: CGFloat = 999
}

/// 字体层级。优先系统字体；数字用 rounded + monospacedDigit。
/// P17 — each role is now a SwiftUI text style (auto-scales with Dynamic Type); the legacy
/// `Font.system(size:)` constants remain as aliases so call sites compile unchanged.
enum DSFont {
    // MARK: Role names (preferred for new code)

    static var Title: Font { .title2.weight(.semibold) }
    static var SectionTitle: Font { .title3.weight(.semibold) }
    static var CardTitle: Font { .headline }
    static var Body: Font { .body }
    static var Metadata: Font { .callout }
    static var Caption: Font { .subheadline }
    static var Caption2: Font { .caption.weight(.medium) }

    // MARK: Legacy aliases (existing call sites keep compiling)

    static let pageTitle = Title
    static let sectionTitle = SectionTitle
    static let cardTitle = CardTitle
    static let body = Body
    static let secondaryBody = Metadata
    static let caption = Caption
    static let compactLabel = Caption2

    /// Numeric display (timer / count-down) — rounded + monospaced.
    static func numericDisplay(_ size: CGFloat = 56) -> Font {
        .system(size: size, weight: .semibold, design: .rounded).monospacedDigit()
    }
}

/// 动效 Tokens。所有动画从这里取；Reduce Motion 时位移动画退化为淡入淡出或无动画。
enum DSMotion {
    static let quick: Double = 0.12          // hover / pressed
    static let standard: Double = 0.20       // 普通内容过渡
    static let emphasized: Double = 0.28     // 窗口形态切换
    static let content: Double = 0.22        // 对话气泡 / 卡片
    static let completion: Double = 0.45      // 完成反馈

    /// 标准内容动画；Reduce Motion 时改为短淡入淡出（无 spring、无位移语义）。
    static func content(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.12) : .easeOut(duration: content)
    }
    /// 强调（带克制 spring）；Reduce Motion 时退化为 easeInOut。
    static func emphasized(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.14) : .spring(response: 0.34, dampingFraction: 0.86)
    }
    static func quick(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeInOut(duration: 0.08) : .easeOut(duration: quick)
    }
}

/// Companion Console window metrics. These are for the normal macOS console only;
/// the desktop pet overlay is sized separately by PetOverlayWindowMetrics.
enum CompanionConsoleWindowMetrics {
    static let defaultWidth: CGFloat = 560
    static let defaultHeight: CGFloat = 640
    static let minWidth: CGFloat = 520
    static let minHeight: CGFloat = 560
    static let sidebarWidth: CGFloat = 148
    static let contentMinWidth: CGFloat = 348

    static var defaultSize: CGSize { CGSize(width: defaultWidth, height: defaultHeight) }
    static var minimumSize: CGSize { CGSize(width: minWidth, height: minHeight) }

    static func clamped(_ size: CGSize) -> CGSize {
        CGSize(width: max(size.width, minWidth), height: max(size.height, minHeight))
    }

    static func contentSize(for mode: WindowMode) -> CGSize {
        clamped(mode.size)
    }
}

/// 当前窗口形态。
enum WindowMode: String, CaseIterable, Codable, Sendable {
    case mini, compact, expanded

    var size: CGSize {
        switch self {
        case .mini: return CompanionConsoleWindowMetrics.minimumSize
        case .compact: return CompanionConsoleWindowMetrics.defaultSize
        case .expanded: return CGSize(width: 720, height: 720)
        }
    }
    var minSize: CGSize {
        CompanionConsoleWindowMetrics.minimumSize
    }
    var label: String {
        switch self {
        case .mini: return "紧凑"
        case .compact: return "标准"
        case .expanded: return "宽屏"
        }
    }
    var symbol: String {
        switch self {
        case .mini: return "rectangle.compress.vertical"
        case .compact: return "rectangle"
        case .expanded: return "rectangle.expand.vertical"
        }
    }
}

/// Floating chat panel metrics. P17 — expanded view gains a min/max clamp so the user can
/// resize the panel without losing the production geometry. All other chrome stays fixed.
enum FloatingChatPanelMetrics {
    static let capsuleSize = CGSize(width: 260, height: 46)
    static let taskHUDSize = CGSize(width: 320, height: 88)
    static let expandedMinSize = CGSize(width: 380, height: 460)
    static let expandedIdealSize = CGSize(width: 420, height: 520)
    static let expandedMaxSize = CGSize(width: 560, height: 680)
}
