import Foundation
import AICore
import PetBrainCore

// P14-B — Durable Task State Machine.
//
// One unified typed surface for the runtime. Backed by the existing
// AgentTaskSchedulerStatus (queue / lock state) and AgentTaskStatus (event-driven
// activity state). The DurableTaskState collapses both views into a single
// canonical state used by:
//   - DurableTaskRecord (persistent record persisted on every transition)
//   - AcceptanceEvaluator (P14-D)
//   - Retry / recovery policy (P14-E/F/G)
//   - Inbox dispatch (P14-H)
//
// Naming aligns with the §9.1 required conceptual states:
//   queued → running → waitingForTool → running
//   running → waitingForApproval → running
//   running → waitingForUserInput → running
//   running → waitingForRetry → running
//   running → interrupted → running
//   running → completed
//   running → failed
//   running → cancelled
//
// Implementation notes:
// - `terminal` states are `.completed`, `.failed`, `.cancelled` (INV-DUR-03).
// - Each transition through `canTransition(to:)` is logged via RuntimeAuditLog
//   so the durable timeline is reconstructable.
// - Illegal transitions are silently rejected (no-op) AND recorded as
//   `RuntimeAuditKind.invalidTransition`.

public enum DurableTaskState: String, Codable, Sendable, Hashable, CaseIterable {
    case queued
    case running
    case waitingForTool
    case waitingForApproval
    case waitingForUserInput
    case waitingForRetry
    case paused
    case interrupted
    case completed
    case failed
    case cancelled
    case unknown               // tolerant decoder fallback

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: return true
        case .queued, .running, .waitingForTool, .waitingForApproval,
             .waitingForUserInput, .waitingForRetry, .paused, .interrupted, .unknown:
            return false
        }
    }

    /// Public-stable user-facing label (Chinese). UI surfaces should display
    /// these (and only these) rather than raw enum case names (§17).
    public var userVisibleLabel: String {
        switch self {
        case .queued: return "排队中"
        case .running: return "运行中"
        case .waitingForTool: return "等待工具"
        case .waitingForApproval: return "等待你确认"
        case .waitingForUserInput: return "需要补充信息"
        case .waitingForRetry: return "等待重试"
        case .paused: return "已暂停"
        case .interrupted: return "已中断"
        case .completed: return "已完成"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        case .unknown: return "未知"
        }
    }

    /// Legal transitions per the P14 §9.2 transition table.
    /// Returns true iff `from -> to` is permitted. Terminal states accept NO
    /// transitions whatsoever — the record is sealed. A retry is a NEW attempt
    /// (new `attemptID` + new `runID`) on the same `taskID`, not a transition
    /// on an existing terminal record.
    public static func canTransition(from: DurableTaskState, to: DurableTaskState) -> Bool {
        if from.isTerminal { return false }
        if from == to { return true }             // idempotent re-entry for non-terminal states
        switch (from, to) {
        case (.queued, .running),
             (.queued, .cancelled):
            return true
        case (.running, .waitingForTool),
             (.running, .waitingForApproval),
             (.running, .waitingForUserInput),
             (.running, .waitingForRetry),
             (.running, .paused),
             (.running, .interrupted),
             (.running, .completed),
             (.running, .failed),
             (.running, .cancelled),
             (.running, .queued):
            return true
        case (.waitingForTool, .running),
             (.waitingForTool, .failed),
             (.waitingForTool, .cancelled),
             (.waitingForTool, .interrupted):
            return true
        case (.waitingForApproval, .running),
             (.waitingForApproval, .failed),
             (.waitingForApproval, .cancelled),
             (.waitingForApproval, .interrupted):
            return true
        case (.waitingForUserInput, .running),
             (.waitingForUserInput, .failed),
             (.waitingForUserInput, .cancelled),
             (.waitingForUserInput, .interrupted):
            return true
        case (.waitingForRetry, .queued),
             (.waitingForRetry, .running),
             (.waitingForRetry, .failed),
             (.waitingForRetry, .cancelled),
             (.waitingForRetry, .interrupted):
            return true
        case (.paused, .running),
             (.paused, .cancelled),
             (.paused, .interrupted):
            return true
        case (.interrupted, .running),
             (.interrupted, .failed),
             (.interrupted, .cancelled),
             (.interrupted, .queued):
            return true
        default:
            return false
        }
    }

    /// Apply the transition if legal; otherwise returns nil. Caller MUST
    /// check the optional and emit a `RuntimeAuditKind.invalidTransition`
    /// audit event when the transition is rejected.
    public static func transition(from: DurableTaskState,
                                  to: DurableTaskState) -> DurableTaskState? {
        canTransition(from: from, to: to) ? to : nil
    }

    // MARK: - Mapping from existing in-codebase enums

    /// Translate `AgentTaskSchedulerStatus` into the unified state.
    public init(scheduler: AgentTaskSchedulerStatus) {
        switch scheduler {
        case .queued: self = .queued
        case .running: self = .running
        case .waitingForResource, .waitingForPermission: self = .waitingForTool
        case .waitingForUser: self = .waitingForUserInput
        case .pauseRequested, .paused: self = .paused
        case .interrupted: self = .interrupted
        case .succeeded: self = .completed
        case .failed: self = .failed
        case .cancelled: self = .cancelled
        }
    }

    /// Translate `AgentTaskStatus` (event-driven activity state) into the
    /// unified state.
    public init(activity: AgentTaskStatus) {
        switch activity {
        case .created, .queued: self = .queued
        case .planning, .running: self = .running
        case .waitingForApproval: self = .waitingForApproval
        case .waitingForPermission: self = .waitingForTool
        case .waitingForUser: self = .waitingForUserInput
        case .synthesizing: self = .running
        case .paused: self = .paused
        case .partiallySucceeded, .succeeded: self = .completed
        case .failed: self = .failed
        case .cancelled: self = .cancelled
        case .interrupted: self = .interrupted
        case .unknown: self = .unknown
        }
    }

    /// Best-effort inverse: a unified state does not have a 1:1 mapping
    /// back to AgentTaskSchedulerStatus (which has more cases). Provided
    /// for `AgentTaskScheduler.finishFromRuntime(...)` callers.
    public var schedulerStatus: AgentTaskSchedulerStatus {
        switch self {
        case .queued: return .queued
        case .running: return .running
        case .waitingForTool: return .waitingForResource
        case .waitingForApproval: return .waitingForPermission
        case .waitingForUserInput: return .waitingForUser
        case .waitingForRetry: return .waitingForResource
        case .paused: return .paused
        case .interrupted: return .interrupted
        case .completed: return .succeeded
        case .failed: return .failed
        case .cancelled: return .cancelled
        case .unknown: return .queued
        }
    }

    /// P14.1 — Translate the legacy `AgentTaskState` (PetBrainCore) used by
    /// the runtime's existing ledger into the unified durable state. Used
    /// by `PetAgentRuntimeCoordinator` to mirror legacy ledger writes into
    /// `DurableTaskStore` without rewriting the pre-existing record path.
    ///
    /// Conservative: every legacy state maps to a meaningful durable state.
    /// `.draft` / `.preparing` map to `.queued`; `.awaitingApproval` /
    /// `.awaitingUserInput` are distinct; `.awaitingPermission` becomes
    /// `.waitingForTool` (the runtime treats both as waiting-on-something).
    /// `.recovering` becomes `.interrupted`; `.cancelling` becomes
    /// `.interrupted` (the cancellation is not yet finalized).
    public init(legacy: AgentTaskState) {
        switch legacy {
        case .draft, .queued, .preparing: self = .queued
        case .running: self = .running
        case .awaitingApproval: self = .waitingForApproval
        case .awaitingPermission: self = .waitingForTool
        case .awaitingUserInput: self = .waitingForUserInput
        case .paused: self = .paused
        case .cancelling, .recovering: self = .interrupted
        case .succeeded: self = .completed
        case .partiallySucceeded: self = .completed
        case .failed: self = .failed
        case .rolledBack, .cancelled: self = .cancelled
        }
    }
}

// MARK: - Persistent durable task record

/// One durable task. Persists across process restarts. The authoritative
/// record is held in `DurableTaskStore`; this struct is the value type.
public struct DurableTaskRecord: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var taskID: UUID
    public var conversationID: UUID?
    public var goalID: UUID?                  // P14-D: every task is rooted in a Goal
    public var title: String
    public var status: DurableTaskState
    public var createdAt: Date
    public var updatedAt: Date
    public var attemptCount: Int
    public var currentAttemptID: UUID?
    public var lastFailure: DurableFailureRecord?
    public var retryPolicy: AgentRetryPolicy
    public var terminalResultTerminalID: UUID?  // set when status.isTerminal
    public var origin: AgentTaskOrigin?
    /// P14.2 — R-B-F03 closure. The earliest time at which a retry is
    /// eligible. Set when `status` transitions to `.waitingForRetry`;
    /// consulted by `reconcileAfterRestart` to skip tasks whose
    /// deadline has not yet passed.
    public var nextRetryAt: Date?

    public var id: UUID { taskID }

    public init(schemaVersion: Int = 1,
                taskID: UUID,
                conversationID: UUID? = nil,
                goalID: UUID? = nil,
                title: String,
                status: DurableTaskState = .queued,
                createdAt: Date = Date(),
                updatedAt: Date = Date(),
                attemptCount: Int = 0,
                currentAttemptID: UUID? = nil,
                lastFailure: DurableFailureRecord? = nil,
                retryPolicy: AgentRetryPolicy = AgentRetryPolicy(),
                terminalResultTerminalID: UUID? = nil,
                origin: AgentTaskOrigin? = nil,
                nextRetryAt: Date? = nil) {
        self.schemaVersion = max(1, schemaVersion)
        self.taskID = taskID
        self.conversationID = conversationID
        self.goalID = goalID
        self.title = AgentEventRedactor.safeText(title, maxLength: 240)
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.attemptCount = max(0, attemptCount)
        self.currentAttemptID = currentAttemptID
        self.lastFailure = lastFailure
        self.retryPolicy = retryPolicy
        self.terminalResultTerminalID = terminalResultTerminalID
        self.origin = origin
        self.nextRetryAt = nextRetryAt
    }
}

/// Persistent failure record attached to a task. Derived from LlmFailure or
/// runtime-classified failure; never carries raw provider text.
public struct DurableFailureRecord: Codable, Sendable, Hashable {
    public var failureCode: String           // AgentTaskFailureCategory rawValue
                                          // or LlmFailureCode rawValue
    public var llmFailureCode: String?       // optional: LlmFailure.code rawValue
    public var phase: String                 // "scheduler" | "runtime" | "tool"
    public var safeSummary: String           // already-redacted user-safe summary
    public var httpStatus: Int?
    public var endpoint: String?
    public var requestID: String?
    public var providerRetryAfterMs: Int?
    public var occurredAt: Date

    public init(failureCode: String,
                llmFailureCode: String? = nil,
                phase: String = "runtime",
                safeSummary: String,
                httpStatus: Int? = nil,
                endpoint: String? = nil,
                requestID: String? = nil,
                providerRetryAfterMs: Int? = nil,
                occurredAt: Date = Date()) {
        self.failureCode = AgentEventRedactor.safeIdentifier(failureCode)
        self.llmFailureCode = llmFailureCode.map { AgentEventRedactor.safeIdentifier($0) }
        self.phase = AgentEventRedactor.safeIdentifier(phase)
        self.safeSummary = AgentPrivacyRedactor.safeSummary(safeSummary, fallback: failureCode)
        self.httpStatus = httpStatus
        self.endpoint = endpoint
        self.requestID = requestID.map(AgentEventRedactor.safeIdentifier)
        self.providerRetryAfterMs = providerRetryAfterMs
        self.occurredAt = occurredAt
    }

    public init(llmFailure: LlmFailure, phase: String = "provider") {
        self.init(failureCode: llmFailure.code.rawValue,
                  llmFailureCode: llmFailure.code.rawValue,
                  phase: phase,
                  safeSummary: llmFailure.message,
                  httpStatus: llmFailure.httpStatus,
                  endpoint: llmFailure.endpoint,
                  requestID: llmFailure.requestID,
                  providerRetryAfterMs: llmFailure.providerRetryAfterMs)
    }
}

// MARK: - Persistent attempt record

public struct DurableAttemptRecord: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var attemptID: UUID
    public var taskID: UUID
    public var runID: UUID
    public var startedAt: Date
    public var endedAt: Date?
    public var terminalStatus: DurableTaskState?    // set on terminalization
    public var failure: DurableFailureRecord?
    public var checkpointPath: String?              // relative path under durable base

    public var id: UUID { attemptID }

    public init(schemaVersion: Int = 1,
                attemptID: UUID,
                taskID: UUID,
                runID: UUID,
                startedAt: Date = Date(),
                endedAt: Date? = nil,
                terminalStatus: DurableTaskState? = nil,
                failure: DurableFailureRecord? = nil,
                checkpointPath: String? = nil) {
        self.schemaVersion = max(1, schemaVersion)
        self.attemptID = attemptID
        self.taskID = taskID
        self.runID = runID
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.terminalStatus = terminalStatus
        self.failure = failure
        self.checkpointPath = checkpointPath
    }

    public var isTerminal: Bool { terminalStatus?.isTerminal == true }
}
