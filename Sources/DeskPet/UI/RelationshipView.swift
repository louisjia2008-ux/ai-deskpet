import SwiftUI
import AICore

// P5.1 — "陪伴"页面 bespoke 重做（doc §10.4）。只展示真实关系数据：阶段 + 模糊进度（永不显示数字）、
// 真实情绪倾向（moodHint，定性而非伪造数值）、已解锁内容卡片、可选配饰卡片（非裸 Radio）。无惩罚、
// 不鼓励机械刷好感度。

struct RelationshipView: View {
    @ObservedObject var relationship: RelationshipModel
    @ObservedObject var prefs: PreferencesModel
    @ObservedObject var runtime: CompanionAgentRuntimeModel

    private var snap: RelationshipSnapshot { relationship.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.l) {
            companionControls
            stageCard
            emotionCard
            unlockedLinesCard
            accessoriesCard
            ethicsNote
        }
    }

    private var companionControls: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                SectionHeader("陪伴控制", subtitle: "所有设置会保存到本地配置")
                Picker("陪伴模式", selection: Binding(
                    get: { prefs.companion.mode },
                    set: { prefs.setCompanionMode($0); runtime.updateCompanionMode(.companion) })) {
                    ForEach(CompanionModePreference.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)

                Picker("主动行为强度", selection: Binding(
                    get: { prefs.companion.proactiveIntensity },
                    set: { prefs.setProactiveIntensity($0) })) {
                    ForEach(ProactiveIntensity.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)

                Toggle(isOn: Binding(get: { prefs.companion.allowInterruptions },
                                     set: { prefs.setAllowInterruptions($0) })) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("允许主动打扰").font(DSFont.body).foregroundStyle(DSColor.textPrimary)
                        Text("关闭时只保留用户主动触发的陪伴反馈").font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                    }
                }
                .toggleStyle(.switch)

                HStack(spacing: DSSpacing.s) {
                    StatusPill(text: runtime.runtimeStatus().currentMode.label, symbol: "pawprint", tint: DSColor.primaryAccent)
                    StatusPill(text: snap.vitals.moodHint, symbol: "sparkle", tint: DSColor.emotionAccent)
                    Spacer()
                }
            }
        }
    }

    // MARK: 关系阶段（模糊进度，无数字）

    private var stageCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                Text("当前关系").font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                Text(relationship.stage.label)
                    .font(DSFont.pageTitle).foregroundStyle(DSColor.textPrimary)
                SegmentedProgress(filled: filledStages, total: RelationshipStage.allCases.count)
                Text(snap.state.progressHint).font(DSFont.secondaryBody).foregroundStyle(DSColor.textSecondary)
            }
        }
    }
    private var filledStages: Int {
        RelationshipStage.allCases.filter { $0 <= relationship.stage }.count
    }

    // MARK: 情绪 / 状态（真实 moodHint，定性）

    private var emotionCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("此刻状态")
                HStack(spacing: DSSpacing.s) {
                    Image(systemName: "sparkle").foregroundStyle(DSColor.emotionAccent).accessibilityHidden(true)
                    Text(snap.vitals.moodHint).font(DSFont.body).foregroundStyle(DSColor.textPrimary)
                    Spacer()
                }
                Text("情绪来自真实互动（陪伴、完成任务、专注）并会随时间自然回落。")
                    .font(DSFont.caption).foregroundStyle(DSColor.textTertiary)
            }
        }
    }

    // MARK: 已解锁的话

    private var unlockedLinesCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("已解锁的话")
                let lines = RelationshipStage.allCases
                    .filter { $0 <= relationship.stage }
                    .flatMap { RewardCatalog.unlockedLines(at: $0) }
                if lines.isEmpty {
                    Text("继续相处，会解锁更多专属的话。")
                        .font(DSFont.secondaryBody).foregroundStyle(DSColor.textSecondary)
                } else {
                    ForEach(lines, id: \.self) { line in
                        HStack(alignment: .top, spacing: DSSpacing.s) {
                            Image(systemName: "quote.opening").font(.system(size: 10))
                                .foregroundStyle(DSColor.emotionAccent).accessibilityHidden(true)
                            Text(line).font(DSFont.secondaryBody).foregroundStyle(DSColor.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    // MARK: 配饰（可选卡片，非 Radio）

    private var accessoriesCard: some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                SectionHeader("配饰", subtitle: "随关系阶段解锁")
                let cols = [GridItem(.adaptive(minimum: 116), spacing: DSSpacing.s)]
                LazyVGrid(columns: cols, alignment: .leading, spacing: DSSpacing.s) {
                    ForEach(Accessory.allCases, id: \.self) { accessory in
                        accessoryCard(accessory)
                    }
                }
            }
        }
    }

    private func accessoryCard(_ accessory: Accessory) -> some View {
        let unlocked = relationship.unlocked.contains(accessory)
        let equipped = relationship.equipped.contains(accessory)
        return Button {
            relationship.toggleEquip(accessory)
        } label: {
            HStack(spacing: DSSpacing.s) {
                Image(systemName: equipped ? "checkmark.circle.fill" : (unlocked ? "circle" : "lock.fill"))
                    .foregroundStyle(equipped ? DSColor.emotionAccent : (unlocked ? DSColor.textTertiary : DSColor.textTertiary))
                VStack(alignment: .leading, spacing: 1) {
                    Text(accessory.label).font(DSFont.compactLabel)
                        .foregroundStyle(unlocked ? DSColor.textPrimary : DSColor.textTertiary)
                    if !unlocked {
                        Text("「\(accessory.unlockStage.label)」解锁").font(.system(size: 9)).foregroundStyle(DSColor.textTertiary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(DSSpacing.s)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                    .fill(equipped ? DSColor.token(.emotionAccent).opacity(0.12) : DSColor.token(.textTertiary).opacity(0.06)))
            .overlay(
                RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                    .strokeBorder(equipped ? DSColor.token(.emotionAccent).opacity(0.5) : DSColor.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!unlocked)
        .help(unlocked ? (equipped ? "点击取下" : "点击佩戴") : "在「\(accessory.unlockStage.label)」阶段解锁")
        .accessibilityLabel(accessory.label)
        .accessibilityValue(unlocked ? (equipped ? "已佩戴" : "未佩戴") : "未解锁")
    }

    private var ethicsNote: some View {
        Text("关系成长来自真实陪伴，不是刷数值——慢慢来就好。")
            .font(DSFont.caption).foregroundStyle(DSColor.textTertiary)
            .padding(.horizontal, DSSpacing.xs)
    }
}
