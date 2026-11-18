import XCTest
import CoreGraphics
@testable import DeskPet

final class PerchSolverTests: XCTestCase {

    private let floor = Surface(y: 0, xRange: 0...1000, kind: .screenBottom, id: "screen-bottom-0")
    private let win = Surface(y: 400, xRange: 200...600, kind: .windowTop, id: "win-1")

    func testLandsOnWindowTopWhenAboveIt() {
        // Dropped just above the window top, within its span → perch on the window.
        let s = PerchSolver.landingSurface(at: CGPoint(x: 300, y: 410),
                                           candidates: [floor, win])
        XCTAssertEqual(s?.id, "win-1")
    }

    func testFallsToFloorOutsideWindowSpan() {
        let s = PerchSolver.landingSurface(at: CGPoint(x: 800, y: 410),
                                           candidates: [floor, win])
        XCTAssertEqual(s?.id, "screen-bottom-0")
    }

    func testIgnoresSurfacesAboveTheFeet() {
        // Feet below the window top → window is not a valid landing surface.
        let s = PerchSolver.landingSurface(at: CGPoint(x: 300, y: 100),
                                           candidates: [floor, win])
        XCTAssertEqual(s?.id, "screen-bottom-0")
    }

    func testFallbackPicksContainingFloor() {
        let other = Surface(y: 0, xRange: 1000...2000, kind: .screenBottom, id: "screen-bottom-1")
        let s = PerchSolver.fallbackSurface(near: 1500, candidates: [floor, other, win])
        XCTAssertEqual(s?.id, "screen-bottom-1")
    }

    func testSurfaceValidityDetectsDisappearance() {
        XCTAssertTrue(PerchSolver.surfaceStillValid(win, in: [floor, win]))
        XCTAssertFalse(PerchSolver.surfaceStillValid(win, in: [floor]))
    }
}

final class ScreenGeometryTests: XCTestCase {

    func testClampSnapsIntoNearestScreen() {
        let screen = CGRect(x: 0, y: 0, width: 800, height: 600)
        let p = ScreenGeometry.clamp(CGPoint(x: 1200, y: 300), into: [screen])
        XCTAssertEqual(p.x, 800, accuracy: 0.001)
        XCTAssertEqual(p.y, 300, accuracy: 0.001)
    }

    func testClampLeavesInsidePointUntouched() {
        let screen = CGRect(x: 0, y: 0, width: 800, height: 600)
        let p = ScreenGeometry.clamp(CGPoint(x: 400, y: 300), into: [screen])
        XCTAssertEqual(p, CGPoint(x: 400, y: 300))
    }

    func testUnionCoversAllScreens() {
        let a = CGRect(x: 0, y: 0, width: 800, height: 600)
        let b = CGRect(x: 800, y: 0, width: 1000, height: 600)
        XCTAssertEqual(ScreenGeometry.union([a, b]), CGRect(x: 0, y: 0, width: 1800, height: 600))
    }

    func testClampFeetUsesVisibleFramePadding() {
        let visible = CGRect(x: 0, y: 24, width: 800, height: 540)
        let visual = CGSize(width: 88, height: 132)
        let p = ScreenGeometry.clampFeet(CGPoint(x: -20, y: 0), visualSize: visual, into: [visible])
        XCTAssertEqual(p.x, visible.minX + ScreenGeometry.edgePadding + visual.width / 2, accuracy: 0.001)
        XCTAssertEqual(p.y, visible.minY + ScreenGeometry.dockPadding, accuracy: 0.001)
    }

    func testClampFeetKeepsCharacterBelowMenuBar() {
        let visible = CGRect(x: 0, y: 24, width: 800, height: 540)
        let visual = CGSize(width: 88, height: 132)
        let p = ScreenGeometry.clampFeet(CGPoint(x: 400, y: 900), visualSize: visual, into: [visible])
        XCTAssertLessThanOrEqual(p.y + visual.height, visible.maxY - ScreenGeometry.menuBarPadding + 0.001)
    }

    func testClampFeetFallsBackToNearestVisibleScreen() {
        let left = CGRect(x: 0, y: 24, width: 800, height: 540)
        let right = CGRect(x: 900, y: 20, width: 700, height: 500)
        let visual = CGSize(width: 88, height: 132)
        let p = ScreenGeometry.clampFeet(CGPoint(x: 850, y: 250), visualSize: visual, into: [left, right])
        XCTAssertGreaterThanOrEqual(p.x, left.minX + ScreenGeometry.edgePadding + visual.width / 2)
        XCTAssertLessThanOrEqual(p.x, left.maxX - ScreenGeometry.edgePadding - visual.width / 2)
    }

    func testOverlayFrameStaysInsideVisibleFrame() {
        let visible = CGRect(x: 0, y: 24, width: 800, height: 540)
        let visual = CGSize(width: 88, height: 132)
        let content = PetOverlayWindowMetrics.contentSize(for: visual)
        let feet = ScreenGeometry.clampFeet(CGPoint(x: 12, y: 24), visualSize: visual, into: [visible])
        let frame = ScreenGeometry.overlayFrame(forFeet: feet,
                                                visualSize: visual,
                                                contentSize: content,
                                                feetInset: PetOverlayWindowMetrics.feetInset(for: content),
                                                visibleFrames: [visible])
        XCTAssertGreaterThanOrEqual(frame.minX, visible.minX + ScreenGeometry.edgePadding)
        XCTAssertGreaterThanOrEqual(frame.minY, visible.minY + ScreenGeometry.dockPadding)
        XCTAssertLessThanOrEqual(frame.maxX, visible.maxX - ScreenGeometry.edgePadding)
        XCTAssertLessThanOrEqual(frame.maxY, visible.maxY - ScreenGeometry.menuBarPadding)
    }


}

final class PetScaleControllerTests: XCTestCase {
    func testDefaultIdleHeightIsCanonicalPointSize() {
        let controller = PetScaleController()
        let size = controller.visualSize(for: CGSize(width: 1024, height: 1536))
        XCTAssertEqual(size.height, PetScaleController.defaultIdleHeightPt, accuracy: 0.001)
        XCTAssertEqual(size.width, 88, accuracy: 0.001)
    }

    func testIdleHeightIsClamped() {
        XCTAssertEqual(PetScaleController(preferredIdleHeightPt: 20)
            .visualSize(for: CGSize(width: 160, height: 240)).height,
                       PetScaleController.minIdleHeightPt,
                       accuracy: 0.001)
        XCTAssertEqual(PetScaleController(preferredIdleHeightPt: 500)
            .visualSize(for: CGSize(width: 160, height: 240)).height,
                       PetScaleController.maxIdleHeightPt,
                       accuracy: 0.001)
    }

    func testInteractionHeightAllowsLargerButStillClamps() {
        let controller = PetScaleController(preferredIdleHeightPt: 500)
        XCTAssertEqual(controller.visualSize(for: CGSize(width: 160, height: 240), mode: .interaction).height,
                       PetScaleController.maxInteractionHeightPt,
                       accuracy: 0.001)
    }
}
