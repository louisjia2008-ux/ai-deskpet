import Foundation

public enum ProviderType: String, Codable, CaseIterable, Sendable, Identifiable {
    case openAICompatible
    case anthropic
    case ollama
    case lmStudio
    case customHTTP
    case gemini

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .openAICompatible: return "OpenAI-compatible"
        case .anthropic: return "Anthropic"
        case .ollama: return "Ollama"
        case .lmStudio: return "LM Studio"
        case .customHTTP: return "Custom HTTP"
        case .gemini: return "Gemini"
        }
    }

    public var requiresAPIKey: Bool {
        switch self {
        case .openAICompatible, .anthropic, .customHTTP, .gemini: return true
        case .ollama, .lmStudio: return false
        }
    }

    public var supportsFetchedModelList: Bool {
        switch self {
        case .openAICompatible, .ollama, .lmStudio: return true
        case .anthropic, .customHTTP, .gemini: return false
        }
    }
}

public enum ModelCapability: String, Codable, CaseIterable, Sendable, Identifiable {
    case chat
    case vision
    case streaming
    case toolCalling
    case embeddings
    case local
    case offline

    public var id: String { rawValue }
}

public enum ProviderToolCallingCapability: String, Codable, Sendable, Equatable {
    case native
    case structuredJSONFallback
    case unsupported
}

public enum ProviderToolCapabilityPolicy {
    public static func capability(for provider: ProviderConfig,
                                  modelID: String? = nil,
                                  resolver: ProviderCapabilityProfileResolving = DefaultProviderCapabilityProfileResolver()) -> ProviderToolCallingCapability {
        let resolvedModelID = modelID ?? provider.defaultModelID
        switch provider.type {
        case .openAICompatible, .lmStudio:
            let profile = resolver.capabilityProfile(provider: provider, modelID: resolvedModelID)
            if profile.supportsNativeToolCalling { return .native }
            return provider.capabilities.contains(.toolCalling) ? .native : .structuredJSONFallback
        case .ollama:
            return .structuredJSONFallback
        case .anthropic, .customHTTP, .gemini:
            return .unsupported
        }
    }
}

public struct LLMJSONValue: Codable, Equatable, Sendable {
    public var storage: Storage

    public enum Storage: Equatable, Sendable {
        case null
        case bool(Bool)
        case number(Double)
        case string(String)
        case array([LLMJSONValue])
        case object([String: LLMJSONValue])
    }

    public init(_ storage: Storage) {
        self.storage = storage
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            storage = .null
        } else if let value = try? container.decode(Bool.self) {
            storage = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            storage = .number(value)
        } else if let value = try? container.decode(String.self) {
            storage = .string(value)
        } else if let value = try? container.decode([LLMJSONValue].self) {
            storage = .array(value)
        } else {
            storage = .object(try container.decode([String: LLMJSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch storage {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    public static func object(_ values: [String: LLMJSONValue]) -> LLMJSONValue {
        LLMJSONValue(.object(values))
    }

    public static func array(_ values: [LLMJSONValue]) -> LLMJSONValue {
        LLMJSONValue(.array(values))
    }

    public static func string(_ value: String) -> LLMJSONValue {
        LLMJSONValue(.string(value))
    }

    public static func bool(_ value: Bool) -> LLMJSONValue {
        LLMJSONValue(.bool(value))
    }
}

public struct LLMToolDefinition: Codable, Equatable, Sendable {
    public var name: String
    public var description: String
    public var parameters: LLMJSONValue

    public init(name: String, description: String, parameters: LLMJSONValue) {
        self.name = name
        self.description = description
        self.parameters = parameters
    }
}

public struct LLMToolCall: Codable, Equatable, Sendable {
    public var id: String?
    public var name: String
    public var argumentsJSON: String

    public init(id: String?, name: String, argumentsJSON: String) {
        self.id = id
        self.name = name
        self.argumentsJSON = argumentsJSON
    }
}

public struct ProviderConfig: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var displayName: String
    public var type: ProviderType
    public var baseURL: URL
    public var apiKeySecretID: String?
    public var defaultModelID: String?
    public var enabled: Bool
    public var capabilities: Set<ModelCapability>
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String = UUID().uuidString,
                displayName: String,
                type: ProviderType,
                baseURL: URL,
                apiKeySecretID: String? = nil,
                defaultModelID: String? = nil,
                enabled: Bool = true,
                capabilities: Set<ModelCapability> = [.chat],
                createdAt: Date = Date(),
                updatedAt: Date = Date()) {
        self.id = id
        self.displayName = displayName
        self.type = type
        self.baseURL = baseURL
        self.apiKeySecretID = apiKeySecretID
        self.defaultModelID = defaultModelID
        self.enabled = enabled
        self.capabilities = capabilities
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum ModelDescriptorSource: String, Codable, Sendable {
    case manual
    case fetched
    case builtIn
}

public struct ModelDescriptor: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var displayName: String
    public var providerID: String
    public var capabilities: Set<ModelCapability>
    public var contextWindow: Int?
    public var isAvailable: Bool
    public var source: ModelDescriptorSource

    public init(id: String,
                displayName: String? = nil,
                providerID: String,
                capabilities: Set<ModelCapability> = [.chat],
                contextWindow: Int? = nil,
                isAvailable: Bool = true,
                source: ModelDescriptorSource) {
        self.id = id
        self.displayName = displayName ?? id
        self.providerID = providerID
        self.capabilities = capabilities
        self.contextWindow = contextWindow
        self.isAvailable = isAvailable
        self.source = source
    }
}

public struct ModelRoleDefaults: Codable, Equatable, Sendable {
    public var companionModelProviderID: String?
    public var companionModelID: String?
    public var toolModelProviderID: String?
    public var toolModelID: String?
    public var summarizerModelProviderID: String?
    public var summarizerModelID: String?
    public var visionModelProviderID: String?
    public var visionModelID: String?

    public init(companionModelProviderID: String? = nil,
                companionModelID: String? = nil,
                toolModelProviderID: String? = nil,
                toolModelID: String? = nil,
                summarizerModelProviderID: String? = nil,
                summarizerModelID: String? = nil,
                visionModelProviderID: String? = nil,
                visionModelID: String? = nil) {
        self.companionModelProviderID = companionModelProviderID
        self.companionModelID = companionModelID
        self.toolModelProviderID = toolModelProviderID
        self.toolModelID = toolModelID
        self.summarizerModelProviderID = summarizerModelProviderID
        self.summarizerModelID = summarizerModelID
        self.visionModelProviderID = visionModelProviderID
        self.visionModelID = visionModelID
    }
}

public enum ModelRole: String, Codable, CaseIterable, Sendable {
    case companion
    case tool
    case summarizer
    case vision
}

public enum ProviderConnectionStatus: Equatable, Sendable, Codable {
    case notConfigured
    case missingAPIKey
    case ready
    case testing
    case connected
    case failed(message: String)
    case unsupported
    case localServiceUnavailable

    private enum CodingKeys: String, CodingKey {
        case kind
        case message
    }

    private enum Kind: String, Codable {
        case notConfigured
        case missingAPIKey
        case ready
        case testing
        case connected
        case failed
        case unsupported
        case localServiceUnavailable
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .kind)
        switch kind {
        case .notConfigured: self = .notConfigured
        case .missingAPIKey: self = .missingAPIKey
        case .ready: self = .ready
        case .testing: self = .testing
        case .connected: self = .connected
        case .failed: self = .failed(message: try container.decodeIfPresent(String.self, forKey: .message) ?? "连接失败")
        case .unsupported: self = .unsupported
        case .localServiceUnavailable: self = .localServiceUnavailable
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .notConfigured:
            try container.encode(Kind.notConfigured, forKey: .kind)
        case .missingAPIKey:
            try container.encode(Kind.missingAPIKey, forKey: .kind)
        case .ready:
            try container.encode(Kind.ready, forKey: .kind)
        case .testing:
            try container.encode(Kind.testing, forKey: .kind)
        case .connected:
            try container.encode(Kind.connected, forKey: .kind)
        case .failed(let message):
            try container.encode(Kind.failed, forKey: .kind)
            try container.encode(message, forKey: .message)
        case .unsupported:
            try container.encode(Kind.unsupported, forKey: .kind)
        case .localServiceUnavailable:
            try container.encode(Kind.localServiceUnavailable, forKey: .kind)
        }
    }

    public var label: String {
        switch self {
        case .notConfigured: return "未配置"
        case .missingAPIKey: return "API Key empty"
        case .ready: return "可测试"
        case .testing: return "测试中"
        case .connected: return "已连接"
        case .failed(let message): return message
        case .unsupported: return "暂不支持"
        case .localServiceUnavailable: return "本地服务未运行"
        }
    }
}

public enum SecretAccessMode: Equatable, Sendable {
    case nonInteractive
    case userInitiated
}

public enum KeychainSecretError: Error, Equatable, Sendable, LocalizedError {
    case itemNotFound(OSStatus)
    case interactionNotAllowed(OSStatus)
    case authenticationFailed(OSStatus)
    case userCancelled(OSStatus)
    case duplicateItem(OSStatus)
    case missingEntitlement(OSStatus)
    case invalidData
    case timeout
    case unexpectedStatus(OSStatus)

    public var status: OSStatus? {
        switch self {
        case .itemNotFound(let status),
             .interactionNotAllowed(let status),
             .authenticationFailed(let status),
             .userCancelled(let status),
             .duplicateItem(let status),
             .missingEntitlement(let status),
             .unexpectedStatus(let status):
            return status
        case .invalidData, .timeout:
            return nil
        }
    }

    public var errorDescription: String? {
        switch self {
        case .itemNotFound:
            return "API Key not found"
        case .interactionNotAllowed:
            return "Keychain requires reauthorization"
        case .authenticationFailed:
            return "Keychain authentication failed"
        case .userCancelled:
            return "Keychain authorization cancelled"
        case .duplicateItem:
            return "Keychain item already exists"
        case .missingEntitlement:
            return "Keychain entitlement missing"
        case .invalidData:
            return "Keychain item data invalid"
        case .timeout:
            return "Keychain request timed out"
        case .unexpectedStatus(let status):
            return "Keychain access failed (OSStatus \(status))"
        }
    }

    public var providerFacingMessage: String {
        switch self {
        case .itemNotFound:
            return "API Key empty"
        case .interactionNotAllowed:
            return "Keychain locked; reauthorize API Key"
        case .authenticationFailed:
            return "Keychain authentication failed"
        case .userCancelled:
            return "Keychain authorization cancelled"
        case .missingEntitlement:
            return "Keychain entitlement missing"
        case .invalidData:
            return "Keychain API Key data invalid"
        case .timeout:
            return "Keychain request timed out"
        case .duplicateItem, .unexpectedStatus:
            return "Keychain access failed"
        }
    }
}

public enum ProviderSecretState: String, Codable, Equatable, Sendable {
    case available
    case missing
    case locked
    case accessDenied
    case invalid
    case unknownFailure

    public init(error: KeychainSecretError) {
        switch error {
        case .itemNotFound:
            self = .missing
        case .interactionNotAllowed, .timeout:
            self = .locked
        case .authenticationFailed, .userCancelled, .missingEntitlement:
            self = .accessDenied
        case .invalidData:
            self = .invalid
        case .duplicateItem, .unexpectedStatus:
            self = .unknownFailure
        }
    }

    public var label: String {
        switch self {
        case .available:
            return "API Key 可用"
        case .missing:
            return "API Key 未配置"
        case .locked:
            return "钥匙串需要重新授权"
        case .accessDenied:
            return "钥匙串访问被拒绝"
        case .invalid:
            return "API Key 数据无效"
        case .unknownFailure:
            return "钥匙串状态未知"
        }
    }
}

public enum ModelReadinessState: Equatable, Sendable {
    case noProvider
    case providerConfiguredButDisconnected(providerName: String)
    case providerConnectedNoModel(providerName: String)
    case ready(providerName: String, modelName: String)
    case error(message: String)

    public var isReady: Bool {
        if case .ready = self { return true }
        return false
    }

    public var label: String {
        switch self {
        case .noProvider:
            return "未选择 Provider"
        case .providerConfiguredButDisconnected(let providerName):
            return "\(providerName) 未连接"
        case .providerConnectedNoModel(let providerName):
            return "\(providerName) 已连接，但未选择默认模型"
        case .ready(let providerName, let modelName):
            return "\(providerName) / \(modelName) 已就绪"
        case .error(let message):
            return message
        }
    }

    public var shortLabel: String {
        switch self {
        case .noProvider:
            return "未选择 Provider"
        case .providerConfiguredButDisconnected:
            return "Provider 未连接"
        case .providerConnectedNoModel:
            return "未选择默认模型"
        case .ready:
            return "模型已就绪"
        case .error:
            return "模型错误"
        }
    }
}

public enum ProviderConnectionError: Error, Equatable, Sendable {
    case invalidBaseURL
    case missingAPIKey
    case keychain(KeychainSecretError)
    case unauthorized
    case modelNotFound
    case networkUnavailable
    case timeout
    case invalidResponse
    case unsupportedProvider
    case localServiceUnavailable

    public var status: ProviderConnectionStatus {
        switch self {
        case .missingAPIKey: return .missingAPIKey
        case .keychain(let error): return .failed(message: error.providerFacingMessage)
        case .unsupportedProvider: return .unsupported
        case .localServiceUnavailable: return .localServiceUnavailable
        case .invalidBaseURL: return .failed(message: "Base URL invalid")
        case .unauthorized: return .failed(message: "Authentication failed / 401")
        case .modelNotFound: return .failed(message: "Model not found / 404")
        case .networkUnavailable: return .failed(message: "Connection failed")
        case .timeout: return .failed(message: "Connection failed")
        case .invalidResponse: return .failed(message: "Connection failed")
        }
    }
}

public protocol SecretStore: Sendable {
    func save(_ secret: String, for secretID: String) async throws
    func read(_ secretID: String) async throws -> String?
    func read(_ secretID: String, accessMode: SecretAccessMode) async throws -> String?
    func delete(_ secretID: String) async throws
    func exists(_ secretID: String) async -> Bool
    func secretState(for secretID: String, accessMode: SecretAccessMode) async -> ProviderSecretState
}

public extension SecretStore {
    func read(_ secretID: String, accessMode: SecretAccessMode) async throws -> String? {
        try await read(secretID)
    }

    func secretState(for secretID: String, accessMode: SecretAccessMode = .nonInteractive) async -> ProviderSecretState {
        do {
            guard let secret = try await read(secretID, accessMode: accessMode) else {
                return .missing
            }
            return secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .invalid : .available
        } catch let error as KeychainSecretError {
            return ProviderSecretState(error: error)
        } catch {
            return .unknownFailure
        }
    }
}

public actor InMemorySecretStore: SecretStore {
    private var secrets: [String: String] = [:]

    public init() {}

    public func save(_ secret: String, for secretID: String) async throws {
        secrets[secretID] = secret
    }

    public func read(_ secretID: String) async throws -> String? {
        secrets[secretID]
    }

    public func read(_ secretID: String, accessMode: SecretAccessMode) async throws -> String? {
        try await read(secretID)
    }

    public func delete(_ secretID: String) async throws {
        secrets.removeValue(forKey: secretID)
    }

    public func exists(_ secretID: String) async -> Bool {
        secrets[secretID] != nil
    }

    public func secretState(for secretID: String, accessMode: SecretAccessMode = .nonInteractive) async -> ProviderSecretState {
        guard let secret = secrets[secretID] else { return .missing }
        return secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .invalid : .available
    }
}

public enum SecretMasking {
    public static func masked(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "未保存" }
        let suffix = value.suffix(4)
        return "sk-\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\(suffix)"
    }

    public static func redact(_ text: String) -> String {
        var redacted = text
        let patterns: [(String, String)] = [
            (#"(?i)authorization\s*[:=]\s*bearer\s+[^\s,;]+"#, "Authorization [redacted]"),
            (#"(?i)bearer\s+[^\s,;]+"#, "Bearer [redacted]"),
            (#"(?i)(api[-_ ]?key|token|secret)\s*[:=]\s*[^\s,;]+"#, "$1 [redacted]"),
            (#"sk-[A-Za-z0-9_\-]{8,}"#, "sk-[redacted]")
        ]
        for (pattern, replacement) in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(redacted.startIndex..<redacted.endIndex, in: redacted)
            redacted = regex.stringByReplacingMatches(in: redacted, range: range, withTemplate: replacement)
        }
        return redacted
    }
}
