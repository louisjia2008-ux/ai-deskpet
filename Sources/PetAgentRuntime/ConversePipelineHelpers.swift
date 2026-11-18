import Foundation
import AICore
import PetBrainCore

// MARK: - Pure helpers for the conversation turn pipeline (doc §11).
//
// Extracted from `PetAgentRuntimeCoordinator.converse` (it lived inline as a
// 200-line `catch` branch with mixed concerns). Each helper is a pure
// decision so it can be tested in isolation — the actor's job is just to
// read inputs and dispatch on the answer.
//
// Companion unit tests: Tests/DeskPetTests/ConversePipelineHelpersTests.swift

enum ConversePipelineHelpers {

    /// Concise UI-facing message for a provider/generation error.
    static func userFacingGenerationError(_ error: Error) -> String {
        if let localized = error as? LocalizedError,
           let message = localized.errorDescription,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }
        return "生成失败"
    }

    /// Should the chunk loop short-circuit immediately, treating the catch
    /// branch as a cancellation rather than a failure? Mirrors the inline
    /// predicate that fired INV-CANCEL-03 + R-A-F4 in the original code.
    static func isTerminalizedCancellation(_ cancelFlags: CancelFlags) -> Bool {
        cancelFlags.cancellationError
            || cancelFlags.taskCancelled
            || cancelFlags.assistantCancelled
            || cancelFlags.attemptTerminalized
    }

    /// Should the typed-failure retry path fire? The decision is intentionally
    /// independent of the `LlmFailure` instance — every field lives on the
    /// plain struct so the helper stays a `Sendable` pure decision.
    static func shouldScheduleRetry(freshFirstAttempt: Bool,
                                   retryable: Bool,
                                   hasTypedFailure: Bool) -> Bool {
        freshFirstAttempt && retryable && hasTypedFailure
    }

    /// Maps `terminalState` + `stopReason` to the activity descriptor the
    /// converse completion path emits. Pure (the caller still owns the emit).
    static func terminalActivityDescriptor(for finalState: AgentTaskState,
                                           stopReason: AgentLoopStopReason?)
        -> (kind: AgentTaskEventKind,
            title: String,
            failureCategory: AgentTaskFailureCategory?) {
        switch finalState {
        case .succeeded:
            return (.taskSucceeded, "任务已完成", nil)
        case .partiallySucceeded:
            return (.taskPartiallySucceeded, "任务部分完成",
                    activityCategory(for: stopReason, default: .unknown))
        case .cancelled:
            return (.taskCancelled, "任务已取消", .cancelled)
        default:
            return (.taskFailed, "任务未完成",
                    activityCategory(for: stopReason, default: .unknown))
        }
    }

    /// Pure stopReason → category lookup (inlined here so this file has no
    /// dependency on the actor's fileprivate extension).
    static func activityCategory(for stopReason: AgentLoopStopReason?,
                                 default fallback: AgentTaskFailureCategory) -> AgentTaskFailureCategory {
        guard let stopReason else { return fallback }
        switch stopReason {
        case .cancelled: return .cancelled
        case .modelTimeout, .providerFailure: return .providerUnavailable
        case .permissionDenied: return .permissionDenied
        case .malformedDecision: return .planningFailed
        case .toolTimeout: return .toolTimedOut
        case .toolFailure, .toolCallLimit, .iterationLimit, .repeatedToolCall: return .toolFailed
        case .completed: return fallback
        }
    }
}

/// Plain, Sendable bag of the four cancel signals the catch branch inspects.
struct CancelFlags: Sendable {
    var cancellationError: Bool = false
    var taskCancelled: Bool = false
    var assistantCancelled: Bool = false
    var attemptTerminalized: Bool = false
}

// MARK: - Inbox + audit helpers (pure aggregation for the converse path).
//
// The converse catch branch and the acceptance gate both build small
// `InboxEvent` payloads and write two flavours of audit entry. The shapes
// are stable, but every callsite hand-builds them inline — easy to drift.
// These helpers build the wire payloads purely so the actor only carries
// them to the wire (no async, no I/O). Pure so each branch can be tested
// without the actor's persistence surface.

enum ConverseInboxBuilder {

    /// Approval requested with a set of missing acceptance criterion IDs.
    /// Mirrors the inline production payload for `case .waitingForUser`.
    static func approvalDecisionRequested(taskID: UUID,
                                          missing: [String]) -> InboxEvent {
        InboxEvent(taskID: taskID,
                   kind: .approvalDecisionRequested,
                   payload: .object([
                       "missing": .array(missing.map { .string($0) })
                   ]))
    }
}

enum ConverseAuditSummary {
    /// Catch-branch terminalized callback (cancellation surfaced as a throw).
    /// Mirrors the inline string `converse:catch:terminalized:<attemptID>`.
    static func converseCatchTerminalized(attemptID: UUID) -> String {
        "converse:catch:terminalized:\(attemptID)"
    }

    /// Converse completion window's stale-callback audit. Mirrors the inline
    /// string `converse:terminalized:<attemptID>`.
    static func converseTerminalized(attemptID: UUID) -> String {
        "converse:terminalized:\(attemptID)"
    }
}