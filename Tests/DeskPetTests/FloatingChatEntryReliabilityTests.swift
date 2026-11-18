import AppKit
import Carbon.HIToolbox
import XCTest
@testable import DeskPet

final class FloatingChatEntryReliabilityTests: XCTestCase {
    func testOptionSpaceHotKeyMatchesOnlyOptionSpace() {
        let hotKey = GlobalHotKey.floatingChatOptionSpace

        XCTAssertTrue(hotKey.matches(eventKeyCode: UInt16(kVK_Space),
                                     modifierFlags: [.option]))
        XCTAssertFalse(hotKey.matches(eventKeyCode: UInt16(kVK_Space),
                                      modifierFlags: [.command, .option]))
        XCTAssertFalse(hotKey.matches(eventKeyCode: 0,
                                      modifierFlags: [.option]))
    }

    func testPetClickTrackerAcceptsShortSmallMovementClick() {
        let tracker = PetClickGestureTracker(
            downGlobal: CGPoint(x: 100, y: 100),
            startedAt: 10)

        XCTAssertTrue(tracker.isClick(upGlobal: CGPoint(x: 103, y: 104),
                                      endedAt: 10.2))
    }

    func testPetClickTrackerRejectsDragMovement() {
        var tracker = PetClickGestureTracker(
            downGlobal: CGPoint(x: 100, y: 100),
            startedAt: 10)

        tracker.recordDrag(to: CGPoint(x: 120, y: 100))

        XCTAssertFalse(tracker.isClick(upGlobal: CGPoint(x: 100, y: 100),
                                       endedAt: 10.2))
    }

    func testPetClickTrackerRejectsLongPress() {
        let tracker = PetClickGestureTracker(
            downGlobal: CGPoint(x: 100, y: 100),
            startedAt: 10)

        XCTAssertFalse(tracker.isClick(upGlobal: CGPoint(x: 100, y: 100),
                                       endedAt: 11.0))
    }
}
