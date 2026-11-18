import Foundation
import AppKit
import Combine
import os
import AICore
import PetBrainCore

/// P18 — Single authoritative ambient desktop awareness subsystem.
///
/// Wraps the pre-existing `WindowTracker`, `ScreenReader`, and `PerceptionPolicy`
/// into one owner of ambient state. Consumers (overlay, agent, settings UI) read
/// the published `snapshot` and never call NSWorkspace / CGWindowList /
/// ScreenCapture directly. The service also installs an NSWorkspace event
/// observer so app switches prompt a fresh snapshot (no polling).
///
/// Concurrency: `@MainActor` — all reads/writes happen on the main thread because
/// every collaborator (AppKit, CGWindowList, NSWorkspace) is main-thread.
@MainActor
public final class DesktopAwarenessService: ObservableObject, AwarenessServiceReferencing {

    // MARK: - Configuration sources

    private let windowTracker: WindowTrackerProviding
    private let screenReader: ScreenReaderProviding
    public let permissionObserver: AwarenessPermissionObserver
    public private(set) var sensitivePolicy: SensitiveAppPolicy
    public private(set) var selfExclusion: SelfExclusionPolicy

    /// P18 — Injected seam for "what is the current foreground application?". Defaults
    /// to a NSWorkspace call; tests inject a deterministic stub so the snapshot's
    /// `frontmostApp` field can be asserted without flicker from the test process.
    var foregroundApplicationProvider: () -> ForegroundApplicationContext?

    /// User-controllable PerceptionPolicy (maxLevel, titleWhitelist). Stored here
    /// (not on `ChatModel.perception`) so every consumer agrees.
    @Published public var perception: PerceptionPolicy = .init()

    /// Toggle for L4-style multimodal screen analysis. Deferred (no model wired);
    /// the toggle exists so the UI can render faithfully.
    @Published public var screenAnalysisEnabled: Bool = false

    // MARK: - Published state

    @Published public private(set) var snapshot: AwarenessSnapshot = .empty

    /// Last computed screen text for visual feedback (so the indicator chip can
    /// show "屏幕已读取 5s 前" without re-capturing).
    @Published public private(set) var lastScreenTextAgeSeconds: Int? = nil

    // MARK: - Private state

    private var observers: [NSObjectProtocol] = []
    private var generation: UInt64 = 0
    private var lastSignificantlyExternalUpdateAt: Date = .distantPast
    private let logger = Logger(subsystem: "ai.deskpet.awareness", category: "service")

    init(windowTracker: WindowTrackerProviding,
         screenReader: ScreenReaderProviding,
         permissionObserver: AwarenessPermissionObserver,
         sensitivePolicy: SensitiveAppPolicy = SensitiveAppPolicy(),
         ownBundleIdentifier: String?,
         foregroundApplicationProvider: (() -> ForegroundApplicationContext?)? = nil) {
        self.windowTracker = windowTracker
        self.screenReader = screenReader
        self.permissionObserver = permissionObserver
        self.sensitivePolicy = sensitivePolicy
        self.selfExclusion = SelfExclusionPolicy(ownBundleIdentifier: ownBundleIdentifier)
        self.foregroundApplicationProvider = foregroundApplicationProvider ?? Self.defaultForegroundApplicationProvider
        self.refreshForeground()
        // F3 (continuation review) — wire mid-session revocation detection so a TCC
        // revoke clears privileged fields even without an explicit UI action.
        self.permissionObserver.onScreenCaptureRevoked = { [weak self] in
            self?.handlePermissionRevocation()
        }
    }

    /// Designated init that wires the production collaborators.
    static func makeShared(screens: ScreenManager,
                           ownBundleIdentifier: String?) -> DesktopAwarenessService {
        let tracker = WindowTracker(screens: screens)
        let reader = ScreenReader(policy: { PerceptionPolicy() })
        let observer = AwarenessPermissionObserver()
        return DesktopAwarenessService(windowTracker: tracker,
                                       screenReader: reader,
                                       permissionObserver: observer,
                                       sensitivePolicy: SensitiveAppPolicy(),
                                       ownBundleIdentifier: ownBundleIdentifier)
    }

    /// Replace the PerceptionPolicy the screen-reader sees. External callers
    /// (the chat composer / settings UI) flip this when the user changes the
    /// awareness level.
    public func updatePerceptionPolicy(_ policy: PerceptionPolicy) {
        let previousLevel = perception.maxLevel
        perception = policy
        // R1-3 — gate the permission-observer polling `Timer` on the user's
        // `maxLevel`. Start polling when transitioning OFF → ON; stop polling
        // when ON → OFF. Honors P18 §22 / §25 / §26 ("no continuous surveillance
        // when awareness is off"). Also re-checked on `startObservingWorkspace()`.
        applyPermissionPollingGate(previousLevel: previousLevel, newLevel: policy.maxLevel)
    }

    private func applyPermissionPollingGate(previousLevel: PerceptionLevel,
                                            newLevel: PerceptionLevel) {
        if newLevel == .off {
            permissionObserver.stopPeriodicRefresh()
            // F4 (P2, continuation review — contract rule 6) — disabling awareness
            // must also clear any privileged context already captured (window title
            // / screen text / visual semantics), not merely stop the polling timer.
            handleProductAwarenessDisabled()
        } else if previousLevel == .off {
            permissionObserver.startPeriodicRefresh(interval: 1.5)
        }
    }

    public func updateSelfExcludedBundleIdentifier(_ id: String?) {
        selfExclusion.setOwnBundleIdentifier(id)
        refreshForeground()
    }

    // MARK: - AwarenessServiceReferencing conformance

    /// Live CGPreflightScreenCaptureAccess result, backed by the observer's most-recent
    /// query. The settings UI consults this so the macOS-side row reflects reality
    /// (not the persisted preference alone).
    public var screenCaptureGranted: Bool? {
        permissionObserver.liveState.screenCaptureGranted
    }

    /// P19.1 / P0-A — live `AXIsProcessTrusted()` result. Per the audit
    /// correction, this is the single source of TCC truth for Accessibility;
    /// we do NOT mirror it into `PermissionPreferences.accessibility` because
    /// the persisted preference is workflow state, not a grant.
    public var accessibilityLiveGranted: Bool? {
        permissionObserver.liveState.accessibilityGranted
    }

    /// P19.1 / P0-A — live Input Monitoring trust state. The observer returns
    /// `.unknown` on macOS 14.4+ where `CGPreflightListenEventAccess` is
    /// deprecated, and we propagate that honest answer through to the UI.
    public var inputMonitoringLiveState: AwarenessPermissionObserver.InputMonitoringState {
        permissionObserver.liveState.inputMonitoring
    }

    @discardableResult
    public func requestScreenCaptureAccess() -> Bool {
        let live = permissionObserver.requestScreenCaptureAccess()
        var snap = snapshot
        snap.permission = computePermissionState(liveState: live)
        snapshot = snap
        return live.screenCaptureGranted
    }

    /// P19.1 / P0-A — explicit user-triggered refresh of the permission observer.
    /// Called by the Settings UI's "刷新状态" buttons and from
    /// `AppDelegate.applicationDidBecomeActive`.
    @discardableResult
    public func refreshPermissionState() -> Bool {
        permissionObserver.refresh()
        return true
    }

    // MARK: - Default foreground lookup

    /// Production default: synchronous NSWorkspace call. Returns `nil` when the test
    /// process happens to be foreground but is called from a headless CI lane.
    private static func defaultForegroundApplicationProvider() -> ForegroundApplicationContext? {
        let front = NSWorkspace.shared.frontmostApplication
        guard let front else { return nil }
        return ForegroundApplicationContext(
            bundleIdentifier: front.bundleIdentifier,
            displayName: front.localizedName ?? "Unknown",
            capturedAt: Date(),
            source: .foregroundApplication,
            sensitivity: SensitiveAppPolicy().classify(bundleID: front.bundleIdentifier))
    }

    // MARK: - Observers

    /// Install NSWorkspace event observers. Idempotent: previously-installed
    /// observers are removed first so re-starting the service is safe.
    public func startObservingWorkspace() {
        stopObservingWorkspace()
        let center = NSWorkspace.shared.notificationCenter
        observers.append(
            center.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                               object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshForeground() }
            })
        observers.append(
            center.addObserver(forName: NSWorkspace.willSleepNotification,
                               object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.handleSleep() }
            })
        observers.append(
            center.addObserver(forName: NSWorkspace.didWakeNotification,
                               object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.handleWake() }
            })
        observers.append(
            center.addObserver(forName: NSWorkspace.screensDidSleepNotification,
                               object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.handleScreenSleep() }
            })
        observers.append(
            center.addObserver(forName: NSWorkspace.screensDidWakeNotification,
                               object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.handleScreenWake() }
            })
        // R1-3 — honor the `maxLevel` gate. The polling `Timer` only runs when
        // awareness is enabled (`>= .app`). If the user has the level off at launch,
        // `updatePerceptionPolicy(_:)` will start the timer when they turn awareness on.
        if perception.maxLevel != .off {
            permissionObserver.startPeriodicRefresh(interval: 1.5)
        }
    }

    public func stopObservingWorkspace() {
        let center = NSWorkspace.shared.notificationCenter
        for token in observers { center.removeObserver(token) }
        observers.removeAll()
        permissionObserver.stopPeriodicRefresh()
    }

    /// Update the snapshot WITHOUT touching generation — used when the policy
    /// changes but the underlying fields are unchanged.
    public func recomputeWithCurrentPermissions() {
        bumpGeneration()
        let now = Date()
        var snap = snapshot
        let sensitive = sensitivePolicy.shouldSuppress(bundleID: snap.frontmostApp?.bundleIdentifier)
        snap.sensitiveContextSuppressed = sensitive
        if sensitive {
            snap.activeWindow = nil
            snap.screenText = nil
        }
        snap.permission = computePermissionState()
        snap.freshness = AwarenessFreshness.compute(capturedAt: snap.capturedAt,
                                                    expiresAt: snap.expiresAt,
                                                    now: now)
        snapshot = snap
    }

    // MARK: - Foreground / window refresh

    /// Refresh the foreground-app field from NSWorkspace. Bumps generation even
    /// if the bundle ID hasn't changed — the chip / Agent prompt observes the
    /// generation to coalesce repeated queries.
    public func refreshForeground() {
        bumpGeneration()
        let now = Date()
        let liveContext = foregroundApplicationProvider()
        // Resolve self-exclusion.
        var mutableSelf = selfExclusion
        let (resolved, selfExclusionActive) = mutableSelf.resolve(currentFrontmost: liveContext, now: now)
        // Record the live external context (non-DeskPet) before resolving.
        if let liveContext,
           !mutableSelf.isSelfExcluded(frontmostBundleID: liveContext.bundleIdentifier) {
            mutableSelf.recordMeaningfulExternal(liveContext)
        }
        selfExclusion = mutableSelf

        var snap = snapshot
        snap.generation = generation
        snap.frontmostApp = resolved
        snap.selfExclusionActive = selfExclusionActive
        snap.capturedAt = now
        snap.expiresAt = now.addingTimeInterval(Self.appLevelTTL)
        snap.permission = computePermissionState()

        // Sensitive context: drop window title + screen text (conservative).
        let sensitiveSuppressed = sensitivePolicy.shouldSuppress(bundleID: liveContext?.bundleIdentifier)
        snap.sensitiveContextSuppressed = sensitiveSuppressed
        if sensitiveSuppressed {
            snap.activeWindow = nil
            snap.screenText = nil
        } else {
            refreshActiveWindow(in: &snap, now: now, liveBundleID: liveContext?.bundleIdentifier)
        }
        snap.freshness = AwarenessFreshness.compute(capturedAt: snap.capturedAt,
                                                    expiresAt: snap.expiresAt,
                                                    now: now)
        snapshot = snap
    }

    /// Refresh the window-title field. Honors the PerceptionPolicy.titleWhitelist
    /// and SensitiveAppPolicy together.
    public func refreshActiveWindow() {
        bumpGeneration()
        let now = Date()
        var snap = snapshot
        refreshActiveWindow(in: &snap,
                            now: now,
                            liveBundleID: snapshot.frontmostApp?.bundleIdentifier)
        snap.freshness = AwarenessFreshness.compute(capturedAt: snap.capturedAt,
                                                    expiresAt: snap.expiresAt,
                                                    now: now)
        snapshot = snap
    }

    private func refreshActiveWindow(in snap: inout AwarenessSnapshot,
                                      now: Date,
                                      liveBundleID: String?) {
        guard perception.canReadTitle(ofBundleID: liveBundleID) else {
            snap.activeWindow = ActiveWindowContext(title: nil,
                                                    owningApplicationBundleID: liveBundleID,
                                                    capturedAt: now)
            return
        }
        let title = windowTracker.frontmostWindowTitle()
        snap.activeWindow = ActiveWindowContext(title: title,
                                                owningApplicationBundleID: liveBundleID,
                                                capturedAt: now)
    }

    // MARK: - L3 screen capture

    /// Capture the screen once on explicit consent. Always creates a new
    /// capture (no caching across messages); the captured `Snapshot` is bumped
    /// so downstream consumers can detect "fresh OCR".
    @discardableResult
    public func readScreen(consent: Bool) async -> ScreenTextContext? {
        bumpGeneration()
        let started = Date()
        guard consent, perception.canReadScreen(explicitConsent: consent) else {
            return nil
        }
        guard permissionObserver.liveState.screenCaptureGranted || requestScreenCaptureAccess() else {
            var snap = snapshot
            snap.screenText = nil
            snap.permission = computePermissionState()
            snapshot = snap
            logger.info("screenText capture skipped: screen-recording permission unavailable generation=\(self.generation)")
            return nil
        }
        // F1 (P1, continuation review) — sensitive-app suppression must gate the
        // explicit L3 capture path too, not only the app-switch snapshot refresh.
        // Without this, a password manager / keychain UI in the foreground could
        // have its screen OCR'd straight into the prompt, contradicting the
        // Settings promise ("敏感应用前自动屏蔽窗口标题与屏幕内容"). We re-query the
        // live foreground at capture time and refuse the capture if it is sensitive.
        let liveForeground = foregroundApplicationProvider()
        if sensitivePolicy.shouldSuppress(bundleID: liveForeground?.bundleIdentifier) {
            var snap = snapshot
            snap.screenText = nil
            snap.sensitiveContextSuppressed = true
            snap.permission = computePermissionState()
            snapshot = snap
            logger.info("screenText capture suppressed: sensitive foreground generation=\(self.generation)")
            return nil
        }
        let text = await screenReader.read(consent: consent)
        let completed = Date()
        guard let text, !text.isEmpty else {
            return nil
        }
        let ctx = ScreenTextContext(text: text,
                                    captureStartedAt: started,
                                    captureCompletedAt: completed)
        var snap = snapshot
        snap.screenText = ctx
        snap.permission = computePermissionState()
        snap.freshness = .fresh
        snapshot = snap
        lastScreenTextAgeSeconds = 0
        logger.info("screenText captured characters=\(ctx.text.count) generation=\(self.generation)")
        return ctx
    }

    // MARK: - Permission revocation

    /// Drop any captured screen text + window title. Foreground app context is
    /// retained so the indicator chip can still tell the user "awareness OFF".
    public func handlePermissionRevocation() {
        bumpGeneration()
        var snap = snapshot
        snap.screenText = nil
        snap.visualSemantics = nil
        snap.activeWindow = ActiveWindowContext(title: nil,
                                                owningApplicationBundleID: snap.frontmostApp?.bundleIdentifier)
        snap.permission = .revoked
        snap.freshness = .expired
        snapshot = snap
    }

    /// User disabled awareness at the product level (Settings → maxLevel: off).
    public func handleProductAwarenessDisabled() {
        bumpGeneration()
        var snap = snapshot
        snap.activeWindow = nil
        snap.screenText = nil
        snap.visualSemantics = nil
        snap.permission = .disabled
        snap.freshness = .expired
        snapshot = snap
    }

    // MARK: - Lifecycle hooks

    private func handleSleep() {
        bumpGeneration()
        var snap = snapshot
        snap.permission = .sleeping
        snap.screenText = nil   // capture stale on resume
        snapshot = snap
    }

    private func handleWake() {
        refreshForeground()
    }

    private func handleScreenSleep() {
        bumpGeneration()
        var snap = snapshot
        snap.permission = .sleeping
        snap.screenText = nil
        snapshot = snap
    }

    private func handleScreenWake() {
        refreshForeground()
    }

    // MARK: - Permission state computation

    private func computePermissionState() -> AwarenessPermissionState {
        computePermissionState(liveState: permissionObserver.liveState)
    }

    private func computePermissionState(liveState live: AwarenessPermissionObserver.LiveState) -> AwarenessPermissionState {
        if perception.maxLevel == .off { return .disabled }
        if !live.screenCaptureGranted && perception.maxLevel >= .screen {
            return .denied
        }
        return .available
    }

    // MARK: - Generation

    @inline(__always)
    private func bumpGeneration() {
        generation &+= 1
    }

    // MARK: - TTLs

    /// L1 foreground-app TTL is 30 s (graceful degradation for ambient chatter).
    /// The actual foreground refresh is event-driven (NSWorkspace), so this TTL
    /// only matters if the observer misses a notification.
    public static let appLevelTTL: TimeInterval = 30
    public static let windowTitleTTL: TimeInterval = 30
    public static let screenTextTTL: TimeInterval = 10
}

// MARK: - Snapshot projection helpers

extension DesktopAwarenessService {
    /// Project the current snapshot into the bounded `PerceivedContext` shape the
    /// agent consumes. Freshness + relevance gating + self-exclusion are applied
    /// here so the agent never sees privileged-after-revocation or stale fields.
    public func perceivedContext(for promptText: String? = nil,
                                 useScreen: Bool = false,
                                 now: Date = Date()) -> PerceivedContext {
        // P18 §6 — L0 (off) hard-walls every field. Apply the policy at projection.
        let policy = perception
        if policy.maxLevel == .off {
            return PerceivedContext(capturedAt: .distantPast, expiresAt: .distantPast)
        }

        var ctx = PerceivedContext(
            frontmostApp: nil,
            windowTitle: nil,
            screenText: nil,
            memoryHints: []
        )

        // Freshness gate — exclude stale fields.
        switch snapshot.freshness {
        case .expired:
            return ctx
        case .stale where snapshot.screenText == nil:
            // Allow cached foreground / window even when "stale" (UI may still find them useful).
            break
        case .stale, .fresh, .recent:
            break
        }

        if policy.canReadApp {
            ctx.frontmostApp = snapshot.frontmostApp?.displayName
        }
        if policy.canReadTitle(ofBundleID: snapshot.frontmostApp?.bundleIdentifier),
           !snapshot.sensitiveContextSuppressed {
            ctx.windowTitle = snapshot.activeWindow?.title
        }

        if useScreen, let screenText = snapshot.screenText, !snapshot.sensitiveContextSuppressed {
            let age = now.timeIntervalSince(screenText.captureCompletedAt)
            if age <= Self.screenTextTTL {
                ctx.screenText = screenText.text
            }
            // Consume-once (doc §11.5 即用即删): the OCR text is projected into
            // this single request's ephemeral context and immediately purged from
            // the snapshot so a later message cannot reuse it. The indicator chip
            // still shows recency via `lastScreenTextAgeSeconds`.
            var snap = snapshot
            snap.screenText = nil
            snapshot = snap
            lastScreenTextAgeSeconds = 0
            bumpGeneration()
        }

        // Stamp capturedAt / expiresAt on the projected context (backward-compatible).
        if let capturedAt = snapshot.capturedAt as Date? {
            ctx.capturedAt = capturedAt
            ctx.expiresAt = snapshot.expiresAt
        }
        return ctx
    }

    /// Convenience for tests / chip rendering: returns a short display string.
    public func indicatorChipText(now: Date = Date()) -> String? {
        switch perception.maxLevel {
        case .off:
            return nil
        case .app:
            return snapshot.frontmostApp.map { "正在了解 \($0.displayName)" }
                ?? "当前应用感知已开启"
        case .title:
            if snapshot.sensitiveContextSuppressed {
                return "敏感应用已屏蔽"
            }
            if let title = snapshot.activeWindow?.title {
                return "窗口：\(title)"
            }
            return "窗口标题感知已开启"
        case .screen:
            if snapshot.sensitiveContextSuppressed {
                return "敏感应用已屏蔽"
            }
            if snapshot.screenText != nil, let seconds = lastScreenTextAgeSeconds {
                return "屏幕已读取 \(seconds)s 前"
            }
            return "屏幕理解已就绪"
        }
    }
}
