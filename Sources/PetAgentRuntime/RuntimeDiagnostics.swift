import Foundation

// P5.0 — pure, UI-free diagnostics snapshot. Safe to surface anywhere (logs, a future debug panel,
// the CurrentRuntimeStatusTool). Contains no conversation text, no token, no credential, no file
// content — only coarse runtime state counters.

public struct RuntimeDiagnosticsSnapshot: Sendable, Equatable, Codable {
    public var runtimeState: String
    public var behaviorMode: String
    public var behaviorState: String
    public var activeRequestCount: Int
    public var registeredToolCount: Int
    public var lastAuditSummary: String?

    public init(runtimeState: String, behaviorMode: String, behaviorState: String,
                activeRequestCount: Int, registeredToolCount: Int, lastAuditSummary: String? = nil) {
        self.runtimeState = runtimeState
        self.behaviorMode = behaviorMode
        self.behaviorState = behaviorState
        self.activeRequestCount = activeRequestCount
        self.registeredToolCount = registeredToolCount
        self.lastAuditSummary = lastAuditSummary
    }

    public static let empty = RuntimeDiagnosticsSnapshot(
        runtimeState: "stopped", behaviorMode: "companion", behaviorState: "dormant",
        activeRequestCount: 0, registeredToolCount: 0, lastAuditSummary: nil)

    public var compactSummary: String {
        "state=\(runtimeState) mode=\(behaviorMode) behavior=\(behaviorState) "
            + "active=\(activeRequestCount) tools=\(registeredToolCount)"
    }
}
