import Foundation

/// Agent task lifecycle (doc §13). Named `AgentTask` to stay distinct from the user's to-do
/// `PetTask` (decision 14: PetTask ≠ Conversation ≠ Agent Session). The native runtime is the event
/// source; everything here — state machine, ledger, idempotency, pause/cancel/recover — is pure
/// and testable.

public enum AgentTaskState: String, Sendable, Codable, Equatable, CaseIterable {
    case draft, awaitingApproval, queued, preparing, running
    case awaitingPermission, awaitingUserInput, paused, cancelling, cancelled
    case recovering, succeeded, partiallySucceeded, failed, rolledBack

    public var isTerminal: Bool {
        switch self {
        case .cancelled, .succeeded, .partiallySucceeded, .failed, .rolledBack: return true
        default: return false
        }
    }
}

/// Lightweight references — payloads live in the artifact store, not inline (C4).
public struct EvidenceRef: Sendable, Codable, Equatable { public var id: String; public init(id: String) { self.id = id } }
public struct ArtifactRef: Sendable, Codable, Equatable { public var id: String; public var path: String; public init(id: String, path: String) { self.id = id; self.path = path } }
public struct CheckpointRef: Sendable, Codable, Equatable { public var id: String; public init(id: String) { self.id = id } }
public struct DiffRef: Sendable, Codable, Equatable { public var id: String; public init(id: String) { self.id = id } }

public struct CompletionReport: Sendable, Codable, Equatable {
    public var success: Bool
    public var partial: Bool
    public var summary: String
    public init(success: Bool, partial: Bool, summary: String) {
        self.success = success; self.partial = partial; self.summary = summary
    }
}
public struct TaskError: Sendable, Codable, Equatable { public var message: String; public init(message: String) { self.message = message } }

/// Events an agent runtime emits (doc §13.3). Side-effecting events carry an `operationID`.
public enum AgentTaskEvent: Sendable, Equatable {
    case stateChanged(AgentTaskState)
    case stageStarted(name: String)
    case progress(stage: String, fraction: Double?)     // nil → unknown total; never fake a %
    case evidenceFound(EvidenceRef)
    case artifactProduced(ArtifactRef)
    case capabilityRequested(CapabilityRequest)
    case userInputRequested(prompt: String)
    case fileChangeProposed(DiffRef, operationID: String)
    case checkpointCreated(CheckpointRef)
    case completed(CompletionReport)
    case failed(TaskError)
}

/// Task definition (doc §13.2) — never a vague user message; always a bounded contract.
public struct AgentTaskDefinition: Sendable, Codable, Equatable {
    public var goal: String
    public var workspace: String
    public var allowedCapabilities: [String]
    public var forbiddenCapabilities: [String]
    public var completionCriteria: String
    public var rollbackOnCancel: Bool
    public init(goal: String, workspace: String, allowedCapabilities: [String] = [],
                forbiddenCapabilities: [String] = [], completionCriteria: String = "",
                rollbackOnCancel: Bool = true) {
        self.goal = goal; self.workspace = workspace
        self.allowedCapabilities = allowedCapabilities; self.forbiddenCapabilities = forbiddenCapabilities
        self.completionCriteria = completionCriteria; self.rollbackOnCancel = rollbackOnCancel
    }
}

/// Valid transitions (doc §13.1). Pure.
public enum AgentTaskMachine {
    public static func canTransition(from: AgentTaskState, to: AgentTaskState) -> Bool {
        if from.isTerminal { return false }
        switch from {
        case .draft:            return [.awaitingApproval, .cancelled].contains(to)
        case .awaitingApproval: return [.queued, .cancelled].contains(to)
        case .queued:           return [.preparing, .cancelling, .cancelled].contains(to)
        case .preparing:        return [.running, .failed, .cancelling].contains(to)
        case .running:          return [.awaitingPermission, .awaitingUserInput, .paused, .cancelling,
                                        .succeeded, .partiallySucceeded, .failed, .recovering].contains(to)
        case .awaitingPermission: return [.running, .cancelling, .failed].contains(to)
        case .awaitingUserInput:  return [.running, .cancelling].contains(to)
        case .paused:           return [.running, .cancelling].contains(to)
        case .cancelling:       return [.cancelled, .rolledBack].contains(to)
        case .recovering:       return [.running, .failed].contains(to)
        default:                return false
        }
    }
}
