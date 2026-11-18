import Foundation
import AICore
import PetBrainCore
import os.lock

// P5.0 — shared timing / identity seams. Injected everywhere so tests never depend on wall-clock
// time or on the concrete value of a random UUID. No global singletons.

/// Thrown by `withTimeout` when the operation exceeds its deadline. A distinct type so callers can
/// tell a timeout apart from a real failure or a cancellation (never conflated, doc §6.10).
public struct RuntimeTimeoutError: Error, Equatable, Sendable {
    public init() {}
}

/// Run `operation` with a deadline. On timeout the operation Task is cancelled and
/// `RuntimeTimeoutError` is thrown. A cooperative cancellation of the caller surfaces as
/// `CancellationError` (not a timeout, not a failure).
public func withTimeout<T: Sendable>(seconds: TimeInterval,
                                     operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            throw RuntimeTimeoutError()
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw RuntimeTimeoutError() }
        return first
    }
}

/// Stable identity seam. Production uses real UUIDs; tests use a deterministic generator so
/// assertions can be exact (doc §8 — tests must not depend on a random UUID's value).
public protocol IdentifierGenerator: Sendable {
    func next() -> UUID
}

public struct UUIDIdentifierGenerator: IdentifierGenerator {
    public init() {}
    public func next() -> UUID { UUID() }
}

/// Deterministic, monotonically increasing UUIDs (00000000-0000-0000-0000-0000xxxxxxxx).
public final class DeterministicIdentifierGenerator: IdentifierGenerator, Sendable {
    private let counter = OSAllocatedUnfairLock<UInt32>(initialState: 1)

    public init(start: UInt32 = 1) { counter.withLockUnchecked { $0 = start } }

    public func next() -> UUID {
        let value = counter.withLockUnchecked { c in
            let v = c
            c &+= 1
            return v
        }
        let suffix = String(format: "%08x", value)
        return UUID(uuidString: "00000000-0000-0000-0000-0000\(suffix)") ?? UUID()
    }
}

/// Controllable clock for tests. Conforms to the existing `RuntimeClock` seam so it can be injected
/// anywhere a clock is accepted.
public final class TestClock: RuntimeClock, Sendable {
    private let current = OSAllocatedUnfairLock<Date>(initialState: Date(timeIntervalSinceReferenceDate: 0))

    public init(start: Date = Date(timeIntervalSinceReferenceDate: 0)) {
        current.withLockUnchecked { $0 = start }
    }

    public func now() -> Date {
        current.withLockUnchecked { $0 }
    }

    public func advance(by seconds: TimeInterval) {
        current.withLockUnchecked { $0.addTimeInterval(seconds) }
    }

    public func set(_ date: Date) {
        current.withLockUnchecked { $0 = date }
    }
}
