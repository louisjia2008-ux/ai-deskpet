import XCTest
import SwiftUI
import AppKit
@testable import DeskPet

private let p195RepositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path

/// P19.5 / R-CHAT-OVERFLOW — chat layout contract regression suite.
///
/// The pre-fix defect: `MessageBubble` wrapped its body in a top-level
/// `GeometryReader`. Inside a `LazyVStack` inside a `ScrollView`, the
/// GeometryReader received an unbounded vertical proposal (the scroll content
/// must be free to grow tall) and reported its size back to the LazyVStack as
/// `(_, .infinity)`. The LazyVStack then stacked every `MessageBubble` at the
/// same y-coordinate (top of scroll content), producing the visible defect:
/// 8 messages crammed into the top ~240pt of the 420×520 panel with the long
/// reply's text overlapping subsequent user/assistant messages and ~210pt of
/// empty scroll area below.
///
/// The P19.5 fix: drop the per-bubble `GeometryReader` and instead inject the
/// measured column width into the SwiftUI environment via
/// `EnvironmentValues.chatColumnWidth`. The message area's GeometryReader now
/// lives in a bounded parent (the outer chat VStack → its frame chain), so the
/// column width is correctly known; MessageBubble itself reports its true
/// intrinsic content height back to the LazyVStack so messages stack at
/// distinct y-coordinates.
///
/// These tests pin the post-fix contract:
///   1. Bubble intrinsic height is content-driven (not unbounded)
///   2. Bubble max width is column-width-aware via the env value
///   3. The default column-width fallback is the readable cap (560pt)
///   4. Column-width injection works on both chat paths (FloatingChat + CompanionChat)
///   5. The full ChatExpandedView renders with all 8 seeded messages visible at
///      distinct y-coordinates and no overlap.
@MainActor
final class P19_5ChatLayoutContractTests: XCTestCase {

    // MARK: - Test 1: bubble intrinsic height is bounded (no GeometryReader)

    /// The pre-fix bubble body was a top-level GeometryReader. After the fix,
    /// the bubble body is a plain HStack. Source-text backstop to prevent
    /// regressing the GeometryReader back into MessageBubble.body.
    func testMessageBubbleBodyIsNotATopLevelGeometryReader() {
        let body = Self.source(of: "DesignComponents.swift", in: "DesignSystem")
        // Find the MessageBubble struct's body declaration.
        // P19.5 contract: the body MUST NOT start with `GeometryReader {`.
        let pattern = "struct MessageBubble: View {"
        guard let structRange = body.range(of: pattern) else {
            XCTFail("MessageBubble struct not found in DesignComponents.swift")
            return
        }
        let structBody = body[structRange.upperBound...]
        guard let bodyRange = structBody.range(of: "var body: some View {") else {
            XCTFail("MessageBubble body declaration not found")
            return
        }
        // Take the first ~600 chars after `var body: some View {` and confirm
        // it does not start with a GeometryReader.
        let afterBodyDecl = structBody[bodyRange.upperBound...]
        let probe = afterBodyDecl.prefix(600)
        let trimmedProbe = probe.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertFalse(trimmedProbe.hasPrefix("GeometryReader"),
                       "P19.5 — MessageBubble body MUST NOT be a top-level GeometryReader. The pre-fix GeometryReader reported unbounded height back to the LazyVStack, which broke the LazyVStack's vertical stacking (8 messages overlapped at y=0 with the long reply's text covering subsequent messages).")
    }

    // MARK: - Test 2: bubble resolves max width from chatColumnWidth env

    func testMessageBubbleReadsChatColumnWidthEnvironment() {
        // Source-text backstop: MessageBubble reads the chatColumnWidth env
        // value. Without this read, the bubble has no way to know the column
        // width after the GeometryReader was removed.
        let body = Self.source(of: "DesignComponents.swift", in: "DesignSystem")
        XCTAssertTrue(body.contains("chatColumnWidth"),
                      "P19.5 — MessageBubble must read the chatColumnWidth environment value to derive its max width")
    }

    // MARK: - Test 3: default column-width fallback is the readable cap

    func testChatColumnWidthDefaultIsReadableCap() {
        let body = Self.source(of: "ChatLayoutEnvironment.swift", in: "DesignSystem")
        XCTAssertTrue(body.contains("static let defaultValue: CGFloat = 560"),
                      "P19.5 — chatColumnWidth defaultValue must be 560 (the readable cap) so isolated previews don't collapse")
    }

    // MARK: - Test 4: floating chat message area injects chatColumnWidth

    func testFloatingChatMessageAreaInjectsChatColumnWidth() {
        let body = Self.source(of: "ChatExpandedView.swift", in: "FloatingChat")
        XCTAssertTrue(body.contains(".environment(\\.chatColumnWidth,"),
                      "P19.5 — ChatExpandedView.messageArea must inject chatColumnWidth via .environment(_:) so MessageBubble can resolve the column width")
        // The injection must come from a GeometryReader — that's the bounded
        // measurement that the LazyVStack children can no longer do themselves.
        XCTAssertTrue(body.contains("GeometryReader { columnProxy in"),
                      "P19.5 — ChatExpandedView.messageArea must wrap the scroll content in a GeometryReader (bounded by the outer VStack) and inject columnProxy.size.width into chatColumnWidth")
    }

    // MARK: - Test 5: companion chat message area injects chatColumnWidth

    func testCompanionChatMessageAreaInjectsChatColumnWidth() {
        let body = Self.source(of: "CompanionChatView.swift", in: "UI")
        XCTAssertTrue(body.contains(".environment(\\.chatColumnWidth,"),
                      "P19.5 — CompanionChatView.messageArea must inject chatColumnWidth via .environment(_:)")
    }

    // MARK: - Test 6: bubble intrinsic height is content-driven

    /// Render a `MessageBubble` with the production long-reply text and verify
    /// that the RENDERED bubble height is bounded (it took its content's
    /// intrinsic height, NOT unbounded). The pre-fix bubble's GeometryReader
    /// reported unbounded height back to the LazyVStack, which made the
    /// rendered bubble frame as tall as the parent viewport — verifiable in
    /// the bitmap.
    func testBubbleReportsContentDrivenHeight() throws {
        let longText = String(repeating: "这是一段很长的回复，用来验证气泡在桌面悬浮窗里能不能正常换行、避免被压成单字符的纵向条。", count: 3)
        let bubble = MessageBubble(role: .assistant, text: longText, status: .completed)
            .environment(\.chatColumnWidth, 420)
        let host = NSHostingView(rootView: bubble)
        host.appearance = NSAppearance(named: .darkAqua)
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 800)
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            XCTFail("no bitmap")
            return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        // Scan the rendered bitmap to find the bubble's actual drawn height.
        // A bubble that took content height has its bottom at some y < 800
        // with sparse rows below. A pre-fix bubble that took unbounded height
        // would have ink extending to the full 800pt.
        var lastInkRow = 0
        for y in 0..<bitmap.pixelsHigh {
            var inkPixels = 0
            for x in 0..<bitmap.pixelsWide {
                guard let c = bitmap.colorAt(x: x, y: y) else { continue }
                if c.alphaComponent > 0.05 &&
                    (c.redComponent < 0.94 || c.greenComponent < 0.94 || c.blueComponent < 0.94) {
                    inkPixels += 1
                }
            }
            if inkPixels > 5 { lastInkRow = y }
        }
        let scale = CGFloat(bitmap.pixelsHigh) / 800
        let bubbleHeightPt = CGFloat(lastInkRow + 1) / scale
        // P19.5 contract: bubble height is bounded by content (~6 wrapped lines
        // at 420pt × 0.88 ≈ 200pt). Pre-fix reported (420, .infinity) so the
        // bubble's drawn ink would extend to the full 800pt viewport.
        XCTAssertLessThan(bubbleHeightPt, 500,
            "P19.5 — bubble drawn height must be content-driven (<500pt for a 6-line Chinese reply at 420pt column). Pre-fix the GeometryReader reported unbounded height so the bubble filled the parent viewport (up to 800pt). Got \(bubbleHeightPt)pt.")
        XCTAssertGreaterThan(bubbleHeightPt, 100,
            "Bubble must show real content height (got \(bubbleHeightPt)pt)")
    }

    // MARK: - Test 7: bubble uses chatColumnWidth to derive max width

    func testBubbleMaxWidthDerivedFromChatColumnWidth() throws {
        // Build two bubbles at different column widths and verify their
        // intrinsic widths scale.
        let text = String(repeating: "宽度变化测试文本", count: 5)
        let narrowHost = NSHostingView(rootView:
            MessageBubble(role: .assistant, text: text, status: .completed)
                .environment(\.chatColumnWidth, 320))
        narrowHost.appearance = NSAppearance(named: .darkAqua)
        narrowHost.frame = NSRect(x: 0, y: 0, width: 320, height: 400)
        narrowHost.layoutSubtreeIfNeeded()
        let wideHost = NSHostingView(rootView:
            MessageBubble(role: .assistant, text: text, status: .completed)
                .environment(\.chatColumnWidth, 600))
        wideHost.appearance = NSAppearance(named: .darkAqua)
        wideHost.frame = NSRect(x: 0, y: 0, width: 600, height: 400)
        wideHost.layoutSubtreeIfNeeded()
        // The wide bubble should produce measurably wider ink than the narrow
        // bubble (since both contain the same text, the difference comes from
        // the column-width-driven max width).
        let narrowInk = Self.inkWidth(of: narrowHost)
        let wideInk = Self.inkWidth(of: wideHost)
        XCTAssertNotNil(narrowInk)
        XCTAssertNotNil(wideInk)
        guard let narrowInk, let wideInk else { return }
        XCTAssertGreaterThan(wideInk, narrowInk + 40,
            "P19.5 — bubble max width must scale with chatColumnWidth (got \(wideInk) vs \(narrowInk))")
    }

    // MARK: - Test 8: full ChatExpandedView rendering — no overlap, all 8 messages visible

    /// Render the full ChatExpandedView at the production geometry and check
    /// the pixel content. The pre-fix render crammed all 8 messages into the
    /// top ~240pt with ~210pt of blank space below; the post-fix render
    /// shows messages stacked at distinct y-coordinates with the scrollable
    /// region fully populated (or scrolled to the bottom).
    func testFloatingChatRendersMessagesAtDistinctYCoordinates() throws {
        let outURL = URL(fileURLWithPath: "/tmp/p19_5_chat_layout_test.png")
        try? FileManager.default.removeItem(at: outURL)
        // We invoke the existing harness via subprocess to avoid coupling this
        // test to internal harness state. The harness captures
        // `floatingChatExpanded` at the production 420×520 size with the
        // seeded conversation.
        let appPath = "\(p195RepositoryRoot)/build/DeskPet.app/Contents/MacOS/DeskPet"
        let outDir = "/tmp/p19_5_test_evidence_\(UUID().uuidString.prefix(8))"
        try? FileManager.default.createDirectory(atPath: outDir + "/screenshots",
                                                 withIntermediateDirectories: true)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: appPath)
        task.environment = [
            "DESKPET_P17_PRODUCT_SURFACE": "floatingChatExpanded",
            "DESKPET_P17_PRODUCT_EVIDENCE_DIR": outDir,
        ]
        try task.run()
        task.waitUntilExit()
        let darkPath = outDir + "/screenshots/p17_floatingChatExpanded_dark.png"
        guard FileManager.default.fileExists(atPath: darkPath) else {
            XCTFail("Harness did not produce expected PNG at \(darkPath)")
            return
        }
        let img = NSImage(contentsOfFile: darkPath)
        guard let img, let tiff = img.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else {
            XCTFail("Could not load harness PNG")
            return
        }
        try? FileManager.default.removeItem(atPath: outDir)

        let w = bitmap.pixelsWide
        let h = bitmap.pixelsHigh
        // Sample row content density. The pre-fix render had messages crammed
        // into y=0..240 (a single dense band) and a sharp drop to a sparse
        // region from y=240..460. The post-fix render distributes message
        // content across the panel (or scrolled to bottom, showing the last
        // messages).
        var denseRows: [Int] = []
        var sparseRows: [Int] = []
        for y in stride(from: 0, to: h, by: 4) {
            var nonDark = 0
            for x in stride(from: 0, to: w, by: 4) {
                guard let c = bitmap.colorAt(x: x, y: y) else { continue }
                if c.alphaComponent > 0.05 &&
                    (c.redComponent > 0.18 || c.greenComponent > 0.18 || c.blueComponent > 0.18) {
                    nonDark += 1
                }
            }
            if nonDark > 8 { denseRows.append(y) }
            else if nonDark <= 2 && y > 80 && y < h - 60 { sparseRows.append(y) }
        }
        // Pre-fix: ~210pt of sparse area between the cramped top and the
        // composer at the bottom. Post-fix: messages distribute through the
        // scroll viewport, so the sparse gaps are smaller. We pin a generous
        // upper bound that catches the pre-fix defect but allows the
        // scroll-to-bottom layout of the post-fix render.
        let sparseRunMax = Self.longestSparseRun(sparseRows)
        XCTAssertLessThan(sparseRunMax, 120,
            "P19.5 — messages must NOT be crammed into a narrow band at the top of the panel. Pre-fix produced a ~210pt sparse run between the cramped messages and the composer; the post-fix layout keeps the panel content continuously distributed (longest sparse run < 120pt, got \(sparseRunMax)pt).")
        // Sanity: at least 30 dense rows (the messages + composer occupy meaningful area).
        XCTAssertGreaterThan(denseRows.count, 30,
            "Floating chat render should have substantial content density (got \(denseRows.count) dense rows)")
    }

    // MARK: - Helpers

    private static func source(of leaf: String, in dir: String) -> String {
        let url = URL(fileURLWithPath:
            "\(p195RepositoryRoot)/Sources/DeskPet/\(dir)/\(leaf)")
        return (try? String(contentsOf: url)) ?? ""
    }

    /// Width of the rendered bubble ink in points.
    private static func inkWidth(of host: NSHostingView<some View>) -> CGFloat? {
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return nil }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        var minX = Int.max, maxX = Int.min, inkPixels = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
            for x in 0..<bitmap.pixelsWide {
                guard let c = bitmap.colorAt(x: x, y: y) else { continue }
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
        let scale = CGFloat(bitmap.pixelsWide) / host.bounds.width
        return CGFloat(maxX - minX + 1) / max(scale, 1)
    }

    /// Longest consecutive run of sparse rows in the row sample. A "sparse run"
    /// is a sequence of sparse rows whose indices form a contiguous block.
    private static func longestSparseRun(_ rows: [Int]) -> Int {
        guard !rows.isEmpty else { return 0 }
        var longest = 1
        var current = 1
        for i in 1..<rows.count {
            if rows[i] == rows[i - 1] + 4 {
                current += 1
                longest = max(longest, current)
            } else {
                current = 1
            }
        }
        return longest * 4  // rows are sampled every 4pt
    }
}
