import Foundation

public struct LLMChatMessage: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable {
        case system
        case user
        case assistant
        case tool
    }

    public var role: Role
    public var content: String
    public var timestamp: Date
    public var metadata: [String: String]
    public var toolCalls: [LLMToolCall]
    public var toolCallID: String?
    public var name: String?

    public init(role: Role,
                content: String,
                timestamp: Date = Date(),
                metadata: [String: String] = [:],
                toolCalls: [LLMToolCall] = [],
                toolCallID: String? = nil,
                name: String? = nil) {
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.metadata = metadata
        self.toolCalls = toolCalls
        self.toolCallID = toolCallID
        self.name = name
    }
}

public enum LLMToolChoice: String, Codable, Equatable, Sendable {
    case auto
    case none
}

public struct LLMChatRequest: Codable, Equatable, Sendable {
    public var messages: [LLMChatMessage]
    public var modelID: String
    public var temperature: Double?
    public var maxTokens: Int?
    public var tools: [LLMToolDefinition]
    public var toolChoice: LLMToolChoice?
    public var metadata: [String: String]

    public init(messages: [LLMChatMessage],
                modelID: String,
                temperature: Double? = nil,
                maxTokens: Int? = nil,
                tools: [LLMToolDefinition] = [],
                toolChoice: LLMToolChoice? = nil,
                metadata: [String: String] = [:]) {
        self.messages = messages
        self.modelID = modelID
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.tools = tools
        self.toolChoice = toolChoice
        self.metadata = metadata
    }
}

public struct LLMChatResponse: Codable, Equatable, Sendable {
    public var message: LLMChatMessage
    public var modelID: String
    public var toolCalls: [LLMToolCall]

    public init(message: LLMChatMessage, modelID: String, toolCalls: [LLMToolCall] = []) {
        self.message = message
        self.modelID = modelID
        self.toolCalls = toolCalls
    }
}

public struct LLMToolCallDelta: Codable, Equatable, Sendable {
    public var index: Int
    public var callID: String?
    public var nameFragment: String?
    public var argumentsFragment: String?

    public init(index: Int,
                callID: String? = nil,
                nameFragment: String? = nil,
                argumentsFragment: String? = nil) {
        self.index = index
        self.callID = callID
        self.nameFragment = nameFragment
        self.argumentsFragment = argumentsFragment
    }
}

public struct ProviderDelta: Codable, Equatable, Sendable {
    public var textDelta: String
    public var reasoningDelta: String
    public var toolCallDeltas: [LLMToolCallDelta]
    public var metadata: [String: String]
    public var usage: [String: Int]
    public var finishReason: String?
    public var error: String?
    public var cancellationAcknowledged: Bool

    public var text: String { textDelta }

    public var isEmpty: Bool {
        textDelta.isEmpty &&
            reasoningDelta.isEmpty &&
            toolCallDeltas.isEmpty &&
            metadata.isEmpty &&
            usage.isEmpty &&
            finishReason == nil &&
            error == nil &&
            !cancellationAcknowledged
    }

    public init(textDelta: String = "",
                reasoningDelta: String = "",
                toolCallDeltas: [LLMToolCallDelta] = [],
                metadata: [String: String] = [:],
                usage: [String: Int] = [:],
                finishReason: String? = nil,
                error: String? = nil,
                cancellationAcknowledged: Bool = false) {
        self.textDelta = textDelta
        self.reasoningDelta = reasoningDelta
        self.toolCallDeltas = toolCallDeltas
        self.metadata = metadata
        self.usage = usage
        self.finishReason = finishReason
        self.error = error
        self.cancellationAcknowledged = cancellationAcknowledged
    }

    public init(text: String) {
        self.init(textDelta: text)
    }
}

public typealias LLMChatResponseDelta = ProviderDelta

public protocol LLMClient: Sendable {
    var capabilities: Set<ModelCapability> { get }
    var toolCallingCapability: ProviderToolCallingCapability { get }
    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse
    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error>
    func listModels() async throws -> [ModelDescriptor]
    func testConnection() async -> ProviderConnectionStatus
}

public enum ProviderClientFactoryError: Error, Equatable, Sendable {
    case missingAPIKey
    case unsupportedProvider
    case invalidEndpoint
}

public enum LLMClientError: Error, Equatable, Sendable, LocalizedError {
    case invalidEndpoint
    case missingAPIKey
    case unauthorized
    case modelNotFound
    case keychain(KeychainSecretError)
    case connectionFailed
    case unsupportedProvider
    case invalidResponse
    case transportFailure(endpoint: String, code: String)
    case httpFailure(statusCode: Int, endpoint: String, message: String)
    case decodeFailure(endpoint: String, message: String)
    case unsupportedResponse(endpoint: String, message: String)
    case capabilityUnsupported(message: String)

    public enum FailureStage: String, Sendable {
        case configuration
        case transport
        case http
        case decode
        case capability
        case runtime
    }

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "base URL invalid"
        case .missingAPIKey:
            return "API Key empty"
        case .unauthorized:
            return "authentication failed / 401"
        case .modelNotFound:
            return "model not found / 404"
        case .keychain(let error):
            return error.providerFacingMessage
        case .connectionFailed:
            return "connection failed"
        case .unsupportedProvider:
            return "provider chat not supported"
        case .invalidResponse:
            return "connection failed"
        case .transportFailure:
            return "connection failed"
        case .httpFailure(let statusCode, _, _):
            if statusCode == 404 { return "model not found / 404" }
            if statusCode == 401 || statusCode == 403 { return "authentication failed / \(statusCode)" }
            return "provider request failed"
        case .decodeFailure, .unsupportedResponse:
            return "provider response unsupported"
        case .capabilityUnsupported:
            return "provider capability unsupported"
        }
    }

    public var failureStage: FailureStage {
        switch self {
        case .invalidEndpoint, .missingAPIKey, .keychain, .unsupportedProvider:
            return .configuration
        case .connectionFailed, .transportFailure:
            return .transport
        case .unauthorized, .modelNotFound, .httpFailure:
            return .http
        case .invalidResponse, .decodeFailure, .unsupportedResponse:
            return .decode
        case .capabilityUnsupported:
            return .capability
        }
    }

    public var diagnosticSummary: String {
        switch self {
        case .invalidEndpoint:
            return "stage=configuration reason=invalidEndpoint"
        case .missingAPIKey:
            return "stage=configuration reason=missingAPIKey"
        case .unauthorized:
            return "stage=http status=401or403 reason=unauthorized"
        case .modelNotFound:
            return "stage=http status=404 reason=modelNotFound"
        case .keychain(let error):
            return "stage=configuration reason=keychain status=\(error.status.map(String.init) ?? "none")"
        case .connectionFailed:
            return "stage=transport reason=connectionFailed"
        case .unsupportedProvider:
            return "stage=configuration reason=unsupportedProvider"
        case .invalidResponse:
            return "stage=decode reason=invalidResponse"
        case .transportFailure(let endpoint, let code):
            return "stage=transport endpoint=\(endpoint) code=\(code)"
        case .httpFailure(let statusCode, let endpoint, let message):
            return "stage=http endpoint=\(endpoint) status=\(statusCode) message=\(message)"
        case .decodeFailure(let endpoint, let message):
            return "stage=decode endpoint=\(endpoint) message=\(message)"
        case .unsupportedResponse(let endpoint, let message):
            return "stage=decode endpoint=\(endpoint) message=\(message)"
        case .capabilityUnsupported(let message):
            return "stage=capability message=\(message)"
        }
    }
}

public struct ProviderClientFactory: Sendable {
    private let http: any ProviderHTTPClient
    private let secretStore: any SecretStore

    public init(http: any ProviderHTTPClient = URLSessionProviderHTTPClient(),
                secretStore: any SecretStore) {
        self.http = http
        self.secretStore = secretStore
    }

    public func makeClient(provider: ProviderConfig) async throws -> any LLMClient {
        do {
            try ProviderEndpointPolicy.validate(provider)
        } catch {
            throw ProviderClientFactoryError.invalidEndpoint
        }
        if provider.type.requiresAPIKey {
            guard provider.apiKeySecretID != nil else {
                throw ProviderClientFactoryError.missingAPIKey
            }
        }
        switch provider.type {
        case .openAICompatible, .lmStudio:
            return OpenAICompatibleClient(provider: provider, http: http, secretStore: secretStore)
        case .ollama:
            return OllamaClient(provider: provider, http: http, secretStore: secretStore)
        case .anthropic, .customHTTP, .gemini:
            return ManualProviderClient(provider: provider, http: http, secretStore: secretStore)
        }
    }
}

private struct OpenAICompatibleClient: LLMClient {
    let provider: ProviderConfig
    let http: any ProviderHTTPClient
    let secretStore: any SecretStore
    private let chatTimeout: TimeInterval = 30

    var capabilities: Set<ModelCapability> { provider.capabilities }
    var toolCallingCapability: ProviderToolCallingCapability {
        ProviderToolCapabilityPolicy.capability(for: provider)
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        guard let url = endpoint(baseURL: provider.baseURL, path: "/v1/chat/completions") else {
            throw LLMClientError.invalidEndpoint
        }
        guard let secretID = provider.apiKeySecretID else {
            throw LLMClientError.missingAPIKey
        }
        let key = try await apiKey(secretID: secretID)

        let useProfileThinkingOption = Self.shouldDisableThinking(provider: provider, modelID: request.modelID)
        let response = try await performChatRequest(request,
                                                    url: url,
                                                    key: key,
                                                    disableThinking: useProfileThinkingOption)

        switch response.statusCode {
        case 200..<300:
            let decoded: OpenAIChatCompletionResponse
            do {
                decoded = try JSONDecoder().decode(OpenAIChatCompletionResponse.self, from: response.data)
            } catch {
                throw LLMClientError.decodeFailure(endpoint: safeEndpointDescription(url),
                                                   message: "openai-compatible chat decode failed")
            }
            guard let message = decoded.choices.first?.message else {
                throw LLMClientError.unsupportedResponse(endpoint: safeEndpointDescription(url),
                                                         message: "missing first choice message")
            }
            let sanitized = ModelResponseSanitizer.sanitize(content: message.content,
                                                            reasoningContent: message.reasoningContent)
            let toolCalls = message.resolvedToolCalls.map {
                LLMToolCall(id: $0.id,
                            name: $0.function.name,
                            argumentsJSON: $0.function.arguments)
            }
            guard !sanitized.visibleText.isEmpty || !toolCalls.isEmpty else {
                throw LLMClientError.unsupportedResponse(endpoint: safeEndpointDescription(url),
                                                         message: "empty visible content and no tool calls")
            }
            return LLMChatResponse(message: LLMChatMessage(role: .assistant,
                                                           content: sanitized.visibleText,
                                                           metadata: ["hadReasoning": sanitized.hadReasoning ? "true" : "false"]),
                                   modelID: decoded.model ?? request.modelID,
                                   toolCalls: toolCalls)
        case 401, 403:
            throw LLMClientError.unauthorized
        case 404:
            throw LLMClientError.modelNotFound
        default:
            throw LLMClientError.httpFailure(statusCode: response.statusCode,
                                             endpoint: safeEndpointDescription(url),
                                             message: safeHTTPErrorSummary(data: response.data))
        }
    }

    private func performChatRequest(_ request: LLMChatRequest,
                                    url: URL,
                                    key: String,
                                    disableThinking: Bool) async throws -> ProviderHTTPResponse {
        let first = try await performChatRequestOnce(request,
                                                     url: url,
                                                     key: key,
                                                     disableThinking: disableThinking)
        if disableThinking, first.statusCode == 400 {
            return try await performChatRequestOnce(request,
                                                    url: url,
                                                    key: key,
                                                    disableThinking: false)
        }
        return first
    }

    private func performChatRequestOnce(_ request: LLMChatRequest,
                                        url: URL,
                                        key: String,
                                        disableThinking: Bool) async throws -> ProviderHTTPResponse {
        var urlRequest = URLRequest(url: url, timeoutInterval: chatTimeout)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        urlRequest.httpBody = try JSONEncoder().encode(OpenAIChatCompletionRequest(
            model: request.modelID,
            messages: request.messages.map(OpenAIChatCompletionMessage.init),
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            stream: false,
            tools: request.tools,
            toolChoice: request.toolChoice,
            extraBody: Self.extraBody(disableThinking: disableThinking,
                                       provider: provider,
                                       modelID: request.modelID)))
        do {
            return try await http.data(for: urlRequest)
        } catch let error as LLMClientError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw LLMClientError.transportFailure(endpoint: safeEndpointDescription(url),
                                                  code: safeTransportCode(error))
        }
    }

    private static func shouldDisableThinking(provider: ProviderConfig,
                                              modelID: String,
                                              resolver: ProviderCapabilityProfileResolving = DefaultProviderCapabilityProfileResolver()) -> Bool {
        guard provider.type == .openAICompatible else { return false }
        let resolvedModelID = modelID.isEmpty ? (provider.defaultModelID ?? "") : modelID
        return resolver.capabilityProfile(provider: provider, modelID: resolvedModelID).disableThinkingOnFirstAttempt
    }

    private static func extraBody(disableThinking: Bool,
                                  resolver: ProviderCapabilityProfileResolving = DefaultProviderCapabilityProfileResolver(),
                                  provider: ProviderConfig,
                                  modelID: String) -> [String: OpenAIJSONValue] {
        var body: [String: OpenAIJSONValue] = [:]
        let resolvedModelID = modelID.isEmpty ? (provider.defaultModelID ?? "") : modelID
        if disableThinking {
            body["thinking"] = .object(["type": .string("disabled")])
            body["reasoning_split"] = .bool(true)
        }
        for (key, value) in resolver.capabilityProfile(provider: provider, modelID: resolvedModelID).requiredRequestFlags {
            switch value {
            case "disabled": body["thinking"] = .object(["type": .string(value)])
            case "true": body[key] = .bool(true)
            case "false": body[key] = .bool(false)
            default: body[key] = .string(value)
            }
        }
        return body
    }

    private func apiKey(secretID: String) async throws -> String {
        let key: String
        do {
            key = try await secretStore.read(secretID, accessMode: .userInitiated) ?? ""
        } catch let error as KeychainSecretError {
            throw LLMClientError.keychain(error)
        } catch {
            throw LLMClientError.missingAPIKey
        }
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LLMClientError.missingAPIKey
        }
        return key
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = endpoint(baseURL: provider.baseURL, path: "/v1/chat/completions") else {
                        throw LLMClientError.invalidEndpoint
                    }
                    guard let secretID = provider.apiKeySecretID else {
                        throw LLMClientError.missingAPIKey
                    }
                    let key = try await apiKey(secretID: secretID)
                    var urlRequest = URLRequest(url: url, timeoutInterval: chatTimeout)
                    urlRequest.httpMethod = "POST"
                    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    urlRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                    let disableThinking = Self.shouldDisableThinking(provider: provider, modelID: request.modelID)
                    urlRequest.httpBody = try JSONEncoder().encode(OpenAIChatCompletionRequest(
                        model: request.modelID,
                        messages: request.messages.map(OpenAIChatCompletionMessage.init),
                        temperature: request.temperature,
                        maxTokens: request.maxTokens,
                        stream: true,
                        tools: request.tools,
                        toolChoice: request.toolChoice,
                        extraBody: Self.extraBody(disableThinking: disableThinking,
                                       provider: provider,
                                       modelID: request.modelID)))

                    let stream = try await http.streamLines(for: urlRequest)
                    try throwIfProviderStreamStatusFailed(stream.statusCode,
                                                          endpoint: safeEndpointDescription(url))
                    let sanitizer = StreamingModelResponseSanitizer()
                    for try await line in stream.lines {
                        guard let rawDelta = try Self.parseStreamLine(line, endpoint: safeEndpointDescription(url)) else {
                            continue
                        }
                        var delta = rawDelta
                        let sanitized = sanitizer.ingest(contentDelta: rawDelta.textDelta,
                                                         reasoningDelta: rawDelta.reasoningDelta)
                        delta.textDelta = sanitized.visibleText
                        delta.reasoningDelta = sanitized.reasoningText ?? ""
                        if !delta.isEmpty {
                            continuation.yield(delta)
                        }
                    }
                    let final = sanitizer.finish()
                    if !final.visibleText.isEmpty || final.hadReasoning {
                        continuation.yield(ProviderDelta(textDelta: final.visibleText,
                                                         reasoningDelta: final.reasoningText ?? ""))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.yield(ProviderDelta(cancellationAcknowledged: true))
                    continuation.finish()
                } catch let error as LLMClientError {
                    continuation.finish(throwing: error)
                } catch {
                    continuation.finish(throwing: LLMClientError.transportFailure(
                        endpoint: safeEndpointDescription(provider.baseURL),
                        code: safeTransportCode(error)))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func parseStreamLine(_ line: String, endpoint: String) throws -> ProviderDelta? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix(":") else { return nil }
        let payload: String
        if trimmed.hasPrefix("data:") {
            payload = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if trimmed.hasPrefix("event:") {
            return nil
        } else {
            payload = trimmed
        }
        guard !payload.isEmpty else { return nil }
        if payload == "[DONE]" {
            return ProviderDelta(finishReason: "stop")
        }
        guard let data = payload.data(using: .utf8) else {
            throw LLMClientError.decodeFailure(endpoint: endpoint, message: "openai-compatible stream line not utf8")
        }
        let decoded: OpenAIChatCompletionStreamChunk
        do {
            decoded = try JSONDecoder().decode(OpenAIChatCompletionStreamChunk.self, from: data)
        } catch {
            throw LLMClientError.decodeFailure(endpoint: endpoint, message: "openai-compatible stream decode failed")
        }
        var text = ""
        var reasoning = ""
        var toolDeltas: [LLMToolCallDelta] = []
        var finishReason: String?
        for choice in decoded.choices {
            text += choice.delta?.content ?? ""
            reasoning += choice.delta?.reasoningContent ?? ""
            finishReason = finishReason ?? choice.finishReason
            if let functionCall = choice.delta?.functionCall {
                toolDeltas.append(LLMToolCallDelta(index: 0,
                                                   nameFragment: functionCall.name,
                                                   argumentsFragment: functionCall.arguments))
            }
            for toolCall in choice.delta?.toolCalls ?? [] {
                toolDeltas.append(LLMToolCallDelta(index: toolCall.index,
                                                   callID: toolCall.id,
                                                   nameFragment: toolCall.function?.name,
                                                   argumentsFragment: toolCall.function?.arguments))
            }
        }
        return ProviderDelta(textDelta: text,
                             reasoningDelta: reasoning,
                             toolCallDeltas: toolDeltas,
                             metadata: decoded.model.map { ["model": $0] } ?? [:],
                             usage: decoded.usage?.dictionary ?? [:],
                             finishReason: finishReason)
    }

    func listModels() async throws -> [ModelDescriptor] {
        try await ModelCatalogService(http: http, secretStore: secretStore).refreshModels(provider: provider)
    }

    func testConnection() async -> ProviderConnectionStatus {
        await ModelCatalogService(http: http, secretStore: secretStore).testConnection(provider: provider)
    }
}

private struct OllamaClient: LLMClient {
    let provider: ProviderConfig
    let http: any ProviderHTTPClient
    let secretStore: any SecretStore
    private let chatTimeout: TimeInterval = 30

    var capabilities: Set<ModelCapability> { provider.capabilities.union([.local]) }
    var toolCallingCapability: ProviderToolCallingCapability {
        ProviderToolCapabilityPolicy.capability(for: provider)
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        guard let url = endpoint(baseURL: provider.baseURL, path: "/api/chat") else {
            throw LLMClientError.invalidEndpoint
        }
        var urlRequest = URLRequest(url: url, timeoutInterval: chatTimeout)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(OllamaChatRequest(
            model: request.modelID,
            messages: request.messages.map {
                OllamaRequestMessage(role: $0.role.rawValue, content: $0.content)
            },
            stream: false,
            think: false,
            options: OllamaOptions(temperature: request.temperature, numPredict: request.maxTokens)))

        let response: ProviderHTTPResponse
        do {
            response = try await http.data(for: urlRequest)
        } catch let error as LLMClientError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw LLMClientError.transportFailure(endpoint: safeEndpointDescription(url),
                                                  code: safeTransportCode(error))
        }

        switch response.statusCode {
        case 200..<300:
            let decoded: OllamaChatResponse
            do {
                decoded = try JSONDecoder().decode(OllamaChatResponse.self, from: response.data)
            } catch {
                throw LLMClientError.decodeFailure(endpoint: safeEndpointDescription(url),
                                                   message: "ollama chat decode failed")
            }
            let sanitized = ModelResponseSanitizer.sanitize(content: decoded.message.content,
                                                            reasoningContent: decoded.message.thinking)
            let toolCalls = decoded.message.resolvedToolCalls
            guard !sanitized.visibleText.isEmpty || !toolCalls.isEmpty else {
                throw LLMClientError.unsupportedResponse(endpoint: safeEndpointDescription(url),
                                                         message: "empty visible content after thinking redaction")
            }
            return LLMChatResponse(message: LLMChatMessage(role: .assistant,
                                                           content: sanitized.visibleText,
                                                           metadata: ["hadReasoning": sanitized.hadReasoning ? "true" : "false"]),
                                   modelID: decoded.model ?? request.modelID,
                                   toolCalls: toolCalls)
        case 401, 403:
            throw LLMClientError.unauthorized
        case 404:
            throw LLMClientError.modelNotFound
        default:
            throw LLMClientError.httpFailure(statusCode: response.statusCode,
                                             endpoint: safeEndpointDescription(url),
                                             message: safeHTTPErrorSummary(data: response.data))
        }
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = endpoint(baseURL: provider.baseURL, path: "/api/chat") else {
                        throw LLMClientError.invalidEndpoint
                    }
                    var urlRequest = URLRequest(url: url, timeoutInterval: chatTimeout)
                    urlRequest.httpMethod = "POST"
                    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    urlRequest.httpBody = try JSONEncoder().encode(OllamaChatRequest(
                        model: request.modelID,
                        messages: request.messages.map {
                            OllamaRequestMessage(role: $0.role.rawValue, content: $0.content)
                        },
                        stream: true,
                        think: false,
                        options: OllamaOptions(temperature: request.temperature, numPredict: request.maxTokens)))

                    let stream = try await http.streamLines(for: urlRequest)
                    try throwIfProviderStreamStatusFailed(stream.statusCode,
                                                          endpoint: safeEndpointDescription(url))
                    let sanitizer = StreamingModelResponseSanitizer()
                    for try await line in stream.lines {
                        let chunk = try OllamaStreamingChunkParser.parseLine(line)
                        let sanitized = sanitizer.ingest(contentDelta: chunk.textDelta,
                                                         reasoningDelta: chunk.thinkingDelta)
                        let delta = ProviderDelta(textDelta: sanitized.visibleText,
                                                  reasoningDelta: sanitized.reasoningText ?? "",
                                                  toolCallDeltas: chunk.toolCallDeltas,
                                                  finishReason: chunk.done ? "stop" : nil)
                        if !delta.isEmpty {
                            continuation.yield(delta)
                        }
                    }
                    let final = sanitizer.finish()
                    if !final.visibleText.isEmpty || final.hadReasoning {
                        continuation.yield(ProviderDelta(textDelta: final.visibleText,
                                                         reasoningDelta: final.reasoningText ?? ""))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.yield(ProviderDelta(cancellationAcknowledged: true))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func listModels() async throws -> [ModelDescriptor] {
        try await ModelCatalogService(http: http, secretStore: secretStore).refreshModels(provider: provider)
    }

    func testConnection() async -> ProviderConnectionStatus {
        await ModelCatalogService(http: http, secretStore: secretStore).testConnection(provider: provider)
    }
}

private struct OllamaRequestMessage: Codable, Equatable {
    var role: String
    var content: String
}

private struct OllamaOptions: Codable, Equatable {
    var temperature: Double?
    var numPredict: Int?

    enum CodingKeys: String, CodingKey {
        case temperature
        case numPredict = "num_predict"
    }
}

private struct OllamaChatRequest: Codable, Equatable {
    var model: String
    var messages: [OllamaRequestMessage]
    var stream: Bool
    var think: Bool?
    var options: OllamaOptions?

    init(model: String,
         messages: [OllamaRequestMessage],
         stream: Bool,
         think: Bool?,
         options: OllamaOptions) {
        self.model = model
        self.messages = messages
        self.stream = stream
        self.think = think
        self.options = options.temperature == nil && options.numPredict == nil ? nil : options
    }
}

private struct OllamaChatResponse: Decodable, Equatable {
    var model: String?
    var message: OllamaResponseMessage
    var done: Bool?
    var error: String?
}

private struct OllamaResponseMessage: Decodable, Equatable {
    var role: String?
    var content: String?
    var thinking: String?
    var toolCalls: [OllamaToolCall]?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case thinking
        case toolCalls = "tool_calls"
    }

    var resolvedToolCalls: [LLMToolCall] {
        (toolCalls ?? []).compactMap { call in
            guard let name = call.function?.name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return nil
            }
            return LLMToolCall(id: call.id, name: name, argumentsJSON: call.function?.arguments.jsonString ?? "{}")
        }
    }
}

private struct OllamaToolCall: Decodable, Equatable {
    struct Function: Decodable, Equatable {
        var name: String
        var arguments: OllamaToolArguments
    }

    var id: String?
    var function: Function?
}

private enum OllamaToolArguments: Decodable, Equatable {
    case string(String)
    case value(LLMJSONValue)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            self = .string(string)
        } else {
            self = .value(try container.decode(LLMJSONValue.self))
        }
    }

    var jsonString: String {
        switch self {
        case .string(let value):
            return value
        case .value(let value):
            guard let data = try? JSONEncoder().encode(value),
                  let string = String(data: data, encoding: .utf8) else {
                return "{}"
            }
            return string
        }
    }
}

public struct OllamaStreamingChunk: Equatable, Sendable {
    public var textDelta: String
    public var thinkingDelta: String
    public var toolCallDeltas: [LLMToolCallDelta]
    public var done: Bool

    public init(textDelta: String = "",
                thinkingDelta: String = "",
                toolCallDeltas: [LLMToolCallDelta] = [],
                done: Bool = false) {
        self.textDelta = textDelta
        self.thinkingDelta = thinkingDelta
        self.toolCallDeltas = toolCallDeltas
        self.done = done
    }
}

public enum OllamaStreamingChunkParser {
    public static func parseLine(_ line: String) throws -> OllamaStreamingChunk {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            throw LLMClientError.decodeFailure(endpoint: "ollama-stream", message: "empty stream line")
        }
        let response: OllamaChatResponse
        do {
            response = try JSONDecoder().decode(OllamaChatResponse.self, from: data)
        } catch {
            throw LLMClientError.decodeFailure(endpoint: "ollama-stream", message: "stream chunk decode failed")
        }
        return OllamaStreamingChunk(
            textDelta: response.message.content ?? "",
            thinkingDelta: response.message.thinking ?? "",
            toolCallDeltas: response.message.resolvedToolCalls.enumerated().map { index, call in
                LLMToolCallDelta(index: index,
                                 callID: call.id,
                                 nameFragment: call.name,
                                 argumentsFragment: call.argumentsJSON)
            },
            done: response.done ?? false)
    }
}

private enum OpenAIJSONValue: Encodable, Equatable {
    case bool(Bool)
    case string(String)
    case object([String: OpenAIJSONValue])

    func encode(to encoder: Encoder) throws {
        switch self {
        case .bool(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .string(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .object(let values):
            var container = encoder.container(keyedBy: DynamicCodingKey.self)
            for (key, value) in values {
                try container.encode(value, forKey: DynamicCodingKey(key))
            }
        }
    }
}

private struct OpenAIChatCompletionRequest: Encodable, Equatable {
    var model: String
    var messages: [OpenAIChatCompletionMessage]
    var temperature: Double?
    var maxTokens: Int?
    var stream: Bool
    var tools: [LLMToolDefinition] = []
    var toolChoice: LLMToolChoice?
    var extraBody: [String: OpenAIJSONValue] = [:]

    enum CodingKeys: String, CodingKey {
        case model
        case messages
        case temperature
        case maxTokens = "max_tokens"
        case stream
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        try container.encode(model, forKey: DynamicCodingKey("model"))
        try container.encode(messages, forKey: DynamicCodingKey("messages"))
        try container.encodeIfPresent(temperature, forKey: DynamicCodingKey("temperature"))
        try container.encodeIfPresent(maxTokens, forKey: DynamicCodingKey("max_tokens"))
        try container.encode(stream, forKey: DynamicCodingKey("stream"))
        if !tools.isEmpty {
            try container.encode(tools.map(OpenAIToolDefinition.init), forKey: DynamicCodingKey("tools"))
            try container.encode((toolChoice ?? .auto).rawValue, forKey: DynamicCodingKey("tool_choice"))
        } else if let toolChoice {
            try container.encode(toolChoice.rawValue, forKey: DynamicCodingKey("tool_choice"))
        }
        for (key, value) in extraBody {
            try container.encode(value, forKey: DynamicCodingKey(key))
        }
    }
}

private struct OpenAIChatCompletionMessage: Encodable, Equatable {
    var role: String
    var content: String?
    var toolCalls: [OpenAIToolCallMessage]?
    var toolCallID: String?
    var name: String?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case toolCalls = "tool_calls"
        case toolCallID = "tool_call_id"
        case name
    }

    init(_ message: LLMChatMessage) {
        self.role = message.role.rawValue
        self.content = message.role == .assistant && !message.toolCalls.isEmpty ? nil : message.content
        self.toolCalls = message.toolCalls.isEmpty ? nil : message.toolCalls.map(OpenAIToolCallMessage.init)
        self.toolCallID = message.toolCallID
        self.name = message.name
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(role, forKey: .role)
        if let content {
            try container.encode(content, forKey: .content)
        } else {
            try container.encodeNil(forKey: .content)
        }
        try container.encodeIfPresent(toolCalls, forKey: .toolCalls)
        try container.encodeIfPresent(toolCallID, forKey: .toolCallID)
        try container.encodeIfPresent(name, forKey: .name)
    }
}

private struct OpenAIToolCallMessage: Encodable, Equatable {
    struct Function: Encodable, Equatable {
        var name: String
        var arguments: String
    }

    var id: String
    var type: String = "function"
    var function: Function

    init(_ call: LLMToolCall) {
        self.id = call.id ?? ""
        self.function = Function(name: call.name, arguments: call.argumentsJSON)
    }
}

private struct OpenAIChatCompletionResponse: Decodable, Equatable {
    struct Choice: Decodable, Equatable {
        var message: OpenAIChatCompletionResponseMessage
    }

    var model: String?
    var choices: [Choice]
}

private struct OpenAIChatCompletionStreamChunk: Decodable, Equatable {
    struct Choice: Decodable, Equatable {
        var delta: OpenAIChatCompletionStreamDelta?
        var finishReason: String?

        enum CodingKeys: String, CodingKey {
            case delta
            case finishReason = "finish_reason"
        }
    }

    var model: String?
    var choices: [Choice]
    var usage: OpenAIUsage?
}

private struct OpenAIChatCompletionStreamDelta: Decodable, Equatable {
    var role: String?
    var content: String?
    var reasoningContent: String?
    var toolCalls: [OpenAIToolCallDelta]?
    var functionCall: OpenAIToolCallDelta.Function?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case reasoningContent = "reasoning_content"
        case toolCalls = "tool_calls"
        case functionCall = "function_call"
    }
}

private struct OpenAIToolCallDelta: Decodable, Equatable {
    struct Function: Decodable, Equatable {
        var name: String?
        var arguments: String?
    }

    var index: Int
    var id: String?
    var type: String?
    var function: Function?
}

private struct OpenAIUsage: Decodable, Equatable {
    var promptTokens: Int?
    var completionTokens: Int?
    var totalTokens: Int?

    enum CodingKeys: String, CodingKey {
        case promptTokens = "prompt_tokens"
        case completionTokens = "completion_tokens"
        case totalTokens = "total_tokens"
    }

    var dictionary: [String: Int] {
        var result: [String: Int] = [:]
        if let promptTokens { result["promptTokens"] = promptTokens }
        if let completionTokens { result["completionTokens"] = completionTokens }
        if let totalTokens { result["totalTokens"] = totalTokens }
        return result
    }
}

private struct OpenAIChatCompletionResponseMessage: Decodable, Equatable {
    var role: String?
    var content: String?
    var reasoningContent: String?
    var toolCalls: [OpenAIToolCall]?
    var functionCall: OpenAIToolCall.Function?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case reasoningContent = "reasoning_content"
        case toolCalls = "tool_calls"
        case functionCall = "function_call"
    }

    var resolvedToolCalls: [OpenAIToolCall] {
        if let toolCalls, !toolCalls.isEmpty { return toolCalls }
        if let functionCall {
            return [OpenAIToolCall(id: nil, type: "function", function: functionCall)]
        }
        return []
    }
}

private struct OpenAIToolDefinition: Encodable, Equatable {
    struct Function: Encodable, Equatable {
        var name: String
        var description: String
        var parameters: LLMJSONValue
    }

    var type: String = "function"
    var function: Function

    init(_ definition: LLMToolDefinition) {
        self.function = Function(name: definition.name,
                                 description: definition.description,
                                 parameters: definition.parameters)
    }
}

private struct OpenAIToolCall: Decodable, Equatable {
    struct Function: Decodable, Equatable {
        var name: String
        var arguments: String
    }

    var id: String?
    var type: String?
    var function: Function
}

private struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        return nil
    }
}

private func endpoint(baseURL: URL, path: String) -> URL? {
    var raw = baseURL.absoluteString
    while raw.hasSuffix("/") { raw.removeLast() }
    let normalizedPath: String
    if path.hasPrefix("/v1/"), raw.hasSuffix("/v1") {
        normalizedPath = String(path.dropFirst(3))
    } else {
        normalizedPath = path
    }
    return URL(string: raw + normalizedPath)
}

private func safeEndpointDescription(_ url: URL) -> String {
    var components = URLComponents()
    components.scheme = url.scheme
    components.host = url.host
    components.port = url.port
    components.path = url.path
    return components.string ?? url.path
}

private func throwIfProviderStreamStatusFailed(_ statusCode: Int, endpoint: String) throws {
    switch statusCode {
    case 200..<300:
        return
    case 401, 403:
        throw LLMClientError.unauthorized
    case 404:
        throw LLMClientError.modelNotFound
    default:
        throw LLMClientError.httpFailure(statusCode: statusCode,
                                         endpoint: endpoint,
                                         message: "stream-status-\(statusCode)")
    }
}

private func safeTransportCode(_ error: Error) -> String {
    if let urlError = error as? URLError {
        return "URLError.\(urlError.code.rawValue)"
    }
    return String(describing: type(of: error))
}

private func safeHTTPErrorSummary(data: Data) -> String {
    guard !data.isEmpty else { return "empty-body" }
    if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        for key in ["error", "message", "detail"] {
            if let value = object[key] as? String {
                return SecretMasking.redact(String(value.prefix(180)))
            }
        }
    }
    let raw = String(data: Data(data.prefix(240)), encoding: .utf8) ?? "non-utf8-body"
    return SecretMasking.redact(raw.replacingOccurrences(of: "\n", with: " "))
}

private struct ManualProviderClient: LLMClient {
    let provider: ProviderConfig
    let http: any ProviderHTTPClient
    let secretStore: any SecretStore

    var capabilities: Set<ModelCapability> { provider.capabilities }
    var toolCallingCapability: ProviderToolCallingCapability {
        ProviderToolCapabilityPolicy.capability(for: provider)
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        throw LLMClientError.unsupportedProvider
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish()
        }
    }

    func listModels() async throws -> [ModelDescriptor] {
        try await ModelCatalogService(http: http, secretStore: secretStore).refreshModels(provider: provider)
    }

    func testConnection() async -> ProviderConnectionStatus {
        await ModelCatalogService(http: http, secretStore: secretStore).testConnection(provider: provider)
    }
}
