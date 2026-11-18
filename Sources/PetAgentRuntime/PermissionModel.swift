import Foundation
import AICore
import PetBrainCore

// P5.0 — formalizes the distinction the codebase did not yet have: an in-app POLICY grant is not the
// same as a macOS SYSTEM authorization (doc §6.4). The existing CapabilityGate/Broker decides app
// policy; this layer composes that with a system-authorization status and resolves an effective
// permission. High-sensitivity capabilities default to denied. Nothing here requests a real macOS
// permission — system status is provided through an injected seam (in-memory in tests).

/// App-side permission state for a capability (doc §6.4). Distinct from system authorization.
public enum CapabilityPermissionState: String, Sendable, Codable, Equatable {
    case unknown
    case notRequested
    case denied
    case grantedOnce
    case grantedForSession
    case grantedPersistently
    case restricted
    case unavailable
}

/// macOS system authorization status (TCC-style). `notRequired` means the capability needs no system
/// permission; `notDetermined` means it would require one we have not (and this round will not) ask for.
public enum SystemAuthorizationStatus: String, Sendable, Codable, Equatable {
    case notRequired
    case notDetermined
    case granted
    case denied
    case restricted
    case unavailable
}

/// The resolved permission. `isExecutable` is true only when app policy allows AND any required
/// system authorization is actually granted — so an in-app "granted" can never be mistaken for a
/// system grant.
public struct EffectivePermission: Sendable, Equatable {
    public var capabilityID: String
    public var applicationPolicyGranted: Bool
    public var systemAuthorizationRequired: Bool
    public var systemAuthorizationStatus: SystemAuthorizationStatus
    public var denialReason: String?

    public init(capabilityID: String, applicationPolicyGranted: Bool,
                systemAuthorizationRequired: Bool, systemAuthorizationStatus: SystemAuthorizationStatus,
                denialReason: String? = nil) {
        self.capabilityID = capabilityID
        self.applicationPolicyGranted = applicationPolicyGranted
        self.systemAuthorizationRequired = systemAuthorizationRequired
        self.systemAuthorizationStatus = systemAuthorizationStatus
        self.denialReason = denialReason
    }

    public var isExecutable: Bool {
        guard applicationPolicyGranted else { return false }
        if systemAuthorizationRequired { return systemAuthorizationStatus == .granted }
        return true
    }
}

/// Seam for system authorization. `requiresSystemAuthorization` is pure (reads immutable config);
/// `status` is async to mirror real TCC queries. This round never queries real macOS state.
public protocol SystemAuthorizationProviding: Sendable {
    func requiresSystemAuthorization(_ capabilityID: String) -> Bool
    func status(for capabilityID: String) async -> SystemAuthorizationStatus
}

/// Default policy: marks high-sensitivity capabilities as system-gated and reports them
/// `notDetermined` (we do not request real permissions in P5.0). Everything else is `notRequired`.
public struct DefaultSystemAuthorizationPolicy: SystemAuthorizationProviding {
    public static let systemGatedDefault: Set<String> = [
        "screen.frontmostWindow.captureOnce", "screen.environment.read", "screen.continuous",
        "accessibility.global", "contacts.read",
        "calendar.events.read", "calendar.event.create", "calendar.event.modify",
        "reminders.read", "keychain.generalRead",
        // conceptual high-sensitivity capabilities not in the catalog yet
        "microphone", "camera", "keyboardMonitoring", "clipboard.continuous",
    ]
    private let gated: Set<String>
    public init(gated: Set<String> = DefaultSystemAuthorizationPolicy.systemGatedDefault) { self.gated = gated }

    public func requiresSystemAuthorization(_ capabilityID: String) -> Bool { gated.contains(capabilityID) }
    public func status(for capabilityID: String) async -> SystemAuthorizationStatus {
        gated.contains(capabilityID) ? .notDetermined : .notRequired
    }
}

/// In-memory, settable system authorization store for tests (never touches real macOS state).
public actor InMemorySystemAuthorizationStore: SystemAuthorizationProviding {
    private let gated: Set<String>
    private var statuses: [String: SystemAuthorizationStatus] = [:]

    public init(gated: Set<String> = DefaultSystemAuthorizationPolicy.systemGatedDefault) { self.gated = gated }

    public nonisolated func requiresSystemAuthorization(_ capabilityID: String) -> Bool {
        gated.contains(capabilityID)
    }
    public func status(for capabilityID: String) async -> SystemAuthorizationStatus {
        if let explicit = statuses[capabilityID] { return explicit }
        return gated.contains(capabilityID) ? .notDetermined : .notRequired
    }
    public func set(_ status: SystemAuthorizationStatus, for capabilityID: String) {
        statuses[capabilityID] = status
    }
}

/// In-memory app-policy store keyed by `CapabilityPermissionState`. Models grantedOnce (one-shot) and
/// session/persistent grants deterministically. Default is `notRequested` → denied (doc §6.4).
public actor InMemoryPermissionStore {
    private var states: [String: CapabilityPermissionState] = [:]
    public init() {}

    public func set(_ state: CapabilityPermissionState, for capabilityID: String) {
        states[capabilityID] = state
    }
    public func state(for capabilityID: String) -> CapabilityPermissionState {
        states[capabilityID] ?? .notRequested
    }
    /// Resolve current allowance, consuming a one-shot `grantedOnce`.
    public func consume(_ capabilityID: String) -> Bool {
        switch states[capabilityID] ?? .notRequested {
        case .grantedOnce:
            states[capabilityID] = .notRequested
            return true
        case .grantedForSession, .grantedPersistently:
            return true
        default:
            return false
        }
    }
}

/// The runtime permission boundary. Every sensitive action/tool is resolved here before execution.
public protocol PermissionGate: Sendable {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission
}

/// Composes the existing app-side `CapabilityGate` (broker policy) with system authorization, and
/// audits every decision. Default-deny is inherited from the broker (P1+ → askUser → not granted).
public struct CapabilityPermissionGate: PermissionGate {
    private let appGate: CapabilityGate
    private let system: SystemAuthorizationProviding
    private let audit: RuntimeAuditSink
    private let clock: RuntimeClock

    public init(appGate: CapabilityGate,
                system: SystemAuthorizationProviding = DefaultSystemAuthorizationPolicy(),
                audit: RuntimeAuditSink,
                clock: RuntimeClock = WallClock()) {
        self.appGate = appGate
        self.system = system
        self.audit = audit
        self.clock = clock
    }

    public func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        let outcome = await appGate.evaluate(capabilityID: capabilityID,
                                             reason: reason,
                                             taskID: correlationID ?? UUID())
        let appGranted: Bool
        var denialReason: String?
        switch outcome {
        case .granted: appGranted = true
        case .denied(let r): appGranted = false; denialReason = r
        case .askUser: appGranted = false; denialReason = "需要用户审批"
        }

        let requires = system.requiresSystemAuthorization(capabilityID)
        let status = await system.status(for: capabilityID)
        if appGranted, requires, status != .granted {
            denialReason = "需要系统授权（\(status.rawValue)）"
        }

        let effective = EffectivePermission(
            capabilityID: capabilityID,
            applicationPolicyGranted: appGranted,
            systemAuthorizationRequired: requires,
            systemAuthorizationStatus: status,
            denialReason: denialReason)

        await audit.record(RuntimeAuditEvent(
            kind: effective.isExecutable ? .permissionGranted : .permissionDenied,
            capabilityID: capabilityID,
            correlationID: correlationID,
            summary: effective.isExecutable ? "" : RuntimeAuditRedactor.redact(denialReason ?? "denied"),
            timestamp: clock.now()))

        return effective
    }
}
