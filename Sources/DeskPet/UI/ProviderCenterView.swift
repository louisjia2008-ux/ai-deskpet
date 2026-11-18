import SwiftUI
import AppKit
import AICore

struct ProviderCenterView: View {
    @ObservedObject var providers: ProviderStore
    @State private var editingProvider: ProviderConfig?
    @State private var showingEditor = false
    @State private var pendingDelete: ProviderConfig?
    @State private var pendingSecretDelete: ProviderConfig?
    /// P19.1 / P1 — last quick-add family the user picked, used to pre-fill
    /// the manual editor's name + base URL.
    @State private var pendingQuickAddFamily: ProviderQuickAddDefaults.Family?

    var body: some View {
        ControlPanelPageLayout {
            header
            quickAddSection

            if providers.providers.isEmpty {
                CardContainer {
                    EmptyStateView(symbol: "server.rack",
                                   title: "还没有可用的 AI",
                                   message: "连接本地模型或云端 AI 服务后，DeskPet 才能回复你的消息。") {
                        addProviderButton
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: DSSpacing.s) {
                    ForEach(providers.providers) { provider in
                        providerCard(provider)
                    }
                }
            }
        }
        .sheet(isPresented: $showingEditor) {
            ProviderEditorSheet(providers: providers, provider: editingProvider)
        }
        .task {
            await providers.refreshAllSecretStates(allowKeychainPrompt: false)
        }
        .confirmationDialog("删除 Provider？", isPresented: Binding(get: { pendingDelete != nil },
                                                              set: { if !$0 { pendingDelete = nil } })) {
            Button("删除配置和 Keychain secret", role: .destructive) {
                if let pendingDelete {
                    Task { await providers.deleteProvider(id: pendingDelete.id, deleteSecret: true) }
                }
                pendingDelete = nil
            }
            Button("仅删除配置", role: .destructive) {
                if let pendingDelete {
                    Task { await providers.deleteProvider(id: pendingDelete.id, deleteSecret: false) }
                }
                pendingDelete = nil
            }
            Button("取消", role: .cancel) { pendingDelete = nil }
        }
        .confirmationDialog("删除此 Provider 的 API Key？",
                            isPresented: Binding(get: { pendingSecretDelete != nil },
                                                 set: { if !$0 { pendingSecretDelete = nil } })) {
            Button("仅删除此 Provider 的 Keychain API Key", role: .destructive) {
                if let pendingSecretDelete {
                    Task { await providers.deleteProviderSecret(providerID: pendingSecretDelete.id) }
                }
                pendingSecretDelete = nil
            }
            Button("取消", role: .cancel) { pendingSecretDelete = nil }
        }
    }

    /// P19.1 / P1 — Quick Add surface. Each card pre-fills the manual editor
    /// with a real default base URL + capability set, so users don't have to
    /// dig for them. Only providers with full chat wiring (per
    /// `ProviderQuickAddDefaults.Family`) are surfaced here. Anthropic /
    /// Gemini / CustomHTTP fall through to `ManualProviderClient` (chat
    /// throws `unsupportedProvider`); they remain reachable via the full
    /// "添加 AI" button for advanced users.
    @ViewBuilder
    private var quickAddSection: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Text("快速添加")
                .font(DSFont.sectionTitle)
                .foregroundStyle(DSColor.textPrimary)
            // P19.6 — switch from `HStack` to `LazyVGrid` so 6 quick-add cards
            // wrap to multiple rows on narrow windows instead of compressing
            // each card's description text into a single truncated line.
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180, maximum: .infinity),
                                          spacing: DSSpacing.m)],
                      alignment: .leading,
                      spacing: DSSpacing.m) {
                ForEach(ProviderQuickAddDefaults.Family.allCases) { family in
                    quickAddCard(for: family)
                }
            }
        }
        .padding(.bottom, DSSpacing.s)
    }

    private func quickAddCard(for family: ProviderQuickAddDefaults.Family) -> some View {
        Button {
            presentQuickAdd(for: family)
        } label: {
            CardContainer {
                VStack(alignment: .leading, spacing: DSSpacing.xs) {
                    HStack(alignment: .center, spacing: DSSpacing.s) {
                        Image(systemName: quickAddSymbol(for: family))
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(DSColor.primaryAccent)
                            .frame(width: 18)
                            .accessibilityHidden(true)
                        Text(family.displayName)
                            .font(DSFont.cardTitle)
                            .foregroundStyle(DSColor.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "plus.circle")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(DSColor.secondaryAccent)
                            .accessibilityHidden(true)
                    }
                    Text(quickAddDescription(for: family))
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("默认接口：\(ProviderQuickAddDefaults.defaultBaseURL(for: family)?.host ?? "—")")
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("快速添加 \(family.displayName)")
        .accessibilityHint(quickAddDescription(for: family))
    }

    private func quickAddSymbol(for family: ProviderQuickAddDefaults.Family) -> String {
        switch family {
        case .openAI: return "cloud.fill"
        case .ollama: return "laptopcomputer"
        case .lmStudio: return "cpu"
        case .MiniMax: return "sparkles"
        case .glm: return "globe.asia.australia.fill"
        case .deepSeek: return "magnifyingglass.circle.fill"
        }
    }

    private func quickAddDescription(for family: ProviderQuickAddDefaults.Family) -> String {
        switch family {
        case .openAI:
            return "云端 OpenAI 兼容服务，需要 API Key。"
        case .ollama:
            return "本地 Ollama 服务，默认地址 localhost:11434。"
        case .lmStudio:
            return "本地 LM Studio OpenAI 兼容接口。"
        case .MiniMax:
            return "云端 MiniMax M3 兼容 OpenAI 接口，需要 API Key。"
        case .glm:
            return "云端 GLM（智谱）OpenAI 兼容接口，需要 API Key。"
        case .deepSeek:
            return "云端 DeepSeek OpenAI 兼容接口，需要 API Key。"
        }
    }

    private func presentQuickAdd(for family: ProviderQuickAddDefaults.Family) {
        let draft = ProviderQuickAddDefaults.makeProvider(for: family)
        editingProvider = draft
        showingEditor = true
        pendingQuickAddFamily = family
    }

    private var header: some View {
        let readiness = providers.readiness()
        return CardContainer {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: DSSpacing.m) {
                    providerHeaderText(readiness)
                    Spacer(minLength: DSSpacing.s)
                    addProviderButton
                }
                VStack(alignment: .leading, spacing: DSSpacing.s) {
                    providerHeaderText(readiness)
                    addProviderButton
                }
            }
        }
    }

    private func providerHeaderText(_ readiness: ModelReadinessState) -> some View {
        HStack(alignment: .center, spacing: DSSpacing.m) {
            Image(systemName: "server.rack")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(DSColor.primaryAccent)
                .frame(width: 34, height: 34)
                .background(DSColor.token(.primaryAccent).opacity(0.10),
                            in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("AI 设置")
                    .font(DSFont.sectionTitle)
                    .foregroundStyle(DSColor.textPrimary)
                Text("选择 DeskPet 用来回复的 AI。API Key 只保存在 macOS 钥匙串。")
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                    .lineLimit(2)
                StatusPill(text: readiness.label,
                           symbol: readiness.isReady ? "checkmark.circle" : "exclamationmark.triangle",
                           tint: readiness.isReady ? DSColor.success : DSColor.warning)
                    .accessibilityIdentifier("provider.status")
            }
        }
    }

    private var addProviderButton: some View {
        Button("添加 AI") {
            editingProvider = nil
            showingEditor = true
        }
        .buttonStyle(PrimaryButtonStyle())
        .frame(minWidth: 116, alignment: .trailing)
    }

    private func providerCard(_ provider: ProviderConfig) -> some View {
        CardContainer {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
                HStack(alignment: .top, spacing: DSSpacing.m) {
                    providerIdentity(provider)
                        .layoutPriority(1)
                    providerActionMenu(provider)
                }
                Divider().overlay(DSColor.border)
                providerStatus(provider)
            }
        }
    }

    private func providerIdentity(_ provider: ProviderConfig) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(provider.displayName).font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(provider.baseURL.absoluteString).font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(provider.defaultModelID ?? "未设置默认模型")
                .font(DSFont.caption)
                .foregroundStyle(provider.defaultModelID == nil ? DSColor.textTertiary : DSColor.textSecondary)
                .lineLimit(1)
                .accessibilityIdentifier("provider.model")
        }
    }

    private func providerStatus(_ provider: ProviderConfig) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: DSSpacing.s) {
                providerStatusPills(provider)
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                providerStatusPills(provider)
            }
        }
    }

    @ViewBuilder
    private func providerStatusPills(_ provider: ProviderConfig) -> some View {
        StatusPill(text: provider.enabled ? "已启用" : "已停用",
                   symbol: provider.enabled ? "checkmark.circle" : "pause.circle",
                   tint: provider.enabled ? DSColor.success : DSColor.textTertiary)
        StatusPill(text: provider.type.label, symbol: "server.rack", tint: DSColor.secondaryAccent)
        if provider.type.requiresAPIKey {
            let state = providers.secretState(for: provider)
            StatusPill(text: state.label,
                       symbol: secretSymbol(state),
                       tint: secretTint(state))
        }
        StatusPill(text: providers.statuses[provider.id]?.label ?? "未测试",
                   symbol: provider.enabled ? "network" : "pause.circle",
                   tint: provider.enabled ? DSColor.primaryAccent : DSColor.textTertiary)
            .accessibilityIdentifier("provider.connectionTest")
    }

    private func providerActionMenu(_ provider: ProviderConfig) -> some View {
        ActionMenuButton(label: "\(provider.displayName) 操作") {
            Button("编辑") {
                editingProvider = provider
                showingEditor = true
            }
            Button("测试连接") {
                prepareForKeychainPrompt()
                Task { await providers.testConnection(providerID: provider.id) }
            }
            .disabled(!provider.enabled)
            if provider.type.requiresAPIKey {
                Button("重新授权 Keychain") {
                    prepareForKeychainPrompt()
                    Task { await providers.reauthorizeSecret(providerID: provider.id) }
                }
                .disabled(provider.apiKeySecretID == nil)
                Button("替换 API Key") {
                    editingProvider = provider
                    showingEditor = true
                }
                Button("删除本 Provider API Key", role: .destructive) {
                    pendingSecretDelete = provider
                }
                .disabled(provider.apiKeySecretID == nil)
            }
            Button("刷新模型") {
                prepareForKeychainPrompt()
                Task { await providers.refreshModels(providerID: provider.id) }
            }
            .disabled(!provider.enabled || !provider.type.supportsFetchedModelList)
            Divider()
            Button("删除", role: .destructive) { pendingDelete = provider }
        }
    }
}

@MainActor
private func prepareForKeychainPrompt() {
    NSApp.activate(ignoringOtherApps: true)
    NSApp.keyWindow?.makeKeyAndOrderFront(nil)
}

private func secretSymbol(_ state: ProviderSecretState) -> String {
    switch state {
    case .available:
        return "key.fill"
    case .missing:
        return "key.slash"
    case .locked:
        return "lock"
    case .accessDenied:
        return "hand.raised"
    case .invalid:
        return "exclamationmark.triangle"
    case .unknownFailure:
        return "questionmark.circle"
    }
}

private func secretTint(_ state: ProviderSecretState) -> Color {
    switch state {
    case .available:
        return DSColor.success
    case .missing, .locked:
        return DSColor.warning
    case .accessDenied, .invalid, .unknownFailure:
        return DSColor.destructive
    }
}

private struct ProviderEditorSheet: View {
    @ObservedObject var providers: ProviderStore
    let provider: ProviderConfig?
    @Environment(\.dismiss) private var dismiss

    @State private var draft: ProviderEditorDraft
    @State private var isShowingAPIKey = false
    @State private var isSaving = false
    @State private var errorText: String?
    @State private var pendingSecretDelete = false
    @FocusState private var focusedField: ProviderEditorField?

    init(providers: ProviderStore, provider: ProviderConfig?) {
        self.providers = providers
        self.provider = provider
        _draft = State(initialValue: ProviderEditorDraft(provider: provider))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            Text(provider == nil ? "添加 AI 服务" : "编辑 AI 服务")
                .font(DSFont.pageTitle)
            Form {
                TextField("服务名称", text: $draft.name)
                    .focused($focusedField, equals: .name)
                Picker("服务类型", selection: $draft.type) {
                    ForEach(ProviderType.allCases) { providerType in
                        Text(providerType.label).tag(providerType)
                    }
                }
                TextField("接口地址", text: $draft.baseURL)
                    .focused($focusedField, equals: .baseURL)
                apiKeyRow
                TextField("手动填写模型 ID", text: $draft.manualModelID)
                    .focused($focusedField, equals: .manualModelID)
                Toggle("启用", isOn: $draft.enabled)
                capabilityGrid
            }
            if draft.type == .gemini {
                InlineNotice(kind: .warning, text: "Gemini 暂不可用，请选择其他服务。")
            }
            if let errorText {
                InlineNotice(kind: .error, text: errorText)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .disabled(isSaving)
                Button("保存到 Keychain / 配置") { save() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isSaving)
            }
        }
        .padding(DSSpacing.xl)
        .frame(width: 520)
        .onAppear(perform: activateAndFocusAPIKeyField)
        .task(id: provider?.id) {
            if let provider {
                await providers.refreshSecretState(providerID: provider.id, allowKeychainPrompt: false)
            }
        }
        .confirmationDialog("删除此 Provider 的 API Key？", isPresented: $pendingSecretDelete) {
            Button("仅删除此 Provider 的 Keychain API Key", role: .destructive) {
                if let provider {
                    Task { await providers.deleteProviderSecret(providerID: provider.id) }
                }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private enum ProviderEditorField: Hashable {
        case name
        case baseURL
        case apiKey
        case manualModelID
    }

    private var apiKeyRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: DSSpacing.s) {
                Group {
                    if isShowingAPIKey {
                        TextField("API Key", text: $draft.apiKey)
                    } else {
                        SecureField("API Key", text: $draft.apiKey)
                    }
                }
                .focused($focusedField, equals: .apiKey)
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))

                Button {
                    pasteAPIKeyFromPasteboard()
                } label: {
                    Label("粘贴", systemImage: "doc.on.clipboard")
                }
                .help("从剪贴板粘贴 API Key")

                Button {
                    isShowingAPIKey.toggle()
                    focusAPIKeyField()
                } label: {
                    Label(isShowingAPIKey ? "隐藏" : "显示",
                          systemImage: isShowingAPIKey ? "eye.slash" : "eye")
                }
                .help(isShowingAPIKey ? "隐藏 API Key" : "显示 API Key")
            }
            Text(apiKeyStatusText)
                .font(DSFont.caption)
                .foregroundStyle(apiKeyStatusTint)
                .lineLimit(2)
            if let provider, provider.type.requiresAPIKey {
                HStack(spacing: DSSpacing.s) {
                    Button("重新授权") {
                        prepareForKeychainPrompt()
                        Task {
                            let state = await providers.reauthorizeSecret(providerID: provider.id)
                            if state == .available {
                                errorText = nil
                            } else {
                                errorText = state.label
                            }
                        }
                    }
                    .disabled(provider.apiKeySecretID == nil)
                    Button("替换 API Key") {
                        isShowingAPIKey = true
                        focusAPIKeyField()
                    }
                    Button("删除本 Provider API Key", role: .destructive) {
                        pendingSecretDelete = true
                    }
                    .disabled(provider.apiKeySecretID == nil)
                }
                .font(DSFont.compactLabel)
            }
        }
    }

    private var apiKeyStatusText: String {
        if isShowingAPIKey {
            return "正在明文显示 API Key"
        }
        if let provider, provider.type.requiresAPIKey {
            switch providers.secretState(for: provider) {
            case .available:
                return ProviderEditorDraft.maskedAPIKeyDisplay(apiKey: draft.apiKey,
                                                               hasSavedSecret: provider.apiKeySecretID != nil)
            case .missing:
                return "API Key 未配置，请输入 API Key"
            case .locked:
                return "API Key 已保存，但钥匙串需要解锁或重新授权"
            case .accessDenied:
                return "钥匙串访问被拒绝，请重新输入 API Key"
            case .invalid:
                return "Keychain 中的 API Key 数据无效，请替换"
            case .unknownFailure:
                return "无法确认 Keychain API Key 状态"
            }
        }
        return ProviderEditorDraft.maskedAPIKeyDisplay(apiKey: draft.apiKey,
                                                       hasSavedSecret: provider?.apiKeySecretID != nil)
    }

    private var apiKeyStatusTint: Color {
        if isShowingAPIKey { return DSColor.warning }
        guard let provider, provider.type.requiresAPIKey else { return DSColor.textTertiary }
        switch providers.secretState(for: provider) {
        case .available:
            return DSColor.success
        case .missing, .locked:
            return DSColor.warning
        case .accessDenied, .invalid, .unknownFailure:
            return DSColor.destructive
        }
    }

    private var capabilityGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], alignment: .leading) {
            ForEach(ModelCapability.allCases) { capability in
                // P17 / LC-03 — use the capability display label instead of the raw
                // case name (pattern after ScheduledTaskEditor.capLabel).
                Toggle(capabilityLabel(capability), isOn: Binding(
                    get: { draft.capabilities.contains(capability) },
                    set: { on in
                        if on { draft.capabilities.insert(capability) }
                        else { draft.capabilities.remove(capability) }
                    }))
            }
        }
    }

    private func capabilityLabel(_ capability: ModelCapability) -> String {
        switch capability {
        case .chat: return "对话"
        case .vision: return "图像理解"
        case .streaming: return "流式回复"
        case .toolCalling: return "工具调用"
        case .embeddings: return "向量生成"
        case .local: return "本地运行"
        case .offline: return "可离线使用"
        }
    }

    private func pasteAPIKeyFromPasteboard() {
        draft.pasteAPIKey(NSPasteboard.general.string(forType: .string))
        errorText = nil
        focusAPIKeyField()
    }

    private func activateAndFocusAPIKeyField() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.keyWindow?.makeKeyAndOrderFront(nil)
        focusAPIKeyField()
    }

    private func focusAPIKeyField() {
        DispatchQueue.main.async {
            focusedField = .apiKey
        }
    }

    private func save() {
        errorText = nil
        let configResult = draft.makeProviderConfig(existingProvider: provider)
        guard case .success(let config) = configResult else {
            if case .failure(let validationError) = configResult {
                errorText = validationError.message
            }
            focusAPIKeyField()
            return
        }
        let apiKeyForSave = draft.apiKeyForSave
        let manualModelIDForSave = draft.manualModelIDForSave
        prepareForKeychainPrompt()
        isSaving = true
        Task {
            let result = await providers.upsert(config,
                                                apiKey: apiKeyForSave,
                                                manualModelID: manualModelIDForSave)
            await MainActor.run {
                isSaving = false
                guard result.isSuccess else {
                    // P17 / EX-01 — localize the save-failure message and add an actionable
                    // suffix so the user knows to check API Key / network.
                    let message = result.errorMessage ?? "连接失败，请检查网络或 API Key 后重试"
                    draft.retainAPIKey(afterFailure: .failed(message: message))
                    errorText = message
                    focusAPIKeyField()
                    return
                }
                dismiss()
            }
        }
    }
}
