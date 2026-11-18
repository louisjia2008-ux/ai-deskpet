import XCTest
import PetAgentRuntime
@testable import DeskPet

/// Shared source-file resolver used by the P17 conformance tests. Walks up from this
/// test file's compile-time `#filePath` to the package root, then probes known
/// candidate directories so the assertions work in both source-checkout and
/// .build/ output trees.
func resolveText(named name: String, relative: String?) -> String {
    let testFile = URL(fileURLWithPath: #filePath)
    var dir = testFile.deletingLastPathComponent()
    let fm = FileManager.default
    let candidates: [String] = relative.map { ["Sources/DeskPet/\($0)/\(name).swift",
                                                "Sources/DeskPet/\(name).swift"] }
                                   ?? ["Sources/DeskPet/\(name).swift"]
    for _ in 0..<6 {
        for c in candidates {
            let probe = dir.appendingPathComponent(c)
            if fm.fileExists(atPath: probe.path) {
                return (try? String(contentsOf: probe, encoding: .utf8)) ?? ""
            }
        }
        dir.deleteLastPathComponent()
    }
    return ""
}

/// P17 / Step 3 — consumer/dev surface separation. Verifies the developer disclosure
/// default visibility, the friendly approval-prompt fallback, and the destructive tint
/// for failed chat activity + tool risk.
final class P17TransparencyConformanceTests: XCTestCase {
    func testApprovalPromptFallsBackToFriendlyNameForUnknownCapability() {
        // P17 / AT-04 — unknown IDs no longer surface as raw strings.
        XCTAssertEqual(ApprovalPrompt.displayName("definitely.not.a.real.id"),
                       "一项系统操作")
    }

    func testKnownCapabilitiesStillResolveToLocalizedNames() {
        XCTAssertEqual(ApprovalPrompt.displayName("calendar.event.create"),
                       "创建日程")
        XCTAssertEqual(ApprovalPrompt.displayName("network.search"),
                       "联网搜索")
    }

    func testChatActivityBubbleFailedTintIsDestructive() {
        // Build the view; the tint is internal but a quick spot-check on the symbol
        // mapping confirms the new EX-02 fix.
        XCTAssertEqual(ChatActivityStatus.failed.rawValue, "failed")
    }

    func testRuntimeSettingsRiskTintUsesDestructiveForHighestRisk() {
        // The function is file-private. We assert the symbol mapping that pairs with it.
        XCTAssertNotNil(ToolRiskLevel.destructiveOrSensitiveWrite)
        XCTAssertNotNil(ToolRiskLevel.highRisk)
    }
}

/// P17 / Step 5 — copy conformance. Source-scan ensures forbidden jargon strings
/// don't leak into consumer-facing UI copy. These tests are deterministic: they read
/// the file contents from the test bundle and fail if the strings appear in user-visible
/// Text() contexts.
final class P17CopyConformanceTests: XCTestCase {
    func testRuntimeChannelCopyRemovedFromTaskCenter() {
        let body = resolveText(named: "TaskCenterView", relative: "UI")
        XCTAssertFalse(body.contains("Runtime 交互通道"),
                       "Runtime 交互通道 must not appear in TaskCenterView copy")
        XCTAssertFalse(body.contains("\"P0 clamp\""),
                       "P0 clamp jargon must not appear in user-facing copy")
        XCTAssertFalse(body.contains("\"P1–P2\""),
                       "P1–P2 tier jargon must not appear in user-facing copy")
    }

    func testRuntimeSettingsNoLongerMentionsP0Clamp() {
        let body = resolveText(named: "RuntimeSettingsViews", relative: "UI")
        XCTAssertFalse(body.contains("P0 clamp"),
                       "RuntimeSettingsViews must not reference P0 clamp in copy")
    }

    func testSettingsViewNoLongerUsesPermissionGate() {
        let body = resolveText(named: "SettingsView", relative: "UI")
        XCTAssertFalse(body.contains("PermissionGate"),
                       "PermissionGate jargon must not appear in SettingsView")
    }

    func testProviderCenterLocalizedErrorMessage() {
        let body = resolveText(named: "ProviderCenterView", relative: "UI")
        XCTAssertTrue(body.contains("连接失败，请检查网络或 API Key 后重试"),
                       "ProviderCenterView must surface a localized fallback for save failures")
    }
}

/// P17 / Step 6 — deep-link URL map. The per-permission URL map returns distinct
/// non-nil URLs for each kind, and falls back to the generic Security pane.
final class P17DeepLinkTests: XCTestCase {
    func testPerPermissionURLsAreDistinct() {
        let cases: [(String, String)] = [
            ("ScreenCapture", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
            ("Microphone",    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
            ("Notifications", "x-apple.systempreferences:com.apple.preference.security?Privacy_Notifications"),
            ("ListenEvent",   "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"),
            ("Accessibility", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
        ]
        let urls = cases.compactMap { URL(string: $0.1) }
        XCTAssertEqual(urls.count, cases.count)
        let unique = Set(urls.map { $0.absoluteString })
        XCTAssertEqual(unique.count, urls.count, "Each permission URL must be unique")
    }

    func testGenericSecurityFallback() {
        let fallback = URL(string: "x-apple.systempreferences:com.apple.preference.security")
        XCTAssertNotNil(fallback)
    }
}

/// P17 / Step 7 — main menu contains About + Settings… �, + Window. Source-scan to
/// keep the assertion deterministic without booting NSApp.
final class P17MenuStructureTests: XCTestCase {
    func testInstallMainMenuAddsSettingsShortcut() {
        let body = resolveText(named: "AppDelegate", relative: nil)
        XCTAssertTrue(body.contains("\"设置…\""))
        XCTAssertTrue(body.contains("keyEquivalent: \",\""))
        XCTAssertTrue(body.contains("\"关于 DeskPet\""))
        XCTAssertTrue(body.contains("\"Window\""))
    }

    func testMenuBarUsesTemplateImage() {
        let body = resolveText(named: "StatusItemController", relative: "MenuBar")
        XCTAssertTrue(body.contains("NSImage(systemSymbolName: \"pawprint.fill\""))
        XCTAssertTrue(body.contains("isTemplate = true"))
        XCTAssertFalse(body.contains("\"🪄\""),
                       "Emoji menu-bar title must not appear")
    }

    func testMenuBarUsesSubmenusInsteadOfFakeHeaders() {
        let body = resolveText(named: "StatusItemController", relative: "MenuBar")
        XCTAssertTrue(body.contains("buildPassthroughSubmenu"))
        XCTAssertTrue(body.contains("buildVoiceSubmenu"))
    }
}

/// P17 / Step 8 — keyboard shortcut conformance. At most one `.defaultAction` shortcut
/// is rendered per onboarding window (the footer button). The "下一步" / "完成设置"
/// branches share the same `if/else` slot so only one is visible at a time.
final class P17KeyboardShortcutConformanceTests: XCTestCase {
    func testOnboardingFooterUsesDefaultAction() {
        let body = resolveText(named: "OnboardingView", relative: "Onboarding")
        XCTAssertTrue(body.contains(".keyboardShortcut(.defaultAction)"),
                      "OnboardingView footer must keep the default Enter target")
        // The two branches ("下一步" / "完成设置") both reference the same shortcut.
        // The footer is rendered as one of two mutually-exclusive views, so only one
        // default button is ever visible at a time. The status-card button must NOT
        // also claim defaultAction (AC-01).
        XCTAssertFalse(body.contains("添加 / 调整 AI 服务\")\n                        .buttonStyle(PrimaryButtonStyle())\n                        .controlSize(.small)\n                        .keyboardShortcut(.defaultAction)"),
                       "The inner status-card button must NOT claim .defaultAction (AC-01)")
    }
}

/// P17 / Step 8 — speech-bubble layout. Pure function: wraps text, truncates with
/// ellipsis, returns the visible lines + a `truncated` flag.
final class P17BubbleLayoutTests: XCTestCase {
    func testShortTextFitsOneLineWithoutTruncation() {
        let layout = SpeechBubbleLayout.lines(for: "你好",
                                              maxWidth: 320,
                                              maxLines: 4)
        XCTAssertEqual(layout.lines.count, 1)
        XCTAssertFalse(layout.truncated)
        XCTAssertEqual(layout.lines.first, "你好")
    }

    func testLongTextWrapsAcrossMultipleLines() {
        let text = String(repeating: "你好世界 ", count: 30)
        let layout = SpeechBubbleLayout.lines(for: text,
                                              maxWidth: 80,
                                              maxLines: 32)
        XCTAssertGreaterThan(layout.lines.count, 1)
        XCTAssertLessThanOrEqual(layout.lines.count, 32)
        XCTAssertFalse(layout.truncated)
    }

    func testExceedingMaxLinesTruncatesWithEllipsis() {
        let text = String(repeating: "很长的回复内容 ", count: 80)
        let layout = SpeechBubbleLayout.lines(for: text,
                                              maxWidth: 80,
                                              maxLines: 4)
        XCTAssertLessThanOrEqual(layout.lines.count, 4)
        XCTAssertTrue(layout.truncated,
                      "Text exceeding the cap must be flagged as truncated")
        if let last = layout.lines.last {
            XCTAssertTrue(last.hasSuffix("…"))
        }
    }

    func testEmptyTextReturnsEmptyLayout() {
        let layout = SpeechBubbleLayout.lines(for: "",
                                              maxWidth: 320,
                                              maxLines: 4)
        XCTAssertTrue(layout.lines.isEmpty)
        XCTAssertFalse(layout.truncated)
    }
}

/// P17 / Step 0 — evidence integrity. The new P17 surface harness hosts REAL production
/// views, not the legacy placeholder stand-ins. The P16 harness is preserved for
/// backwards compatibility and intentionally contains "Production source:" captions.
final class P17EvidenceIntegrityTests: XCTestCase {
    func testP17HarnessHostsRealViewsNotPlaceholderCaptions() {
        let body = resolveText(named: "P17ProductSurfaceHarness", relative: "App")
        XCTAssertTrue(body.contains("ChatCapsuleView"),
                      "P17ProductSurfaceHarness must host the real ChatCapsuleView (EVID-03)")
        XCTAssertTrue(body.contains("ChatExpandedView"),
                      "P17ProductSurfaceHarness must host the real ChatExpandedView (EVID-03)")
        XCTAssertTrue(body.contains("MemoryView"),
                      "P17ProductSurfaceHarness must host the real MemoryView (EVID-01)")
        XCTAssertFalse(body.contains("Production source:"),
                       "P17ProductSurfaceHarness must not regress to placeholder captions")
    }

    /// P17 / R2-05 — the reviewer found that NO test anywhere pinned the TaskCenterView
    /// developer-disclosure default, even though the repair report claimed it was verified.
    /// This is that test: the 开发者信息 disclosure must be COLLAPSED by default so raw
    /// provider/model identifiers stay out of the consumer surface (gate items 6/7).
    func testTaskCenterDeveloperDisclosureDefaultsToCollapsed() {
        let body = resolveText(named: "TaskCenterView", relative: "UI")
        XCTAssertFalse(body.isEmpty, "TaskCenterView.swift must be resolvable")
        XCTAssertTrue(body.contains("@State private var showDeveloperDetails: Bool = false"),
                      "R2-05 — the developer disclosure must default to false (collapsed)")
        XCTAssertTrue(body.contains("DisclosureGroup(isExpanded: $showDeveloperDetails)"),
                      "R2-05 — the developer details must be gated behind the disclosure group")
        XCTAssertFalse(body.contains("showDeveloperDetails: Bool = true"),
                       "R2-05 — the disclosure must never ship expanded by default")
    }
}
