import SwiftUI
import AICore

struct ModelCenterView: View {
    @ObservedObject var providers: ProviderStore
    @ObservedObject var runtime: CompanionAgentRuntimeModel
    @ObservedObject var uiState: AppUIStateStore
    @State private var isTestingCurrentModel = false
    @State private var refreshingProviderID: String?
    @State private var refreshingRole: ModelRole?

    var body: some View {
        ControlPanelPageLayout {
            currentModelCard
            DashboardSection(title: "高级模型路由", subtitle: "为不同能力选择专用模型（可选）") {
                VStack(alignment: .leading, spacing: DSSpacing.m) {
                    ForEach(ModelRole.allCases, id: \.self) { role in
                        roleCard(role)
                        if role != ModelRole.allCases.last {
                            Divider().overlay(DSColor.border)
                        }
                    }
                }
            }
        }
    }

    private var currentModelCard: some View {
        let status = runtime.runtimeStatus()
        return CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: DSSpacing.m) {
                        modelHero(status)
                        Spacer(minLength: DSSpacing.s)
                        currentModelActions
                    }
                    VStack(alignment: .leading, spacing: DSSpacing.m) {
                        modelHero(status)
                        currentModelActions
                    }
                }
                if !status.modelReadiness.isReady {
                    InlineNotice(kind: .warning, text: status.modelReadiness.label, actionTitle: "设置 AI") {
                        uiState.setSection(.providers)
                    }
                }
            }
        }
    }

    private func modelHero(_ status: CompanionRuntimeStatus) -> some View {
        HStack(alignment: .center, spacing: DSSpacing.m) {
            Image(systemName: status.modelReadiness.isReady ? "checkmark.circle.fill" : "cpu")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(status.modelReadiness.isReady ? DSColor.success : DSColor.warning)
                .frame(width: 38, height: 38)
                .background(DSColor.appBackground, in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous).strokeBorder(DSColor.border, lineWidth: 1))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(status.selectedModel)
                    .font(DSFont.cardTitle)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("普通聊天会优先使用这里选择的陪伴模型")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                    .lineLimit(2)
                StatusPill(text: status.modelReadiness.shortLabel,
                           symbol: status.modelReadiness.isReady ? "checkmark.circle" : "exclamationmark.triangle",
                           tint: status.modelReadiness.isReady ? DSColor.success : DSColor.warning)
            }
        }
    }

    @ViewBuilder
    private var currentModelActions: some View {
        Button(action: testCurrentModel) {
            HStack(spacing: DSSpacing.xs) {
                if isTestingCurrentModel { ProgressView().controlSize(.small) }
                Text("测试当前模型")
            }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(isTestingCurrentModel)
        Button(action: refreshCurrentCompanionModels) {
            HStack(spacing: DSSpacing.xs) {
                if refreshingProviderID == providers.defaults.companionModelProviderID {
                    ProgressView().controlSize(.small)
                }
                Text("刷新模型列表")
            }
        }
        .buttonStyle(SecondaryButtonStyle())
        .disabled(providers.defaults.companionModelProviderID == nil
                  || refreshingProviderID != nil)
    }

    private func testCurrentModel() {
        guard !isTestingCurrentModel else { return }
        isTestingCurrentModel = true
        Task {
            _ = await runtime.testSelectedModel()
            isTestingCurrentModel = false
        }
    }

    private func refreshCurrentCompanionModels() {
        guard let providerID = providers.defaults.companionModelProviderID,
              refreshingProviderID == nil else { return }
        refreshingProviderID = providerID
        Task {
            await providers.refreshModels(providerID: providerID)
            refreshingProviderID = nil
        }
    }

    private func roleCard(_ role: ModelRole) -> some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .top, spacing: DSSpacing.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(roleTitle(role))
                        .font(DSFont.cardTitle)
                        .foregroundStyle(DSColor.textPrimary)
                    Text(roleSubtitle(role))
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                }
                Spacer(minLength: DSSpacing.s)
                roleStatus(role)
            }
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                Picker("Provider", selection: providerBinding(role)) {
                    Text("未配置").tag(String?.none)
                    ForEach(providers.providers) { provider in
                        Text(provider.displayName).tag(Optional(provider.id))
                    }
                }
                Picker("Model", selection: modelBinding(role)) {
                    Text("未配置").tag(String?.none)
                    ForEach(modelOptions(for: providerID(for: role))) { model in
                        Text(model.displayName).tag(Optional(model.id))
                    }
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: DSSpacing.s) {
                        Spacer(minLength: 0)
                        refreshRoleButton(role)
                    }
                    VStack(alignment: .leading, spacing: DSSpacing.s) {
                        refreshRoleButton(role)
                    }
                }
            }
        }
    }

    private func roleStatus(_ role: ModelRole) -> some View {
        Group {
            if let provider = providers.provider(id: providerID(for: role)) {
                StatusPill(text: providers.statuses[provider.id]?.label ?? "可测试",
                           symbol: provider.enabled ? "checkmark" : "pause.circle",
                           tint: provider.enabled ? DSColor.secondaryAccent : DSColor.textTertiary)
            } else {
                StatusPill(text: "未配置", symbol: "cpu", tint: DSColor.textTertiary)
            }
        }
    }

    private func refreshRoleButton(_ role: ModelRole) -> some View {
        Button(action: { refreshRole(role) }) {
            HStack(spacing: DSSpacing.xs) {
                if refreshingRole == role { ProgressView().controlSize(.small) }
                Text("刷新")
            }
        }
        .buttonStyle(SecondaryButtonStyle())
        .controlSize(.small)
        .disabled(providerID(for: role) == nil || refreshingRole != nil)
    }

    private func refreshRole(_ role: ModelRole) {
        guard let id = providerID(for: role), refreshingRole == nil else { return }
        refreshingRole = role
        Task {
            await providers.refreshModels(providerID: id)
            refreshingRole = nil
        }
    }

    private func modelOptions(for providerID: String?) -> [ModelDescriptor] {
        guard let provider = providers.provider(id: providerID) else { return [] }
        var models = providers.models(for: provider.id)
        if let defaultModelID = provider.defaultModelID,
           !models.contains(where: { $0.id == defaultModelID }) {
            models.insert(ModelDescriptor(id: defaultModelID, providerID: provider.id, source: .manual), at: 0)
        }
        return models
    }

    private func providerID(for role: ModelRole) -> String? {
        switch role {
        case .companion: return providers.defaults.companionModelProviderID
        case .tool: return providers.defaults.toolModelProviderID
        case .summarizer: return providers.defaults.summarizerModelProviderID
        case .vision: return providers.defaults.visionModelProviderID
        }
    }

    private func modelID(for role: ModelRole) -> String? {
        switch role {
        case .companion: return providers.defaults.companionModelID
        case .tool: return providers.defaults.toolModelID
        case .summarizer: return providers.defaults.summarizerModelID
        case .vision: return providers.defaults.visionModelID
        }
    }

    private func providerBinding(_ role: ModelRole) -> Binding<String?> {
        Binding(get: { providerID(for: role) },
                set: { providerID in providers.setDefault(role: role, providerID: providerID, modelID: nil) })
    }

    private func modelBinding(_ role: ModelRole) -> Binding<String?> {
        Binding(get: { modelID(for: role) },
                set: { modelID in providers.setDefault(role: role, providerID: providerID(for: role), modelID: modelID) })
    }

    private func roleTitle(_ role: ModelRole) -> String {
        switch role {
        case .companion: return "陪伴模型"
        case .tool: return "工具模型"
        case .summarizer: return "总结模型"
        case .vision: return "视觉模型"
        }
    }

    private func roleSubtitle(_ role: ModelRole) -> String {
        switch role {
        case .companion: return "普通陪伴对话默认使用"
        case .tool: return "工具调用计划与结构化决策"
        case .summarizer: return "对话与记忆摘要"
        case .vision: return "未来视觉输入；未配置时不会假装可用"
        }
    }
}
