import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P18.5 — Cancellation Contract Tests.
///
/// Locks the invariants established / repaired in the P18.5 cancellation
/// contract audit:
///
/// - INV-CANCEL-03 (F1): a cancellation that surfaces as a *thrown* error out
///   of the conversation stream terminalizes as `.cancelled`, never as
///   `.failed` / `.typedFailed` (which would be recorded as a generic provider
///   failure and could enter the retry-classification path).
/// - INV-CANCEL-04 (F2): `AIServices.classify(CancellationError)` maps to the
///   non-retryable `.cancelled` failure code, never `.unknown`.
/// - Quota contract (C5/C6): a cancellation is never a retryable failure, so a
///   user Stop can never drive a retry or a provider fallback.
@MainActor
final class P18_5CancellationContractTests: XCTestCase {

    // MARK: - Fakes

    /// A conversation provider whose stream throws `CancellationError` on the
    /// first (and only) iteration, before yielding any chunk. This reproduces
    /// the window where a cancellation reaches the coordinator's `converse()`
    /// catch block as a thrown error without a prior `terminalizedAttempts`
    /// marking.
    private struct ThrowingCancellationConversation: ConversationGenerating {
        func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
            AsyncThrowingStream { continuation in
                continuation.finish(throwing: CancellationError())
            }
        }
    }

    /// A conversation provider that throws a genuine (non-cancellation)
    /// provider error — used as the contrast case proving the catch block
    /// still surfaces real failures.
    private struct ThrowingProviderErrorConversation: ConversationGenerating {
        func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
            AsyncThrowingStream { continuation in
                continuation.finish(throwing: ConversationGenerationError(message: "boom"))
            }
        }
    }

    private func collectOutputs(_ coordinator: PetAgentRuntimeCoordinator,
                               text: String = "hello") async -> [PetAgentRuntimeOutput] {
        let event = UserMessageEvent(conversationID: UUID(), messageID: UUID(),
                                     text: text, taskIDOverride: UUID(),
                                     runIDOverride: UUID(), metadata: UserMessageMetadata())
        var outputs: [PetAgentRuntimeOutput] = []
        for await output in coordinator.handle(.userMessage(event)) {
            outputs.append(output)
        }
        return outputs
    }

    private func hasCancelled(_ outputs: [PetAgentRuntimeOutput]) -> Bool {
        outputs.contains { if case .cancelled = $0 { return true } else { return false } }
    }
    private func hasFailed(_ outputs: [PetAgentRuntimeOutput]) -> Bool {
        outputs.contains {
            switch $0 {
            case .failed, .typedFailed: return true
            default: return false
            }
        }
    }

    // MARK: - F1: thrown cancellation terminalizes as .cancelled

    func testF1_thrownCancellationTerminalizesAsCancelledNotFailed() async throws {
        // Empty-text respond decision => empty `preset` => converse() drives
        // `conversation.generate(...)`, whose stream throws CancellationError.
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: ""),
            conversation: ThrowingCancellationConversation())
        let outputs = await collectOutputs(coordinator)

        XCTAssertTrue(hasCancelled(outputs),
                      "A thrown CancellationError MUST terminalize as .cancelled")
        XCTAssertFalse(hasFailed(outputs),
                       "A cancelled turn MUST NOT be emitted as .failed / .typedFailed")
    }

    /// Contrast case: a genuine provider error must still surface as a failure,
    /// proving F1 narrowed only the cancellation path and did not swallow real
    /// failures.
    func testF1_genuineProviderErrorStillSurfacesAsFailure() async throws {
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: ""),
            conversation: ThrowingProviderErrorConversation())
        let outputs = await collectOutputs(coordinator)

        XCTAssertTrue(hasFailed(outputs),
                      "A genuine provider error MUST still surface as a failure")
        XCTAssertFalse(hasCancelled(outputs),
                       "A genuine provider error MUST NOT be mislabeled as .cancelled")
    }

    // MARK: - F2: classify(CancellationError) -> .cancelled

    func testF2_classifyCancellationErrorMapsToCancelled() {
        let failure = AIServices.classify(CancellationError())
        XCTAssertEqual(failure?.code, .cancelled,
                       "CancellationError MUST classify as .cancelled, never .unknown")
    }

    func testF2_classifyNonCancellationErrorUnaffected() {
        // Regression guard: a transport-shaped URLError still classifies as a
        // transport failure (not accidentally swallowed by the new branch).
        let failure = AIServices.classify(URLError(.timedOut))
        XCTAssertEqual(failure?.code, .transportFailure)
    }

    // MARK: - C5/C6: cancellation is never retryable (no retry / no fallback)

    func testQuota_cancellationIsNeverRetryable() {
        let policy = AgentRetryPolicy()
        let idempotent = AgentToolExecutionSemantics(idempotency: .idempotent)
        XCTAssertFalse(policy.shouldRetry(llmFailure: LlmFailure(code: .cancelled, message: "cancelled"),
                                          attempt: 1, semantics: idempotent),
                       "A cancelled request MUST NOT be retried (no quota re-burn).")
        XCTAssertFalse(policy.shouldRetry(llmFailure: LlmFailure(code: .unknown, message: "x"),
                                          attempt: 1, semantics: idempotent),
                       "An .unknown failure MUST NOT be retried (defangs any residual mislabel).")
    }
}
