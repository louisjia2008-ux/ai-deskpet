import Foundation
import AICore

public enum AgentEventSource: String, Codable, Sendable, Hashable, CaseIterable {
    case chat
    case runtime
    case agentLoop
    case toolRuntime
    case permissionGate
    case provider
    case scheduler
    case replay
    case system
}

public enum AgentEventVisibility: String, Codable, Sendable, Hashable, CaseIterable {
    case user
    case developer
    case diagnostic
    case hidden
}

public enum AgentEventKind: String, Codable, Sendable, Hashable, CaseIterable {
    case taskCreated
    case taskQueued
    case taskStarted
    case taskPaused
    case taskResumed
    case taskSucceeded
    case taskPartiallySucceeded
    case taskFailed
    case taskCancelled
    case taskInterrupted
    case taskWaitingForRetry
    case taskRecovered

    case runStarted
    case runRetryStarted
    case runCompleted
    case runFailed
    case runCancelled

    case stepStarted
    case stepProgress
    case stepSucceeded
    case stepFailed
    case stepSkipped

    case modelRequestStarted
    case modelResponseStreaming
    case modelResponseCompleted
    case modelRequestFailed

    case toolRequested
    case toolValidated
    case toolValidationFailed
    case toolPermissionRequired
    case toolPermissionGranted
    case toolPermissionDenied
    case toolStarted
    case toolProgress
    case toolSucceeded
    case toolFailed
    case toolCancelled
    case observationProduced
    case observationDeliveredToModel

    case waitingForUser
    case userActionReceived
    case userActionCancelled
    case userActionTimedOut

    case providerRequestStarted
    case providerResponseReceived
    case providerRateLimited
    case providerAuthenticationFailed
    case providerUnavailable
    case providerRequestFailed

    case warning
    case diagnostic
    case verificationStarted
    case verificationSucceeded
    case verificationFailed
    case recoveryStarted
    case recoverySucceeded
    case recoveryFailed
    case resultSnapshot
    case resultPatch
    case uiInteractionRequested
    case uiInteractionResolved
    case resultProduced

    case unknown
}

public struct AgentEventEnvelope: Codable, Sendable, Identifiable, Hashable {
    public var schemaVersion: Int
    public var id: UUID
    public var taskID: UUID
    public var runID: UUID
    public var sequence: UInt64
    public var timestamp: Date
    public var source: AgentEventSource
    public var visibility: AgentEventVisibility
    public var parentEventID: UUID?
    public var kind: AgentEventKind
    public var payload: AgentEventPayload

    public init(schemaVersion: Int = 1,
                id: UUID = UUID(),
                taskID: UUID,
                runID: UUID,
                sequence: UInt64,
                timestamp: Date = Date(),
                source: AgentEventSource,
                visibility: AgentEventVisibility = .user,
                parentEventID: UUID? = nil,
                kind: AgentEventKind,
                payload: AgentEventPayload = .empty) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.taskID = taskID
        self.runID = runID
        self.sequence = sequence
        self.timestamp = timestamp
        self.source = source
        self.visibility = visibility
        self.parentEventID = parentEventID
        self.kind = kind
        self.payload = payload
    }
}

public enum AgentEventPayload: Codable, Sendable, Hashable {
    case empty
    case activity(ActivityPayload)
    case task(TaskPayload)
    case run(RunPayload)
    case step(StepPayload)
    case model(ModelPayload)
    case tool(ToolPayload)
    case permission(PermissionPayload)
    case provider(ProviderPayload)
    case userAction(UserActionPayload)
    case result(ResultPayload)
    case failure(FailurePayload)
    case diagnostic(DiagnosticPayload)

    public struct ActivityPayload: Codable, Sendable, Hashable {
        public var title: String
        public var detail: String?
        public var stepID: String?
        public var toolID: String?
        public var failureCategory: String?
        public var conversationID: UUID?
        public var userMessageID: UUID?
        public var origin: String?
        public var providerKind: String?
        public var modelID: String?
        public var scheduleID: UUID?

        public init(title: String,
                    detail: String? = nil,
                    stepID: String? = nil,
                    toolID: String? = nil,
                    failureCategory: String? = nil,
                    conversationID: UUID? = nil,
                    userMessageID: UUID? = nil,
                    origin: String? = nil,
                    providerKind: String? = nil,
                    modelID: String? = nil,
                    scheduleID: UUID? = nil) {
            self.title = title
            self.detail = detail
            self.stepID = stepID
            self.toolID = toolID
            self.failureCategory = failureCategory
            self.conversationID = conversationID
            self.userMessageID = userMessageID
            self.origin = origin
            self.providerKind = providerKind
            self.modelID = modelID
            self.scheduleID = scheduleID
        }
    }

    public struct TaskPayload: Codable, Sendable, Hashable {
        public var title: String
        public var status: String?
        public var currentStep: String?
        public var retryCount: Int?
        public var conversationID: UUID?
        public var userMessageID: UUID?
        public var origin: String?
        public var providerKind: String?
        public var modelID: String?
        public var scheduleID: UUID?

        public init(title: String,
                    status: String? = nil,
                    currentStep: String? = nil,
                    retryCount: Int? = nil,
                    conversationID: UUID? = nil,
                    userMessageID: UUID? = nil,
                    origin: String? = nil,
                    providerKind: String? = nil,
                    modelID: String? = nil,
                    scheduleID: UUID? = nil) {
            self.title = title
            self.status = status
            self.currentStep = currentStep
            self.retryCount = retryCount
            self.conversationID = conversationID
            self.userMessageID = userMessageID
            self.origin = origin
            self.providerKind = providerKind
            self.modelID = modelID
            self.scheduleID = scheduleID
        }
    }

    public struct RunPayload: Codable, Sendable, Hashable {
        public var attempt: Int?
        public var retryOfRunID: UUID?
        public var reason: String?

        public init(attempt: Int? = nil,
                    retryOfRunID: UUID? = nil,
                    reason: String? = nil) {
            self.attempt = attempt
            self.retryOfRunID = retryOfRunID
            self.reason = reason
        }
    }

    public struct StepPayload: Codable, Sendable, Hashable {
        public var stepID: String
        public var title: String
        public var progress: Double?
        public var safeSummary: String?

        public init(stepID: String,
                    title: String,
                    progress: Double? = nil,
                    safeSummary: String? = nil) {
            self.stepID = stepID
            self.title = title
            self.progress = progress
            self.safeSummary = safeSummary
        }
    }

    public struct ModelPayload: Codable, Sendable, Hashable {
        public var provider: String?
        public var modelID: String?
        public var safeSummary: String?
        public var finishReason: String?

        public init(provider: String? = nil,
                    modelID: String? = nil,
                    safeSummary: String? = nil,
                    finishReason: String? = nil) {
            self.provider = provider
            self.modelID = modelID
            self.safeSummary = safeSummary
            self.finishReason = finishReason
        }
    }

    public struct ToolPayload: Codable, Sendable, Hashable {
        public var toolID: String
        public var toolCallID: String?
        public var toolExecutionID: UUID?
        public var displayName: String
        public var safeSummary: String?
        public var riskLevel: String?
        public var duration: TimeInterval?
        public var resultCategory: String?
        public var errorCategory: String?
        public var recoverable: Bool?
        public var retryable: Bool?

        public init(toolID: String,
                    toolCallID: String? = nil,
                    toolExecutionID: UUID? = nil,
                    displayName: String,
                    safeSummary: String? = nil,
                    riskLevel: String? = nil,
                    duration: TimeInterval? = nil,
                    resultCategory: String? = nil,
                    errorCategory: String? = nil,
                    recoverable: Bool? = nil,
                    retryable: Bool? = nil) {
            self.toolID = toolID
            self.toolCallID = toolCallID
            self.toolExecutionID = toolExecutionID
            self.displayName = displayName
            self.safeSummary = safeSummary
            self.riskLevel = riskLevel
            self.duration = duration
            self.resultCategory = resultCategory
            self.errorCategory = errorCategory
            self.recoverable = recoverable
            self.retryable = retryable
        }
    }

    public struct PermissionPayload: Codable, Sendable, Hashable {
        public var capabilityID: String
        public var decision: String?
        public var safeReason: String?

        public init(capabilityID: String,
                    decision: String? = nil,
                    safeReason: String? = nil) {
            self.capabilityID = capabilityID
            self.decision = decision
            self.safeReason = safeReason
        }
    }

    public struct ProviderPayload: Codable, Sendable, Hashable {
        public var providerID: String?
        public var providerKind: String?
        public var modelID: String?
        public var httpStatus: Int?
        public var errorCategory: String?
        public var retryAfter: TimeInterval?
        public var safeSummary: String?

        public init(providerID: String? = nil,
                    providerKind: String? = nil,
                    modelID: String? = nil,
                    httpStatus: Int? = nil,
                    errorCategory: String? = nil,
                    retryAfter: TimeInterval? = nil,
                    safeSummary: String? = nil) {
            self.providerID = providerID
            self.providerKind = providerKind
            self.modelID = modelID
            self.httpStatus = httpStatus
            self.errorCategory = errorCategory
            self.retryAfter = retryAfter
            self.safeSummary = safeSummary
        }
    }

    public struct UserActionPayload: Codable, Sendable, Hashable {
        public var action: String
        public var safeSummary: String?
        public var componentID: String?
        public var actionID: String?
        public var documentID: String?
        public var payload: AgentJSONValue?

        public init(action: String,
                    safeSummary: String? = nil,
                    componentID: String? = nil,
                    actionID: String? = nil,
                    documentID: String? = nil,
                    payload: AgentJSONValue? = nil) {
            self.action = AgentEventRedactor.safeIdentifier(action)
            self.safeSummary = safeSummary.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
            self.componentID = componentID.map(AgentEventRedactor.safeIdentifier)
            self.actionID = actionID.map(AgentEventRedactor.safeIdentifier)
            self.documentID = documentID.map(AgentEventRedactor.safeIdentifier)
            self.payload = payload?.sanitized()
        }
    }

    public struct ResultPayload: Codable, Sendable, Hashable {
        public var title: String
        public var summary: String
        public var document: AgentResultDocument
        public var eventKind: AgentResultEventKind?
        public var baseRevision: Int?

        public init(title: String,
                    summary: String,
                    document: AgentResultDocument,
                    eventKind: AgentResultEventKind? = nil,
                    baseRevision: Int? = nil) {
            self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "结果已生成")
            self.summary = AgentPrivacyRedactor.safeText(summary, maxLength: 1_000).text
            self.document = document
            self.eventKind = eventKind
            self.baseRevision = baseRevision.map { max(0, $0) }
        }
    }

    public struct FailurePayload: Codable, Sendable, Hashable {
        public var phase: String
        public var category: String
        public var safeSummary: String
        public var recoverable: Bool
        public var retryable: Bool

        public init(phase: String,
                    category: String,
                    safeSummary: String,
                    recoverable: Bool,
                    retryable: Bool) {
            self.phase = phase
            self.category = category
            self.safeSummary = safeSummary
            self.recoverable = recoverable
            self.retryable = retryable
        }
    }

    public struct DiagnosticPayload: Codable, Sendable, Hashable {
        public var category: String
        public var safeSummary: String
        public var details: [String: String]

        public init(category: String,
                    safeSummary: String,
                    details: [String: String] = [:]) {
            self.category = category
            self.safeSummary = safeSummary
            self.details = details
        }
    }
}

public enum AgentEventRedactionLevel: String, Codable, Sendable, Hashable, CaseIterable {
    case normal
    case developer
    case diagnostic
}

public enum AgentEventRedactor {
    public static func redact(_ envelope: AgentEventEnvelope,
                              level: AgentEventRedactionLevel = .normal) -> AgentEventEnvelope {
        var copy = envelope
        copy.payload = redact(copy.payload, level: level)
        if copy.visibility == .hidden, level == .normal {
            copy.payload = .diagnostic(.init(category: "hidden", safeSummary: "内部事件已隐藏"))
        }
        return copy
    }

    public static func redact(_ payload: AgentEventPayload,
                              level: AgentEventRedactionLevel = .normal) -> AgentEventPayload {
        switch payload {
        case .empty:
            return .empty
        case .activity(var value):
            value.title = safeText(value.title)
            value.detail = value.detail.map { safeText($0) }
            value.stepID = value.stepID.map(safeIdentifier)
            value.toolID = value.toolID.map(safeIdentifier)
            value.failureCategory = value.failureCategory.map(safeIdentifier)
            value.origin = value.origin.map(safeIdentifier)
            value.providerKind = value.providerKind.map(safeIdentifier)
            value.modelID = value.modelID.map(safeIdentifier)
            return .activity(value)
        case .task(var value):
            value.title = safeText(value.title)
            value.status = value.status.map(safeIdentifier)
            value.currentStep = value.currentStep.map { safeText($0) }
            value.origin = value.origin.map(safeIdentifier)
            value.providerKind = value.providerKind.map(safeIdentifier)
            value.modelID = value.modelID.map(safeIdentifier)
            return .task(value)
        case .run(var value):
            value.reason = value.reason.map { safeText($0) }
            return .run(value)
        case .step(var value):
            value.stepID = safeIdentifier(value.stepID)
            value.title = safeText(value.title)
            value.safeSummary = value.safeSummary.map { safeText($0) }
            return .step(value)
        case .model(var value):
            value.provider = value.provider.map(safeIdentifier)
            value.modelID = value.modelID.map(safeIdentifier)
            value.safeSummary = value.safeSummary.map { safeText($0) }
            value.finishReason = value.finishReason.map(safeIdentifier)
            return .model(value)
        case .tool(var value):
            value.toolID = safeIdentifier(value.toolID)
            value.toolCallID = value.toolCallID.map(safeIdentifier)
            value.displayName = safeText(value.displayName)
            value.safeSummary = value.safeSummary.map { safeText($0) }
            value.riskLevel = value.riskLevel.map(safeIdentifier)
            value.resultCategory = value.resultCategory.map(safeIdentifier)
            value.errorCategory = value.errorCategory.map(safeIdentifier)
            return .tool(value)
        case .permission(var value):
            value.capabilityID = safeIdentifier(value.capabilityID)
            value.decision = value.decision.map(safeIdentifier)
            value.safeReason = value.safeReason.map { safeText($0) }
            return .permission(value)
        case .provider(var value):
            value.providerID = value.providerID.map(safeIdentifier)
            value.providerKind = value.providerKind.map(safeIdentifier)
            value.modelID = value.modelID.map(safeIdentifier)
            value.errorCategory = value.errorCategory.map(safeIdentifier)
            value.safeSummary = value.safeSummary.map { safeText($0) }
            return .provider(value)
        case .userAction(var value):
            value.action = safeIdentifier(value.action)
            value.safeSummary = value.safeSummary.map { safeText($0) }
            value.componentID = value.componentID.map(safeIdentifier)
            value.actionID = value.actionID.map(safeIdentifier)
            value.documentID = value.documentID.map(safeIdentifier)
            value.payload = value.payload?.sanitized()
            return .userAction(value)
        case .result(var value):
            value.title = safeText(value.title)
            value.summary = safeText(value.summary, maxLength: 1_000)
            value.baseRevision = value.baseRevision.map { max(0, $0) }
            return .result(value)
        case .failure(var value):
            value.phase = safeIdentifier(value.phase)
            value.category = safeIdentifier(value.category)
            value.safeSummary = safeText(value.safeSummary)
            return .failure(value)
        case .diagnostic(var value):
            value.category = safeIdentifier(value.category)
            value.safeSummary = safeText(value.safeSummary)
            value.details = value.details.reduce(into: [:]) { partial, item in
                let safeKey = safeIdentifier(item.key)
                let loweredKey = item.key.lowercased()
                if loweredKey.contains("cookie")
                    || loweredKey.contains("authorization")
                    || loweredKey.contains("api")
                    || loweredKey.contains("token")
                    || loweredKey.contains("secret")
                    || loweredKey.contains("password") {
                    partial[safeKey] = "[redacted]"
                } else {
                    partial[safeKey] = safeText(item.value, maxLength: level == .diagnostic ? 512 : 180)
                }
            }
            return .diagnostic(value)
        }
    }

    public static func safeIdentifier(_ raw: String) -> String {
        let redacted = safeText(raw, maxLength: 96)
        let allowed = redacted.unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-" || scalar == "." || scalar == ":" {
                return Character(scalar)
            }
            return "_"
        }
        let value = String(allowed).trimmingCharacters(in: CharacterSet(charactersIn: "._-:"))
        return value.isEmpty ? "redacted" : value
    }

    public static func safeText(_ raw: String, maxLength: Int = 240) -> String {
        var text = raw
        let replacements: [(String, String)] = [
            (#"sk-[A-Za-z0-9_\-]{8,}"#, "[redacted-api-key]"),
            (#"(?i)Bearer\s+[A-Za-z0-9._\-+/=]{8,}"#, "Bearer [redacted]"),
            (#"(?i)Authorization\s*[:=]\s*[^\s,;]+"#, "Authorization [redacted]"),
            (#"(?i)(api[_-]?key|apiKey|token|secret|password)\s*[:=]\s*["']?[^"',\s;]+"#, "$1=[redacted]"),
            (#"(?i)(Cookie|Set-Cookie)\s*[:=]\s*[^\n]+"#, "$1 [redacted]"),
            (#"(?i)reasoning_content\s*[:=]\s*[^\n]+"#, "reasoning_content [redacted]"),
            (#"(?i)chain[- ]of[- ]thought\s*[:=]?\s*[^\n]*"#, "reasoning [redacted]"),
            (#"(?i)Keychain secret[^\n]*"#, "Keychain secret [redacted]"),
            (#"/Users/[^/\s]+(/[^\s,;]*)?"#, "[redacted-user-path]"),
            (#"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, "[redacted-email]"),
        ]
        for (pattern, replacement) in replacements {
            text = replace(pattern: pattern, in: text, with: replacement)
        }
        let lowered = text.lowercased()
        if lowered.contains("reasoning_content") || lowered.contains("chain-of-thought") || lowered.contains("思维链") {
            text = "reasoning [redacted]"
        }
        if text.count > maxLength {
            text = String(text.prefix(maxLength)) + "..."
        }
        return text
    }

    private static func replace(pattern: String, in input: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return input
        }
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        return regex.stringByReplacingMatches(in: input, range: range, withTemplate: replacement)
    }
}

public struct AgentEventFilter: Sendable, Hashable {
    public var taskID: UUID?
    public var runID: UUID?
    public var minimumVisibility: AgentEventVisibility?
    public var includeHidden: Bool

    public init(taskID: UUID? = nil,
                runID: UUID? = nil,
                minimumVisibility: AgentEventVisibility? = nil,
                includeHidden: Bool = false) {
        self.taskID = taskID
        self.runID = runID
        self.minimumVisibility = minimumVisibility
        self.includeHidden = includeHidden
    }

    public func matches(_ event: AgentEventEnvelope) -> Bool {
        if let taskID, event.taskID != taskID { return false }
        if let runID, event.runID != runID { return false }
        if event.visibility == .hidden, !includeHidden { return false }
        if let minimumVisibility {
            return event.visibility.rank <= minimumVisibility.rank
        }
        return true
    }
}

public struct AgentEventSnapshot: Sendable, Hashable {
    public var taskID: UUID
    public var latestRunID: UUID?
    public var latestKind: AgentEventKind?
    public var eventCount: Int
    public var updatedAt: Date?

    public init(taskID: UUID,
                latestRunID: UUID?,
                latestKind: AgentEventKind?,
                eventCount: Int,
                updatedAt: Date?) {
        self.taskID = taskID
        self.latestRunID = latestRunID
        self.latestKind = latestKind
        self.eventCount = eventCount
        self.updatedAt = updatedAt
    }
}

public actor AgentEventHub {
    private struct Subscriber {
        var filter: AgentEventFilter
        var continuation: AsyncStream<AgentEventEnvelope>.Continuation
    }

    private let maxRecentEvents: Int
    private let maxSubscriberBuffer: Int
    private var events: [AgentEventEnvelope] = []
    private var seenEventIDs: Set<UUID> = []
    private var lastSequenceByRunID: [UUID: UInt64] = [:]
    private var subscribers: [UUID: Subscriber] = [:]

    public init(maxRecentEvents: Int = 2_000,
                maxSubscriberBuffer: Int = 256) {
        self.maxRecentEvents = max(1, maxRecentEvents)
        self.maxSubscriberBuffer = max(1, maxSubscriberBuffer)
    }

    @discardableResult
    public func publish(_ event: AgentEventEnvelope) -> Bool {
        let safe = AgentEventRedactor.redact(event, level: .diagnostic)
        guard seenEventIDs.insert(safe.id).inserted else { return false }
        if let last = lastSequenceByRunID[safe.runID], safe.sequence <= last {
            #if DEBUG
            let diagnostic = AgentEventEnvelope(
                taskID: safe.taskID,
                runID: safe.runID,
                sequence: last + 1,
                timestamp: safe.timestamp,
                source: .system,
                visibility: .diagnostic,
                kind: .diagnostic,
                payload: .diagnostic(.init(category: "sequence",
                                           safeSummary: "Agent event sequence did not advance",
                                           details: [
                                            "previous": "\(last)",
                                            "incoming": "\(safe.sequence)"
                                           ])))
            events.append(diagnostic)
            #endif
        }
        lastSequenceByRunID[safe.runID] = max(lastSequenceByRunID[safe.runID] ?? 0, safe.sequence)
        events.append(safe)
        if events.count > maxRecentEvents {
            let overflow = events.count - maxRecentEvents
            events.removeFirst(overflow)
        }
        for subscriber in subscribers.values where subscriber.filter.matches(safe) {
            subscriber.continuation.yield(safe)
        }
        return true
    }

    @discardableResult
    public func publish(kind: AgentEventKind,
                        taskID: UUID,
                        runID: UUID,
                        sequence: UInt64,
                        source: AgentEventSource,
                        visibility: AgentEventVisibility = .user,
                        payload: AgentEventPayload = .empty,
                        timestamp: Date = Date()) -> Bool {
        publish(AgentEventEnvelope(taskID: taskID,
                                   runID: runID,
                                   sequence: sequence,
                                   timestamp: timestamp,
                                   source: source,
                                   visibility: visibility,
                                   kind: kind,
                                   payload: payload))
    }

    public func subscribe(filter: AgentEventFilter = AgentEventFilter()) -> (id: UUID, stream: AsyncStream<AgentEventEnvelope>) {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(
            of: AgentEventEnvelope.self,
            bufferingPolicy: .bufferingNewest(maxSubscriberBuffer))
        subscribers[id] = Subscriber(filter: filter, continuation: continuation)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
        return (id, stream)
    }

    public func subscribe(taskID: UUID) -> (id: UUID, stream: AsyncStream<AgentEventEnvelope>) {
        subscribe(filter: AgentEventFilter(taskID: taskID))
    }

    public func subscribe(runID: UUID) -> (id: UUID, stream: AsyncStream<AgentEventEnvelope>) {
        subscribe(filter: AgentEventFilter(runID: runID))
    }

    public func unsubscribe(_ id: UUID) {
        subscribers[id]?.continuation.finish()
        subscribers[id] = nil
    }

    public func recentEvents(limit: Int = 100) -> [AgentEventEnvelope] {
        Array(events.suffix(max(0, limit)))
    }

    public func events(taskID: UUID) -> [AgentEventEnvelope] {
        events.filter { $0.taskID == taskID }.sortedForReplay()
    }

    public func events(runID: UUID) -> [AgentEventEnvelope] {
        events.filter { $0.runID == runID }.sortedForReplay()
    }

    public func currentSnapshot(taskID: UUID) -> AgentEventSnapshot? {
        let taskEvents = events(taskID: taskID)
        guard let latest = taskEvents.last else { return nil }
        return AgentEventSnapshot(taskID: taskID,
                                  latestRunID: latest.runID,
                                  latestKind: latest.kind,
                                  eventCount: taskEvents.count,
                                  updatedAt: latest.timestamp)
    }

    public func subscriberCount() -> Int {
        subscribers.count
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers[id] = nil
    }
}

public extension Array where Element == AgentEventEnvelope {
    func sortedForReplay() -> [AgentEventEnvelope] {
        enumerated().sorted { lhs, rhs in
            if lhs.element.runID == rhs.element.runID,
               lhs.element.source == rhs.element.source,
               lhs.element.sequence != rhs.element.sequence {
                return lhs.element.sequence < rhs.element.sequence
            }
            if lhs.element.timestamp != rhs.element.timestamp {
                return lhs.element.timestamp < rhs.element.timestamp
            }
            if lhs.element.sequence != rhs.element.sequence {
                return lhs.element.sequence < rhs.element.sequence
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }
}

private extension AgentEventVisibility {
    var rank: Int {
        switch self {
        case .user: return 0
        case .developer: return 1
        case .diagnostic: return 2
        case .hidden: return 3
        }
    }
}

public extension AgentEventKind {
    init(activityKind: AgentTaskEventKind) {
        switch activityKind {
        case .taskCreated:
            self = .taskCreated
        case .taskQueued:
            self = .taskQueued
        case .planningStarted, .planProposed:
            self = .stepStarted
        case .approvalRequested:
            self = .toolPermissionRequired
        case .approvalGranted:
            self = .toolPermissionGranted
        case .approvalDenied:
            self = .toolPermissionDenied
        case .executionStarted:
            self = .taskStarted
        case .stepStarted:
            self = .toolStarted
        case .stepProgress:
            self = .toolProgress
        case .stepSucceeded:
            self = .toolSucceeded
        case .stepFailed:
            self = .toolFailed
        case .stepSkipped:
            self = .stepSkipped
        case .replanStarted:
            self = .recoveryStarted
        case .replanSucceeded:
            self = .recoverySucceeded
        case .replanFailed:
            self = .recoveryFailed
        case .verificationStarted:
            self = .verificationStarted
        case .verificationSucceeded:
            self = .verificationSucceeded
        case .verificationFailed:
            self = .verificationFailed
        case .synthesisStarted:
            self = .modelRequestStarted
        case .synthesisSucceeded:
            self = .modelResponseCompleted
        case .resultProduced:
            self = .resultProduced
        case .userInteractionRequested:
            self = .uiInteractionRequested
        case .userInteractionResolved:
            self = .uiInteractionResolved
        case .taskSucceeded:
            self = .taskSucceeded
        case .taskPartiallySucceeded:
            self = .taskPartiallySucceeded
        case .taskFailed:
            self = .taskFailed
        case .taskCancelled:
            self = .taskCancelled
        case .taskInterrupted:
            self = .taskInterrupted
        case .taskWaitingForRetry:
            self = .recoveryStarted
        case .taskRecovered:
            self = .recoverySucceeded
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
        case .modelRequestStarted:
            self = .modelRequestStarted
        case .modelResponseStreaming:
            self = .modelResponseStreaming
        case .modelResponseCompleted:
            self = .modelResponseCompleted
        case .modelRequestFailed:
            self = .modelRequestFailed
        case .unknown:
            self = .unknown
        }
    }
}

public extension AgentTaskEventKind {
    init(eventKind: AgentEventKind) {
        switch eventKind {
        case .taskCreated:
            self = .taskCreated
        case .taskQueued:
            self = .taskQueued
        case .taskStarted, .runStarted, .runRetryStarted:
            self = .executionStarted
        case .taskPaused:
            self = .taskInterrupted
        case .taskResumed:
            self = .taskQueued
        case .taskSucceeded, .runCompleted:
            self = .taskSucceeded
        case .taskPartiallySucceeded:
            self = .taskPartiallySucceeded
        case .taskFailed, .runFailed:
            self = .taskFailed
        case .taskCancelled, .runCancelled, .toolCancelled, .userActionCancelled:
            self = .taskCancelled
        case .taskInterrupted:
            self = .taskInterrupted
        case .taskWaitingForRetry:
            self = .stepStarted
        case .taskRecovered:
            self = .stepStarted
        case .stepStarted:
            self = .stepStarted
        case .stepProgress:
            self = .stepProgress
        case .stepSucceeded:
            self = .stepSucceeded
        case .stepFailed:
            self = .stepFailed
        case .stepSkipped:
            self = .stepSkipped
        case .modelRequestStarted:
            self = .modelRequestStarted
        case .modelResponseStreaming:
            self = .modelResponseStreaming
        case .modelResponseCompleted:
            self = .modelResponseCompleted
        case .modelRequestFailed:
            self = .modelRequestFailed
        case .toolRequested, .toolValidated, .toolValidationFailed, .toolStarted:
            self = .stepStarted
        case .toolProgress:
            self = .stepProgress
        case .toolSucceeded, .observationProduced, .observationDeliveredToModel:
            self = .stepSucceeded
        case .toolFailed:
            self = .stepFailed
        case .toolPermissionRequired:
            self = .approvalRequested
        case .toolPermissionGranted:
            self = .approvalGranted
        case .toolPermissionDenied, .userActionTimedOut:
            self = .approvalDenied
        case .waitingForUser, .uiInteractionRequested:
            self = .userInteractionRequested
        case .userActionReceived, .uiInteractionResolved:
            self = .userInteractionResolved
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
        case .resultProduced, .resultSnapshot, .resultPatch:
            self = .resultProduced
        case .verificationStarted:
            self = .verificationStarted
        case .verificationSucceeded:
            self = .verificationSucceeded
        case .verificationFailed:
            self = .verificationFailed
        case .warning, .diagnostic, .unknown:
            self = .unknown
        case .recoveryStarted:
            self = .replanStarted
        case .recoverySucceeded:
            self = .replanSucceeded
        case .recoveryFailed:
            self = .replanFailed
        }
    }
}

public extension AgentEventEnvelope {
    init(activityEvent event: AgentTaskActivityEvent, source: AgentEventSource = .runtime) {
        let payload: AgentEventPayload
        if let resultDocument = event.resultDocument {
            payload = .result(.init(title: event.presentation.title,
                                    summary: event.presentation.detail ?? resultDocument.summary,
                                    document: resultDocument,
                                    eventKind: resultDocument.status == .partial ? .patch : .snapshot,
                                    baseRevision: resultDocument.status == .partial ? max(0, resultDocument.currentRevision - 1) : nil))
        } else {
            payload = .activity(.init(
                title: event.presentation.title,
                detail: event.presentation.detail,
                stepID: event.stepID,
                toolID: event.toolID?.rawValue,
                failureCategory: event.failureCategory?.rawValue,
                conversationID: event.conversationID,
                userMessageID: event.userMessageID,
                origin: event.origin?.rawValue,
                providerKind: event.providerKind,
                modelID: event.modelID,
                scheduleID: event.scheduleID))
        }
        self.init(schemaVersion: event.schemaVersion,
                  id: event.eventID,
                  taskID: event.taskID,
                  runID: event.runID,
                  sequence: UInt64(max(0, event.sequenceNumber)),
                  timestamp: event.timestamp,
                  source: event.source ?? source,
                  visibility: .user,
                  kind: AgentEventKind(activityKind: event.kind),
                  payload: payload)
    }

}

public extension AgentTaskActivityEvent {
    init(eventEnvelope envelope: AgentEventEnvelope) {
        let metadata = ActivityEventProjectionMetadata(envelope: envelope)
        self.init(schemaVersion: envelope.schemaVersion,
                  eventID: envelope.id,
                  taskID: envelope.taskID,
                  runID: envelope.runID,
                  conversationID: metadata.conversationID,
                  userMessageID: metadata.userMessageID,
                  sequenceNumber: Int(clamping: envelope.sequence),
                  timestamp: envelope.timestamp,
                  kind: AgentTaskEventKind(eventKind: envelope.kind),
                  presentation: AgentTaskEventPresentation(title: metadata.title, detail: metadata.detail),
                  stepID: metadata.stepID,
                  toolID: metadata.toolID.map(ToolID.init(rawValue:)),
                  failureCategory: metadata.failureCategory,
                  source: envelope.source,
                  origin: metadata.origin,
                  providerKind: metadata.providerKind,
                  modelID: metadata.modelID,
                  scheduleID: metadata.scheduleID,
                  resultDocument: metadata.resultDocument)
    }
}

private struct ActivityEventProjectionMetadata {
    var title: String
    var detail: String?
    var stepID: String?
    var toolID: String?
    var failureCategory: AgentTaskFailureCategory?
    var conversationID: UUID?
    var userMessageID: UUID?
    var origin: AgentTaskOrigin?
    var providerKind: String?
    var modelID: String?
    var scheduleID: UUID?
    var resultDocument: AgentResultDocument?

    init(envelope: AgentEventEnvelope) {
        switch envelope.payload {
        case .activity(let payload):
            self.title = payload.title
            self.detail = payload.detail
            self.stepID = payload.stepID
            self.toolID = payload.toolID
            self.failureCategory = ActivityEventProjectionMetadata.failureCategory(payload.failureCategory)
            self.conversationID = payload.conversationID
            self.userMessageID = payload.userMessageID
            self.origin = payload.origin.map(AgentTaskOrigin.init(safeRawValue:))
            self.providerKind = payload.providerKind
            self.modelID = payload.modelID
            self.scheduleID = payload.scheduleID
            self.resultDocument = nil
        case .task(let payload):
            self.title = payload.title
            self.detail = payload.currentStep ?? payload.status
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = ActivityEventProjectionMetadata.failureCategory(payload.status)
            self.conversationID = payload.conversationID
            self.userMessageID = payload.userMessageID
            self.origin = payload.origin.map(AgentTaskOrigin.init(safeRawValue:))
            self.providerKind = payload.providerKind
            self.modelID = payload.modelID
            self.scheduleID = payload.scheduleID
            self.resultDocument = nil
        case .run(let payload):
            self.title = ActivityEventProjectionMetadata.title(for: envelope.kind)
            self.detail = payload.reason
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .step(let payload):
            self.title = payload.title
            self.detail = payload.safeSummary
            self.stepID = payload.stepID
            self.toolID = nil
            self.failureCategory = nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .model(let payload):
            self.title = ActivityEventProjectionMetadata.title(for: envelope.kind)
            self.detail = payload.safeSummary ?? payload.finishReason
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = ActivityEventProjectionMetadata.failureCategory(payload.finishReason)
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = payload.provider
            self.modelID = payload.modelID
            self.scheduleID = nil
            self.resultDocument = nil
        case .tool(let payload):
            self.title = payload.displayName
            self.detail = payload.safeSummary ?? payload.errorCategory ?? payload.resultCategory
            self.stepID = payload.toolCallID
            self.toolID = payload.toolID
            self.failureCategory = ActivityEventProjectionMetadata.failureCategory(payload.errorCategory)
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .permission(let payload):
            self.title = payload.safeReason ?? ActivityEventProjectionMetadata.title(for: envelope.kind)
            self.detail = payload.decision
            self.stepID = payload.capabilityID
            self.toolID = nil
            self.failureCategory = payload.decision == "denied" ? .permissionDenied : nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .provider(let payload):
            self.title = payload.safeSummary ?? ActivityEventProjectionMetadata.title(for: envelope.kind)
            self.detail = payload.httpStatus.map { "HTTP \($0)" } ?? payload.errorCategory
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = ActivityEventProjectionMetadata.failureCategory(payload.errorCategory)
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = payload.providerKind
            self.modelID = payload.modelID
            self.scheduleID = nil
            self.resultDocument = nil
        case .userAction(let payload):
            self.title = payload.safeSummary ?? payload.action
            self.detail = nil
            self.stepID = payload.action
            self.toolID = nil
            self.failureCategory = envelope.kind == .userActionCancelled ? .cancelled : nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .result(let payload):
            self.title = payload.title
            self.detail = payload.summary
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = payload.document
        case .failure(let payload):
            self.title = payload.safeSummary
            self.detail = payload.category
            self.stepID = payload.phase
            self.toolID = nil
            self.failureCategory = ActivityEventProjectionMetadata.failureCategory(payload.category)
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .diagnostic(let payload):
            self.title = payload.safeSummary
            self.detail = payload.category
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        case .empty:
            self.title = ActivityEventProjectionMetadata.title(for: envelope.kind)
            self.detail = nil
            self.stepID = nil
            self.toolID = nil
            self.failureCategory = nil
            self.conversationID = nil
            self.userMessageID = nil
            self.origin = nil
            self.providerKind = nil
            self.modelID = nil
            self.scheduleID = nil
            self.resultDocument = nil
        }
        self.origin = self.origin ?? AgentTaskOrigin(source: envelope.source)
    }

    private static func title(for kind: AgentEventKind) -> String {
        switch kind {
        case .taskCreated: return "任务已创建"
        case .taskQueued: return "任务已入队"
        case .taskStarted, .runStarted: return "任务开始执行"
        case .runRetryStarted: return "重试开始"
        case .taskPaused: return "任务已暂停"
        case .taskResumed: return "任务已恢复"
        case .taskSucceeded, .runCompleted: return "任务已完成"
        case .taskPartiallySucceeded: return "任务部分完成"
        case .taskFailed, .runFailed: return "任务失败"
        case .taskCancelled, .runCancelled: return "任务已取消"
        case .taskInterrupted: return "任务被中断"
        case .modelRequestStarted: return "模型请求开始"
        case .modelResponseStreaming: return "模型正在响应"
        case .modelResponseCompleted: return "模型响应完成"
        case .modelRequestFailed: return "模型请求失败"
        case .providerRequestStarted: return "Provider 请求开始"
        case .providerResponseReceived: return "Provider 已响应"
        case .providerRateLimited: return "Provider 限流"
        case .providerAuthenticationFailed: return "Provider 认证失败"
        case .providerUnavailable: return "Provider 不可用"
        case .providerRequestFailed: return "Provider 请求失败"
        case .toolPermissionRequired: return "等待用户确认"
        case .toolPermissionGranted: return "用户已批准"
        case .toolPermissionDenied: return "用户已拒绝"
        case .uiInteractionRequested: return "等待用户选择"
        case .uiInteractionResolved: return "用户已选择"
        case .resultProduced, .resultSnapshot: return "结果已生成"
        case .resultPatch: return "结果已更新"
        case .warning: return "警告"
        case .diagnostic: return "诊断事件"
        default: return "任务活动"
        }
    }

    private static func failureCategory(_ raw: String?) -> AgentTaskFailureCategory? {
        guard let raw else { return nil }
        switch raw {
        case "permissionDenied", "authenticationFailed":
            return .permissionDenied
        case "approvalRejected", "denied":
            return .approvalRejected
        case "approvalTimedOut", "timeout", "timedOut":
            return .approvalTimedOut
        case "planningFailed":
            return .planningFailed
        case "validationFailed", "schemaValidationFailed":
            return .validationFailed
        case "toolTimedOut":
            return .toolTimedOut
        case "toolFailed":
            return .toolFailed
        case "providerUnavailable", "provider5xx", "networkUnavailable", "rateLimited":
            return .providerUnavailable
        case "synthesisFailed":
            return .synthesisFailed
        case "cancelled", "userCancelled":
            return .cancelled
        case "interrupted":
            return .interrupted
        default:
            return AgentTaskFailureCategory(rawValue: raw) ?? .unknown
        }
    }
}
