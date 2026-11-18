import Foundation
import Combine
import AICore
import PetAgentRuntime

private struct ProviderStoreSnapshot: Codable, Equatable {
    var providers: [ProviderConfig]
    var modelsByProviderID: [String: [ModelDescriptor]]
    var defaults: ModelRoleDefaults
    var statuses: [String: ProviderConnectionStatus]

    init(providers: [ProviderConfig],
         modelsByProviderID: [String: [ModelDescriptor]],
         defaults: ModelRoleDefaults,
         statuses: [String: ProviderConnectionStatus]) {
        self.providers = providers
        self.modelsByProviderID = modelsByProviderID
        self.defaults = defaults
        self.statuses = statuses
    }

    private enum CodingKeys: String, CodingKey {
        case providers
        case modelsByProviderID
        case defaults
        case statuses
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providers = try container.decode([ProviderConfig].self, forKey: .providers)
        modelsByProviderID = try container.decode([String: [ModelDescriptor]].self, forKey: .modelsByProviderID)
        defaults = try container.decode(ModelRoleDefaults.self, forKey: .defaults)
        statuses = try container.decodeIfPresent([String: ProviderConnectionStatus].self, forKey: .statuses) ?? [:]
    }
}

struct ProviderStoreSaveResult: Equatable {
    var isSuccess: Bool
    var errorMessage: String?

    static let success = ProviderStoreSaveResult(isSuccess: true, errorMessage: nil)

    static func failure(_ message: String) -> ProviderStoreSaveResult {
        ProviderStoreSaveResult(isSuccess: false, errorMessage: message)
    }
}

@MainActor
final class ProviderStore: ObservableObject {
    @Published private(set) var providers: [ProviderConfig]
    @Published private(set) var modelsByProviderID: [String: [ModelDescriptor]]
    @Published private(set) var defaults: ModelRoleDefaults
    @Published private(set) var statuses: [String: ProviderConnectionStatus] = [:]
    @Published private(set) var secretStates: [String: ProviderSecretState] = [:]
    /// P18.6 — observable durable-write failure for the void `persist()` callers
    /// (setters). `upsert(...)` reports failure through its returned
    /// `ProviderStoreSaveResult` instead; both leave this cleared on success.
    @Published private(set) var lastPersistenceError: String?
    /// P18.6 — set when init finds an existing-but-undecodable providers.json and
    /// quarantines it, so corrupt provider config is never silently reset.
    private(set) var lastLoadCorruptionURL: URL?

    let secretStore: any SecretStore
    private let catalog: ModelCatalogService
    private let conformanceProfileStore: ModelConformanceProfileStore?
    private let url: URL

    init(fileURL: URL? = nil,
         secretStore: any SecretStore = KeychainSecretStore(),
         http: any ProviderHTTPClient = URLSessionProviderHTTPClient(),
         conformanceProfileStore: ModelConformanceProfileStore? = nil) {
        self.secretStore = secretStore
        self.catalog = ModelCatalogService(http: http, secretStore: secretStore)
        self.conformanceProfileStore = conformanceProfileStore
        if let fileURL {
            self.url = fileURL
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DeskPet", isDirectory: true)
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            self.url = base.appendingPathComponent("providers.json")
        }
        // P18.6 — distinguish "no file yet" (fresh install) from "file present but
        // undecodable" (e.g. forward-incompatible or externally corrupted). A
        // corrupt providers.json is quarantined so its bytes survive for recovery
        // instead of being clobbered by the next persist(), which would otherwise
        // silently reset provider config to the default Ollama entry.
        var decodedSnapshot: ProviderStoreSnapshot?
        var wasSealedLoad = false
        do {
            if case .data(let data, let wasSealed) = try SealedStore.load(at: url) {
                wasSealedLoad = wasSealed
                do {
                    decodedSnapshot = try JSONDecoder().decode(ProviderStoreSnapshot.self, from: data)
                } catch {
                    self.lastLoadCorruptionURL = DurableJSONFile.quarantineCorrupt(at: url)
                }
            }
        } catch {
            // Sealed but unreadable (no key): NOT corruption — leave bytes and
            // fall through to the default seed (in-memory only, nothing saved).
        }
        if let snapshot = decodedSnapshot {
            self.providers = snapshot.providers
            self.modelsByProviderID = snapshot.modelsByProviderID
            self.defaults = snapshot.defaults
            self.statuses = snapshot.statuses
            // P19.1 / P1 — Ollama migration. Existing installs may have a
            // pre-P19.1 "Automation Ollama" entry. We rename its displayName to
            // "本地 Ollama（自动化使用）" so users can tell it apart from a
            // user-added "Ollama 本地" entry at the same base URL. Internal ID
            // is preserved (tests + routing depend on it). The migration only
            // renames; it never deletes or rewires anything.
            Self.migrateAutomationOllamaDisplayName(in: &self.providers)
        } else {
            // P19.1 / P1 — Ollama semantic audit. A previous version of this seed
            // unconditionally inserted "Ollama 本地" on a fresh install. When the
            // DEBUG automation profile (`DESKPET_AUTOMATION_OLLAMA_MODEL`) is
            // active, `configureAutomationOllama(modelID:)` later inserts a SECOND
            // Ollama entry at the same base URL. Both rows then appear in the
            // provider center with different IDs and identical endpoints —
            // confusing for the user.
            //
            // Per P19.1 §10 option B, we KEEP both IDs (the automation profile
            // pins `"automation.ollama"` by string in `P61AcceptanceInfrastructureTests`
            // / `P7RecoveryConformanceTests`, and the routing layer keys on
            // `ProviderConfig.id`), but skip the seed when the host already has
            // ANY Ollama entry on the standard localhost:11434 endpoint. This
            // preserves internal identity and unifies the user-facing presentation.
            let ollama = ProviderConfig(displayName: "Ollama 本地",
                                        type: .ollama,
                                        baseURL: URL(string: "http://localhost:11434")!,
                                        enabled: false,
                                        capabilities: [.chat, .local, .offline])
            self.providers = [ollama]
            self.modelsByProviderID = [:]
            self.defaults = ModelRoleDefaults()
        }
        for provider in providers {
            if statuses[provider.id] == nil {
                statuses[provider.id] = provider.enabled ? .ready : .notConfigured
            }
            secretStates[provider.id] = initialSecretState(for: provider)
        }
        // D3: re-seal legacy plaintext on first read when a key is wired.
        if decodedSnapshot != nil, !wasSealedLoad {
            SealedStore.migratePlaintext(at: url) { try writeSnapshot() }
        }
    }

    var configuredDefaultModelLabel: String {
        guard let providerID = defaults.companionModelProviderID,
              let modelID = defaults.companionModelID,
              let provider = providers.first(where: { $0.id == providerID }) else {
            return "未配置模型"
        }
        return "\(provider.displayName) / \(modelID)"
    }

    func provider(id: String?) -> ProviderConfig? {
        guard let id else { return nil }
        return providers.first { $0.id == id }
    }

    func models(for providerID: String?) -> [ModelDescriptor] {
        guard let providerID else { return [] }
        return modelsByProviderID[providerID] ?? []
    }

    func readiness(for role: ModelRole = .companion) -> ModelReadinessState {
        let ids = providerAndModel(for: role)
        guard let providerID = ids.providerID else { return .noProvider }
        guard let provider = providers.first(where: { $0.id == providerID }) else {
            return .error(message: "Provider 不存在")
        }
        guard provider.enabled else {
            return .providerConfiguredButDisconnected(providerName: provider.displayName)
        }
        let status = statuses[provider.id] ?? .ready
        switch status {
        case .connected:
            if let modelID = ids.modelID, !modelID.isEmpty {
                return .ready(providerName: provider.displayName, modelName: modelID)
            }
            if let providerDefault = provider.defaultModelID, !providerDefault.isEmpty {
                return .ready(providerName: provider.displayName, modelName: providerDefault)
            }
            return .providerConnectedNoModel(providerName: provider.displayName)
        case .testing:
            return .providerConfiguredButDisconnected(providerName: provider.displayName)
        case .ready:
            return .providerConfiguredButDisconnected(providerName: provider.displayName)
        case .notConfigured:
            return .providerConfiguredButDisconnected(providerName: provider.displayName)
        case .missingAPIKey:
            return provider.type.requiresAPIKey
                ? .error(message: "\(provider.displayName) 缺少 API Key")
                : .providerConfiguredButDisconnected(providerName: provider.displayName)
        case .localServiceUnavailable:
            return .providerConfiguredButDisconnected(providerName: provider.displayName)
        case .failed(let message):
            return .error(message: message)
        case .unsupported:
            return .error(message: "\(provider.displayName) 暂不支持")
        }
    }

    @discardableResult
    func upsert(_ provider: ProviderConfig, apiKey: String? = nil, manualModelID: String? = nil) async -> ProviderStoreSaveResult {
        var updated = provider
        updated.updatedAt = Date()
        let sanitizedAPIKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !sanitizedAPIKey.isEmpty {
            let secretID = provider.apiKeySecretID ?? "provider.\(provider.id).apiKey"
            do {
                try await secretStore.save(sanitizedAPIKey, for: secretID)
                updated.apiKeySecretID = secretID
                secretStates[updated.id] = .available
            } catch let error as KeychainSecretError {
                let message = error.providerFacingMessage
                secretStates[provider.id] = ProviderSecretState(error: error)
                statuses[provider.id] = .failed(message: message)
                return .failure(message)
            } catch {
                let message = "API Key save failed"
                secretStates[provider.id] = .unknownFailure
                statuses[provider.id] = .failed(message: message)
                return .failure(message)
            }
        }
        if let index = providers.firstIndex(where: { $0.id == provider.id }) {
            providers[index] = updated
        } else {
            providers.append(updated)
        }
        let trimmedManualModelID = manualModelID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedManualModelID.isEmpty {
            let trimmedModelID = trimmedManualModelID
            if modelsByProviderID[updated.id, default: []].contains(where: { $0.id == trimmedModelID }) == false {
                modelsByProviderID[updated.id, default: []].append(
                    ModelDescriptor(id: trimmedModelID,
                                    providerID: updated.id,
                                    capabilities: updated.capabilities,
                                    source: .manual))
            }
            if updated.defaultModelID == nil {
                setProviderDefaultModel(providerID: updated.id, modelID: trimmedModelID, persistAfterChange: false)
            }
            if defaults.companionModelProviderID == nil {
                setDefault(role: .companion, providerID: updated.id, modelID: trimmedModelID, persistAfterChange: false)
            }
        }
        if updated.type.requiresAPIKey, updated.apiKeySecretID == nil {
            secretStates[updated.id] = .missing
        } else if !updated.type.requiresAPIKey {
            secretStates[updated.id] = .available
        }
        statuses[updated.id] = updated.enabled ? (statuses[updated.id] ?? .ready) : .notConfigured
        // P18.6 — the durable write is part of this operation's success contract.
        // If providers.json cannot be written, do NOT claim success: the Keychain
        // secret was saved but the config that references it did not reach disk,
        // so restart would diverge. Report an observable failure instead.
        do {
            try writeSnapshot()
            lastPersistenceError = nil
        } catch {
            let message = SealedStore.describe(error, fallback: "配置保存失败")
            lastPersistenceError = message
            return .failure(message)
        }
        return .success
    }

    func deleteProvider(id: String, deleteSecret: Bool = true) async {
        guard let provider = providers.first(where: { $0.id == id }) else { return }
        providers.removeAll { $0.id == id }
        modelsByProviderID[id] = nil
        statuses[id] = nil
        secretStates[id] = nil
        clearDefaultsReferencingProvider(id)
        if deleteSecret, let secretID = provider.apiKeySecretID {
            try? await secretStore.delete(secretID)
        }
        persist()
    }

    func setProviderDefaultModel(providerID: String, modelID: String) {
        setProviderDefaultModel(providerID: providerID, modelID: modelID, persistAfterChange: true)
    }

    private func setProviderDefaultModel(providerID: String, modelID: String, persistAfterChange: Bool) {
        guard let index = providers.firstIndex(where: { $0.id == providerID }) else { return }
        providers[index].defaultModelID = modelID
        providers[index].updatedAt = Date()
        if persistAfterChange { persist() }
    }

    func setDefault(role: ModelRole, providerID: String?, modelID: String?) {
        setDefault(role: role, providerID: providerID, modelID: modelID, persistAfterChange: true)
    }

    @discardableResult
    func configureAutomationOllama(modelID: String,
                                   baseURL: URL = URL(string: "http://localhost:11434")!) -> String {
        let providerID = "automation.ollama"
        let trimmedModelID = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        // P19.1 / P1 — rename + distinctive display so users can tell the
        // automation Ollama apart from a user-added "Ollama 本地" entry. Per
        // P19.1 §10 we keep the internal ID `"automation.ollama"` unchanged
        // (tests pin it; routing keys on it) but the user-facing label makes
        // the difference obvious.
        let provider = ProviderConfig(id: providerID,
                                      displayName: "本地 Ollama（自动化使用）",
                                      type: .ollama,
                                      baseURL: baseURL,
                                      defaultModelID: trimmedModelID.isEmpty ? nil : trimmedModelID,
                                      enabled: true,
                                      capabilities: [.chat, .local, .offline])
        if let index = providers.firstIndex(where: { $0.id == providerID }) {
            providers[index] = provider
        } else {
            providers.append(provider)
        }
        if !trimmedModelID.isEmpty {
            modelsByProviderID[providerID] = [
                ModelDescriptor(id: trimmedModelID,
                                providerID: providerID,
                                capabilities: provider.capabilities,
                                source: .manual)
            ]
            setDefault(role: .companion, providerID: providerID, modelID: trimmedModelID, persistAfterChange: false)
        }
        statuses[providerID] = .connected
        secretStates[providerID] = .available
        persist()
        Task { await persistConformanceProfiles(providerID: providerID,
                                                models: modelsByProviderID[providerID] ?? []) }
        return providerID
    }

    private func setDefault(role: ModelRole, providerID: String?, modelID: String?, persistAfterChange: Bool) {
        switch role {
        case .companion:
            defaults.companionModelProviderID = providerID
            defaults.companionModelID = modelID
        case .tool:
            defaults.toolModelProviderID = providerID
            defaults.toolModelID = modelID
        case .summarizer:
            defaults.summarizerModelProviderID = providerID
            defaults.summarizerModelID = modelID
        case .vision:
            defaults.visionModelProviderID = providerID
            defaults.visionModelID = modelID
        }
        if persistAfterChange { persist() }
    }

    func refreshModels(providerID: String) async {
        guard let provider = providers.first(where: { $0.id == providerID }) else { return }
        statuses[providerID] = .testing
        do {
            let models = try await catalog.refreshModels(provider: provider, secretAccessMode: .userInitiated)
            modelsByProviderID[providerID] = models
            statuses[providerID] = .connected
            secretStates[providerID] = .available
            if provider.defaultModelID == nil, let first = models.first {
                setProviderDefaultModel(providerID: providerID, modelID: first.id, persistAfterChange: false)
            }
            if defaults.companionModelProviderID == nil, let first = models.first {
                setDefault(role: .companion, providerID: providerID, modelID: first.id, persistAfterChange: false)
            } else if defaults.companionModelProviderID == providerID,
                      (defaults.companionModelID == nil || defaults.companionModelID?.isEmpty == true),
	                      let first = models.first {
                setDefault(role: .companion, providerID: providerID, modelID: first.id, persistAfterChange: false)
            }
            await persistConformanceProfiles(providerID: providerID, models: models)
        } catch let error as ProviderConnectionError {
            updateSecretState(providerID: providerID, from: error)
            statuses[providerID] = error.status
        } catch {
            statuses[providerID] = .failed(message: "模型列表刷新失败")
        }
        persist()
    }

    func testConnection(providerID: String) async {
        guard let provider = providers.first(where: { $0.id == providerID }) else { return }
        statuses[providerID] = .testing
        do {
            let models = try await catalog.refreshModels(provider: provider, secretAccessMode: .userInitiated)
            statuses[providerID] = .connected
            secretStates[providerID] = .available
            modelsByProviderID[providerID] = models
            if defaults.companionModelProviderID == nil {
                setDefault(role: .companion, providerID: providerID, modelID: nil, persistAfterChange: false)
            }
            await persistConformanceProfiles(providerID: providerID, models: models)
        } catch let error as ProviderConnectionError {
            updateSecretState(providerID: providerID, from: error)
            statuses[providerID] = error.status
        } catch {
            statuses[providerID] = .failed(message: "Connection failed")
        }
        persist()
    }

    func secretExists(for provider: ProviderConfig) async -> Bool {
        guard let secretID = provider.apiKeySecretID else { return false }
        let state = await secretStore.secretState(for: secretID, accessMode: .nonInteractive)
        secretStates[provider.id] = state
        return state == .available
    }

    func secretState(for provider: ProviderConfig) -> ProviderSecretState {
        if !provider.type.requiresAPIKey { return .available }
        guard provider.apiKeySecretID != nil else { return .missing }
        return secretStates[provider.id] ?? .unknownFailure
    }

    @discardableResult
    func refreshSecretState(providerID: String, allowKeychainPrompt: Bool = false) async -> ProviderSecretState {
        guard let provider = providers.first(where: { $0.id == providerID }) else { return .unknownFailure }
        if !provider.type.requiresAPIKey {
            secretStates[providerID] = .available
            return .available
        }
        guard let secretID = provider.apiKeySecretID else {
            secretStates[providerID] = .missing
            return .missing
        }
        let mode: SecretAccessMode = allowKeychainPrompt ? .userInitiated : .nonInteractive
        let state = await secretStore.secretState(for: secretID, accessMode: mode)
        secretStates[providerID] = state
        if state == .missing {
            statuses[providerID] = .missingAPIKey
        }
        return state
    }

    func refreshAllSecretStates(allowKeychainPrompt: Bool = false) async {
        for provider in providers where provider.type.requiresAPIKey {
            _ = await refreshSecretState(providerID: provider.id, allowKeychainPrompt: allowKeychainPrompt)
        }
    }

    @discardableResult
    func reauthorizeSecret(providerID: String) async -> ProviderSecretState {
        let state = await refreshSecretState(providerID: providerID, allowKeychainPrompt: true)
        if state == .available {
            statuses[providerID] = .ready
        } else if state == .missing {
            statuses[providerID] = .missingAPIKey
        }
        persist()
        return state
    }

    func deleteProviderSecret(providerID: String) async {
        guard let index = providers.firstIndex(where: { $0.id == providerID }) else { return }
        guard let secretID = providers[index].apiKeySecretID else {
            secretStates[providerID] = .missing
            statuses[providerID] = .missingAPIKey
            return
        }
        try? await secretStore.delete(secretID)
        providers[index].apiKeySecretID = nil
        providers[index].updatedAt = Date()
        secretStates[providerID] = .missing
        statuses[providerID] = .missingAPIKey
        persist()
    }

    private func clearDefaultsReferencingProvider(_ providerID: String) {
        if defaults.companionModelProviderID == providerID {
            defaults.companionModelProviderID = nil
            defaults.companionModelID = nil
        }
        if defaults.toolModelProviderID == providerID {
            defaults.toolModelProviderID = nil
            defaults.toolModelID = nil
        }
        if defaults.summarizerModelProviderID == providerID {
            defaults.summarizerModelProviderID = nil
            defaults.summarizerModelID = nil
        }
        if defaults.visionModelProviderID == providerID {
            defaults.visionModelProviderID = nil
            defaults.visionModelID = nil
        }
    }

    private func persistConformanceProfiles(providerID: String,
                                            models: [ModelDescriptor]) async {
        guard let conformanceProfileStore,
              let provider = providers.first(where: { $0.id == providerID }) else { return }
        var modelIDs = models.map(\.id)
        if let defaultModelID = provider.defaultModelID, !defaultModelID.isEmpty {
            modelIDs.append(defaultModelID)
        }
        if defaults.companionModelProviderID == providerID,
           let modelID = defaults.companionModelID,
           !modelID.isEmpty {
            modelIDs.append(modelID)
        }
        for modelID in Set(modelIDs.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            let profile = ModelConformanceProfile.from(provider: provider,
                                                       modelID: modelID,
                                                       verifiedAt: Date())
            try? await conformanceProfileStore.save(profile)
        }
    }

    /// Void persist used by the setters. P18.6 — surfaces any durable-write
    /// failure through the observable `lastPersistenceError` instead of silently
    /// swallowing it, and clears the error on success.
    private func persist() {
        do {
            try writeSnapshot()
            lastPersistenceError = nil
        } catch {
            lastPersistenceError = SealedStore.describe(error, fallback: "配置保存失败")
        }
    }

    /// P18.6 — the throwing durable write. `upsert(...)` uses this directly so it
    /// can fold a write failure into its returned `ProviderStoreSaveResult`.
    /// Sealed when a key is wired (D3); fail-closed on sealed-without-key.
    private func writeSnapshot() throws {
        let snapshot = ProviderStoreSnapshot(providers: providers,
                                             modelsByProviderID: modelsByProviderID,
                                             defaults: defaults,
                                             statuses: statuses)
        let data = try JSONEncoder().encode(snapshot)
        try SealedStore.save(data, to: url)
    }

    private func initialSecretState(for provider: ProviderConfig) -> ProviderSecretState {
        if !provider.type.requiresAPIKey { return .available }
        return provider.apiKeySecretID == nil ? .missing : .unknownFailure
    }

    private func updateSecretState(providerID: String, from error: ProviderConnectionError) {
        switch error {
        case .missingAPIKey:
            secretStates[providerID] = .missing
        case .keychain(let keychainError):
            secretStates[providerID] = ProviderSecretState(error: keychainError)
        default:
            break
        }
    }

    private func providerAndModel(for role: ModelRole) -> (providerID: String?, modelID: String?) {
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

    /// P19.1 / P1 — Ollama presentation migration. Existing installs may have a
    /// pre-P19.1 "Automation Ollama" entry. We rename its `displayName` to
    /// "本地 Ollama（自动化使用）" so users can tell it apart from a user-added
    /// "Ollama 本地" entry at the same base URL. The migration is a pure rename:
    /// internal `ProviderConfig.id` is preserved so routing + automation tests
    /// that pin `"automation.ollama"` continue to work unchanged.
    static func migrateAutomationOllamaDisplayName(in providers: inout [ProviderConfig]) {
        for index in providers.indices {
            guard providers[index].id == "automation.ollama" else { continue }
            if providers[index].displayName == "Automation Ollama" {
                providers[index].displayName = "本地 Ollama（自动化使用）"
            }
        }
    }
}
