import SwiftUI
import AICore

// P5.1 — "今日"页面重做。清晰层级：问候 → 当前/下一项任务（或设计完整空状态）→ 今日进度（仅在有真实
// 任务时）→ 快速输入 → 任务列表。无假数据：进度只用真实 done/total；无任务时显示空状态而非占位。

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var prefs: PreferencesModel
    @ObservedObject var providers: ProviderStore
    @ObservedObject var runtime: CompanionAgentRuntimeModel
    @ObservedObject var uiState: AppUIStateStore
    @Environment(\.sendPetIntent) private var sendPetIntent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var nlText = ""
    @State private var showingNewTask = false

    private var openTasks: [PetTask] { model.topOpenTasks }
    private var doneCount: Int { model.tasks.filter(\.done).count }
    private var totalCount: Int { model.tasks.count }

    var body: some View {
        ControlPanelPageLayout {
            statusOverview
            quickInput
            if let draft = model.draft { DraftConfirmView(draft: draft) }

            if model.tasks.isEmpty {
                emptyState
            } else {
                if let current = openTasks.first { currentTaskCard(current) }
                progressCard
                taskList
            }
        }
    }

    private var statusOverview: some View {
        let status = runtime.runtimeStatus()
        return DashboardSection(title: greetingText, subtitle: contextLine) {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                // P17 / VH-03 — only the "桌宠状态" chip stays in-page; the header pill is
                // the authoritative readiness indicator. The duplicate "模型状态" pill was
                // removed so the user sees the same readiness signal once per screen.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: DSSpacing.s)],
                          alignment: .leading,
                          spacing: DSSpacing.s) {
                    MetricChip(label: "桌宠状态", value: status.currentMode.label, symbol: "pawprint")
                }
                Text(status.lastError ?? "今日建议：先确认模型和权限，再开始一段轻量陪伴。")
                    .font(DSFont.secondaryBody)
                    .foregroundStyle(status.lastError == nil ? DSColor.textSecondary : DSColor.warning)
                ViewThatFits(in: .horizontal) {
                    statusActionsRow
                    statusActionsGrid
                }
            }
        }
    }

    private var statusActionsRow: some View {
        HStack(spacing: DSSpacing.s) {
            statusActionButtons
        }
    }

    private var statusActionsGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 108), spacing: DSSpacing.s)],
                  alignment: .leading,
                  spacing: DSSpacing.s) {
            statusActionButtons
        }
    }

    @ViewBuilder
    private var statusActionButtons: some View {
        Button("开始专注") {
            model.startFocus(mode: .pom25, task: model.topOpenTasks.first)
            runtime.startFocusSession()
            sendPetIntent(.focusStarted)
        }.buttonStyle(PrimaryButtonStyle())
        Button("打开聊天") { uiState.setSection(.chat) }
            .buttonStyle(SecondaryButtonStyle())
        Button("配置模型") { uiState.setSection(.models) }
            .buttonStyle(SecondaryButtonStyle())
        Button("检查权限") { uiState.setSection(.privacy) }
            .buttonStyle(SecondaryButtonStyle())
    }

    // MARK: 问候

    private var greetingText: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<11: return "上午好"
        case 11..<14: return "中午好"
        case 14..<18: return "下午好"
        case 18..<23: return "晚上好"
        default: return "夜深了"
        }
    }
    private var greetingSymbol: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<11: return "sunrise"
        case 11..<18: return "sun.max"
        case 18..<23: return "sunset"
        default: return "moon.stars"
        }
    }
    private var contextLine: String {
        if model.tasks.isEmpty { return "今天还没有安排，慢慢来。" }
        let open = openTasks.count
        return open == 0 ? "今天的任务都完成啦，干得漂亮。" : "还有 \(open) 项待办，一起加油。"
    }

    // MARK: 当前任务

    private func currentTaskCard(_ task: PetTask) -> some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                HStack {
                    StatusPill(text: model.focus.isActive ? "进行中" : "下一项", symbol: model.focus.isActive ? "timer" : "arrow.right",
                               tint: model.focus.isActive ? DSColor.secondaryAccent : DSColor.primaryAccent)
                    Spacer()
                }
                Text(task.title).font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                taskMeta(task)
                HStack(spacing: DSSpacing.s) {
                    Button("开始专注") {
                        model.startFocus(mode: .pom25, task: task)
                        sendPetIntent(.focusStarted)
                    }.buttonStyle(PrimaryButtonStyle())
                    Button("完成") {
                        complete(task)
                    }.buttonStyle(SecondaryButtonStyle())
                    Spacer()
                }
            }
        }
    }

    // MARK: 今日进度（真实 done/total）

    private var progressCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("任务进度", subtitle: "已完成 \(doneCount) / \(totalCount)")
                DSProgressBar(value: totalCount > 0 ? Double(doneCount) / Double(totalCount) : 0)
            }
        }
    }

    // MARK: 快速输入

    private var quickInput: some View {
        CardContainer(padding: DSSpacing.m) {
            ViewThatFits(in: .horizontal) {
                quickInputRow
                quickInputStack
            }
        }
        .sheet(isPresented: $showingNewTask) { NewTaskSheet() }
    }

    private var quickInputRow: some View {
        HStack(spacing: DSSpacing.s) {
            Image(systemName: "sparkles").foregroundStyle(DSColor.secondaryAccent).accessibilityHidden(true)
            TextField("自然语言新建，如：明晚前复习积分，两轮45分钟", text: $nlText)
                .textFieldStyle(.plain)
                .font(DSFont.body)
                .onSubmit(parse)
                .accessibilityLabel("新建任务输入框")
            Button("解析", action: parse)
                .buttonStyle(SecondaryButtonStyle())
                .disabled(nlText.trimmingCharacters(in: .whitespaces).isEmpty)
            IconButton(symbol: "plus", label: "手动新建任务") { showingNewTask = true }
        }
    }

    private var quickInputStack: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(spacing: DSSpacing.s) {
                Image(systemName: "sparkles").foregroundStyle(DSColor.secondaryAccent).accessibilityHidden(true)
                TextField("自然语言新建，如：明晚前复习积分，两轮45分钟", text: $nlText)
                    .textFieldStyle(.plain)
                    .font(DSFont.body)
                    .onSubmit(parse)
                    .accessibilityLabel("新建任务输入框")
            }
            HStack(spacing: DSSpacing.s) {
                Button("解析", action: parse)
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(nlText.trimmingCharacters(in: .whitespaces).isEmpty)
                IconButton(symbol: "plus", label: "手动新建任务") { showingNewTask = true }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: 任务列表

    private var taskList: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            SectionHeader("全部任务")
            ForEach(model.tasks) { task in
                TodayTaskRow(task: task, onComplete: { complete(task) })
                    .transition(.opacity)
            }
        }
    }

    // MARK: 空状态

    private var emptyState: some View {
        CardContainer {
            EmptyStateView(symbol: "checklist",
                           title: "今天还很空闲",
                           message: "添加一项任务，或直接开始一段专注，我会陪着你。") {
                HStack(spacing: DSSpacing.s) {
                    Button("专注 25 分钟") {
                        model.startFocus(mode: .pom25, task: nil)
                        sendPetIntent(.focusStarted)
                    }.buttonStyle(PrimaryButtonStyle())
                    Button("添加任务") { showingNewTask = true }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .sheet(isPresented: $showingNewTask) { NewTaskSheet() }
    }

    // MARK: 操作

    private func parse() {
        let t = nlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        model.makeDraft(from: t)
        nlText = ""
    }

    private func complete(_ task: PetTask) {
        guard !task.done else { return }
        withAnimation(DSMotion.content(reduceMotion)) { model.toggleDone(task) }
        sendPetIntent(.taskCompleted)   // 完成反馈只在真正完成时发一次
    }

    private func taskMeta(_ task: PetTask) -> some View {
        HStack(spacing: DSSpacing.xs) {
            if let s = task.subject, !s.isEmpty { metaTag(s) }
            if let due = task.due { metaTag(TodayTaskRow.df.string(from: due)) }
            if let r = task.focusRounds, let m = task.estimatedMinutes { metaTag("\(r)×\(m)分") }
            metaTag("优先级\(task.priority.label)")
        }
    }
    private func metaTag(_ s: String) -> some View {
        Text(s).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
            .padding(.horizontal, DSSpacing.xs).padding(.vertical, 1)
            .background(DSColor.token(.textTertiary).opacity(0.12), in: Capsule())
    }

}

/// 单个任务卡片：完成状态 + 标题 + 元信息 + hover + 键盘 + VoiceOver。
struct TodayTaskRow: View {
    @EnvironmentObject var model: AppModel
    let task: PetTask
    let onComplete: () -> Void
    @State private var hovering = false
    // P20 / #5 — fires briefly when the row is just completed so a small
    // confetti burst radiates from the checkmark. Resets after 1.2s.
    @State private var burst = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let df: DateFormatter = { let f = DateFormatter(); f.dateFormat = "M/d HH:mm"; return f }()

    var body: some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Button(action: {
                if task.done { model.toggleDone(task); return }
                onComplete()
                // P20 / #5 — kick the burst off only when the user actually
                // marks it done (not when un-toggling).
                burst = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    burst = false
                }
            }) {
                Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 16))
                    .foregroundStyle(task.done ? DSColor.success : DSColor.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(task.done ? "标记为未完成" : "完成任务")

            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(DSFont.body)
                    .foregroundStyle(task.done ? DSColor.textTertiary : DSColor.textPrimary)
                    .strikethrough(task.done)
                    .lineLimit(2)
                HStack(spacing: DSSpacing.xs) {
                    if let s = task.subject, !s.isEmpty { tag(s) }
                    if let due = task.due { tag(Self.df.string(from: due)) }
                    tag("优先级\(task.priority.label)")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(DSSpacing.m)
        .background(DSColor.elevatedSurface, in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                .strokeBorder(hovering ? DSColor.token(.primaryAccent).opacity(0.4) : DSColor.border, lineWidth: 1))
        // P20 / #5 — confetti anchored to the leading edge so the burst appears
        // to fly out of the just-clicked checkmark.
        .overlay(alignment: .leading) {
            ConfettiBurst(isActive: burst,
                          particleCount: 10,
                          tint: DSColor.emotionAccent,
                          reduceMotion: reduceMotion)
                .frame(width: 28, height: 28)
                .offset(x: 14, y: 0)
        }
        .onHover { hovering = $0 }
        .contextMenu { Button("删除", role: .destructive) { model.delete(task) } }
        .accessibilityElement(children: .combine)
        .accessibilityValue(task.done ? "已完成" : "未完成")
    }

    private func tag(_ s: String) -> some View {
        Text(s).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
            .padding(.horizontal, DSSpacing.xs).padding(.vertical, 1)
            .background(DSColor.token(.textTertiary).opacity(0.12), in: Capsule())
    }
}
