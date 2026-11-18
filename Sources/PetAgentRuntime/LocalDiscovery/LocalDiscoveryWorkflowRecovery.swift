import Foundation

public enum LocalDiscoveryWorkflowStage: String, Codable, Sendable, Hashable, CaseIterable, Comparable {
    case created
    case queryApproved
    case locationResolved
    case initialSearchCompleted
    case dedupCompleted
    case routeItemCompleted
    case routeBatchCompleted
    case enrichmentItemCompleted
    case enrichmentBatchCompleted
    case validationCompleted
    case verifierCompleted
    case resultSynthesized
    case cancelled
    case recoveryBlocked

    public static func < (lhs: LocalDiscoveryWorkflowStage, rhs: LocalDiscoveryWorkflowStage) -> Bool {
        lhs.rank < rhs.rank
    }

    public var rank: Int {
        switch self {
        case .created: return 0
        case .queryApproved: return 10
        case .locationResolved: return 20
        case .initialSearchCompleted: return 30
        case .dedupCompleted: return 40
        case .routeItemCompleted: return 45
        case .routeBatchCompleted: return 50
        case .enrichmentItemCompleted: return 55
        case .enrichmentBatchCompleted: return 60
        case .validationCompleted: return 70
        case .verifierCompleted: return 80
        case .resultSynthesized: return 90
        case .cancelled: return 100
        case .recoveryBlocked: return 101
        }
    }

    public var isTerminal: Bool {
        self == .cancelled || self == .resultSynthesized || self == .recoveryBlocked
    }
}

public struct LocalDiscoveryResolvedLocationSnapshot: Codable, Sendable, Hashable {
    public var label: String
    public var coordinate: PlaceCoordinate?
    public var source: String

    public init(label: String,
                coordinate: PlaceCoordinate? = nil,
                source: String) {
        self.label = AgentPrivacyRedactor.safeText(label, maxLength: 300).text
        self.coordinate = coordinate
        self.source = AgentEventRedactor.safeIdentifier(source)
    }
}

public struct LocalDiscoveryToolCompletionIdentity: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var taskID: UUID
    public var runID: UUID
    public var workflowStage: LocalDiscoveryWorkflowStage
    public var toolID: String
    public var normalizedInputDigest: String
    public var targetID: String?
    public var evidenceIDs: [String]
    public var completedAt: Date

    public init(taskID: UUID,
                runID: UUID,
                workflowStage: LocalDiscoveryWorkflowStage,
                toolID: String,
                normalizedInputDigest: String,
                targetID: String? = nil,
                evidenceIDs: [String] = [],
                completedAt: Date) {
        self.taskID = taskID
        self.runID = runID
        self.workflowStage = workflowStage
        self.toolID = AgentEventRedactor.safeIdentifier(toolID)
        self.normalizedInputDigest = AgentEventRedactor.safeIdentifier(normalizedInputDigest)
        self.targetID = targetID.map(AgentEventRedactor.safeIdentifier)
        self.evidenceIDs = evidenceIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.completedAt = completedAt
        self.id = [
            taskID.uuidString,
            runID.uuidString,
            workflowStage.rawValue,
            self.toolID,
            self.normalizedInputDigest,
            self.targetID ?? "none",
        ].joined(separator: ":")
    }
}

public struct LocalDiscoveryWorkflowSnapshot: Codable, Sendable, Hashable, Identifiable {
    public static let domainPayloadKey = "localDiscoveryWorkflow"
    public static let currentSchemaVersion = 1

    public var id: String { workflowID }
    public var schemaVersion: Int
    public var taskID: UUID
    public var runID: UUID
    public var workflowID: String
    public var currentStage: LocalDiscoveryWorkflowStage
    public var approvedQuery: PlaceQuery?
    public var plannedAssumptions: [String]
    public var plannedMissingInformation: [String]
    public var plannedUnsupportedRequirements: [String]
    public var plannedRepairAttempts: Int
    public var plannedUsedDeterministicFallback: Bool
    public var resolvedLocation: LocalDiscoveryResolvedLocationSnapshot?
    public var searchPolicySnapshot: LocalDiscoverySearchPolicy
    public var rawCandidates: [PlaceCandidate]
    public var mergedCandidates: [PlaceCandidate]
    public var completedRouteCandidateIDs: [String]
    public var pendingRouteCandidateIDs: [String]
    public var completedEnrichmentCandidateIDs: [String]
    public var pendingEnrichmentCandidateIDs: [String]
    public var webpageEvidenceIDs: [String]
    public var extractionEvidenceIDs: [String]
    public var validatorFindings: [PlaceVerificationFinding]
    public var verifierDisposition: LocalDiscoveryVerifierReport?
    public var rankedCandidateIDs: [String]
    public var synthesizedResultRevision: Int?
    public var toolCompletions: [LocalDiscoveryToolCompletionIdentity]
    public var backend: String
    public var warnings: [String]
    public var lastAppliedEventSequence: UInt64
    public var updatedAt: Date

    public init(schemaVersion: Int = Self.currentSchemaVersion,
                taskID: UUID,
                runID: UUID,
                workflowID: String? = nil,
                currentStage: LocalDiscoveryWorkflowStage = .created,
                approvedQuery: PlaceQuery? = nil,
                plannedAssumptions: [String] = [],
                plannedMissingInformation: [String] = [],
                plannedUnsupportedRequirements: [String] = [],
                plannedRepairAttempts: Int = 0,
                plannedUsedDeterministicFallback: Bool = true,
                resolvedLocation: LocalDiscoveryResolvedLocationSnapshot? = nil,
                searchPolicySnapshot: LocalDiscoverySearchPolicy,
                rawCandidates: [PlaceCandidate] = [],
                mergedCandidates: [PlaceCandidate] = [],
                completedRouteCandidateIDs: [String] = [],
                pendingRouteCandidateIDs: [String] = [],
                completedEnrichmentCandidateIDs: [String] = [],
                pendingEnrichmentCandidateIDs: [String] = [],
                webpageEvidenceIDs: [String] = [],
                extractionEvidenceIDs: [String] = [],
                validatorFindings: [PlaceVerificationFinding] = [],
                verifierDisposition: LocalDiscoveryVerifierReport? = nil,
                rankedCandidateIDs: [String] = [],
                synthesizedResultRevision: Int? = nil,
                toolCompletions: [LocalDiscoveryToolCompletionIdentity] = [],
                backend: String = "unknown",
                warnings: [String] = [],
                lastAppliedEventSequence: UInt64 = 0,
                updatedAt: Date = Date()) {
        self.schemaVersion = max(1, schemaVersion)
        self.taskID = taskID
        self.runID = runID
        self.workflowID = AgentEventRedactor.safeIdentifier(workflowID ?? "local-discovery-\(runID.uuidString)")
        self.currentStage = currentStage
        self.approvedQuery = approvedQuery
        self.plannedAssumptions = plannedAssumptions.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.plannedMissingInformation = plannedMissingInformation.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.plannedUnsupportedRequirements = plannedUnsupportedRequirements.map(AgentEventRedactor.safeIdentifier).sorted()
        self.plannedRepairAttempts = max(0, plannedRepairAttempts)
        self.plannedUsedDeterministicFallback = plannedUsedDeterministicFallback
        self.resolvedLocation = resolvedLocation
        self.searchPolicySnapshot = searchPolicySnapshot
        self.rawCandidates = rawCandidates
        self.mergedCandidates = mergedCandidates
        self.completedRouteCandidateIDs = completedRouteCandidateIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.pendingRouteCandidateIDs = pendingRouteCandidateIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.completedEnrichmentCandidateIDs = completedEnrichmentCandidateIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.pendingEnrichmentCandidateIDs = pendingEnrichmentCandidateIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.webpageEvidenceIDs = webpageEvidenceIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.extractionEvidenceIDs = extractionEvidenceIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.validatorFindings = validatorFindings
        self.verifierDisposition = verifierDisposition
        self.rankedCandidateIDs = rankedCandidateIDs.map(AgentEventRedactor.safeIdentifier)
        self.synthesizedResultRevision = synthesizedResultRevision
        self.toolCompletions = Array(Set(toolCompletions)).sorted { $0.id < $1.id }
        self.backend = AgentPrivacyRedactor.safeSummary(backend, fallback: "unknown")
        self.warnings = warnings.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.lastAppliedEventSequence = lastAppliedEventSequence
        self.updatedAt = updatedAt
    }

    public var plannedQuery: LocalDiscoveryPlannedQuery {
        LocalDiscoveryPlannedQuery(status: approvedQuery == nil ? .requiresClarification : .ready,
                                   query: approvedQuery,
                                   assumptions: plannedAssumptions,
                                   missingInformation: plannedMissingInformation,
                                   unsupportedRequirements: plannedUnsupportedRequirements,
                                   repairAttempts: plannedRepairAttempts,
                                   usedDeterministicFallback: plannedUsedDeterministicFallback)
    }
}

public enum LocalDiscoveryWorkflowRecoveryLoadResult: Sendable, Equatable {
    case missing
    case recovered(LocalDiscoveryWorkflowSnapshot)
    case terminal(LocalDiscoveryWorkflowSnapshot)
    case recoveryBlocked(String)
}

public extension AgentCheckpointStore {
    func saveLocalDiscoverySnapshot(_ snapshot: LocalDiscoveryWorkflowSnapshot,
                                    resultDocument: AgentResultDocument? = nil,
                                    state: AgentRunState = .running,
                                    phase: AgentCheckpointPhase = .active,
                                    conversationID: UUID? = nil,
                                    lastSequence: UInt64? = nil) async throws {
        let existing = try? load(taskID: snapshot.taskID, runID: snapshot.runID)
        if existing?.projection.state == .cancelled && state != .cancelled {
            return
        }
        var domainPayloads: [String: AgentJSONValue] = [:]
        if let existing {
            domainPayloads = existing.domainPayloads
        }
        domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] = try LocalDiscoveryJSON.jsonValue(from: snapshot)
        let now = snapshot.updatedAt
        let resolvedConversationID = conversationID ?? existing?.conversationID ?? existing?.projection.conversationID
        let resolvedResultDocument = resultDocument ?? existing?.resultDocument ?? existing?.projection.resultDocument
        let localEvidenceIDs = Array(Set(snapshot.webpageEvidenceIDs + snapshot.extractionEvidenceIDs))
        let mergedToolCallIDs = Array(Set((existing?.completedToolCallIDs ?? []) + snapshot.toolCompletions.map(\.id))).sorted()
        let mergedEvidenceIDs = Array(Set((existing?.evidenceIDs ?? []) + localEvidenceIDs)).sorted()
        let mergedCompletedSteps = Array(Set((existing?.completedStepIDs ?? []) + [snapshot.currentStage.rawValue])).sorted()
        let resolvedLastSequence = max(existing?.lastSequence ?? 0, lastSequence ?? snapshot.lastAppliedEventSequence)
        let projection = AgentRunProjection(taskID: snapshot.taskID,
                                            runID: snapshot.runID,
                                            conversationID: resolvedConversationID,
                                            userMessageID: existing?.projection.userMessageID,
                                            assistantMessageID: existing?.projection.assistantMessageID,
                                            state: state,
                                            events: existing?.projection.events ?? [],
                                            createdAt: existing?.projection.createdAt ?? now,
                                            updatedAt: now,
                                            completedAt: state.isTerminal ? now : existing?.projection.completedAt,
                                            currentStepTitle: snapshot.currentStage.rawValue,
                                            terminalSummary: existing?.projection.terminalSummary,
                                            failureCategory: existing?.projection.failureCategory,
                                            resultDocument: resolvedResultDocument)
        var checkpoint = AgentCheckpoint(taskID: snapshot.taskID,
                                         runID: snapshot.runID,
                                         conversationID: resolvedConversationID,
                                         projection: projection,
                                         replayState: existing?.replayState ?? AgentTimelineReplayState(taskID: snapshot.taskID,
                                                                                                        runID: snapshot.runID,
                                                                                                        events: []).jumpToEnd(),
                                         phase: state.isTerminal ? .terminal : phase,
                                         lastSequence: resolvedLastSequence,
                                         eventCount: max(existing?.eventCount ?? 0, 0),
                                         resultDocument: resolvedResultDocument,
                                         completedToolCallIDs: mergedToolCallIDs,
                                         completedSideEffectOperationIDs: existing?.completedSideEffectOperationIDs ?? [],
                                         completedStepIDs: mergedCompletedSteps,
                                         pendingStepIDs: state.isTerminal ? [] : [snapshot.currentStage.rawValue],
                                         accumulatedAssistantText: existing?.accumulatedAssistantText ?? "",
                                         currentUIRevision: resultDocument?.revision ?? snapshot.synthesizedResultRevision ?? existing?.currentUIRevision,
                                         evidenceIDs: mergedEvidenceIDs,
                                         verifierState: snapshot.verifierDisposition?.verdict.rawValue ?? existing?.verifierState ?? "notStarted",
                                         recoveryDisposition: snapshot.currentStage.rawValue,
                                         domainPayloads: domainPayloads,
                                         createdAt: existing?.createdAt ?? now,
                                         updatedAt: now)
        if existing?.phase == .terminal {
            checkpoint.phase = .terminal
        }
        try save(checkpoint)
    }

    func markLocalDiscoverySnapshotCancelled(taskID: UUID,
                                             runID: UUID,
                                             conversationID: UUID?,
                                             updatedAt: Date = Date()) async throws {
        let checkpoint = try load(taskID: taskID, runID: runID)
        let snapshot: LocalDiscoveryWorkflowSnapshot
        if let payload = checkpoint?.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey],
           var decoded = try? LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload) {
            decoded.currentStage = .cancelled
            decoded.lastAppliedEventSequence = max(decoded.lastAppliedEventSequence, checkpoint?.lastSequence ?? 0)
            decoded.updatedAt = updatedAt
            snapshot = decoded
        } else {
            snapshot = LocalDiscoveryWorkflowSnapshot(taskID: taskID,
                                                      runID: runID,
                                                      currentStage: .cancelled,
                                                      searchPolicySnapshot: LocalDiscoverySearchPolicy(),
                                                      lastAppliedEventSequence: checkpoint?.lastSequence ?? 0,
                                                      updatedAt: updatedAt)
        }
        try await saveLocalDiscoverySnapshot(snapshot,
                                             state: .cancelled,
                                             phase: .terminal,
                                             conversationID: conversationID,
                                             lastSequence: snapshot.lastAppliedEventSequence)
    }

    func loadLocalDiscoverySnapshot(taskID: UUID,
                                    runID: UUID) async -> LocalDiscoveryWorkflowRecoveryLoadResult {
        do {
            guard let checkpoint = try load(taskID: taskID, runID: runID) else {
                return .missing
            }
            guard let payload = checkpoint.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] else {
                return .missing
            }
            let snapshot = try LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload)
            if checkpoint.projection.state.isTerminal || snapshot.currentStage.isTerminal {
                return .terminal(snapshot)
            }
            return .recovered(snapshot)
        } catch {
            let detail = AgentPrivacyRedactor.safeText(String(describing: error), maxLength: 160).text
            return .recoveryBlocked("local_discovery_snapshot_corrupted:\(detail)")
        }
    }
}
