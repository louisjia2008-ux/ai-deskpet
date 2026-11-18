import AppKit
import SwiftUI
import PetAgentRuntime

// P17-A — onboarding view.
//
// Five-step first-run flow:
//   1. Welcome — product overview + CTA
//   2. AI Setup — provider status + "configure later" affordance
//   3. Permissions — explain, with optional open System Settings link
//   4. Safety — what approvals look like
//   5. Ready — completion + "open chat" hint
//
// Pure native macOS. Reuses DS design tokens (DSSpacing, DSFont, DSColor).
// Keyboard: ← / → navigate steps; Enter advances; Escape does nothing
// (window close is the dismissal action — we don't want Escape to silently
// skip onboarding).

struct OnboardingView: View {
    @ObservedObject var viewModel: OnboardingViewModel
    /// P17 / R1-13 + R2-08 — live hotkey status provider. Read from
    /// `HotKeys.floatingChatGlobalHotKeyResult` by the production host
    /// (`OnboardingWindowController`). It is a CLOSURE rather than a snapshot so the status
    /// stays live as the user walks to the "ready" step — the previous snapshot parameter was
    /// hardcoded to `nil` by every real caller, which made the whole feature inert (R2-08).
    /// A provider returning `nil` falls back to the static copy.
    var hotkeyStatusProvider: () -> GlobalHotKeyRegistrar.RegistrationResult? = { nil }
    let reasonsTitle: String
    let reasonsMessage: String
    let onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(DSColor.border)
            stepContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(DSColor.appBackground)
                .id(viewModel.currentStep) // P22 — cross-fade between steps
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            Divider().background(DSColor.border)
            footer
        }
        .background(DSColor.appBackground)
        .frame(minWidth: 600, minHeight: 520)
        // P22 — gentle entrance: opacity 0→1 + 8pt upward translate over
        // DSMotion.content, Reduce Motion collapses to a short fade.
        .bubbleReveal(reduceMotion: reduceMotion)
        .animation(DSMotion.content(reduceMotion), value: viewModel.currentStep)
        .onAppear {
            // Persist initial show timestamp so resume-from-step works.
            _ = try? viewModel.persistence.recordShown(stepIndex: viewModel.currentStep.index)
        }
        .modifier(OnboardingKeyboardShortcuts(
            onBack: viewModel.canGoBack ? { viewModel.goBack() } : nil,
            onNext: viewModel.isLastStep ? nil : { viewModel.goNext() }))
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .center, spacing: DSSpacing.m) {
                Image(systemName: viewModel.currentStep.symbol)
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(DSColor.primaryAccent)
                    .frame(width: 36, height: 36)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(reasonsTitle)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textTertiary)
                    Text(viewModel.currentStep.title)
                        .font(DSFont.pageTitle)
                        .foregroundStyle(DSColor.textPrimary)
                        .lineLimit(1)
                }
                Spacer()
                Text("\(viewModel.currentStep.index + 1) / \(OnboardingStep.allCases.count)")
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .accessibilityLabel("步骤 \(viewModel.currentStep.index + 1) 共 \(OnboardingStep.allCases.count)")
            }
            stepIndicator
        }
        .padding(.horizontal, DSSpacing.xl)
        .padding(.top, DSSpacing.l)
        .padding(.bottom, DSSpacing.m)
        // P22 — Liquid Glass header (sits above the page divider).
        .liquidGlass(style: .regular, cornerRadius: 0)
    }

    private var stepIndicator: some View {
        SegmentedProgress(filled: viewModel.currentStep.index + 1,
                          total: OnboardingStep.allCases.count,
                          tint: DSColor.primaryAccent)
            .padding(.top, DSSpacing.s)
    }

    // MARK: Content

    @ViewBuilder
    private var stepContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DSSpacing.l) {
                switch viewModel.currentStep {
                case .welcome:     welcomeStep
                case .aiSetup:     aiSetupStep
                case .permissions: permissionsStep
                case .safety:      safetyStep
                case .ready:       readyStep
                }
            }
            .frame(maxWidth: 560)
            .padding(.horizontal, DSSpacing.xl)
            .padding(.vertical, DSSpacing.xl)
        }
    }

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            Text(reasonsMessage)
                .font(DSFont.body)
                .foregroundStyle(DSColor.textSecondary)
                .lineSpacing(3)
            featureBullet(symbol: "bubble.left.and.text", title: "陪伴聊天", text: "随时和桌宠对话，可以聊日常，也可以问问题。")
            featureBullet(symbol: "sparkles", title: "智能任务", text: "让它帮你查日历、记提醒、整理专注计划。")
            featureBullet(symbol: "lock.shield", title: "本地优先", text: "默认本地运行；调用云端 AI 时会先征求你的同意。")
            InlineNotice(kind: .info,
                         text: "整个引导可以随时关闭，已做的设置不会丢失。")
        }
    }

    private var aiSetupStep: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            statusCard
            Text("支持的服务")
                .font(DSFont.sectionTitle)
                .foregroundStyle(DSColor.textPrimary)
                .padding(.top, DSSpacing.s)
            providerSupportRow(symbol: "externaldrive.connected.to.line.below",
                               title: "本地模型（Ollama / LM Studio）",
                               text: "完全本地运行，无需 API Key。需要本机已安装并启动服务。")
            providerSupportRow(symbol: "cloud.fill",
                               title: "OpenAI 兼容 / Anthropic / Gemini / 自定义 HTTP",
                               text: "需要对应服务的 API Key，存放在 macOS 钥匙串中。")
            InlineNotice(kind: .info,
                         text: "Gemini 暂不可用，请选择其他服务。")
        }
    }

    private var statusCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                HStack(alignment: .center, spacing: DSSpacing.s) {
                    Image(systemName: providerStatusSymbol)
                        .font(.system(size: 16))
                        .foregroundStyle(providerStatusTint)
                        .frame(width: 22)
                        .accessibilityHidden(true)
                    Text("当前 AI 状态")
                        .font(DSFont.cardTitle)
                        .foregroundStyle(DSColor.textPrimary)
                    Spacer()
                    StatusPill(text: providerStatusLabel,
                               symbol: providerStatusSymbol,
                               tint: providerStatusTint)
                }
                Text(viewModel.providerReadiness.summaryText)
                    .font(DSFont.body)
                    .foregroundStyle(DSColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: DSSpacing.s) {
                    // P17 / AC-01 — single default button per window. The inner card
                    // button must NOT claim `.defaultAction`; only the footer button
                    // does, so pressing Enter is unambiguous.
                    Button("添加 / 调整 AI 服务", action: handleConfigureNow)
                        .buttonStyle(PrimaryButtonStyle())
                        .controlSize(.small)
                    Button("稍后配置", action: handleConfigureLater)
                        .buttonStyle(SecondaryButtonStyle())
                        .controlSize(.small)
                }
                .padding(.top, DSSpacing.xs)
            }
        }
    }

    private var providerStatusSymbol: String {
        switch viewModel.providerReadiness.state {
        case .ready:    return "checkmark.circle.fill"
        case .noModel:  return "exclamationmark.circle"
        case .disconnected: return "wifi.exclamationmark"
        case .noProvider: return "sparkles"
        case .error:    return "xmark.octagon"
        }
    }

    private var providerStatusLabel: String {
        switch viewModel.providerReadiness.state {
        case .ready:        return "已就绪"
        case .noModel:      return "需要选模型"
        case .disconnected: return "未连接"
        case .noProvider:   return "未配置"
        case .error:        return "错误"
        }
    }

    private var providerStatusTint: Color {
        switch viewModel.providerReadiness.state {
        case .ready:        return DSColor.success
        case .noModel:      return DSColor.warning
        case .disconnected: return DSColor.warning
        case .noProvider:   return DSColor.secondaryAccent
        case .error:        return DSColor.destructive
        }
    }

    private var permissionsStep: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            Text("DeskPet 默认按需申请权限。下面这些选项你随时可以在「设置 → 隐私与权限」中调整。")
                .font(DSFont.body)
                .foregroundStyle(DSColor.textSecondary)
                .lineSpacing(3)
            permissionRow(symbol: "rectangle.dashed",
                          title: "屏幕读取",
                          state: viewModel.preferences.permissions.screenRead,
                          description: "用于智能回答「屏幕上是什么」之类的问题；图像不写入长期记忆。",
                          openSettings: requestScreenCaptureAccess)
            // P19.1 / P0-A — accessibility row. Truth source is the
            // `AwarenessPermissionObserver` (live `AXIsProcessTrusted`), NOT the
            // persisted `PermissionPreferences`. The row is hidden entirely when
            // no observer is wired (test environment) so the user never sees a
            // permanently "未授权" placeholder.
            if viewModel.permissionObserver != nil {
                accessibilityPermissionRow
            }
            if viewModel.permissionObserver != nil {
                inputMonitoringPermissionRow
            }
            permissionRow(symbol: "mic",
                          title: "麦克风",
                          state: viewModel.preferences.permissions.microphone,
                          description: "用于语音输入；不授权时仍然可以打字。",
                          openSettings: { openSystemSettings(for: .microphone) })
            permissionRow(symbol: "bell",
                          title: "通知",
                          state: viewModel.preferences.permissions.notifications,
                          description: "用于在专注结束或任务完成时提醒你。",
                          openSettings: { openSystemSettings(for: .notifications) })
            HStack(spacing: DSSpacing.s) {
                Button("打开系统设置") { openSystemSettings() }
                    .buttonStyle(SecondaryButtonStyle())
                Button("刷新状态", action: handleRefreshPermissions)
                    .buttonStyle(SecondaryButtonStyle())
                Button("稍后再设置", action: handleSkipPermissions)
                    .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.top, DSSpacing.s)
        }
    }

    /// P19.1 / P0-A — Accessibility row. Copy is capability-specific:
    /// * primary ⌥Space hotkey uses Carbon `RegisterEventHotKey` and does NOT
    ///   need Accessibility to fire;
    /// * Awareness (frontmost app, window title) DOES need Accessibility;
    /// * no restart is needed because the runtime reads AX lazily.
    private var accessibilityPermissionRow: some View {
        let granted = viewModel.accessibilityLiveGranted
        let state: CapabilityPermissionState = granted ? .grantedPersistently : .notRequested
        return VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack(alignment: .center, spacing: DSSpacing.s) {
                Image(systemName: "figure.roll").font(.system(size: 12))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18).accessibilityHidden(true)
                Text("辅助功能").font(DSFont.body).foregroundStyle(DSColor.textPrimary).lineLimit(1)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: state.displayLabel,
                           symbol: statusPillSymbol(for: state),
                           tint: statusPillTint(for: state))
            }
            Text("让桌宠感知当前前台应用与窗口标题；⌥ Space 主快捷键使用系统级注册，不需要这一项也能工作。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("去授权", action: { openSystemSettings(for: .accessibility) })
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    /// P19.1 / P0-A — Input Monitoring row. Copy is capability-specific per
    /// audit correction: primary ⌥Space does NOT need it; the background
    /// ⌘+Opt+[A|N|P|R] family does. We use the observer's typed state
    /// (`.granted` vs `.unknown` vs `.notDetermined`) so the UI never claims
    /// more certainty than the OS query supports. The "我已测试可用"
    /// confirmation button is intentionally NOT exposed here — that human
    /// verification will be wired in a later phase so we do not present an
    /// inert affordance that grants nothing.
    private var inputMonitoringPermissionRow: some View {
        let state = viewModel.inputMonitoringLiveState
        let display: CapabilityPermissionState = {
            switch state {
            case .granted, .humanVerified: return .grantedPersistently
            case .notDetermined: return .denied
            case .unknown: return .notRequested
            }
        }()
        return VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack(alignment: .center, spacing: DSSpacing.s) {
                Image(systemName: "keyboard").font(.system(size: 12))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18).accessibilityHidden(true)
                Text("输入监控").font(DSFont.body).foregroundStyle(DSColor.textPrimary).lineLimit(1)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: displayLabelForInputMonitoring(state),
                           symbol: statusPillSymbol(for: display),
                           tint: statusPillTint(for: display))
            }
            Text("仅在桌宠不处于前台时，让 ⌘+Opt+[P|R|N|A] 等组合键也能唤起对应操作。⌥ Space 主快捷键不受影响。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("去授权", action: { openSystemSettings(for: .inputMonitoring) })
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    /// P19.1 / P0-A — capability-specific copy for the Input Monitoring state
    /// pill. Avoids developer terms like "TCC", "AXIsProcessTrusted", "NSEvent
    /// monitor" or "Carbon".
    private func displayLabelForInputMonitoring(_ state: AwarenessPermissionObserver.InputMonitoringState) -> String {
        switch state {
        case .granted, .humanVerified: return "已授权"
        case .notDetermined: return "未授权"
        case .unknown: return "需要确认"
        }
    }

    private func permissionRow(symbol: String,
                               title: String,
                               state: CapabilityPermissionState,
                               description: String,
                               openSettings: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack(alignment: .center, spacing: DSSpacing.s) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18).accessibilityHidden(true)
                Text(title).font(DSFont.body).foregroundStyle(DSColor.textPrimary).lineLimit(1)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: state.displayLabel,
                           symbol: statusPillSymbol(for: state),
                           tint: statusPillTint(for: state))
            }
            Text(description).font(DSFont.caption).foregroundStyle(DSColor.textSecondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("去授权", action: openSettings)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }

    private func statusPillSymbol(for state: CapabilityPermissionState) -> String {
        switch state {
        case .grantedOnce, .grantedForSession, .grantedPersistently: return "checkmark.circle"
        case .denied, .restricted: return "xmark.octagon"
        case .unavailable: return "lock"
        case .notRequested: return "exclamationmark.triangle"
        case .unknown: return "minus.circle"
        }
    }

    private func statusPillTint(for state: CapabilityPermissionState) -> Color {
        switch state {
        case .grantedOnce, .grantedForSession, .grantedPersistently: return DSColor.success
        case .denied, .restricted: return DSColor.warning
        case .unavailable, .unknown: return DSColor.textTertiary
        case .notRequested: return DSColor.warning
        }
    }

    private var safetyStep: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            Text("为了让智能任务可控，DeskPet 做了这些事情：")
                .font(DSFont.body)
                .foregroundStyle(DSColor.textSecondary)
                .lineSpacing(3)
            featureBullet(symbol: "lock.shield",
                          title: "按权限运行",
                          text: "没有获得你授权的能力，桌宠不会调用。")
            featureBullet(symbol: "list.bullet.rectangle",
                          title: "敏感操作需要你确认",
                          text: "在「系统设置、日历、提醒事项、文件」等位置写入或修改前会先弹出确认卡片。")
            featureBullet(symbol: "eye",
                          title: "你随时可以取消",
                          text: "运行中的任务可以一键取消；取消后状态会保留，你也能查看原因。")
            featureBullet(symbol: "arrow.clockwise",
                          title: "出错会自动重试",
                          text: "网络抖动或模型暂时不可用时，桌宠会在后台重试，不会反复打扰你。")
            InlineNotice(kind: .info,
                         text: "你可以随时在「设置 → 隐私与权限」中关闭自动重试。")
        }
    }

    private var readyStep: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 36, weight: .light))
                    .foregroundStyle(DSColor.success)
                    .accessibilityHidden(true)
                Text(viewModel.hasConfiguredProvider ? "准备好了" : "可以开始了")
                    .font(DSFont.pageTitle)
                    .foregroundStyle(DSColor.textPrimary)
                Text(viewModel.hasConfiguredProvider
                     ? "点击「完成设置」后，桌宠就会出现在屏幕上。直接点击桌宠就能打开对话。"
                     : "点击「完成设置」后，桌宠会出现在屏幕上。你随时可以在「AI 设置」里补上模型。")
                    .font(DSFont.body)
                    .foregroundStyle(DSColor.textSecondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            featureBullet(symbol: "hand.point.up.left",
                          title: "点击桌宠",
                          text: "可以直接和它对话。")
            featureBullet(symbol: "keyboard",
                          title: "Option + Space（唤起/隐藏悬浮窗）",
                          text: hotkeyStatusText)
            featureBullet(symbol: "gear",
                          title: "想重新看一次引导？",
                          text: "「设置 → 关于」里有「重新查看新手引导」。")
        }
    }

    /// P17 / R1-13 — derive the helper copy from the live registration status. When
    /// the host wires `hotkeyStatus`, the user sees a real "已启用" / "未注册：…"
    /// message instead of a generic static line.
    private var hotkeyStatusText: String {
        switch hotkeyStatusProvider() {
        case .some(.registered):
            return "已启用：Option + Space 唤起/隐藏悬浮窗。"
        case .some(.notAttempted):
            return "尚未尝试注册（系统环境尚未就绪）。"
        case .some(.failed):
            return "未注册：全局快捷键失败，仍可使用菜单栏与本地键盘。"
        case .none:
            return "使用全局快捷键也能打开对话。"
        }
    }

    @ViewBuilder
    private func featureBulletHotkeyStatus(status: GlobalHotKeyRegistrar.RegistrationResult?) -> some View {
        // Reserved for a future inline status row. The textual status is already
        // surfaced via `hotkeyStatusText` inside the bullet above; keep this helper
        // as the canonical extension point when the design system adds a status pill
        // to onboarding.
        EmptyView()
    }

    // MARK: Bullets / rows

    private func featureBullet(symbol: String, title: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: DSSpacing.m) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(DSColor.primaryAccent)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                Text(text).font(DSFont.secondaryBody).foregroundStyle(DSColor.textSecondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .layoutPriority(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title)：\(text)")
    }

    private func providerSupportRow(symbol: String, title: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: DSSpacing.m) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(DSColor.secondaryAccent)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                Text(text).font(DSFont.secondaryBody).foregroundStyle(DSColor.textSecondary)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .layoutPriority(1)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(alignment: .center, spacing: DSSpacing.m) {
            Button(action: handleClose) {
                Text(viewModel.isReplay ? "取消" : "稍后再说")
                    .font(DSFont.body)
            }
            .buttonStyle(.link)
            Spacer()
            Button("上一步", action: handleBack)
                .buttonStyle(SecondaryButtonStyle())
                .disabled(!viewModel.canGoBack)
            if viewModel.isLastStep {
                Button("完成设置", action: handleFinish)
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("下一步", action: handleNext)
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, DSSpacing.xl)
        .padding(.vertical, DSSpacing.m)
        .background(DSColor.elevatedSurface)
    }

    // MARK: Actions

    private func handleBack() { viewModel.goBack() }
    private func handleNext() { viewModel.goNext() }

    private func handleFinish() {
        _ = try? viewModel.finish()
        onClose()
    }

    private func handleClose() {
        onClose()
    }

    private func handleConfigureNow() {
        viewModel.recordSkip("opened_provider_editor")
        // Walk to the Provider Center section. AppDelegate observes this via
        // notification, or SettingsView reads via uiState — keep the API local
        // to the window controller owner.
        NotificationCenter.default.post(name: .deskpetOpenProviderCenterRequested, object: nil)
        onClose()
    }

    private func handleConfigureLater() {
        viewModel.recordSkip("config_provider_later")
    }

    private func handleSkipPermissions() {
        viewModel.recordSkip("permissions_skipped")
    }

    /// P19.1 / P0-A — explicit user-controlled refresh. Bound to the new
    /// "刷新状态" button next to "打开系统设置". Re-queries the live observer so
    /// the status pills update without a full app restart after the user
    /// toggled TCC in System Settings.
    private func handleRefreshPermissions() {
        viewModel.refreshPermissions()
        viewModel.recordSkip("permissions_refresh_requested")
    }

    private func requestScreenCaptureAccess() {
        let granted = CGRequestScreenCaptureAccess()
        viewModel.preferences.setPermission(\.screenRead, granted ? .grantedPersistently : .notRequested)
        if !granted {
            openSystemSettings(for: .screenCapture)
        }
    }

    /// P17 / NM-05 — per-permission deep link map used by the onboarding permission step.
    enum PermissionKind {
        case screenCapture
        case microphone
        case notifications
        case inputMonitoring
        case accessibility
    }

    private func openSystemSettings(for kind: PermissionKind? = nil) {
        let deepLink: URL? = {
            guard let kind else { return URL(string: "x-apple.systempreferences:com.apple.preference.security") }
            switch kind {
            case .screenCapture:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            case .microphone:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            case .notifications:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Notifications")
            case .inputMonitoring:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            case .accessibility:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            }
        }()
        let fallback = URL(string: "x-apple.systempreferences:com.apple.preference.security")
            ?? URL(fileURLWithPath: "/System/Applications/System Settings.app")
        NSWorkspace.shared.open(deepLink ?? fallback)
    }
}

extension Notification.Name {
    /// Posted when onboarding requests the host to open the Provider Center.
    static let deskpetOpenProviderCenterRequested = Notification.Name("deskpet.openProviderCenterRequested")
    /// Posted when onboarding requests the host to close any onboarding UI.
    static let deskpetOnboardingCompleted = Notification.Name("deskpet.onboardingCompleted")
    /// Posted when Settings → "重新查看新手引导" is tapped.
    static let deskpetReplayOnboardingRequested = Notification.Name("deskpet.replayOnboardingRequested")
}

private struct OnboardingKeyboardShortcuts: ViewModifier {
    let onBack: (() -> Void)?
    let onNext: (() -> Void)?
    func body(content: Content) -> some View {
        content
            .background(
                Group {
                    if let onBack {
                        Button("", action: onBack)
                            .keyboardShortcut(.leftArrow, modifiers: [.command])
                            .hidden()
                    }
                    if let onNext {
                        Button("", action: onNext)
                            .keyboardShortcut(.rightArrow, modifiers: [.command])
                            .hidden()
                    }
                }
            )
    }
}
