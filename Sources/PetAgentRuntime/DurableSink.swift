import Foundation
import AICore
import PetBrainCore

// MARK: - Durable sink (single seam for the coordinator's durability
// surface).
//
// The coordinator calls four helpers for durable persistence:
// `record(...)`, `mirrorDurable(...)`, `appendInbox(...)`,
// `recordAudit(...)`. Each helper duplicates the same private-task dye
// (doc §12.4 私密会话隔离) and the same nil-store guard. `DurableSink`
// is the one seam that owns both, so a future write path can't accidentally
// skip them — a sink test pins the contract, the coordinator stays an
// actor with a single injected dependency.
//
// All members are `async` so a future swap to an async backend (e.g. a
// file-backed queue) needs no signature change. Errors surface via the
// actor's existing observable-persistence channel; this protocol does
// not introduce a new failure mode.

public protocol DurableSink: Sendable {
    /// Append a single ledger entry. Returns silently on private/no-op/no-store.
    func record(_ event: AgentTaskLedgerEvent) async throws
    /// Mirror a legacy state transition into the durable task kernel. No-op
    /// for private tasks (doc §12.4) and when the kernel is not injected.
    func mirrorDurable(taskID: UUID,
                        attemptID: UUID,
                        legacyState: AgentTaskState,
                        title: String,
                        failure: DurableFailureRecord?,
                        conversationID: UUID?) async
    /// Append an inbox event. No-op for private tasks and when no inbox is wired.
    func appendInbox(_ event: InboxEvent) async
    /// Append an audit entry. No-op for private tasks and when no audit is wired.
    func recordAudit(_ event: RuntimeAuditEvent) async
}

/// Default production sink — composes the four existing fields
/// (`durableTaskStore`, `durableInboxStore`, `durableAuditLogStore`,
/// `ledger`) with the private-task dye set the coordinator owns.
///
/// `privateTaskIDs` is taken as a `@Sendable () -> Set<UUID>` so the sink
/// reads the current set on every call without taking a snapshot at
/// construction time (the set is mutated by `dyeFrom`).
public struct CoordinatedDurableSink: DurableSink {
    public var ledger: AgentTaskLedgerPersisting
    public var durableTaskStore: DurableTaskStore?
    public var durableInboxStore: DurableInboxStore?
    public var durableAuditLogStore: DurableAuditLogStore?
    public var privateTaskIDs: @Sendable () -> Set<UUID>

    public init(ledger: AgentTaskLedgerPersisting,
                durableTaskStore: DurableTaskStore? = nil,
                durableInboxStore: DurableInboxStore? = nil,
                durableAuditLogStore: DurableAuditLogStore? = nil,
                privateTaskIDs: @Sendable @escaping () -> Set<UUID>) {
        self.ledger = ledger
        self.durableTaskStore = durableTaskStore
        self.durableInboxStore = durableInboxStore
        self.durableAuditLogStore = durableAuditLogStore
        self.privateTaskIDs = privateTaskIDs
    }

    public func record(_ event: AgentTaskLedgerEvent) async throws {
        guard !privateTaskIDs().contains(event.taskID) else { return }
        try await ledger.append(event)
    }

    public func mirrorDurable(taskID: UUID,
                        attemptID: UUID,
                        legacyState: AgentTaskState,
                        title: String,
                        failure: DurableFailureRecord?,
                        conversationID: UUID?) async {
        guard !privateTaskIDs().contains(taskID) else { return }
        guard let store = durableTaskStore else { return }
        let durable = DurableTaskState(legacy: legacyState)
        if await store.task(id: taskID) == nil {
            let record = DurableTaskRecord(taskID: taskID,
                                          conversationID: conversationID,
                                          title: title,
                                          status: durable,
                                          retryPolicy: AgentRetryPolicy(),
                                          origin: nil)
            await store.upsert(record)
        } else {
            let applied = await store.applyTransition(taskID: taskID, to: durable, failure: failure)
            if applied == nil, let audit = durableAuditLogStore {
                let current = await store.task(id: taskID)
                await audit.record(RuntimeAuditEvent(kind: .invalidTransition,
                                                     correlationID: taskID,
                                                     summary: "rejected legacy=\(legacyState.rawValue) current=\(current?.status.rawValue ?? "?")",
                                                     timestamp: Date()))
            }
        }
        if await store.attempt(id: attemptID) == nil {
            _ = await store.recordNewAttempt(taskID: taskID,
                                             attemptID: attemptID,
                                             runID: attemptID)
        }
        if let audit = durableAuditLogStore {
            await audit.record(RuntimeAuditEvent(kind: .errorRecovery,
                                                 correlationID: taskID,
                                                 summary: "legacy=(legacyState.rawValue) durable=(durable.rawValue)",
                                                 timestamp: Date()))
        }
    }

    public func appendInbox(_ event: InboxEvent) async {
        guard !privateTaskIDs().contains(event.taskID) else { return }
        guard let inbox = durableInboxStore else { return }
        await inbox.appendIfNew(event)
    }

    public func recordAudit(_ event: RuntimeAuditEvent) async {
        if let taskID = event.correlationID, privateTaskIDs().contains(taskID) { return }
        guard let audit = durableAuditLogStore else { return }
        await audit.record(event)
    }
}

/// Test seam: a sink that records every call so tests can pin the
/// privacy gate and the round-trip of payloads. Thread-safe via a lock
/// inside the actor boundary (the test code awaits each call).
actor RecordingDurableSink: DurableSink {
    private(set) var recorded: [AgentTaskLedgerEvent] = []
    private(set) var mirrored: [(taskID: UUID, legacyState: AgentTaskState, title: String)] = []
    private(set) var inboxed: [InboxEvent] = []
    private(set) var audited: [RuntimeAuditEvent] = []
    /// Privacy dye (test seam): taskIDs marked private must take no-op
    /// across every method. Tests call `markPrivate(taskID:)` to mirror the
    /// coordinator's `dyeFrom`. The set is per-actor; callers `await`.
    private var privateTaskIDs = Set<UUID>()
    /// When true, every method is a no-op (mirrors the actor's no-store
    /// guard). Tests flip this to verify the seam still works without
    /// backing storage.
    var offline: Bool = false

    public func markPrivate(taskID: UUID) { privateTaskIDs.insert(taskID) }
    public func clearPrivate(taskID: UUID) { privateTaskIDs.remove(taskID) }
    public func isPrivate(taskID: UUID) -> Bool { privateTaskIDs.contains(taskID) }

    public func record(_ event: AgentTaskLedgerEvent) async throws {
        guard !offline, !privateTaskIDs.contains(event.taskID) else { return }
        recorded.append(event)
    }

    public func mirrorDurable(taskID: UUID,
                        attemptID: UUID,
                        legacyState: AgentTaskState,
                        title: String,
                        failure: DurableFailureRecord?,
                        conversationID: UUID?) async {
        guard !offline, !privateTaskIDs.contains(taskID) else { return }
        mirrored.append((taskID, legacyState, title))
    }

    public func appendInbox(_ event: InboxEvent) async {
        guard !offline, !privateTaskIDs.contains(event.taskID) else { return }
        inboxed.append(event)
    }

    public func recordAudit(_ event: RuntimeAuditEvent) async {
        guard !offline else { return }
        if let taskID = event.correlationID, privateTaskIDs.contains(taskID) { return }
        audited.append(event)
    }
}