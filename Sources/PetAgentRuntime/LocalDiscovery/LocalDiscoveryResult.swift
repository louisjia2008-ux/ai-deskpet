import Foundation

public enum LocalDiscoveryResultStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case loading
    case partial
    case completed
    case verifiedResultsAvailable
    case partialResultsAvailable
    case noMatchingResults
    case requiresUserInput
    case failed
    case cancelled
}

public struct LocalDiscoveryResult: Codable, Sendable, Hashable, Identifiable {
    public var id: String { resultID }
    public var schemaVersion: Int
    public var resultID: String
    public var query: PlaceQuery
    public var status: LocalDiscoveryResultStatus
    public var candidates: [PlaceCandidate]
    public var excludedCandidates: [PlaceCandidate]
    public var evidence: [AgentEvidenceRecord]
    public var findings: [PlaceVerificationFinding]
    public var usedCapabilities: [String]
    public var backend: String
    public var generatedAt: Date
    public var freshness: String

    public init(schemaVersion: Int = LocalDiscoverySchemaVersion.current,
                resultID: String,
                query: PlaceQuery,
                status: LocalDiscoveryResultStatus = .partial,
                candidates: [PlaceCandidate] = [],
                excludedCandidates: [PlaceCandidate] = [],
                evidence: [AgentEvidenceRecord] = [],
                findings: [PlaceVerificationFinding] = [],
                usedCapabilities: [String] = [],
                backend: String = "unknown",
                generatedAt: Date = Date(),
                freshness: String = "unknown") {
        self.schemaVersion = max(1, schemaVersion)
        self.resultID = AgentEventRedactor.safeIdentifier(resultID)
        self.query = query
        self.status = status
        self.candidates = candidates
        self.excludedCandidates = excludedCandidates
        self.evidence = evidence
        self.findings = findings
        self.usedCapabilities = usedCapabilities.map { AgentEventRedactor.safeIdentifier($0) }.sorted()
        self.backend = AgentPrivacyRedactor.safeSummary(backend, fallback: "unknown")
        self.generatedAt = generatedAt
        self.freshness = AgentPrivacyRedactor.safeSummary(freshness, fallback: "unknown")
    }

    public var evidenceIDs: Set<String> {
        Set(evidence.map(\.id))
    }

    public func missingEvidenceReferenceIDs() -> Set<String> {
        var references = Set<String>()
        for candidate in candidates + excludedCandidates {
            references.formUnion(candidate.evidenceReferences.map(\.evidenceID))
            references.formUnion(candidate.openingStatus.evidenceReferences.map(\.evidenceID))
            references.formUnion(candidate.priceEstimate.evidenceReferences.map(\.evidenceID))
            references.formUnion(candidate.parkingInfo.evidenceReferences.map(\.evidenceID))
            references.formUnion(candidate.webLinks.flatMap { $0.evidenceReferences.map(\.evidenceID) })
            references.formUnion(candidate.findings.flatMap(\.evidenceIDs))
        }
        references.formUnion(findings.flatMap(\.evidenceIDs))
        return references.subtracting(evidenceIDs)
    }
}

public enum LocalDiscoveryJSON {
    public static func jsonValue<T: Encodable>(from value: T) throws -> AgentJSONValue {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(value)
        return try JSONDecoder().decode(AgentJSONValue.self, from: data)
    }

    public static func decoded<T: Decodable>(_ type: T.Type, from value: AgentJSONValue) throws -> T {
        let data = try JSONEncoder().encode(value)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(T.self, from: data)
    }
}
