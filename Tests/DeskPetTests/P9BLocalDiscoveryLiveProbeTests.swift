import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime

final class P9BLocalDiscoveryLiveProbeTests: XCTestCase {
    func testLiveSichuanRestaurantProbeThroughGenericToolChain() async throws {
        try await runProbe(.init(probeID: "p9b-live-a",
                                 queryText: "Sichuan restaurant",
                                 category: .sichuanRestaurant,
                                 regionText: "San Francisco, CA",
                                 origin: PlaceCoordinate(latitude: 37.7749, longitude: -122.4194)))
    }

    func testLiveGolfDrivingRangeProbeThroughGenericToolChain() async throws {
        try await runProbe(.init(probeID: "p9b-live-golf",
                                 queryText: "golf driving range",
                                 category: .golfDrivingRange,
                                 regionText: "San Jose, CA",
                                 origin: PlaceCoordinate(latitude: 37.3382, longitude: -121.8863)))
    }

    private func runProbe(_ probe: P9BLiveProbe) async throws {
        guard ProcessInfo.processInfo.environment["DESKPET_P9B_LIVE_PLACE_PROBE"] == "1" else {
            throw XCTSkip("Set DESKPET_P9B_LIVE_PLACE_PROBE=1 to run live MapKit local discovery probes.")
        }

        let registry = ToolRegistry(gate: P9BLiveAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(LocalPlaceSearchAgentTool())
        try await registry.register(RouteDistanceEstimateAgentTool())
        try await registry.register(WebpageReadAgentTool())
        try await registry.register(StructuredPlaceExtractionAgentTool())

        let searchRequest = AgentToolCallRequest(callID: "\(probe.probeID)-search",
                                                 toolName: "local_place_search",
                                                 arguments: .object([
                                                     "queryText": .string(probe.queryText),
                                                     "category": .string(probe.category.rawValue),
                                                     "regionText": .string(probe.regionText),
                                                     "resultLimit": .number(5),
                                                     "locale": .string("en_US"),
                                                 ]),
                                                 userVisibleSummary: "正在搜索地点")
        let searchResult = await registry.executeTool(
            request: searchRequest,
            context: context(callID: searchRequest.callID, toolID: "local_place_search"))
        let searchOutput = try successOutput(searchResult, tool: "local_place_search")
        let searchSchema = ToolSchemaValidator.validate(searchOutput,
                                                        against: LocalPlaceSearchAgentTool.manifest.outputContract.schema!)
        XCTAssertTrue(searchSchema.accepted, searchSchema.issues.map(\.message).joined(separator: "\n"))
        XCTAssertEqual(searchOutput.boolValue("usedFixture"), false)
        let searchStatus = searchOutput.stringValue("status") ?? "unknown"
        let searchEvidenceIDs = evidenceIDs(from: searchOutput)
        XCTAssertFalse(searchEvidenceIDs.isEmpty)

        if searchStatus != "success" {
            let record = P9BLiveProbeRecord(probeID: probe.probeID,
                                            category: probe.category.rawValue,
                                            backend: searchOutput.stringValue("backend") ?? "unknown",
                                            query: searchOutput.stringValue("query") ?? probe.queryText,
                                            inputLocationType: searchOutput.stringValue("inputLocationType") ?? "unknown",
                                            searchStatus: searchStatus,
                                            searchErrorReason: searchOutput.stringValue("errorReason"),
                                            resultCount: searchOutput.intValue("resultCount") ?? 0,
                                            cancellationSupport: true,
                                            searchEvidenceIDs: searchEvidenceIDs,
                                            routeEvidenceIDs: [],
                                            realData: false,
                                            usedFixture: searchOutput.boolValue("usedFixture") ?? true,
                                            schemaValidationAccepted: searchSchema.accepted,
                                            validatorFindingCount: 0,
                                            validatorDisposition: "not_run",
                                            routeStatus: "not_run",
                                            routeCalculationSource: nil,
                                            routeDistancePresent: false,
                                            straightLineDistancePresent: false,
                                            webpageStatus: "not_run",
                                            webpageEvidenceIDs: [],
                                            extractionStatus: "not_run",
                                            extractionWarnings: [])
            print("P9B_LIVE_PROBE_RESULT \(try record.jsonLine())")
            return
        }

        let candidateValues = searchOutput.arrayValue("candidates") ?? []
        let candidates = try candidateValues.map { try LocalDiscoveryJSON.decoded(PlaceCandidate.self, from: $0) }
        XCTAssertEqual(searchOutput.intValue("resultCount"), candidates.count)
        for candidate in candidates {
            XCTAssertFalse(candidate.stableID.isEmpty)
            XCTAssertFalse(candidate.name.isEmpty)
            XCTAssertFalse(candidate.sourceEntityIDs.isEmpty)
            XCTAssertFalse(candidate.evidenceReferences.isEmpty)
            XCTAssertFalse(candidate.openingStatus.evidenceReferences.isEmpty)
            XCTAssertFalse(candidate.priceEstimate.evidenceReferences.isEmpty)
            XCTAssertFalse(candidate.parkingInfo.evidenceReferences.isEmpty)
        }

        var routeStatus = "not_run"
        var routeEvidenceIDs: [String] = []
        var routeCalculationSource: String?
        var routeDistancePresent = false
        var straightLineDistancePresent = false
        var candidateForValidation = candidates.first
        if var candidate = candidates.first, let destination = candidate.coordinate {
            let routeRequest = AgentToolCallRequest(callID: "\(probe.probeID)-route",
                                                    toolName: "route_distance_estimate",
                                                    arguments: .object([
                                                        "origin": coordinateJSON(probe.origin),
                                                        "destination": coordinateJSON(destination),
                                                        "transportMode": .string("automobile"),
                                                    ]),
                                                    userVisibleSummary: "正在估算距离")
            let routeResult = await registry.executeTool(
                request: routeRequest,
                context: context(callID: routeRequest.callID, toolID: "route_distance_estimate"))
            let routeOutput = try successOutput(routeResult, tool: "route_distance_estimate")
            let routeSchema = ToolSchemaValidator.validate(routeOutput,
                                                           against: RouteDistanceEstimateAgentTool.manifest.outputContract.schema!)
            XCTAssertTrue(routeSchema.accepted, routeSchema.issues.map(\.message).joined(separator: "\n"))
            XCTAssertEqual(routeOutput.boolValue("usedFixture"), false)
            routeEvidenceIDs = evidenceIDs(from: routeOutput)
            XCTAssertFalse(routeEvidenceIDs.isEmpty)
            routeStatus = routeOutput.stringValue("status") ?? "unknown"
            routeCalculationSource = routeOutput.stringValue("calculationSource")
            straightLineDistancePresent = routeOutput.doubleValue("straightLineDistanceMeters") != nil
            routeDistancePresent = routeOutput.doubleValue("routeDistanceMeters") != nil
            if routeDistancePresent == false {
                XCTAssertNotEqual(routeCalculationSource, "MapKit.MKDirections")
                XCTAssertNotNil(routeOutput.stringValue("uncertaintyReason"))
            }
            candidate.distance = placeDistance(from: routeOutput,
                                               key: "straightLineDistanceMeters",
                                               kind: .straightLine)
            candidate.travelEstimate = placeTravelEstimate(from: routeOutput)
            candidateForValidation = candidate
        }

        let webpageRecord = await firstSuccessfulWebRead(from: candidates,
                                                         registry: registry,
                                                         probeID: probe.probeID)
        let query = PlaceQuery(queryID: probe.probeID,
                               rawUserIntent: "\(probe.queryText) near \(probe.regionText)",
                               searchText: probe.queryText,
                               category: probe.category,
                               locationInput: PlaceLocationInput(kind: .explicitRegion,
                                                                  label: probe.regionText),
                               resultLimit: 5,
                               locale: "en_US",
                               timezone: "America/Los_Angeles",
                               createdAt: Date())
        let validationReport = LocalDiscoveryValidator(now: Date()).validate(
            query: query,
            candidates: candidateForValidation.map { [$0] } ?? [])
        let disposition = candidateForValidation.map {
            validationReport.disposition(for: $0.stableID).rawValue
        } ?? "not_applicable"

        let record = P9BLiveProbeRecord(probeID: probe.probeID,
                                        category: probe.category.rawValue,
                                        backend: searchOutput.stringValue("backend") ?? "unknown",
                                        query: searchOutput.stringValue("query") ?? probe.queryText,
                                        inputLocationType: searchOutput.stringValue("inputLocationType") ?? "unknown",
                                        searchStatus: searchStatus,
                                        searchErrorReason: nil,
                                        resultCount: candidates.count,
                                        cancellationSupport: true,
                                        searchEvidenceIDs: searchEvidenceIDs,
                                        routeEvidenceIDs: routeEvidenceIDs,
                                        realData: true,
                                        usedFixture: searchOutput.boolValue("usedFixture") ?? true,
                                        schemaValidationAccepted: searchSchema.accepted,
                                        validatorFindingCount: validationReport.findings.count,
                                        validatorDisposition: disposition,
                                        routeStatus: routeStatus,
                                        routeCalculationSource: routeCalculationSource,
                                        routeDistancePresent: routeDistancePresent,
                                        straightLineDistancePresent: straightLineDistancePresent,
                                        webpageStatus: webpageRecord.status,
                                        webpageEvidenceIDs: webpageRecord.evidenceIDs,
                                        extractionStatus: webpageRecord.extractionStatus,
                                        extractionWarnings: webpageRecord.extractionWarnings)
        print("P9B_LIVE_PROBE_RESULT \(try record.jsonLine())")
    }

    private func firstSuccessfulWebRead(from candidates: [PlaceCandidate],
                                        registry: ToolRegistry,
                                        probeID: String) async -> P9BLiveWebpageRecord {
        let urls = candidates
            .flatMap(\.webLinks)
            .map(\.url)
            .filter { $0.lowercased().hasPrefix("http://") || $0.lowercased().hasPrefix("https://") }
        guard urls.isEmpty == false else {
            return P9BLiveWebpageRecord(status: "not_available",
                                        evidenceIDs: [],
                                        extractionStatus: "not_run",
                                        extractionWarnings: [])
        }

        for (index, url) in urls.prefix(3).enumerated() {
            let callID = "\(probeID)-web-\(index)"
            let request = AgentToolCallRequest(callID: callID,
                                               toolName: "webpage_read",
                                               arguments: .object([
                                                   "url": .string(url),
                                                   "extractionPurpose": .string("verify local place details"),
                                                   "allowedContentTypes": .array([
                                                       .string("text/html"),
                                                       .string("application/xhtml+xml"),
                                                       .string("application/json"),
                                                       .string("application/ld+json"),
                                                       .string("text/plain"),
                                                   ]),
                                                   "sizeLimitBytes": .number(65_536),
                                               ]),
                                               userVisibleSummary: "正在读取网页")
            let result = await registry.executeTool(
                request: request,
                context: context(callID: callID, toolID: "webpage_read"))
            guard case .success(let webResult) = result else { continue }
            let webOutput = webResult.structuredData
            let webSchema = ToolSchemaValidator.validate(webOutput,
                                                         against: WebpageReadAgentTool.manifest.outputContract.schema!)
            guard webSchema.accepted else { continue }
            guard webOutput.boolValue("contentIsUntrusted") == true else { continue }
            let webEvidenceIDs = evidenceIDs(from: webOutput)
            guard let evidenceID = webEvidenceIDs.first else { continue }

            let extractionCallID = "\(probeID)-extract-\(index)"
            var extractionArguments: [String: AgentJSONValue] = [
                "evidenceID": .string(evidenceID),
                "canonicalURL": .string(webOutput.stringValue("canonicalURL") ?? url),
                "extractedText": .string(webOutput.stringValue("extractedText") ?? ""),
                "structuredMetadata": .array(webOutput.arrayValue("structuredMetadata") ?? []),
                "fields": .array([
                    .string("openingHours"),
                    .string("phone"),
                    .string("website"),
                    .string("menu"),
                    .string("price"),
                    .string("parking"),
                ]),
                "fetchedAt": .string(webOutput.stringValue("fetchedAt") ?? ""),
            ]
            if let pageTitle = webOutput.stringValue("pageTitle") {
                extractionArguments["pageTitle"] = .string(pageTitle)
            }
            let extractionRequest = AgentToolCallRequest(callID: extractionCallID,
                                                         toolName: "structured_place_extraction",
                                                         arguments: .object(extractionArguments),
                                                         userVisibleSummary: "正在提取网页中的地点信息")
            let extractionResult = await registry.executeTool(
                request: extractionRequest,
                context: context(callID: extractionCallID, toolID: "structured_place_extraction"))
            guard case .success(let extraction) = extractionResult else {
                return P9BLiveWebpageRecord(status: "success",
                                            evidenceIDs: webEvidenceIDs,
                                            extractionStatus: "failed",
                                            extractionWarnings: [])
            }
            let extractionSchema = ToolSchemaValidator.validate(
                extraction.structuredData,
                against: StructuredPlaceExtractionAgentTool.manifest.outputContract.schema!)
            guard extractionSchema.accepted else {
                return P9BLiveWebpageRecord(status: "success",
                                            evidenceIDs: webEvidenceIDs,
                                            extractionStatus: "schema_failed",
                                            extractionWarnings: [])
            }
            let warnings = extraction.structuredData
                .arrayValue("warnings")?
                .compactMap(\.stringScalar) ?? []
            return P9BLiveWebpageRecord(status: "success",
                                        evidenceIDs: webEvidenceIDs,
                                        extractionStatus: "success",
                                        extractionWarnings: warnings)
        }

        return P9BLiveWebpageRecord(status: "failed",
                                    evidenceIDs: [],
                                    extractionStatus: "not_run",
                                    extractionWarnings: [])
    }

    private func successOutput(_ result: Result<ToolExecutionResult, ToolPlatformError>,
                               tool: String) throws -> AgentJSONValue {
        switch result {
        case .success(let output):
            return output.structuredData
        case .failure(let error):
            XCTFail("Expected \(tool) success, got \(error)")
            throw error
        }
    }

    private func context(callID: String, toolID: ToolID) -> ToolExecutionContext {
        ToolExecutionContext(taskID: UUID(),
                             runID: UUID(),
                             turnID: UUID(),
                             callID: callID,
                             toolID: toolID,
                             locale: Locale(identifier: "en_US"),
                             timeZone: TimeZone(identifier: "America/Los_Angeles")!,
                             clock: WallClock())
    }

    private func coordinateJSON(_ coordinate: PlaceCoordinate) -> AgentJSONValue {
        .object([
            "latitude": .number(coordinate.latitude),
            "longitude": .number(coordinate.longitude),
        ])
    }

    private func evidenceIDs(from value: AgentJSONValue) -> [String] {
        value.arrayValue("evidenceReferences")?
            .compactMap { $0.objectValue?["evidenceID"]?.stringScalar }
            .sorted() ?? []
    }

    private func placeDistance(from value: AgentJSONValue,
                               key: String,
                               kind: PlaceDistanceKind) -> PlaceDistance? {
        guard let meters = value.doubleValue(key) else { return nil }
        return PlaceDistance(meters: meters,
                             kind: kind,
                             source: value.stringValue("calculationSource") ?? "unknown",
                             calculatedAt: Date(),
                             uncertaintyReason: value.stringValue("uncertaintyReason"))
    }

    private func placeTravelEstimate(from value: AgentJSONValue) -> PlaceTravelEstimate {
        PlaceTravelEstimate(transportMode: PlaceTransportMode(rawValue: value.stringValue("transportMode") ?? "") ?? .unknown,
                            straightLineDistance: placeDistance(from: value,
                                                                key: "straightLineDistanceMeters",
                                                                kind: .straightLine),
                            routeDistance: placeDistance(from: value,
                                                         key: "routeDistanceMeters",
                                                         kind: .route),
                            estimatedTravelDurationSeconds: value.doubleValue("estimatedTravelDurationSeconds"),
                            calculationSource: value.stringValue("calculationSource") ?? "unknown",
                            calculatedAt: Date(),
                            uncertaintyReason: value.stringValue("uncertaintyReason"))
    }
}

private struct P9BLiveProbe: Sendable {
    var probeID: String
    var queryText: String
    var category: PlaceCategory
    var regionText: String
    var origin: PlaceCoordinate
}

private struct P9BLiveWebpageRecord: Sendable {
    var status: String
    var evidenceIDs: [String]
    var extractionStatus: String
    var extractionWarnings: [String]
}

private struct P9BLiveProbeRecord: Codable, Sendable {
    var probeID: String
    var category: String
    var backend: String
    var query: String
    var inputLocationType: String
    var searchStatus: String
    var searchErrorReason: String?
    var resultCount: Int
    var cancellationSupport: Bool
    var searchEvidenceIDs: [String]
    var routeEvidenceIDs: [String]
    var realData: Bool
    var usedFixture: Bool
    var schemaValidationAccepted: Bool
    var validatorFindingCount: Int
    var validatorDisposition: String
    var routeStatus: String
    var routeCalculationSource: String?
    var routeDistancePresent: Bool
    var straightLineDistancePresent: Bool
    var webpageStatus: String
    var webpageEvidenceIDs: [String]
    var extractionStatus: String
    var extractionWarnings: [String]

    func jsonLine() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(data: try encoder.encode(self), encoding: .utf8) ?? "{}"
    }
}

private struct P9BLiveAllowPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: true,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired)
    }
}

private extension AgentJSONValue {
    var objectValue: [String: AgentJSONValue]? {
        if case .object(let object) = self { return object }
        return nil
    }

    var stringScalar: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var doubleScalar: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    func stringValue(_ key: String) -> String? {
        objectValue?[key]?.stringScalar
    }

    func doubleValue(_ key: String) -> Double? {
        objectValue?[key]?.doubleScalar
    }

    func intValue(_ key: String) -> Int? {
        doubleValue(key).map(Int.init)
    }

    func boolValue(_ key: String) -> Bool? {
        guard case .bool(let value)? = objectValue?[key] else { return nil }
        return value
    }

    func arrayValue(_ key: String) -> [AgentJSONValue]? {
        guard case .array(let values)? = objectValue?[key] else { return nil }
        return values
    }
}
