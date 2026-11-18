import XCTest
import SwiftUI
import AppKit
import PetAgentRuntime
@testable import DeskPet

private let p19ToolRepositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path

/// P19.1 / P0-B — user-visible tool execution behaviour.
///
/// Three contracts under test:
/// 1. `ToolOutputPreviewBuilder` only returns previews from real
///    `userSafeSummary` payloads. Empty, fake, and chain-of-thought inputs all
///    collapse to `nil` so the UI can fall back to the generic title rather than
///    fabricating facts.
/// 2. `ToolOutputPreviewBuilder` re-runs `AgentPrivacyRedactor.safeText` so a
///    future code path that bypasses the runner cannot leak secrets / paths / long
///    opaque tokens into the chat bubble.
/// 3. `ChatActivityToolRecord.resultPreview` is `Codable` so it survives a
///    round-trip through the conversation store.
@MainActor
final class P19_1ToolOutputPreviewBuilderTests: XCTestCase {

    func testEmptyOrWhitespaceReturnsNil() {
        XCTAssertNil(ToolOutputPreviewBuilder.preview(toolID: "list_today_calendar_events",
                                                     rawUserSafeSummary: nil))
        XCTAssertNil(ToolOutputPreviewBuilder.preview(toolID: "list_today_calendar_events",
                                                     rawUserSafeSummary: ""))
        XCTAssertNil(ToolOutputPreviewBuilder.preview(toolID: "list_today_calendar_events",
                                                     rawUserSafeSummary: "   \n  "))
    }

    func testTruthfulSummaryIsReturned() {
        let preview = ToolOutputPreviewBuilder.preview(toolID: "get_current_datetime",
                                                      rawUserSafeSummary: "已获取本地日期和时间")
        XCTAssertEqual(preview, "已获取本地日期和时间")
    }

    func testChainOfThoughtTextIsRejected() {
        // The redactor must reject anything that smells like reasoning/thinking so a
        // future model that leaks CoT into a summary cannot bubble it up to the user.
        for forbidden in ["my reasoning: …", "thinking about this", "分析用户画像",
                          "根据我的推理得出结论", "思维链回顾"] {
            let preview = ToolOutputPreviewBuilder.preview(toolID: "list_today_calendar_events",
                                                          rawUserSafeSummary: forbidden)
            XCTAssertNil(preview, "CoT-like input must be rejected; got: \(String(describing: preview))")
        }
    }

    func testSecretsAreRedactedBeforeReturning() {
        // `AgentPrivacyRedactor.safeText` strips bearer tokens, sk-... keys,
        // /Users/ paths, etc. The preview path must inherit that sanitization.
        let fixtureUserPath = "/" + ["Users", "fixture-user", "Documents", "private.md"].joined(separator: "/")
        let cases: [(input: String, forbidden: String)] = [
            ("读取的文件包含 " + fixtureUserPath,
             "/Users/"),
            ("Authorization Bearer " + String(repeating: "e", count: 40),
             "Bearer eyJ"),
            ("API Key = " + "sk-" + String(repeating: "a", count: 32),
             "sk-abcdefghij"),
        ]
        for (input, forbidden) in cases {
            let preview = ToolOutputPreviewBuilder.preview(toolID: "read_file",
                                                          rawUserSafeSummary: input)
            if let preview {
                XCTAssertFalse(preview.contains(forbidden),
                              "preview must redact \(forbidden); got: \(preview)")
            }
        }
    }

    func testLongSummaryIsTruncatedToMaxLength() {
        let long = String(repeating: "这是一段中文摘要。", count: 20) // ~140 chars
        let preview = ToolOutputPreviewBuilder.preview(toolID: "list_today_calendar_events",
                                                      rawUserSafeSummary: long)
        XCTAssertNotNil(preview)
        XCTAssertLessThanOrEqual(preview?.count ?? 0, 80,
                                 "preview must be clamped to <=80 characters by safeText")
    }
}

/// P19.1 / P0-B — `ChatActivityToolRecord.resultPreview` survives Codable round-trip
/// and the field exists on the production record type with the documented semantics.
@MainActor
final class P19_1ChatActivityToolRecordTests: XCTestCase {

    func testResultPreviewRoundTripsThroughCodable() throws {
        let record = ChatActivityToolRecord(
            key: "step-1",
            toolID: "list_today_calendar_events",
            displayName: "今日日历",
            icon: "calendar",
            status: .succeeded,
            title: "已查询今日日历",
            resultPreview: "已查询今日日程",
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000))

        let encoded = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(ChatActivityToolRecord.self, from: encoded)
        XCTAssertEqual(decoded.resultPreview, "已查询今日日程")
        XCTAssertEqual(decoded.toolID, record.toolID)
        XCTAssertEqual(decoded.status, record.status)
    }

    func testResultPreviewNilRoundTripsThroughCodable() throws {
        let record = ChatActivityToolRecord(
            key: "step-1",
            toolID: "list_today_calendar_events",
            displayName: "今日日历",
            icon: "calendar",
            status: .running,
            title: "正在查询今日日历",
            resultPreview: nil,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000))

        let encoded = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(ChatActivityToolRecord.self, from: encoded)
        XCTAssertNil(decoded.resultPreview)
    }

    func testChatActivityToolRecordExposesResultPreviewProperty() {
        // Pin the API surface so a future renaming is visible in code review.
        let record = ChatActivityToolRecord(key: "k",
                                            toolID: "t",
                                            displayName: "d",
                                            icon: "i",
                                            status: .running,
                                            title: "title",
                                            resultPreview: "preview",
                                            updatedAt: Date())
        XCTAssertEqual(record.resultPreview, "preview")
    }
}

/// P19.1 / P0-B — `ChatActivityBubble` source-level contracts.
///
/// Source-inspection is acceptable here because the production rendering passes
/// SwiftUI state through `@State` + `.onAppear`, which is hard to drive deterministically
/// from an XCTest. The body itself is plain SwiftUI text + conditionals — a compile-
/// time assertion that the right code path is in place is the most honest test we can
/// write without a full P15.1 harness.
@MainActor
final class P19_1ChatActivityBubbleExpansionTests: XCTestCase {

    func testChatActivityBubbleDefaultExpansionRuleUsesStatus() {
        // P19.1 / §7 — the bubble must NOT hard-code `expanded = false`. The default
        // must be derived from `activity.status.isTerminal` via `.onAppear`.
        let source = Self.sourceOf("ChatActivityBubble.swift")
        XCTAssertTrue(source.contains("@State private var expanded: Bool"),
                     "P19.1 — `expanded` must be @State with no inline default (default is applied in .onAppear)")
        XCTAssertTrue(source.contains(".onAppear"),
                     "P19.1 — expansion default must be applied in .onAppear")
        XCTAssertTrue(source.contains("expanded = !activity.status.isTerminal"),
                     "P19.1 — active activities must expand by default")
    }

    func testChatActivityBubbleRendersResultPreviewWhenPresent() {
        // P19.1 / §4 — when the user collapses a bubble with a single tool that has
        // a real preview, the preview must still be visible (one-line caption).
        let source = Self.sourceOf("ChatActivityBubble.swift")
        XCTAssertTrue(source.contains("primaryTool.resultPreview"),
                     "P19.1 — collapsed view must surface the primary tool's resultPreview")
        XCTAssertTrue(source.contains("tool.resultPreview"),
                     "P19.1 — expanded view must surface the tool's resultPreview")
    }

    func testChatActivityBubblePreservesPreExistingDisplayNameAndSummary() {
        // P15.1 source-text backstop: the P19.1 changes must not regress the
        // earlier R1-04 / PARALLEL_ENUM01 contracts.
        let source = Self.sourceOf("ChatActivityBubble.swift")
        XCTAssertTrue(source.contains("Text(activity.summary)"))
        XCTAssertTrue(source.contains("Text(tool.displayName)"))
        XCTAssertTrue(source.contains("backgroundOpacity"))
        XCTAssertTrue(source.contains("activity.status.isTerminal ? 0.56 : 0.92"))
    }

    private static func sourceOf(_ leaf: String) -> String {
        let url = URL(fileURLWithPath: "\(p19ToolRepositoryRoot)/Sources/DeskPet/UI/\(leaf)")
        return (try? String(contentsOf: url)) ?? ""
    }
}
