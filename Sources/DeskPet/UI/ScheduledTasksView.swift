import SwiftUI
import AICore

// P5 — manage scheduled / recurring tasks. The pet runs each task's prompt through the agent when due.
// Unattended runs default to notify-only; "免确认" pre-authorizes a small reversible capability set.
// P17 / SP-01 — full re-expression onto ControlPanelPageLayout + DashboardSection + SettingsRow +
// DS buttons. No raw spacing/font literals. No .borderedProminent.
struct ScheduledTasksView: View {
    @ObservedObject var scheduler: TaskScheduler
    @State private var showingAdd = false

    /// Capabilities a user may pre-authorize for unattended runs (reversible only).
    private static let preauthorizable: [String] = ["timer.local", "reminder.local.create", "calendar.event.create"]

    var body: some View {
        ControlPanelPageLayout {
            header
            listCard
        }
        .sheet(isPresented: $showingAdd) {
            ScheduledTaskEditor(preauthorizable: Self.preauthorizable) { task in
                scheduler.add(task); showingAdd = false
            } cancel: { showingAdd = false }
        }
    }

    private var header: some View {
        DashboardSection(title: "定时任务",
                         subtitle: "到点桌宠自动执行任务的指令") {
            HStack(spacing: DSSpacing.s) {
                Text("无人值守时需确认的操作默认只提示；勾选「免确认」可让指定可逆操作自动执行。")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                Spacer(minLength: DSSpacing.s)
                Button {
                    showingAdd = true
                } label: {
                    Label("新建", systemImage: "plus")
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    @ViewBuilder
    private var listCard: some View {
        if scheduler.tasks.isEmpty {
            CardContainer {
                EmptyStateView(symbol: "alarm",
                               title: "还没有定时任务",
                               message: "点「新建」，或直接对桌宠说「以后每天早上提醒我看日历」。") {
                    Button("新建定时任务") { showingAdd = true }
                        .buttonStyle(PrimaryButtonStyle())
                }
            }
        } else {
            CardContainer {
                VStack(alignment: .leading, spacing: DSSpacing.s) {
                    ForEach(scheduler.tasks) { task in
                        taskRow(task)
                        if task.id != scheduler.tasks.last?.id {
                            Divider().overlay(DSColor.border)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func taskRow(_ task: ScheduledTask) -> some View {
        SettingsRow(title: task.title,
                    subtitle: taskSubtitle(task),
                    symbol: task.source == .agent ? "wand.and.stars" : "alarm") {
            HStack(spacing: DSSpacing.s) {
                Text(autonomyLabel(task.autonomy))
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
                Toggle("", isOn: Binding(get: { task.enabled },
                                         set: { scheduler.setEnabled(task.id, $0) }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                Button(role: .destructive) {
                    scheduler.remove(task.id)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
                .help("删除任务")
                .accessibilityLabel("删除定时任务")
            }
        }
    }

    private func taskSubtitle(_ task: ScheduledTask) -> String {
        let promptLine = task.prompt.isEmpty ? "" : task.prompt
        let metaLine = scheduleLabel(task.schedule) + nextLabel(task)
        return [promptLine, metaLine].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func autonomyLabel(_ a: ScheduledAutonomy) -> String {
        switch a {
        case .notifyOnly: return "仅通知"
        case .preauthorized(let caps): return "免确认(\(caps.count))"
        }
    }
    private func scheduleLabel(_ s: Schedule) -> String {
        switch s {
        case .oneShot(let d): return "一次性 · \(Self.df.string(from: d))"
        case .everySeconds(let sec): return "每 \(sec >= 60 ? "\(sec/60) 分钟" : "\(sec) 秒")"
        case .dailyAt(let h, let m): return String(format: "每天 %02d:%02d", h, m)
        }
    }
    private func nextLabel(_ task: ScheduledTask) -> String {
        guard task.enabled, let next = task.nextFireAt else { return " · 已停用"
        }
        return " · 下次 \(Self.df.string(from: next))"
    }
    private static let df: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "MM-dd HH:mm"; return f
    }()
}

private struct ScheduledTaskEditor: View {
    let preauthorizable: [String]
    let onSave: (ScheduledTask) -> Void
    let cancel: () -> Void

    @State private var title = ""
    @State private var prompt = ""
    @State private var kind = 0                      // 0 dailyAt, 1 everyMinutes, 2 oneShot
    @State private var hour = 9
    @State private var minute = 0
    @State private var everyMinutes = 60
    @State private var date = Date().addingTimeInterval(3600)
    @State private var preauthorize = false
    @State private var selectedCaps: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            Text("新建定时任务").font(DSFont.pageTitle).foregroundStyle(DSColor.textPrimary)
            Form {
                TextField("标题", text: $title)
                TextField("指令（桌宠到点要做的事）", text: $prompt, axis: .vertical).lineLimit(2...4)
                Picker("频率", selection: $kind) {
                    Text("每天").tag(0); Text("每隔").tag(1); Text("一次性").tag(2)
                }.pickerStyle(.segmented)
                switch kind {
                case 0:
                    HStack {
                        Stepper("时 \(hour)", value: $hour, in: 0...23)
                        Stepper("分 \(minute)", value: $minute, in: 0...59)
                    }
                case 1:
                    Stepper("每 \(everyMinutes) 分钟", value: $everyMinutes, in: 1...1440)
                default:
                    DatePicker("时间", selection: $date)
                }
                Toggle("免确认运行（自动执行可逆操作）", isOn: $preauthorize)
                if preauthorize {
                    ForEach(preauthorizable, id: \.self) { cap in
                        Toggle(capLabel(cap), isOn: Binding(
                            get: { selectedCaps.contains(cap) },
                            set: { if $0 { selectedCaps.insert(cap) } else { selectedCaps.remove(cap) } }))
                    }
                }
            }
            HStack {
                Spacer()
                Button("取消", action: cancel)
                    .buttonStyle(SecondaryButtonStyle())
                Button("保存", action: save)
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(title.isEmpty || prompt.isEmpty)
            }
        }
        .padding(DSSpacing.xl)
        .frame(width: 460)
    }

    private func save() {
        let schedule: Schedule
        switch kind {
        case 0: schedule = .dailyAt(hour: hour, minute: minute)
        case 1: schedule = .everySeconds(everyMinutes * 60)
        default: schedule = .oneShot(date)
        }
        let autonomy: ScheduledAutonomy = (preauthorize && !selectedCaps.isEmpty)
            ? .preauthorized(selectedCaps) : .notifyOnly
        onSave(ScheduledTask(title: title, prompt: prompt, schedule: schedule,
                             autonomy: autonomy, source: .user))
    }

    private func capLabel(_ cap: String) -> String {
        switch cap {
        case "timer.local": return "计时提醒"
        case "reminder.local.create": return "创建提醒"
        case "calendar.event.create": return "创建日程"
        default: return cap
        }
    }
}
