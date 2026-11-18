import SwiftUI

struct FloatingChatWindowView: View {
    @ObservedObject var store: FloatingChatStateStore
    @ObservedObject var chat: ChatModel
    @ObservedObject var providers: ProviderStore
    var onExpand: () -> Void
    var onCollapse: () -> Void
    var onDragChanged: (CGSize) -> Void
    var onDragEnded: (CGSize) -> Void
    // P17 / R1-07 + R2-03 — failure recovery CTA in the floating chat opens AI settings
    // when the closure is provided by the host (`FloatingChatPanelController` routes it to
    // the main window's `.providers` section). The value is passed DOWN UNCHANGED: a nil
    // closure must stay nil so `ChatExpandedView` hides the CTA instead of rendering a
    // button that silently does nothing (R2-03 — the previous `?? {}` coalesce defeated
    // the optional and re-introduced the dead button on the production path).
    var onOpenAISettings: (() -> Void)? = nil

    var body: some View {
        Group {
            switch store.visibilityState {
            case .hidden:
                EmptyView()
            case .capsuleIdle, .capsuleActive:
                ChatCapsuleView(store: store,
                                onExpand: onExpand,
                                onDragChanged: onDragChanged,
                                onDragEnded: onDragEnded)
            case .expanded:
                ChatExpandedView(store: store,
                                 chat: chat,
                                 providers: providers,
                                 onCollapse: onCollapse,
                                 onDragChanged: onDragChanged,
                                 onDragEnded: onDragEnded,
                                 onOpenAISettings: onOpenAISettings)
            case .taskHUD:
                taskHUD
            }
        }
    }

    private var taskHUD: some View {
        Button {
            store.expand()
            onExpand()
        } label: {
            HStack(spacing: DSSpacing.s) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text("处理中")
                        .font(DSFont.cardTitle)
                        .foregroundStyle(DSColor.textPrimary)
                    Text("点击查看聊天")
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                }
                Spacer()
                Text(store.modelBadge)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
            }
            .padding(DSSpacing.m)
            .frame(width: 320, height: 88)
            .background(.ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(DSColor.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .simultaneousGesture(dragGesture)
        .accessibilityLabel("打开浮动聊天任务状态")
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
