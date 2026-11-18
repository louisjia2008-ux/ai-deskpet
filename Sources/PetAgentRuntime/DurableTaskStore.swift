import Foundation
import AICore

// P14-C — Durable Task / Attempt persistence.
//
// `DurableTaskStore` persists `DurableTaskRecord` and `DurableAttemptRecord`
// to disk with atomic-write semantics and forward-compatible schema versioning.
// On launch a new `PetAgentRuntimeCoordinator` constructs this store and
// loads every persisted task. Recovery classification (§8.1, P14-G) walks
// the loaded records and emits a recovery plan.
//
// Filesystem layout (one file per record):
//   <baseDirectory>/tasks/<taskID>.json
//   <baseDirectory>/attempts/<attemptID>.json
//   <baseDirectory>/index.json (taskID → path + lastUpdatedAt for fast scan)
//
// Atomic write: temp file + `FileManager.replaceItemAt` for POSIX atomic
// replacement (same pattern as `AgentCheckpointStore.atomicWrite`).

public actor DurableTaskStore {
    private let baseDirectory: URL
    private let tasksDirectory: URL
    private let attemptsDirectory: URL
    private let indexURL: URL
    private let clock: @Sendable () -> Date
    private let fileManager: FileManager

    /// In-memory cache; loaded from disk on init, persisted on every write.
    private var tasks: [UUID: DurableTaskRecord] = [:]
    private var attempts: [UUID: DurableAttemptRecord] = [:]
    /// taskID → ordered attempt IDs
    private var attemptOrder: [UUID: [UUID]] = [:]

    // P18.6 #1 — durability observability. Every `persist` that throws is
    // captured here (counter + last error). The kernel exposes these via
    // `persistHealth` so the supervisor / runtime UI can surface a "degraded
    // durability" state instead of silently relying on next-launch
    // reconciliation. Failures are kept in memory only — they reset across
    // process restarts by design.
    private var persistFailureCount: Int = 0
    private var lastPersistFailure: DurablePersistFailure?

    public init(baseDirectory: URL,
                clock: @escaping @Sendable () -> Date = { Date() },
                fileManager: FileManager = .default) {
        self.baseDirectory = baseDirectory
        self.tasksDirectory = baseDirectory.appendingPathComponent("tasks", isDirectory: true)
        self.attemptsDirectory = baseDirectory.appendingPathComponent("attempts", isDirectory: true)
        self.indexURL = baseDirectory.appendingPathComponent("index.json")
        self.clock = clock
        self.fileManager = fileManager
    }

    public static func defaultStore() -> DurableTaskStore {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("DeskPet", isDirectory: true)
            .appendingPathComponent("DurableTasks", isDirectory: true)
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("DeskPet-DurableTasks", isDirectory: true)
        return DurableTaskStore(baseDirectory: base)
    }

    /// Load every persisted task into memory. Called on Runtime startup.
    /// Errors on individual files are logged but do not abort load.
    public func load() async {
        try? fileManager.createDirectory(at: tasksDirectory, withIntermediateDirectories: true)
        try? fileManager.createDirectory(at: attemptsDirectory, withIntermediateDirectories: true)
        // Tasks (D3: sealed-aware read — keyless-sealed files skipped, kept).
        if let entries = try? fileManager.contentsOfDirectory(at: tasksDirectory,
                                                               includingPropertiesForKeys: nil) {
            for url in entries where url.pathExtension == "json" {
                guard let data = try? Data(contentsOf: url),
                      let plain = try? SealedStore.openForRead(data),
                      let record = try? Self.decoder.decode(DurableTaskRecord.self, from: plain) else {
                    continue
                }
                tasks[record.taskID] = record
            }
        }
        // Attempts (D3: same sealed-aware read).
        if let entries = try? fileManager.contentsOfDirectory(at: attemptsDirectory,
                                                               includingPropertiesForKeys: nil) {
            for url in entries where url.pathExtension == "json" {
                guard let data = try? Data(contentsOf: url),
                      let plain = try? SealedStore.openForRead(data),
                      let record = try? Self.decoder.decode(DurableAttemptRecord.self, from: plain) else {
                    continue
                }
                // Dedup: skip if this attemptID is already loaded.
                if attempts[record.attemptID] != nil { continue }
                attempts[record.attemptID] = record
                var order = attemptOrder[record.taskID, default: []]
                order.append(record.attemptID)
                attemptOrder[record.taskID] = order
            }
        }
    }

    // MARK: - CRUD

    public func upsert(_ record: DurableTaskRecord) async {
        tasks[record.taskID] = record
        await persist(record)
    }

    public func upsert(_ attempt: DurableAttemptRecord) async {
        attempts[attempt.attemptID] = attempt
        var order = attemptOrder[attempt.taskID, default: []]
        order.append(attempt.attemptID)
        attemptOrder[attempt.taskID] = order
        await persist(attempt)
    }

    public func task(id: UUID) -> DurableTaskRecord? { tasks[id] }
    public func attempt(id: UUID) -> DurableAttemptRecord? { attempts[id] }
    public func allTasks() -> [DurableTaskRecord] {
        tasks.values.sorted { $0.createdAt < $1.createdAt }
    }
    public func attempts(forTask taskID: UUID) -> [DurableAttemptRecord] {
        (attemptOrder[taskID] ?? []).compactMap { attempts[$0] }
            .sorted { $0.startedAt < $1.startedAt }
    }

    public func nonTerminalTasks() -> [DurableTaskRecord] {
        allTasks().filter { !$0.status.isTerminal }
    }

    // MARK: - Transition application

    /// Apply a transition to the persisted task record. Persists on success.
    /// Returns the new record if the transition is legal; nil otherwise.
    /// Illegal transitions are recorded but do NOT mutate the record.
    @discardableResult
    public func applyTransition(taskID: UUID,
                                to newStatus: DurableTaskState,
                                failure: DurableFailureRecord? = nil,
                                nextRetryAt: Date? = nil) async -> DurableTaskRecord? {
        guard var record = tasks[taskID] else { return nil }
        guard DurableTaskState.canTransition(from: record.status, to: newStatus) else {
            return nil
        }
        record.status = newStatus
        record.updatedAt = clock()
        if let failure {
            record.lastFailure = failure
        }
        if let nextRetryAt {
            record.nextRetryAt = nextRetryAt
        } else if newStatus == .waitingForRetry {
            // Default: clear the deadline when transitioning into
            // `.waitingForRetry` without an explicit value (caller
            // should supply one).
            record.nextRetryAt = nil
        }
        if newStatus.isTerminal {
            record.terminalResultTerminalID = record.terminalResultTerminalID ?? UUID()
        }
        tasks[taskID] = record
        await persist(record)
        return record
    }

    /// Bump attempt count and set the current attempt id. Does NOT itself
    /// transition state; caller pairs this with `applyTransition`.
    /// Terminal-state guard: refuses to mutate attempt history on a task
    /// that has already reached `.completed` / `.failed` / `.cancelled`.
    /// A retry is a NEW task, not a new attempt on a terminal task.
    public func recordNewAttempt(taskID: UUID, attemptID: UUID, runID: UUID) async -> DurableAttemptRecord? {
        guard let existing = tasks[taskID] else { return nil }
        guard !existing.status.isTerminal else { return nil }
        // Idempotency: an attemptID that is already in the order list is a
        // duplicate and must not inflate the history (R-A-11).
        let orderForTask = attemptOrder[taskID, default: []]
        if orderForTask.contains(attemptID) {
            return attempts[attemptID]
        }
        let attempt = DurableAttemptRecord(attemptID: attemptID,
                                           taskID: taskID,
                                           runID: runID,
                                           startedAt: clock())
        var record = existing
        record.attemptCount += 1
        record.currentAttemptID = attemptID
        record.updatedAt = clock()
        tasks[taskID] = record
        await persist(record)
        attempts[attemptID] = attempt
        var order = attemptOrder[taskID, default: []]
        order.append(attemptID)
        attemptOrder[taskID] = order
        await persist(attempt)
        return attempt
    }

    // MARK: - Atomic write helpers

    private func persist(_ record: DurableTaskRecord) async {
        let url = tasksDirectory.appendingPathComponent("\(record.taskID.uuidString).json")
        let fm = fileManager
        do {
            // D3: sealed when keyed (keyless-sealed overwrite refused).
            let data = try SealedStore.sealForWrite(Self.encoder.encode(record), url: url)
            try Self.atomicWriteData(data, to: url, fileManager: fm)
        } catch {
            // P18.6 #1 — surface the failure so the supervisor can observe
            // a degraded durability state instead of silently relying on
            // next-launch reconciliation.
            recordPersistFailure(.init(kind: .task, recordID: record.taskID, error: error))
        }
    }

    private func persist(_ record: DurableAttemptRecord) async {
        let url = attemptsDirectory.appendingPathComponent("\(record.attemptID.uuidString).json")
        let fm = fileManager
        do {
            // D3: sealed when keyed (keyless-sealed overwrite refused).
            let data = try SealedStore.sealForWrite(Self.encoder.encode(record), url: url)
            try Self.atomicWriteData(data, to: url, fileManager: fm)
        } catch {
            recordPersistFailure(.init(kind: .attempt, recordID: record.attemptID, error: error))
        }
    }

    // MARK: - P18.6 #1 durability observability

    /// Latest durability snapshot. Cheap to read (actor-isolated counter +
    /// single optional). Callers can poll or hold the value to drive a
    /// settings-banner / runtime status indicator.
    public var persistHealth: DurablePersistHealth {
        DurablePersistHealth(failureCount: persistFailureCount,
                             lastFailure: lastPersistFailure)
    }

    private func recordPersistFailure(_ failure: DurablePersistFailure) {
        persistFailureCount += 1
        lastPersistFailure = failure
        // Best-effort signal — not a real logger to avoid taking a dep here.
        // The kernel / coordinator can re-read `persistHealth` to surface
        // the same data in observability surfaces.
    }

    private static func atomicWriteData(_ data: Data,
                                        to url: URL,
                                        fileManager: FileManager) throws {
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(".tmp-\(UUID().uuidString)")
        try data.write(to: tmp, options: [.atomic])
        if fileManager.fileExists(atPath: url.path) {
            _ = try fileManager.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fileManager.moveItem(at: tmp, to: url)
        }
    }

    // MARK: - Codable plumbing

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}

// MARK: - P18.6 #1 durability types

/// Kinds of persisted record whose durability may be degraded.
public enum DurablePersistFailureKind: String, Sendable, Codable, Equatable {
    case task
    case attempt
}

/// One persisted-record failure (the most recent one). Error is captured
/// as a `String` description to keep the snapshot `Sendable` and avoid
/// retaining arbitrary `(any Error)` across actor hops.
public struct DurablePersistFailure: Sendable, Codable, Equatable {
    public let kind: DurablePersistFailureKind
    public let recordID: UUID
    public let errorDescription: String

    init(kind: DurablePersistFailureKind, recordID: UUID, error: Error) {
        self.kind = kind
        self.recordID = recordID
        self.errorDescription = String(describing: error)
    }
}

/// Snapshot of the store's durability health. `failureCount > 0` indicates
/// at least one write failed since process start; `lastFailure` carries the
/// most recent one for display in settings / runtime observability.
public struct DurablePersistHealth: Sendable, Equatable {
    public let failureCount: Int
    public let lastFailure: DurablePersistFailure?

    public var isDegraded: Bool { failureCount > 0 }
}
