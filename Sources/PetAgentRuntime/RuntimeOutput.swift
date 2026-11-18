import Foundation
import AICore
import PetBrainCore

// Single-runtime convergence (P4.3): the coordinator is the only top-level entry. These are the
// vendor-neutral event-in / output-out types the UI consumes — never raw model output, never an
// external runtime's envelope.

/// Normalized user chat input (no SwiftUI/DB types inside the runtime event, §4.1).
public struct UserMessageMetadata: Sendable, Equatable {
    public var useScreen: Bool
    public var source: String
    public var intentContext: ConversationIntentContext?
    public init(useScreen: Bool = false,
                source: String = "mainChat",
                intentContext: ConversationIntentContext? = nil) {
        self.useScreen = useScreen
        self.source = source
        self.intentContext = intentContext
    }
}

public struct UserMessageEvent: Sendable, Equatable {
    public let eventID: UUID
    public let conversationID: UUID
    public let messageID: UUID
    public let text: String
    public let conversationClass: ConversationClass
    public let createdAt: Date
    public let retryOfMessageID: UUID?
    public let retryOfTaskID: UUID?
    public let regeneratedFromMessageID: UUID?
    public let taskIDOverride: UUID?
    public let runIDOverride: UUID?
    public let metadata: UserMessageMetadata
    public init(eventID: UUID = UUID(), conversationID: UUID, messageID: UUID = UUID(), text: String,
                conversationClass: ConversationClass = .normal, createdAt: Date = Date(),
                retryOfMessageID: UUID? = nil, retryOfTaskID: UUID? = nil,
                regeneratedFromMessageID: UUID? = nil,
                taskIDOverride: UUID? = nil, runIDOverride: UUID? = nil,
                metadata: UserMessageMetadata = .init()) {
        self.eventID = eventID; self.conversationID = conversationID; self.messageID = messageID
        self.text = text; self.conversationClass = conversationClass; self.createdAt = createdAt
        self.retryOfMessageID = retryOfMessageID; self.retryOfTaskID = retryOfTaskID
        self.regeneratedFromMessageID = regeneratedFromMessageID
        self.taskIDOverride = taskIDOverride
        self.runIDOverride = runIDOverride
        self.metadata = metadata
    }
}

/// Where a decision came from — so a keyword stub can never silently become "the architecture" (§11).
public enum DecisionSource: String, Sendable, Codable, Equatable {
    case ruleBasedFallback      // explicit fallback; never masquerades as structured model output
    case modelStructured        // a real structured-decision model (future)
    case deterministicFallback  // model failed → safe default

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        switch raw {
        case Self.ruleBasedFallback.rawValue:
            self = .ruleBasedFallback
        case "ruleBasedStub":
            self = .ruleBasedFallback
        case Self.modelStructured.rawValue:
            self = .modelStructured
        case Self.deterministicFallback.rawValue:
            self = .deterministicFallback
        default:
            throw DecodingError.dataCorruptedError(in: container,
                                                   debugDescription: "Unknown decision source: \(raw)")
        }
    }
}

public enum ConversationProviderStreamingCapability: String, Sendable, Codable, Equatable {
    case trueStreaming
    case nonStreaming
}

/// Streamed runtime output the UI subscribes to (§5.1). The UI never subscribes to a model stream.
public enum PetAgentRuntimeOutput: Sendable, Equatable {
    case taskStarted(taskID: UUID, attemptID: UUID, source: DecisionSource)
    case taskActivity(AgentTaskActivityEvent)
    case providerMetadata(ConversationProviderStreamingCapability)
    case loopStateChanged(AgentLoopState)
    case planUpdated(PlanPresentationSnapshot)
    case responseStarted(messageID: UUID)
    case responseDelta(messageID: UUID, sequence: Int, text: String)
    case responseCompleted(messageID: UUID, emotion: PetEmotion, viaCloud: Bool)
    case presentation(CharacterPresentation)
    case waitingForApproval(capabilityID: String)
    case failed(messageID: UUID?, reason: String)
    case cancelled(messageID: UUID?)
    /// P14.2 — R-B-F01 closure. Typed-failure emission carrying the
    /// `LlmFailure` so consumers (ChatModel, AppDelegate) can route the
    /// typed scheduler retry path.
    case typedFailed(messageID: UUID?, llmFailure: LlmFailure, reason: String)
}

// MARK: Conversation generation seam (§4.3) — the demoted role of the old top-level runtime

public struct ConversationRequest: Sendable, Equatable {
    public var text: String
    public var history: [String]
    public var memoryHints: [String]
    public var isPrivate: Bool
    public var useScreen: Bool
    public init(text: String, history: [String] = [], memoryHints: [String] = [], isPrivate: Bool = false,
                useScreen: Bool = false) {
        self.text = text; self.history = history; self.memoryHints = memoryHints; self.isPrivate = isPrivate
        self.useScreen = useScreen
    }
}

public enum ConversationChunk: Sendable, Equatable {
    case metadata(ConversationProviderStreamingCapability)
    case delta(sequence: Int, text: String)
    case completed(emotion: PetEmotion, viaCloud: Bool)
    /// P14.2 — R-B-F01 closure. The provider surfaced a typed failure
    /// (rather than a generic string). The runtime can route the typed
    /// `LlmFailure.code` directly into `AgentRetryPolicy.shouldRetry(...)`
    /// without losing semantics through string conversion.
    case typedError(LlmFailure)
}

/// A pure conversation generator: streams a reply, supports cancellation (caller cancels the Task),
/// surfaces structured errors. It does NOT touch UI, tools, the Ledger, or long-term memory, and it
/// never publishes the final message itself — the coordinator owns that (§4.3).
public protocol ConversationGenerating: Sendable {
    var streamingCapability: ConversationProviderStreamingCapability { get }
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error>
}

public extension ConversationGenerating {
    var streamingCapability: ConversationProviderStreamingCapability { .nonStreaming }

    /// P14.2 — R-B-F01. Default typed-failure entry point. Implementations
    /// that can classify a provider failure into `LlmFailure` override
    /// this; the default implementation throws the regular `Error`
    /// instead so existing call sites are unaffected.
    func typedGenerate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        generate(request)
    }
}

/// P14.2 — public error type thrown by `ConversationGenerating.generate(_:)`
/// (or `.typedError` chunks rethrown to surface the typed `LlmFailure` to
/// the catch block on the call site).
public struct ConversationGenerationError: Error, LocalizedError, Sendable, Equatable {
    public let message: String
    public init(message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum RuntimeLedgerEventKind: String, Sendable, Codable, Equatable {
    case created
    case started
    case responseStarted
    case responseDelta
    case completed
    case cancelled
    case failed
    case waitingForApproval
    case interruptedByRestart
    case toolObserved          // P1: one agentic-loop iteration's executed steps were observed
    case delegated             // P3: a subtask was delegated to a bounded child agent
}

public struct AgentTaskLedgerEvent: Sendable, Codable, Equatable, Identifiable {
    public var id: UUID
    public var taskID: UUID
    public var attemptID: UUID
    public var conversationID: UUID
    public var userMessageID: UUID
    public var assistantMessageID: UUID?
    public var retryOfTaskID: UUID?
    public var regeneratedFromMessageID: UUID?
    public var parentTaskID: UUID?
    public var state: AgentTaskState
    public var kind: RuntimeLedgerEventKind
    public var sequence: Int
    public var operationID: String?
    public var decisionSource: DecisionSource?
    public var providerStreamingCapability: ConversationProviderStreamingCapability?
    public var agentLoopState: String?
    public var stopReason: AgentLoopStopReason?
    public var iterationCount: Int?
    public var toolCallCount: Int?
    public var usedToolNames: [String]?
    public var toolStatuses: [String]?
    public var planID: String?
    public var planVersion: Int?
    public var planStepCount: Int?
    public var planRiskLevel: String?
    public var planApprovalRequired: Bool?
    public var planApprovalGranted: Bool?
    public var planReplanCount: Int?
    public var planResultItemCount: Int?
    public var planResultTruncated: Bool?
    public var modelProvider: String?
    public var latencyMilliseconds: Int?
    public var failureReason: String?
    public var cancelReason: String?
    public var outputSequence: Int?
    public var createdAt: Date
    public var updatedAt: Date
    public var terminalAt: Date?

    public init(id: UUID = UUID(), taskID: UUID, attemptID: UUID, conversationID: UUID,
                userMessageID: UUID, assistantMessageID: UUID? = nil, retryOfTaskID: UUID? = nil,
                regeneratedFromMessageID: UUID? = nil, parentTaskID: UUID? = nil, state: AgentTaskState,
                kind: RuntimeLedgerEventKind, sequence: Int, operationID: String? = nil,
                decisionSource: DecisionSource? = nil,
                providerStreamingCapability: ConversationProviderStreamingCapability? = nil,
                agentLoopState: String? = nil,
                stopReason: AgentLoopStopReason? = nil,
                iterationCount: Int? = nil,
                toolCallCount: Int? = nil,
                usedToolNames: [String]? = nil,
                toolStatuses: [String]? = nil,
                planID: String? = nil,
                planVersion: Int? = nil,
                planStepCount: Int? = nil,
                planRiskLevel: String? = nil,
                planApprovalRequired: Bool? = nil,
                planApprovalGranted: Bool? = nil,
                planReplanCount: Int? = nil,
                planResultItemCount: Int? = nil,
                planResultTruncated: Bool? = nil,
                modelProvider: String? = nil,
                latencyMilliseconds: Int? = nil,
                failureReason: String? = nil, cancelReason: String? = nil,
                outputSequence: Int? = nil, createdAt: Date = Date(),
                updatedAt: Date = Date(), terminalAt: Date? = nil) {
        self.id = id; self.taskID = taskID; self.attemptID = attemptID
        self.conversationID = conversationID; self.userMessageID = userMessageID
        self.assistantMessageID = assistantMessageID; self.retryOfTaskID = retryOfTaskID
        self.regeneratedFromMessageID = regeneratedFromMessageID; self.parentTaskID = parentTaskID
        self.state = state
        self.kind = kind; self.sequence = sequence; self.operationID = operationID
        self.decisionSource = decisionSource
        self.providerStreamingCapability = providerStreamingCapability
        self.agentLoopState = agentLoopState
        self.stopReason = stopReason
        self.iterationCount = iterationCount
        self.toolCallCount = toolCallCount
        self.usedToolNames = usedToolNames
        self.toolStatuses = toolStatuses
        self.planID = AgentPrivacyRedactor.safeMetadata(["planID": planID ?? ""])["planID"]
        self.planVersion = planVersion
        self.planStepCount = planStepCount
        self.planRiskLevel = planRiskLevel
        self.planApprovalRequired = planApprovalRequired
        self.planApprovalGranted = planApprovalGranted
        self.planReplanCount = planReplanCount
        self.planResultItemCount = planResultItemCount
        self.planResultTruncated = planResultTruncated
        self.modelProvider = modelProvider
        self.latencyMilliseconds = latencyMilliseconds
        self.failureReason = failureReason; self.cancelReason = cancelReason
        self.outputSequence = outputSequence; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.terminalAt = terminalAt
    }
}

public struct AgentTaskSnapshot: Sendable, Codable, Equatable {
    public var taskID: UUID
    public var attemptID: UUID
    public var conversationID: UUID
    public var userMessageID: UUID
    public var assistantMessageID: UUID?
    public var state: AgentTaskState
    public var lastSequence: Int
    public var retryOfTaskID: UUID?
    public var regeneratedFromMessageID: UUID?
    public var parentTaskID: UUID?
    public var updatedAt: Date

    public init(taskID: UUID, attemptID: UUID, conversationID: UUID, userMessageID: UUID,
                assistantMessageID: UUID?, state: AgentTaskState, lastSequence: Int,
                retryOfTaskID: UUID? = nil, regeneratedFromMessageID: UUID? = nil,
                parentTaskID: UUID? = nil, updatedAt: Date) {
        self.taskID = taskID; self.attemptID = attemptID
        self.conversationID = conversationID; self.userMessageID = userMessageID
        self.assistantMessageID = assistantMessageID; self.state = state
        self.lastSequence = lastSequence; self.retryOfTaskID = retryOfTaskID
        self.regeneratedFromMessageID = regeneratedFromMessageID
        self.parentTaskID = parentTaskID; self.updatedAt = updatedAt
    }
}

public protocol AgentTaskLedgerPersisting: Sendable {
    func append(_ event: AgentTaskLedgerEvent) async throws
    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent]
    func activeTasks() async throws -> [AgentTaskSnapshot]
    func hasOperationID(_ operationID: String) async throws -> Bool
}

public actor NoopAgentTaskLedgerStore: AgentTaskLedgerPersisting {
    public init() {}
    public func append(_ event: AgentTaskLedgerEvent) async throws {}
    public func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] { [] }
    public func activeTasks() async throws -> [AgentTaskSnapshot] { [] }
    public func hasOperationID(_ operationID: String) async throws -> Bool { false }
}
