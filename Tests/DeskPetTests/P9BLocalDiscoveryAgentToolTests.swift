import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

final class P9BLocalDiscoveryAgentToolTests: XCTestCase {
    func testReleaseRegistryIncludesEnabledP9ReadOnlyToolsAndSnapshotFiltersDisabled() async throws {
        let manifests = ToolPlatformAssembly.releaseManifests
        let ids = manifests.map(\.id.rawValue)
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertTrue(ids.contains("approximate_location"))
        XCTAssertTrue(ids.contains("local_place_search"))
        XCTAssertTrue(ids.contains("route_distance_estimate"))
        XCTAssertFalse(ids.contains("webpage_read"))
        XCTAssertTrue(ids.contains("structured_place_extraction"))

        let policy = InMemoryToolPolicyStore()
        await policy.setEnabled(false, for: "local_place_search")
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(),
                                    audit: InMemoryAuditSink(),
                                    toolPolicy: policy)
        for tool in ToolPlatformAssembly.releaseTools {
            try await registry.registerAgentTool(tool)
        }

        let snapshot = await registry.toolCatalogSnapshot(for: AgentPolicy(allowTools: true,
                                                                           maxSteps: 4,
                                                                           tier: .developerID))
        XCTAssertTrue(snapshot.contains("approximate_location"))
        XCTAssertFalse(snapshot.contains("local_place_search"))
        XCTAssertTrue(snapshot.contains("route_distance_estimate"))
        XCTAssertFalse(snapshot.contains("webpage_read"))
        XCTAssertTrue(snapshot.contains("structured_place_extraction"))
    }

    func testRegistryPermissionDeniedPreventsAgentToolExecution() async throws {
        let searcher = P9BRecordingPlaceSearcher()
        let registry = ToolRegistry(gate: P9BToolDenyPermissionGate(),
                                    audit: InMemoryAuditSink())
        try await registry.register(LocalPlaceSearchAgentTool(searcher: searcher))

        let result = await registry.executeTool(
            request: P9BToolRequest.search(callID: "search-denied"),
            context: P9BToolRequest.context(callID: "search-denied", toolID: "local_place_search"))

        switch result {
        case .failure(.permissionDenied(let capabilityID)):
            XCTAssertEqual(capabilityID, "places.search.read")
        default:
            XCTFail("Expected registry permission denial, got \(result)")
        }
        let calls = await searcher.callCount()
        XCTAssertEqual(calls, 0)
    }

    func testApproximateLocationAllowOnceRepromptsAndRedactsInjectedLocation() async throws {
        let approver = P9BApproverBox(decision: .allowOnce)
        let appGate = BrokerCapabilityGate(tier: .developerID,
                                           approver: { _, _, _ in await approver.decide() })
        let permission = CapabilityPermissionGate(appGate: appGate,
                                                  audit: InMemoryAuditSink(),
                                                  clock: TestClock())
        let provider = P9BLocationProvider(snapshot: .init(
            authorizationState: .granted,
            coordinate: PlaceCoordinate(latitude: 37.7749295,
                                        longitude: -122.4194155,
                                        horizontalAccuracyMeters: 5),
            regionDescription: "San Francisco",
            horizontalAccuracyMeters: 5,
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            source: "test-injected"))
        let registry = ToolRegistry(gate: permission, audit: InMemoryAuditSink())
        try await registry.register(ApproximateLocationAgentTool(provider: provider))

        let first = await registry.executeTool(request: P9BToolRequest.location(callID: "loc-1"),
                                               context: P9BToolRequest.context(callID: "loc-1",
                                                                               toolID: "approximate_location"))
        let second = await registry.executeTool(request: P9BToolRequest.location(callID: "loc-2"),
                                                context: P9BToolRequest.context(callID: "loc-2",
                                                                                toolID: "approximate_location"))

        let output = try XCTUnwrap(first.successValue?.structuredData.objectValue)
        let coordinate = try XCTUnwrap(output["coordinate"]?.objectValue)
        XCTAssertEqual(coordinate["latitude"]?.doubleValue, 37.77)
        XCTAssertEqual(coordinate["longitude"]?.doubleValue, -122.42)
        XCTAssertEqual(output["horizontalAccuracyMeters"]?.doubleValue, 3_000)
        XCTAssertEqual(second.successValue?.status, .success)
        let approvalCalls = await approver.count()
        let providerCalls = await provider.callCount()
        XCTAssertEqual(approvalCalls, 2)
        XCTAssertEqual(providerCalls, 2)
    }

    func testApproximateLocationProviderDeniedReturnsStructuredDenied() async throws {
        let provider = P9BLocationProvider(snapshot: .init(
            authorizationState: .denied,
            coordinate: nil,
            regionDescription: nil,
            horizontalAccuracyMeters: nil,
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            source: "test-injected"))
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(ApproximateLocationAgentTool(provider: provider))

        let result = await registry.executeTool(request: P9BToolRequest.location(callID: "loc-denied"),
                                                context: P9BToolRequest.context(callID: "loc-denied",
                                                                                toolID: "approximate_location"))

        switch result {
        case .success(let output):
            XCTAssertEqual(output.status, .denied)
            XCTAssertEqual(output.structuredData.stringValue("status"), "denied")
            XCTAssertEqual(output.structuredData.stringValue("authorizationState"), "denied")
        case .failure(let error):
            XCTFail("Expected structured denied output, got \(error)")
        }
    }

    func testApproximateLocationCancellationPropagatesThroughRegistry() async throws {
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(ApproximateLocationAgentTool(provider: P9BSlowLocationProvider()))

        let task = Task {
            await registry.executeTool(request: P9BToolRequest.location(callID: "loc-cancel"),
                                       context: P9BToolRequest.context(callID: "loc-cancel",
                                                                       toolID: "approximate_location"))
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        task.cancel()
        let result = await task.value

        XCTAssertEqual(result, .failure(.cancelled))
    }

    func testPlaceSearchMapsCandidatesLimitSchemaAndEvidence() async throws {
        let searcher = P9BRecordingPlaceSearcher(candidateCount: 5)
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(LocalPlaceSearchAgentTool(searcher: searcher))

        let result = await registry.executeTool(
            request: P9BToolRequest.search(callID: "search-ok", resultLimit: 3),
            context: P9BToolRequest.context(callID: "search-ok", toolID: "local_place_search"))

        let output: AgentJSONValue
        switch result {
        case .success(let value):
            output = value.structuredData
        case .failure(let error):
            return XCTFail("Expected place search success, got \(error)")
        }
        XCTAssertEqual(output.stringValue("backend"), "fixture-place-searcher")
        XCTAssertEqual(output.intValue("resultCount"), 3)
        XCTAssertEqual(output.boolValue("usedFixture"), false)
        XCTAssertEqual(output.arrayValue("candidates")?.count, 3)
        XCTAssertEqual(output.arrayValue("evidenceReferences")?.count, 1)
        XCTAssertTrue(ToolSchemaValidator.validate(output,
                                                   against: LocalDiscoveryToolSchemas.placeSearchOutput).accepted)
    }

    func testPlaceSearchMalformedBackendResultFailsOutputSchema() async throws {
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(LocalPlaceSearchAgentTool(searcher: P9BMalformedPlaceSearcher()))

        let result = await registry.executeTool(
            request: P9BToolRequest.search(callID: "search-bad"),
            context: P9BToolRequest.context(callID: "search-bad", toolID: "local_place_search"))

        switch result {
        case .failure(.schemaValidationFailed(let issues)):
            XCTAssertTrue(issues.contains { $0.path.contains("evidenceReferences") })
        default:
            XCTFail("Expected output schema failure, got \(result)")
        }
    }

    func testRouteDistanceDistinguishesStraightLineAndRouteDistance() async throws {
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(RouteDistanceEstimateAgentTool(estimator: P9BRouteEstimator()))

        let result = await registry.executeTool(
            request: P9BToolRequest.route(callID: "route-ok"),
            context: P9BToolRequest.context(callID: "route-ok", toolID: "route_distance_estimate"))

        let output = try XCTUnwrap(result.successValue?.structuredData)
        XCTAssertEqual(output.doubleValue("straightLineDistanceMeters"), 1_000)
        XCTAssertEqual(output.doubleValue("routeDistanceMeters"), 1_450)
        XCTAssertEqual(output.doubleValue("estimatedTravelDurationSeconds"), 420)
        XCTAssertEqual(output.stringValue("calculationSource"), "fixture-route")
    }

    func testRouteFallbackDoesNotClaimDrivingRouteForUnsupportedMode() async throws {
        let tool = AnyAgentTool(RouteDistanceEstimateAgentTool(estimator: MapKitRouteDistanceEstimator()))
        let result = try await tool.execute(arguments: P9BToolRequest.routeArguments(transportMode: "cycling"),
                                            context: P9BToolRequest.context(callID: "route-fallback",
                                                                            toolID: "route_distance_estimate",
                                                                            permissionAlreadyEvaluated: true))
        XCTAssertEqual(result.status, .partial)
        XCTAssertNotNil(result.structuredData.doubleValue("straightLineDistanceMeters"))
        XCTAssertNil(result.structuredData.doubleValue("routeDistanceMeters"))
        XCTAssertEqual(result.structuredData.stringValue("calculationSource"), "haversine")
        XCTAssertNotNil(result.structuredData.stringValue("uncertaintyReason"))
    }

    func testWebpageReadMarksUntrustedContentAndBindsEvidence() async throws {
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(WebpageReadAgentTool(reader: P9BWebpageReader()))

        let result = await registry.executeTool(
            request: P9BToolRequest.web(callID: "web-ok"),
            context: P9BToolRequest.context(callID: "web-ok", toolID: "webpage_read"))

        let output = try XCTUnwrap(result.successValue?.structuredData)
        XCTAssertEqual(output.boolValue("contentIsUntrusted"), true)
        XCTAssertEqual(output.stringValue("contentHash"), "hash-fixture")
        XCTAssertEqual(output.arrayValue("structuredMetadata")?.count, 1)
        XCTAssertTrue(output.jsonString.contains("evidence-web-ok"))
    }

    func testStructuredExtractionUsesMetadataAndDoesNotFabricateMissingParking() async throws {
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(StructuredPlaceExtractionAgentTool())
        let metadata: AgentJSONValue = .object([
            "@type": .string("Restaurant"),
            "telephone": .string("+1 415 555 0100"),
            "priceRange": .string("$$"),
            "openingHours": .array([.string("Mo-Su 17:00-22:00")]),
        ])
        let result = await registry.executeTool(
            request: P9BToolRequest.extraction(callID: "extract-ok", metadata: [metadata]),
            context: P9BToolRequest.context(callID: "extract-ok",
                                            toolID: "structured_place_extraction"))

        let fields = try XCTUnwrap(result.successValue?.structuredData.objectValue?["extractedFields"]?.objectValue)
        XCTAssertEqual(fields["phone"]?.objectValue?["value"]?.stringScalar, "+1 415 555 0100")
        XCTAssertEqual(fields["priceHints"]?.objectValue?["value"]?.stringScalar, "$$")
        XCTAssertEqual(fields["parkingHints"]?.objectValue?["status"]?.stringScalar, "unknown")
        XCTAssertTrue(result.successValue?.structuredData.jsonString.contains("parking_unknown") ?? false)
    }

    func testDynamicWorkflowExecutionProducesRuntimeEvidenceForP9Tool() async throws {
        let registry = ToolRegistry(gate: P9BToolAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(LocalPlaceSearchAgentTool(searcher: P9BRecordingPlaceSearcher(candidateCount: 1)))
        let catalog = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: LocalPlaceSearchAgentTool.manifest, enabled: true),
        ])
        let workflow = DynamicWorkflow(id: "p9b.local.discovery.probe",
                                       version: 1,
                                       goal: "Search one local place category",
                                       steps: [
                                           DynamicWorkflowStep(stepID: "search",
                                                               toolID: "local_place_search",
                                                               arguments: P9BToolRequest.searchArguments(resultLimit: 1),
                                                               outputSchema: LocalPlaceSearchAgentTool.manifest.outputContract.schema,
                                                               userVisibleSummary: "正在搜索地点"),
                                       ])
        let taskID = UUID()
        let report = await DynamicWorkflowExecutor(toolPlatform: registry,
                                                   permissionGate: P9BToolAllowPermissionGate(),
                                                   clock: TestClock())
            .execute(workflow,
                     taskID: taskID,
                     runID: UUID(),
                     toolCatalog: catalog)

        XCTAssertEqual(report.status, .success)
        XCTAssertEqual(report.observations.count, 1)
        XCTAssertEqual(report.evidence.count, 1)
        XCTAssertEqual(report.evidence.first?.id, "evidence-search")
        XCTAssertEqual(report.evidence.first?.sourceToolID, "local_place_search")
        XCTAssertTrue(report.outputs["search"]?.jsonString.contains("evidence-search") ?? false)
    }
}

private enum P9BToolRequest {
    static func location(callID: String) -> AgentToolCallRequest {
        AgentToolCallRequest(callID: callID,
                             toolName: "approximate_location",
                             arguments: .object([
                                 "desiredAccuracyLevel": .string("city"),
                                 "purpose": .string("local discovery"),
                                 "taskScope": .string("one-task"),
                             ]),
                             userVisibleSummary: "正在获取位置")
    }

    static func search(callID: String, resultLimit: Int = 3) -> AgentToolCallRequest {
        AgentToolCallRequest(callID: callID,
                             toolName: "local_place_search",
                             arguments: searchArguments(resultLimit: resultLimit),
                             userVisibleSummary: "正在搜索地点")
    }

    static func searchArguments(resultLimit: Int = 3) -> AgentJSONValue {
        .object([
            "queryText": .string("Sichuan restaurant"),
            "category": .string("sichuan_restaurant"),
            "regionText": .string("San Francisco, CA"),
            "resultLimit": .number(Double(resultLimit)),
            "locale": .string("en_US"),
        ])
    }

    static func route(callID: String) -> AgentToolCallRequest {
        AgentToolCallRequest(callID: callID,
                             toolName: "route_distance_estimate",
                             arguments: routeArguments(),
                             userVisibleSummary: "正在估算距离")
    }

    static func routeArguments(transportMode: String = "automobile") -> AgentJSONValue {
        .object([
            "origin": .object(["latitude": .number(37.7749), "longitude": .number(-122.4194)]),
            "destination": .object(["latitude": .number(37.7849), "longitude": .number(-122.4094)]),
            "transportMode": .string(transportMode),
        ])
    }

    static func web(callID: String) -> AgentToolCallRequest {
        AgentToolCallRequest(callID: callID,
                             toolName: "webpage_read",
                             arguments: .object([
                                 "url": .string("https://example.com/place"),
                                 "extractionPurpose": .string("verify place details"),
                                 "allowedContentTypes": .array([.string("text/html")]),
                                 "sizeLimitBytes": .number(4096),
                             ]),
                             userVisibleSummary: "正在读取网页")
    }

    static func extraction(callID: String, metadata: [AgentJSONValue]) -> AgentToolCallRequest {
        AgentToolCallRequest(callID: callID,
                             toolName: "structured_place_extraction",
                             arguments: .object([
                                 "evidenceID": .string("evidence-web-ok"),
                                 "canonicalURL": .string("https://example.com/place"),
                                 "pageTitle": .string("Example Place"),
                                 "extractedText": .string("No live parking availability is stated."),
                                 "structuredMetadata": .array(metadata),
                                 "fields": .array([
                                     .string("openingHours"),
                                     .string("phone"),
                                     .string("price"),
                                     .string("parking"),
                                 ]),
                                 "fetchedAt": .string("2026-07-28T00:00:00.000Z"),
                             ]),
                             userVisibleSummary: "正在提取网页中的地点信息")
    }

    static func context(callID: String,
                        toolID: ToolID,
                        permissionAlreadyEvaluated: Bool = false) -> ToolExecutionContext {
        ToolExecutionContext(taskID: UUID(),
                             runID: UUID(),
                             turnID: UUID(),
                             callID: callID,
                             toolID: toolID,
                             locale: Locale(identifier: "en_US"),
                             timeZone: TimeZone(identifier: "America/Los_Angeles")!,
                             clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)),
                             permissionAlreadyEvaluated: permissionAlreadyEvaluated)
    }
}

private actor P9BApproverBox {
    private let decision: ApprovalDecision
    private var calls = 0

    init(decision: ApprovalDecision) {
        self.decision = decision
    }

    func decide() -> ApprovalDecision {
        calls += 1
        return decision
    }

    func count() -> Int { calls }
}

private actor P9BLocationProvider: ApproximateLocationProviding {
    private let snapshot: ApproximateLocationSnapshot
    private var calls = 0

    init(snapshot: ApproximateLocationSnapshot) {
        self.snapshot = snapshot
    }

    func approximateLocation(desiredAccuracyLevel: String,
                             purpose: String,
                             taskScope: String?,
                             context: ToolExecutionContext) async throws -> ApproximateLocationSnapshot {
        calls += 1
        return snapshot
    }

    func callCount() -> Int { calls }
}

private struct P9BSlowLocationProvider: ApproximateLocationProviding {
    func approximateLocation(desiredAccuracyLevel: String,
                             purpose: String,
                             taskScope: String?,
                             context: ToolExecutionContext) async throws -> ApproximateLocationSnapshot {
        try await Task.sleep(nanoseconds: 5_000_000_000)
        throw CancellationError()
    }
}

private actor P9BRecordingPlaceSearcher: LocalPlaceSearching {
    private let candidateCount: Int
    private var calls = 0

    init(candidateCount: Int = 1) {
        self.candidateCount = candidateCount
    }

    func search(input: LocalPlaceSearchInput,
                context: ToolExecutionContext) async throws -> (backend: String, candidates: [PlaceCandidate], fetchedAt: Date) {
        calls += 1
        let count = min(candidateCount, input.resultLimit)
        let candidates = (0..<count).map {
            P9BFixtures.candidate(id: "candidate-\($0)",
                                  name: "Candidate \($0)",
                                  evidenceID: "evidence-\(context.callID)",
                                  toolID: context.toolID)
        }
        return ("fixture-place-searcher", candidates, context.clock.now())
    }

    func callCount() -> Int { calls }
}

private struct P9BMalformedPlaceSearcher: LocalPlaceSearching {
    func search(input: LocalPlaceSearchInput,
                context: ToolExecutionContext) async throws -> (backend: String, candidates: [PlaceCandidate], fetchedAt: Date) {
        let candidate = PlaceCandidate(stableID: "bad-candidate",
                                       sourceEntityIDs: ["fixture:bad"],
                                       name: "Bad Candidate",
                                       categories: [.sichuanRestaurant],
                                       address: PlaceAddress(formatted: "1 Test St"),
                                       coordinate: PlaceCoordinate(latitude: 37, longitude: -122),
                                       evidenceReferences: [],
                                       verificationStatus: .unknown)
        return ("fixture-malformed", [candidate], context.clock.now())
    }
}

private struct P9BRouteEstimator: RouteDistanceEstimating {
    func estimate(input: RouteDistanceEstimateInput,
                  context: ToolExecutionContext) async throws -> RouteDistanceEstimateSnapshot {
        RouteDistanceEstimateSnapshot(transportMode: .automobile,
                                      straightLineDistanceMeters: 1_000,
                                      routeDistanceMeters: 1_450,
                                      estimatedTravelDurationSeconds: 420,
                                      calculationSource: "fixture-route",
                                      calculatedAt: context.clock.now(),
                                      uncertaintyReason: nil)
    }
}

private struct P9BWebpageReader: WebpageReading {
    func read(input: WebpageReadInput, context: ToolExecutionContext) async throws -> WebpageReadSnapshot {
        WebpageReadSnapshot(canonicalURL: "https://example.com/place",
                            pageTitle: "Example Place",
                            extractedText: "Example visible content",
                            structuredMetadata: [
                                .object(["@type": .string("Restaurant"),
                                         "openingHours": .string("Mo-Su 17:00-22:00")]),
                            ],
                            fetchedAt: context.clock.now(),
                            contentHash: "hash-fixture")
    }
}

private enum P9BFixtures {
    static func candidate(id: String,
                          name: String,
                          evidenceID: String,
                          toolID: ToolID) -> PlaceCandidate {
        let evidence = PlaceEvidenceReference(evidenceID: evidenceID,
                                              sourceToolID: toolID,
                                              claim: "fixture candidate for platform behavior test",
                                              observedAt: Date(timeIntervalSince1970: 1_700_000_000),
                                              confidence: 0.9)
        return PlaceCandidate(stableID: id,
                              sourceEntityIDs: ["fixture:\(id)"],
                              name: name,
                              categories: [.sichuanRestaurant],
                              address: PlaceAddress(formatted: "\(id) Market St, San Francisco, CA"),
                              coordinate: PlaceCoordinate(latitude: 37.77, longitude: -122.42),
                              openingStatus: PlaceOpeningStatus(value: .unknown,
                                                                checkedAt: Date(timeIntervalSince1970: 1_700_000_000),
                                                                source: "fixture",
                                                                evidenceReferences: [evidence],
                                                                uncertaintyReason: "fixture does not assert opening status"),
                              priceEstimate: PlacePriceEstimate(source: "fixture",
                                                                observedAt: Date(timeIntervalSince1970: 1_700_000_000),
                                                                evidenceReferences: [evidence],
                                                                uncertaintyReason: "fixture does not assert price"),
                              parkingInfo: PlaceParkingInfo(source: "fixture",
                                                            observedAt: Date(timeIntervalSince1970: 1_700_000_000),
                                                            evidenceReferences: [evidence],
                                                            uncertaintyReason: "fixture does not assert parking"),
                              evidenceReferences: [evidence],
                              freshness: "fixture-platform-test",
                              verificationStatus: .partiallyVerified)
    }
}

private struct P9BToolAllowPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: true,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired)
    }
}

private struct P9BToolDenyPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: false,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired,
                            denialReason: "denied")
    }
}

private extension Result where Success == ToolExecutionResult, Failure == ToolPlatformError {
    var successValue: ToolExecutionResult? {
        if case .success(let value) = self { return value }
        return nil
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

    var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    func stringValue(_ key: String) -> String? {
        objectValue?[key]?.stringScalar
    }

    func doubleValue(_ key: String) -> Double? {
        objectValue?[key]?.doubleValue
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
