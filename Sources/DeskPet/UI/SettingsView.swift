import SwiftUI
import AppKit
import AVFoundation
import UserNotifications
import PetAgentRuntime

enum PermissionRowActionLabels {
    static let enable = "启用"
    static let openSystemSettings = "打开系统设置"
    static let refresh = "刷新"
    static let clipboardPicker = "剪贴板读取"
}

/// P18 — Lightweight protocol that lets `SettingsView` show live permission state
/// without coupling to `DesktopAwarenessService` directly. The settings view
/// imports this into its callsite instead of the concrete service so unit tests
/// can pass any object that returns the same projection.
@MainActor
public protocol AwarenessServiceReferencing: AnyObject {
    /// Live CGPreflightScreenCaptureAccess result, where supported. `nil` means
    /// the host hasn't wired the live observer (e.g. test harness without TCC).
    var screenCaptureGranted: Bool? { get }
    @discardableResult
    func requestScreenCaptureAccess() -> Bool
    /// P19.1 / P0-A — live Accessibility state. Optional so existing test
    /// doubles that only implement screen capture continue to compile.
    var accessibilityLiveGranted: Bool? { get }
    /// P19.1 / P0-A — live Input Monitoring trust state. Defaults to `.unknown`
    /// when the host hasn't wired the observer.
    var inputMonitoringLiveState: AwarenessPermissionObserver.InputMonitoringState { get }
    @discardableResult
    func refreshPermissionState() -> Bool
}

// P5.1 — "设置"页面。把低频功能从一级导航收敛到这里：隐私/权限说明、数据与备份（复用现有 DataView，
// 真实功能）、关于。运行时主动模式与系统权限申请属于 Runtime 绑定，本轮以只读说明呈现，不做假控件。

struct SettingsView: View {
    @ObservedObject var prefs: PreferencesModel
    let backup: BackupService
    /// P18 — optional reference to the awareness service so the section can show
    /// live permission state without each setting card re-querying TCC.
    var awarenessService: AwarenessServiceReferencing? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            privacyCard
            // P18 — New "桌面感知 / Desktop Awareness" card sits beside privacy so
            // the user's mental model ("what can DeskPet see?") stays contiguous.
            awarenessCard
            // P17 / SH-01 — cross-link to the tools permission page so the user has one
            // obvious path to "what tools can DeskPet access?". The page itself now lives
            // under the "AI" group in the sidebar; this row points to the same section.
            CardContainer {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    SectionHeader("工具访问策略", subtitle: "每个工具都来自同一份 Manifest")
                    Text("桌宠能调用的工具、风险等级和默认授权都在「工具权限」页面集中管理。")
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            CardContainer {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    SectionHeader("数据与同步")
                    DataView(prefs: prefs, backup: backup)
                }
            }
            aboutCard
        }
    }

    private var privacyCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                SectionHeader("隐私与权限", subtitle: "默认最小化采集，系统权限必须由你显式授权")
                permissionStatusRow(symbol: "rectangle.dashed",
                                    title: "屏幕读取",
                                    state: prefs.permissions.screenRead,
                                    openSettings: requestScreenCaptureAccess,
                                    refresh: refreshScreenCaptureStatus)
                // P19.1 / P0-A — Accessibility row. Live state comes from the
                // observer; we do not write the grant to PermissionPreferences.
                accessibilityRow
                inputMonitoringRow
                permissionStatusRow(symbol: "mic",
                                    title: "麦克风",
                                    state: prefs.permissions.microphone,
                                    openSettings: { openSystemSettings(for: .microphone) },
                                    refresh: refreshMicrophoneStatus)
                keyboardRow
                clipboardRow
                permissionStatusRow(symbol: "bell",
                                    title: "通知",
                                    state: prefs.permissions.notifications,
                                    openSettings: { openSystemSettings(for: .notifications) },
                                    refresh: refreshNotificationStatus)
                Toggle(isOn: Binding(get: { prefs.autoApproveReversibleThisSession },
                                     set: { prefs.setTrustReversibleThisSession($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("本次会话内自动允许低风险的可撤销操作")
                        Text("开启后，桌宠这次会话内创建提醒 / 日程、读写工作区文件等可撤销操作不再逐项询问。重启后重置。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                // P17 / PX-01 — tier names (low-risk reversible / un-revocable) are
                // removed; the description stays readable while the underlying risk
                // taxonomy is preserved in code.
                InlineNotice(kind: .info, text: "屏幕读取、持续麦克风、键盘监听和工具访问默认关闭；未授权的工具会被直接拒绝。对外发送或不可撤销的操作始终逐项询问。")
            }
        }
    }

    /// P19.1 / P0-A — Accessibility row in Settings. The state pill shows the
    /// live `AXIsProcessTrusted()` result via the observer; copy explains the
    /// capability the permission enables (Awareness / frontmost app tracking)
    /// without using developer terms.
    private var accessibilityRow: some View {
        let live = liveAccessibilityState
        let display = displayState(for: live)
        return permissionStatusRow(symbol: "figure.roll",
                                  title: "辅助功能",
                                  state: live,
                                  openSettings: { openSystemSettings(for: .accessibility) },
                                  refresh: refreshAccessibilityStatus)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("辅助功能：\(display.label)")
    }

    /// P19.1 / P0-A — Input Monitoring row in Settings. Uses the observer's
    /// typed `InputMonitoringState` so the UI never claims more certainty than
    /// the OS query supports.
    private var inputMonitoringRow: some View {
        let state = liveInputMonitoringState
        let display = inputMonitoringDisplay(for: state)
        return VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Image(systemName: "keyboard").font(.system(size: 12))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18).accessibilityHidden(true)
                Text("输入监控").font(DSFont.body).foregroundStyle(DSColor.textPrimary).lineLimit(1)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: display.label,
                           symbol: display.symbol,
                           tint: display.tint)
            }
            Text("仅在桌宠不处于前台时，让 ⌘+Opt+[P|R|N|A] 等组合键也能唤起对应操作。⌥ Space 主快捷键不受影响。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: DSSpacing.s) {
                Button(PermissionRowActionLabels.openSystemSettings,
                       action: { openSystemSettings(for: .inputMonitoring) })
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
                Button(PermissionRowActionLabels.refresh, action: refreshInputMonitoringStatus)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("输入监控：\(display.label)")
    }

    /// P19.1 / P0-A — drive the Accessibility state from the awareness service
    /// when wired (the canonical production path). The persisted preference is
    /// NEVER the source of truth for the Accessibility grant; it only records
    /// whether the user has been prompted.
    private var liveAccessibilityState: CapabilityPermissionState {
        awarenessService?.accessibilityLiveGranted == true
            ? .grantedPersistently
            : .notRequested
    }

    /// P19.1 / P0-A — drive the Input Monitoring state from the same observer.
    /// Falls back to `.unknown` (rendered as "需要确认") when the observer is
    /// not wired, so the UI never claims TCC truth it cannot verify.
    private var liveInputMonitoringState: AwarenessPermissionObserver.InputMonitoringState {
        awarenessService?.inputMonitoringLiveState ?? .unknown
    }

    private func refreshAccessibilityStatus() {
        _ = awarenessService?.refreshPermissionState()
    }

    private func refreshInputMonitoringStatus() {
        // Same as refreshAccessibilityStatus — there is one observer that exposes
        // both TCC categories.
        _ = awarenessService?.refreshPermissionState()
    }

    private func inputMonitoringDisplay(for state: AwarenessPermissionObserver.InputMonitoringState)
        -> (label: String, symbol: String, tint: Color) {
        switch state {
        case .granted, .humanVerified:
            return ("已授权", "checkmark.circle", DSColor.success)
        case .notDetermined:
            return ("未授权", "exclamationmark.triangle", DSColor.warning)
        case .unknown:
            return ("需要确认", "questionmark.circle", DSColor.textTertiary)
        }
    }

    /// P18 §24 — Ambient Desktop Awareness card. Lives between Privacy and Tools so
    /// the user's mental model ("what can DeskPet see?") stays contiguous, but it
    /// never replaces the existing privacy card. Adds the spec-mandated controls:
    /// level picker, gated whitelist + screen-analysis controls, sensitive toggle,
    /// and the macOS-side screen-recording row.
    private var awarenessCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                SectionHeader("桌面感知", subtitle: "分级授权，默认最小化感知")
                awarenessLevelPicker
                if prefs.awareness.maxLevel == "title" || prefs.awareness.maxLevel == "screen" {
                    awarenessWhitelistEditor
                }
                if prefs.awareness.maxLevel == "screen" {
                    awarenessScreenAnalysisToggle
                }
                awarenessSensitiveToggle
                awarenessMacScreenRecordingRow
                InlineNotice(kind: .info,
                             text: "屏幕读取仅在你主动发送「看看屏幕上是什么」时才会触发；图像不会持久化，OCR 文本不写入长期记忆。")
            }
        }
    }

    private var awarenessLevelPicker: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Text("感知等级").font(DSFont.body).foregroundStyle(DSColor.textPrimary)
            Picker("感知等级", selection: Binding(get: { prefs.awareness.maxLevel },
                                                set: { prefs.setAwarenessMaxLevel($0) })) {
                Text("关闭").tag("off")
                Text("L1 当前应用").tag("app")
                Text("L2 窗口标题").tag("title")
                Text("L3 屏幕理解").tag("screen")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text(awarenessLevelDescription(for: prefs.awareness.maxLevel))
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }

    private var awarenessWhitelistEditor: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Text("窗口标题白名单").font(DSFont.body).foregroundStyle(DSColor.textPrimary)
            Text("仅当桌宠在这些 App 前台时才会读取窗口标题；不在列表里则只看到 L1 应用名。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(prefs.awareness.titleWhitelist, id: \.self) { bundleID in
                HStack {
                    Text(bundleID).font(DSFont.caption)
                    Spacer()
                    Button("移除") {
                        var list = prefs.awareness.titleWhitelist
                        list.removeAll { $0 == bundleID }
                        prefs.setAwarenessTitleWhitelist(list)
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.mini)
                }
            }
            HStack {
                TextField("com.example.app", text: $newWhitelistBundleID)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(commitWhitelist)
                Button("添加", action: commitWhitelist)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
                    .disabled(newWhitelistBundleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            HStack(spacing: DSSpacing.s) {
                ForEach(AwarenessPreferences.defaultTitleWhitelistExamples, id: \.self) { bundleID in
                    Button(bundleID) {
                        var list = prefs.awareness.titleWhitelist
                        if !list.contains(bundleID) {
                            list.append(bundleID)
                            prefs.setAwarenessTitleWhitelist(list)
                        }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.mini)
                }
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }

    private var awarenessScreenAnalysisToggle: some View {
        Toggle("屏幕分析（让多模态模型理解屏幕）",
               isOn: Binding(
                get: { prefs.awareness.screenAnalysisEnabled },
                set: { prefs.setAwarenessScreenAnalysisEnabled($0) }))
            .toggleStyle(.switch)
            .font(DSFont.body)
    }

    private var awarenessSensitiveToggle: some View {
        Toggle("在密码管理器、银行等敏感应用前自动屏蔽窗口标题与屏幕内容",
               isOn: Binding(
                get: { prefs.awareness.sensitiveContextSuppressed },
                set: { prefs.setAwarenessSensitiveContextSuppressed($0) }))
            .toggleStyle(.switch)
            .font(DSFont.body)
    }

    private var awarenessMacScreenRecordingRow: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Image(systemName: "rectangle.dashed").font(.system(size: 12))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                Text("macOS 屏幕录制权限")
                    .font(DSFont.body)
                    .foregroundStyle(DSColor.textPrimary)
                Spacer()
                StatusPill(text: awarenessScreenCaptureLabel,
                           symbol: awarenessScreenCaptureSymbol,
                           tint: awarenessScreenCaptureTint)
            }
            Text("L3 屏幕理解需要 macOS 屏幕录制授权；如果你暂时没开，可以先把等级调到 L2，权限就位后再升级。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: DSSpacing.s) {
                Button(PermissionRowActionLabels.openSystemSettings,
                       action: requestScreenCaptureAccess)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
                Button(PermissionRowActionLabels.refresh, action: refreshScreenCaptureStatus)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }

    @State private var newWhitelistBundleID: String = ""

    private func commitWhitelist() {
        let raw = newWhitelistBundleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        var list = prefs.awareness.titleWhitelist
        if !list.contains(raw) { list.append(raw) }
        prefs.setAwarenessTitleWhitelist(list)
        newWhitelistBundleID = ""
    }

    private func awarenessLevelDescription(for level: String) -> String {
        switch level {
        case "off": return "完全关闭桌面对话感知。"
        case "app": return "只感知当前前台应用名，例如「Sage / Chrome」。"
        case "title": return "在白名单 App 中才感知窗口标题；其它 App 仅暴露应用名。"
        case "screen": return "仅在你发送「看看屏幕上是什么」时才会触发屏幕读取；图像不保存。"
        default: return ""
        }
    }

    /// Live label for the macOS screen-recording state. Defaults to the persisted
    /// preference value when no live service observer is wired; prefers the
    /// service's own query result when available.
    private var awarenessScreenCaptureLabel: String {
        if let live = awarenessService?.screenCaptureGranted {
            return live ? "已授权" : "未授权"
        }
        return prefs.permissions.screenRead == .grantedPersistently ? "已授权" : "未授权"
    }

    private var awarenessScreenCaptureSymbol: String {
        if let live = awarenessService?.screenCaptureGranted {
            return live ? "checkmark.circle" : "exclamationmark.triangle"
        }
        return prefs.permissions.screenRead == .grantedPersistently ? "checkmark.circle" : "exclamationmark.triangle"
    }

    private var awarenessScreenCaptureTint: Color {
        if let live = awarenessService?.screenCaptureGranted {
            return live ? DSColor.success : DSColor.warning
        }
        return prefs.permissions.screenRead == .grantedPersistently ? DSColor.success : DSColor.warning
    }

    private func permissionStatusRow(symbol: String,
                                     title: String,
                                     state: CapabilityPermissionState,
                                     openSettings: @escaping () -> Void,
                                     refresh: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18).accessibilityHidden(true)
                Text(title)
                    .font(DSFont.body)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: displayState(for: state).label,
                           symbol: displayState(for: state).symbol,
                           tint: displayState(for: state).tint)
            }
            Text(permissionDescription(title: title, state: state))
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: DSSpacing.s) {
                Button(PermissionRowActionLabels.openSystemSettings, action: openSettings)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
                Button(PermissionRowActionLabels.refresh, action: refresh)
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func permissionActionButtons(openSettings: @escaping () -> Void,
                                         refresh: @escaping () -> Void) -> some View {
        HStack(spacing: DSSpacing.s) {
            Button(PermissionRowActionLabels.openSystemSettings, action: openSettings)
                .buttonStyle(SecondaryButtonStyle())
                .controlSize(.small)
            Button(PermissionRowActionLabels.refresh, action: refresh)
                .buttonStyle(SecondaryButtonStyle())
                .controlSize(.small)
        }
    }

    private var keyboardRow: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Image(systemName: "keyboard").font(.system(size: 12)).foregroundStyle(DSColor.textTertiary)
                    .frame(width: 18).accessibilityHidden(true)
                Text("键盘监听").font(DSFont.body).foregroundStyle(DSColor.textPrimary)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: "暂未启用", symbol: "lock", tint: DSColor.textTertiary)
            }
            Text("高级能力当前不可用，不会在后台读取键盘输入。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
            Toggle(PermissionRowActionLabels.enable, isOn: .constant(false))
                .toggleStyle(.switch)
                .font(DSFont.body)
                .disabled(true)
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.textTertiary).opacity(0.05),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }

    private var clipboardRow: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Image(systemName: "doc.on.clipboard").font(.system(size: 12)).foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 18).accessibilityHidden(true)
                Text(PermissionRowActionLabels.clipboardPicker)
                    .font(DSFont.body)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: prefs.permissions.clipboard.label,
                           symbol: "doc.on.clipboard",
                           tint: DSColor.secondaryAccent)
            }
            Text("剪贴板读取只按所选策略执行，不做持续后台读取。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
            Picker(PermissionRowActionLabels.clipboardPicker,
                   selection: Binding(get: { prefs.permissions.clipboard },
                                      set: { prefs.setClipboardPolicy($0) })) {
                ForEach(ClipboardAccessPolicy.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(DSSpacing.s)
        .background(DSColor.token(.primaryAccent).opacity(0.04),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }

    private func refreshScreenCaptureStatus() {
        prefs.setPermission(\.screenRead, CGPreflightScreenCaptureAccess() ? .grantedPersistently : .notRequested)
    }

    private func requestScreenCaptureAccess() {
        let granted = awarenessService?.requestScreenCaptureAccess()
            ?? CGRequestScreenCaptureAccess()
        refreshScreenCaptureStatus()
        if !granted {
            openSystemSettings(for: .screenCapture)
        }
    }

    private func refreshMicrophoneStatus() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: prefs.setPermission(\.microphone, .grantedPersistently)
        case .denied, .restricted: prefs.setPermission(\.microphone, .denied)
        case .notDetermined: prefs.setPermission(\.microphone, .notRequested)
        @unknown default: prefs.setPermission(\.microphone, .unknown)
        }
    }

    private func refreshNotificationStatus() {
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            await MainActor.run {
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    prefs.setPermission(\.notifications, .grantedPersistently)
                case .denied:
                    prefs.setPermission(\.notifications, .denied)
                case .notDetermined:
                    prefs.setPermission(\.notifications, .notRequested)
                @unknown default:
                    prefs.setPermission(\.notifications, .unknown)
                }
            }
        }
    }

    /// P17 / NM-05 — per-permission deep link map. Routes the user directly to the
    /// relevant TCC pane in System Settings; falls back to the generic Security pane
    /// (and finally to opening the System Settings app) if a specific pane cannot be
    /// resolved.
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

    private func displayState(for state: CapabilityPermissionState) -> (label: String, symbol: String, tint: Color) {
        switch state {
        case .grantedOnce, .grantedForSession, .grantedPersistently:
            return (state.displayLabel, "checkmark.circle", DSColor.success)
        case .denied, .restricted:
            return (state.displayLabel, "xmark.octagon", DSColor.warning)
        case .unavailable:
            return (state.displayLabel, "lock", DSColor.textTertiary)
        case .notRequested:
            return (state.displayLabel, "exclamationmark.triangle", DSColor.warning)
        case .unknown:
            return (state.displayLabel, "minus.circle", DSColor.textTertiary)
        }
    }

    private func permissionDescription(title: String, state: CapabilityPermissionState) -> String {
        switch title {
        case "屏幕读取":
            return state == .grantedPersistently ? "系统已允许屏幕读取；runtime 仍会按权限边界执行。" : "需要你在系统设置中显式授权后才会读取屏幕。"
        case "麦克风":
            return state == .grantedPersistently ? "系统已允许麦克风；持续监听仍默认关闭。" : "需要你在系统设置中显式授权后才会使用麦克风。"
        case "通知":
            return state == .grantedPersistently ? "通知已允许，用于提醒专注与任务。" : "需要系统通知授权后才会发送提醒。"
        default:
            return "系统权限和应用内工具权限会同时参与决策。"
        }
    }

    private var aboutCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("关于")
                HStack {
                    Text("版本").font(DSFont.body).foregroundStyle(DSColor.textSecondary)
                    Spacer()
                    Text(Self.versionString).font(DSFont.body).foregroundStyle(DSColor.textPrimary)
                }
                Text("DeskPet · 以角色为中心的 macOS 桌面陪伴")
                    .font(DSFont.caption).foregroundStyle(DSColor.textTertiary)

                Divider().background(DSColor.border).padding(.vertical, DSSpacing.xs)

                SettingsRow(title: "重新查看新手引导",
                            subtitle: "重新打开设置引导，按步骤了解桌宠的使用方法。",
                            symbol: "questionmark.circle") {
                    Button("重新查看", action: handleReplayOnboarding)
                        .buttonStyle(SecondaryButtonStyle())
                }
            }
        }
    }

    private func handleReplayOnboarding() {
        NotificationCenter.default.post(name: .deskpetReplayOnboardingRequested, object: nil)
    }

    private static var versionString: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "dev"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }
}
