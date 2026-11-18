import XCTest
@testable import DeskPet

final class FloatingChatPanelPlacementTests: XCTestCase {
    func testDefaultFrameUsesBottomTrailingAnchor() {
        let placement = FloatingChatPanelPlacement(
            visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            screenMargin: 112,
            bottomOffset: 128)

        let frame = placement.frame(size: CGSize(width: 260, height: 46), anchor: nil)

        XCTAssertEqual(frame.origin.x, 1068)
        XCTAssertEqual(frame.origin.y, 128)
        XCTAssertEqual(frame.maxX, 1328)
    }

    func testSameAnchorKeepsRightEdgeAcrossCapsuleAndExpanded() {
        let placement = FloatingChatPanelPlacement(
            visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            screenMargin: 112,
            bottomOffset: 128)
        let anchor = CGPoint(x: 900, y: 180)

        let capsule = placement.frame(size: CGSize(width: 260, height: 46), anchor: anchor)
        let expanded = placement.frame(size: CGSize(width: 420, height: 520), anchor: anchor)

        XCTAssertEqual(capsule.maxX, expanded.maxX)
        XCTAssertEqual(capsule.minY, expanded.minY)
    }

    func testDraggingDownConvertsSwiftUITranslationToLowerAppKitY() {
        let placement = FloatingChatPanelPlacement(
            visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 900),
            screenMargin: 112,
            bottomOffset: 128)

        let anchor = placement.translatedAnchor(
            from: CGPoint(x: 900, y: 180),
            translation: CGSize(width: 32, height: 24))

        XCTAssertEqual(anchor.x, 932)
        XCTAssertEqual(anchor.y, 156)
    }

    func testFrameClampsInsideVisibleFrame() {
        let placement = FloatingChatPanelPlacement(
            visibleFrame: CGRect(x: 100, y: 50, width: 500, height: 400),
            screenMargin: 40,
            bottomOffset: 80,
            edgePadding: 8)

        let frame = placement.frame(
            size: CGSize(width: 260, height: 120),
            anchor: CGPoint(x: 10_000, y: -10_000))

        XCTAssertEqual(frame.maxX, 592)
        XCTAssertEqual(frame.minY, 58)
    }
}
