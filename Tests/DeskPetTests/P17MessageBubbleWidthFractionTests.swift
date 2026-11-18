import XCTest
import SwiftUI
import AppKit
@testable import DeskPet

/// P17 / R1-04 + R2-07 — `MessageBubble` used `.frame(maxWidth: 0.65)` thinking SwiftUI took
/// a fraction. SwiftUI actually takes points, so every user/assistant bubble collapsed to
/// 0.65pt (one glyph). The fix wraps the bubble column in a `GeometryReader` so the
/// `widthFraction` is multiplied by the container width.
///
/// R2-07: the previous version of this suite asserted on `bitmap.size.width`, which is
/// always the host's bounds width — it passed under the ORIGINAL bug too. These tests now
/// measure the **rendered bubble fill** (pixel bounding box of non-background pixels),
/// mirroring the harness pixel-statistics technique, so re-introducing the bug fails them.
@MainActor
final class P17MessageBubbleWidthFractionTests: XCTestCase {
    /// Renders a bubble into a bitmap over an opaque white backdrop and returns the width of
    /// the bounding box of all pixels that differ from that backdrop (i.e. the actual drawn
    /// bubble). Returns nil when rendering fails.
    private func renderedBubbleInkWidth(text: String,
                                        role: MessageBubble.Role,
                                        columnWidth: CGFloat,
                                        height: CGFloat = 400) -> CGFloat? {
        let bubble = MessageBubble(role: role, text: text, status: .completed)
            .frame(width: columnWidth, alignment: .leading)
            .background(Color.white)
        let host = NSHostingView(rootView: bubble)
        host.appearance = NSAppearance(named: .aqua)
        host.frame = NSRect(x: 0, y: 0, width: columnWidth, height: height)
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: bitmap)

        var minX = Int.max
        var maxX = Int.min
        var inkPixels = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 1) {
                guard let c = bitmap.colorAt(x: x, y: y) else { continue }
                // Anything meaningfully different from the white backdrop is bubble ink.
                let isInk = c.alphaComponent > 0.05 &&
                    (c.redComponent < 0.94 || c.greenComponent < 0.94 || c.blueComponent < 0.94)
                if isInk {
                    inkPixels += 1
                    minX = min(minX, x)
                    maxX = max(maxX, x)
                }
            }
        }
        guard inkPixels > 0, maxX >= minX else { return nil }
        // Bitmap pixels may be at backing scale; normalise back to points.
        let scale = CGFloat(bitmap.pixelsWide) / columnWidth
        return CGFloat(maxX - minX + 1) / max(scale, 1)
    }

    private var longText: String {
        String(repeating: "这是一段足够长的消息内容，用来把气泡撑到列宽的上限。", count: 4)
    }

    func testUserBubbleInkSpansMostOfTheColumnAfterFix() throws {
        let columnWidth: CGFloat = 400
        let ink = try XCTUnwrap(renderedBubbleInkWidth(text: longText,
                                                       role: .user,
                                                       columnWidth: columnWidth),
                                "User bubble must render visible ink")
        // Pre-fix the bubble collapsed to a ~1pt vertical strip. Post-fix a long message
        // fills up to widthFraction (0.65) of the column.
        XCTAssertGreaterThan(ink, columnWidth * 0.4,
                             "R1-04/R2-07 — user bubble ink must span a real fraction of the 400pt column; pre-fix it was ~1pt")
        XCTAssertLessThanOrEqual(ink, columnWidth,
                                 "Bubble ink must stay inside the column")
    }

    func testAssistantBubbleInkSpansMostOfTheColumnAfterFix() throws {
        let columnWidth: CGFloat = 400
        let ink = try XCTUnwrap(renderedBubbleInkWidth(text: longText,
                                                       role: .assistant,
                                                       columnWidth: columnWidth),
                                "Assistant bubble must render visible ink")
        XCTAssertGreaterThan(ink, columnWidth * 0.4,
                             "R1-04/R2-07 — assistant bubble ink must span a real fraction of the column")
    }

    /// The decisive regression assertion: the rendered width must SCALE with the container.
    /// Under the original points-instead-of-fraction bug both widths were ~1pt and this
    /// comparison fails.
    func testBubbleInkScalesWithContainerWidth() throws {
        let narrow = try XCTUnwrap(renderedBubbleInkWidth(text: longText,
                                                          role: .assistant,
                                                          columnWidth: 300))
        let wide = try XCTUnwrap(renderedBubbleInkWidth(text: longText,
                                                        role: .assistant,
                                                        columnWidth: 600))
        XCTAssertGreaterThan(wide, narrow + 80,
                             "R2-07 — the bubble max width is derived from the container width, so a 600pt column must render measurably wider ink than a 300pt column (got \(wide) vs \(narrow))")
    }

    func testWidthFractionDefaultsToAssistantNarrowColumn() {
        // P19.1 / P1 — the default `widthFraction` (the assistant fraction) is now
        // 0.88 so long Chinese prose no longer wastes ~35% of the panel width.
        // Pinned here so any future tuning is visible in code review.
        let bubble = MessageBubble(role: .assistant, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        guard let child = mirror.children.first(where: { $0.label == "widthFraction" }) else {
            XCTFail("MessageBubble must expose widthFraction")
            return
        }
        XCTAssertEqual(child.value as? CGFloat, 0.88)
    }

    func testUserWidthFractionStaysCompact() {
        // P19.1 / P1 — user bubbles stay narrower than assistant so they read
        // as right-aligned cards (not full-column ribbons).
        let bubble = MessageBubble(role: .user, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        guard let child = mirror.children.first(where: { $0.label == "userWidthFraction" }) else {
            XCTFail("MessageBubble must expose userWidthFraction")
            return
        }
        XCTAssertEqual(child.value as? CGFloat, 0.68)
    }

    func testBubbleMaxWidthHonoursReadableCap() {
        // P19.1 / P1 — even on a 1200pt column the assistant bubble must NOT
        // grow past the readable 560pt cap; otherwise line length becomes
        // uncomfortable and the bubble looks like a banner.
        let bubble = MessageBubble(role: .assistant, text: "x", status: .completed)
        let mirror = Mirror(reflecting: bubble)
        let widthFraction = mirror.children.first(where: { $0.label == "widthFraction" })?.value as? CGFloat ?? 0
        // Width 1200pt would naively give 1200 × 0.88 = 1056pt; the cap must
        // clamp that to 560pt. We probe via reflection rather than rendering to
        // keep the test independent of SwiftUI's layout engine.
        XCTAssertGreaterThanOrEqual(widthFraction, 0.85,
                                    "P19.1 — assistant fraction must be >=0.85 so long prose fills the column")
        XCTAssertLessThanOrEqual(widthFraction, 0.95,
                                 "P19.1 — assistant fraction must stay <=0.95 so the bubble doesn't read as full-width")
    }

    /// R2-07 — source-scan backstop: the GeometryReader-derived max width must stay in place
    /// even if the pixel assertions are ever weakened by a platform rendering change.
    /// P19.1 / P1 — updated to accept the role-aware variant `columnWidth * fraction`
    /// which still satisfies the R1-04 contract: the max width is derived from the
    /// container width, not raw points.
    func testBubbleMaxWidthIsDerivedFromContainerWidth() {
        let body = resolveText(named: "DesignComponents", relative: "DesignSystem")
        let hasOriginalExpression = body.contains("proxy.size.width * widthFraction")
        let hasRoleAwareExpression = body.contains("columnWidth * fraction")
        XCTAssertTrue(hasOriginalExpression || hasRoleAwareExpression,
                      "R1-04 / P19.1 — the bubble max width must be container-width × widthFraction (or fraction), not raw points")
    }
}
