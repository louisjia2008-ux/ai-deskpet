import Foundation
import AICore

public struct LocalDiscoveryStructuredPlannerRequest: Sendable, Equatable {
    public var userText: String
    public var decision: LocalDiscoveryIntentDecision
    public var conversationContext: ConversationIntentContext?
    public var now: Date
    public var locale: Locale
    public var timeZone: TimeZone
    public var availableCapabilityIDs: [String]
    public var permissionStateSummary: [String: String]
    public var policy: LocalDiscoverySearchPolicy

    public init(userText: String,
                decision: LocalDiscoveryIntentDecision,
                conversationContext: ConversationIntentContext? = nil,
                now: Date,
                locale: Locale,
                timeZone: TimeZone,
                availableCapabilityIDs: [String],
                permissionStateSummary: [String: String] = [:],
                policy: LocalDiscoverySearchPolicy) {
        self.userText = AgentPrivacyRedactor.safeText(userText, maxLength: 1_000).text
        self.decision = decision
        self.conversationContext = conversationContext
        self.now = now
        self.locale = locale
        self.timeZone = timeZone
        self.availableCapabilityIDs = availableCapabilityIDs.map(AgentEventRedactor.safeIdentifier).sorted()
        self.permissionStateSummary = AgentPrivacyRedactor.safeMetadata(permissionStateSummary)
        self.policy = policy
    }
}

public protocol LocalDiscoveryStructuredPlanning: Sendable {
    func planLocalDiscovery(request: LocalDiscoveryStructuredPlannerRequest,
                            fallbackPlanner: LocalDiscoveryQueryPlanner) async throws -> LocalDiscoveryPlannedQuery
}

public enum LocalDiscoveryStructuredPlannerError: Error, Sendable, Equatable {
    case conformanceDenied([String])
    case providerUnavailable(String)
    case invalidModelOutput([String])
    case cancelled
}

private struct LocalDiscoveryDraftParseFailure: Error, Sendable, Equatable {
    var issues: [String]

    init(_ issues: [String]) {
        self.issues = issues.map(AgentEventRedactor.safeIdentifier)
    }
}

public struct LocalDiscoveryPlannerConformance: Sendable, Equatable {
    public var providerID: String
    public var modelID: String
    public var allowed: Bool
    public var supportsStructuredOutput: Bool
    public var requiresOutputRepair: Bool
    public var supportsReasoningSeparation: Bool
    public var maxAutonomousSteps: Int
    public var issues: [String]

    public init(providerID: String,
                modelID: String,
                allowed: Bool = true,
                supportsStructuredOutput: Bool = false,
                requiresOutputRepair: Bool = true,
                supportsReasoningSeparation: Bool = true,
                maxAutonomousSteps: Int = 1,
                issues: [String] = []) {
        self.providerID = AgentEventRedactor.safeIdentifier(providerID)
        self.modelID = AgentEventRedactor.safeIdentifier(modelID)
        self.allowed = allowed
        self.supportsStructuredOutput = supportsStructuredOutput
        self.requiresOutputRepair = requiresOutputRepair
        self.supportsReasoningSeparation = supportsReasoningSeparation
        self.maxAutonomousSteps = max(1, maxAutonomousSteps)
        self.issues = issues.map(AgentEventRedactor.safeIdentifier).sorted()
    }

    public init(selection: ModelRouter.Selection,
                plannerDecision: ModelRouter.ConformanceDecision?) {
        self.init(providerID: selection.provider.id,
                  modelID: selection.modelID,
                  allowed: plannerDecision?.allowed ?? true,
                  supportsStructuredOutput: plannerDecision?.nativeToolCallingAllowed == true
                    || selection.provider.capabilities.contains(.toolCalling),
                  requiresOutputRepair: !(plannerDecision?.nativeToolCallingAllowed == true),
                  supportsReasoningSeparation: !((plannerDecision?.issues ?? []).contains("reasoning_separation_unverified")),
                  maxAutonomousSteps: plannerDecision?.maxAutonomousSteps ?? 1,
                  issues: plannerDecision?.issues ?? [])
    }
}

public struct LocalDiscoveryModelStructuredPlanner: LocalDiscoveryStructuredPlanning {
    private let client: any LLMClient
    private let modelID: String
    private let modelProvider: String
    private let conformance: LocalDiscoveryPlannerConformance
    private let maxRepairAttempts: Int

    public init(client: any LLMClient,
                modelID: String,
                modelProvider: String,
                conformance: LocalDiscoveryPlannerConformance,
                maxRepairAttempts: Int = 2) {
        self.client = client
        self.modelID = AgentEventRedactor.safeIdentifier(modelID)
        self.modelProvider = AgentEventRedactor.safeIdentifier(modelProvider)
        self.conformance = conformance
        self.maxRepairAttempts = min(2, max(0, maxRepairAttempts))
    }

    public func planLocalDiscovery(request: LocalDiscoveryStructuredPlannerRequest,
                                   fallbackPlanner: LocalDiscoveryQueryPlanner) async throws -> LocalDiscoveryPlannedQuery {
        guard conformance.allowed else {
            throw LocalDiscoveryStructuredPlannerError.conformanceDenied(conformance.issues)
        }
        guard conformance.supportsReasoningSeparation else {
            throw LocalDiscoveryStructuredPlannerError.conformanceDenied(["reasoning_separation_unverified"])
        }

        let repairBudget = min(maxRepairAttempts, max(0, conformance.maxAutonomousSteps - 1))
        var validationIssues: [String] = []
        for attempt in 0...repairBudget {
            try Task.checkCancellation()
            let response = try await client.sendChat(LLMChatRequest(
                messages: Self.messages(for: request,
                                        schema: LocalDiscoveryPlaceQueryDraft.schema,
                                        validationIssues: validationIssues,
                                        repairAttempt: attempt),
                modelID: modelID,
                temperature: 0,
                maxTokens: 1_200,
                tools: [],
                toolChoice: LLMToolChoice.none,
                metadata: [
                    "role": "planner",
                    "schema": "localDiscovery.placeQueryDraft.v1",
                    "providerID": conformance.providerID,
                    "modelProvider": modelProvider,
                    "structuredOutput": conformance.supportsStructuredOutput ? "native_or_constrained" : "text_constrained",
                ]))
            try Task.checkCancellation()
            let raw = ModelResponseSanitizer.sanitize(content: response.message.content).visibleText
            let normalized = Self.parseAndNormalize(raw: raw,
                                                    request: request,
                                                    fallbackPlanner: fallbackPlanner,
                                                    repairAttempts: attempt)
            switch normalized {
            case .success(let planned):
                return planned
            case .failure(let failure):
                validationIssues = failure.issues
            }
        }

        let fallback = fallbackPlanner.plan(userText: request.userText,
                                            decision: request.decision,
                                            conversationContext: request.conversationContext,
                                            now: request.now,
                                            locale: request.locale,
                                            timeZone: request.timeZone)
        if Self.canUseDeterministicFallback(for: request.userText), fallback.status == .ready {
            return LocalDiscoveryPlannedQuery(status: fallback.status,
                                             query: fallback.query,
                                             assumptions: fallback.assumptions + ["模型结构化 planner 未通过校验，使用 deterministic fallback。"],
                                             missingInformation: fallback.missingInformation,
                                             unsupportedRequirements: fallback.unsupportedRequirements,
                                             repairAttempts: repairBudget,
                                             usedDeterministicFallback: true)
        }
        return LocalDiscoveryPlannedQuery(status: .requiresClarification,
                                         query: fallback.query,
                                         assumptions: fallback.assumptions,
                                         missingInformation: ["我需要你确认地点类别、位置和硬性筛选条件后再继续。"],
                                         unsupportedRequirements: fallback.unsupportedRequirements,
                                         repairAttempts: repairBudget,
                                         usedDeterministicFallback: true)
    }

    private static func parseAndNormalize(raw: String,
                                          request: LocalDiscoveryStructuredPlannerRequest,
                                          fallbackPlanner: LocalDiscoveryQueryPlanner,
                                          repairAttempts: Int) -> Result<LocalDiscoveryPlannedQuery, LocalDiscoveryDraftParseFailure> {
        guard let json = extractJSONObject(from: raw) else {
            return .failure(LocalDiscoveryDraftParseFailure(["invalid_json"]))
        }
        let parsed: AgentJSONValue
        do {
            let object = try JSONSerialization.jsonObject(with: Data(json.utf8))
            parsed = try AgentJSONValue.fromJSONObject(object)
        } catch {
            return .failure(LocalDiscoveryDraftParseFailure(["invalid_json"]))
        }
        let schema = ToolSchemaValidator.validate(parsed,
                                                  against: LocalDiscoveryPlaceQueryDraft.schema,
                                                  limits: ToolSchemaValidationLimits(maxPayloadBytes: 24_576,
                                                                                     maxDepth: 8,
                                                                                     maxArrayItems: 32))
        guard schema.accepted else {
            return .failure(LocalDiscoveryDraftParseFailure(schema.issues.map { "\($0.path):\($0.message)" }))
        }
        do {
            let draft = try LocalDiscoveryJSON.decoded(LocalDiscoveryPlaceQueryDraft.self, from: parsed)
            return try .success(LocalDiscoveryPlaceQueryDraftNormalizer.normalize(draft,
                                                                                  request: request,
                                                                                  fallbackPlanner: fallbackPlanner,
                                                                                  repairAttempts: repairAttempts))
        } catch let error as LocalDiscoveryDraftSemanticError {
            return .failure(LocalDiscoveryDraftParseFailure(error.issues))
        } catch {
            return .failure(LocalDiscoveryDraftParseFailure(["draft_decode_failed"]))
        }
    }

    private static func extractJSONObject(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{"), trimmed.hasSuffix("}") { return trimmed }
        guard let start = trimmed.firstIndex(of: "{"),
              let end = trimmed.lastIndex(of: "}"),
              start <= end else { return nil }
        return String(trimmed[start...end])
    }

    private static func canUseDeterministicFallback(for userText: String) -> Bool {
        let normalized = LocalDiscoveryIntentClassifier.normalized(userText)
        let complexMarkers = [
            "今晚", "明天", "周六", "停车", "人均", "总预算", "便宜", "必须", "关门",
            "库存", "现货", "$", "within", "minutes", "tonight", "tomorrow", "parking", "budget",
        ]
        return !complexMarkers.contains { normalized.contains($0) }
    }

    private static func messages(for request: LocalDiscoveryStructuredPlannerRequest,
                                 schema: ToolJSONSchema,
                                 validationIssues: [String],
                                 repairAttempt: Int) -> [LLMChatMessage] {
        let capabilitySummary = request.availableCapabilityIDs.joined(separator: ",")
        let permissionSummary = request.permissionStateSummary
            .sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: ",")
        let schemaJSON = (try? LocalDiscoveryJSON.jsonValue(from: schema).jsonString) ?? "{}"
        var lines = [
            "You are DeskPet's Local Discovery PlaceQuery planner.",
            "Return exactly one JSON object matching the supplied schema.",
            "Do not output PlaceCandidate data, business names, addresses, phone numbers, opening hours, prices, parking claims, or source facts.",
            "Only extract the user's intent, constraints, assumptions, missing information, and unsupported requirements.",
            "No reasoning, no markdown, no hidden thoughts.",
            "Current datetime: \(ISO8601DateFormatter().string(from: request.now))",
            "Locale: \(request.locale.identifier)",
            "Default timezone: \(request.timeZone.identifier)",
            "Available capabilities: \(capabilitySummary)",
            "Permission state summary: \(permissionSummary)",
            "Policy: radius=\(Int(request.policy.defaultRadiusMeters))m candidates=\(request.policy.defaultCandidateCount) enrichment=\(request.policy.enrichmentCandidateCount)",
            "Schema: \(schema.providerDescription)",
            "Full schema JSON: \(schemaJSON)",
        ]
        if let context = request.conversationContext?.recentUserGoal,
           !context.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines.append("Relevant conversation context: \(AgentPrivacyRedactor.safeText(context, maxLength: 300).text)")
        }
        if repairAttempt > 0 {
            let repairSummary = validationIssues.prefix(12).joined(separator: "; ")
            lines.append("Repair attempt \(repairAttempt). Fix only these validation errors: \(repairSummary)")
        }
        return [
            LLMChatMessage(role: .system, content: lines.joined(separator: "\n")),
            LLMChatMessage(role: .user, content: request.userText),
        ]
    }
}

public struct LocalDiscoveryPlaceQueryDraft: Codable, Sendable, Hashable {
    public var isLocalDiscovery: Bool
    public var searchText: String
    public var category: String
    public var locationInput: LocationDraft
    public var temporalConstraint: TemporalDraft?
    public var hardConstraints: [ConstraintDraft]
    public var softPreferences: [ConstraintDraft]
    public var budget: BudgetDraft?
    public var travelLimit: TravelLimitDraft?
    public var resultLimit: Int
    public var assumptions: [String]
    public var missingInformation: [String]
    public var unsupportedRequirements: [String]

    public struct LocationDraft: Codable, Sendable, Hashable {
        public var kind: String
        public var label: String?
    }

    public struct TemporalDraft: Codable, Sendable, Hashable {
        public var description: String?
        public var targetDateISO8601: String?
        public var openNow: Bool
    }

    public struct ConstraintDraft: Codable, Sendable, Hashable {
        public var kind: String
        public var priority: String
        public var value: String
    }

    public struct BudgetDraft: Codable, Sendable, Hashable {
        public var scope: String
        public var maximumAmount: Double?
        public var currencyCode: String
        public var vaguePreference: String?
    }

    public struct TravelLimitDraft: Codable, Sendable, Hashable {
        public var maximumDistanceMeters: Double?
        public var maximumTravelTimeSeconds: Double?
        public var transportMode: String
    }
}

public extension LocalDiscoveryPlaceQueryDraft {
    static let schema = ToolJSONSchema(
        type: .object,
        properties: [
            "isLocalDiscovery": ToolJSONSchema(type: .boolean),
            "searchText": ToolJSONSchema(type: .string, minLength: 1, maxLength: 240),
            "category": ToolJSONSchema(type: .string, minLength: 1, maxLength: 120),
            "locationInput": ToolJSONSchema(type: .object,
                                             properties: [
                                                "kind": ToolJSONSchema(type: .string,
                                                                       enumValues: PlaceLocationInputKind.allCases.map { .string($0.rawValue) }),
                                                "label": ToolJSONSchema(type: .string, maxLength: 240),
                                             ],
                                             required: ["kind"],
                                             additionalProperties: false),
            "temporalConstraint": ToolJSONSchema(type: .object,
                                                 properties: [
                                                    "description": ToolJSONSchema(type: .string, maxLength: 240),
                                                    "targetDateISO8601": ToolJSONSchema(type: .string, maxLength: 80),
                                                    "openNow": ToolJSONSchema(type: .boolean),
                                                 ],
                                                 required: ["openNow"],
                                                 additionalProperties: false),
            "hardConstraints": ToolJSONSchema(type: .array,
                                              items: constraintSchema,
                                              maxItems: 16),
            "softPreferences": ToolJSONSchema(type: .array,
                                              items: constraintSchema,
                                              maxItems: 16),
            "budget": ToolJSONSchema(type: .object,
                                      properties: [
                                        "scope": ToolJSONSchema(type: .string,
                                                               enumValues: [.string("none"), .string("perPerson"), .string("total"), .string("vague")]),
                                        "maximumAmount": ToolJSONSchema(type: .number, minimum: 0, maximum: 100_000),
                                        "currencyCode": ToolJSONSchema(type: .string, minLength: 3, maxLength: 3),
                                        "vaguePreference": ToolJSONSchema(type: .string, maxLength: 200),
                                      ],
                                      required: ["scope", "currencyCode"],
                                      additionalProperties: false),
            "travelLimit": ToolJSONSchema(type: .object,
                                          properties: [
                                            "maximumDistanceMeters": ToolJSONSchema(type: .number, minimum: 0, maximum: 200_000),
                                            "maximumTravelTimeSeconds": ToolJSONSchema(type: .number, minimum: 0, maximum: 86_400),
                                            "transportMode": ToolJSONSchema(type: .string,
                                                                           enumValues: PlaceTransportMode.allCases.map { .string($0.rawValue) }),
                                          ],
                                          required: ["transportMode"],
                                          additionalProperties: false),
            "resultLimit": ToolJSONSchema(type: .integer, minimum: 1, maximum: 20),
            "assumptions": ToolJSONSchema(type: .array,
                                          items: ToolJSONSchema(type: .string, maxLength: 240),
                                          maxItems: 16),
            "missingInformation": ToolJSONSchema(type: .array,
                                                 items: ToolJSONSchema(type: .string, maxLength: 240),
                                                 maxItems: 16),
            "unsupportedRequirements": ToolJSONSchema(type: .array,
                                                      items: ToolJSONSchema(type: .string, maxLength: 120),
                                                      maxItems: 16),
        ],
        required: [
            "assumptions",
            "category",
            "hardConstraints",
            "isLocalDiscovery",
            "locationInput",
            "missingInformation",
            "resultLimit",
            "searchText",
            "softPreferences",
            "unsupportedRequirements",
        ],
        additionalProperties: false)

    private static let constraintSchema = ToolJSONSchema(
        type: .object,
        properties: [
            "kind": ToolJSONSchema(type: .string,
                                   enumValues: PlaceConstraintKind.allCases.map { .string($0.rawValue) }),
            "priority": ToolJSONSchema(type: .string,
                                       enumValues: PlaceConstraintPriority.allCases.map { .string($0.rawValue) }),
            "value": ToolJSONSchema(type: .string, maxLength: 240),
        ],
        required: ["kind", "priority", "value"],
        additionalProperties: false)
}

public struct LocalDiscoveryDraftSemanticError: Error, Sendable, Equatable {
    public var issues: [String]

    public init(_ issues: [String]) {
        self.issues = issues.map(AgentEventRedactor.safeIdentifier)
    }
}

public enum LocalDiscoveryPlaceQueryDraftNormalizer {
    public static func normalize(_ draft: LocalDiscoveryPlaceQueryDraft,
                                 request: LocalDiscoveryStructuredPlannerRequest,
                                 fallbackPlanner: LocalDiscoveryQueryPlanner,
                                 repairAttempts: Int) throws -> LocalDiscoveryPlannedQuery {
        var issues: [String] = []
        if !draft.isLocalDiscovery {
            issues.append("draft_not_local_discovery")
        }
        if draft.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("missing_search_text")
        }
        let category = canonicalCategory(draft.category, request: request)
        if category == .place {
            issues.append("missing_category")
        }
        var locationKind = PlaceLocationInputKind(rawValue: draft.locationInput.kind) ?? .unknown
        if let explicit = request.decision.explicitLocation {
            if locationKind == .approximateCurrentLocation {
                issues.append("explicit_location_downgraded_to_current_location")
            }
            if (draft.locationInput.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                issues.append("explicit_location_label_missing")
            } else if !sameLocation(draft.locationInput.label, explicit) {
                issues.append("explicit_location_not_preserved")
            } else if locationKind == .unknown {
                locationKind = .explicitRegion
            }
        } else if request.decision.requiresLocationPermission,
                  locationKind != .approximateCurrentLocation {
            issues.append("nearby_requires_approximate_location")
        }
        let unsupported = Set(draft.unsupportedRequirements.map(AgentEventRedactor.safeIdentifier))
        for requirement in request.decision.unsupportedRequirements where !unsupported.contains(requirement) {
            issues.append("unsupported_requirement_dropped_\(requirement)")
        }
        if hasContradictoryBudget(in: request.userText) {
            return LocalDiscoveryPlannedQuery(status: .requiresClarification,
                                             assumptions: draft.assumptions,
                                             missingInformation: ["预算同时包含人均和总额，请确认哪个是硬性限制。"],
                                             unsupportedRequirements: Array(unsupported).sorted(),
                                             repairAttempts: repairAttempts,
                                             usedDeterministicFallback: false)
        }
        if modelMadeParkingHardWithoutUserRequirement(draft: draft, userText: request.userText) {
            issues.append("parking_soft_preference_marked_hard")
        }
        guard issues.isEmpty else {
            throw LocalDiscoveryDraftSemanticError(issues)
        }

        let deterministic = fallbackPlanner.plan(userText: request.userText,
                                                 decision: request.decision,
                                                 conversationContext: request.conversationContext,
                                                 now: request.now,
                                                 locale: request.locale,
                                                 timeZone: request.timeZone)
        guard var query = deterministic.query else {
            return LocalDiscoveryPlannedQuery(status: deterministic.status,
                                             assumptions: deterministic.assumptions + draft.assumptions,
                                             missingInformation: deterministic.missingInformation + draft.missingInformation,
                                             unsupportedRequirements: Array(unsupported).sorted(),
                                             repairAttempts: repairAttempts,
                                             usedDeterministicFallback: false)
        }
        query.searchText = AgentPrivacyRedactor.safeText(draft.searchText, maxLength: 240).text
        query.category = category
        query.locationInput = PlaceLocationInput(kind: locationKind,
                                                 label: draft.locationInput.label ?? deterministic.query?.locationInput.label)
        if let budget = draft.budget {
            switch budget.scope {
            case "perPerson":
                query.budget = PlaceBudget(maximumAmount: budget.maximumAmount,
                                           currencyCode: budget.currencyCode,
                                           perPerson: true)
            case "total":
                query.budget = PlaceBudget(maximumAmount: budget.maximumAmount,
                                           currencyCode: budget.currencyCode,
                                           perPerson: false)
            default:
                break
            }
        }
        if let travel = draft.travelLimit {
            query.travelLimit = PlaceTravelLimit(maximumDistanceMeters: travel.maximumDistanceMeters,
                                                maximumTravelTimeSeconds: travel.maximumTravelTimeSeconds,
                                                transportMode: PlaceTransportMode(rawValue: travel.transportMode) ?? .automobile)
        }
        query.resultLimit = min(max(1, draft.resultLimit), request.policy.defaultCandidateCount)
        let missing = blockingMissingInformation(deterministic.missingInformation + draft.missingInformation,
                                                 query: query,
                                                 request: request)
        let status: LocalDiscoveryPlanningStatus = missing.isEmpty ? .ready : .requiresClarification
        return LocalDiscoveryPlannedQuery(status: status,
                                         query: query,
                                         assumptions: Array(Set(deterministic.assumptions + draft.assumptions)).sorted(),
                                         missingInformation: Array(Set(missing)).sorted(),
                                         unsupportedRequirements: Array(unsupported.union(deterministic.unsupportedRequirements)).sorted(),
                                         repairAttempts: repairAttempts,
                                         usedDeterministicFallback: false)
    }

    private static func sameLocation(_ lhs: String?, _ rhs: String) -> Bool {
        let left = LocalDiscoveryIntentClassifier.normalized(lhs ?? "")
        let right = LocalDiscoveryIntentClassifier.normalized(rhs)
        guard !left.isEmpty else { return false }
        return left == right || left.contains(right) || right.contains(left)
    }

    private static func canonicalCategory(_ raw: String,
                                          request: LocalDiscoveryStructuredPlannerRequest) -> PlaceCategory {
        let normalized = LocalDiscoveryIntentClassifier.normalized(raw)
        if normalized.isEmpty || normalized == "place" { return .place }
        if normalized.contains("sichuan") || normalized.contains("川菜") || normalized.contains("四川") {
            return .sichuanRestaurant
        }
        if normalized.contains("chinese") || normalized.contains("中餐") || normalized.contains("中国菜") {
            return .chineseRestaurant
        }
        if normalized.contains("golf") || normalized.contains("driving range") || normalized.contains("练习场") {
            return .golfDrivingRange
        }
        if normalized.contains("electronics") || normalized.contains("charger") || normalized.contains("usb-c") || normalized.contains("充电器") {
            return .electronicsStore
        }
        if normalized.contains("retail") || normalized.contains("store") || normalized.contains("商店") {
            return .retailStore
        }
        if normalized.contains("coffee") || normalized.contains("咖啡") {
            return PlaceCategory(rawValue: "coffee_shop")
        }
        if normalized.contains("pharmacy") || normalized.contains("药店") {
            return PlaceCategory(rawValue: "pharmacy")
        }
        if normalized == "restaurant" || normalized.contains("restaurant") {
            return request.decision.requestedCategory ?? .restaurant
        }
        let category = PlaceCategory(rawValue: raw)
        return category == .place ? .place : category
    }

    private static func meaningfulMissingInformation(_ values: [String]) -> [String] {
        values.compactMap { value in
            let trimmed = AgentPrivacyRedactor.safeText(value, maxLength: 300).text
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = LocalDiscoveryIntentClassifier.normalized(trimmed)
            guard !trimmed.isEmpty,
                  !["none", "n/a", "na", "nil", "null", "no missing information", "无", "无缺失", "没有"].contains(normalized) else {
                return nil
            }
            return trimmed
        }
    }

    private static func blockingMissingInformation(_ values: [String],
                                                   query: PlaceQuery,
                                                   request: LocalDiscoveryStructuredPlannerRequest) -> [String] {
        meaningfulMissingInformation(values).filter { value in
            let normalized = LocalDiscoveryIntentClassifier.normalized(value)
            if isOptionalPreferenceGap(normalized, query: query, request: request) {
                return false
            }
            return true
        }
    }

    private static func isOptionalPreferenceGap(_ normalized: String,
                                                query: PlaceQuery,
                                                request: LocalDiscoveryStructuredPlannerRequest) -> Bool {
        let userText = LocalDiscoveryIntentClassifier.normalized(request.userText)
        if normalized.contains("party") || normalized.contains("reservation")
            || normalized.contains("dine-in") || normalized.contains("takeout")
            || normalized.contains("dietary") || normalized.contains("spice")
            || normalized.contains("ambiance") || normalized.contains("neighborhood") {
            return true
        }
        if (normalized.contains("budget") || normalized.contains("price") || normalized.contains("cost"))
            && query.budget == nil
            && !containsAny(userText, ["budget", "price", "cost", "$", "人均", "总预算", "便宜", "价格"]) {
            return true
        }
        if (normalized.contains("time") || normalized.contains("open") || normalized.contains("lunch") || normalized.contains("dinner"))
            && query.temporalConstraint == nil
            && !containsAny(userText, ["tonight", "tomorrow", "open", "营业", "今晚", "明天", "中午", "早上", "下午", "关门"]) {
            return true
        }
        if (normalized.contains("current") || normalized.contains("approximate") || normalized.contains("reference point")
            || normalized.contains("distance"))
            && query.locationInput.kind != .unknown
            && !request.decision.requiresLocationPermission {
            return true
        }
        return false
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }

    private static func hasContradictoryBudget(in text: String) -> Bool {
        let normalized = LocalDiscoveryIntentClassifier.normalized(text)
        return (normalized.contains("人均") || normalized.contains("per person"))
            && (normalized.contains("总预算") || normalized.contains("total budget"))
    }

    private static func modelMadeParkingHardWithoutUserRequirement(draft: LocalDiscoveryPlaceQueryDraft,
                                                                   userText: String) -> Bool {
        let normalized = LocalDiscoveryIntentClassifier.normalized(userText)
        let userRequiresParking = normalized.contains("必须停车")
            || normalized.contains("一定要停车")
            || normalized.contains("parking required")
            || normalized.contains("must have parking")
        guard !userRequiresParking else { return false }
        return draft.hardConstraints.contains {
            $0.kind == PlaceConstraintKind.parkingPreference.rawValue
        }
    }
}
