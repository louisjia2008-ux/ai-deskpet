import Combine
import Foundation
import PetAgentRuntime

@MainActor
final class AgentTaskActivityStore: ObservableObject {
    @Published private(set) var tasks: [AgentTaskActivitySnapshot] = []
    @Published private(set) var canonicalTasks: [AgentTaskProjectionSnapshot] = []

    private var events: [AgentTaskActivityEvent] = []
    private var seenEventIDs: Set<UUID> = []
    private let persistence: (any AgentTaskActivityEventPersisting)?
    let eventHub: AgentEventHub
    private let runEventStore: (any AgentRunEventPersisting)?
    private let checkpointStore: AgentCheckpointStore?
    private let maxTaskCount: Int
    private let maxEventsPerTask: Int
    private var eventHubSubscriptionTask: Task<Void, Never>?
    /// Privacy dye (in-memory only, never persisted): taskIDs submitted from a
    /// private conversation. Their events still project to the live UI, but all
    /// disk writes (activity JSONL, run events, checkpoints) are skipped so a
    /// private chat leaves no trace outside its own (non-persisted) conversation.
    /// Fed by ChatModel at submit time; see `markPrivate(taskID:)`.
    private var privateTaskIDs = Set<UUID>()

    init(persistence: (any AgentTaskActivityEventPersisting)? = JSONLAgentTaskActivityEventStore.defaultStore(),
         eventHub: AgentEventHub = AgentEventHub(),
         runEventStore: (any AgentRunEventPersisting)? = nil,
         checkpointStore: AgentCheckpointStore? = nil,
         maxTaskCount: Int = 100,
         maxEventsPerTask: Int = 80) {
        self.persistence = persistence
        self.eventHub = eventHub
        self.runEventStore = runEventStore
        self.checkpointStore = checkpointStore
        self.maxTaskCount = max(1, maxTaskCount)
        self.maxEventsPerTask = max(1, maxEventsPerTask)
        startEventHubProjection()
    }

    deinit {
        eventHubSubscriptionTask?.cancel()
    }

    func loadPersistedHistory(now: Date = Date()) {
        guard let persistence else { return }
        Task {
            let loaded = (try? await persistence.loadEvents()) ?? []
            await MainActor.run {
                self.hydrate(loaded, markInterruptedAt: now)
            }
        }
    }

    func hydrate(_ loaded: [AgentTaskActivityEvent], markInterruptedAt now: Date? = nil) {
        events.removeAll()
        seenEventIDs.removeAll()
        for event in loaded {
            let safe = AgentTaskActivityRedactor.redacted(event)
            guard seenEventIDs.insert(safe.eventID).inserted else { continue }
            events.append(safe)
        }
        applyRetention()
        rebuild()
        if let now { markInterruptedRuns(now: now) }
    }

    @available(*, deprecated, message: "Publish AgentEventEnvelope through AgentEventHub; AgentTaskActivityStore is an EventHub projection.")
    func append(_ event: AgentTaskActivityEvent) {
        publish(AgentEventEnvelope(activityEvent: event))
    }

    func publish(_ envelope: AgentEventEnvelope) {
        ingest(envelope, persistLegacyEvent: true, appendRunEvent: true)
        let hub = eventHub
        Task { await hub.publish(envelope) }
    }

    func task(id taskID: UUID) -> AgentTaskActivitySnapshot? {
        tasks.first { $0.taskID == taskID }
    }

    func catchUpFromEventHub(limit: Int = 200) async {
        let recent = await eventHub.recentEvents(limit: limit)
        recent.forEach { ingest($0, persistLegacyEvent: true, appendRunEvent: true) }
    }

    func canonicalTask(id taskID: UUID) -> AgentTaskProjectionSnapshot? {
        canonicalTasks.first { $0.taskID == taskID }
    }

    func run(id runID: UUID) -> AgentTaskRunActivity? {
        tasks.flatMap(\.runs).first { $0.runID == runID }
    }

    func latestTask(conversationID: UUID) -> AgentTaskActivitySnapshot? {
        tasks
            .filter { $0.latestRun?.conversationID == conversationID }
            .max { $0.updatedAt < $1.updatedAt }
    }

    var activeTasks: [AgentTaskActivitySnapshot] {
        tasks.filter { [.created, .queued, .planning, .running, .paused, .synthesizing, .interrupted].contains($0.status) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var waitingTasks: [AgentTaskActivitySnapshot] {
        tasks.filter { [.waitingForApproval, .waitingForPermission, .waitingForUser].contains($0.status) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var recentTerminalTasks: [AgentTaskActivitySnapshot] {
        tasks.filter(\.isTerminal)
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func clearHistory() {
        events.removeAll()
        seenEventIDs.removeAll()
        tasks.removeAll()
        canonicalTasks.removeAll()
        privateTaskIDs.removeAll()
        if let persistence {
            Task { try? await persistence.clear() }
        }
    }

    func remove(taskID: UUID) {
        events.removeAll { $0.taskID == taskID }
        seenEventIDs = Set(events.map(\.eventID))
        privateTaskIDs.remove(taskID)
        rebuild()
        persistSnapshot()
        if let runEventStore {
            Task { try? await runEventStore.deleteEvents(taskID: taskID) }
        }
    }

    /// Dye a task as private (no disk trace). Safe to call repeatedly and for
    /// unknown tasks. Opportunistically drops dye for tasks no longer projected
    /// so the set stays bounded by the retention window.
    func markPrivate(taskID: UUID) {
        let live = Set(tasks.map(\.taskID))
        privateTaskIDs = privateTaskIDs.intersection(live).union([taskID])
    }

    func isPrivate(taskID: UUID) -> Bool { privateTaskIDs.contains(taskID) }

    func runEvents(taskID: UUID) async -> [AgentEventEnvelope] {
        if let runEventStore {
            return (try? await runEventStore.loadEvents(taskID: taskID)) ?? []
        }
        return events
            .filter { $0.taskID == taskID }
            .map { AgentEventEnvelope(activityEvent: $0) }
            .sortedForReplay()
    }

    func runEvents(runID: UUID) async -> [AgentEventEnvelope] {
        if let runEventStore {
            return (try? await runEventStore.loadEvents(runID: runID)) ?? []
        }
        return events
            .filter { $0.runID == runID }
            .map { AgentEventEnvelope(activityEvent: $0) }
            .sortedForReplay()
    }

    private func rebuild() {
        let taskIDs = Set(events.map(\.taskID))
        tasks = taskIDs
            .map { AgentTaskActivityReducer.reduce(taskID: $0, events: events) }
            .sorted { $0.updatedAt > $1.updatedAt }
        canonicalTasks = AgentTaskProjectionReducer
            .reduce(activityEvents: events)
            .tasks
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private func applyRetention() {
        let groupedByTask = Dictionary(grouping: events, by: \.taskID)
        var retained: [AgentTaskActivityEvent] = []
        let orderedTaskIDs = groupedByTask
            .map { taskID, taskEvents -> (UUID, Date) in
                (taskID, taskEvents.map(\.timestamp).max() ?? .distantPast)
            }
            .sorted { $0.1 > $1.1 }
            .prefix(maxTaskCount)
            .map(\.0)

        for taskID in orderedTaskIDs {
            let taskEvents = groupedByTask[taskID, default: []]
                .sorted {
                    if $0.runID == $1.runID, $0.sequenceNumber == $1.sequenceNumber {
                        return $0.timestamp < $1.timestamp
                    }
                    if $0.runID == $1.runID { return $0.sequenceNumber < $1.sequenceNumber }
                    return $0.timestamp < $1.timestamp
                }
                .suffix(maxEventsPerTask)
            retained.append(contentsOf: taskEvents)
        }
        events = retained
        seenEventIDs = Set(events.map(\.eventID))
    }

    private func markInterruptedRuns(now: Date) {
        let interrupted = tasks.compactMap { snapshot -> AgentTaskActivityEvent? in
            guard let run = snapshot.latestRun, !run.status.isTerminal else { return nil }
            let nextSequence = (run.events.map(\.sequenceNumber).max() ?? 0) + 1
            return AgentTaskActivityEvent(
                taskID: snapshot.taskID,
                runID: run.runID,
                conversationID: run.conversationID,
                userMessageID: run.userMessageID,
                sequenceNumber: nextSequence,
                timestamp: now,
                kind: .taskFailed,
                presentation: AgentTaskEventPresentation(title: "任务被应用重启打断",
                                                         detail: "可以重试此任务"),
                failureCategory: .interrupted)
        }
        interrupted.forEach { publish(AgentEventEnvelope(activityEvent: $0)) }
    }

    private func persistSnapshot() {
        guard let persistence else { return }
        // Private tasks must not leak through a full-snapshot rewrite either.
        let retained = events.filter { !privateTaskIDs.contains($0.taskID) }
        Task { try? await persistence.replaceAll(retained) }
    }

    private func startEventHubProjection() {
        let hub = eventHub
        eventHubSubscriptionTask = Task { [weak self] in
            let subscription = await hub.subscribe()
            let recent = await hub.recentEvents(limit: 2_000)
            await MainActor.run {
                recent.forEach {
                    self?.ingest($0, persistLegacyEvent: true, appendRunEvent: true)
                }
            }
            for await envelope in subscription.stream {
                if Task.isCancelled { break }
                await MainActor.run {
                    self?.ingest(envelope, persistLegacyEvent: true, appendRunEvent: true)
                }
            }
        }
    }

    private func ingest(_ envelope: AgentEventEnvelope,
                        persistLegacyEvent: Bool,
                        appendRunEvent: Bool) {
        let safeEnvelope = AgentEventRedactor.redact(envelope, level: .diagnostic)
        let safe = AgentTaskActivityRedactor.redacted(AgentTaskActivityEvent(eventEnvelope: safeEnvelope))
        guard seenEventIDs.insert(safe.eventID).inserted else { return }
        events.append(safe)
        applyRetention()
        rebuild()
        // Private tasks project to the live UI but never touch disk.
        let isPrivate = privateTaskIDs.contains(safeEnvelope.taskID)
        if persistLegacyEvent, !isPrivate, let persistence {
            Task { try? await persistence.append(safe) }
        }
        guard appendRunEvent, !isPrivate else { return }
        let runStore = runEventStore
        let checkpointStore = checkpointStore
        Task {
            try? await runStore?.append(safeEnvelope)
            guard let runStore, let checkpointStore else { return }
            let runEvents = (try? await runStore.loadEvents(runID: safeEnvelope.runID)) ?? []
            var checkpoint = AgentCheckpointBuilder().checkpoint(taskID: safeEnvelope.taskID,
                                                                 runID: safeEnvelope.runID,
                                                                 events: runEvents)
            if let existing = try? await checkpointStore.load(taskID: safeEnvelope.taskID,
                                                              runID: safeEnvelope.runID) {
                checkpoint.domainPayloads = existing.domainPayloads
                checkpoint.completedToolCallIDs = Array(Set(checkpoint.completedToolCallIDs + existing.completedToolCallIDs)).sorted()
                checkpoint.completedSideEffectOperationIDs = Array(Set(checkpoint.completedSideEffectOperationIDs + existing.completedSideEffectOperationIDs)).sorted()
                checkpoint.evidenceIDs = Array(Set(checkpoint.evidenceIDs + existing.evidenceIDs)).sorted()
                if checkpoint.currentUIRevision == nil {
                    checkpoint.currentUIRevision = existing.currentUIRevision
                }
                if checkpoint.resultDocument == nil {
                    checkpoint.resultDocument = existing.resultDocument
                }
            }
            try? await checkpointStore.save(checkpoint)
        }
    }
}
