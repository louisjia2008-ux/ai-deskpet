import Foundation

/// Relationship & rewards (doc §10). The score is internal and PRECISE but never shown as a number
/// (doc §10.4) and is strictly MONOTONIC — nothing here can ever decrease it (doc §10.2 无惩罚原则).

public enum RelationshipStage: Int, CaseIterable, Codable, Sendable, Comparable {
    case acquaintance, familiar, trusted, close, bestie
    public static func < (l: Self, r: Self) -> Bool { l.rawValue < r.rawValue }
    public var label: String {
        switch self {
        case .acquaintance: return "初识"
        case .familiar: return "熟悉"
        case .trusted: return "信任"
        case .close: return "亲密"
        case .bestie: return "挚友"
        }
    }
    /// Score at which this stage begins.
    public var threshold: Double {
        switch self {
        case .acquaintance: return 0
        case .familiar: return 20
        case .trusted: return 60
        case .close: return 140
        case .bestie: return 300
        }
    }
}

/// Positive-only interactions (doc §10.3). There is deliberately no "negative" kind.
public enum InteractionKind: Sendable {
    case pet, chat, play, focusComplete, taskComplete, dailyGreeting
    public var weight: Double {
        switch self {
        case .pet: return 1
        case .chat: return 2
        case .play: return 1
        case .focusComplete: return 5
        case .taskComplete: return 3
        case .dailyGreeting: return 2
        }
    }
}

public struct RelationshipState: Codable, Equatable, Sendable {
    /// Hidden, precise, monotonic non-decreasing.
    public private(set) var score: Double
    public init(score: Double = 0) { self.score = max(0, score) }

    /// Add affinity. Returns true if this pushed into a new (higher) stage.
    @discardableResult
    public mutating func record(_ kind: InteractionKind) -> Bool {
        let before = stage
        score += kind.weight            // never subtracts (doc §10.2)
        return stage > before
    }

    public var stage: RelationshipStage {
        RelationshipStage.allCases.last { score >= $0.threshold } ?? .acquaintance
    }

    /// Vague within-stage progress 0…1 (presented only fuzzily, never as a number — doc §10.4).
    public var fuzzyProgress: Double {
        let stages = RelationshipStage.allCases
        guard let idx = stages.firstIndex(of: stage) else { return 0 }
        guard idx + 1 < stages.count else { return 1 }   // top stage
        let lo = stages[idx].threshold, hi = stages[idx + 1].threshold
        return min(1, max(0, (score - lo) / (hi - lo)))
    }

    /// Coarse hint for the relationship page (no numbers).
    public var progressHint: String {
        if stage == .bestie { return "我们已经是最好的搭档啦" }
        switch fuzzyProgress {
        case ..<0.34: return "我们的关系还在慢慢加深"
        case ..<0.74: return "感觉我们越来越合拍了"
        default: return "好像快要更进一步了～"
        }
    }
}

/// Unlockable accessories (doc §10.3 少量配饰).
public enum Accessory: String, CaseIterable, Codable, Sendable {
    case hairclip, glasses, badge, scarf, cape, nightcap, dragonCollar
    public var label: String {
        switch self {
        case .hairclip: return "发夹"
        case .glasses: return "眼镜"
        case .badge: return "徽章"
        case .scarf: return "围巾"
        case .cape: return "小斗篷"
        case .nightcap: return "睡帽"
        case .dragonCollar: return "小龙项圈"
        }
    }
    public var unlockStage: RelationshipStage {
        switch self {
        case .hairclip: return .acquaintance
        case .glasses, .dragonCollar: return .familiar
        case .badge, .scarf: return .trusted
        case .cape, .nightcap: return .close
        }
    }
}

/// What each stage unlocks (doc §10.3 关系变化解锁台词/动作/配饰). Lines are flavor for the page.
public enum RewardCatalog {
    public static func accessories(upTo stage: RelationshipStage) -> [Accessory] {
        Accessory.allCases.filter { $0.unlockStage <= stage }
    }
    public static func unlockedLines(at stage: RelationshipStage) -> [String] {
        switch stage {
        case .acquaintance: return ["请多关照呀～"]
        case .familiar: return ["今天也一起加油！", "我记得你喜欢的节奏咯"]
        case .trusted: return ["有你在我很安心", "需要我帮你挡一会儿消息吗？"]
        case .close: return ["嘿嘿，就知道你会回来", "我们的小窝又添新东西啦"]
        case .bestie: return ["不管多久，我都在这儿等你", "最好的搭档，没有之一！"]
        }
    }
}

/// Internal vitals expressed through behavior, never as care-bars (doc §10.4). No "sickness".
public struct PetVitals: Codable, Equatable, Sendable {
    public var energy: Double   // 0…1
    public var mood: Double     // 0…1
    public init(energy: Double = 0.7, mood: Double = 0.6) {
        self.energy = energy; self.mood = mood
    }
    public mutating func onInteraction() {
        mood = min(1, mood + 0.06)
        energy = min(1, energy + 0.02)
    }
    /// Gentle drift — lower energy just means more resting poses, never penalty (doc §10.2).
    public mutating func drift(dtHours: Double) {
        energy = max(0.2, energy - 0.03 * dtHours)
        mood = mood > 0.5 ? max(0.5, mood - 0.01 * dtHours) : min(0.5, mood + 0.01 * dtHours)
    }
    public var moodHint: String {
        switch mood {
        case ..<0.4: return "有点懒洋洋的"
        case ..<0.7: return "心情平稳"
        default: return "心情很好"
        }
    }
}
