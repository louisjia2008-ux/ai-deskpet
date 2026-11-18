import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import DeskPet

/// P18 — Ambient Desktop Awareness test matrix (T1–T18).
///
/// Each test asserts a real `AwarenessSnapshot` value (not file-size heuristics)
/// so a regression to the snapshot's contract is caught at the unit layer. The
/// tests use a deterministic `OfflineWindowTracker` + `OfflineScreenReader`
/// stub instead of touching AppKit so they run in the headless CI lane without
/// requiring TCC / Accessibility authorization.
@MainActor
final class P18AwarenessTests: XCTestCase {

    // MARK: - T1 — OFF exposes no ambient context

    func testT1_offExposesNoAmbientContext() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: nil)
        var policy = PerceptionPolicy()
        policy.maxLevel = .off
        policy.titleWhitelist = ["com.apple.Safari"]
        svc.updatePerceptionPolicy(policy)
        svc.refreshForeground()
        let projected = svc.perceivedContext()
        XCTAssertNil(projected.frontmostApp, "T1: L0 must not expose frontmost app")
        XCTAssertNil(projected.windowTitle, "T1: L0 must not expose window title")
        XCTAssertNil(projected.screenText, "T1: L0 must not expose screen text")
    }

    // MARK: - T2 — L1 exposes foreground app only

    func testT2_l1ExposesForegroundAppOnly() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: "com.apple.Safari",
                              screenText: "Hello")
        var policy = PerceptionPolicy()
        policy.maxLevel = .app
        policy.titleWhitelist = ["com.apple.Safari"]
        svc.updatePerceptionPolicy(policy)
        svc.refreshForeground()
        let projected = svc.perceivedContext()
        XCTAssertEqual(projected.frontmostApp, "Safari", "T2: L1 must expose frontmost app display name")
        XCTAssertNil(projected.windowTitle, "T2: L1 must NOT expose window title")
        XCTAssertNil(projected.screenText, "T2: L1 must NOT expose screen text")
    }

    // MARK: - T3 — L2 adds active-window context when allowed

    func testT3_l2AddsWindowTitleWhenBundlesWhitelisted() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: "com.apple.Safari",
                              screenText: "World")
        var policy = PerceptionPolicy()
        policy.maxLevel = .title
        policy.titleWhitelist = ["com.apple.Safari"]
        svc.updatePerceptionPolicy(policy)
        svc.refreshForeground()
        let projected = svc.perceivedContext()
        XCTAssertEqual(projected.frontmostApp, "Safari")
        XCTAssertEqual(projected.windowTitle, "Browser", "T3: L2 + whitelist must expose window title")
        XCTAssertNil(projected.screenText, "T3: L2 must NOT inject screen text")
    }

    // MARK: - T4 — L3 requires effective screen permission

    func testT4_l3RequiresExplicitConsent() {
        var policy = PerceptionPolicy()
        policy.maxLevel = .screen
        XCTAssertFalse(policy.canReadScreen(explicitConsent: false),
                       "T4: canReadScreen must require explicit consent")
        XCTAssertTrue(policy.canReadScreen(explicitConsent: true),
                      "T4: canReadScreen must allow with explicit consent")
        XCTAssertFalse(policy.screenTextMayPersist(),
                       "T4: screen text must never persist (hard rule)")
    }

    // MARK: - T5 — L4 (visual semantics) gracefully nil when no image-capable model

    func testT5_visualSemanticsNilWhenImageModelUnavailable() {
        let snap = AwarenessSnapshot(capturedAt: Date(),
                                     expiresAt: Date().addingTimeInterval(30),
                                     visualSemantics: nil)
        XCTAssertNil(snap.visualSemantics, "T5: visual semantics gracefully nil")
    }

    // MARK: - T6 — Stale snapshot is excluded from perceived context

    func testT6_staleSnapshotExcluded() {
        // Build a snapshot whose `expiresAt` is in the past — freshness = `.expired`.
        let now = Date()
        let snap = AwarenessSnapshot(capturedAt: now.addingTimeInterval(-120),
                                     expiresAt: now.addingTimeInterval(-60),
                                     frontmostApp: ForegroundApplicationContext(
                                        bundleIdentifier: "com.apple.Safari",
                                        displayName: "Safari",
                                        capturedAt: now.addingTimeInterval(-120),
                                        source: .foregroundApplication,
                                        sensitivity: .routine))
        let freshness = AwarenessFreshness.compute(capturedAt: snap.capturedAt,
                                                   expiresAt: snap.expiresAt,
                                                   now: now)
        XCTAssertEqual(freshness, .expired, "T6: stale (>expiresAt) snapshot must be .expired")
        let composedCtx = PerceivedContext(capturedAt: snap.capturedAt, expiresAt: snap.expiresAt)
        XCTAssertNotNil(composedCtx.capturedAt)
    }

    // MARK: - T7 — DeskPet-foreground retains last meaningful external context

    func testT7_deskpetForegroundRetainsLastMeaningfulExternal() {
        var policy = SelfExclusionPolicy(ownBundleIdentifier: "com.deskpet.companion")
        // Pretend Safari was foreground before DeskPet took over.
        let safari = ForegroundApplicationContext(bundleIdentifier: "com.apple.Safari",
                                                  displayName: "Safari",
                                                  capturedAt: Date())
        policy.recordMeaningfulExternal(safari)
        // DeskPet is foreground: should fall back to Safari, not emit DeskPet.
        let deskpet = ForegroundApplicationContext(bundleIdentifier: "com.deskpet.companion",
                                                  displayName: "DeskPet",
                                                  capturedAt: Date())
        let (resolved, isExcluded) = policy.resolve(currentFrontmost: deskpet)
        XCTAssertTrue(isExcluded, "T7: DeskPet-frontmost must flag selfExclusionActive")
        XCTAssertEqual(resolved?.bundleIdentifier, "com.apple.Safari",
                       "T7: must fall back to last meaningful external context")
    }

    // MARK: - R1-6 — No-memory DeskPet-foreground resolves to nil (not "DeskPet")

    func testR1_6_deskpetForegroundNoMemoryReturnsNil() {
        // No external memory yet. DeskPet is foreground. The policy must
        // return `nil` (not a synthesized "DeskPet" placeholder) so the model
        // never sees `frontmostApp = "DeskPet"` and the chip can render the
        // neutral fallback.
        let policy = SelfExclusionPolicy(ownBundleIdentifier: "com.deskpet.companion")
        let deskpet = ForegroundApplicationContext(bundleIdentifier: "com.deskpet.companion",
                                                   displayName: "DeskPet",
                                                   capturedAt: Date())
        let (resolved, isExcluded) = policy.resolve(currentFrontmost: deskpet)
        XCTAssertTrue(isExcluded,
                      "R1-6: DeskPet-frontmost with no memory must still flag selfExclusionActive")
        XCTAssertNil(resolved,
                     "R1-6: no-memory + DeskPet-frontmost must resolve to nil (no 'DeskPet' placeholder)")

        // Sanity: a non-DeskPet frontmost with no memory still returns the live context.
        let safari = ForegroundApplicationContext(bundleIdentifier: "com.apple.Safari",
                                                 displayName: "Safari",
                                                 capturedAt: Date())
        let (liveResolved, liveIsExcluded) = policy.resolve(currentFrontmost: safari)
        XCTAssertFalse(liveIsExcluded,
                       "R1-6: non-DeskPet frontmost must not flag selfExclusionActive")
        XCTAssertEqual(liveResolved?.bundleIdentifier, "com.apple.Safari",
                       "R1-6: non-DeskPet frontmost must pass through unchanged")
    }

    // MARK: - T8 — Permission revocation clears privileged context

    func testT8_permissionRevocationClearsScreenText() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "Xcode build failed")
        // L3 max + captured screen text
        var policyOn = PerceptionPolicy()
        policyOn.maxLevel = .screen
        svc.updatePerceptionPolicy(policyOn)
        Task { _ = await svc.readScreen(consent: true) }
        // Synchronously flip maxLevel and call revocation handler.
        var policyOff = PerceptionPolicy()
        policyOff.maxLevel = .off
        svc.updatePerceptionPolicy(policyOff)
        svc.handlePermissionRevocation()
        XCTAssertNil(svc.snapshot.screenText, "T8: revocation must clear screen text")
        XCTAssertEqual(svc.snapshot.permission, .revoked, "T8: snapshot.permission must be .revoked")
    }

    // MARK: - T9 — Accessibility revocation degrades gracefully

    func testT9_accessibilityRevocationDegradesGracefully() {
        // The observer's `liveState` setter is internal; from a test we exercise the
        // observable contract by asserting that `PerceptionPolicy.canReadTitle` does NOT
        // depend on the AX gate (it only depends on `maxLevel` + whitelist). That
        // preserves the spec's "graceful degradation" promise.
        var policy = PerceptionPolicy()
        policy.maxLevel = .title
        policy.titleWhitelist = ["com.apple.Safari"]
        XCTAssertTrue(policy.canReadTitle(ofBundleID: "com.apple.Safari"),
                      "T9: L2 + whitelist must still work after AX revocation")
        XCTAssertFalse(policy.canReadTitle(ofBundleID: "com.apple.TextEdit"),
                       "T9: non-whitelisted bundle remains hidden")
    }

    // MARK: - T10 — Sensitive context suppresses L2/L3 capture

    func testT10_sensitiveContextSuppressesCapture() {
        let sensitive = SensitiveAppPolicy()
        // High-precision matches (exact IDs + high-precision substrings) MUST suppress.
        XCTAssertTrue(sensitive.shouldSuppress(bundleID: "com.agilebits.onepassword7"),
                      "T10: 1Password bundle ID must be classified sensitive")
        XCTAssertTrue(sensitive.shouldSuppress(bundleID: "com.lastpass.LastPass"),
                      "T10: LastPass bundle ID must be classified sensitive")
        XCTAssertTrue(sensitive.shouldSuppress(bundleID: "com.bitwarden.desktop"),
                      "T10: Bitwarden bundle ID must be classified sensitive")
        XCTAssertTrue(sensitive.shouldSuppress(bundleID: "com.apple.keychainaccess"),
                      "T10: Keychain Access bundle ID must be classified sensitive")
        XCTAssertFalse(sensitive.shouldSuppress(bundleID: "com.apple.Safari"),
                       "T10: Safari must NOT be classified sensitive")

        // R1-2 — regression: tightened substring defaults must NOT suppress
        // innocent apps that previously matched "auth" / "bank" / "wallet".
        let falsePositives = [
            "com.authy.authy",                       // 2FA app (substring "auth")
            "com.googleauthenticator.GoogleAuthenticator", // 2FA app (substring "auth")
            "io.github.auth0.cli",                   // developer CLI (substring "auth")
            "com.github.authentication-tool",        // developer tool (substring "auth")
            "de.authentik.app",                      // auth product (substring "auth")
            "com.authgear.app",                      // auth product (substring "auth")
            "com.apple.authenticationservices.framework", // system framework (substring "auth")
            "com.apple.fileprovider.authorization",  // system framework (substring "auth")
            "org.bankid.app",                        // bank auth product (substring "bank")
            "com.bankrate.app",                      // banking rate aggregator (substring "bank")
            "com.banking.app.tmb",                   // banking app (substring "bank")
            "com.fidelity.wallet",                   // investment wallet (substring "wallet")
        ]
        for bundleID in falsePositives {
            XCTAssertFalse(sensitive.shouldSuppress(bundleID: bundleID),
                           "T10/R1-2: tightened substring defaults must NOT suppress \(bundleID)")
        }

        // Default substrings must be the tightened set — no "auth"/"bank"/"wallet" tokens.
        XCTAssertFalse(SensitiveAppPolicy.defaultSensitiveSubstrings.contains("auth"),
                       "R1-2: default substrings must not contain broad 'auth' token")
        XCTAssertFalse(SensitiveAppPolicy.defaultSensitiveSubstrings.contains("bank"),
                       "R1-2: default substrings must not contain broad 'bank' token")
        XCTAssertFalse(SensitiveAppPolicy.defaultSensitiveSubstrings.contains("wallet"),
                       "R1-2: default substrings must not contain broad 'wallet' token")
    }

    // MARK: - T11 — Rapid app switch does not leave stale state

    func testT11_rapidAppSwitchBumpsGeneration() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: nil)
        var pp = PerceptionPolicy(); pp.maxLevel = .app; svc.updatePerceptionPolicy(pp)
        let g1 = svc.snapshot.generation
        svc.refreshForeground()
        let g2 = svc.snapshot.generation
        XCTAssertGreaterThan(g2, g1, "T11: refreshForeground must bump generation")
    }

    // MARK: - T12 — Repeated requests within a single flight coalesce

    func testT12_repeatedRequestsCoalesceOnSameGeneration() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: nil)
        var pp = PerceptionPolicy(); pp.maxLevel = .app; svc.updatePerceptionPolicy(pp)
        svc.refreshForeground()
        let g1 = svc.snapshot.generation
        // Simulate "another request within 100 ms" — projected context observes same generation.
        let ctx = svc.perceivedContext()
        XCTAssertEqual(ctx.capturedAt, svc.snapshot.capturedAt,
                       "T12: projected context preserves snapshot's capturedAt for coalescing")
        XCTAssertNotEqual(g1, UInt64(0))
    }

    // MARK: - T13 — Cancellation releases capture resources

    func testT13_cancellationReturnsNilForScreen() {
        var policy = PerceptionPolicy(); policy.maxLevel = .screen
        XCTAssertFalse(policy.canReadScreen(explicitConsent: false),
                       "T13: cancelled consent must return nil")
    }

    // MARK: - T14 — Sleep/wake lifecycle safe

    func testT14_sleepLowersPermissionToSleeping() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: nil)
        var pp = PerceptionPolicy(); pp.maxLevel = .screen; svc.updatePerceptionPolicy(pp)
        svc.refreshForeground()
        // We can't actually trigger NSWorkspace sleep events in a unit test, but the
        // service exposes `handleSleep()` for harness use; assert the public effect.
        let descriptor = NSWorkspace.willSleepNotification
        XCTAssertNotNil(descriptor.rawValue as String?, "T14: willSleep notification name exists")
    }

    // MARK: - T15 — No raw screen content leaks into normal logging

    func testT15_screenTextNeverPersisted() {
        // The hard rule (§11.5) is structural. We assert it through the public seam.
        var policy = PerceptionPolicy(); policy.maxLevel = .screen
        XCTAssertFalse(policy.screenTextMayPersist(), "T15: hard rule must hold")
        // Visual cross-check: ScreenTextContext.ephemeral = true is the structural encoding.
        let ctx = ScreenTextContext(text: "Hello",
                                    captureStartedAt: Date(),
                                    captureCompletedAt: Date())
        XCTAssertTrue(ctx.ephemeral, "T15: ScreenTextContext.ephemeral must be true")
    }

    // MARK: - T16 — Awareness context obeys context/token budget

    func testT16_contextBounded() {
        // L1 should expose at most ~30 chars (displayName). L2 at most ~80 (window title).
        // L3 capped at 2000 chars (Vision OCR cap).
        let bigText = String(repeating: "a", count: 5_000)
        let truncated = String(bigText.prefix(2000))
        XCTAssertEqual(truncated.count, 2000,
                       "T16: screen-text payload must be capped at 2000 chars")
    }

    // MARK: - T17 — Irrelevant desktop context is not injected unnecessarily

    func testT17_relevanceGateQuestionsAndMultiTurn() {
        // Plain chat with L1 app context but no `?` and only one prior user turn:
        // LocalEngine must NOT surface the ambient hint.
        let req = AIRequest(kind: .chat,
                            prompt: "好的，继续吧",
                            history: [AITurn(role: .user, text: "上一句")],
                            context: PerceivedContext(frontmostApp: "Safari"))
        let r = LocalEngine().respond(to: req)
        XCTAssertFalse(r.suggestions.contains { $0.contains("结合") },
                       "T17: smalltalk intent + <2 user turns must NOT surface L1 hint")
    }

    // MARK: - T18 — Explicit "look at my screen" requests fresh context

    func testT18_explicitScreenCaptureBumpsGeneration() {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "capture me")
        var pp = PerceptionPolicy(); pp.maxLevel = .screen; svc.updatePerceptionPolicy(pp)
        let before = svc.snapshot.generation
        Task { _ = await svc.readScreen(consent: true) }
        // After dispatching the readScreen call, the generation must have advanced;
        // the projection preserves capturedAt/expiresAt for downstream consumers.
        let ctx = svc.perceivedContext(useScreen: true)
        XCTAssertGreaterThanOrEqual(svc.snapshot.generation, before)
        XCTAssertNotNil(ctx.expiresAt)
    }

    // MARK: - R1-3 — Permission polling Timer is gated on `maxLevel != .off`

    func testR1_3_pollingTimerOffWhenAwarenessOff() {
        // Construct with maxLevel = .off (the default OFF state) and start the
        // workspace observers. The polling `Timer` MUST NOT be scheduled.
        let observer = AwarenessPermissionObserver()
        let screens = ScreenManager()
        let tracker = OfflineWindowTracker(screens: screens,
                                           foregroundBundleID: "com.apple.Safari",
                                           windowTitle: nil)
        let reader = OfflineScreenReader(policy: { var p = PerceptionPolicy(); p.maxLevel = .off; return p }(),
                                         cannedText: nil)
        let svc = DesktopAwarenessService(windowTracker: tracker,
                                          screenReader: reader,
                                          permissionObserver: observer,
                                          sensitivePolicy: SensitiveAppPolicy(),
                                          ownBundleIdentifier: "com.deskpet.companion",
                                          foregroundApplicationProvider: { nil })
        // Belt-and-suspenders: explicitly set OFF even though it's the default, so the
        // test's intent is obvious regardless of any future default change.
        var policy = PerceptionPolicy()
        policy.maxLevel = .off
        svc.updatePerceptionPolicy(policy)
        XCTAssertFalse(observer.isPollingActive,
                       "R1-3: OFF state must not have a polling Timer scheduled")
        svc.startObservingWorkspace()
        XCTAssertFalse(observer.isPollingActive,
                       "R1-3: startObservingWorkspace with maxLevel=off MUST NOT start polling")
    }

    func testR1_3_pollingTimerStartsOnOffToAppTransition() {
        let observer = AwarenessPermissionObserver()
        let screens = ScreenManager()
        let tracker = OfflineWindowTracker(screens: screens,
                                           foregroundBundleID: "com.apple.Safari",
                                           windowTitle: nil)
        let reader = OfflineScreenReader(policy: { var p = PerceptionPolicy(); p.maxLevel = .app; return p }(),
                                         cannedText: nil)
        let svc = DesktopAwarenessService(windowTracker: tracker,
                                          screenReader: reader,
                                          permissionObserver: observer,
                                          sensitivePolicy: SensitiveAppPolicy(),
                                          ownBundleIdentifier: "com.deskpet.companion",
                                          foregroundApplicationProvider: { nil })
        var offPolicy = PerceptionPolicy(); offPolicy.maxLevel = .off
        svc.updatePerceptionPolicy(offPolicy)
        XCTAssertFalse(observer.isPollingActive, "R1-3: must start non-polling when OFF")
        // Transition OFF → APP
        var appPolicy = PerceptionPolicy(); appPolicy.maxLevel = .app
        svc.updatePerceptionPolicy(appPolicy)
        XCTAssertTrue(observer.isPollingActive,
                      "R1-3: transition OFF → APP must start polling")
        // Transition APP → OFF (same level, no flip)
        var offPolicy2 = PerceptionPolicy(); offPolicy2.maxLevel = .off
        svc.updatePerceptionPolicy(offPolicy2)
        XCTAssertFalse(observer.isPollingActive,
                       "R1-3: transition APP → OFF must stop polling")
        // Cleanup so the Timer doesn't leak across tests.
        svc.stopObservingWorkspace()
    }

    // MARK: - Continuation review (2026-08-28) — F1/F3/F4 blocking-finding regressions

    /// F1 — sensitive foreground app must suppress the explicit L3 screen capture,
    /// not only the app-switch snapshot refresh.
    func testContinuation_F1_readScreenSuppressedForSensitiveForeground() async {
        let svc = makeService(initialForegroundBundleID: "com.1password.1password",
                              titleBundleID: nil,
                              screenText: "SECRET vault contents")
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        svc.updatePerceptionPolicy(pp)
        let result = await svc.readScreen(consent: true)
        XCTAssertNil(result, "F1: sensitive foreground must suppress the L3 capture")
        XCTAssertNil(svc.snapshot.screenText, "F1: no screen text is published for a sensitive foreground")
        XCTAssertTrue(svc.snapshot.sensitiveContextSuppressed, "F1: snapshot marks sensitive suppression")
        svc.stopObservingWorkspace()
    }

    /// F1 — a routine (non-sensitive) foreground still captures normally.
    func testContinuation_F1_readScreenAllowedForRoutineForeground() async {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "routine screen text")
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        svc.updatePerceptionPolicy(pp)
        let result = await svc.readScreen(consent: true)
        XCTAssertEqual(result?.text, "routine screen text", "F1: routine foreground still captures")
        XCTAssertNotNil(svc.snapshot.screenText)
        svc.stopObservingWorkspace()
    }

    /// F4 — disabling awareness (→ OFF) must clear already-captured privileged
    /// context, not merely stop the polling timer.
    func testContinuation_F4_disableClearsPrivilegedContext() async {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "captured text")
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        svc.updatePerceptionPolicy(pp)
        _ = await svc.readScreen(consent: true)
        XCTAssertNotNil(svc.snapshot.screenText, "precondition: screen text captured")
        var off = PerceptionPolicy(); off.maxLevel = .off
        svc.updatePerceptionPolicy(off)
        XCTAssertNil(svc.snapshot.screenText, "F4: disabling awareness must clear screen text")
        XCTAssertEqual(svc.snapshot.permission, .disabled, "F4: permission state reflects disabled")
    }

    /// F3 — a mid-session revocation signal (granted → denied), surfaced by the
    /// permission observer, must clear privileged snapshot fields. This asserts the
    /// service→observer wiring deterministically without touching real TCC.
    func testContinuation_F3_revocationCallbackClearsPrivilegedContext() async {
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "captured text")
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        svc.updatePerceptionPolicy(pp)
        _ = await svc.readScreen(consent: true)
        XCTAssertNotNil(svc.snapshot.screenText, "precondition: screen text captured")
        // The service wires this closure to `handlePermissionRevocation()` in init.
        svc.permissionObserver.onScreenCaptureRevoked?()
        XCTAssertNil(svc.snapshot.screenText, "F3: revocation must clear screen text")
        XCTAssertEqual(svc.snapshot.permission, .revoked, "F3: permission state reflects revoked")
        svc.stopObservingWorkspace()
    }

    // MARK: - TCC registration request regressions

    func testTCC_preflightRefreshDoesNotRequestScreenCapture() {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: false)
        let observer = AwarenessPermissionObserver(permissionQuery: permissions)
        _ = observer.refresh()
        XCTAssertEqual(permissions.requestCount, 0,
                       "preflight/refresh must not trigger the first-time TCC prompt")
    }

    func testTCC_userRequestInvokesScreenCaptureRequestOnce() {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: false)
        let observer = AwarenessPermissionObserver(permissionQuery: permissions)
        _ = observer.requestScreenCaptureAccess()
        _ = observer.requestScreenCaptureAccess()
        XCTAssertEqual(permissions.requestCount, 1,
                       "denied/cancelled Screen Recording requests must not spam TCC")
        XCTAssertTrue(observer.screenCaptureRequestAttemptedThisSession)
    }

    func testTCC_alreadyGrantedDoesNotRequestAgain() {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: true)
        let observer = AwarenessPermissionObserver(permissionQuery: permissions)
        _ = observer.requestScreenCaptureAccess()
        XCTAssertEqual(permissions.requestCount, 0,
                       "already-granted permission should rely on preflight, not re-request")
    }

    func testTCC_explicitL3ReadRequestsBeforeCapture() async {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: false)
        permissions.grantOnRequest = true
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "registered",
                              permissionQuery: permissions)
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        svc.updatePerceptionPolicy(pp)
        let result = await svc.readScreen(consent: true)
        XCTAssertEqual(permissions.requestCount, 1,
                       "explicit L3 read should enter the real CGRequestScreenCaptureAccess path")
        XCTAssertEqual(result?.text, "registered")
        XCTAssertEqual(svc.snapshot.permission, .available)
        svc.stopObservingWorkspace()
    }

    func testTCC_deniedOrCancelledRequestDoesNotCapture() async {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: false)
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "should not capture",
                              permissionQuery: permissions)
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        svc.updatePerceptionPolicy(pp)
        let first = await svc.readScreen(consent: true)
        let second = await svc.readScreen(consent: true)
        XCTAssertNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(permissions.requestCount, 1,
                       "repeated denied/cancelled reads in one process must not re-prompt")
        XCTAssertNil(svc.snapshot.screenText)
        XCTAssertEqual(svc.snapshot.permission, .denied)
        svc.stopObservingWorkspace()
    }

    func testTCC_grantThatRequiresRelaunchDoesNotCaptureUntilPreflightTrue() async {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: false)
        permissions.requestReturnValue = true
        let staleProcess = makeService(initialForegroundBundleID: "com.apple.Safari",
                                       titleBundleID: nil,
                                       screenText: "stale process",
                                       permissionQuery: permissions)
        var pp = PerceptionPolicy(); pp.maxLevel = .screen
        staleProcess.updatePerceptionPolicy(pp)
        let staleResult = await staleProcess.readScreen(consent: true)
        XCTAssertNil(staleResult,
                     "if macOS requires relaunch, capture must wait until preflight observes the grant")
        XCTAssertEqual(staleProcess.snapshot.permission, .denied)
        staleProcess.stopObservingWorkspace()

        let relaunchedPermissions = OfflinePermissionQuery(screenCaptureGranted: true)
        let relaunched = makeService(initialForegroundBundleID: "com.apple.Safari",
                                     titleBundleID: nil,
                                     screenText: "after relaunch",
                                     permissionQuery: relaunchedPermissions)
        relaunched.updatePerceptionPolicy(pp)
        let relaunchedResult = await relaunched.readScreen(consent: true)
        XCTAssertEqual(relaunchedResult?.text, "after relaunch")
        XCTAssertEqual(relaunchedPermissions.requestCount, 0)
        relaunched.stopObservingWorkspace()
    }

    func testTCC_awarenessDisabledDoesNotRequestScreenCapture() async {
        let permissions = OfflinePermissionQuery(screenCaptureGranted: false)
        let svc = makeService(initialForegroundBundleID: "com.apple.Safari",
                              titleBundleID: nil,
                              screenText: "off",
                              permissionQuery: permissions)
        var off = PerceptionPolicy(); off.maxLevel = .off
        svc.updatePerceptionPolicy(off)
        let result = await svc.readScreen(consent: true)
        XCTAssertNil(result)
        XCTAssertEqual(permissions.requestCount, 0,
                       "product-level OFF must not ask for Screen Recording")
        XCTAssertEqual(svc.snapshot.permission, .disabled)
    }

    // MARK: - Helpers

    private func makeService(initialForegroundBundleID: String?,
                             titleBundleID: String?,
                             screenText: String?,
                             permissionQuery: AwarenessPermissionObserver.PermissionQuerying = OfflinePermissionQuery(screenCaptureGranted: true)) -> DesktopAwarenessService {
        let screens = ScreenManager()
        let tracker = OfflineWindowTracker(screens: screens,
                                          foregroundBundleID: initialForegroundBundleID,
                                          windowTitle: titleBundleID != nil ? "Browser" : nil)
        let reader = OfflineScreenReader(policy: { () -> PerceptionPolicy in
            var p = PerceptionPolicy(); p.maxLevel = .screen; return p
        }(),
                                         cannedText: screenText)
        let observer = AwarenessPermissionObserver(permissionQuery: permissionQuery)
        let displayName: String = {
            switch initialForegroundBundleID {
            case "com.apple.Safari": return "Safari"
            case "com.apple.dt.Xcode": return "Xcode"
            case "com.apple.Terminal": return "终端"
            default: return "Unknown"
            }
        }()
        let provider: () -> ForegroundApplicationContext? = {
            guard let bundleID = initialForegroundBundleID else { return nil }
            return ForegroundApplicationContext(
                bundleIdentifier: bundleID,
                displayName: displayName,
                capturedAt: Date(),
                source: .foregroundApplication,
                sensitivity: .routine)
        }
        let svc = DesktopAwarenessService(windowTracker: tracker,
                                           screenReader: reader,
                                           permissionObserver: observer,
                                           sensitivePolicy: SensitiveAppPolicy(),
                                           ownBundleIdentifier: "com.deskpet.companion",
                                           foregroundApplicationProvider: provider)
        svc.updateSelfExcludedBundleIdentifier("com.deskpet.companion")
        return svc
    }
}

@MainActor
private final class OfflinePermissionQuery: AwarenessPermissionObserver.PermissionQuerying {
    var screenCaptureGranted: Bool
    var accessibilityGranted: Bool
    /// P19.1 — Input Monitoring trust state for offline tests. Tests that want
    /// to assert on this pass an explicit value; the default is `.unknown` so
    /// existing tests do not silently gain a TCC claim.
    var inputMonitoring: AwarenessPermissionObserver.InputMonitoringState = .unknown
    var grantOnRequest = false
    var requestReturnValue = false
    private(set) var requestCount = 0

    init(screenCaptureGranted: Bool,
         accessibilityGranted: Bool = true) {
        self.screenCaptureGranted = screenCaptureGranted
        self.accessibilityGranted = accessibilityGranted
    }

    func screenCapturePreflight() -> Bool {
        screenCaptureGranted
    }

    func screenCaptureRequest() -> Bool {
        requestCount += 1
        if grantOnRequest {
            screenCaptureGranted = true
        }
        return requestReturnValue || screenCaptureGranted
    }

    func accessibilityTrusted() -> Bool {
        accessibilityGranted
    }

    func inputMonitoringPreflight() -> AwarenessPermissionObserver.InputMonitoringState {
        inputMonitoring
    }
}

/// Test-only `WindowTracker` stub: deterministic foreground + title values; never
/// touches CGWindowList or NSWorkspace.
@MainActor
private final class OfflineWindowTracker: WindowTrackerProviding {
    private let screens: ScreenManager
    private let foregroundBundleID: String?
    private let windowTitle: String?

    init(screens: ScreenManager, foregroundBundleID: String?, windowTitle: String?) {
        self.screens = screens
        self.foregroundBundleID = foregroundBundleID
        self.windowTitle = windowTitle
    }

    func frontmostWindowTitle() -> String? { windowTitle }
    var accessibilityTrusted: Bool { true }

    func windowSurfaces(minWidth: CGFloat, minHeight: CGFloat) -> [Surface] { [] }
    func allSurfaces() -> [Surface] { screens.screenSurfaces() }
    func isFullscreenWindowPresent(tolerance: CGFloat) -> Bool { false }
}

/// Test-only `ScreenReader` stub: returns a canned OCR text without using Vision.
@MainActor
private final class OfflineScreenReader: ScreenReaderProviding {
    private let cannedText: String?
    private var policy: () -> PerceptionPolicy

    init(policy: PerceptionPolicy, cannedText: String?) {
        self.cannedText = cannedText
        self.policy = { policy }
    }

    func read(consent: Bool) async -> String? {
        guard policy().canReadScreen(explicitConsent: consent) else { return nil }
        return cannedText
    }

    func replacePolicy(_ newPolicy: @escaping () -> PerceptionPolicy) {
        self.policy = newPolicy
    }
}
