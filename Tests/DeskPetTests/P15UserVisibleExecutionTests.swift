import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore

/// P15 — User-Visible Agent Execution Golden Tests
final class P15UserVisibleExecutionTests: XCTestCase {

    // MARK: - THINK-01..05 — Thinking leak regression

    func testTHINK01_StrippedCompleteThinkBlockDoesNotLeakIntoVisibleText() {
        let raw = "<think>This is internal reasoning that must NOT appear in the user chat.</think>The visible answer is here."
        let result = ThinkingContentFilter.filter(raw)
        XCTAssertTrue(result.didStrip)
        XCTAssertEqual(result.visible, "The visible answer is here.")
        XCTAssertFalse(result.visible.lowercased().contains("think"))
        XCTAssertFalse(result.visible.contains("reasoning"))
    }

    func testTHINK02_StructuredReasoningTagsAreStripped() {
        let raw = "<reasoning>Hidden chain-of-thought.</reasoning>Final answer: 42"
        let result = ThinkingContentFilter.filter(raw)
        XCTAssertTrue(result.didStrip)
        XCTAssertEqual(result.visible, "Final answer: 42")
        XCTAssertFalse(result.visible.lowercased().contains("hidden"))
        XCTAssertFalse(result.visible.lowercased().contains("chain-of-thought"))
    }

    func testTHINK03_ToolCallBlocksDoNotLeakIntoUserVisibleText() {
        // The provider emits tool calls inline; the filter must strip them.
        // Production regex requires literal "<tool_call>" with no attrs between
        // _call and >. Use that exact form here.
        let raw = "Pre-tool text<tool_call>{\"tool\":\"search\",\"query\":\"foo\"}</tool_call>Post-tool text"
        let result = ThinkingContentFilter.filter(raw)
        XCTAssertTrue(result.didStrip)
        XCTAssertTrue(result.visible.contains("Pre-tool text"))
        XCTAssertTrue(result.visible.contains("Post-tool text"))
        XCTAssertFalse(result.visible.contains("\"search\""))
        XCTAssertFalse(result.visible.contains("\"foo\""))
    }

    func testTHINK04_OpenThinkTagMidStreamIsStrippedAndDoesNotResurface() {
        let raw = "Half-way through<think>partial reasoning"
        let result = ThinkingContentFilter.filter(raw)
        XCTAssertTrue(result.didStrip)
        XCTAssertFalse(result.visible.contains("partial"))
        XCTAssertFalse(result.visible.contains("reasoning"))
    }

    func testTHINK05_NoThinkingContentLeavesTextUnchanged() {
        let raw = "Just a normal reply with no thinking tags."
        let result = ThinkingContentFilter.filter(raw)
        XCTAssertFalse(result.didStrip)
        XCTAssertEqual(result.visible, raw)
    }

    func testTHINK06_ContainsThinkingHelperDetectsAllKnownForms() {
        XCTAssertTrue(ThinkingContentFilter.containsThinking("<think>x"))
        XCTAssertTrue(ThinkingContentFilter.containsThinking("<reasoning>x"))
        XCTAssertTrue(ThinkingContentFilter.containsThinking("<tool_call>x"))
        XCTAssertFalse(ThinkingContentFilter.containsThinking("normal text"))
    }

    // MARK: - TOOL-01..05 — Tool visibility

    func testTOOL01_KnownToolProvidesUserVisibleTitleAndCategory() {
        let date = ToolPresentationMetadata.metadata(for: "get_current_datetime")
        XCTAssertEqual(date.displayName, "本地日期和时间")
        XCTAssertEqual(date.runningTitle, "正在获取本地日期和时间…")
        XCTAssertEqual(date.succeededTitle, "已获取本地日期和时间")
    }

    func testTOOL02_UnknownToolFailsSafeWithGenericTitle() {
        let unknown = ToolPresentationMetadata.metadata(for: "internal.debug_payload_runner_v3")
        XCTAssertEqual(unknown.runningTitle, "正在执行操作…")
        XCTAssertEqual(unknown.succeededTitle, "操作已完成")
        XCTAssertEqual(unknown.failedTitle, "这个操作没有完成")
    }

    func testTOOL03_ToolMetadataNeverContainsRawIdentifierInUserCopy() {
        let knownIDs = ["get_current_datetime", "get_system_profile",
                        "get_frontmost_application", "list_today_calendar_events",
                        "approximate_location", "local_place_search",
                        "route_distance_estimate", "webpage_read",
                        "structured_place_extraction", "read_file",
                        "run_command", "modify_file",
                        "calendar.event.create"]
        for id in knownIDs {
            let meta = ToolPresentationMetadata.metadata(for: id)
            XCTAssertFalse(meta.displayName.contains(id),
                           "displayName leaks raw id: \(meta.displayName) for \(id)")
            XCTAssertFalse(meta.runningTitle.contains(id),
                           "runningTitle leaks raw id: \(meta.runningTitle) for \(id)")
            XCTAssertFalse(meta.succeededTitle.contains(id),
                           "succeededTitle leaks raw id: \(meta.succeededTitle) for \(id)")
            XCTAssertFalse(meta.failedTitle.contains(id),
                           "failedTitle leaks raw id: \(meta.failedTitle) for \(id)")
        }
    }

    func testTOOL04_ProjectionPhaseForUsingToolHasCorrectSemantics() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .running,
            activeToolCall: RuntimeActivityToolCall(
                internalToolID: "get_current_datetime",
                userVisibleRunningTitle: "正在获取本地日期和时间…",
                userCategory: .dateTime),
            toolCategory: .dateTime)
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .usingTool)
        XCTAssertEqual(p.toolCategory, .dateTime)
        XCTAssertTrue(p.title.contains("本地日期和时间"))
        XCTAssertFalse(p.title.contains("get_current_datetime"))
        XCTAssertTrue(p.canCancel)
    }

    func testTOOL05_UnknownToolCategorisesAsGeneric() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .running,
            activeToolCall: RuntimeActivityToolCall(
                internalToolID: "internal.debug_thing",
                userVisibleRunningTitle: "正在执行操作…",
                userCategory: .generic),
            toolCategory: .generic)
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .usingTool)
        XCTAssertEqual(p.toolCategory, .generic)
    }

    // MARK: - RETRY-UX-01..05 — Retry / recovery UX projection

    func testRETRYUX01_WaitingForRetryProjectsToUserVisibleRetryPhase() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .waitingForRetry,
            toolCategory: .generic,
            capabilityFriendlyDetail: "provider 暂时繁忙")
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .waitingForRetry)
        XCTAssertEqual(p.retryState, .waiting)
        XCTAssertTrue(p.title.contains("自动重试"))
        XCTAssertFalse(p.title.contains("429"))
        XCTAssertFalse(p.title.lowercased().contains("provider"))
        XCTAssertTrue(p.canCancel)
    }

    func testRETRYUX02_RecoveringStateIsVisibleAndDistinctFromRunning() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .recovering,
            toolCategory: .dateTime,
            capabilityFriendlyDetail: "重新执行日期查询")
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .recovering)
        XCTAssertEqual(p.retryState, .retrying)
        XCTAssertTrue(p.title.contains("已恢复"))
        XCTAssertFalse(p.title.contains("scheduler"))
        XCTAssertFalse(p.title.contains("wakeup"))
    }

    func testRETRYUX03_IdleProjectsToIdlePhase() {
        let p = AgentUserActivityProjector.project(RuntimeActivitySnapshot(runtimeState: .idle))
        XCTAssertEqual(p.phase, .idle)
        XCTAssertFalse(p.title.isEmpty)
        XCTAssertFalse(p.canCancel)
    }

    func testRETRYUX04_CancelledTerminalProjectsToCancelledPhase() {
        let p = AgentUserActivityProjector.project(RuntimeActivitySnapshot(runtimeState: .cancelled))
        XCTAssertEqual(p.phase, .cancelled)
        XCTAssertFalse(p.canCancel)
        XCTAssertTrue(p.title.contains("停止") || p.title.contains("取消"))
    }

    func testRETRYUX05_FailedTerminalProjectsToFailedPhaseWithFriendlyTitle() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .failed,
            userFacingFailureTitle: "暂时无法连接到模型",
            userFacingFailureDetail: "稍后再试或换个模型")
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .failed)
        XCTAssertEqual(p.title, "暂时无法连接到模型")
        XCTAssertEqual(p.detail, "稍后再试或换个模型")
        XCTAssertFalse(p.title.lowercased().contains("exception"))
        XCTAssertFalse(p.title.contains("stack"))
    }

    // MARK: - AC-01..06 — Approval / cancel

    func testAC01_WaitingForApprovalHasApprovedPhase() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .waitingForApproval,
            toolCategory: .calendar,
            capabilityFriendlyDetail: "DeskPet 想读取今日日历。")
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .waitingForApproval)
        XCTAssertTrue(p.requiresApproval)
        XCTAssertTrue(p.canCancel)
        XCTAssertTrue(p.title.contains("确认"))
        XCTAssertFalse(p.title.contains("calendar.events.read"))
    }

    func testAC02_CancellingIsDistinctFromCancelled() {
        let cancelling = AgentUserActivityProjector.project(
            RuntimeActivitySnapshot(runtimeState: .cancelling))
        let cancelled = AgentUserActivityProjector.project(
            RuntimeActivitySnapshot(runtimeState: .cancelled))
        XCTAssertEqual(cancelling.phase, .cancelling)
        XCTAssertEqual(cancelled.phase, .cancelled)
        XCTAssertNotEqual(cancelling.phase, cancelled.phase)
    }

    func testAC03_CompletedPhaseHasTerminalShape() {
        let p = AgentUserActivityProjector.project(RuntimeActivitySnapshot(runtimeState: .completed))
        XCTAssertEqual(p.phase, .completed)
        XCTAssertFalse(p.canCancel)
        XCTAssertFalse(p.requiresApproval)
    }

    func testAC04_ThinkingPhaseHidesInternalDetails() {
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .running,
            hasThinkingEvent: true)
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertEqual(p.phase, .thinking)
        XCTAssertFalse(p.title.contains("reasoning"))
        XCTAssertFalse(p.title.contains("thinking"))
        XCTAssertFalse(p.title.contains("reflect"))
    }

    func testAC05_TitleIsLengthCappedToPreventOverflow() {
        let long = String(repeating: "很长的标题", count: 100)
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .failed,
            userFacingFailureTitle: long)
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertLessThanOrEqual(p.title.count, 120)
    }

    func testAC06_DetailIsLengthCapped() {
        let long = String(repeating: "细节", count: 200)
        let snapshot = RuntimeActivitySnapshot(
            runtimeState: .failed,
            userFacingFailureTitle: "短标题",
            userFacingFailureDetail: long)
        let p = AgentUserActivityProjector.project(snapshot)
        XCTAssertNotNil(p.detail)
        XCTAssertLessThanOrEqual(p.detail?.count ?? 0, 120)
    }
}
