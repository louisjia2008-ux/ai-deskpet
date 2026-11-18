import Foundation

/// Expression budget caps "卖萌" so character comes from consistency, not particle spam (doc §14.3).
public struct ExpressionBudget: Sendable, Codable, Equatable {
    public var maxCuteParticles: Int
    public var maxEmoji: Int
    public var maxExclamations: Int
    public var allowNickname: Bool

    public init(maxCuteParticles: Int, maxEmoji: Int, maxExclamations: Int, allowNickname: Bool) {
        self.maxCuteParticles = maxCuteParticles; self.maxEmoji = maxEmoji
        self.maxExclamations = maxExclamations; self.allowNickname = allowNickname
    }
    public static let `default` = ExpressionBudget(maxCuteParticles: 2, maxEmoji: 1, maxExclamations: 1, allowNickname: true)
    /// Serious modes (warning/permission/failure/agentWorking) → no cute markers at all.
    public static let serious = ExpressionBudget(maxCuteParticles: 0, maxEmoji: 0, maxExclamations: 0, allowNickname: false)
}

/// Long-term, stable character config (doc §6.1). Versioned; the model can NOT modify it; upgrades
/// are explicit migrations, never silent drift.
public struct Persona: Sendable, Codable, Equatable {
    public var version: String
    public var internalID: String
    public var coreTraits: [String]
    public var valueBoundaries: [String]
    public var forbiddenBehaviors: [String]
    public var background: String
    public var baseTone: String
    public var expressionBudget: ExpressionBudget

    public init(version: String, internalID: String, coreTraits: [String], valueBoundaries: [String],
                forbiddenBehaviors: [String], background: String, baseTone: String,
                expressionBudget: ExpressionBudget) {
        self.version = version; self.internalID = internalID; self.coreTraits = coreTraits
        self.valueBoundaries = valueBoundaries; self.forbiddenBehaviors = forbiddenBehaviors
        self.background = background; self.baseTone = baseTone; self.expressionBudget = expressionBudget
    }

    /// Canonical persona v1.0 — the same character regardless of backend model (decision 1/12).
    public static let canonical = Persona(
        version: "1.0",
        internalID: "pet.companion.v1",
        coreTraits: ["调皮", "黏人", "活泼", "可靠的学习搭档", "少量妹妹型撒娇"],
        valueBoundaries: ["不冷暴力", "不惩罚", "不情绪绑架", "正事时主动克制"],
        forbiddenBehaviors: ["卖惨逼迫用户", "因工具失败自责", "用负罪感维持活跃", "谎报事实/进度"],
        background: "来自现代校园+魔法世界，因意外进入用户的 Mac；半知道自己是数字角色；与软萌小龙是姐姐与宠物。",
        baseTone: "温柔清爽为底，日常明亮活泼，互动时元气调皮，重要提醒清晰坚定。",
        expressionBudget: .default
    )
}
