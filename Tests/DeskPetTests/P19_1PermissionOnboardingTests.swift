import XCTest
import SwiftUI
import AppKit
import Combine
import PetAgentRuntime
@testable import DeskPet

private let p19PermissionRepositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path

/// P19.1 / P0-A — Accessibility + Input Monitoring live state plumbing.
///
/// The contract under test: `AwarenessPermissionObserver.LiveState` carries a
/// typed `InputMonitoringState` that defaults to `.unknown` (NOT `.granted`) on
/// macOS 14.4+ where `CGPreflightListenEventAccess` is deprecated, so the UI
/// never claims TCC truth it cannot verify. Accessibility continues to flow
/// through `AXIsProcessTrusted` via the same observer.
@MainActor
final class P19_1AccessibilityInputMonitoringStateTests: XCTestCase {

    func testLiveStateExposesInputMonitoringStateUnknownByDefault() {
        // P19.1 §1 — do not fabricate the Input Monitoring state. Without an
        // observer query the field must default to `.unknown`, not `.granted`.
        let state = AwarenessPermissionObserver.LiveState(screenCaptureGranted: true,
                                                         accessibilityGranted: true)
        XCTAssertEqual(state.inputMonitoring, .unknown,
                     "P19.1 — default inputMonitoring must be .unknown so the UI never over-promises")
    }

    func testLiveStateCarriesExplicitInputMonitoringValue() {
        // When the host provides a real `CGPreflightListenEventAccess` result
        // (or a human-verified proof), the state must round-trip through.
        for input: AwarenessPermissionObserver.InputMonitoringState in [.unknown,
                                                                         .notDetermined,
                                                                         .granted,
                                                                         .humanVerified] {
            let state = AwarenessPermissionObserver.LiveState(screenCaptureGranted: false,
                                                             accessibilityGranted: false,
                                                             inputMonitoring: input)
            XCTAssertEqual(state.inputMonitoring, input)
        }
    }

    func testLiveStateEqualityIncludesInputMonitoring() {
        // Two LiveState values with the same screenCapture / accessibility but
        // different inputMonitoring must NOT be equal — otherwise the observer
        // would silently swallow Input Monitoring transitions.
        let lhs = AwarenessPermissionObserver.LiveState(screenCaptureGranted: true,
                                                        accessibilityGranted: true,
                                                        inputMonitoring: .granted)
        let rhs = AwarenessPermissionObserver.LiveState(screenCaptureGranted: true,
                                                        accessibilityGranted: true,
                                                        inputMonitoring: .unknown)
        XCTAssertNotEqual(lhs, rhs,
                          "LiveState equality must consider inputMonitoring so transitions fire objectWillChange")
    }

    func testInitPreservesInputMonitoringSeed() {
        // The optional initial-value init must accept an explicit
        // `initialInputMonitoring` so production wiring can seed `.granted`
        // after a real human test, instead of letting the observer poll downgrade
        // it on the next refresh.
        let observer = AwarenessPermissionObserver(initialScreenCaptureGranted: true,
                                                  initialAccessibilityGranted: true,
                                                  initialInputMonitoring: .humanVerified)
        XCTAssertEqual(observer.liveState.inputMonitoring, .humanVerified)
    }

    func testSystemPermissionQueryReturnsUnknownOnMacOS14_4() {
        // The system query must not lie about Input Monitoring on macOS 14.4+
        // where the API is deprecated. `.unknown` is the only honest answer.
        let query = AwarenessPermissionObserver.SystemPermissionQuery()
        let state = query.inputMonitoringPreflight()
        if #available(macOS 14.4, *) {
            XCTAssertEqual(state, .unknown,
                          "P19.1 §1 — SystemPermissionQuery must return .unknown on macOS 14.4+")
        } else {
            XCTAssertTrue([.granted, .notDetermined].contains(state),
                         "pre-14.4 system query must return either .granted or .notDetermined, got: \(state)")
        }
    }
}

/// P19.1 / P0-A — Onboarding view model permission surface.
///
/// The contract under test: the onboarding view model exposes live
/// accessibility + Input Monitoring state sourced from the observer (the ONLY
/// TCC truth source) and per-user workflow state (`explanationSeen`) sourced
/// from `OnboardingPersistence` (NOT from the observer). The two MUST NOT be
/// conflated.
@MainActor
final class P19_1OnboardingPermissionViewModelTests: XCTestCase {

    func testAccessibilityLiveGrantedReadsFromObserver() {
        let prefs = tempPrefs()
        let observer = AwarenessPermissionObserver(initialScreenCaptureGranted: false,
                                                  initialAccessibilityGranted: true,
                                                  initialInputMonitoring: .granted)
        let viewModel = OnboardingViewModel(persistence: tempPersistence(),
                                            providers: tempProviderStore(),
                                            preferences: prefs,
                                            permissionObserver: observer,
                                            initialState: OnboardingState(),
                                            reason: .firstLaunch)
        XCTAssertTrue(viewModel.accessibilityLiveGranted)
    }

    func testAccessibilityLiveGrantedDefaultsFalseWhenNoObserver() {
        // The onboarding view model must NOT crash or fabricate when the host
        // environment has no TCC observer (test harness, headless build).
        let prefs = tempPrefs()
        let viewModel = OnboardingViewModel(persistence: tempPersistence(),
                                            providers: tempProviderStore(),
                                            preferences: prefs,
                                            permissionObserver: nil,
                                            initialState: OnboardingState(),
                                            reason: .firstLaunch)
        XCTAssertFalse(viewModel.accessibilityLiveGranted,
                      "P19.1 §2 — without an observer the model must report false, not crash and not fabricate")
        XCTAssertEqual(viewModel.inputMonitoringLiveState, .unknown)
    }

    func testInputMonitoringLiveStateReadsFromObserver() {
        let prefs = tempPrefs()
        let observer = AwarenessPermissionObserver(initialScreenCaptureGranted: false,
                                                  initialAccessibilityGranted: false,
                                                  initialInputMonitoring: .humanVerified)
        let viewModel = OnboardingViewModel(persistence: tempPersistence(),
                                            providers: tempProviderStore(),
                                            preferences: prefs,
                                            permissionObserver: observer,
                                            initialState: OnboardingState(),
                                            reason: .firstLaunch)
        XCTAssertEqual(viewModel.inputMonitoringLiveState, .humanVerified)
    }

    func testExplanationSeenIsWorkflowStateNotTCCTruth() {
        // P19.1 §2 — workflow state (`explanationSeen`) and TCC truth
        // (`accessibilityLiveGranted`) MUST live in different fields. A user
        // may have seen the explanation without granting the permission, and
        // vice versa.
        let prefs = tempPrefs()
        let observer = AwarenessPermissionObserver(initialScreenCaptureGranted: false,
                                                  initialAccessibilityGranted: false,
                                                  initialInputMonitoring: .unknown)
        let viewModel = OnboardingViewModel(persistence: tempPersistence(),
                                            providers: tempProviderStore(),
                                            preferences: prefs,
                                            permissionObserver: observer,
                                            initialState: OnboardingState(),
                                            reason: .firstLaunch)
        XCTAssertFalse(viewModel.accessibilityExplanationSeen)
        XCTAssertFalse(viewModel.inputMonitoringExplanationSeen)
        viewModel.markAccessibilityExplanationSeen()
        XCTAssertTrue(viewModel.accessibilityExplanationSeen)
        XCTAssertFalse(viewModel.inputMonitoringExplanationSeen,
                      "P19.1 §2 — marking accessibility-seen must NOT auto-mark Input Monitoring-seen")
    }

    func testAccessibilityRestartRequiredIsFalse() {
        // P19.1 §3 — Accessibility is read lazily. We never need to relaunch
        // DeskPet to activate a newly granted Accessibility. The model must
        // therefore report `false`, and the onboarding view must NOT show a
        // restart UX (P19.1 §3: "If no restart is technically required, do
        // not show restart messaging.").
        let prefs = tempPrefs()
        let viewModel = OnboardingViewModel(persistence: tempPersistence(),
                                            providers: tempProviderStore(),
                                            preferences: prefs,
                                            initialState: OnboardingState(),
                                            reason: .firstLaunch)
        XCTAssertFalse(viewModel.accessibilityRestartRequired)
    }

    // MARK: - Helpers

    private func tempPersistence() -> OnboardingPersistence {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("p19_1_onboarding_tests_\(UUID().uuidString)",
                                    isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return OnboardingPersistence(applicationSupportRoot: dir)
    }

    private func tempProviderStore() -> ProviderStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("p19_1_providers_\(UUID().uuidString).json")
        return ProviderStore(fileURL: url)
    }

    private func tempPrefs() -> PreferencesModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("p19_1_prefs_\(UUID().uuidString).json")
        return PreferencesModel(fileURL: url)
    }
}

/// P19.1 / P0-A — HotKey capability contract.
///
/// Two distinct hotkey classes must be documented independently:
/// 1. PRIMARY_HOTKEY (⌥Space) — Carbon `RegisterEventHotKey`. Does NOT need
///    Input Monitoring, does NOT need Accessibility.
/// 2. SECONDARY_HOTKEY family (⌘+Opt+[A|N|P|R]) — `NSEvent.addGlobalMonitorForEvents`.
///    Background delivery MAY require Input Monitoring.
@MainActor
final class P19_1HotKeyCapabilityContractTests: XCTestCase {

    func testPrimaryHotKeyUsesCarbonRegisterEventHotKey() {
        // Carbon is the registered path for the floating-chat ⌥Space hotkey.
        // Source-text backstop: the registrar must call `RegisterEventHotKey`,
        // which is the documented API that does not require Input Monitoring.
        let source = Self.sourceOf("GlobalHotKeyRegistrar.swift")
        XCTAssertTrue(source.contains("RegisterEventHotKey"),
                     "P19.1 §12 — PRIMARY_HOTKEY must use Carbon RegisterEventHotKey")
    }

    func testPrimaryHotKeyRequiresNoAccessibility() {
        // Per the audit correction, Accessibility is consulted only by the
        // Awareness subsystem (frontmost app / window title), not by the
        // Carbon hotkey path. The Carbon hotkey must NOT touch `AXIsProcessTrusted`.
        let source = Self.sourceOf("GlobalHotKeyRegistrar.swift")
        XCTAssertFalse(source.contains("AXIsProcessTrusted"),
                      "P19.1 §3 — PRIMARY_HOTKEY must NOT depend on Accessibility")
    }

    func testSecondaryHotKeysUseGlobalEventMonitor() {
        // The secondary Cmd+Opt shortcut family is implemented via the global
        // NSEvent monitor in HotKeys.swift. This path may need Input Monitoring
        // for delivery when DeskPet is not frontmost.
        let source = Self.sourceOf("HotKeys.swift")
        XCTAssertTrue(source.contains("addGlobalMonitorForEvents"),
                     "P19.1 §12 — SECONDARY_HOTKEY family must use NSEvent.addGlobalMonitorForEvents")
    }

    func testHotKeysDocClarifiesCarbonDoesNotNeedInputMonitoring() {
        // The existing doc comment is the user-visible truth source: confirm
        // it's still there so a future refactor cannot silently regress to
        // "all hotkeys need Input Monitoring".
        let source = Self.sourceOf("HotKeys.swift")
        XCTAssertTrue(source.contains("global monitor needs"),
                     "P19.1 §12 — HotKeys.swift must continue to document that the global monitor is what needs Input Monitoring")
        XCTAssertTrue(source.contains("Input Monitoring"),
                     "P19.1 §12 — the doc must mention Input Monitoring so a future reader sees the dependency contract")
        XCTAssertTrue(source.contains("menu bar still provides every action"),
                     "P19.1 §4 — copy must mention the fallback (menu bar) so users understand the app is usable without Input Monitoring")
    }

    private static func sourceOf(_ leaf: String) -> String {
        let url = URL(fileURLWithPath: "\(p19PermissionRepositoryRoot)/Sources/DeskPet/Input/\(leaf)")
        return (try? String(contentsOf: url)) ?? ""
    }
}
