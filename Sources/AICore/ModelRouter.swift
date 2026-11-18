import Foundation

/// Decides where a request should run (doc §11.2). Local is always the default; cloud is only
/// ever *recommended* for hard tasks and is used solely when the user has authorized it. The
/// router NEVER routes to cloud on its own — no silent uploads (doc §11.2 自动路由仅预留).
public enum ModelRoute: Equatable, Sendable {
    case local
    case cloudRecommended   // hard task, but only goes to cloud if authorized
}

public struct ModelRouter: Sendable {
    public init() {}

    private static let hardKeywords = [
        "证明", "推导", "架构", "评审", "论文", "翻译这", "长文", "数学", "物理", "经济", "优化算法",
    ]

    public func route(prompt: String) -> ModelRoute {
        let longEnough = prompt.count >= 120
        let hard = Self.hardKeywords.contains { prompt.contains($0) }
        return (longEnough || hard) ? .cloudRecommended : .local
    }

    /// The actual destination given the route + the user's session authorization.
    /// cloudRecommended + not authorized → stays local (and the UI should suggest enabling cloud).
    public func destination(for route: ModelRoute, cloudAuthorized: Bool) -> Destination {
        switch route {
        case .local: return .local
        case .cloudRecommended: return cloudAuthorized ? .cloud : .localWithCloudSuggestion
        }
    }

    public enum Destination: Equatable, Sendable { case local, cloud, localWithCloudSuggestion }

    public struct Selection: Equatable, Sendable {
        public var role: ModelRole
        public var provider: ProviderConfig
        public var modelID: String
        public var usedFallback: Bool
        public var conformance: ConformanceDecision?

        public init(role: ModelRole,
                    provider: ProviderConfig,
                    modelID: String,
                    usedFallback: Bool,
                    conformance: ConformanceDecision? = nil) {
            self.role = role
            self.provider = provider
            self.modelID = modelID
            self.usedFallback = usedFallback
            self.conformance = conformance
        }
    }

    public struct ConformanceRequest: Equatable, Sendable {
        public var providerID: String
        public var modelID: String
        public var roleID: String
        public var requiresNativeToolCalling: Bool
        public var requiresTrueStreaming: Bool
        public var requiresParallelToolCalls: Bool
        public var requestedAutonomousSteps: Int

        public init(providerID: String,
                    modelID: String,
                    roleID: String,
                    requiresNativeToolCalling: Bool,
                    requiresTrueStreaming: Bool,
                    requiresParallelToolCalls: Bool = false,
                    requestedAutonomousSteps: Int = 1) {
            self.providerID = providerID
            self.modelID = modelID
            self.roleID = roleID
            self.requiresNativeToolCalling = requiresNativeToolCalling
            self.requiresTrueStreaming = requiresTrueStreaming
            self.requiresParallelToolCalls = requiresParallelToolCalls
            self.requestedAutonomousSteps = max(0, requestedAutonomousSteps)
        }
    }

    public struct ConformanceDecision: Equatable, Sendable {
        public var allowed: Bool
        public var appliedProfileID: String?
        public var maxAutonomousSteps: Int
        public var nativeToolCallingAllowed: Bool
        public var trueStreamingAllowed: Bool
        public var parallelToolCallsAllowed: Bool
        public var issues: [String]

        public init(allowed: Bool,
                    appliedProfileID: String? = nil,
                    maxAutonomousSteps: Int = 1,
                    nativeToolCallingAllowed: Bool,
                    trueStreamingAllowed: Bool,
                    parallelToolCallsAllowed: Bool,
                    issues: [String] = []) {
            self.allowed = allowed
            self.appliedProfileID = appliedProfileID
            self.maxAutonomousSteps = max(0, maxAutonomousSteps)
            self.nativeToolCallingAllowed = nativeToolCallingAllowed
            self.trueStreamingAllowed = trueStreamingAllowed
            self.parallelToolCallsAllowed = parallelToolCallsAllowed
            self.issues = issues.sorted()
        }

        public static let safeDefault = ConformanceDecision(allowed: false,
                                                            maxAutonomousSteps: 1,
                                                            nativeToolCallingAllowed: false,
                                                            trueStreamingAllowed: false,
                                                            parallelToolCallsAllowed: false,
                                                            issues: ["missing_conformance_profile"])
    }

    public protocol ConformancePolicy: Sendable {
        func evaluate(_ request: ConformanceRequest) -> ConformanceDecision
    }

    public enum RoleRoutingError: Error, Equatable, Sendable {
        case noCompanionModelConfigured
        case providerNotFound(String)
        case providerDisabled(String)
        case noDefaultModelSelected(String)
        case modelMissing(String)
        case missingAPIKey(String)
        case localServiceUnavailable(String)
        case conformanceDenied(String)

        public var userMessage: String {
            switch self {
            case .noCompanionModelConfigured: return "未选择 Provider"
            case .providerNotFound: return "Provider 不存在"
            case .providerDisabled: return "Provider 已停用"
            case .noDefaultModelSelected: return "Provider 已连接，但未选择默认模型"
            case .modelMissing: return "默认模型不可用"
            case .missingAPIKey: return "API Key empty"
            case .localServiceUnavailable: return "本地服务未运行"
            case .conformanceDenied: return "模型能力未通过安全配置"
            }
        }
    }

    public func route(_ role: ModelRole,
                      providers: [ProviderConfig],
                      defaults: ModelRoleDefaults,
                      secretStore: any SecretStore,
                      conformancePolicy: (any ConformancePolicy)? = nil,
                      requestedAutonomousSteps: Int = 1,
                      requiresParallelToolCalls: Bool = false) async -> Result<Selection, RoleRoutingError> {
        let explicit = providerAndModel(for: role, defaults: defaults)
        let companion = providerAndModel(for: .companion, defaults: defaults)
        let chosen = explicit.providerID != nil && explicit.modelID != nil ? explicit : companion
        let usedFallback = role != .companion && (explicit.providerID == nil || explicit.modelID == nil)

        guard let providerID = chosen.providerID else {
            return .failure(.noCompanionModelConfigured)
        }
        guard let modelID = chosen.modelID, !modelID.isEmpty else {
            return .failure(.noDefaultModelSelected(providerID))
        }
        guard let provider = providers.first(where: { $0.id == providerID }) else {
            return .failure(.providerNotFound(providerID))
        }
        guard provider.enabled else {
            return .failure(.providerDisabled(providerID))
        }
        if provider.type.requiresAPIKey {
            guard provider.apiKeySecretID != nil else {
                return .failure(.missingAPIKey(providerID))
            }
        }
        let toolCalling = ProviderToolCapabilityPolicy.capability(for: provider, modelID: modelID)
        let conformanceRequest = ConformanceRequest(providerID: provider.id,
                                                    modelID: modelID,
                                                    roleID: role.rawValue,
                                                    requiresNativeToolCalling: role == .tool && toolCalling == .native,
                                                    requiresTrueStreaming: provider.capabilities.contains(.streaming),
                                                    requiresParallelToolCalls: requiresParallelToolCalls,
                                                    requestedAutonomousSteps: requestedAutonomousSteps)
        let conformance = conformancePolicy?.evaluate(conformanceRequest)
        if let conformance, !conformance.allowed {
            return .failure(.conformanceDenied(conformance.issues.joined(separator: ",")))
        }
        return .success(Selection(role: role,
                                  provider: provider,
                                  modelID: modelID,
                                  usedFallback: usedFallback,
                                  conformance: conformance))
    }

    private func providerAndModel(for role: ModelRole,
                                  defaults: ModelRoleDefaults) -> (providerID: String?, modelID: String?) {
        switch role {
        case .companion:
            return (defaults.companionModelProviderID, defaults.companionModelID)
        case .tool:
            return (defaults.toolModelProviderID, defaults.toolModelID)
        case .summarizer:
            return (defaults.summarizerModelProviderID, defaults.summarizerModelID)
        case .vision:
            return (defaults.visionModelProviderID, defaults.visionModelID)
        }
    }
}
