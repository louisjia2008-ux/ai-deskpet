import Foundation

/// Transport policy shared by provider editing and every native request path.
///
/// Remote/credential-bearing providers are HTTPS-only on the standard TLS
/// port. Cleartext is limited to explicitly local, keyless Ollama/LM Studio
/// configurations on canonical loopback hosts.
public enum ProviderEndpointPolicy {
    public enum PolicyError: Error, Equatable, Sendable {
        case malformed
        case credentialsInURL
        case insecureTransport
        case nonLoopbackLocalProvider
        case blockedHost
        case nonstandardRemotePort
    }

    @discardableResult
    public static func validate(_ provider: ProviderConfig) throws -> URL {
        try validate(baseURL: provider.baseURL,
                     type: provider.type,
                     hasCredential: provider.type.requiresAPIKey || provider.apiKeySecretID != nil)
    }

    @discardableResult
    public static func validate(baseURL: URL,
                                type: ProviderType,
                                hasCredential: Bool) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.query == nil,
              components.fragment == nil else {
            throw PolicyError.malformed
        }
        guard components.user == nil, components.password == nil else {
            throw PolicyError.credentialsInURL
        }
        components.scheme = scheme
        components.host = host

        switch type {
        case .ollama, .lmStudio:
            guard ["http", "https"].contains(scheme) else {
                throw PolicyError.insecureTransport
            }
            guard isCanonicalLoopback(host) else {
                throw PolicyError.nonLoopbackLocalProvider
            }
            guard !hasCredential || scheme == "https" else {
                throw PolicyError.insecureTransport
            }
        case .openAICompatible, .anthropic, .customHTTP, .gemini:
            guard scheme == "https" else { throw PolicyError.insecureTransport }
            guard components.port == nil || components.port == 443 else {
                throw PolicyError.nonstandardRemotePort
            }
            guard !FetchTargetValidator.isBlockedHost(host) else {
                throw PolicyError.blockedHost
            }
        }
        guard let normalized = components.url else { throw PolicyError.malformed }
        return normalized
    }

    public static func isCanonicalLoopback(_ host: String) -> Bool {
        let normalized = host.lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
    }
}
