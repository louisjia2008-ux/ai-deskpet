import Foundation
import AICore
import PetBrainCore

// Native PetAgentRuntime — DeskPet's own agent runtime. NO dependency on, connection to, or
// awareness of OpenClaw / Hermes / any external agent runtime. Models are reasoning providers only.

// MARK: Events (§5)

public enum EventCategory: Sendable, Equatable {
    case immediateResponse    // user is waiting
    case backgroundUpdate     // task/runtime progress
    case proactiveCandidate   // may or may not surface (policy decides)
    case internalState        // never user-visible on its own
}

public enum PetAgentEvent: Sendable {
    case userMessage(UserMessageEvent)
    case timer(id: String)
    case calendar(title: String, minutesUntil: Int)
    case system(note: String)
    case screenContext(summary: String)      // already sanitized upstream (no raw screenshot)
    case idle(seconds: Int)
    case taskUpdate(AgentTaskEvent)
    case characterState(note: String)

    public var category: EventCategory {
        switch self {
        case .userMessage: return .immediateResponse
        case .taskUpdate: return .backgroundUpdate
        case .timer, .calendar, .idle: return .proactiveCandidate
        case .system, .screenContext, .characterState: return .internalState
        }
    }
}

public extension PetAgentEvent {
    static func userMessage(text: String,
                            conversationID: UUID = UUID(),
                            conversationClass: ConversationClass = .normal,
                            useScreen: Bool = false) -> PetAgentEvent {
        .userMessage(UserMessageEvent(conversationID: conversationID, text: text,
                                      conversationClass: conversationClass,
                                      metadata: UserMessageMetadata(useScreen: useScreen)))
    }
}

// MARK: Context (assembled per event; what the model is allowed to see)

public struct CharacterRuntimeState: Sendable, Equatable {
    public var emotion: PetEmotion
    public var userBusy: Bool
    public init(emotion: PetEmotion = .neutral, userBusy: Bool = false) {
        self.emotion = emotion; self.userBusy = userBusy
    }
}

/// A single executed step's outcome, folded back into the next decision round (P1 agentic loop).
/// The model sees only this redacted/clipped summary — never a raw tool payload, never a token.
public struct ToolObservation: Sendable, Equatable {
    public var stepID: String
    public var capabilityID: String
    public var ok: Bool
    public var summary: String       // already redacted/clipped before it reaches the model
    public init(stepID: String, capabilityID: String, ok: Bool, summary: String) {
        self.stepID = stepID; self.capabilityID = capabilityID; self.ok = ok; self.summary = summary
    }
}

public struct AgentContext: Sendable, Equatable {
    public var userText: String?
    public var memoryHints: [String]
    public var recentTurns: [String]
    public var frontmostApp: String?
    public var characterState: CharacterRuntimeState
    public var intentContext: ConversationIntentContext?
    /// Results of steps already executed in THIS task. Empty on the first decision round; populated
    /// by the coordinator before each re-decision so the model can observe and choose the next step.
    public var observations: [ToolObservation]
    public init(userText: String? = nil, memoryHints: [String] = [], recentTurns: [String] = [],
                frontmostApp: String? = nil, characterState: CharacterRuntimeState = .init(),
                intentContext: ConversationIntentContext? = nil,
                observations: [ToolObservation] = []) {
        self.userText = userText; self.memoryHints = memoryHints; self.recentTurns = recentTurns
        self.frontmostApp = frontmostApp; self.characterState = characterState
        self.intentContext = intentContext
        self.observations = observations
    }
}

public protocol AgentContextBuilding: Sendable {
    func build(for event: PetAgentEvent) async -> AgentContext
}

// MARK: Reasoning model provider (§3) — the ONLY role of a model

public struct AgentPolicy: Sendable, Equatable {
    public var allowTools: Bool
    public var maxSteps: Int                 // per-round plan step cap (existing semantics)
    /// Agentic-loop budgets (P1). They bound the observe→re-decide cycle so it always terminates.
    public var maxIterations: Int            // re-decision rounds
    public var maxToolCalls: Int             // cumulative executed steps across all rounds
    public var maxWallClock: TimeInterval    // wall-clock ceiling for the whole loop
    /// Subagent delegation bounds (P3). `capabilityAllowlist` (when non-nil) narrows the capability
    /// catalog to a subset — children run with a least-privilege subset of the parent's.
    public var capabilityAllowlist: Set<String>?
    public var maxDelegationDepth: Int       // hardest cap on nested delegation
    public var delegationDepth: Int          // current depth (0 = top-level)
    public var tier: DistributionTier
    public init(allowTools: Bool, maxSteps: Int,
                maxIterations: Int = 3, maxToolCalls: Int = 8, maxWallClock: TimeInterval = 60,
                capabilityAllowlist: Set<String>? = nil, maxDelegationDepth: Int = 1,
                delegationDepth: Int = 0, tier: DistributionTier) {
        self.allowTools = allowTools; self.maxSteps = maxSteps
        self.maxIterations = maxIterations; self.maxToolCalls = maxToolCalls
        self.maxWallClock = maxWallClock
        self.capabilityAllowlist = capabilityAllowlist
        self.maxDelegationDepth = maxDelegationDepth; self.delegationDepth = delegationDepth
        self.tier = tier
    }
}

public struct CapabilityCatalogSnapshot: Sendable, Equatable {
    public var capabilities: [Capability]
    public var toolCatalog: ToolCatalogSnapshot
    public init(capabilities: [Capability], toolCatalog: ToolCatalogSnapshot = .empty) {
        self.capabilities = capabilities
        self.toolCatalog = toolCatalog
    }
    public static func forPolicy(_ policy: AgentPolicy) -> CapabilityCatalogSnapshot {
        guard policy.allowTools else { return CapabilityCatalogSnapshot(capabilities: []) }
        let base = CapabilityCatalog.all.filter {
            !policy.tier.isPermanentlyDenied($0) &&
                !CapabilityCatalog.unavailableByDefault.contains($0.id)
        }
        // Least privilege: a child's allowlist (when present) intersects the tier-allowed set.
        guard let allowlist = policy.capabilityAllowlist else {
            return CapabilityCatalogSnapshot(capabilities: base)
        }
        return CapabilityCatalogSnapshot(capabilities: base.filter { allowlist.contains($0.id) })
    }
    public func contains(_ id: String) -> Bool {
        toolCatalog.contains(id) || capabilities.contains { $0.id == id }
    }
}

public struct ConversationResponseDecision: Sendable, Equatable {
    public var text: String
    public var emotion: PetEmotion
    public init(text: String = "", emotion: PetEmotion = .neutral) {
        self.text = text
        self.emotion = emotion
    }
}

public struct AgentPlanProposalStep: Sendable, Equatable {
    public var id: String
    public var description: String
    public var capabilityID: String
    public var toolID: String?
    public var arguments: [String: String]
    public init(id: String,
                description: String,
                capabilityID: String,
                toolID: String? = nil,
                arguments: [String: String] = [:]) {
        self.id = id
        self.description = description
        self.capabilityID = capabilityID
        self.toolID = toolID
        self.arguments = arguments
    }
}

public struct AgentPlanProposal: Sendable, Equatable {
    public var goal: String
    public var steps: [AgentPlanProposalStep]
    public init(goal: String, steps: [AgentPlanProposalStep]) {
        self.goal = goal
        self.steps = steps
    }
}

public struct ClarificationDecision: Sendable, Equatable {
    public var question: String
    public init(question: String) { self.question = question }
}

public struct DeclineDecision: Sendable, Equatable {
    public var reason: String
    public init(reason: String) { self.reason = reason }
}

public struct NoActionDecision: Sendable, Equatable {
    public var reason: String
    public init(reason: String = "") { self.reason = reason }
}

/// A request to hand a sub-goal to a bounded child agent (P3). `allowedCapabilities` is the subset the
/// child may use — the runtime intersects it with the parent's, never widening it.
public struct DelegationDecision: Sendable, Equatable {
    public var goal: String
    public var allowedCapabilities: [String]
    public init(goal: String, allowedCapabilities: [String]) {
        self.goal = goal
        self.allowedCapabilities = allowedCapabilities
    }
}

/// A validated structured decision — never an execution. The model can only propose intent; it
/// cannot run tools, hold grants, touch the filesystem/shell/memory/ledger, or spawn background
/// tasks (§3).
public enum AgentDecision: Sendable, Equatable {
    case respond(ConversationResponseDecision)
    case proposePlan(AgentPlanProposal)
    case delegate(DelegationDecision)
    case askClarification(ClarificationDecision)
    case decline(DeclineDecision)
    case noAction(NoActionDecision)
}

public struct DecisionValidationResult: Sendable, Equatable {
    public var accepted: Bool
    public var issues: [String]
    public init(accepted: Bool, issues: [String] = []) {
        self.accepted = accepted
        self.issues = issues
    }
    public static let valid = DecisionValidationResult(accepted: true)
    public static func rejected(_ issues: [String]) -> DecisionValidationResult {
        DecisionValidationResult(accepted: false, issues: issues)
    }
}

public struct StructuredDecisionResult: Sendable, Equatable {
    public var decision: AgentDecision
    public var decisionSource: DecisionSource
    public var schemaVersion: Int
    public var validationResult: DecisionValidationResult
    public var fallbackReason: String?
    public var memoryCandidates: [MemoryCandidate]
    public var resultDocument: AgentResultDocument?
    public var resultIssues: [AgentResultValidationIssue]
    public var modelProvider: String
    public var latency: TimeInterval
    public init(decision: AgentDecision, decisionSource: DecisionSource,
                schemaVersion: Int = 1, validationResult: DecisionValidationResult = .valid,
                fallbackReason: String? = nil,
                memoryCandidates: [MemoryCandidate] = [],
                resultDocument: AgentResultDocument? = nil,
                resultIssues: [AgentResultValidationIssue] = [],
                modelProvider: String = "local",
                latency: TimeInterval = 0) {
        self.decision = decision
        self.decisionSource = decisionSource
        self.schemaVersion = schemaVersion
        self.validationResult = validationResult
        self.fallbackReason = fallbackReason
        self.memoryCandidates = memoryCandidates
        self.resultDocument = resultDocument
        self.resultIssues = resultIssues
        self.modelProvider = modelProvider
        self.latency = latency
    }
}

public protocol StructuredDecisionProviding: Sendable {
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult
}

// MARK: Plan (§4.4 — every side effect becomes a capability request first)

public struct AgentPlanStep: Sendable, Equatable {
    public var description: String
    public var capabilityID: String
    public var params: [String: String]
    public init(description: String, capabilityID: String, params: [String: String] = [:]) {
        self.description = description; self.capabilityID = capabilityID; self.params = params
    }
}
public struct AgentPlan: Sendable, Equatable {
    public var goal: String
    public var steps: [AgentPlanStep]
}

// MARK: Capability boundary + tool execution (injected; the runtime never calls effects directly)

public enum GateOutcome: Sendable, Equatable {
    case granted(CapabilityToken)
    case denied(reason: String)
    case askUser
}
/// The Capability Broker boundary. Planner / model / coordinator MUST route every side effect here.
public protocol CapabilityGate: Sendable {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome
}

public struct ToolOutcome: Sendable, Equatable {
    public var ok: Bool
    public var output: String
    public var error: String?
    public init(ok: Bool, output: String, error: String? = nil) { self.ok = ok; self.output = output; self.error = error }
}
/// Executes a granted step. Receives a token (never a grant), minimal params. Cannot be reached
/// except via the gate (the coordinator enforces this ordering).
public protocol ToolExecuting: Sendable {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome
}

public protocol RuntimeClock: Sendable { func now() -> Date }
public struct WallClock: RuntimeClock { public init() {}; public func now() -> Date { Date() } }

// MARK: Reflection sink (P4) — a finished task's outcome, for the self-evolution learning loop

/// Receives a terminated tool-task's outcome so the app can reflect and suggest memories. A side
/// channel: it must not block, mutate runtime state, or produce side effects the runtime can observe.
public protocol ReflectionSink: Sendable {
    func reflect(_ input: TaskReflectionInput) async
    func reflectCandidates(_ candidates: [MemoryCandidate]) async
}

public extension ReflectionSink {
    func reflectCandidates(_ candidates: [MemoryCandidate]) async {}
}

/// Default: reflection disabled. The runtime behaves exactly as before P4.
public struct NoopReflectionSink: ReflectionSink {
    public init() {}
    public func reflect(_ input: TaskReflectionInput) async {}
}
