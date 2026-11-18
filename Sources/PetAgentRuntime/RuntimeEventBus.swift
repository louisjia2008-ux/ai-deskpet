import Foundation
import AICore
import PetBrainCore

// P5.0 — strongly-typed runtime event bus (doc §6.2). Core state is never passed as a stringly-typed
// dictionary; every event is an enum case carrying only metadata (ids, capability names, redacted
// reasons), never the raw user input. Thread-safe via actor isolation; subscriptions are cancellable
// and self-clean on stream termination (no retain cycle).

public enum RuntimeEvent: Sendable, Equatable {
    case runtimeStarted
    case runtimeStopped
    case runtimeSuspended
    case runtimeResumed

    case requestSubmitted(UUID)
    case requestStarted(UUID)
    case requestCompleted(UUID)
    case requestCancelled(UUID)
    case requestFailed(UUID, reason: String)

    case permissionRequested(capabilityID: String, correlationID: UUID?)
    case permissionGranted(capabilityID: String, correlationID: UUID?)
    case permissionDenied(capabilityID: String, reason: String, correlationID: UUID?)

    case actionQueued(UUID)
    case actionStarted(UUID)
    case actionCompleted(UUID)
    case actionCancelled(UUID)
    case actionFailed(UUID, reason: String)

    case behaviorStateChanged(from: String, to: String)
    case presentationCommandIssued(String)

    case toolRegistered(String)
    case toolInvocationStarted(String)
    case toolInvocationFinished(String, ok: Bool)

    case auditWarning(String)
}

/// Delivered to subscribers. The timestamp is injected (clock seam) so tests are deterministic; the
/// correlationID ties an event back to the request/action that produced it.
public struct RuntimeEventEnvelope: Sendable, Equatable {
    public var event: RuntimeEvent
    public var correlationID: UUID?
    public var timestamp: Date

    public init(event: RuntimeEvent, correlationID: UUID? = nil, timestamp: Date) {
        self.event = event
        self.correlationID = correlationID
        self.timestamp = timestamp
    }
}

public actor RuntimeEventBus {
    private let clock: RuntimeClock
    private var subscribers: [UUID: AsyncStream<RuntimeEventEnvelope>.Continuation] = [:]

    public init(clock: RuntimeClock = WallClock()) { self.clock = clock }

    /// Subscribe. The returned stream finishes (and the subscription is removed) when the caller
    /// stops iterating or calls `unsubscribe`.
    public func subscribe() -> (id: UUID, stream: AsyncStream<RuntimeEventEnvelope>) {
        let (stream, continuation) = AsyncStream.makeStream(of: RuntimeEventEnvelope.self)
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        return (id, stream)
    }

    public func unsubscribe(_ id: UUID) {
        subscribers[id]?.finish()
        subscribers[id] = nil
    }

    public func publish(_ event: RuntimeEvent, correlationID: UUID? = nil) {
        let envelope = RuntimeEventEnvelope(event: event, correlationID: correlationID, timestamp: clock.now())
        for continuation in subscribers.values { continuation.yield(envelope) }
    }

    public func subscriberCount() -> Int { subscribers.count }
}
