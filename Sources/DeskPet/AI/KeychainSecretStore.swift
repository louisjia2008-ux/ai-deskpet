import Foundation
import LocalAuthentication
import Security
import AICore

actor KeychainSecretStore: SecretStore {
    private let service: String

    init(service: String = "com.deskpet.providerSecrets") {
        self.service = service
    }

    func save(_ secret: String, for secretID: String) async throws {
        var query = baseQuery(secretID)
        query[kSecValueData as String] = Data(secret.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let attributes: [String: Any] = [
                kSecValueData as String: Data(secret.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            ]
            let updateStatus = SecItemUpdate(baseQuery(secretID) as CFDictionary, attributes as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw Self.error(from: updateStatus)
            }
            return
        }
        guard status == errSecSuccess else { throw Self.error(from: status) }
    }

    func read(_ secretID: String) async throws -> String? {
        try await read(secretID, accessMode: .nonInteractive)
    }

    func read(_ secretID: String, accessMode: SecretAccessMode) async throws -> String? {
        let service = self.service
        return try await Self.withTimeout(seconds: accessMode.timeoutSeconds) {
            try Self.readSync(secretID: secretID, service: service, accessMode: accessMode)
        }
    }

    func delete(_ secretID: String) async throws {
        let status = SecItemDelete(baseQuery(secretID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Self.error(from: status)
        }
    }

    func exists(_ secretID: String) async -> Bool {
        await secretState(for: secretID, accessMode: .nonInteractive) == .available
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

    private func baseQuery(_ secretID: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: secretID,
        ]
    }

    private static func readSync(secretID: String, service: String, accessMode: SecretAccessMode) throws -> String? {
        var query = baseQuery(secretID, service: service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        applyAuthenticationPolicy(to: &query, accessMode: accessMode)
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw error(from: status) }
        guard let data = item as? Data else {
            throw KeychainSecretError.invalidData
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func baseQuery(_ secretID: String, service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: secretID,
        ]
    }

    private static func applyAuthenticationPolicy(to query: inout [String: Any], accessMode: SecretAccessMode) {
        let context = authenticationContext(accessMode: accessMode)
        query[kSecUseAuthenticationContext as String] = context
    }

    private static func authenticationContext(accessMode: SecretAccessMode) -> LAContext {
        let context = LAContext()
        context.localizedReason = "DeskPet 需要读取此 Provider 的 API Key"
        context.interactionNotAllowed = accessMode == .nonInteractive
        return context
    }

    private static func error(from status: OSStatus) -> KeychainSecretError {
        switch status {
        case errSecItemNotFound:
            return .itemNotFound(status)
        case errSecInteractionNotAllowed:
            return .interactionNotAllowed(status)
        case errSecAuthFailed:
            return .authenticationFailed(status)
        case errSecUserCanceled:
            return .userCancelled(status)
        case errSecDuplicateItem:
            return .duplicateItem(status)
        case errSecMissingEntitlement:
            return .missingEntitlement(status)
        default:
            return .unexpectedStatus(status)
        }
    }

    private static func withTimeout<Value: Sendable>(
        seconds: TimeInterval = 2,
        operation: @escaping @Sendable () throws -> Value
    ) async throws -> Value {
        let race = KeychainLookupRace<Value>()
        return try await withCheckedThrowingContinuation { continuation in
            Task.detached {
                do {
                    let value = try operation()
                    await race.resume(.success(value), continuation: continuation)
                } catch {
                    await race.resume(.failure(error), continuation: continuation)
                }
            }
            Task.detached {
                let nanoseconds = UInt64(max(0.1, seconds) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanoseconds)
                await race.resume(.failure(KeychainSecretError.timeout), continuation: continuation)
            }
        }
    }
}

private extension SecretAccessMode {
    var timeoutSeconds: TimeInterval {
        switch self {
        case .nonInteractive:
            return 2
        case .userInitiated:
            return 60
        }
    }
}

private actor KeychainLookupRace<Value: Sendable> {
    private var didResume = false

    func resume(_ result: Result<Value, Error>,
                continuation: CheckedContinuation<Value, Error>) {
        guard !didResume else { return }
        didResume = true
        continuation.resume(with: result)
    }
}
