import Foundation

/// P18 — Ambient Desktop Awareness snapshot.
///
/// Single value type published by `DesktopAwarenessService`. Holds the latest
/// foreground-app, window-title, and screen-text contexts the policy permits, plus
/// freshness + sensitivity metadata + a generation counter for race-safe downstream
/// caching. The snapshot is the only thing the Agent / UI / overlay read — no other
/// code touches NSWorkspace, CGWindowList, or ScreenCapture directly (P18 §2).
public struct AwarenessSnapshot: Sendable, Equatable {

    /// Captured-at timestamps per field — freshness is computed on read from these.
    public var capturedAt: Date
    public var expiresAt: Date
    public var freshness: AwarenessFreshness
    public var generation: UInt64

    public var frontmostApp: ForegroundApplicationContext?
    public var activeWindow: ActiveWindowContext?
    public var screenText: ScreenTextContext?
    public var visualSemantics: VisualSemanticContext?

    public var permission: AwarenessPermissionState
    public var sensitiveContextSuppressed: Bool
    public var selfExclusionActive: Bool

    public var hasAnyAmbientContext: Bool {
        frontmostApp != nil || activeWindow != nil || screenText != nil || visualSemantics != nil
    }

    public init(capturedAt: Date = .distantPast,
                expiresAt: Date = .distantPast,
                freshness: AwarenessFreshness = .expired,
                generation: UInt64 = 0,
                frontmostApp: ForegroundApplicationContext? = nil,
                activeWindow: ActiveWindowContext? = nil,
                screenText: ScreenTextContext? = nil,
                visualSemantics: VisualSemanticContext? = nil,
                permission: AwarenessPermissionState = .unknown,
                sensitiveContextSuppressed: Bool = false,
                selfExclusionActive: Bool = false) {
        self.capturedAt = capturedAt
        self.expiresAt = expiresAt
        self.freshness = freshness
        self.generation = generation
        self.frontmostApp = frontmostApp
        self.activeWindow = activeWindow
        self.screenText = screenText
        self.visualSemantics = visualSemantics
        self.permission = permission
        self.sensitiveContextSuppressed = sensitiveContextSuppressed
        self.selfExclusionActive = selfExclusionActive
    }

    /// Empty snapshot used as the initial / cleared state.
    public static let empty = AwarenessSnapshot()

    public func withFreshness(at now: Date) -> AwarenessSnapshot {
        var copy = self
        copy.freshness = AwarenessFreshness.compute(capturedAt: capturedAt,
                                                    expiresAt: expiresAt,
                                                    now: now)
        return copy
    }
}

/// Foreground application (L1). Never carries title or content here.
public struct ForegroundApplicationContext: Sendable, Equatable, Codable {
    public var bundleIdentifier: String?
    public var displayName: String
    public var capturedAt: Date
    public var source: AwarenessSnapshot.Source
    public var sensitivity: AwarenessContextSensitivity

    public init(bundleIdentifier: String?,
                displayName: String,
                capturedAt: Date = Date(),
                source: AwarenessSnapshot.Source = .foregroundApplication,
                sensitivity: AwarenessContextSensitivity = .routine) {
        self.bundleIdentifier = bundleIdentifier
        self.displayName = displayName
        self.capturedAt = capturedAt
        self.source = source
        self.sensitivity = sensitivity
    }
}

/// Active window title (L2). Only populated when the bundle is in the title whitelist.
public struct ActiveWindowContext: Sendable, Equatable, Codable {
    public var title: String?
    public var owningApplicationBundleID: String?
    public var capturedAt: Date
    public var source: AwarenessSnapshot.Source

    public init(title: String?,
                owningApplicationBundleID: String?,
                capturedAt: Date = Date(),
                source: AwarenessSnapshot.Source = .accessibilityWindow) {
        self.title = title
        self.owningApplicationBundleID = owningApplicationBundleID
        self.capturedAt = capturedAt
        self.source = source
    }
}

/// Screen text (L3). Ephemeral; never persisted; raw CGImage discarded at capture.
/// `ephemeral` is always true per the hard rule — the snapshot itself is a value
/// type and goes out of scope with its consumer.
public struct ScreenTextContext: Sendable, Equatable, Codable {
    public var text: String
    public var captureStartedAt: Date
    public var captureCompletedAt: Date
    public var source: AwarenessSnapshot.Source
    public var ephemeral: Bool

    public init(text: String,
                captureStartedAt: Date,
                captureCompletedAt: Date,
                source: AwarenessSnapshot.Source = .screenCapture,
                ephemeral: Bool = true) {
        self.text = text
        self.captureStartedAt = captureStartedAt
        self.captureCompletedAt = captureCompletedAt
        self.source = source
        self.ephemeral = ephemeral
    }
}

/// Visual semantic context (L4 deferred). The multimodal model interprets screen
/// content directly; this captures the result of any provider response. Today the
/// code path gracefully returns nil — no image-capable model is wired into the
/// chat loop yet. See `AwarenessPermissionObserver` for the gating seam.
public struct VisualSemanticContext: Sendable, Equatable, Codable {
    public var description: String
    public var confidence: Double
    public var capturedAt: Date
    public var source: AwarenessSnapshot.Source

    public init(description: String,
                confidence: Double,
                capturedAt: Date = Date(),
                source: AwarenessSnapshot.Source = .visionModel) {
        self.description = description
        self.confidence = confidence
        self.capturedAt = capturedAt
        self.source = source
    }
}

/// Sensitivity classification for a foreground app. Drives the suppression policy.
public enum AwarenessContextSensitivity: String, Sendable, Codable, Equatable {
    case routine
    case sensitive
    case unknown
}

/// Permission state for the awareness subsystem. Distinct from `CapabilityPermissionState`
/// (which is a 3rd-party seam) and `PreferenceModel.preferences.screenRead` (which is the
/// persisted macOS side). This one is the runtime-availability reading.
public enum AwarenessPermissionState: String, Sendable, Codable, Equatable {
    case unknown          // not yet queried
    case available        // screen recording granted; can capture
    case denied           // user explicitly denied; capture returns nil
    case disabled         // product setting is OFF
    case revoked          // user revoked mid-session; capture must stop
    case sleeping         // system is asleep; capture deferred
}

/// Origin label for awareness fields — distinct from `AwarenessPermissionState`'s
/// permission lens; this one tells the test harness where a field came from.
///
/// `AwarenessSnapshot.Source` is a stable, namespaced alias so call sites can keep
/// writing the full qualified form (`AwarenessSnapshot.Source.foregroundApplication`)
/// for consistency with the rest of the snapshot.
public enum AwarenessSource: String, Sendable, Codable, Equatable {
    case foregroundApplication
    case accessibilityWindow
    case screenCapture
    case visionModel
    case unavailable
}

extension AwarenessSnapshot {
    /// Stable, namespaced alias so call sites can keep writing the full qualified
    /// form (`AwarenessSnapshot.Source.foregroundApplication`) for consistency.
    public typealias Source = AwarenessSource
}

/// Freshness classification for a snapshot field. Computed from `capturedAt`
/// against `now`. Stale/expired content MUST NOT be injected into the Agent
/// prompt (`AIServices.generate(_:)` is the gate).
public enum AwarenessFreshness: String, Sendable, Codable, Equatable, Comparable {
    case fresh      // < 5 s
    case recent     // 5–60 s
    case stale      // 60 s – expiresAt
    case expired    // > expiresAt

    public static func < (lhs: AwarenessFreshness, rhs: AwarenessFreshness) -> Bool {
        lhs.rank < rhs.rank
    }

    private var rank: Int {
        switch self {
        case .fresh: return 0
        case .recent: return 1
        case .stale: return 2
        case .expired: return 3
        }
    }

    public static func compute(capturedAt: Date,
                                expiresAt: Date,
                                now: Date) -> AwarenessFreshness {
        if now >= expiresAt { return .expired }
        let age = now.timeIntervalSince(capturedAt)
        if age < 5 { return .fresh }
        if age < 60 { return .recent }
        return .stale
    }
}
