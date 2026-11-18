import Foundation

/// Rule-based (non-AI) parser turning a short Chinese phrase into a structured TaskDraft for
/// confirmation (doc §9.3). Deterministic given `now` so it is fully unit-testable. Local LLM
/// parsing arrives in M3; until then this never auto-commits — it only proposes a draft.
enum TaskDraftParser {

    static func parse(_ text: String, now: Date = Date(),
                      calendar: Calendar = .current) -> TaskDraft {
        var work = text
        var draft = TaskDraft(title: text, rawText: text)

        // --- focus rounds: "两轮" / "2轮" ---
        if let (rounds, matched) = firstInt(in: work, suffix: "轮") {
            draft.focusRounds = rounds
            work = removeFirst(matched, from: work)
        }
        // --- focus length: "45分钟" / "45分" ---
        if let (mins, matched) = firstInt(in: work, suffix: "分钟") ?? firstInt(in: work, suffix: "分") {
            draft.estimatedMinutes = mins
            work = removeFirst(matched, from: work)
        }
        // --- priority keywords ---
        for kw in ["重要", "紧急", "优先"] where work.contains(kw) {
            draft.priority = .high; work = removeFirst(kw, from: work)
        }
        for kw in ["不急", "随便", "有空"] where work.contains(kw) {
            draft.priority = .low; work = removeFirst(kw, from: work)
        }
        // --- due date ---
        if let (date, consumed) = parseDue(work, now: now, calendar: calendar) {
            draft.due = date
            for token in consumed { work = removeFirst(token, from: work) }
        }

        draft.title = cleanTitle(work, fallback: text)
        return draft
    }

    // MARK: Due parsing

    private static let dayTokens: [(token: String, offset: Int, eveningImplied: Bool)] = [
        ("大后天", 3, false), ("后天", 2, false), ("明天", 1, false), ("今天", 0, false),
        ("明晚", 1, true), ("今晚", 0, true), ("后晚", 2, true),
    ]
    private static let timeWords: [(word: String, hour: Int)] = [
        ("凌晨", 1), ("早上", 9), ("上午", 9), ("中午", 12), ("下午", 15),
        ("傍晚", 18), ("晚上", 21), ("深夜", 23),
    ]

    private static func parseDue(_ text: String, now: Date, calendar: Calendar) -> (Date, [String])? {
        var consumed: [String] = []
        var offset: Int?
        var hour = 21          // default evening deadline
        var pm = false

        for d in dayTokens where text.contains(d.token) {
            offset = d.offset; consumed.append(d.token)
            if d.eveningImplied { hour = 21 }
            break
        }
        for t in timeWords where text.contains(t.word) {
            hour = t.hour; consumed.append(t.word)
            pm = t.hour >= 12
            break
        }
        if let (h, matched) = firstInt(in: text, suffix: "点") {
            hour = (pm && h < 12) ? h + 12 : h
            consumed.append(matched)
        }
        if text.contains("前") { consumed.append("前") }   // deadline marker, no semantic change

        guard let off = offset else { return nil }
        let base = calendar.startOfDay(for: now)
        guard let day = calendar.date(byAdding: .day, value: off, to: base),
              let due = calendar.date(bySettingHour: min(23, max(0, hour)), minute: 0, second: 0, of: day)
        else { return nil }
        return (due, consumed)
    }

    // MARK: Helpers

    private static let cnDigits: [Character: Int] = [
        "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
        "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    ]

    /// Find "<number><suffix>" where number is Arabic or a simple CN digit. Returns value + the
    /// full matched substring (e.g. "两轮", "45分钟").
    private static func firstInt(in text: String, suffix: String) -> (Int, String)? {
        guard let r = text.range(of: suffix) else { return nil }
        // Walk left from the suffix collecting digits.
        var idx = r.lowerBound
        var digits = ""
        while idx > text.startIndex {
            let prev = text.index(before: idx)
            let ch = text[prev]
            if ch.isNumber || cnDigits[ch] != nil { digits.insert(ch, at: digits.startIndex); idx = prev }
            else { break }
        }
        guard !digits.isEmpty else { return nil }
        let value: Int
        if let n = Int(digits) { value = n }
        else if digits.count == 1, let n = cnDigits[digits.first!] { value = n }
        else { value = digits.compactMap { cnDigits[$0] }.first ?? 0 }
        let matched = String(text[idx..<r.upperBound])
        return (value, matched)
    }

    private static func removeFirst(_ sub: String, from text: String) -> String {
        guard let r = text.range(of: sub) else { return text }
        return text.replacingCharacters(in: r, with: "")
    }

    private static func cleanTitle(_ text: String, fallback: String) -> String {
        let punct = CharacterSet(charactersIn: "，,。.；;、 　\n\t！!？?·…-")
        let trimmed = text.trimmingCharacters(in: punct.union(.whitespacesAndNewlines))
        // Collapse stray internal punctuation left behind by removals.
        let collapsed = trimmed
            .replacingOccurrences(of: "，，", with: "，")
            .trimmingCharacters(in: punct)
        return collapsed.isEmpty ? fallback : collapsed
    }
}
