import Foundation
import AICore
import PetBrainCore

// MARK: - Conversation turn state machine (doc §11 streaming path).
//
// The original `converse()` lived inside the coordinator's actor as a single
// ~475-line `async` function with five mutable locals (`buffer`, `emotion`,
// `viaCloud`, `outputSeq`, `terminated`) that wove setup, streaming, retry
// classification, acceptance, and completion together. This file lifts the
// streaming phase into a Sendable struct so the same logic is testable as a
// pure state transition: `ConversationTurn` consumes one chunk, returns the
// next decision, and the actor stays in charge of durable persistence.
//
// The actor remains the single owner of every `await`; this struct is purely
// synchronous over already-decoded inputs. Any new behavior added here should
// stay that way (no network, no DB, no `actor` re-entry) — when it needs to
// emit an `await` effect, the result type routes back to the caller.

enum ConversationTurnDecision: Sendable, Equatable {
    /// Streaming continues; no terminal state observed yet.
    case keepStreaming
    /// The chunk loop should drop any remaining chunks and return immediately.
    /// Same semantics as the inline `return` inside the streaming `for` loop.
    case cancelImmediately
    /// The actor should run the typed-failure retry handoff; the chunk loop has ended.
    case retry(reason: String, typedFailure: LlmFailure)
    /// The actor should run the non-retryable `.failed` terminal handoff.
    case failTerminal(reason: String, typedFailure: LlmFailure?, durableFailure: DurableFailureRecord?)
    /// The catch arm saw a cancellation; no failure or retry.
    case canceled
}

struct ConversationTurn: Sendable {
    public var buffer: String
    public var emotion: PetEmotion
    public var viaCloud: Bool
    public var outputSeq: Int
    public var pendingTypedFailure: LlmFailure?
    public var terminated: Bool

    init() {
        self.buffer = ""
        self.emotion = .neutral
        self.viaCloud = false
        self.outputSeq = 0
        self.pendingTypedFailure = nil
        self.terminated = false
    }

    /// Apply a single provider chunk. Returns whether the chunk loop should
    /// bail (mirror of `terminated = true; return` in the original code).
    @discardableResult
    mutating func consume(chunk: ConversationChunk) -> Bool {
        switch chunk {
        case .metadata:
            // Surface-only; nothing to absorb.
            return false
        case .delta(let seq, let text):
            outputSeq = max(outputSeq + 1, seq)
            buffer += text
            return terminated   // caller already set `terminated` if a
                                // downstream emit was dropped for cancel.
        case .completed(let e, let vc):
            emotion = e; viaCloud = vc
            return false
        case .typedError(let failure):
            pendingTypedFailure = failure
            // Caller turns this into a throw to enter the catch branch
            // (preserving R-B-F01 semantics).
            return true
        }
    }

    /// Did the chunk loop cancel for any reason? Pure aggregator of the
    /// four signals the inline catch branch inspected.
    static func isTerminalized(_ flags: CancelFlags) -> Bool {
        ConversePipelineHelpers.isTerminalizedCancellation(flags)
    }

    /// Map the typed-failure observation + retryability into a decision.
    /// Mirrors the inline if/else if/else tail in the catch branch — no
    /// new policy, only moved out for unit testing.
    func resolveFailure(error: Error) -> ConversationTurnDecision {
        let typedFailure = pendingTypedFailure
        let durableFailure: DurableFailureRecord? = typedFailure.map {
            DurableFailureRecord(llmFailure: $0, phase: "provider")
        }
        // The typed failure's message is the authoritative user-facing
        // reason; the thrown error's LocalizedDescription is the fallback
        // (mirrors the inline production behavior at the call site).
        let reason: String
        if let typedFailure, !typedFailure.message.isEmpty {
            reason = typedFailure.message
        } else {
            reason = ConversePipelineHelpers.userFacingGenerationError(error)
        }
        if let typedFailure {
            return .failTerminal(reason: reason,
                                  typedFailure: typedFailure,
                                  durableFailure: durableFailure)
        }
        return .failTerminal(reason: reason, typedFailure: nil, durableFailure: nil)
    }

    /// Apply a `CancelFlags` snapshot. Returns whether the chunk loop should
    /// drop any further chunks (true ⇒ `cancelImmediately`).
    func applyCancellationIfAny(_ flags: CancelFlags) -> Bool {
        Self.isTerminalized(flags)
    }
}