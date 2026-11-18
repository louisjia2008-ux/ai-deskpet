import Foundation

public enum PlaceMergeReason: String, Codable, Sendable, Hashable, CaseIterable {
    case sameSourceEntityID
    case sameNormalizedNameAndAddress
    case sameNormalizedNameAndNearbyCoordinate
    case samePhoneNumber
    case sameWebsiteHost
}

public struct PlaceMergeConflict: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var field: String
    public var candidateIDs: [String]
    public var values: [String]

    public init(field: String, candidateIDs: [String], values: [String]) {
        self.id = AgentEventRedactor.safeIdentifier("conflict-\(field)-\(candidateIDs.sorted().joined(separator: "-"))")
        self.field = AgentEventRedactor.safeIdentifier(field)
        self.candidateIDs = candidateIDs.map { AgentEventRedactor.safeIdentifier($0) }.sorted()
        self.values = values.map { AgentPrivacyRedactor.safeSummary($0, fallback: "value") }.sorted()
    }
}

public struct PlaceMergeRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var primaryCandidateID: String
    public var mergedCandidateIDs: [String]
    public var reasons: [PlaceMergeReason]
    public var confidence: Double
    public var conflicts: [PlaceMergeConflict]

    public init(primaryCandidateID: String,
                mergedCandidateIDs: [String],
                reasons: [PlaceMergeReason],
                confidence: Double,
                conflicts: [PlaceMergeConflict] = []) {
        self.primaryCandidateID = AgentEventRedactor.safeIdentifier(primaryCandidateID)
        self.mergedCandidateIDs = mergedCandidateIDs.map { AgentEventRedactor.safeIdentifier($0) }.sorted()
        self.id = AgentEventRedactor.safeIdentifier("merge-\(self.primaryCandidateID)-\(self.mergedCandidateIDs.joined(separator: "-"))")
        self.reasons = Array(Set(reasons)).sorted { $0.rawValue < $1.rawValue }
        self.confidence = min(1, max(0, confidence))
        self.conflicts = conflicts
    }
}

public struct PlaceDeduplicationResult: Codable, Sendable, Hashable {
    public var candidates: [PlaceCandidate]
    public var mergeRecords: [PlaceMergeRecord]
    public var conflicts: [PlaceMergeConflict]

    public init(candidates: [PlaceCandidate],
                mergeRecords: [PlaceMergeRecord] = [],
                conflicts: [PlaceMergeConflict] = []) {
        self.candidates = candidates
        self.mergeRecords = mergeRecords
        self.conflicts = conflicts
    }
}

public struct PlaceCandidateDeduplicator: Sendable {
    public init() {}

    public func deduplicate(_ candidates: [PlaceCandidate]) -> PlaceDeduplicationResult {
        var clusters: [[PlaceCandidate]] = []
        var records: [PlaceMergeRecord] = []
        for candidate in candidates {
            if let index = clusters.firstIndex(where: { cluster in
                cluster.contains { Self.shouldMerge($0, candidate).merge }
            }) {
                clusters[index].append(candidate)
            } else {
                clusters.append([candidate])
            }
        }

        var merged: [PlaceCandidate] = []
        var allConflicts: [PlaceMergeConflict] = []
        for cluster in clusters {
            guard let first = cluster.first else { continue }
            if cluster.count == 1 {
                merged.append(first)
                continue
            }
            var reasons: [PlaceMergeReason] = []
            var confidence = 0.0
            for pair in Self.combinations(cluster) {
                let decision = Self.shouldMerge(pair.0, pair.1)
                if decision.merge {
                    reasons.append(contentsOf: decision.reasons)
                    confidence = max(confidence, decision.confidence)
                }
            }
            let conflicts = Self.conflicts(in: cluster)
            allConflicts.append(contentsOf: conflicts)
            let mergedCandidate = Self.merge(cluster, conflicts: conflicts)
            records.append(PlaceMergeRecord(primaryCandidateID: first.stableID,
                                            mergedCandidateIDs: cluster.dropFirst().map(\.stableID),
                                            reasons: reasons,
                                            confidence: confidence,
                                            conflicts: conflicts))
            merged.append(mergedCandidate)
        }
        return PlaceDeduplicationResult(candidates: merged.sorted { $0.name < $1.name },
                                        mergeRecords: records,
                                        conflicts: allConflicts)
    }

    private static func shouldMerge(_ lhs: PlaceCandidate,
                                    _ rhs: PlaceCandidate) -> (merge: Bool, reasons: [PlaceMergeReason], confidence: Double) {
        let sharedSourceID = !Set(lhs.sourceEntityIDs).intersection(rhs.sourceEntityIDs).isEmpty
        if sharedSourceID {
            return (true, [.sameSourceEntityID], 0.98)
        }
        var reasons: [PlaceMergeReason] = []
        let sameName = !lhs.normalizedName.isEmpty && lhs.normalizedName == rhs.normalizedName
        if sameName, normalizedAddress(lhs.address) != nil, normalizedAddress(lhs.address) == normalizedAddress(rhs.address) {
            reasons.append(.sameNormalizedNameAndAddress)
        }
        if sameName, coordinateDistance(lhs.coordinate, rhs.coordinate).map({ $0 <= 40 }) == true {
            reasons.append(.sameNormalizedNameAndNearbyCoordinate)
        }
        if normalizedPhone(lhs.contact.phoneNumber) != nil,
           normalizedPhone(lhs.contact.phoneNumber) == normalizedPhone(rhs.contact.phoneNumber) {
            reasons.append(.samePhoneNumber)
        }
        if websiteHosts(lhs).isDisjoint(with: websiteHosts(rhs)) == false {
            reasons.append(.sameWebsiteHost)
        }

        if reasons.contains(.sameNormalizedNameAndAddress) { return (true, reasons, 0.92) }
        if reasons.contains(.sameNormalizedNameAndNearbyCoordinate),
           reasons.contains(.samePhoneNumber) || reasons.contains(.sameWebsiteHost) {
            return (true, reasons, 0.88)
        }
        return (false, reasons, 0)
    }

    private static func merge(_ cluster: [PlaceCandidate],
                              conflicts: [PlaceMergeConflict]) -> PlaceCandidate {
        var base = cluster[0]
        base.sourceEntityIDs = Array(Set(cluster.flatMap(\.sourceEntityIDs))).sorted()
        base.categories = Array(Set(cluster.flatMap(\.categories))).sorted { $0.rawValue < $1.rawValue }
        base.evidenceReferences = uniqueEvidence(cluster.flatMap(\.evidenceReferences))
        base.webLinks = uniqueLinks(cluster.flatMap(\.webLinks))
        base.findings = cluster.flatMap(\.findings)
        base.actionDescriptors = uniqueActions(cluster.flatMap(\.actionDescriptors))
        base.address = cluster.compactMap(\.address).first
        base.coordinate = cluster.compactMap(\.coordinate).first
        base.contact = cluster.first { $0.contact.phoneNumber != nil }?.contact ?? base.contact
        base.openingHours = cluster.compactMap(\.openingHours).first
        base.distance = cluster.compactMap(\.distance).first
        base.travelEstimate = cluster.compactMap(\.travelEstimate).first
        base.recommendationRationale = cluster.compactMap(\.recommendationRationale).first
        if !conflicts.isEmpty {
            base.verificationStatus = .conflicting
            base.findings.append(contentsOf: conflicts.map {
                PlaceVerificationFinding(id: "merge-\($0.id)",
                                         candidateID: base.stableID,
                                         criterion: $0.field,
                                         status: .failed,
                                         severity: .warning,
                                         evidenceIDs: base.evidenceReferences.map(\.evidenceID),
                                         reason: "Merged sources conflict for \($0.field)",
                                         recommendedDisposition: .includeWithWarning)
            })
        } else if cluster.contains(where: { $0.verificationStatus == .verified }) {
            base.verificationStatus = .partiallyVerified
        }
        return base
    }

    private static func conflicts(in cluster: [PlaceCandidate]) -> [PlaceMergeConflict] {
        var conflicts: [PlaceMergeConflict] = []
        let openingValues = Set(cluster.map(\.openingStatus.value).filter { $0 != .unknown })
        if openingValues.count > 1 {
            conflicts.append(PlaceMergeConflict(field: "openingStatus",
                                                candidateIDs: cluster.map(\.stableID),
                                                values: openingValues.map(\.rawValue)))
        }
        let prices = Set(cluster.map { priceFingerprint($0.priceEstimate.value) }.filter { $0 != "unknown" })
        if prices.count > 1 {
            conflicts.append(PlaceMergeConflict(field: "priceEstimate",
                                                candidateIDs: cluster.map(\.stableID),
                                                values: Array(prices)))
        }
        let parking = Set(cluster.map(\.parkingInfo.value).filter { $0 != .unknown })
        if parking.count > 1 {
            conflicts.append(PlaceMergeConflict(field: "parkingInfo",
                                                candidateIDs: cluster.map(\.stableID),
                                                values: parking.map(\.rawValue)))
        }
        return conflicts
    }

    private static func combinations(_ values: [PlaceCandidate]) -> [(PlaceCandidate, PlaceCandidate)] {
        guard values.count > 1 else { return [] }
        var pairs: [(PlaceCandidate, PlaceCandidate)] = []
        for lhs in values.indices {
            for rhs in values.indices where rhs > lhs {
                pairs.append((values[lhs], values[rhs]))
            }
        }
        return pairs
    }

    private static func normalizedAddress(_ address: PlaceAddress?) -> String? {
        guard let address else { return nil }
        return PlaceNormalizer.normalizedName(address.formatted)
    }

    private static func normalizedPhone(_ phone: String?) -> String? {
        guard let phone else { return nil }
        var digits = phone.filter(\.isNumber)
        if digits.count == 11, digits.first == "1" {
            digits.removeFirst()
        }
        return digits.count >= 7 ? digits : nil
    }

    private static func websiteHosts(_ candidate: PlaceCandidate) -> Set<String> {
        Set(candidate.webLinks.compactMap { PlaceNormalizer.normalizedHost($0.url) })
    }

    private static func coordinateDistance(_ lhs: PlaceCoordinate?, _ rhs: PlaceCoordinate?) -> Double? {
        guard let lhs, let rhs else { return nil }
        return LocalDiscoveryDistance.haversineMeters(from: lhs, to: rhs)
    }

    private static func uniqueEvidence(_ values: [PlaceEvidenceReference]) -> [PlaceEvidenceReference] {
        var seen: Set<String> = []
        return values.filter {
            guard !seen.contains($0.evidenceID) else { return false }
            seen.insert($0.evidenceID)
            return true
        }
    }

    private static func uniqueLinks(_ values: [PlaceWebLink]) -> [PlaceWebLink] {
        var seen: Set<String> = []
        return values.filter {
            let key = PlaceNormalizer.normalizedHost($0.url) ?? $0.url
            guard !seen.contains(key) else { return false }
            seen.insert(key)
            return true
        }
    }

    private static func uniqueActions(_ values: [PlaceActionDescriptor]) -> [PlaceActionDescriptor] {
        var seen: Set<String> = []
        return values.filter {
            guard !seen.contains($0.actionID) else { return false }
            seen.insert($0.actionID)
            return true
        }
    }

    private static func priceFingerprint(_ value: PlacePriceValue) -> String {
        switch value {
        case .level(let level):
            return "level:\(level)"
        case .maximumPerPerson(let amount, let currency):
            return "max:\(currency):\(Int(amount.rounded()))"
        case .rangePerPerson(let minimum, let maximum, let currency):
            return "range:\(currency):\(Int(minimum.rounded()))-\(Int(maximum.rounded()))"
        case .unknown:
            return "unknown"
        }
    }
}

public enum LocalDiscoveryDistance {
    public static func haversineMeters(from origin: PlaceCoordinate, to destination: PlaceCoordinate) -> Double {
        let radius = 6_371_000.0
        let lat1 = origin.latitude * .pi / 180
        let lat2 = destination.latitude * .pi / 180
        let deltaLat = (destination.latitude - origin.latitude) * .pi / 180
        let deltaLon = (destination.longitude - origin.longitude) * .pi / 180
        let a = sin(deltaLat / 2) * sin(deltaLat / 2)
            + cos(lat1) * cos(lat2) * sin(deltaLon / 2) * sin(deltaLon / 2)
        let c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return radius * c
    }
}
