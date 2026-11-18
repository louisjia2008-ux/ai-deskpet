import XCTest
import Foundation
import Security
import AICore
@testable import DeskPet

private actor ScriptedKeychainSecretStore: SecretStore {
    private var secrets: [String: String]
    private var queuedReads: [Result<String?, KeychainSecretError>]
    private(set) var readModes: [SecretAccessMode] = []
    private(set) var deletedIDs: [String] = []

    init(secrets: [String: String] = [:],
         queuedReads: [Result<String?, KeychainSecretError>] = []) {
        self.secrets = secrets
        self.queuedReads = queuedReads
    }

    func save(_ secret: String, for secretID: String) async throws {
        secrets[secretID] = secret
    }

    func read(_ secretID: String) async throws -> String? {
        try await read(secretID, accessMode: .nonInteractive)
    }

    func read(_ secretID: String, accessMode: SecretAccessMode) async throws -> String? {
        readModes.append(accessMode)
        if !queuedReads.isEmpty {
            return try queuedReads.removeFirst().get()
        }
        return secrets[secretID]
    }

    func delete(_ secretID: String) async throws {
        deletedIDs.append(secretID)
        secrets[secretID] = nil
    }

    func exists(_ secretID: String) async -> Bool {
        secrets[secretID] != nil
    }

    func secretState(for secretID: String, accessMode: SecretAccessMode = .nonInteractive) async -> ProviderSecretState {
        do {
            guard let secret = try await read(secretID, accessMode: accessMode) else { return .missing }
            return secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .invalid : .available
        } catch let error as KeychainSecretError {
            return ProviderSecretState(error: error)
        } catch {
            return .unknownFailure
        }
    }

    func value(for secretID: String) -> String? {
        secrets[secretID]
    }

    func readCount() -> Int {
        readModes.count
    }
}

private actor RecordingKeychainHTTPClient: ProviderHTTPClient {
    var response: ProviderHTTPResponse
    var error: Error?
    private(set) var requestCount = 0

    init(response: ProviderHTTPResponse = ProviderHTTPResponse(statusCode: 200, data: Data(#"{"data":[{"id":"minimax-m3"}]}"#.utf8)),
         error: Error? = nil) {
        self.response = response
        self.error = error
    }

    func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        requestCount += 1
        if let error { throw error }
        return response
    }
}

final class ProviderKeychainSecretTests: XCTestCase {
    func testSecretExistsAndIsReadable() async throws {
        let store = ScriptedKeychainSecretStore(secrets: ["secret": "test-key-placeholder"])

        let state = await store.secretState(for: "secret", accessMode: .nonInteractive)
        let value = try await store.read("secret", accessMode: .userInitiated)

        XCTAssertEqual(state, .available)
        XCTAssertEqual(value, "test-key-placeholder")
    }

    func testSecretMissingIsDistinctFromLockedOrNetworkFailure() async {
        let store = ScriptedKeychainSecretStore()

        let state = await store.secretState(for: "missing", accessMode: .nonInteractive)
        let service = ModelCatalogService(http: RecordingKeychainHTTPClient(), secretStore: store)
        let status = await service.testConnection(provider: provider(secretID: nil))

        XCTAssertEqual(state, .missing)
        XCTAssertEqual(status, .missingAPIKey)
    }

    func testInteractionNotAllowedMapsToLockedSecretState() async {
        await assertKeychainError(.interactionNotAllowed(errSecInteractionNotAllowed),
                                  expectedState: .locked,
                                  expectedStatus: .failed(message: "Keychain locked; reauthorize API Key"))
    }

    func testAuthenticationFailedMapsToAccessDenied() async {
        await assertKeychainError(.authenticationFailed(errSecAuthFailed),
                                  expectedState: .accessDenied,
                                  expectedStatus: .failed(message: "Keychain authentication failed"))
    }

    func testUserCancelledMapsToCancelledMessage() async {
        await assertKeychainError(.userCancelled(errSecUserCanceled),
                                  expectedState: .accessDenied,
                                  expectedStatus: .failed(message: "Keychain authorization cancelled"))
    }

    func testMissingEntitlementMapsToAccessDenied() async {
        await assertKeychainError(.missingEntitlement(errSecMissingEntitlement),
                                  expectedState: .accessDenied,
                                  expectedStatus: .failed(message: "Keychain entitlement missing"))
    }

    func testProviderNetworkFailureDoesNotBecomeKeychainFailure() async {
        let store = ScriptedKeychainSecretStore(secrets: ["secret": "test-key-placeholder"])
        let http = RecordingKeychainHTTPClient(error: URLError(.notConnectedToInternet))
        let service = ModelCatalogService(http: http, secretStore: store)

        let status = await service.testConnection(provider: provider())
        let state = await store.secretState(for: "secret", accessMode: .nonInteractive)

        XCTAssertEqual(status, .failed(message: "Connection failed"))
        XCTAssertEqual(state, .available)
    }

    func testHTTP401DoesNotBecomeConnectionFailed() async {
        let store = ScriptedKeychainSecretStore(secrets: ["secret": "test-key-placeholder"])
        let http = RecordingKeychainHTTPClient(response: ProviderHTTPResponse(statusCode: 401, data: Data()))
        let service = ModelCatalogService(http: http, secretStore: store)

        let status = await service.testConnection(provider: provider())

        XCTAssertEqual(status, .failed(message: "Authentication failed / 401"))
    }

    @MainActor
    func testProviderStoreStartupDoesNotReadLockedKeychain() async {
        let store = ScriptedKeychainSecretStore(queuedReads: [.failure(.interactionNotAllowed(errSecInteractionNotAllowed))])
        let provider = provider(id: "provider-minimax", secretID: "secret")
        let providerStore = ProviderStore(fileURL: tempURL(), secretStore: store)

        await providerStore.upsert(provider, manualModelID: "minimax-m3")

        let readCount = await store.readCount()
        XCTAssertEqual(readCount, 0)
        XCTAssertEqual(providerStore.secretState(for: provider), .unknownFailure)
    }

    @MainActor
    func testReauthorizeRecoversAfterLockedState() async {
        let store = ScriptedKeychainSecretStore(queuedReads: [
            .failure(.interactionNotAllowed(errSecInteractionNotAllowed)),
            .success("test-key-placeholder")
        ])
        let provider = provider(id: "provider-minimax", secretID: "secret")
        let providerStore = ProviderStore(fileURL: tempURL(), secretStore: store)
        await providerStore.upsert(provider, manualModelID: "minimax-m3")

        let locked = await providerStore.refreshSecretState(providerID: provider.id, allowKeychainPrompt: false)
        let recovered = await providerStore.reauthorizeSecret(providerID: provider.id)
        let modes = await store.readModes

        XCTAssertEqual(locked, .locked)
        XCTAssertEqual(recovered, .available)
        XCTAssertEqual(modes, [.nonInteractive, .userInitiated])
    }

    @MainActor
    func testProviderRenameKeepsStableProviderIDSecret() async throws {
        let store = ScriptedKeychainSecretStore()
        let providerID = "provider-stable-id"
        let providerStore = ProviderStore(fileURL: tempURL(), secretStore: store)
        let original = provider(id: providerID, secretID: nil, displayName: "MiniMax")

        await providerStore.upsert(original, apiKey: "test-key-placeholder", manualModelID: "minimax-m3")
        guard let saved = providerStore.providers.first(where: { $0.id == providerID }) else {
            return XCTFail("provider should be saved")
        }
        var renamed = saved
        renamed.displayName = "Renamed MiniMax"
        await providerStore.upsert(renamed, manualModelID: "minimax-m3")

        let secretID = "provider.\(providerID).apiKey"
        let savedSecret = await store.value(for: secretID)
        XCTAssertEqual(providerStore.providers.first(where: { $0.id == providerID })?.apiKeySecretID, secretID)
        XCTAssertEqual(savedSecret, "test-key-placeholder")
    }

    @MainActor
    func testMultipleProvidersUseSeparateSecretIDsAndDeleteOnlyOne() async {
        let store = ScriptedKeychainSecretStore()
        let providerStore = ProviderStore(fileURL: tempURL(), secretStore: store)
        let miniMax = provider(id: "provider-minimax", secretID: nil, displayName: "MiniMax")
        let openAI = provider(id: "provider-openai", secretID: nil, displayName: "OpenAI")

        await providerStore.upsert(miniMax, apiKey: "minimax-key-placeholder", manualModelID: "minimax-m3")
        await providerStore.upsert(openAI, apiKey: "openai-key-placeholder", manualModelID: "gpt-test")
        await providerStore.deleteProviderSecret(providerID: miniMax.id)

        let deletedMiniMaxSecret = await store.value(for: "provider.provider-minimax.apiKey")
        let retainedOpenAISecret = await store.value(for: "provider.provider-openai.apiKey")
        XCTAssertNil(deletedMiniMaxSecret)
        XCTAssertEqual(retainedOpenAISecret, "openai-key-placeholder")
        XCTAssertEqual(providerStore.secretState(for: miniMax), .missing)
    }

    @MainActor
    func testSecretNeverPersistsToProviderJSONOrStatusText() async throws {
        let secret = "sk-" + String(repeating: "x", count: 32)
        let url = tempURL()
        let providerStore = ProviderStore(fileURL: url, secretStore: ScriptedKeychainSecretStore())
        let miniMax = provider(id: "provider-minimax", secretID: nil, displayName: "MiniMax")

        await providerStore.upsert(miniMax, apiKey: secret, manualModelID: "minimax-m3")
        let persisted = try String(contentsOf: url, encoding: .utf8)
        let labels = providerStore.statuses.values.map(\.label).joined(separator: " ")
            + " " + providerStore.secretStates.values.map(\.label).joined(separator: " ")

        XCTAssertFalse(persisted.contains(secret))
        XCTAssertFalse(labels.contains(secret))
        XCTAssertFalse(SecretMasking.redact("Authorization: Bearer \(secret)").contains(secret))
    }

    private func assertKeychainError(_ error: KeychainSecretError,
                                     expectedState: ProviderSecretState,
                                     expectedStatus: ProviderConnectionStatus,
                                     file: StaticString = #filePath,
                                     line: UInt = #line) async {
        let store = ScriptedKeychainSecretStore(queuedReads: [.failure(error)])
        let http = RecordingKeychainHTTPClient()
        let service = ModelCatalogService(http: http, secretStore: store)

        let status = await service.testConnection(provider: provider())
        let requestCount = await http.requestCount

        XCTAssertEqual(ProviderSecretState(error: error), expectedState, file: file, line: line)
        XCTAssertEqual(status, expectedStatus, file: file, line: line)
        XCTAssertEqual(requestCount, 0, file: file, line: line)
    }

    private func provider(id: String = "provider-minimax",
                          secretID: String? = "secret",
                          displayName: String = "MiniMax") -> ProviderConfig {
        ProviderConfig(id: id,
                       displayName: displayName,
                       type: .openAICompatible,
                       baseURL: URL(string: "https://example.com/v1")!,
                       apiKeySecretID: secretID,
                       defaultModelID: "minimax-m3",
                       enabled: true,
                       capabilities: [.chat, .streaming])
    }

    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-keychain-\(UUID().uuidString).json")
    }
}
