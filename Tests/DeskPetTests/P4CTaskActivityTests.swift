import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

final class P4CTaskActivityTests: XCTestCase {
    func testReducerDerivesStatusOrderingAndIgnoresIllegalTerminalEvents() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p4cEvent(.taskCreated, taskID: taskID, runID: runID, sequence: 0, title: "开始"),
            p4cEvent(.planningStarted, taskID: taskID, runID: runID, sequence: 1, title: "规划"),
            p4cEvent(.stepStarted, taskID: taskID, runID: runID, sequence: 2, title: "读取信息", stepID: "step_1"),
            p4cEvent(.stepSucceeded, taskID: taskID, runID: runID, sequence: 3, title: "读取完成", stepID: "step_1"),
            p4cEvent(.taskSucceeded, taskID: taskID, runID: runID, sequence: 4, title: "完成"),
            p4cEvent(.stepStarted, taskID: taskID, runID: runID, sequence: 5, title: "迟到步骤", stepID: "late"),
        ]

        let run = AgentTaskActivityReducer.reduceRun(events: events)

        XCTAssertEqual(run.status, .succeeded)
        XCTAssertEqual(run.events.map(\.kind), [.taskCreated, .planningStarted, .stepStarted, .stepSucceeded, .taskSucceeded])
        XCTAssertEqual(run.completedStepCount, 1)
        XCTAssertEqual(run.totalStepCount, 1)
        XCTAssertNil(run.currentStepTitle)
        XCTAssertFalse(run.canShowStopAction)
    }

    func testUserVisibleActivityAggregatesDateToolAndHidesInternalSteps() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p4cEvent(.taskCreated, taskID: taskID, runID: runID, sequence: 0, title: "今天是几号？"),
            p4cEvent(.planningStarted, taskID: taskID, runID: runID, sequence: 1, title: "schedulerStart"),
            p4cEvent(.planningStarted, taskID: taskID, runID: runID, sequence: 2, title: "正在判断下一步"),
            p4cEvent(.stepStarted,
                     taskID: taskID,
                     runID: runID,
                     sequence: 3,
                     title: "正在获取本地日期和时间",
                     stepID: "tool-get_current_datetime",
                     toolID: "get_current_datetime"),
            p4cEvent(.stepSucceeded,
                     taskID: taskID,
                     runID: runID,
                     sequence: 4,
                     title: "已获取本地日期和时间",
                     stepID: "tool-get_current_datetime",
                     toolID: "get_current_datetime"),
            p4cEvent(.synthesisStarted, taskID: taskID, runID: runID, sequence: 5, title: "正在整理最终答复"),
            p4cEvent(.synthesisSucceeded, taskID: taskID, runID: runID, sequence: 6, title: "最终答复已生成"),
            p4cEvent(.taskSucceeded, taskID: taskID, runID: runID, sequence: 7, title: "任务已完成")
        ]

        let run = AgentTaskActivityReducer.reduceRun(events: events)

        XCTAssertEqual(run.status, .succeeded)
        XCTAssertEqual(run.userVisibleEvents.map(\.presentation.title),
                       ["正在获取本地日期和时间…", "已获取本地日期和时间", "已完成"])
        XCTAssertEqual(run.userVisibleTerminalSummary, "已完成 · 1 个步骤 · 用时 7.0 秒")
        XCTAssertFalse(run.userVisibleEvents.map(\.presentation.title).contains("schedulerStart"))
        XCTAssertFalse(run.userVisibleEvents.map(\.presentation.title).contains("今天是几号？"))
        XCTAssertFalse(run.userVisibleEvents.map(\.presentation.title).contains("正在判断下一步"))
        XCTAssertFalse(run.userVisibleEvents.map(\.presentation.title).contains("正在整理最终答复"))
        XCTAssertFalse(run.canShowStopAction)
    }

    @MainActor
    func testStoreDeduplicatesEventsAndExposesWaitingAndActiveLists() {
        let store = AgentTaskActivityStore(persistence: nil)
        let taskID = UUID()
        let runID = UUID()
        let eventID = UUID()
        let first = p4cEvent(.taskCreated, eventID: eventID, taskID: taskID, runID: runID, sequence: 0, title: "开始")
        store.append(first)
        store.append(first)
        store.append(p4cEvent(.approvalRequested, taskID: taskID, runID: runID, sequence: 1,
                              title: "需要确认", detail: "不显示私人数据"))

        XCTAssertEqual(store.tasks.count, 1)
        XCTAssertEqual(store.task(id: taskID)?.latestRun?.events.count, 2)
        XCTAssertEqual(store.waitingTasks.map(\.taskID), [taskID])
        XCTAssertTrue(store.activeTasks.isEmpty)
    }

    func testApprovalDeniedCancellationAndLateResultsAreTerminalSafe() {
        let taskID = UUID()
        let deniedRun = UUID()
        let denied = AgentTaskActivityReducer.reduceRun(events: [
            p4cEvent(.taskCreated, taskID: taskID, runID: deniedRun, sequence: 0, title: "开始"),
            p4cEvent(.approvalRequested, taskID: taskID, runID: deniedRun, sequence: 1, title: "需要确认"),
            p4cEvent(.approvalDenied, taskID: taskID, runID: deniedRun, sequence: 2, title: "已拒绝", category: .approvalRejected),
            p4cEvent(.stepStarted, taskID: taskID, runID: deniedRun, sequence: 3, title: "不得执行", stepID: "late"),
        ])
        XCTAssertEqual(denied.status, .failed)
        XCTAssertFalse(denied.events.contains { $0.stepID == "late" })

        let cancelRun = UUID()
        let cancelled = AgentTaskActivityReducer.reduceRun(events: [
            p4cEvent(.taskCreated, taskID: taskID, runID: cancelRun, sequence: 0, title: "开始"),
            p4cEvent(.stepStarted, taskID: taskID, runID: cancelRun, sequence: 1, title: "执行", stepID: "step_1"),
            p4cEvent(.taskCancelled, taskID: taskID, runID: cancelRun, sequence: 2, title: "取消", category: .cancelled),
            p4cEvent(.stepSucceeded, taskID: taskID, runID: cancelRun, sequence: 3, title: "迟到成功", stepID: "step_1"),
        ])
        XCTAssertEqual(cancelled.status, .cancelled)
        XCTAssertEqual(cancelled.events.last?.kind, .taskCancelled)
        XCTAssertFalse(cancelled.canShowStopAction)
    }

    @MainActor
    func testHydratedTerminalRunDoesNotBecomeActiveOrShowStopAction() {
        let taskID = UUID()
        let runID = UUID()
        let loaded = [
            p4cEvent(.taskCreated, taskID: taskID, runID: runID, sequence: 0, title: "开始"),
            p4cEvent(.taskSucceeded, taskID: taskID, runID: runID, sequence: 1, title: "任务已完成"),
            p4cEvent(.stepStarted, taskID: taskID, runID: runID, sequence: 2, title: "迟到运行", stepID: "late"),
        ]
        let store = AgentTaskActivityStore(persistence: nil)

        store.hydrate(loaded)

        let task = store.task(id: taskID)
        XCTAssertEqual(task?.status, .succeeded)
        XCTAssertTrue(store.activeTasks.isEmpty)
        XCTAssertEqual(task?.latestRun?.events.map(\.kind), [.taskCreated, .taskSucceeded])
        XCTAssertEqual(task?.latestRun?.userVisibleEvents.map(\.presentation.title), ["已完成"])
        XCTAssertEqual(task?.latestRun?.canShowStopAction, false)
    }

    func testOrdinaryRunningActivityDoesNotExposeSchedulerInternals() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p4cEvent(.taskCreated, taskID: taskID, runID: runID, sequence: 0, title: "现在几点？", detail: "running"),
            p4cEvent(.executionStarted, taskID: taskID, runID: runID, sequence: 1, title: "任务开始执行", detail: "schedulerStart"),
            p4cEvent(.modelRequestStarted, taskID: taskID, runID: runID, sequence: 2, title: "模型请求开始", detail: "providerResponseReceived")
        ]

        let run = AgentTaskActivityReducer.reduceRun(events: events)
        let rendered = run.userVisibleEvents
        let joined = rendered
            .flatMap { [$0.presentation.title, $0.presentation.detail].compactMap { $0 } }
            .joined(separator: " ")

        XCTAssertEqual(rendered.map(\.presentation.title), ["正在生成回复……"])
        XCTAssertFalse(joined.contains("schedulerStart"))
        XCTAssertFalse(joined.contains("running"))
        XCTAssertFalse(joined.contains("现在几点？"))
        XCTAssertFalse(joined.contains("providerResponseReceived"))
        XCTAssertTrue(run.canShowStopAction)
    }

    func testRetryKeepsTaskIDAndCreatesSeparateRuns() {
        let taskID = UUID()
        let firstRun = UUID()
        let retryRun = UUID()
        let snapshot = AgentTaskActivityReducer.reduce(taskID: taskID, events: [
            p4cEvent(.taskCreated, taskID: taskID, runID: firstRun, sequence: 0, title: "开始"),
            p4cEvent(.taskFailed, taskID: taskID, runID: firstRun, sequence: 1, title: "失败", category: .toolFailed),
            p4cEvent(.taskCreated, taskID: taskID, runID: retryRun, sequence: 0, title: "重试"),
            p4cEvent(.taskSucceeded, taskID: taskID, runID: retryRun, sequence: 1, title: "完成"),
        ])

        XCTAssertEqual(snapshot.taskID, taskID)
        XCTAssertEqual(snapshot.runs.count, 2)
        XCTAssertEqual(snapshot.latestRun?.runID, retryRun)
        XCTAssertEqual(snapshot.status, .succeeded)
    }

    func testPersistenceRoundTripCorruptionUnknownEnumAndInterruptedHydration() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("p4c-\(UUID().uuidString)", isDirectory: true)
        let url = dir.appendingPathComponent("activity.jsonl")
        let store = JSONLAgentTaskActivityEventStore(fileURL: url)
        let taskID = UUID()
        let runID = UUID()
        try await store.append(p4cEvent(.taskCreated, taskID: taskID, runID: runID, sequence: 0, title: "开始"))
        try await store.append(p4cEvent(.stepStarted, taskID: taskID, runID: runID, sequence: 1, title: "运行中", stepID: "step_1"))
        let unknownLine = #"{"schemaVersion":1,"eventID":"\#(UUID().uuidString)","taskID":"\#(taskID.uuidString)","runID":"\#(runID.uuidString)","sequenceNumber":2,"timestamp":"2026-07-13T00:00:00Z","kind":"futureKind","presentation":{"title":"future"}}"#
        try FileHandle(forWritingTo: url).p4cAppendLine("not json")
        try FileHandle(forWritingTo: url).p4cAppendLine(unknownLine)

        let loaded = try await store.loadEvents()
        XCTAssertEqual(loaded.count, 3)
        XCTAssertTrue(loaded.contains { $0.kind == .unknown })

        await MainActor.run {
            let activity = AgentTaskActivityStore(persistence: nil)
            activity.hydrate(loaded, markInterruptedAt: Date(timeIntervalSince1970: 1))
            XCTAssertEqual(activity.task(id: taskID)?.status, .failed)
            XCTAssertEqual(activity.task(id: taskID)?.latestRun?.failureCategory, .interrupted)
        }
    }

    @MainActor
    func testRetentionLimitAndRemoval() {
        let store = AgentTaskActivityStore(persistence: nil, maxTaskCount: 2, maxEventsPerTask: 3)
        let taskIDs = [UUID(), UUID(), UUID()]
        for index in 0..<3 {
            let runID = UUID()
            for sequence in 0..<5 {
                store.append(p4cEvent(sequence == 4 ? .taskSucceeded : .stepStarted,
                                      taskID: taskIDs[index],
                                      runID: runID,
                                      sequence: sequence,
                                      title: "任务 \(index)-\(sequence)",
                                      timestamp: Date(timeIntervalSince1970: TimeInterval(index * 10 + sequence)),
                                      stepID: "step_\(sequence)"))
            }
        }

        XCTAssertEqual(store.tasks.count, 2)
        XCTAssertNil(store.task(id: taskIDs[0]))
        let remaining = store.tasks.first!
        XCTAssertLessThanOrEqual(remaining.latestRun?.events.count ?? 0, 3)
        store.remove(taskID: remaining.taskID)
        XCTAssertNil(store.task(id: remaining.taskID))
    }

    func testPrivacyRedactionRemovesSecretsReasoningRawJSONAndPrivateCalendarFields() {
        let taskID = UUID()
        let runID = UUID()
        let fixtureBearer = "Bearer " + String(repeating: "fixture", count: 5)
        let fixtureEmail = ["person", "example.invalid"].joined(separator: "@")
        let fixtureUserPath = "/" + ["Users", "fixture-user", "private"].joined(separator: "/")
        let event = p4cEvent(.stepStarted,
                             taskID: taskID,
                             runID: runID,
                             sequence: 0,
                             title: ["Authorization:", fixtureBearer,
                                     #"calendar title: Secret Meeting {"include_all_day":true}"#]
                                 .joined(separator: " "),
                             detail: "reasoning_content " + "sk-" + "fixture-value " + fixtureEmail + " " + fixtureUserPath,
                             stepID: "step_1")

        let combined = event.presentation.title + " " + (event.presentation.detail ?? "")

        XCTAssertFalse(combined.contains("Secret Meeting"))
        XCTAssertFalse(combined.contains("include_all_day"))
        XCTAssertFalse(combined.contains("sk-"))
        XCTAssertFalse(combined.contains("reasoning_content"))
        XCTAssertFalse(combined.contains(fixtureEmail))
        XCTAssertFalse(combined.contains(fixtureUserPath))
    }

    func testRuntimeEmitsMinimumActivityForOrdinaryFinalAndRetryKeepsTaskID() async {
        let runtime = PetAgentRuntimeCoordinator(
            context: P4CContextBuilder(),
            model: P4CDecisionModel(decision: .respond(ConversationResponseDecision(text: "你好"))),
            conversation: P4CConversationProvider(),
            gate: P4CGate(),
            executor: P4CToolExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))

        let retryTaskID = UUID()
        let message = UserMessageEvent(conversationID: UUID(),
                                       text: "你好",
                                       retryOfTaskID: retryTaskID)
        var outputs: [PetAgentRuntimeOutput] = []
        for await output in runtime.handle(.userMessage(message)) {
            outputs.append(output)
        }

        let activities = outputs.compactMap { output -> AgentTaskActivityEvent? in
            guard case .taskActivity(let event) = output else { return nil }
            return event
        }
        let started = outputs.compactMap { output -> (UUID, UUID)? in
            guard case .taskStarted(let taskID, let runID, _) = output else { return nil }
            return (taskID, runID)
        }.first

        XCTAssertEqual(started?.0, retryTaskID)
        XCTAssertNotEqual(started?.1, retryTaskID)
        XCTAssertTrue(activities.contains { $0.kind == .taskCreated && $0.taskID == retryTaskID })
        XCTAssertTrue(activities.contains { $0.kind == .taskSucceeded && $0.taskID == retryTaskID })
    }
}

private func p4cEvent(_ kind: AgentTaskEventKind,
                      eventID: UUID = UUID(),
                      taskID: UUID,
                      runID: UUID,
                      sequence: Int,
                      title: String,
                      detail: String? = nil,
                      timestamp: Date? = nil,
                      stepID: String? = nil,
                      toolID: String? = nil,
                      category: AgentTaskFailureCategory? = nil) -> AgentTaskActivityEvent {
    AgentTaskActivityEvent(eventID: eventID,
                           taskID: taskID,
                           runID: runID,
                           sequenceNumber: sequence,
                           timestamp: timestamp ?? Date(timeIntervalSince1970: TimeInterval(sequence)),
                           kind: kind,
                           presentation: AgentTaskEventPresentation(title: title, detail: detail),
                           stepID: stepID,
                           toolID: toolID.map(ToolID.init(rawValue:)),
                           failureCategory: category)
}

private extension FileHandle {
    func p4cAppendLine(_ line: String) throws {
        try seekToEnd()
        try write(contentsOf: Data((line + "\n").utf8))
        try close()
    }
}

private struct P4CContextBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event { return AgentContext(userText: message.text) }
        return AgentContext()
    }
}

private struct P4CDecisionModel: StructuredDecisionProviding {
    var decision: AgentDecision
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: decision, decisionSource: .modelStructured, modelProvider: "p4c")
    }
}

private struct P4CConversationProvider: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.delta(sequence: 1, text: "ok"))
            continuation.yield(.completed(emotion: .neutral, viaCloud: false))
            continuation.finish()
        }
    }
}

private actor P4CGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .granted(CapabilityToken(raw: "token", taskID: taskID, expiresAt: .distantFuture))
    }
}

private actor P4CToolExecutor: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        ToolOutcome(ok: true, output: "ok")
    }
}
