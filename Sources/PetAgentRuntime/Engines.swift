import Foundation
import AICore
import PetBrainCore

/// Wraps a StructuredDecisionProviding and enforces the policy on its proposal (e.g. strips a tool plan
/// when tools are disallowed). The model proposes; the engine constrains.
public struct DecisionEngine: Sendable {
    private let provider: StructuredDecisionProviding
    public init(provider: StructuredDecisionProviding) { self.provider = provider }

    /// Returns the decision AND its provenance (§11). Model failure → deterministic fallback,
    /// never a runtime failure. An empty `.respond` text means "converse via the conversation provider".
    public func decide(context: AgentContext, policy: AgentPolicy) async -> (AgentDecision, DecisionSource) {
        let result = await decideStructured(context: context, policy: policy)
        return (result.decision, result.decisionSource)
    }

    public func decideStructured(context: AgentContext, policy: AgentPolicy) async -> StructuredDecisionResult {
        let result: StructuredDecisionResult
        do {
            result = try await provider.decide(context: context,
                                               availableCapabilities: CapabilityCatalogSnapshot.forPolicy(policy))
        } catch {
            return StructuredDecisionResult(
                decision: .respond(ConversationResponseDecision(text: "我先记下来啦，稍后再帮你看。",
                                                                emotion: .neutral)),
                decisionSource: .deterministicFallback)
        }

        var constrained = result
        switch result.decision {
        case .proposePlan(let proposal):
            guard policy.allowTools else {
                constrained.decision = .decline(DeclineDecision(reason: "当前模式不执行工具操作"))
                return constrained
            }
            let allowed = CapabilityCatalogSnapshot.forPolicy(policy)
            guard proposal.steps.allSatisfy({ allowed.contains($0.capabilityID) }) else {
                constrained.decision = .askClarification(ClarificationDecision(question: "这个操作需要我无法确认的能力，请换一种说法。"))
                return constrained
            }
            let trimmed = Array(proposal.steps.prefix(max(0, policy.maxSteps)))
            guard !trimmed.isEmpty else {
                constrained.decision = .respond(ConversationResponseDecision())
                return constrained
            }
            constrained.decision = .proposePlan(AgentPlanProposal(goal: proposal.goal, steps: trimmed))
            return constrained
        case .delegate(let d):
            guard policy.allowTools else {
                constrained.decision = .decline(DeclineDecision(reason: "当前模式不执行委托"))
                return constrained
            }
            guard policy.delegationDepth < policy.maxDelegationDepth else {
                constrained.decision = .decline(DeclineDecision(reason: "委托层级过深，先自己处理"))
                return constrained
            }
            // Least privilege: keep only capabilities the parent itself is allowed to use.
            let allowed = CapabilityCatalogSnapshot.forPolicy(policy)
            let subset = d.allowedCapabilities.filter { allowed.contains($0) }
            guard !subset.isEmpty else {
                constrained.decision = .askClarification(ClarificationDecision(question: "这个委托需要我没有的能力，请换种说法。"))
                return constrained
            }
            constrained.decision = .delegate(DelegationDecision(goal: d.goal, allowedCapabilities: subset))
            return constrained
        case .respond, .askClarification, .decline, .noAction:
            return constrained
        }
    }
}

/// Builds an executable plan from a decision (§4.4). Every step is a capability the Broker must
/// approve — the planner declares, it never executes.
public enum AgentPlanner {
    public static func plan(from decision: AgentDecision) -> AgentPlan? {
        guard case .proposePlan(let proposal) = decision else { return nil }
        let steps = proposal.steps.map {
            AgentPlanStep(description: $0.description, capabilityID: $0.capabilityID, params: $0.arguments)
        }
        return AgentPlan(goal: proposal.goal, steps: steps)
    }
}

// MARK: Proactive policy (§5 — gate proactive candidates)

public enum ProactiveMode: String, Sendable, Equatable { case quiet, companion, active, agentWorking }

public struct ProactiveInputs: Sendable, Equatable {
    public var urgency: Double            // 0…1
    public var companionshipValue: Double // 0…1
    public var interruptionCost: Double   // 0…1
    public var privacyRisk: Double        // 0…1
    public var userBusy: Bool
    public var mode: ProactiveMode
    public var cooldownActive: Bool
    public init(urgency: Double, companionshipValue: Double, interruptionCost: Double,
                privacyRisk: Double, userBusy: Bool, mode: ProactiveMode, cooldownActive: Bool) {
        self.urgency = urgency; self.companionshipValue = companionshipValue
        self.interruptionCost = interruptionCost; self.privacyRisk = privacyRisk
        self.userBusy = userBusy; self.mode = mode; self.cooldownActive = cooldownActive
    }
}

public enum ProactiveDecision: Sendable, Equatable {
    case allow
    case deferred(reason: String)
    case suppress(reason: String)
    case deny(reason: String)
}

/// Deterministic proactive gate (§5). Privacy and quiet/cooldown win over companionship; nothing
/// here ever produces a side effect — it only decides whether a candidate may surface.
public enum ProactivePolicyEngine {
    public static func decide(_ i: ProactiveInputs, criticalUrgency: Double = 0.85) -> ProactiveDecision {
        if i.privacyRisk > 0.6 { return .deny(reason: "隐私风险过高") }
        let critical = i.urgency >= criticalUrgency
        if i.mode == .quiet && !critical { return .suppress(reason: "安静模式") }
        if i.mode == .agentWorking && !critical { return .suppress(reason: "Agent 工作中，不插入闲聊") }
        if i.cooldownActive && !critical { return .suppress(reason: "冷却中") }
        if i.userBusy && !critical { return .deferred(reason: "用户忙，稍后再说") }
        if critical || i.companionshipValue >= 0.5 { return .allow }
        return .suppress(reason: "陪伴价值不足，转为无声")
    }
}

// MARK: Action scheduler — orders approved plan steps (sequential in v1)

public struct ActionScheduler: Sendable {
    public init() {}
    /// v1: strictly sequential execution order. (Parallelism is a later, carefully-gated addition.)
    public func order(_ plan: AgentPlan) -> [AgentPlanStep] { plan.steps }
}
