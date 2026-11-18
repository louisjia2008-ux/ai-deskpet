import SwiftUI
import AICore
import PetAgentRuntime

struct ToolPermissionsView: View {
    @ObservedObject var prefs: PreferencesModel
    @State private var calendarStatus: SystemAuthorizationStatus = .notDetermined

    var body: some View {
        ControlPanelPageLayout {
            DashboardSection(title: "工具权限", subtitle: "每个工具都来自同一份 Manifest") {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    ForEach(groupedCategories, id: \.0) { category, manifests in
                        toolGroup(category: category, manifests: manifests)
                    }
                    InlineNotice(kind: .info, text: "关闭某个工具后，新的对话轮次不会再向模型暴露该工具；正在执行的轮次继续使用开始时的快照。")
                    if let error = prefs.lastPersistenceError {
                        InlineNotice(kind: .warning, text: error)
                    }
                }
            }
        }
        .task { await refreshCalendarStatus() }
    }

    private var groupedCategories: [(ToolCategory, [ToolManifest])] {
        let manifests = ToolPlatformAssembly.releaseManifests.sorted {
            if $0.category != $1.category { return $0.category.rawValue < $1.category.rawValue }
            if $0.displayName != $1.displayName { return $0.displayName < $1.displayName }
            return $0.id.rawValue < $1.id.rawValue
        }
        let groups = Dictionary(grouping: manifests, by: \.category)
        return ToolCategory.allCases.compactMap { category in
            guard let values = groups[category], !values.isEmpty else { return nil }
            return (category, values)
        }
    }

    private func toolGroup(category: ToolCategory, manifests: [ToolManifest]) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Text(category.displayName)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textTertiary)
                .textCase(.uppercase)
            ForEach(manifests, id: \.id.rawValue) { manifest in
                toolRow(manifest)
            }
        }
    }

    @ViewBuilder
    private func toolRow(_ manifest: ToolManifest) -> some View {
        SettingsRow(title: manifest.displayName,
                    subtitle: subtitle(for: manifest),
                    symbol: symbol(for: manifest.category)) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: DSSpacing.s) {
                    StatusPill(text: manifest.riskLevel.displayName,
                               symbol: riskSymbol(for: manifest.riskLevel),
                               tint: riskTint(for: manifest.riskLevel))
                    Toggle("", isOn: Binding(
                        get: { prefs.isToolEnabled(manifest.id.rawValue) },
                        set: { prefs.setToolEnabled(manifest.id.rawValue, $0) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                }
                VStack(alignment: .trailing, spacing: DSSpacing.xs) {
                    StatusPill(text: manifest.riskLevel.displayName,
                               symbol: riskSymbol(for: manifest.riskLevel),
                               tint: riskTint(for: manifest.riskLevel))
                    Toggle("", isOn: Binding(
                        get: { prefs.isToolEnabled(manifest.id.rawValue) },
                        set: { prefs.setToolEnabled(manifest.id.rawValue, $0) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                }
            }
        }
        if manifest.permissionRequirement.systemPermission == .calendarEvents {
            HStack(spacing: DSSpacing.s) {
                Text("系统日历权限：\(calendarStatusLabel)")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                Spacer()
                if calendarStatus != .granted {
                    Button("请求权限") {
                        Task {
                            calendarStatus = await CalendarPermissionRequester.requestEventsAccess()
                        }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .controlSize(.small)
                }
                Button("刷新") {
                    Task { await refreshCalendarStatus() }
                }
                .buttonStyle(SecondaryButtonStyle())
                .controlSize(.small)
            }
            // P17 / SP-03 — align to SettingsRow symbol column (20pt) plus DSSpacing.m
            // instead of the magic `30` indent.
            .padding(.leading, 20 + DSSpacing.m)
        }
    }

    private func subtitle(for manifest: ToolManifest) -> String {
        // P17 / LC-05 — keep just the short description here; enabled / permission state
        // is conveyed by the StatusPill on the right.
        return manifest.shortDescription
    }

    private var calendarStatusLabel: String {
        switch calendarStatus {
        case .notRequired: return "无需授权"
        case .notDetermined: return "未请求"
        case .granted: return "已允许"
        case .denied: return "已拒绝"
        case .restricted: return "受限制"
        case .unavailable: return "不可用"
        }
    }

    private func refreshCalendarStatus() async {
        calendarStatus = await LiveSystemAuthorizationPolicy().status(for: "calendar.events.read")
    }

    private func symbol(for category: ToolCategory) -> String {
        switch category {
        case .utility: return "clock"
        case .system: return "desktopcomputer"
        case .location: return "location"
        case .places: return "mappin.and.ellipse"
        case .applications: return "app.dashed"
        case .calendar: return "calendar"
        case .reminders: return "checklist"
        case .files: return "folder"
        case .browser: return "safari"
        case .communication: return "message"
        case .developer: return "curlybraces"
        case .desktopAutomation: return "cursorarrow.motionlines"
        case .unknown: return "questionmark.circle"
        }
    }

    private func riskSymbol(for risk: ToolRiskLevel) -> String {
        switch risk {
        case .localReadOnlyNoPrivateData, .safe: return "checkmark.shield"
        case .privateDataReadOnly, .sensitive: return "eye"
        case .externalReadOnly: return "network"
        case .externalSideEffectReversible: return "arrow.uturn.backward.circle"
        case .destructiveOrSensitiveWrite, .highRisk: return "exclamationmark.triangle"
        case .unknown: return "questionmark.circle"
        }
    }

    private func riskTint(for risk: ToolRiskLevel) -> Color {
        switch risk {
        case .localReadOnlyNoPrivateData, .safe: return DSColor.success
        case .privateDataReadOnly, .externalReadOnly, .sensitive: return DSColor.warning
        case .externalSideEffectReversible: return DSColor.warning
        case .destructiveOrSensitiveWrite, .highRisk:
            // P17 / EX-02 — highest-risk tiers use destructive so they don't share the
            // orange "waiting" voice.
            return DSColor.destructive
        case .unknown:
            return DSColor.warning
        }
    }
}

struct AppearanceAnimationView: View {
    @State private var previewExpression = ""
    @ObservedObject var prefs: PreferencesModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var overridePrefs = AccessibilityPreferences()

    private var characterHeight: Binding<Double> {
        Binding(get: { prefs.appearance.resolvedCharacterHeight },
                set: { prefs.setCharacterHeight($0) })
    }

    var body: some View {
        ControlPanelPageLayout {
            DashboardSection(title: "角色大小", subtitle: "即时调整桌面角色，退出后也会保留") {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    HStack {
                        Text("Live2D 角色").font(DSFont.body)
                        Spacer()
                        Text("\(Int((prefs.appearance.resolvedCharacterHeight / 240 * 100).rounded()))%")
                            .monospacedDigit().foregroundStyle(DSColor.textSecondary)
                    }
                    Slider(value: characterHeight, in: 120...420, step: 10) {
                        Text("角色大小")
                    } minimumValueLabel: {
                        Image(systemName: "person.fill").font(.system(size: 12))
                    } maximumValueLabel: {
                        Image(systemName: "person.fill").font(.system(size: 20))
                    }
                    .accessibilityIdentifier("companion.size")
                    HStack(spacing: DSSpacing.s) {
                        Button("小巧") { prefs.setPetSize(.small) }
                        Button("标准") { prefs.setPetSize(.normal) }
                        Button("放大") { prefs.setPetSize(.large) }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    Button("预览气泡") { prefs.onPreviewCompanionBubble?() }
                        .buttonStyle(SecondaryButtonStyle())
                    Text("拖动滑块预览大小；气泡文字保持清晰易读。")
                        .font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                    if let error = prefs.lastPersistenceError {
                        InlineNotice(kind: .warning, text: error)
                    }
                }
            }
            DashboardSection(title: "角色表情", subtitle: "情绪会自动驱动模型，也可以在这里预览") {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    HStack {
                        Button("开心") { prefs.onPreviewCompanionEmotion?(.happy) }
                        Button("害羞") { prefs.onPreviewCompanionEmotion?(.shy) }
                        Button("难过") { prefs.onPreviewCompanionEmotion?(.sad) }
                        Button("兴奋") { prefs.onPreviewCompanionEmotion?(.excited) }
                        Button("思考") { prefs.onPreviewCompanionEmotion?(.thinking) }
                    }.buttonStyle(SecondaryButtonStyle())
                    Picker("模型表情", selection: $previewExpression) {
                        Text("选择表情或姿势").tag("")
                        ForEach(prefs.companionExpressions, id: \.self) { name in
                            Text(CharacterExpressionResolver.label(name)).tag(name)
                        }
                    }
                    HStack {
                        Button("预览所选表情") { prefs.onPreviewCompanionExpression?(previewExpression) }
                            .disabled(previewExpression.isEmpty)
                        Button("恢复自动表情") { prefs.onPreviewCompanionExpression?(nil) }
                    }.buttonStyle(SecondaryButtonStyle())
                    Text("情绪预览约 4 秒，所选模型表情预览 5 秒后恢复。造型、道具与特殊姿势只在手动选择时预览；水印关闭设置不受影响。")
                        .font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                }
            }
            DashboardSection(title: "动画", subtitle: reduceMotion ? "系统 Reduce Motion 已开启" : "轻量动画已启用") {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    Picker("动画强度", selection: Binding(get: { prefs.appearance.animationIntensity },
                                                       set: { prefs.setAnimationIntensity($0) })) {
                        ForEach(AnimationIntensity.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Toggle("贴边避让 Dock", isOn: Binding(get: { prefs.appearance.avoidDock },
                                                       set: { prefs.setAvoidDock($0) }))
                    Toggle("允许 idle breathing / blink", isOn: Binding(get: { prefs.appearance.allowIdleBreathing },
                                                                   set: { prefs.setAllowIdleBreathing($0) }))
                    InlineNotice(kind: reduceMotion ? .warning : .info,
                                 text: reduceMotion ? "Reduce Motion 下会禁用大位移动画，只保留必要状态变化。" : "不会新增或替换角色动画素材。")
                }
            }
            // P22 — in-app override for the system Reduce Motion / Reduce
            // Transparency settings. Useful for testing and for users who
            // want a consistent experience even when system settings differ
            // (e.g. external monitor on a corporate-managed Mac).
            DashboardSection(title: "可访问性覆盖",
                             subtitle: overridePrefs.overrideSystem ? "应用内设置覆盖系统设置" : "跟随系统设置") {
                VStack(alignment: .leading, spacing: DSSpacing.s) {
                    Toggle("在应用内覆盖系统设置", isOn: Binding(
                        get: { overridePrefs.overrideSystem },
                        set: { overridePrefs.overrideSystem = $0 }
                    ))
                    Toggle("禁用所有动画（Reduce Motion）", isOn: Binding(
                        get: { overridePrefs.forceReduceMotion },
                        set: { overridePrefs.forceReduceMotion = $0 }
                    ))
                    .disabled(!overridePrefs.overrideSystem)
                    Toggle("禁用玻璃材质 / 透明背景（Reduce Transparency）", isOn: Binding(
                        get: { overridePrefs.forceReduceTransparency },
                        set: { overridePrefs.forceReduceTransparency = $0 }
                    ))
                    .disabled(!overridePrefs.overrideSystem)
                    InlineNotice(kind: .info,
                                 text: "覆盖仅作用于 DeskPet 内部；其他应用继续跟随系统设置。")
                }
            }
        }
    }
}

struct AdvancedDebugView: View {
    @ObservedObject var runtime: CompanionAgentRuntimeModel
    @ObservedObject var providers: ProviderStore
    let diagnosticsURL: URL
    @State private var exportMessage: String?
    @State private var exportIsError = false
    @State private var isExporting = false

    var body: some View {
        ControlPanelPageLayout {
            DashboardSection(title: "运行时状态", subtitle: "不包含 secret") {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    let status = runtime.runtimeStatus()
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: DSSpacing.s)],
                              alignment: .leading,
                              spacing: DSSpacing.s) {
                        MetricChip(label: "模式", value: status.currentMode.label, symbol: "pawprint")
                        MetricChip(label: "模型", value: status.selectedModel, symbol: "cpu")
                    }
                    Text(status.permissionSummary.label)
                        .font(DSFont.secondaryBody)
                        .foregroundStyle(DSColor.textSecondary)
                }
            }
            DashboardSection(title: "关于 DeskPet") {
                VStack(alignment: .leading, spacing: DSSpacing.s) {
                    infoRow("版本", Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")
                    infoRow("构建", Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0")
                    infoRow("Provider 数量", "\(providers.providers.count)")
                    Button(action: exportDiagnostics) {
                        HStack(spacing: DSSpacing.xs) {
                            if isExporting {
                                ProgressView().controlSize(.small)
                            }
                            Text("导出诊断报告")
                        }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(isExporting)
                    if let exportMessage {
                        Text(exportMessage)
                            .font(DSFont.caption)
                            .foregroundStyle(exportIsError ? DSColor.destructive : DSColor.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func infoRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(DSFont.body).foregroundStyle(DSColor.textSecondary)
            Spacer()
            Text(value).font(DSFont.body).foregroundStyle(DSColor.textPrimary)
        }
    }

    private func exportDiagnostics() {
        guard !isExporting else { return }
        isExporting = true
        let url = diagnosticsURL
        let status = runtime.runtimeStatus()
        let body = [
            "mode=\(status.currentMode.label)",
            "selectedModel=\(status.selectedModel)",
            "providerStatus=\(status.providerStatus.label)",
            "permissions=\(status.permissionSummary.label)",
            "memory=\(status.memoryStatus)",
            "lastError=\(status.lastError ?? "none")",
        ].joined(separator: "\n")
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
            exportMessage = "已导出：\(url.path)"
            exportIsError = false
        } catch {
            let detail = error.localizedDescription
            exportMessage = detail.isEmpty ? "导出失败" : "导出失败：\(detail)"
            exportIsError = true
        }
        isExporting = false
    }
}
