import Foundation
import AICore

public enum AgentTaskPriority: Int, Codable, Sendable, Hashable, CaseIterable, Comparable {
    case background = 0
    case normal = 10
    case high = 20
    case userInteractive = 30

    public static func < (lhs: AgentTaskPriority, rhs: AgentTaskPriority) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public enum AgentTaskSchedulerStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case queued
    case running
    case waitingForResource
    case waitingForPermission
    case pauseRequested
    case paused
    case succeeded
    case failed
    case cancelled
    case interrupted
    case waitingForUser

    public var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .cancelled:
            return true
        case .queued, .running, .waitingForResource, .waitingForPermission, .pauseRequested,
             .paused, .interrupted, .waitingForUser:
            return false
        }
    }
}

public struct AgentResourceKey: Codable, Sendable, Hashable, Comparable, CustomStringConvertible {
    public var namespace: String
    public var identifier: String

    public var description: String { "\(namespace):\(identifier)" }

    public init(namespace: String, identifier: String = "default") {
        self.namespace = AgentEventRedactor.safeIdentifier(namespace)
        self.identifier = AgentEventRedactor.safeIdentifier(identifier)
    }

    public static func < (lhs: AgentResourceKey, rhs: AgentResourceKey) -> Bool {
        lhs.description < rhs.description
    }

    public static func file(_ path: String) -> AgentResourceKey {
        AgentResourceKey(namespace: "file", identifier: AgentEventRedactor.safeText(path, maxLength: 180))
    }

    public static let calendar = AgentResourceKey(namespace: "calendar")
    public static let mail = AgentResourceKey(namespace: "mail")
    public static let contacts = AgentResourceKey(namespace: "contacts")
    public static let terminal = AgentResourceKey(namespace: "terminal")

    public static func provider(_ id: String) -> AgentResourceKey {
        AgentResourceKey(namespace: "provider", identifier: id)
    }

    public static func keychain(providerID: UUID) -> AgentResourceKey {
        AgentResourceKey(namespace: "keychain", identifier: providerID.uuidString)
    }

    public static func git(repoPath: String) -> AgentResourceKey {
        AgentResourceKey(namespace: "git", identifier: AgentEventRedactor.safeText(repoPath, maxLength: 180))
    }
}

public enum AgentResourceAccessMode: String, Codable, Sendable, Hashable {
    case read
    case write
}

public struct AgentResourceRequirement: Codable, Sendable, Hashable {
    public var key: AgentResourceKey
    public var mode: AgentResourceAccessMode

    public init(key: AgentResourceKey, mode: AgentResourceAccessMode) {
        self.key = key
        self.mode = mode
    }
}

public enum ToolIdempotency: String, Codable, Sendable, Hashable, CaseIterable {
    case idempotent
    case conditionallyIdempotent
    case nonIdempotent
}

public enum ToolSideEffectLevel: String, Codable, Sendable, Hashable, CaseIterable {
    case none
    case localRead
    case localWrite
    case externalWrite
    case destructive
}

public enum ToolCancellability: String, Codable, Sendable, Hashable, CaseIterable {
    case cooperative
    case safeBoundaryOnly
    case notCancellable
}

public enum ToolResumability: String, Codable, Sendable, Hashable, CaseIterable {
    case resumable
    case restartFromBeginning
    case notResumable
}

public struct AgentToolExecutionSemantics: Codable, Sendable, Hashable {
    public var idempotency: ToolIdempotency
    public var sideEffectLevel: ToolSideEffectLevel
    public var cancellability: ToolCancellability
    public var resumability: ToolResumability
    public var resourceAccess: [AgentResourceRequirement]
    public var expectedDuration: TimeInterval?
    public var requiresForeground: Bool
    public var requiresUserConfirmation: Bool

    public init(idempotency: ToolIdempotency = .idempotent,
                sideEffectLevel: ToolSideEffectLevel = .none,
                cancellability: ToolCancellability = .cooperative,
                resumability: ToolResumability = .restartFromBeginning,
                resourceAccess: [AgentResourceRequirement] = [],
                expectedDuration: TimeInterval? = nil,
                requiresForeground: Bool = false,
                requiresUserConfirmation: Bool = false) {
        self.idempotency = idempotency
        self.sideEffectLevel = sideEffectLevel
        self.cancellability = cancellability
        self.resumability = resumability
        self.resourceAccess = resourceAccess.sorted { $0.key < $1.key }
        self.expectedDuration = expectedDuration
        self.requiresForeground = requiresForeground
        self.requiresUserConfirmation = requiresUserConfirmation
    }

    public var canAutoRecoverAfterInterruption: Bool {
        idempotency == .idempotent && sideEffectLevel == .none
    }

    public var supportsPause: Bool {
        cancellability != .notCancellable && resumability != .notResumable
    }
}

public struct AgentRetryPolicy: Codable, Sendable, Hashable {
    public var maxAttempts: Int
    public var baseDelay: TimeInterval
    public var exponentialBackoff: Bool
    public var jitter: TimeInterval
    public var retryableErrorCategories: Set<String>

    public init(maxAttempts: Int = 1,
                baseDelay: TimeInterval = 1,
                exponentialBackoff: Bool = true,
                jitter: TimeInterval = 0,
                retryableErrorCategories: Set<String> = ["timeout", "networkUnavailable", "provider5xx", "rateLimited"]) {
        self.maxAttempts = max(1, maxAttempts)
        self.baseDelay = max(0, baseDelay)
        self.exponentialBackoff = exponentialBackoff
        self.jitter = max(0, jitter)
        self.retryableErrorCategories = retryableErrorCategories.map(AgentEventRedactor.safeIdentifier).reduce(into: Set<String>()) { $0.insert($1) }
    }

    public func shouldRetry(errorCategory: String,
                            attempt: Int,
                            semantics: AgentToolExecutionSemantics) -> Bool {
        let safeCategory = AgentEventRedactor.safeIdentifier(errorCategory)
        let neverRetry = [
            "authenticationFailed",
            "permissionDenied",
            "userCancelled",
            "schemaValidationFailed",
            "destructiveUncertainOutcome",
            "provider4xx"
        ]
        guard !neverRetry.contains(safeCategory) else { return false }
        guard semantics.idempotency != .nonIdempotent else { return false }
        guard attempt < maxAttempts else { return false }
        return retryableErrorCategories.contains(safeCategory)
    }
}

public struct AgentTaskSubmission: Codable, Sendable, Hashable {
    public var taskID: UUID
    public var title: String
    public var priority: AgentTaskPriority
    public var semantics: AgentToolExecutionSemantics
    public var retryPolicy: AgentRetryPolicy
    public var createdAt: Date
    public var scheduleID: UUID?
    public var origin: AgentTaskOrigin?
    public var conversationID: UUID?
    public var userMessageID: UUID?
    public var providerKind: String?
    public var modelID: String?
    /// Privacy dye: private-chat submissions must not leave user text on disk
    /// (queue titles, activity JSONL, run events, checkpoints). Defaults false;
    /// legacy payloads without the key decode as non-private.
    public var isPrivate: Bool

    public init(taskID: UUID = UUID(),
                title: String,
                priority: AgentTaskPriority = .normal,
                semantics: AgentToolExecutionSemantics = AgentToolExecutionSemantics(),
                retryPolicy: AgentRetryPolicy = AgentRetryPolicy(),
                createdAt: Date = Date(),
                scheduleID: UUID? = nil,
                origin: AgentTaskOrigin? = nil,
                conversationID: UUID? = nil,
                userMessageID: UUID? = nil,
                providerKind: String? = nil,
                modelID: String? = nil,
                isPrivate: Bool = false) {
        self.taskID = taskID
        self.title = AgentEventRedactor.safeText(title, maxLength: 160)
        self.priority = priority
        self.semantics = semantics
        self.retryPolicy = retryPolicy
        self.createdAt = createdAt
        self.scheduleID = scheduleID
        self.origin = origin
        self.conversationID = conversationID
        self.userMessageID = userMessageID
        self.providerKind = providerKind.map(AgentEventRedactor.safeIdentifier)
        self.modelID = modelID.map(AgentEventRedactor.safeIdentifier)
        self.isPrivate = isPrivate
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskID = try c.decode(UUID.self, forKey: .taskID)
        title = try c.decode(String.self, forKey: .title)
        priority = (try? c.decodeIfPresent(AgentTaskPriority.self, forKey: .priority)) ?? .normal
        semantics = (try? c.decodeIfPresent(AgentToolExecutionSemantics.self, forKey: .semantics)) ?? AgentToolExecutionSemantics()
        retryPolicy = (try? c.decodeIfPresent(AgentRetryPolicy.self, forKey: .retryPolicy)) ?? AgentRetryPolicy()
        createdAt = (try? c.decodeIfPresent(Date.self, forKey: .createdAt)) ?? Date()
        scheduleID = try? c.decodeIfPresent(UUID.self, forKey: .scheduleID) ?? nil
        origin = try? c.decodeIfPresent(AgentTaskOrigin.self, forKey: .origin) ?? nil
        conversationID = try? c.decodeIfPresent(UUID.self, forKey: .conversationID) ?? nil
        userMessageID = try? c.decodeIfPresent(UUID.self, forKey: .userMessageID) ?? nil
        providerKind = try? c.decodeIfPresent(String.self, forKey: .providerKind) ?? nil
        modelID = try? c.decodeIfPresent(String.self, forKey: .modelID) ?? nil
        isPrivate = (try? c.decodeIfPresent(Bool.self, forKey: .isPrivate)) ?? false
    }
}

public struct AgentTaskQueueRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID { taskID }
    public var taskID: UUID
    public var runID: UUID
    public var title: String
    public var status: AgentTaskSchedulerStatus
    public var priority: AgentTaskPriority
    public var queueIndex: Int
    public var attempt: Int
    public var retryCount: Int
    public var submittedAt: Date
    public var updatedAt: Date
    public var startedAt: Date?
    public var finishedAt: Date?
    public var waitingResource: AgentResourceKey?
    public var requiredPermissions: [String]
    public var semantics: AgentToolExecutionSemantics
    public var retryPolicy: AgentRetryPolicy
    public var scheduleID: UUID?
    public var origin: AgentTaskOrigin?
    public var conversationID: UUID?
    public var userMessageID: UUID?
    public var providerKind: String?
    public var modelID: String?
    /// Carried from the submission (see `AgentTaskSubmission.isPrivate`).
    /// Retry mutates the existing record, so the flag survives retries.
    public var isPrivate: Bool

    public init(submission: AgentTaskSubmission,
                runID: UUID,
                status: AgentTaskSchedulerStatus,
                queueIndex: Int,
                attempt: Int,
                retryCount: Int = 0,
                updatedAt: Date) {
        self.taskID = submission.taskID
        self.runID = runID
        self.title = submission.title
        self.status = status
        self.priority = submission.priority
        self.queueIndex = queueIndex
        self.attempt = attempt
        self.retryCount = retryCount
        self.submittedAt = submission.createdAt
        self.updatedAt = updatedAt
        self.startedAt = nil
        self.finishedAt = nil
        self.waitingResource = nil
        self.requiredPermissions = []
        self.semantics = submission.semantics
        self.retryPolicy = submission.retryPolicy
        self.scheduleID = submission.scheduleID
        self.origin = submission.origin
        self.conversationID = submission.conversationID
        self.userMessageID = submission.userMessageID
        self.providerKind = submission.providerKind
        self.modelID = submission.modelID
        self.isPrivate = submission.isPrivate
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskID = try c.decode(UUID.self, forKey: .taskID)
        runID = try c.decode(UUID.self, forKey: .runID)
        title = try c.decode(String.self, forKey: .title)
        status = try c.decode(AgentTaskSchedulerStatus.self, forKey: .status)
        priority = (try? c.decodeIfPresent(AgentTaskPriority.self, forKey: .priority)) ?? .normal
        queueIndex = (try? c.decodeIfPresent(Int.self, forKey: .queueIndex)) ?? 0
        attempt = (try? c.decodeIfPresent(Int.self, forKey: .attempt)) ?? 1
        retryCount = (try? c.decodeIfPresent(Int.self, forKey: .retryCount)) ?? 0
        submittedAt = (try? c.decodeIfPresent(Date.self, forKey: .submittedAt)) ?? Date()
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? Date()
        startedAt = try? c.decodeIfPresent(Date.self, forKey: .startedAt) ?? nil
        finishedAt = try? c.decodeIfPresent(Date.self, forKey: .finishedAt) ?? nil
        waitingResource = try? c.decodeIfPresent(AgentResourceKey.self, forKey: .waitingResource) ?? nil
        requiredPermissions = (try? c.decodeIfPresent([String].self, forKey: .requiredPermissions)) ?? []
        semantics = (try? c.decodeIfPresent(AgentToolExecutionSemantics.self, forKey: .semantics)) ?? AgentToolExecutionSemantics()
        retryPolicy = (try? c.decodeIfPresent(AgentRetryPolicy.self, forKey: .retryPolicy)) ?? AgentRetryPolicy()
        scheduleID = try? c.decodeIfPresent(UUID.self, forKey: .scheduleID) ?? nil
        origin = try? c.decodeIfPresent(AgentTaskOrigin.self, forKey: .origin) ?? nil
        conversationID = try? c.decodeIfPresent(UUID.self, forKey: .conversationID) ?? nil
        userMessageID = try? c.decodeIfPresent(UUID.self, forKey: .userMessageID) ?? nil
        providerKind = try? c.decodeIfPresent(String.self, forKey: .providerKind) ?? nil
        modelID = try? c.decodeIfPresent(String.self, forKey: .modelID) ?? nil
        isPrivate = (try? c.decodeIfPresent(Bool.self, forKey: .isPrivate)) ?? false
    }
}

public struct AgentTaskSchedulerSnapshot: Codable, Sendable, Hashable {
    public var records: [AgentTaskQueueRecord]
    public var maxConcurrent: Int
    public var updatedAt: Date

    public init(records: [AgentTaskQueueRecord],
                maxConcurrent: Int,
                updatedAt: Date) {
        self.records = records
        self.maxConcurrent = maxConcurrent
        self.updatedAt = updatedAt
    }
}

public actor AgentTaskScheduler {
    private let eventHub: AgentEventHub?
    private let now: @Sendable () -> Date
    private var maxConcurrent: Int
    private var records: [UUID: AgentTaskQueueRecord] = [:]
    private var insertionOrder: [UUID] = []
    private var lockOwners: [AgentResourceKey: [(taskID: UUID, mode: AgentResourceAccessMode)]] = [:]
    private var sequenceByRunID: [UUID: UInt64] = [:]

    public init(maxConcurrent: Int = 2,
                eventHub: AgentEventHub? = nil,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.maxConcurrent = min(max(maxConcurrent, 1), 4)
        self.eventHub = eventHub
        self.now = now
    }

    public func configure(maxConcurrent: Int) {
        self.maxConcurrent = min(max(maxConcurrent, 1), 4)
    }

    @discardableResult
    public func submit(_ submission: AgentTaskSubmission) async -> AgentTaskQueueRecord {
        let runID = UUID()
        let record = AgentTaskQueueRecord(submission: submission,
                                          runID: runID,
                                          status: .queued,
                                          queueIndex: insertionOrder.count,
                                          attempt: 1,
                                          updatedAt: now())
        records[record.taskID] = record
        insertionOrder.append(record.taskID)
        await emit(kind: .taskQueued,
                   record: record,
                   payload: .task(record.taskPayload()))
        return record
    }

    public func startAvailable() async -> [AgentTaskQueueRecord] {
        var started: [AgentTaskQueueRecord] = []
        var runningCount = records.values.filter { $0.status == .running }.count
        let startable = queuedRecords()
        for var record in startable where runningCount < maxConcurrent {
            if record.status == .waitingForPermission { continue }
            if let blocked = firstBlockedResource(for: record) {
                record.status = .waitingForResource
                record.waitingResource = blocked
                record.updatedAt = now()
                records[record.taskID] = record
                await emit(kind: .warning,
                           record: record,
                           payload: .diagnostic(.init(category: "resourceLock",
                                                      safeSummary: "等待资源释放",
                                                      details: ["resource": blocked.description])))
                continue
            }
            acquireLocks(for: record)
            record.status = .running
            record.startedAt = now()
            record.updatedAt = record.startedAt ?? now()
            record.waitingResource = nil
            records[record.taskID] = record
            runningCount += 1
            started.append(record)
            await emit(kind: record.attempt > 1 ? .runRetryStarted : .runStarted,
                       record: record,
                       payload: .run(.init(attempt: record.attempt, reason: "schedulerStart")))
            await emit(kind: .taskStarted,
                       record: record,
                       payload: .task(record.taskPayload()))
        }
        return started
    }

    public func complete(taskID: UUID) async {
        guard var record = records[taskID], record.status == .running else { return }
        releaseLocks(for: record.taskID)
        record.status = .succeeded
        record.finishedAt = now()
        record.updatedAt = record.finishedAt ?? now()
        records[taskID] = record
        await emit(kind: .taskSucceeded,
                   record: record,
                   payload: .task(record.taskPayload()))
    }

    public func partiallyCompleteFromRuntime(taskID: UUID,
                                             failureCategory: String? = nil,
                                             safeSummary: String? = nil) async {
        guard var record = records[taskID], !record.status.isTerminal else { return }
        releaseLocks(for: record.taskID)
        record.status = .succeeded
        record.finishedAt = now()
        record.updatedAt = record.finishedAt ?? now()
        records[taskID] = record
        await emit(kind: .taskPartiallySucceeded,
                   record: record,
                   payload: .task(record.taskPayload()))
    }

    public func fail(taskID: UUID, errorCategory: String, safeSummary: String) async {
        guard var record = records[taskID] else { return }
        // R-A-03 closure: a late `fail` event must not overwrite a record
        // that has already terminalized via `complete` or `cancel`.
        guard !record.status.isTerminal else { return }
        releaseLocks(for: record.taskID)
        let canRetry = record.retryPolicy.shouldRetry(errorCategory: errorCategory,
                                                      attempt: record.attempt,
                                                      semantics: record.semantics)
        record.status = .failed
        record.finishedAt = now()
        record.updatedAt = record.finishedAt ?? now()
        records[taskID] = record
        await emit(kind: .taskFailed,
                   record: record,
                   payload: .failure(.init(phase: "scheduler",
                                           category: errorCategory,
                                           safeSummary: safeSummary,
                                           recoverable: canRetry,
                                           retryable: canRetry)))
        if canRetry {
            _ = await retry(taskID: taskID, reason: errorCategory)
        }
    }

    public func cancel(taskID: UUID, reason: String = "userCancelled") async {
        guard var record = records[taskID], !record.status.isTerminal else { return }
        releaseLocks(for: record.taskID)
        record.status = .cancelled
        record.finishedAt = now()
        record.updatedAt = record.finishedAt ?? now()
        records[taskID] = record
        await emit(kind: .taskCancelled,
                   record: record,
                   payload: .failure(.init(phase: "scheduler",
                                           category: "cancelled",
                                           safeSummary: reason,
                                           recoverable: false,
                                           retryable: false)))
    }

    public func waitForPermission(taskID: UUID, permissions: [String]) async {
        guard var record = records[taskID] else { return }
        if record.status == .running {
            releaseLocks(for: record.taskID)
        }
        record.status = .waitingForPermission
        record.requiredPermissions = permissions.map(AgentEventRedactor.safeIdentifier)
        record.updatedAt = now()
        records[taskID] = record
        await emit(kind: .toolPermissionRequired,
                   record: record,
                   payload: .permission(.init(capabilityID: record.requiredPermissions.first ?? "permission",
                                              safeReason: "等待用户确认")))
    }

    public func resolvePermission(taskID: UUID, granted: Bool) async {
        guard var record = records[taskID], record.status == .waitingForPermission else { return }
        record.status = granted ? .queued : .failed
        record.updatedAt = now()
        if !granted { record.finishedAt = record.updatedAt }
        records[taskID] = record
        await emit(kind: granted ? .toolPermissionGranted : .toolPermissionDenied,
                   record: record,
                   payload: .permission(.init(capabilityID: record.requiredPermissions.first ?? "permission",
                                              decision: granted ? "granted" : "denied")))
    }

    public func retry(taskID: UUID, reason: String = "retry") async -> AgentTaskQueueRecord? {
        guard var record = records[taskID], record.status.isTerminal || record.status == .interrupted || record.status == .waitingForUser else {
            return nil
        }
        releaseLocks(for: record.taskID)
        record.runID = UUID()
        record.status = .queued
        record.attempt += 1
        record.retryCount += 1
        record.startedAt = nil
        record.finishedAt = nil
        record.waitingResource = nil
        record.updatedAt = now()
        records[taskID] = record
        await emit(kind: .taskQueued,
                   record: record,
                   payload: .run(.init(attempt: record.attempt, reason: reason)))
        return record
    }

    public func requestPause(taskID: UUID) async -> Bool {
        guard var record = records[taskID], record.status == .running else { return false }
        guard record.semantics.supportsPause else {
            await emit(kind: .diagnostic,
                       record: record,
                       payload: .diagnostic(.init(category: "pauseUnsupported",
                                                  safeSummary: "此任务不支持暂停")))
            return false
        }
        record.status = .pauseRequested
        record.updatedAt = now()
        records[taskID] = record
        await emit(kind: .taskPaused,
                   record: record,
                   payload: .task(record.taskPayload()))
        return true
    }

    public func pauseAtSafeBoundary(taskID: UUID) async {
        guard var record = records[taskID], record.status == .pauseRequested else { return }
        releaseLocks(for: record.taskID)
        record.status = .paused
        record.updatedAt = now()
        records[taskID] = record
        await emit(kind: .taskPaused,
                   record: record,
                   payload: .task(record.taskPayload()))
    }

    public func resume(taskID: UUID) async {
        guard var record = records[taskID], record.status == .paused else { return }
        record.status = .queued
        record.updatedAt = now()
        records[taskID] = record
        await emit(kind: .taskResumed,
                   record: record,
                   payload: .task(.init(title: record.title, status: record.status.rawValue)))
    }

    public func recoverInterruptedOnLaunch() async -> [AgentTaskQueueRecord] {
        var recovered: [AgentTaskQueueRecord] = []
        for taskID in insertionOrder {
            guard var record = records[taskID],
                  record.status == .running || record.status == .waitingForResource || record.status == .pauseRequested else {
                continue
            }
            releaseLocks(for: taskID)
            record.status = record.semantics.canAutoRecoverAfterInterruption ? .interrupted : .waitingForUser
            record.updatedAt = now()
            records[taskID] = record
            recovered.append(record)
            await emit(kind: .taskInterrupted,
                       record: record,
                       payload: .failure(.init(phase: "schedulerRecovery",
                                               category: record.status.rawValue,
                                               safeSummary: record.semantics.canAutoRecoverAfterInterruption ? "任务被中断，可确认恢复" : "任务涉及副作用，需要用户确认",
                                               recoverable: true,
                                               retryable: record.semantics.canAutoRecoverAfterInterruption)))
        }
        return recovered
    }

    public func increasePriority(taskID: UUID) {
        guard var record = records[taskID] else { return }
        record.priority = record.priority.nextHigher
        record.updatedAt = now()
        records[taskID] = record
    }

    public func decreasePriority(taskID: UUID) {
        guard var record = records[taskID] else { return }
        record.priority = record.priority.nextLower
        record.updatedAt = now()
        records[taskID] = record
    }

    public func snapshot() -> AgentTaskSchedulerSnapshot {
        AgentTaskSchedulerSnapshot(records: sortedRecords(),
                                   maxConcurrent: maxConcurrent,
                                   updatedAt: now())
    }

    public func record(taskID: UUID) -> AgentTaskQueueRecord? {
        records[taskID]
    }

    /// Privacy dye lookup for persistence gates (activity JSONL / run events /
    /// checkpoints must skip private tasks). Unknown tasks are non-private.
    public func isPrivateTask(_ taskID: UUID) -> Bool {
        records[taskID]?.isPrivate ?? false
    }

    public func hasActiveRun(runID: UUID) -> Bool {
        records.values.contains { $0.runID == runID && !$0.status.isTerminal && $0.status == .running }
    }

    public func finishFromRuntime(taskID: UUID,
                                  status: AgentTaskSchedulerStatus,
                                  failureCategory: String? = nil,
                                  safeSummary: String? = nil) async {
        guard var record = records[taskID], !record.status.isTerminal else { return }
        releaseLocks(for: record.taskID)
        record.status = status
        record.finishedAt = now()
        record.updatedAt = record.finishedAt ?? now()
        records[taskID] = record

        let kind: AgentEventKind
        let payload: AgentEventPayload
        switch status {
        case .succeeded:
            kind = .runCompleted
            payload = .run(.init(attempt: record.attempt, reason: "runtimeCompleted"))
        case .failed:
            kind = .runFailed
            payload = .failure(.init(phase: "runtime",
                                     category: failureCategory ?? "runtimeFailed",
                                     safeSummary: safeSummary ?? "任务失败",
                                     recoverable: false,
                                     retryable: record.retryPolicy.shouldRetry(errorCategory: failureCategory ?? "runtimeFailed",
                                                                               attempt: record.attempt,
                                                                               semantics: record.semantics)))
        case .cancelled:
            kind = .runCancelled
            payload = .failure(.init(phase: "runtime",
                                     category: "cancelled",
                                     safeSummary: safeSummary ?? "任务已取消",
                                     recoverable: false,
                                     retryable: false))
        default:
            return
        }
        await emit(kind: kind, record: record, payload: payload)
    }

    /// P14.2 — R-B-F01 closure. Typed failure entry point used by the
    /// production coordinator / ChatModel when the LLM provider returned
    /// a typed `LlmFailure` (rather than a stringly-typed category).
    /// The retry decision is made via
    /// `AgentRetryPolicy.shouldRetry(llmFailure:attempt:semantics:)` — the
    /// typed source of truth — and the typed `LlmFailure.code.rawValue`
    /// is surfaced as the event's category for downstream consumers.
    public func finishFromRuntime(taskID: UUID,
                                  status: AgentTaskSchedulerStatus,
                                  llmFailure: LlmFailure,
                                  safeSummary: String? = nil) async {
        guard var record = records[taskID], !record.status.isTerminal else { return }
        releaseLocks(for: record.taskID)
        record.status = status
        record.finishedAt = now()
        record.updatedAt = record.finishedAt ?? now()
        records[taskID] = record

        let retryable = record.retryPolicy.shouldRetry(llmFailure: llmFailure,
                                                       attempt: record.attempt,
                                                       semantics: record.semantics)
        let category = llmFailure.code.rawValue
        let payload: AgentEventPayload
        let kind: AgentEventKind
        switch status {
        case .failed:
            kind = .runFailed
            payload = .failure(.init(phase: "runtime",
                                     category: category,
                                     safeSummary: safeSummary ?? llmFailure.message,
                                     recoverable: false,
                                     retryable: retryable))
        case .cancelled:
            kind = .runCancelled
            payload = .failure(.init(phase: "runtime",
                                     category: "cancelled",
                                     safeSummary: safeSummary ?? "任务已取消",
                                     recoverable: false,
                                     retryable: false))
        case .succeeded:
            kind = .runCompleted
            payload = .run(.init(attempt: record.attempt, reason: "runtimeCompleted"))
        default:
            return
        }
        await emit(kind: kind, record: record, payload: payload)
    }

    public func load(snapshot: AgentTaskSchedulerSnapshot) {
        maxConcurrent = min(max(snapshot.maxConcurrent, 1), 4)
        // P18.1 — PAR-005 closure. The persisted snapshot may
        // contain duplicate taskIDs (corrupted legacy snapshot, or a
        // bug in a previous writer). `uniqueKeysWithValues:` would
        // `fatalError` here — process crash. We use last-wins keyed
        // dedupe, with the higher `queueIndex` winning (later writes
        // take precedence). Insertion order is then sorted to
        // preserve the queue invariant.
        records = Dictionary(
            snapshot.records.map { ($0.taskID, $0) },
            uniquingKeysWith: { first, second in
                // Higher queueIndex wins (last writer).
                first.queueIndex >= second.queueIndex ? first : second
            })
        insertionOrder = snapshot.records.sorted { $0.queueIndex < $1.queueIndex }.map(\.taskID)
        lockOwners.removeAll()
    }

    private func queuedRecords() -> [AgentTaskQueueRecord] {
        sortedRecords().filter { [.queued, .waitingForResource].contains($0.status) }
    }

    private func sortedRecords() -> [AgentTaskQueueRecord] {
        records.values.sorted {
            if $0.priority != $1.priority { return $0.priority > $1.priority }
            if $0.queueIndex != $1.queueIndex { return $0.queueIndex < $1.queueIndex }
            return $0.submittedAt < $1.submittedAt
        }
    }

    private func firstBlockedResource(for record: AgentTaskQueueRecord) -> AgentResourceKey? {
        for requirement in record.semantics.resourceAccess.sorted(by: { $0.key < $1.key }) {
            guard let owners = lockOwners[requirement.key], !owners.isEmpty else { continue }
            let conflicts = owners.contains { owner in
                if owner.taskID == record.taskID { return false }
                return owner.mode == .write || requirement.mode == .write
            }
            if conflicts { return requirement.key }
        }
        return nil
    }

    private func acquireLocks(for record: AgentTaskQueueRecord) {
        for requirement in record.semantics.resourceAccess.sorted(by: { $0.key < $1.key }) {
            var owners = lockOwners[requirement.key, default: []]
            if !owners.contains(where: { $0.taskID == record.taskID }) {
                owners.append((taskID: record.taskID, mode: requirement.mode))
            }
            lockOwners[requirement.key] = owners
        }
    }

    private func releaseLocks(for taskID: UUID) {
        for key in lockOwners.keys {
            lockOwners[key]?.removeAll { $0.taskID == taskID }
            if lockOwners[key]?.isEmpty == true {
                lockOwners[key] = nil
            }
        }
        for var record in records.values where record.status == .waitingForResource {
            if firstBlockedResource(for: record) == nil {
                record.status = .queued
                record.waitingResource = nil
                record.updatedAt = now()
                records[record.taskID] = record
            }
        }
    }

    private func nextSequence(runID: UUID) -> UInt64 {
        let next = (sequenceByRunID[runID] ?? 0) + 1
        sequenceByRunID[runID] = next
        return next
    }

    private func emit(kind: AgentEventKind,
                      record: AgentTaskQueueRecord,
                      payload: AgentEventPayload) async {
        guard let eventHub else { return }
        await eventHub.publish(AgentEventEnvelope(taskID: record.taskID,
                                                  runID: record.runID,
                                                  sequence: nextSequence(runID: record.runID),
                                                  timestamp: now(),
                                                  source: .scheduler,
                                                  visibility: .user,
                                                  kind: kind,
                                                  payload: payload))
    }
}

private extension AgentTaskQueueRecord {
    func taskPayload() -> AgentEventPayload.TaskPayload {
        AgentEventPayload.TaskPayload(title: title,
                                      status: status.rawValue,
                                      retryCount: retryCount,
                                      conversationID: conversationID,
                                      userMessageID: userMessageID,
                                      origin: origin?.rawValue,
                                      providerKind: providerKind,
                                      modelID: modelID,
                                      scheduleID: scheduleID)
    }
}

private extension AgentTaskPriority {
    var nextHigher: AgentTaskPriority {
        switch self {
        case .background: return .normal
        case .normal: return .high
        case .high, .userInteractive: return .userInteractive
        }
    }

    var nextLower: AgentTaskPriority {
        switch self {
        case .userInteractive: return .high
        case .high: return .normal
        case .normal, .background: return .background
        }
    }
}
