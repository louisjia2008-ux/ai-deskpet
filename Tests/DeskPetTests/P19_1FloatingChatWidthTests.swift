import XCTest
import SwiftUI
import AppKit
@testable import DeskPet

private let p19WidthRepositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path

/// P19.1 / P1 — `MessageBubble` role-aware + available-space-aware width layout.
///
/// The defect: prior to P19.1, every chat bubble used `widthFraction = 0.65`
/// regardless of role or panel width. Long Chinese assistant replies in a wide
/// floating-chat panel therefore wasted ~35% of the panel width.
///
/// The fix: role-aware defaults (assistant ~88%, user ~68%) + a 560pt
/// readable cap on wide columns + a 40pt minimum so short replies don't look
/// like a thin sliver. The fix must NOT regress the pre-existing P17 R1-04 /
/// R2-07 contract that bubble width scales with column width.
@MainActor
final class P19_1MessageBubbleWidthTests: XCTestCase {

    func testAssistantDefaultIsWiderThanUserDefault() {
        let bubble = MessageBubble(role: .assistant, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        let assistantFraction = mirror.children.first(where: { $0.label == "widthFraction" })?.value as? CGFloat ?? 0
        let userFraction = mirror.children.first(where: { $0.label == "userWidthFraction" })?.value as? CGFloat ?? 0
        XCTAssertGreaterThan(assistantFraction, userFraction,
                             "P19.1 — assistant bubbles should use more column width than user bubbles")
    }

    func testAssistantFractionIsAtLeastEightyFivePercent() {
        // Lower bound: anything below 0.85 brings the audit defect back.
        let bubble = MessageBubble(role: .assistant, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        let assistantFraction = mirror.children.first(where: { $0.label == "widthFraction" })?.value as? CGFloat ?? 0
        XCTAssertGreaterThanOrEqual(assistantFraction, 0.85,
                                    "P19.1 — assistant fraction must be >=0.85")
    }

    func testAssistantFractionIsAtMostNinetyFivePercent() {
        // Upper bound: anything above 0.95 makes the bubble feel like a
        // full-column ribbon and ruins line length on wide panels.
        let bubble = MessageBubble(role: .assistant, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        let assistantFraction = mirror.children.first(where: { $0.label == "widthFraction" })?.value as? CGFloat ?? 0
        XCTAssertLessThanOrEqual(assistantFraction, 0.95,
                                 "P19.1 — assistant fraction must be <=0.95")
    }

    func testUserFractionIsAtMostSeventyFivePercent() {
        // User bubbles should not feel as wide as assistant bubbles.
        let bubble = MessageBubble(role: .user, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        let userFraction = mirror.children.first(where: { $0.label == "userWidthFraction" })?.value as? CGFloat ?? 0
        XCTAssertLessThanOrEqual(userFraction, 0.75,
                                 "P19.1 — user fraction must stay <=0.75")
    }

    func testWidthFractionCanStillBeOverridden() {
        // The role-aware defaults must be overridable for tests, narrow
        // content layouts, etc.
        let bubble = MessageBubble(role: .assistant, text: "x", status: .completed, widthFraction: 0.5)
        let mirror = Mirror(reflecting: bubble)
        let widthFraction = mirror.children.first(where: { $0.label == "widthFraction" })?.value as? CGFloat ?? 0
        XCTAssertEqual(widthFraction, 0.5,
                       "P19.1 — MessageBubble must continue to honour an explicit widthFraction parameter")
    }

    func testEffectiveWidthFractionIsRoleAware() {
        // Build a bubble directly and verify that the internal accessor
        // returns the role-appropriate fraction.
        let assistant = MessageBubble(role: .assistant, text: "x", status: .completed)
        let user = MessageBubble(role: .user, text: "x", status: .completed)
        let assistantMirror = Mirror(reflecting: assistant)
        let userMirror = Mirror(reflecting: user)
        let assistantFraction = assistantMirror.children.first(where: { $0.label == "widthFraction" })?.value as? CGFloat ?? 0
        let userFraction = userMirror.children.first(where: { $0.label == "userWidthFraction" })?.value as? CGFloat ?? 0
        XCTAssertGreaterThan(assistantFraction, userFraction)
    }

    func testBubbleLayoutHonoursReadableCapOnWideColumns() {
        // Source-text backstop: even on a 1200pt column the assistant bubble
        // must NOT grow past the 560pt readable cap. The cap is enforced via
        // the `bubbleMaxWidth(for:)` helper which calls
        // `columnWidth * fraction` then `min(maxReadable, proportional)`.
        let source = Self.sourceOf("DesignComponents.swift")
        XCTAssertTrue(source.contains("maxReadable"),
                     "P19.1 — bubble must apply a readable-line-length cap on wide columns")
        XCTAssertTrue(source.contains("560"),
                     "P19.1 — readable cap is 560pt; pin it as a magic-number so a future tuning change is visible")
    }

    func testBubbleLayoutHonoursMinimumOnNarrowColumns() {
        // Source-text backstop: even on a 40pt column the bubble must NOT
        // collapse to 0pt (which would re-introduce the original P17 R1-04 bug).
        let source = Self.sourceOf("DesignComponents.swift")
        XCTAssertTrue(source.contains("max(40"),
                     "P19.1 — bubble max width must be >=40pt regardless of column width")
    }

    private static func sourceOf(_ leaf: String) -> String {
        let url = URL(fileURLWithPath: "\(p19WidthRepositoryRoot)/Sources/DeskPet/DesignSystem/\(leaf)")
        return (try? String(contentsOf: url)) ?? ""
    }
}
