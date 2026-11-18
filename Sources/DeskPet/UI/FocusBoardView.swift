import SwiftUI

// P5.1 — "专注"页面重做。复用唯一的 FocusEngine（单一计时源，不在 View 层另建 Timer）。大号计时、
// 阶段、轮次、模式选择、开始/暂停/继续/跳过/结束、关联任务、当前会话概览，以及专注期间的角色陪伴状态。

struct FocusBoardView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var focus: FocusEngine
    @ObservedObject var prefs: PreferencesModel
    @Environment(\.sendPetIntent) private var sendPetIntent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var modeIndex = 0
    @State private var sessionGoal = ""
    @State private var allowEncouragement = true
    @State private var mutePetMotion = false
    @State private var customWork = 50
    @State private var customBreak = 10
    @State private var customRounds = 3
    @State private var taskTargetMinutes = 60
    @State private var selectedTaskID: UUID?

    private let modes = ["番茄 25/5", "番茄 45/10", "自定义", "任务驱动"]

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            timerCard
            if !focus.isActive { setupCard }
            sessionOverview
        }
    }

    // MARK: 计时主卡

    private var timerCard: some View {
        CardContainer {
            VStack(spacing: DSSpacing.m) {
                HStack {
                    StatusPill(text: focus.phase.label,
                               symbol: focus.isActive ? "moon.zzz" : "timer",
                               tint: focus.isActive ? DSColor.secondaryAccent : DSColor.primaryAccent)
                    Spacer()
                    if focus.totalRounds > 0 {
                        Text("第 \(focus.completedRounds)/\(focus.totalRounds) 轮")
                            .font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                    }
                }

                Text(focus.clockText)
                    .font(DSFont.numericDisplay(64))
                    .foregroundStyle(focus.isOvertime ? DSColor.warning : DSColor.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(maxWidth: .infinity, minHeight: 78, alignment: .center)
                    .accessibilityLabel("剩余时间 \(focus.clockText)")

                if focus.isActive {
                    Text("专注陪伴中 · 我会安静一会儿")
                        .font(DSFont.caption).foregroundStyle(DSColor.textTertiary)
                }

                controls
            }
            .frame(maxWidth: .infinity)
        }
        .overlay {
            // P20 / #6 — focus halo sits above the card border but below any
            // controls. Hit-test disabled so it never blocks clicks.
            FocusHaloOverlay(isActive: focus.isActive,
                             tint: DSColor.secondaryAccent,
                             reduceMotion: reduceMotion)
        }
        .alert("已到目标时长，继续吗？", isPresented: $focus.pendingContinuePrompt) {
            Button("再来一会儿") { focus.continueFocus(extraMinutes: 10) }
            Button("结束", role: .cancel) { endFocus() }
        }
    }

    private var controls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: DSSpacing.s) { controlButtons }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: DSSpacing.s)],
                      spacing: DSSpacing.s) {
                controlButtons
            }
        }
    }

    @ViewBuilder
    private var controlButtons: some View {
        if focus.isRunning {
            Button("暂停") { focus.pause(); sendPetIntent(.focusPaused) }.buttonStyle(SecondaryButtonStyle())
            Button("跳过阶段") { focus.skip() }.buttonStyle(SecondaryButtonStyle())
        } else if focus.phase == .idle || focus.phase == .finished {
            Button("开始", action: startFocus).buttonStyle(PrimaryButtonStyle())
        } else {
            Button("继续") { focus.resume(); sendPetIntent(.focusStarted) }.buttonStyle(PrimaryButtonStyle())
            Button("跳过阶段") { focus.skip() }.buttonStyle(SecondaryButtonStyle())
        }
        if focus.phase != .idle {
            Button("结束") { endFocus() }.buttonStyle(SecondaryButtonStyle())
        }
    }

    // MARK: 设置（仅未开始时）

    private var setupCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                SectionHeader("开始一段专注")
                Picker("模式", selection: $modeIndex) {
                    ForEach(modes.indices, id: \.self) { Text(modes[$0]).tag($0) }
                }.pickerStyle(.segmented).labelsHidden()

                if modeIndex == 2 {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), spacing: DSSpacing.s)],
                              alignment: .leading,
                              spacing: DSSpacing.s) {
                        Stepper("专注 \(customWork)", value: $customWork, in: 10...120, step: 5)
                        Stepper("休息 \(customBreak)", value: $customBreak, in: 1...30)
                        Stepper("轮次 \(customRounds)", value: $customRounds, in: 1...8)
                    }.font(DSFont.caption)
                } else if modeIndex == 3 {
                    Stepper("目标 \(taskTargetMinutes) 分钟", value: $taskTargetMinutes, in: 10...180, step: 10)
                        .font(DSFont.caption)
                }

                Picker("关联任务", selection: $selectedTaskID) {
                    Text("无关联任务").tag(UUID?.none)
                    ForEach(model.tasks.filter { !$0.done }) { Text($0.title).tag(Optional($0.id)) }
                }
                .accessibilityLabel("关联任务")

                TextField("本次目标", text: $sessionGoal)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("本次专注目标")

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: DSSpacing.s)],
                          alignment: .leading,
                          spacing: DSSpacing.s) {
                    Toggle("允许桌宠鼓励提示", isOn: $allowEncouragement)
                    Toggle("静音动作", isOn: $mutePetMotion)
                }
                .font(DSFont.caption)
            }
        }
    }

    // MARK: 当前会话概览

    private var sessionOverview: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("本次会话")
                if focus.phase == .idle {
                    Text("还没有进行中的专注。")
                        .font(DSFont.secondaryBody).foregroundStyle(DSColor.textSecondary)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: DSSpacing.s)],
                              alignment: .leading,
                              spacing: DSSpacing.s) {
                        MetricChip(label: "阶段", value: focus.phase.label, symbol: "circle.dashed")
                        MetricChip(label: "已专注", value: "\(focus.elapsed / 60) 分", symbol: "clock")
                        if focus.totalRounds > 0 {
                            MetricChip(label: "轮次", value: "\(focus.completedRounds)/\(focus.totalRounds)", symbol: "repeat")
                        }
                    }
                    if !sessionGoal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("目标：\(sessionGoal)")
                            .font(DSFont.secondaryBody)
                            .foregroundStyle(DSColor.textSecondary)
                    }
                }
            }
        }
    }

    // MARK: 操作

    private func startFocus() {
        let mode: FocusMode
        switch modeIndex {
        case 0: mode = .pom25
        case 1: mode = .pom45
        case 2: mode = .custom(work: customWork, brk: customBreak, rounds: customRounds, longBreak: customBreak * 2)
        default: mode = .taskDriven(targetWork: taskTargetMinutes)
        }
        let task = model.tasks.first { $0.id == selectedTaskID }
        model.startFocus(mode: mode, task: task)
        if !mutePetMotion { sendPetIntent(.focusStarted) }
    }

    private func endFocus() {
        let wasActive = focus.isActive
        focus.stop()
        if wasActive { sendPetIntent(.focusCompleted) }
    }
}
