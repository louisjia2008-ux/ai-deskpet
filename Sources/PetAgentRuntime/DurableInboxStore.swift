import Foundation
import AICore

// P14-H — Durable Inbox.
//
// A local at-least-once event queue for task continuation. Survives restart.
// Consumers process events one at a time, advancing the task checkpoint
// atomically. Duplicate `eventID`s are idempotent.
//
// Use cases covered (per §15.1): userReply, approvalDecision, toolResult,
// retryWakeup, systemRecoveryNotice, taskSignal.

public enum InboxEventKind: String, Codable, Sendable, Hashable, CaseIterable {
    case userReply
    case approvalDecision
    case approvalDecisionRequested
    case toolResult
    case retryWakeup
    case systemRecoveryNotice
    case taskSignal
}

public struct InboxEvent: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var eventID: UUID
    public var taskID: UUID
    public var kind: InboxEventKind
    public var createdAt: Date
    public var payload: AgentJSONValue
    public var consumedAt: Date?
    public var consumedByAttemptID: UUID?

    public var id: UUID { eventID }

    public init(schemaVersion: Int = 1,
                eventID: UUID = UUID(),
                taskID: UUID,
                kind: InboxEventKind,
                payload: AgentJSONValue = .null,
                createdAt: Date = Date(),
                consumedAt: Date? = nil,
                consumedByAttemptID: UUID? = nil) {
        self.schemaVersion = max(1, schemaVersion)
        self.eventID = eventID
        self.taskID = taskID
        self.kind = kind
        self.payload = payload
        self.createdAt = createdAt
        self.consumedAt = consumedAt
        self.consumedByAttemptID = consumedByAttemptID
    }
}

public actor DurableInboxStore {
    private let baseDirectory: URL
    private let fileManager: FileManager
    private let clock: @Sendable () -> Date
    /// In-memory event log, ordered by `createdAt`. Persisted to JSONL.
    private var events: [InboxEvent] = []
    private var consumedIDs: Set<UUID> = []

    public init(baseDirectory: URL,
                clock: @escaping @Sendable () -> Date = { Date() },
                fileManager: FileManager = .default) {
        self.baseDirectory = baseDirectory
        self.fileManager = fileManager
        self.clock = clock
    }

    public static func defaultStore() -> DurableInboxStore {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("DurableInbox.jsonl")
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("DeskPet-DurableInbox.jsonl")
        return DurableInboxStore(baseDirectory: base)
    }

    public func load() async {
        guard let data = try? Data(contentsOf: baseDirectory) else { return }
        try? fileManager.createDirectory(at: baseDirectory.deletingLastPathComponent(),
                                        withIntermediateDirectories: true)
        for line in data.split(separator: 0x0A) where !line.isEmpty {
            // D3: sealed lines decrypt when keyed; legacy lines pass through.
            guard let plain = try? SealedStore.openLine(Data(line)),
                  let event = try? Self.decoder.decode(InboxEvent.self, from: plain) else {
                continue
            }
            events.append(event)
            if event.consumedAt != nil { consumedIDs.insert(event.eventID) }
        }
        events.sort { $0.createdAt < $1.createdAt }
    }

    public func append(_ event: InboxEvent) async {
        events.append(event)
        await rewriteLog()
    }

    /// Idempotent: a duplicate eventID is silently dropped. Returns true if
    /// the event was newly appended; false if it was a duplicate.
    @discardableResult
    public func appendIfNew(_ event: InboxEvent) async -> Bool {
        if consumedIDs.contains(event.eventID) { return false }
        if events.contains(where: { $0.eventID == event.eventID }) { return false }
        await append(event)
        return true
    }

    public func unconsumedEvents(forTask taskID: UUID) async -> [InboxEvent] {
        events.filter { $0.taskID == taskID && $0.consumedAt == nil }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func consume(eventID: UUID, attemptID: UUID) async {
        guard let idx = events.firstIndex(where: { $0.eventID == eventID }) else { return }
        guard events[idx].consumedAt == nil else { return }
        events[idx].consumedAt = clock()
        events[idx].consumedByAttemptID = attemptID
        consumedIDs.insert(eventID)
        await rewriteLog()
    }

    public func consumeAll(forTask taskID: UUID, attemptID: UUID) async {
        for idx in events.indices where events[idx].taskID == taskID && events[idx].consumedAt == nil {
            events[idx].consumedAt = clock()
            events[idx].consumedByAttemptID = attemptID
            consumedIDs.insert(events[idx].eventID)
        }
        await rewriteLog()
    }

    private func rewriteLog() async {
        try? fileManager.createDirectory(at: baseDirectory.deletingLastPathComponent(),
                                        withIntermediateDirectories: true)
        var blob = Data()
        for event in events {
            if let line = try? Self.encoder.encode(event) {
                guard let protected = try? SealedStore.sealLine(line) else {
                    return
                }
                blob.append(protected)
                blob.append(Data([0x0A]))
            }
        }
        try? blob.write(to: baseDirectory, options: [.atomic])
    }

    public func allEvents() -> [InboxEvent] { events }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
