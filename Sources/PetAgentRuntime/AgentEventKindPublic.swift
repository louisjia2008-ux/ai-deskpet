import Foundation

// P13-D: Public semantic event taxonomy and invariants.
//
// DeskPet already exposes `AgentEventKind` (Sources/PetAgentRuntime/AgentEventModels.swift:23-)
// and `AgentTaskEventKind` (Sources/PetAgentRuntime/AgentTaskActivityModels.swift:4-).
// `AgentTaskEventKind` is the durable kind emitted on the activity stream.
// `AgentEventKind` is the envelope-level kind the activity store exposes.
//
// P13-D extends the existing `AgentEventKind` with terminal classification
// (`isTerminal`) and a deterministic mapping from the durable
// `AgentTaskEventKind` to the public semantic kind the UI must consume.
// The mapping is total; the unknown internal kind maps to nil.
//
// Invariants enforced by `P13-D Kernel Contract Tests`:
//
//   INV-EVENT-01 — A terminal state must occur at most once per run.
//                   Enforced at the activity reducer via `terminalizedRunIDs`.
//                   (Sources/DeskPet/AI/ChatModel.swift:876)
//
//   INV-EVENT-02 — No ordinary progress event may appear after a terminal
//                   event for the same run. Enforced by the activity reducer
//                   state machine (`isLegal`).
//                   (Sources/PetAgentRuntime/AgentTaskActivityModels.swift:482-511)
//
//   INV-EVENT-03 — Tool start correlates with a tool request / execution
//                   identity. Enforced via `ToolID` and `ToolExecutionIdentity`.
//                   (Sources/PetAgentRuntime/ToolPlatformModels.swift:580-616,
//                    Sources/PetAgentRuntime/ToolPostExecuteHook.swift)
//
//   INV-EVENT-04 — Tool completion/failure correlates with the same tool
//                   execution identity as the start. Enforced via
//                   `ToolExecutionIdentity` carried by the post-execute hook.
//
//   INV-EVENT-05 — Cancellation must not later produce an ordinary success
//                   state. Enforced via `terminalizedRunIDs.insert(...).inserted`.
//                   (Sources/DeskPet/AI/ChatModel.swift:876)
//
//   INV-EVENT-06 — User-facing activity must not require displaying raw tool
//                   identifiers. The UI must always go through
//                   `ToolPresentationMetadata.metadata(for:)`
//                   (Sources/PetAgentRuntime/AgentActivityPresentation.swift:119-).
//
//   INV-EVENT-07 — Provider-internal reasoning must not leak into ordinary
//                   assistant output content. Sanitised at the adapter
//                   boundary (Sources/AICore/ModelResponseSanitizer.swift:21-)
//                   and at the post-execute hook chain.
//
//   INV-EVENT-08 — Raw provider errors must have a semantic translation path.
//                   The kernel publishes `LlmFailure.code` (P13-D new); the
//                   UI branches on the code, never on the raw provider text.

extension AgentEventKind {
    /// True for terminal event kinds (P13 INV-EVENT-01).
    public var isTerminal: Bool {
        switch self {
        case .taskSucceeded, .taskPartiallySucceeded, .taskFailed,
             .taskCancelled, .taskInterrupted, .runCompleted, .runFailed,
             .runCancelled:
            return true
        default:
            return false
        }
    }

    /// Map an internal durable `AgentTaskEventKind` to the public semantic
    /// `AgentEventKind`. The mapping is total; the unknown internal kind maps
    /// to nil. UI consumers should always go through this mapping rather than
    /// using `AgentTaskEventKind` directly.
    public init?(from internalKind: AgentTaskEventKind) {
        switch internalKind {
        case .taskCreated, .taskQueued, .planningStarted, .planProposed:
            self = .taskCreated
        case .taskWaitingForRetry:
            self = .providerRateLimited
        case .taskRecovered:
            self = .taskResumed
        case .modelRequestStarted:
            self = .modelRequestStarted
        case .approvalRequested:
            self = .toolPermissionRequired
        case .stepStarted, .executionStarted, .verificationStarted,
             .replanStarted, .providerRequestStarted, .userInteractionRequested:
            self = .stepStarted
        case .stepProgress, .modelResponseStreaming, .providerResponseReceived,
             .providerRateLimited:
            self = .stepProgress
        case .stepSucceeded, .verificationSucceeded, .replanSucceeded,
             .userInteractionResolved, .approvalGranted, .modelResponseCompleted:
            self = .stepSucceeded
        case .stepFailed, .stepSkipped, .replanFailed, .verificationFailed,
             .modelRequestFailed, .providerAuthenticationFailed, .providerUnavailable,
             .providerRequestFailed, .approvalDenied:
            self = .stepFailed
        case .synthesisStarted:
            self = .modelRequestStarted
        case .synthesisSucceeded, .resultProduced:
            self = .resultProduced
        case .taskSucceeded, .taskPartiallySucceeded:
            self = .taskSucceeded
        case .taskFailed:
            self = .taskFailed
        case .taskCancelled:
            self = .taskCancelled
        case .taskInterrupted:
            self = .taskInterrupted
        case .unknown:
            return nil
        }
    }
}