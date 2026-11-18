import XCTest
import CoreGraphics
@testable import DeskPet

final class DesktopEntityLayoutTests: XCTestCase {
    private let frame = CGRect(x: 0, y: 0, width: 800, height: 600)

    private var layout: DesktopEntityLayoutController {
        DesktopEntityLayoutController(petVisualSize: CGSize(width: 80, height: 120),
                                      nestSize: CGSize(width: 132, height: 76))
    }

    func testPetClampKeepsFeetInsideVisibleFrame() {
        let clamped = layout.screenChanged(
            current: DesktopEntityLayoutState(petFeet: CGPoint(x: -500, y: -500),
                                             nestAnchor: CGPoint(x: 80, y: 40),
                                             homeTarget: .zero),
            visibleFrames: [frame])

        XCTAssertGreaterThanOrEqual(clamped.petFeet.x, 52)
        XCTAssertGreaterThanOrEqual(clamped.petFeet.y, ScreenGeometry.dockPadding)
    }

    func testNestClampKeepsNestInsideVisibleFrame() {
        let anchor = layout.clampNestAnchor(CGPoint(x: 900, y: 900), visibleFrames: [frame])

        XCTAssertLessThanOrEqual(anchor.x, frame.maxX - ScreenGeometry.edgePadding - 66)
        XCTAssertLessThanOrEqual(anchor.y, frame.maxY - ScreenGeometry.menuBarPadding - 76)
    }

    func testDraggingPetDoesNotMoveNest() {
        let initial = layout.defaultState(visibleFrames: [frame])
        let dragged = layout.draggingPet(to: CGPoint(x: 700, y: 80),
                                         current: initial,
                                         visibleFrames: [frame])

        XCTAssertNotEqual(dragged.petFeet, initial.petFeet)
        XCTAssertEqual(dragged.nestAnchor, initial.nestAnchor)
    }

    func testScreenVisibleFrameChangeClampsPetAndNestIndependently() {
        let initial = DesktopEntityLayoutState(petFeet: CGPoint(x: 760, y: 500),
                                               nestAnchor: CGPoint(x: 760, y: 500),
                                               homeTarget: .zero)
        let smaller = CGRect(x: 0, y: 0, width: 420, height: 320)

        let changed = layout.screenChanged(current: initial, visibleFrames: [smaller])

        XCTAssertLessThanOrEqual(changed.petFeet.x, smaller.maxX - ScreenGeometry.edgePadding - 40)
        XCTAssertLessThanOrEqual(changed.nestAnchor.x, smaller.maxX - ScreenGeometry.edgePadding - 66)
        XCTAssertEqual(changed.homeTarget.y, ScreenGeometry.dockPadding)
    }
}
