import AICore
import PetAgentRuntime
import SwiftUI

struct ChatExpandedView: View {
    @ObservedObject var store: FloatingChatStateStore
    @ObservedObject var chat: ChatModel
    @ObservedObject var providers: ProviderStore
    var onCollapse: () -> Void
    var onDragChanged: (CGSize) -> Void
    var onDragEnded: (CGSize) -> Void
    // P17 / R1-07 — failure recovery CTA only renders when a non-empty closure is
    // provided by the host. The default `{}` no-op closure rendered a visible button
    // that silently did nothing; that violated EX-04 "every failure has a next step".
    // The host (`FloatingChatWindowView`) threads an explicit closure when AI settings
    // are reachable; otherwise the button is hidden.
    var onOpenAISettings: (() -> Void)? = nil

    @FocusState private var inputFocused: Bool
    @State private var showingHistory = false
    // P20 / #4 — hero arrival state. Flips true on first appear so the panel
    // plays its grow-in; stays true after.
    @State private var appeared = false
    // P17 / R4-01 — the R3-01 fix routed MessageBubble through the explicit-scheme
    // DSColor overload, but ChatExpandedView itself still resolved its chrome
    // (panel material, message-area background, composer TextField, warning text,
    // header icon and stop-button tint) through the NSAppearance-derived `DSColor.X`
    // shortcuts. In a window-less NSHostingView (the P17ProductSurfaceHarness's
    // floatingChatExpanded capture) those tokens resolve against `NSApp.appearance`,
    // but `.ultraThinMaterial` ALSO needs a real NSWindow to sample — without one the
    // material falls back to a light surface, producing a dark capture whose chrome is
    // 54.7% light-luminance and a bit-identical white composer TextField
    // (full-frame measurements in 14_review_round_4/FINDINGS.md R4-01).
    //
    // Reading `\.colorScheme` from the SwiftUI environment and routing every fill /
    // foreground / stroke through `DSColor.token(_:scheme:)` removes the NSAppearance
    // dependency entirely: the SwiftUI env value is set explicitly by the harness
    // (`.environment(\.colorScheme, .dark)`) and is what the host production window
    // propagates, so a single source of truth resolves every chrome token.
    //
    // P17 / R5-02 — the R4-01 repair replaced the panel `.ultraThinMaterial` with a
    // permanently-opaque `elevatedSurface`. That silently deviated from the design
    // plan's overlay-material token row (§2: ElevatedSurface = `.ultraThinMaterial` +
    // `glassSurface` fallback) and §7.3 ("Overlay = material"), and diverged from the
    // still-material capsule (ChatCapsuleView.swift:43) and task HUD
    // (FloatingChatWindowView.swift:66). The fix restores the AppGlassContainer-style
    // env-branch: when the user's Reduce Transparency preference is OFF (the default
    // for almost every user), the panel renders `.ultraThinMaterial` like its sibling
    // capsule/HUD; when ON, it falls back to the opaque `DSColor.token(.elevatedSurface,
    // scheme:)` surface so transparency-intolerant users still get a readable panel.
    // The harness sets `\.accessibilityReduceTransparency = true` for the
    // `floatingChatExpanded` capture via the DESKPET_P17_OPAQUE_CHAT env so the dark
    // capture deterministically uses the opaque branch (same dark evidence the R4-01
    // reviewer measured and the guard verifies).
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            header
            if let task = chat.activeTaskActivity {
                TaskActivityCard(task: task,
                                 onApprove: chat.approveActivePlan,
                                 onCancel: chat.cancelActivePlan,
                                 onStop: { chat.stopTask(task.taskID) },
                                 onRetry: { chat.retryTask(task.taskID) },
                                 onOpenDetails: {})
            }
            messageArea
            composer
        }
        .padding(DSSpacing.m)
        .frame(minWidth: FloatingChatPanelMetrics.expandedMinSize.width,
               idealWidth: FloatingChatPanelMetrics.expandedIdealSize.width,
               maxWidth: FloatingChatPanelMetrics.expandedMaxSize.width,
               minHeight: FloatingChatPanelMetrics.expandedMinSize.height,
               idealHeight: FloatingChatPanelMetrics.expandedIdealSize.height,
               maxHeight: FloatingChatPanelMetrics.expandedMaxSize.height)
        // P20 / #4 — the expanded panel slides in from the capsule anchor. The
        // .scaleEffect starts tighter (0.94) and grows while opacity goes 0→1,
        // giving the eye a continuous "grow out of the capsule" motion that
        // complements the capsule's tap squash (ChatCapsuleView.playHero).
        .scaleEffect(appeared ? 1.0 : 0.94, anchor: .topLeading)
        .opacity(appeared ? 1 : 0)
        .animation(reduceTransparency
                   ? .easeInOut(duration: 0.18)
                   : .spring(response: 0.36, dampingFraction: 0.86),
                   value: appeared)
        .background {
            // P17 / R5-02 — AppGlassContainer-style env branch between
            // `.ultraThinMaterial` (default; matches sibling capsule/HUD per design plan
            // §2 token row "ElevatedSurface (overlay chrome)" + §7.3 composition rule) and
            // explicit-scheme `elevatedSurface` when the user has Reduce Transparency on.
            // The harness sets `\.accessibilityReduceTransparency = true` for the
            // `floatingChatExpanded` capture (DESKPET_P17_OPAQUE_CHAT=1) so the dark-mode
            // evidence uses the opaque branch deterministically.
            RoundedRectangle(cornerRadius: DSRadius.large, style: .continuous)
                .fill(reduceTransparency
                      ? AnyShapeStyle(DSColor.token(.elevatedSurface, scheme: colorScheme))
                      : AnyShapeStyle(Material.ultraThinMaterial))
        }
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.large, style: .continuous)
                .strokeBorder(DSColor.token(.border, scheme: colorScheme), lineWidth: 1))
        // P21 — accent-tinted glass glaze on top of the ultraThinMaterial so the
        // expanded panel reads as glass even on macOS 14/15 (no native glass).
        .overlay {
            if !reduceTransparency {
                LiquidGlassTintOverlay(tint: DSColor.primaryAccent, opacity: 0.06)
            }
        }
        .overlay(LiquidGlassEdgeHighlight(cornerRadius: DSRadius.large))
        .shadow(color: .black.opacity(0.18), radius: 24, x: 0, y: 18)
        .onAppear {
            store.isResponding = chat.busy
            inputFocused = true
            appeared = true
        }
        .onChange(of: chat.busy) {
            store.isResponding = chat.busy
            store.markUserActivity()
        }
        .onExitCommand {
            collapse()
        }
        // P17 / CX-02 — pause auto-collapse while the pointer is inside.
        .onHover { hovering in
            store.setPointerInside(hovering)
        }
        .sheet(isPresented: $showingHistory) {
            HistoryPanel(chat: chat)
        }
    }

    private var header: some View {
        HStack(spacing: DSSpacing.s) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(DSColor.token(.primaryAccent, scheme: colorScheme))
                .frame(width: 24, height: 24)
                .background(DSColor.token(.primaryAccent, scheme: colorScheme).opacity(0.12),
                            in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text("DeskPet")
                    .font(DSFont.cardTitle)
                    .foregroundStyle(DSColor.token(.textPrimary, scheme: colorScheme))
                    .lineLimit(1)
                Text(activitySubtitle)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.token(.textSecondary, scheme: colorScheme))
                    .lineLimit(1)
            }

            Spacer()

            // P18 §23 — Awareness indicator chip in the floating-chat header. Same
            // contract as the main chat: hidden when `.off`; otherwise a calm label.
            AwarenessIndicatorChip(
                state: chat.awarenessIndicatorState,
                screenAgeSeconds: chat.awarenessScreenAgeSeconds()
            )

            StatusPill(text: store.modelBadge,
                       symbol: providers.readiness().isReady ? "checkmark.circle" : "exclamationmark.triangle",
                       tint: providers.readiness().isReady
                        ? DSColor.token(.success, scheme: colorScheme)
                        : DSColor.token(.warning, scheme: colorScheme))

            IconButton(symbol: "clock.arrow.circlepath", label: "历史对话", tint: DSColor.token(.textSecondary, scheme: colorScheme)) {
                showingHistory = true
            }
            IconButton(symbol: "chevron.down", label: "收起浮动聊天", tint: DSColor.token(.textSecondary, scheme: colorScheme)) {
                collapse()
            }
        }
        .simultaneousGesture(dragGesture)
        .help("拖动移动浮动聊天")
    }

    private var messageArea: some View {
        // P19.5 / R-CHAT-OVERFLOW — explicit `.frame(maxHeight: .infinity)` so the
        // ScrollView claims ALL remaining vertical space inside the outer VStack. Without
        // this modifier the ScrollView defaults to fitting its content, which (combined
        // with the GeometryReader-in-LazyVStack bug fixed at the MessageBubble level)
        // made the message area visually cramp into the top of the panel. The contract
        // is now: header is bounded, composer is bounded (with its own min/max), and
        // the message area gets whatever is left.
        //
        // P19.5 / R-CHAT-OVERFLOW (follow-up) — the message area ALSO injects the
        // measured column width into the SwiftUI environment so MessageBubble can
        // derive its max bubble width from the column WITHOUT wrapping its body in a
        // top-level GeometryReader. The measurement lives in a bounded GeometryReader
        // (whose parent IS bounded by the outer frame → VStack → ScrollView chain),
        // so the column width is correctly known and the bug is resolved.
        GeometryReader { columnProxy in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: DSSpacing.s) {
                        if chat.conversation.messages.isEmpty {
                            VStack(spacing: DSSpacing.s) {
                                Image(systemName: "sparkles")
                                    .font(.system(size: 24, weight: .medium))
                                    .foregroundStyle(DSColor.token(.secondaryAccent, scheme: colorScheme))
                                    .accessibilityHidden(true)
                                Text(emptyStateText)
                                    .font(DSFont.body)
                                    .foregroundStyle(DSColor.token(.textSecondary, scheme: colorScheme))
                                    .multilineTextAlignment(.center)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, DSSpacing.l)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.top, 80)
                        } else {
                            ForEach(chat.conversation.messages) { message in
                                messageView(for: message)
                                    .id(message.id)
                            }
                        }
                    }
                    .padding(DSSpacing.m)
                }
                .frame(maxHeight: .infinity)
                .onChange(of: chat.conversation.messages.count) {
                    if let last = chat.conversation.messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .environment(\.chatColumnWidth, columnProxy.size.width)
        }
        .frame(maxHeight: .infinity)
        .background(DSColor.token(.appBackground, scheme: colorScheme).opacity(0.88),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                .strokeBorder(DSColor.token(.border, scheme: colorScheme), lineWidth: 1))
    }

    @ViewBuilder
    private func messageView(for message: ChatMessage) -> some View {
        if let activity = message.activity, message.role == .activity {
            ChatActivityBubble(activity: activity,
                               compact: true,
                               localDiscoveryPresentationStore: chat.localDiscoveryPresentationStore,
                               placeHandoffViewModel: chat.placeHandoffViewModel)
        } else {
            MessageBubble(role: message.role == .user ? .user : .assistant,
                          text: message.text,
                          status: bubbleStatus(for: message.status),
                          onRetry: message.status == .failed
                            ? { chat.retry(message) } : nil,
                          onRegenerate: message.status == .completed
                            ? { chat.regenerate(message) } : nil,
                          onOpenAISettings: message.status == .failed
                            ? onOpenAISettings : nil,
                          transientStatusText: chat.transientStatusText)
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
            if !providers.readiness().isReady {
                Text(floatingReadinessMessage)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.token(.warning, scheme: colorScheme))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(alignment: .bottom, spacing: DSSpacing.s) {
                TextField("问我点什么…", text: $store.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(DSFont.body)
                    .lineLimit(1...4)
                    .focused($inputFocused)
                    .padding(.horizontal, DSSpacing.m)
                    .padding(.vertical, DSSpacing.s)
                    .background(DSColor.token(.elevatedSurface, scheme: colorScheme),
                                in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                            .strokeBorder(DSColor.token(.border, scheme: colorScheme), lineWidth: 1))
                    .onSubmit(send)
                    .onChange(of: store.draft) {
                        store.markUserActivity()
                    }
                    // P17 / CX-03 — drafting is always allowed; only the send/stop button
                    // gates on provider readiness so the keyboard stays explorable.
                    .disabled(chat.busy)

                // P18 §22 — "look at my screen" affordance. Hidden when awareness
                // level is below L3.
                if chat.canRequestScreen {
                    IconButton(symbol: chat.useScreenForNextMessage ? "eye.fill" : "eye",
                               label: chat.useScreenForNextMessage ? "下次发送会附带屏幕内容" : "让桌宠看你的屏幕",
                               tint: chat.useScreenForNextMessage
                                ? DSColor.token(.primaryAccent, scheme: colorScheme)
                                : DSColor.token(.secondaryAccent, scheme: colorScheme)) {
                        chat.useScreenForNextMessage.toggle()
                        store.markUserActivity()
                    }
                    .disabled(chat.busy)
                    .accessibilityIdentifier("chat.lookAtScreen")
                }

                if chat.busy {
                    IconButton(symbol: "stop.fill", label: "停止生成", tint: DSColor.token(.destructive, scheme: colorScheme)) {
                        chat.stopGenerating()
                        store.markUserActivity()
                    }
                } else {
                    IconButton(symbol: "paperplane.fill",
                               label: "发送消息",
                               tint: canSend
                                ? DSColor.token(.primaryAccent, scheme: colorScheme)
                                : DSColor.token(.textTertiary, scheme: colorScheme)) {
                        send()
                    }
                    .disabled(!canSend)
                }
            }
        }
    }

    private var canSend: Bool {
        providers.readiness().isReady &&
        !chat.busy &&
        !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var activitySubtitle: String {
        if chat.busy { return "正在回复" }
        if let task = chat.activeTaskActivity { return activityText(for: task) }
        return "轻量陪伴聊天"
    }

    private func activityText(for task: AgentTaskActivitySnapshot) -> String {
        guard let run = task.latestRun else { return "正在处理任务" }
        switch run.status {
        case .waitingForApproval, .waitingForPermission, .waitingForUser: return "等待你的确认"
        case .running: return "正在处理任务"
        case .planning: return "正在规划"
        case .synthesizing: return "正在整理结果"
        default: return "轻量陪伴聊天"
        }
    }

    private var emptyStateText: String {
        providers.readiness().isReady ? "我在桌面边上，随时可以聊。" : floatingReadinessMessage
    }

    private var floatingReadinessMessage: String {
        switch providers.readiness() {
        case .noProvider:
            return "请先在主窗口的 AI 设置中连接本地模型或云端服务。"
        case .providerConfiguredButDisconnected(let providerName):
            return "\(providerName) 还不能用于回复，请检查连接或 API Key。"
        case .providerConnectedNoModel(let providerName):
            return "\(providerName) 已连接，请在 AI 设置中选择默认模型。"
        case .ready:
            return "可以聊天"
        case .error(let message):
            return message
        }
    }

    private func send() {
        let text = store.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, providers.readiness().isReady, !chat.busy else { return }
        store.draft = ""
        store.isResponding = true
        store.markUserActivity()
        chat.send(text, kind: .chat, useScreen: false)
    }

    private func collapse() {
        store.collapseToCapsule()
        onCollapse()
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { value in
                store.markUserActivity()
                onDragChanged(value.translation)
            }
            .onEnded { value in
                store.markUserActivity()
                onDragEnded(value.translation)
            }
    }
}
