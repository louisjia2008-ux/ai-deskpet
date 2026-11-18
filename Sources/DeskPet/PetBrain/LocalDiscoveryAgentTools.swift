import Foundation
import CryptoKit
import PetAgentRuntime
import os.lock
#if canImport(CoreLocation)
import CoreLocation
#endif
#if canImport(MapKit)
import MapKit
#endif

#if canImport(MapKit)
private final class MapKitRequestCancellationBox: Sendable {
    private struct State: @unchecked Sendable {
        var cancelled = false
        // P22 — MapKit's MKLocalSearch/MKDirections aren't `Sendable`, so the
        // cancel handler can't be `@Sendable`. The lock is the only thing
        // ensuring the closure is called exactly once.
        var cancelHandler: (() -> Void)?
    }
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    func setCancelHandler(_ handler: @escaping () -> Void) {
        let fire = state.withLockUnchecked { s -> (() -> Void)? in
            if s.cancelled { return handler }
            s.cancelHandler = handler
            return nil
        }
        fire?()
    }

    func cancel() {
        let handler = state.withLockUnchecked { s -> (() -> Void)? in
            s.cancelled = true
            let h = s.cancelHandler
            s.cancelHandler = nil
            return h
        }
        handler?()
    }
}
#endif

struct ApproximateLocationInput: Decodable, Sendable, Equatable {
    var desiredAccuracyLevel: String
    var purpose: String
    var taskScope: String?
}

struct LocalPlaceSearchInput: Decodable, Sendable, Equatable {
    var queryText: String
    var category: String?
    var center: PlaceCoordinate?
    var regionText: String?
    var radiusMeters: Double?
    var resultLimit: Int
    var locale: String?
}

struct RouteDistanceEstimateInput: Decodable, Sendable, Equatable {
    var origin: PlaceCoordinate
    var destination: PlaceCoordinate
    var transportMode: String
    var departureContext: String?
}

struct WebpageReadInput: Decodable, Sendable, Equatable {
    var url: String
    var extractionPurpose: String?
    var allowedContentTypes: [String]?
    var sizeLimitBytes: Int?
}

struct StructuredPlaceExtractionInput: Decodable, Sendable, Equatable {
    var evidenceID: String
    var canonicalURL: String?
    var pageTitle: String?
    var extractedText: String?
    var structuredMetadata: [AgentJSONValue]?
    var fields: [String]
    var fetchedAt: String?
}

enum ApproximateLocationAuthorizationState: String, Sendable, Codable, Hashable {
    case granted
    case denied
    case restricted
    case notDetermined
    case unavailable
}

struct ApproximateLocationSnapshot: Sendable, Equatable {
    var authorizationState: ApproximateLocationAuthorizationState
    var coordinate: PlaceCoordinate?
    var regionDescription: String?
    var horizontalAccuracyMeters: Double?
    var capturedAt: Date
    var source: String
}

protocol ApproximateLocationProviding: Sendable {
    func approximateLocation(desiredAccuracyLevel: String,
                             purpose: String,
                             taskScope: String?,
                             context: ToolExecutionContext) async throws -> ApproximateLocationSnapshot
}

protocol LocalPlaceSearching: Sendable {
    func search(input: LocalPlaceSearchInput,
                context: ToolExecutionContext) async throws -> (backend: String, candidates: [PlaceCandidate], fetchedAt: Date)
}

struct RouteDistanceEstimateSnapshot: Sendable, Equatable {
    var transportMode: PlaceTransportMode
    var straightLineDistanceMeters: Double
    var routeDistanceMeters: Double?
    var estimatedTravelDurationSeconds: Double?
    var calculationSource: String
    var calculatedAt: Date
    var uncertaintyReason: String?
}

protocol RouteDistanceEstimating: Sendable {
    func estimate(input: RouteDistanceEstimateInput,
                  context: ToolExecutionContext) async throws -> RouteDistanceEstimateSnapshot
}

struct WebpageReadSnapshot: Sendable, Equatable {
    var canonicalURL: String
    var pageTitle: String?
    var extractedText: String
    var structuredMetadata: [AgentJSONValue]
    var fetchedAt: Date
    var contentHash: String
}

protocol WebpageReading: Sendable {
    func read(input: WebpageReadInput, context: ToolExecutionContext) async throws -> WebpageReadSnapshot
}

protocol StructuredPlaceExtracting: Sendable {
    func extract(input: StructuredPlaceExtractionInput,
                 context: ToolExecutionContext) async throws -> (fields: AgentJSONValue, warnings: [String])
}

struct ApproximateLocationAgentTool: AgentTool {
    typealias Input = ApproximateLocationInput

    static let manifest = ToolManifest(
        id: "approximate_location",
        displayName: "大致位置",
        shortDescription: "Read an approximate current location only after the location capability gate allows this task.",
        category: .location,
        riskLevel: .privateDataReadOnly,
        permissionRequirement: .capability("location.approximate.read"),
        inputSchema: LocalDiscoveryToolSchemas.approximateLocationInput,
        outputContract: ToolOutputContract(description: "Approximate location authorization and coarse coordinate",
                                           schema: LocalDiscoveryToolSchemas.approximateLocationOutput),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 10, maxResultBytes: 12_288),
        userVisibleExecutionSummary: "正在获取位置")

    private let provider: any ApproximateLocationProviding

    init(provider: any ApproximateLocationProviding = LiveApproximateLocationProvider()) {
        self.provider = provider
    }

    func execute(input: ApproximateLocationInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try Task.checkCancellation()
        let snapshot = try await provider.approximateLocation(desiredAccuracyLevel: input.desiredAccuracyLevel,
                                                             purpose: input.purpose,
                                                             taskScope: input.taskScope,
                                                             context: context)
        let safeCoordinate = snapshot.coordinate.map {
            LocalDiscoveryToolSupport.redactedCoordinate($0, desiredAccuracyLevel: input.desiredAccuracyLevel)
        }
        let safeAccuracy = max(snapshot.horizontalAccuracyMeters ?? safeCoordinate?.horizontalAccuracyMeters ?? 0,
                              LocalDiscoveryToolSupport.minimumOutputAccuracyMeters(for: input.desiredAccuracyLevel))
        let evidence = LocalDiscoveryToolSupport.evidenceReference(
            context: context,
            claim: snapshot.authorizationState == .granted ? "Approximate location resolved" : "Location authorization \(snapshot.authorizationState.rawValue)",
            observedAt: snapshot.capturedAt,
            confidence: snapshot.authorizationState == .granted ? 0.8 : 1)
        var output: [String: AgentJSONValue] = [
            "status": .string(snapshot.authorizationState == .granted ? "success" : "denied"),
            "authorizationState": .string(snapshot.authorizationState.rawValue),
            "capturedAt": .string(LocalDiscoveryToolSupport.isoString(snapshot.capturedAt)),
            "source": .string(snapshot.source),
            "evidenceReferences": .array([try LocalDiscoveryJSON.jsonValue(from: evidence)]),
        ]
        if let coordinate = safeCoordinate {
            output["coordinate"] = try LocalDiscoveryJSON.jsonValue(from: coordinate)
        }
        if let regionDescription = snapshot.regionDescription {
            output["regionDescription"] = .string(regionDescription)
        }
        if snapshot.authorizationState == .granted {
            let accuracy = max(safeAccuracy, 0)
            output["horizontalAccuracyMeters"] = .number(accuracy)
        }
        return ToolExecutionResult(status: snapshot.authorizationState == .granted ? .success : .denied,
                                   userSafeSummary: snapshot.authorizationState == .granted
                                   ? "已获取任务所需的大致位置"
                                   : "位置权限不可用或被拒绝",
                                   structuredData: .object(output))
    }
}

struct LocalPlaceSearchAgentTool: AgentTool {
    typealias Input = LocalPlaceSearchInput

    static let manifest = ToolManifest(
        id: "local_place_search",
        displayName: "本地地点搜索",
        shortDescription: "Search for local places through a read-only structured place backend.",
        category: .places,
        riskLevel: .externalReadOnly,
        permissionRequirement: .capability("places.search.read"),
        inputSchema: LocalDiscoveryToolSchemas.placeSearchInput,
        outputContract: ToolOutputContract(description: "Structured local place candidates",
                                           maxItems: 20,
                                           schema: LocalDiscoveryToolSchemas.placeSearchOutput),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 12, maxResultBytes: 262_144),
        userVisibleExecutionSummary: "正在搜索地点")

    private let searcher: any LocalPlaceSearching

    init(searcher: any LocalPlaceSearching = MapKitLocalPlaceSearcher()) {
        self.searcher = searcher
    }

    func execute(input: LocalPlaceSearchInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try Task.checkCancellation()
        let limited = LocalPlaceSearchInput(queryText: input.queryText,
                                            category: input.category,
                                            center: input.center,
                                            regionText: input.regionText,
                                            radiusMeters: input.radiusMeters,
                                            resultLimit: min(max(input.resultLimit, 1), 20),
                                            locale: input.locale)
        let locationType = input.center == nil ? (input.regionText == nil ? "unspecified" : "explicitRegion") : "coordinate"
        let page: (backend: String, candidates: [PlaceCandidate], fetchedAt: Date)
        do {
            page = try await searcher.search(input: limited, context: context)
        } catch {
            let failedAt = context.clock.now()
            let evidence = LocalDiscoveryToolSupport.evidenceReference(
                context: context,
                claim: "Local place search backend failed",
                observedAt: failedAt,
                confidence: 1)
            return ToolExecutionResult(
                status: .failed,
                userSafeSummary: "地点搜索后端不可用，未返回候选",
                structuredData: .object([
                    "status": .string("failed"),
                    "backend": .string("MapKit.MKLocalSearch"),
                    "query": .string(input.queryText),
                    "inputLocationType": .string(locationType),
                    "resultCount": .number(0),
                    "candidates": .array([]),
                    "evidenceReferences": .array([try LocalDiscoveryJSON.jsonValue(from: evidence)]),
                    "fetchedAt": .string(LocalDiscoveryToolSupport.isoString(failedAt)),
                    "usedFixture": .bool(false),
                    "errorReason": .string(LocalDiscoveryToolSupport.backendErrorReason(error)),
                ]),
                metadata: ToolExecutionMetadata(itemCount: 0))
        }
        let candidates = page.candidates
        let searchEvidence = LocalDiscoveryToolSupport.evidenceReference(context: context,
                                                                         claim: "Local place search executed",
                                                                         observedAt: page.fetchedAt,
                                                                         confidence: 0.75)
        let evidenceReferences = LocalDiscoveryToolSupport.uniqueEvidenceReferences(from: candidates,
                                                                                   including: [searchEvidence])
        let candidateValues = try candidates.map { try LocalDiscoveryJSON.jsonValue(from: $0) }
        let evidenceValues = try evidenceReferences.map { try LocalDiscoveryJSON.jsonValue(from: $0) }
        return ToolExecutionResult(
            status: .success,
            userSafeSummary: "找到 \(candidates.count) 个候选地点",
            structuredData: .object([
                "status": .string("success"),
                "backend": .string(page.backend),
                "query": .string(input.queryText),
                "inputLocationType": .string(locationType),
                "resultCount": .number(Double(candidates.count)),
                "candidates": .array(candidateValues),
                "evidenceReferences": .array(evidenceValues),
                "fetchedAt": .string(LocalDiscoveryToolSupport.isoString(page.fetchedAt)),
                "usedFixture": .bool(false),
            ]),
            metadata: ToolExecutionMetadata(itemCount: candidates.count))
    }
}

struct RouteDistanceEstimateAgentTool: AgentTool {
    typealias Input = RouteDistanceEstimateInput

    static let manifest = ToolManifest(
        id: "route_distance_estimate",
        displayName: "路线距离估算",
        shortDescription: "Estimate straight-line distance and, when available, route distance without dispatching navigation.",
        category: .places,
        riskLevel: .externalReadOnly,
        permissionRequirement: .capability("routes.estimate.read"),
        inputSchema: LocalDiscoveryToolSchemas.routeDistanceInput,
        outputContract: ToolOutputContract(description: "Straight-line and route distance estimates",
                                           schema: LocalDiscoveryToolSchemas.routeDistanceOutput),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 12, maxResultBytes: 16_384),
        userVisibleExecutionSummary: "正在估算距离")

    private let estimator: any RouteDistanceEstimating

    init(estimator: any RouteDistanceEstimating = MapKitRouteDistanceEstimator()) {
        self.estimator = estimator
    }

    func execute(input: RouteDistanceEstimateInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try Task.checkCancellation()
        let snapshot = try await estimator.estimate(input: input, context: context)
        let evidence = LocalDiscoveryToolSupport.evidenceReference(context: context,
                                                                   claim: "Distance estimate calculated",
                                                                   observedAt: snapshot.calculatedAt,
                                                                   confidence: snapshot.routeDistanceMeters == nil ? 0.45 : 0.85)
        var output: [String: AgentJSONValue] = [
            "status": .string(snapshot.routeDistanceMeters == nil ? "partial" : "success"),
            "transportMode": .string(snapshot.transportMode.rawValue),
            "straightLineDistanceMeters": .number(snapshot.straightLineDistanceMeters),
            "calculationSource": .string(snapshot.calculationSource),
            "calculatedAt": .string(LocalDiscoveryToolSupport.isoString(snapshot.calculatedAt)),
            "evidenceReferences": .array([try LocalDiscoveryJSON.jsonValue(from: evidence)]),
            "usedFixture": .bool(false),
        ]
        if let route = snapshot.routeDistanceMeters {
            output["routeDistanceMeters"] = .number(route)
        }
        if let duration = snapshot.estimatedTravelDurationSeconds {
            output["estimatedTravelDurationSeconds"] = .number(duration)
        }
        if let reason = snapshot.uncertaintyReason {
            output["uncertaintyReason"] = .string(reason)
        }
        return ToolExecutionResult(status: snapshot.routeDistanceMeters == nil ? .partial : .success,
                                   userSafeSummary: snapshot.routeDistanceMeters == nil
                                   ? "已计算直线距离，路线距离无法确认"
                                   : "已估算路线距离",
                                   structuredData: .object(output))
    }
}

struct WebpageReadAgentTool: AgentTool {
    typealias Input = WebpageReadInput

    static let manifest = ToolManifest(
        id: "webpage_read",
        displayName: "网页读取",
        shortDescription: "Fetch and extract a bounded untrusted web page for local discovery verification.",
        category: .browser,
        riskLevel: .externalReadOnly,
        permissionRequirement: .capability("web.page.read"),
        inputSchema: LocalDiscoveryToolSchemas.webpageReadInput,
        outputContract: ToolOutputContract(description: "Bounded untrusted webpage text and structured metadata",
                                           schema: LocalDiscoveryToolSchemas.webpageReadOutput),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 15, maxResultBytes: 65_536),
        userVisibleExecutionSummary: "正在读取网页")

    private let reader: any WebpageReading

    init(reader: any WebpageReading = URLSessionWebpageReader()) {
        self.reader = reader
    }

    func execute(input: WebpageReadInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try Task.checkCancellation()
        let snapshot = try await reader.read(input: input, context: context)
        let evidence = LocalDiscoveryToolSupport.evidenceReference(context: context,
                                                                   sourceURL: snapshot.canonicalURL,
                                                                   claim: "Web page fetched as untrusted content",
                                                                   observedAt: snapshot.fetchedAt,
                                                                   confidence: 0.85)
        var output: [String: AgentJSONValue] = [
            "status": .string("success"),
            "canonicalURL": .string(snapshot.canonicalURL),
            "extractedText": .string(snapshot.extractedText),
            "structuredMetadata": .array(snapshot.structuredMetadata),
            "fetchedAt": .string(LocalDiscoveryToolSupport.isoString(snapshot.fetchedAt)),
            "contentHash": .string(snapshot.contentHash),
            "contentIsUntrusted": .bool(true),
            "evidenceReferences": .array([try LocalDiscoveryJSON.jsonValue(from: evidence)]),
        ]
        if let title = snapshot.pageTitle {
            output["pageTitle"] = .string(title)
        }
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "已读取网页并标记为不可信内容",
                                   structuredData: .object(output))
    }
}

struct StructuredPlaceExtractionAgentTool: AgentTool {
    typealias Input = StructuredPlaceExtractionInput

    static let manifest = ToolManifest(
        id: "structured_place_extraction",
        displayName: "地点网页结构化提取",
        shortDescription: "Extract place details from an existing webpage evidence reference without guessing missing fields.",
        category: .places,
        riskLevel: .externalReadOnly,
        permissionRequirement: .capability("web.structured_data.read"),
        inputSchema: LocalDiscoveryToolSchemas.structuredExtractionInput,
        outputContract: ToolOutputContract(description: "Deterministic place detail extraction with field-level evidence",
                                           schema: LocalDiscoveryToolSchemas.structuredExtractionOutput),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 4, maxResultBytes: 32_768),
        userVisibleExecutionSummary: "正在提取网页中的地点信息")

    private let extractor: any StructuredPlaceExtracting

    init(extractor: any StructuredPlaceExtracting = DeterministicStructuredPlaceExtractor()) {
        self.extractor = extractor
    }

    func execute(input: StructuredPlaceExtractionInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try Task.checkCancellation()
        let result = try await extractor.extract(input: input, context: context)
        let evidence = LocalDiscoveryToolSupport.evidenceReference(context: context,
                                                                   sourceURL: input.canonicalURL,
                                                                   claim: "Structured fields extracted from webpage evidence \(input.evidenceID)",
                                                                   observedAt: context.clock.now(),
                                                                   confidence: 0.7)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "已完成结构化地点信息提取",
                                   structuredData: .object([
                                       "status": .string("success"),
                                       "sourceEvidenceID": .string(input.evidenceID),
                                       "extractedFields": result.fields,
                                       "warnings": .array(result.warnings.map(AgentJSONValue.string)),
                                       "evidenceReferences": .array([try LocalDiscoveryJSON.jsonValue(from: evidence)]),
                                       "usedFixture": .bool(false),
                                   ]))
    }
}

struct LiveApproximateLocationProvider: ApproximateLocationProviding {
    func approximateLocation(desiredAccuracyLevel: String,
                             purpose: String,
                             taskScope: String?,
                             context: ToolExecutionContext) async throws -> ApproximateLocationSnapshot {
        #if canImport(CoreLocation)
        return try await CoreLocationApproximateLocationReader().read(desiredAccuracyLevel: desiredAccuracyLevel,
                                                                      context: context)
        #else
        return ApproximateLocationSnapshot(authorizationState: .unavailable,
                                           coordinate: nil,
                                           regionDescription: nil,
                                           horizontalAccuracyMeters: nil,
                                           capturedAt: context.clock.now(),
                                           source: "corelocation-unavailable")
        #endif
    }
}

#if canImport(CoreLocation)
@MainActor
private final class CoreLocationApproximateLocationReader: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<ApproximateLocationSnapshot, Error>?
    private var context: ToolExecutionContext?

    func read(desiredAccuracyLevel: String, context: ToolExecutionContext) async throws -> ApproximateLocationSnapshot {
        self.context = context
        manager.delegate = self
        manager.desiredAccuracy = Self.accuracy(for: desiredAccuracyLevel)
        let status = manager.authorizationStatus
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            break
        case .denied:
            return snapshot(.denied, location: nil)
        case .restricted:
            return snapshot(.restricted, location: nil)
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        @unknown default:
            return snapshot(.unavailable, location: nil)
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                manager.requestLocation()
            }
        } onCancel: {
            Task { @MainActor in
                self.manager.stopUpdatingLocation()
                self.continuation?.resume(throwing: CancellationError())
                self.continuation = nil
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            continuation?.resume(returning: snapshot(.granted, location: locations.last))
            continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            continuation?.resume(returning: snapshot(.unavailable, location: nil))
            continuation = nil
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            switch status {
            case .denied:
                continuation?.resume(returning: snapshot(.denied, location: nil))
                continuation = nil
            case .restricted:
                continuation?.resume(returning: snapshot(.restricted, location: nil))
                continuation = nil
            default:
                break
            }
        }
    }

    private func snapshot(_ state: ApproximateLocationAuthorizationState,
                          location: CLLocation?) -> ApproximateLocationSnapshot {
        let coordinate = location.map {
            PlaceCoordinate(latitude: $0.coordinate.latitude,
                            longitude: $0.coordinate.longitude,
                            horizontalAccuracyMeters: max($0.horizontalAccuracy, 0))
        }
        return ApproximateLocationSnapshot(authorizationState: state,
                                           coordinate: coordinate,
                                           regionDescription: nil,
                                           horizontalAccuracyMeters: location.map { max($0.horizontalAccuracy, 0) },
                                           capturedAt: context?.clock.now() ?? Date(),
                                           source: "CoreLocation")
    }

    private static func accuracy(for level: String) -> CLLocationAccuracy {
        switch level.lowercased() {
        case "city", "coarse", "approximate":
            return kCLLocationAccuracyThreeKilometers
        case "neighborhood":
            return kCLLocationAccuracyKilometer
        default:
            return kCLLocationAccuracyReduced
        }
    }
}
#endif

struct MapKitLocalPlaceSearcher: LocalPlaceSearching {
    func search(input: LocalPlaceSearchInput,
                context: ToolExecutionContext) async throws -> (backend: String, candidates: [PlaceCandidate], fetchedAt: Date) {
        #if canImport(MapKit)
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = Self.query(input)
        if let center = input.center {
            let radius = min(max(input.radiusMeters ?? 8_000, 100), 100_000)
            request.region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: center.latitude,
                                                                               longitude: center.longitude),
                                                latitudinalMeters: radius,
                                                longitudinalMeters: radius)
        }
        if let filter = Self.pointOfInterestFilter(for: input.category) {
            request.pointOfInterestFilter = filter
        }
        let search = MKLocalSearch(request: request)
        let cancellation = MapKitRequestCancellationBox()
        cancellation.setCancelHandler { search.cancel() }
        let response = try await withTaskCancellationHandler {
            try await search.start()
        } onCancel: {
            cancellation.cancel()
        }
        try Task.checkCancellation()
        let fetchedAt = context.clock.now()
        let limitedItems = Array(response.mapItems.prefix(min(max(input.resultLimit, 1), 20)))
        let candidates = limitedItems.map { mapItem in
            Self.candidate(from: mapItem,
                           category: input.category,
                           fetchedAt: fetchedAt,
                           context: context)
        }
        return ("MapKit.MKLocalSearch", candidates, fetchedAt)
        #else
        throw LocalDiscoveryToolError.backendUnavailable("MapKit unavailable")
        #endif
    }

    private static func query(_ input: LocalPlaceSearchInput) -> String {
        let query = input.queryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard input.center == nil,
              let region = input.regionText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !region.isEmpty else {
            return query
        }
        return "\(query) near \(region)"
    }

    #if canImport(MapKit)
    private static func pointOfInterestFilter(for category: String?) -> MKPointOfInterestFilter? {
        guard let category = category?.lowercased() else { return nil }
        if category.contains("restaurant") || category.contains("sichuan") || category.contains("chinese") {
            return MKPointOfInterestFilter(including: [.restaurant])
        }
        if category.contains("golf") {
            return nil
        }
        if category.contains("store") || category.contains("electronics") || category.contains("charger") {
            return MKPointOfInterestFilter(including: [.store])
        }
        return nil
    }

    private static func candidate(from mapItem: MKMapItem,
                                  category: String?,
                                  fetchedAt: Date,
                                  context: ToolExecutionContext) -> PlaceCandidate {
        let name = mapItem.name ?? "Unnamed place"
        let address = address(from: mapItem.placemark)
        let coordinate = PlaceCoordinate(latitude: mapItem.placemark.coordinate.latitude,
                                         longitude: mapItem.placemark.coordinate.longitude)
        let stableID = LocalDiscoveryToolSupport.stableHash([
            "mapkit",
            name,
            address?.formatted ?? "",
            String(format: "%.5f", coordinate.latitude),
            String(format: "%.5f", coordinate.longitude),
        ])
        let evidence = LocalDiscoveryToolSupport.evidenceReference(context: context,
                                                                   claim: "Place candidate returned by MapKit local search",
                                                                   observedAt: fetchedAt,
                                                                   confidence: 0.8)
        var links: [PlaceWebLink] = []
        if let url = mapItem.url?.absoluteString {
            links.append(PlaceWebLink(id: "\(stableID)-website",
                                      kind: .officialWebsite,
                                      title: "Website",
                                      url: url,
                                      evidenceReferences: [evidence]))
        }
        let placeCategory = PlaceCategory(rawValue: category ?? "place")
        return PlaceCandidate(stableID: stableID,
                              sourceEntityIDs: ["mapkit:\(stableID)"],
                              name: name,
                              categories: [placeCategory],
                              address: address,
                              coordinate: coordinate,
                              openingStatus: PlaceOpeningStatus(value: .unknown,
                                                                checkedAt: fetchedAt,
                                                                confidence: 0,
                                                                source: "MapKit.MKLocalSearch",
                                                                evidenceReferences: [evidence],
                                                                uncertaintyReason: "opening hours not provided by search result"),
                              priceEstimate: PlacePriceEstimate(source: "MapKit.MKLocalSearch",
                                                                observedAt: fetchedAt,
                                                                evidenceReferences: [evidence],
                                                                uncertaintyReason: "price not provided by search result"),
                              parkingInfo: PlaceParkingInfo(source: "MapKit.MKLocalSearch",
                                                            observedAt: fetchedAt,
                                                            evidenceReferences: [evidence],
                                                            uncertaintyReason: "parking not provided by search result"),
                              contact: PlaceContact(phoneNumber: mapItem.phoneNumber,
                                                    displayPhone: mapItem.phoneNumber),
                              webLinks: links,
                              evidenceReferences: [evidence],
                              freshness: "live:\(LocalDiscoveryToolSupport.isoString(fetchedAt))",
                              verificationStatus: .partiallyVerified,
                              actionDescriptors: LocalDiscoveryToolSupport.actionDescriptors(candidateID: stableID,
                                                                                            phone: mapItem.phoneNumber,
                                                                                            website: mapItem.url?.absoluteString,
                                                                                            coordinate: coordinate))
    }

    private static func address(from placemark: MKPlacemark) -> PlaceAddress? {
        let street = [placemark.subThoroughfare, placemark.thoroughfare]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let formattedParts = [
            street,
            placemark.locality,
            placemark.administrativeArea,
            placemark.postalCode,
            placemark.countryCode,
        ].compactMap { $0 }.filter { !$0.isEmpty }
        let formatted = placemark.title ?? formattedParts.joined(separator: ", ")
        guard !formatted.isEmpty else { return nil }
        return PlaceAddress(street: street.isEmpty ? nil : street,
                            locality: placemark.locality,
                            region: placemark.administrativeArea,
                            postalCode: placemark.postalCode,
                            countryCode: placemark.countryCode,
                            formatted: formatted)
    }
    #endif
}

struct MapKitRouteDistanceEstimator: RouteDistanceEstimating {
    func estimate(input: RouteDistanceEstimateInput,
                  context: ToolExecutionContext) async throws -> RouteDistanceEstimateSnapshot {
        let mode = PlaceTransportMode(rawValue: input.transportMode) ?? .unknown
        let straightLine = LocalDiscoveryToolSupport.haversineMeters(from: input.origin, to: input.destination)
        #if canImport(MapKit)
        guard mode == .automobile || mode == .walking || mode == .transit else {
            return RouteDistanceEstimateSnapshot(transportMode: mode,
                                                 straightLineDistanceMeters: straightLine,
                                                 routeDistanceMeters: nil,
                                                 estimatedTravelDurationSeconds: nil,
                                                 calculationSource: "haversine",
                                                 calculatedAt: context.clock.now(),
                                                 uncertaintyReason: "route backend unsupported for transport mode \(mode.rawValue)")
        }
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: input.origin.latitude,
                                                                                             longitude: input.origin.longitude)))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: input.destination.latitude,
                                                                                                  longitude: input.destination.longitude)))
        request.transportType = Self.transportType(for: mode)
        do {
            let directions = MKDirections(request: request)
            let cancellation = MapKitRequestCancellationBox()
            cancellation.setCancelHandler { directions.cancel() }
            let response = try await withTaskCancellationHandler {
                try await directions.calculate()
            } onCancel: {
                cancellation.cancel()
            }
            try Task.checkCancellation()
            guard let route = response.routes.first else {
                return fallback(mode: mode, straightLine: straightLine, context: context, reason: "route backend returned no route")
            }
            return RouteDistanceEstimateSnapshot(transportMode: mode,
                                                 straightLineDistanceMeters: straightLine,
                                                 routeDistanceMeters: route.distance,
                                                 estimatedTravelDurationSeconds: route.expectedTravelTime,
                                                 calculationSource: "MapKit.MKDirections",
                                                 calculatedAt: context.clock.now(),
                                                 uncertaintyReason: nil)
        } catch {
            return fallback(mode: mode, straightLine: straightLine, context: context, reason: "route backend unavailable; straight-line distance only")
        }
        #else
        return fallback(mode: mode, straightLine: straightLine, context: context, reason: "MapKit unavailable; straight-line distance only")
        #endif
    }

    private func fallback(mode: PlaceTransportMode,
                          straightLine: Double,
                          context: ToolExecutionContext,
                          reason: String) -> RouteDistanceEstimateSnapshot {
        RouteDistanceEstimateSnapshot(transportMode: mode,
                                      straightLineDistanceMeters: straightLine,
                                      routeDistanceMeters: nil,
                                      estimatedTravelDurationSeconds: nil,
                                      calculationSource: "haversine",
                                      calculatedAt: context.clock.now(),
                                      uncertaintyReason: reason)
    }

    #if canImport(MapKit)
    private static func transportType(for mode: PlaceTransportMode) -> MKDirectionsTransportType {
        switch mode {
        case .walking:
            return .walking
        case .transit:
            return .transit
        default:
            return .automobile
        }
    }
    #endif
}

struct URLSessionWebpageReader: WebpageReading {
    func read(input: WebpageReadInput, context: ToolExecutionContext) async throws -> WebpageReadSnapshot {
        guard let url = URL(string: input.url),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            throw LocalDiscoveryToolError.invalidURL
        }
        let limit = min(max(input.sizeLimitBytes ?? 64_000, 512), 262_144)
        let allowed = Set((input.allowedContentTypes ?? [
            "text/html",
            "application/xhtml+xml",
            "application/json",
            "application/ld+json",
            "text/plain",
        ]).map { $0.lowercased() })

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 15
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        var request = URLRequest(url: url)
        request.setValue("DeskPet LocalDiscovery/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue(allowed.joined(separator: ", "), forHTTPHeaderField: "Accept")

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<400).contains(http.statusCode) else {
            throw LocalDiscoveryToolError.httpError
        }
        let mime = (http.mimeType ?? "application/octet-stream").lowercased()
        guard allowed.contains(mime) || allowed.contains(where: { mime.hasPrefix($0) }) else {
            throw LocalDiscoveryToolError.unsupportedContentType(mime)
        }
        if http.expectedContentLength > Int64(limit), http.expectedContentLength > 0 {
            throw LocalDiscoveryToolError.responseTooLarge
        }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            data.append(byte)
            if data.count > limit {
                throw LocalDiscoveryToolError.responseTooLarge
            }
        }
        let raw = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
        let metadata = LocalDiscoveryToolSupport.structuredMetadata(from: raw)
        return WebpageReadSnapshot(canonicalURL: response.url?.absoluteString ?? url.absoluteString,
                                   pageTitle: LocalDiscoveryToolSupport.htmlTitle(from: raw),
                                   extractedText: LocalDiscoveryToolSupport.visibleText(from: raw),
                                   structuredMetadata: metadata,
                                   fetchedAt: context.clock.now(),
                                   contentHash: LocalDiscoveryToolSupport.sha256(data))
    }
}

struct DeterministicStructuredPlaceExtractor: StructuredPlaceExtracting {
    func extract(input: StructuredPlaceExtractionInput,
                 context: ToolExecutionContext) async throws -> (fields: AgentJSONValue, warnings: [String]) {
        var fields: [String: AgentJSONValue] = [:]
        var warnings: [String] = []
        let requested = Set(input.fields.map { $0.lowercased() })
        let metadataObjects = input.structuredMetadata ?? []
        let text = input.extractedText ?? ""
        let evidence = try LocalDiscoveryJSON.jsonValue(from: PlaceEvidenceReference(
            evidenceID: input.evidenceID,
            sourceToolID: "webpage_read",
            sourceURL: input.canonicalURL,
            claim: "Field extracted from webpage evidence",
            observedAt: LocalDiscoveryToolSupport.date(from: input.fetchedAt) ?? context.clock.now(),
            confidence: 0.7))

        if requested.contains("openingHours".lowercased()) || requested.contains("opening_hours") {
            let values = Self.openingHours(from: metadataObjects)
            if values.isEmpty {
                fields["openingHours"] = unknownField("opening hours not found", evidence: evidence)
                warnings.append("opening_hours_unknown")
            } else {
                fields["openingHours"] = .object([
                    "status": .string("partiallyVerified"),
                    "value": .array(values.map(AgentJSONValue.string)),
                    "confidence": .number(0.8),
                    "source": .string("structuredMetadata"),
                    "evidenceReferences": .array([evidence]),
                ])
            }
        }
        if requested.contains("phone") {
            if let phone = Self.firstString(keys: ["telephone", "phone"], in: metadataObjects) {
                fields["phone"] = valueField(phone, confidence: 0.85, source: "structuredMetadata", evidence: evidence)
            } else {
                fields["phone"] = unknownField("phone not found", evidence: evidence)
                warnings.append("phone_unknown")
            }
        }
        if requested.contains("website") || requested.contains("menu") {
            if let website = Self.firstString(keys: ["url", "sameAs"], in: metadataObjects) ?? input.canonicalURL {
                fields["website"] = valueField(website, confidence: input.canonicalURL == website ? 0.6 : 0.8,
                                               source: input.canonicalURL == website ? "canonicalURL" : "structuredMetadata",
                                               evidence: evidence)
            }
            if requested.contains("menu") {
                if let menu = Self.firstString(keys: ["menu", "hasMenu"], in: metadataObjects) {
                    fields["menu"] = valueField(menu, confidence: 0.75, source: "structuredMetadata", evidence: evidence)
                } else {
                    fields["menu"] = unknownField("menu not found", evidence: evidence)
                    warnings.append("menu_unknown")
                }
            }
        }
        if requested.contains("price") || requested.contains("pricehints") || requested.contains("price_hints") {
            if let price = Self.firstString(keys: ["priceRange"], in: metadataObjects) {
                fields["priceHints"] = valueField(price, confidence: 0.65, source: "structuredMetadata", evidence: evidence)
            } else {
                fields["priceHints"] = unknownField("price not found", evidence: evidence)
                warnings.append("price_unknown")
            }
        }
        if requested.contains("parking") || requested.contains("parkinghints") || requested.contains("parking_hints") {
            let hints = Self.parkingHints(in: text)
            if hints.isEmpty {
                fields["parkingHints"] = unknownField("parking not found", evidence: evidence)
                warnings.append("parking_unknown")
            } else {
                fields["parkingHints"] = .object([
                    "status": .string("partiallyVerified"),
                    "value": .array(hints.map(AgentJSONValue.string)),
                    "confidence": .number(0.45),
                    "source": .string("pageText"),
                    "uncertaintyReason": .string("parking text is a hint, not live availability"),
                    "evidenceReferences": .array([evidence]),
                ])
            }
        }
        return (.object(fields), warnings)
    }

    private func unknownField(_ reason: String, evidence: AgentJSONValue) -> AgentJSONValue {
        .object([
            "status": .string("unknown"),
            "confidence": .number(0),
            "uncertaintyReason": .string(reason),
            "evidenceReferences": .array([evidence]),
        ])
    }

    private func valueField(_ value: String,
                            confidence: Double,
                            source: String,
                            evidence: AgentJSONValue) -> AgentJSONValue {
        .object([
            "status": .string("partiallyVerified"),
            "value": .string(value),
            "confidence": .number(confidence),
            "source": .string(source),
            "evidenceReferences": .array([evidence]),
        ])
    }

    private static func openingHours(from metadata: [AgentJSONValue]) -> [String] {
        values(for: ["openingHours", "openingHoursSpecification"], in: metadata)
    }

    private static func firstString(keys: [String], in metadata: [AgentJSONValue]) -> String? {
        values(for: keys, in: metadata).first
    }

    private static func values(for keys: [String], in metadata: [AgentJSONValue]) -> [String] {
        var out: [String] = []
        for value in metadata {
            collect(keys: Set(keys), from: value, into: &out)
        }
        return Array(Set(out)).sorted()
    }

    private static func collect(keys: Set<String>, from value: AgentJSONValue, into out: inout [String]) {
        switch value {
        case .object(let object):
            for (key, child) in object {
                if keys.contains(key) {
                    switch child {
                    case .string(let string):
                        out.append(string)
                    case .array(let values):
                        out.append(contentsOf: values.compactMap { if case .string(let string) = $0 { return string } else { return nil } })
                    case .object:
                        out.append(child.jsonString)
                    default:
                        break
                    }
                }
                collect(keys: keys, from: child, into: &out)
            }
        case .array(let values):
            values.forEach { collect(keys: keys, from: $0, into: &out) }
        default:
            break
        }
    }

    private static func parkingHints(in text: String) -> [String] {
        let lower = text.lowercased()
        let patterns = ["free parking", "validated parking", "parking garage", "street parking", "parking lot", "停车"]
        return patterns.filter { lower.contains($0) }
    }
}

enum LocalDiscoveryToolError: Error, Equatable {
    case backendUnavailable(String)
    case invalidURL
    case httpError
    case unsupportedContentType(String)
    case responseTooLarge
}

enum LocalDiscoveryToolSupport {
    static func evidenceReference(context: ToolExecutionContext,
                                  sourceURL: String? = nil,
                                  claim: String,
                                  observedAt: Date,
                                  confidence: Double) -> PlaceEvidenceReference {
        PlaceEvidenceReference(evidenceID: "evidence-\(context.callID)",
                               sourceToolID: context.toolID,
                               sourceURL: sourceURL,
                               claim: claim,
                               observedAt: observedAt,
                               freshness: "current-task",
                               confidence: confidence)
    }

    static func uniqueEvidenceReferences(from candidates: [PlaceCandidate],
                                         including additionalReferences: [PlaceEvidenceReference] = []) -> [PlaceEvidenceReference] {
        var seen: Set<String> = []
        var refs: [PlaceEvidenceReference] = []
        for ref in candidates.flatMap(\.evidenceReferences) + additionalReferences where !seen.contains(ref.evidenceID) {
            seen.insert(ref.evidenceID)
            refs.append(ref)
        }
        return refs.sorted { $0.evidenceID < $1.evidenceID }
    }

    static func actionDescriptors(candidateID: String,
                                  phone: String?,
                                  website: String?,
                                  coordinate: PlaceCoordinate?) -> [PlaceActionDescriptor] {
        var actions: [PlaceActionDescriptor] = [
            PlaceActionDescriptor(actionID: "\(candidateID)-details",
                                  type: .showDetails,
                                  label: "查看详情",
                                  requiredCapability: nil,
                                  targetReference: candidateID,
                                  permissionRequirement: .none),
        ]
        if let coordinate {
            actions.append(PlaceActionDescriptor(actionID: "\(candidateID)-maps",
                                                 type: .openMaps,
                                                 label: "打开地图",
                                                 requiredCapability: "application.launch",
                                                 targetReference: "\(coordinate.latitude),\(coordinate.longitude)"))
        }
        if let phone {
            actions.append(PlaceActionDescriptor(actionID: "\(candidateID)-call",
                                                 type: .callPhone,
                                                 label: "拨打电话",
                                                 requiredCapability: "application.launch",
                                                 targetReference: phone))
        }
        if let website {
            actions.append(PlaceActionDescriptor(actionID: "\(candidateID)-website",
                                                 type: .openWebsite,
                                                 label: "打开官网",
                                                 requiredCapability: "browser.control",
                                                 targetReference: website))
        }
        return actions
    }

    static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func date(from value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func stableHash(_ parts: [String]) -> String {
        "place-" + sha256(Data(parts.joined(separator: "|").utf8)).prefix(24)
    }

    static func sha256(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func haversineMeters(from origin: PlaceCoordinate, to destination: PlaceCoordinate) -> Double {
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

    static func backendErrorReason(_ error: Error) -> String {
        if let local = error as? LocalDiscoveryToolError {
            switch local {
            case .backendUnavailable(let reason):
                return "backendUnavailable:\(AgentPrivacyRedactor.safeSummary(reason, fallback: "unavailable"))"
            case .invalidURL:
                return "invalidURL"
            case .httpError:
                return "httpError"
            case .unsupportedContentType(let type):
                return "unsupportedContentType:\(AgentPrivacyRedactor.safeSummary(type, fallback: "unsupported"))"
            case .responseTooLarge:
                return "responseTooLarge"
            }
        }
        let nsError = error as NSError
        return "backendError:\(AgentEventRedactor.safeIdentifier(nsError.domain)):\(nsError.code)"
    }

    static func redactedCoordinate(_ coordinate: PlaceCoordinate,
                                   desiredAccuracyLevel: String) -> PlaceCoordinate {
        let decimals = outputCoordinateDecimals(for: desiredAccuracyLevel)
        let factor = pow(10.0, Double(decimals))
        let accuracy = max(coordinate.horizontalAccuracyMeters ?? 0,
                           minimumOutputAccuracyMeters(for: desiredAccuracyLevel))
        return PlaceCoordinate(latitude: (coordinate.latitude * factor).rounded() / factor,
                               longitude: (coordinate.longitude * factor).rounded() / factor,
                               horizontalAccuracyMeters: accuracy)
    }

    static func minimumOutputAccuracyMeters(for desiredAccuracyLevel: String) -> Double {
        switch desiredAccuracyLevel.lowercased() {
        case "city", "coarse":
            return 3_000
        case "neighborhood", "approximate":
            return 1_000
        default:
            return 500
        }
    }

    private static func outputCoordinateDecimals(for desiredAccuracyLevel: String) -> Int {
        switch desiredAccuracyLevel.lowercased() {
        case "city", "coarse":
            return 2
        case "neighborhood", "approximate":
            return 3
        default:
            return 3
        }
    }

    static func htmlTitle(from html: String) -> String? {
        firstMatch(#"(?is)<title[^>]*>(.*?)</title>"#, in: html)
            .map { decodeBasicHTMLEntities(stripTags($0)).trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }

    static func visibleText(from html: String) -> String {
        var text = html
        text = text.replacingOccurrences(of: #"(?is)<script[^>]*>.*?</script>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?is)<style[^>]*>.*?</style>"#, with: " ", options: .regularExpression)
        text = stripTags(text)
        text = decodeBasicHTMLEntities(text)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(20_000))
    }

    static func structuredMetadata(from html: String) -> [AgentJSONValue] {
        let pattern = #"(?is)<script[^>]+type=["']application/ld\+json["'][^>]*>(.*?)</script>"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(html.startIndex..<html.endIndex, in: html)
        var values: [AgentJSONValue] = []
        for match in regex.matches(in: html, range: range).prefix(24) {
            guard let scriptRange = Range(match.range(at: 1), in: html) else { continue }
            let raw = decodeBasicHTMLEntities(String(html[scriptRange]))
            guard let data = raw.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data),
                  let value = try? AgentJSONValue.fromJSONObject(json) else {
                continue
            }
            values.append(value)
        }
        return values
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              let resultRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[resultRange])
    }

    private static func stripTags(_ value: String) -> String {
        value.replacingOccurrences(of: #"(?is)<[^>]+>"#, with: " ", options: .regularExpression)
    }

    private static func decodeBasicHTMLEntities(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&nbsp;", with: " ")
    }
}
