import Foundation
import AICore

// P5.0 — privacy-safe runtime audit. Records metadata only: never the full user prompt, never a
// token/credential, never file contents (doc §6.9). Reuses AICore's redaction so the rule lives in
// one place. The sink is injected; the in-memory sink is the test/default implementation.

public enum RuntimeAuditKind: String, Sendable, Codable, Equatable {
    case runtimeStarted, runtimeStopped, runtimeSuspended, runtimeResumed
    case permissionRequested, permissionGranted, permissionDenied
    case toolRegistered, toolInvocationStarted, toolInvocationFinished, toolInvocationFailed
    case actionQueued, actionStarted, actionCompleted, actionCancelled, actionFailed
    case cancellation, timeout, invalidTransition, policySuppression, errorRecovery, warning
    case staleCallbackDropped          // P14.2 (R-A-F4)
    case continuationRecovered         // P14.2 (R-A-F1)
    case retryResumed                  // P14.3 (INV-RD-01..04)
    case postApprovalResumed           // P14.3 (INV-ACR-01..05)
    case retryScheduled                // P14.5 (INV-RH-02..03)
}

/// One audit record. `summary` is already redacted and is metadata only (e.g. "len=42"), never the
/// raw content.
public struct RuntimeAuditEvent: Sendable, Codable, Equatable {
    public var kind: RuntimeAuditKind
    public var capabilityID: String?
    public var correlationID: UUID?
    public var summary: String
    public var timestamp: Date

    public init(kind: RuntimeAuditKind, capabilityID: String? = nil, correlationID: UUID? = nil,
                summary: String = "", timestamp: Date) {
        self.kind = kind
        self.capabilityID = capabilityID
        self.correlationID = correlationID
        self.summary = summary
        self.timestamp = timestamp
    }
}

/// Redaction helpers. `redact` defers to AICore's single source of truth; `metadata` never echoes
/// content — it only describes shape.
public enum RuntimeAuditRedactor {
    public static func redact(_ s: String) -> String { AuditLog.redact(s) }
    public static func metadata(length: Int) -> String { "len=\(length)" }
    public static func metadata(forText text: String) -> String { "len=\(text.count)" }
}

public protocol RuntimeAuditSink: Sendable {
    func record(_ event: RuntimeAuditEvent) async
}

/// In-memory sink (default + test). Append-only; exposes read accessors for assertions.
public actor InMemoryAuditSink: RuntimeAuditSink {
    public private(set) var events: [RuntimeAuditEvent] = []
    public init() {}

    public func record(_ event: RuntimeAuditEvent) async { events.append(event) }

    public func all() -> [RuntimeAuditEvent] { events }
    public func last() -> RuntimeAuditEvent? { events.last }
    public func count(of kind: RuntimeAuditKind) -> Int { events.filter { $0.kind == kind }.count }
    public func contains(kind: RuntimeAuditKind) -> Bool { events.contains { $0.kind == kind } }
}
