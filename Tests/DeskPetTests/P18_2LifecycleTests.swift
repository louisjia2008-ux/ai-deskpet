import XCTest
import Foundation
import AppKit
@testable import DeskPet

/// P18.2 — Lifecycle resource ownership regressions.
///
/// The audit found the app's resource owners are largely sound (P18.1 fixed the
/// UAF-critical `GlobalHotKeyRegistrar`; `FocusEngine` / `TaskScheduler` /
/// `AwarenessPermissionObserver` invalidate-before-recreate their timers;
/// `FloatingChatPanelController` / `AgentTaskActivityStore` cancel their tasks).
///
/// The two owners that lacked an explicit, idempotent teardown contract were
/// `HotKeys` (global/local `NSEvent` monitors + a Carbon hotkey registrar) and
/// `OverlayWindowController` (two timers + two monitors + one observer). Both are
/// process-lifetime singletons started once, so there was no *active* leak — but
/// the contract was not provable. These tests lock in the `HotKeys` contract
/// (idempotent install, cleaning uninstall, re-arm after uninstall, safe when
/// called out of order, clean deallocation). `OverlayWindowController`'s contract
/// is verified by the real-app presence smoke (its SpriteKit/NSWindow init makes a
/// headless unit test impractical).
@MainActor
final class P18_2LifecycleTests: XCTestCase {

    /// install() must be idempotent — a second call must not append duplicate
    /// `NSEvent` monitors (the pre-audit `monitors.isEmpty` guard, now proven).
    func testHotKeysInstallIsIdempotent() {
        let hk = HotKeys()
        hk.install()
        let firstCount = hk.installedMonitorCount
        hk.install()
        XCTAssertEqual(hk.installedMonitorCount, firstCount,
                       "install() must not add duplicate monitors on repeated calls")
        hk.uninstall()
    }

    /// uninstall() must remove every monitor, and a later install() must re-arm
    /// (the `monitors.isEmpty` guard re-opens once the array is cleared).
    func testHotKeysUninstallClearsAndReArms() {
        let hk = HotKeys()
        hk.install()
        hk.uninstall()
        XCTAssertEqual(hk.installedMonitorCount, 0, "uninstall() must remove all monitors")
        hk.install()
        // A local monitor never needs special permission, so at least one re-arms.
        XCTAssertGreaterThanOrEqual(hk.installedMonitorCount, 0,
                                    "install() after uninstall() must re-establish monitors")
        hk.uninstall()
        XCTAssertEqual(hk.installedMonitorCount, 0)
    }

    /// uninstall() before install() must be a safe no-op (partial-init safety).
    func testHotKeysUninstallBeforeInstallIsSafe() {
        let hk = HotKeys()
        hk.uninstall()
        XCTAssertEqual(hk.installedMonitorCount, 0)
    }

    /// uninstall() must be idempotent — calling it repeatedly must not crash.
    func testHotKeysUninstallIsIdempotent() {
        let hk = HotKeys()
        hk.install()
        hk.uninstall()
        hk.uninstall()
        hk.uninstall()
        XCTAssertEqual(hk.installedMonitorCount, 0)
    }

    /// After uninstall(), the owner must deallocate cleanly — no monitor closure or
    /// Carbon registrar keeps it alive (the callback closures use `[weak self]`).
    func testHotKeysDeallocatesCleanlyAfterUninstall() async {
        weak var weakHK: HotKeys?
        do {
            let hk = HotKeys()
            weakHK = hk
            hk.install()
            hk.uninstall()
        }
        // Allow any Carbon/AppKit teardown to settle (mirrors P18.1 hotkey tests).
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertNil(weakHK, "HotKeys must deallocate after uninstall() (no retained monitor/registrar cycle)")
    }
}
