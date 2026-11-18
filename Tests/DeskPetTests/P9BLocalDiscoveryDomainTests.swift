import XCTest
@testable import PetAgentRuntime

final class P9BLocalDiscoveryDomainTests: XCTestCase {
    func testDomainContractCodableRoundTripPreservesSchemaAndStructuredFields() throws {
        let now = Date(timeIntervalSince1970: 1_786_800_000)
        let evidenceRef = PlaceEvidenceReference(evidenceID: "ev-place-1",
                                                 sourceToolID: "local_place_search",
                                                 sourceURL: "https://example.com/place",
                                                 claim: "candidate identity",
                                                 observedAt: now,
                                                 freshness: "current-task",
                                                 confidence: 0.9)
        let query = p9bQuery(now: now)
        let candidate = PlaceCandidate(
            stableID: "mapkit-chengdu-house",
            sourceEntityIDs: ["mapkit:123"],
            name: "Chengdu House",
            categories: [.sichuanRestaurant],
            address: PlaceAddress(locality: "San Francisco", region: "CA", formatted: "123 Market St, San Francisco, CA"),
            coordinate: PlaceCoordinate(latitude: 37.78, longitude: -122.41, horizontalAccuracyMeters: 50),
            distance: PlaceDistance(meters: 1200, kind: .straightLine, source: "haversine", calculatedAt: now),
            openingStatus: PlaceOpeningStatus(value: .unknown,
                                              checkedAt: now,
                                              targetTime: now,
                                              confidence: 0.2,
                                              source: "not verified",
                                              evidenceReferences: [evidenceRef],
                                              uncertaintyReason: "hours not fetched"),
            priceEstimate: PlacePriceEstimate(value: .maximumPerPerson(amount: 40, currencyCode: "USD"),
                                              confidence: 0.7,
                                              source: "menu page",
                                              observedAt: now,
                                              verifiedAt: now,
                                              evidenceReferences: [evidenceRef]),
            parkingInfo: PlaceParkingInfo(value: .limited,
                                          confidence: 0.4,
                                          source: "public page",
                                          observedAt: now,
                                          evidenceReferences: [evidenceRef],
                                          uncertaintyReason: "no live parking inventory"),
            contact: PlaceContact(phoneNumber: "+14155550123", displayPhone: "(415) 555-0123"),
            webLinks: [
                PlaceWebLink(id: "official", kind: .officialWebsite, title: "Website",
                             url: "https://example.com", evidenceReferences: [evidenceRef])
            ],
            evidenceReferences: [evidenceRef],
            freshness: "current-task",
            verificationStatus: .partiallyVerified,
            actionDescriptors: [
                PlaceActionDescriptor(actionID: "open-website",
                                      type: .openWebsite,
                                      label: "官网",
                                      requiredCapability: "application.launch",
                                      targetReference: "official",
                                      permissionRequirement: .futureDispatchRequired)
            ])
        let evidence = AgentEvidenceRecord(id: "ev-place-1",
                                           taskID: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-000000000001")!,
                                           sourceType: .toolObservation,
                                           sourceToolID: "local_place_search",
                                           capturedAt: now,
                                           contentHash: String(repeating: "a", count: 64),
                                           redactedSummary: "candidate identity",
                                           claimsSupported: ["candidate identity"],
                                           reliability: .directToolResult,
                                           freshness: "current-task",
                                           privacyClass: "public-place")
        let result = LocalDiscoveryResult(resultID: "result-1",
                                          query: query,
                                          status: .partial,
                                          candidates: [candidate],
                                          evidence: [evidence],
                                          usedCapabilities: ["places.search.read"],
                                          backend: "fixture-contract",
                                          generatedAt: now,
                                          freshness: "current-task")

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(result)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(LocalDiscoveryResult.self, from: data)

        XCTAssertEqual(decoded.schemaVersion, LocalDiscoverySchemaVersion.current)
        XCTAssertEqual(decoded.query.schemaVersion, LocalDiscoverySchemaVersion.current)
        XCTAssertEqual(decoded.candidates.first?.stableID, "mapkit-chengdu-house")
        XCTAssertEqual(decoded.candidates.first?.priceEstimate.confidence, 0.7)
        XCTAssertTrue(decoded.missingEvidenceReferenceIDs().isEmpty)
    }

    func testUnknownFieldsAreIgnoredForForwardCompatibility() throws {
        let json = """
        {
          "schemaVersion": 1,
          "queryID": "query-unknown",
          "rawUserIntent": "find a place",
          "searchText": "coffee",
          "category": "place",
          "locationInput": {"kind": "explicitRegion", "label": "San Francisco", "futureField": "ignored"},
          "hardConstraints": [],
          "softPreferences": [],
          "resultLimit": 5,
          "locale": "en_US",
          "timezone": "America/Los_Angeles",
          "createdAt": "2026-07-28T12:00:00Z",
          "futureRootField": {"ignored": true}
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let query = try decoder.decode(PlaceQuery.self, from: Data(json.utf8))

        XCTAssertEqual(query.schemaVersion, 1)
        XCTAssertEqual(query.locationInput.kind, .explicitRegion)
        XCTAssertEqual(query.resultLimit, 5)
    }

    func testHardAndSoftConstraintsRemainDistinct() {
        let query = p9bQuery(hardConstraints: [
            PlaceConstraint(id: "open-now",
                            kind: .openNow,
                            priority: .hard,
                            value: .bool(true)),
            PlaceConstraint(id: "budget",
                            kind: .priceMaximum,
                            priority: .hard,
                            value: .number(40))
        ], softPreferences: [
            PlaceConstraint(id: "parking",
                            kind: .parkingPreference,
                            priority: .soft,
                            value: .string("easy"))
        ])

        XCTAssertEqual(query.hardConstraints.map(\.priority), [.hard, .hard])
        XCTAssertEqual(query.softPreferences.map(\.priority), [.soft])
        XCTAssertEqual(query.hardConstraints.map(\.kind), [.openNow, .priceMaximum])
        XCTAssertEqual(query.softPreferences.first?.kind, .parkingPreference)
    }

    func testUncertaintyRepresentationIsNotNullableFreeTextOnly() {
        let price = PlacePriceEstimate(value: .unknown,
                                       confidence: 0,
                                       source: "no source",
                                       uncertaintyReason: "menu price not found")
        let parking = PlaceParkingInfo(value: .unknown,
                                       confidence: 0.1,
                                       source: "search result",
                                       uncertaintyReason: "parking not mentioned")
        let hours = PlaceOpeningStatus(value: .unknown,
                                       confidence: 0,
                                       source: "webpage_read",
                                       uncertaintyReason: "opening hours not found")

        XCTAssertEqual(price.value, .unknown)
        XCTAssertEqual(price.confidence, 0)
        XCTAssertEqual(price.uncertaintyReason, "menu price not found")
        XCTAssertEqual(parking.value, .unknown)
        XCTAssertEqual(parking.confidence, 0.1)
        XCTAssertEqual(hours.value, .unknown)
    }

    func testEvidenceReferenceIntegrityDetectsMissingBindings() {
        let ref = PlaceEvidenceReference(evidenceID: "missing-evidence",
                                         sourceToolID: "webpage_read",
                                         claim: "opening hours")
        let candidate = PlaceCandidate(stableID: "candidate-1",
                                       name: "Candidate",
                                       openingStatus: PlaceOpeningStatus(value: .open,
                                                                         confidence: 0.8,
                                                                         source: "webpage_read",
                                                                         evidenceReferences: [ref]),
                                       evidenceReferences: [ref],
                                       verificationStatus: .partiallyVerified)
        let result = LocalDiscoveryResult(resultID: "result-missing",
                                          query: p9bQuery(),
                                          candidates: [candidate],
                                          evidence: [])

        XCTAssertEqual(result.missingEvidenceReferenceIDs(), ["missing-evidence"])
    }

    private func p9bQuery(now: Date = Date(timeIntervalSince1970: 1_786_800_000),
                          hardConstraints: [PlaceConstraint] = [],
                          softPreferences: [PlaceConstraint] = []) -> PlaceQuery {
        PlaceQuery(queryID: "query-1",
                   rawUserIntent: "nearby Sichuan restaurants open tonight under $40 with parking",
                   searchText: "Sichuan restaurant",
                   category: .sichuanRestaurant,
                   locationInput: PlaceLocationInput(kind: .explicitRegion, label: "San Francisco, CA"),
                   temporalConstraint: PlaceTemporalConstraint(targetDate: now, description: "tonight"),
                   hardConstraints: hardConstraints,
                   softPreferences: softPreferences,
                   budget: PlaceBudget(maximumAmount: 40, currencyCode: "USD", perPerson: true),
                   travelLimit: PlaceTravelLimit(maximumDistanceMeters: 8000, transportMode: .automobile),
                   resultLimit: 5,
                   locale: "en_US",
                   timezone: "America/Los_Angeles",
                   createdAt: now)
    }
}
