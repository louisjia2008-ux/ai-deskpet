import SwiftUI

/// Root of the standard macOS window (doc §13.1). P5.1: delegates to the character-centered
/// AppShellView (今日/专注/陪伴/记忆/设置); the character itself stays on the desktop (doc §13.3).
struct RootView: View {
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
    var body: some View {
        AppShellView(chat: chat, memory: memory, relationship: relationship,
                     prefs: prefs, providers: providers, runtime: runtime,
                     scheduler: scheduler, backup: backup,
                     uiState: uiState,
                     automationIndicatorInfo: automationIndicatorInfo,
                     diagnosticsURL: diagnosticsURL)
            .frame(minWidth: 360, minHeight: 460)
    }
}

// MARK: NL draft confirmation (used by TodayView)

struct DraftConfirmView: View {
    @EnvironmentObject var model: AppModel
    let draft: TaskDraft
    var body: some View {
        CardContainer(padding: DSSpacing.m) {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                Text("草稿（请确认）").font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                HStack(spacing: DSSpacing.s) {
                    Text(draft.title).font(DSFont.body).fontWeight(.semibold).foregroundStyle(DSColor.textPrimary)
                    if let due = draft.due { Text(TodayTaskRow.df.string(from: due)).font(DSFont.caption).foregroundStyle(DSColor.textSecondary) }
                    if let r = draft.focusRounds, let m = draft.estimatedMinutes {
                        Text("\(r)×\(m)分").font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                    }
                    Spacer()
                    Button("确认") { model.confirmDraft() }.buttonStyle(PrimaryButtonStyle())
                    Button("取消") { model.discardDraft() }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: New task sheet

struct NewTaskSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var subject = ""
    @State private var priority: TaskPriority = .normal
    @State private var hasDue = false
    @State private var due = Date()
    @State private var minutes = 45
    @State private var rounds = 1
    @State private var notes = ""

    var body: some View {
        VStack(alignment: .leading) {
            Text("新建任务").font(.headline)
            Form {
                TextField("标题", text: $title)
                TextField("科目/项目", text: $subject)
                Picker("优先级", selection: $priority) {
                    ForEach(TaskPriority.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                Toggle("截止时间", isOn: $hasDue)
                if hasDue { DatePicker("截止", selection: $due) }
                Stepper("每轮 \(minutes) 分钟", value: $minutes, in: 5...120, step: 5)
                Stepper("专注轮次 \(rounds)", value: $rounds, in: 1...8)
                TextField("备注", text: $notes)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    Button("添加") {
                        var t = PetTask(title: title.isEmpty ? "未命名任务" : title)
                        t.subject = subject.isEmpty ? nil : subject
                        t.priority = priority
                        t.due = hasDue ? due : nil
                        t.estimatedMinutes = minutes
                        t.focusRounds = rounds
                        t.notes = notes.isEmpty ? nil : notes
                        model.add(t); dismiss()
                    }.buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding()
        .frame(width: 380)
    }
}
