import CryptoKit
import Foundation

public typealias AgentTaskID = UUID
public typealias AgentRunID = UUID
public typealias PlaceHandoffRequestID = String
public typealias PlaceHandoffAttemptID = String

public enum PlaceHandoffActionKind: String, Codable, Sendable, CaseIterable, Hashable {
    case openInMaps = "place.openInMaps"
    case openDirections = "place.openDirections"
    case openOfficialWebsite = "place.openOfficialWebsite"
    case startPhoneHandoff = "place.startPhoneHandoff"

    public var confirmTitle: String {
        switch self {
        case .openInMaps: return "在地图中打开"
        case .openDirections: return "查看路线"
        case .openOfficialWebsite: return "打开网站"
        case .startPhoneHandoff: return "拨打电话"
        }
    }

    public var compactTitle: String {
        switch self {
        case .openInMaps: return "地图"
        case .openDirections: return "路线"
        case .openOfficialWebsite: return "官网"
        case .startPhoneHandoff: return "电话"
        }
    }

    public var systemImageName: String {
        switch self {
        case .openInMaps: return "map"
        case .openDirections: return "arrow.triangle.turn.up.right.diamond"
        case .openOfficialWebsite: return "safari"
        case .startPhoneHandoff: return "phone"
        }
    }

    public var requiredCapabilityID: String { rawValue }
}

public enum PlaceActionEvidenceState: String, Codable, Sendable, Hashable, CaseIterable {
    case confirmed
    case supported
    case partial
    case stale
    case conflicting
    case unknown

    public var userLabel: String {
        switch self {
        case .confirmed: return "已确认"
        case .supported: return "有来源支持"
        case .partial: return "尚未完全确认"
        case .stale: return "来源可能过期"
        case .conflicting: return "来源不一致"
        case .unknown: return "来源未知"
        }
    }
}

public enum WebsiteClassification: String, Codable, Sendable, Hashable, CaseIterable {
    case official
    case canonical
    case directory
    case evidenceSource
    case unknown

    public var isOfficial: Bool {
        self == .official || self == .canonical
    }

    public var userLabel: String {
        switch self {
        case .official: return "商户官网"
        case .canonical: return "商户官网，已验证"
        case .directory: return "信息来源"
        case .evidenceSource: return "证据来源"
        case .unknown: return "未知网站"
        }
    }
}

public enum DirectionsOrigin: Codable, Sendable, Hashable {
    case currentLocation(PlaceHandoffLocationAccuracy)
    case lastKnownLocation(label: String, coordinate: PlaceCoordinate?, capturedAt: Date?)
    case userEnteredAddress(String)
    case none

    public var userLabel: String {
        switch self {
        case .currentLocation: return "当前位置"
        case .lastKnownLocation(let label, _, _):
            return label.isEmpty ? "上次位置" : label
        case .userEnteredAddress(let address):
            return address.isEmpty ? "手动输入起点" : address
        case .none:
            return "起点待选择"
        }
    }
}

public enum PlaceHandoffLocationAccuracy: String, Codable, Sendable, Hashable, CaseIterable {
    case preciseCurrentLocation
    case approximateCurrentLocation

    public var userLabel: String {
        switch self {
        case .preciseCurrentLocation: return "精确当前位置"
        case .approximateCurrentLocation: return "大致当前位置"
        }
    }
}

public enum PlaceHandoffDestination: Equatable, Sendable {
    case mapPlace(name: String, coordinate: PlaceCoordinate?, postalAddress: String?)
    case directions(destinationName: String,
                    destinationCoordinate: PlaceCoordinate?,
                    destinationAddress: String?,
                    origin: DirectionsOrigin)
    case website(url: URL, classification: WebsiteClassification)
    case phone(normalizedNumber: String, displayNumber: String)

    public var auditSummary: String {
        switch self {
        case .mapPlace(let name, let coordinate, let postalAddress):
            return [
                "mapPlace",
                "name=\(AgentPrivacyRedactor.safeIdentifier(name, fallback: "place"))",
                coordinate.map { "coordinate=\(PlaceHandoffAuditSanitizer.coordinateSummary($0))" },
                postalAddress.map { "address=\(AgentPrivacyRedactor.safeSummary($0, fallback: "address"))" },
            ].compactMap { $0 }.joined(separator: " ")
        case .directions(let name, let coordinate, let address, let origin):
            return [
                "directions",
                "destination=\(AgentPrivacyRedactor.safeIdentifier(name, fallback: "place"))",
                coordinate.map { "coordinate=\(PlaceHandoffAuditSanitizer.coordinateSummary($0))" },
                address.map { "address=\(AgentPrivacyRedactor.safeSummary($0, fallback: "address"))" },
                "origin=\(PlaceHandoffAuditSanitizer.originSummary(origin))",
            ].compactMap { $0 }.joined(separator: " ")
        case .website(let url, let classification):
            return "website classification=\(classification.rawValue) url=\(PlaceHandoffAuditSanitizer.urlSummary(url))"
        case .phone(let normalizedNumber, _):
            return "phone \(PlaceHandoffAuditSanitizer.phoneSummary(normalizedNumber))"
        }
    }
}

public struct PlaceHandoffRequest: Equatable, Sendable {
    public let requestID: PlaceHandoffRequestID
    public let taskID: AgentTaskID
    public let runID: AgentRunID?
    public let candidateID: LocalDiscoveryCandidateID
    public let action: PlaceHandoffActionKind
    public let destination: PlaceHandoffDestination
    public let evidenceState: PlaceActionEvidenceState
    public let requestedAt: Date

    public init(requestID: PlaceHandoffRequestID,
                taskID: AgentTaskID,
                runID: AgentRunID?,
                candidateID: LocalDiscoveryCandidateID,
                action: PlaceHandoffActionKind,
                destination: PlaceHandoffDestination,
                evidenceState: PlaceActionEvidenceState,
                requestedAt: Date) {
        self.requestID = AgentPrivacyRedactor.safeIdentifier(requestID, fallback: "place_handoff_request")
        self.taskID = taskID
        self.runID = runID
        self.candidateID = AgentEventRedactor.safeIdentifier(candidateID)
        self.action = action
        self.destination = destination
        self.evidenceState = evidenceState
        self.requestedAt = requestedAt
    }
}

public enum PlaceHandoffBlockingReason: String, Codable, Sendable, Hashable, CaseIterable {
    case candidateNoLongerPresent
    case invalidCandidateIdentity
    case missingMapDestination
    case invalidCoordinate
    case coordinateAddressConflict
    case regionCenterOnly
    case missingDirectionsDestination
    case missingDirectionsOrigin
    case locationPermissionDenied
    case staleOrigin
    case websiteMissing
    case websiteNotOfficial
    case websiteConflict
    case urlParseFailed
    case urlSchemeNotAllowed
    case urlHostMissing
    case urlCredentialsRejected
    case urlControlCharacters
    case urlTooLong
    case phoneMissing
    case phoneConflict
    case phoneInvalid
    case phoneUSSDRejected
    case phonePauseWaitRejected
    case phoneHandlerUnavailable
    case handlerUnavailable
    case unsupportedByReleasePolicy
    case dataCorrupted

    public var userMessage: String {
        switch self {
        case .candidateNoLongerPresent: return "该地点已不在当前结果中"
        case .invalidCandidateIdentity: return "地点标识无效"
        case .missingMapDestination: return "没有可用于地图的坐标或地址"
        case .invalidCoordinate: return "地点坐标无效"
        case .coordinateAddressConflict: return "地点坐标与地址来源不一致"
        case .regionCenterOnly: return "只有区域中心点，不能当作商户地点"
        case .missingDirectionsDestination: return "没有可用于路线的终点"
        case .missingDirectionsOrigin: return "还没有明确的路线起点"
        case .locationPermissionDenied: return "当前位置权限不可用或被拒绝"
        case .staleOrigin: return "起点位置可能已过期"
        case .websiteMissing: return "未找到经过确认的官网"
        case .websiteNotOfficial: return "该链接不是经过确认的官网"
        case .websiteConflict: return "官网来源存在冲突"
        case .urlParseFailed: return "网站地址无法解析"
        case .urlSchemeNotAllowed: return "网站地址协议不允许"
        case .urlHostMissing: return "网站地址缺少主机名"
        case .urlCredentialsRejected: return "网站地址包含用户名或密码"
        case .urlControlCharacters: return "网站地址包含不可见控制字符"
        case .urlTooLong: return "网站地址过长"
        case .phoneMissing: return "没有可用电话号码"
        case .phoneConflict: return "电话号码来源存在冲突"
        case .phoneInvalid: return "电话号码格式不可用"
        case .phoneUSSDRejected: return "不支持拨打 USSD 或服务代码"
        case .phonePauseWaitRejected: return "电话号码包含自动等待或暂停拨号指令"
        case .phoneHandlerUnavailable: return "此 Mac 没有可用的电话处理程序"
        case .handlerUnavailable: return "当前没有可用的系统处理程序"
        case .unsupportedByReleasePolicy: return "此 Mac 当前未启用电话操作"
        case .dataCorrupted: return "地点数据损坏，无法安全执行操作"
        }
    }
}

public enum PlaceHandoffWarning: String, Codable, Sendable, Hashable, CaseIterable {
    case partialEvidence
    case staleEvidence
    case unconfirmedWebsite
    case httpURL
    case unicodeHost
    case punycodeHost
    case suspiciousPort
    case redirectorURL
    case trackingQueryRemovedFromAudit
    case approximateCurrentLocation
    case lastKnownLocation
    case phoneExtensionRequiresManualEntry
    case vanityPhoneNumberNormalized
    case partialCoordinate

    public var userMessage: String {
        switch self {
        case .partialEvidence: return "来源尚未完全确认"
        case .staleEvidence: return "来源可能已过期"
        case .unconfirmedWebsite: return "官网来源尚未完全确认"
        case .httpURL: return "网站不是 HTTPS"
        case .unicodeHost: return "网站域名包含 Unicode 字符，请确认目标"
        case .punycodeHost: return "网站域名使用 Punycode，请确认目标"
        case .suspiciousPort: return "网站使用非常见端口"
        case .redirectorURL: return "网站看起来可能是跳转链接"
        case .trackingQueryRemovedFromAudit: return "审计记录会移除查询参数"
        case .approximateCurrentLocation: return "路线起点只会交给系统地图为“当前位置”，DeskPet 不记录精确坐标"
        case .lastKnownLocation: return "起点是上次位置，可能不是实时位置"
        case .phoneExtensionRequiresManualEntry: return "分机号不会自动拨出，通话后需手动输入"
        case .vanityPhoneNumberNormalized: return "字母电话号码已转换为数字"
        case .partialCoordinate: return "坐标精度较低，将附带提示"
        }
    }
}

public struct PlaceHandoffEligibility: Codable, Equatable, Sendable, Hashable, Error {
    public let isAvailable: Bool
    public let requiresConfirmation: Bool
    public let blockingReasons: [PlaceHandoffBlockingReason]
    public let warnings: [PlaceHandoffWarning]
    public let releaseSupport: PlaceHandoffReleaseSupport

    public init(isAvailable: Bool,
                requiresConfirmation: Bool = true,
                blockingReasons: [PlaceHandoffBlockingReason] = [],
                warnings: [PlaceHandoffWarning] = [],
                releaseSupport: PlaceHandoffReleaseSupport = .supported) {
        self.isAvailable = isAvailable
        self.requiresConfirmation = requiresConfirmation
        self.blockingReasons = Array(Set(blockingReasons)).sorted { $0.rawValue < $1.rawValue }
        self.warnings = Array(Set(warnings)).sorted { $0.rawValue < $1.rawValue }
        self.releaseSupport = releaseSupport
    }

    public static func allowed(warnings: [PlaceHandoffWarning] = []) -> PlaceHandoffEligibility {
        PlaceHandoffEligibility(isAvailable: true, warnings: warnings)
    }

    public static func blocked(_ reasons: [PlaceHandoffBlockingReason],
                               warnings: [PlaceHandoffWarning] = []) -> PlaceHandoffEligibility {
        PlaceHandoffEligibility(isAvailable: false, blockingReasons: reasons, warnings: warnings)
    }

    public var primaryUserExplanation: String? {
        if case .unavailable(let reason) = releaseSupport {
            return reason.userMessage
        }
        return blockingReasons.first?.userMessage ?? warnings.first?.userMessage
    }

    public var accessibilityHint: String? {
        if case .unavailable(let reason) = releaseSupport {
            return reason.accessibilityHint
        }
        return primaryUserExplanation
    }

    public func applyingReleaseSupport(_ evaluation: PlaceHandoffReleaseSupportEvaluation) -> PlaceHandoffEligibility {
        guard isAvailable else {
            return PlaceHandoffEligibility(isAvailable: false,
                                           requiresConfirmation: requiresConfirmation,
                                           blockingReasons: blockingReasons,
                                           warnings: warnings,
                                           releaseSupport: releaseSupport)
        }
        guard !evaluation.support.allowsDispatch else {
            return PlaceHandoffEligibility(isAvailable: isAvailable,
                                           requiresConfirmation: requiresConfirmation,
                                           blockingReasons: blockingReasons,
                                           warnings: warnings,
                                           releaseSupport: evaluation.support)
        }
        let reason = evaluation.support.reason ?? .destinationValidationFailed
        let policyBlock = reason.blockingReason(for: evaluation.action)
        return PlaceHandoffEligibility(isAvailable: false,
                                       requiresConfirmation: requiresConfirmation,
                                       blockingReasons: blockingReasons + [policyBlock],
                                       warnings: warnings,
                                       releaseSupport: evaluation.support)
    }
}

public struct PlaceHandoffCandidateContext: Codable, Sendable, Hashable {
    public var taskID: AgentTaskID
    public var runID: AgentRunID?
    public var candidateID: LocalDiscoveryCandidateID
    public var name: String
    public var address: PlaceAddress?
    public var coordinate: PlaceCoordinate?
    public var contact: PlaceContact
    public var webLinks: [PlaceWebLink]
    public var evidenceReferences: [PlaceEvidenceReference]
    public var verificationStatus: PlaceVerificationStatus
    public var freshness: String
    public var findings: [PlaceVerificationFinding]
    public var directionsOrigin: DirectionsOrigin
    public var isPresentInCurrentPresentation: Bool

    public init(taskID: AgentTaskID,
                runID: AgentRunID?,
                candidateID: LocalDiscoveryCandidateID,
                name: String,
                address: PlaceAddress?,
                coordinate: PlaceCoordinate?,
                contact: PlaceContact,
                webLinks: [PlaceWebLink],
                evidenceReferences: [PlaceEvidenceReference],
                verificationStatus: PlaceVerificationStatus,
                freshness: String,
                findings: [PlaceVerificationFinding],
                directionsOrigin: DirectionsOrigin = .currentLocation(.approximateCurrentLocation),
                isPresentInCurrentPresentation: Bool = true) {
        self.taskID = taskID
        self.runID = runID
        self.candidateID = AgentEventRedactor.safeIdentifier(candidateID)
        self.name = AgentPrivacyRedactor.safeSummary(name, fallback: "地点")
        self.address = address
        self.coordinate = coordinate
        self.contact = contact
        self.webLinks = webLinks
        self.evidenceReferences = evidenceReferences
        self.verificationStatus = verificationStatus
        self.freshness = AgentPrivacyRedactor.safeSummary(freshness, fallback: "unknown")
        self.findings = findings
        self.directionsOrigin = directionsOrigin
        self.isPresentInCurrentPresentation = isPresentInCurrentPresentation
    }
}

public struct PlaceHandoffActionPresentation: Codable, Sendable, Hashable, Identifiable {
    public var id: String { action.rawValue }
    public var action: PlaceHandoffActionKind
    public var title: String
    public var compactTitle: String
    public var systemImageName: String
    public var eligibility: PlaceHandoffEligibility
    public var releaseSupport: PlaceHandoffReleaseSupport
    public var accessibilityLabel: String
    public var accessibilityHint: String

    public init(action: PlaceHandoffActionKind,
                eligibility: PlaceHandoffEligibility) {
        self.action = action
        self.title = action.confirmTitle
        self.compactTitle = action.compactTitle
        self.systemImageName = action.systemImageName
        self.eligibility = eligibility
        self.releaseSupport = eligibility.releaseSupport
        self.accessibilityLabel = action.confirmTitle
        self.accessibilityHint = eligibility.accessibilityHint ?? "需要点击后预览并确认"
    }
}

public struct PlaceHandoffURLValidationResult: Equatable, Sendable {
    public var url: URL?
    public var classification: WebsiteClassification
    public var blockingReasons: [PlaceHandoffBlockingReason]
    public var warnings: [PlaceHandoffWarning]
    public var displayHost: String?
    public var sanitizedAuditSummary: String?
}

public enum PlaceHandoffURLValidator {
    private static let allowedSchemes: Set<String> = ["https", "http"]
    private static let sensitiveQueryNames: Set<String> = [
        "token", "access_token", "auth", "authorization", "apikey", "api_key", "key",
        "password", "session", "cookie", "signature", "sig",
    ]

    public static func validate(_ rawURL: String,
                                classification: WebsiteClassification) -> PlaceHandoffURLValidationResult {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        var warnings: [PlaceHandoffWarning] = []
        var blocks: [PlaceHandoffBlockingReason] = []

        guard !trimmed.isEmpty else {
            return result(nil, classification, [.websiteMissing], warnings)
        }
        if trimmed.count > 2_048 {
            blocks.append(.urlTooLong)
        }
        if trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            blocks.append(.urlControlCharacters)
        }
        if trimmed.unicodeScalars.contains(where: { !$0.isASCII }) {
            warnings.append(.unicodeHost)
        }
        if trimmed.lowercased().contains("xn--") {
            warnings.append(.punycodeHost)
        }
        if let decodedPrefix = trimmed.prefix(80).removingPercentEncoding,
           decodedPrefix.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#,
                               options: .regularExpression) != nil,
           let scheme = decodedPrefix.split(separator: ":", maxSplits: 1).first?.lowercased(),
           !allowedSchemes.contains(String(scheme)) {
            blocks.append(.urlSchemeNotAllowed)
        }

        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let url = components.url else {
            return result(nil, classification, blocks + [.urlParseFailed], warnings)
        }
        guard allowedSchemes.contains(scheme) else {
            return result(nil, classification, blocks + [.urlSchemeNotAllowed], warnings)
        }
        guard let host = components.host, !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return result(nil, classification, blocks + [.urlHostMissing], warnings)
        }
        if components.user != nil || components.password != nil {
            blocks.append(.urlCredentialsRejected)
        }
        if scheme == "http" {
            warnings.append(.httpURL)
        }
        if let port = components.port,
           !((scheme == "https" && port == 443) || (scheme == "http" && port == 80)) {
            warnings.append(.suspiciousPort)
        }
        if host.unicodeScalars.contains(where: { !$0.isASCII }) {
            warnings.append(.unicodeHost)
        }
        if host.lowercased().contains("xn--") {
            warnings.append(.punycodeHost)
        }
        if looksLikeRedirector(host: host, path: components.percentEncodedPath, query: components.percentEncodedQuery) {
            warnings.append(.redirectorURL)
        }
        if hasSensitiveOrTrackingQuery(components.percentEncodedQuery) {
            warnings.append(.trackingQueryRemovedFromAudit)
        }
        return result(blocks.isEmpty ? url : nil,
                      classification,
                      blocks,
                      warnings,
                      displayHost: host,
                      sanitizedAuditSummary: PlaceHandoffAuditSanitizer.urlSummary(url))
    }

    private static func result(_ url: URL?,
                               _ classification: WebsiteClassification,
                               _ blocks: [PlaceHandoffBlockingReason],
                               _ warnings: [PlaceHandoffWarning],
                               displayHost: String? = nil,
                               sanitizedAuditSummary: String? = nil) -> PlaceHandoffURLValidationResult {
        PlaceHandoffURLValidationResult(url: url,
                                        classification: classification,
                                        blockingReasons: Array(Set(blocks)).sorted { $0.rawValue < $1.rawValue },
                                        warnings: Array(Set(warnings)).sorted { $0.rawValue < $1.rawValue },
                                        displayHost: displayHost,
                                        sanitizedAuditSummary: sanitizedAuditSummary)
    }

    private static func looksLikeRedirector(host: String, path: String, query: String?) -> Bool {
        let lowered = ([host, path, query ?? ""]).joined(separator: " ").lowercased()
        return lowered.contains("redirect")
            || lowered.contains("redir")
            || lowered.contains("url=")
            || lowered.contains("u=")
            || lowered.contains("target=")
    }

    private static func hasSensitiveOrTrackingQuery(_ query: String?) -> Bool {
        guard let query, !query.isEmpty else { return false }
        let names = query
            .split(separator: "&")
            .compactMap { $0.split(separator: "=", maxSplits: 1).first?.lowercased() }
        return names.contains { name in
            sensitiveQueryNames.contains(String(name)) || name.hasPrefix("utm_")
        }
    }
}

public struct PlacePhoneValidationResult: Equatable, Sendable {
    public var normalizedNumber: String?
    public var displayNumber: String?
    public var blockingReasons: [PlaceHandoffBlockingReason]
    public var warnings: [PlaceHandoffWarning]
}

public enum PlacePhoneNumberValidator {
    private static let vanityMap: [Character: Character] = [
        "A": "2", "B": "2", "C": "2",
        "D": "3", "E": "3", "F": "3",
        "G": "4", "H": "4", "I": "4",
        "J": "5", "K": "5", "L": "5",
        "M": "6", "N": "6", "O": "6",
        "P": "7", "Q": "7", "R": "7", "S": "7",
        "T": "8", "U": "8", "V": "8",
        "W": "9", "X": "9", "Y": "9", "Z": "9",
    ]

    public static func validate(rawNumber: String?,
                                displayNumber: String? = nil,
                                defaultRegionCode: String = "US") -> PlacePhoneValidationResult {
        guard var raw = rawNumber?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return result(nil, nil, [.phoneMissing], [])
        }
        if raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            return result(nil, nil, [.phoneInvalid], [])
        }
        let lowered = raw.lowercased()
        if lowered.hasPrefix("tel:") || lowered.hasPrefix("telprompt:") || lowered.contains("://") {
            return result(nil, nil, [.phoneInvalid], [])
        }
        if lowered.contains("<script") || lowered.contains("javascript:") {
            return result(nil, nil, [.phoneInvalid], [])
        }
        if raw.contains("*") || raw.contains("#") {
            return result(nil, nil, [.phoneUSSDRejected], [])
        }
        if raw.contains(",") || raw.contains(";") {
            return result(nil, nil, [.phonePauseWaitRejected], [])
        }

        var warnings: [PlaceHandoffWarning] = []
        if let range = raw.range(of: #"(?i)\s*(?:ext\.?|extension|x)\s*\d{1,8}\s*$"#, options: .regularExpression) {
            raw.removeSubrange(range)
            warnings.append(.phoneExtensionRequiresManualEntry)
        }

        var hadVanityLetters = false
        let converted = raw.map { character -> Character? in
            if character.isNumber { return character }
            if character == "+" { return character }
            if let mapped = vanityMap[Character(character.uppercased())] {
                hadVanityLetters = true
                return mapped
            }
            if " ()-. ".contains(character) { return nil }
            return "\u{0}"
        }
        if converted.contains("\u{0}") {
            return result(nil, nil, [.phoneInvalid], warnings)
        }
        if hadVanityLetters {
            warnings.append(.vanityPhoneNumberNormalized)
        }
        let compact = String(converted.compactMap { $0 == nil ? nil : $0 })
        let hasPlus = compact.hasPrefix("+")
        let digits = compact.filter(\.isNumber)
        guard (7...15).contains(digits.count) else {
            return result(nil, nil, [.phoneInvalid], warnings)
        }
        let normalized: String
        if hasPlus {
            normalized = "+\(digits)"
        } else if defaultRegionCode.uppercased() == "US", digits.count == 10 {
            normalized = "+1\(digits)"
        } else if defaultRegionCode.uppercased() == "US", digits.count == 11, digits.hasPrefix("1") {
            normalized = "+\(digits)"
        } else {
            normalized = digits
        }
        guard normalized.count <= 16 else {
            return result(nil, nil, [.phoneInvalid], warnings)
        }
        let display = displayNumber?.trimmingCharacters(in: .whitespacesAndNewlines)
        return result(normalized,
                      AgentPrivacyRedactor.safeSummary(display?.isEmpty == false ? display! : normalized,
                                                       fallback: "电话号码"),
                      [],
                      warnings)
    }

    private static func result(_ normalized: String?,
                               _ display: String?,
                               _ blocks: [PlaceHandoffBlockingReason],
                               _ warnings: [PlaceHandoffWarning]) -> PlacePhoneValidationResult {
        PlacePhoneValidationResult(normalizedNumber: normalized,
                                   displayNumber: display,
                                   blockingReasons: Array(Set(blocks)).sorted { $0.rawValue < $1.rawValue },
                                   warnings: Array(Set(warnings)).sorted { $0.rawValue < $1.rawValue })
    }
}

public enum PlaceHandoffEligibilityEvaluator {
    public static func actionPresentations(
        for context: PlaceHandoffCandidateContext,
        releaseSupportPolicy: PlaceHandoffReleaseSupportPolicy = .default
    ) -> [PlaceHandoffActionPresentation] {
        PlaceHandoffActionKind.allCases.map {
            let structural = evaluate($0, context: context)
            let support = releaseSupportPolicy.evaluate(action: $0,
                                                        structuralEligibility: structural)
            return PlaceHandoffActionPresentation(action: $0,
                                                  eligibility: structural.applyingReleaseSupport(support))
        }
    }

    public static func evaluate(_ action: PlaceHandoffActionKind,
                                context: PlaceHandoffCandidateContext) -> PlaceHandoffEligibility {
        guard context.isPresentInCurrentPresentation else {
            return .blocked([.candidateNoLongerPresent])
        }
        guard !context.candidateID.isEmpty else {
            return .blocked([.invalidCandidateIdentity])
        }
        switch action {
        case .openInMaps:
            return mapEligibility(context)
        case .openDirections:
            return directionsEligibility(context)
        case .openOfficialWebsite:
            return websiteEligibility(context)
        case .startPhoneHandoff:
            return phoneEligibility(context)
        }
    }

    public static func evidenceState(for context: PlaceHandoffCandidateContext,
                                     references: [PlaceEvidenceReference] = []) -> PlaceActionEvidenceState {
        let fieldRefs = references.isEmpty ? context.evidenceReferences : references
        if context.verificationStatus == .conflicting || hasConflict(context, field: nil) {
            return .conflicting
        }
        let stale = context.verificationStatus == .stale
            || context.freshness.lowercased().contains("stale")
            || fieldRefs.contains { $0.freshness.lowercased().contains("stale") }
        if stale { return .stale }
        if context.verificationStatus == .verified {
            return fieldRefs.contains { $0.confidence >= 0.75 } ? .confirmed : .supported
        }
        if fieldRefs.contains(where: { $0.confidence >= 0.75 }) { return .supported }
        if context.verificationStatus == .partiallyVerified || fieldRefs.contains(where: { $0.confidence > 0 }) {
            return .partial
        }
        return .unknown
    }

    public static func selectedOfficialWebsite(in context: PlaceHandoffCandidateContext) -> PlaceWebLink? {
        let officialLinks = context.webLinks.filter { $0.kind == .officialWebsite }
        if let https = officialLinks.first(where: { $0.url.lowercased().hasPrefix("https://") }) {
            return https
        }
        return officialLinks.first
    }

    private static func mapEligibility(_ context: PlaceHandoffCandidateContext) -> PlaceHandoffEligibility {
        var warnings = evidenceWarnings(evidenceState(for: context))
        if let coordinate = context.coordinate {
            if !isValidCoordinate(coordinate) {
                return .blocked([.invalidCoordinate], warnings: warnings)
            }
            if let accuracy = coordinate.horizontalAccuracyMeters, accuracy > 5_000 {
                warnings.append(.partialCoordinate)
            }
            if hasConflict(context, field: "coordinate") || context.verificationStatus == .conflicting {
                return .blocked([.coordinateAddressConflict], warnings: warnings)
            }
            return .allowed(warnings: warnings)
        }
        if hasSpecificAddress(context.address) {
            if context.verificationStatus == .conflicting || hasConflict(context, field: "address") {
                return .blocked([.coordinateAddressConflict], warnings: warnings)
            }
            return .allowed(warnings: warnings)
        }
        return .blocked([.missingMapDestination], warnings: warnings)
    }

    private static func directionsEligibility(_ context: PlaceHandoffCandidateContext) -> PlaceHandoffEligibility {
        let evidence = evidenceState(for: context)
        var warnings = evidenceWarnings(evidence)
        if evidence == .conflicting || hasConflict(context, field: "coordinate") {
            return .blocked([.coordinateAddressConflict], warnings: warnings)
        }
        guard context.coordinate.map(isValidCoordinate) == true || hasSpecificAddress(context.address) else {
            return .blocked([.missingDirectionsDestination], warnings: warnings)
        }
        switch context.directionsOrigin {
        case .none:
            return .blocked([.missingDirectionsOrigin], warnings: warnings)
        case .currentLocation(let accuracy):
            if accuracy == .approximateCurrentLocation {
                warnings.append(.approximateCurrentLocation)
            }
        case .lastKnownLocation:
            warnings.append(.lastKnownLocation)
            warnings.append(.staleEvidence)
        case .userEnteredAddress(let address):
            if address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return .blocked([.missingDirectionsOrigin], warnings: warnings)
            }
        }
        if evidence == .unknown {
            return .blocked([.missingDirectionsDestination], warnings: warnings)
        }
        return .allowed(warnings: warnings)
    }

    private static func websiteEligibility(_ context: PlaceHandoffCandidateContext) -> PlaceHandoffEligibility {
        guard let website = selectedOfficialWebsite(in: context) else {
            return .blocked([.websiteMissing])
        }
        var warnings = evidenceWarnings(evidenceState(for: context, references: website.evidenceReferences))
        guard website.kind == .officialWebsite else {
            return .blocked([.websiteNotOfficial], warnings: warnings)
        }
        if context.verificationStatus == .conflicting || hasConflict(context, field: "website") || hasConflict(context, field: "url") {
            return .blocked([.websiteConflict], warnings: warnings)
        }
        let validated = PlaceHandoffURLValidator.validate(website.url, classification: classification(for: website))
        warnings.append(contentsOf: validated.warnings)
        if !validated.classification.isOfficial {
            return .blocked([.websiteNotOfficial], warnings: warnings)
        }
        let state = evidenceState(for: context, references: website.evidenceReferences)
        switch state {
        case .confirmed, .supported:
            break
        case .partial, .stale:
            warnings.append(state == .stale ? .staleEvidence : .unconfirmedWebsite)
        case .conflicting, .unknown:
            return .blocked([state == .conflicting ? .websiteConflict : .websiteNotOfficial],
                            warnings: warnings)
        }
        return validated.blockingReasons.isEmpty
            ? .allowed(warnings: warnings)
            : .blocked(validated.blockingReasons, warnings: warnings)
    }

    private static func phoneEligibility(_ context: PlaceHandoffCandidateContext) -> PlaceHandoffEligibility {
        if context.verificationStatus == .conflicting || hasConflict(context, field: "phone") {
            return .blocked([.phoneConflict])
        }
        let validation = PlacePhoneNumberValidator.validate(rawNumber: context.contact.phoneNumber,
                                                            displayNumber: context.contact.displayPhone)
        var warnings = evidenceWarnings(evidenceState(for: context))
        warnings.append(contentsOf: validation.warnings)
        let state = evidenceState(for: context)
        switch state {
        case .confirmed, .supported:
            break
        case .partial, .stale:
            warnings.append(state == .stale ? .staleEvidence : .partialEvidence)
        case .conflicting:
            return .blocked([.phoneConflict], warnings: warnings)
        case .unknown:
            return .blocked([.phoneMissing], warnings: warnings)
        }
        return validation.blockingReasons.isEmpty
            ? .allowed(warnings: warnings)
            : .blocked(validation.blockingReasons, warnings: warnings)
    }

    private static func hasSpecificAddress(_ address: PlaceAddress?) -> Bool {
        guard let address else { return false }
        let formatted = address.formatted.trimmingCharacters(in: .whitespacesAndNewlines)
        if formatted.count < 8 { return false }
        return address.street != nil || address.locality != nil || formatted.contains(",")
    }

    private static func isValidCoordinate(_ coordinate: PlaceCoordinate) -> Bool {
        coordinate.latitude.isFinite
            && coordinate.longitude.isFinite
            && (-90...90).contains(coordinate.latitude)
            && (-180...180).contains(coordinate.longitude)
    }

    private static func hasConflict(_ context: PlaceHandoffCandidateContext, field: String?) -> Bool {
        context.findings.contains { finding in
            let criterion = finding.criterion.lowercased()
            let fieldMatches = field.map { criterion.contains($0.lowercased()) } ?? true
            return fieldMatches
                && (finding.status == .failed || finding.recommendedDisposition == .excludeConflict)
        }
    }

    private static func evidenceWarnings(_ state: PlaceActionEvidenceState) -> [PlaceHandoffWarning] {
        switch state {
        case .confirmed, .supported:
            return []
        case .partial:
            return [.partialEvidence]
        case .stale:
            return [.staleEvidence]
        case .conflicting, .unknown:
            return []
        }
    }

    private static func classification(for link: PlaceWebLink) -> WebsiteClassification {
        switch link.kind {
        case .officialWebsite: return link.evidenceReferences.contains(where: { $0.confidence >= 0.9 }) ? .canonical : .official
        case .source: return .evidenceSource
        case .maps, .menu, .other: return .directory
        }
    }
}

public enum PlaceHandoffRequestBuilder {
    public static func makeRequest(action: PlaceHandoffActionKind,
                                   context: PlaceHandoffCandidateContext,
                                   requestedAt: Date = Date()) -> Result<PlaceHandoffRequest, PlaceHandoffEligibility> {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(action, context: context)
        guard eligibility.isAvailable else { return .failure(eligibility) }
        let destination: PlaceHandoffDestination
        let evidenceState: PlaceActionEvidenceState
        switch action {
        case .openInMaps:
            evidenceState = PlaceHandoffEligibilityEvaluator.evidenceState(for: context)
            destination = .mapPlace(name: context.name,
                                    coordinate: context.coordinate,
                                    postalAddress: context.address?.formatted)
        case .openDirections:
            evidenceState = PlaceHandoffEligibilityEvaluator.evidenceState(for: context)
            destination = .directions(destinationName: context.name,
                                      destinationCoordinate: context.coordinate,
                                      destinationAddress: context.address?.formatted,
                                      origin: context.directionsOrigin)
        case .openOfficialWebsite:
            guard let website = PlaceHandoffEligibilityEvaluator.selectedOfficialWebsite(in: context) else {
                return .failure(.blocked([.websiteMissing]))
            }
            let classification: WebsiteClassification = website.evidenceReferences.contains(where: { $0.confidence >= 0.9 }) ? .canonical : .official
            let validation = PlaceHandoffURLValidator.validate(website.url, classification: classification)
            guard let url = validation.url, validation.blockingReasons.isEmpty else {
                return .failure(.blocked(validation.blockingReasons.isEmpty ? [.urlParseFailed] : validation.blockingReasons,
                                         warnings: validation.warnings))
            }
            evidenceState = PlaceHandoffEligibilityEvaluator.evidenceState(for: context,
                                                                           references: website.evidenceReferences)
            destination = .website(url: url, classification: classification)
        case .startPhoneHandoff:
            let validation = PlacePhoneNumberValidator.validate(rawNumber: context.contact.phoneNumber,
                                                                displayNumber: context.contact.displayPhone)
            guard let normalized = validation.normalizedNumber,
                  let display = validation.displayNumber,
                  validation.blockingReasons.isEmpty else {
                return .failure(.blocked(validation.blockingReasons.isEmpty ? [.phoneInvalid] : validation.blockingReasons,
                                         warnings: validation.warnings))
            }
            evidenceState = PlaceHandoffEligibilityEvaluator.evidenceState(for: context)
            destination = .phone(normalizedNumber: normalized, displayNumber: display)
        }
        return .success(PlaceHandoffRequest(requestID: stableRequestID(taskID: context.taskID,
                                                                       runID: context.runID,
                                                                       candidateID: context.candidateID,
                                                                       action: action,
                                                                       destination: destination),
                                           taskID: context.taskID,
                                           runID: context.runID,
                                           candidateID: context.candidateID,
                                           action: action,
                                           destination: destination,
                                           evidenceState: evidenceState,
                                           requestedAt: requestedAt))
    }

    public static func stableRequestID(taskID: UUID,
                                       runID: UUID?,
                                       candidateID: String,
                                       action: PlaceHandoffActionKind,
                                       destination: PlaceHandoffDestination) -> PlaceHandoffRequestID {
        let raw = [
            taskID.uuidString,
            runID?.uuidString ?? "no-run",
            candidateID,
            action.rawValue,
            destination.auditSummary,
        ].joined(separator: "|")
        let digest = SHA256.hash(data: Data(raw.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "place-handoff-\(digest.prefix(24))"
    }

    public static func newAttemptID(requestID: PlaceHandoffRequestID, attemptIndex: Int) -> PlaceHandoffAttemptID {
        "\(AgentEventRedactor.safeIdentifier(requestID))-attempt-\(max(1, attemptIndex))"
    }
}

public enum PlaceHandoffDispatchBoundaryValidator {
    public static func validate(_ request: PlaceHandoffRequest) -> PlaceHandoffEligibility {
        var blocks: [PlaceHandoffBlockingReason] = []
        var warnings: [PlaceHandoffWarning] = []

        if request.candidateID == "redacted" {
            blocks.append(.invalidCandidateIdentity)
        }
        let expectedRequestID = PlaceHandoffRequestBuilder.stableRequestID(taskID: request.taskID,
                                                                           runID: request.runID,
                                                                           candidateID: request.candidateID,
                                                                           action: request.action,
                                                                           destination: request.destination)
        if request.requestID != expectedRequestID {
            blocks.append(.dataCorrupted)
        }

        switch (request.action, request.destination) {
        case (.openInMaps, .mapPlace(let name, let coordinate, let address)):
            validateDestinationText(name, into: &blocks)
            if let address { validateDestinationText(address, into: &blocks) }
            if let coordinate {
                validateCoordinate(coordinate, into: &blocks)
                if let accuracy = coordinate.horizontalAccuracyMeters, accuracy > 5_000 {
                    warnings.append(.partialCoordinate)
                }
            } else if !hasSpecificAddress(address) {
                blocks.append(.missingMapDestination)
            }
        case (.openDirections, .directions(let name, let coordinate, let address, let origin)):
            validateDestinationText(name, into: &blocks)
            if let address { validateDestinationText(address, into: &blocks) }
            if let coordinate {
                validateCoordinate(coordinate, into: &blocks)
            } else if !hasSpecificAddress(address) {
                blocks.append(.missingDirectionsDestination)
            }
            validateOrigin(origin, into: &blocks, warnings: &warnings)
        case (.openOfficialWebsite, .website(let url, let classification)):
            if !classification.isOfficial {
                blocks.append(.websiteNotOfficial)
            }
            let validation = PlaceHandoffURLValidator.validate(url.absoluteString,
                                                               classification: classification)
            blocks.append(contentsOf: validation.blockingReasons)
            warnings.append(contentsOf: validation.warnings)
        case (.startPhoneHandoff, .phone(let normalizedNumber, _)):
            let validation = PlacePhoneNumberValidator.validate(rawNumber: normalizedNumber)
            if validation.normalizedNumber != normalizedNumber {
                blocks.append(.phoneInvalid)
            }
            blocks.append(contentsOf: validation.blockingReasons)
            warnings.append(contentsOf: validation.warnings)
        default:
            blocks.append(.dataCorrupted)
        }

        return blocks.isEmpty
            ? .allowed(warnings: warnings)
            : .blocked(blocks, warnings: warnings)
    }

    private static func validateOrigin(_ origin: DirectionsOrigin,
                                       into blocks: inout [PlaceHandoffBlockingReason],
                                       warnings: inout [PlaceHandoffWarning]) {
        switch origin {
        case .currentLocation(let accuracy):
            if accuracy == .approximateCurrentLocation {
                warnings.append(.approximateCurrentLocation)
            }
        case .lastKnownLocation(let label, let coordinate, let capturedAt):
            warnings.append(.lastKnownLocation)
            warnings.append(.staleEvidence)
            if let coordinate {
                validateCoordinate(coordinate, into: &blocks)
            }
            if coordinate == nil && label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.missingDirectionsOrigin)
            }
            if capturedAt == nil {
                blocks.append(.staleOrigin)
            }
        case .userEnteredAddress(let address):
            validateDestinationText(address, into: &blocks)
            if address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.missingDirectionsOrigin)
            }
        case .none:
            blocks.append(.missingDirectionsOrigin)
        }
    }

    private static func validateCoordinate(_ coordinate: PlaceCoordinate,
                                           into blocks: inout [PlaceHandoffBlockingReason]) {
        guard coordinate.latitude.isFinite,
              coordinate.longitude.isFinite,
              (-90...90).contains(coordinate.latitude),
              (-180...180).contains(coordinate.longitude) else {
            blocks.append(.invalidCoordinate)
            return
        }
    }

    private static func validateDestinationText(_ value: String,
                                                into blocks: inout [PlaceHandoffBlockingReason]) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.count > 512 {
            blocks.append(.dataCorrupted)
        }
        if trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            blocks.append(.dataCorrupted)
        }
    }

    private static func hasSpecificAddress(_ address: String?) -> Bool {
        guard let address else { return false }
        let formatted = address.trimmingCharacters(in: .whitespacesAndNewlines)
        return formatted.count >= 8 && formatted.contains(",")
    }
}

public enum PlaceHandoffPermissionDecision: Equatable, Sendable {
    case approved
    case denied(String)
    case cancelled(String)
}

public protocol PlaceHandoffAuthorizing: Sendable {
    func authorize(_ request: PlaceHandoffRequest) async -> PlaceHandoffPermissionDecision
}

public enum PlaceHandoffDispatchStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case acceptedBySystem
    case unsupportedByReleasePolicy
    case rejected
    case unavailableHandler
    case malformedDestination
    case cancelledBeforeSubmit
    case cancelledAfterSubmit
    case failed
    case timedOut
    case duplicateRequest
}

public enum PlaceHandoffOutcomeSemantic: String, Codable, Sendable, Hashable, CaseIterable {
    case unsupportedByReleasePolicy
    case handlerUnavailable
    case systemOpenFailed
    case permissionRejected
    case userCancelled
    case dispatchInterrupted
    case handedOff
    case malformedDestination
    case duplicateRejected
    case failed

    public init(status: PlaceHandoffDispatchStatus) {
        switch status {
        case .acceptedBySystem, .cancelledAfterSubmit:
            self = .handedOff
        case .unsupportedByReleasePolicy:
            self = .unsupportedByReleasePolicy
        case .unavailableHandler:
            self = .handlerUnavailable
        case .malformedDestination:
            self = .malformedDestination
        case .cancelledBeforeSubmit:
            self = .userCancelled
        case .rejected:
            self = .permissionRejected
        case .timedOut:
            self = .dispatchInterrupted
        case .duplicateRequest:
            self = .duplicateRejected
        case .failed:
            self = .failed
        }
    }
}

public enum ExternalHandlerVisibility: String, Codable, Sendable, Hashable, CaseIterable {
    case notApplicable
    case unverified
    case humanObserved
    case humanNotObserved
}

public enum PlaceHandoffExternalFailureReason: String, Codable, Sendable, Hashable, CaseIterable {
    case systemHandlerUnavailable
    case systemOpenFailed
    case unsupportedByReleasePolicy
}

public struct PlaceHandoffExternalHandlerAudit: Codable, Sendable, Hashable, Equatable {
    public var phoneHandlerRegistered: Bool?
    public var registeredHandlerBundleIdentifier: String?
    public var registeredHandlerDisplayName: String?
    public var systemOpenAccepted: Bool?
    public var runningApplicationReturned: Bool?
    public var returnedHandlerBundleIdentifier: String?
    public var returnedHandlerDisplayName: String?
    public var handlerUIVisibility: ExternalHandlerVisibility
    public var openCompletionTimestamp: Date?
    public var failureReason: PlaceHandoffExternalFailureReason?
    public var openErrorCategory: String?

    public init(phoneHandlerRegistered: Bool? = nil,
                registeredHandlerBundleIdentifier: String? = nil,
                registeredHandlerDisplayName: String? = nil,
                systemOpenAccepted: Bool? = nil,
                runningApplicationReturned: Bool? = nil,
                returnedHandlerBundleIdentifier: String? = nil,
                returnedHandlerDisplayName: String? = nil,
                handlerUIVisibility: ExternalHandlerVisibility = .notApplicable,
                openCompletionTimestamp: Date? = nil,
                failureReason: PlaceHandoffExternalFailureReason? = nil,
                openErrorCategory: String? = nil) {
        self.phoneHandlerRegistered = phoneHandlerRegistered
        self.registeredHandlerBundleIdentifier = registeredHandlerBundleIdentifier.map {
            AgentPrivacyRedactor.safeIdentifier($0, fallback: "handler")
        }
        self.registeredHandlerDisplayName = registeredHandlerDisplayName.map {
            AgentPrivacyRedactor.safeText($0, maxLength: 80).text
        }
        self.systemOpenAccepted = systemOpenAccepted
        self.runningApplicationReturned = runningApplicationReturned
        self.returnedHandlerBundleIdentifier = returnedHandlerBundleIdentifier.map {
            AgentPrivacyRedactor.safeIdentifier($0, fallback: "handler")
        }
        self.returnedHandlerDisplayName = returnedHandlerDisplayName.map {
            AgentPrivacyRedactor.safeText($0, maxLength: 80).text
        }
        self.handlerUIVisibility = handlerUIVisibility
        self.openCompletionTimestamp = openCompletionTimestamp
        self.failureReason = failureReason
        self.openErrorCategory = openErrorCategory.map {
            AgentPrivacyRedactor.safeIdentifier($0, fallback: "open_error")
        }
    }
}

public struct PlaceHandoffDispatchResult: Equatable, Sendable {
    public var status: PlaceHandoffDispatchStatus
    public var userMessage: String
    public var diagnosticSummary: String
    public var submittedToSystem: Bool
    public var externalHandlerAudit: PlaceHandoffExternalHandlerAudit?
    public var outcomeSemantic: PlaceHandoffOutcomeSemantic

    public init(status: PlaceHandoffDispatchStatus,
                userMessage: String,
                diagnosticSummary: String = "",
                submittedToSystem: Bool = false,
                externalHandlerAudit: PlaceHandoffExternalHandlerAudit? = nil,
                outcomeSemantic: PlaceHandoffOutcomeSemantic? = nil) {
        self.status = status
        self.userMessage = AgentPrivacyRedactor.safeText(userMessage, maxLength: 240).text
        self.diagnosticSummary = AgentPrivacyRedactor.safeText(diagnosticSummary, maxLength: 400).text
        self.submittedToSystem = submittedToSystem
        self.externalHandlerAudit = externalHandlerAudit
        self.outcomeSemantic = outcomeSemantic ?? PlaceHandoffOutcomeSemantic(status: status)
    }

    public static func accepted(_ message: String, diagnosticSummary: String = "") -> PlaceHandoffDispatchResult {
        PlaceHandoffDispatchResult(status: .acceptedBySystem,
                                   userMessage: message,
                                   diagnosticSummary: diagnosticSummary,
                                   submittedToSystem: true)
    }
}

public protocol PlaceHandoffDispatching: Sendable {
    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult
}

public enum PlaceHandoffExecutionState: String, Codable, Sendable, Hashable, CaseIterable {
    case previewing
    case awaitingConfirmation
    case dispatching
    case handedOff
    case rejected
    case cancelled
    case failed
    case interrupted

    public var isTerminal: Bool {
        switch self {
        case .handedOff, .rejected, .cancelled, .failed, .interrupted:
            return true
        case .previewing, .awaitingConfirmation, .dispatching:
            return false
        }
    }

    public var userTitle: String {
        switch self {
        case .previewing: return "准备外部操作"
        case .awaitingConfirmation: return "等待你的确认"
        case .dispatching: return "正在交给系统"
        case .handedOff: return "已交给系统"
        case .rejected: return "操作被拒绝"
        case .cancelled: return "操作已取消"
        case .failed: return "操作失败"
        case .interrupted: return "操作中断"
        }
    }
}

public struct PlaceHandoffAuditEvent: Codable, Sendable, Hashable, Identifiable {
    public var id: String { eventID }
    public var eventID: String
    public var requestID: PlaceHandoffRequestID
    public var attemptID: PlaceHandoffAttemptID?
    public var actionKind: PlaceHandoffActionKind
    public var candidateID: LocalDiscoveryCandidateID
    public var taskID: AgentTaskID
    public var runID: AgentRunID?
    public var eventKind: String
    public var timestamp: Date
    public var userInitiated: Bool
    public var sanitizedDestinationSummary: String
    public var diagnosticSummary: String?

    public init(eventID: String,
                request: PlaceHandoffRequest,
                attemptID: PlaceHandoffAttemptID?,
                eventKind: String,
                timestamp: Date,
                userInitiated: Bool = true,
                diagnosticSummary: String? = nil) {
        self.eventID = AgentPrivacyRedactor.safeIdentifier(eventID, fallback: "place_handoff_event")
        self.requestID = request.requestID
        self.attemptID = attemptID.map(AgentEventRedactor.safeIdentifier)
        self.actionKind = request.action
        self.candidateID = request.candidateID
        self.taskID = request.taskID
        self.runID = request.runID
        self.eventKind = AgentPrivacyRedactor.safeIdentifier(eventKind, fallback: "event")
        self.timestamp = timestamp
        self.userInitiated = userInitiated
        self.sanitizedDestinationSummary = request.destination.auditSummary
        self.diagnosticSummary = diagnosticSummary.map { AgentPrivacyRedactor.safeText($0, maxLength: 400).text }
    }
}

public struct PlaceHandoffExecutionRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: String { requestID }
    public var requestID: PlaceHandoffRequestID
    public var attemptID: PlaceHandoffAttemptID?
    public var taskID: AgentTaskID
    public var runID: AgentRunID?
    public var candidateID: LocalDiscoveryCandidateID
    public var actionKind: PlaceHandoffActionKind
    public var state: PlaceHandoffExecutionState
    public var permissionDecision: String?
    public var dispatchStatus: PlaceHandoffDispatchStatus?
    public var outcomeSemantic: PlaceHandoffOutcomeSemantic?
    public var terminalMessage: String?
    public var requestedAt: Date
    public var updatedAt: Date
    public var duplicateDispatchCount: Int
    public var sanitizedDestinationSummary: String
    public var externalHandlerAudit: PlaceHandoffExternalHandlerAudit?
    public var auditEvents: [PlaceHandoffAuditEvent]
    public var preSubmitState: PlaceHandoffExecutionState?
    public var systemAcceptedAt: Date?
    public var terminalState: PlaceHandoffExecutionState?

    public init(request: PlaceHandoffRequest,
                state: PlaceHandoffExecutionState,
                attemptID: PlaceHandoffAttemptID? = nil,
                permissionDecision: String? = nil,
                dispatchStatus: PlaceHandoffDispatchStatus? = nil,
                outcomeSemantic: PlaceHandoffOutcomeSemantic? = nil,
                terminalMessage: String? = nil,
                updatedAt: Date,
                duplicateDispatchCount: Int = 0,
                externalHandlerAudit: PlaceHandoffExternalHandlerAudit? = nil,
                auditEvents: [PlaceHandoffAuditEvent] = [],
                preSubmitState: PlaceHandoffExecutionState? = nil,
                systemAcceptedAt: Date? = nil,
                terminalState: PlaceHandoffExecutionState? = nil) {
        self.requestID = request.requestID
        self.attemptID = attemptID
        self.taskID = request.taskID
        self.runID = request.runID
        self.candidateID = request.candidateID
        self.actionKind = request.action
        self.state = state
        self.permissionDecision = permissionDecision.map { AgentPrivacyRedactor.safeIdentifier($0, fallback: "unknown") }
        self.dispatchStatus = dispatchStatus
        self.outcomeSemantic = outcomeSemantic ?? dispatchStatus.map(PlaceHandoffOutcomeSemantic.init(status:))
        self.terminalMessage = terminalMessage.map { AgentPrivacyRedactor.safeText($0, maxLength: 240).text }
        self.requestedAt = request.requestedAt
        self.updatedAt = updatedAt
        self.duplicateDispatchCount = max(0, duplicateDispatchCount)
        self.sanitizedDestinationSummary = request.destination.auditSummary
        self.externalHandlerAudit = externalHandlerAudit
        self.auditEvents = auditEvents
        self.preSubmitState = preSubmitState
        self.systemAcceptedAt = systemAcceptedAt
        self.terminalState = terminalState
    }
}

public enum PlaceHandoffRecoveryPolicy {
    public static func recover(_ records: [PlaceHandoffExecutionRecord],
                               now: Date = Date()) -> [PlaceHandoffExecutionRecord] {
        records.map { record in
            var copy = record
            switch record.state {
            case .previewing, .awaitingConfirmation:
                copy.state = .cancelled
                copy.terminalMessage = "上次操作未执行"
                copy.outcomeSemantic = .userCancelled
                copy.terminalState = .cancelled
                copy.updatedAt = now
            case .dispatching:
                copy.state = .interrupted
                copy.terminalMessage = "外部操作中断，DeskPet 不会自动重试"
                copy.outcomeSemantic = .dispatchInterrupted
                copy.terminalState = .interrupted
                copy.updatedAt = now
            case .handedOff, .rejected, .cancelled, .failed, .interrupted:
                break
            }
            return copy
        }
    }
}

public enum PlaceHandoffAuditSanitizer {
    public static func urlSummary(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return "url=unparseable"
        }
        components.user = nil
        components.password = nil
        components.percentEncodedQuery = nil
        components.fragment = nil
        let path = components.percentEncodedPath
        let limitedPath = path.count > 96 ? "\(path.prefix(96))..." : path
        return [
            components.scheme?.lowercased(),
            components.host?.lowercased(),
            limitedPath.isEmpty ? nil : limitedPath,
        ].compactMap { $0 }.joined(separator: " ")
    }

    public static func phoneSummary(_ number: String) -> String {
        let digits = number.filter(\.isNumber)
        guard digits.count > 4 else { return "phone=redacted" }
        return "phone=...\(digits.suffix(4))"
    }

    public static func coordinateSummary(_ coordinate: PlaceCoordinate) -> String {
        String(format: "lat=%.3f lon=%.3f", coordinate.latitude, coordinate.longitude)
    }

    public static func originSummary(_ origin: DirectionsOrigin) -> String {
        switch origin {
        case .currentLocation(let accuracy):
            return "currentLocation(\(accuracy.rawValue))"
        case .lastKnownLocation:
            return "lastKnownLocation"
        case .userEnteredAddress:
            return "userEnteredAddress"
        case .none:
            return "none"
        }
    }
}
