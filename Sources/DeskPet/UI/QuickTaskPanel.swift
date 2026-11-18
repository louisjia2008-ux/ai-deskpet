import AppKit
import SwiftUI

/// Lightweight floating input for the global quick-task hotkey (doc §9.3 — 在任意 App 中快速呼出).
/// Parses to a draft and shows it for confirmation; never auto-commits.
@MainActor
final class QuickTaskPanel {

    private let model: AppModel
    private var panel: NSPanel?

    init(model: AppModel) { self.model = model }

    func toggle() {
        if let p = panel, p.isVisible { close(); return }
        show()
    }

    private func show() {
        let view = QuickTaskView(model: model) { [weak self] in self?.close() }
        let hosting = NSHostingController(rootView: view)
        let p = NSPanel(contentViewController: hosting)
        p.styleMask = [.titled, .closable, .nonactivatingPanel]
        p.title = "快速任务"
        p.isFloatingPanel = true
        p.level = .floating
        p.setContentSize(NSSize(width: 420, height: 150))
        p.center()
        panel = p
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }

    private func close() { panel?.close(); panel = nil }
}

private struct QuickTaskView: View {
    @ObservedObject var model: AppModel
    var onDone: () -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("快速新建任务").font(.caption).foregroundStyle(.secondary)
            TextField("如：明天下午写周报，1轮25分钟", text: $text)
                .textFieldStyle(.roundedBorder)
                .onSubmit { model.makeDraft(from: text) }

            if let d = model.draft {
                HStack {
                    Text(d.title).bold()
                    if let due = d.due { Text(TodayTaskRow.df.string(from: due)).foregroundStyle(.secondary) }
                    Spacer()
                    Button("确认") { model.confirmDraft(); onDone() }.buttonStyle(PrimaryButtonStyle())
                    Button("取消") { model.discardDraft() }
                }
            } else {
                HStack {
                    Spacer()
                    Button("解析") { model.makeDraft(from: text) }.disabled(text.isEmpty)
                }
            }
        }
        .padding()
    }
}
