import Foundation

public enum LocalDiscoveryRequestKind: String, Codable, Sendable, Hashable, CaseIterable {
    case localDiscovery
    case knownPlaceDetail
    case routeQuery
    case productStoreDiscovery
    case plainKnowledge
    case complexBrowserTask
    case unclear
}

public struct LocalDiscoveryIntentDecision: Codable, Sendable, Hashable {
    public var isLocalDiscovery: Bool
    public var confidence: Double
    public var requestedCategory: PlaceCategory?
    public var explicitLocation: String?
    public var requiresLocationPermission: Bool
    public var unsupportedRequirements: [String]
    public var routingReason: String
    public var requestKind: LocalDiscoveryRequestKind

    public init(isLocalDiscovery: Bool,
                confidence: Double,
                requestedCategory: PlaceCategory? = nil,
                explicitLocation: String? = nil,
                requiresLocationPermission: Bool = false,
                unsupportedRequirements: [String] = [],
                routingReason: String,
                requestKind: LocalDiscoveryRequestKind) {
        self.isLocalDiscovery = isLocalDiscovery
        self.confidence = min(1, max(0, confidence))
        self.requestedCategory = requestedCategory
        self.explicitLocation = explicitLocation.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.requiresLocationPermission = requiresLocationPermission
        self.unsupportedRequirements = unsupportedRequirements.map {
            AgentEventRedactor.safeIdentifier($0)
        }.sorted()
        self.routingReason = AgentPrivacyRedactor.safeText(routingReason, maxLength: 500).text
        self.requestKind = requestKind
    }
}

public struct LocalDiscoverySearchPolicy: Codable, Sendable, Hashable {
    public var defaultRadiusMeters: Double
    public var defaultCandidateCount: Int
    public var enrichmentCandidateCount: Int
    public var maximumExpansionRounds: Int
    public var maximumConcurrentReads: Int
    public var maximumExecutionDurationSeconds: Double
    public var maximumRouteCandidates: Int
    public var maximumTotalToolCalls: Int

    public init(defaultRadiusMeters: Double = 8_000,
                defaultCandidateCount: Int = 8,
                enrichmentCandidateCount: Int = 3,
                maximumExpansionRounds: Int = 1,
                maximumConcurrentReads: Int = 2,
                maximumExecutionDurationSeconds: Double = 60,
                maximumRouteCandidates: Int = 6,
                maximumTotalToolCalls: Int = 24) {
        self.defaultRadiusMeters = max(500, defaultRadiusMeters)
        self.defaultCandidateCount = min(max(1, defaultCandidateCount), 20)
        self.enrichmentCandidateCount = min(max(0, enrichmentCandidateCount), 8)
        self.maximumExpansionRounds = min(max(0, maximumExpansionRounds), 3)
        self.maximumConcurrentReads = min(max(1, maximumConcurrentReads), 4)
        self.maximumExecutionDurationSeconds = max(5, maximumExecutionDurationSeconds)
        self.maximumRouteCandidates = min(max(0, maximumRouteCandidates), 12)
        self.maximumTotalToolCalls = min(max(1, maximumTotalToolCalls), 60)
    }
}

public enum LocalDiscoveryPlanningStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case ready
    case requiresClarification
    case unsupported
    case notLocalDiscovery
}

public struct LocalDiscoveryPlannedQuery: Codable, Sendable, Hashable {
    public var status: LocalDiscoveryPlanningStatus
    public var query: PlaceQuery?
    public var assumptions: [String]
    public var missingInformation: [String]
    public var unsupportedRequirements: [String]
    public var repairAttempts: Int
    public var usedDeterministicFallback: Bool

    public init(status: LocalDiscoveryPlanningStatus,
                query: PlaceQuery? = nil,
                assumptions: [String] = [],
                missingInformation: [String] = [],
                unsupportedRequirements: [String] = [],
                repairAttempts: Int = 0,
                usedDeterministicFallback: Bool = true) {
        self.status = status
        self.query = query
        self.assumptions = assumptions.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.missingInformation = missingInformation.map { AgentPrivacyRedactor.safeText($0, maxLength: 300).text }
        self.unsupportedRequirements = unsupportedRequirements.map {
            AgentEventRedactor.safeIdentifier($0)
        }.sorted()
        self.repairAttempts = max(0, repairAttempts)
        self.usedDeterministicFallback = usedDeterministicFallback
    }
}

public enum LocalDiscoveryIntentClassifier {
    public static func classify(userText: String?,
                                context: ConversationIntentContext? = nil) -> LocalDiscoveryIntentDecision {
        guard let raw = userText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0,
                                                routingReason: "Empty user text",
                                                requestKind: .unclear)
        }
        let normalized = Self.normalized(raw)
        if isPlainKnowledge(normalized) {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0.92,
                                                routingReason: "Knowledge-question markers without a place-search goal",
                                                requestKind: .plainKnowledge)
        }
        if isRouteOnly(normalized) {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0.86,
                                                routingReason: "Route-only request should not enter place discovery",
                                                requestKind: .routeQuery)
        }
        if isKnownPlaceDetail(normalized) {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0.78,
                                                routingReason: "Known-place detail lookup is distinct from discovery",
                                                requestKind: .knownPlaceDetail)
        }
        if isComplexBrowserTask(normalized) {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0.74,
                                                routingReason: "Request needs browser-like cross-site interaction, not read-only local discovery",
                                                requestKind: .complexBrowserTask)
        }

        let category = category(in: normalized)
        let explicitLocation = explicitLocation(in: normalized)
        let nearby = mentionsNearby(normalized)
        let productStore = mentionsProductStore(normalized)
        let searchVerb = mentionsDiscoveryVerb(normalized)
        let unsupported = unsupportedRequirements(in: normalized, productStore: productStore)

        guard searchVerb || nearby || category != nil || productStore else {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0.2,
                                                routingReason: "No clear discovery verb, place category, or location constraint",
                                                requestKind: .unclear)
        }
        guard category != nil || productStore else {
            return LocalDiscoveryIntentDecision(isLocalDiscovery: false,
                                                confidence: 0.48,
                                                explicitLocation: explicitLocation,
                                                requiresLocationPermission: nearby && explicitLocation == nil,
                                                unsupportedRequirements: unsupported,
                                                routingReason: "Discovery phrasing is present but the category is ambiguous",
                                                requestKind: .unclear)
        }

        let resolvedCategory = category ?? .electronicsStore
        let confidence: Double = explicitLocation != nil || nearby ? 0.88 : 0.68
        return LocalDiscoveryIntentDecision(isLocalDiscovery: confidence >= 0.65,
                                            confidence: confidence,
                                            requestedCategory: resolvedCategory,
                                            explicitLocation: explicitLocation,
                                            requiresLocationPermission: nearby && explicitLocation == nil,
                                            unsupportedRequirements: unsupported,
                                            routingReason: explicitLocation == nil && nearby
                                                ? "Local discovery request with relative location requires approximate-location permission"
                                                : "Local discovery request has category and location semantics",
                                            requestKind: productStore ? .productStoreDiscovery : .localDiscovery)
    }

    public static func normalized(_ text: String) -> String {
        text
            .folding(options: [.diacriticInsensitive, .widthInsensitive, .caseInsensitive],
                     locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
    }

    private static func mentionsDiscoveryVerb(_ text: String) -> Bool {
        containsAny(text, ["找", "附近", "near", "around", "within", "recommend", "推荐", "search", "还有", "还能"])
    }

    private static func mentionsNearby(_ text: String) -> Bool {
        containsAny(text, ["附近", "near me", "nearby", "around me", "周边", "附近的", "附近可能"])
            || text.contains(" near ")
    }

    private static func mentionsProductStore(_ text: String) -> Bool {
        containsAny(text, ["usb-c", "usbc", "充电器", "charger", "笔记本充电", "卖"])
            && containsAny(text, ["店", "商店", "store", "retailer", "可能卖", "有售"])
    }

    private static func category(in text: String) -> PlaceCategory? {
        if containsAny(text, ["川菜", "sichuan", "四川菜"]) { return .sichuanRestaurant }
        if containsAny(text, ["中餐", "chinese restaurant", "中国菜"]) { return .chineseRestaurant }
        if containsAny(text, ["餐厅", "餐馆", "restaurant"]) { return .restaurant }
        if containsAny(text, ["高尔夫练习场", "练球", "driving range", "golf range"]) { return .golfDrivingRange }
        if containsAny(text, ["咖啡", "coffee", "cafe"]) { return PlaceCategory(rawValue: "coffee_shop") }
        if containsAny(text, ["药店", "pharmacy", "drugstore"]) { return PlaceCategory(rawValue: "pharmacy") }
        if mentionsProductStore(text) || containsAny(text, ["电子商店", "electronics store"]) { return .electronicsStore }
        if containsAny(text, ["商店", "store", "retailer"]) { return .retailStore }
        return nil
    }

    private static func explicitLocation(in text: String) -> String? {
        let known = [
            ("san francisco", "San Francisco, CA"),
            ("旧金山", "San Francisco, CA"),
            (" sf ", "San Francisco, CA"),
            ("san jose", "San Jose, CA"),
            ("圣何塞", "San Jose, CA"),
            ("ucla", "UCLA, Los Angeles, CA"),
            ("los angeles", "Los Angeles, CA"),
            ("洛杉矶", "Los Angeles, CA"),
        ]
        let padded = " \(text) "
        for (needle, label) in known where padded.contains(needle) {
            return label
        }
        if let range = padded.range(of: #"\b\d{5}(?:-\d{4})?\b"#, options: .regularExpression) {
            return String(padded[range]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private static func unsupportedRequirements(in text: String, productStore: Bool) -> [String] {
        var out: [String] = []
        if productStore || containsAny(text, ["库存", "现货", "in stock", "live inventory", "实时库存"]) {
            out.append("live_inventory")
        }
        if containsAny(text, ["预订", "订位", "购买", "下单", "book", "reserve", "buy"]) {
            out.append("read_only_action_dispatch")
        }
        return Array(Set(out)).sorted()
    }

    private static func isPlainKnowledge(_ text: String) -> Bool {
        containsAny(text, ["是什么", "为什么", "介绍一下", "history of", "what is", "explain"])
            && !mentionsDiscoveryVerb(text)
    }

    private static func isRouteOnly(_ text: String) -> Bool {
        containsAny(text, ["怎么去", "路线", "导航", "directions", "route from"])
            && !containsAny(text, ["找", "推荐", "discover", "附近"])
    }

    private static func isKnownPlaceDetail(_ text: String) -> Bool {
        containsAny(text, ["营业时间", "电话", "地址", "官网", "hours", "phone", "website"])
            && !containsAny(text, ["找", "附近", "推荐", "near", "around"])
    }

    private static func isComplexBrowserTask(_ text: String) -> Bool {
        containsAny(text, ["比较官网", "填表", "登录", "checkout", "browser", "打开网页操作"])
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }
}

public struct LocalDiscoveryQueryPlanner: Sendable {
    public var policy: LocalDiscoverySearchPolicy
    public var maxRepairAttempts: Int

    public init(policy: LocalDiscoverySearchPolicy = LocalDiscoverySearchPolicy(),
                maxRepairAttempts: Int = 1) {
        self.policy = policy
        self.maxRepairAttempts = max(0, maxRepairAttempts)
    }

    public func plan(userText: String,
                     decision: LocalDiscoveryIntentDecision,
                     conversationContext: ConversationIntentContext? = nil,
                     now: Date,
                     locale: Locale,
                     timeZone: TimeZone) -> LocalDiscoveryPlannedQuery {
        guard decision.isLocalDiscovery, decision.confidence >= 0.65 else {
            return LocalDiscoveryPlannedQuery(status: decision.confidence > 0.35 ? .requiresClarification : .notLocalDiscovery,
                                             missingInformation: decision.confidence > 0.35 ? ["需要明确要找的地点类别或位置"] : [],
                                             unsupportedRequirements: decision.unsupportedRequirements)
        }
        guard let category = decision.requestedCategory else {
            return LocalDiscoveryPlannedQuery(status: .requiresClarification,
                                             missingInformation: ["需要明确地点类别，例如餐馆、咖啡店、药店或练习场"],
                                             unsupportedRequirements: decision.unsupportedRequirements)
        }

        let normalized = LocalDiscoveryIntentClassifier.normalized(userText)
        var assumptions: [String] = []
        var missing: [String] = []
        let locationInput: PlaceLocationInput
        let effectiveTimeZone = Self.timeZone(forExplicitLocation: decision.explicitLocation) ?? timeZone

        if let explicit = decision.explicitLocation {
            locationInput = PlaceLocationInput(kind: .explicitRegion, label: explicit)
        } else if decision.requiresLocationPermission {
            locationInput = PlaceLocationInput(kind: .approximateCurrentLocation,
                                               label: "approximate current location")
            assumptions.append("“附近”按默认搜索半径 \(Int(policy.defaultRadiusMeters)) 米执行。")
        } else if let confirmed = conversationContext?.recentUserGoal, !confirmed.isEmpty {
            locationInput = PlaceLocationInput(kind: .explicitRegion, label: confirmed)
            assumptions.append("使用对话中已确认的位置上下文。")
        } else {
            locationInput = PlaceLocationInput(kind: .unknown)
            missing.append("请提供城市、邮编或附近地标。")
        }

        let temporal = Self.temporalConstraint(in: normalized, now: now, timeZone: effectiveTimeZone)
        var hard = [PlaceConstraint(id: "category-\(category.rawValue)",
                                    kind: .category,
                                    priority: .hard,
                                    value: .category(category))]
        if let temporal, temporal.openNow || temporal.targetDate != nil {
            hard.append(PlaceConstraint(id: "open-at",
                                        kind: temporal.openNow ? .openNow : .openAt,
                                        priority: .hard,
                                        value: temporal.targetDate.map(PlaceConstraintValue.date) ?? .bool(true)))
        }

        var soft: [PlaceConstraint] = []
        if Self.containsAny(normalized, ["停车", "parking"]) {
            let hardParking = Self.containsAny(normalized, ["必须停车", "一定要停车", "parking required", "must have parking"])
            let constraint = PlaceConstraint(id: "parking",
                                             kind: .parkingPreference,
                                             priority: hardParking ? .hard : .soft,
                                             value: .string("convenient parking"))
            if hardParking { hard.append(constraint) } else { soft.append(constraint) }
        }
        if Self.containsAny(normalized, ["越近越好", "closer", "nearer"]) {
            soft.append(PlaceConstraint(id: "distance-preference",
                                        kind: .distanceMaximum,
                                        priority: .soft,
                                        value: .string("prefer shorter distance")))
        }
        if Self.containsAny(normalized, ["便宜", "价格不要太高", "cheap", "not too expensive"]) {
            soft.append(PlaceConstraint(id: "price-preference",
                                        kind: .priceMaximum,
                                        priority: .soft,
                                        value: .string("prefer lower price")))
        }
        if Self.containsAny(normalized, ["关门比较晚", "营业到比较晚", "late", "open late"]) {
            soft.append(PlaceConstraint(id: "late-hours",
                                        kind: .keyword,
                                        priority: .soft,
                                        value: .string("open late")))
        }

        let budget = Self.budget(in: normalized)
        if let budget, let maximum = budget.maximumAmount {
            hard.append(PlaceConstraint(id: budget.perPerson ? "budget-per-person" : "budget-total",
                                        kind: .priceMaximum,
                                        priority: .hard,
                                        value: .number(maximum)))
        } else if Self.containsAny(normalized, ["$$"]) {
            soft.append(PlaceConstraint(id: "price-level",
                                        kind: .priceMaximum,
                                        priority: .soft,
                                        value: .string("around $$")))
        }

        let travelLimit = Self.travelLimit(in: normalized)
        if let distance = travelLimit?.maximumDistanceMeters {
            hard.append(PlaceConstraint(id: "distance-limit",
                                        kind: .distanceMaximum,
                                        priority: .hard,
                                        value: .distance(PlaceDistance(meters: distance,
                                                                      kind: .route,
                                                                      source: "query"))))
        }
        if let seconds = travelLimit?.maximumTravelTimeSeconds {
            hard.append(PlaceConstraint(id: "travel-time-limit",
                                        kind: .travelTimeMaximum,
                                        priority: .hard,
                                        value: .durationMinutes(seconds / 60)))
        }

        if decision.unsupportedRequirements.contains("live_inventory") {
            assumptions.append("只能验证商店或地点类别，不能证明实时库存。")
        }

        let query = PlaceQuery(queryID: "local-discovery-\(UUID().uuidString)",
                               rawUserIntent: userText,
                               searchText: Self.searchText(category: category, normalized: normalized),
                               category: category,
                               locationInput: locationInput,
                               temporalConstraint: temporal,
                               hardConstraints: hard,
                               softPreferences: soft,
                               budget: budget,
                               travelLimit: travelLimit,
                               resultLimit: policy.defaultCandidateCount,
                               locale: locale.identifier,
                               timezone: effectiveTimeZone.identifier,
                               createdAt: now)

        if !missing.isEmpty {
            return LocalDiscoveryPlannedQuery(status: .requiresClarification,
                                             query: query,
                                             assumptions: assumptions,
                                             missingInformation: missing,
                                             unsupportedRequirements: decision.unsupportedRequirements)
        }
        return LocalDiscoveryPlannedQuery(status: .ready,
                                         query: query,
                                         assumptions: assumptions,
                                         missingInformation: missing,
                                         unsupportedRequirements: decision.unsupportedRequirements)
    }

    private static func temporalConstraint(in text: String, now: Date, timeZone: TimeZone) -> PlaceTemporalConstraint? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if containsAny(text, ["现在", "此刻", "open now", "right now"]) {
            return PlaceTemporalConstraint(targetDate: now, openNow: true, description: "now")
        }
        if containsAny(text, ["今晚", "tonight", "还营业", "还能练球"]) {
            let hour = containsAny(text, ["关门比较晚", "营业到比较晚", "late"]) ? 21 : 20
            let target = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: now) ?? now
            return PlaceTemporalConstraint(targetDate: target, openNow: false, description: "tonight")
        }
        if containsAny(text, ["明天早上", "tomorrow morning"]) {
            let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
            let target = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
            return PlaceTemporalConstraint(targetDate: target, openNow: false, description: "tomorrow morning")
        }
        if containsAny(text, ["中午", "noon", "lunch"]) {
            let target = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: now) ?? now
            return PlaceTemporalConstraint(targetDate: target, openNow: false, description: "noon")
        }
        if containsAny(text, ["周六下午", "saturday afternoon"]) {
            let target = nextWeekday(7, hour: 15, now: now, calendar: calendar)
            return PlaceTemporalConstraint(targetDate: target, openNow: false, description: "Saturday afternoon")
        }
        if containsAny(text, ["凌晨", "after midnight"]) {
            let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
            let target = calendar.date(bySettingHour: 0, minute: 30, second: 0, of: tomorrow) ?? tomorrow
            return PlaceTemporalConstraint(targetDate: target, openNow: false, description: "after midnight")
        }
        return nil
    }

    private static func nextWeekday(_ weekday: Int, hour: Int, now: Date, calendar: Calendar) -> Date {
        var components = DateComponents()
        components.weekday = weekday
        components.hour = hour
        components.minute = 0
        components.second = 0
        return calendar.nextDate(after: now, matching: components, matchingPolicy: .nextTimePreservingSmallerComponents) ?? now
    }

    private static func budget(in text: String) -> PlaceBudget? {
        guard let amount = firstDollarAmount(in: text) else { return nil }
        let perPerson = containsAny(text, ["人均", "per person", "per-person", "each"])
        let total = containsAny(text, ["总预算", "total budget"])
        return PlaceBudget(maximumAmount: amount, currencyCode: "USD", perPerson: perPerson || !total)
    }

    private static func travelLimit(in text: String) -> PlaceTravelLimit? {
        if let minutes = firstNumber(beforeAnyOf: ["分钟", "minutes", "min"], in: text),
           containsAny(text, ["开车", "driv", "步行", "walk"]) {
            let mode: PlaceTransportMode = containsAny(text, ["步行", "walk"]) ? .walking : .automobile
            return PlaceTravelLimit(maximumTravelTimeSeconds: minutes * 60, transportMode: mode)
        }
        if let miles = firstNumber(beforeAnyOf: ["英里", "miles", "mile"], in: text) {
            return PlaceTravelLimit(maximumDistanceMeters: miles * 1_609.34, transportMode: .automobile)
        }
        if let km = firstNumber(beforeAnyOf: ["公里", "km"], in: text) {
            return PlaceTravelLimit(maximumDistanceMeters: km * 1_000, transportMode: .automobile)
        }
        return nil
    }

    private static func firstDollarAmount(in text: String) -> Double? {
        if let range = text.range(of: #"(\$|usd|美元)\s*\d+(?:\.\d+)?"#, options: .regularExpression) {
            let raw = String(text[range])
            return firstNumber(in: raw)
        }
        if let range = text.range(of: #"\d+(?:\.\d+)?\s*(美元|usd|dollars)"#, options: .regularExpression) {
            let raw = String(text[range])
            return firstNumber(in: raw)
        }
        return nil
    }

    private static func firstNumber(beforeAnyOf units: [String], in text: String) -> Double? {
        for unit in units {
            if let range = text.range(of: #"\d+(?:\.\d+)?\s*"# + NSRegularExpression.escapedPattern(for: unit),
                                      options: .regularExpression) {
                return firstNumber(in: String(text[range]))
            }
        }
        return nil
    }

    private static func firstNumber(in text: String) -> Double? {
        guard let range = text.range(of: #"\d+(?:\.\d+)?"#, options: .regularExpression) else { return nil }
        return Double(text[range])
    }

    private static func searchText(category: PlaceCategory, normalized: String) -> String {
        switch category.rawValue {
        case PlaceCategory.sichuanRestaurant.rawValue:
            return "Sichuan restaurant"
        case PlaceCategory.chineseRestaurant.rawValue:
            return "Chinese restaurant"
        case PlaceCategory.golfDrivingRange.rawValue:
            return "golf driving range"
        case PlaceCategory.electronicsStore.rawValue:
            return containsAny(normalized, ["usb-c", "usbc", "充电器"]) ? "electronics store USB-C charger" : "electronics store"
        case "coffee_shop":
            return "coffee shop"
        case "pharmacy":
            return "pharmacy"
        default:
            return category.rawValue.replacingOccurrences(of: "_", with: " ")
        }
    }

    private static func timeZone(forExplicitLocation location: String?) -> TimeZone? {
        guard let location = location?.lowercased() else { return nil }
        if location.contains("san francisco") || location.contains("san jose") || location.contains("ucla")
            || location.contains("los angeles") {
            return TimeZone(identifier: "America/Los_Angeles")
        }
        return nil
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }
}

public enum LocalDiscoveryVerifierVerdict: String, Codable, Sendable, Hashable, CaseIterable {
    case pass
    case partialPass
    case repairRequired
    case fail
}

public struct LocalDiscoveryVerifierReport: Codable, Sendable, Hashable {
    public var verdict: LocalDiscoveryVerifierVerdict
    public var issues: [AgentResultValidationIssue]

    public init(verdict: LocalDiscoveryVerifierVerdict,
                issues: [AgentResultValidationIssue] = []) {
        self.verdict = verdict
        self.issues = issues
    }
}

public enum LocalDiscoveryWorkflowVerifier {
    public static func verify(originalRequest: String,
                              plannedQuery: LocalDiscoveryPlannedQuery,
                              result: LocalDiscoveryResult) -> LocalDiscoveryVerifierReport {
        var issues: [AgentResultValidationIssue] = []
        guard let query = plannedQuery.query else {
            return LocalDiscoveryVerifierReport(verdict: .repairRequired,
                                                issues: [.init(path: "$.query", message: "missing planned PlaceQuery")])
        }
        if !PlaceNormalizer.normalizedName(originalRequest).contains(PlaceNormalizer.normalizedName(query.searchText).split(separator: " ").first.map(String.init) ?? "") {
            issues.append(.init(path: "$.query.searchText", message: "PlaceQuery search text may not reflect original user request"))
        }
        if !result.missingEvidenceReferenceIDs().isEmpty {
            issues.append(.init(path: "$.evidence", message: "candidate references missing evidence records"))
        }
        for candidate in result.candidates {
            // P18.4 — PAR-028: rationale substring matching was dead code in
            // production (the workflow-generated rationale never contains the
            // probed substrings), but kept it defensible via whole-word matching
            // so that any future rationale source cannot accidentally trigger
            // via substring overlap (e.g. "openable", "reopen", "in stockroom").
            if let rationale = candidate.recommendationRationale?.lowercased() {
                if LocalDiscoveryValidator.containsWord(rationale, "open")
                    && candidate.openingStatus.value != .open {
                    issues.append(.init(path: "$.candidates.\(candidate.stableID).openingStatus",
                                        message: "recommendation overclaims opening status"))
                }
                if LocalDiscoveryValidator.containsWord(rationale, "driving")
                    || rationale.contains("开车") {
                    if candidate.travelEstimate?.routeDistance == nil,
                       candidate.travelEstimate?.straightLineDistance != nil {
                        issues.append(.init(path: "$.candidates.\(candidate.stableID).travelEstimate",
                                            message: "straight-line distance cannot be presented as driving distance"))
                    }
                }
                if LocalDiscoveryValidator.containsWord(rationale, "in stock")
                    || rationale.contains("有货") || rationale.contains("现货") {
                    issues.append(.init(path: "$.candidates.\(candidate.stableID).inventory",
                                        message: "live inventory cannot be verified by local discovery evidence"))
                }
            }
        }
        let hasBlocking = result.findings.contains { $0.severity == .blocking && $0.status == .failed }
        if issues.isEmpty && !hasBlocking { return LocalDiscoveryVerifierReport(verdict: .pass) }
        if issues.contains(where: { $0.message.contains("overclaims") || $0.message.contains("cannot be presented") }) {
            return LocalDiscoveryVerifierReport(verdict: .repairRequired, issues: issues)
        }
        return LocalDiscoveryVerifierReport(verdict: result.candidates.isEmpty ? .fail : .partialPass,
                                            issues: issues)
    }
}
