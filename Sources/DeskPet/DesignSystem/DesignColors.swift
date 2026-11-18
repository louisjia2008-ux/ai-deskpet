import SwiftUI
import AppKit

// P5.1 — DeskPet 轻量设计系统：颜色 Tokens。冷蓝 / 淡青 / 柔白为主，少量暖粉作为情绪强调。
// 取色逻辑是纯函数（`DSPalette.rgba`），可单元测试；SwiftUI 用 `DSColor` 动态色（自动随
// Light/Dark 切换）。Reduce Transparency / Increase Contrast 经组件层把不透明度抬高或加深，
// 不依赖单一外观，也不只用颜色表达状态。

/// 可测试的 RGBA 值（0...1）。
struct RGBA: Equatable, Sendable {
    var r: Double, g: Double, b: Double, a: Double
    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = r; self.g = g; self.b = b; self.a = a
    }
}

/// 语义颜色 token。
enum DSColorToken: CaseIterable {
    case appBackground
    case elevatedSurface
    case glassSurface
    case primaryAccent      // 冰蓝
    case secondaryAccent    // 淡青
    case emotionAccent      // 暖粉（情绪/关系强调）
    case success
    case warning
    case destructive
    case textPrimary
    case textSecondary
    case textTertiary
    case border
    case focusRing
}

/// 纯取色逻辑——按外观与是否增强对比返回 RGBA。无副作用、可测试。
enum DSPalette {
    /// Reduce Transparency 时把半透明叠加抬高多少 alpha（退化为近实色）。
    static let reduceTransparencyAlphaBoost: Double = 0.38

    static func rgba(_ token: DSColorToken, scheme: ColorScheme, increaseContrast: Bool = false) -> RGBA {
        let base = light(token, dark: scheme == .dark)
        return increaseContrast ? contrastBoosted(token, base, dark: scheme == .dark) : base
    }

    /// 完整解析（含 Reduce Transparency 退化）。`DSColor.token` 与测试都走这条路径，保证一致。
    static func resolved(_ token: DSColorToken, scheme: ColorScheme,
                         increaseContrast: Bool = false, reduceTransparency: Bool = false) -> RGBA {
        var c = rgba(token, scheme: scheme, increaseContrast: increaseContrast)
        if reduceTransparency, c.a < 1 { c.a = min(1, c.a + reduceTransparencyAlphaBoost) }
        return c
    }

    // MARK: 基础取色

    private static func light(_ token: DSColorToken, dark: Bool) -> RGBA {
        switch token {
        case .appBackground:
            // 浅色：柔白偏冷；深色：冷色调（非纯黑）。
            return dark ? RGBA(0.10, 0.11, 0.13) : RGBA(0.965, 0.970, 0.978)
        case .elevatedSurface:
            return dark ? RGBA(0.145, 0.155, 0.18) : RGBA(0.995, 0.997, 1.00)
        case .glassSurface:
            // 玻璃叠加色（半透明）；Reduce Transparency 时由组件抬高 alpha。
            return dark ? RGBA(0.18, 0.19, 0.22, 0.70) : RGBA(1.00, 1.00, 1.00, 0.78)
        case .primaryAccent:
            return dark ? RGBA(0.50, 0.72, 0.95) : RGBA(0.20, 0.48, 0.82)   // macOS blue
        case .secondaryAccent:
            return dark ? RGBA(0.48, 0.76, 0.78) : RGBA(0.25, 0.62, 0.66)   // 淡青
        case .emotionAccent:
            return dark ? RGBA(0.96, 0.62, 0.74) : RGBA(0.93, 0.49, 0.64)   // 暖粉
        case .success:
            return dark ? RGBA(0.42, 0.80, 0.55) : RGBA(0.24, 0.66, 0.42)
        case .warning:
            return dark ? RGBA(0.95, 0.74, 0.36) : RGBA(0.86, 0.60, 0.16)
        case .destructive:
            return dark ? RGBA(0.96, 0.52, 0.50) : RGBA(0.84, 0.31, 0.30)
        case .textPrimary:
            return dark ? RGBA(0.95, 0.96, 0.98) : RGBA(0.11, 0.13, 0.18)
        case .textSecondary:
            return dark ? RGBA(0.70, 0.73, 0.78) : RGBA(0.34, 0.37, 0.43)
        case .textTertiary:
            return dark ? RGBA(0.52, 0.55, 0.60) : RGBA(0.56, 0.59, 0.64)
        case .border:
            return dark ? RGBA(1, 1, 1, 0.12) : RGBA(0.10, 0.14, 0.20, 0.12)
        case .focusRing:
            return dark ? RGBA(0.46, 0.72, 0.98, 0.90) : RGBA(0.26, 0.56, 0.92, 0.85)
        }
    }

    // MARK: Increase Contrast——文字加深、边框/焦点更实，背景更纯净。

    private static func contrastBoosted(_ token: DSColorToken, _ base: RGBA, dark: Bool) -> RGBA {
        switch token {
        case .textPrimary:
            return dark ? RGBA(1, 1, 1) : RGBA(0, 0, 0)
        case .textSecondary:
            return dark ? RGBA(0.86, 0.88, 0.92) : RGBA(0.22, 0.25, 0.30)
        case .textTertiary:
            return dark ? RGBA(0.70, 0.73, 0.78) : RGBA(0.34, 0.37, 0.42)
        case .border:
            return dark ? RGBA(1, 1, 1, 0.28) : RGBA(0.10, 0.14, 0.22, 0.30)
        case .focusRing:
            return dark ? RGBA(0.60, 0.80, 1.0, 1.0) : RGBA(0.14, 0.40, 0.82, 1.0)
        default:
            return base
        }
    }
}

/// SwiftUI 动态颜色入口。自动随系统外观切换；Reduce Transparency 时把玻璃/表面 alpha 抬高。
enum DSColor {
    static func token(_ token: DSColorToken, increaseContrast: Bool = false,
                      reduceTransparency: Bool = false) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight]) == .darkAqua
            let rgba = DSPalette.resolved(token, scheme: dark ? .dark : .light,
                                          increaseContrast: increaseContrast, reduceTransparency: reduceTransparency)
            return NSColor(srgbRed: rgba.r, green: rgba.g, blue: rgba.b, alpha: rgba.a)
        })
    }

    /// R3-01 — explicit-scheme variant. `Color(nsColor: NSColor(name:dynamicProvider:))`
    /// resolves the closure against the **drawing context's** effective appearance. In a
    /// window-less `NSHostingView` whose root contains `GeometryReader` → `LazyVStack` →
    /// nested `MessageBubble`s, the drawing-context appearance does NOT propagate
    /// reliably to the bubble fill — the user-bubble ended up rendering light-scheme
    /// `primaryAccent` while the surrounding material darkened (see R3-01 reviewer
    /// evidence: 30.1% bit-identical, 9,284 px light-accent fill in the dark capture).
    ///
    /// Components that explicitly read `\.colorScheme` from the SwiftUI environment and
    /// route their fills through this overload bypass the NSAppearance chain entirely:
    /// the SwiftUI env value is whatever the host set (production: `NSApp.effectiveAppearance`;
    /// harness: `.environment(\.colorScheme, …)`), so a single source of truth resolves
    /// the token. Visually identical to the NSAppearance path for every legitimately
    /// converted surface — both funnel through `DSPalette.resolved`.
    static func token(_ token: DSColorToken, scheme: ColorScheme,
                      increaseContrast: Bool = false,
                      reduceTransparency: Bool = false) -> Color {
        let rgba = DSPalette.resolved(token, scheme: scheme,
                                      increaseContrast: increaseContrast,
                                      reduceTransparency: reduceTransparency)
        return Color(.sRGB, red: rgba.r, green: rgba.g, blue: rgba.b, opacity: rgba.a)
    }

    static var appBackground: Color { token(.appBackground) }
    static var elevatedSurface: Color { token(.elevatedSurface) }
    static var primaryAccent: Color { token(.primaryAccent) }
    static var secondaryAccent: Color { token(.secondaryAccent) }
    static var emotionAccent: Color { token(.emotionAccent) }
    static var success: Color { token(.success) }
    static var warning: Color { token(.warning) }
    static var destructive: Color { token(.destructive) }
    static var textPrimary: Color { token(.textPrimary) }
    static var textSecondary: Color { token(.textSecondary) }
    static var textTertiary: Color { token(.textTertiary) }
    static var border: Color { token(.border) }
    static var focusRing: Color { token(.focusRing) }
}
