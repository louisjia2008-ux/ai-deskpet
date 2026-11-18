import Foundation

public enum PlaceHandoffSupportReason: String, Codable, Sendable, Hashable, CaseIterable {
    case humanVisibleHandlerConformanceNotCompleted
    case handlerUnavailable
    case destinationValidationFailed
    case internalConformanceOnly

    public var userMessage: String {
        switch self {
        case .humanVisibleHandlerConformanceNotCompleted:
            return "此 Mac 当前未启用电话操作"
        case .handlerUnavailable:
            return "当前没有可用的系统处理程序"
        case .destinationValidationFailed:
            return "地点信息不可安全交给系统"
        case .internalConformanceOnly:
            return "内部验收构建已启用"
        }
    }

    public var accessibilityHint: String {
        switch self {
        case .humanVisibleHandlerConformanceNotCompleted:
            return "此 Mac 的电话处理程序尚未完成可见性验收。"
        case .handlerUnavailable:
            return "系统没有返回可用的外部处理程序。"
        case .destinationValidationFailed:
            return "地点、网址或电话号码未通过安全校验。"
        case .internalConformanceOnly:
            return "仅限内部 handoff 可见性验收构建。"
        }
    }

    public var developerDiagnostic: String {
        switch self {
        case .humanVisibleHandlerConformanceNotCompleted:
            return [
                "handler registered in P9F acceptance: true",
                "system open accepted in acceptance run: true",
                "visible UI conformance: not passed",
                "release support: disabled",
            ].joined(separator: "; ")
        case .handlerUnavailable:
            return "handler registered: false; release support: unavailable"
        case .destinationValidationFailed:
            return "release support blocked by destination validation"
        case .internalConformanceOnly:
            return "release support enabled only by DESKPET_INTERNAL_HANDOFF_CONFORMANCE compile condition"
        }
    }

    public func blockingReason(for action: PlaceHandoffActionKind) -> PlaceHandoffBlockingReason {
        switch self {
        case .humanVisibleHandlerConformanceNotCompleted:
            return .unsupportedByReleasePolicy
        case .handlerUnavailable:
            return action == .startPhoneHandoff ? .phoneHandlerUnavailable : .handlerUnavailable
        case .destinationValidationFailed:
            return .dataCorrupted
        case .internalConformanceOnly:
            return .unsupportedByReleasePolicy
        }
    }
}

public enum PlaceHandoffReleaseSupport: Codable, Sendable, Hashable, Equatable {
    case supported
    case experimental(reason: PlaceHandoffSupportReason)
    case unavailable(reason: PlaceHandoffSupportReason)

    public var allowsDispatch: Bool {
        switch self {
        case .supported, .experimental:
            return true
        case .unavailable:
            return false
        }
    }

    public var reason: PlaceHandoffSupportReason? {
        switch self {
        case .supported:
            return nil
        case .experimental(let reason), .unavailable(let reason):
            return reason
        }
    }

    public var rawStatus: String {
        switch self {
        case .supported:
            return "supported"
        case .experimental(let reason):
            return "experimental:\(reason.rawValue)"
        case .unavailable(let reason):
            return "unavailable:\(reason.rawValue)"
        }
    }
}

public enum PlaceHandoffReleaseBuildConfiguration: String, Codable, Sendable, Hashable {
    case releaseDistribution
    case debug
    case internalConformance

    public static var current: PlaceHandoffReleaseBuildConfiguration {
        #if DESKPET_INTERNAL_HANDOFF_CONFORMANCE
        return .internalConformance
        #else
        return .releaseDistribution
        #endif
    }
}

public struct PlaceHandoffHandlerAvailabilitySnapshot: Codable, Sendable, Hashable, Equatable {
    public var scheme: String
    public var isRegistered: Bool
    public var handlerBundleIdentifier: String?
    public var handlerDisplayName: String?
    public var resolvedAt: Date

    public init(scheme: String,
                isRegistered: Bool,
                handlerBundleIdentifier: String? = nil,
                handlerDisplayName: String? = nil,
                resolvedAt: Date) {
        self.scheme = scheme.lowercased()
        self.isRegistered = isRegistered
        self.handlerBundleIdentifier = handlerBundleIdentifier.map {
            AgentPrivacyRedactor.safeIdentifier($0, fallback: "handler")
        }
        self.handlerDisplayName = handlerDisplayName.map {
            AgentPrivacyRedactor.safeText($0, maxLength: 80).text
        }
        self.resolvedAt = resolvedAt
    }
}

public struct PlaceHandoffReleaseSupportEvaluation: Codable, Sendable, Hashable, Equatable {
    public var action: PlaceHandoffActionKind
    public var support: PlaceHandoffReleaseSupport
    public var handlerAvailability: PlaceHandoffHandlerAvailabilitySnapshot?
    public var developerDiagnostics: [String]

    public init(action: PlaceHandoffActionKind,
                support: PlaceHandoffReleaseSupport,
                handlerAvailability: PlaceHandoffHandlerAvailabilitySnapshot? = nil,
                developerDiagnostics: [String] = []) {
        self.action = action
        self.support = support
        self.handlerAvailability = handlerAvailability
        self.developerDiagnostics = developerDiagnostics
    }

    public var userMessage: String? {
        support.reason?.userMessage
    }

    public var accessibilityHint: String? {
        support.reason?.accessibilityHint
    }
}

public struct PlaceHandoffReleaseSupportPolicy: Codable, Sendable, Hashable, Equatable {
    public var buildConfiguration: PlaceHandoffReleaseBuildConfiguration
    public var phoneHumanVisibleHandlerConformancePassed: Bool

    public init(buildConfiguration: PlaceHandoffReleaseBuildConfiguration = .current,
                phoneHumanVisibleHandlerConformancePassed: Bool = false) {
        self.buildConfiguration = buildConfiguration
        self.phoneHumanVisibleHandlerConformancePassed = phoneHumanVisibleHandlerConformancePassed
    }

    public static let `default` = PlaceHandoffReleaseSupportPolicy()
    public static let releaseDistribution = PlaceHandoffReleaseSupportPolicy(buildConfiguration: .releaseDistribution)

    #if DEBUG
    public static let internalConformanceForTesting = PlaceHandoffReleaseSupportPolicy(
        buildConfiguration: .internalConformance,
        phoneHumanVisibleHandlerConformancePassed: true)
    #endif

    public func evaluate(action: PlaceHandoffActionKind,
                         structuralEligibility: PlaceHandoffEligibility,
                         handlerAvailability: PlaceHandoffHandlerAvailabilitySnapshot? = nil) -> PlaceHandoffReleaseSupportEvaluation {
        guard structuralEligibility.isAvailable else {
            return PlaceHandoffReleaseSupportEvaluation(
                action: action,
                support: .unavailable(reason: .destinationValidationFailed),
                handlerAvailability: handlerAvailability,
                developerDiagnostics: structuralEligibility.blockingReasons.map(\.rawValue))
        }
        if let handlerAvailability, !handlerAvailability.isRegistered {
            return PlaceHandoffReleaseSupportEvaluation(
                action: action,
                support: .unavailable(reason: .handlerUnavailable),
                handlerAvailability: handlerAvailability,
                developerDiagnostics: ["handler registered: false", "scheme: \(handlerAvailability.scheme)"])
        }
        if action == .startPhoneHandoff {
            if buildConfiguration == .internalConformance, phoneHumanVisibleHandlerConformancePassed {
                return PlaceHandoffReleaseSupportEvaluation(
                    action: action,
                    support: .experimental(reason: .internalConformanceOnly),
                    handlerAvailability: handlerAvailability,
                    developerDiagnostics: [PlaceHandoffSupportReason.internalConformanceOnly.developerDiagnostic])
            }
            var diagnostics = [PlaceHandoffSupportReason.humanVisibleHandlerConformanceNotCompleted.developerDiagnostic]
            if let handlerAvailability {
                diagnostics.insert("handler registered: \(handlerAvailability.isRegistered)", at: 0)
                if let bundle = handlerAvailability.handlerBundleIdentifier {
                    diagnostics.insert("handler bundle identifier: \(bundle)", at: 1)
                }
            }
            return PlaceHandoffReleaseSupportEvaluation(
                action: action,
                support: .unavailable(reason: .humanVisibleHandlerConformanceNotCompleted),
                handlerAvailability: handlerAvailability,
                developerDiagnostics: diagnostics)
        }
        return PlaceHandoffReleaseSupportEvaluation(action: action,
                                                   support: .supported,
                                                   handlerAvailability: handlerAvailability)
    }

    public func evaluate(request: PlaceHandoffRequest,
                         handlerAvailability: PlaceHandoffHandlerAvailabilitySnapshot? = nil) -> PlaceHandoffReleaseSupportEvaluation {
        let structural = PlaceHandoffDispatchBoundaryValidator.validate(request)
        return evaluate(action: request.action,
                        structuralEligibility: structural,
                        handlerAvailability: handlerAvailability)
    }
}
