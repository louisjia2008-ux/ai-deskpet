import Foundation
import CryptoKit
import AICore

public enum AgentCheckpointPhase: String, Codable, Sendable, Hashable {
    case replayOnly
    case awaitingToolResult
    case awaitingModelSynthesis
    case providerStreamInterrupted
    case active
    case terminal
}

public struct AgentCheckpoint: Codable, Sendable, Hashable, Identifiable {
    public var id: String { checkpointID }
    public var schemaVersion: Int
    public var checkpointID: String
    public var taskID: UUID
    public var runID: UUID
    public var conversationID: UUID?
    public var projection: AgentRunProjection
    public var replayState: AgentTimelineReplayState
    public var phase: AgentCheckpointPhase
    public var lastSequence: UInt64
    public var eventCount: Int
    public var resultDocument: AgentResultDocument?
    public var completedToolCallIDs: [String]
    public var completedSideEffectOperationIDs: [String]
    public var completedStepIDs: [String]
    public var pendingStepIDs: [String]
    public var accumulatedAssistantText: String
    public var currentUIRevision: Int?
    public var evidenceIDs: [String]
    public var verifierState: String
    public var recoveryDisposition: String
    public var domainPayloads: [String: AgentJSONValue]
    public var createdAt: Date
    public var updatedAt: Date

    public init(schemaVersion: Int = 1,
                checkpointID: String? = nil,
                taskID: UUID,
                runID: UUID,
                conversationID: UUID? = nil,
                projection: AgentRunProjection,
                replayState: AgentTimelineReplayState,
                phase: AgentCheckpointPhase,
                lastSequence: UInt64,
                eventCount: Int,
                resultDocument: AgentResultDocument? = nil,
                completedToolCallIDs: [String] = [],
                completedSideEffectOperationIDs: [String] = [],
                completedStepIDs: [String] = [],
                pendingStepIDs: [String] = [],
                accumulatedAssistantText: String = "",
                currentUIRevision: Int? = nil,
                evidenceIDs: [String] = [],
                verifierState: String = "unknown",
                recoveryDisposition: String = "notEvaluated",
                domainPayloads: [String: AgentJSONValue] = [:],
                createdAt: Date = Date(),
                updatedAt: Date? = nil) {
        self.schemaVersion = max(1, schemaVersion)
        self.checkpointID = AgentEventRedactor.safeIdentifier(checkpointID ?? "\(taskID.uuidString):\(runID.uuidString):\(lastSequence)")
        self.taskID = taskID
        self.runID = runID
        self.conversationID = conversationID
        self.projection = projection
        self.replayState = replayState
        self.phase = phase
        self.lastSequence = lastSequence
        self.eventCount = max(0, eventCount)
        self.resultDocument = resultDocument
        self.completedToolCallIDs = completedToolCallIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.completedSideEffectOperationIDs = completedSideEffectOperationIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.completedStepIDs = completedStepIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.pendingStepIDs = pendingStepIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.accumulatedAssistantText = AgentPrivacyRedactor.safeText(accumulatedAssistantText, maxLength: 16_384).text
        self.currentUIRevision = currentUIRevision
        self.evidenceIDs = evidenceIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.verifierState = AgentEventRedactor.safeIdentifier(verifierState)
        self.recoveryDisposition = AgentEventRedactor.safeIdentifier(recoveryDisposition)
        self.domainPayloads = domainPayloads.reduce(into: [String: AgentJSONValue]()) { out, pair in
            let safeKey = AgentEventRedactor.safeIdentifier(pair.key)
            if safeKey == "localDiscoveryWorkflow" {
                out[safeKey] = pair.value
            } else {
                out[safeKey] = pair.value.sanitized(maxStringLength: 8_192)
            }
        }
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

extension AgentCheckpoint {
    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case checkpointID
        case taskID
        case runID
        case conversationID
        case projection
        case replayState
        case phase
        case lastSequence
        case eventCount
        case resultDocument
        case completedToolCallIDs
        case completedSideEffectOperationIDs
        case completedStepIDs
        case pendingStepIDs
        case accumulatedAssistantText
        case currentUIRevision
        case evidenceIDs
        case verifierState
        case recoveryDisposition
        case domainPayloads
        case createdAt
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let taskID = try container.decode(UUID.self, forKey: .taskID)
        let runID = try container.decode(UUID.self, forKey: .runID)
        let lastSequence = try container.decodeIfPresent(UInt64.self, forKey: .lastSequence) ?? 0
        let createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        self.init(schemaVersion: try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1,
                  checkpointID: try container.decodeIfPresent(String.self, forKey: .checkpointID),
                  taskID: taskID,
                  runID: runID,
                  conversationID: try container.decodeIfPresent(UUID.self, forKey: .conversationID),
                  projection: try container.decode(AgentRunProjection.self, forKey: .projection),
                  replayState: try container.decode(AgentTimelineReplayState.self, forKey: .replayState),
                  phase: try container.decodeIfPresent(AgentCheckpointPhase.self, forKey: .phase) ?? .active,
                  lastSequence: lastSequence,
                  eventCount: try container.decodeIfPresent(Int.self, forKey: .eventCount) ?? 0,
                  resultDocument: try container.decodeIfPresent(AgentResultDocument.self, forKey: .resultDocument),
                  completedToolCallIDs: try container.decodeIfPresent([String].self, forKey: .completedToolCallIDs) ?? [],
                  completedSideEffectOperationIDs: try container.decodeIfPresent([String].self, forKey: .completedSideEffectOperationIDs) ?? [],
                  completedStepIDs: try container.decodeIfPresent([String].self, forKey: .completedStepIDs) ?? [],
                  pendingStepIDs: try container.decodeIfPresent([String].self, forKey: .pendingStepIDs) ?? [],
                  accumulatedAssistantText: try container.decodeIfPresent(String.self, forKey: .accumulatedAssistantText) ?? "",
                  currentUIRevision: try container.decodeIfPresent(Int.self, forKey: .currentUIRevision),
                  evidenceIDs: try container.decodeIfPresent([String].self, forKey: .evidenceIDs) ?? [],
                  verifierState: try container.decodeIfPresent(String.self, forKey: .verifierState) ?? "unknown",
                  recoveryDisposition: try container.decodeIfPresent(String.self, forKey: .recoveryDisposition) ?? "notEvaluated",
                  domainPayloads: try container.decodeIfPresent([String: AgentJSONValue].self, forKey: .domainPayloads) ?? [:],
                  createdAt: createdAt,
                  updatedAt: try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(checkpointID, forKey: .checkpointID)
        try container.encode(taskID, forKey: .taskID)
        try container.encode(runID, forKey: .runID)
        try container.encodeIfPresent(conversationID, forKey: .conversationID)
        try container.encode(projection, forKey: .projection)
        try container.encode(replayState, forKey: .replayState)
        try container.encode(phase, forKey: .phase)
        try container.encode(lastSequence, forKey: .lastSequence)
        try container.encode(eventCount, forKey: .eventCount)
        try container.encodeIfPresent(resultDocument, forKey: .resultDocument)
        try container.encode(completedToolCallIDs, forKey: .completedToolCallIDs)
        try container.encode(completedSideEffectOperationIDs, forKey: .completedSideEffectOperationIDs)
        try container.encode(completedStepIDs, forKey: .completedStepIDs)
        try container.encode(pendingStepIDs, forKey: .pendingStepIDs)
        try container.encode(accumulatedAssistantText, forKey: .accumulatedAssistantText)
        try container.encodeIfPresent(currentUIRevision, forKey: .currentUIRevision)
        try container.encode(evidenceIDs, forKey: .evidenceIDs)
        try container.encode(verifierState, forKey: .verifierState)
        try container.encode(recoveryDisposition, forKey: .recoveryDisposition)
        try container.encode(domainPayloads, forKey: .domainPayloads)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

public struct AgentCheckpointBuilder: Sendable {
    public init() {}

    public func checkpoint(taskID: UUID,
                           runID: UUID,
                           events rawEvents: [AgentEventEnvelope],
                           sideEffectLedger: AgentSideEffectLedger = AgentSideEffectLedger(),
                           createdAt: Date = Date()) -> AgentCheckpoint {
        let events = rawEvents
            .filter { $0.taskID == taskID && $0.runID == runID }
            .deduplicatedForP7()
            .sortedForReplay()
        let projection = AgentTaskProjectionReducer.reduce(envelopes: events).run(id: runID)
            ?? AgentRunProjection(taskID: taskID,
                                  runID: runID,
                                  state: .unknown,
                                  events: [],
                                  createdAt: .distantPast,
                                  updatedAt: .distantPast)
        let completedToolCallIDs = events.compactMap { event -> String? in
            guard event.kind == .toolSucceeded,
                  case .tool(let payload) = event.payload else { return nil }
            return payload.toolCallID ?? payload.toolExecutionID?.uuidString ?? payload.toolID
        }
        let completedStepIDs = events.compactMap { event -> String? in
            guard [.stepSucceeded, .stepSkipped].contains(event.kind),
                  case .step(let payload) = event.payload else { return nil }
            return payload.stepID
        }
        let pendingStepIDs = Self.pendingStepIDs(in: events, completedStepIDs: Set(completedStepIDs))
        let phase = phase(for: projection, events: events)
        return AgentCheckpoint(taskID: taskID,
                               runID: runID,
                               conversationID: Self.conversationID(in: events),
                               projection: projection,
                               replayState: AgentTimelineReplayState(taskID: taskID,
                                                                     runID: runID,
                                                                     events: events).jumpToEnd(),
                               phase: phase,
                               lastSequence: events.map(\.sequence).max() ?? 0,
                               eventCount: projection.events.count,
                               resultDocument: projection.resultDocument,
                               completedToolCallIDs: completedToolCallIDs,
                               completedSideEffectOperationIDs: sideEffectLedger.completedOperationIDs(taskID: taskID,
                                                                                                      runID: runID),
                               completedStepIDs: completedStepIDs,
                               pendingStepIDs: pendingStepIDs,
                               accumulatedAssistantText: Self.accumulatedAssistantText(in: events),
                               currentUIRevision: projection.resultDocument?.revision,
                               evidenceIDs: events.map { $0.id.uuidString },
                               verifierState: Self.verifierState(in: events),
                               createdAt: createdAt)
    }

    private func phase(for projection: AgentRunProjection,
                       events: [AgentEventEnvelope]) -> AgentCheckpointPhase {
        if projection.state.isTerminal { return .terminal }
        let completedStepIDs = events.compactMap { event -> String? in
            guard [.stepSucceeded, .stepSkipped].contains(event.kind),
                  case .step(let payload) = event.payload else { return nil }
            return payload.stepID
        }
        let hasPendingStep = !Self.pendingStepIDs(in: events, completedStepIDs: Set(completedStepIDs)).isEmpty
        let hasUISnapshot = events.contains {
            [.resultSnapshot, .resultPatch, .resultProduced].contains($0.kind)
        }
        let hasToolSuccess = events.contains { $0.kind == .toolSucceeded || $0.kind == .observationProduced }
        let hasModelCompleted = events.contains { $0.kind == .modelResponseCompleted || $0.kind == .runCompleted }
        let hasModelStreaming = events.contains { $0.kind == .modelResponseStreaming }
        let hasModelFailure = events.contains { $0.kind == .modelRequestFailed || $0.kind == .providerRequestFailed }
        if events.contains(where: { $0.kind == .toolStarted })
            && !events.contains(where: { [.toolSucceeded, .toolFailed, .toolCancelled].contains($0.kind) }) {
            return .awaitingToolResult
        }
        if hasPendingStep || hasUISnapshot {
            return .active
        }
        if events.last?.kind == .modelResponseStreaming && hasModelStreaming && !hasModelCompleted && !hasModelFailure {
            return .providerStreamInterrupted
        }
        if hasToolSuccess && !hasModelCompleted {
            return .awaitingModelSynthesis
        }
        return .active
    }

    private static func conversationID(in events: [AgentEventEnvelope]) -> UUID? {
        for event in events {
            switch event.payload {
            case .activity(let payload):
                if let id = payload.conversationID { return id }
            case .task(let payload):
                if let id = payload.conversationID { return id }
            default:
                continue
            }
        }
        return nil
    }

    private static func accumulatedAssistantText(in events: [AgentEventEnvelope]) -> String {
        let text = events.compactMap { event -> String? in
            guard [.modelResponseStreaming, .modelResponseCompleted].contains(event.kind),
                  case .model(let payload) = event.payload else { return nil }
            return payload.safeSummary
        }.joined()
        return AgentPrivacyRedactor.safeText(text, maxLength: 16_384).text
    }

    private static func pendingStepIDs(in events: [AgentEventEnvelope],
                                       completedStepIDs: Set<String>) -> [String] {
        events.compactMap { event -> String? in
            guard event.kind == .stepStarted,
                  case .step(let payload) = event.payload,
                  !completedStepIDs.contains(payload.stepID) else { return nil }
            return payload.stepID
        }.map(AgentEventRedactor.safeIdentifier).sorted()
    }

    private static func verifierState(in events: [AgentEventEnvelope]) -> String {
        if events.contains(where: { $0.kind == .verificationFailed }) { return "failed" }
        if events.contains(where: { $0.kind == .verificationSucceeded }) { return "succeeded" }
        if events.contains(where: { $0.kind == .verificationStarted }) { return "started" }
        return "notStarted"
    }
}

public enum AgentRecoveryStrategy: String, Codable, Sendable, Hashable {
    case replayOnly
    case resumeTool
    case resumeModelSynthesis
    case retryProviderStream
    case requireUserReview
}

public struct AgentRecoveryPlan: Codable, Sendable, Hashable {
    public var strategy: AgentRecoveryStrategy
    public var shouldEmitRecoveryEvents: Bool
    public var shouldRepeatSideEffects: Bool
    public var reason: String
    public var checkpoint: AgentCheckpoint

    public init(strategy: AgentRecoveryStrategy,
                shouldEmitRecoveryEvents: Bool,
                shouldRepeatSideEffects: Bool,
                reason: String,
                checkpoint: AgentCheckpoint) {
        self.strategy = strategy
        self.shouldEmitRecoveryEvents = shouldEmitRecoveryEvents
        self.shouldRepeatSideEffects = shouldRepeatSideEffects
        self.reason = AgentPrivacyRedactor.safeSummary(reason, fallback: strategy.rawValue)
        self.checkpoint = checkpoint
    }
}

public struct AgentRecoveryPlanner: Sendable {
    public init() {}

    public func plan(from checkpoint: AgentCheckpoint,
                     providerConformance: ModelConformanceProfile? = nil) -> AgentRecoveryPlan {
        if checkpoint.projection.state.isTerminal {
            return AgentRecoveryPlan(strategy: .replayOnly,
                                     shouldEmitRecoveryEvents: false,
                                     shouldRepeatSideEffects: false,
                                     reason: "terminal replay only",
                                     checkpoint: checkpoint)
        }
        switch checkpoint.phase {
        case .terminal, .replayOnly:
            return AgentRecoveryPlan(strategy: .replayOnly,
                                     shouldEmitRecoveryEvents: false,
                                     shouldRepeatSideEffects: false,
                                     reason: "replay only",
                                     checkpoint: checkpoint)
        case .awaitingModelSynthesis:
            return AgentRecoveryPlan(strategy: .resumeModelSynthesis,
                                     shouldEmitRecoveryEvents: true,
                                     shouldRepeatSideEffects: false,
                                     reason: "tool result is already recorded; resume final synthesis",
                                     checkpoint: checkpoint)
        case .providerStreamInterrupted:
            let supportsStreaming = providerConformance?.trueStreamingSupported ?? true
            return AgentRecoveryPlan(strategy: supportsStreaming ? .retryProviderStream : .resumeModelSynthesis,
                                     shouldEmitRecoveryEvents: true,
                                     shouldRepeatSideEffects: false,
                                     reason: supportsStreaming ? "provider stream interrupted" : "provider streaming not conformance-approved",
                                     checkpoint: checkpoint)
        case .awaitingToolResult:
            return AgentRecoveryPlan(strategy: .resumeTool,
                                     shouldEmitRecoveryEvents: true,
                                     shouldRepeatSideEffects: false,
                                     reason: "resume at tool boundary; ledger still prevents duplicate side effects",
                                     checkpoint: checkpoint)
        case .active:
            return AgentRecoveryPlan(strategy: .requireUserReview,
                                     shouldEmitRecoveryEvents: true,
                                     shouldRepeatSideEffects: false,
                                     reason: "active checkpoint has no safe deterministic resume point",
                                     checkpoint: checkpoint)
        }
    }
}

public enum AgentSideEffectStatus: String, Codable, Sendable, Hashable {
    case proposed
    case authorized
    case started
    case succeeded
    case failed
    case cancelled
    case outcomeUnknown
}

public struct AgentSideEffectRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: String { operationID }
    public var schemaVersion: Int?
    public var sideEffectID: String?
    public var operationID: String
    public var idempotencyKey: String?
    public var taskID: UUID
    public var runID: UUID
    public var toolID: ToolID?
    public var capabilityID: String?
    public var operationKind: String?
    public var status: AgentSideEffectStatus
    public var argumentsHash: String
    public var redactedInputDigest: String?
    public var resultHash: String?
    public var externalResourceID: String?
    public var resultDigest: String?
    public var retryPolicy: AgentRetryPolicy?
    public var recoveryNotes: String?
    public var createdAt: Date
    public var startedAt: Date?
    public var completedAt: Date?
    public var updatedAt: Date

    public init(operationID: String,
                idempotencyKey: String? = nil,
                taskID: UUID,
                runID: UUID,
                toolID: ToolID? = nil,
                capabilityID: String? = nil,
                operationKind: String? = nil,
                status: AgentSideEffectStatus,
                argumentsHash: String,
                resultHash: String? = nil,
                externalResourceID: String? = nil,
                retryPolicy: AgentRetryPolicy? = nil,
                recoveryNotes: String? = nil,
                createdAt: Date,
                startedAt: Date? = nil,
                completedAt: Date? = nil,
                updatedAt: Date) {
        self.operationID = AgentEventRedactor.safeIdentifier(operationID)
        self.schemaVersion = 1
        self.sideEffectID = self.operationID
        self.idempotencyKey = AgentEventRedactor.safeIdentifier(idempotencyKey ?? operationID)
        self.taskID = taskID
        self.runID = runID
        self.toolID = toolID
        self.capabilityID = capabilityID.map(AgentEventRedactor.safeIdentifier)
        self.operationKind = operationKind.map(AgentEventRedactor.safeIdentifier)
        self.status = status
        self.argumentsHash = AgentEventRedactor.safeIdentifier(argumentsHash)
        self.redactedInputDigest = self.argumentsHash
        self.resultHash = resultHash.map(AgentEventRedactor.safeIdentifier)
        self.externalResourceID = externalResourceID.map(AgentEventRedactor.safeIdentifier)
        self.resultDigest = self.resultHash
        self.retryPolicy = retryPolicy
        self.recoveryNotes = recoveryNotes.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
        self.createdAt = createdAt
        self.startedAt = startedAt ?? (status == .started ? createdAt : nil)
        self.completedAt = completedAt ?? (status == .succeeded || status == .failed || status == .cancelled ? updatedAt : nil)
        self.updatedAt = updatedAt
    }
}

public struct AgentSideEffectLedger: Codable, Sendable, Hashable {
    public private(set) var records: [AgentSideEffectRecord]

    public init(records: [AgentSideEffectRecord] = []) {
        self.records = records.sorted { $0.updatedAt < $1.updatedAt }
    }

    public func shouldExecute(operationID: String) -> Bool {
        let id = AgentEventRedactor.safeIdentifier(operationID)
        guard let record = records.last(where: { $0.operationID == id }) else { return true }
        return record.status == .failed || record.status == .cancelled || record.status == .proposed || record.status == .authorized
    }

    @discardableResult
    public mutating func recordStart(operationID: String,
                                     taskID: UUID,
                                     runID: UUID,
                                     toolID: ToolID?,
                                     arguments: AgentJSONValue,
                                     at date: Date = Date()) -> Bool {
        let id = AgentEventRedactor.safeIdentifier(operationID)
        if records.contains(where: { $0.operationID == id && ($0.status == .started || $0.status == .succeeded) }) {
            return false
        }
        records.append(AgentSideEffectRecord(operationID: id,
                                             taskID: taskID,
                                             runID: runID,
                                             toolID: toolID,
                                             status: .started,
                                             argumentsHash: Self.hash(arguments.jsonString),
                                             createdAt: date,
                                             updatedAt: date))
        return true
    }

    @discardableResult
    public mutating func recordCompletion(operationID: String,
                                          status: AgentSideEffectStatus,
                                          result: AgentJSONValue,
                                          at date: Date = Date()) -> Bool {
        let id = AgentEventRedactor.safeIdentifier(operationID)
        guard let index = records.lastIndex(where: { $0.operationID == id }) else { return false }
        if records[index].status == .succeeded { return false }
        records[index].status = status
        records[index].resultHash = Self.hash(result.jsonString)
        records[index].updatedAt = date
        return true
    }

    public func completedOperationIDs(taskID: UUID, runID: UUID) -> [String] {
        records
            .filter { $0.taskID == taskID && $0.runID == runID && $0.status == .succeeded }
            .map(\.operationID)
            .sorted()
    }

    private static func hash(_ raw: String) -> String {
        let digest = SHA256.hash(data: Data(raw.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    public static func digest(_ value: AgentJSONValue) -> String {
        hash(value.sanitized().jsonString)
    }
}

public enum ModelConformanceRole: String, Codable, Sendable, Hashable, CaseIterable {
    case responder
    case planner
    case toolCaller
    case verifier
    case synthesizer
}

public struct ModelConformanceProfile: Codable, Sendable, Hashable, Identifiable {
    public var id: String {
        [providerID, modelID, adapterVersion, "v\(conformanceVersion)"].compactMap { $0 }.joined(separator: ":")
    }
    public var providerID: String?
    public var providerType: ProviderType
    public var modelID: String
    public var adapterVersion: String
    public var conformanceVersion: Int
    public var capabilities: Set<ModelCapability>
    public var toolCalling: ProviderToolCallingCapability
    public var trueStreamingSupported: Bool
    public var supportsStreamingToolArguments: Bool
    public var supportsParallelToolCalls: Bool
    public var supportsStructuredOutput: Bool
    public var supportsReasoningSeparation: Bool
    public var supportsVision: Bool
    public var schemaReliability: Double
    public var toolCallReliability: Double
    public var hiddenReasoningFields: [String]
    public var requiredRequestFlags: [String: String]
    public var incompatibleFlags: Set<String>
    public var maxToolCalls: Int
    public var allowedRoles: Set<ModelConformanceRole>
    public var forbiddenRoles: Set<ModelConformanceRole>
    public var maxAutonomousSteps: Int
    public var requiresOutputRepair: Bool
    public var fixtureVersion: Int
    public var lastVerifiedAt: Date
    public var expiresAt: Date?
    public var evidenceSummary: String?

    public init(providerID: String? = nil,
                providerType: ProviderType,
                modelID: String,
                adapterVersion: String = "default",
                conformanceVersion: Int = 1,
                capabilities: Set<ModelCapability>,
                toolCalling: ProviderToolCallingCapability,
                trueStreamingSupported: Bool,
                supportsStreamingToolArguments: Bool = false,
                supportsParallelToolCalls: Bool = false,
                supportsStructuredOutput: Bool = false,
                supportsReasoningSeparation: Bool = true,
                supportsVision: Bool = false,
                schemaReliability: Double = 0,
                toolCallReliability: Double = 0,
                hiddenReasoningFields: [String] = [],
                requiredRequestFlags: [String: String] = [:],
                incompatibleFlags: Set<String> = [],
                maxToolCalls: Int = 0,
                allowedRoles: Set<ModelConformanceRole> = [.responder],
                forbiddenRoles: Set<ModelConformanceRole> = [],
                maxAutonomousSteps: Int = 1,
                requiresOutputRepair: Bool = false,
                fixtureVersion: Int = 1,
                lastVerifiedAt: Date = Date(),
                expiresAt: Date? = nil,
                evidenceSummary: String? = nil) {
        self.providerID = providerID.map(AgentEventRedactor.safeIdentifier)
        self.providerType = providerType
        self.modelID = AgentEventRedactor.safeIdentifier(modelID)
        self.adapterVersion = AgentEventRedactor.safeIdentifier(adapterVersion)
        self.conformanceVersion = max(1, conformanceVersion)
        self.capabilities = capabilities
        self.toolCalling = toolCalling
        self.trueStreamingSupported = trueStreamingSupported
        self.supportsStreamingToolArguments = supportsStreamingToolArguments
        self.supportsParallelToolCalls = supportsParallelToolCalls
        self.supportsStructuredOutput = supportsStructuredOutput
        self.supportsReasoningSeparation = supportsReasoningSeparation
        self.supportsVision = supportsVision
        self.schemaReliability = min(1, max(0, schemaReliability))
        self.toolCallReliability = min(1, max(0, toolCallReliability))
        self.hiddenReasoningFields = hiddenReasoningFields.map(AgentEventRedactor.safeIdentifier).sorted()
        self.requiredRequestFlags = AgentPrivacyRedactor.safeMetadata(requiredRequestFlags)
        self.incompatibleFlags = incompatibleFlags.map(AgentEventRedactor.safeIdentifier).reduce(into: Set<String>()) { $0.insert($1) }
        self.maxToolCalls = max(0, maxToolCalls)
        self.allowedRoles = allowedRoles
        self.forbiddenRoles = forbiddenRoles
        self.maxAutonomousSteps = max(1, maxAutonomousSteps)
        self.requiresOutputRepair = requiresOutputRepair
        self.fixtureVersion = max(1, fixtureVersion)
        self.lastVerifiedAt = lastVerifiedAt
        self.expiresAt = expiresAt
        self.evidenceSummary = evidenceSummary.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
    }

    public static func from(provider: ProviderConfig,
                            modelID: String? = nil,
                            verifiedAt: Date = Date(),
                            resolver: ProviderCapabilityProfileResolving = DefaultProviderCapabilityProfileResolver()) -> ModelConformanceProfile {
        let resolvedModelID = modelID ?? provider.defaultModelID ?? "unknown"
        let toolCalling = ProviderToolCapabilityPolicy.capability(for: provider, modelID: resolvedModelID, resolver: resolver)
        let profile = resolver.capabilityProfile(provider: provider, modelID: resolvedModelID)
        let roles: Set<ModelConformanceRole> = toolCalling == .unsupported
            ? [.responder, .synthesizer]
            : [.responder, .planner, .toolCaller, .synthesizer]
        return ModelConformanceProfile(providerID: provider.id,
                                       providerType: provider.type,
                                       modelID: resolvedModelID,
                                       adapterVersion: provider.type.rawValue,
                                       conformanceVersion: 1,
                                       capabilities: provider.capabilities,
                                       toolCalling: toolCalling,
                                       trueStreamingSupported: provider.capabilities.contains(.streaming),
                                       supportsStreamingToolArguments: toolCalling == .native,
                                       supportsParallelToolCalls: false,
                                       supportsStructuredOutput: provider.capabilities.contains(.toolCalling),
                                       supportsReasoningSeparation: true,
                                       supportsVision: provider.capabilities.contains(.vision),
                                       schemaReliability: provider.capabilities.contains(.toolCalling) ? 0.8 : 0.4,
                                       toolCallReliability: toolCalling == .unsupported ? 0 : 0.8,
                                       hiddenReasoningFields: profile.hiddenReasoningFields,
                                       requiredRequestFlags: profile.requiredRequestFlags,
                                       incompatibleFlags: provider.capabilities.contains(.toolCalling) ? [] : ["native_tool_calls"],
                                       maxToolCalls: profile.maxToolCalls ?? (toolCalling == .unsupported ? 0 : 8),
                                       allowedRoles: roles,
                                       maxAutonomousSteps: toolCalling == .unsupported ? 1 : 4,
                                       lastVerifiedAt: verifiedAt)
    }
}

extension ModelConformanceProfile {
    private enum CodingKeys: String, CodingKey {
        case providerID
        case providerType
        case modelID
        case adapterVersion
        case conformanceVersion
        case capabilities
        case toolCalling
        case trueStreamingSupported
        case supportsStreamingToolArguments
        case supportsParallelToolCalls
        case supportsStructuredOutput
        case supportsReasoningSeparation
        case supportsVision
        case schemaReliability
        case toolCallReliability
        case hiddenReasoningFields
        case requiredRequestFlags
        case incompatibleFlags
        case maxToolCalls
        case allowedRoles
        case forbiddenRoles
        case maxAutonomousSteps
        case requiresOutputRepair
        case fixtureVersion
        case lastVerifiedAt
        case expiresAt
        case evidenceSummary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(providerID: try container.decodeIfPresent(String.self, forKey: .providerID),
                  providerType: try container.decode(ProviderType.self, forKey: .providerType),
                  modelID: try container.decode(String.self, forKey: .modelID),
                  adapterVersion: try container.decodeIfPresent(String.self, forKey: .adapterVersion) ?? "default",
                  conformanceVersion: try container.decodeIfPresent(Int.self, forKey: .conformanceVersion) ?? 1,
                  capabilities: try container.decodeIfPresent(Set<ModelCapability>.self, forKey: .capabilities) ?? [.chat],
                  toolCalling: try container.decodeIfPresent(ProviderToolCallingCapability.self, forKey: .toolCalling) ?? .unsupported,
                  trueStreamingSupported: try container.decodeIfPresent(Bool.self, forKey: .trueStreamingSupported) ?? false,
                  supportsStreamingToolArguments: try container.decodeIfPresent(Bool.self, forKey: .supportsStreamingToolArguments) ?? false,
                  supportsParallelToolCalls: try container.decodeIfPresent(Bool.self, forKey: .supportsParallelToolCalls) ?? false,
                  supportsStructuredOutput: try container.decodeIfPresent(Bool.self, forKey: .supportsStructuredOutput) ?? false,
                  supportsReasoningSeparation: try container.decodeIfPresent(Bool.self, forKey: .supportsReasoningSeparation) ?? true,
                  supportsVision: try container.decodeIfPresent(Bool.self, forKey: .supportsVision) ?? false,
                  schemaReliability: try container.decodeIfPresent(Double.self, forKey: .schemaReliability) ?? 0,
                  toolCallReliability: try container.decodeIfPresent(Double.self, forKey: .toolCallReliability) ?? 0,
                  hiddenReasoningFields: try container.decodeIfPresent([String].self, forKey: .hiddenReasoningFields) ?? [],
                  requiredRequestFlags: try container.decodeIfPresent([String: String].self, forKey: .requiredRequestFlags) ?? [:],
                  incompatibleFlags: try container.decodeIfPresent(Set<String>.self, forKey: .incompatibleFlags) ?? [],
                  maxToolCalls: try container.decodeIfPresent(Int.self, forKey: .maxToolCalls) ?? 0,
                  allowedRoles: try container.decodeIfPresent(Set<ModelConformanceRole>.self, forKey: .allowedRoles) ?? [.responder],
                  forbiddenRoles: try container.decodeIfPresent(Set<ModelConformanceRole>.self, forKey: .forbiddenRoles) ?? [],
                  maxAutonomousSteps: try container.decodeIfPresent(Int.self, forKey: .maxAutonomousSteps) ?? 1,
                  requiresOutputRepair: try container.decodeIfPresent(Bool.self, forKey: .requiresOutputRepair) ?? false,
                  fixtureVersion: try container.decodeIfPresent(Int.self, forKey: .fixtureVersion) ?? 1,
                  lastVerifiedAt: try container.decodeIfPresent(Date.self, forKey: .lastVerifiedAt) ?? Date(),
                  expiresAt: try container.decodeIfPresent(Date.self, forKey: .expiresAt),
                  evidenceSummary: try container.decodeIfPresent(String.self, forKey: .evidenceSummary))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(providerID, forKey: .providerID)
        try container.encode(providerType, forKey: .providerType)
        try container.encode(modelID, forKey: .modelID)
        try container.encode(adapterVersion, forKey: .adapterVersion)
        try container.encode(conformanceVersion, forKey: .conformanceVersion)
        try container.encode(capabilities, forKey: .capabilities)
        try container.encode(toolCalling, forKey: .toolCalling)
        try container.encode(trueStreamingSupported, forKey: .trueStreamingSupported)
        try container.encode(supportsStreamingToolArguments, forKey: .supportsStreamingToolArguments)
        try container.encode(supportsParallelToolCalls, forKey: .supportsParallelToolCalls)
        try container.encode(supportsStructuredOutput, forKey: .supportsStructuredOutput)
        try container.encode(supportsReasoningSeparation, forKey: .supportsReasoningSeparation)
        try container.encode(supportsVision, forKey: .supportsVision)
        try container.encode(schemaReliability, forKey: .schemaReliability)
        try container.encode(toolCallReliability, forKey: .toolCallReliability)
        try container.encode(hiddenReasoningFields, forKey: .hiddenReasoningFields)
        try container.encode(requiredRequestFlags, forKey: .requiredRequestFlags)
        try container.encode(incompatibleFlags, forKey: .incompatibleFlags)
        try container.encode(maxToolCalls, forKey: .maxToolCalls)
        try container.encode(allowedRoles, forKey: .allowedRoles)
        try container.encode(forbiddenRoles, forKey: .forbiddenRoles)
        try container.encode(maxAutonomousSteps, forKey: .maxAutonomousSteps)
        try container.encode(requiresOutputRepair, forKey: .requiresOutputRepair)
        try container.encode(fixtureVersion, forKey: .fixtureVersion)
        try container.encode(lastVerifiedAt, forKey: .lastVerifiedAt)
        try container.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try container.encodeIfPresent(evidenceSummary, forKey: .evidenceSummary)
    }
}

public enum ModelConformanceIssueKind: String, Codable, Sendable, Hashable {
    case missingCapability
    case unsupportedToolCalling
    case unsupportedStreaming
    case roleDenied
    case incompatibleFlag
    case maxToolCallsExceeded
}

public struct ModelConformanceIssue: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: ModelConformanceIssueKind
    public var message: String

    public init(id: String, kind: ModelConformanceIssueKind, message: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.kind = kind
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 300).text
    }
}

public struct ModelConformanceRequest: Codable, Sendable, Hashable {
    public var requiredCapabilities: Set<ModelCapability>
    public var requiredRole: ModelConformanceRole
    public var requiresNativeToolCalling: Bool
    public var requiresTrueStreaming: Bool
    public var requestedToolCalls: Int
    public var requestFlags: Set<String>

    public init(requiredCapabilities: Set<ModelCapability> = [.chat],
                requiredRole: ModelConformanceRole = .responder,
                requiresNativeToolCalling: Bool = false,
                requiresTrueStreaming: Bool = false,
                requestedToolCalls: Int = 0,
                requestFlags: Set<String> = []) {
        self.requiredCapabilities = requiredCapabilities
        self.requiredRole = requiredRole
        self.requiresNativeToolCalling = requiresNativeToolCalling
        self.requiresTrueStreaming = requiresTrueStreaming
        self.requestedToolCalls = max(0, requestedToolCalls)
        self.requestFlags = requestFlags.map(AgentEventRedactor.safeIdentifier).reduce(into: Set<String>()) { $0.insert($1) }
    }
}

public enum ModelConformanceVerdict: String, Codable, Sendable, Hashable {
    case pass
    case fail
}

public struct ProviderConformanceReport: Codable, Sendable, Hashable {
    public var profile: ModelConformanceProfile
    public var request: ModelConformanceRequest
    public var verdict: ModelConformanceVerdict
    public var issues: [ModelConformanceIssue]
    public var generatedAt: Date

    public init(profile: ModelConformanceProfile,
                request: ModelConformanceRequest,
                verdict: ModelConformanceVerdict,
                issues: [ModelConformanceIssue],
                generatedAt: Date = Date()) {
        self.profile = profile
        self.request = request
        self.verdict = verdict
        self.issues = issues
        self.generatedAt = generatedAt
    }

    public var allowsRequest: Bool { verdict == .pass }
}

public struct ModelConformanceGate: Sendable {
    public init() {}

    public func report(profile: ModelConformanceProfile,
                       request: ModelConformanceRequest,
                       generatedAt: Date = Date()) -> ProviderConformanceReport {
        var issues: [ModelConformanceIssue] = []
        let missingCapabilities = request.requiredCapabilities.subtracting(profile.capabilities)
        for capability in missingCapabilities.sorted(by: { $0.rawValue < $1.rawValue }) {
            issues.append(ModelConformanceIssue(id: "missing_\(capability.rawValue)",
                                                kind: .missingCapability,
                                                message: "模型缺少 capability：\(capability.rawValue)"))
        }
        if !profile.allowedRoles.contains(request.requiredRole) {
            issues.append(ModelConformanceIssue(id: "role_denied",
                                                kind: .roleDenied,
                                                message: "模型 conformance profile 不允许角色：\(request.requiredRole.rawValue)"))
        }
        if request.requiresNativeToolCalling && profile.toolCalling != .native {
            issues.append(ModelConformanceIssue(id: "native_tool_calling_unsupported",
                                                kind: .unsupportedToolCalling,
                                                message: "模型不支持 native tool calling"))
        }
        if request.requiresTrueStreaming && !profile.trueStreamingSupported {
            issues.append(ModelConformanceIssue(id: "true_streaming_unsupported",
                                                kind: .unsupportedStreaming,
                                                message: "模型未通过 true streaming conformance"))
        }
        if request.requestedToolCalls > profile.maxToolCalls {
            issues.append(ModelConformanceIssue(id: "tool_call_budget",
                                                kind: .maxToolCallsExceeded,
                                                message: "模型工具调用次数超过 conformance profile 限制"))
        }
        for flag in request.requestFlags where profile.incompatibleFlags.contains(flag) {
            issues.append(ModelConformanceIssue(id: "flag_\(flag)",
                                                kind: .incompatibleFlag,
                                                message: "请求包含模型不兼容 flag：\(flag)"))
        }
        return ProviderConformanceReport(profile: profile,
                                         request: request,
                                         verdict: issues.isEmpty ? .pass : .fail,
                                         issues: issues,
                                         generatedAt: generatedAt)
    }
}

private extension Array where Element == AgentEventEnvelope {
    func deduplicatedForP7() -> [AgentEventEnvelope] {
        var seen = Set<UUID>()
        return filter { seen.insert($0.id).inserted }
    }
}
