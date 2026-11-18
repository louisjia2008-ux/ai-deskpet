import Foundation
import AICore

// P3 / P5 seams. The architecture and routing are real and tested; the executors that need TCC
// grants (calendar/reminders) or neural weights (Vision/STT/TTS) are slots, BLOCKED on assets.

// MARK: P3 — desktop-assistant intent → capability request (executed via the Broker, never inline)

public enum AssistantCapabilityMap {
    /// Map an assistant utterance to the capability it would need. The runtime DECLARES this; the
    /// app's SecurityKernel decides + executes after approval (C2). Returns nil if unrecognized.
    public static func capability(for text: String) -> CapabilityRequest? {
        if text.contains("提醒") { return CapabilityRequest(capability: "reminders.create", reason: "创建提醒") }
        if text.contains("日历") || text.contains("日程") { return CapabilityRequest(capability: "calendar.event.create", reason: "创建日历事件") }
        if text.contains("打开") || text.contains("启动") { return CapabilityRequest(capability: "application.launch", reason: "打开应用") }
        if text.contains("计时") || text.contains("番茄") || text.contains("倒计时") { return CapabilityRequest(capability: "timer.local", reason: "本地计时") }
        if DateTimeIntentNormalizer.isCurrentDateTimeRequest(text) {
            return CapabilityRequest(capability: "get_current_datetime", reason: "获取当前本地日期和时间")
        }
        return nil
    }
}

public enum DateTimeIntentNormalizer {
    public enum Intent: String, Sendable, Equatable {
        case currentDateTime
    }

    public static func intent(for text: String) -> Intent? {
        let normalized = normalize(text)
        guard !normalized.isEmpty, !isDateEditingRequest(normalized) else { return nil }
        if isChineseCurrentDateTimeRequest(normalized) || isEnglishCurrentDateTimeRequest(normalized) {
            return .currentDateTime
        }
        return nil
    }

    fileprivate static func isCurrentDateTimeRequest(_ text: String) -> Bool {
        intent(for: text) == .currentDateTime
    }

    private static func isChineseCurrentDateTimeRequest(_ text: String) -> Bool {
        let exactPhrases = [
            "当前时间", "本地时间", "现在几点", "现在时间", "当前日期", "本地日期",
            "日期和时间", "日期时间", "现在的日期", "现在的时间", "今天几号",
            "今天是几号", "今天什么日期", "今天是什么日期", "今天是哪一天",
            "告诉我今天的日期", "今天星期几", "今天周几", "今天几号几点"
        ]
        if exactPhrases.contains(where: { text.contains($0) }) { return true }
        if text.contains("今天") {
            let dateTokens = ["几号", "几日", "日期", "哪一天", "星期几", "周几", "几点"]
            if dateTokens.contains(where: { text.contains($0) }) { return true }
        }
        let asksForNow = text.contains("现在") || text.contains("当前") || text.contains("本地")
        let asksForTemporalValue = text.contains("时间") || text.contains("日期") || text.contains("几点")
        return asksForNow && asksForTemporalValue
    }

    private static func isEnglishCurrentDateTimeRequest(_ text: String) -> Bool {
        let phrases = [
            "currenttime", "localtime", "currentdate", "localdate", "dateandtime",
            "whatistodaysdate", "whatistodaydate", "whatdayisittoday", "whattimeisit"
        ]
        if phrases.contains(where: { text.contains($0) }) { return true }
        return text.contains("today") && (text.contains("date") || text.contains("whatday"))
    }

    private static func isDateEditingRequest(_ text: String) -> Bool {
        let editingPhrases = [
            "日期格式", "格式改", "改成yyyy", "邮件里的日期", "带日期的文档",
            "总结这份带日期", "dateformat", "formatdate"
        ]
        if editingPhrases.contains(where: { text.contains($0) }) { return true }
        let hasDate = text.contains("日期") || text.contains("date")
        let editing = ["修改", "改成", "格式", "总结", "文档", "邮件"].contains { text.contains($0) }
        let asksCurrent = ["今天", "现在", "当前", "本地", "today", "current", "local"].contains { text.contains($0) }
        return hasDate && editing && !asksCurrent
    }

    private static func normalize(_ text: String) -> String {
        let replacements: [Character: Character] = [
            "現": "现", "當": "当", "幾": "几", "號": "号", "週": "周",
            "時": "时", "間": "间", "點": "点", "嗎": "吗", "請": "请",
            "訴": "诉", "這": "这", "裡": "里", "裏": "里"
        ]
        let folded = text.lowercased().map { replacements[$0] ?? $0 }
        return String(folded).filter { character in
            character.isLetter || character.isNumber || character == "'"
        }
        .replacingOccurrences(of: "'", with: "")
    }
}

// MARK: P5 — 6-layer memory mapping (collapses M5 flat categories into the layered model, doc §10)

public enum MemoryLayer: String, Sendable, Codable, CaseIterable, Equatable {
    case working, episodic, semantic, preference, project, procedural
}

public enum MemoryLayerMap {
    public static func layer(for category: MemoryCategory) -> MemoryLayer {
        switch category {
        case .preference: return .preference
        case .learningGoal: return .episodic
        case .project: return .project
        case .usageHabit: return .procedural
        case .temporaryContext: return .working
        }
    }
}

// MARK: P5 — multimodal provider slots (neural backends BLOCKED; default unavailable → degrade)

public protocol VisionProviding: Sendable { var isAvailable: Bool { get }; func describe(imageRef: String) async -> String? }
public protocol STTProviding: Sendable { var isAvailable: Bool { get }; func transcribe(audioRef: String) async -> String? }
public protocol TTSProviding: Sendable { var isAvailable: Bool { get }; func synthesize(text: String) async -> String? }

public struct UnavailableVision: VisionProviding { public init() {}; public var isAvailable: Bool { false }; public func describe(imageRef: String) async -> String? { nil } }
public struct UnavailableSTT: STTProviding { public init() {}; public var isAvailable: Bool { false }; public func transcribe(audioRef: String) async -> String? { nil } }
public struct UnavailableTTS: TTSProviding { public init() {}; public var isAvailable: Bool { false }; public func synthesize(text: String) async -> String? { nil } }
