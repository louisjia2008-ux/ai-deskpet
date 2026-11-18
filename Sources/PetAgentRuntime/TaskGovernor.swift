import Foundation
import CryptoKit
import AICore
import PetBrainCore

public enum AgentRuntimeRiskLevel: String, Codable, Sendable, Hashable, CaseIterable, Comparable {
    case risk0
    case risk1
    case risk2
    case risk3
    case risk4

    public static func < (lhs: AgentRuntimeRiskLevel, rhs: AgentRuntimeRiskLevel) -> Bool {
        lhs.rank < rhs.rank
    }

    public var rank: Int {
        switch self {
        case .risk0: return 0
        case .risk1: return 1
        case .risk2: return 2
        case .risk3: return 3
        case .risk4: return 4
        }
    }

    public var displayName: String {
        switch self {
        case .risk0: return "Risk 0 普通聊天"
        case .risk1: return "Risk 1 只读信息"
        case .risk2: return "Risk 2 私人数据或临时能力"
        case .risk3: return "Risk 3 可逆写操作"
        case .risk4: return "Risk 4 高风险操作"
        }
    }

    public static func from(toolRisk: ToolRiskLevel) -> AgentRuntimeRiskLevel {
        switch TaskPlanValidator.normalizedRisk(toolRisk) {
        case .localReadOnlyNoPrivateData:
            return .risk1
        case .privateDataReadOnly, .externalReadOnly:
            return .risk2
        case .externalSideEffectReversible:
            return .risk3
        case .destructiveOrSensitiveWrite, .unknown, .safe, .sensitive, .highRisk:
            return .risk4
        }
    }
}

public enum AgentRole: String, Codable, Sendable, Hashable, CaseIterable {
    case governor
    case planner
    case planCritic
    case executor
    case verifier
    case synthesizer
}

public struct TaskGovernorBudget: Codable, Sendable, Hashable {
    public var maxPlanReviewRounds: Int
    public var maxVerificationRepairs: Int
    public var maxExecutionRepairs: Int
    public var maxToolGenerationCandidates: Int
    public var maxAutonomousSteps: Int

    public init(maxPlanReviewRounds: Int = 1,
                maxVerificationRepairs: Int = 1,
                maxExecutionRepairs: Int = 1,
                maxToolGenerationCandidates: Int = 0,
                maxAutonomousSteps: Int = 4) {
        self.maxPlanReviewRounds = max(0, maxPlanReviewRounds)
        self.maxVerificationRepairs = max(0, maxVerificationRepairs)
        self.maxExecutionRepairs = max(0, maxExecutionRepairs)
        self.maxToolGenerationCandidates = max(0, maxToolGenerationCandidates)
        self.maxAutonomousSteps = max(1, maxAutonomousSteps)
    }

    public init(plannerLimits: PlannerLimits) {
        self.init(maxPlanReviewRounds: 1,
                  maxVerificationRepairs: plannerLimits.maxPlanRepairs,
                  maxExecutionRepairs: plannerLimits.maxReplans,
                  maxToolGenerationCandidates: 0,
                  maxAutonomousSteps: plannerLimits.maxPlanSteps)
    }
}

public struct TaskGovernorAssessment: Codable, Sendable, Hashable {
    public var riskLevel: AgentRuntimeRiskLevel
    public var roles: [AgentRole]
    public var requiresPlanCritic: Bool
    public var requiresVerifier: Bool
    public var requiresUserConfirmation: Bool
    public var allowsAutonomousExecution: Bool
    public var budget: TaskGovernorBudget
    public var reason: String

    public init(riskLevel: AgentRuntimeRiskLevel,
                roles: [AgentRole],
                requiresPlanCritic: Bool,
                requiresVerifier: Bool,
                requiresUserConfirmation: Bool,
                allowsAutonomousExecution: Bool,
                budget: TaskGovernorBudget,
                reason: String) {
        self.riskLevel = riskLevel
        self.roles = roles
        self.requiresPlanCritic = requiresPlanCritic
        self.requiresVerifier = requiresVerifier
        self.requiresUserConfirmation = requiresUserConfirmation
        self.allowsAutonomousExecution = allowsAutonomousExecution
        self.budget = budget
        self.reason = AgentPrivacyRedactor.safeSummary(reason, fallback: riskLevel.displayName)
    }
}

public protocol TaskGoverning: Sendable {
    func assess(goal: PlanningGoal,
                plan: ValidatedTaskPlan?,
                budget: TaskGovernorBudget) -> TaskGovernorAssessment
}

public struct DefaultTaskGovernor: TaskGoverning {
    public init() {}

    public func assess(goal: PlanningGoal,
                       plan: ValidatedTaskPlan?,
                       budget: TaskGovernorBudget) -> TaskGovernorAssessment {
        guard let plan else {
            return TaskGovernorAssessment(riskLevel: .risk0,
                                          roles: [.governor, .synthesizer],
                                          requiresPlanCritic: false,
                                          requiresVerifier: false,
                                          requiresUserConfirmation: false,
                                          allowsAutonomousExecution: true,
                                          budget: budget,
                                          reason: "无工具普通对话")
        }

        let risks = plan.toolCatalogSnapshot.entries
            .filter { entry in plan.plan.steps.contains { $0.toolID == entry.manifest.id } }
            .map { AgentRuntimeRiskLevel.from(toolRisk: $0.manifest.riskLevel) }
        let risk = risks.max() ?? .risk1
        let roles: [AgentRole]
        switch risk {
        case .risk0:
            roles = [.governor, .synthesizer]
        case .risk1:
            roles = [.governor, .executor, .verifier, .synthesizer]
        case .risk2:
            roles = [.governor, .planner, .executor, .verifier, .synthesizer]
        case .risk3, .risk4:
            roles = [.governor, .planner, .planCritic, .executor, .verifier, .synthesizer]
        }
        return TaskGovernorAssessment(riskLevel: risk,
                                      roles: roles,
                                      requiresPlanCritic: risk >= .risk2,
                                      requiresVerifier: risk >= .risk1,
                                      requiresUserConfirmation: risk >= .risk2,
                                      allowsAutonomousExecution: risk < .risk3 || plan.plan.approvalRequirement == .userApproval,
                                      budget: budget,
                                      reason: "计划最高风险：\(risk.displayName)")
    }
}

public enum PlanConstraintKind: String, Codable, Sendable, Hashable {
    case requiresTool
    case forbidsTool
    case requiresTextInPlan
}

public struct PlanHardConstraint: Codable, Sendable, Hashable {
    public var kind: PlanConstraintKind
    public var value: String

    public init(kind: PlanConstraintKind, value: String) {
        self.kind = kind
        self.value = AgentPrivacyRedactor.safeText(value, maxLength: 160).text
    }

    public static func infer(from goal: PlanningGoal) -> [PlanHardConstraint] {
        let text = goal.text
        var constraints: [PlanHardConstraint] = []
        if let required = token(afterAnyOf: ["必须使用 ", "must use "], in: text) {
            constraints.append(PlanHardConstraint(kind: .requiresTool, value: required))
        }
        if let forbidden = token(afterAnyOf: ["不能使用 ", "不要使用 ", "must not use ", "do not use "], in: text) {
            constraints.append(PlanHardConstraint(kind: .forbidsTool, value: forbidden))
        }
        return constraints
    }

    private static func token(afterAnyOf markers: [String], in text: String) -> String? {
        for marker in markers {
            guard let range = text.range(of: marker, options: [.caseInsensitive]) else { continue }
            let suffix = text[range.upperBound...]
            let token = suffix.prefix { character in
                !character.isWhitespace && !["。", "，", ",", ".", "；", ";"].contains(character)
            }
            let value = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return value }
        }
        return nil
    }
}

public enum PlanCriticVerdict: String, Codable, Sendable, Hashable {
    case approve
    case approveWithChanges
    case reject
    case needUserClarification
}

public enum AgentReviewSeverity: String, Codable, Sendable, Hashable {
    case info
    case warning
    case blocking
}

public struct AgentReviewFinding: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var severity: AgentReviewSeverity
    public var message: String

    public init(id: String, severity: AgentReviewSeverity, message: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.severity = severity
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 400).text
    }
}

public struct PlanCriticInput: Sendable, Hashable {
    public var goal: PlanningGoal
    public var plan: ValidatedTaskPlan
    public var constraints: [PlanHardConstraint]
    public var assessment: TaskGovernorAssessment

    public init(goal: PlanningGoal,
                plan: ValidatedTaskPlan,
                constraints: [PlanHardConstraint] = [],
                assessment: TaskGovernorAssessment) {
        self.goal = goal
        self.plan = plan
        self.constraints = constraints
        self.assessment = assessment
    }
}

public struct PlanCriticReport: Codable, Sendable, Hashable {
    public var verdict: PlanCriticVerdict
    public var findings: [AgentReviewFinding]

    public init(verdict: PlanCriticVerdict, findings: [AgentReviewFinding] = []) {
        self.verdict = verdict
        self.findings = findings
    }

    public var allowsExecution: Bool {
        verdict == .approve || verdict == .approveWithChanges
    }

    public var resultIssues: [AgentResultValidationIssue] {
        findings.map { AgentResultValidationIssue(path: "planCritic.\($0.id)", message: $0.message) }
    }
}

public protocol TaskPlanCritiquing: Sendable {
    func review(_ input: PlanCriticInput) async -> PlanCriticReport
}

public struct DeterministicPlanCritic: TaskPlanCritiquing {
    public init() {}

    public func review(_ input: PlanCriticInput) async -> PlanCriticReport {
        var findings: [AgentReviewFinding] = []
        let toolIDs = Set(input.plan.plan.steps.map(\.toolID.rawValue))
        for constraint in input.constraints {
            switch constraint.kind {
            case .requiresTool where !toolIDs.contains(constraint.value):
                findings.append(AgentReviewFinding(id: "missing_required_tool",
                                                   severity: .blocking,
                                                   message: "计划遗漏硬约束要求的工具：\(constraint.value)"))
            case .forbidsTool where toolIDs.contains(constraint.value):
                findings.append(AgentReviewFinding(id: "forbidden_tool",
                                                   severity: .blocking,
                                                   message: "计划使用了用户禁止的工具：\(constraint.value)"))
            case .requiresTextInPlan:
                let haystack = ([input.plan.plan.goalSummary] + input.plan.plan.steps.map(\.title)).joined(separator: " ")
                if !haystack.localizedCaseInsensitiveContains(constraint.value) {
                    findings.append(AgentReviewFinding(id: "missing_required_text",
                                                       severity: .blocking,
                                                       message: "计划遗漏硬约束：\(constraint.value)"))
                }
            default:
                break
            }
        }

        if input.assessment.riskLevel >= .risk3 && input.plan.plan.approvalRequirement != .userApproval {
            findings.append(AgentReviewFinding(id: "write_without_confirmation",
                                               severity: .blocking,
                                               message: "写操作计划必须先获得用户确认"))
        }
        if input.plan.plan.steps.count > input.assessment.budget.maxAutonomousSteps {
            findings.append(AgentReviewFinding(id: "step_budget_exceeded",
                                               severity: .blocking,
                                               message: "计划步骤超过本轮预算"))
        }

        if findings.contains(where: { $0.severity == .blocking }) {
            return PlanCriticReport(verdict: .reject, findings: findings)
        }
        return PlanCriticReport(verdict: findings.isEmpty ? .approve : .approveWithChanges,
                                findings: findings)
    }
}

public enum EvidenceSourceType: String, Codable, Sendable, Hashable {
    case toolObservation
    case verifier
}

public enum EvidenceReliability: String, Codable, Sendable, Hashable {
    case directToolResult
    case failedToolResult
    case inferred
}

public struct AgentEvidenceRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var taskID: UUID
    public var sourceType: EvidenceSourceType
    public var sourceToolID: ToolID?
    public var sourceEventID: UUID?
    public var capturedAt: Date
    public var contentHash: String
    public var redactedSummary: String
    public var claimsSupported: [String]
    public var reliability: EvidenceReliability
    public var freshness: String
    public var privacyClass: String

    public init(id: String,
                taskID: UUID,
                sourceType: EvidenceSourceType,
                sourceToolID: ToolID? = nil,
                sourceEventID: UUID? = nil,
                capturedAt: Date,
                contentHash: String,
                redactedSummary: String,
                claimsSupported: [String],
                reliability: EvidenceReliability,
                freshness: String,
                privacyClass: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.taskID = taskID
        self.sourceType = sourceType
        self.sourceToolID = sourceToolID
        self.sourceEventID = sourceEventID
        self.capturedAt = capturedAt
        self.contentHash = contentHash
        self.redactedSummary = AgentPrivacyRedactor.safeText(redactedSummary, maxLength: 600).text
        self.claimsSupported = claimsSupported.map { AgentPrivacyRedactor.safeSummary($0, fallback: "claim") }
        self.reliability = reliability
        self.freshness = AgentPrivacyRedactor.safeSummary(freshness, fallback: "current-task")
        self.privacyClass = AgentPrivacyRedactor.safeSummary(privacyClass, fallback: "unknown")
    }

    public static func from(observation: AgentToolObservation,
                            taskID: UUID,
                            capturedAt: Date) -> AgentEvidenceRecord {
        let raw = observation.content.jsonString
        return AgentEvidenceRecord(id: "evidence-\(observation.callID)",
                                   taskID: taskID,
                                   sourceType: .toolObservation,
                                   sourceToolID: ToolID(rawValue: observation.toolName),
                                   capturedAt: capturedAt,
                                   contentHash: sha256(raw),
                                   redactedSummary: observation.userSafeSummary,
                                   claimsSupported: [observation.toolName],
                                   reliability: observation.status == .success ? .directToolResult : .failedToolResult,
                                   freshness: "current-task",
                                   privacyClass: observation.status == .success ? "tool-result-redacted" : "tool-error-redacted")
    }

    private static func sha256(_ raw: String) -> String {
        let digest = SHA256.hash(data: Data(raw.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

public enum VerificationCriterionStatus: String, Codable, Sendable, Hashable {
    case passed
    case failed
    case uncertain
    case notApplicable
}

public struct CompletionCriterionResult: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var status: VerificationCriterionStatus
    public var evidenceIDs: [String]
    public var message: String

    public init(id: String,
                status: VerificationCriterionStatus,
                evidenceIDs: [String] = [],
                message: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.status = status
        self.evidenceIDs = evidenceIDs.map(AgentEventRedactor.safeIdentifier)
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 400).text
    }
}

public enum PlanVerificationVerdict: String, Codable, Sendable, Hashable {
    case pass
    case partialPass
    case repairRequired
    case fail
}

public struct PlanVerificationInput: Sendable {
    public var goal: PlanningGoal
    public var plan: ValidatedTaskPlan
    public var execution: PlanExecutionResult
    public var finalResponse: AgentFinalResponse
    public var evidence: [AgentEvidenceRecord]
    public var assessment: TaskGovernorAssessment
    public var repairAttempt: Int

    public init(goal: PlanningGoal,
                plan: ValidatedTaskPlan,
                execution: PlanExecutionResult,
                finalResponse: AgentFinalResponse,
                evidence: [AgentEvidenceRecord],
                assessment: TaskGovernorAssessment,
                repairAttempt: Int = 0) {
        self.goal = goal
        self.plan = plan
        self.execution = execution
        self.finalResponse = finalResponse
        self.evidence = evidence
        self.assessment = assessment
        self.repairAttempt = repairAttempt
    }
}

public struct PlanVerificationReport: Codable, Sendable, Hashable {
    public var verdict: PlanVerificationVerdict
    public var criteria: [CompletionCriterionResult]
    public var findings: [AgentReviewFinding]
    public var evidenceIDs: [String]
    public var repairAttempt: Int

    public init(verdict: PlanVerificationVerdict,
                criteria: [CompletionCriterionResult],
                findings: [AgentReviewFinding] = [],
                evidenceIDs: [String] = [],
                repairAttempt: Int = 0) {
        self.verdict = verdict
        self.criteria = criteria
        self.findings = findings
        self.evidenceIDs = evidenceIDs.map(AgentEventRedactor.safeIdentifier)
        self.repairAttempt = max(0, repairAttempt)
    }

    public var allowsTerminalSuccess: Bool {
        verdict == .pass || verdict == .partialPass
    }

    public var terminalState: AgentTaskState {
        switch verdict {
        case .pass:
            return .succeeded
        case .partialPass:
            return .partiallySucceeded
        case .repairRequired, .fail:
            return .failed
        }
    }

    public var resultIssues: [AgentResultValidationIssue] {
        findings.map { AgentResultValidationIssue(path: "verifier.\($0.id)", message: $0.message) }
    }
}

public protocol TaskPlanVerifying: Sendable {
    func verify(_ input: PlanVerificationInput) async -> PlanVerificationReport
    func repairFinalResponse(for report: PlanVerificationReport,
                             observations: [AgentToolObservation]) -> AgentFinalResponse
}

public struct DeterministicPlanVerifier: TaskPlanVerifying {
    public init() {}

    public func verify(_ input: PlanVerificationInput) async -> PlanVerificationReport {
        let evidenceIDs = input.evidence.map(\.id)
        var criteria: [CompletionCriterionResult] = []
        var findings: [AgentReviewFinding] = []
        let executedRecords = input.execution.records.filter { $0.status != .skippedDependency }
        let successfulRecords = executedRecords.filter { $0.status.isSuccessful }
        let failedRecords = executedRecords.filter { !$0.status.isSuccessful }

        if executedRecords.isEmpty {
            findings.append(AgentReviewFinding(id: "no_execution_evidence",
                                               severity: .blocking,
                                               message: "没有执行证据，不能判定任务完成"))
            criteria.append(CompletionCriterionResult(id: "has_evidence",
                                                      status: .failed,
                                                      message: "缺少工具执行证据"))
            return PlanVerificationReport(verdict: .fail,
                                          criteria: criteria,
                                          findings: findings,
                                          evidenceIDs: evidenceIDs,
                                          repairAttempt: input.repairAttempt)
        }

        criteria.append(CompletionCriterionResult(id: "has_evidence",
                                                  status: evidenceIDs.isEmpty ? .uncertain : .passed,
                                                  evidenceIDs: evidenceIDs,
                                                  message: evidenceIDs.isEmpty ? "执行记录存在但缺少证据记录" : "执行证据已绑定"))

        if failedRecords.isEmpty {
            criteria.append(CompletionCriterionResult(id: "steps_completed",
                                                      status: .passed,
                                                      evidenceIDs: evidenceIDs,
                                                      message: "所有计划步骤均已完成"))
            criteria.append(CompletionCriterionResult(id: "final_answer_supported",
                                                      status: .passed,
                                                      evidenceIDs: evidenceIDs,
                                                      message: "最终答复可由工具结果支持"))
            return PlanVerificationReport(verdict: .pass,
                                          criteria: criteria,
                                          evidenceIDs: evidenceIDs,
                                          repairAttempt: input.repairAttempt)
        }

        let blockedByPermission = failedRecords.contains { $0.status == .denied }
        let text = input.finalResponse.text
        let overclaims = containsCompletionClaim(text) && !acknowledgesFailure(text)
        let severity: AgentReviewSeverity = blockedByPermission ? .blocking : .warning
        findings.append(AgentReviewFinding(id: blockedByPermission ? "permission_denied" : "incomplete_steps",
                                           severity: severity,
                                           message: blockedByPermission ? "存在未授权步骤，任务不能继续执行" : "存在未完成步骤，最终答复必须标注部分完成"))
        criteria.append(CompletionCriterionResult(id: "steps_completed",
                                                  status: failedRecords.count == executedRecords.count ? .failed : .uncertain,
                                                  evidenceIDs: evidenceIDs,
                                                  message: "未完成步骤数：\(failedRecords.count)"))

        if overclaims {
            findings.append(AgentReviewFinding(id: "unsupported_completion_claim",
                                               severity: .blocking,
                                               message: "最终答复宣称完成，但执行证据显示仍有失败或跳过步骤"))
            criteria.append(CompletionCriterionResult(id: "final_answer_supported",
                                                      status: .failed,
                                                      evidenceIDs: evidenceIDs,
                                                      message: "最终答复需要修正"))
            return PlanVerificationReport(verdict: .repairRequired,
                                          criteria: criteria,
                                          findings: findings,
                                          evidenceIDs: evidenceIDs,
                                          repairAttempt: input.repairAttempt)
        }

        criteria.append(CompletionCriterionResult(id: "final_answer_supported",
                                                  status: blockedByPermission ? .failed : .passed,
                                                  evidenceIDs: evidenceIDs,
                                                  message: blockedByPermission ? "权限拒绝必须作为失败处理" : "最终答复已标注未完成信息"))
        return PlanVerificationReport(verdict: blockedByPermission ? .fail : (successfulRecords.isEmpty ? .fail : .partialPass),
                                      criteria: criteria,
                                      findings: findings,
                                      evidenceIDs: evidenceIDs,
                                      repairAttempt: input.repairAttempt)
    }

    public func repairFinalResponse(for report: PlanVerificationReport,
                                    observations: [AgentToolObservation]) -> AgentFinalResponse {
        let details = report.findings.map(\.message).joined(separator: "；")
        let evidenceSummary = observations.isEmpty
            ? "没有可用工具证据。"
            : observations.suffix(3).map { "\($0.toolName)：\($0.userSafeSummary)" }.joined(separator: "\n")
        let text = "验证发现结果不完整，不能标记为已完成。\(details)\n\(evidenceSummary)"
        return AgentFinalResponse(text: text, finishReason: "verification_repair")
    }

    private func containsCompletionClaim(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return ["已完成", "完成", "成功", "done", "completed", "all set"].contains { lowered.contains($0) }
    }

    private func acknowledgesFailure(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return ["失败", "未完成", "不能", "无法", "部分", "failed", "partial", "incomplete"].contains {
            lowered.contains($0)
        }
    }
}
