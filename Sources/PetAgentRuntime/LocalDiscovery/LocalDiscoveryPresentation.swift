import Foundation

public typealias LocalDiscoveryCandidateID = String
public typealias LocalDiscoveryEvidenceID = String

public enum LocalDiscoverySortMode: String, Codable, Sendable, Hashable, CaseIterable {
    case recommended
    case distance
    case routeDuration
    case verification

    public var userLabel: String {
        switch self {
        case .recommended: return "推荐顺序"
        case .distance: return "距离"
        case .routeDuration: return "路线时间"
        case .verification: return "可信度"
        }
    }
}

public enum LocalDiscoveryEmptyReason: String, Codable, Sendable, Hashable, CaseIterable {
    case noCandidates
    case noDisplayableCandidates
    case noValidCoordinates
    case ambiguousQuery
    case insufficientEvidence
    case staleResults
    case missingCheckpoint

    public var userTitle: String {
        switch self {
        case .noCandidates: return "没有候选地点"
        case .noDisplayableCandidates: return "没有可展示的地点"
        case .noValidCoordinates: return "没有可用于地图的坐标"
        case .ambiguousQuery: return "搜索范围还不明确"
        case .insufficientEvidence: return "证据不足"
        case .staleResults: return "结果可能已过期"
        case .missingCheckpoint: return "没有可恢复的结果"
        }
    }

    public var userSuggestion: String {
        switch self {
        case .noCandidates, .noDisplayableCandidates:
            return "可以尝试扩大搜索区域或减少筛选条件。"
        case .noValidCoordinates:
            return "列表仍可比较；地图只显示有可靠坐标的候选。"
        case .ambiguousQuery:
            return "可以添加城市、邮编或附近地标。"
        case .insufficientEvidence:
            return "可以重新描述你需要的商户类型或减少硬性条件。"
        case .staleResults:
            return "可以重新发起一次新的搜索。"
        case .missingCheckpoint:
            return "可以返回聊天重新发起查询。"
        }
    }
}

public enum LocalDiscoveryPresentationErrorKind: String, Codable, Sendable, Hashable, CaseIterable {
    case permissionUnavailable
    case locationUnavailable
    case searchServiceError
    case routeServiceError
    case evidenceReadError
    case synthesisError
    case recoveryCorrupted
    case unknown
}

public struct LocalDiscoveryPresentationError: Codable, Sendable, Hashable {
    public var kind: LocalDiscoveryPresentationErrorKind
    public var userMessage: String

    public init(kind: LocalDiscoveryPresentationErrorKind, userMessage: String) {
        self.kind = kind
        self.userMessage = AgentPrivacyRedactor.safeText(userMessage, maxLength: 240).text
    }
}

public enum LocalDiscoveryPresentationStatus: Sendable, Hashable {
    case preparing
    case searching
    case routing
    case readingEvidence
    case verifying
    case synthesizing
    case complete
    case partial
    case empty(LocalDiscoveryEmptyReason)
    case cancelled
    case failed(LocalDiscoveryPresentationError)

    public var isTerminal: Bool {
        switch self {
        case .complete, .partial, .empty, .cancelled, .failed:
            return true
        case .preparing, .searching, .routing, .readingEvidence, .verifying, .synthesizing:
            return false
        }
    }

    public var userLabel: String {
        switch self {
        case .preparing: return "正在理解需求"
        case .searching: return "正在搜索地点"
        case .routing: return "正在估算路线"
        case .readingEvidence: return "正在核对公开信息"
        case .verifying: return "正在验证结果"
        case .synthesizing: return "正在整理结果"
        case .complete: return "已完成"
        case .partial: return "部分结果"
        case .empty(let reason): return reason.userTitle
        case .cancelled: return "已停止"
        case .failed: return "未完成"
        }
    }
}

public enum LocalDiscoveryVerificationFieldState: String, Codable, Sendable, Hashable, CaseIterable {
    case confirmed
    case partial
    case unknown
    case conflicting
    case stale
    case notApplicable

    public var userLabel: String {
        switch self {
        case .confirmed: return "已确认"
        case .partial: return "部分信息"
        case .unknown: return "尚未确认"
        case .conflicting: return "来源不一致"
        case .stale: return "可能已过期"
        case .notApplicable: return "不适用"
        }
    }
}

public struct LocalDiscoveryQuerySummary: Codable, Sendable, Hashable {
    public var intentSummary: String
    public var searchText: String
    public var categoryLabel: String
    public var locationLabel: String
    public var constraintSummaries: [String]
    public var resultCountSummary: String
    public var statusSummary: String

    public init(intentSummary: String,
                searchText: String,
                categoryLabel: String,
                locationLabel: String,
                constraintSummaries: [String],
                resultCountSummary: String,
                statusSummary: String) {
        self.intentSummary = AgentPrivacyRedactor.safeText(intentSummary, maxLength: 360).text
        self.searchText = AgentPrivacyRedactor.safeText(searchText, maxLength: 240).text
        self.categoryLabel = AgentPrivacyRedactor.safeSummary(categoryLabel, fallback: "地点")
        self.locationLabel = AgentPrivacyRedactor.safeText(locationLabel, maxLength: 240).text
        self.constraintSummaries = constraintSummaries.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
        self.resultCountSummary = AgentPrivacyRedactor.safeSummary(resultCountSummary, fallback: "结果数量未知")
        self.statusSummary = AgentPrivacyRedactor.safeText(statusSummary, maxLength: 300).text
    }
}

public struct LocalDiscoveryCoordinatePresentation: Codable, Sendable, Hashable {
    public var latitude: Double
    public var longitude: Double
    public var accuracyMeters: Double?

    public init(latitude: Double, longitude: Double, accuracyMeters: Double? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
    }
}

public struct LocalDiscoveryMapAnnotationPresentation: Codable, Sendable, Hashable, Identifiable {
    public var id: LocalDiscoveryCandidateID
    public var title: String
    public var coordinate: LocalDiscoveryCoordinatePresentation
    public var verificationState: LocalDiscoveryVerificationFieldState
    public var accessibilityLabel: String

    public init(id: LocalDiscoveryCandidateID,
                title: String,
                coordinate: LocalDiscoveryCoordinatePresentation,
                verificationState: LocalDiscoveryVerificationFieldState,
                accessibilityLabel: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "地点")
        self.coordinate = coordinate
        self.verificationState = verificationState
        self.accessibilityLabel = AgentPrivacyRedactor.safeText(accessibilityLabel, maxLength: 360).text
    }
}

public struct LocalDiscoveryFieldPresentation: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    public var value: String
    public var state: LocalDiscoveryVerificationFieldState
    public var detail: String?
    public var evidenceIDs: [LocalDiscoveryEvidenceID]

    public init(id: String,
                label: String,
                value: String,
                state: LocalDiscoveryVerificationFieldState,
                detail: String? = nil,
                evidenceIDs: [LocalDiscoveryEvidenceID] = []) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: "字段")
        self.value = AgentPrivacyRedactor.safeText(value, maxLength: 400).text
        self.state = state
        self.detail = detail.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
        self.evidenceIDs = evidenceIDs.map(AgentEventRedactor.safeIdentifier).sorted()
    }
}

public struct LocalDiscoveryEvidenceItemPresentation: Codable, Sendable, Hashable, Identifiable {
    public var id: LocalDiscoveryEvidenceID
    public var sourceType: String
    public var sourceTitle: String
    public var observedAt: Date?
    public var supportedFields: [String]
    public var state: LocalDiscoveryVerificationFieldState
    public var freshness: String
    public var confidenceLabel: String
    public var developerToolID: String?

    public init(id: LocalDiscoveryEvidenceID,
                sourceType: String,
                sourceTitle: String,
                observedAt: Date?,
                supportedFields: [String],
                state: LocalDiscoveryVerificationFieldState,
                freshness: String,
                confidenceLabel: String,
                developerToolID: String? = nil) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.sourceType = AgentPrivacyRedactor.safeSummary(sourceType, fallback: "来源")
        self.sourceTitle = AgentPrivacyRedactor.safeText(sourceTitle, maxLength: 360).text
        self.observedAt = observedAt
        self.supportedFields = supportedFields.map { AgentPrivacyRedactor.safeSummary($0, fallback: "字段") }
        self.state = state
        self.freshness = AgentPrivacyRedactor.safeSummary(freshness, fallback: "unknown")
        self.confidenceLabel = AgentPrivacyRedactor.safeSummary(confidenceLabel, fallback: "置信度未知")
        self.developerToolID = developerToolID.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct LocalDiscoveryEvidencePresentation: Codable, Sendable, Hashable {
    public var summaryLines: [String]
    public var items: [LocalDiscoveryEvidenceItemPresentation]
    public var conflictCount: Int
    public var staleCount: Int
    public var unknownFieldCount: Int

    public init(summaryLines: [String],
                items: [LocalDiscoveryEvidenceItemPresentation],
                conflictCount: Int,
                staleCount: Int,
                unknownFieldCount: Int) {
        self.summaryLines = summaryLines.map { AgentPrivacyRedactor.safeText($0, maxLength: 360).text }
        self.items = items
        self.conflictCount = max(0, conflictCount)
        self.staleCount = max(0, staleCount)
        self.unknownFieldCount = max(0, unknownFieldCount)
    }
}

public struct LocalDiscoveryDeveloperDiagnostics: Codable, Sendable, Hashable {
    public var workflowStage: String
    public var verifierVerdict: String?
    public var backend: String?
    public var checkpointRecoveryFlag: Bool
    public var toolCompletionIDs: [String]
    public var warnings: [String]

    public init(workflowStage: String,
                verifierVerdict: String?,
                backend: String?,
                checkpointRecoveryFlag: Bool,
                toolCompletionIDs: [String],
                warnings: [String]) {
        self.workflowStage = AgentEventRedactor.safeIdentifier(workflowStage)
        self.verifierVerdict = verifierVerdict.map(AgentEventRedactor.safeIdentifier)
        self.backend = backend.map { AgentPrivacyRedactor.safeSummary($0, fallback: "unknown") }
        self.checkpointRecoveryFlag = checkpointRecoveryFlag
        self.toolCompletionIDs = toolCompletionIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.warnings = warnings.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public struct LocalDiscoveryCandidatePresentation: Codable, Sendable, Hashable, Identifiable {
    public var id: LocalDiscoveryCandidateID
    public var rank: Int
    public var name: String
    public var categoryLabel: String
    public var addressSummary: String
    public var distanceSummary: String
    public var straightLineDistanceSummary: String
    public var routeDistanceSummary: String
    public var routeDurationSummary: String
    public var openingSummary: String
    public var priceSummary: String
    public var parkingSummary: String
    public var serviceAvailabilitySummary: String
    public var rationale: String?
    public var verificationLabel: String
    public var verificationState: LocalDiscoveryVerificationFieldState
    public var confidenceSummary: String
    public var isSelected: Bool
    public var hasValidCoordinate: Bool
    public var coordinate: LocalDiscoveryCoordinatePresentation?
    public var fields: [LocalDiscoveryFieldPresentation]
    public var evidence: [LocalDiscoveryEvidenceItemPresentation]
    public var conflictSummaries: [String]
    public var unknownSummaries: [String]
    public var handoffContext: PlaceHandoffCandidateContext
    public var handoffActions: [PlaceHandoffActionPresentation]
    public var developerDiagnostics: LocalDiscoveryDeveloperDiagnostics?
    public var accessibilityLabel: String

    public init(id: LocalDiscoveryCandidateID,
                rank: Int,
                name: String,
                categoryLabel: String,
                addressSummary: String,
                distanceSummary: String,
                straightLineDistanceSummary: String,
                routeDistanceSummary: String,
                routeDurationSummary: String,
                openingSummary: String,
                priceSummary: String,
                parkingSummary: String,
                serviceAvailabilitySummary: String,
                rationale: String?,
                verificationLabel: String,
                verificationState: LocalDiscoveryVerificationFieldState,
                confidenceSummary: String,
                isSelected: Bool,
                hasValidCoordinate: Bool,
                coordinate: LocalDiscoveryCoordinatePresentation?,
                fields: [LocalDiscoveryFieldPresentation],
                evidence: [LocalDiscoveryEvidenceItemPresentation],
                conflictSummaries: [String],
                unknownSummaries: [String],
                handoffContext: PlaceHandoffCandidateContext,
                handoffActions: [PlaceHandoffActionPresentation],
                developerDiagnostics: LocalDiscoveryDeveloperDiagnostics?,
                accessibilityLabel: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.rank = max(1, rank)
        self.name = AgentPrivacyRedactor.safeSummary(name, fallback: "地点")
        self.categoryLabel = AgentPrivacyRedactor.safeSummary(categoryLabel, fallback: "地点")
        self.addressSummary = AgentPrivacyRedactor.safeText(addressSummary, maxLength: 500).text
        self.distanceSummary = AgentPrivacyRedactor.safeSummary(distanceSummary, fallback: "距离待确认")
        self.straightLineDistanceSummary = AgentPrivacyRedactor.safeSummary(straightLineDistanceSummary, fallback: "直线距离待确认")
        self.routeDistanceSummary = AgentPrivacyRedactor.safeSummary(routeDistanceSummary, fallback: "路线距离待确认")
        self.routeDurationSummary = AgentPrivacyRedactor.safeSummary(routeDurationSummary, fallback: "路线时间待确认")
        self.openingSummary = AgentPrivacyRedactor.safeSummary(openingSummary, fallback: "营业状态待确认")
        self.priceSummary = AgentPrivacyRedactor.safeSummary(priceSummary, fallback: "价格待确认")
        self.parkingSummary = AgentPrivacyRedactor.safeSummary(parkingSummary, fallback: "停车待确认")
        self.serviceAvailabilitySummary = AgentPrivacyRedactor.safeSummary(serviceAvailabilitySummary, fallback: "服务可用性待确认")
        self.rationale = rationale.map { AgentPrivacyRedactor.safeText($0, maxLength: 500).text }
        self.verificationLabel = AgentPrivacyRedactor.safeSummary(verificationLabel, fallback: "尚未确认")
        self.verificationState = verificationState
        self.confidenceSummary = AgentPrivacyRedactor.safeSummary(confidenceSummary, fallback: "置信度未知")
        self.isSelected = isSelected
        self.hasValidCoordinate = hasValidCoordinate
        self.coordinate = coordinate
        self.fields = fields
        self.evidence = evidence
        self.conflictSummaries = conflictSummaries.map { AgentPrivacyRedactor.safeText($0, maxLength: 360).text }
        self.unknownSummaries = unknownSummaries.map { AgentPrivacyRedactor.safeText($0, maxLength: 360).text }
        self.handoffContext = handoffContext
        self.handoffActions = handoffActions
        self.developerDiagnostics = developerDiagnostics
        self.accessibilityLabel = AgentPrivacyRedactor.safeText(accessibilityLabel, maxLength: 900).text
    }
}

public struct LocalDiscoveryPresentation: Sendable, Hashable {
    public var taskID: AgentTaskID
    public var runID: AgentRunID
    public var querySummary: LocalDiscoveryQuerySummary
    public var status: LocalDiscoveryPresentationStatus
    public var candidates: [LocalDiscoveryCandidatePresentation]
    public var sortMode: LocalDiscoverySortMode
    public var selectedCandidateID: LocalDiscoveryCandidateID?
    public var evidenceSummary: LocalDiscoveryEvidencePresentation
    public var generatedAt: Date?
    public var recoveredFromCheckpoint: Bool
    public var mapAnnotations: [LocalDiscoveryMapAnnotationPresentation]
    public var validCoordinateCount: Int
    public var developerDiagnostics: LocalDiscoveryDeveloperDiagnostics?

    public init(taskID: AgentTaskID,
                runID: AgentRunID,
                querySummary: LocalDiscoveryQuerySummary,
                status: LocalDiscoveryPresentationStatus,
                candidates: [LocalDiscoveryCandidatePresentation],
                sortMode: LocalDiscoverySortMode,
                selectedCandidateID: LocalDiscoveryCandidateID?,
                evidenceSummary: LocalDiscoveryEvidencePresentation,
                generatedAt: Date?,
                recoveredFromCheckpoint: Bool,
                mapAnnotations: [LocalDiscoveryMapAnnotationPresentation],
                developerDiagnostics: LocalDiscoveryDeveloperDiagnostics?) {
        self.taskID = taskID
        self.runID = runID
        self.querySummary = querySummary
        self.status = status
        self.candidates = candidates
        self.sortMode = sortMode
        self.selectedCandidateID = selectedCandidateID.map(AgentEventRedactor.safeIdentifier)
        self.evidenceSummary = evidenceSummary
        self.generatedAt = generatedAt
        self.recoveredFromCheckpoint = recoveredFromCheckpoint
        self.mapAnnotations = mapAnnotations
        self.validCoordinateCount = mapAnnotations.count
        self.developerDiagnostics = developerDiagnostics
    }
}

public enum LocalDiscoveryPresentationAdapter {
    public static func make(from checkpoint: AgentCheckpoint,
                            sortMode: LocalDiscoverySortMode = .recommended,
                            selectedCandidateID: LocalDiscoveryCandidateID? = nil,
                            recoveredFromCheckpoint: Bool = true,
                            includeDeveloperDiagnostics: Bool = false) -> LocalDiscoveryPresentation {
        guard let payload = checkpoint.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] else {
            return missingCheckpointPresentation(taskID: checkpoint.taskID,
                                                 runID: checkpoint.runID,
                                                 status: .empty(.missingCheckpoint),
                                                 sortMode: sortMode,
                                                 selectedCandidateID: selectedCandidateID,
                                                 generatedAt: checkpoint.updatedAt,
                                                 recoveredFromCheckpoint: recoveredFromCheckpoint)
        }
        do {
            let snapshot = try LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload)
            return make(snapshot: snapshot,
                        runState: checkpoint.projection.state,
                        resultDocument: checkpoint.resultDocument ?? checkpoint.projection.resultDocument,
                        sortMode: sortMode,
                        selectedCandidateID: selectedCandidateID,
                        recoveredFromCheckpoint: recoveredFromCheckpoint,
                        includeDeveloperDiagnostics: includeDeveloperDiagnostics)
        } catch {
            return missingCheckpointPresentation(taskID: checkpoint.taskID,
                                                 runID: checkpoint.runID,
                                                 status: .failed(.init(kind: .recoveryCorrupted,
                                                                       userMessage: "恢复数据损坏，无法安全展示地点结果。")),
                                                 sortMode: sortMode,
                                                 selectedCandidateID: selectedCandidateID,
                                                 generatedAt: checkpoint.updatedAt,
                                                 recoveredFromCheckpoint: recoveredFromCheckpoint)
        }
    }

    public static func make(snapshot: LocalDiscoveryWorkflowSnapshot,
                            runState: AgentRunState? = nil,
                            resultDocument: AgentResultDocument? = nil,
                            sortMode: LocalDiscoverySortMode = .recommended,
                            selectedCandidateID: LocalDiscoveryCandidateID? = nil,
                            recoveredFromCheckpoint: Bool = false,
                            includeDeveloperDiagnostics: Bool = false) -> LocalDiscoveryPresentation {
        let query = snapshot.approvedQuery
        let reconstructed = reconstructCandidates(snapshot: snapshot)
        let ordered = orderCandidates(reconstructed.included,
                                      rankedCandidateIDs: snapshot.rankedCandidateIDs,
                                      sortMode: sortMode)
        let evidenceIndex = evidenceItems(snapshot: snapshot,
                                          candidates: reconstructed.all,
                                          includeDeveloperDiagnostics: includeDeveloperDiagnostics)
        let candidatePresentations = ordered.enumerated().map { index, candidate in
            candidatePresentation(candidate,
                                  taskID: snapshot.taskID,
                                  runID: snapshot.runID,
                                  rank: index + 1,
                                  selectedCandidateID: selectedCandidateID,
                                  evidenceIndex: evidenceIndex,
                                  developerDiagnostics: includeDeveloperDiagnostics ? candidateDiagnostics(snapshot: snapshot,
                                                                                                           candidate: candidate,
                                                                                                           recoveredFromCheckpoint: recoveredFromCheckpoint) : nil)
        }
        let annotations = candidatePresentations.compactMap(annotation)
        let status = presentationStatus(snapshot: snapshot,
                                        runState: runState,
                                        resultDocument: resultDocument,
                                        includedCandidateCount: candidatePresentations.count,
                                        validCoordinateCount: annotations.count,
                                        findingCount: snapshot.validatorFindings.count)
        let visibleCandidatePresentations: [LocalDiscoveryCandidatePresentation]
        let visibleAnnotations: [LocalDiscoveryMapAnnotationPresentation]
        switch status {
        case .cancelled, .failed:
            visibleCandidatePresentations = []
            visibleAnnotations = []
        default:
            visibleCandidatePresentations = candidatePresentations
            visibleAnnotations = annotations
        }
        let evidenceSummary = aggregateEvidenceSummary(candidates: visibleCandidatePresentations,
                                                       evidenceItems: Array(evidenceIndex.values).sorted { $0.id < $1.id },
                                                       findings: snapshot.validatorFindings)
        let querySummary = makeQuerySummary(query: query,
                                            resolvedLocation: snapshot.resolvedLocation,
                                            status: status,
                                            candidates: visibleCandidatePresentations,
                                            excludedCount: reconstructed.excluded.count,
                                            warnings: snapshot.warnings)
        let developerDiagnostics = includeDeveloperDiagnostics
            ? LocalDiscoveryDeveloperDiagnostics(workflowStage: snapshot.currentStage.rawValue,
                                                verifierVerdict: snapshot.verifierDisposition?.verdict.rawValue,
                                                backend: snapshot.backend,
                                                checkpointRecoveryFlag: recoveredFromCheckpoint,
                                                toolCompletionIDs: snapshot.toolCompletions.map(\.id),
                                                warnings: snapshot.warnings)
            : nil
        return LocalDiscoveryPresentation(taskID: snapshot.taskID,
                                          runID: snapshot.runID,
                                          querySummary: querySummary,
                                          status: status,
                                          candidates: visibleCandidatePresentations,
                                          sortMode: sortMode,
                                          selectedCandidateID: selectedCandidateID,
                                          evidenceSummary: evidenceSummary,
                                          generatedAt: resultDocument?.generatedAt ?? snapshot.updatedAt,
                                          recoveredFromCheckpoint: recoveredFromCheckpoint,
                                          mapAnnotations: visibleAnnotations,
                                          developerDiagnostics: developerDiagnostics)
    }

    private static func missingCheckpointPresentation(taskID: UUID,
                                                      runID: UUID,
                                                      status: LocalDiscoveryPresentationStatus,
                                                      sortMode: LocalDiscoverySortMode,
                                                      selectedCandidateID: LocalDiscoveryCandidateID?,
                                                      generatedAt: Date?,
                                                      recoveredFromCheckpoint: Bool) -> LocalDiscoveryPresentation {
        let query = LocalDiscoveryQuerySummary(intentSummary: "地点搜索结果",
                                              searchText: "地点搜索",
                                              categoryLabel: "地点",
                                              locationLabel: "位置待确认",
                                              constraintSummaries: [],
                                              resultCountSummary: "0 个候选地点",
                                              statusSummary: status.userLabel)
        return LocalDiscoveryPresentation(taskID: taskID,
                                          runID: runID,
                                          querySummary: query,
                                          status: status,
                                          candidates: [],
                                          sortMode: sortMode,
                                          selectedCandidateID: selectedCandidateID,
                                          evidenceSummary: .init(summaryLines: ["没有可恢复的 Local Discovery checkpoint。"],
                                                                 items: [],
                                                                 conflictCount: 0,
                                                                 staleCount: 0,
                                                                 unknownFieldCount: 0),
                                          generatedAt: generatedAt,
                                          recoveredFromCheckpoint: recoveredFromCheckpoint,
                                          mapAnnotations: [],
                                          developerDiagnostics: .init(workflowStage: "missing",
                                                                      verifierVerdict: nil,
                                                                      backend: nil,
                                                                      checkpointRecoveryFlag: recoveredFromCheckpoint,
                                                                      toolCompletionIDs: [],
                                                                      warnings: ["missing checkpoint for \(taskID.uuidString):\(runID.uuidString)"]))
    }

    private static func reconstructCandidates(snapshot: LocalDiscoveryWorkflowSnapshot) -> (included: [PlaceCandidate], excluded: [PlaceCandidate], all: [PlaceCandidate]) {
        let base = snapshot.mergedCandidates.isEmpty ? snapshot.rawCandidates : snapshot.mergedCandidates
        let findingsByCandidate = Dictionary(grouping: snapshot.validatorFindings, by: \.candidateID)
        let report = LocalDiscoveryValidationReport(findings: snapshot.validatorFindings)
        var included: [PlaceCandidate] = []
        var excluded: [PlaceCandidate] = []
        var all: [PlaceCandidate] = []
        for original in base {
            var candidate = original
            let findings = findingsByCandidate[candidate.stableID] ?? []
            if !findings.isEmpty {
                candidate.findings = findings
                candidate.verificationStatus = verificationStatus(from: findings)
                if candidate.recommendationRationale == nil {
                    candidate.recommendationRationale = recommendationFallback(candidate)
                }
            }
            all.append(candidate)
            guard !snapshot.validatorFindings.isEmpty else {
                included.append(candidate)
                continue
            }
            switch report.disposition(for: candidate.stableID) {
            case .excludeHardConstraintFailure, .excludeConflict:
                excluded.append(candidate)
            case .requiresMoreEvidence, .includeVerified, .includeWithWarning:
                included.append(candidate)
            }
        }
        return (included, excluded, all)
    }

    private static func verificationStatus(from findings: [PlaceVerificationFinding]) -> PlaceVerificationStatus {
        if findings.contains(where: { $0.recommendedDisposition == .excludeConflict }) { return .conflicting }
        if findings.contains(where: { $0.criterion == "stale_evidence" && $0.status == .uncertain }) { return .stale }
        if findings.contains(where: { $0.severity == .blocking && $0.status == .failed }) { return .unsupported }
        if findings.contains(where: { $0.status == .uncertain || $0.severity == .warning }) { return .partiallyVerified }
        if findings.isEmpty { return .unknown }
        return .verified
    }

    private static func orderCandidates(_ candidates: [PlaceCandidate],
                                        rankedCandidateIDs: [String],
                                        sortMode: LocalDiscoverySortMode) -> [PlaceCandidate] {
        let index = Dictionary(uniqueKeysWithValues: candidates.enumerated().map { ($0.element.stableID, $0.offset) })
        switch sortMode {
        case .recommended:
            guard !rankedCandidateIDs.isEmpty else { return candidates }
            let rankIndex = Dictionary(uniqueKeysWithValues: rankedCandidateIDs.enumerated().map { ($0.element, $0.offset) })
            return candidates.sorted {
                let lhsRank = rankIndex[$0.stableID] ?? Int.max
                let rhsRank = rankIndex[$1.stableID] ?? Int.max
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return (index[$0.stableID] ?? Int.max) < (index[$1.stableID] ?? Int.max)
            }
        case .distance:
            return stableSorted(candidates, originalIndex: index) {
                comparableDistance($0) < comparableDistance($1)
            }
        case .routeDuration:
            return stableSorted(candidates, originalIndex: index) {
                comparableDuration($0) < comparableDuration($1)
            }
        case .verification:
            return stableSorted(candidates, originalIndex: index) {
                verificationScore($0.verificationStatus) > verificationScore($1.verificationStatus)
            }
        }
    }

    private static func stableSorted(_ candidates: [PlaceCandidate],
                                     originalIndex: [String: Int],
                                     areInIncreasingOrder: (PlaceCandidate, PlaceCandidate) -> Bool) -> [PlaceCandidate] {
        candidates.sorted {
            if areInIncreasingOrder($0, $1) { return true }
            if areInIncreasingOrder($1, $0) { return false }
            return (originalIndex[$0.stableID] ?? Int.max) < (originalIndex[$1.stableID] ?? Int.max)
        }
    }

    private static func comparableDistance(_ candidate: PlaceCandidate) -> Double {
        candidate.travelEstimate?.routeDistance?.meters
            ?? candidate.travelEstimate?.straightLineDistance?.meters
            ?? candidate.distance?.meters
            ?? Double.greatestFiniteMagnitude
    }

    private static func comparableDuration(_ candidate: PlaceCandidate) -> Double {
        candidate.travelEstimate?.estimatedTravelDurationSeconds ?? Double.greatestFiniteMagnitude
    }

    private static func verificationScore(_ status: PlaceVerificationStatus) -> Int {
        switch status {
        case .verified: return 5
        case .partiallyVerified: return 4
        case .unknown: return 3
        case .stale: return 2
        case .conflicting: return 1
        case .unsupported: return 0
        }
    }

    private static func presentationStatus(snapshot: LocalDiscoveryWorkflowSnapshot,
                                           runState: AgentRunState?,
                                           resultDocument: AgentResultDocument?,
                                           includedCandidateCount: Int,
                                           validCoordinateCount: Int,
                                           findingCount: Int) -> LocalDiscoveryPresentationStatus {
        if snapshot.currentStage == .cancelled || runState == .cancelled {
            return .cancelled
        }
        if snapshot.currentStage == .recoveryBlocked {
            return .failed(.init(kind: .recoveryCorrupted,
                                 userMessage: "恢复数据损坏，无法安全展示地点结果。"))
        }
        if runState == .failed || resultDocument?.status == .failed {
            return .failed(.init(kind: .unknown,
                                 userMessage: "地点搜索没有完成，可以重新描述需求后再试。"))
        }
        if includedCandidateCount == 0 {
            if snapshot.approvedQuery == nil {
                return .empty(.ambiguousQuery)
            }
            if snapshot.currentStage >= .initialSearchCompleted {
                return .empty(.noCandidates)
            }
            return .empty(.insufficientEvidence)
        }
        if validCoordinateCount == 0, snapshot.currentStage >= .resultSynthesized {
            return .partial
        }
        if snapshot.currentStage >= .resultSynthesized {
            if runState == .partiallySucceeded
                || resultDocument?.status == .partial
                || snapshot.verifierDisposition?.verdict == .partialPass
                || findingCount > 0
                || !snapshot.warnings.isEmpty {
                return .partial
            }
            return .complete
        }
        switch snapshot.currentStage {
        case .created, .queryApproved, .locationResolved:
            return .preparing
        case .initialSearchCompleted, .dedupCompleted:
            return .searching
        case .routeItemCompleted, .routeBatchCompleted:
            return .routing
        case .enrichmentItemCompleted, .enrichmentBatchCompleted:
            return .readingEvidence
        case .validationCompleted, .verifierCompleted:
            return includedCandidateCount > 0 ? .partial : .verifying
        case .resultSynthesized:
            return .complete
        case .cancelled:
            return .cancelled
        case .recoveryBlocked:
            return .failed(.init(kind: .recoveryCorrupted,
                                 userMessage: "恢复数据损坏，无法安全展示地点结果。"))
        }
    }

    private static func makeQuerySummary(query: PlaceQuery?,
                                         resolvedLocation: LocalDiscoveryResolvedLocationSnapshot?,
                                         status: LocalDiscoveryPresentationStatus,
                                         candidates: [LocalDiscoveryCandidatePresentation],
                                         excludedCount: Int,
                                         warnings: [String]) -> LocalDiscoveryQuerySummary {
        let searchText = query?.searchText ?? "地点搜索"
        let category = query.map { categoryLabel($0.category) } ?? "地点"
        let location = resolvedLocation?.label ?? query?.locationInput.label ?? "位置待确认"
        let routeCount = candidates.filter { !$0.routeDurationSummary.contains("待确认") && !$0.routeDurationSummary.contains("未获得") }.count
        let unknownCount = candidates.reduce(0) { $0 + $1.unknownSummaries.count }
        var constraints: [String] = []
        if let query {
            constraints.append(contentsOf: query.hardConstraints.map { constraintSummary($0, prefix: "必须") })
            constraints.append(contentsOf: query.softPreferences.map { constraintSummary($0, prefix: "偏好") })
            if let budget = query.budget, let max = budget.maximumAmount {
                constraints.append("预算：\(budget.currencyCode) \(Int(max))\(budget.perPerson ? "/人" : "") 以内")
            }
            if let travel = query.travelLimit {
                if let maxMinutes = travel.maximumTravelTimeSeconds.map({ Int(ceil($0 / 60)) }) {
                    constraints.append("路线时间：约 \(maxMinutes) 分钟内")
                }
                if let maxDistance = travel.maximumDistanceMeters {
                    constraints.append("距离：\(formatDistance(maxDistance)) 内")
                }
            }
        }
        let resultCount = "\(candidates.count) 个候选地点" + (excludedCount > 0 ? "，排除 \(excludedCount) 个" : "")
        let routePart = routeCount > 0 ? "其中 \(routeCount) 个具有路线时间" : "路线时间待确认"
        let unknownPart = unknownCount > 0 ? "\(unknownCount) 个字段尚未确认" : "关键字段已整理"
        let warningPart = warnings.isEmpty ? "" : "，有 \(warnings.count) 条限制说明"
        let intent = "\(location) 的 \(category)"
        return LocalDiscoveryQuerySummary(intentSummary: intent,
                                          searchText: searchText,
                                          categoryLabel: category,
                                          locationLabel: location,
                                          constraintSummaries: constraints,
                                          resultCountSummary: resultCount,
                                          statusSummary: "\(status.userLabel)：\(routePart)，\(unknownPart)\(warningPart)。")
    }

    private static func candidatePresentation(_ candidate: PlaceCandidate,
                                              taskID: AgentTaskID,
                                              runID: AgentRunID,
                                              rank: Int,
                                              selectedCandidateID: LocalDiscoveryCandidateID?,
                                              evidenceIndex: [String: LocalDiscoveryEvidenceItemPresentation],
                                              developerDiagnostics: LocalDiscoveryDeveloperDiagnostics?) -> LocalDiscoveryCandidatePresentation {
        let coordinate = validCoordinate(candidate).map {
            LocalDiscoveryCoordinatePresentation(latitude: $0.latitude,
                                                 longitude: $0.longitude,
                                                 accuracyMeters: $0.horizontalAccuracyMeters)
        }
        let opening = openingField(candidate)
        let price = priceField(candidate)
        let parking = parkingField(candidate)
        let routeDistance = routeDistanceField(candidate)
        let straightDistance = straightDistanceField(candidate)
        let routeDuration = routeDurationField(candidate)
        let service = serviceAvailabilityField(candidate)
        let verification = verificationState(candidate.verificationStatus)
        let candidateEvidenceIDs = allEvidenceIDs(candidate)
        let evidence = candidateEvidenceIDs.compactMap { evidenceIndex[$0] }
        let fields = [
            routeDistance,
            straightDistance,
            routeDuration,
            opening,
            price,
            parking,
            service,
        ]
        let conflicts = candidate.findings
            .filter { $0.status == .failed || $0.recommendedDisposition == .excludeConflict }
            .map { "\($0.criterion): \($0.reason)" }
        let unknowns = fields
            .filter { $0.state == .unknown || $0.state == .partial || $0.state == .stale || $0.state == .conflicting }
            .map { "\($0.label)：\($0.value)" }
        let selected = selectedCandidateID == candidate.stableID
        let handoffContext = PlaceHandoffCandidateContext(taskID: taskID,
                                                          runID: runID,
                                                          candidateID: candidate.stableID,
                                                          name: candidate.name,
                                                          address: candidate.address,
                                                          coordinate: candidate.coordinate,
                                                          contact: candidate.contact,
                                                          webLinks: candidate.webLinks,
                                                          evidenceReferences: allEvidenceReferences(candidate),
                                                          verificationStatus: candidate.verificationStatus,
                                                          freshness: candidate.freshness,
                                                          findings: candidate.findings,
                                                          directionsOrigin: .currentLocation(.approximateCurrentLocation),
                                                          isPresentInCurrentPresentation: true)
        let handoffActions = PlaceHandoffEligibilityEvaluator.actionPresentations(for: handoffContext)
        let accessibility = [
            candidate.name,
            candidate.address?.formatted ?? "地址待确认",
            routeDistance.value,
            routeDuration.value,
            opening.value,
            verification.userLabel,
            selected ? "已选中" : nil,
        ].compactMap { $0 }.joined(separator: "，")
        return LocalDiscoveryCandidatePresentation(id: candidate.stableID,
                                                   rank: rank,
                                                   name: candidate.name,
                                                   categoryLabel: categoryLabel(candidate.categories.first ?? .place),
                                                   addressSummary: candidate.address?.formatted ?? "地址待确认",
                                                   distanceSummary: preferredDistanceSummary(candidate),
                                                   straightLineDistanceSummary: straightDistance.value,
                                                   routeDistanceSummary: routeDistance.value,
                                                   routeDurationSummary: routeDuration.value,
                                                   openingSummary: opening.value,
                                                   priceSummary: price.value,
                                                   parkingSummary: parking.value,
                                                   serviceAvailabilitySummary: service.value,
                                                   rationale: candidate.recommendationRationale,
                                                   verificationLabel: verification.userLabel,
                                                   verificationState: verification,
                                                   confidenceSummary: confidenceSummary(candidate),
                                                   isSelected: selected,
                                                   hasValidCoordinate: coordinate != nil,
                                                   coordinate: coordinate,
                                                   fields: fields,
                                                   evidence: evidence,
                                                   conflictSummaries: conflicts,
                                                   unknownSummaries: unknowns,
                                                   handoffContext: handoffContext,
                                                   handoffActions: handoffActions,
                                                   developerDiagnostics: developerDiagnostics,
                                                   accessibilityLabel: accessibility)
    }

    private static func annotation(_ candidate: LocalDiscoveryCandidatePresentation) -> LocalDiscoveryMapAnnotationPresentation? {
        guard let coordinate = candidate.coordinate else { return nil }
        return LocalDiscoveryMapAnnotationPresentation(id: candidate.id,
                                                       title: candidate.name,
                                                       coordinate: coordinate,
                                                       verificationState: candidate.verificationState,
                                                       accessibilityLabel: "地图标记，\(candidate.name)，\(candidate.addressSummary)，\(candidate.verificationLabel)")
    }

    private static func validCoordinate(_ candidate: PlaceCandidate) -> PlaceCoordinate? {
        guard let coordinate = candidate.coordinate,
              coordinate.latitude.isFinite,
              coordinate.longitude.isFinite,
              (-90...90).contains(coordinate.latitude),
              (-180...180).contains(coordinate.longitude) else {
            return nil
        }
        if let accuracy = coordinate.horizontalAccuracyMeters, accuracy > 50_000 {
            return nil
        }
        let coordinateConflict = candidate.findings.contains {
            $0.criterion.lowercased().contains("coordinate")
                && ($0.status == .failed || $0.recommendedDisposition == .excludeConflict)
        }
        return coordinateConflict ? nil : coordinate
    }

    private static func evidenceItems(snapshot: LocalDiscoveryWorkflowSnapshot,
                                      candidates: [PlaceCandidate],
                                      includeDeveloperDiagnostics: Bool) -> [String: LocalDiscoveryEvidenceItemPresentation] {
        var refs: [String: PlaceEvidenceReference] = [:]
        for candidate in candidates {
            for ref in allEvidenceReferences(candidate) {
                refs[ref.evidenceID] = ref
            }
        }
        for id in snapshot.webpageEvidenceIDs + snapshot.extractionEvidenceIDs where refs[id] == nil {
            refs[id] = PlaceEvidenceReference(evidenceID: id,
                                              claim: id.contains("extract") ? "Structured place extraction evidence" : "Webpage evidence",
                                              freshness: "current-task",
                                              confidence: 0.45)
        }
        return refs.mapValues { ref in
            let state = ref.freshness.lowercased().contains("stale") ? LocalDiscoveryVerificationFieldState.stale
                : ref.confidence >= 0.75 ? .confirmed
                : ref.confidence > 0 ? .partial
                : .unknown
            return LocalDiscoveryEvidenceItemPresentation(id: ref.evidenceID,
                                                          sourceType: ref.sourceToolID?.rawValue ?? "source",
                                                          sourceTitle: ref.claim,
                                                          observedAt: ref.observedAt,
                                                          supportedFields: [ref.claim],
                                                          state: state,
                                                          freshness: ref.freshness,
                                                          confidenceLabel: confidenceLabel(ref.confidence),
                                                          developerToolID: includeDeveloperDiagnostics ? ref.sourceToolID?.rawValue : nil)
        }
    }

    private static func aggregateEvidenceSummary(candidates: [LocalDiscoveryCandidatePresentation],
                                                 evidenceItems: [LocalDiscoveryEvidenceItemPresentation],
                                                 findings: [PlaceVerificationFinding]) -> LocalDiscoveryEvidencePresentation {
        let conflictCount = findings.filter { $0.recommendedDisposition == .excludeConflict || $0.status == .failed && $0.severity == .blocking }.count
        let staleCount = evidenceItems.filter { $0.state == .stale }.count
        let unknownCount = candidates.reduce(0) { $0 + $1.fields.filter { $0.state == .unknown }.count }
        var lines: [String] = []
        if evidenceItems.isEmpty {
            lines.append("没有可展示的证据来源，字段保持待确认。")
        } else {
            lines.append("共有 \(evidenceItems.count) 条证据引用；置信度较低或缺失的字段保持待确认。")
        }
        if conflictCount > 0 {
            lines.append("发现 \(conflictCount) 条来源不一致或阻断性验证问题。")
        }
        if staleCount > 0 {
            lines.append("\(staleCount) 条证据可能已过期。")
        }
        if unknownCount > 0 {
            lines.append("\(unknownCount) 个字段尚未确认，没有被改写成否定结论。")
        }
        return LocalDiscoveryEvidencePresentation(summaryLines: lines,
                                                  items: evidenceItems,
                                                  conflictCount: conflictCount,
                                                  staleCount: staleCount,
                                                  unknownFieldCount: unknownCount)
    }

    private static func candidateDiagnostics(snapshot: LocalDiscoveryWorkflowSnapshot,
                                             candidate: PlaceCandidate,
                                             recoveredFromCheckpoint: Bool) -> LocalDiscoveryDeveloperDiagnostics {
        let completions = snapshot.toolCompletions
            .filter { $0.targetID == candidate.stableID || $0.evidenceIDs.contains(where: Set(allEvidenceIDs(candidate)).contains) }
            .map(\.id)
        return LocalDiscoveryDeveloperDiagnostics(workflowStage: snapshot.currentStage.rawValue,
                                                  verifierVerdict: snapshot.verifierDisposition?.verdict.rawValue,
                                                  backend: snapshot.backend,
                                                  checkpointRecoveryFlag: recoveredFromCheckpoint,
                                                  toolCompletionIDs: completions,
                                                  warnings: snapshot.warnings)
    }

    private static func verificationState(_ status: PlaceVerificationStatus) -> LocalDiscoveryVerificationFieldState {
        switch status {
        case .verified: return .confirmed
        case .partiallyVerified: return .partial
        case .conflicting: return .conflicting
        case .stale: return .stale
        case .unknown: return .unknown
        case .unsupported: return .notApplicable
        }
    }

    private static func openingField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        let state: LocalDiscoveryVerificationFieldState
        let value: String
        switch candidate.openingStatus.value {
        case .open:
            if candidate.openingStatus.targetTime != nil {
                value = "营业中"
                state = candidate.openingStatus.confidence >= 0.6 ? .confirmed : .partial
            } else {
                value = "可能营业"
                state = .partial
            }
        case .closed:
            if candidate.openingStatus.targetTime != nil {
                value = "已关门"
                state = candidate.openingStatus.confidence >= 0.6 ? .confirmed : .partial
            } else {
                value = "可能已关门"
                state = .partial
            }
        case .unknown:
            if let summary = candidate.openingHours?.valueSummary, !summary.isEmpty {
                value = "营业时间有线索，当前状态待确认"
                state = candidate.openingHours?.freshnessState ?? .partial
            } else {
                value = "营业状态待确认"
                state = .unknown
            }
        case .conflicting:
            value = "营业状态来源不一致"
            state = .conflicting
        }
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-opening",
                                               label: "营业状态",
                                               value: value,
                                               state: state,
                                               detail: candidate.openingStatus.uncertaintyReason,
                                               evidenceIDs: candidate.openingStatus.evidenceReferences.map(\.evidenceID))
    }

    private static func priceField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        let value: String
        let state: LocalDiscoveryVerificationFieldState
        switch candidate.priceEstimate.value {
        case .unknown:
            value = "价格信息待确认"
            state = .unknown
        case .level(let level):
            value = "价格约 \(String(repeating: "$", count: max(1, level)))"
            state = candidate.priceEstimate.fieldState
        case .maximumPerPerson(let amount, let currency):
            value = "约 \(currency) \(roundedAmount(amount)) / 人以内"
            state = candidate.priceEstimate.fieldState
        case .rangePerPerson(let minimum, let maximum, let currency):
            value = "约 \(currency) \(roundedAmount(minimum))-\(roundedAmount(maximum)) / 人"
            state = candidate.priceEstimate.fieldState
        }
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-price",
                                               label: "价格",
                                               value: value,
                                               state: state,
                                               detail: candidate.priceEstimate.uncertaintyReason,
                                               evidenceIDs: candidate.priceEstimate.evidenceReferences.map(\.evidenceID))
    }

    private static func parkingField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        let value: String
        let state: LocalDiscoveryVerificationFieldState
        switch candidate.parkingInfo.value {
        case .unknown:
            value = "停车信息待确认"
            state = .unknown
        case .easy:
            value = "来源称停车较方便"
            state = candidate.parkingInfo.fieldState
        case .available:
            value = "来源称有停车"
            state = candidate.parkingInfo.fieldState
        case .limited:
            value = "来源称停车有限"
            state = candidate.parkingInfo.fieldState
        case .paid:
            value = "来源称需要付费停车"
            state = candidate.parkingInfo.fieldState
        case .none:
            value = "来源称没有停车"
            state = candidate.parkingInfo.fieldState
        }
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-parking",
                                               label: "停车",
                                               value: value,
                                               state: state,
                                               detail: candidate.parkingInfo.uncertaintyReason,
                                               evidenceIDs: candidate.parkingInfo.evidenceReferences.map(\.evidenceID))
    }

    private static func serviceAvailabilityField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        let unsupportedInventory = candidate.findings.contains {
            $0.criterion.lowercased().contains("inventory")
        }
        let value = unsupportedInventory ? "实时库存未验证" : "服务可用性待确认"
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-availability",
                                               label: "库存或服务",
                                               value: value,
                                               state: unsupportedInventory ? .notApplicable : .unknown,
                                               detail: unsupportedInventory ? "Local Discovery 不证明实时库存或即时服务名额。" : nil)
    }

    private static func routeDistanceField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        if let route = candidate.travelEstimate?.routeDistance {
            return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-route-distance",
                                                   label: "路线距离",
                                                   value: "约 \(formatDistance(route.meters))",
                                                   state: route.uncertaintyReason == nil ? .partial : .unknown,
                                                   detail: route.uncertaintyReason)
        }
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-route-distance",
                                               label: "路线距离",
                                               value: "未获得路线距离",
                                               state: .unknown,
                                               detail: candidate.travelEstimate?.uncertaintyReason)
    }

    private static func straightDistanceField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        if let straight = candidate.travelEstimate?.straightLineDistance ?? (candidate.distance?.kind == .straightLine ? candidate.distance : nil) {
            return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-straight-distance",
                                                   label: "直线距离",
                                                   value: "直线约 \(formatDistance(straight.meters))",
                                                   state: .partial,
                                                   detail: "直线距离不是路线距离。")
        }
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-straight-distance",
                                               label: "直线距离",
                                               value: "直线距离待确认",
                                               state: .unknown)
    }

    private static func routeDurationField(_ candidate: PlaceCandidate) -> LocalDiscoveryFieldPresentation {
        guard let seconds = candidate.travelEstimate?.estimatedTravelDurationSeconds else {
            return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-route-duration",
                                                   label: "路线时间",
                                                   value: "未获得路线时间",
                                                   state: .unknown,
                                                   detail: candidate.travelEstimate?.uncertaintyReason)
        }
        return LocalDiscoveryFieldPresentation(id: "\(candidate.stableID)-route-duration",
                                               label: "路线时间",
                                               value: "约 \(Int(ceil(seconds / 60))) 分钟",
                                               state: candidate.travelEstimate?.routeDistance == nil ? .partial : .partial,
                                               detail: candidate.travelEstimate?.uncertaintyReason)
    }

    private static func preferredDistanceSummary(_ candidate: PlaceCandidate) -> String {
        if let route = candidate.travelEstimate?.routeDistance {
            return "路线约 \(formatDistance(route.meters))"
        }
        if let straight = candidate.travelEstimate?.straightLineDistance ?? candidate.distance {
            return "直线约 \(formatDistance(straight.meters))"
        }
        return "距离待确认"
    }

    private static func categoryLabel(_ category: PlaceCategory) -> String {
        switch category.rawValue {
        case "sichuan_restaurant": return "川菜餐厅"
        case "chinese_restaurant": return "中餐厅"
        case "restaurant": return "餐厅"
        case "golf_driving_range": return "高尔夫练习场"
        case "electronics_store": return "电子产品商店"
        case "retail_store": return "零售商店"
        case "place": return "地点"
        default:
            return category.rawValue
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    private static func constraintSummary(_ constraint: PlaceConstraint, prefix: String) -> String {
        "\(prefix)：\(constraint.kind.rawValue)"
    }

    private static func recommendationFallback(_ candidate: PlaceCandidate) -> String {
        var parts: [String] = []
        if candidate.verificationStatus == .verified { parts.append("类别和基础信息有验证支持") }
        if let route = candidate.travelEstimate?.routeDistance {
            parts.append("路线距离约 \(formatDistance(route.meters))")
        } else if let straight = candidate.travelEstimate?.straightLineDistance {
            parts.append("只有直线距离约 \(formatDistance(straight.meters))")
        }
        if candidate.openingStatus.value == .unknown { parts.append("营业状态待确认") }
        return parts.isEmpty ? "可作为候选比较，仍需查看证据说明。" : parts.joined(separator: "；")
    }

    private static func confidenceSummary(_ candidate: PlaceCandidate) -> String {
        let evidenceCount = allEvidenceIDs(candidate).count
        switch candidate.verificationStatus {
        case .verified:
            return evidenceCount > 0 ? "由 \(evidenceCount) 条证据支持" : "已验证"
        case .partiallyVerified:
            return evidenceCount > 0 ? "部分字段由 \(evidenceCount) 条证据支持" : "部分信息"
        case .conflicting:
            return "存在来源不一致"
        case .stale:
            return "证据可能已过期"
        case .unknown:
            return "证据不足"
        case .unsupported:
            return "不适用或无法验证"
        }
    }

    private static func confidenceLabel(_ confidence: Double) -> String {
        if confidence >= 0.75 { return "高置信度" }
        if confidence >= 0.45 { return "中等置信度" }
        if confidence > 0 { return "低置信度" }
        return "置信度未知"
    }

    private static func allEvidenceReferences(_ candidate: PlaceCandidate) -> [PlaceEvidenceReference] {
        var refs = candidate.evidenceReferences
        refs.append(contentsOf: candidate.openingStatus.evidenceReferences)
        refs.append(contentsOf: candidate.priceEstimate.evidenceReferences)
        refs.append(contentsOf: candidate.parkingInfo.evidenceReferences)
        refs.append(contentsOf: candidate.webLinks.flatMap(\.evidenceReferences))
        var seen = Set<String>()
        return refs.filter { seen.insert($0.evidenceID).inserted }
    }

    private static func allEvidenceIDs(_ candidate: PlaceCandidate) -> [String] {
        Array(Set(allEvidenceReferences(candidate).map(\.evidenceID) + candidate.findings.flatMap(\.evidenceIDs))).sorted()
    }

    private static func roundedAmount(_ value: Double) -> String {
        if value.rounded() == value { return "\(Int(value))" }
        return String(format: "%.1f", value)
    }

    private static func formatDistance(_ meters: Double) -> String {
        if meters >= 1_609.34 {
            return String(format: "%.1f 英里", meters / 1_609.34)
        }
        if meters >= 1_000 {
            return String(format: "%.1f 公里", meters / 1_000)
        }
        return "\(Int(max(0, meters).rounded())) 米"
    }
}

private extension PlaceOpeningHours {
    var freshnessState: LocalDiscoveryVerificationFieldState {
        if freshnessText.lowercased().contains("stale") { return .stale }
        return confidence >= 0.6 ? .partial : .unknown
    }

    var freshnessText: String {
        if let uncertaintyReason { return uncertaintyReason }
        return source
    }
}

private extension PlacePriceEstimate {
    var fieldState: LocalDiscoveryVerificationFieldState {
        if source.lowercased().contains("stale") || uncertaintyReason?.lowercased().contains("stale") == true {
            return .stale
        }
        return confidence >= 0.6 ? .confirmed : .partial
    }
}

private extension PlaceParkingInfo {
    var fieldState: LocalDiscoveryVerificationFieldState {
        if source.lowercased().contains("stale") || uncertaintyReason?.lowercased().contains("stale") == true {
            return .stale
        }
        return confidence >= 0.6 ? .confirmed : .partial
    }
}
