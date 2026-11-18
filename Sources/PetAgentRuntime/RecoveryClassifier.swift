import Foundation
import AICore

// P14-G — Recovery classification.
//
// On Runtime B launch (after Runtime A was killed), this service walks every
// persisted DurableTaskRecord and decides what to do:
//   - `.completed` / `.failed` / `.cancelled` → leave alone (terminal).
//   - `.running` with no recent attempt checkpoint → mark `.interrupted`.
//   - `.waitingForApproval` / `.waitingForUserInput` / `.waitingForTool` →
//     leave the task in the same non-terminal state (it can be resumed by
//     the user / scheduler / runtime when the missing input arrives).
//   - `.interrupted` → leave as-is (recovery will resume it).
//   - `.waitingForRetry` with `nextRetryAt` in the future → leave as-is.
//
// The classification is read-only against the durable store — it does not
// silently resume destructive side effects. The runtime drives resume by
// consulting the durable state on startup.

public struct RecoveryClassification: Sendable, Equatable, Hashable {
    public var taskID: UUID
    public var action: Action
    public var reason: String

    public enum Action: String, Codable, Sendable, Hashable {
        case leaveUnchanged
        case markInterrupted
        case waitingForApprovalSurvives
        case waitingForUserInputSurvives
        case waitingForToolSurvives
        case waitingForRetrySurvives
        case unknownStateReviewRequired
    }
}

public actor RecoveryClassifier {
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

    public func classify(_ record: DurableTaskRecord) -> RecoveryClassification {
        let reason = "task observed in non-terminal state on launch"
        switch record.status {
        case .completed, .failed, .cancelled:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .leaveUnchanged,
                                          reason: "terminal state survives restart")
        case .running:
            // Active at the time of crash — mark interrupted so the runtime
            // can attempt a controlled resume.
            return RecoveryClassification(taskID: record.taskID,
                                          action: .markInterrupted,
                                          reason: "active run interrupted by process exit")
        case .waitingForApproval:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .waitingForApprovalSurvives,
                                          reason: reason)
        case .waitingForUserInput:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .waitingForUserInputSurvives,
                                          reason: reason)
        case .waitingForTool:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .waitingForToolSurvives,
                                          reason: reason)
        case .waitingForRetry:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .waitingForRetrySurvives,
                                          reason: reason)
        case .paused, .interrupted:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .leaveUnchanged,
                                          reason: "non-running paused/interrupted survives")
        case .queued:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .leaveUnchanged,
                                          reason: "queued survives; runtime will start it")
        case .unknown:
            return RecoveryClassification(taskID: record.taskID,
                                          action: .unknownStateReviewRequired,
                                          reason: "decoded as unknown; manual review required")
        }
    }

    public func classifyAll(_ records: [DurableTaskRecord]) async -> [RecoveryClassification] {
        records.map { classify($0) }
    }
}
