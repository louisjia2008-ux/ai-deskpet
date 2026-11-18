import Foundation

public struct ProviderHTTPResponse: Sendable, Equatable {
    public var statusCode: Int
    public var data: Data

    public init(statusCode: Int, data: Data) {
        self.statusCode = statusCode
        self.data = data
    }
}

public struct ProviderHTTPLineStream: Sendable {
    public var statusCode: Int
    public var lines: AsyncThrowingStream<String, Error>

    public init(statusCode: Int, lines: AsyncThrowingStream<String, Error>) {
        self.statusCode = statusCode
        self.lines = lines
    }
}

public protocol ProviderHTTPClient: Sendable {
    func data(for request: URLRequest) async throws -> ProviderHTTPResponse
    func streamLines(for request: URLRequest) async throws -> ProviderHTTPLineStream
}

public extension ProviderHTTPClient {
    func streamLines(for request: URLRequest) async throws -> ProviderHTTPLineStream {
        let response = try await data(for: request)
        let lines = AsyncThrowingStream<String, Error> { continuation in
            let raw = String(data: response.data, encoding: .utf8) ?? ""
            for line in raw.split(whereSeparator: \.isNewline) {
                continuation.yield(String(line))
            }
            continuation.finish()
        }
        return ProviderHTTPLineStream(statusCode: response.statusCode, lines: lines)
    }
}

public final class URLSessionProviderHTTPClient: ProviderHTTPClient, @unchecked Sendable {
    public static let maximumBufferedResponseBytes = 8 * 1024 * 1024
    public static let maximumStreamBytes = 16 * 1024 * 1024
    public static let maximumStreamLineBytes = 1 * 1024 * 1024
    public static let maximumStreamLines = 10_000
    private let session: URLSession

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: configuration,
                                  delegate: ProviderRedirectBlockingDelegate(),
                                  delegateQueue: nil)
    }

    public func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        let timeout = max(1, min(request.timeoutInterval, 120))
        return try await withThrowingTaskGroup(of: ProviderHTTPResponse.self) { group in
            group.addTask {
                let (bytes, response) = try await self.session.bytes(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw ProviderConnectionError.invalidResponse
                }
                if http.expectedContentLength > Int64(Self.maximumBufferedResponseBytes) {
                    throw ProviderConnectionError.invalidResponse
                }
                var data = Data()
                data.reserveCapacity(min(max(0, Int(http.expectedContentLength)),
                                         Self.maximumBufferedResponseBytes))
                for try await byte in bytes {
                    guard data.count < Self.maximumBufferedResponseBytes else {
                        throw ProviderConnectionError.invalidResponse
                    }
                    data.append(byte)
                }
                return ProviderHTTPResponse(statusCode: http.statusCode, data: data)
            }
            group.addTask {
                let nanoseconds = UInt64(timeout * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanoseconds)
                throw URLError(.timedOut)
            }
            guard let response = try await group.next() else {
                group.cancelAll()
                throw ProviderConnectionError.invalidResponse
            }
            group.cancelAll()
            return response
        }
    }

    public func streamLines(for request: URLRequest) async throws -> ProviderHTTPLineStream {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ProviderConnectionError.invalidResponse
        }
        let lines = AsyncThrowingStream<String, Error>(bufferingPolicy: .bufferingOldest(32)) { continuation in
            let task = Task {
                do {
                    let startedAt = Date()
                    var aggregateBytes = 0
                    var lineCount = 0
                    var pending = Data()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        aggregateBytes += 1
                        guard aggregateBytes <= Self.maximumStreamBytes,
                              pending.count < Self.maximumStreamLineBytes,
                              Date().timeIntervalSince(startedAt) <= 120 else {
                            throw ProviderConnectionError.invalidResponse
                        }
                        if byte == 0x0A {
                            if pending.last == 0x0D { pending.removeLast() }
                            guard let line = String(data: pending, encoding: .utf8) else {
                                throw ProviderConnectionError.invalidResponse
                            }
                            pending.removeAll(keepingCapacity: true)
                            lineCount += 1
                            guard lineCount <= Self.maximumStreamLines else {
                                throw ProviderConnectionError.invalidResponse
                            }
                            switch continuation.yield(line) {
                            case .enqueued:
                                break
                            case .dropped:
                                throw ProviderConnectionError.invalidResponse
                            case .terminated:
                                return
                            @unknown default:
                                throw ProviderConnectionError.invalidResponse
                            }
                        } else {
                            pending.append(byte)
                        }
                    }
                    if !pending.isEmpty {
                        guard let line = String(data: pending, encoding: .utf8),
                              lineCount < Self.maximumStreamLines else {
                            throw ProviderConnectionError.invalidResponse
                        }
                        switch continuation.yield(line) {
                        case .enqueued:
                            break
                        case .dropped:
                            throw ProviderConnectionError.invalidResponse
                        case .terminated:
                            return
                        @unknown default:
                            throw ProviderConnectionError.invalidResponse
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return ProviderHTTPLineStream(statusCode: http.statusCode, lines: lines)
    }
}

private final class ProviderRedirectBlockingDelegate: NSObject,
                                                       URLSessionTaskDelegate,
                                                       @unchecked Sendable {
    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Provider credentials and prompts are destination-bound. Provider
        // endpoints must be configured at their final origin.
        completionHandler(nil)
    }
}

public struct ModelCatalogService: Sendable {
    private let http: any ProviderHTTPClient
    private let secretStore: any SecretStore

    public init(http: any ProviderHTTPClient = URLSessionProviderHTTPClient(),
                secretStore: any SecretStore) {
        self.http = http
        self.secretStore = secretStore
    }

    public func testConnection(provider: ProviderConfig,
                               secretAccessMode: SecretAccessMode = .userInitiated) async -> ProviderConnectionStatus {
        do {
            _ = try await refreshModels(provider: provider, secretAccessMode: secretAccessMode)
            return .connected
        } catch let error as ProviderConnectionError {
            return error.status
        } catch {
            return ProviderConnectionError.networkUnavailable.status
        }
    }

    public func refreshModels(provider: ProviderConfig,
                              secretAccessMode: SecretAccessMode = .userInitiated) async throws -> [ModelDescriptor] {
        guard provider.enabled else { throw ProviderConnectionError.invalidResponse }
        do {
            try ProviderEndpointPolicy.validate(provider)
        } catch {
            throw ProviderConnectionError.invalidBaseURL
        }
        if provider.type == .anthropic {
            _ = try await secretValueIfNeeded(provider, accessMode: secretAccessMode)
            return builtInAnthropicModels(providerID: provider.id)
        }
        if provider.type == .customHTTP || provider.type == .gemini {
            throw ProviderConnectionError.unsupportedProvider
        }
        let key = try await secretValueIfNeeded(provider, accessMode: secretAccessMode)

        guard let url = modelsURL(for: provider) else {
            throw ProviderConnectionError.invalidBaseURL
        }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "GET"
        if let key, !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }

        let response: ProviderHTTPResponse
        do {
            response = try await http.data(for: request)
        } catch let error as ProviderConnectionError {
            throw error
        } catch {
            if provider.type == .ollama { throw ProviderConnectionError.localServiceUnavailable }
            throw ProviderConnectionError.networkUnavailable
        }
        switch response.statusCode {
        case 200..<300:
            do {
                return try decodeModels(provider: provider, data: response.data)
            } catch let error as ProviderConnectionError {
                throw error
            } catch {
                throw ProviderConnectionError.invalidResponse
            }
        case 401, 403:
            throw ProviderConnectionError.unauthorized
        case 404:
            throw ProviderConnectionError.modelNotFound
        default:
            throw ProviderConnectionError.invalidResponse
        }
    }

    public func listManualModels(provider: ProviderConfig, manualModelID: String?) -> [ModelDescriptor] {
        let trimmedModelID = manualModelID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedModelID.isEmpty else {
            return []
        }
        return [ModelDescriptor(id: trimmedModelID, providerID: provider.id, source: .manual)]
    }

    private func secretValueIfNeeded(_ provider: ProviderConfig,
                                     accessMode: SecretAccessMode) async throws -> String? {
        guard provider.type.requiresAPIKey else { return nil }
        guard let secretID = provider.apiKeySecretID else {
            throw ProviderConnectionError.missingAPIKey
        }
        do {
            guard let key = try await secretStore.read(secretID, accessMode: accessMode) else {
                throw ProviderConnectionError.missingAPIKey
            }
            let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { throw ProviderConnectionError.missingAPIKey }
            return trimmed
        } catch let error as KeychainSecretError {
            if case .itemNotFound = error {
                throw ProviderConnectionError.missingAPIKey
            }
            throw ProviderConnectionError.keychain(error)
        }
    }

    private func modelsURL(for provider: ProviderConfig) -> URL? {
        switch provider.type {
        case .openAICompatible, .lmStudio:
            return endpoint(baseURL: provider.baseURL, path: "/v1/models")
        case .ollama:
            return endpoint(baseURL: provider.baseURL, path: "/api/tags")
        case .anthropic, .customHTTP, .gemini:
            return nil
        }
    }

    private func endpoint(baseURL: URL, path: String) -> URL? {
        var raw = baseURL.absoluteString
        while raw.hasSuffix("/") { raw.removeLast() }
        let normalizedPath: String
        if path == "/v1/models", raw.hasSuffix("/v1") {
            normalizedPath = "/models"
        } else {
            normalizedPath = path
        }
        return URL(string: raw + normalizedPath)
    }

    private func decodeModels(provider: ProviderConfig, data: Data) throws -> [ModelDescriptor] {
        switch provider.type {
        case .openAICompatible, .lmStudio:
            let response = try JSONDecoder().decode(OpenAIModelsResponse.self, from: data)
            guard response.data.count <= 2_000,
                  response.data.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 512 }) else {
                throw ProviderConnectionError.invalidResponse
            }
            return response.data.map {
                ModelDescriptor(id: $0.id, providerID: provider.id, capabilities: provider.capabilities, source: .fetched)
            }
        case .ollama:
            let response = try JSONDecoder().decode(OllamaTagsResponse.self, from: data)
            guard response.models.count <= 2_000,
                  response.models.allSatisfy({ !$0.name.isEmpty && $0.name.utf8.count <= 512 }) else {
                throw ProviderConnectionError.invalidResponse
            }
            return response.models.map {
                ModelDescriptor(id: $0.name, providerID: provider.id, capabilities: provider.capabilities.union([.local]), source: .fetched)
            }
        case .anthropic:
            return builtInAnthropicModels(providerID: provider.id)
        case .customHTTP, .gemini:
            throw ProviderConnectionError.unsupportedProvider
        }
    }

    private func builtInAnthropicModels(providerID: String) -> [ModelDescriptor] {
        [
            ModelDescriptor(id: "claude-3-5-sonnet-latest", providerID: providerID, capabilities: [.chat, .vision, .toolCalling], source: .builtIn),
            ModelDescriptor(id: "claude-3-5-haiku-latest", providerID: providerID, capabilities: [.chat], source: .builtIn),
        ]
    }
}

private struct OpenAIModelsResponse: Decodable {
    struct Item: Decodable { var id: String }
    var data: [Item]
}

private struct OllamaTagsResponse: Decodable {
    struct Item: Decodable { var name: String }
    var models: [Item]
}
