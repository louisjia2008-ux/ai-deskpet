import Foundation
import PetBrainCore

public enum RuntimePreparedCapability: String, Sendable, Equatable, Hashable {
    case currentDateTime
    case localDiscovery

    public var toolName: String {
        switch self {
        case .currentDateTime:
            return "get_current_datetime"
        case .localDiscovery:
            return "local_discovery_workflow"
        }
    }
}

public enum RuntimeIntentResolutionSource: String, Sendable, Equatable {
    case explicitCurrentMessage
    case contextualFollowUp
    case noMatch
}

public enum RuntimeIntentReasonCategory: String, Sendable, Equatable {
    case explicitCurrentDateTime
    case currentDateTimeFollowUp
    case previousFailedCurrentDateTimeRetry
    case explicitLocalDiscovery
    case ambiguousLocalDiscovery
    case noMatch
}

public enum RuntimePreviousOutcomeStatus: String, Sendable, Equatable {
    case succeeded
    case failed
    case cancelled
    case running
    case unknown
}

public struct ConversationIntentContext: Sendable, Equatable {
    public var conversationID: UUID
    public var recentUserGoal: String?
    public var previousInferredCapabilities: [RuntimePreparedCapability]
    public var previousSuccessfulToolIDs: [String]
    public var previousOutcomeStatus: RuntimePreviousOutcomeStatus
    public var previousCompletedAt: Date?
    public var recentAssistantCategory: String?

    public init(conversationID: UUID,
                recentUserGoal: String? = nil,
                previousInferredCapabilities: [RuntimePreparedCapability] = [],
                previousSuccessfulToolIDs: [String] = [],
                previousOutcomeStatus: RuntimePreviousOutcomeStatus = .unknown,
                previousCompletedAt: Date? = nil,
                recentAssistantCategory: String? = nil) {
        self.conversationID = conversationID
        self.recentUserGoal = recentUserGoal
        self.previousInferredCapabilities = previousInferredCapabilities
        self.previousSuccessfulToolIDs = previousSuccessfulToolIDs
        self.previousOutcomeStatus = previousOutcomeStatus
        self.previousCompletedAt = previousCompletedAt
        self.recentAssistantCategory = recentAssistantCategory
    }
}

public struct ResolvedRuntimeIntent: Sendable, Equatable {
    public var resolvedIntent: RuntimePreparedCapability?
    public var inheritedCapability: RuntimePreparedCapability?
    public var requiresFreshExecution: Bool
    public var confidence: Double
    public var reasonCategory: RuntimeIntentReasonCategory
    public var source: RuntimeIntentResolutionSource

    public init(resolvedIntent: RuntimePreparedCapability? = nil,
                inheritedCapability: RuntimePreparedCapability? = nil,
                requiresFreshExecution: Bool = false,
                confidence: Double = 0,
                reasonCategory: RuntimeIntentReasonCategory = .noMatch,
                source: RuntimeIntentResolutionSource = .noMatch) {
        self.resolvedIntent = resolvedIntent
        self.inheritedCapability = inheritedCapability
        self.requiresFreshExecution = requiresFreshExecution
        self.confidence = confidence
        self.reasonCategory = reasonCategory
        self.source = source
    }
}

public struct RuntimePreparedRequest: Sendable, Equatable {
    public var inferredCapabilities: [RuntimePreparedCapability]
    public var requiredCapabilities: [RuntimePreparedCapability]
    public var executionMode: RuntimePreparedExecutionMode
    public var resolutionSource: RuntimeIntentResolutionSource
    public var requiresFreshExecution: Bool
    public var confidence: Double
    public var reasonCategory: RuntimeIntentReasonCategory
    public var localDiscoveryIntentDecision: LocalDiscoveryIntentDecision?

    public init(inferredCapabilities: [RuntimePreparedCapability] = [],
                requiredCapabilities: [RuntimePreparedCapability] = [],
                executionMode: RuntimePreparedExecutionMode = .conversation,
                resolutionSource: RuntimeIntentResolutionSource = .noMatch,
                requiresFreshExecution: Bool = false,
                confidence: Double = 0,
                reasonCategory: RuntimeIntentReasonCategory = .noMatch,
                localDiscoveryIntentDecision: LocalDiscoveryIntentDecision? = nil) {
        self.inferredCapabilities = inferredCapabilities
        self.requiredCapabilities = requiredCapabilities
        self.executionMode = executionMode
        self.resolutionSource = resolutionSource
        self.requiresFreshExecution = requiresFreshExecution
        self.confidence = confidence
        self.reasonCategory = reasonCategory
        self.localDiscoveryIntentDecision = localDiscoveryIntentDecision
    }

    public var requiredToolDecision: AgentLoopDecisionResult? {
        guard let capability = requiredCapabilities.first else { return nil }
        let toolCall = AgentToolCallRequest(
            callID: "required-\(capability.toolName)",
            toolName: capability.toolName,
            arguments: .object([:]),
            userVisibleSummary: userVisibleSummary(for: capability)
        )
        return AgentLoopDecisionResult(
            decision: .toolCall(toolCall),
            decisionSource: .ruleBasedFallback,
            providerMetadata: [
                "requiredCapability": capability.rawValue,
                "requiredTool": capability.toolName,
                "routing": resolutionSource == .contextualFollowUp ? "contextual-required-tool" : "required-tool",
                "resolutionSource": resolutionSource.rawValue,
                "reasonCategory": reasonCategory.rawValue,
                "requiresFreshExecution": requiresFreshExecution ? "true" : "false",
                "confidence": "\(confidence)"
            ],
            modelProvider: "runtime-request-preparer"
        )
    }

    private func userVisibleSummary(for capability: RuntimePreparedCapability) -> String {
        switch capability {
        case .currentDateTime:
            return "获取当前本地日期和时间"
        case .localDiscovery:
            return "执行地点发现工作流"
        }
    }
}

public enum RuntimePreparedExecutionMode: String, Sendable, Equatable {
    case conversation
    case boundedToolLoop
    case localDiscoveryWorkflow
}

public enum RuntimeRequestPreparer {
    public static func prepare(userText: String?) -> RuntimePreparedRequest {
        prepare(userText: userText, context: nil)
    }

    public static func prepare(userText: String?,
                               context: ConversationIntentContext?) -> RuntimePreparedRequest {
        let resolved = ContextualIntentResolver.resolve(userText: userText, context: context)
        guard let capability = resolved.resolvedIntent else {
            let localDiscovery = LocalDiscoveryIntentClassifier.classify(userText: userText, context: context)
            if localDiscovery.isLocalDiscovery {
                return RuntimePreparedRequest(
                    inferredCapabilities: [.localDiscovery],
                    requiredCapabilities: [],
                    executionMode: .localDiscoveryWorkflow,
                    resolutionSource: .explicitCurrentMessage,
                    requiresFreshExecution: true,
                    confidence: localDiscovery.confidence,
                    reasonCategory: .explicitLocalDiscovery,
                    localDiscoveryIntentDecision: localDiscovery)
            }
            if localDiscovery.requestKind == .unclear && localDiscovery.confidence >= 0.35 {
                return RuntimePreparedRequest(
                    inferredCapabilities: [],
                    requiredCapabilities: [],
                    executionMode: .conversation,
                    resolutionSource: .explicitCurrentMessage,
                    requiresFreshExecution: false,
                    confidence: localDiscovery.confidence,
                    reasonCategory: .ambiguousLocalDiscovery,
                    localDiscoveryIntentDecision: localDiscovery)
            }
            return RuntimePreparedRequest(resolutionSource: resolved.source,
                                          requiresFreshExecution: resolved.requiresFreshExecution,
                                          confidence: resolved.confidence,
                                          reasonCategory: resolved.reasonCategory)
        }
        return RuntimePreparedRequest(
            inferredCapabilities: [capability],
            requiredCapabilities: [capability],
            executionMode: .boundedToolLoop,
            resolutionSource: resolved.source,
            requiresFreshExecution: resolved.requiresFreshExecution,
            confidence: resolved.confidence,
            reasonCategory: resolved.reasonCategory
        )
    }
}

public enum ContextualIntentResolver {
    public static func resolve(userText: String?,
                               context: ConversationIntentContext?) -> ResolvedRuntimeIntent {
        guard let userText else { return ResolvedRuntimeIntent() }
        if DateTimeIntentNormalizer.intent(for: userText) == .currentDateTime {
            return ResolvedRuntimeIntent(resolvedIntent: .currentDateTime,
                                         requiresFreshExecution: true,
                                         confidence: 1,
                                         reasonCategory: .explicitCurrentDateTime,
                                         source: .explicitCurrentMessage)
        }
        guard isCurrentDateTimeFollowUp(userText),
              let context,
              hasPriorCurrentDateTimeContext(context) else {
            return ResolvedRuntimeIntent()
        }
        let reason: RuntimeIntentReasonCategory = context.previousOutcomeStatus == .failed
            ? .previousFailedCurrentDateTimeRetry
            : .currentDateTimeFollowUp
        return ResolvedRuntimeIntent(resolvedIntent: .currentDateTime,
                                     inheritedCapability: .currentDateTime,
                                     requiresFreshExecution: true,
                                     confidence: context.previousSuccessfulToolIDs.contains("get_current_datetime") ? 0.95 : 0.85,
                                     reasonCategory: reason,
                                     source: .contextualFollowUp)
    }

    private static func hasPriorCurrentDateTimeContext(_ context: ConversationIntentContext) -> Bool {
        context.previousInferredCapabilities.contains(.currentDateTime)
            || context.previousSuccessfulToolIDs.contains("get_current_datetime")
    }

    private static func isCurrentDateTimeFollowUp(_ text: String) -> Bool {
        let normalized = normalize(text)
        guard !normalized.isEmpty else { return false }
        let topicSwitchTokens = [
            "视频", "影片", "时长", "倒计时", "计时器", "邮件", "文档", "格式",
            "video", "duration", "countdown", "timer", "email", "mail", "document", "format"
        ]
        if topicSwitchTokens.contains(where: { normalized.contains($0) }) {
            return false
        }
        let phrases = [
            "具体到秒", "精确到秒", "要秒数", "再精确一点", "现在呢", "再查一次",
            "刷新一下", "再告诉我一次", "用24小时制", "用十二小时制", "用12小时制",
            "带上星期几", "只告诉我时间", "只告诉我日期", "whatabouttheseconds",
            "whataboutseconds", "downtothesecond", "downtoseconds", "refreshit",
            "whataboutnow", "withseconds", "tothesecond"
        ]
        return phrases.contains { normalized.contains($0) }
    }

    private static func normalize(_ text: String) -> String {
        let replacements: [Character: Character] = [
            "現": "现", "當": "当", "幾": "几", "號": "号", "週": "周",
            "時": "时", "間": "间", "點": "点", "嗎": "吗", "請": "请",
            "訴": "诉", "這": "这", "裡": "里", "裏": "里"
        ]
        let folded = text.lowercased().map { replacements[$0] ?? $0 }
        return String(folded).filter { character in
            character.isLetter || character.isNumber
        }
    }
}
