import SwiftUI
import AICore

// P5.1 — "记忆"页面 bespoke 重做（doc §12.2 透明度）。卡片化：记住了什么、来源、为何、隐私级别、能否
// 控制。保留现有记忆能力与权限边界，不扩张采集。破坏性删除需确认。不显示内部 Prompt / 凭据。

struct MemoryView: View {
    @ObservedObject var memory: MemoryModel
    @State private var newText = ""
    @State private var newCategory: MemoryCategory = .preference
    @State private var pendingDelete: MemoryItem?
    @State private var showShortTermContext = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DSSpacing.l) {
                header
                composer
                if let notice = memory.recentLearningNotice {
                    InlineNotice(kind: .info, text: "\(notice)。")
                }
                if memory.items.filter({ !$0.archived }).isEmpty {
                    emptyState
                } else {
                    memorySection(title: "已记住",
                                  subtitle: "长期 active 的偏好、事实和工作方式",
                                  items: memory.rememberedItems,
                                  emptyText: "暂无长期记忆")
                    memorySection(title: "最近自动学习",
                                  subtitle: "低风险内容已自动保存，可随时撤销",
                                  items: memory.recentlyAutoLearnedItems,
                                  emptyText: "暂无自动学习记录",
                                  actionTitle: "撤销",
                                  action: memory.undoAutoLearned)
                    memorySection(title: "需要确认",
                                  subtitle: "只放风险、歧义或冲突内容",
                                  items: memory.pendingConfirmationItems,
                                  emptyText: "暂无需要确认的记忆")
                    shortTermSection
                }
                privacyFooter
            }
            .padding(DSSpacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("memory.view")
        .confirmationDialog("忘记这条记忆？", isPresented: deleteBinding, presenting: pendingDelete) { item in
            Button("忘记", role: .destructive) { memory.forget(item); pendingDelete = nil }
            Button("取消", role: .cancel) { pendingDelete = nil }
        } message: { item in
            Text(item.text)
        }
    }

    private var deleteBinding: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var header: some View {
        DashboardSection(title: "记忆中心",
                         subtitle: "长期记忆、自动学习和短期上下文分开管理") {
            HStack(spacing: DSSpacing.m) {
                Toggle("长期记忆", isOn: Binding(get: { memory.memoryEnabled },
                                            set: { memory.setMemoryEnabled($0) }))
                    .toggleStyle(.switch)
                    .accessibilityLabel("启用长期记忆")
                Spacer()
                Button(showShortTermContext ? "隐藏短期上下文" : "显示短期上下文") {
                    withAnimation(.easeInOut(duration: 0.16)) { showShortTermContext.toggle() }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    private var composer: some View {
        CardContainer(padding: DSSpacing.m) {
            HStack(spacing: DSSpacing.s) {
                Image(systemName: "brain.head.profile").foregroundStyle(DSColor.secondaryAccent).accessibilityHidden(true)
                TextField("新增记忆，如：称呼我为「队长」", text: $newText)
                    .textFieldStyle(.plain).font(DSFont.body)
                    .onSubmit(add)
                    .accessibilityLabel("新增记忆")
                Picker("", selection: $newCategory) {
                    ForEach(MemoryCategory.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .labelsHidden().frame(width: 96)
                Button("保存", action: add).buttonStyle(SecondaryButtonStyle())
                    .disabled(newText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private var emptyState: some View {
        CardContainer {
            EmptyStateView(symbol: "brain",
                           title: "还没有记住什么",
                           message: "你可以让我记住称呼、偏好或正在进行的项目；所有记忆你都能查看与删除。") {
                EmptyView()
            }
        }
    }

    private var privacyFooter: some View {
        InlineNotice(kind: .info, text: "记忆默认仅本地；标记「禁云端 / 仅本地」的内容不会进入云端上下文。")
    }

    private func memorySection(title: String,
                               subtitle: String,
                               items: [MemoryItem],
                               emptyText: String,
                               actionTitle: String? = nil,
                               action: ((MemoryItem) -> Void)? = nil) -> some View {
        DashboardSection(title: title, subtitle: "\(subtitle) · \(items.count) 条") {
            if items.isEmpty {
                Text(emptyText)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, DSSpacing.xs)
            } else {
                VStack(alignment: .leading, spacing: DSSpacing.s) {
                    ForEach(items) { item in
                        MemoryCard(memory: memory,
                                   item: item,
                                   primaryActionTitle: actionTitle,
                                   primaryAction: action.map { callback in { callback(item) } }) {
                            pendingDelete = item
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier(memorySectionIdentifier(title))
    }

    private func memorySectionIdentifier(_ title: String) -> String {
        switch title {
        case "已记住": return "memory.activeSection"
        case "最近自动学习": return "memory.recentSection"
        case "需要确认": return "memory.pendingSection"
        case "短期上下文": return "memory.shortTermSection"
        default: return "memory.section.\(title)"
        }
    }

    private var shortTermSection: some View {
        Group {
            if showShortTermContext {
                memorySection(title: "短期上下文",
                              subtitle: "仅开发/诊断使用，过期后不进入长期记忆",
                              items: memory.shortTermContextItems,
                              emptyText: "暂无 working/session 记忆")
            }
        }
    }

    private func add() {
        let ok = memory.add(MemoryItem(text: newText, category: newCategory, source: .explicit))
        if ok { newText = "" }
    }
}

private struct MemoryCard: View {
    @ObservedObject var memory: MemoryModel
    let item: MemoryItem
    var primaryActionTitle: String?
    var primaryAction: (() -> Void)?
    let onDelete: () -> Void
    @State private var expanded = false

    static let df: DateFormatter = { let f = DateFormatter(); f.dateFormat = "M/d"; return f }()

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .top) {
                Text(item.text)
                    .font(DSFont.body)
                    .foregroundStyle(item.paused ? DSColor.textTertiary : DSColor.textPrimary)
                    .strikethrough(item.paused)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: DSSpacing.s)
                if !item.confirmed {
                    Button("确认") { memory.confirm(item) }
                        .buttonStyle(SecondaryButtonStyle())
                        .controlSize(.small)
                        .accessibilityIdentifier("memory.item.confirm")
                }
                if let primaryActionTitle, let primaryAction {
                    Button(primaryActionTitle, action: primaryAction)
                        .buttonStyle(SecondaryButtonStyle())
                        .controlSize(.small)
                }
                IconButton(symbol: expanded ? "chevron.up" : "info.circle",
                           label: expanded ? "收起详情" : "查看详情") { expanded.toggle() }
            }

            HStack(spacing: DSSpacing.xs) {
                badge(item.category.label, tint: DSColor.primaryAccent)
                badge(item.source.label, tint: DSColor.secondaryAccent)
                if item.privacy == .sensitive { badge("敏感", tint: DSColor.warning) }
                badge(item.scope.label, tint: DSColor.textTertiary)
                // P17 / LC-03 — memory-state display labels (active/pending/expired/etc.)
                // so the consumer never sees the raw enum name.
                if item.state != .active { badge(stateLabel(item.state), tint: DSColor.warning) }
                if item.localOnly { badge("仅本地", tint: DSColor.textTertiary) }
                if item.blockCloud { badge("禁云端", tint: DSColor.textTertiary) }
                if let exp = item.expiresAt { badge("到期 \(Self.df.string(from: exp))", tint: DSColor.textTertiary) }
            }

            if expanded { detail }
        }
        .padding(DSSpacing.m)
        .background(DSColor.elevatedSurface, in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous).strokeBorder(DSColor.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.item.\(item.id.uuidString)")
    }

    private func stateLabel(_ state: MemoryState) -> String {
        switch state {
        case .observed: return "观察中"
        case .active: return "活跃"
        case .pendingConfirmation: return "待确认"
        case .rejected: return "已拒绝"
        case .superseded: return "已替换"
        case .expired: return "已过期"
        case .ignored: return "已忽略"
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            if let r = item.reason { Text("原因：\(r)").font(DSFont.caption).foregroundStyle(DSColor.textSecondary) }
            Text("来源：\(sourceDescription(item))")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textSecondary)
            Text("使用 \(item.useCount) 次" + (item.lastUsed.map { " · 最近 \(Self.df.string(from: $0))" } ?? ""))
                .font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
            Text(item.everEnteredCloud ? "曾进入云端上下文" : "从未上云")
                .font(DSFont.caption)
                .foregroundStyle(item.everEnteredCloud ? DSColor.warning : DSColor.textTertiary)
            HStack(spacing: DSSpacing.m) {
                Toggle("仅本地", isOn: boolBinding(\.localOnly)).toggleStyle(.checkbox).font(DSFont.caption)
                Toggle("禁云端", isOn: boolBinding(\.blockCloud)).toggleStyle(.checkbox).font(DSFont.caption)
                Button(item.paused ? "恢复" : "暂停") { memory.setPaused(item, !item.paused) }
                    .buttonStyle(SecondaryButtonStyle()).controlSize(.small)
                Spacer()
                Button("忘记", role: .destructive, action: onDelete)
                    .controlSize(.small)
                    .accessibilityIdentifier("memory.item.forget")
            }
            .padding(.top, 2)
        }
    }

    private func boolBinding(_ keyPath: WritableKeyPath<MemoryItem, Bool>) -> Binding<Bool> {
        Binding(get: { item[keyPath: keyPath] },
                set: { var m = item; m[keyPath: keyPath] = $0; memory.update(m) })
    }

    private func badge(_ text: String, tint: Color) -> some View {
        Text(text).font(DSFont.caption).foregroundStyle(tint)
            .padding(.horizontal, DSSpacing.xs).padding(.vertical, 1)
            .background(tint.opacity(0.12), in: Capsule())
    }

    private func sourceDescription(_ item: MemoryItem) -> String {
        switch item.source {
        case .explicit: return "你明确告诉我"
        case .auto: return "根据重复行为自动学习"
        case .suggested: return item.state == .pendingConfirmation ? "等待你确认" : "来自任务结果"
        }
    }
}
