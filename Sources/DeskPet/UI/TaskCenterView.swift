import AppKit
import SwiftUI
import UniformTypeIdentifiers
import PetAgentRuntime
import AICore

private enum TaskCenterFilter: String, CaseIterable, Identifiable {
    case running
    case waiting
    case completed
    case failed
    case all

    var id: String { rawValue }
    var title: String {
        switch self {
        case .running: return "正在执行"
        case .waiting: return "等待处理"
        case .completed: return "已完成"
        case .failed: return "失败"
        case .all: return "全部任务"
        }
    }
}

private enum TaskCenterTimeFilter: String, CaseIterable, Identifiable {
    case all
    case today
    case week
    case month

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "全部时间"
        case .today: return "今天"
        case .week: return "7 天"
        case .month: return "30 天"
        }
    }
}

private enum TaskCenterOriginFilter: String, CaseIterable, Identifiable {
    case all
    case chat
    case quickChat
    case scheduled
    case retry
    case system

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "全部来源"
        case .chat: return "聊天"
        case .quickChat: return "快捷聊天"
        case .scheduled: return "定时"
        case .retry: return "重试"
        case .system: return "系统"
        }
    }
}

/// P17 / R1-09 — provider filter is no longer a hard-coded enum. Instead we keep an
/// `all` pseudo-case and resolve per-provider cases dynamically from
/// `ProviderStore.providers` so the menu reflects whatever the user has configured.
/// The menu itself is built in `providerPickerCases()` so adding a provider
/// automatically adds a filter row (see LC-03 in the audit).
private enum TaskCenterProviderFilter: Hashable {
    case all
    case provider(String)     // ProviderConfig.id (String)
    case other                 // Catch-all for unknown / unset providers

    var id: String {
        switch self {
        case .all: return "all"
        case .other: return "other"
        case .provider(let id): return "provider-\(id)"
        }
    }
    var title: String {
        switch self {
        case .all: return "全部服务"
        case .other: return "其他/未知"
        case .provider(let id):
            // Resolved at the call site via `title(_:providers:)` so it stays decoupled
            // from the concrete `ProviderStore` type. This default is only used by
            // `Identifiable` conformers; menu labels go through `title(_:providers:)`.
            return id
        }
    }

    /// P17 / LC-03 — build the filter cases for a given provider list. Returns at
    /// minimum `[.all, .other]` plus one `.provider(id)` per configured provider.
    static func cases(for providers: [ProviderConfig]) -> [TaskCenterProviderFilter] {
        var cases: [TaskCenterProviderFilter] = [.all]
        cases.append(contentsOf: providers.map { .provider($0.id) })
        cases.append(.other)
        return cases
    }

    /// P17 / LC-03 — resolve the display title for a case against the live
    /// `ProviderStore`. Used by the filter picker so menu rows show the configured
    /// provider display names (not raw UUIDs).
    static func title(_ filter: TaskCenterProviderFilter, providers: [ProviderConfig]) -> String {
        switch filter {
        case .all: return "全部服务"
        case .other: return "其他/未知"
        case .provider(let id):
            return providers.first(where: { $0.id == id })?.displayName ?? "其他/未知"
        }
    }
}

struct TaskCenterView: View {
    @ObservedObject var chat: ChatModel
    @ObservedObject var activityStore: AgentTaskActivityStore
    @ObservedObject var providers: ProviderStore
    var onOpenChat: () -> Void
    var onResultInteraction: (AgentResultInteractionEvent) -> Void = { _ in }

    @State private var filter: TaskCenterFilter = .running
    @State private var selectedTaskID: UUID?
    @State private var replayState: AgentTimelineReplayState?
    @State private var diagnosticExportMessage: String?
    @State private var searchText = ""
    @State private var timeFilter: TaskCenterTimeFilter = .all
    @State private var originFilter: TaskCenterOriginFilter = .all
    @State private var providerFilter: TaskCenterProviderFilter = .all
    // P17 / AT-01, AT-02, DS-01 — developer-only details (UUIDs, raw provider/model,
    // failure enum rawValue, replay transport, diagnostic export) are hidden behind a
    // collapsed-by-default disclosure. Default visibility is `false`; a11y id
    // `task.developerDetails` is preserved on the disclosure for test stability.
    @State private var showDeveloperDetails: Bool = false

    private var filteredTasks: [AgentTaskActivitySnapshot] {
        let tasks: [AgentTaskActivitySnapshot]
        switch filter {
        case .running:
            tasks = activityStore.tasks.filter { [.created, .queued, .planning, .running, .synthesizing, .paused, .interrupted].contains($0.status) }
        case .waiting:
            tasks = activityStore.tasks.filter { [.waitingForApproval, .waitingForPermission, .waitingForUser].contains($0.status) }
        case .completed:
            tasks = activityStore.tasks.filter { $0.status == .succeeded || $0.status == .partiallySucceeded }
        case .failed:
            tasks = activityStore.tasks.filter { $0.status == .failed || $0.status == .cancelled }
        case .all:
            tasks = activityStore.tasks
        }
        return tasks.filter(matchesSearch)
            .filter(matchesTime)
            .filter(matchesOrigin)
            .filter(matchesProvider)
    }

    private var selectedTask: AgentTaskActivitySnapshot? {
        if let selectedTaskID, let found = activityStore.task(id: selectedTaskID) { return found }
        return filteredTasks.first
    }

    var body: some View {
        ControlPanelPageLayout(maxWidth: 920, spacing: DSSpacing.l) {
            summaryBand
            taskWorkspace
        }
    }

    private var taskWorkspace: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: DSSpacing.m) {
                filters
                    .frame(width: 132)
                taskList
                    .frame(minWidth: 220, maxWidth: 300)
                taskDetail
                    .frame(minWidth: 280, maxWidth: .infinity)
            }
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                filters
                    .frame(maxWidth: .infinity, alignment: .leading)
                taskDetail
                taskList
            }
        }
    }

    private var summaryBand: some View {
        DashboardSection(title: "任务中心",
                         subtitle: "查看运行中、等待处理和已完成的安全任务活动") {
            HStack(spacing: DSSpacing.s) {
                MetricChip(label: "正在执行", value: "\(activityStore.activeTasks.count)", symbol: "waveform.path.ecg")
                MetricChip(label: "等待处理", value: "\(activityStore.waitingTasks.count)", symbol: "lock.shield")
                MetricChip(label: "历史", value: "\(activityStore.recentTerminalTasks.count)", symbol: "clock.arrow.circlepath")
            }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            ForEach(TaskCenterFilter.allCases) { item in
                Button {
                    filter = item
                    selectedTaskID = filteredTasks.first?.taskID
                } label: {
                    HStack(spacing: DSSpacing.s) {
                        Image(systemName: symbol(for: item))
                            .font(.system(size: 12, weight: .medium))
                            .frame(width: 16)
                        Text(item.title)
                            .font(DSFont.caption)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, DSSpacing.s)
                    .padding(.vertical, 7)
                    .foregroundStyle(filter == item ? DSColor.primaryAccent : DSColor.textSecondary)
                    .background(DSColor.token(.primaryAccent).opacity(filter == item ? 0.10 : 0),
                                in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
                    // P22 — liquid-glass tint on the selected filter so the
                    // active filter reads as a glassy chip rather than a flat
                    // accent fill. Reduce Transparency callers (handled by
                    // `liquidGlassTint`) get a flat fallback.
                    .liquidGlassTint(DSColor.primaryAccent,
                                     opacity: filter == item ? 0.10 : 0)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
            }
        }
    }

    private var taskList: some View {
        DashboardSection(title: "任务列表", subtitle: emptyListText) {
            VStack(alignment: .leading, spacing: DSSpacing.xs) {
                TextField("搜索任务", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                HStack(spacing: DSSpacing.xs) {
                    Picker("", selection: $timeFilter) {
                        ForEach(TaskCenterTimeFilter.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 112)
                    Picker("", selection: $originFilter) {
                        ForEach(TaskCenterOriginFilter.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 118)
                    Picker("", selection: $providerFilter) {
                        // R1-09 — picker rows are built from the live `ProviderStore`
                        // plus `.all` / `.other`; previously the cases were hardcoded to
                        // `minimax/ollama/other` and never reflected the user's config.
                        ForEach(TaskCenterProviderFilter.cases(for: providers.providers), id: \.id) { item in
                            Text(TaskCenterProviderFilter.title(item, providers: providers.providers))
                                .tag(item)
                        }
                    }
                    .labelsHidden()
                }
            }
            if filteredTasks.isEmpty {
                EmptyStateView(symbol: "tray",
                               title: emptyListText,
                               message: "任务活动会在这里出现") {
                    Button("打开聊天") { onOpenChat() }
                        .buttonStyle(PrimaryButtonStyle())
                }
                .frame(minHeight: 180)
            } else {
                VStack(spacing: DSSpacing.xs) {
                    ForEach(filteredTasks) { task in
                        taskRow(task)
                    }
                }
            }
        }
        .accessibilityIdentifier("task.list")
    }

    private var taskDetail: some View {
        DashboardSection(title: "任务详情",
                         subtitle: selectedTask == nil ? "选择一个任务查看安全时间线" : nil) {
            if let task = selectedTask, let run = task.latestRun {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    HStack(alignment: .center, spacing: DSSpacing.s) {
                        StatusPill(text: statusText(run.status),
                                   symbol: statusSymbol(run.status),
                                   tint: statusTint(run.status))
                        if let progressText = progressText(run) {
                            StatusPill(text: progressText, symbol: "checklist", tint: DSColor.secondaryAccent)
                        }
                        Spacer()
                    }

                    if let resultDocument = run.resultDocument {
                        resultPanel(resultDocument)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text(run.userVisibleEvents.first?.presentation.title ?? "任务")
                            .font(DSFont.cardTitle)
                            .foregroundStyle(DSColor.textPrimary)
                            .lineLimit(2)
                        Text(dateSummary(run))
                            .font(DSFont.caption)
                            .foregroundStyle(DSColor.textSecondary)
                    }

                    actionRow(task, run: run)

                    developerDetailsDisclosure(task: task, run: run)

                    Divider().overlay(DSColor.border)

                    VStack(alignment: .leading, spacing: DSSpacing.s) {
                        SectionHeader("安全事件时间线")
                        ForEach(run.userVisibleEvents.suffix(24)) { event in
                            eventRow(event)
                        }
                    }
                }
                .task(id: task.taskID) {
                    await loadReplay(taskID: task.taskID)
                }
            } else {
                EmptyStateView(symbol: "list.bullet.rectangle",
                               title: "暂无任务详情",
                               message: "运行任务、批准请求和历史记录会显示在这里") {
                    EmptyView()
                }
                .frame(minHeight: 260)
            }
        }
        .accessibilityIdentifier("task.detail")
    }

    private func replayPanel(task: AgentTaskActivitySnapshot, run: AgentTaskRunActivity) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Divider().overlay(DSColor.border)
            HStack(spacing: DSSpacing.s) {
                SectionHeader("时间线回放")
                Spacer()
                Button {
                    replayState = replayState?.restart()
                } label: {
                    Image(systemName: "backward.end")
                }
                .buttonStyle(.plain)
                .help("回到开始")
                Button {
                    replayState = replayState?.pause()
                } label: {
                    Image(systemName: "pause.fill")
                }
                .buttonStyle(.plain)
                .help("暂停")
                Button {
                    replayState = replayState?.play().nextFrame()
                } label: {
                    Image(systemName: "play.fill")
                }
                .buttonStyle(.plain)
                .help("播放下一步")
                Button {
                    replayState = replayState?.jumpToFailure()
                } label: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .buttonStyle(.plain)
                .help("跳到失败")
                Button {
                    replayState = replayState?.jumpToEnd()
                } label: {
                    Image(systemName: "forward.end")
                }
                .buttonStyle(.plain)
                .help("跳到结束")
            }

            HStack(spacing: DSSpacing.s) {
                ForEach(AgentReplayFilter.allCases, id: \.self) { item in
                    Button(replayFilterTitle(item)) {
                        replayState = replayState?.withFilter(item)
                    }
                    .buttonStyle(.plain)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(replayState?.filter == item ? DSColor.primaryAccent : DSColor.textSecondary)
                }
                Spacer()
                Button("导出诊断") {
                    exportDiagnostic(taskID: task.taskID, runID: run.runID)
                }
                .buttonStyle(SecondaryButtonStyle())
            }

            if let focus = replayState?.failureFocus() {
                HStack(alignment: .top, spacing: DSSpacing.s) {
                    Image(systemName: "scope")
                        .foregroundStyle(DSColor.warning)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("失败定位：\(focus.phase)")
                            .font(DSFont.caption)
                            .foregroundStyle(DSColor.textPrimary)
                        Text("\(focus.category) · \(focus.suggestedAction)")
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textSecondary)
                    }
                }
            }

            if let replayState {
                let items = AgentActivityReducer.reduce(events: replayState.visibleEvents, visibility: .user)
                if items.isEmpty {
                    Text("此任务创建于详细时间线功能启用之前")
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                } else {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(items.suffix(10)) { item in
                            replayItemRow(item)
                        }
                    }
                }
            }

            if let diagnosticExportMessage {
                Text(diagnosticExportMessage)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
            }
        }
    }

    private func inspector(_ task: AgentTaskActivitySnapshot, run: AgentTaskRunActivity) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            SectionHeader("开发者信息")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), alignment: .leading)], alignment: .leading, spacing: DSSpacing.xs) {
                inspectorMetric("来源", originText(run.origin))
                inspectorMetric("Provider", providerText(run))
                inspectorMetric("运行", String(run.runID.uuidString.prefix(8)))
                inspectorMetric("任务", String(task.taskID.uuidString.prefix(8)))
                inspectorMetric("重试", "\(max(0, task.runs.count - 1))")
                inspectorMetric("事件", "\(run.events.count)")
                if let duration = durationText(run) {
                    inspectorMetric("耗时", duration)
                }
                if let failure = run.failureCategory {
                    inspectorMetric("失败分类", failure.rawValue)
                }
            }
            .padding(DSSpacing.s)
            .background(DSColor.appBackground.opacity(0.55),
                        in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
            replayPanel(task: task, run: run)
        }
        .accessibilityIdentifier("task.developerDetails")
    }

    /// P17 / AT-01, AT-02, DS-01 — wraps the developer-only details (Inspector + replay
    /// tooling + diagnostic export) in a collapsed-by-default disclosure.
    @ViewBuilder
    private func developerDetailsDisclosure(task: AgentTaskActivitySnapshot,
                                            run: AgentTaskRunActivity) -> some View {
        DisclosureGroup(isExpanded: $showDeveloperDetails) {
            inspector(task, run: run)
                .padding(.top, DSSpacing.s)
        } label: {
            HStack(spacing: DSSpacing.s) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(DSColor.textSecondary)
                Text("开发者信息")
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
                Text("(UUID、时间线回放、诊断导出)")
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
            }
        }
        .accessibilityIdentifier("task.developerDetailsDisclosure")
    }

    private func inspectorMetric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textTertiary)
            Text(value)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textPrimary)
                .lineLimit(1)
        }
    }

    private func resultPanel(_ document: AgentResultDocument) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            SectionHeader("任务结果")
            if isLocalDiscoveryDocument(document) {
                LocalDiscoveryResultContainerView(taskID: document.taskID,
                                                  runID: document.runID,
                                                  store: chat.localDiscoveryPresentationStore,
                                                  placeHandoffViewModel: chat.placeHandoffViewModel,
                                                  layout: .wide,
                                                  recoveredFromCheckpoint: true,
                                                  developerMode: false)
            } else {
                AgentResultView(
                    document: document,
                    onAction: { action in
                        let event = AgentResultInteractionEvent(
                            taskID: document.taskID,
                            runID: document.runID,
                            documentID: document.id,
                            componentID: "action-row",
                            actionID: action.id,
                            payload: .object([
                                "toolID": .string(action.toolID.rawValue),
                                "requiresApproval": .bool(action.requiresApproval)
                            ]))
                        onResultInteraction(event)
                        // P17 / AT-03 — silent success on ordinary taps.
                    },
                    onInteraction: { event in
                        onResultInteraction(event)
                        // P17 / AT-03 — silent success on consumer interactions.
                    })
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task.result")
    }

    private func isLocalDiscoveryDocument(_ document: AgentResultDocument) -> Bool {
        document.metadata["workflow"] == "localDiscovery" || document.id.hasPrefix("local-discovery")
    }

    private func taskRow(_ task: AgentTaskActivitySnapshot) -> some View {
        Button {
            selectedTaskID = task.taskID
        } label: {
            HStack(alignment: .top, spacing: DSSpacing.s) {
                Image(systemName: statusSymbol(task.status))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(statusTint(task.status))
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textPrimary)
                        .lineLimit(1)
                    Text(rowSubtitle(task))
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(DSSpacing.s)
            .background(DSColor.appBackground.opacity(selectedTaskID == task.taskID ? 0.95 : 0.55),
                        in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                    .strokeBorder(selectedTaskID == task.taskID ? DSColor.primaryAccent.opacity(0.45) : DSColor.border,
                                  lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(task.title) \(rowSubtitle(task))")
        .accessibilityIdentifier("task.item.\(task.taskID.uuidString)")
    }

    private func actionRow(_ task: AgentTaskActivitySnapshot, run: AgentTaskRunActivity) -> some View {
        HStack(spacing: DSSpacing.s) {
            if [.waitingForApproval, .waitingForPermission, .waitingForUser].contains(run.status) {
                Button("允许一次") { chat.approveTask(task.taskID) }
                    .buttonStyle(PrimaryButtonStyle())
                Button("本会话都允许") { chat.approveTask(task.taskID) }
                    .buttonStyle(SecondaryButtonStyle())
                Button("拒绝") { chat.cancelTask(task.taskID) }
                    .buttonStyle(SecondaryButtonStyle())
            } else if run.status.isTerminal {
                Button("重试") { chat.retryTask(task.taskID) }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(run.userMessageID == nil)
            } else if run.canShowStopAction {
                Button("停止") { chat.stopTask(task.taskID) }
                    .buttonStyle(SecondaryButtonStyle())
            }
            Button("回到聊天") { onOpenChat() }
                .buttonStyle(SecondaryButtonStyle())
            Button("删除历史") { chat.deleteTaskHistory(task.taskID) }
                .buttonStyle(SecondaryButtonStyle())
        }
    }

    private func eventRow(_ event: AgentTaskActivityEvent) -> some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Image(systemName: eventSymbol(event.kind))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(eventTint(event.kind))
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.presentation.title)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                if let detail = event.presentation.detail {
                    Text(detail)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            Text(event.timestamp, style: .time)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textTertiary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(event.toolID == nil ? "task.activity" : "task.toolID")
    }

    private func replayItemRow(_ item: AgentActivityItem) -> some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Image(systemName: replaySymbol(item.status))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(replayTint(item.status))
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title)，\(replayStatusText(item.status))")
    }

    private var emptyListText: String {
        switch filter {
        case .running: return "暂无运行任务"
        case .waiting: return "暂无等待处理"
        case .completed: return "暂无已完成任务"
        case .failed: return "暂无失败任务"
        case .all: return "暂无历史记录"
        }
    }

    private func matchesSearch(_ task: AgentTaskActivitySnapshot) -> Bool {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return true }
        let haystack = [
            task.title,
            task.latestRun?.currentStepTitle,
            task.latestRun?.userVisibleTerminalSummary,
            task.latestRun?.providerKind,
            task.latestRun?.modelID,
            task.latestRun?.userVisibleEvents.last?.presentation.title,
            task.latestRun?.userVisibleEvents.last?.presentation.detail
        ]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
        return haystack.contains(needle)
    }

    private func matchesTime(_ task: AgentTaskActivitySnapshot) -> Bool {
        guard timeFilter != .all else { return true }
        let interval: TimeInterval
        switch timeFilter {
        case .all:
            return true
        case .today:
            return Calendar.current.isDateInToday(task.updatedAt)
        case .week:
            interval = 7 * 24 * 60 * 60
        case .month:
            interval = 30 * 24 * 60 * 60
        }
        return task.updatedAt >= Date().addingTimeInterval(-interval)
    }

    private func matchesOrigin(_ task: AgentTaskActivitySnapshot) -> Bool {
        guard originFilter != .all else { return true }
        let origin = task.latestRun?.origin ?? .system
        switch originFilter {
        case .all: return true
        case .chat: return origin == .chat
        case .quickChat: return origin == .quickChat
        case .scheduled: return origin == .scheduled
        case .retry: return origin == .retry
        case .system: return origin == .system
        }
    }

    private func matchesProvider(_ task: AgentTaskActivitySnapshot) -> Bool {
        guard providerFilter != .all else { return true }
        let providerText = [task.latestRun?.providerKind, task.latestRun?.modelID]
            .compactMap { $0?.lowercased() }
            .joined(separator: " ")
        switch providerFilter {
        case .all:
            return true
        case .other:
            // Catch-all: provider unset or doesn't match any configured case.
            return providerText.isEmpty || providers.providers.isEmpty
        case .provider(let id):
            // Match the task's provider by id first, fall back to name substring so
            // legacy run records (no providerID) still match by display name.
            if let provider = providers.provider(id: id) {
                if task.latestRun?.providerKind == provider.id { return true }
                if providerText.contains(provider.displayName.lowercased()) ||
                    providerText.contains(provider.type.rawValue.lowercased()) {
                    return true
                }
            }
            return false
        }
    }

    private func rowSubtitle(_ task: AgentTaskActivitySnapshot) -> String {
        guard let run = task.latestRun else { return "暂无运行记录" }
        if let terminal = run.userVisibleTerminalSummary, run.status.isTerminal {
            return terminal
        }
        if let latest = run.userVisibleEvents.last?.presentation.title {
            return latest
        }
        let progress = progressText(run).map { " · \($0)" } ?? ""
        return "\(statusText(run.status))\(progress)"
    }

    private func progressText(_ run: AgentTaskRunActivity) -> String? {
        guard let total = run.totalStepCount, total > 0 else { return nil }
        return "\(run.completedStepCount)/\(total)"
    }

    private func dateSummary(_ run: AgentTaskRunActivity) -> String {
        if let completedAt = run.completedAt {
            return "开始 \(run.createdAt.formatted(date: .omitted, time: .shortened)) · 结束 \(completedAt.formatted(date: .omitted, time: .shortened))"
        }
        return "开始 \(run.createdAt.formatted(date: .omitted, time: .shortened))"
    }

    private func durationText(_ run: AgentTaskRunActivity) -> String? {
        guard let completedAt = run.completedAt else { return nil }
        let seconds = max(0, completedAt.timeIntervalSince(run.createdAt))
        if seconds < 1 { return "<1s" }
        if seconds < 60 { return "\(Int(seconds))s" }
        return "\(Int(seconds / 60))m \(Int(seconds) % 60)s"
    }

    private func originText(_ origin: AgentTaskOrigin?) -> String {
        switch origin ?? .system {
        case .chat: return "聊天"
        case .quickChat: return "快捷聊天"
        case .scheduled: return "定时"
        case .retry: return "重试"
        case .system: return "系统"
        }
    }

    private func providerText(_ run: AgentTaskRunActivity) -> String {
        if let provider = run.providerKind, let model = run.modelID { return "\(provider) / \(model)" }
        if let provider = run.providerKind { return provider }
        if let model = run.modelID { return model }
        return "未知"
    }

    private func statusText(_ status: AgentTaskStatus) -> String {
        switch status {
        case .created: return "已创建"
        case .queued: return "等待中"
        case .planning: return "正在处理"
        case .waitingForApproval, .waitingForPermission: return "等待你的确认"
        case .waitingForUser: return "等待用户操作"
        case .running: return "正在处理"
        case .paused: return "已暂停"
        case .synthesizing: return "正在整理结果"
        case .partiallySucceeded: return "部分完成"
        case .succeeded: return "已完成"
        case .failed: return "操作失败"
        case .cancelled: return "已停止"
        case .interrupted: return "已中断"
        case .unknown: return "未知"
        }
    }

    private func statusSymbol(_ status: AgentTaskStatus) -> String {
        switch status {
        case .waitingForApproval, .waitingForPermission, .waitingForUser: return "lock.shield"
        case .succeeded: return "checkmark.circle.fill"
        case .partiallySucceeded: return "checkmark.circle.trianglebadge.exclamationmark"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "minus.circle.fill"
        case .paused: return "pause.circle.fill"
        case .interrupted: return "bolt.horizontal.circle.fill"
        case .synthesizing: return "text.bubble"
        default: return "waveform.path.ecg"
        }
    }

    private func statusTint(_ status: AgentTaskStatus) -> Color {
        switch status {
        case .failed:
            // R1-10 — failures tint destructive (red) so the consumer can distinguish
            // them from waiting/paused/interrupted states which remain warning.
            return DSColor.destructive
        case .waitingForApproval, .waitingForPermission, .waitingForUser, .paused, .interrupted:
            return DSColor.warning
        case .succeeded: return DSColor.success
        case .partiallySucceeded: return DSColor.warning
        case .cancelled: return DSColor.textTertiary
        default: return DSColor.secondaryAccent
        }
    }

    private func symbol(for filter: TaskCenterFilter) -> String {
        switch filter {
        case .running: return "waveform.path.ecg"
        case .waiting: return "lock.shield"
        case .completed: return "checkmark.circle"
        case .failed: return "exclamationmark.triangle"
        case .all: return "tray.full"
        }
    }

    private func eventSymbol(_ kind: AgentTaskEventKind) -> String {
        switch kind {
        case .taskSucceeded, .stepSucceeded, .approvalGranted, .synthesisSucceeded, .userInteractionResolved, .resultProduced:
            return "checkmark.circle.fill"
        case .taskFailed, .stepFailed, .approvalDenied, .replanFailed:
            return "exclamationmark.triangle.fill"
        case .taskCancelled:
            return "minus.circle.fill"
        case .approvalRequested, .userInteractionRequested:
            return "lock.shield"
        default:
            return "circle"
        }
    }

    private func eventTint(_ kind: AgentTaskEventKind) -> Color {
        switch kind {
        case .taskSucceeded, .stepSucceeded, .approvalGranted, .synthesisSucceeded, .userInteractionResolved, .resultProduced:
            return DSColor.success
        case .taskFailed, .stepFailed, .approvalDenied, .replanFailed:
            // R1-10 — failure events tint destructive (red) to match the destructive
            // tint used by TaskActivityCard and ChatActivityBubble (EX-02).
            return DSColor.destructive
        case .taskCancelled:
            return DSColor.textTertiary
        case .userInteractionRequested:
            return DSColor.warning
        default:
            return DSColor.secondaryAccent
        }
    }

    private func replayFilterTitle(_ filter: AgentReplayFilter) -> String {
        switch filter {
        case .all: return "全部"
        case .toolsOnly: return "工具"
        case .errorsOnly: return "错误"
        case .userActionsOnly: return "用户操作"
        }
    }

    private func replaySymbol(_ status: AgentActivityStatus) -> String {
        switch status {
        case .pending: return "circle"
        case .running: return "circle.dotted"
        case .waiting: return "lock.shield"
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "minus.circle.fill"
        case .skipped: return "forward.end"
        }
    }

    private func replayTint(_ status: AgentActivityStatus) -> Color {
        switch status {
        case .succeeded: return DSColor.success
        case .failed, .waiting: return DSColor.warning
        case .cancelled, .skipped: return DSColor.textTertiary
        default: return DSColor.secondaryAccent
        }
    }

    private func replayStatusText(_ status: AgentActivityStatus) -> String {
        switch status {
        case .pending: return "等待中"
        case .running: return "执行中"
        case .waiting: return "等待确认"
        case .succeeded: return "已完成"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        case .skipped: return "已跳过"
        }
    }

    private func loadReplay(taskID: UUID) async {
        let events = await activityStore.runEvents(taskID: taskID)
        await MainActor.run {
            replayState = AgentTimelineReplayState(taskID: taskID, events: events)
            diagnosticExportMessage = nil
        }
    }

    private func exportDiagnostic(taskID: UUID, runID: UUID?) {
        Task {
            let events = await activityStore.runEvents(taskID: taskID)
            let report = AgentDiagnosticExporter.report(taskID: taskID,
                                                        runID: runID,
                                                        events: events,
                                                        appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
                                                        buildVersion: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
                                                        featureFlags: ["p5-agent-observability"])
            let data: Data
            do {
                data = try AgentDiagnosticExporter.export(report, format: .markdown)
            } catch {
                await MainActor.run { diagnosticExportMessage = "诊断导出失败" }
                return
            }
            await MainActor.run {
                let panel = NSSavePanel()
                panel.canCreateDirectories = true
                panel.nameFieldStringValue = "DeskPet-Agent-Diagnostic-\(taskID.uuidString.prefix(8)).md"
                panel.allowedContentTypes = [.plainText]
                if panel.runModal() == .OK, let url = panel.url {
                    do {
                        try data.write(to: url, options: .atomic)
                        diagnosticExportMessage = "诊断报告已导出"
                    } catch {
                        diagnosticExportMessage = "诊断导出失败"
                    }
                }
            }
        }
    }
}
