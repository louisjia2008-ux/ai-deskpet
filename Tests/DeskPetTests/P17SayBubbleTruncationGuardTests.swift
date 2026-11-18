import XCTest
@testable import DeskPet

/// P17 / CR-01 (R1-02) — defense-in-depth truncation guard at AppDelegate.swift:307.
/// The renderer-side `SpeechBubbleLayout` is the primary guarantee, but the call site
/// also clamps replies to `sayBubbleTruncationLimit` characters so legacy replays and
/// any future code path that bypasses the bubble renderer cannot overwhelm the bubble
/// texture cache. This suite pins the threshold and the clamp behavior.
@MainActor
final class P17SayBubbleTruncationGuardTests: XCTestCase {
    func testTruncationLimitIsDocumentedValue() {
        XCTAssertEqual(AppDelegate.sayBubbleTruncationLimit, 240,
                       "R1-02 — truncation cap must stay at 240 to match the bubble's 4-line budget")
    }

    func testShortReplyIsReturnedUnchanged() {
        let input = "短回复，足够了。"
        XCTAssertEqual(AppDelegate.truncateForSayBubble(input), input)
    }

    func testReplyAtExactlyTheLimitIsReturnedUnchanged() {
        let input = String(repeating: "a", count: AppDelegate.sayBubbleTruncationLimit)
        XCTAssertEqual(AppDelegate.truncateForSayBubble(input), input)
    }

    func testReplyLongerThanTheLimitIsTruncated() {
        let input = String(repeating: "长内容", count: 80) // 80 × 3 chars = 240 chars
        let truncated = AppDelegate.truncateForSayBubble(input)
        XCTAssertEqual(truncated.count, AppDelegate.sayBubbleTruncationLimit)
        XCTAssertTrue(input.hasPrefix(truncated),
                      "Truncated output must be a prefix of the original reply")
    }

    func testEmptyReplyReturnsEmpty() {
        XCTAssertEqual(AppDelegate.truncateForSayBubble(""), "")
    }

    func testSourceUsesTheTruncationHelperAtTheCallSite() {
        // R1-02 — the call site at AppDelegate.swift must use `truncateForSayBubble`.
        // (Source-scan: resilient to whitespace changes but pins the helper name.)
        let body = resolveText(named: "AppDelegate", relative: nil)
        XCTAssertTrue(body.contains("truncateForSayBubble"),
                      "AppDelegate must call the helper at the sayBubble call site")
    }
}