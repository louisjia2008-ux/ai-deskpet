import Foundation
import AICore
import AppKit
import os.lock

// P13-D: Approval requester seam.
//
// Before P13, the only approval surface was `ApprovalPrompt.ask` (an
// `NSAlert`-driven function). The runtime's `BrokerCapabilityGate` called it
// directly, which made the surface hard-coded and left the floating chat's
// `AgentTimelineStore.showApprovalRequest` as dead code (P13-A risk R-6).
//
// P13-D introduces a thin protocol so the runtime can request approval
// without knowing which surface renders it. The production implementation
// delegates to `ApprovalPrompt.ask`. Tests can substitute an in-memory
// implementation.

public protocol ApprovalRequesting: Sendable {
    func request(capabilityID: String, reason: String, risk: RiskLevel) async -> ApprovalDecision
}

/// Production `NSAlert`-backed implementation. Delegates to `ApprovalPrompt.ask`
/// so behaviour is byte-identical to pre-P13.
public struct NSAlertApprovalRequester: ApprovalRequesting, Sendable {
    public init() {}

    public func request(capabilityID: String, reason: String, risk: RiskLevel) async -> ApprovalDecision {
        await ApprovalPrompt.ask(capabilityID: capabilityID, reason: reason, risk: risk)
    }
}

/// In-memory implementation for tests and headless harnesses. Records every
/// request so a test can assert on the call list. Safe to use across actors
/// because all mutable state is serialized through an internal unfair lock
/// (P22 — was `DispatchQueue.sync`, now `OSAllocatedUnfairLock`).
public final class InMemoryApprovalRequester: ApprovalRequesting, Sendable {
    public struct Request: Sendable, Equatable {
        public var capabilityID: String
        public var reason: String
        public var risk: RiskLevel
    }

    private struct State {
        var requests: [Request] = []
        var responses: [String: ApprovalDecision] = [:]
    }
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    public init() {}

    public func record(response: ApprovalDecision, for capabilityID: String) {
        state.withLockUnchecked { $0.responses[capabilityID] = response }
    }

    public func request(capabilityID: String, reason: String, risk: RiskLevel) async -> ApprovalDecision {
        let recorded: (Request, ApprovalDecision) = state.withLockUnchecked { s in
            let request = Request(capabilityID: capabilityID, reason: reason, risk: risk)
            s.requests.append(request)
            return (request, s.responses[capabilityID] ?? .deny)
        }
        _ = recorded.0
        return recorded.1
    }

    public func recordedRequests() -> [Request] {
        state.withLockUnchecked { $0.requests }
    }
}