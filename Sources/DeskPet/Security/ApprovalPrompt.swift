import AppKit
import AICore

// P3 — the user-facing approval prompt for P1+ capability requests. Modal NSAlert with three choices
// mapped to ApprovalDecision. The gate awaits this; the agentic loop suspends until the user answers.
enum ApprovalPrompt {
    @MainActor
    static func ask(capabilityID: String, reason: String, risk: RiskLevel) async -> ApprovalDecision {
        let alert = NSAlert()
        alert.messageText = "桌宠想执行：\(displayName(capabilityID))"
        let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        alert.informativeText = (trimmedReason.isEmpty ? "" : trimmedReason + "\n\n")
            + "风险等级：\(risk.label) · \(riskNote(risk))"
        alert.alertStyle = risk >= .p3 ? .critical : .warning
        alert.addButton(withTitle: "允许一次")
        alert.addButton(withTitle: "本会话都允许")
        alert.addButton(withTitle: "拒绝")
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .allowOnce
        case .alertSecondButtonReturn: return .allowSession
        default: return .deny
        }
    }

    static func displayName(_ id: String) -> String {
        switch id {
        case "reminder.local.create", "reminders.create": return "创建提醒"
        case "reminders.read": return "读取提醒"
        case "calendar.event.create": return "创建日程"
        case "calendar.event.modify": return "修改日程"
        case "calendar.events.read": return "读取日历"
        case "filesystem.workspace.read": return "读取工作区文件"
        case "filesystem.workspace.write": return "写入工作区文件"
        case "filesystem.userSelected.read": return "读取你选择的文件"
        case "network.search": return "联网搜索"
        case "network.fetch": return "联网抓取网页"
        case "network.upload": return "上传数据"
        case "application.launch": return "启动应用"
        case "mail.send": return "发送邮件"
        default:
            // P17 / AT-04 — friendly fallback for unknown capability IDs (e.g. a new tool
            // added before the prompt table is updated). The raw ID is logged for
            // diagnostics; the UI never shows it to the user.
            NSLog("ApprovalPrompt unknown capability id=%@", id)
            return "一项系统操作"
        }
    }

    private static func riskNote(_ r: RiskLevel) -> String {
        switch r {
        case .p0: return "无副作用"
        case .p1: return "只读"
        case .p2: return "可逆写入"
        case .p3: return "对外产生影响"
        case .p4: return "高风险"
        }
    }
}
