import Foundation
import AICore

enum ProviderEditorValidationError: Error, Equatable {
    case providerNameEmpty
    case baseURLInvalid
    case apiKeyEmpty

    var message: String {
        switch self {
        case .providerNameEmpty:
            return "Provider name empty"
        case .baseURLInvalid:
            return "Base URL invalid"
        case .apiKeyEmpty:
            return "API Key empty"
        }
    }
}

struct ProviderEditorDraft: Equatable {
    var name: String
    var type: ProviderType
    var baseURL: String
    var apiKey: String
    var manualModelID: String
    var enabled: Bool
    var capabilities: Set<ModelCapability>

    init(provider: ProviderConfig?) {
        self.name = provider?.displayName ?? ""
        self.type = provider?.type ?? .openAICompatible
        self.baseURL = provider?.baseURL.absoluteString ?? "https://api.openai.com"
        self.apiKey = ""
        self.manualModelID = provider?.defaultModelID ?? ""
        self.enabled = provider?.enabled ?? true
        self.capabilities = provider?.capabilities ?? [.chat]
    }

    static func sanitizeAPIKey(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func trimmedManualModelID(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func maskedAPIKeyDisplay(apiKey: String, hasSavedSecret: Bool) -> String {
        let sanitized = sanitizeAPIKey(apiKey)
        if !sanitized.isEmpty {
            return SecretMasking.masked(sanitized)
        }
        return hasSavedSecret ? "已保存 API Key；留空则保留" : "未保存 API Key"
    }

    var sanitizedAPIKey: String {
        Self.sanitizeAPIKey(apiKey)
    }

    var trimmedManualModelID: String {
        Self.trimmedManualModelID(manualModelID)
    }

    var apiKeyForSave: String? {
        let sanitized = sanitizedAPIKey
        return sanitized.isEmpty ? nil : sanitized
    }

    var manualModelIDForSave: String? {
        let trimmed = trimmedManualModelID
        return trimmed.isEmpty ? nil : trimmed
    }

    mutating func pasteAPIKey(_ pasteboardString: String?) {
        apiKey = Self.sanitizeAPIKey(pasteboardString ?? "")
    }

    mutating func retainAPIKey(afterFailure status: ProviderConnectionStatus) {
        _ = status
    }

    func makeProviderConfig(existingProvider: ProviderConfig?, now: Date = Date()) -> Result<ProviderConfig, ProviderEditorValidationError> {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            return .failure(.providerNameEmpty)
        }
        guard let url = Self.validatedBaseURL(baseURL, type: type,
                                              hasCredential: type.requiresAPIKey ||
                                                  !sanitizedAPIKey.isEmpty ||
                                                  existingProvider?.apiKeySecretID != nil) else {
            return .failure(.baseURLInvalid)
        }
        if type.requiresAPIKey,
           sanitizedAPIKey.isEmpty,
           existingProvider?.apiKeySecretID == nil {
            return .failure(.apiKeyEmpty)
        }

        let modelID = manualModelIDForSave
        let config = ProviderConfig(id: existingProvider?.id ?? UUID().uuidString,
                                    displayName: trimmedName,
                                    type: type,
                                    baseURL: url,
                                    apiKeySecretID: existingProvider?.apiKeySecretID,
                                    defaultModelID: modelID,
                                    enabled: enabled && type != .gemini,
                                    capabilities: capabilities.isEmpty ? [.chat] : capabilities,
                                    createdAt: existingProvider?.createdAt ?? now,
                                    updatedAt: now)
        return .success(config)
    }

    private static func validatedBaseURL(_ value: String,
                                         type: ProviderType,
                                         hasCredential: Bool) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let host = components.host,
              !host.isEmpty else {
            return nil
        }
        guard let url = components.url else { return nil }
        return try? ProviderEndpointPolicy.validate(baseURL: url,
                                                    type: type,
                                                    hasCredential: hasCredential)
    }
}
