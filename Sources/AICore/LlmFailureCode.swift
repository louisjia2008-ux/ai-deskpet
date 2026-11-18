import Foundation

// P13-D: Canonical provider-neutral failure surface.
//
// Before P13, `LLMClientError.errorDescription` produced sanitized human copy
// (e.g. "authentication failed / 401", "model not found / 404",
// "provider request failed"). Callers that needed to *branch* on failure type
// had to inspect the human copy, which is exactly the leak path we want to
// avoid (P13-A risk R-9).
//
// P13-D adds a machine-routable code list. The error description remains the
// human copy. Adapters map a concrete failure into one of these codes; the
// kernel and UI can branch on `code` without ever reading raw provider text.
//
// Reference: DeepSeek Harness `LlmFailure` shape
// (docs/subsystems/llm-streaming.md) — but DeskPet stays independent and
// uses its own codes.

public enum LlmFailureCode: String, Codable, Sendable, Equatable, CaseIterable {
    /// Provider rejected credentials (HTTP 401/403).
    case authenticationFailed
    /// Provider could not find the requested model (HTTP 404).
    case modelNotFound
    /// Provider rate-limited or quota exhausted (HTTP 429).
    case rateLimited
    /// Provider refused the request because the context window was exceeded.
    case contextWindowExceeded
    /// Provider returned an HTTP failure not classified above.
    case providerRequestFailed
    /// Network transport error.
    case transportFailure
    /// Provider returned data that could not be decoded into the expected shape.
    case decodeFailure
    /// Adapter does not support chat for the given provider type.
    case unsupportedProvider
    /// Local configuration error (e.g. base URL, missing keychain entry).
    case configurationInvalid
    /// Request was cancelled by the caller.
    case cancelled
    /// Provider returned an empty completion; considered retryable upstream.
    case emptyResponse
    /// Catch-all when the underlying error is unrecognised.
    case unknown
}

public struct LlmFailure: Codable, Sendable, Equatable {
    public var code: LlmFailureCode
    /// Provider-neutral human-readable summary. NEVER the raw provider payload;
    /// populated from the adapter's sanitised description.
    public var message: String
    public var httpStatus: Int?
    /// Provider-neutral URL/host description (no secrets).
    public var endpoint: String?
    /// Optional provider-issued request id for diagnostics. Safe to surface.
    public var requestID: String?
    /// Provider-requested retry delay (milliseconds), if any.
    public var providerRetryAfterMs: Int?

    public init(code: LlmFailureCode,
                message: String,
                httpStatus: Int? = nil,
                endpoint: String? = nil,
                requestID: String? = nil,
                providerRetryAfterMs: Int? = nil) {
        self.code = code
        self.message = message
        self.httpStatus = httpStatus
        self.endpoint = endpoint
        self.requestID = requestID
        self.providerRetryAfterMs = providerRetryAfterMs
    }
}

extension LlmFailure {
    /// Classify an `LLMClientError` into an `LlmFailure`. The mapping is
    /// exhaustive over the cases the DeskPet adapter produces today. New
    /// `LLMClientError` cases MUST be classified here.
    public init(from error: LLMClientError) {
        switch error {
        case .invalidEndpoint, .missingAPIKey, .keychain:
            self.init(code: .configurationInvalid,
                      message: LLMClientError.errorDescription(for: error) ?? "configuration invalid")
        case .unauthorized:
            self.init(code: .authenticationFailed,
                      message: LLMClientError.errorDescription(for: error) ?? "authentication failed",
                      httpStatus: 401)
        case .modelNotFound:
            self.init(code: .modelNotFound,
                      message: LLMClientError.errorDescription(for: error) ?? "model not found",
                      httpStatus: 404)
        case .connectionFailed, .transportFailure:
            self.init(code: .transportFailure,
                      message: LLMClientError.errorDescription(for: error) ?? "transport failed",
                      endpoint: LLMClientError.endpointDescription(for: error))
        case .unsupportedProvider:
            self.init(code: .unsupportedProvider,
                      message: LLMClientError.errorDescription(for: error) ?? "provider not supported")
        case .invalidResponse, .decodeFailure, .unsupportedResponse:
            self.init(code: .decodeFailure,
                      message: LLMClientError.errorDescription(for: error) ?? "decode failed",
                      endpoint: LLMClientError.endpointDescription(for: error))
        case .httpFailure(let status, let endpoint, _):
            let code: LlmFailureCode
            switch status {
            case 401, 403: code = .authenticationFailed
            case 404: code = .modelNotFound
            case 429: code = .rateLimited
            default: code = .providerRequestFailed
            }
            self.init(code: code,
                      message: LLMClientError.errorDescription(for: error) ?? "provider request failed",
                      httpStatus: status,
                      endpoint: endpoint)
        case .capabilityUnsupported:
            self.init(code: .configurationInvalid,
                      message: LLMClientError.errorDescription(for: error) ?? "capability unsupported")
        }
    }

    /// Convenience: classify a thrown error that may or may not be an
    /// `LLMClientError`. `CancellationError` returns `cancelled`; other types
    /// return `unknown`.
    public static func classify(_ error: Error) -> LlmFailure {
        if error is CancellationError {
            return LlmFailure(code: .cancelled, message: "cancelled")
        }
        if let llm = error as? LLMClientError {
            return LlmFailure(from: llm)
        }
        return LlmFailure(code: .unknown, message: "unknown error")
    }
}

extension LLMClientError {
    /// Recover the sanitized human description. Pre-P13 this was exposed as
    /// `errorDescription`. We re-expose it here as a free function so
    /// `LlmFailure` can compute without depending on `LocalizedError`.
    public static func errorDescription(for error: LLMClientError) -> String? {
        error.errorDescription
    }

    /// Recover the sanitized endpoint description when one is associated with
    /// the error. Returns nil for errors that do not carry endpoint context.
    public static func endpointDescription(for error: LLMClientError) -> String? {
        switch error {
        case .httpFailure(_, let endpoint, _),
             .decodeFailure(let endpoint, _),
             .unsupportedResponse(let endpoint, _):
            return endpoint
        case .transportFailure(let endpoint, _):
            return endpoint
        default:
            return nil
        }
    }
}