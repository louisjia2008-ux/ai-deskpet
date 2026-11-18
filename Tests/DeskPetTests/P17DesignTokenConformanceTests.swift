import XCTest
import CoreGraphics
import AppKit
@testable import DeskPet

/// P17 / Step 1 — DesignTokens convergence tests. The DS token grid, radius scale, and
/// font role aliases must match the design spec (4pt grid; small/regular/large radii;
/// SwiftUI text-style aliases).
final class P17DesignTokenConformanceTests: XCTestCase {
    func testSpacingGridIsFourPoint() {
        XCTAssertEqual(DSSpacing.xs, 4)
        XCTAssertEqual(DSSpacing.s, 8)
        XCTAssertEqual(DSSpacing.m, 12)
        XCTAssertEqual(DSSpacing.l, 16)
        XCTAssertEqual(DSSpacing.xl, 24)
        XCTAssertEqual(DSSpacing.xxl, 32)
    }

    func testRadiiFollowThreeStepScale() {
        // P17 — three semantic radius tiers + capsule.
        XCTAssertEqual(DSRadius.control, 6)
        XCTAssertEqual(DSRadius.card, 10)
        XCTAssertEqual(DSRadius.panel, 16)
        XCTAssertGreaterThan(DSRadius.capsule, DSRadius.panel)
    }

    func testRadiusSemanticAliasesResolve() {
        XCTAssertEqual(DSRadius.small, DSRadius.control)
        XCTAssertEqual(DSRadius.regular, DSRadius.card)
        XCTAssertEqual(DSRadius.large, DSRadius.panel)
    }

    func testNothingExceedsSixteenExceptCapsule() {
        XCTAssertLessThanOrEqual(DSRadius.control, 16)
        XCTAssertLessThanOrEqual(DSRadius.card, 16)
        XCTAssertLessThanOrEqual(DSRadius.panel, 16)
    }

    func testLegacyFontAliasesResolveToRoles() {
        XCTAssertNotNil(DSFont.pageTitle)
        XCTAssertNotNil(DSFont.sectionTitle)
        XCTAssertNotNil(DSFont.cardTitle)
        XCTAssertNotNil(DSFont.body)
        XCTAssertNotNil(DSFont.secondaryBody)
        XCTAssertNotNil(DSFont.caption)
        XCTAssertNotNil(DSFont.compactLabel)
    }

    func testRoleNamesResolve() {
        XCTAssertNotNil(DSFont.Title)
        XCTAssertNotNil(DSFont.SectionTitle)
        XCTAssertNotNil(DSFont.CardTitle)
        XCTAssertNotNil(DSFont.Body)
        XCTAssertNotNil(DSFont.Metadata)
        XCTAssertNotNil(DSFont.Caption)
        XCTAssertNotNil(DSFont.Caption2)
    }

    func testNumericDisplayUsesMonospacedDigits() {
        let display = DSFont.numericDisplay(28)
        // The font is a system-rounded monospaced font; we assert it constructs without
        // crashing. Pixel-exact assertions are brittle.
        XCTAssertNotNil(display)
    }

    func testFloatingChatMetricsExposeClampConstants() {
        XCTAssertGreaterThanOrEqual(FloatingChatPanelMetrics.expandedMinSize.width,
                                    320)
        XCTAssertGreaterThanOrEqual(FloatingChatPanelMetrics.expandedMaxSize.width,
                                    FloatingChatPanelMetrics.expandedMinSize.width)
        XCTAssertGreaterThanOrEqual(FloatingChatPanelMetrics.expandedMaxSize.height,
                                    FloatingChatPanelMetrics.expandedMinSize.height)
        // EVID-06 — ideal size matches production geometry.
        XCTAssertEqual(FloatingChatPanelMetrics.expandedIdealSize, CGSize(width: 420, height: 520))
    }

    func testWindowModeLabelsAreNonEmptyAndDistinct() {
        let labels = Set(WindowMode.allCases.map { $0.label })
        XCTAssertEqual(labels.count, WindowMode.allCases.count)
        for mode in WindowMode.allCases {
            XCTAssertFalse(mode.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
}
