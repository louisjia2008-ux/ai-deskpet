import Foundation
import AppKit
import os

/// P18 §25/§26 — Observes macOS permission state for screen capture + accessibility.
///
/// Both the persisted `PermissionPreferences.screenRead` flag and the live
/// `CGPreflightScreenCaptureAccess()` + `AXIsProcessTrusted()` calls are
/// surfaced through this seam. The service periodically refreshes (and bumps
/// the snapshot's `permission` field) so the UI can show "已授权 / 未授权 /
/// 已撤回" without each call site re-querying TCC.
@MainActor
public final class AwarenessPermissionObserver: ObservableObject {

    @MainActor
public protocol PermissionQuerying: AnyObject {
    func screenCapturePreflight() -> Bool
    func screenCaptureRequest() -> Bool
    func accessibilityTrusted() -> Bool
    /// P19.1 — Input Monitoring cannot be programmatically preflighted the way
    /// `AXIsProcessTrusted` can. The honest sources of evidence are:
    ///   * the OS-level `CGPreflightListenEventAccess()` (deprecated on macOS 14.4
    ///     but still returns the user-facing "trusted" flag where available), and
    ///   * a runtime probe (a brief `NSEvent.addGlobalMonitorForEvents` registration
    ///     that the OS accepts vs. silently drops).
    /// The default implementation returns `unknown` because nothing reliable
    /// runs without test seams. Production wiring passes a `SystemPermissionQuery`.
    func inputMonitoringPreflight() -> InputMonitoringState
}

    public final class SystemPermissionQuery: PermissionQuerying {
        public init() {}

        public func screenCapturePreflight() -> Bool {
            CGPreflightScreenCaptureAccess()
        }

        public func screenCaptureRequest() -> Bool {
            CGRequestScreenCaptureAccess()
        }

        public func accessibilityTrusted() -> Bool {
            AXIsProcessTrusted()
        }

        public func inputMonitoringPreflight() -> InputMonitoringState {
            // P19.1 §1 — DO NOT claim `granted` solely from successful
            // `NSEvent.addGlobalMonitorForEvents` registration. macOS may return a
            // non-nil monitor token even when no events are delivered, and the
            // runtime probe path is exactly what the audit's correction forbids.
            //
            // What we CAN call is `CGPreflightListenEventAccess()` (deprecated on
            // macOS 14.4+, but still the documented API for "is the process in the
            // Input Monitoring TCC list"). When it returns true we are confident;
            // when it returns false we are confident the system has not granted it.
            // When unavailable or deprecated we fall back to `.unknown` so the UI
            // never over-promises.
            #if compiler(>=5.9)
            if #available(macOS 14.4, *) {
                // `CGPreflightListenEventAccess` is deprecated on 14.4+ and the
                // replacement is per-event delivery observation. We conservatively
                // return `.unknown` — only a real human typing ⌘+Opt+[A|N|P|R] while
                // DeskPet is NOT frontmost can promote this to `.granted`.
                return .unknown
            } else {
                return CGPreflightListenEventAccess() ? .granted : .notDetermined
            }
            #else
            return CGPreflightListenEventAccess() ? .granted : .notDetermined
            #endif
        }
    }

    /// P19.1 §1 — typed trust hierarchy for Input Monitoring. We deliberately do
    /// NOT collapse this into a `Bool` because the OS does not give us a single
    /// boolean answer. The audit's correction mandates that we do not promote
    /// `registered` (a `NSEvent.addGlobalMonitorForEvents` returned a monitor
    /// token) to `granted` (the system actually delivers events when DeskPet is
    /// not frontmost).
    public enum InputMonitoringState: String, Sendable, Codable, Equatable {
        /// We cannot determine the trust state from available APIs. UI must say
        /// "状态未知" rather than claim anything. Typical when running on macOS
        /// 14.4+ where `CGPreflightListenEventAccess` is deprecated.
        case unknown
        /// The system reports (via `CGPreflightListenEventAccess`) that this
        /// process is NOT in the Input Monitoring TCC list. UI must say
        /// "未授权" and offer an action.
        case notDetermined
        /// The system reports (via `CGPreflightListenEventAccess`) that this
        /// process IS in the Input Monitoring TCC list. This is the strongest
        /// proof we can offer without a real human typing a global shortcut
        /// outside the app.
        case granted
        /// A real user has verified that pressing ⌘+Opt+[A|N|P|R] while DeskPet is
        /// NOT frontmost triggers the expected action. Promoted by a runtime
        /// probe (a future P19.x enhancement) or by an explicit user "我已测试可用"
        /// confirmation. UI may show "已确认可用".
        case humanVerified
    }

    public struct LiveState: Sendable, Equatable {
        public var screenCaptureGranted: Bool
        public var accessibilityGranted: Bool
        /// P19.1 §1 — see `InputMonitoringState` for the trust hierarchy.
        /// Default `.unknown` so the UI never claims more certainty than the OS
        /// query supports.
        public var inputMonitoring: InputMonitoringState

        public init(screenCaptureGranted: Bool,
                    accessibilityGranted: Bool,
                    inputMonitoring: InputMonitoringState = .unknown) {
            self.screenCaptureGranted = screenCaptureGranted
            self.accessibilityGranted = accessibilityGranted
            self.inputMonitoring = inputMonitoring
        }

        public static let unknown = LiveState(screenCaptureGranted: false,
                                              accessibilityGranted: false,
                                              inputMonitoring: .unknown)
    }

    @Published public private(set) var liveState: LiveState

    private var pollTimer: Timer?
    private let permissionQuery: PermissionQuerying
    private var hasRequestedScreenCaptureAccessThisSession = false

    /// F3 (continuation review) — invoked when `refresh()` detects a granted→denied
    /// screen-recording transition mid-session. macOS emits no public TCC
    /// notification, so consecutive-read comparison is the only signal. The owning
    /// `DesktopAwarenessService` wires this to `handlePermissionRevocation()` so
    /// privileged snapshot fields are cleared the moment the user revokes access.
    public var onScreenCaptureRevoked: (@MainActor () -> Void)?

    public init(initialScreenCaptureGranted: Bool? = nil,
                initialAccessibilityGranted: Bool? = nil,
                initialInputMonitoring: InputMonitoringState? = nil,
                permissionQuery: PermissionQuerying = SystemPermissionQuery()) {
        self.permissionQuery = permissionQuery
        if let s = initialScreenCaptureGranted, let a = initialAccessibilityGranted {
            self.liveState = LiveState(screenCaptureGranted: s,
                                       accessibilityGranted: a,
                                       inputMonitoring: initialInputMonitoring ?? .unknown)
        } else {
            self.liveState = Self.query(using: permissionQuery)
        }
    }

    public static func query() -> LiveState {
        query(using: SystemPermissionQuery())
    }

    private static func query(using permissionQuery: PermissionQuerying) -> LiveState {
        LiveState(screenCaptureGranted: permissionQuery.screenCapturePreflight(),
                  accessibilityGranted: permissionQuery.accessibilityTrusted(),
                  inputMonitoring: permissionQuery.inputMonitoringPreflight())
    }

    public func startPeriodicRefresh(interval: TimeInterval = 1.0) {
        pollTimer?.invalidate()
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                _ = self?.refresh()
            }
        }
    }

    public func stopPeriodicRefresh() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    /// R1-3 — exposes whether the periodic-refresh `Timer` is currently scheduled.
    /// Used by the awareness service to gate the polling lifecycle on the user's
    /// `maxLevel` (no polling when awareness is OFF) and by the test suite to
    /// assert the gate is honored.
    public var isPollingActive: Bool { pollTimer != nil }

    /// Re-query macOS state and publish. Safe to call from any main-thread path.
    @discardableResult
    public func refresh() -> LiveState {
        let previous = liveState
        let next = Self.query(using: permissionQuery)
        publish(next, previous: previous)
        return next
    }

    /// Ask macOS to register/request Screen Recording permission on an explicit
    /// user action. This is intentionally one-shot per process while denied so
    /// normal refreshes or repeated failed captures do not keep prompting.
    @discardableResult
    public func requestScreenCaptureAccess() -> LiveState {
        let previous = liveState
        if previous.screenCaptureGranted {
            return previous
        }
        if !hasRequestedScreenCaptureAccessThisSession {
            hasRequestedScreenCaptureAccessThisSession = true
            _ = permissionQuery.screenCaptureRequest()
        }
        let next = Self.query(using: permissionQuery)
        publish(next, previous: previous)
        return next
    }

    public var screenCaptureRequestAttemptedThisSession: Bool {
        hasRequestedScreenCaptureAccessThisSession
    }

    private func publish(_ next: LiveState, previous: LiveState) {
        if next != liveState {
            liveState = next
        }
        // F3 (continuation review — contract rule 5) — surface a mid-session
        // screen-recording revocation (granted → denied between polls) so the
        // service can clear privileged snapshot fields.
        if previous.screenCaptureGranted, !next.screenCaptureGranted {
            onScreenCaptureRevoked?()
        }
    }

    /// Best-effort detection of a mid-session revocation. The system doesn't
    /// emit a public notification when TCC status flips, so we compare two
    /// consecutive reads. The service wires this into its `refresh()` loop.
    public func detectRevocation(previous: LiveState) -> LiveState? {
        guard previous.screenCaptureGranted, !liveState.screenCaptureGranted else { return nil }
        return liveState
    }
}
