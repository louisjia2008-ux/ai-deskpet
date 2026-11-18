import Foundation

public struct LocalDiscoveryValidationReport: Codable, Sendable, Hashable {
    public var findings: [PlaceVerificationFinding]

    public init(findings: [PlaceVerificationFinding]) {
        self.findings = findings
    }

    public var hasBlockingFailure: Bool {
        findings.contains { $0.severity == .blocking && $0.status == .failed }
    }

    public func disposition(for candidateID: String) -> PlaceCandidateDisposition {
        let candidateFindings = findings.filter { $0.candidateID == candidateID }
        if candidateFindings.contains(where: { $0.recommendedDisposition == .excludeConflict }) {
            return .excludeConflict
        }
        if candidateFindings.contains(where: { $0.recommendedDisposition == .excludeHardConstraintFailure }) {
            return .excludeHardConstraintFailure
        }
        if candidateFindings.contains(where: { $0.recommendedDisposition == .requiresMoreEvidence }) {
            return .requiresMoreEvidence
        }
        if candidateFindings.contains(where: { $0.status == .uncertain || $0.severity == .warning }) {
            return .includeWithWarning
        }
        return .includeVerified
    }
}

public struct LocalDiscoveryValidator: Sendable {
    public var staleSourceAge: TimeInterval
    private let now: Date

    public init(now: Date = Date(), staleSourceAge: TimeInterval = 90 * 24 * 60 * 60) {
        self.now = now
        self.staleSourceAge = staleSourceAge
    }

    public func validate(query: PlaceQuery,
                         candidates: [PlaceCandidate]) -> LocalDiscoveryValidationReport {
        var findings: [PlaceVerificationFinding] = []
        let duplicates = Dictionary(grouping: candidates, by: \.stableID).filter { $0.value.count > 1 }
        for candidate in candidates {
            findings.append(contentsOf: validateCandidate(candidate, query: query))
            if duplicates[candidate.stableID] != nil {
                findings.append(finding(candidate,
                                        criterion: "duplicated_candidates",
                                        status: .failed,
                                        severity: .warning,
                                        evidenceIDs: candidate.evidenceReferences.map(\.evidenceID),
                                        reason: "Candidate stable ID appears more than once after deduplication",
                                        disposition: .includeWithWarning))
            }
        }
        return LocalDiscoveryValidationReport(findings: findings)
    }

    private func validateCandidate(_ candidate: PlaceCandidate,
                                   query: PlaceQuery) -> [PlaceVerificationFinding] {
        var findings: [PlaceVerificationFinding] = []
        findings.append(validateEvidence(candidate))
        findings.append(validateStaleness(candidate))
        findings.append(validateCategory(candidate, expected: query.category, hard: true))

        for constraint in query.hardConstraints {
            findings.append(validate(candidate, constraint: constraint, hard: true))
        }
        for constraint in query.softPreferences {
            findings.append(validate(candidate, constraint: constraint, hard: false))
        }
        if let budget = query.budget, let max = budget.maximumAmount {
            findings.append(validatePrice(candidate, maximum: max, currencyCode: budget.currencyCode, hard: true))
        }
        if let travelLimit = query.travelLimit {
            if let maximumDistance = travelLimit.maximumDistanceMeters {
                findings.append(validateDistance(candidate, maximumMeters: maximumDistance, hard: true))
            }
            if let maximumTravelTime = travelLimit.maximumTravelTimeSeconds {
                findings.append(validateTravelTime(candidate, maximumSeconds: maximumTravelTime, hard: true))
            }
        }
        if candidate.verificationStatus == .conflicting || candidate.openingStatus.value == .conflicting {
            findings.append(finding(candidate,
                                    criterion: "source_conflict",
                                    status: .failed,
                                    severity: .blocking,
                                    evidenceIDs: allEvidenceIDs(candidate),
                                    reason: "Candidate contains unresolved source conflict",
                                    disposition: .excludeConflict))
        }
        if let rationale = candidate.recommendationRationale?.lowercased() {
            findings.append(contentsOf: validateOverclaim(candidate, rationale: rationale))
        }
        return findings
    }

    private func validate(_ candidate: PlaceCandidate,
                          constraint: PlaceConstraint,
                          hard: Bool) -> PlaceVerificationFinding {
        switch constraint.kind {
        case .category:
            if case .category(let expected) = constraint.value {
                return validateCategory(candidate, expected: expected, hard: hard)
            }
        case .openAt, .openNow:
            return validateOpening(candidate, hard: hard)
        case .priceMaximum:
            if case .number(let maximum) = constraint.value {
                return validatePrice(candidate, maximum: maximum, currencyCode: "USD", hard: hard)
            }
        case .distanceMaximum:
            if case .distance(let distance) = constraint.value {
                return validateDistance(candidate, maximumMeters: distance.meters, hard: hard)
            }
        case .travelTimeMaximum:
            if case .durationMinutes(let minutes) = constraint.value {
                return validateTravelTime(candidate, maximumSeconds: minutes * 60, hard: hard)
            }
        case .parkingPreference:
            return validateParking(candidate, hard: hard)
        case .keyword:
            if case .string(let keyword) = constraint.value {
                return validateKeyword(candidate, keyword: keyword, hard: hard)
            }
        case .accessibility, .ratingPreference, .resultCount:
            return finding(candidate,
                           criterion: constraint.kind.rawValue,
                           status: .notApplicable,
                           severity: .info,
                           evidenceIDs: constraint.evidenceReferences.map(\.evidenceID),
                           reason: "Validator does not apply this criterion at candidate level",
                           disposition: .includeWithWarning)
        }
        return finding(candidate,
                       criterion: constraint.kind.rawValue,
                       status: .uncertain,
                       severity: hard ? .blocking : .warning,
                       evidenceIDs: constraint.evidenceReferences.map(\.evidenceID),
                       reason: "Constraint value is unsupported for deterministic validation",
                       disposition: hard ? .requiresMoreEvidence : .includeWithWarning)
    }

    private func validateEvidence(_ candidate: PlaceCandidate) -> PlaceVerificationFinding {
        let evidenceIDs = candidate.evidenceReferences.map(\.evidenceID)
        return finding(candidate,
                       criterion: "missing_critical_evidence",
                       status: evidenceIDs.isEmpty ? .failed : .passed,
                       severity: evidenceIDs.isEmpty ? .blocking : .info,
                       evidenceIDs: evidenceIDs,
                       reason: evidenceIDs.isEmpty ? "Candidate has no evidence references" : "Candidate has evidence references",
                       disposition: evidenceIDs.isEmpty ? .requiresMoreEvidence : .includeVerified)
    }

    private func validateStaleness(_ candidate: PlaceCandidate) -> PlaceVerificationFinding {
        let staleByLabel = candidate.freshness.lowercased().contains("stale")
            || candidate.evidenceReferences.contains { $0.freshness.lowercased().contains("stale") }
        let staleByAge = candidate.evidenceReferences.contains {
            guard let observed = $0.observedAt else { return false }
            return now.timeIntervalSince(observed) > staleSourceAge
        }
        let stale = staleByLabel || staleByAge
        return finding(candidate,
                       criterion: "stale_evidence",
                       status: stale ? .uncertain : .passed,
                       severity: stale ? .warning : .info,
                       evidenceIDs: candidate.evidenceReferences.map(\.evidenceID),
                       reason: stale ? "Evidence may be stale" : "Evidence freshness is acceptable",
                       disposition: stale ? .includeWithWarning : .includeVerified)
    }

    private func validateCategory(_ candidate: PlaceCandidate,
                                  expected: PlaceCategory,
                                  hard: Bool) -> PlaceVerificationFinding {
        // P18.4 — PAR-015: identity-sensitive substring replaced by exact match.
        // The previous implementation also accepted `contains()` matches such as
        // `"store"` matching `"bookstore"` (false positive for retail-store queries)
        // and `"lace"` matching `"place"` (false positive for place queries). Both
        // are removed. `PlaceCategory` is a closed enum of canonical rawValues
        // (.place / .restaurant / .chineseRestaurant / .sichuanRestaurant /
        // .golfDrivingRange / .retailStore / .electronicsStore) and exact equality
        // is the only contract this classifier should rely on. IS-A narrowing
        // (e.g. `sichuan_restaurant` being-a `restaurant`) is captured via the
        // structured planner's `canonicalCategory(...)` which already emits the
        // expected canonical value the user asked for.
        let expectedRaw = expected.rawValue
        let matched = candidate.categories.contains { $0.rawValue == expectedRaw }
        return finding(candidate,
                       criterion: "category",
                       status: matched ? .passed : .failed,
                       severity: matched || !hard ? .info : .blocking,
                       evidenceIDs: candidate.evidenceReferences.map(\.evidenceID),
                       reason: matched ? "Category matches query" : "Category does not match hard query category",
                       disposition: matched ? .includeVerified : hard ? .excludeHardConstraintFailure : .includeWithWarning)
    }

    private func validateOpening(_ candidate: PlaceCandidate,
                                 hard: Bool) -> PlaceVerificationFinding {
        switch candidate.openingStatus.value {
        case .open:
            return finding(candidate,
                           criterion: "opening_status",
                           status: .passed,
                           severity: .info,
                           evidenceIDs: candidate.openingStatus.evidenceReferences.map(\.evidenceID),
                           reason: "Opening status is verified open for target time",
                           disposition: .includeVerified)
        case .closed:
            return finding(candidate,
                           criterion: "opening_status",
                           status: .failed,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: candidate.openingStatus.evidenceReferences.map(\.evidenceID),
                           reason: "Opening status is closed for target time",
                           disposition: hard ? .excludeHardConstraintFailure : .includeWithWarning)
        case .conflicting:
            return finding(candidate,
                           criterion: "opening_status",
                           status: .failed,
                           severity: .blocking,
                           evidenceIDs: candidate.openingStatus.evidenceReferences.map(\.evidenceID),
                           reason: "Opening status has conflicting sources",
                           disposition: .excludeConflict)
        case .unknown:
            return finding(candidate,
                           criterion: "opening_status",
                           status: .uncertain,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: candidate.openingStatus.evidenceReferences.map(\.evidenceID),
                           reason: "Unknown opening status does not satisfy the constraint",
                           disposition: hard ? .requiresMoreEvidence : .includeWithWarning)
        }
    }

    private func validatePrice(_ candidate: PlaceCandidate,
                               maximum: Double,
                               currencyCode: String,
                               hard: Bool) -> PlaceVerificationFinding {
        let amount = maximumPrice(candidate.priceEstimate.value, currencyCode: currencyCode)
        guard let amount else {
            return finding(candidate,
                           criterion: "price_maximum",
                           status: .uncertain,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: candidate.priceEstimate.evidenceReferences.map(\.evidenceID),
                           reason: "Unknown or incomparable price does not satisfy the budget",
                           disposition: hard ? .requiresMoreEvidence : .includeWithWarning)
        }
        let passed = amount <= maximum && candidate.priceEstimate.confidence >= 0.5
        return finding(candidate,
                       criterion: "price_maximum",
                       status: passed ? .passed : .failed,
                       severity: passed || !hard ? .info : .blocking,
                       evidenceIDs: candidate.priceEstimate.evidenceReferences.map(\.evidenceID),
                       reason: passed ? "Price estimate is within maximum" : "Price estimate exceeds or is too uncertain for maximum",
                       disposition: passed ? .includeVerified : hard ? .excludeHardConstraintFailure : .includeWithWarning)
    }

    private func validateDistance(_ candidate: PlaceCandidate,
                                  maximumMeters: Double,
                                  hard: Bool) -> PlaceVerificationFinding {
        let meters = candidate.travelEstimate?.routeDistance?.meters
            ?? candidate.distance?.meters
            ?? candidate.travelEstimate?.straightLineDistance?.meters
        guard let meters else {
            return finding(candidate,
                           criterion: "distance_maximum",
                           status: .uncertain,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: allEvidenceIDs(candidate),
                           reason: "Distance is unknown",
                           disposition: hard ? .requiresMoreEvidence : .includeWithWarning)
        }
        let passed = meters <= maximumMeters
        return finding(candidate,
                       criterion: "distance_maximum",
                       status: passed ? .passed : .failed,
                       severity: passed || !hard ? .info : .blocking,
                       evidenceIDs: allEvidenceIDs(candidate),
                       reason: passed ? "Distance is within limit" : "Distance exceeds limit",
                       disposition: passed ? .includeVerified : hard ? .excludeHardConstraintFailure : .includeWithWarning)
    }

    private func validateTravelTime(_ candidate: PlaceCandidate,
                                    maximumSeconds: Double,
                                    hard: Bool) -> PlaceVerificationFinding {
        guard let seconds = candidate.travelEstimate?.estimatedTravelDurationSeconds else {
            return finding(candidate,
                           criterion: "travel_time_maximum",
                           status: .uncertain,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: allEvidenceIDs(candidate),
                           reason: "Travel time is unknown",
                           disposition: hard ? .requiresMoreEvidence : .includeWithWarning)
        }
        let passed = seconds <= maximumSeconds
        return finding(candidate,
                       criterion: "travel_time_maximum",
                       status: passed ? .passed : .failed,
                       severity: passed || !hard ? .info : .blocking,
                       evidenceIDs: allEvidenceIDs(candidate),
                       reason: passed ? "Travel time is within limit" : "Travel time exceeds limit",
                       disposition: passed ? .includeVerified : hard ? .excludeHardConstraintFailure : .includeWithWarning)
    }

    private func validateParking(_ candidate: PlaceCandidate,
                                 hard: Bool) -> PlaceVerificationFinding {
        switch candidate.parkingInfo.value {
        case .easy, .available:
            return finding(candidate,
                           criterion: "parking_preference",
                           status: candidate.parkingInfo.confidence >= 0.5 ? .passed : .uncertain,
                           severity: candidate.parkingInfo.confidence >= 0.5 ? .info : .warning,
                           evidenceIDs: candidate.parkingInfo.evidenceReferences.map(\.evidenceID),
                           reason: candidate.parkingInfo.confidence >= 0.5 ? "Parking preference has supporting evidence" : "Parking claim is low confidence",
                           disposition: candidate.parkingInfo.confidence >= 0.5 ? .includeVerified : .includeWithWarning)
        case .limited, .paid, .none:
            return finding(candidate,
                           criterion: "parking_preference",
                           status: .failed,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: candidate.parkingInfo.evidenceReferences.map(\.evidenceID),
                           reason: "Parking does not meet preference",
                           disposition: hard ? .excludeHardConstraintFailure : .includeWithWarning)
        case .unknown:
            return finding(candidate,
                           criterion: "parking_preference",
                           status: .uncertain,
                           severity: hard ? .blocking : .warning,
                           evidenceIDs: candidate.parkingInfo.evidenceReferences.map(\.evidenceID),
                           reason: "Unknown parking cannot be treated as convenient parking",
                           disposition: hard ? .requiresMoreEvidence : .includeWithWarning)
        }
    }

    private func validateKeyword(_ candidate: PlaceCandidate,
                                 keyword: String,
                                 hard: Bool) -> PlaceVerificationFinding {
        // P18.4 — PAR-016: substring routing replaced with whole-word match
        // for prose fields and exact match for canonical `PlaceCategory`
        // rawValues. The previous `contains()` form matched `"lace"` against
        // `"place"` and `"store"` against `"bookstore"` etc., falsely
        // satisfying user-supplied hard keyword constraints. Word-boundary
        // semantics ensure `keyword = "lace"` does NOT match a name that
        // happens to contain the suffix "lace" inside "place"; the token
        // must appear as a discrete word/segment.
        let normalized = PlaceNormalizer.normalizedName(keyword)
        let matched = Self.containsWord(candidate.normalizedName, normalized)
            || candidate.categories.contains { $0.rawValue == normalized.lowercased() }
            || Self.containsWord(candidate.address?.formatted ?? "", keyword.lowercased())
        return finding(candidate,
                       criterion: "keyword",
                       status: matched ? .passed : .failed,
                       severity: matched || !hard ? .info : .blocking,
                       evidenceIDs: candidate.evidenceReferences.map(\.evidenceID),
                       reason: matched ? "Keyword appears in structured candidate fields" : "Keyword not found in structured candidate fields",
                       disposition: matched ? .includeVerified : hard ? .excludeHardConstraintFailure : .includeWithWarning)
    }

    /// P18.4 — PAR-016 helper. Returns `true` if `needle` appears as a whole
    /// word/segment inside `haystack` (split on non-alphanumeric ASCII).
    /// Stops the false positives that pure `String.contains()` produces on
    /// `"lace"`-in-`"place"`, `"store"`-in-`"bookstore"` etc.
    /// Chinese characters do not have the same notion of whitespace-
    /// delimited words, so for all-CJK inputs the function falls back to
    /// substring behavior (same shape as before P18.4 for the Chinese path).
    static func containsWord(_ haystack: String, _ needle: String) -> Bool {
        let trimmedHaystack = haystack.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNeedle = needle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHaystack.isEmpty, !trimmedNeedle.isEmpty else { return false }
        let loweredNeedle = trimmedNeedle.lowercased()
        // If the needle is purely CJK, use substring (Chinese has no whitespace
        // word boundaries in this codebase's contracts).
        if trimmedNeedle.unicodeScalars.allSatisfy({ $0.isASCII == false }) {
            return trimmedHaystack.lowercased().contains(loweredNeedle)
        }
        let tokens = trimmedHaystack
            .lowercased()
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        return tokens.contains { $0 == loweredNeedle }
    }

    private func validateOverclaim(_ candidate: PlaceCandidate,
                                   rationale: String) -> [PlaceVerificationFinding] {
        // P18.4 — PAR-028: replaced `rationale.contains("open")` and
        // `rationale.contains("parking")` with whole-word matching
        // (`Self.containsWord`). Pure substring routing false-positives on
        // prose mentions like `"reopen"` or `"reparking"`. Word-boundary
        // semantics still fire on the canonical positive case
        // `"Open now with easy parking"` (verified by
        // `P9BLocalDiscoveryDedupValidatorTests.testValidatorRejectsOverclaim`)
        // while dropping the false positives the original PAR-028
        // submission flagged.
        var findings: [PlaceVerificationFinding] = []
        let lowered = rationale.lowercased()
        if Self.containsWord(lowered, "open") && candidate.openingStatus.value != .open {
            findings.append(finding(candidate,
                                    criterion: "overclaim",
                                    status: .failed,
                                    severity: .blocking,
                                    evidenceIDs: candidate.openingStatus.evidenceReferences.map(\.evidenceID),
                                    reason: "Recommendation rationale claims open without verified open status",
                                    disposition: .requiresMoreEvidence))
        }
        if Self.containsWord(lowered, "parking") && candidate.parkingInfo.value == .unknown {
            findings.append(finding(candidate,
                                    criterion: "overclaim",
                                    status: .failed,
                                    severity: .warning,
                                    evidenceIDs: candidate.parkingInfo.evidenceReferences.map(\.evidenceID),
                                    reason: "Recommendation rationale claims parking without verified parking evidence",
                                    disposition: .includeWithWarning))
        }
        return findings
    }

    private func maximumPrice(_ value: PlacePriceValue, currencyCode: String) -> Double? {
        switch value {
        case .maximumPerPerson(let amount, let currency) where currency.uppercased() == currencyCode.uppercased():
            return amount
        case .rangePerPerson(_, let maximum, let currency) where currency.uppercased() == currencyCode.uppercased():
            return maximum
        case .level(let level):
            return Double(level) * 20
        default:
            return nil
        }
    }

    private func finding(_ candidate: PlaceCandidate,
                         criterion: String,
                         status: VerificationCriterionStatus,
                         severity: PlaceVerificationSeverity,
                         evidenceIDs: [String],
                         reason: String,
                         disposition: PlaceCandidateDisposition) -> PlaceVerificationFinding {
        PlaceVerificationFinding(id: "\(candidate.stableID)-\(criterion)-\(status.rawValue)",
                                 candidateID: candidate.stableID,
                                 criterion: criterion,
                                 status: status,
                                 severity: severity,
                                 evidenceIDs: evidenceIDs,
                                 reason: reason,
                                 recommendedDisposition: disposition)
    }

    private func allEvidenceIDs(_ candidate: PlaceCandidate) -> [String] {
        Array(Set(
            candidate.evidenceReferences.map(\.evidenceID)
            + candidate.openingStatus.evidenceReferences.map(\.evidenceID)
            + candidate.priceEstimate.evidenceReferences.map(\.evidenceID)
            + candidate.parkingInfo.evidenceReferences.map(\.evidenceID)
        )).sorted()
    }
}
