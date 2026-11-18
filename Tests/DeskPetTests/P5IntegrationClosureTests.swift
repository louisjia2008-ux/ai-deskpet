import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

@MainActor
final class P5IntegrationClosureTests: XCTestCase {
    func testActivityStoreProjectsLiveEventHubEvents() async {
        let hub = AgentEventHub()
        let store = AgentTaskActivityStore(persistence: nil, eventHub: hub, runEventStore: nil)
        let taskID = UUID()
        let runID = UUID()
        let conversationID = UUID()
        let messageID = UUID()

        await hub.publish(AgentEventEnvelope(
            taskID: taskID,
            runID: runID,
            sequence: 1,
            source: .scheduler,
            kind: .taskQueued,
            payload: .task(.init(title: "从 EventHub 投影",
                                 status: "queued",
                                 conversationID: conversationID,
                                 userMessageID: messageID,
                                 origin: AgentTaskOrigin.chat.rawValue))))

        await p5ClosureWaitUntil { store.task(id: taskID) != nil }

        let run = store.task(id: taskID)?.latestRun
        XCTAssertEqual(run?.origin, .chat)
        XCTAssertEqual(run?.conversationID, conversationID)
        XCTAssertEqual(run?.userMessageID, messageID)
        XCTAssertEqual(run?.events.count, 1)
    }

    func testActivityStoreDeduplicatesHydratedAndLiveEventsByEventID() async {
        let hub = AgentEventHub()
        let eventID = UUID()
        let taskID = UUID()
        let runID = UUID()
        let event = AgentTaskActivityEvent(eventID: eventID,
                                           taskID: taskID,
                                           runID: runID,
                                           sequenceNumber: 1,
                                           kind: .taskQueued,
                                           presentation: .init(title: "同一个事件"),
                                           source: .scheduler,
                                           origin: .scheduled)
        let store = AgentTaskActivityStore(persistence: nil, eventHub: hub, runEventStore: nil)
        store.hydrate([event])

        await hub.publish(AgentEventEnvelope(activityEvent: event))
        await p5ClosureWaitUntil { store.task(id: taskID)?.latestRun?.events.count == 1 }

        XCTAssertEqual(store.task(id: taskID)?.latestRun?.events.count, 1)
    }

    func testChatModelSubmitsThroughSchedulerAndRuntimeUsesSchedulerIDs() async {
        let activityStore = AgentTaskActivityStore(persistence: nil, runEventStore: nil)
        let scheduler = AgentTaskScheduler(maxConcurrent: 1, eventHub: activityStore.eventHub)
        let memory = MemoryModel(store: MemoryStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("p5-closure-memory-\(UUID().uuidString).json")))
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                                  repository: JSONMemoryRepository(memory))
        let chatStore = ChatStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("p5-closure-chat-\(UUID().uuidString).json"))
        let chat = ChatModel(runtime: p5Coordinator(conversation: P5FakeConversation(reply: "done")),
                             services: services,
                             store: chatStore,
                             activityStore: activityStore,
                             scheduler: scheduler)

        chat.send("告诉我现在的本地日期和时间。")
        await p5ClosureWaitUntil { !chat.busy && chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed } }

        let schedulerSnapshot = await scheduler.snapshot()
        let records = schedulerSnapshot.records
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records.first?.status, .succeeded)
        XCTAssertEqual(records.first?.origin, .chat)
        let assistant = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(assistant?.taskID, records.first?.taskID)
        XCTAssertEqual(assistant?.attemptID, records.first?.runID)
        await p5ClosureWaitUntil { activityStore.task(id: records[0].taskID)?.latestRun?.runID == records[0].runID }
        XCTAssertEqual(activityStore.task(id: records[0].taskID)?.latestRun?.origin, .chat)
    }

    func testChineseDateTimeChatExecutesRequiredToolOnceAndCommitsOneAssistantMessage() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let (chat, scheduler, activityStore) = p5RoutingChat(
            model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
            platform: platform)

        chat.send("告诉我现在的本地日期和时间。")

        await p5ClosureWaitUntil { !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1 }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .succeeded
        }
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].status, .succeeded)
        XCTAssertEqual(records[0].origin, .chat)
        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 1)

        let userMessages = chat.conversation.messages.filter { $0.role == .user }
        let assistantMessages = chat.conversation.messages.filter { $0.role == .pet }
        let activityMessages = chat.conversation.messages.p5ActivityMessages
        XCTAssertEqual(userMessages.count, 1)
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertEqual(activityMessages.count, 1)
        XCTAssertEqual(chat.conversation.messages.map(\.role), [.user, .activity, .pet])
        XCTAssertEqual(assistantMessages.first?.status, .completed)
        XCTAssertEqual(assistantMessages.first?.taskID, records[0].taskID)
        XCTAssertEqual(assistantMessages.first?.attemptID, records[0].runID)
        let activityMessage = try XCTUnwrap(activityMessages.first)
        XCTAssertEqual(activityMessage.status, .completed)
        XCTAssertEqual(activityMessage.taskID, records[0].taskID)
        XCTAssertEqual(activityMessage.attemptID, records[0].runID)
        let activity = try XCTUnwrap(activityMessage.activity)
        XCTAssertEqual(activity.taskID, records[0].taskID)
        XCTAssertEqual(activity.runID, records[0].runID)
        XCTAssertEqual(activity.status, .succeeded)
        XCTAssertEqual(activity.tools.map(\.toolID), ["get_current_datetime"])
        XCTAssertEqual(activity.tools.map(\.displayName), ["本地日期和时间"])
        XCTAssertTrue(activity.summary.contains("本地日期和时间"))
        XCTAssertFalse(activity.p5RenderedText.contains("schedulerStart"))
        XCTAssertFalse(activity.p5RenderedText.contains("running"))
        XCTAssertFalse(activity.p5RenderedText.contains("reasoning"))
        XCTAssertFalse(activity.p5RenderedText.contains("{"))

        await p5ClosureWaitUntil {
            activityStore.task(id: records[0].taskID)?.latestRun?.events.contains {
                $0.kind == .stepSucceeded && $0.toolID?.rawValue == "get_current_datetime"
            } == true
        }
        let run = try XCTUnwrap(activityStore.task(id: records[0].taskID)?.latestRun)
        XCTAssertEqual(run.events.filter {
            $0.kind == .stepSucceeded && $0.toolID?.rawValue == "get_current_datetime"
        }.count, 1)
        XCTAssertEqual(run.events.filter { $0.kind == .taskSucceeded }.count, 1)
        let firstRunActive = await scheduler.hasActiveRun(runID: records[0].runID)
        XCTAssertFalse(firstRunActive)
        XCTAssertNil(chat.activeTaskActivity)
    }

    func testStopGeneratingSynchronizesCancelledActivityBubble() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerSlowCurrentDateTimeTool()
        let (chat, _, activityStore) = p5RoutingChat(
            model: P5RespondModel(text: "不会生成最终回答。"),
            platform: platform)

        chat.send("告诉我现在的本地日期和时间。")
        await p5ClosureWaitUntil({
            chat.busy && chat.conversation.messages.p5ActivityMessages.contains { $0.status == .pending }
        }, timeout: 3)

        chat.stopGenerating()
        await p5ClosureWaitUntil({
            activityStore.latestTask(conversationID: chat.conversation.id)?.latestRun?.status == .cancelled
                && chat.conversation.messages.p5ActivityMessages.contains { $0.status == .cancelled }
        }, timeout: 3)

        XCTAssertEqual(activityStore.latestTask(conversationID: chat.conversation.id)?.latestRun?.status, .cancelled)
        XCTAssertTrue(chat.conversation.messages.p5ActivityMessages.contains { $0.status == .cancelled })
        XCTAssertFalse(chat.conversation.messages.p5ActivityMessages.contains { $0.status == .pending })
    }

    func testSequentialDateTimeMessagesCreateFreshRunsAndDoNotKeepOldLiveCard() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let (chat, scheduler, activityStore) = p5RoutingChat(
            model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
            platform: platform)

        chat.send("告诉我现在的本地日期和时间。")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1
        }
        let firstRecords = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .succeeded
        }
        let first = try XCTUnwrap(firstRecords.first)
        let firstRunActive = await scheduler.hasActiveRun(runID: first.runID)
        XCTAssertFalse(firstRunActive)
        XCTAssertNil(chat.activeTaskActivity)

        chat.send("现在几点？")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 2
        }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 2 && records.allSatisfy { $0.status == .succeeded }
        }
        XCTAssertEqual(records.count, 2)
        let sorted = records.sorted { $0.submittedAt < $1.submittedAt }
        XCTAssertNotEqual(sorted[0].taskID, sorted[1].taskID)
        XCTAssertNotEqual(sorted[0].runID, sorted[1].runID)
        let oldRunActive = await scheduler.hasActiveRun(runID: sorted[0].runID)
        let newRunActive = await scheduler.hasActiveRun(runID: sorted[1].runID)
        XCTAssertFalse(oldRunActive)
        XCTAssertFalse(newRunActive)
        XCTAssertNil(chat.activeTaskActivity)

        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 2)
        let firstRun = try XCTUnwrap(activityStore.task(id: sorted[0].taskID)?.latestRun)
        let secondRun = try XCTUnwrap(activityStore.task(id: sorted[1].taskID)?.latestRun)
        XCTAssertEqual(firstRun.runID, sorted[0].runID)
        XCTAssertEqual(secondRun.runID, sorted[1].runID)
        XCTAssertEqual(firstRun.conversationID, chat.conversation.id)
        XCTAssertEqual(secondRun.conversationID, chat.conversation.id)
        XCTAssertEqual(firstRun.status, .succeeded)
        XCTAssertEqual(secondRun.status, .succeeded)
        XCTAssertFalse(firstRun.canShowStopAction)
        XCTAssertFalse(secondRun.canShowStopAction)

        let activityMessages = chat.conversation.messages.p5ActivityMessages
        XCTAssertEqual(activityMessages.count, 2)
        XCTAssertEqual(activityMessages.compactMap(\.attemptID), [sorted[0].runID, sorted[1].runID])
        XCTAssertEqual(activityMessages.compactMap(\.taskID), [sorted[0].taskID, sorted[1].taskID])
        XCTAssertTrue(activityMessages.allSatisfy { $0.status == .completed })
        XCTAssertEqual(activityMessages.compactMap { $0.activity?.tools.first?.toolID },
                       ["get_current_datetime", "get_current_datetime"])
        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .pet }.count, 2)
    }

    func testContextualSecondPrecisionFollowUpCreatesFreshDateTimeRun() async throws {
        let iso = ISO8601DateFormatter()
        let clock = TestClock(start: iso.date(from: "2026-07-14T01:02:03Z")!)
        let shanghai = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let (chat, scheduler, activityStore) = p5RoutingChat(
            model: P5ObservationEchoModel(fallbackText: "普通回复"),
            platform: platform,
            clock: clock,
            locale: Locale(identifier: "zh_CN"),
            timeZone: shanghai)

        chat.send("现在几点？")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1
        }
        let firstRecords = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .succeeded
        }
        let first = try XCTUnwrap(firstRecords.first)
        let firstRunActive = await scheduler.hasActiveRun(runID: first.runID)
        XCTAssertFalse(firstRunActive)
        XCTAssertNil(chat.activeTaskActivity)

        clock.advance(by: 7)
        chat.send("具体到秒")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 2
        }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 2 && records.allSatisfy { $0.status == .succeeded }
        }
        let sorted = records.sorted { $0.submittedAt < $1.submittedAt }
        XCTAssertEqual(sorted.count, 2)
        XCTAssertNotEqual(sorted[0].taskID, sorted[1].taskID)
        XCTAssertNotEqual(sorted[0].runID, sorted[1].runID)
        let oldRunActive = await scheduler.hasActiveRun(runID: sorted[0].runID)
        let newRunActive = await scheduler.hasActiveRun(runID: sorted[1].runID)
        XCTAssertFalse(oldRunActive)
        XCTAssertFalse(newRunActive)
        XCTAssertNil(chat.activeTaskActivity)

        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 2)
        let assistantMessages = chat.conversation.messages.filter { $0.role == .pet }
        XCTAssertEqual(assistantMessages.last?.taskID, sorted[1].taskID)
        XCTAssertEqual(assistantMessages.last?.attemptID, sorted[1].runID)
        XCTAssertTrue(assistantMessages.last?.text.contains("09:02:10") == true)

        let activityMessages = chat.conversation.messages.p5ActivityMessages
        XCTAssertEqual(activityMessages.count, 2)
        XCTAssertEqual(activityMessages.compactMap(\.taskID), [sorted[0].taskID, sorted[1].taskID])
        XCTAssertEqual(activityMessages.compactMap(\.attemptID), [sorted[0].runID, sorted[1].runID])
        XCTAssertEqual(activityMessages.compactMap { $0.activity?.tools.first?.toolID },
                       ["get_current_datetime", "get_current_datetime"])

        let secondRun = try XCTUnwrap(activityStore.task(id: sorted[1].taskID)?.latestRun)
        XCTAssertEqual(secondRun.runID, sorted[1].runID)
        XCTAssertEqual(secondRun.status, .succeeded)
        XCTAssertEqual(secondRun.events.filter {
            $0.kind == .stepSucceeded && $0.toolID?.rawValue == "get_current_datetime"
        }.count, 1)
        XCTAssertFalse(secondRun.canShowStopAction)
    }

    func testContextualSecondPrecisionFollowUpDoesNotSurviveTopicSwitch() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let (chat, scheduler, _) = p5RoutingChat(
            model: P5RespondModel(text: "普通回复"),
            platform: platform)

        chat.send("现在几点？")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1
        }
        chat.send("帮我总结这封邮件")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 2
        }
        chat.send("具体到秒")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 3
        }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 3 && records.allSatisfy { $0.status == .succeeded }
        }

        XCTAssertEqual(records.count, 3)
        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 1)
        XCTAssertEqual(chat.conversation.messages.p5ActivityMessages.count, 1)
    }

    func testContextualSecondPrecisionFollowUpAfterFailedDateTimeAttemptRetriesFreshRun() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        let (chat, scheduler, _) = p5RoutingChat(
            model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
            platform: platform)

        chat.send("现在几点？")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1
        }
        let failedRecords = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .failed
        }
        let failed = try XCTUnwrap(failedRecords.first)
        XCTAssertEqual(chat.conversation.messages.p5ActivityMessages.first?.activity?.status, .failed)

        try await platform.registerCurrentDateTimeTool()
        chat.send("具体到秒")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 2
        }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 2 && records.contains { $0.status == .succeeded }
        }
        let sorted = records.sorted { $0.submittedAt < $1.submittedAt }
        XCTAssertEqual(sorted.count, 2)
        XCTAssertEqual(sorted[0].taskID, failed.taskID)
        XCTAssertEqual(sorted[0].status, .failed)
        XCTAssertEqual(sorted[1].status, .succeeded)
        XCTAssertNotEqual(sorted[0].taskID, sorted[1].taskID)
        XCTAssertNotEqual(sorted[0].runID, sorted[1].runID)
        let failedRunActive = await scheduler.hasActiveRun(runID: sorted[0].runID)
        let retryRunActive = await scheduler.hasActiveRun(runID: sorted[1].runID)
        XCTAssertFalse(failedRunActive)
        XCTAssertFalse(retryRunActive)
        XCTAssertNil(chat.activeTaskActivity)
        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 1)

        let activityMessages = chat.conversation.messages.p5ActivityMessages
        XCTAssertEqual(activityMessages.count, 2)
        XCTAssertEqual(activityMessages.compactMap(\.taskID), [sorted[0].taskID, sorted[1].taskID])
        XCTAssertEqual(activityMessages.compactMap(\.attemptID), [sorted[0].runID, sorted[1].runID])
        XCTAssertEqual(activityMessages.compactMap { $0.activity?.status }, [.failed, .succeeded])
        XCTAssertEqual(activityMessages.compactMap { $0.activity?.tools.first?.toolID },
                       ["get_current_datetime", "get_current_datetime"])
    }

    func testActivityHistoryIsScopedToConversationAndSurvivesReload() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let chatURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("p5-activity-history-chat-\(UUID().uuidString).json")
        let (chat, scheduler, _) = p5RoutingChat(
            model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
            platform: platform,
            chatStoreURL: chatURL)

        chat.send("告诉我现在的本地日期和时间。")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.p5ActivityMessages.count == 1
        }
        let firstConversationID = chat.conversation.id
        let firstActivity = try XCTUnwrap(chat.conversation.messages.p5ActivityMessages.first?.activity)

        chat.newConversation(kind: .normal)
        chat.send("现在几点？")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.p5ActivityMessages.count == 1
        }
        let secondConversationID = chat.conversation.id
        let secondActivity = try XCTUnwrap(chat.conversation.messages.p5ActivityMessages.first?.activity)
        XCTAssertNotEqual(firstConversationID, secondConversationID)
        XCTAssertNotEqual(firstActivity.runID, secondActivity.runID)
        XCTAssertEqual(secondActivity.conversationID, secondConversationID)

        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 2 && records.allSatisfy { $0.status == .succeeded }
        }
        XCTAssertEqual(records.count, 2)

        let firstStored = try XCTUnwrap(chat.history.first { $0.id == firstConversationID })
        XCTAssertEqual(firstStored.messages.p5ActivityMessages.count, 1)
        XCTAssertEqual(firstStored.messages.p5ActivityMessages.first?.activity?.runID, firstActivity.runID)
        XCTAssertFalse(firstStored.messages.p5ActivityMessages.contains {
            $0.activity?.runID == secondActivity.runID
        })

        let reopenedActivityStore = AgentTaskActivityStore(persistence: nil, runEventStore: nil)
        let reopenedScheduler = AgentTaskScheduler(maxConcurrent: 1, eventHub: reopenedActivityStore.eventHub)
        let reopened = ChatModel(runtime: p5Coordinator(conversation: P5FakeConversation(reply: "unused")),
                                 services: p5ClosureServices(),
                                 store: ChatStore(fileURL: chatURL),
                                 activityStore: reopenedActivityStore,
                                 scheduler: reopenedScheduler)
        let reloadedFirst = try XCTUnwrap(reopened.history.first { $0.id == firstConversationID })
        XCTAssertEqual(reloadedFirst.messages.p5ActivityMessages.count, 1)
        XCTAssertEqual(reloadedFirst.messages.p5ActivityMessages.first?.activity?.tools.map(\.toolID),
                       ["get_current_datetime"])
        XCTAssertEqual(reloadedFirst.messages.p5ActivityMessages.first?.status, .completed)
    }

    func testRetryCreatesNewActivityRunWithoutOverwritingFailedRun() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        let (chat, scheduler, activityStore) = p5RoutingChat(
            model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
            platform: platform)

        chat.send("现在几点？")
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1
        }
        var records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .failed
        }
        let failedRecord = try XCTUnwrap(records.first)
        let failedActivity = try XCTUnwrap(chat.conversation.messages.p5ActivityMessages.first)
        XCTAssertEqual(failedActivity.status, .failed)
        XCTAssertEqual(failedActivity.taskID, failedRecord.taskID)
        XCTAssertEqual(failedActivity.attemptID, failedRecord.runID)
        let failedRun = try XCTUnwrap(activityStore.task(id: failedRecord.taskID)?.latestRun)
        XCTAssertEqual(failedRun.status, .failed)
        XCTAssertEqual(failedRun.runID, failedRecord.runID)

        try await platform.registerCurrentDateTimeTool()
        chat.retryTask(failedRecord.taskID)
        XCTAssertTrue(chat.busy)
        await p5ClosureWaitUntil {
            !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 2
        }
        records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .succeeded && records[0].retryCount == 1
        }
        let retryRecord = try XCTUnwrap(records.first)
        XCTAssertEqual(retryRecord.taskID, failedRecord.taskID)
        XCTAssertNotEqual(retryRecord.runID, failedRecord.runID)

        let activityMessages = chat.conversation.messages.p5ActivityMessages
        XCTAssertEqual(activityMessages.count, 2)
        XCTAssertEqual(activityMessages.compactMap(\.taskID), [failedRecord.taskID, retryRecord.taskID])
        XCTAssertEqual(activityMessages.compactMap(\.attemptID), [failedRecord.runID, retryRecord.runID])
        XCTAssertEqual(activityMessages.map(\.status), [.failed, .completed])
        XCTAssertEqual(activityMessages.first?.activity?.runID, failedRecord.runID)
        XCTAssertEqual(activityMessages.last?.activity?.runID, retryRecord.runID)
    }

    func testDateTimeIntentVariantsRouteThroughTrueChatEntryOnce() async throws {
        let phrases = [
            "今天是几号？",
            "请告诉我当前日期。",
            "今天星期几？",
            "现在几点？"
        ]

        for phrase in phrases {
            let prepared = RuntimeRequestPreparer.prepare(userText: phrase)
            XCTAssertEqual(prepared.inferredCapabilities, [.currentDateTime], phrase)
            XCTAssertEqual(prepared.requiredCapabilities, [.currentDateTime], phrase)
            XCTAssertEqual(prepared.executionMode, .boundedToolLoop, phrase)

            let platform = P5RoutingRecordingToolPlatform()
            try await platform.registerCurrentDateTimeTool()
            let (chat, scheduler, activityStore) = p5RoutingChat(
                model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
                platform: platform)

            chat.send(phrase)

            await p5ClosureWaitUntil {
                !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1
            }
            let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
                records.count == 1 && records[0].status == .succeeded
            }
            guard let record = records.first else {
                XCTFail("missing scheduler record for \(phrase)")
                continue
            }

            XCTAssertEqual(record.status, .succeeded, phrase)
            let executionCount = await platform.executionCount(for: "get_current_datetime")
            XCTAssertEqual(executionCount, 1, phrase)
            let requests = await platform.executionRequests(for: "get_current_datetime")
            XCTAssertEqual(requests.count, 1, phrase)

            let assistantMessages = chat.conversation.messages.filter { $0.role == .pet }
            XCTAssertEqual(assistantMessages.count, 1, phrase)
            XCTAssertEqual(assistantMessages.first?.status, .completed, phrase)
            XCTAssertEqual(assistantMessages.first?.taskID, record.taskID, phrase)
            XCTAssertEqual(assistantMessages.first?.attemptID, record.runID, phrase)
            let activityMessages = chat.conversation.messages.p5ActivityMessages
            XCTAssertEqual(activityMessages.count, 1, phrase)
            XCTAssertEqual(activityMessages.first?.activity?.runID, record.runID, phrase)
            XCTAssertEqual(activityMessages.first?.activity?.tools.map(\.toolID), ["get_current_datetime"], phrase)

            await p5ClosureWaitUntil {
                activityStore.task(id: record.taskID)?.latestRun?.status == .succeeded
            }
            let run = try XCTUnwrap(activityStore.task(id: record.taskID)?.latestRun, phrase)
            XCTAssertEqual(run.events.filter {
                $0.kind == .stepSucceeded && $0.toolID?.rawValue == "get_current_datetime"
            }.count, 1, phrase)
            XCTAssertEqual(run.events.filter { $0.kind == .taskSucceeded }.count, 1, phrase)
            XCTAssertEqual(run.userVisibleEvents.map(\.presentation.title),
                           ["正在获取本地日期和时间…", "已获取本地日期和时间", "已验证工具结果", "已完成"],
                           phrase)
            XCTAssertFalse(run.canShowStopAction, phrase)
        }
    }

    func testDateEditingRequestDoesNotTriggerCurrentDateTimeTool() async throws {
        XCTAssertEqual(RuntimeRequestPreparer.prepare(
            userText: "帮我把邮件里的日期格式改成 YYYY-MM-DD。"
        ).executionMode, .conversation)

        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let (chat, scheduler, activityStore) = p5RoutingChat(
            model: P5RespondModel(text: "可以，我会只处理邮件里的日期格式。"),
            platform: platform)

        chat.send("帮我把邮件里的日期格式改成 YYYY-MM-DD。")

        await p5ClosureWaitUntil { !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1 }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .succeeded
        }

        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 0)
        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .pet }.count, 1)
        XCTAssertTrue(chat.conversation.messages.p5ActivityMessages.isEmpty)
        if let record = records.first {
            await p5ClosureWaitUntil {
                activityStore.task(id: record.taskID)?.latestRun?.status == .succeeded
            }
            XCTAssertFalse(activityStore.task(id: record.taskID)?.latestRun?.events.contains {
                $0.toolID?.rawValue == "get_current_datetime"
            } ?? true)
        }
    }

    func testTrueChatEntryUsesInjectedPacificTimezoneWithChineseLocale() async throws {
        let iso = ISO8601DateFormatter()
        let clock = TestClock(start: iso.date(from: "2026-07-14T05:30:00Z")!)
        let pacific = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let platform = P5RoutingRecordingToolPlatform()
        try await platform.registerCurrentDateTimeTool()
        let (chat, scheduler, _) = p5RoutingChat(
            model: P5RespondModel(text: "已经根据工具结果生成最终回答。"),
            platform: platform,
            clock: clock,
            locale: Locale(identifier: "zh_CN"),
            timeZone: pacific)

        chat.send("今天是几号？")

        await p5ClosureWaitUntil { !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1 }
        _ = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .succeeded
        }
        let capturedResult = await platform.lastResult(for: "get_current_datetime")
        let result = try XCTUnwrap(capturedResult)
        let content = result.modelContent ?? ""

        XCTAssertEqual(result.structuredData.stringValue("localDate"), "2026-07-13")
        XCTAssertEqual(result.structuredData.stringValue("timeZoneIdentifier"), "America/Los_Angeles")
        XCTAssertEqual(result.structuredData.stringValue("utcOffset"), "-07:00")
        XCTAssertEqual(result.structuredData.stringValue("localeIdentifier"), "zh_CN")
        XCTAssertFalse(content.contains("北京时间"))
        XCTAssertFalse(content.contains("Asia/Shanghai"))
        XCTAssertFalse(content.contains("UTC+08:00"))
        XCTAssertFalse(content.contains("GMT+8"))
    }

    func testChineseDateTimeChatFailsWhenRequiredToolIsUnavailable() async throws {
        let platform = P5RoutingRecordingToolPlatform()
        let (chat, scheduler, activityStore) = p5RoutingChat(
            model: P5RespondModel(text: "我无法访问实时系统时间。"),
            platform: platform)

        chat.send("告诉我现在的本地日期和时间。")

        await p5ClosureWaitUntil { !chat.busy && chat.conversation.messages.filter { $0.role == .pet }.count == 1 }
        let records = await p5ClosureWaitForSchedulerRecords(scheduler) { records in
            records.count == 1 && records[0].status == .failed
        }
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].status, .failed)
        let executionCount = await platform.executionCount(for: "get_current_datetime")
        XCTAssertEqual(executionCount, 0)

        let assistantMessages = chat.conversation.messages.filter { $0.role == .pet }
        XCTAssertEqual(assistantMessages.count, 1)
        XCTAssertTrue(assistantMessages[0].text.contains("未能调用日期时间工具"))
        let activityMessages = chat.conversation.messages.p5ActivityMessages
        XCTAssertEqual(activityMessages.count, 1)
        XCTAssertEqual(activityMessages.first?.status, .failed)
        XCTAssertEqual(activityMessages.first?.activity?.status, .failed)
        XCTAssertEqual(activityMessages.first?.activity?.tools.map(\.toolID), ["get_current_datetime"])

        await p5ClosureWaitUntil {
            activityStore.task(id: records[0].taskID)?.latestRun?.events.contains {
                $0.kind == .taskFailed
            } == true
        }
        let run = try XCTUnwrap(activityStore.task(id: records[0].taskID)?.latestRun)
        XCTAssertEqual(run.events.filter { $0.kind == .taskSucceeded }.count, 0)
        XCTAssertEqual(run.events.filter { $0.kind == .taskFailed }.count, 1)
        XCTAssertTrue(run.events.contains {
            $0.kind == .stepFailed && $0.toolID?.rawValue == "get_current_datetime"
        })
    }

    func testMiniMaxM3OpenAICompatibleUsesNativeToolsWithoutManualCapabilityFlag() {
        let provider = ProviderConfig(displayName: "MiniMax",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://api.minimax.io")!,
                                      defaultModelID: "MiniMax-M3",
                                      capabilities: [.chat])

        XCTAssertEqual(ProviderToolCapabilityPolicy.capability(for: provider, modelID: "MiniMax-M3"),
                       .native)
    }

    func testSchedulerScheduledSubmissionProjectsOriginAndScheduleID() async {
        let hub = AgentEventHub()
        let store = AgentTaskActivityStore(persistence: nil, eventHub: hub, runEventStore: nil)
        let scheduler = AgentTaskScheduler(maxConcurrent: 1, eventHub: hub)
        let scheduleID = UUID()
        let submitted = await scheduler.submit(AgentTaskSubmission(title: "定时检查",
                                                                   scheduleID: scheduleID,
                                                                   origin: .scheduled,
                                                                   conversationID: UUID(),
                                                                   userMessageID: UUID()))
        _ = await scheduler.startAvailable()

        await p5ClosureWaitUntil { store.task(id: submitted.taskID)?.latestRun?.origin == .scheduled }

        let run = store.task(id: submitted.taskID)?.latestRun
        XCTAssertEqual(run?.origin, .scheduled)
        XCTAssertEqual(run?.scheduleID, scheduleID)
    }
}

final class P5TaskCenterProjectionTests: XCTestCase {
    func testTaskCenterProjectionKeepsOriginProviderAndModelMetadata() {
        let taskID = UUID()
        let runID = UUID()
        let events = [
            AgentTaskActivityEvent(eventEnvelope: AgentEventEnvelope(
                taskID: taskID,
                runID: runID,
                sequence: 1,
                source: .scheduler,
                kind: .taskQueued,
                payload: .task(.init(title: "Provider 任务",
                                     status: "queued",
                                     origin: AgentTaskOrigin.chat.rawValue)))),
            AgentTaskActivityEvent(eventEnvelope: AgentEventEnvelope(
                taskID: taskID,
                runID: runID,
                sequence: 2,
                source: .provider,
                kind: .providerResponseReceived,
                payload: .provider(.init(providerKind: "minimax",
                                         modelID: "abab6.5",
                                         httpStatus: 200,
                                         safeSummary: "ok"))))
        ]

        let snapshot = AgentTaskActivityReducer.reduce(taskID: taskID, events: events)

        XCTAssertEqual(snapshot.latestRun?.origin, .chat)
        XCTAssertEqual(snapshot.latestRun?.providerKind, "minimax")
        XCTAssertEqual(snapshot.latestRun?.modelID, "abab6.5")
    }
}

@MainActor
private func p5ClosureWaitUntil(_ predicate: @MainActor @escaping () -> Bool,
                                timeout: TimeInterval = 2.0) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if predicate() { return }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

@MainActor
private func p5RoutingChat(model: StructuredDecisionProviding,
                           platform: P5RoutingRecordingToolPlatform,
                           clock: RuntimeClock = WallClock(),
                           locale: Locale = .current,
                           timeZone: TimeZone = .current,
                           chatStoreURL: URL? = nil) -> (ChatModel, AgentTaskScheduler, AgentTaskActivityStore) {
    let activityStore = AgentTaskActivityStore(persistence: nil, runEventStore: nil)
    let scheduler = AgentTaskScheduler(maxConcurrent: 1, eventHub: activityStore.eventHub)
    let services = p5ClosureServices()
    let chatStore = ChatStore(fileURL: chatStoreURL ?? FileManager.default.temporaryDirectory
        .appendingPathComponent("p5-routing-chat-\(UUID().uuidString).json"))
    let runtime = PetAgentRuntimeCoordinator(
        context: P5FakeContext(),
        model: model,
        conversation: P5FakeConversation(reply: "unused"),
        gate: P5AllowAppGate(),
        executor: P5FakeExecutor(),
        policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
        toolCatalogProvider: platform,
        toolPlatformExecutor: platform,
        systemAuthorization: DefaultSystemAuthorizationPolicy(),
        clock: clock,
        localeProvider: { locale },
        timeZoneProvider: { timeZone })
    let chat = ChatModel(runtime: runtime,
                         services: services,
                         store: chatStore,
                         activityStore: activityStore,
                         scheduler: scheduler)
    return (chat, scheduler, activityStore)
}

@MainActor
private func p5ClosureServices() -> AIServices {
    let memory = MemoryModel(store: MemoryStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("p5-routing-memory-\(UUID().uuidString).json")))
    return AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                      repository: JSONMemoryRepository(memory))
}

private func p5ClosureWaitForSchedulerRecords(_ scheduler: AgentTaskScheduler,
                                               timeout: TimeInterval = 2.0,
                                               predicate: @escaping @Sendable ([AgentTaskQueueRecord]) -> Bool) async -> [AgentTaskQueueRecord] {
    let deadline = Date().addingTimeInterval(timeout)
    var records: [AgentTaskQueueRecord] = []
    while Date() < deadline {
        records = await scheduler.snapshot().records
        if predicate(records) { return records }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return records
}

private actor P5RoutingRecordingToolPlatform: ToolCatalogProviding, ToolPlatformExecuting {
    private let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
    private var executions: [AgentToolCallRequest] = []
    private var results: [(String, ToolExecutionResult)] = []

    func registerCurrentDateTimeTool() async throws {
        try await registry.registerAgentTool(AnyAgentTool(CurrentDateTimeAgentTool()))
    }

    func registerSlowCurrentDateTimeTool() async throws {
        try await registry.registerAgentTool(AnyAgentTool(P5SlowCurrentDateTimeAgentTool()))
    }

    func toolCatalogSnapshot(for policy: AgentPolicy) async -> ToolCatalogSnapshot {
        await registry.toolCatalogSnapshot(for: policy)
    }

    func executeTool(request: AgentToolCallRequest,
                     context: ToolExecutionContext) async -> Result<ToolExecutionResult, ToolPlatformError> {
        executions.append(request)
        let result = await registry.executeTool(request: request, context: context)
        if case .success(let value) = result {
            results.append((request.toolName, value))
        }
        return result
    }

    func executionCount(for toolName: String) -> Int {
        executions.filter { $0.toolName == toolName }.count
    }

    func executionRequests(for toolName: String) -> [AgentToolCallRequest] {
        executions.filter { $0.toolName == toolName }
    }

    func lastResult(for toolName: String) -> ToolExecutionResult? {
        results.last { $0.0 == toolName }?.1
    }
}

private struct P5SlowCurrentDateTimeAgentTool: AgentTool {
    typealias Input = EmptyToolInput

    static let manifest = ToolManifest(
        id: "get_current_datetime",
        displayName: "Slow Date Time",
        shortDescription: "Test-only cancellable current date/time tool.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .capability("get_current_datetime"),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "current date/time"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 5, maxResultBytes: 512),
        userVisibleExecutionSummary: "Testing cancellable date/time status")

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try await Task.sleep(nanoseconds: 5_000_000_000)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "done",
                                   structuredData: .object(["status": .string("success")]),
                                   modelContent: "done")
    }
}

private extension AgentJSONValue {
    func stringValue(_ key: String) -> String? {
        guard case .object(let object) = self,
              case .string(let value)? = object[key] else {
            return nil
        }
        return value
    }
}

private extension Array where Element == ChatMessage {
    var p5ActivityMessages: [ChatMessage] {
        filter { $0.role == .activity }
    }
}

private extension ChatActivityRecord {
    var p5RenderedText: String {
        let toolText = tools
            .flatMap { [$0.displayName, $0.toolID, $0.title, $0.status.rawValue] }
            .joined(separator: " ")
        return [summary, detail, toolText].compactMap { $0 }.joined(separator: " ")
    }
}
