import XCTest
import SwiftUI
@testable import DeskPet

final class P5_1DesignSystemTests: XCTestCase {

    func testLightAndDarkTokensDiffer() {
        for token in DSColorToken.allCases {
            let light = DSPalette.rgba(token, scheme: .light)
            let dark = DSPalette.rgba(token, scheme: .dark)
            XCTAssertNotEqual(light, dark, "token \(token) should differ between light/dark")
        }
    }

    func testBackgroundIsNotPureWhiteOrPureBlack() {
        let light = DSPalette.rgba(.appBackground, scheme: .light)
        let dark = DSPalette.rgba(.appBackground, scheme: .dark)
        XCTAssertLessThan(light.r, 1.0)            // not pure white
        XCTAssertGreaterThan(dark.r, 0.0)          // not pure black (keeps cool tone)
    }

    func testIncreaseContrastStrengthensText() {
        let normal = DSPalette.rgba(.textPrimary, scheme: .light)
        let boosted = DSPalette.rgba(.textPrimary, scheme: .light, increaseContrast: true)
        XCTAssertNotEqual(normal, boosted)
        XCTAssertLessThanOrEqual(boosted.r, normal.r)   // darker text on light bg
    }

    func testReduceTransparencyRaisesGlassAlpha() {
        let base = DSPalette.resolved(.glassSurface, scheme: .dark, reduceTransparency: false)
        let reduced = DSPalette.resolved(.glassSurface, scheme: .dark, reduceTransparency: true)
        XCTAssertLessThan(base.a, 1.0)
        XCTAssertGreaterThan(reduced.a, base.a)     // fallback toward solid for readability
    }

    func testReduceTransparencyDoesNotAlterOpaqueTokens() {
        let base = DSPalette.resolved(.elevatedSurface, scheme: .light, reduceTransparency: false)
        let reduced = DSPalette.resolved(.elevatedSurface, scheme: .light, reduceTransparency: true)
        XCTAssertEqual(base, reduced)               // already opaque → unchanged
    }

    func testMotionTokensHaveReduceMotionFallback() {
        // Reduce Motion path must resolve to a (shorter, non-spring) animation, not crash.
        _ = DSMotion.content(true)
        _ = DSMotion.emphasized(true)
        _ = DSMotion.quick(true)
        XCTAssertLessThan(DSMotion.quick, DSMotion.standard)
        XCTAssertLessThan(DSMotion.standard, DSMotion.completion)
    }

    func testWindowModeSizesAreOrdered() {
        XCTAssertLessThan(WindowMode.mini.size.height, WindowMode.compact.size.height)
        XCTAssertLessThan(WindowMode.compact.size.height, WindowMode.expanded.size.height)
        for mode in WindowMode.allCases {
            XCTAssertGreaterThanOrEqual(mode.size.width, mode.minSize.width)
            XCTAssertGreaterThanOrEqual(mode.size.height, mode.minSize.height)
        }
    }

    func testWindowModeRoundTrips() {
        for mode in WindowMode.allCases {
            XCTAssertEqual(WindowMode(rawValue: mode.rawValue), mode)
        }
    }

    func testConsoleSidebarLeavesMinimumContentWidth() {
        let remaining = CompanionConsoleWindowMetrics.minWidth - CompanionConsoleWindowMetrics.sidebarWidth
        XCTAssertGreaterThanOrEqual(remaining, CompanionConsoleWindowMetrics.contentMinWidth)
        XCTAssertGreaterThan(CompanionConsoleWindowMetrics.sidebarWidth, 140)
    }

    func testControlPanelRadiiStayMacLike() {
        // P17 — design spec: small=6, regular=10, large=16; nothing exceeds 16 except capsules.
        XCTAssertEqual(DSRadius.control, 6)
        XCTAssertEqual(DSRadius.card, 10)
        XCTAssertEqual(DSRadius.panel, 16)
        XCTAssertEqual(DSRadius.small, DSRadius.control)
        XCTAssertEqual(DSRadius.regular, DSRadius.card)
        XCTAssertEqual(DSRadius.large, DSRadius.panel)
        XCTAssertLessThan(DSRadius.control, DSRadius.card)
        XCTAssertLessThan(DSRadius.card, DSRadius.panel)
    }
}
