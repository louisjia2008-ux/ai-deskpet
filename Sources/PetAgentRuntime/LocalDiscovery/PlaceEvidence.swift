import Foundation

public struct PlaceEvidenceReference: Codable, Sendable, Hashable, Identifiable {
    public var id: String { evidenceID }
    public var evidenceID: String
    public var sourceToolID: ToolID?
    public var sourceURL: String?
    public var claim: String
    public var observedAt: Date?
    public var freshness: String
    public var confidence: Double

    public init(evidenceID: String,
                sourceToolID: ToolID? = nil,
                sourceURL: String? = nil,
                claim: String,
                observedAt: Date? = nil,
                freshness: String = "current-task",
                confidence: Double = 0) {
        self.evidenceID = AgentEventRedactor.safeIdentifier(evidenceID)
        self.sourceToolID = sourceToolID
        self.sourceURL = sourceURL.map { AgentPrivacyRedactor.safeText($0, maxLength: 1_000).text }
        self.claim = AgentPrivacyRedactor.safeText(claim, maxLength: 400).text
        self.observedAt = observedAt
        self.freshness = AgentPrivacyRedactor.safeSummary(freshness, fallback: "unknown")
        self.confidence = min(1, max(0, confidence))
    }

    private enum CodingKeys: String, CodingKey {
        case evidenceID
        case sourceToolID
        case sourceURL
        case claim
        case observedAt
        case freshness
        case confidence
    }

    private enum LegacyToolIDKeys: String, CodingKey {
        case rawValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let evidenceID = try container.decode(String.self, forKey: .evidenceID)
        let sourceToolID: ToolID?
        if let rawToolID = try container.decodeIfPresent(String.self, forKey: .sourceToolID) {
            sourceToolID = ToolID(rawValue: rawToolID)
        } else if let legacy = try? container.nestedContainer(keyedBy: LegacyToolIDKeys.self, forKey: .sourceToolID),
                  let raw = try? legacy.decode(String.self, forKey: .rawValue) {
            sourceToolID = ToolID(rawValue: raw)
        } else {
            sourceToolID = nil
        }
        self.init(evidenceID: evidenceID,
                  sourceToolID: sourceToolID,
                  sourceURL: try container.decodeIfPresent(String.self, forKey: .sourceURL),
                  claim: try container.decode(String.self, forKey: .claim),
                  observedAt: try container.decodeIfPresent(Date.self, forKey: .observedAt),
                  freshness: try container.decodeIfPresent(String.self, forKey: .freshness) ?? "current-task",
                  confidence: try container.decodeIfPresent(Double.self, forKey: .confidence) ?? 0)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(evidenceID, forKey: .evidenceID)
        try container.encodeIfPresent(sourceToolID?.rawValue, forKey: .sourceToolID)
        try container.encodeIfPresent(sourceURL, forKey: .sourceURL)
        try container.encode(claim, forKey: .claim)
        try container.encodeIfPresent(observedAt, forKey: .observedAt)
        try container.encode(freshness, forKey: .freshness)
        try container.encode(confidence, forKey: .confidence)
    }
}

public enum PlaceVerificationStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case verified
    case partiallyVerified
    case conflicting
    case stale
    case unknown
    case unsupported
}

public enum PlaceVerificationSeverity: String, Codable, Sendable, Hashable, CaseIterable {
    case info
    case warning
    case blocking
}

public enum PlaceCandidateDisposition: String, Codable, Sendable, Hashable, CaseIterable {
    case includeVerified
    case includeWithWarning
    case excludeHardConstraintFailure
    case excludeConflict
    case requiresMoreEvidence
}

public struct PlaceVerificationFinding: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var candidateID: String
    public var criterion: String
    public var status: VerificationCriterionStatus
    public var severity: PlaceVerificationSeverity
    public var evidenceIDs: [String]
    public var reason: String
    public var recommendedDisposition: PlaceCandidateDisposition

    public init(id: String,
                candidateID: String,
                criterion: String,
                status: VerificationCriterionStatus,
                severity: PlaceVerificationSeverity,
                evidenceIDs: [String] = [],
                reason: String,
                recommendedDisposition: PlaceCandidateDisposition) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.candidateID = AgentEventRedactor.safeIdentifier(candidateID)
        self.criterion = AgentEventRedactor.safeIdentifier(criterion)
        self.status = status
        self.severity = severity
        self.evidenceIDs = evidenceIDs.map { AgentEventRedactor.safeIdentifier($0) }.sorted()
        self.reason = AgentPrivacyRedactor.safeText(reason, maxLength: 500).text
        self.recommendedDisposition = recommendedDisposition
    }
}

public enum PlaceActionType: String, Codable, Sendable, Hashable, CaseIterable {
    case openMaps
    case callPhone
    case openWebsite
    case openMenu
    case showDetails
}

public enum PlaceActionPermissionRequirement: String, Codable, Sendable, Hashable, CaseIterable {
    case none
    case approvalRequired
    case futureDispatchRequired
}

public struct PlaceActionDescriptor: Codable, Sendable, Hashable, Identifiable {
    public var id: String { actionID }
    public var actionID: String
    public var type: PlaceActionType
    public var label: String
    public var requiredCapability: String?
    public var targetReference: String
    public var permissionRequirement: PlaceActionPermissionRequirement

    public init(actionID: String,
                type: PlaceActionType,
                label: String,
                requiredCapability: String? = nil,
                targetReference: String,
                permissionRequirement: PlaceActionPermissionRequirement = .futureDispatchRequired) {
        self.actionID = AgentEventRedactor.safeIdentifier(actionID)
        self.type = type
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: "操作")
        self.requiredCapability = requiredCapability.map { AgentEventRedactor.safeIdentifier($0) }
        self.targetReference = AgentPrivacyRedactor.safeText(targetReference, maxLength: 1_000).text
        self.permissionRequirement = permissionRequirement
    }
}
