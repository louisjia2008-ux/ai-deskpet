import SwiftUI

// P5.1 — 应用主壳：以角色为中心的产品化外壳，替代默认 TabView。左侧导航 + 顶部产品头部 + 玻璃容器。
// 切换导航是纯 SwiftUI 状态变化，不重建任何 Runtime。导航选中态由 AppUIStateStore 持久化。

enum AppSection: String, CaseIterable, Identifiable {
    case chat, today, companion, focus, memory, schedule, tasks
    case models, providers, toolPermissions
    case privacy, appearance, advanced

    var id: String { rawValue }
    var groupTitle: String {
        switch self {
        case .chat, .today, .companion, .focus, .memory, .schedule, .tasks: return "桌宠"
        case .models, .providers, .toolPermissions: return "AI"
        case .privacy, .appearance, .advanced: return "系统"
        }
    }

    static let grouped: [(String, [AppSection])] = [
        ("桌宠", [.chat, .today, .companion, .tasks, .schedule, .memory]),
        ("AI", [.providers, .models, .toolPermissions]),
        ("系统", [.privacy, .appearance, .advanced]),
    ]

    var title: String {
        switch self {
        case .chat: return "聊天"
        case .today: return "今日"
        case .companion: return "陪伴"
        case .focus: return "专注"
        case .memory: return "记忆"
        case .schedule: return "定时任务"
        case .tasks: return "任务"
        case .models: return "高级模型"
        case .providers: return "AI 设置"
        case .toolPermissions: return "工具权限"
        case .privacy: return "隐私与权限"
        case .appearance: return "外观与动画"
        case .advanced: return "高级"
        }
    }
    var subtitle: String {
        switch self {
        case .chat: return "对话、陪伴与当前模型"
        case .today: return "状态、任务与快捷操作"
        case .companion: return "陪伴模式与关系"
        case .focus: return "专注计时与陪伴"
        case .memory: return "桌宠记住的内容"
        case .schedule: return "到点自动执行的定时/循环任务"
        case .tasks: return "运行中、等待处理和历史任务"
        case .models: return "角色路由与高级模型设置"
        case .providers: return "连接 DeskPet 用来回复的 AI 服务"
        case .toolPermissions: return "高敏感工具访问策略"
        case .privacy: return "系统权限与隐私控制"
        case .appearance: return "尺寸、动画与可访问性"
        case .advanced: return "诊断、构建信息与导出"
        }
    }
    var symbol: String {
        switch self {
        case .chat: return "bubble.left.and.bubble.right"
        case .today: return "sun.max"
        case .companion: return "heart"
        case .focus: return "timer"
        case .memory: return "brain"
        case .schedule: return "clock.badge"
        case .tasks: return "list.bullet.rectangle.portrait"
        case .models: return "cpu"
        case .providers: return "sparkles"
        case .toolPermissions: return "checkmark.shield"
        case .privacy: return "hand.raised"
        case .appearance: return "wand.and.stars"
        case .advanced: return "wrench.and.screwdriver"
        }
    }
}

struct AppShellView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var chat: ChatModel
    @ObservedObject var memory: MemoryModel
    @ObservedObject var relationship: RelationshipModel
    @ObservedObject var prefs: PreferencesModel
    @ObservedObject var providers: ProviderStore
    @ObservedObject var runtime: CompanionAgentRuntimeModel
    @ObservedObject var scheduler: TaskScheduler
    let backup: BackupService
    @ObservedObject var uiState: AppUIStateStore
    let automationIndicatorInfo: DeskPetAutomationIndicatorInfo?
    let diagnosticsURL: URL
    @StateObject private var companionChatViewModel: CompanionChatViewModel

    @Environment(\.sendPetIntent) private var sendPetIntent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // P20 — namespace for the left-rail selected-tab indicator (#9). One source
    // per selected button; matchedGeometryEffect slides the same Capsule across
    // button frames when `section` changes.
    @Namespace private var railIndicatorNamespace

    init(chat: ChatModel,
         memory: MemoryModel,
         relationship: RelationshipModel,
         prefs: PreferencesModel,
         providers: ProviderStore,
         runtime: CompanionAgentRuntimeModel,
         scheduler: TaskScheduler,
         backup: BackupService,
         uiState: AppUIStateStore,
         automationIndicatorInfo: DeskPetAutomationIndicatorInfo? = nil,
         diagnosticsURL: URL) {
        self.chat = chat
        self.memory = memory
        self.relationship = relationship
        self.prefs = prefs
        self.providers = providers
        self.runtime = runtime
        self.scheduler = scheduler
        self.backup = backup
        self.uiState = uiState
        self.automationIndicatorInfo = automationIndicatorInfo
        self.diagnosticsURL = diagnosticsURL
        _companionChatViewModel = StateObject(wrappedValue: CompanionChatViewModel(chat: chat, providers: providers))
    }

    private var section: AppSection { AppSection(rawValue: uiState.sectionRaw) ?? .today }
    private var windowMode: WindowMode { WindowMode(rawValue: uiState.windowModeRaw) ?? .compact }

    var body: some View {
        Group {
            if windowMode == .mini {
                MiniView(relationship: relationship, focus: model.focus, uiState: uiState)
            } else {
                fullShell
            }
        }
        // P17 / MO-01 — crossfade the mini / full shell swap so the change isn't a
        // hard cut. Route through DSMotion.emphasized so Reduce Motion falls back
        // to a short ease-in/out instead of a spring.
        .animation(DSMotion.emphasized(reduceMotion), value: windowMode)
        .frame(minWidth: CompanionConsoleWindowMetrics.minWidth,
               minHeight: CompanionConsoleWindowMetrics.minHeight)
        // P22 — user-overridable accessibility. When the user enables the
        // override in Appearance / Animation settings, the corresponding
        // values flow into the SwiftUI environment so every animation
        // modifier in the tree collapses to the no-motion / no-glass path.
        .applyAccessibilityOverrides()
        .onAppear { sendPetIntent(.windowOpened) }
    }

    private var fullShell: some View {
        HStack(spacing: 0) {
            navigationRail
            Divider().overlay(DSColor.border.opacity(0.7))
            content
        }
        .background(LiquidGlassRefractionBackdrop(seed: 11))
        .background(DSColor.appBackground)
    }

    // MARK: 左侧导航

    private var navigationRail: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: DSSpacing.s) {
                    Image(systemName: "pawprint.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(DSColor.primaryAccent)
                    Text("DeskPet")
                        .font(DSFont.cardTitle)
                        .foregroundStyle(DSColor.textPrimary)
                        .lineLimit(1)
                }
                Text("Companion Console")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textTertiary)
                    .lineLimit(1)
                #if DEBUG
                if let automationIndicatorInfo {
                    Text(automationIndicatorInfo.displayText)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.warning)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("automation.profileIndicator")
                        .accessibilityValue(automationIndicatorInfo.accessibilityValue)
                }
                #endif
            }
            .padding(.horizontal, DSSpacing.xs)
            .padding(.bottom, DSSpacing.m)
            .accessibilityElement(children: .contain)

            ForEach(AppSection.grouped, id: \.0) { group, items in
                Text(group)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textTertiary)
                    .textCase(.uppercase)
                    .padding(.horizontal, DSSpacing.xs)
                    .padding(.top, group == "桌宠" ? 0 : DSSpacing.m)
                ForEach(items) { item in
                    navButton(item)
                }
            }
            Spacer()
        }
        .padding(DSSpacing.m)
        .frame(width: CompanionConsoleWindowMetrics.sidebarWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .liquidGlass(style: .regular, cornerRadius: 0)
    }

    private func navButton(_ item: AppSection) -> some View {
        let isSelected = section == item
        return Button {
            guard !isSelected else { return }
            withAnimation(DSMotion.emphasized(reduceMotion)) { uiState.setSection(item) }
            sendPetIntent(.navigationChanged)
        } label: {
            HStack(spacing: DSSpacing.s) {
                Image(systemName: item.symbol)
                    .font(.system(size: 13, weight: .medium))
                    .frame(width: 20)
                Text(item.title).font(DSFont.body)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(isSelected ? DSColor.primaryAccent : DSColor.textSecondary)
            .padding(.horizontal, DSSpacing.s)
            .padding(.vertical, DSSpacing.s)
            .background(
                RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous)
                    .fill(DSColor.token(.primaryAccent).opacity(isSelected ? 0.10 : 0)))
            .overlay(alignment: .leading) {
                // P20 / #9 — the indicator lives on every button but is only
                // visible on the selected one; matchedGeometryEffect slides
                // it across button frames as `section` changes.
                Capsule()
                    .fill(DSColor.primaryAccent)
                    .frame(width: 2, height: 16)
                    .offset(x: -DSSpacing.s + 2)
                    .opacity(isSelected ? 1 : 0)
                    .matchedGeometryEffect(id: "rail.indicator",
                                           in: railIndicatorNamespace,
                                           isSource: isSelected)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
        .accessibilityIdentifier(accessibilityIdentifier(for: item))
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }

    private func accessibilityIdentifier(for item: AppSection) -> String {
        switch item {
        case .chat: return "sidebar.chat"
        case .memory: return "sidebar.memory"
        case .tasks: return "sidebar.taskCenter"
        case .providers: return "sidebar.provider"
        default: return "sidebar.\(item.rawValue)"
        }
    }

    // MARK: 内容区

    private var content: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(DSColor.border)
            pageBody
        }
        .frame(minWidth: CompanionConsoleWindowMetrics.contentMinWidth,
               maxWidth: .infinity,
               maxHeight: .infinity)
    }

    /// Memory manages its own List scroll; other pages are wrapped in a single scroll + padding.
    @ViewBuilder
    private var pageBody: some View {
        switch section {
        case .chat: scrolled {
            CompanionChatView(viewModel: companionChatViewModel,
                              onOpenAISettings: { uiState.setSection(.providers) })
        }
        case .today: scrolled { TodayView(prefs: prefs, providers: providers, runtime: runtime, uiState: uiState) }
        case .companion: scrolled { RelationshipView(relationship: relationship, prefs: prefs, runtime: runtime) }
        case .focus: scrolled { FocusBoardView(focus: model.focus, prefs: prefs) }
        case .memory: MemoryView(memory: memory)
        case .schedule: scrolled { ScheduledTasksView(scheduler: scheduler) }
        case .tasks: scrolled { TaskCenterView(chat: chat,
                                               activityStore: chat.activityStore,
                                               providers: providers,
                                               onOpenChat: { uiState.setSection(.chat) },
                                               onResultInteraction: { interaction in
                                                   Task { await runtime.handleResultInteraction(interaction) }
                                               }) }
        case .models: scrolled { ModelCenterView(providers: providers, runtime: runtime, uiState: uiState) }
        case .providers: scrolled { ProviderCenterView(providers: providers) }
        case .toolPermissions: scrolled { ToolPermissionsView(prefs: prefs) }
        case .privacy: scrolled {
            SettingsView(prefs: prefs,
                         backup: backup,
                         awarenessService: chat.awarenessService)
        }
        case .appearance: scrolled { AppearanceAnimationView(prefs: prefs) }
        case .advanced: scrolled { AdvancedDebugView(runtime: runtime, providers: providers, diagnosticsURL: diagnosticsURL) }
        }
    }

    private func scrolled<V: View>(@ViewBuilder _ make: () -> V) -> some View {
        ScrollView {
            make()
                .padding(.horizontal, DSSpacing.xl)
                .padding(.vertical, DSSpacing.l)
                .frame(minWidth: CompanionConsoleWindowMetrics.contentMinWidth,
                       maxWidth: .infinity,
                       alignment: .leading)
        }
        .background(DSColor.appBackground)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: DSSpacing.m) {
            HStack(spacing: DSSpacing.s) {
                Image(systemName: section.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(DSColor.primaryAccent)
                    .frame(width: 24, height: 24)
                    .background(DSColor.token(.primaryAccent).opacity(0.10),
                                in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(section.title).font(DSFont.pageTitle).foregroundStyle(DSColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .minimumScaleFactor(0.9)
                    Text(section.subtitle).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .layoutPriority(1)
            Spacer()
            CompanionStatusPill(relationship: relationship, focus: model.focus, runtime: runtime)
            WindowModeMenu(uiState: uiState)
        }
        .padding(.horizontal, DSSpacing.l)
        .padding(.vertical, DSSpacing.m)
        .liquidGlass(style: .regular, cornerRadius: 0)
    }

}

/// 角色状态胶囊：关系阶段 + 当前是否专注（真实数据）。
private struct CompanionStatusPill: View {
    @ObservedObject var relationship: RelationshipModel
    @ObservedObject var focus: FocusEngine
    @ObservedObject var runtime: CompanionAgentRuntimeModel
    var body: some View {
        if focus.isActive {
            StatusPill(text: "专注陪伴中", symbol: "moon.zzz", tint: DSColor.secondaryAccent)
        } else if runtime.runtimeStatus().modelReadiness.isReady {
            StatusPill(text: "模型已就绪", symbol: "checkmark.circle", tint: DSColor.success)
        } else {
            StatusPill(text: runtime.runtimeStatus().modelReadiness.shortLabel, symbol: "cpu", tint: DSColor.warning)
        }
    }
}

/// 迷你形态：简化状态 + 当前任务/专注 + 展开入口 + 一个主要快捷操作。复用同一状态源（model.focus、
/// relationship），切回展开只改 AppUIStateStore 并请求窗口重设尺寸——不重建任何状态。
struct MiniView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var relationship: RelationshipModel
    @ObservedObject var focus: FocusEngine
    @ObservedObject var uiState: AppUIStateStore
    @Environment(\.setWindowMode) private var setWindowMode
    @Environment(\.sendPetIntent) private var sendPetIntent

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack {
                if focus.isActive {
                    StatusPill(text: "专注陪伴中", symbol: "moon.zzz", tint: DSColor.secondaryAccent)
                } else {
                    StatusPill(text: relationship.stage.label, symbol: "heart.fill", tint: DSColor.emotionAccent)
                }
                Spacer()
                IconButton(symbol: "rectangle.expand.vertical", label: "展开窗口") {
                    uiState.setWindowMode(.compact)
                    setWindowMode(.compact)
                }
            }

            primaryLine

            HStack(spacing: DSSpacing.s) {
                if focus.isActive {
                    Button(focus.isRunning ? "暂停" : "继续") {
                        if focus.isRunning { focus.pause(); sendPetIntent(.focusPaused) }
                        else { focus.resume(); sendPetIntent(.focusStarted) }
                    }.buttonStyle(PrimaryButtonStyle())
                } else {
                    Button("专注 25 分钟") {
                        model.startFocus(mode: .pom25, task: nil)
                        sendPetIntent(.focusStarted)
                    }.buttonStyle(PrimaryButtonStyle())
                }
                Spacer()
            }
        }
        .padding(DSSpacing.m)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(DSColor.appBackground)
    }

    @ViewBuilder private var primaryLine: some View {
        if focus.isActive {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Text(focus.clockText).font(DSFont.numericDisplay(26))
                    .foregroundStyle(focus.isOvertime ? DSColor.warning : DSColor.textPrimary)
                Text(focus.phase.label).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                Spacer()
            }
            .accessibilityElement(children: .combine)
        } else if let task = model.topOpenTasks.first {
            Text(task.title).font(DSFont.body).foregroundStyle(DSColor.textPrimary).lineLimit(1)
        } else {
            Text("今天还很空闲").font(DSFont.body).foregroundStyle(DSColor.textSecondary)
        }
    }
}

/// 窗口形态切换菜单。切换经环境闭包到达持有 NSWindow 的控制器。
private struct WindowModeMenu: View {
    @ObservedObject var uiState: AppUIStateStore
    @Environment(\.setWindowMode) private var setWindowMode
    private var mode: WindowMode { WindowMode(rawValue: uiState.windowModeRaw) ?? .compact }
    var body: some View {
        Menu {
            ForEach([WindowMode.mini, .compact, .expanded], id: \.self) { m in
                Button {
                    uiState.setWindowMode(m)
                    setWindowMode(m)
                } label: {
                    Label(m.label, systemImage: mode == m ? "checkmark" : m.symbol)
                }
            }
        } label: {
            Image(systemName: mode.symbol).font(.system(size: 13, weight: .medium))
        }
        .menuStyle(.borderlessButton)
        .help("切换窗口形态")
        .accessibilityLabel("窗口形态：\(mode.label)")
    }
}
