import XCTest
import Foundation
@testable import PetAgentRuntime

final class P5AgentEventHubTests: XCTestCase {
    func testHubDeduplicatesAndDeliversToMultipleSubscribers() async {
        let hub = AgentEventHub()
        let (_, streamA) = await hub.subscribe()
        let (_, streamB) = await hub.subscribe()
        let taskID = UUID()
        let runID = UUID()
        let eventID = UUID()
        let event = AgentEventEnvelope(id: eventID,
                                       taskID: taskID,
                                       runID: runID,
                                       sequence: 1,
                                       source: .runtime,
                                       kind: .taskStarted,
                                       payload: .task(.init(title: "开始")))

        async let receivedA = p5FirstEvent(streamA)
        async let receivedB = p5FirstEvent(streamB)

        let firstAccepted = await hub.publish(event)
        let secondAccepted = await hub.publish(event)
        let firstReceived = await receivedA
        let secondReceived = await receivedB

        XCTAssertTrue(firstAccepted)
        XCTAssertFalse(secondAccepted)
        XCTAssertEqual(firstReceived?.id, eventID)
        XCTAssertEqual(secondReceived?.id, eventID)
        let recent = await hub.recentEvents(limit: 10)
        XCTAssertEqual(recent.filter { $0.id == eventID }.count, 1)
    }

    func testHubFiltersByTaskAndRun() async {
        let hub = AgentEventHub()
        let taskID = UUID()
        let runID = UUID()
        let otherTask = UUID()
        let (_, stream) = await hub.subscribe(taskID: taskID)
        async let received = p5FirstEvent(stream)

        await hub.publish(kind: .taskStarted, taskID: otherTask, runID: UUID(), sequence: 1, source: .runtime)
        await hub.publish(kind: .taskStarted, taskID: taskID, runID: runID, sequence: 1, source: .runtime)
        let filtered = await received

        let runEventCount = await hub.events(runID: runID).count
        let snapshot = await hub.currentSnapshot(taskID: taskID)
        XCTAssertEqual(filtered?.taskID, taskID)
        XCTAssertEqual(runEventCount, 1)
        XCTAssertEqual(snapshot?.latestKind, .taskStarted)
    }

    func testRedactorRemovesSecretsAuthorizationReasoningAndUserPaths() {
        let taskID = UUID()
        let fixtureBearer = "Bearer " + String(repeating: "fixture", count: 4)
        let fixtureAPIKey = "sk-" + "fixture-value"
        let fixtureUserPath = "/" + ["Users", "fixture-user", "private"].joined(separator: "/")
        let event = AgentEventEnvelope(
            taskID: taskID,
            runID: UUID(),
            sequence: 1,
            source: .provider,
            visibility: .diagnostic,
            kind: .providerRequestFailed,
            payload: .diagnostic(.init(
                category: "provider",
                safeSummary: "Authorization: " + fixtureBearer + " " + fixtureAPIKey + " reasoning_content: hidden " + fixtureUserPath,
                details: ["api_key": fixtureAPIKey, "Cookie": "session=secret"])))

        let encoded = String(data: try! JSONEncoder().encode(AgentEventRedactor.redact(event, level: .diagnostic)),
                             encoding: .utf8) ?? ""

        XCTAssertFalse(encoded.contains(fixtureAPIKey))
        XCTAssertFalse(encoded.contains(fixtureBearer))
        XCTAssertFalse(encoded.contains("session=secret"))
        XCTAssertFalse(encoded.contains(fixtureUserPath))
        XCTAssertFalse(encoded.contains("hidden"))
    }
}

final class P5AgentRunEventStoreTests: XCTestCase {
    func testRunEventStoreAppendLoadSkipsCorruptionAndDeleteTask() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("p5-events-\(UUID().uuidString)", isDirectory: true)
        let store = AgentRunEventStore(baseDirectory: dir)
        let taskID = UUID()
        let runID = UUID()
        let first = p5Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1)
        let second = p5Event(.toolSucceeded, taskID: taskID, runID: runID, sequence: 2,
                             payload: .tool(.init(toolID: "get_current_datetime",
                                                  displayName: "本地时间",
                                                  safeSummary: "ok")))

        try await store.append(first)
        try await store.append(second)
        let file = dir.appendingPathComponent(taskID.uuidString, isDirectory: true)
            .appendingPathComponent(runID.uuidString)
            .appendingPathExtension("jsonl")
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("not-json\n".utf8))
        try handle.close()

        let loaded = try await store.loadEvents(taskID: taskID)
        XCTAssertEqual(loaded.map(\.sequence), [1, 2])
        let runEventCount = try await store.loadEvents(runID: runID).count
        XCTAssertEqual(runEventCount, 2)

        try await store.deleteEvents(taskID: taskID)
        let afterDelete = try await store.loadEvents(taskID: taskID)
        XCTAssertTrue(afterDelete.isEmpty)
    }
}

final class P5AgentActivityReducerTests: XCTestCase {
    func testToolLifecycleAggregatesIntoSingleActivityItem() {
        let taskID = UUID()
        let runID = UUID()
        let executionID = UUID()
        let events = [
            p5ToolEvent(.toolRequested, taskID: taskID, runID: runID, sequence: 1, executionID: executionID),
            p5ToolEvent(.toolValidated, taskID: taskID, runID: runID, sequence: 2, executionID: executionID),
            p5ToolEvent(.toolStarted, taskID: taskID, runID: runID, sequence: 3, executionID: executionID),
            p5ToolEvent(.toolSucceeded, taskID: taskID, runID: runID, sequence: 4, executionID: executionID)
        ]

        let items = AgentActivityReducer.reduce(events: events, visibility: .diagnostic)

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.status, .succeeded)
        XCTAssertEqual(items.first?.title, "已获取本地日期和时间")
        XCTAssertEqual(items.first?.details.count, 4)
    }

    func testUserModeAggregatesDateToolTimelineWithoutInternalEvents() {
        let taskID = UUID()
        let runID = UUID()
        let executionID = UUID()
        let events = [
            p5Event(.taskStarted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 1,
                    payload: .task(.init(title: "今天是几号？", status: "running"))),
            p5Event(.runStarted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 2,
                    payload: .run(.init(reason: "schedulerStart"))),
            p5Event(.modelRequestStarted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 3,
                    payload: .model(.init(safeSummary: "正在判断下一步"))),
            p5ToolEvent(.toolStarted, taskID: taskID, runID: runID, sequence: 4, executionID: executionID),
            p5ToolEvent(.toolSucceeded, taskID: taskID, runID: runID, sequence: 5, executionID: executionID),
            p5Event(.modelResponseStreaming,
                    taskID: taskID,
                    runID: runID,
                    sequence: 6,
                    payload: .model(.init(safeSummary: "正在生成最终答复"))),
            p5Event(.modelResponseCompleted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 7,
                    payload: .model(.init(safeSummary: "最终答复已生成"))),
            p5Event(.taskSucceeded,
                    taskID: taskID,
                    runID: runID,
                    sequence: 8,
                    payload: .task(.init(title: "任务已完成", status: "succeeded")))
        ]

        let items = AgentActivityReducer.reduce(events: events)
        let titles = items.map(\.title)

        XCTAssertEqual(titles, ["正在获取本地日期和时间…", "已获取本地日期和时间", "已完成"])
        XCTAssertFalse(titles.contains("schedulerStart"))
        XCTAssertFalse(titles.contains("running"))
        XCTAssertFalse(titles.contains("今天是几号？"))
        XCTAssertFalse(titles.contains("正在判断下一步"))
        XCTAssertFalse(titles.contains("正在生成最终答复"))
        XCTAssertFalse(titles.contains("最终答复已生成"))
    }

    func testUserModeAggregatesOrdinaryChatToSingleTerminalItem() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p5Event(.taskStarted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 1,
                    payload: .task(.init(title: "你好", status: "running"))),
            p5Event(.runStarted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 2,
                    payload: .run(.init(reason: "schedulerStart"))),
            p5Event(.modelRequestStarted,
                    taskID: taskID,
                    runID: runID,
                    sequence: 3,
                    payload: .model(.init(safeSummary: "正在判断下一步"))),
            p5Event(.modelResponseStreaming,
                    taskID: taskID,
                    runID: runID,
                    sequence: 4,
                    payload: .model(.init(safeSummary: "正在生成最终答复"))),
            p5Event(.taskSucceeded,
                    taskID: taskID,
                    runID: runID,
                    sequence: 5,
                    payload: .task(.init(title: "任务已完成", status: "succeeded")))
        ]

        let items = AgentActivityReducer.reduce(events: events)

        XCTAssertEqual(items.map(\.title), ["已完成"])
        XCTAssertFalse(items.map(\.title).contains("schedulerStart"))
        XCTAssertFalse(items.map(\.title).contains("running"))
        XCTAssertFalse(items.map(\.title).contains("你好"))
    }

    func testActivityReducerDoesNotExposeReasoningOrSecretInDiagnosticMode() {
        let taskID = UUID()
        let event = p5Event(.toolFailed,
                            taskID: taskID,
                            runID: UUID(),
                            sequence: 1,
                            payload: .tool(.init(toolID: "run_command",
                                                 displayName: "Authorization: Bearer abcdefghijklmnop",
                                                 safeSummary: "reasoning_content: hidden sk-abcdefghijklmnop",
                                                 errorCategory: "failed")))

        let rendered = AgentActivityReducer.reduce(events: [event], visibility: .diagnostic)
        let combined = String(data: try! JSONEncoder().encode(rendered), encoding: .utf8) ?? ""

        XCTAssertFalse(combined.contains("sk-"))
        XCTAssertFalse(combined.contains("Bearer abcdefghijklmnop"))
        XCTAssertFalse(combined.contains("hidden"))
        XCTAssertFalse(combined.contains("reasoning_content"))
    }
}

final class P5AgentReplayAndExportTests: XCTestCase {
    func testReplaySeekFailureAndFiltersAreDeterministic() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p5Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p5ToolEvent(.toolStarted, taskID: taskID, runID: runID, sequence: 2, executionID: UUID()),
            p5Event(.toolFailed, taskID: taskID, runID: runID, sequence: 3,
                    payload: .tool(.init(toolID: "get_current_datetime",
                                         displayName: "本地时间",
                                         errorCategory: "timeout",
                                         retryable: true)))
        ]

        let replay = AgentTimelineReplayState(taskID: taskID, runID: runID, events: events)
        XCTAssertEqual(replay.jumpToFailure().visibleEvents.last?.kind, .toolFailed)
        XCTAssertEqual(replay.withFilter(.toolsOnly).filteredEvents.map(\.kind), [.toolStarted, .toolFailed])
        XCTAssertEqual(replay.failureFocus()?.category, "timeout")
        XCTAssertEqual(AgentTimelineReplayState(taskID: taskID, events: events).allEvents.map(\.sequence), [1, 2, 3])
    }

    func testDiagnosticExportDoesNotContainSecretsOrReasoning() throws {
        let taskID = UUID()
        let events = [
            p5Event(.providerRequestFailed,
                    taskID: taskID,
                    runID: UUID(),
                    sequence: 1,
                    payload: .diagnostic(.init(category: "provider",
                                               safeSummary: "Authorization: Bearer abcdefghijklmnop reasoning_content: hidden sk-abcdefghijklmnop Cookie: abc")))
        ]
        let report = AgentDiagnosticExporter.report(taskID: taskID, events: events, providerKind: "minimax", modelID: "model")
        let json = String(data: try AgentDiagnosticExporter.export(report, format: .json), encoding: .utf8) ?? ""
        let markdown = String(data: try AgentDiagnosticExporter.export(report, format: .markdown), encoding: .utf8) ?? ""

        for output in [json, markdown] {
            XCTAssertFalse(output.contains("sk-abcdefghijklmnop"))
            XCTAssertFalse(output.contains("Bearer abcdefghijklmnop"))
            XCTAssertFalse(output.contains("hidden"))
            XCTAssertFalse(output.contains("Cookie: abc"))
        }
    }
}

final class P5AgentTaskSchedulerTests: XCTestCase {
    func testPriorityAndConcurrencyLimit() async {
        let scheduler = AgentTaskScheduler(maxConcurrent: 1)
        let low = await scheduler.submit(AgentTaskSubmission(title: "低", priority: .background))
        let high = await scheduler.submit(AgentTaskSubmission(title: "高", priority: .userInteractive))

        let started = await scheduler.startAvailable()

        XCTAssertEqual(started.map(\.taskID), [high.taskID])
        let snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.records.first { $0.taskID == low.taskID }?.status, .queued)
    }

    func testResourceWriteLocksSerializeAndCancelReleases() async {
        let scheduler = AgentTaskScheduler(maxConcurrent: 2)
        let semantics = AgentToolExecutionSemantics(
            sideEffectLevel: .localWrite,
            resourceAccess: [.init(key: .file("/tmp/a.txt"), mode: .write)])
        let first = await scheduler.submit(AgentTaskSubmission(title: "写 A", semantics: semantics))
        let second = await scheduler.submit(AgentTaskSubmission(title: "写 B", semantics: semantics))

        let firstStart = await scheduler.startAvailable()
        XCTAssertEqual(firstStart.count, 1)
        XCTAssertEqual(firstStart.first?.taskID, first.taskID)
        var snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.records.first { $0.taskID == second.taskID }?.status, .waitingForResource)

        await scheduler.cancel(taskID: first.taskID)
        let secondStart = await scheduler.startAvailable()
        XCTAssertEqual(secondStart.map(\.taskID), [second.taskID])
        snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.records.first { $0.taskID == first.taskID }?.status, .cancelled)
    }

    func testPermissionWaitingDoesNotConsumeExecutionSlot() async {
        let scheduler = AgentTaskScheduler(maxConcurrent: 1)
        let permissionTask = await scheduler.submit(AgentTaskSubmission(title: "需要权限"))
        await scheduler.waitForPermission(taskID: permissionTask.taskID, permissions: ["calendar.read"])
        let other = await scheduler.submit(AgentTaskSubmission(title: "普通任务"))

        let started = await scheduler.startAvailable()

        XCTAssertEqual(started.map(\.taskID), [other.taskID])
    }

    func testRetryCreatesNewRunAndKeepsTaskID() async {
        let scheduler = AgentTaskScheduler(maxConcurrent: 1)
        let submission = await scheduler.submit(AgentTaskSubmission(title: "重试任务"))
        let originalRunID = submission.runID
        _ = await scheduler.startAvailable()
        await scheduler.fail(taskID: submission.taskID, errorCategory: "fatal", safeSummary: "failed")
        let retry = await scheduler.retry(taskID: submission.taskID, reason: "manual")

        XCTAssertEqual(retry?.taskID, submission.taskID)
        XCTAssertNotEqual(retry?.runID, originalRunID)
        XCTAssertEqual(retry?.retryCount, 1)
    }

    func testRuntimePartialCompletionEmitsPartialEventNotFailure() async {
        let hub = AgentEventHub()
        let scheduler = AgentTaskScheduler(maxConcurrent: 1, eventHub: hub)
        let submission = await scheduler.submit(AgentTaskSubmission(title: "部分完成任务"))
        _ = await scheduler.startAvailable()

        await scheduler.partiallyCompleteFromRuntime(taskID: submission.taskID,
                                                     failureCategory: "partialSuccess",
                                                     safeSummary: "任务部分完成")

        let events = await hub.events(taskID: submission.taskID)
        XCTAssertTrue(events.contains { $0.kind == .taskPartiallySucceeded })
        XCTAssertFalse(events.contains { $0.kind == .taskFailed || $0.kind == .runFailed })
        let snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.records.first { $0.taskID == submission.taskID }?.status, .succeeded)
    }

    func testInterruptedRecoveryDistinguishesIdempotentReadAndExternalWrite() async {
        let scheduler = AgentTaskScheduler(maxConcurrent: 2)
        let read = await scheduler.submit(AgentTaskSubmission(title: "读",
                                                             semantics: AgentToolExecutionSemantics(idempotency: .idempotent,
                                                                                                    sideEffectLevel: .none)))
        let write = await scheduler.submit(AgentTaskSubmission(title: "写",
                                                              semantics: AgentToolExecutionSemantics(idempotency: .nonIdempotent,
                                                                                                     sideEffectLevel: .externalWrite)))
        _ = await scheduler.startAvailable()

        let recovered = await scheduler.recoverInterruptedOnLaunch()

        XCTAssertEqual(Set(recovered.map(\.taskID)), Set([read.taskID, write.taskID]))
        let snapshot = await scheduler.snapshot()
        XCTAssertEqual(snapshot.records.first { $0.taskID == read.taskID }?.status, .interrupted)
        XCTAssertEqual(snapshot.records.first { $0.taskID == write.taskID }?.status, .waitingForUser)
    }
}

private func p5Event(_ kind: AgentEventKind,
                     taskID: UUID,
                     runID: UUID,
                     sequence: UInt64,
                     payload: AgentEventPayload = .empty) -> AgentEventEnvelope {
    AgentEventEnvelope(taskID: taskID,
                       runID: runID,
                       sequence: sequence,
                       timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)),
                       source: .runtime,
                       kind: kind,
                       payload: payload)
}

private func p5ToolEvent(_ kind: AgentEventKind,
                         taskID: UUID,
                         runID: UUID,
                         sequence: UInt64,
                         executionID: UUID) -> AgentEventEnvelope {
    p5Event(kind,
            taskID: taskID,
            runID: runID,
            sequence: sequence,
            payload: .tool(.init(toolID: "get_current_datetime",
                                 toolCallID: "call_1",
                                 toolExecutionID: executionID,
                                 displayName: "本地时间",
                                 safeSummary: "ok",
                                 resultCategory: kind == .toolSucceeded ? "success" : nil)))
}

private func p5FirstEvent(_ stream: AsyncStream<AgentEventEnvelope>) async -> AgentEventEnvelope? {
    var iterator = stream.makeAsyncIterator()
    return await iterator.next()
}
