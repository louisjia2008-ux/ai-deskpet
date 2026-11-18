import XCTest
import Foundation
@testable import PetAgentRuntime

final class P6ActivityProjectionTests: XCTestCase {
    func testUserProjectionShowsSemanticDateToolActivityWithoutArguments() {
        let events = makeToolEvents(toolID: "get_current_datetime",
                                    safeSummary: #"arguments {"include_all_day":true}"#)
        let userItems = AgentActivityReducer.reduce(events: events, visibility: .user)
        XCTAssertTrue(userItems.contains { $0.title == "正在获取本地日期和时间…" })
        XCTAssertTrue(userItems.contains { $0.title == "已获取本地日期和时间" })
        let serialized = userItems.map { "\($0.title) \($0.subtitle ?? "") \($0.details.compactMap(\.value).joined())" }.joined(separator: "\n")
        XCTAssertFalse(serialized.contains("include_all_day"))
        XCTAssertFalse(serialized.lowercased().contains("arguments"))
    }

    func testP12ToolPresentationCatalogDoesNotExposeRawToolIDsByDefault() {
        let date = ToolPresentationMetadata.metadata(for: "get_current_datetime")
        XCTAssertEqual(date.runningTitle, "正在获取本地日期和时间…")
        XCTAssertEqual(date.succeededTitle, "已获取本地日期和时间")

        let placeSearch = ToolPresentationMetadata.metadata(for: "local_discovery.search_places")
        XCTAssertEqual(placeSearch.runningTitle, "正在查找地点…")

        let unknown = ToolPresentationMetadata.metadata(for: "internal.debug_payload_runner")
        let defaultText = [
            unknown.displayName,
            unknown.runningTitle,
            unknown.succeededTitle,
            unknown.failedTitle
        ].joined(separator: "\n")
        XCTAssertFalse(defaultText.contains("internal.debug_payload_runner"))
        XCTAssertFalse(defaultText.contains("debug_payload_runner"))
        XCTAssertFalse(defaultText.contains("_"))
    }

    func testP12DateToolProjectionCollapsesVerificationEvents() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   sequenceNumber: 0,
                                   kind: .stepStarted,
                                   presentation: .init(title: "raw start"),
                                   stepID: "currentDateTime",
                                   toolID: ToolID(rawValue: "get_current_datetime")),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   sequenceNumber: 1,
                                   kind: .stepSucceeded,
                                   presentation: .init(title: "raw success"),
                                   stepID: "currentDateTime",
                                   toolID: ToolID(rawValue: "get_current_datetime")),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   sequenceNumber: 2,
                                   kind: .verificationSucceeded,
                                   presentation: .init(title: "internal verification"),
                                   stepID: "currentDateTimeVerification",
                                   toolID: ToolID(rawValue: "get_current_datetime")),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   sequenceNumber: 3,
                                   kind: .taskSucceeded,
                                   presentation: .init(title: "raw terminal"))
        ]
        let run = AgentTaskRunActivity(taskID: taskID,
                                       runID: runID,
                                       status: .succeeded,
                                       events: events,
                                       createdAt: Date(),
                                       updatedAt: Date(),
                                       completedAt: Date(),
                                       completedStepCount: 1,
                                       totalStepCount: 1)

        let titles = run.userVisibleEvents.map(\.presentation.title)
        XCTAssertTrue(titles.contains("正在获取本地日期和时间…"))
        XCTAssertTrue(titles.contains("已获取本地日期和时间"))
        // P15 — verification step IS surfaced for the date-time tool
        // ("已验证工具结果") so users see the runtime confirmed the tool
        // result. The "verification" / "verificationKind" internal event
        // labels must NOT leak, but a user-facing "验证" summary is OK.
        XCTAssertFalse(titles.contains { $0.lowercased().contains("verification") })
        XCTAssertFalse(titles.contains { $0.lowercased().contains("verifykind") })
    }

    func testP12PermissionWaitAndTerminalFailuresAreHumanReadable() {
        let taskID = UUID()
        let waitingRunID = UUID()
        let waiting = AgentTaskRunActivity(
            taskID: taskID,
            runID: waitingRunID,
            status: .waitingForApproval,
            events: [
                AgentTaskActivityEvent(taskID: taskID,
                                       runID: waitingRunID,
                                       sequenceNumber: 0,
                                       kind: .approvalRequested,
                                       presentation: .init(title: "approval", detail: "calendar.event.create"))
            ],
            createdAt: Date(),
            updatedAt: Date())
        let waitingEvent = waiting.userVisibleEvents.last
        XCTAssertEqual(waitingEvent?.presentation.title, "等待你的确认")
        XCTAssertEqual(waitingEvent?.presentation.detail, "需要你的允许才能继续。")

        let failedRunID = UUID()
        let failed = AgentTaskRunActivity(
            taskID: taskID,
            runID: failedRunID,
            status: .failed,
            events: [
                AgentTaskActivityEvent(taskID: taskID,
                                       runID: failedRunID,
                                       sequenceNumber: 0,
                                       kind: .taskFailed,
                                       presentation: .init(title: "failed", detail: "model not found / 404"),
                                       failureCategory: .providerUnavailable)
            ],
            createdAt: Date(),
            updatedAt: Date(),
            completedAt: Date(),
            terminalSummary: "model not found / 404",
            failureCategory: .providerUnavailable)
        XCTAssertEqual(failed.userVisibleTerminalSummary, "当前选择的模型不可用。")

        let cancelled = AgentTaskRunActivity(
            taskID: taskID,
            runID: UUID(),
            status: .cancelled,
            events: [],
            createdAt: Date(),
            updatedAt: Date(),
            completedAt: Date())
        XCTAssertEqual(cancelled.userVisibleTerminalSummary, "已停止")
    }

    func testDeveloperProjectionIncludesToolDetailButRedactsSecrets() {
        let events = makeToolEvents(toolID: "get_current_datetime",
                                    safeSummary: "Authorization: Bearer sk-secret123456")
        let developerItems = AgentActivityReducer.reduce(events: events, visibility: .developer)
        let details = developerItems.flatMap(\.details).map { "\($0.title) \($0.value ?? "")" }.joined(separator: "\n")
        XCTAssertTrue(details.contains("toolStarted") || details.contains("toolSucceeded"))
        XCTAssertFalse(details.contains("sk-secret"))
        XCTAssertFalse(details.lowercased().contains("bearer sk-"))
    }

    func testNoToolChatDoesNotProjectFakeTool() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            AgentEventEnvelope(taskID: taskID, runID: runID, sequence: 0,
                               source: .provider, kind: .modelRequestStarted,
                               payload: .model(.init(provider: "fake", safeSummary: "start"))),
            AgentEventEnvelope(taskID: taskID, runID: runID, sequence: 1,
                               source: .provider, kind: .modelResponseCompleted,
                               payload: .model(.init(provider: "fake", safeSummary: "done"))),
        ]
        let userItems = AgentActivityReducer.reduce(events: events, visibility: .user)
        XCTAssertTrue(userItems.contains { $0.title == "正在生成回复……" })
        XCTAssertFalse(userItems.contains { $0.category == .tool })
    }

    func testResultDocumentAttachesThroughActivityReducerAndReplayEnvelope() {
        #if DEBUG
        let taskID = UUID()
        let runID = UUID()
        let document = P6DebugTravelFixture.sampleDocument(taskID: taskID, runID: runID)
        let started = AgentTaskActivityEvent(taskID: taskID,
                                             runID: runID,
                                             sequenceNumber: 0,
                                             kind: .synthesisStarted,
                                             presentation: .init(title: "正在整理最终答复"))
        let result = AgentTaskActivityEvent(taskID: taskID,
                                            runID: runID,
                                            sequenceNumber: 1,
                                            kind: .resultProduced,
                                            presentation: .init(title: "结果已生成", detail: document.summary),
                                            resultDocument: document)
        let terminal = AgentTaskActivityEvent(taskID: taskID,
                                              runID: runID,
                                              sequenceNumber: 2,
                                              kind: .taskSucceeded,
                                              presentation: .init(title: "任务已完成"))
        let snapshot = AgentTaskActivityReducer.reduce(taskID: taskID, events: [started, result, terminal])
        XCTAssertEqual(snapshot.latestRun?.resultDocument?.id, document.id)

        let replayed = AgentTaskActivityEvent(eventEnvelope: AgentEventEnvelope(activityEvent: result))
        XCTAssertEqual(replayed.kind, .resultProduced)
        XCTAssertEqual(replayed.resultDocument?.id, document.id)
        #endif
    }

    func testOldTaskWithoutResultStillReplaysWithoutResultDocument() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   sequenceNumber: 0,
                                   kind: .taskCreated,
                                   presentation: .init(title: "任务已创建")),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   sequenceNumber: 1,
                                   kind: .taskSucceeded,
                                   presentation: .init(title: "任务已完成"))
        ]
        let snapshot = AgentTaskActivityReducer.reduce(taskID: taskID, events: events)
        XCTAssertNil(snapshot.latestRun?.resultDocument)
    }

    private func makeToolEvents(toolID: String, safeSummary: String) -> [AgentEventEnvelope] {
        let taskID = UUID()
        let runID = UUID()
        return [
            AgentEventEnvelope(taskID: taskID, runID: runID, sequence: 0,
                               source: .toolRuntime, kind: .toolStarted,
                               payload: .tool(.init(toolID: toolID,
                                                    toolCallID: "call-1",
                                                    displayName: "Current Date",
                                                    safeSummary: safeSummary))),
            AgentEventEnvelope(taskID: taskID, runID: runID, sequence: 1,
                               source: .toolRuntime, kind: .toolSucceeded,
                               payload: .tool(.init(toolID: toolID,
                                                    toolCallID: "call-1",
                                                    displayName: "Current Date",
                                                    safeSummary: safeSummary,
                                                    resultCategory: "success"))),
        ]
    }
}
