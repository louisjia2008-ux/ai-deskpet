import Foundation

/// Proactive-content categories with the fixed mix from doc §8.1.
enum SpeechCategory: String, CaseIterable, Sendable {
    case companionship   // 日常陪伴 40%
    case encouragement   // 学习鼓励 30%
    case banter          // 吐槽与调皮 20%
    case assistant       // AI 助手 10%

    var weight: Double {
        switch self {
        case .companionship: return 0.40
        case .encouragement: return 0.30
        case .banter: return 0.20
        case .assistant: return 0.10
        }
    }
}

/// Short, one-line proactive lines (doc §8.2 — 一短句). Chinese-first (doc §8.5 默认中文).
/// Selection is deterministic given a roll in [0,1) so cadence/mix are unit-testable.
enum SpeechLibrary {

    static let lines: [SpeechCategory: [String]] = [
        .companionship: ["在呢～", "今天也要一起加油哦", "小龙又在打瞌睡了", "窗外的光好舒服呀", "要不要歇一会儿？"],
        .encouragement: ["这一段你已经很稳啦", "再坚持一下下就好", "刚才那波操作很漂亮", "卡住也没关系，慢慢来", "你比昨天更熟练了"],
        .banter: ["诶——你又在划水？", "小龙说它能比你先写完", "我偷偷记下来咯", "这个 bug 是不是在躲你", "哼，不理我我就去睡觉啦"],
        .assistant: ["需要我帮你理一下思路吗？", "要不要我记下这个待办？", "这段我可以帮你看看", "想查点什么？"],
    ]

    /// Pick a category by cumulative weight. `roll` ∈ [0,1).
    static func pickCategory(roll: Double) -> SpeechCategory {
        var acc = 0.0
        for c in SpeechCategory.allCases {
            acc += c.weight
            if roll < acc { return c }
        }
        return .companionship
    }

    /// Pick a line within a category. `roll` ∈ [0,1).
    static func line(for category: SpeechCategory, roll: Double) -> String {
        let pool = lines[category] ?? ["…"]
        let idx = min(pool.count - 1, max(0, Int(roll * Double(pool.count))))
        return pool[idx]
    }
}
