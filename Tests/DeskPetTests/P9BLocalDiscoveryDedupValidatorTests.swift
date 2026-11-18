import XCTest
import Foundation
@testable import PetAgentRuntime

final class P9BLocalDiscoveryDedupValidatorTests: XCTestCase {
    func testDedupMergesSameSourceEntityIDAndRetainsEvidence() {
        let first = P9BDedupFixtures.candidate(id: "a", sourceIDs: ["mapkit:1"], evidenceID: "e1")
        let second = P9BDedupFixtures.candidate(id: "b", sourceIDs: ["mapkit:1"], evidenceID: "e2")

        let result = PlaceCandidateDeduplicator().deduplicate([first, second])

        XCTAssertEqual(result.candidates.count, 1)
        XCTAssertEqual(Set(result.candidates[0].sourceEntityIDs), ["mapkit:1"])
        XCTAssertEqual(Set(result.candidates[0].evidenceReferences.map(\.evidenceID)), ["e1", "e2"])
        XCTAssertEqual(result.mergeRecords.first?.reasons, [.sameSourceEntityID])
    }

    func testDedupMergesSamePlaceFromTwoSourcesByNameAddressPhoneAndHost() {
        let first = P9BDedupFixtures.candidate(id: "a",
                                               sourceIDs: ["mapkit:a"],
                                               name: "Chengdu Taste",
                                               address: "1 Market St, San Francisco, CA",
                                               phone: "+1 415 555 0100",
                                               website: "https://chengdutaste.example/menu",
                                               evidenceID: "e1")
        let second = P9BDedupFixtures.candidate(id: "b",
                                                sourceIDs: ["web:b"],
                                                name: "chengdu taste",
                                                address: "1 Market St, San Francisco, CA",
                                                phone: "(415) 555-0100",
                                                website: "https://www.chengdutaste.example",
                                                evidenceID: "e2")

        let result = PlaceCandidateDeduplicator().deduplicate([first, second])

        XCTAssertEqual(result.candidates.count, 1)
        XCTAssertTrue(result.mergeRecords.first?.reasons.contains(.sameNormalizedNameAndAddress) ?? false)
        XCTAssertTrue(result.mergeRecords.first?.reasons.contains(.samePhoneNumber) ?? false)
        XCTAssertTrue(result.mergeRecords.first?.reasons.contains(.sameWebsiteHost) ?? false)
        XCTAssertEqual(Set(result.candidates[0].sourceEntityIDs), ["mapkit:a", "web:b"])
    }

    func testDedupDoesNotMergeSameNameDifferentAddresses() {
        let first = P9BDedupFixtures.candidate(id: "a",
                                               name: "Market Cafe",
                                               address: "1 Market St, San Francisco, CA",
                                               coordinate: PlaceCoordinate(latitude: 37.77, longitude: -122.42),
                                               evidenceID: "e1")
        let second = P9BDedupFixtures.candidate(id: "b",
                                                name: "Market Cafe",
                                                address: "500 Howard St, San Francisco, CA",
                                                coordinate: PlaceCoordinate(latitude: 37.79, longitude: -122.39),
                                                evidenceID: "e2")

        let result = PlaceCandidateDeduplicator().deduplicate([first, second])

        XCTAssertEqual(result.candidates.count, 2)
        XCTAssertTrue(result.mergeRecords.isEmpty)
    }

    func testDedupDoesNotMergeNearbySeparateBusinesses() {
        let first = P9BDedupFixtures.candidate(id: "a",
                                               name: "Tea House",
                                               coordinate: PlaceCoordinate(latitude: 37.7700, longitude: -122.4200),
                                               evidenceID: "e1")
        let second = P9BDedupFixtures.candidate(id: "b",
                                                name: "Noodle House",
                                                coordinate: PlaceCoordinate(latitude: 37.7701, longitude: -122.4201),
                                                evidenceID: "e2")

        let result = PlaceCandidateDeduplicator().deduplicate([first, second])

        XCTAssertEqual(result.candidates.count, 2)
    }

    func testDedupPreservesSourceConflictsAfterMerge() {
        let open = P9BDedupFixtures.candidate(id: "a",
                                              sourceIDs: ["same"],
                                              opening: .open,
                                              price: .level(2),
                                              parking: .available,
                                              evidenceID: "e1")
        let closed = P9BDedupFixtures.candidate(id: "b",
                                                sourceIDs: ["same"],
                                                opening: .closed,
                                                price: .level(4),
                                                parking: .none,
                                                evidenceID: "e2")

        let result = PlaceCandidateDeduplicator().deduplicate([open, closed])

        XCTAssertEqual(result.candidates.count, 1)
        XCTAssertEqual(result.candidates[0].verificationStatus, .conflicting)
        XCTAssertEqual(Set(result.conflicts.map(\.field)), ["openingStatus", "parkingInfo", "priceEstimate"])
        XCTAssertFalse(result.candidates[0].findings.isEmpty)
    }

    func testValidatorExcludesHardCategoryFailure() {
        let query = P9BDedupFixtures.query(category: .golfDrivingRange)
        let candidate = P9BDedupFixtures.candidate(id: "restaurant", category: .sichuanRestaurant, evidenceID: "e1")

        let report = LocalDiscoveryValidator().validate(query: query, candidates: [candidate])
        let category = report.finding(candidateID: "restaurant", criterion: "category")

        XCTAssertEqual(category?.status, .failed)
        XCTAssertEqual(category?.recommendedDisposition, .excludeHardConstraintFailure)
    }

    func testValidatorTreatsUnknownHardOpeningAsUncertainNotPassed() {
        var query = P9BDedupFixtures.query()
        query.hardConstraints = [
            PlaceConstraint(id: "open-now", kind: .openNow, priority: .hard, value: .bool(true)),
        ]
        let candidate = P9BDedupFixtures.candidate(id: "unknown-open", opening: .unknown, evidenceID: "e1")

        let report = LocalDiscoveryValidator().validate(query: query, candidates: [candidate])
        let opening = report.finding(candidateID: "unknown-open", criterion: "opening_status")

        XCTAssertEqual(opening?.status, .uncertain)
        XCTAssertEqual(opening?.recommendedDisposition, .requiresMoreEvidence)
    }

    func testValidatorSoftPreferenceDoesNotExcludeCandidate() {
        var query = P9BDedupFixtures.query()
        query.softPreferences = [
            PlaceConstraint(id: "parking", kind: .parkingPreference, priority: .soft, value: .string("easy")),
        ]
        let candidate = P9BDedupFixtures.candidate(id: "parking-unknown", parking: .unknown, evidenceID: "e1")

        let report = LocalDiscoveryValidator().validate(query: query, candidates: [candidate])
        let parking = report.finding(candidateID: "parking-unknown", criterion: "parking_preference")

        XCTAssertEqual(parking?.status, .uncertain)
        XCTAssertEqual(parking?.recommendedDisposition, .includeWithWarning)
    }

    func testValidatorOpeningConflictIsExcluded() {
        var candidate = P9BDedupFixtures.candidate(id: "conflict", opening: .conflicting, evidenceID: "e1")
        candidate.verificationStatus = .conflicting

        let report = LocalDiscoveryValidator().validate(query: P9BDedupFixtures.query(), candidates: [candidate])

        XCTAssertEqual(report.disposition(for: "conflict"), .excludeConflict)
    }

    func testValidatorFlagsStaleEvidence() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let candidate = P9BDedupFixtures.candidate(id: "stale",
                                                   evidenceObservedAt: Date(timeIntervalSince1970: 1_000_000_000),
                                                   evidenceID: "e1")

        let report = LocalDiscoveryValidator(now: now, staleSourceAge: 60).validate(query: P9BDedupFixtures.query(),
                                                                                    candidates: [candidate])
        let stale = report.finding(candidateID: "stale", criterion: "stale_evidence")

        XCTAssertEqual(stale?.status, .uncertain)
        XCTAssertEqual(stale?.recommendedDisposition, .includeWithWarning)
    }

    func testValidatorRejectsOverclaim() {
        let candidate = P9BDedupFixtures.candidate(id: "overclaim",
                                                   opening: .unknown,
                                                   parking: .unknown,
                                                   recommendationRationale: "Open now with easy parking",
                                                   evidenceID: "e1")

        let report = LocalDiscoveryValidator().validate(query: P9BDedupFixtures.query(), candidates: [candidate])
        let overclaims = report.findings.filter { $0.criterion == "overclaim" }

        XCTAssertEqual(overclaims.count, 2)
        XCTAssertTrue(overclaims.contains { $0.status == .failed && $0.severity == .blocking })
    }

    func testValidatorPriceMaximumUncertainRequiresEvidenceForHardBudget() {
        var query = P9BDedupFixtures.query()
        query.budget = PlaceBudget(maximumAmount: 40, currencyCode: "USD", perPerson: true)
        let candidate = P9BDedupFixtures.candidate(id: "price-unknown", price: .unknown, evidenceID: "e1")

        let report = LocalDiscoveryValidator().validate(query: query, candidates: [candidate])
        let price = report.finding(candidateID: "price-unknown", criterion: "price_maximum")

        XCTAssertEqual(price?.status, .uncertain)
        XCTAssertEqual(price?.recommendedDisposition, .requiresMoreEvidence)
    }

    func testValidatorParkingUnverifiedWarnsInsteadOfPassing() {
        var query = P9BDedupFixtures.query()
        query.softPreferences = [
            PlaceConstraint(id: "parking", kind: .parkingPreference, priority: .soft, value: .string("easy")),
        ]
        let candidate = P9BDedupFixtures.candidate(id: "parking-low",
                                                   parking: .available,
                                                   parkingConfidence: 0.2,
                                                   evidenceID: "e1")

        let report = LocalDiscoveryValidator().validate(query: query, candidates: [candidate])
        let parking = report.finding(candidateID: "parking-low", criterion: "parking_preference")

        XCTAssertEqual(parking?.status, .uncertain)
        XCTAssertEqual(parking?.recommendedDisposition, .includeWithWarning)
    }
}

private enum P9BDedupFixtures {
    static func query(category: PlaceCategory = .sichuanRestaurant) -> PlaceQuery {
        PlaceQuery(queryID: "q",
                   rawUserIntent: "find places",
                   searchText: "Sichuan restaurant",
                   category: category,
                   locationInput: PlaceLocationInput(kind: .explicitRegion, label: "San Francisco, CA"),
                   resultLimit: 5,
                   createdAt: Date(timeIntervalSince1970: 1_700_000_000))
    }

    static func candidate(id: String,
                          sourceIDs: [String]? = nil,
                          name: String = "Chengdu Taste",
                          category: PlaceCategory = .sichuanRestaurant,
                          address: String = "1 Market St, San Francisco, CA",
                          coordinate: PlaceCoordinate = PlaceCoordinate(latitude: 37.77, longitude: -122.42),
                          phone: String? = nil,
                          website: String? = nil,
                          opening: PlaceOpeningStatusValue = .open,
                          price: PlacePriceValue = .maximumPerPerson(amount: 30, currencyCode: "USD"),
                          parking: PlaceParkingAvailability = .available,
                          parkingConfidence: Double = 0.8,
                          recommendationRationale: String? = nil,
                          evidenceObservedAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
                          evidenceID: String) -> PlaceCandidate {
        let evidence = PlaceEvidenceReference(evidenceID: evidenceID,
                                              sourceToolID: "fixture",
                                              claim: "candidate fixture evidence",
                                              observedAt: evidenceObservedAt,
                                              confidence: 0.9)
        let links = website.map {
            [PlaceWebLink(id: "\(id)-web", kind: .officialWebsite, title: "Website", url: $0, evidenceReferences: [evidence])]
        } ?? []
        return PlaceCandidate(stableID: id,
                              sourceEntityIDs: sourceIDs ?? ["fixture:\(id)"],
                              name: name,
                              categories: [category],
                              address: PlaceAddress(formatted: address),
                              coordinate: coordinate,
                              openingStatus: PlaceOpeningStatus(value: opening,
                                                                checkedAt: evidenceObservedAt,
                                                                confidence: opening == .unknown ? 0 : 0.8,
                                                                source: "fixture",
                                                                evidenceReferences: [evidence],
                                                                uncertaintyReason: opening == .unknown ? "unknown" : nil),
                              priceEstimate: PlacePriceEstimate(value: price,
                                                                confidence: price == .unknown ? 0 : 0.8,
                                                                source: "fixture",
                                                                observedAt: evidenceObservedAt,
                                                                evidenceReferences: [evidence],
                                                                uncertaintyReason: price == .unknown ? "unknown" : nil),
                              parkingInfo: PlaceParkingInfo(value: parking,
                                                            confidence: parkingConfidence,
                                                            source: "fixture",
                                                            observedAt: evidenceObservedAt,
                                                            evidenceReferences: [evidence],
                                                            uncertaintyReason: parking == .unknown ? "unknown" : nil),
                              contact: PlaceContact(phoneNumber: phone, displayPhone: phone),
                              webLinks: links,
                              evidenceReferences: [evidence],
                              freshness: "current-task",
                              verificationStatus: .partiallyVerified,
                              recommendationRationale: recommendationRationale)
    }
}

private extension LocalDiscoveryValidationReport {
    func finding(candidateID: String, criterion: String) -> PlaceVerificationFinding? {
        findings.first { $0.candidateID == candidateID && $0.criterion == criterion }
    }
}
