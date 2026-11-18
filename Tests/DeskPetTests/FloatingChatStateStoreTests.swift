import XCTest
@testable import DeskPet

@MainActor
final class FloatingChatStateStoreTests: XCTestCase {
    func testInitialStateDefaultsToCapsuleIdle() {
        let now = Date(timeIntervalSince1970: 10)
        let store = FloatingChatStateStore(now: now)

        XCTAssertEqual(store.visibilityState, .capsuleIdle)
        XCTAssertEqual(store.modelBadge, "未配置 AI")
        XCTAssertFalse(store.isResponding)
        XCTAssertEqual(store.lastActivity, now)
    }

    func testToggleExpandedExpandsAndCollapses() {
        let now = Date(timeIntervalSince1970: 10)
        let store = FloatingChatStateStore(now: now)

        store.toggleExpanded(now: now.addingTimeInterval(1))
        XCTAssertEqual(store.visibilityState, .expanded)

        store.toggleExpanded(now: now.addingTimeInterval(2))
        XCTAssertEqual(store.visibilityState, .capsuleIdle)
    }

    func testExpandAndCollapseUpdateActivity() {
        let now = Date(timeIntervalSince1970: 10)
        let store = FloatingChatStateStore(now: now)

        let expandedAt = now.addingTimeInterval(5)
        store.expand(now: expandedAt)
        XCTAssertEqual(store.visibilityState, .expanded)
        XCTAssertEqual(store.lastActivity, expandedAt)

        let collapsedAt = now.addingTimeInterval(8)
        store.collapseToCapsule(now: collapsedAt)
        XCTAssertEqual(store.visibilityState, .capsuleIdle)
        XCTAssertEqual(store.lastActivity, collapsedAt)
    }

    func testInactivityCollapseOnlyWhenExpandedAndIdle() {
        let now = Date(timeIntervalSince1970: 10)
        let store = FloatingChatStateStore(inactivityTimeout: 3, now: now)

        store.expand(now: now)
        XCTAssertFalse(store.collapseIfInactive(now: now.addingTimeInterval(2.9)))
        XCTAssertEqual(store.visibilityState, .expanded)

        XCTAssertTrue(store.collapseIfInactive(now: now.addingTimeInterval(3)))
        XCTAssertEqual(store.visibilityState, .capsuleIdle)
    }

    func testInactivityDoesNotCollapseWhileResponding() {
        let now = Date(timeIntervalSince1970: 10)
        let store = FloatingChatStateStore(inactivityTimeout: 3, now: now)

        store.expand(now: now)
        store.isResponding = true

        XCTAssertFalse(store.collapseIfInactive(now: now.addingTimeInterval(30)))
        XCTAssertEqual(store.visibilityState, .expanded)
    }

    func testInactivityDoesNotCollapseWithDraftText() {
        let now = Date(timeIntervalSince1970: 10)
        let store = FloatingChatStateStore(inactivityTimeout: 3, now: now)

        store.expand(now: now)
        store.draft = "ping"

        XCTAssertFalse(store.collapseIfInactive(now: now.addingTimeInterval(30)))
        XCTAssertEqual(store.visibilityState, .expanded)
    }
}
