import SwiftUI
import AICore

/// P17 / CX-01 — portable conversation-history panel. Reaches the `chat.history` data
/// source that previously lived in the dead `ChatView.HistoryView`. Used by main chat
/// header (CompanionChatView) and floating chat header (ChatExpandedView) — both surface
/// the same component, with the same styling and copy.
struct HistoryPanel: View {
    @ObservedObject var chat: ChatModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            HStack {
                Text("历史对话").font(DSFont.cardTitle).foregroundStyle(DSColor.textPrimary)
                Spacer()
                IconButton(symbol: "xmark", label: "关闭历史对话") { dismiss() }
            }
            if chat.history.isEmpty {
                EmptyStateView(symbol: "clock.arrow.circlepath",
                               title: "还没有历史对话",
                               message: "对话会在你关闭后出现在这里。") { EmptyView() }
            } else {
                List {
                    ForEach(chat.history) { c in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title).font(DSFont.body)
                                Text("\(c.kind.label) · \(c.messages.count) 条")
                                    .font(DSFont.caption)
                                    .foregroundStyle(DSColor.textSecondary)
                            }
                            Spacer()
                            Button("打开") { chat.open(c); dismiss() }
                                .buttonStyle(SecondaryButtonStyle())
                                .controlSize(.small)
                            Button("归档") { chat.archive(c) }
                                .buttonStyle(SecondaryButtonStyle())
                                .controlSize(.small)
                            Button("删除", role: .destructive) { chat.deleteConversation(c) }
                                .buttonStyle(SecondaryButtonStyle())
                                .controlSize(.small)
                        }
                    }
                }
                .listStyle(.inset)
            }
            HStack { Spacer(); Button("关闭") { dismiss() }.buttonStyle(SecondaryButtonStyle()) }
        }
        .padding(DSSpacing.l)
        .frame(width: 480, height: 440)
        .background(DSColor.elevatedSurface)
    }
}
