import Foundation
import AICore

// P14-E + P14-F — Retry policy + LlmFailure integration.
//
// The pre-existing `AgentRetryPolicy.shouldRetry(errorCategory:attempt:semantics:)`
// is stringly-typed. This file adds typed overloads that consume LlmFailure.code
// directly, so the runtime and recovery planner can branch on neutral provider
// codes rather than parsing provider strings.
//
// Mapping rules (per P14 §12.3):
//   .rateLimited, .transportFailure, .providerRequestFailed(5xx-equivalent),
//   .emptyResponse             → retryable when attempt < maxAttempts
//   .authenticationFailed,
//   .modelNotFound,
//   .unsupportedProvider,
//   .configurationInvalid,
//   .contextWindowExceeded,
//   .cancelled,
//   .decodeFailure             → NOT retryable (correctness / budget concerns)
//
// Provider retryAfter is exposed via the LlmFailure, surfaced to the runtime,
// and persisted in DurableFailureRecord so the planner respects it on restart
// (P14-E backoff survives restart).

extension AgentRetryPolicy {
    /// Typed LlmFailure-aware retry decision. Source of truth for retry at
    /// the runtime / scheduler / recovery planner level. The stringly-typed
    /// `shouldRetry(errorCategory:attempt:semantics:)` remains for legacy
    /// callers; both should reach the same verdict for the same failure.
    public func shouldRetry(llmFailure: LlmFailure,
                            attempt: Int,
                            semantics: AgentToolExecutionSemantics) -> Bool {
        guard semantics.idempotency != .nonIdempotent else { return false }
        guard attempt < maxAttempts else { return false }
        switch llmFailure.code {
        case .rateLimited,
             .transportFailure,
             .emptyResponse,
             .providerRequestFailed:        // 5xx-equivalent (status >= 500 only)
            return isRetryableStatus(llmFailure.httpStatus)
        case .authenticationFailed,
             .modelNotFound,
             .unsupportedProvider,
             .configurationInvalid,
             .contextWindowExceeded,
             .decodeFailure,
             .cancelled,
             .unknown:
            return false
        }
    }

    private func isRetryableStatus(_ status: Int?) -> Bool {
        guard let status else { return true }   // unknown status: assume retryable
        return status >= 500 || status == 408 || status == 429
    }
}

/// Computed backoff for a given attempt (1-indexed) using the policy.
extension AgentRetryPolicy {
    /// Returns the wait time (seconds) before retrying attempt #N.
    /// `attempt` is the count of attempts ALREADY made; the returned value is
    /// the wait before attempt #(attempt + 1).
    public func backoffSeconds(attempt: Int) -> TimeInterval {
        let attempt = max(0, attempt - 1)
        if exponentialBackoff {
            return baseDelay * pow(2.0, Double(attempt))
        }
        return baseDelay
    }

    /// Returns a future Date for the next retry, allowing a `providerRetryAfterMs`
    /// from the provider (when set) to override the computed backoff.
    public func nextRetryDate(attempt: Int,
                              llmFailure: LlmFailure?,
                              clock: @escaping @Sendable () -> Date) -> Date {
        let computed = clock().addingTimeInterval(backoffSeconds(attempt: attempt))
        if let ms = llmFailure?.providerRetryAfterMs, ms > 0 {
            return clock().addingTimeInterval(TimeInterval(ms) / 1000.0)
        }
        return computed
    }
}
