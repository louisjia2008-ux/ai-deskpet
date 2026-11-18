import Foundation
import AICore
import PetBrainCore

public struct TaskPlanID: RawRepresentable, Codable, Sendable, Hashable, Comparable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) {
        self.rawValue = AgentPrivacyRedactor.safeIdentifier(rawValue, fallback: "plan")
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(rawValue: value)
    }

    public static func < (lhs: TaskPlanID, rhs: TaskPlanID) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct TaskPlanStepID: RawRepresentable, Codable, Sendable, Hashable, Comparable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) {
        self.rawValue = AgentPrivacyRedactor.safeIdentifier(rawValue, fallback: "step")
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(rawValue: value)
    }

    public static func < (lhs: TaskPlanStepID, rhs: TaskPlanStepID) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct RawTaskPlan: Codable, Sendable, Hashable {
    public var goalSummary: String
    public var steps: [RawTaskPlanStep]

    public init(goalSummary: String, steps: [RawTaskPlanStep]) {
        self.goalSummary = goalSummary
        self.steps = steps
    }

    private enum CodingKeys: String, CodingKey {
        case goalSummary = "goal_summary"
        case steps
    }
}

public struct RawTaskPlanStep: Codable, Sendable, Hashable {
    public var id: String?
    public var title: String
    public var tool: ToolID
    public var arguments: AgentJSONValue
    public var dependsOn: [String]
    public var userVisibleSummary: String?

    public init(id: String? = nil,
                title: String,
                tool: ToolID,
                arguments: AgentJSONValue = .object([:]),
                dependsOn: [String] = [],
                userVisibleSummary: String? = nil) {
        self.id = id
        self.title = title
        self.tool = tool
        self.arguments = arguments
        self.dependsOn = dependsOn
        self.userVisibleSummary = userVisibleSummary
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case tool
        case arguments
        case dependsOn = "depends_on"
        case userVisibleSummary = "user_visible_summary"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        tool = ToolID(rawValue: try container.decode(String.self, forKey: .tool))
        arguments = try container.decodeIfPresent(AgentJSONValue.self, forKey: .arguments) ?? .object([:])
        dependsOn = try container.decodeIfPresent([String].self, forKey: .dependsOn) ?? []
        userVisibleSummary = try container.decodeIfPresent(String.self, forKey: .userVisibleSummary)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(tool.rawValue, forKey: .tool)
        try container.encode(arguments, forKey: .arguments)
        try container.encode(dependsOn, forKey: .dependsOn)
        try container.encodeIfPresent(userVisibleSummary, forKey: .userVisibleSummary)
    }
}

public struct TaskPlanRiskSummary: Codable, Sendable, Hashable {
    public var highestRisk: ToolRiskLevel
    public var containsPrivateDataRead: Bool
    public var stepRisks: [TaskPlanStepID: ToolRiskLevel]

    public init(highestRisk: ToolRiskLevel,
                containsPrivateDataRead: Bool,
                stepRisks: [TaskPlanStepID: ToolRiskLevel]) {
        self.highestRisk = highestRisk
        self.containsPrivateDataRead = containsPrivateDataRead
        self.stepRisks = stepRisks
    }
}

public enum PlanApprovalRequirement: String, Codable, Sendable, Hashable {
    case none
    case userApproval
    case blocked
}

public struct TaskPlan: Codable, Sendable, Hashable {
    public var id: TaskPlanID
    public var version: Int
    public var goalSummary: String
    public var steps: [TaskPlanStep]
    public var riskSummary: TaskPlanRiskSummary
    public var approvalRequirement: PlanApprovalRequirement
    public var createdAt: Date
    public var toolCatalogRevision: String

    public init(id: TaskPlanID,
                version: Int = 1,
                goalSummary: String,
                steps: [TaskPlanStep],
                riskSummary: TaskPlanRiskSummary,
                approvalRequirement: PlanApprovalRequirement,
                createdAt: Date,
                toolCatalogRevision: String) {
        self.id = id
        self.version = max(1, version)
        self.goalSummary = AgentPrivacyRedactor.safeText(goalSummary, maxLength: PlannerLimits().maxGoalSummaryCharacters).text
        self.steps = steps
        self.riskSummary = riskSummary
        self.approvalRequirement = approvalRequirement
        self.createdAt = createdAt
        self.toolCatalogRevision = AgentPrivacyRedactor.safeIdentifier(toolCatalogRevision, fallback: "catalog")
    }
}

public struct TaskPlanStep: Codable, Sendable, Hashable {
    public var id: TaskPlanStepID
    public var ordinal: Int
    public var title: String
    public var toolID: ToolID
    public var arguments: AgentJSONValue
    public var dependsOn: [TaskPlanStepID]
    public var userVisibleSummary: String

    public init(id: TaskPlanStepID,
                ordinal: Int,
                title: String,
                toolID: ToolID,
                arguments: AgentJSONValue,
                dependsOn: [TaskPlanStepID],
                userVisibleSummary: String) {
        self.id = id
        self.ordinal = ordinal
        self.title = title
        self.toolID = toolID
        self.arguments = arguments
        self.dependsOn = dependsOn
        self.userVisibleSummary = userVisibleSummary
    }

    public var fingerprint: String {
        "\(toolID.rawValue)|\(arguments.canonicalString)"
    }
}

public struct ValidatedTaskPlan: Sendable, Hashable {
    public var plan: TaskPlan
    public var toolCatalogSnapshot: ToolCatalogSnapshot
    public var plannerLimits: PlannerLimits

    public init(plan: TaskPlan,
                toolCatalogSnapshot: ToolCatalogSnapshot,
                plannerLimits: PlannerLimits = PlannerLimits()) {
        self.plan = plan
        self.toolCatalogSnapshot = toolCatalogSnapshot
        self.plannerLimits = plannerLimits
    }
}

public enum PlanStatus: String, Codable, Sendable, Hashable {
    case planning
    case validating
    case awaitingApproval
    case approved
    case executing
    case replanning
    case verifying
    case synthesizing
    case completed
    case partiallyCompleted
    case cancelled
    case failed
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanStatus(rawValue: raw) ?? .unknown
    }
}

public enum PlanStepStatus: String, Codable, Sendable, Hashable {
    case pending
    case running
    case succeeded
    case partial
    case denied
    case failed
    case timedOut
    case cancelled
    case skippedDependency
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PlanStepStatus(rawValue: raw) ?? .unknown
    }

    public var isTerminal: Bool {
        switch self {
        case .pending, .running, .unknown:
            return false
        case .succeeded, .partial, .denied, .failed, .timedOut, .cancelled, .skippedDependency:
            return true
        }
    }

    public var isSuccessful: Bool {
        self == .succeeded || self == .partial
    }
}

public enum PlanExecutionEvent: Sendable, Equatable {
    case planCreated(PlanPresentationSnapshot)
    case approvalRequired(PlanPresentationSnapshot)
    case planApproved(PlanPresentationSnapshot)
    case planCancelled(PlanPresentationSnapshot)
    case stepStarted(TaskPlanStepID, PlanPresentationSnapshot)
    case stepFinished(TaskPlanStepID, PlanStepStatus, PlanPresentationSnapshot)
    case stepSkipped(TaskPlanStepID, PlanStepStatus, PlanPresentationSnapshot)
    case replanning(PlanPresentationSnapshot)
    case verificationStarted(PlanPresentationSnapshot)
    case verificationCompleted(PlanVerificationReport, PlanPresentationSnapshot)
    case synthesisStarted(PlanPresentationSnapshot)
    case completed(PlanPresentationSnapshot)
    case failed(PlanError, PlanPresentationSnapshot?)
}

public struct PlannerLimits: Sendable, Codable, Hashable {
    public var maxPlanSteps: Int
    public var maxPlanRepairs: Int
    public var maxReplans: Int
    public var maxActivePlans: Int
    public var planningTimeout: TimeInterval
    public var planApprovalTimeout: TimeInterval
    public var finalSynthesisTimeout: TimeInterval
    public var plannedTurnDeadline: TimeInterval
    public var toolExecutionTimeout: TimeInterval
    public var maxPlanPayloadBytes: Int
    public var maxGoalSummaryCharacters: Int
    public var maxStepTitleCharacters: Int
    public var maxVisibleSummaryCharacters: Int

    public init(maxPlanSteps: Int = 6,
                maxPlanRepairs: Int = 1,
                maxReplans: Int = 1,
                maxActivePlans: Int = 1,
                planningTimeout: TimeInterval = 20,
                planApprovalTimeout: TimeInterval = 300,
                finalSynthesisTimeout: TimeInterval = 30,
                plannedTurnDeadline: TimeInterval = 90,
                toolExecutionTimeout: TimeInterval = 8,
                maxPlanPayloadBytes: Int = 24_576,
                maxGoalSummaryCharacters: Int = 160,
                maxStepTitleCharacters: Int = 80,
                maxVisibleSummaryCharacters: Int = 80) {
        self.maxPlanSteps = max(2, maxPlanSteps)
        self.maxPlanRepairs = max(0, maxPlanRepairs)
        self.maxReplans = max(0, maxReplans)
        self.maxActivePlans = max(1, maxActivePlans)
        self.planningTimeout = max(0.1, planningTimeout)
        self.planApprovalTimeout = max(0.1, planApprovalTimeout)
        self.finalSynthesisTimeout = max(0.1, finalSynthesisTimeout)
        self.plannedTurnDeadline = max(0.1, plannedTurnDeadline)
        self.toolExecutionTimeout = max(0.1, toolExecutionTimeout)
        self.maxPlanPayloadBytes = max(1_024, maxPlanPayloadBytes)
        self.maxGoalSummaryCharacters = max(16, maxGoalSummaryCharacters)
        self.maxStepTitleCharacters = max(16, maxStepTitleCharacters)
        self.maxVisibleSummaryCharacters = max(16, maxVisibleSummaryCharacters)
    }
}

public enum PlanError: Error, Sendable, Codable, Hashable {
    case plannerUnavailable
    case plannerTimeout
    case malformedPlan
    case planRepairFailed
    case planValidationFailed(TaskPlanValidationError)
    case tooFewSteps
    case tooManySteps
    case unknownTool(String)
    case toolDisabled(String)
    case invalidArguments(String)
    case invalidDependency(String)
    case cyclicDependency
    case unsupportedRisk(String)
    case approvalRequired
    case approvalDeclined
    case approvalTimedOut
    case planCriticRejected
    case executionFailed
    case replanFailed
    case verificationFailed
    case verificationRepairBudgetExceeded
    case synthesisFailed
    case turnDeadlineExceeded
    case cancelled
    case internalInvariantViolation

    public var userVisibleMessage: String {
        switch self {
        case .approvalDeclined, .cancelled:
            return "计划已取消。"
        case .approvalTimedOut:
            return "计划确认已超时，未执行任何步骤。"
        case .planCriticRejected:
            return "计划审核未通过，已停止执行。"
        case .tooFewSteps:
            return "这个请求更适合单个工具处理。"
        case .tooManySteps:
            return "这个计划步骤过多，我已停止执行。"
        case .unknownTool, .toolDisabled:
            return "计划包含当前不可用的工具，已停止执行。"
        case .invalidArguments, .invalidDependency, .cyclicDependency:
            return "计划结构无效，已停止执行。"
        case .unsupportedRisk:
            return "计划包含本轮不支持的高风险工具，已停止执行。"
        case .synthesisFailed:
            return "步骤已结束，但整理最终回复失败。"
        case .verificationFailed:
            return "验证未通过，不能将任务标记为完成。"
        case .verificationRepairBudgetExceeded:
            return "验证要求修正，但已达到修正预算。"
        case .turnDeadlineExceeded:
            return "计划达到时间限制，已停止继续执行。"
        default:
            return "计划无法安全执行。"
        }
    }
}

public enum TaskPlanValidationError: String, Codable, Sendable, Hashable {
    case unknownTool
    case toolDisabled
    case invalidArguments
    case tooFewSteps
    case tooManySteps
    case duplicateStep
    case duplicateFingerprint
    case invalidDependency
    case cyclicDependency
    case unsupportedRisk
    case approvalPolicyViolation
    case malformedPlan
}

public struct PlanPresentationStep: Codable, Sendable, Hashable, Identifiable {
    public var id: TaskPlanStepID
    public var ordinal: Int
    public var title: String
    public var toolDisplayName: String
    public var riskLevel: ToolRiskLevel
    public var status: PlanStepStatus
    public var involvesPrivateData: Bool

    public init(id: TaskPlanStepID,
                ordinal: Int,
                title: String,
                toolDisplayName: String,
                riskLevel: ToolRiskLevel,
                status: PlanStepStatus,
                involvesPrivateData: Bool) {
        self.id = id
        self.ordinal = ordinal
        self.title = title
        self.toolDisplayName = toolDisplayName
        self.riskLevel = riskLevel
        self.status = status
        self.involvesPrivateData = involvesPrivateData
    }
}

public struct PlanPresentationSnapshot: Codable, Sendable, Hashable, Identifiable {
    public var id: TaskPlanID
    public var goalSummary: String
    public var status: PlanStatus
    public var approvalRequirement: PlanApprovalRequirement
    public var steps: [PlanPresentationStep]
    public var containsPrivateDataRead: Bool
    public var canApprove: Bool
    public var canCancel: Bool

    public init(id: TaskPlanID,
                goalSummary: String,
                status: PlanStatus,
                approvalRequirement: PlanApprovalRequirement,
                steps: [PlanPresentationStep],
                containsPrivateDataRead: Bool,
                canApprove: Bool,
                canCancel: Bool) {
        self.id = id
        self.goalSummary = goalSummary
        self.status = status
        self.approvalRequirement = approvalRequirement
        self.steps = steps
        self.containsPrivateDataRead = containsPrivateDataRead
        self.canApprove = canApprove
        self.canCancel = canCancel
    }
}

public enum PlanApprovalDecision: Sendable, Equatable {
    case approved
    case declined
    case timedOut
    case cancelled
}

public protocol TaskPlanApprovalHandling: Sendable {
    func requestApproval(for plan: ValidatedTaskPlan,
                         snapshot: PlanPresentationSnapshot) async -> PlanApprovalDecision
}

public struct AutoTaskPlanApprovalHandler: TaskPlanApprovalHandling {
    private let decision: PlanApprovalDecision

    public init(decision: PlanApprovalDecision = .approved) {
        self.decision = decision
    }

    public func requestApproval(for plan: ValidatedTaskPlan,
                                snapshot: PlanPresentationSnapshot) async -> PlanApprovalDecision {
        decision
    }
}

public struct ClosureTaskPlanApprovalHandler: TaskPlanApprovalHandling {
    public typealias Handler = @Sendable (ValidatedTaskPlan, PlanPresentationSnapshot) async -> PlanApprovalDecision
    private let handler: Handler

    public init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    public func requestApproval(for plan: ValidatedTaskPlan,
                                snapshot: PlanPresentationSnapshot) async -> PlanApprovalDecision {
        await handler(plan, snapshot)
    }
}

public protocol TaskPlanning: Sendable {
    func createPlan(goal: PlanningGoal,
                    toolCatalog: ToolCatalogSnapshot,
                    context: PlanningContext) async throws -> RawTaskPlan
}

public struct PlanningGoal: Sendable, Hashable {
    public var text: String
    public init(text: String) {
        self.text = AgentPrivacyRedactor.safeText(text, maxLength: 1_000).text
    }
}

public struct PlanningContext: Sendable, Hashable {
    public var localeIdentifier: String
    public var timeZoneIdentifier: String
    public var policySummary: String

    public init(locale: Locale = .current,
                timeZone: TimeZone = .current,
                policySummary: String = "P4-B allows only registered P0/P1 read-only tools.") {
        self.localeIdentifier = locale.identifier
        self.timeZoneIdentifier = timeZone.identifier
        self.policySummary = policySummary
    }
}
