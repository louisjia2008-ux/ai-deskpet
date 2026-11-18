import XCTest
import Foundation
import AICore
@testable import DeskPet

private struct MockProviderHTTPClient: ProviderHTTPClient {
    var response: ProviderHTTPResponse
    var error: Error?

    func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        if let error { throw error }
        return response
    }
}

private enum MockSecretStoreError: Error {
    case saveFailed
}

private actor FailingSecretStore: SecretStore {
    func save(_ secret: String, for secretID: String) async throws {
        throw MockSecretStoreError.saveFailed
    }

    func read(_ secretID: String) async throws -> String? {
        nil
    }

    func delete(_ secretID: String) async throws {}

    func exists(_ secretID: String) async -> Bool {
        false
    }
}

@MainActor
final class ProviderStoreTests: XCTestCase {
    func testProviderStoreDoesNotPersistAPIKey() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let secretStore = InMemorySecretStore()
        let store = ProviderStore(fileURL: url, secretStore: secretStore)
        let provider = ProviderConfig(displayName: "Test OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      enabled: true)
        let sensitiveValue = "value-\(UUID().uuidString)"

        await store.upsert(provider, apiKey: sensitiveValue, manualModelID: "gpt-test")

        let persisted = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(persisted.contains(sensitiveValue))
        let saved = store.providers.first { $0.displayName == "Test OpenAI" }
        XCTAssertNotNil(saved?.apiKeySecretID)
        let secretExists = await secretStore.exists(saved!.apiKeySecretID!)
        XCTAssertTrue(secretExists)
    }

    func testProviderStoreTrimsAPIKeyBeforeSaving() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let secretStore = InMemorySecretStore()
        let store = ProviderStore(fileURL: url, secretStore: secretStore)
        let provider = ProviderConfig(displayName: "Test OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      enabled: true)

        await store.upsert(provider,
                           apiKey: "\n  test-key-placeholder  \t",
                           manualModelID: "gpt-test")

        let saved = store.providers.first { $0.displayName == "Test OpenAI" }
        let savedSecret = try await secretStore.read(saved!.apiKeySecretID!)
        XCTAssertEqual(savedSecret, "test-key-placeholder")
    }

    func testProviderStoreSaveFailureDoesNotPersistNewProvider() async {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let store = ProviderStore(fileURL: url, secretStore: FailingSecretStore())
        let provider = ProviderConfig(displayName: "Test OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      enabled: true)

        let result = await store.upsert(provider,
                                        apiKey: "test-key-placeholder",
                                        manualModelID: "gpt-test")

        XCTAssertFalse(result.isSuccess)
        XCTAssertFalse(store.providers.contains { $0.id == provider.id })
        XCTAssertEqual(store.statuses[provider.id], .failed(message: "API Key save failed"))
    }

    func testDeletingProviderClearsDefaults() async {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let store = ProviderStore(fileURL: url, secretStore: InMemorySecretStore())
        let provider = ProviderConfig(displayName: "Local",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      defaultModelID: "llama3",
                                      enabled: true)
        await store.upsert(provider, manualModelID: "llama3")
        store.setDefault(role: .companion, providerID: provider.id, modelID: "llama3")

        await store.deleteProvider(id: provider.id)

        XCTAssertNil(store.defaults.companionModelProviderID)
        XCTAssertNil(store.defaults.companionModelID)
    }
}

final class ProviderEditorDraftTests: XCTestCase {
    func testAPIKeyPasteTrimsWhitespaceAndNewlines() {
        var draft = ProviderEditorDraft(provider: nil)

        draft.pasteAPIKey("\n  test-key-placeholder  \r\n")

        XCTAssertEqual(draft.apiKey, "test-key-placeholder")
    }

    func testValidationRejectsInvalidBaseURL() {
        var draft = ProviderEditorDraft(provider: nil)
        draft.name = "Test Provider"
        draft.baseURL = "not-a-url"
        draft.apiKey = "test-key-placeholder"

        let result = draft.makeProviderConfig(existingProvider: nil)

        XCTAssertEqual(result, .failure(.baseURLInvalid))
    }

    func testValidationRejectsCleartextRemoteProviderAndAllowsLoopbackLocalProvider() {
        var remote = ProviderEditorDraft(provider: nil)
        remote.name = "Remote"
        remote.type = .openAICompatible
        remote.baseURL = "http://api.example.com"
        remote.apiKey = "test-key-placeholder"
        XCTAssertEqual(remote.makeProviderConfig(existingProvider: nil),
                       .failure(.baseURLInvalid))

        var local = ProviderEditorDraft(provider: nil)
        local.name = "Local"
        local.type = .ollama
        local.baseURL = "http://127.0.0.1:11434"
        guard case .success = local.makeProviderConfig(existingProvider: nil) else {
            return XCTFail("canonical keyless loopback provider should be allowed")
        }
    }

    func testValidationRejectsEmptyRequiredAPIKey() {
        var draft = ProviderEditorDraft(provider: nil)
        draft.name = "Test Provider"
        draft.baseURL = "https://example.com"
        draft.apiKey = " \n "

        let result = draft.makeProviderConfig(existingProvider: nil)

        XCTAssertEqual(result, .failure(.apiKeyEmpty))
    }

    func testValidationAllowsExistingSavedSecretWithoutRetypingAPIKey() {
        let provider = ProviderConfig(displayName: "Test Provider",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      apiKeySecretID: "provider.test.apiKey")
        var draft = ProviderEditorDraft(provider: provider)
        draft.name = "Renamed Provider"

        let result = draft.makeProviderConfig(existingProvider: provider)

        guard case .success(let config) = result else {
            return XCTFail("expected existing secret to satisfy required API key validation")
        }
        XCTAssertEqual(config.apiKeySecretID, "provider.test.apiKey")
    }

    func testManualModelIDIsTrimmedBeforeConfigCreation() {
        var draft = ProviderEditorDraft(provider: nil)
        draft.name = "Test Provider"
        draft.baseURL = "https://example.com"
        draft.apiKey = "test-key-placeholder"
        draft.manualModelID = "  gpt-test  \n"

        let result = draft.makeProviderConfig(existingProvider: nil)

        guard case .success(let config) = result else {
            return XCTFail("expected valid config")
        }
        XCTAssertEqual(config.defaultModelID, "gpt-test")
    }

    func testMaskedDisplayHelperDoesNotReturnFullAPIKey() {
        let raw = "test-key-placeholder-1234"

        let masked = ProviderEditorDraft.maskedAPIKeyDisplay(apiKey: raw, hasSavedSecret: false)

        XCTAssertNotEqual(masked, raw)
        XCTAssertFalse(masked.contains(raw))
        XCTAssertTrue(masked.contains("1234"))
    }

    func testFailureDoesNotClearDraftAPIKey() {
        var draft = ProviderEditorDraft(provider: nil)
        draft.apiKey = "test-key-placeholder"

        draft.retainAPIKey(afterFailure: .failed(message: "Connection failed"))

        XCTAssertEqual(draft.apiKey, "test-key-placeholder")
    }
}

final class ProviderEndpointPolicyTests: XCTestCase {
    func testRemoteProvidersRequireCredentialFreeStandardPortHTTPS() throws {
        XCTAssertNoThrow(try ProviderEndpointPolicy.validate(
            baseURL: URL(string: "https://api.example.com/v1")!,
            type: .openAICompatible,
            hasCredential: true))

        for raw in [
            "http://api.example.com/v1",
            "https://api.example.com:8443/v1",
            "https://127.0.0.1/v1",
            "https://api.example.com/v1?debug=true",
            "https://user:placeholder@api.example.com/v1",
        ] {
            XCTAssertThrowsError(try ProviderEndpointPolicy.validate(
                baseURL: URL(string: raw)!,
                type: .openAICompatible,
                hasCredential: true), raw)
        }
    }

    func testLocalProvidersAllowOnlyCanonicalLoopbackAndNoCredentialOverCleartext() throws {
        XCTAssertNoThrow(try ProviderEndpointPolicy.validate(
            baseURL: URL(string: "http://localhost:11434")!,
            type: .ollama,
            hasCredential: false))
        XCTAssertNoThrow(try ProviderEndpointPolicy.validate(
            baseURL: URL(string: "http://[::1]:1234")!,
            type: .lmStudio,
            hasCredential: false))

        XCTAssertThrowsError(try ProviderEndpointPolicy.validate(
            baseURL: URL(string: "http://localhost.example:11434")!,
            type: .ollama,
            hasCredential: false))
        XCTAssertThrowsError(try ProviderEndpointPolicy.validate(
            baseURL: URL(string: "http://localhost:11434")!,
            type: .ollama,
            hasCredential: true))
    }

    func testFactoryRejectsConfigThatBypassesEditorValidation() async {
        let provider = ProviderConfig(displayName: "Unsafe fixture",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "http://api.example.com")!,
                                      apiKeySecretID: "fixture.secret")
        let factory = ProviderClientFactory(http: MockProviderHTTPClient(
            response: ProviderHTTPResponse(statusCode: 200, data: Data()),
            error: nil), secretStore: InMemorySecretStore())

        do {
            _ = try await factory.makeClient(provider: provider)
            XCTFail("factory must revalidate persisted provider configuration")
        } catch let error as ProviderClientFactoryError {
            XCTAssertEqual(error, .invalidEndpoint)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

final class ModelResponseSanitizerTests: XCTestCase {
    func testSanitizerRemovesThinkBlock() {
        let result = ModelResponseSanitizer.sanitize(content: "<think>我要先分析</think>好的呢")

        XCTAssertEqual(result.visibleText, "好的呢")
        XCTAssertTrue(result.hadReasoning)
        XCTAssertEqual(result.reasoningText, "我要先分析")
    }

    func testSanitizerRemovesDanglingClosingThinkPrefix() {
        let result = ModelResponseSanitizer.sanitize(content: "我要分析</think>收到")

        XCTAssertEqual(result.visibleText, "收到")
        XCTAssertTrue(result.hadReasoning)
    }

    func testSanitizerExtractsVisibleContentWhenReasoningContentExists() {
        let result = ModelResponseSanitizer.sanitize(content: "最终回答",
                                                     reasoningContent: "内部推理")

        XCTAssertEqual(result.visibleText, "最终回答")
        XCTAssertEqual(result.reasoningText, "内部推理")
        XCTAssertTrue(result.hadReasoning)
    }

    func testSanitizerDoesNotDisplayReasoningWhenFinalContentIsEmpty() {
        let result = ModelResponseSanitizer.sanitize(content: "",
                                                     reasoningContent: "内部推理")

        XCTAssertEqual(result.visibleText, "")
        XCTAssertEqual(result.reasoningText, "内部推理")
        XCTAssertTrue(result.hadReasoning)
    }
}

@MainActor
final class ProviderReadinessTests: XCTestCase {
    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
    }

    func testOllamaNoAPIKeyConnectedAndSelectedModelIsReady() async {
        let data = #"{"models":[{"name":"llama3.2"}]}"#.data(using: .utf8)!
        let store = ProviderStore(
            fileURL: tempURL(),
            secretStore: InMemorySecretStore(),
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: data)))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)

        await store.upsert(provider)
        await store.refreshModels(providerID: provider.id)

        XCTAssertEqual(store.readiness(), .ready(providerName: "Ollama", modelName: "llama3.2"))
    }

    func testConnectedProviderWithoutSelectedModelIsExplicit() async {
        let data = #"{"models":[{"name":"llama3.2"}]}"#.data(using: .utf8)!
        let store = ProviderStore(
            fileURL: tempURL(),
            secretStore: InMemorySecretStore(),
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: data)))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)

        await store.upsert(provider)
        store.setDefault(role: .companion, providerID: provider.id, modelID: nil)
        await store.testConnection(providerID: provider.id)

        XCTAssertEqual(store.readiness(), .providerConnectedNoModel(providerName: "Ollama"))
    }

    func testDisconnectedProviderIsConfiguredButDisconnected() async {
        let store = ProviderStore(fileURL: tempURL(), secretStore: InMemorySecretStore())
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)

        await store.upsert(provider, manualModelID: "llama3.2")
        store.setDefault(role: .companion, providerID: provider.id, modelID: "llama3.2")

        XCTAssertEqual(store.readiness(), .providerConfiguredButDisconnected(providerName: "Ollama"))
    }

    func testNoProviderIsNoProvider() {
        let store = ProviderStore(fileURL: tempURL(), secretStore: InMemorySecretStore())

        XCTAssertEqual(store.readiness(), .noProvider)
    }
}

final class ModelCatalogServiceTests: XCTestCase {
    func testOpenAICompatibleModelsSuccess() async throws {
        let secretStore = InMemorySecretStore()
        try await secretStore.save("value-\(UUID().uuidString)", for: "secret")
        let data = #"{"data":[{"id":"gpt-4.1-mini"}]}"#.data(using: .utf8)!
        let service = ModelCatalogService(
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: data)),
            secretStore: secretStore)
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      apiKeySecretID: "secret")

        let models = try await service.refreshModels(provider: provider)

        XCTAssertEqual(models.map(\.id), ["gpt-4.1-mini"])
        XCTAssertEqual(models.first?.source, .fetched)
    }

    func testOpenAIUnauthorizedMapsToStatus() async {
        let secretStore = InMemorySecretStore()
        try? await secretStore.save("value-\(UUID().uuidString)", for: "secret")
        let service = ModelCatalogService(
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 401, data: Data())),
            secretStore: secretStore)
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      apiKeySecretID: "secret")

        let status = await service.testConnection(provider: provider)

        XCTAssertEqual(status, .failed(message: "Authentication failed / 401"))
    }

    func testInvalidJSONFailsClearly() async {
        let secretStore = InMemorySecretStore()
        try? await secretStore.save("value-\(UUID().uuidString)", for: "secret")
        let service = ModelCatalogService(
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: Data("{}".utf8))),
            secretStore: secretStore)
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      apiKeySecretID: "secret")

        let status = await service.testConnection(provider: provider)

        XCTAssertEqual(status, .failed(message: "Connection failed"))
    }

    func testOpenAIModelNotFoundMapsToStatus() async {
        let secretStore = InMemorySecretStore()
        try? await secretStore.save("value-\(UUID().uuidString)", for: "secret")
        let service = ModelCatalogService(
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 404, data: Data())),
            secretStore: secretStore)
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      apiKeySecretID: "secret")

        let status = await service.testConnection(provider: provider)

        XCTAssertEqual(status, .failed(message: "Model not found / 404"))
    }

    func testOllamaModelsSuccessWithoutAPIKey() async throws {
        let data = #"{"models":[{"name":"llama3.2"}]}"#.data(using: .utf8)!
        let service = ModelCatalogService(
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: data)),
            secretStore: InMemorySecretStore())
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!)

        let models = try await service.refreshModels(provider: provider)

        XCTAssertEqual(models.map(\.id), ["llama3.2"])
        XCTAssertTrue(models.first?.capabilities.contains(.local) == true)
    }

    func testMissingAPIKeyState() async {
        let service = ModelCatalogService(
            http: MockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: Data())),
            secretStore: InMemorySecretStore())
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!)

        let status = await service.testConnection(provider: provider)

        XCTAssertEqual(status, .missingAPIKey)
    }
}

final class ModelRouterRoleTests: XCTestCase {
    func testDefaultSelectedOllamaModelRoutesToOllamaProvider() async {
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        let defaults = ModelRoleDefaults(companionModelProviderID: provider.id,
                                         companionModelID: "llama3.2")

        let result = await ModelRouter().route(.companion,
                                               providers: [provider],
                                               defaults: defaults,
                                               secretStore: InMemorySecretStore())

        guard case .success(let selection) = result else {
            return XCTFail("expected success")
        }
        XCTAssertEqual(selection.provider.type, .ollama)
        XCTAssertEqual(selection.modelID, "llama3.2")
    }

    func testMissingSelectedModelReturnsClearError() async {
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        let defaults = ModelRoleDefaults(companionModelProviderID: provider.id,
                                         companionModelID: nil)

        let result = await ModelRouter().route(.companion,
                                               providers: [provider],
                                               defaults: defaults,
                                               secretStore: InMemorySecretStore())

        XCTAssertEqual(result, .failure(.noDefaultModelSelected(provider.id)))
    }

    func testToolRoleFallsBackToCompanionModel() async throws {
        let secretStore = InMemorySecretStore()
        try await secretStore.save("value-\(UUID().uuidString)", for: "secret")
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      apiKeySecretID: "secret")
        let defaults = ModelRoleDefaults(companionModelProviderID: provider.id,
                                         companionModelID: "gpt-test")

        let result = await ModelRouter().route(.tool,
                                               providers: [provider],
                                               defaults: defaults,
                                               secretStore: secretStore)

        guard case .success(let selection) = result else {
            return XCTFail("expected success")
        }
        XCTAssertEqual(selection.modelID, "gpt-test")
        XCTAssertTrue(selection.usedFallback)
    }

    func testMissingProviderSecretReturnsExplicitError() async {
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!)
        let defaults = ModelRoleDefaults(companionModelProviderID: provider.id,
                                         companionModelID: "gpt-test")

        let result = await ModelRouter().route(.companion,
                                               providers: [provider],
                                               defaults: defaults,
                                               secretStore: InMemorySecretStore())

        XCTAssertEqual(result, .failure(.missingAPIKey(provider.id)))
    }

    func testProviderClientFactoryCreatesLocalClientWithoutSecret() async throws {
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!)
        let client = try await ProviderClientFactory(secretStore: InMemorySecretStore()).makeClient(provider: provider)
        XCTAssertTrue(client.capabilities.contains(.local))
    }
}

@MainActor
final class PermissionPreferencesTests: XCTestCase {
    func testPermissionActionsPersistState() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("prefs-\(UUID().uuidString).json")
        let prefs = PreferencesModel(fileURL: url)

        prefs.setPermission(\.screenRead, .grantedPersistently)
        prefs.setClipboardPolicy(.manualAllowed)
        prefs.setMemoryEnabled(false)

        let reloaded = PreferencesModel(fileURL: url)
        XCTAssertEqual(reloaded.permissions.screenRead, .grantedPersistently)
        XCTAssertEqual(reloaded.permissions.clipboard, .manualAllowed)
        XCTAssertFalse(reloaded.permissions.memoryEnabled)
    }
}
