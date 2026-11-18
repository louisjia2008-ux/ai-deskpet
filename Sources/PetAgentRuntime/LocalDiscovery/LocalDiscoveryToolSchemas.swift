import Foundation

public enum LocalDiscoveryToolSchemas {
    public static let status = ToolJSONSchema(type: .string,
                                              enumValues: [
                                                  .string("success"),
                                                  .string("partial"),
                                                  .string("denied"),
                                                  .string("failed"),
                                                  .string("cancelled"),
                                              ])

    public static let evidenceReference = ToolJSONSchema(
        type: .object,
        properties: [
            "evidenceID": .string(maxLength: 160),
            "sourceToolID": .string(maxLength: 160),
            "sourceURL": .string(maxLength: 1_000),
            "claim": .string(maxLength: 400),
            "observedAt": .string(maxLength: 80),
            "freshness": .string(maxLength: 120),
            "confidence": .number(minimum: 0, maximum: 1),
        ],
        required: ["claim", "confidence", "evidenceID", "freshness"],
        additionalProperties: false)

    public static let coordinate = ToolJSONSchema(
        type: .object,
        properties: [
            "latitude": .number(minimum: -90, maximum: 90),
            "longitude": .number(minimum: -180, maximum: 180),
            "horizontalAccuracyMeters": .number(minimum: 0),
        ],
        required: ["latitude", "longitude"],
        additionalProperties: false)

    public static let placeSearchInput = ToolJSONSchema(
        type: .object,
        properties: [
            "queryText": .string(minLength: 1, maxLength: 240),
            "category": .string(maxLength: 120),
            "center": coordinate,
            "regionText": .string(maxLength: 240),
            "radiusMeters": .number(minimum: 1, maximum: 100_000),
            "resultLimit": .integer(minimum: 1, maximum: 20),
            "locale": .string(maxLength: 40),
        ],
        required: ["queryText", "resultLimit"],
        additionalProperties: false)

    public static let placeCandidateSummary = ToolJSONSchema(
        type: .object,
        properties: [
            "schemaVersion": .integer(minimum: 1),
            "stableID": .string(maxLength: 200),
            "sourceEntityIDs": .array(items: .string(maxLength: 240), maxItems: 16),
            "name": .string(minLength: 1, maxLength: 240),
            "normalizedName": .string(maxLength: 240),
            "categories": .array(items: .string(maxLength: 120), minItems: 1, maxItems: 16),
            "address": .object(additionalProperties: true),
            "coordinate": coordinate,
            "distance": .object(additionalProperties: true),
            "travelEstimate": .object(additionalProperties: true),
            "openingHours": .object(additionalProperties: true),
            "openingStatus": .object(additionalProperties: true),
            "priceEstimate": .object(additionalProperties: true),
            "parkingInfo": .object(additionalProperties: true),
            "contact": .object(additionalProperties: true),
            "webLinks": .array(items: .object(additionalProperties: true), maxItems: 16),
            "evidenceReferences": .array(items: evidenceReference, minItems: 1, maxItems: 32),
            "freshness": .string(maxLength: 120),
            "verificationStatus": .string(maxLength: 80),
            "recommendationRationale": .string(maxLength: 500),
            "findings": .array(items: .object(additionalProperties: true), maxItems: 32),
            "actionDescriptors": .array(items: .object(additionalProperties: true), maxItems: 16),
        ],
        required: [
            "actionDescriptors",
            "categories",
            "evidenceReferences",
            "findings",
            "freshness",
            "name",
            "normalizedName",
            "openingStatus",
            "parkingInfo",
            "priceEstimate",
            "sourceEntityIDs",
            "stableID",
            "verificationStatus",
        ],
        additionalProperties: true)

    public static let placeSearchOutput = ToolJSONSchema(
        type: .object,
        properties: [
            "status": status,
            "backend": .string(maxLength: 120),
            "query": .string(maxLength: 300),
            "inputLocationType": .string(maxLength: 80),
            "resultCount": .integer(minimum: 0, maximum: 20),
            "candidates": .array(items: placeCandidateSummary, maxItems: 20),
            "evidenceReferences": .array(items: evidenceReference, maxItems: 64),
            "fetchedAt": .string(maxLength: 80),
            "usedFixture": .boolean(),
            "errorReason": .string(maxLength: 300),
        ],
        required: [
            "backend",
            "candidates",
            "evidenceReferences",
            "fetchedAt",
            "inputLocationType",
            "query",
            "resultCount",
            "status",
            "usedFixture",
        ],
        additionalProperties: false)

    public static let approximateLocationInput = ToolJSONSchema(
        type: .object,
        properties: [
            "desiredAccuracyLevel": .string(maxLength: 80),
            "purpose": .string(minLength: 1, maxLength: 300),
            "taskScope": .string(maxLength: 120),
        ],
        required: ["desiredAccuracyLevel", "purpose"],
        additionalProperties: false)

    public static let approximateLocationOutput = ToolJSONSchema(
        type: .object,
        properties: [
            "status": status,
            "authorizationState": .string(maxLength: 80),
            "coordinate": coordinate,
            "regionDescription": .string(maxLength: 240),
            "horizontalAccuracyMeters": .number(minimum: 0),
            "capturedAt": .string(maxLength: 80),
            "source": .string(maxLength: 120),
            "evidenceReferences": .array(items: evidenceReference, maxItems: 16),
        ],
        required: ["authorizationState", "capturedAt", "evidenceReferences", "source", "status"],
        additionalProperties: false)

    public static let routeDistanceInput = ToolJSONSchema(
        type: .object,
        properties: [
            "origin": coordinate,
            "destination": coordinate,
            "transportMode": .string(maxLength: 40),
            "departureContext": .string(maxLength: 160),
        ],
        required: ["destination", "origin", "transportMode"],
        additionalProperties: false)

    public static let routeDistanceOutput = ToolJSONSchema(
        type: .object,
        properties: [
            "status": status,
            "transportMode": .string(maxLength: 40),
            "straightLineDistanceMeters": .number(minimum: 0),
            "routeDistanceMeters": .number(minimum: 0),
            "estimatedTravelDurationSeconds": .number(minimum: 0),
            "calculationSource": .string(maxLength: 120),
            "calculatedAt": .string(maxLength: 80),
            "uncertaintyReason": .string(maxLength: 300),
            "evidenceReferences": .array(items: evidenceReference, minItems: 1, maxItems: 16),
            "usedFixture": .boolean(),
        ],
        required: [
            "calculatedAt",
            "calculationSource",
            "evidenceReferences",
            "status",
            "straightLineDistanceMeters",
            "transportMode",
            "usedFixture",
        ],
        additionalProperties: false)

    public static let webpageReadInput = ToolJSONSchema(
        type: .object,
        properties: [
            "url": .string(minLength: 1, maxLength: 2_000),
            "extractionPurpose": .string(maxLength: 300),
            "allowedContentTypes": .array(items: .string(maxLength: 120), maxItems: 12),
            "sizeLimitBytes": .integer(minimum: 512, maximum: 262_144),
        ],
        required: ["url"],
        additionalProperties: false)

    public static let webpageReadOutput = ToolJSONSchema(
        type: .object,
        properties: [
            "status": status,
            "canonicalURL": .string(maxLength: 2_000),
            "pageTitle": .string(maxLength: 400),
            "extractedText": .string(maxLength: 20_000),
            "structuredMetadata": .array(items: .object(additionalProperties: true), maxItems: 32),
            "fetchedAt": .string(maxLength: 80),
            "contentHash": .string(maxLength: 160),
            "contentIsUntrusted": .boolean(),
            "evidenceReferences": .array(items: evidenceReference, minItems: 1, maxItems: 16),
        ],
        required: [
            "canonicalURL",
            "contentHash",
            "contentIsUntrusted",
            "evidenceReferences",
            "fetchedAt",
            "status",
        ],
        additionalProperties: false)

    public static let structuredExtractionInput = ToolJSONSchema(
        type: .object,
        properties: [
            "evidenceID": .string(minLength: 1, maxLength: 160),
            "canonicalURL": .string(maxLength: 2_000),
            "pageTitle": .string(maxLength: 400),
            "extractedText": .string(maxLength: 20_000),
            "structuredMetadata": .array(items: .object(additionalProperties: true), maxItems: 32),
            "fields": .array(items: .string(maxLength: 120), maxItems: 16),
            "fetchedAt": .string(maxLength: 80),
        ],
        required: ["evidenceID", "fields"],
        additionalProperties: false)

    public static let structuredExtractionOutput = ToolJSONSchema(
        type: .object,
        properties: [
            "status": status,
            "sourceEvidenceID": .string(maxLength: 160),
            "extractedFields": .object(additionalProperties: true),
            "warnings": .array(items: .string(maxLength: 300), maxItems: 24),
            "evidenceReferences": .array(items: evidenceReference, minItems: 1, maxItems: 32),
            "usedFixture": .boolean(),
        ],
        required: [
            "evidenceReferences",
            "extractedFields",
            "sourceEvidenceID",
            "status",
            "usedFixture",
            "warnings",
        ],
        additionalProperties: false)
}

private extension ToolJSONSchema {
    static func string(minLength: Int? = nil, maxLength: Int? = nil) -> ToolJSONSchema {
        ToolJSONSchema(type: .string, minLength: minLength, maxLength: maxLength)
    }

    static func number(minimum: Double? = nil, maximum: Double? = nil) -> ToolJSONSchema {
        ToolJSONSchema(type: .number, minimum: minimum, maximum: maximum)
    }

    static func integer(minimum: Double? = nil, maximum: Double? = nil) -> ToolJSONSchema {
        ToolJSONSchema(type: .integer, minimum: minimum, maximum: maximum)
    }

    static func boolean() -> ToolJSONSchema {
        ToolJSONSchema(type: .boolean)
    }

    static func array(items: ToolJSONSchema? = nil,
                      minItems: Int? = nil,
                      maxItems: Int? = nil) -> ToolJSONSchema {
        ToolJSONSchema(type: .array, items: items, minItems: minItems, maxItems: maxItems)
    }

    static func object(additionalProperties: Bool = false) -> ToolJSONSchema {
        ToolJSONSchema(type: .object, additionalProperties: additionalProperties)
    }
}
