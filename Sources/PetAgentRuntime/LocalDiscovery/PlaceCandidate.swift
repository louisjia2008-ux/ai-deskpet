import Foundation

public enum PlaceDistanceKind: String, Codable, Sendable, Hashable, CaseIterable {
    case straightLine
    case route
}

public struct PlaceCoordinate: Codable, Sendable, Hashable {
    public var latitude: Double
    public var longitude: Double
    public var horizontalAccuracyMeters: Double?

    public init(latitude: Double,
                longitude: Double,
                horizontalAccuracyMeters: Double? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.horizontalAccuracyMeters = horizontalAccuracyMeters.map { max(0, $0) }
    }
}

public struct PlaceDistance: Codable, Sendable, Hashable {
    public var meters: Double
    public var kind: PlaceDistanceKind
    public var source: String
    public var calculatedAt: Date?
    public var uncertaintyReason: String?

    public init(meters: Double,
                kind: PlaceDistanceKind,
                source: String,
                calculatedAt: Date? = nil,
                uncertaintyReason: String? = nil) {
        self.meters = max(0, meters)
        self.kind = kind
        self.source = AgentPrivacyRedactor.safeSummary(source, fallback: "calculated")
        self.calculatedAt = calculatedAt
        self.uncertaintyReason = uncertaintyReason.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public enum PlaceTransportMode: String, Codable, Sendable, Hashable, CaseIterable {
    case walking
    case automobile
    case transit
    case cycling
    case unknown
}

public struct PlaceTravelEstimate: Codable, Sendable, Hashable {
    public var transportMode: PlaceTransportMode
    public var straightLineDistance: PlaceDistance?
    public var routeDistance: PlaceDistance?
    public var estimatedTravelDurationSeconds: Double?
    public var calculationSource: String
    public var calculatedAt: Date
    public var uncertaintyReason: String?

    public init(transportMode: PlaceTransportMode,
                straightLineDistance: PlaceDistance? = nil,
                routeDistance: PlaceDistance? = nil,
                estimatedTravelDurationSeconds: Double? = nil,
                calculationSource: String,
                calculatedAt: Date = Date(),
                uncertaintyReason: String? = nil) {
        self.transportMode = transportMode
        self.straightLineDistance = straightLineDistance
        self.routeDistance = routeDistance
        self.estimatedTravelDurationSeconds = estimatedTravelDurationSeconds.map { max(0, $0) }
        self.calculationSource = AgentPrivacyRedactor.safeSummary(calculationSource, fallback: "calculated")
        self.calculatedAt = calculatedAt
        self.uncertaintyReason = uncertaintyReason.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public struct PlaceIdentity: Codable, Sendable, Hashable {
    public var stableID: String
    public var sourceEntityIDs: [String]
    public var name: String
    public var normalizedName: String

    public init(stableID: String,
                sourceEntityIDs: [String] = [],
                name: String,
                normalizedName: String? = nil) {
        self.stableID = AgentEventRedactor.safeIdentifier(stableID)
        self.sourceEntityIDs = sourceEntityIDs.map { AgentEventRedactor.safeIdentifier($0) }.sorted()
        self.name = AgentPrivacyRedactor.safeSummary(name, fallback: "地点")
        self.normalizedName = PlaceNormalizer.normalizedName(normalizedName ?? name)
    }
}

public struct PlaceAddress: Codable, Sendable, Hashable {
    public var street: String?
    public var locality: String?
    public var region: String?
    public var postalCode: String?
    public var countryCode: String?
    public var formatted: String

    public init(street: String? = nil,
                locality: String? = nil,
                region: String? = nil,
                postalCode: String? = nil,
                countryCode: String? = nil,
                formatted: String) {
        self.street = street.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
        self.locality = locality.map { AgentPrivacyRedactor.safeText($0, maxLength: 160).text }
        self.region = region.map { AgentPrivacyRedactor.safeText($0, maxLength: 120).text }
        self.postalCode = postalCode.map { AgentPrivacyRedactor.safeSummary($0, fallback: "postal") }
        self.countryCode = countryCode.map { AgentPrivacyRedactor.safeIdentifier($0.uppercased(), fallback: "unknown") }
        self.formatted = AgentPrivacyRedactor.safeText(formatted, maxLength: 500).text
    }
}

public enum PlaceOpeningStatusValue: String, Codable, Sendable, Hashable, CaseIterable {
    case open
    case closed
    case unknown
    case conflicting
}

public struct PlaceOpeningStatus: Codable, Sendable, Hashable {
    public var value: PlaceOpeningStatusValue
    public var checkedAt: Date?
    public var targetTime: Date?
    public var confidence: Double
    public var source: String
    public var evidenceReferences: [PlaceEvidenceReference]
    public var uncertaintyReason: String?

    public init(value: PlaceOpeningStatusValue,
                checkedAt: Date? = nil,
                targetTime: Date? = nil,
                confidence: Double = 0,
                source: String = "unknown",
                evidenceReferences: [PlaceEvidenceReference] = [],
                uncertaintyReason: String? = nil) {
        self.value = value
        self.checkedAt = checkedAt
        self.targetTime = targetTime
        self.confidence = min(1, max(0, confidence))
        self.source = AgentPrivacyRedactor.safeSummary(source, fallback: "unknown")
        self.evidenceReferences = evidenceReferences
        self.uncertaintyReason = uncertaintyReason.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public struct PlaceOpeningInterval: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var weekday: Int?
    public var startTime: String
    public var endTime: String
    public var spansMidnight: Bool
    public var evidenceReferences: [PlaceEvidenceReference]

    public init(id: String,
                weekday: Int? = nil,
                startTime: String,
                endTime: String,
                spansMidnight: Bool = false,
                evidenceReferences: [PlaceEvidenceReference] = []) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.weekday = weekday.map { min(7, max(1, $0)) }
        self.startTime = AgentPrivacyRedactor.safeSummary(startTime, fallback: "00:00")
        self.endTime = AgentPrivacyRedactor.safeSummary(endTime, fallback: "00:00")
        self.spansMidnight = spansMidnight
        self.evidenceReferences = evidenceReferences
    }
}

public struct PlaceOpeningHours: Codable, Sendable, Hashable {
    public var intervals: [PlaceOpeningInterval]
    public var timezone: String
    public var valueSummary: String?
    public var confidence: Double
    public var source: String
    public var observedAt: Date?
    public var verifiedAt: Date?
    public var uncertaintyReason: String?

    public init(intervals: [PlaceOpeningInterval] = [],
                timezone: String,
                valueSummary: String? = nil,
                confidence: Double = 0,
                source: String = "unknown",
                observedAt: Date? = nil,
                verifiedAt: Date? = nil,
                uncertaintyReason: String? = nil) {
        self.intervals = intervals
        self.timezone = AgentPrivacyRedactor.safeSummary(timezone, fallback: "UTC")
        self.valueSummary = valueSummary.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
        self.confidence = min(1, max(0, confidence))
        self.source = AgentPrivacyRedactor.safeSummary(source, fallback: "unknown")
        self.observedAt = observedAt
        self.verifiedAt = verifiedAt
        self.uncertaintyReason = uncertaintyReason.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public enum PlacePriceValue: Codable, Sendable, Hashable {
    case level(Int)
    case maximumPerPerson(amount: Double, currencyCode: String)
    case rangePerPerson(minimum: Double, maximum: Double, currencyCode: String)
    case unknown
}

public struct PlacePriceEstimate: Codable, Sendable, Hashable {
    public var value: PlacePriceValue
    public var confidence: Double
    public var source: String
    public var observedAt: Date?
    public var verifiedAt: Date?
    public var evidenceReferences: [PlaceEvidenceReference]
    public var uncertaintyReason: String?

    public init(value: PlacePriceValue = .unknown,
                confidence: Double = 0,
                source: String = "unknown",
                observedAt: Date? = nil,
                verifiedAt: Date? = nil,
                evidenceReferences: [PlaceEvidenceReference] = [],
                uncertaintyReason: String? = nil) {
        self.value = value
        self.confidence = min(1, max(0, confidence))
        self.source = AgentPrivacyRedactor.safeSummary(source, fallback: "unknown")
        self.observedAt = observedAt
        self.verifiedAt = verifiedAt
        self.evidenceReferences = evidenceReferences
        self.uncertaintyReason = uncertaintyReason.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public enum PlaceParkingAvailability: String, Codable, Sendable, Hashable, CaseIterable {
    case easy
    case available
    case limited
    case paid
    case none
    case unknown
}

public struct PlaceParkingInfo: Codable, Sendable, Hashable {
    public var value: PlaceParkingAvailability
    public var confidence: Double
    public var source: String
    public var observedAt: Date?
    public var verifiedAt: Date?
    public var evidenceReferences: [PlaceEvidenceReference]
    public var uncertaintyReason: String?

    public init(value: PlaceParkingAvailability = .unknown,
                confidence: Double = 0,
                source: String = "unknown",
                observedAt: Date? = nil,
                verifiedAt: Date? = nil,
                evidenceReferences: [PlaceEvidenceReference] = [],
                uncertaintyReason: String? = nil) {
        self.value = value
        self.confidence = min(1, max(0, confidence))
        self.source = AgentPrivacyRedactor.safeSummary(source, fallback: "unknown")
        self.observedAt = observedAt
        self.verifiedAt = verifiedAt
        self.evidenceReferences = evidenceReferences
        self.uncertaintyReason = uncertaintyReason.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public struct PlaceContact: Codable, Sendable, Hashable {
    public var phoneNumber: String?
    public var displayPhone: String?

    public init(phoneNumber: String? = nil,
                displayPhone: String? = nil) {
        self.phoneNumber = phoneNumber.map { AgentPrivacyRedactor.safeSummary($0, fallback: "phone") }
        self.displayPhone = displayPhone.map { AgentPrivacyRedactor.safeSummary($0, fallback: "phone") }
    }
}

public enum PlaceWebLinkKind: String, Codable, Sendable, Hashable, CaseIterable {
    case officialWebsite
    case menu
    case maps
    case source
    case other
}

public struct PlaceWebLink: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: PlaceWebLinkKind
    public var title: String
    public var url: String
    public var evidenceReferences: [PlaceEvidenceReference]

    public init(id: String,
                kind: PlaceWebLinkKind,
                title: String,
                url: String,
                evidenceReferences: [PlaceEvidenceReference] = []) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.kind = kind
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "link")
        self.url = AgentPrivacyRedactor.safeText(url, maxLength: 1_000).text
        self.evidenceReferences = evidenceReferences
    }
}

public struct PlaceCandidate: Codable, Sendable, Hashable, Identifiable {
    public var id: String { stableID }
    public var schemaVersion: Int
    public var stableID: String
    public var sourceEntityIDs: [String]
    public var name: String
    public var normalizedName: String
    public var categories: [PlaceCategory]
    public var address: PlaceAddress?
    public var coordinate: PlaceCoordinate?
    public var distance: PlaceDistance?
    public var travelEstimate: PlaceTravelEstimate?
    public var openingHours: PlaceOpeningHours?
    public var openingStatus: PlaceOpeningStatus
    public var priceEstimate: PlacePriceEstimate
    public var parkingInfo: PlaceParkingInfo
    public var contact: PlaceContact
    public var webLinks: [PlaceWebLink]
    public var evidenceReferences: [PlaceEvidenceReference]
    public var freshness: String
    public var verificationStatus: PlaceVerificationStatus
    public var recommendationRationale: String?
    public var findings: [PlaceVerificationFinding]
    public var actionDescriptors: [PlaceActionDescriptor]

    public init(schemaVersion: Int = LocalDiscoverySchemaVersion.current,
                stableID: String,
                sourceEntityIDs: [String] = [],
                name: String,
                normalizedName: String? = nil,
                categories: [PlaceCategory] = [.place],
                address: PlaceAddress? = nil,
                coordinate: PlaceCoordinate? = nil,
                distance: PlaceDistance? = nil,
                travelEstimate: PlaceTravelEstimate? = nil,
                openingHours: PlaceOpeningHours? = nil,
                openingStatus: PlaceOpeningStatus = .init(value: .unknown, uncertaintyReason: "not checked"),
                priceEstimate: PlacePriceEstimate = .init(uncertaintyReason: "not checked"),
                parkingInfo: PlaceParkingInfo = .init(uncertaintyReason: "not checked"),
                contact: PlaceContact = .init(),
                webLinks: [PlaceWebLink] = [],
                evidenceReferences: [PlaceEvidenceReference] = [],
                freshness: String = "unknown",
                verificationStatus: PlaceVerificationStatus = .unknown,
                recommendationRationale: String? = nil,
                findings: [PlaceVerificationFinding] = [],
                actionDescriptors: [PlaceActionDescriptor] = []) {
        self.schemaVersion = max(1, schemaVersion)
        self.stableID = AgentEventRedactor.safeIdentifier(stableID)
        self.sourceEntityIDs = sourceEntityIDs.map { AgentEventRedactor.safeIdentifier($0) }.sorted()
        self.name = AgentPrivacyRedactor.safeSummary(name, fallback: "地点")
        self.normalizedName = PlaceNormalizer.normalizedName(normalizedName ?? name)
        self.categories = categories.isEmpty ? [.place] : categories
        self.address = address
        self.coordinate = coordinate
        self.distance = distance
        self.travelEstimate = travelEstimate
        self.openingHours = openingHours
        self.openingStatus = openingStatus
        self.priceEstimate = priceEstimate
        self.parkingInfo = parkingInfo
        self.contact = contact
        self.webLinks = webLinks
        self.evidenceReferences = evidenceReferences
        self.freshness = AgentPrivacyRedactor.safeSummary(freshness, fallback: "unknown")
        self.verificationStatus = verificationStatus
        self.recommendationRationale = recommendationRationale.map { AgentPrivacyRedactor.safeText($0, maxLength: 500).text }
        self.findings = findings
        self.actionDescriptors = actionDescriptors
    }
}

public enum PlaceNormalizer {
    public static func normalizedName(_ value: String) -> String {
        value
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9\u{4e00}-\u{9fff}]+"#, with: " ", options: .regularExpression)
            .split(separator: " ")
            .joined(separator: " ")
    }

    public static func normalizedHost(_ value: String?) -> String? {
        guard let value, let url = URL(string: value), let host = url.host?.lowercased() else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
