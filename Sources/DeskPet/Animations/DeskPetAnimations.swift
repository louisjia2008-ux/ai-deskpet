import SwiftUI

// P20 — 桌宠动画扩展库。所有 modifier 都遵循：
//   * 接入 DSMotion / DSColor token（不引硬编码）
//   * Reduce Motion 时退化为最短淡入淡出（保留可读性，不留位移语义）
//   * 纯 SwiftUI；不依赖 SpriteKit / Metal
//
// 范围：
//   * 气泡进场 spring（#1）
//   * 字符级打字机（#2）
//   * 气泡 idle 呼吸（#3）
//   * 任务完成 confetti（#5）
//   * 输入框草稿 pulse（#8）
//   * 滑动重试（#10）
//
// 配套：
//   * 胶囊↔展开 hero 在 `FloatingChat` 内的 `matchedGeometryEffect` 用例
//   * Tab indicator 滑动在 `AppShellView` 内
//   * 菜单栏 hover 在 `MenuBar/AnimatedMenuBarController.swift`
//   * 专注模式屏幕光晕在 `Focus/FocusHaloOverlay.swift`

// MARK: - #1 气泡进场 spring

/// 气泡 / 卡片进场：opacity + 12pt 上移 + 0.96→1.0 微缩放。
/// 走 DSMotion.emphasized（有 spring），Reduce Motion 时退化为纯淡入。
struct BubbleRevealModifier: ViewModifier {
    let isVisible: Bool
    let reduceMotion: Bool

    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .offset(y: isVisible ? 0 : 12)
            .scaleEffect(isVisible ? 1.0 : 0.96, anchor: .bottom)
            .animation(
                reduceMotion
                    ? .easeInOut(duration: 0.12)
                    : .spring(response: 0.34, dampingFraction: 0.86),
                value: isVisible
            )
    }
}

extension View {
    /// 进场动画（#1）。Reduce Motion 时退化为短淡入。
    func bubbleReveal(isVisible: Bool = true, reduceMotion: Bool = false) -> some View {
        modifier(BubbleRevealModifier(isVisible: isVisible, reduceMotion: reduceMotion))
    }
}

// MARK: - #2 字符级打字机

/// 把一段文字按 0.018s/字符 reveal（中文按字符切；ASCII 按字符切）。
/// 用于 assistant streaming 期间；`isRevealing` 关闭时立刻显示完整文本。
/// 每次 `text` 变化时自动重置进度（无需外部状态管理）。
struct TypewriterText: View {
    let text: String
    let charInterval: TimeInterval
    let isRevealing: Bool
    let reduceMotion: Bool

    @State private var displayedCount: Int = 0
    @State private var animationTask: Task<Void, Never>?

    init(_ text: String,
         isRevealing: Bool,
         charInterval: TimeInterval = 0.018,
         reduceMotion: Bool = false) {
        self.text = text
        self.isRevealing = isRevealing
        self.charInterval = charInterval
        self.reduceMotion = reduceMotion
    }

    var body: some View {
        // Reduce Motion 时直接显示完整文本。
        let displayText: String = reduceMotion || !isRevealing
            ? text
            : String(text.prefix(displayedCount))
        Text(displayText)
            .onAppear { reset() }
            .onChange(of: text) { _, _ in reset() }
            .onChange(of: isRevealing) { _, newValue in
                if newValue { start() } else { animationTask?.cancel(); displayedCount = text.count }
            }
            .onDisappear { animationTask?.cancel() }
    }

    private func reset() {
        animationTask?.cancel()
        if reduceMotion || !isRevealing {
            displayedCount = text.count
            return
        }
        displayedCount = 0
        start()
    }

    private func start() {
        animationTask?.cancel()
        guard !reduceMotion, isRevealing else {
            displayedCount = text.count
            return
        }
        animationTask = Task { @MainActor in
            while displayedCount < text.count {
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: UInt64(charInterval * 1_000_000_000))
                if Task.isCancelled { return }
                displayedCount += 1
            }
        }
    }
}

// MARK: - #3 气泡 idle 呼吸

/// assistant pending 期间的 1.0 → 1.02 → 1.0 缩放循环（1.6s/周期）。
/// Reduce Motion 时整段无效果。挂载到 view 上即可。
struct IdleBreathingModifier: ViewModifier {
    let isActive: Bool
    let reduceMotion: Bool
    @State private var phase: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .scaleEffect(isActive && !reduceMotion ? 1.0 + 0.02 * phase : 1.0,
                        anchor: .bottomLeading)
            .onAppear { tickIfNeeded() }
            .onChange(of: isActive) { _, newValue in
                if newValue { tickIfNeeded() } else { phase = 0 }
            }
    }

    private func tickIfNeeded() {
        guard isActive, !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            phase = 1
        }
    }
}

extension View {
    /// 气泡 pending 时呼吸（#3）。
    func idleBreathing(isActive: Bool, reduceMotion: Bool = false) -> some View {
        modifier(IdleBreathingModifier(isActive: isActive, reduceMotion: reduceMotion))
    }
}

// MARK: - #5 任务完成 confetti

/// 8 个粒子从中心向四周飞散（带重力 + 旋转 + 衰减）。Reduce Motion 时立刻隐藏。
/// 触发动画靠外层 `isActive`；完成后粒子停在屏幕外（不影响 hit-test）。
///
/// P22 — the body is wrapped in a `TimelineView(.animation)` so the particle
/// positions are recomputed every frame. Without the timeline the SwiftUI
/// body would only re-evaluate when `@State` changes, and `Date().timeIntervalSince`
/// would freeze the particles at their start frame.
struct ConfettiBurst: View {
    let isActive: Bool
    let particleCount: Int
    let tint: Color
    let reduceMotion: Bool

    @State private var particles: [Particle] = []
    @State private var startTime: Date?

    init(isActive: Bool,
         particleCount: Int = 14,
         tint: Color = DSColor.emotionAccent,
         reduceMotion: Bool = false) {
        self.isActive = isActive
        self.particleCount = particleCount
        self.tint = tint
        self.reduceMotion = reduceMotion
    }

    struct Particle: Identifiable {
        let id = UUID()
        let angle: Angle
        let distance: CGFloat
        let rotation: Double
        let delay: Double
        let size: CGFloat
    }

    var body: some View {
        ZStack {
            if isActive && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: false)) { context in
                    // Each frame recompute every particle from the start time.
                    let now = context.date
                    ForEach(particles) { p in
                        ConfettiShape()
                            .fill(tint)
                            .frame(width: p.size, height: p.size * 0.5)
                            .rotationEffect(.degrees(p.rotation * progress(for: p, at: now)))
                            .offset(
                                x: cos(p.angle.radians) * p.distance * progress(for: p, at: now),
                                y: sin(p.angle.radians) * p.distance * progress(for: p, at: now)
                                    + gravityDrop(for: p, at: now)
                            )
                            .opacity(1.0 - progress(for: p, at: now) * 0.9)
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .onAppear { seedIfNeeded() }
        .onChange(of: isActive) { _, _ in seedIfNeeded() }
    }

    private func progress(for p: Particle, at now: Date) -> CGFloat {
        guard let start = startTime else { return 0 }
        let elapsed = now.timeIntervalSince(start) - p.delay
        let total: TimeInterval = 0.9
        return CGFloat(max(0, min(1, elapsed / total)))
    }

    private func gravityDrop(for p: Particle, at now: Date) -> CGFloat {
        let t = progress(for: p, at: now)
        return 30 * t * t
    }

    private func seedIfNeeded() {
        guard isActive else { return }
        if particles.isEmpty {
            particles = (0..<particleCount).map { _ in
                Particle(angle: .degrees(Double.random(in: 0..<360)),
                         distance: CGFloat.random(in: 60...120),
                         rotation: Double.random(in: -540...540),
                         delay: Double.random(in: 0..<0.12),
                         size: CGFloat.random(in: 6...10))
            }
        }
        startTime = Date()
        // 清空让下次 burst 重新生成
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if !isActive { particles.removeAll() }
        }
    }
}

private struct ConfettiShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.addRoundedRect(in: rect, cornerSize: .init(width: 1, height: 1))
        return p
    }
}

// MARK: - #8 输入框草稿 pulse

/// 用户正在输入时输入框边框轻微脉动（border opacity 0.4 → 0.9 → 0.4，1.2s 循环）。
/// Reduce Motion 时退化为静态 border。
struct DraftingPulseModifier: ViewModifier {
    let isDrafting: Bool
    let tint: Color
    let reduceMotion: Bool
    @State private var phase: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .overlay(
                RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                    .strokeBorder(tint.opacity(0.4 + 0.5 * phase), lineWidth: 1.5)
                    .opacity(isDrafting && !reduceMotion ? 1 : 0)
            )
            .onChange(of: isDrafting) { _, newValue in
                if newValue {
                    withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                        phase = 1
                    }
                } else {
                    phase = 0
                }
            }
    }
}

extension View {
    /// 输入框草稿 pulse（#8）。
    func draftingPulse(isActive: Bool, tint: Color = DSColor.primaryAccent,
                       reduceMotion: Bool = false) -> some View {
        modifier(DraftingPulseModifier(isDrafting: isActive, tint: tint, reduceMotion: reduceMotion))
    }
}

// MARK: - #10 滑动重试

/// failed 气泡左滑 ≥ 60pt 触发 onRetry。松手回弹。
/// 触觉不在 SwiftUI 内（NSHapticFeedbackPerformer 由 caller 决定是否接入）。
struct SwipeToRetryModifier: ViewModifier {
    let isEnabled: Bool
    let onRetry: () -> Void
    @State private var dragOffset: CGFloat = 0
    @State private var isSwiping = false

    private let triggerDistance: CGFloat = 60
    private let maxDistance: CGFloat = 110

    func body(content: Content) -> some View {
        content
            .offset(x: isEnabled ? dragOffset : 0)
            .gesture(
                DragGesture(minimumDistance: 10)
                    .onChanged { value in
                        guard isEnabled else { return }
                        // 只接受左滑（横向负向）；屏蔽误触的纵向手势
                        if abs(value.translation.height) > abs(value.translation.width) {
                            return
                        }
                        let dx = value.translation.width
                        if dx < 0 {
                            isSwiping = true
                            dragOffset = max(-maxDistance, dx)
                        }
                    }
                    .onEnded { value in
                        guard isEnabled else { return }
                        isSwiping = false
                        if value.translation.width < -triggerDistance {
                            withAnimation(DSMotion.emphasized(false)) {
                                dragOffset = 0
                            }
                            onRetry()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                dragOffset = 0
                            }
                        }
                    }
            )
            .overlay(alignment: .trailing) {
                if isSwiping && dragOffset < -10 {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.counterclockwise")
                        Text("重试").font(DSFont.Caption)
                    }
                    .foregroundStyle(DSColor.primaryAccent)
                    .padding(.trailing, DSSpacing.s)
                    .opacity(min(1, -dragOffset / triggerDistance))
                    .allowsHitTesting(false)
                }
            }
    }
}

extension View {
    /// failed 气泡左滑触发重试（#10）。
    func swipeToRetry(isEnabled: Bool, onRetry: @escaping () -> Void) -> some View {
        modifier(SwipeToRetryModifier(isEnabled: isEnabled, onRetry: onRetry))
    }
}
