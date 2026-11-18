import Foundation

/// Append-only event ledger (doc §13.8). Used for crash recovery, audit, state rebuild, and
/// idempotency (doc §13.9) — a side-effecting op runs at most once even across a runtime restart.
public struct LedgerEntry: Sendable, Equatable {
    public var seq: Int
    public var event: AgentTaskEvent
    public var operationID: String?
    public var timestamp: Date
}

public struct TaskLedger: Sendable {
    public private(set) var entries: [LedgerEntry] = []
    public init() {}

    public mutating func append(_ event: AgentTaskEvent, operationID: String? = nil, now: Date = Date()) {
        entries.append(LedgerEntry(seq: entries.count, event: event, operationID: operationID, timestamp: now))
    }

    /// Idempotency check (doc §13.9): has this side-effecting op already been recorded?
    public func hasOperation(_ id: String) -> Bool {
        entries.contains { $0.operationID == id }
    }

    /// Rebuild current state from the ledger (crash recovery / state reconstruction).
    public func rebuiltState() -> AgentTaskState? {
        for entry in entries.reversed() {
            if case .stateChanged(let s) = entry.event { return s }
        }
        return nil
    }
}

/// Drives one AgentTask: enforces valid transitions, records every event in the ledger, dedupes
/// side-effecting operations, and supports pause/cancel/recover (doc §13.6). Pure mutating struct —
/// the native runtime is the event source that calls `ingest`.
public struct AgentTaskCoordinator: Sendable {
    public let definition: AgentTaskDefinition
    public private(set) var state: AgentTaskState = .draft
    public private(set) var ledger = TaskLedger()
    public private(set) var partial = false

    public init(definition: AgentTaskDefinition) { self.definition = definition }

    public enum IngestResult: Sendable, Equatable {
        case applied
        case ignoredDuplicate          // idempotency hit
        case rejectedTransition(from: AgentTaskState, to: AgentTaskState)
    }

    /// Apply an event from the runtime. State-changing events are validated; side-effecting events
    /// with a known operationID are ignored (already done).
    @discardableResult
    public mutating func ingest(_ event: AgentTaskEvent, now: Date = Date()) -> IngestResult {
        switch event {
        case .stateChanged(let to):
            guard AgentTaskMachine.canTransition(from: state, to: to) else {
                return .rejectedTransition(from: state, to: to)
            }
            state = to
            if to == .partiallySucceeded { partial = true }
            ledger.append(event, now: now)
            return .applied

        case .fileChangeProposed(_, let operationID):
            if ledger.hasOperation(operationID) { return .ignoredDuplicate }
            ledger.append(event, operationID: operationID, now: now)
            return .applied

        default:
            ledger.append(event, now: now)
            return .applied
        }
    }

    // Explicit controls (doc §13.6) — request transitions, validated by the machine.

    @discardableResult public mutating func start(now: Date = Date()) -> IngestResult { ingest(.stateChanged(.awaitingApproval), now: now) }
    @discardableResult public mutating func approve(now: Date = Date()) -> IngestResult { ingest(.stateChanged(.queued), now: now) }
    @discardableResult public mutating func pause(now: Date = Date()) -> IngestResult { ingest(.stateChanged(.paused), now: now) }
    @discardableResult public mutating func resume(now: Date = Date()) -> IngestResult { ingest(.stateChanged(.running), now: now) }

    /// Cancel: enter cancelling, then settle to rolledBack (if the definition rolls back) or cancelled.
    @discardableResult
    public mutating func cancel(now: Date = Date()) -> IngestResult {
        let r = ingest(.stateChanged(.cancelling), now: now)
        guard r == .applied else { return r }
        return ingest(.stateChanged(definition.rollbackOnCancel ? .rolledBack : .cancelled), now: now)
    }

    /// Recover after a runtime crash: rebuild from the ledger, then re-enter recovering→running.
    @discardableResult
    public mutating func recover(now: Date = Date()) -> IngestResult {
        if let rebuilt = ledger.rebuiltState() { state = rebuilt }
        guard !state.isTerminal else { return .rejectedTransition(from: state, to: .recovering) }
        return ingest(.stateChanged(.recovering), now: now)
    }
}
