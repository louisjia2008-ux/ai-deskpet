import Combine
import SwiftUI
import AICore
import PetAgentRuntime

@MainActor
final class CompanionChatViewModel: ObservableObject {
    let chat: ChatModel
    private let providers: ProviderStore
    private var cancellables: Set<AnyCancellable> = []

    init(chat: ChatModel, providers: ProviderStore) {
        self.chat = chat
        self.providers = providers
        chat.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        providers.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    var messages: [ChatMessage] { chat.conversation.messages }
    var busy: Bool { chat.busy }
    var transientStatusText: String? { chat.transientStatusText }
    var activeTask: AgentTaskActivitySnapshot? { chat.activeTaskActivity }
    var readiness: ModelReadinessState { providers.readiness() }
    var canSend: Bool { readiness.isReady && !busy }

    #if DEBUG
    /// P15.1 — test-only accessor so the GUI acceptance harness can construct
    /// a view model with a real ChatModel.
    var providersForTesting: ProviderStore { providers }
    #endif
    var setupTitle: String { readiness.consumerSetupTitle }
    var setupMessage: String { readiness.consumerSetupMessage }

    var modelBadgeText: String {
        // P17 / R1-14 — main chat header pill mirrors the floating-side mapping
        // (display name only). The "Provider / model-id" raw pattern is reserved for
        // the developer disclosure.
        switch readiness {
        case .ready(let providerName, _):
            return providerName.isEmpty ? readiness.consumerShortLabel : providerName
        default:
            return readiness.consumerShortLabel
        }
    }

    func send(_ text: String) {
        guard canSend else { return }
        chat.send(text, kind: .chat, useScreen: false)
    }

    func stop() {
        chat.stopGenerating()
    }

    func approveActivePlan() {
        chat.approveActivePlan()
    }

    func cancelActivePlan() {
        chat.cancelActivePlan()
    }

    func stopTask(_ taskID: UUID) {
        chat.stopTask(taskID)
    }

    func retryTask(_ taskID: UUID) {
        chat.retryTask(taskID)
    }

    func retry(_ message: ChatMessage) {
        chat.retry(message)
    }

    func regenerate(_ message: ChatMessage) {
        chat.regenerate(message)
    }

    func newConversation() {
        chat.newConversation(kind: chat.conversation.kind)
    }
}

struct CompanionChatView: View {
    @ObservedObject var viewModel: CompanionChatViewModel
    var onOpenAISettings: () -> Void = {}
    @State private var draft = ""
    @State private var showingHistory = false
    @FocusState private var inputFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// P18 §23 — Bind the chat's `useScreenForNextMessage` toggle into the composer
    /// so the "看看我现在的屏幕" affordance reflects the next-message state.
    private var useScreenBinding: Binding<Bool> {
        Binding(get: { viewModel.chat.useScreenForNextMessage },
                set: { viewModel.chat.useScreenForNextMessage = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            chatHeader
            if let task = viewModel.activeTask {
                TaskActivityCard(task: task,
                                 onApprove: viewModel.approveActivePlan,
                                 onCancel: viewModel.cancelActivePlan,
                                 onStop: { viewModel.stopTask(task.taskID) },
                                 onRetry: { viewModel.retryTask(task.taskID) },
                                 onOpenDetails: {})
                    .accessibilityIdentifier("chat.liveActivity")
            }
            messageArea
            composer
        }
        .padding(DSSpacing.m)
        .background(DSColor.elevatedSurface, in: RoundedRectangle(cornerRadius: DSRadius.regular, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.regular, style: .continuous).strokeBorder(DSColor.border, lineWidth: 1))
        .frame(minHeight: 480)
        .sheet(isPresented: $showingHistory) {
            HistoryPanel(chat: viewModel.chat)
        }
    }

    private var chatHeader: some View {
        HStack(spacing: DSSpacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text("聊天").font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                Text("和桌宠说话").font(DSFont.caption).foregroundStyle(DSColor.textSecondary)
            }
            Spacer()
            // P18 §23 — Awareness indicator chip next to the model badge. Hidden when
            // `awarenessIndicatorState == .off` because that's the visual contract.
            AwarenessIndicatorChip(
                state: viewModel.chat.awarenessIndicatorState,
                screenAgeSeconds: viewModel.chat.awarenessScreenAgeSeconds()
            )
            StatusPill(text: viewModel.modelBadgeText,
                       symbol: viewModel.readiness.isReady ? "checkmark.circle" : "exclamationmark.triangle",
                       tint: viewModel.readiness.isReady ? DSColor.success : DSColor.warning)
                .accessibilityIdentifier("provider.selected")
            IconButton(symbol: "clock.arrow.circlepath", label: "历史对话") {
                showingHistory = true
            }
            IconButton(symbol: "square.and.pencil", label: "新对话") {
                viewModel.newConversation()
                inputFocused = true
            }
        }
    }

    private var messageArea: some View {
        // P19.5 / R-CHAT-OVERFLOW — measure the column width here (where the parent
        // IS bounded by the outer chat VStack) and inject it via the chatColumnWidth
        // env value so MessageBubble can resolve its max bubble width without
        // wrapping its body in a top-level GeometryReader. See
        // `Sources/DeskPet/DesignSystem/ChatLayoutEnvironment.swift` for the rationale.
        GeometryReader { columnProxy in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: DSSpacing.s) {
                        if viewModel.messages.isEmpty {
                            if viewModel.readiness.isReady {
                                EmptyStateView(symbol: "bubble.left.and.bubble.right",
                                               title: "今天想聊什么？",
                                               message: "我在这儿。") {
                                    EmptyView()
                                }
                                .padding(.top, DSSpacing.xl)
                            } else {
                                ChatAISetupCard(title: viewModel.setupTitle,
                                                message: viewModel.setupMessage,
                                                action: onOpenAISettings)
                                    .padding(.top, DSSpacing.xl)
                            }
                        } else {
                            // P17 / CX-06 — gentle insert transition. Respect Reduce Motion
                            // by routing through DSMotion.content, which collapses to a
                            // short opacity fade for users who can't tolerate movement.
                            ForEach(viewModel.messages) { message in
                                messageView(for: message)
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                            }
                        }
                    }
                    .padding(DSSpacing.m)
                    .animation(DSMotion.content(reduceMotion), value: viewModel.messages.count)
                }
                .onChange(of: viewModel.messages.count) {
                    if let last = viewModel.messages.last {
                        withAnimation(DSMotion.content(reduceMotion)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
            .environment(\.chatColumnWidth, columnProxy.size.width)
        }
        .background(DSColor.appBackground, in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous).strokeBorder(DSColor.border, lineWidth: 1))
        .accessibilityIdentifier("chat.messageList")
    }

    @ViewBuilder
    private func messageView(for message: ChatMessage) -> some View {
        if let activity = message.activity, message.role == .activity {
            ChatActivityBubble(activity: activity,
                               localDiscoveryPresentationStore: viewModel.chat.localDiscoveryPresentationStore,
                               placeHandoffViewModel: viewModel.chat.placeHandoffViewModel)
                .id(message.id)
                .accessibilityIdentifier("chat.message.\(message.id.uuidString)")
                // P20 / #1 — every message gets a gentle reveal on insert.
                .bubbleReveal(reduceMotion: reduceMotion)
        } else {
            // P20 / #2 — typewriter reveal kicks in only for assistant ("pet")
            // messages that are still pending (i.e. streaming) so the user
            // sees the text materialize in real time.
            let isStreaming = message.role == .pet && message.status == .pending
            let bubble = MessageBubble(role: message.role == .user ? .user : .assistant,
                                       text: message.text,
                                       status: bubbleStatus(for: message.status),
                                       onRetry: message.status == .failed
                                         ? { viewModel.retry(message) } : nil,
                                       onRegenerate: message.status == .completed
                                         ? { viewModel.regenerate(message) } : nil,
                                       onOpenAISettings: message.status == .failed
                                         ? { onOpenAISettings() } : nil,
                                       transientStatusText: viewModel.transientStatusText,
                                       isRevealing: isStreaming)
                .id(message.id)
                .accessibilityIdentifier("chat.message.\(message.id.uuidString)")
                .bubbleReveal(reduceMotion: reduceMotion)
            // P20 / #10 — failed bubbles also accept a left swipe to retry in
            // addition to the inline "重试" button.
            if message.status == .failed {
                bubble.swipeToRetry(isEnabled: true) {
                    viewModel.retry(message)
                }
            } else {
                bubble
            }
        }
    }

    private func bubbleStatus(for status: MessageStatus) -> MessageBubble.Status {
        switch status {
        case .pending: return .pending
        case .completed: return .completed
        case .failed: return .failed
        case .cancelled: return .cancelled
        case .interrupted: return .interrupted
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            if !viewModel.readiness.isReady {
                InlineNotice(kind: .warning,
                             text: viewModel.setupMessage,
                             actionTitle: "设置 AI") {
                    onOpenAISettings()
                }
            }
            HStack(alignment: .bottom, spacing: DSSpacing.s) {
                TextField("问我点什么…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(DSFont.body)
                    .lineLimit(1...5)
                    .focused($inputFocused)
                    .padding(.horizontal, DSSpacing.m)
                    .padding(.vertical, DSSpacing.s)
                    .background(DSColor.appBackground, in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                            .strokeBorder(DSColor.border, lineWidth: 1))
                    .onSubmit(send)
                    // P20 / #8 — while the user has non-empty draft text and the
                    // input is focused, the border breathes to acknowledge typing.
                    .draftingPulse(isActive: inputFocused && !draft.isEmpty,
                                   tint: DSColor.primaryAccent,
                                   reduceMotion: reduceMotion)
                    // P17 / CX-03 — only the send button gates on provider readiness so the
                    // keyboard stays explorable.
                    .disabled(viewModel.busy)
                    .accessibilityIdentifier("chat.input")
                // P18 §22 — "look at my screen" affordance. Hidden when awareness level
                // is below L3 (the gate is `viewModel.chat.canRequestScreen`).
                if viewModel.chat.canRequestScreen {
                    IconButton(symbol: useScreenBinding.wrappedValue ? "eye.fill" : "eye",
                               label: useScreenBinding.wrappedValue ? "下次发送会附带屏幕内容" : "让桌宠看你的屏幕",
                               tint: useScreenBinding.wrappedValue ? DSColor.primaryAccent : DSColor.secondaryAccent) {
                        useScreenBinding.wrappedValue.toggle()
                    }
                    .disabled(viewModel.busy)
                    .accessibilityIdentifier("chat.lookAtScreen")
                }

                if viewModel.busy {
                    IconButton(symbol: "stop.fill", label: "停止", tint: DSColor.destructive) {
                        viewModel.stop()
                    }
                    .accessibilityIdentifier("chat.stop")
                } else {
                    IconButton(symbol: "paperplane.fill", label: "发送", tint: canSubmit ? DSColor.primaryAccent : DSColor.textTertiary) {
                        send()
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("chat.send")
                }
            }
        }
    }

    private var canSubmit: Bool {
        viewModel.canSend && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        viewModel.send(text)
    }
}

private struct ChatAISetupCard: View {
    let title: String
    let message: String
    var action: () -> Void

    var body: some View {
        VStack(spacing: DSSpacing.s) {
            Image(systemName: "sparkles")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(DSColor.primaryAccent)
                .accessibilityHidden(true)
            Text(title)
                .font(DSFont.cardTitle)
                .foregroundStyle(DSColor.textPrimary)
                .multilineTextAlignment(.center)
            Text(message)
                .font(DSFont.body)
                .foregroundStyle(DSColor.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 420)
            Button("设置 AI") {
                action()
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityIdentifier("chat.aiSetup")
            Text("你可以使用本地模型或自己的云端 API Key；密钥会保存在 macOS 钥匙串。")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textTertiary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity)
        .padding(DSSpacing.l)
        .accessibilityElement(children: .contain)
    }
}

private struct CompanionMessageBubbleRemoved {
    // P17 / CI-01 — replaced by the shared `MessageBubble` in DesignComponents.swift.
    // The old struct previously rendered here; tests that referenced `message.viaCloud`
    // (P10-era) no longer apply because the shared bubble does not need that field.
}

private extension ModelReadinessState {
    var consumerShortLabel: String {
        switch self {
        case .noProvider:
            return "需要设置 AI"
        case .providerConfiguredButDisconnected:
            return "AI 未连接"
        case .providerConnectedNoModel:
            return "需要选择模型"
        case .ready:
            return shortLabel
        case .error:
            return "AI 设置需要处理"
        }
    }

    var consumerSetupTitle: String {
        switch self {
        case .noProvider:
            return "先连接一个 AI"
        case .providerConfiguredButDisconnected:
            return "AI 还没有连接成功"
        case .providerConnectedNoModel:
            return "选择一个可用模型"
        case .ready:
            return "AI 已就绪"
        case .error:
            return "AI 设置需要处理"
        }
    }

    var consumerSetupMessage: String {
        switch self {
        case .noProvider:
            return "DeskPet 需要一个本地模型或云端 AI 服务来回复你。"
        case .providerConfiguredButDisconnected(let providerName):
            return "\(providerName) 还不能用于回复。请检查连接、API Key 或本地服务是否正在运行。"
        case .providerConnectedNoModel(let providerName):
            return "\(providerName) 已连接，但还没有为聊天选择默认模型。"
        case .ready:
            return "可以开始聊天。"
        case .error(let message):
            return message
        }
    }
}
