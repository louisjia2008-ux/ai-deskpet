import XCTest
@testable import DeskPet

/// P17 / Step 2 — pointer-inside pauses auto-collapse for the floating chat panel.
/// Mirrors the pattern in `FloatingChatStateStoreTests` so the behavior stays injectable
/// via the `now:` parameter.
@MainActor
final class P17FloatingChatPolicyTests: XCTestCase {
    func testPointerInsidePausesAutoCollapse() {
        let store = FloatingChatStateStore(visibilityState: .expanded,
                                           isResponding: false,
                                           modelBadge: "Auto",
                                           draft: "",
                                           inactivityTimeout: 1.0)
        // Expand at t0
        let t0 = Date()
        store.expand(now: t0)
        // Pointer enters at t0 + 0.5s
        store.setPointerInside(true, now: t0.addingTimeInterval(0.5))
        // Even after the inactivity timeout elapses, collapse must not fire.
        XCTAssertFalse(store.collapseIfInactive(now: t0.addingTimeInterval(2.0)))
        XCTAssertEqual(store.visibilityState, .expanded)
    }

    func testPointerLeavingResumesAutoCollapse() {
        let store = FloatingChatStateStore(visibilityState: .expanded,
                                           isResponding: false,
                                           modelBadge: "Auto",
                                           draft: "",
                                           inactivityTimeout: 1.0)
        let t0 = Date()
        store.expand(now: t0)
        store.setPointerInside(true, now: t0)
        store.setPointerInside(false, now: t0.addingTimeInterval(0.2))
        // After inactivity timeout, collapse fires.
        XCTAssertTrue(store.collapseIfInactive(now: t0.addingTimeInterval(1.5)))
        XCTAssertEqual(store.visibilityState, .capsuleIdle)
    }

    func testDraftKeepsPanelExpandedEvenAfterTimeout() {
        let store = FloatingChatStateStore(visibilityState: .expanded,
                                           isResponding: false,
                                           modelBadge: "Auto",
                                           draft: "你好",
                                           inactivityTimeout: 1.0)
        let t0 = Date()
        store.expand(now: t0)
        XCTAssertFalse(store.collapseIfInactive(now: t0.addingTimeInterval(5.0)))
        XCTAssertEqual(store.visibilityState, .expanded)
    }
}
