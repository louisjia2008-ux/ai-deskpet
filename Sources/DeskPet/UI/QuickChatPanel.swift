import AppKit
import SwiftUI
import AICore

/// Quick desktop chat (doc §11.1 短气泡层). A small floating input; the reply appears as a short
/// bubble on the pet and a brief reaction — not in the main window. Long talk lives in ChatView.
@MainActor
final class QuickChatPanel {

    private let chat: ChatModel
    private var panel: NSPanel?

    init(chat: ChatModel) { self.chat = chat }

    func toggle() {
        if let p = panel, p.isVisible { close(); return }
        show()
    }

    private func show() {
        let view = QuickChatView(chat: chat) { [weak self] in self?.close() }
        let hosting = NSHostingController(rootView: view)
        let p = NSPanel(contentViewController: hosting)
        p.styleMask = [.titled, .closable, .nonactivatingPanel]
        p.title = "和她说句话"
        p.isFloatingPanel = true
        p.level = .floating
        p.setContentSize(NSSize(width: 380, height: 90))
        p.center()
        panel = p
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }

    private func close() { panel?.close(); panel = nil }
}

private struct QuickChatView: View {
    @ObservedObject var chat: ChatModel
    var onDone: () -> Void
    @State private var text = ""

    var body: some View {
        HStack {
            TextField("想说点什么…", text: $text)
                .textFieldStyle(.roundedBorder)
                .onSubmit(send)
            Button("发送", action: send).disabled(text.isEmpty || chat.busy)
        }
        .padding()
    }

    private func send() {
        chat.send(text, kind: .quick)
        text = ""
        onDone()
    }
}
