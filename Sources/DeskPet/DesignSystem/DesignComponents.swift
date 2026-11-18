import SwiftUI

// P5.1 — 可复用组件。职责清晰、原生、克制。所有交互控件含 hover / pressed / disabled / 焦点环 /
// accessibility label；状态不只用颜色表达（配合符号或文字）。玻璃材质在 Reduce Transparency 时
// 退化为近实色表面。组件层不依赖 Runtime。

// MARK: 表面容器

/// 稳定的内容表面（不透明，适合长文本 / 列表 / 表单内容）。
/// P21 — gains a faint accent glaze + 1-pt specular edge highlight so the
/// container reads as a polished, slightly-translucent surface even when
/// Reduce Transparency is on (the underlying fill is still opaque).
struct CardContainer<Content: View>: View {
    var padding: CGFloat = DSSpacing.m
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .background(DSColor.elevatedSurface, in: RoundedRectangle(cornerRadius: DSRadius.card, style: .continuous))
            .overlay(LiquidGlassTintOverlay(tint: DSColor.primaryAccent, opacity: 0.03))
            .overlay(LiquidGlassEdgeHighlight(cornerRadius: DSRadius.card))
            .overlay(
                RoundedRectangle(cornerRadius: DSRadius.card, style: .continuous)
                    .strokeBorder(DSColor.border, lineWidth: 1))
    }
}

/// 玻璃容器（窗口主壳 / 顶部导航 / 浮动胶囊）。Reduce Transparency 时退化为近实色 elevated surface。
struct AppGlassContainer<Content: View>: View {
    var cornerRadius: CGFloat = DSRadius.panel
    var padding: CGFloat = DSSpacing.l
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(padding)
            .background {
                if reduceTransparency {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(DSColor.token(.elevatedSurface))
                } else {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(.ultraThinMaterial)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(DSColor.border, lineWidth: 1))
    }
}

/// Standard detail-page layout for the companion console. It keeps every page on the same readable width,
/// without forcing cards to stretch into dense debug dashboards.
struct ControlPanelPageLayout<Content: View>: View {
    var maxWidth: CGFloat = 620
    var spacing: CGFloat = DSSpacing.l
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content
        }
        .frame(maxWidth: maxWidth, alignment: .leading)
        // P17 / VH-01 — center the constrained column in wide windows so we don't leave
        // a 330pt dead gutter on the right in expanded mode. Narrow widths keep the
        // top-leading alignment because centering would feel wrong when content fills the
        // available space.
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// Quiet section band for related controls. This replaces many visually heavy nested cards.
struct DashboardSection<Content: View>: View {
    let title: String
    var subtitle: String?
    var padding: CGFloat = DSSpacing.m
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            SectionHeader(title, subtitle: subtitle)
            content
        }
        .padding(padding)
        // P22 — every DashboardSection gets a faint glass tint + 1-pt
        // specular edge so settings rows read as glass cards. Existing
        // accent fills still drive active states; the glass is the
        // surface treatment underneath.
        .background(DSColor.elevatedSurface, in: RoundedRectangle(cornerRadius: DSRadius.card, style: .continuous))
        .overlay(LiquidGlassTintOverlay(tint: DSColor.primaryAccent, opacity: 0.03))
        .overlay(LiquidGlassEdgeHighlight(cornerRadius: DSRadius.card))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.card, style: .continuous)
                .strokeBorder(DSColor.border, lineWidth: 1))
    }
}

struct SettingsRow<Trailing: View>: View {
    let title: String
    var subtitle: String?
    var symbol: String?
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(alignment: .center, spacing: DSSpacing.m) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 20)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(DSFont.body).foregroundStyle(DSColor.textPrimary)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: DSSpacing.s)
            trailing
        }
        .padding(.vertical, DSSpacing.xs)
    }
}

extension SettingsRow where Trailing == EmptyView {
    init(_ title: String, subtitle: String? = nil, symbol: String? = nil) {
        self.init(title: title, subtitle: subtitle, symbol: symbol) { EmptyView() }
    }
}

struct ActionMenuButton<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content
    var body: some View {
        Menu {
            content
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 14, weight: .medium))
                .frame(width: 28, height: 28)
        }
        .menuStyle(.borderlessButton)
        .help(label)
        .accessibilityLabel(label)
    }
}

// MARK: 标题 / 标签

struct SectionHeader<Accessory: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var accessory: Accessory
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(DSFont.sectionTitle).foregroundStyle(DSColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle {
                    Text(subtitle).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
            }
            .layoutPriority(1)
            Spacer()
            accessory
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

extension SectionHeader where Accessory == EmptyView {
    init(_ title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

/// 状态胶囊：符号 + 文字 + 色调。不只用颜色表达（始终带文字/符号）。
struct StatusPill: View {
    let text: String
    var symbol: String?
    var tint: Color = DSColor.secondaryAccent
    var body: some View {
        HStack(spacing: DSSpacing.xs) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .semibold)) }
            Text(text).font(DSFont.compactLabel)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, DSSpacing.s)
        .padding(.vertical, 3)
        .foregroundStyle(tint)
        // P21 — glassy capsule: subtle accent glaze + 1-pt specular edge so
        // the pill reads as a small refractive chip on light/dark surfaces.
        .background(tint.opacity(0.14), in: Capsule())
        .overlay(LiquidGlassTintOverlay(tint: tint, opacity: 0.06))
        .overlay(LiquidGlassEdgeHighlight(cornerRadius: 999))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

/// 指标 chip：标签 + 数值。
struct MetricChip: View {
    let label: String
    let value: String
    var symbol: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: DSSpacing.xs) {
                if let symbol { Image(systemName: symbol).font(.system(size: 10)).foregroundStyle(DSColor.textTertiary) }
                Text(label).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
            }
            Text(value).font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                .lineLimit(2)
                .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(DSSpacing.s)
        .background(DSColor.appBackground, in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous).strokeBorder(DSColor.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(value)")
    }
}

// MARK: Chat bubble — single source of truth (P17 / CI-01)

/// Shared chat bubble. Used by CompanionChatView + ChatExpandedView so the user sees one
/// visual language across main and floating chats. Role (user/assistant), status footer
/// (pending/failed/cancelled/interrupted/completed with retry/regenerate), radius regular,
/// bubble fill user = primaryAccent / assistant = elevatedSurface / failed = destructive tint,
/// max text width ≈ 65% column (CX-05).
struct MessageBubble: View {
    enum Role { case user, assistant }
    enum Status { case pending, completed, failed, cancelled, interrupted }

    let role: Role
    let text: String
    let status: Status
    var onRetry: (() -> Void)?
    var onRegenerate: (() -> Void)?
    var onOpenAISettings: (() -> Void)?
    var transientStatusText: String?

    /// 0...1 — fraction of the available column width used as the bubble's max width.
    /// Defaults to a role-aware pair via `effectiveWidthFraction`: assistant bubbles
    /// take ~88% of the column so long Chinese prose no longer wastes 35% of the
    /// panel width; user bubbles stay at ~68% so they read as right-aligned cards
    /// rather than wide bars.
    var widthFraction: CGFloat = 0.88
    /// Optional override for the assistant bubble width fraction. `widthFraction`
    /// above is still the default; this lets `MessageBubble(role: .assistant, ...)`
    /// declarations that want to opt into the narrower 0.68 size do so explicitly.
    var userWidthFraction: CGFloat = 0.68

    // R3-01 — the user-bubble fill must be resolved from the explicit SwiftUI colorScheme,
    // not from NSAppearance-derived `DSColor.primaryAccent`. In a window-less NSHostingView
    // (e.g. the P17ProductSurfaceHarness's floatingChatExpanded capture) the dynamic
    // `NSColor(name:dynamicProvider:)` closure did not re-resolve against the host's
    // appearance for the user-bubble's draw pass, producing a light-scheme accent fill
    // inside an otherwise-dark surface (see R3-01 reviewer evidence: 30.1% bit-identical,
    // 9,284 px light-accent fill in the dark capture). Reading `\.colorScheme` directly
    // bypasses the broken NSAppearance chain and is what every other working surface
    // effectively does (their tokens fall on a code path that DOES reach SwiftUI's env).
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // P20 / #2 — typewriter reveal flag. When true, bubble text reveals
    // character-by-character. The flag is set by CompanionChatView for
    // assistant messages that are still streaming.
    var isRevealing: Bool = false

    /// P19.1 / P1 — role-aware width fraction. Assistant bubbles widen to use
    /// the available column; user bubbles stay narrower so they read as
    /// right-aligned cards. The single `widthFraction` field above still acts
    /// as the assistant default so call sites that pass an explicit value
    /// (e.g. tests pinning the layout) keep working unchanged.
    private var effectiveWidthFraction: CGFloat {
        switch role {
        case .assistant: return widthFraction
        case .user: return userWidthFraction
        }
    }

    /// P19.1 / P1 — read-friendly absolute bounds. We always:
    ///  * ensure a sensible minimum so a "hi" reply still looks like a bubble
    ///    (not a thin sliver glued to the left edge);
    ///  * cap the upper bound on narrow desktop placements where the panel can
    ///    be as small as ~340pt and 88% × 340 = ~300pt is the readable max;
    ///  * leave headroom on wide placements so the bubble does not stretch
    ///    into an unreadable full-column ribbon.
    private func bubbleMaxWidth(for columnWidth: CGFloat) -> CGFloat {
        // P17 / R1-04 — the bubble max width must remain `columnWidth * widthFraction`,
        // not raw points. P19.1 / P1 layers role-aware + readable-cap on top of
        // that base multiplier without changing the underlying contract.
        let fraction = effectiveWidthFraction
        let proportional = max(40, columnWidth * fraction)
        let maxReadable: CGFloat = 560
        return min(maxReadable, proportional)
    }

    var body: some View {
        // P17 / R1-04 — `frame(maxWidth:)` takes POINTS, not a fraction. We resolve
        // the column width with `containerRelativeFrame(.horizontal)` (macOS 13+)
        // so the bubble spans `widthFraction × columnWidth` without needing a top-level
        // GeometryReader.
        //
        // P19.1 / P1 — role-aware + available-space-aware (see `effectiveWidthFraction`
        // and `bubbleMaxWidth(for:)`). The previous uniform 0.65 default left ~35% of the
        // panel width empty on long Chinese replies. The new layout fills that space
        // without making the bubble feel like a full-column ribbon: short messages stay
        // short, long prose fills more of the column, and a hard cap at 560pt keeps
        // line length readable on wide desktops.
        //
        // P19.5 / R-CHAT-OVERFLOW — the previous version wrapped the bubble body in a
        // top-level `GeometryReader { ... }`. Inside a `LazyVStack` inside a `ScrollView`
        // the GeometryReader was given an unbounded vertical proposal (the scroll content
        // must be free to be tall), and on macOS it reported `(_, .infinity)` back to
        // the LazyVStack. The LazyVStack then stacked every `MessageBubble` at the
        // same y-coordinate (top of scroll content), producing the visible defect:
        // 8 messages crammed into the top ~240pt of the 420×520 panel with the long
        // reply's text overlapping subsequent user/assistant messages and ~210pt of
        // empty scroll area below. The P19.5 attempt with
        // `.fixedSize(horizontal: false, vertical: true)` on the GeometryReader did
        // NOT fix the bug (verified by isolated render harness — bubble frames still
        // overlap visually). The robust fix is to drop the GeometryReader entirely:
        // the bubble's intrinsic content height flows back to the LazyVStack as a
        // normal non-flexible value, and the column width is resolved at layout time
        // via the `chatColumnWidth` environment key set by the production message area.
        // See `review/p19_5_chat_responsive_20260903_143800/01_root_cause/P19_5_CHAT_OVERFLOW_ROOT_CAUSE.md`.
        HStack(alignment: .bottom, spacing: DSSpacing.s) {
            if role == .user { Spacer(minLength: DSSpacing.s) }
            VStack(alignment: role == .user ? .trailing : .leading, spacing: 4) {
                bubbleText
                if role == .assistant { footer }
            }
            .frame(maxWidth: bubbleMaxWidth(for: containerWidth),
                   alignment: role == .user ? .trailing : .leading)
            if role == .assistant { Spacer(minLength: DSSpacing.s) }
        }
    }

    /// P19.5 — column width resolver. Reads from the chat column environment key set
    /// by the production message area (ChatExpandedView.messageArea + CompanionChatView).
    /// When no container is set, falls back to the readable cap (560pt) so isolated
    /// previews and tests render the bubble at its maximum reasonable width.
    @Environment(\.chatColumnWidth) private var containerWidth

    @ViewBuilder
    private var bubbleText: some View {
        let displayed = visibleText
        // P20 / #2 — assistant pending bubbles use the typewriter reveal; user
        // bubbles + completed/terminal bubbles show text immediately. The
        // TypewriterText view collapses to plain Text when `isRevealing == false`
        // or when Reduce Motion is set.
        Group {
            if role == .assistant && isRevealing {
                TypewriterText(displayed,
                               isRevealing: true,
                               charInterval: 0.018,
                               reduceMotion: reduceMotion)
            } else {
                Text(displayed)
            }
        }
        .font(DSFont.Body)
        .foregroundStyle(role == .user ? .white : DSColor.token(.textPrimary, scheme: colorScheme))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, DSSpacing.m)
        .padding(.vertical, DSSpacing.s)
        .background(bubbleFill,
                    in: RoundedRectangle(cornerRadius: DSRadius.regular, style: .continuous))
        // P21 — assistant completed/pending bubbles get a soft accent glaze
        // and a 1-pt specular edge so they read as glass against the
        // light/dark surrounding surface. Failed/cancelled keep their flat
        // destructive tint for clarity.
        .overlay {
            if role == .assistant && status != .failed {
                LiquidGlassTintOverlay(tint: DSColor.primaryAccent, opacity: 0.05)
            }
        }
        .overlay(LiquidGlassEdgeHighlight(cornerRadius: DSRadius.regular))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.regular, style: .continuous)
                .strokeBorder(borderColor, lineWidth: 1))
        // P20 / #3 — assistant pending bubbles gently breathe to signal "thinking".
        .idleBreathing(isActive: role == .assistant && status == .pending,
                       reduceMotion: reduceMotion)
    }

    @ViewBuilder
    private var footer: some View {
        HStack(spacing: DSSpacing.xs) {
            switch status {
            case .pending:
                PendingIndicator(label: transientStatusText ?? "生成中")
            case .failed:
                Image(systemName: "xmark.octagon.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(DSColor.token(.destructive, scheme: colorScheme))
                    .accessibilityHidden(true)
                Text("发送失败")
                    .font(DSFont.Caption)
                    .foregroundStyle(DSColor.token(.destructive, scheme: colorScheme))
                if let onRetry {
                    Button("重试", action: onRetry)
                        .buttonStyle(.plain)
                        .font(DSFont.Caption)
                        .foregroundStyle(DSColor.token(.destructive, scheme: colorScheme))
                }
                if let onOpenAISettings {
                    Button("打开 AI 设置", action: onOpenAISettings)
                        .buttonStyle(.plain)
                        .font(DSFont.Caption)
                        .foregroundStyle(DSColor.token(.primaryAccent, scheme: colorScheme))
                }
            case .cancelled:
                Text("已停止").font(DSFont.Caption).foregroundStyle(DSColor.token(.textSecondary, scheme: colorScheme))
                if let onRetry {
                    Button("重试", action: onRetry)
                        .buttonStyle(.plain)
                        .font(DSFont.Caption)
                        .foregroundStyle(DSColor.token(.primaryAccent, scheme: colorScheme))
                }
            case .interrupted:
                Text("被中断").font(DSFont.Caption).foregroundStyle(DSColor.token(.textSecondary, scheme: colorScheme))
                if let onRetry {
                    Button("重试", action: onRetry)
                        .buttonStyle(.plain)
                        .font(DSFont.Caption)
                        .foregroundStyle(DSColor.token(.primaryAccent, scheme: colorScheme))
                }
            case .completed:
                if let onRegenerate {
                    Button("重新生成", action: onRegenerate)
                        .buttonStyle(.plain)
                        .font(DSFont.Caption)
                        .foregroundStyle(DSColor.token(.secondaryAccent, scheme: colorScheme))
                }
            }
        }
    }

    private var visibleText: String {
        if text.isEmpty && status == .pending { return "..." }
        return text
    }

    private var bubbleFill: Color {
        switch role {
        case .user:
            // R3-01 — explicit colorScheme path. See header comment for the R3-01 root cause.
            return DSColor.token(.primaryAccent, scheme: colorScheme)
        case .assistant:
            switch status {
            case .failed:
                return DSColor.token(.destructive, scheme: colorScheme).opacity(0.12)
            default:
                return DSColor.token(.elevatedSurface, scheme: colorScheme)
            }
        }
    }

    private var borderColor: Color {
        switch role {
        case .user: return .clear
        case .assistant:
            switch status {
            case .failed: return DSColor.token(.destructive, scheme: colorScheme).opacity(0.4)
            default: return DSColor.token(.border, scheme: colorScheme)
            }
        }
    }
}

// MARK: 按钮

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(DSFont.cardTitle)
            .lineLimit(1)
            .padding(.horizontal, DSSpacing.m)
            .padding(.vertical, DSSpacing.s)
            .frame(minHeight: 28)
            .foregroundStyle(.white)
            .background(
                DSColor.primaryAccent
                    .opacity(isEnabled ? (configuration.isPressed ? 0.78 : (hovering ? 0.92 : 1)) : 0.4),
                in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: DSMotion.quick), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(DSFont.cardTitle)
            .lineLimit(1)
            .padding(.horizontal, DSSpacing.m)
            .padding(.vertical, DSSpacing.s)
            .frame(minHeight: 28)
            .foregroundStyle(isEnabled ? DSColor.textPrimary : DSColor.textTertiary)
            .background(
                DSColor.token(.primaryAccent).opacity(hovering && isEnabled ? 0.12 : 0.07),
                in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous)
                    .strokeBorder(DSColor.border, lineWidth: 1))
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: DSMotion.quick), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

/// 纯图标按钮：必须有 accessibilityLabel + tooltip + 足够点击区域。
struct IconButton: View {
    let symbol: String
    let label: String          // accessibility + tooltip
    var tint: Color = DSColor.textSecondary
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(DSColor.token(.primaryAccent).opacity(hovering ? 0.12 : 0), in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}

// MARK: 空状态

struct EmptyStateView<Actions: View>: View {
    let symbol: String
    let title: String
    let message: String
    @ViewBuilder var actions: Actions
    var body: some View {
        VStack(spacing: DSSpacing.m) {
            Image(systemName: symbol)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(DSColor.secondaryAccent)
                .accessibilityHidden(true)
            VStack(spacing: DSSpacing.xs) {
                Text(title).font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                Text(message).font(DSFont.secondaryBody).foregroundStyle(DSColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            actions
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DSSpacing.xl)
        .accessibilityElement(children: .contain)
    }
}

// MARK: 进度

/// 分段进度（关系阶段 / 任意 step 进度）。无数字时仍能表达，配合 accessibilityValue。
struct SegmentedProgress: View {
    let filled: Int
    let total: Int
    var tint: Color = DSColor.emotionAccent
    var body: some View {
        HStack(spacing: DSSpacing.xs) {
            ForEach(0..<max(total, 1), id: \.self) { i in
                Capsule()
                    .fill(i < filled ? tint : DSColor.token(.textTertiary).opacity(0.25))
                    .frame(height: 7)
            }
        }
        .accessibilityElement()
        .accessibilityValue("\(filled) / \(total)")
    }
}

/// 连续进度条（今日进度 / 专注进度）。
struct DSProgressBar: View {
    let value: Double          // 0...1
    var tint: Color = DSColor.primaryAccent
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(DSColor.token(.textTertiary).opacity(0.18))
                Capsule().fill(tint)
                    .frame(width: max(0, min(1, value)) * geo.size.width)
            }
        }
        .frame(height: 7)
        .accessibilityElement()
        .accessibilityValue("\(Int((max(0, min(1, value))) * 100)) percent")
    }
}

// MARK: 行内提示

/// Pulsing three-dot indicator for in-flight work. Pairs with a status label
/// (e.g. "桌面正在思考…") and respects Reduce Motion by collapsing to a
/// static, opacity-tinted dot.
struct PendingIndicator: View {
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: Int = 0

    var body: some View {
        HStack(spacing: DSSpacing.xs) {
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(DSColor.secondaryAccent.opacity(reduceMotion ? 0.55 : dotOpacity(for: i)))
                        .frame(width: 5, height: 5)
                        .animation(reduceMotion ? nil :
                            .easeInOut(duration: 0.45).repeatForever(autoreverses: true).delay(Double(i) * 0.12),
                            value: phase)
                }
            }
            .accessibilityHidden(true)
            Text(label).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
        }
        .onAppear {
            if !reduceMotion { phase = 1 }
        }
    }

    private func dotOpacity(for index: Int) -> Double {
        // Phase 0 = nothing active; Phase 1 = pulse train begins.
        phase == 0 ? 0.45 : 1.0
    }
}

enum InlineNoticeKind {
    case info, warning, error
    var symbol: String {
        switch self {
        case .info: return "info.circle"
        case .warning: return "exclamationmark.triangle"
        case .error: return "xmark.octagon"
        }
    }
    var tint: Color {
        switch self {
        case .info: return DSColor.secondaryAccent
        case .warning: return DSColor.warning
        case .error: return DSColor.destructive
        }
    }
}

struct InlineNotice: View {
    let kind: InlineNoticeKind
    let text: String
    var actionTitle: String?
    var action: (() -> Void)?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
            Image(systemName: kind.symbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(kind.tint)
            Text(text).font(DSFont.secondaryBody).foregroundStyle(DSColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(DSSpacing.m)
        .background(kind.tint.opacity(0.10), in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous).strokeBorder(kind.tint.opacity(0.25), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}
