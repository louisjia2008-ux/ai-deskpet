import Foundation

public enum LocalDiscoverySchemaVersion {
    public static let current = 1
}

public struct PlaceCategory: Codable, Sendable, Hashable, RawRepresentable, ExpressibleByStringLiteral {
    public var rawValue: String

    public init(rawValue: String) {
        self.rawValue = AgentPrivacyRedactor.safeIdentifier(rawValue, fallback: "place")
    }

    public init(stringLiteral value: StringLiteralType) {
        self.init(rawValue: value)
    }

    private enum CodingKeys: String, CodingKey {
        case rawValue
    }

    public init(from decoder: Decoder) throws {
        if let raw = try? decoder.singleValueContainer().decode(String.self) {
            self.init(rawValue: raw)
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(rawValue: try container.decode(String.self, forKey: .rawValue))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let place = PlaceCategory(rawValue: "place")
    public static let restaurant = PlaceCategory(rawValue: "restaurant")
    public static let chineseRestaurant = PlaceCategory(rawValue: "chinese_restaurant")
    public static let sichuanRestaurant = PlaceCategory(rawValue: "sichuan_restaurant")
    public static let golfDrivingRange = PlaceCategory(rawValue: "golf_driving_range")
    public static let retailStore = PlaceCategory(rawValue: "retail_store")
    public static let electronicsStore = PlaceCategory(rawValue: "electronics_store")
}

public enum PlaceConstraintPriority: String, Codable, Sendable, Hashable, CaseIterable {
    case hard
    case soft
}

public enum PlaceConstraintKind: String, Codable, Sendable, Hashable, CaseIterable {
    case category
    case openAt
    case openNow
    case priceMaximum
    case distanceMaximum
    case travelTimeMaximum
    case parkingPreference
    case keyword
    case accessibility
    case ratingPreference
    case resultCount
}

public enum PlaceConstraintValue: Codable, Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case date(Date)
    case category(PlaceCategory)
    case distance(PlaceDistance)
    case durationMinutes(Double)
    case keywords([String])

    private enum CodingKeys: String, CodingKey {
        case type
        case value
    }

    private enum ValueType: String, Codable {
        case string
        case number
        case bool
        case date
        case category
        case distance
        case durationMinutes
        case keywords
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(ValueType.self, forKey: .type)
        switch type {
        case .string:
            self = .string(try container.decode(String.self, forKey: .value))
        case .number:
            self = .number(try container.decode(Double.self, forKey: .value))
        case .bool:
            self = .bool(try container.decode(Bool.self, forKey: .value))
        case .date:
            self = .date(try container.decode(Date.self, forKey: .value))
        case .category:
            self = .category(try container.decode(PlaceCategory.self, forKey: .value))
        case .distance:
            self = .distance(try container.decode(PlaceDistance.self, forKey: .value))
        case .durationMinutes:
            self = .durationMinutes(try container.decode(Double.self, forKey: .value))
        case .keywords:
            self = .keywords(try container.decode([String].self, forKey: .value))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .string(let value):
            try container.encode(ValueType.string, forKey: .type)
            try container.encode(AgentPrivacyRedactor.safeText(value, maxLength: 300).text, forKey: .value)
        case .number(let value):
            try container.encode(ValueType.number, forKey: .type)
            try container.encode(value, forKey: .value)
        case .bool(let value):
            try container.encode(ValueType.bool, forKey: .type)
            try container.encode(value, forKey: .value)
        case .date(let value):
            try container.encode(ValueType.date, forKey: .type)
            try container.encode(value, forKey: .value)
        case .category(let value):
            try container.encode(ValueType.category, forKey: .type)
            try container.encode(value, forKey: .value)
        case .distance(let value):
            try container.encode(ValueType.distance, forKey: .type)
            try container.encode(value, forKey: .value)
        case .durationMinutes(let value):
            try container.encode(ValueType.durationMinutes, forKey: .type)
            try container.encode(max(0, value), forKey: .value)
        case .keywords(let values):
            try container.encode(ValueType.keywords, forKey: .type)
            let safe = values.map { AgentPrivacyRedactor.safeSummary($0, fallback: "keyword") }
            try container.encode(safe, forKey: .value)
        }
    }
}

public struct PlaceConstraint: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: PlaceConstraintKind
    public var priority: PlaceConstraintPriority
    public var value: PlaceConstraintValue
    public var evidenceReferences: [PlaceEvidenceReference]

    public init(id: String,
                kind: PlaceConstraintKind,
                priority: PlaceConstraintPriority,
                value: PlaceConstraintValue,
                evidenceReferences: [PlaceEvidenceReference] = []) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.kind = kind
        self.priority = priority
        self.value = value
        self.evidenceReferences = evidenceReferences
    }
}

public enum PlaceLocationInputKind: String, Codable, Sendable, Hashable, CaseIterable {
    case approximateCurrentLocation
    case coordinate
    case explicitRegion
    case address
    case postalCode
    case unknown
}

public struct PlaceLocationInput: Codable, Sendable, Hashable {
    public var kind: PlaceLocationInputKind
    public var label: String?
    public var coordinate: PlaceCoordinate?

    public init(kind: PlaceLocationInputKind,
                label: String? = nil,
                coordinate: PlaceCoordinate? = nil) {
        self.kind = kind
        self.label = label.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.coordinate = coordinate
    }
}

public struct PlaceTemporalConstraint: Codable, Sendable, Hashable {
    public var targetDate: Date?
    public var openNow: Bool
    public var description: String?

    public init(targetDate: Date? = nil,
                openNow: Bool = false,
                description: String? = nil) {
        self.targetDate = targetDate
        self.openNow = openNow
        self.description = description.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
    }
}

public struct PlaceBudget: Codable, Sendable, Hashable {
    public var maximumAmount: Double?
    public var currencyCode: String
    public var perPerson: Bool

    public init(maximumAmount: Double? = nil,
                currencyCode: String = "USD",
                perPerson: Bool = false) {
        self.maximumAmount = maximumAmount.map { max(0, $0) }
        self.currencyCode = AgentPrivacyRedactor.safeIdentifier(currencyCode.uppercased(), fallback: "USD")
        self.perPerson = perPerson
    }
}

public struct PlaceTravelLimit: Codable, Sendable, Hashable {
    public var maximumDistanceMeters: Double?
    public var maximumTravelTimeSeconds: Double?
    public var transportMode: PlaceTransportMode

    public init(maximumDistanceMeters: Double? = nil,
                maximumTravelTimeSeconds: Double? = nil,
                transportMode: PlaceTransportMode = .automobile) {
        self.maximumDistanceMeters = maximumDistanceMeters.map { max(0, $0) }
        self.maximumTravelTimeSeconds = maximumTravelTimeSeconds.map { max(0, $0) }
        self.transportMode = transportMode
    }
}

public struct PlaceQuery: Codable, Sendable, Hashable, Identifiable {
    public var id: String { queryID }
    public var schemaVersion: Int
    public var queryID: String
    public var rawUserIntent: String
    public var searchText: String
    public var category: PlaceCategory
    public var locationInput: PlaceLocationInput
    public var temporalConstraint: PlaceTemporalConstraint?
    public var hardConstraints: [PlaceConstraint]
    public var softPreferences: [PlaceConstraint]
    public var budget: PlaceBudget?
    public var travelLimit: PlaceTravelLimit?
    public var resultLimit: Int
    public var locale: String
    public var timezone: String
    public var createdAt: Date

    public init(schemaVersion: Int = LocalDiscoverySchemaVersion.current,
                queryID: String,
                rawUserIntent: String,
                searchText: String,
                category: PlaceCategory = .place,
                locationInput: PlaceLocationInput,
                temporalConstraint: PlaceTemporalConstraint? = nil,
                hardConstraints: [PlaceConstraint] = [],
                softPreferences: [PlaceConstraint] = [],
                budget: PlaceBudget? = nil,
                travelLimit: PlaceTravelLimit? = nil,
                resultLimit: Int = 8,
                locale: String = Locale.current.identifier,
                timezone: String = TimeZone.current.identifier,
                createdAt: Date = Date()) {
        self.schemaVersion = max(1, schemaVersion)
        self.queryID = AgentEventRedactor.safeIdentifier(queryID)
        self.rawUserIntent = AgentPrivacyRedactor.safeText(rawUserIntent, maxLength: 1_000).text
        self.searchText = AgentPrivacyRedactor.safeText(searchText, maxLength: 500).text
        self.category = category
        self.locationInput = locationInput
        self.temporalConstraint = temporalConstraint
        self.hardConstraints = hardConstraints
        self.softPreferences = softPreferences
        self.budget = budget
        self.travelLimit = travelLimit
        self.resultLimit = min(max(1, resultLimit), 20)
        self.locale = AgentPrivacyRedactor.safeSummary(locale, fallback: "en_US")
        self.timezone = AgentPrivacyRedactor.safeSummary(timezone, fallback: "UTC")
        self.createdAt = createdAt
    }
}
