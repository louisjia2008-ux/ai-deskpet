import Foundation

/// Long-term memory (doc §12). Every field that the Memory Center must surface lives here so the
/// user can see provenance and control retention (doc §12.2 透明度).

public enum MemoryCategory: String, Codable, CaseIterable, Sendable {
    case preference        // 基础偏好 — long-term until changed
    case learningGoal      // 学习目标 — 30–90 天，过期前待确认
    case project           // 项目 — 长期无使用后归档
    case usageHabit        // 使用习惯 — 重复才形成，长期不出现降权
    case temporaryContext  // 临时上下文 — 7–30 天自动过期
    public var label: String {
        switch self {
        case .preference: return "基础偏好"
        case .learningGoal: return "学习目标"
        case .project: return "项目"
        case .usageHabit: return "使用习惯"
        case .temporaryContext: return "临时上下文"
        }
    }
}

public enum MemorySource: String, Codable, CaseIterable, Sendable {
    case explicit    // 用户主动保存
    case suggested   // AI 建议，需确认
    case auto        // 有限低风险自动记忆
    public var label: String {
        switch self { case .explicit: return "用户设置"; case .suggested: return "建议"; case .auto: return "自动" }
    }
}

public enum MemoryPrivacy: String, Codable, CaseIterable, Sendable {
    case normal, sensitive
    public var label: String { self == .normal ? "普通" : "敏感" }
}

public enum MemoryScope: String, Codable, CaseIterable, Sendable, Hashable {
    case working
    case session
    case episodic
    case semantic
    case procedural

    public var label: String {
        switch self {
        case .working: return "工作上下文"
        case .session: return "会话上下文"
        case .episodic: return "经历"
        case .semantic: return "事实/偏好"
        case .procedural: return "工作方式"
        }
    }
}

public enum MemoryState: String, Codable, CaseIterable, Sendable, Hashable {
    case observed
    case active
    case pendingConfirmation
    case rejected
    case superseded
    case expired
    case ignored

    public var isRetrievable: Bool { self == .active }
}

public enum MemorySensitivity: String, Codable, CaseIterable, Sendable, Hashable {
    case ordinary
    case personal
    case sensitive
    case prohibitedSecret
}

public enum MemorySourceKind: String, Codable, CaseIterable, Sendable, Hashable {
    case explicitUserStatement
    case repeatedUserBehavior
    case verifiedTaskOutcome
    case importedLegacyMemory
}

public struct MemorySourceReference: Codable, Equatable, Hashable, Sendable {
    public var conversationID: UUID?
    public var messageID: UUID?
    public var taskID: UUID?
    public var runID: UUID?
    public var eventID: UUID?

    public init(conversationID: UUID? = nil,
                messageID: UUID? = nil,
                taskID: UUID? = nil,
                runID: UUID? = nil,
                eventID: UUID? = nil) {
        self.conversationID = conversationID
        self.messageID = messageID
        self.taskID = taskID
        self.runID = runID
        self.eventID = eventID
    }
}

public struct MemoryItem: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var text: String
    public var category: MemoryCategory
    public var source: MemorySource
    public var reason: String?          // 保存原因
    public var confirmed: Bool          // 确认状态（建议项需确认）
    public var paused: Bool             // 暂停（不参与上下文）
    public var privacy: MemoryPrivacy
    public var localOnly: Bool          // 仅本地（不同步）
    public var blockCloud: Bool         // 禁止发送云端
    public var createdAt: Date
    public var expiresAt: Date?         // 有效期
    public var lastUsed: Date?          // 最近使用时间
    public var useCount: Int            // 使用次数
    public var everEnteredCloud: Bool   // 是否曾进入云端上下文
    public var archived: Bool
    public var canonicalKey: String
    public var scope: MemoryScope
    public var state: MemoryState
    public var sensitivity: MemorySensitivity
    public var normalizedValue: String?
    public var confidence: Double
    public var evidenceCount: Int
    public var sourceReferences: [MemorySourceReference]
    public var updatedAt: Date
    public var lastUsedAt: Date?
    public var supersedesID: UUID?
    public var supersededByID: UUID?
    public var pinned: Bool
    public var userEditable: Bool
    public var schemaVersion: Int

    public init(text: String, category: MemoryCategory, source: MemorySource,
                reason: String? = nil, confirmed: Bool? = nil,
                privacy: MemoryPrivacy = .normal, localOnly: Bool = false, blockCloud: Bool = false,
                createdAt: Date = Date(), expiresAt: Date? = nil, id: UUID = UUID(),
                canonicalKey: String? = nil, scope: MemoryScope? = nil,
                state: MemoryState? = nil, sensitivity: MemorySensitivity? = nil,
                normalizedValue: String? = nil, confidence: Double = 1,
                evidenceCount: Int = 1, sourceReferences: [MemorySourceReference] = [],
                updatedAt: Date? = nil, lastUsedAt: Date? = nil,
                supersedesID: UUID? = nil, supersededByID: UUID? = nil,
                pinned: Bool = false, userEditable: Bool = true,
                schemaVersion: Int = 2) {
        self.id = id
        self.text = text
        self.category = category
        self.source = source
        self.reason = reason
        self.confirmed = confirmed ?? (source == .explicit)   // explicit is auto-confirmed
        self.paused = false
        self.privacy = privacy
        self.localOnly = localOnly
        self.blockCloud = blockCloud
        self.createdAt = createdAt
        self.expiresAt = expiresAt ?? MemoryRetention.defaultExpiry(for: category, from: createdAt)
        self.lastUsed = nil
        self.useCount = 0
        self.everEnteredCloud = false
        self.archived = false
        self.canonicalKey = canonicalKey ?? MemoryCanonicalizer.key(for: text)
        self.scope = scope ?? MemoryLegacyMapper.scope(for: category)
        self.state = state ?? ((confirmed ?? (source == .explicit)) ? .active : .pendingConfirmation)
        self.sensitivity = sensitivity ?? MemoryLegacyMapper.sensitivity(for: privacy)
        self.normalizedValue = normalizedValue ?? text
        self.confidence = min(1, max(0, confidence))
        self.evidenceCount = max(0, evidenceCount)
        self.sourceReferences = sourceReferences
        self.updatedAt = updatedAt ?? createdAt
        self.lastUsedAt = lastUsedAt
        self.supersedesID = supersedesID
        self.supersededByID = supersededByID
        self.pinned = pinned
        self.userEditable = userEditable
        self.schemaVersion = max(1, schemaVersion)
    }

    /// Active = confirmed, not paused, not archived, not expired. Only active memories are used.
    public func isActive(now: Date) -> Bool {
        guard state == .active, confirmed, !paused, !archived else { return false }
        if let exp = expiresAt, now > exp { return false }
        return true
    }

    enum CodingKeys: String, CodingKey {
        case id, text, category, source, reason, confirmed, paused, privacy, localOnly, blockCloud
        case createdAt, expiresAt, lastUsed, useCount, everEnteredCloud, archived
        case canonicalKey, scope, state, sensitivity, normalizedValue, confidence, evidenceCount
        case sourceReferences, updatedAt, lastUsedAt, supersedesID, supersededByID, pinned
        case userEditable, schemaVersion
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        category = (try? c.decode(MemoryCategory.self, forKey: .category)) ?? .temporaryContext
        source = (try? c.decode(MemorySource.self, forKey: .source)) ?? .suggested
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        confirmed = try c.decodeIfPresent(Bool.self, forKey: .confirmed) ?? (source == .explicit)
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        privacy = (try? c.decode(MemoryPrivacy.self, forKey: .privacy)) ?? .normal
        localOnly = try c.decodeIfPresent(Bool.self, forKey: .localOnly) ?? false
        blockCloud = try c.decodeIfPresent(Bool.self, forKey: .blockCloud) ?? false
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        expiresAt = try c.decodeIfPresent(Date.self, forKey: .expiresAt)
            ?? MemoryRetention.defaultExpiry(for: category, from: createdAt)
        lastUsed = try c.decodeIfPresent(Date.self, forKey: .lastUsed)
        useCount = try c.decodeIfPresent(Int.self, forKey: .useCount) ?? 0
        everEnteredCloud = try c.decodeIfPresent(Bool.self, forKey: .everEnteredCloud) ?? false
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        canonicalKey = try c.decodeIfPresent(String.self, forKey: .canonicalKey)
            ?? MemoryCanonicalizer.key(for: text)
        scope = (try? c.decode(MemoryScope.self, forKey: .scope)) ?? MemoryLegacyMapper.scope(for: category)
        state = (try? c.decode(MemoryState.self, forKey: .state))
            ?? (archived ? .superseded : (confirmed ? .active : .pendingConfirmation))
        sensitivity = (try? c.decode(MemorySensitivity.self, forKey: .sensitivity))
            ?? MemoryLegacyMapper.sensitivity(for: privacy)
        normalizedValue = try c.decodeIfPresent(String.self, forKey: .normalizedValue) ?? text
        confidence = min(1, max(0, try c.decodeIfPresent(Double.self, forKey: .confidence) ?? (confirmed ? 1 : 0.6)))
        evidenceCount = max(0, try c.decodeIfPresent(Int.self, forKey: .evidenceCount) ?? max(1, useCount))
        sourceReferences = (try? c.decode([MemorySourceReference].self, forKey: .sourceReferences)) ?? []
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
        lastUsedAt = try c.decodeIfPresent(Date.self, forKey: .lastUsedAt) ?? lastUsed
        supersedesID = try c.decodeIfPresent(UUID.self, forKey: .supersedesID)
        supersededByID = try c.decodeIfPresent(UUID.self, forKey: .supersededByID)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        userEditable = try c.decodeIfPresent(Bool.self, forKey: .userEditable) ?? true
        schemaVersion = max(1, try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1)
    }
}

/// Retention & decay (doc §12.3). Pure and deterministic given `now`.
public enum MemoryRetention {

    public static func defaultExpiry(for category: MemoryCategory, from now: Date) -> Date? {
        switch category {
        case .learningGoal:     return now.addingTimeInterval(60 * 86400)   // 60 天
        case .temporaryContext: return now.addingTimeInterval(14 * 86400)   // 14 天
        default:                return nil
        }
    }

    /// Exponential usage weight from last use (1.0 fresh → 0 stale). Half-life ~30 days.
    public static func effectiveWeight(_ item: MemoryItem, now: Date, halfLifeDays: Double = 30) -> Double {
        let ref = item.lastUsed ?? item.createdAt
        let days = max(0, now.timeIntervalSince(ref) / 86400)
        return pow(0.5, days / halfLifeDays)
    }

    /// Apply retention: drop expired temporary context, mark expired goals as待确认, archive
    /// long-inactive projects and faded usage habits.
    public static func apply(_ items: [MemoryItem], now: Date,
                             projectInactiveDays: Double = 45,
                             habitArchiveWeight: Double = 0.1) -> [MemoryItem] {
        var out: [MemoryItem] = []
        for var m in items {
            if let exp = m.expiresAt, now > exp {
                switch m.category {
                case .temporaryContext: continue           // auto-expire, drop
                case .learningGoal: m.confirmed = false     // 接近/过期 → 待确认
                default: break
                }
            }
            if m.category == .project {
                let ref = m.lastUsed ?? m.createdAt
                if now.timeIntervalSince(ref) > projectInactiveDays * 86400 { m.archived = true }
            }
            if m.category == .usageHabit, effectiveWeight(m, now: now) < habitArchiveWeight {
                m.archived = true
            }
            out.append(m)
        }
        return out
    }
}

/// What may be saved automatically (doc §12.1 有限自动记忆 / 禁止自动记忆).
public enum MemoryPolicy {
    /// Never memorize these, regardless of source.
    public static let forbiddenMarkers = ["密码", "支付", "账号", "信用卡", "cvv", "身份证", "银行卡",
                                          "api key", "apikey", "access token", "bearer ", "otp",
                                          "private key", "authorization:", "password", "secret"]

    public static func isForbiddenContent(_ text: String) -> Bool {
        let t = text.lowercased()
        return forbiddenMarkers.contains { t.contains($0.lowercased()) }
    }

    /// Gate before persisting a memory of the given source/category.
    public static func mayStore(category: MemoryCategory, source: MemorySource, text: String) -> Bool {
        if isForbiddenContent(text) { return false }                 // 禁止自动记忆 sensitive
        switch source {
        case .explicit:  return !isForbiddenContent(text)
        case .suggested: return category != .preference              // suggestions need confirm, not base prefs
        case .auto:      return category == .usageHabit              // only low-risk repeated habits
        }
    }
}

public struct MemoryCandidate: Codable, Equatable, Sendable {
    public var proposedScope: MemoryScope
    public var canonicalKey: String
    public var summary: String
    public var normalizedValue: String
    public var confidence: Double
    public var sensitivityHint: MemorySensitivity
    public var sourceReference: MemorySourceReference?
    public var sourceKind: MemorySourceKind
    public var evidenceKind: MemorySourceKind
    public var explicitlyRequestedByUser: Bool
    public var authoredByAssistant: Bool
    public var rawCategoryHint: String?

    public init(proposedScope: MemoryScope,
                canonicalKey: String? = nil,
                summary: String,
                normalizedValue: String? = nil,
                confidence: Double = 0.8,
                sensitivityHint: MemorySensitivity = .ordinary,
                sourceReference: MemorySourceReference? = nil,
                sourceKind: MemorySourceKind = .explicitUserStatement,
                evidenceKind: MemorySourceKind? = nil,
                explicitlyRequestedByUser: Bool = false,
                authoredByAssistant: Bool = false,
                rawCategoryHint: String? = nil) {
        self.proposedScope = proposedScope
        self.canonicalKey = canonicalKey ?? MemoryCanonicalizer.key(for: summary)
        self.summary = summary
        self.normalizedValue = normalizedValue ?? summary
        self.confidence = min(1, max(0, confidence))
        self.sensitivityHint = sensitivityHint
        self.sourceReference = sourceReference
        self.sourceKind = sourceKind
        self.evidenceKind = evidenceKind ?? sourceKind
        self.explicitlyRequestedByUser = explicitlyRequestedByUser
        self.authoredByAssistant = authoredByAssistant
        self.rawCategoryHint = rawCategoryHint
    }
}

public enum UserAuthoredMemoryCandidateExtractor {
    public static func candidates(from text: String,
                                  sourceReference: MemorySourceReference? = nil) -> [MemoryCandidate] {
        let summary = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty,
              isExplicitLongTermCue(summary),
              !MemoryPolicy.isForbiddenContent(summary),
              !MemoryPolicyEngine.isDateTimeRequest(summary) else {
            return []
        }
        let scope: MemoryScope = isProceduralPreference(summary) ? .procedural : .semantic
        let candidate = MemoryCandidate(
            proposedScope: scope,
            summary: summary,
            normalizedValue: normalizedValue(for: summary),
            confidence: 0.86,
            sensitivityHint: sensitivityHint(for: summary),
            sourceReference: sourceReference,
            sourceKind: .explicitUserStatement,
            explicitlyRequestedByUser: true,
            authoredByAssistant: false,
            rawCategoryHint: scope == .procedural ? "proceduralPreference" : "semanticPreference")
        guard case .autoCommit = MemoryPolicyEngine.decide(candidate: candidate) else {
            return [candidate]
        }
        return [candidate]
    }

    private static func isExplicitLongTermCue(_ text: String) -> Bool {
        ["以后", "默认", "从现在开始", "请记住", "记住", "一定"].contains { text.contains($0) }
    }

    private static func isProceduralPreference(_ text: String) -> Bool {
        let markers = ["报告", "任务", "测试", "代码", "提交", "运行", "工作", "回复格式", "输出格式", "结论"]
        return markers.contains { text.contains($0) }
    }

    private static func sensitivityHint(for text: String) -> MemorySensitivity {
        let markers = ["住址", "地址", "医疗", "健康", "疾病", "财务", "政治", "宗教", "身份", "银行卡", "投资"]
        return markers.contains { text.localizedCaseInsensitiveContains($0) } ? .sensitive : .ordinary
    }

    private static func normalizedValue(for text: String) -> String {
        text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum MemoryPolicyDecision: Equatable, Sendable {
    case ignore(reason: String)
    case keepEphemeral(scope: MemoryScope, expiresAt: Date, reason: String)
    case observe(reason: String)
    case autoCommit(reason: String)
    case requireConfirmation(reason: String)
    case reject(reason: String)
}

public struct MemoryPolicyConfiguration: Equatable, Sendable {
    public var upgradeEvidenceThreshold: Int
    public var upgradeSessionThreshold: Int
    public var upgradeConfidenceThreshold: Double
    public var workingTTL: TimeInterval
    public var sessionTTL: TimeInterval
    public var episodicTTL: TimeInterval

    public init(upgradeEvidenceThreshold: Int = 3,
                upgradeSessionThreshold: Int = 2,
                upgradeConfidenceThreshold: Double = 0.8,
                workingTTL: TimeInterval = 6 * 60 * 60,
                sessionTTL: TimeInterval = 2 * 24 * 60 * 60,
                episodicTTL: TimeInterval = 90 * 24 * 60 * 60) {
        self.upgradeEvidenceThreshold = max(1, upgradeEvidenceThreshold)
        self.upgradeSessionThreshold = max(1, upgradeSessionThreshold)
        self.upgradeConfidenceThreshold = min(1, max(0, upgradeConfidenceThreshold))
        self.workingTTL = max(60, workingTTL)
        self.sessionTTL = max(60, sessionTTL)
        self.episodicTTL = max(60, episodicTTL)
    }
}

public enum MemoryPolicyEngine {
    public static func decide(candidate: MemoryCandidate,
                              existing: [MemoryItem] = [],
                              memoryEnabled: Bool = true,
                              now: Date = Date(),
                              configuration: MemoryPolicyConfiguration = MemoryPolicyConfiguration()) -> MemoryPolicyDecision {
        let text = candidate.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .ignore(reason: "empty candidate") }
        if candidate.authoredByAssistant { return .ignore(reason: "assistant-authored content is not user memory") }
        if candidate.rawCategoryHint == "toolArguments" { return .ignore(reason: "tool arguments are not durable memory") }
        if ["schedulerStart", "running"].contains(text) { return .ignore(reason: "internal runtime state") }
        if isDateTimeRequest(text) { return .ignore(reason: "date/time request is not durable memory") }
        if isOrdinaryTaskPrompt(text) { return .ignore(reason: "ordinary task prompt is not durable memory") }
        if containsProhibitedSecret(text) || candidate.sensitivityHint == .prohibitedSecret {
            return .reject(reason: "prohibited secret")
        }
        if !memoryEnabled, candidate.proposedScope != .working, candidate.proposedScope != .session {
            return .ignore(reason: "long-term memory is disabled")
        }
        if isForgetRequest(text) {
            return .autoCommit(reason: "forget request")
        }
        if candidate.proposedScope == .working {
            return .keepEphemeral(scope: .working, expiresAt: now.addingTimeInterval(configuration.workingTTL),
                                  reason: "working memory")
        }
        if candidate.proposedScope == .session || isTransientPreference(text) {
            return .keepEphemeral(scope: .session, expiresAt: now.addingTimeInterval(configuration.sessionTTL),
                                  reason: "session-scoped preference")
        }
        if candidate.sensitivityHint == .sensitive || isSensitivePersonalContent(text) {
            return .requireConfirmation(reason: "sensitive or high-impact personal memory")
        }
        let activeConflicts = existing.filter {
            $0.canonicalKey == candidate.canonicalKey
                && $0.state == .active
                && $0.normalizedValue != candidate.normalizedValue
        }
        if !activeConflicts.isEmpty {
            return candidate.explicitlyRequestedByUser
                ? .autoCommit(reason: "explicit update supersedes previous value")
                : .requireConfirmation(reason: "conflicts with an active memory")
        }
        if candidate.explicitlyRequestedByUser && isLongTermCue(text) && candidate.confidence >= 0.7 {
            return .autoCommit(reason: "explicit low-risk long-term preference")
        }
        let related = existing.filter { $0.canonicalKey == candidate.canonicalKey }
        let independentSessions = Set(related.compactMap { $0.sourceReferences.first?.conversationID }).count
            + (candidate.sourceReference?.conversationID == nil ? 0 : 1)
        let evidenceCount = related.reduce(candidate.confidence >= 0.5 ? 1 : 0) { $0 + max(1, $1.evidenceCount) }
        if evidenceCount >= configuration.upgradeEvidenceThreshold,
           independentSessions >= configuration.upgradeSessionThreshold,
           candidate.confidence >= configuration.upgradeConfidenceThreshold {
            return .autoCommit(reason: "repeated evidence threshold met")
        }
        if candidate.proposedScope == .episodic {
            return .keepEphemeral(scope: .episodic, expiresAt: now.addingTimeInterval(configuration.episodicTTL),
                                  reason: "episodic memory with retention")
        }
        return .observe(reason: "insufficient repeated evidence")
    }

    public static func isDateTimeRequest(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let exact = [
            "今天几号", "现在几点", "what is the current local date and time?",
            "what is the current local date and time", "告诉我当前日期", "告诉我当前日期。",
            "告诉我当前日期和时间", "告诉我当前日期和时间。"
        ]
        if exact.contains(normalized) { return true }
        return (normalized.contains("当前") || normalized.contains("现在") || normalized.contains("今天"))
            && (normalized.contains("日期") || normalized.contains("时间") || normalized.contains("几点") || normalized.contains("几号"))
            && normalized.count < 40
    }

    public static func containsProhibitedSecret(_ text: String) -> Bool {
        MemoryPolicy.isForbiddenContent(text)
    }

    public static func isForgetRequest(_ text: String) -> Bool {
        text.contains("忘记") || text.contains("不要再记住") || text.contains("删除这条记忆")
    }

    private static func isLongTermCue(_ text: String) -> Bool {
        ["以后", "默认", "从现在开始", "请记住", "记住", "一定"].contains { text.contains($0) }
    }

    private static func isTransientPreference(_ text: String) -> Bool {
        ["这次", "这趟", "今天先", "本次"].contains { text.contains($0) }
    }

    private static func isSensitivePersonalContent(_ text: String) -> Bool {
        let lowered = text.lowercased()
        let markers = ["住址", "地址", "医疗", "健康", "疾病", "财务", "政治", "宗教", "身份", "性格", "银行卡", "投资"]
        return markers.contains { lowered.contains($0.lowercased()) }
    }

    private static func isOrdinaryTaskPrompt(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("完成『") || trimmed.hasPrefix("完成「") { return true }
        let verbs = ["查询", "打开", "读取", "列出", "帮我", "告诉我", "生成", "比较", "搜索"]
        return verbs.contains { trimmed.hasPrefix($0) }
            && !isLongTermCue(trimmed)
            && !isTransientPreference(trimmed)
            && trimmed.count < 80
    }
}

public enum MemoryCanonicalizer {
    public static func key(for text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let replacements = ["。", "，", ",", ".", "！", "!", "？", "?", "“", "”", "\"", "「", "」", "『", "』"]
        for replacement in replacements {
            value = value.replacingOccurrences(of: replacement, with: " ")
        }
        value = value.split(whereSeparator: \.isWhitespace).joined(separator: ".")
        if value.hasPrefix("以后默认") || value.contains("默认用中文") || value.contains("默认使用中文") {
            return "preference.default_language"
        }
        if value.contains("不要自动") && value.contains("commit") {
            return "procedure.git.no_auto_commit"
        }
        if value.contains("运行测试") {
            return "procedure.code.run_tests_after_changes"
        }
        return value.isEmpty ? "memory.unknown" : String(value.prefix(120))
    }
}

public enum MemoryLegacyMapper {
    public static func scope(for category: MemoryCategory) -> MemoryScope {
        switch category {
        case .preference, .project: return .semantic
        case .usageHabit: return .procedural
        case .learningGoal: return .episodic
        case .temporaryContext: return .session
        }
    }

    public static func category(for scope: MemoryScope) -> MemoryCategory {
        switch scope {
        case .working, .session: return .temporaryContext
        case .episodic: return .learningGoal
        case .semantic: return .preference
        case .procedural: return .usageHabit
        }
    }

    public static func sensitivity(for privacy: MemoryPrivacy) -> MemorySensitivity {
        privacy == .sensitive ? .sensitive : .ordinary
    }

    public static func privacy(for sensitivity: MemorySensitivity) -> MemoryPrivacy {
        switch sensitivity {
        case .ordinary, .personal: return .normal
        case .sensitive, .prohibitedSecret: return .sensitive
        }
    }

    public static func source(for kind: MemorySourceKind) -> MemorySource {
        switch kind {
        case .explicitUserStatement, .importedLegacyMemory: return .explicit
        case .repeatedUserBehavior: return .auto
        case .verifiedTaskOutcome: return .suggested
        }
    }
}

public enum MemoryLegacyMigrator {
    public static func migrate(_ rawItems: [MemoryItem], now: Date = Date()) -> [MemoryItem] {
        var seen = Set<String>()
        return rawItems.map { item in
            var migrated = item
            migrated.schemaVersion = max(2, item.schemaVersion)
            if migrated.canonicalKey.isEmpty || migrated.canonicalKey == "memory.unknown" {
                migrated.canonicalKey = MemoryCanonicalizer.key(for: migrated.text)
            }
            if MemoryPolicyEngine.isDateTimeRequest(migrated.text)
                || MemoryPolicyEngine.decide(candidate: MemoryCandidate(
                    proposedScope: migrated.scope,
                    canonicalKey: migrated.canonicalKey,
                    summary: migrated.text,
                    normalizedValue: migrated.normalizedValue,
                    confidence: migrated.confidence,
                    sensitivityHint: migrated.sensitivity,
                    sourceKind: .importedLegacyMemory,
                    explicitlyRequestedByUser: migrated.source == .explicit
                ), now: now) == .ignore(reason: "ordinary task prompt is not durable memory") {
                migrated.state = .ignored
                migrated.confirmed = false
            } else if migrated.confirmed && !migrated.archived && migrated.state != .superseded {
                migrated.state = .active
            } else if !migrated.confirmed && migrated.state == .active {
                migrated.state = .pendingConfirmation
            }
            let dedupeKey = "\(migrated.canonicalKey)|\(migrated.normalizedValue ?? migrated.text)|\(migrated.state.rawValue)"
            if seen.contains(dedupeKey) {
                migrated.state = .ignored
                migrated.confirmed = false
            } else {
                seen.insert(dedupeKey)
            }
            return migrated
        }
    }
}

public struct MemoryContextBudget: Sendable, Equatable {
    public var maxItems: Int
    public var maxCharacters: Int

    public init(maxItems: Int = 12, maxCharacters: Int = 2_000) {
        self.maxItems = max(1, maxItems)
        self.maxCharacters = max(80, maxCharacters)
    }
}

/// Local text retrieval for memories (pure, no storage dependency).
/// The old call sites used raw substring `contains` on both sides, which fails
/// for CJK (no word boundaries: "咖啡" never matches as a "word"). This
/// tokenizer emits CJK bigrams + latin/number words so short queries recall
/// correctly in both languages. Deterministic; safe to use in ranking.
public enum MemoryTextSearch {
    /// Tokenize for retrieval. CJK runs → overlapping bigrams; latin/digit
    /// runs → whole words. Lower-cased, de-duplicated, order-stable.
    public static func tokens(for text: String) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        func emit(_ t: String) {
            guard !t.isEmpty, seen.insert(t).inserted else { return }
            out.append(t)
        }
        var latin = ""
        var cjkRun: [Character] = []
        func flushLatin() {
            if !latin.isEmpty { emit(latin) }
            latin = ""
        }
        func flushCJK() {
            guard !cjkRun.isEmpty else { return }
            if cjkRun.count == 1 { emit(String(cjkRun)) }
            else {
                for i in 0..<(cjkRun.count - 1) { emit(String(cjkRun[i...i + 1])) }
            }
            cjkRun.removeAll()
        }
        for ch in text.lowercased() {
            if ch.isLetter || ch.isNumber {
                // CJK code points are letters too — split by script.
                if isCJK(ch) { flushLatin(); cjkRun.append(ch) }
                else { flushCJK(); latin.append(ch) }
            } else {
                flushLatin(); flushCJK()
            }
        }
        flushLatin(); flushCJK()
        return out
    }

    private static func isCJK(_ ch: Character) -> Bool {
        ch.unicodeScalars.allSatisfy { s in
            switch s.value {
            case 0x4E00...0x9FFF,   // CJK Unified Ideographs
                 0x3400...0x4DBF,   // Extension A
                 0x3040...0x309F,   // Hiragana
                 0x30A0...0x30FF,   // Katakana
                 0xAC00...0xD7AF:   // Hangul Syllables
                return true
            default:
                return false
            }
        }
    }

    /// Number of shared tokens between a query and a memory's searchable text
    /// (canonicalKey + text + normalizedValue, same fields the old substring
    /// check used, now tokenized on both sides).
    public static func matchedTokenCount(queryTokens: Set<String>, item: MemoryItem) -> Int {
        guard !queryTokens.isEmpty else { return 0 }
        let haystack = Set(tokens(for: "\(item.canonicalKey) \(item.text) \(item.normalizedValue ?? "")"))
        return queryTokens.intersection(haystack).count
    }

    /// Ranked search over in-memory items for the Memory Center / debugging.
    /// Filters archived items; expired/inactive are demoted (not dropped) so the
    /// user can still find and revive them. Stable sort: score desc, then updatedAt desc.
    public static func search(_ query: String, in items: [MemoryItem], limit: Int = 20) -> [MemoryItem] {
        let q = Set(tokens(for: query))
        guard !q.isEmpty else { return [] }
        return items
            .filter { !$0.archived }
            .map { ($0, score(queryTokens: q, item: $0)) }
            .filter { $0.1 > 0 }
            .sorted {
                if $0.1 != $1.1 { return $0.1 > $1.1 }
                return $0.0.updatedAt > $1.0.updatedAt
            }
            .prefix(max(1, limit))
            .map(\.0)
    }

    private static func score(queryTokens: Set<String>, item: MemoryItem) -> Double {
        var s = Double(matchedTokenCount(queryTokens: queryTokens, item: item)) * 10
        if item.pinned { s += 20 }
        s += item.confidence * 5
        if item.state != .active { s -= 15 }
        if item.isActive(now: Date()) { s += 5 }
        return s
    }
}

public enum MemoryContextBuilder {
    public static func build(items: [MemoryItem],
                             taskText: String,
                             conversationID: UUID? = nil,
                             taskID: UUID? = nil,
                             now: Date = Date(),
                             budget: MemoryContextBudget = MemoryContextBudget()) -> [MemoryItem] {
        let queryTokens = Set(MemoryTextSearch.tokens(for: taskText))
        let candidates = items.filter { item in
            guard item.isActive(now: now) else { return false }
            guard item.sensitivity != .sensitive && item.sensitivity != .prohibitedSecret else { return false }
            if item.scope == .working {
                return item.sourceReferences.contains { $0.taskID == taskID }
            }
            if item.scope == .session {
                return item.sourceReferences.contains { $0.conversationID == conversationID }
            }
            return true
        }
        let sorted = candidates.enumerated().sorted { lhs, rhs in
            let l = rank(lhs.element, queryTokens: queryTokens, now: now)
            let r = rank(rhs.element, queryTokens: queryTokens, now: now)
            if l != r { return l > r }
            return lhs.offset < rhs.offset
        }.map(\.element)
        var output: [MemoryItem] = []
        var characters = 0
        for item in sorted where output.count < budget.maxItems {
            let next = characters + item.text.count
            guard next <= budget.maxCharacters else { break }
            output.append(item)
            characters = next
        }
        return output
    }

    private static func rank(_ item: MemoryItem, queryTokens: Set<String>, now: Date) -> Double {
        var score: Double
        switch item.scope {
        case .working: score = 100
        case .session: score = 80
        case .procedural: score = 60
        case .semantic: score = 45
        case .episodic: score = 30
        }
        if item.pinned { score += 20 }
        score += item.confidence * 10
        // Token-overlap relevance (CJK-bigram aware). Procedural know-how gets a
        // higher per-token weight so "how do I…" queries prefer it; capped so a
        // long matching text can't outrank a scope tier.
        let matched = MemoryTextSearch.matchedTokenCount(queryTokens: queryTokens, item: item)
        if matched > 0 {
            let perToken = item.scope == .procedural ? 12.0 : 5.0
            score += min(Double(matched) * perToken, item.scope == .procedural ? 36 : 15)
        }
        let reference = item.lastUsedAt ?? item.lastUsed ?? item.updatedAt
        let ageDays = max(0, now.timeIntervalSince(reference) / 86_400)
        score -= min(20, ageDays / 7)
        return score
    }
}

/// Generates suggested memories the user can confirm (doc §12.1 建议式记忆).
public enum MemorySuggester {
    /// After repeatedly using the same focus length, suggest remembering it (doc §12.1 example).
    public static func focusHabit(minutes: Int, occurrences: Int, threshold: Int = 3) -> MemoryItem? {
        guard occurrences >= threshold, minutes > 0 else { return nil }
        return MemoryItem(text: "常用 \(minutes) 分钟专注", category: .usageHabit, source: .suggested,
                          reason: "最近多次使用该专注时长")
    }
}

// MARK: - P4 self-evolution: reflect on a finished agent task and suggest memories

/// The outcome of one terminated agent task, handed to the reflector. Pure value type — the reflector
/// never touches the runtime, ledger, or live memory; it only proposes candidate memories.
public struct TaskReflectionInput: Sendable, Equatable {
    public var goal: String
    public var userText: String?
    public var executedCapabilities: [String]
    public var deniedCapabilities: [String]
    public var succeeded: Bool
    public var cancelled: Bool
    public init(goal: String, userText: String? = nil, executedCapabilities: [String] = [],
                deniedCapabilities: [String] = [], succeeded: Bool = false, cancelled: Bool = false) {
        self.goal = goal; self.userText = userText
        self.executedCapabilities = executedCapabilities; self.deniedCapabilities = deniedCapabilities
        self.succeeded = succeeded; self.cancelled = cancelled
    }
}

/// Turns a finished task into zero or more *suggested* memories (the P4 learning loop). Pure and
/// deterministic. Suggestions need user confirmation before they influence future context, and every
/// candidate passes `MemoryPolicy.mayStore` — the reflector can never write a base preference, grant a
/// capability, or store forbidden content.
public enum TaskReflector {
    private static func clip(_ s: String, _ n: Int = 60) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count <= n ? t : String(t.prefix(n)) + "…"
    }

    public static func reflectCandidates(_ input: TaskReflectionInput) -> [MemoryCandidate] {
        // A cancelled task tells us nothing reliable about preference — skip it.
        if input.cancelled { return [] }
        let goal = clip(input.goal)
        guard !goal.isEmpty else { return [] }

        var candidates: [MemoryCandidate] = []

        // Constraint: something was gate-blocked → suggest remembering to ask first next time.
        if !input.deniedCapabilities.isEmpty {
            candidates.append(MemoryCandidate(
                proposedScope: .procedural,
                canonicalKey: "procedure.ask_before_denied_capability",
                summary: "处理这类请求前，先征得我同意",
                normalizedValue: Array(Set(input.deniedCapabilities)).sorted().joined(separator: ","),
                confidence: 0.7,
                sourceKind: .verifiedTaskOutcome,
                explicitlyRequestedByUser: false))
        }

        return candidates
    }

    public static func reflect(_ input: TaskReflectionInput) -> [MemoryItem] {
        reflectCandidates(input).compactMap { candidate in
            guard case .requireConfirmation = MemoryPolicyEngine.decide(candidate: candidate) else {
                return nil
            }
            return MemoryItem(text: candidate.summary,
                              category: MemoryLegacyMapper.category(for: candidate.proposedScope),
                              source: .suggested,
                              reason: "任务结果提出的候选记忆",
                              confirmed: false,
                              privacy: MemoryLegacyMapper.privacy(for: candidate.sensitivityHint),
                              canonicalKey: candidate.canonicalKey,
                              scope: candidate.proposedScope,
                              state: .pendingConfirmation,
                              sensitivity: candidate.sensitivityHint,
                              normalizedValue: candidate.normalizedValue,
                              confidence: candidate.confidence,
                              evidenceCount: 1,
                              sourceReferences: candidate.sourceReference.map { [$0] } ?? [])
        }
    }
}
