import Foundation

public enum AgentRunState: String, Codable, Sendable, Hashable, CaseIterable {
    case created
    case queued
    case preparing
    case understanding
    case planning
    case awaitingApproval
    case awaitingPermission
    case awaitingUserInput
    case running
    case streaming
    case executingTool
    case verifying
    case recovering
    case succeeded
    case partiallySucceeded
    case failed
    case cancelled
    case interrupted
    case unknown

    public var isTerminal: Bool {
        switch self {
        case .succeeded, .partiallySucceeded, .failed, .cancelled, .interrupted:
            return true
        case .created, .queued, .preparing, .understanding, .planning, .awaitingApproval,
             .awaitingPermission, .awaitingUserInput, .running, .streaming, .executingTool,
             .verifying, .recovering, .unknown:
            return false
        }
    }

    public var isWaiting: Bool {
        switch self {
        case .awaitingApproval, .awaitingPermission, .awaitingUserInput:
            return true
        default:
            return false
        }
    }

    public var isActive: Bool {
        !isTerminal && !isWaiting
    }
}

public enum AgentStreamEventKind: String, Codable, Sendable, Hashable, CaseIterable {
    case taskCreated
    case taskQueued
    case taskStarted
    case taskCheckpointed
    case taskCompleted
    case taskPartiallyCompleted
    case taskFailed
    case taskCancelled
    case taskInterrupted
    case taskWaitingForRetry
    case taskRecovered

    case agentSelected
    case agentDelegated
    case verifierStarted
    case verifierCompleted
    case verifierFailed
    case criticStarted
    case criticCompleted

    case modelRequestStarted
    case modelDelta
    case modelReasoningDeltaHidden
    case modelToolCallDelta
    case modelResponseCompleted
    case modelRequestFailed

    case toolCallProposed
    case toolValidated
    case toolValidationFailed
    case toolApprovalRequired
    case toolApprovalGranted
    case toolApprovalDenied
    case toolStarted
    case toolProgress
    case toolObservation
    case toolCompleted
    case toolFailed
    case toolCancelled

    case providerRequestStarted
    case providerResponseReceived
    case providerRateLimited
    case providerAuthenticationFailed
    case providerUnavailable
    case providerRequestFailed

    case userInputRequested
    case userInputReceived
    case userInputCancelled
    case userInputTimedOut

    case resultSnapshot
    case resultPatch
    case uiInteractionRequested
    case uiInteractionResolved

    case recoveryStarted
    case recoverySucceeded
    case recoveryFailed
    case warning
    case diagnostic
    case unknown
}

public struct AgentStreamEvent: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var id: UUID
    public var taskID: UUID
    public var runID: UUID
    public var conversationID: UUID?
    public var userMessageID: UUID?
    public var assistantMessageID: UUID?
    public var agentID: String?
    public var parentEventID: UUID?
    public var sequence: UInt64
    public var timestamp: Date
    public var source: AgentEventSource
    public var visibility: AgentEventVisibility
    public var kind: AgentStreamEventKind
    public var payload: AgentEventPayload

    public init(schemaVersion: Int = 1,
                id: UUID = UUID(),
                taskID: UUID,
                runID: UUID,
                conversationID: UUID? = nil,
                userMessageID: UUID? = nil,
                assistantMessageID: UUID? = nil,
                agentID: String? = nil,
                parentEventID: UUID? = nil,
                sequence: UInt64,
                timestamp: Date = Date(),
                source: AgentEventSource,
                visibility: AgentEventVisibility = .user,
                kind: AgentStreamEventKind,
                payload: AgentEventPayload = .empty) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.taskID = taskID
        self.runID = runID
        self.conversationID = conversationID
        self.userMessageID = userMessageID
        self.assistantMessageID = assistantMessageID
        self.agentID = agentID.map(AgentEventRedactor.safeIdentifier)
        self.parentEventID = parentEventID
        self.sequence = sequence
        self.timestamp = timestamp
        self.source = source
        self.visibility = visibility
        self.kind = kind
        self.payload = AgentEventRedactor.redact(payload, level: .diagnostic)
    }

    public init(envelope: AgentEventEnvelope,
                assistantMessageID: UUID? = nil,
                agentID: String? = nil,
                parentEventID: UUID? = nil) {
        let metadata = AgentStreamProjectionMetadata(envelope: envelope)
        self.init(schemaVersion: envelope.schemaVersion,
                  id: envelope.id,
                  taskID: envelope.taskID,
                  runID: envelope.runID,
                  conversationID: metadata.conversationID,
                  userMessageID: metadata.userMessageID,
                  assistantMessageID: assistantMessageID,
                  agentID: agentID,
                  parentEventID: parentEventID ?? envelope.parentEventID,
                  sequence: envelope.sequence,
                  timestamp: envelope.timestamp,
                  source: envelope.source,
                  visibility: envelope.visibility,
                  kind: AgentStreamEventKind(eventKind: envelope.kind, payload: envelope.payload),
                  payload: envelope.payload)
    }

    public init(activityEvent event: AgentTaskActivityEvent,
                assistantMessageID: UUID? = nil,
                agentID: String? = nil,
                parentEventID: UUID? = nil) {
        self.init(envelope: AgentEventEnvelope(activityEvent: event),
                  assistantMessageID: assistantMessageID,
                  agentID: agentID,
                  parentEventID: parentEventID)
    }

    public func envelope() -> AgentEventEnvelope {
        AgentEventEnvelope(schemaVersion: schemaVersion,
                           id: id,
                           taskID: taskID,
                           runID: runID,
                           sequence: sequence,
                           timestamp: timestamp,
                           source: source,
                           visibility: visibility,
                           parentEventID: parentEventID,
                           kind: AgentEventKind(streamKind: kind),
                           payload: payload)
    }
}

public struct AgentRunProjection: Codable, Sendable, Hashable, Identifiable {
    public var taskID: UUID
    public var runID: UUID
    public var conversationID: UUID?
    public var userMessageID: UUID?
    public var assistantMessageID: UUID?
    public var state: AgentRunState
    public var events: [AgentStreamEvent]
    public var createdAt: Date
    public var updatedAt: Date
    public var completedAt: Date?
    public var currentStepTitle: String?
    public var terminalSummary: String?
    public var failureCategory: String?
    public var resultDocument: AgentResultDocument?

    public var id: UUID { runID }
    public var isTerminal: Bool { state.isTerminal }
    public var isWaiting: Bool { state.isWaiting }
    public var isActive: Bool { state.isActive }

    public init(taskID: UUID,
                runID: UUID,
                conversationID: UUID? = nil,
                userMessageID: UUID? = nil,
                assistantMessageID: UUID? = nil,
                state: AgentRunState,
                events: [AgentStreamEvent],
                createdAt: Date,
                updatedAt: Date,
                completedAt: Date? = nil,
                currentStepTitle: String? = nil,
                terminalSummary: String? = nil,
                failureCategory: String? = nil,
                resultDocument: AgentResultDocument? = nil) {
        self.taskID = taskID
        self.runID = runID
        self.conversationID = conversationID
        self.userMessageID = userMessageID
        self.assistantMessageID = assistantMessageID
        self.state = state
        self.events = events
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.currentStepTitle = currentStepTitle.map { AgentEventRedactor.safeText($0, maxLength: 160) }
        self.terminalSummary = terminalSummary.map { AgentEventRedactor.safeText($0, maxLength: 240) }
        self.failureCategory = failureCategory.map(AgentEventRedactor.safeIdentifier)
        self.resultDocument = resultDocument
    }
}

public struct AgentTaskProjectionSnapshot: Codable, Sendable, Hashable, Identifiable {
    public var taskID: UUID
    public var runs: [AgentRunProjection]

    public var id: UUID { taskID }
    public var latestRun: AgentRunProjection? {
        runs.enumerated().max { lhs, rhs in
            if lhs.element.updatedAt != rhs.element.updatedAt {
                return lhs.element.updatedAt < rhs.element.updatedAt
            }
            if lhs.element.createdAt != rhs.element.createdAt {
                return lhs.element.createdAt < rhs.element.createdAt
            }
            return lhs.offset < rhs.offset
        }?.element
    }
    public var state: AgentRunState { latestRun?.state ?? .unknown }
    public var isTerminal: Bool { state.isTerminal }
    public var updatedAt: Date { latestRun?.updatedAt ?? .distantPast }

    public init(taskID: UUID, runs: [AgentRunProjection]) {
        self.taskID = taskID
        self.runs = runs.enumerated().sorted { lhs, rhs in
            if lhs.element.createdAt != rhs.element.createdAt {
                return lhs.element.createdAt < rhs.element.createdAt
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }
}

public struct AgentTaskProjection: Codable, Sendable, Hashable {
    public var tasks: [AgentTaskProjectionSnapshot]

    public var activeTasks: [AgentTaskProjectionSnapshot] {
        tasks.filter { $0.state.isActive }.sorted { $0.updatedAt > $1.updatedAt }
    }

    public var waitingTasks: [AgentTaskProjectionSnapshot] {
        tasks.filter { $0.state.isWaiting }.sorted { $0.updatedAt > $1.updatedAt }
    }

    public var terminalTasks: [AgentTaskProjectionSnapshot] {
        tasks.filter(\.isTerminal).sorted { $0.updatedAt > $1.updatedAt }
    }

    public init(tasks: [AgentTaskProjectionSnapshot]) {
        self.tasks = tasks.sorted { $0.updatedAt > $1.updatedAt }
    }

    public func task(id taskID: UUID) -> AgentTaskProjectionSnapshot? {
        tasks.first { $0.taskID == taskID }
    }

    public func run(id runID: UUID) -> AgentRunProjection? {
        tasks.flatMap(\.runs).first { $0.runID == runID }
    }
}

public enum AgentTaskProjectionReducer {
    public static func reduce(envelopes: [AgentEventEnvelope]) -> AgentTaskProjection {
        reduce(streamEvents: envelopes.map { AgentStreamEvent(envelope: $0) })
    }

    public static func reduce(activityEvents: [AgentTaskActivityEvent]) -> AgentTaskProjection {
        reduce(streamEvents: activityEvents.map { AgentStreamEvent(activityEvent: $0) })
    }

    public static func reduce(streamEvents rawEvents: [AgentStreamEvent]) -> AgentTaskProjection {
        let events = deduplicated(rawEvents)
        let grouped = Dictionary(grouping: events, by: \.taskID)
        let tasks = grouped.map { taskID, taskEvents in
            reduce(taskID: taskID, streamEvents: taskEvents)
        }
        return AgentTaskProjection(tasks: tasks)
    }

    public static func reduce(taskID: UUID, streamEvents rawEvents: [AgentStreamEvent]) -> AgentTaskProjectionSnapshot {
        let events = deduplicated(rawEvents).filter { $0.taskID == taskID }
        let grouped = Dictionary(grouping: events, by: \.runID)
        var firstSeenIndexByRunID: [UUID: Int] = [:]
        for (index, event) in events.enumerated() where firstSeenIndexByRunID[event.runID] == nil {
            firstSeenIndexByRunID[event.runID] = index
        }
        let runs = grouped.map { _, runEvents in
            reduceRun(streamEvents: runEvents)
        }.sorted {
            (firstSeenIndexByRunID[$0.runID] ?? Int.max) < (firstSeenIndexByRunID[$1.runID] ?? Int.max)
        }
        return AgentTaskProjectionSnapshot(taskID: taskID, runs: runs)
    }

    public static func reduceRun(streamEvents rawEvents: [AgentStreamEvent]) -> AgentRunProjection {
        let sorted = rawEvents.enumerated().sorted { lhs, rhs in
            let left = lhs.element
            let right = rhs.element
            if left.runID == right.runID,
               left.source == right.source,
               left.sequence != right.sequence {
                return left.sequence < right.sequence
            }
            if left.timestamp != right.timestamp {
                return left.timestamp < right.timestamp
            }
            if left.sequence != right.sequence {
                return left.sequence < right.sequence
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
        guard let first = sorted.first else {
            let id = UUID()
            return AgentRunProjection(taskID: id,
                                      runID: id,
                                      state: .unknown,
                                      events: [],
                                      createdAt: .distantPast,
                                      updatedAt: .distantPast)
        }

        var accepted: [AgentStreamEvent] = []
        var seenEventIDs = Set<UUID>()
        var state = AgentRunState.queued
        var conversationID: UUID?
        var userMessageID: UUID?
        var assistantMessageID: UUID?
        var currentStepTitle: String?
        var terminalSummary: String?
        var completedAt: Date?
        var failureCategory: String?
        var resultDocument: AgentResultDocument?

        for event in sorted {
            guard event.taskID == first.taskID, event.runID == first.runID else { continue }
            guard seenEventIDs.insert(event.id).inserted else { continue }
            guard isLegal(event.kind, from: state) else { continue }

            accepted.append(event)
            conversationID = conversationID ?? event.conversationID
            userMessageID = userMessageID ?? event.userMessageID
            assistantMessageID = assistantMessageID ?? event.assistantMessageID

            let metadata = AgentStreamProjectionMetadata(event: event)
            if let title = metadata.currentStepTitle {
                currentStepTitle = title
            }
            if metadata.clearsCurrentStep {
                currentStepTitle = nil
            }
            terminalSummary = metadata.terminalSummary ?? terminalSummary
            failureCategory = metadata.failureCategory ?? failureCategory
            resultDocument = metadata.resultDocument ?? resultDocument

            state = nextState(after: event.kind, current: state)
            if state.isTerminal, completedAt == nil {
                completedAt = event.timestamp
                currentStepTitle = nil
            }
        }

        return AgentRunProjection(taskID: first.taskID,
                                  runID: first.runID,
                                  conversationID: conversationID,
                                  userMessageID: userMessageID,
                                  assistantMessageID: assistantMessageID,
                                  state: state,
                                  events: accepted,
                                  createdAt: accepted.first?.timestamp ?? first.timestamp,
                                  updatedAt: accepted.last?.timestamp ?? first.timestamp,
                                  completedAt: completedAt,
                                  currentStepTitle: currentStepTitle,
                                  terminalSummary: terminalSummary,
                                  failureCategory: failureCategory,
                                  resultDocument: resultDocument)
    }

    public static func isLegal(_ kind: AgentStreamEventKind, from state: AgentRunState) -> Bool {
        if state.isTerminal {
            return [.uiInteractionResolved, .resultPatch].contains(kind)
        }
        switch state {
        case .awaitingApproval:
            return [.toolApprovalGranted, .toolApprovalDenied, .toolStarted, .taskCancelled,
                    .taskFailed, .userInputCancelled].contains(kind)
        case .awaitingPermission:
            return [.toolApprovalGranted, .toolApprovalDenied, .toolStarted, .taskCancelled,
                    .taskFailed, .userInputCancelled].contains(kind)
        case .awaitingUserInput:
            return [.userInputReceived, .userInputCancelled, .userInputTimedOut, .taskCancelled,
                    .taskFailed].contains(kind)
        case .created:
            return kind != .taskCompleted && kind != .taskPartiallyCompleted
        case .queued, .preparing, .understanding, .planning, .running, .streaming,
             .executingTool, .verifying, .recovering, .unknown:
            return true
        case .succeeded, .partiallySucceeded, .failed, .cancelled, .interrupted:
            return false
        }
    }

    public static func nextState(after kind: AgentStreamEventKind,
                                 current: AgentRunState) -> AgentRunState {
        if current.isTerminal, [.uiInteractionResolved, .resultPatch].contains(kind) {
            return current
        }
        switch kind {
        case .taskCreated:
            return .created
        case .taskQueued:
            return .queued
        case .taskStarted:
            return current == .unknown ? .preparing : .preparing
        case .agentSelected, .agentDelegated:
            return .planning
        case .modelRequestStarted:
            return .understanding
        case .modelDelta:
            return .streaming
        case .modelReasoningDeltaHidden, .modelToolCallDelta:
            return current == .unknown ? .understanding : current
        case .modelResponseCompleted:
            return .verifying
        case .modelRequestFailed:
            return .failed
        case .toolCallProposed, .toolValidated, .toolValidationFailed:
            return .planning
        case .toolApprovalRequired:
            return .awaitingApproval
        case .toolApprovalGranted:
            return .running
        case .toolApprovalDenied:
            return .failed
        case .toolStarted, .toolProgress:
            return .executingTool
        case .toolObservation, .toolCompleted:
            return .running
        case .toolFailed:
            return .failed
        case .toolCancelled:
            return .cancelled
        case .providerRequestStarted, .providerResponseReceived:
            return .understanding
        case .providerRateLimited, .providerAuthenticationFailed, .providerUnavailable, .providerRequestFailed:
            return .failed
        case .userInputRequested, .uiInteractionRequested:
            return .awaitingUserInput
        case .userInputReceived, .uiInteractionResolved:
            return .running
        case .userInputCancelled:
            return .cancelled
        case .userInputTimedOut:
            return .failed
        case .resultSnapshot, .resultPatch, .verifierStarted, .criticStarted:
            return .verifying
        case .verifierCompleted, .criticCompleted:
            return current == .unknown ? .verifying : current
        case .verifierFailed:
            return current == .unknown ? .verifying : current
        case .recoveryStarted:
            return .recovering
        case .recoverySucceeded:
            return .running
        case .recoveryFailed:
            return .failed
        case .taskCheckpointed, .warning, .diagnostic, .unknown:
            return current
        case .taskCompleted:
            return .succeeded
        case .taskPartiallyCompleted:
            return .partiallySucceeded
        case .taskFailed:
            return .failed
        case .taskCancelled:
            return .cancelled
        case .taskInterrupted:
            return .interrupted
        case .taskWaitingForRetry:
            return .recovering
        case .taskRecovered:
            return .recovering
        }
    }

    private static func deduplicated(_ events: [AgentStreamEvent]) -> [AgentStreamEvent] {
        var seen = Set<UUID>()
        var result: [AgentStreamEvent] = []
        for event in events where seen.insert(event.id).inserted {
            result.append(event)
        }
        return result
    }
}

public extension AgentStreamEventKind {
    init(eventKind: AgentEventKind, payload: AgentEventPayload = .empty) {
        switch eventKind {
        case .taskCreated:
            self = .taskCreated
        case .taskQueued:
            self = .taskQueued
        case .taskStarted, .runStarted, .runRetryStarted:
            self = .taskStarted
        case .taskPaused:
            self = .taskInterrupted
        case .taskResumed:
            self = .taskStarted
        case .taskSucceeded, .runCompleted:
            self = .taskCompleted
        case .taskPartiallySucceeded:
            self = .taskPartiallyCompleted
        case .taskFailed, .runFailed:
            self = .taskFailed
        case .taskCancelled, .runCancelled:
            self = .taskCancelled
        case .taskInterrupted:
            self = .taskInterrupted
        case .taskWaitingForRetry:
            self = .taskInterrupted
        case .taskRecovered:
            self = .taskStarted
        case .stepStarted, .toolRequested:
            self = .toolCallProposed
        case .stepProgress:
            self = .toolProgress
        case .stepSucceeded, .observationDeliveredToModel:
            self = .toolCompleted
        case .stepFailed:
            self = .toolFailed
        case .stepSkipped:
            self = .warning
        case .modelRequestStarted:
            self = .modelRequestStarted
        case .modelResponseStreaming:
            self = .modelDelta
        case .modelResponseCompleted:
            self = .modelResponseCompleted
        case .modelRequestFailed:
            self = .modelRequestFailed
        case .toolValidated:
            self = .toolValidated
        case .toolValidationFailed:
            self = .toolValidationFailed
        case .toolPermissionRequired:
            self = .toolApprovalRequired
        case .toolPermissionGranted:
            self = .toolApprovalGranted
        case .toolPermissionDenied:
            self = .toolApprovalDenied
        case .toolStarted:
            self = .toolStarted
        case .toolProgress:
            self = .toolProgress
        case .toolSucceeded:
            self = .toolCompleted
        case .toolFailed:
            self = .toolFailed
        case .toolCancelled:
            self = .toolCancelled
        case .observationProduced:
            self = .toolObservation
        case .waitingForUser:
            self = .userInputRequested
        case .userActionReceived:
            self = .userInputReceived
        case .userActionCancelled:
            self = .userInputCancelled
        case .userActionTimedOut:
            self = .userInputTimedOut
        case .providerRequestStarted:
            self = .providerRequestStarted
        case .providerResponseReceived:
            self = .providerResponseReceived
        case .providerRateLimited:
            self = .providerRateLimited
        case .providerAuthenticationFailed:
            self = .providerAuthenticationFailed
        case .providerUnavailable:
            self = .providerUnavailable
        case .providerRequestFailed:
            self = .providerRequestFailed
        case .verificationStarted:
            self = .verifierStarted
        case .verificationSucceeded:
            self = .verifierCompleted
        case .verificationFailed:
            self = .verifierFailed
        case .recoveryStarted:
            self = .recoveryStarted
        case .recoverySucceeded:
            self = .recoverySucceeded
        case .recoveryFailed:
            self = .recoveryFailed
        case .resultSnapshot:
            self = .resultSnapshot
        case .resultPatch:
            self = .resultPatch
        case .uiInteractionRequested:
            self = .uiInteractionRequested
        case .uiInteractionResolved:
            self = .uiInteractionResolved
        case .resultProduced:
            self = payload.isResultPatch ? .resultPatch : .resultSnapshot
        case .warning:
            self = .warning
        case .diagnostic:
            self = .diagnostic
        case .unknown:
            self = .unknown
        }
    }
}

public extension AgentEventKind {
    init(streamKind: AgentStreamEventKind) {
        switch streamKind {
        case .taskCreated:
            self = .taskCreated
        case .taskQueued:
            self = .taskQueued
        case .taskStarted:
            self = .taskStarted
        case .taskCheckpointed:
            self = .diagnostic
        case .taskCompleted:
            self = .taskSucceeded
        case .taskPartiallyCompleted:
            self = .taskPartiallySucceeded
        case .taskFailed:
            self = .taskFailed
        case .taskCancelled:
            self = .taskCancelled
        case .taskInterrupted:
            self = .taskInterrupted
        case .taskWaitingForRetry:
            self = .taskInterrupted
        case .taskRecovered:
            self = .taskResumed
            self = .taskInterrupted
        case .modelRequestStarted:
            self = .modelRequestStarted
        case .modelDelta, .modelReasoningDeltaHidden, .modelToolCallDelta:
            self = .modelResponseStreaming
        case .modelResponseCompleted:
            self = .modelResponseCompleted
        case .modelRequestFailed:
            self = .modelRequestFailed
        case .toolCallProposed:
            self = .toolRequested
        case .toolValidated:
            self = .toolValidated
        case .toolValidationFailed:
            self = .toolValidationFailed
        case .toolApprovalRequired:
            self = .toolPermissionRequired
        case .toolApprovalGranted:
            self = .toolPermissionGranted
        case .toolApprovalDenied:
            self = .toolPermissionDenied
        case .toolStarted:
            self = .toolStarted
        case .toolProgress:
            self = .toolProgress
        case .toolObservation:
            self = .observationProduced
        case .toolCompleted:
            self = .toolSucceeded
        case .toolFailed:
            self = .toolFailed
        case .toolCancelled:
            self = .toolCancelled
        case .providerRequestStarted:
            self = .providerRequestStarted
        case .providerResponseReceived:
            self = .providerResponseReceived
        case .providerRateLimited:
            self = .providerRateLimited
        case .providerAuthenticationFailed:
            self = .providerAuthenticationFailed
        case .providerUnavailable:
            self = .providerUnavailable
        case .providerRequestFailed:
            self = .providerRequestFailed
        case .userInputRequested:
            self = .waitingForUser
        case .userInputReceived:
            self = .userActionReceived
        case .uiInteractionRequested:
            self = .uiInteractionRequested
        case .uiInteractionResolved:
            self = .uiInteractionResolved
        case .userInputCancelled:
            self = .userActionCancelled
        case .userInputTimedOut:
            self = .userActionTimedOut
        case .resultSnapshot, .resultPatch:
            self = .resultProduced
        case .recoveryStarted:
            self = .recoveryStarted
        case .recoverySucceeded:
            self = .recoverySucceeded
        case .recoveryFailed:
            self = .recoveryFailed
        case .agentSelected, .agentDelegated, .criticStarted, .criticCompleted, .warning:
            self = .warning
        case .verifierStarted:
            self = .verificationStarted
        case .verifierCompleted:
            self = .verificationSucceeded
        case .verifierFailed:
            self = .verificationFailed
        case .diagnostic:
            self = .diagnostic
        case .unknown:
            self = .unknown
        }
    }
}

private struct AgentStreamProjectionMetadata {
    var conversationID: UUID?
    var userMessageID: UUID?
    var currentStepTitle: String?
    var clearsCurrentStep: Bool
    var terminalSummary: String?
    var failureCategory: String?
    var resultDocument: AgentResultDocument?

    init(envelope: AgentEventEnvelope) {
        self.init(event: AgentStreamEvent(schemaVersion: envelope.schemaVersion,
                                          id: envelope.id,
                                          taskID: envelope.taskID,
                                          runID: envelope.runID,
                                          sequence: envelope.sequence,
                                          timestamp: envelope.timestamp,
                                          source: envelope.source,
                                          visibility: envelope.visibility,
                                          kind: AgentStreamEventKind(eventKind: envelope.kind, payload: envelope.payload),
                                          payload: envelope.payload))
    }

    init(event: AgentStreamEvent) {
        conversationID = event.conversationID
        userMessageID = event.userMessageID
        currentStepTitle = nil
        clearsCurrentStep = false
        terminalSummary = nil
        failureCategory = nil
        resultDocument = nil

        switch event.payload {
        case .activity(let payload):
            conversationID = conversationID ?? payload.conversationID
            userMessageID = userMessageID ?? payload.userMessageID
            currentStepTitle = payload.title
            failureCategory = payload.failureCategory
        case .task(let payload):
            conversationID = conversationID ?? payload.conversationID
            userMessageID = userMessageID ?? payload.userMessageID
            currentStepTitle = payload.currentStep
            terminalSummary = terminalTitleIfNeeded(kind: event.kind, fallback: payload.title)
            failureCategory = payload.status
        case .step(let payload):
            currentStepTitle = payload.title
        case .tool(let payload):
            currentStepTitle = payload.displayName
            failureCategory = payload.errorCategory
        case .model(let payload):
            currentStepTitle = payload.safeSummary
            failureCategory = payload.finishReason
        case .provider(let payload):
            failureCategory = payload.errorCategory
        case .permission(let payload):
            currentStepTitle = payload.safeReason
            failureCategory = payload.decision == "denied" ? "permissionDenied" : nil
        case .userAction(let payload):
            currentStepTitle = payload.safeSummary ?? payload.action
        case .result(let payload):
            terminalSummary = payload.summary
            resultDocument = payload.document
        case .failure(let payload):
            currentStepTitle = payload.safeSummary
            terminalSummary = payload.safeSummary
            failureCategory = payload.category
        case .diagnostic(let payload):
            currentStepTitle = payload.safeSummary
        case .run(let payload):
            terminalSummary = terminalTitleIfNeeded(kind: event.kind, fallback: payload.reason ?? event.kind.rawValue)
        case .empty:
            break
        }

        switch event.kind {
        case .toolCompleted, .toolFailed, .toolCancelled, .taskCompleted, .taskPartiallyCompleted,
             .taskFailed, .taskCancelled, .taskInterrupted:
            clearsCurrentStep = true
        default:
            break
        }
        terminalSummary = terminalSummary ?? terminalTitleIfNeeded(kind: event.kind, fallback: nil)
    }

    private func terminalTitleIfNeeded(kind: AgentStreamEventKind, fallback: String?) -> String? {
        switch kind {
        case .taskCompleted:
            return fallback ?? "任务已完成"
        case .taskPartiallyCompleted:
            return fallback ?? "任务部分完成"
        case .taskFailed:
            return fallback ?? "任务失败"
        case .taskCancelled:
            return fallback ?? "任务已取消"
        case .taskInterrupted:
            return fallback ?? "任务被中断"
        case .taskWaitingForRetry:
            return fallback ?? "等待重试"
        case .taskRecovered:
            return fallback ?? "任务已恢复"
        default:
            return nil
        }
    }
}

private extension AgentEventPayload {
    var isResultPatch: Bool {
        guard case .result(let payload) = self else { return false }
        if payload.eventKind == .patch { return true }
        if payload.eventKind == .snapshot { return false }
        return payload.document.status == .partial
    }
}
