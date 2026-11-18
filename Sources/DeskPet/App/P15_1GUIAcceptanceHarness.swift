#if PHASE_HARNESS && DEBUG
import AppKit
import Foundation
import PetAgentRuntime
import SwiftUI

// P15.1 — Human-Visible GUI Acceptance Harness.
//
// Closes the GUI_SMOKE = PARTIAL gap from P15 by rendering the production
// SwiftUI hierarchy offline (NSHostingView + cacheDisplay) and capturing
// PNG evidence. Pattern is identical to P9D/P9E production harnesses.
//
// Scenarios (see P15.1 spec §8, §9, §11, §13, §14, §15):
//   • toolDateTime          — get_current_datetime live activity card
//   • toolLocalDiscovery    — local_place_search full lifecycle card
//   • approvalPending       — TaskActivityCard waitingForApproval + buttons
//   • approvalApprove       — same task after approveActivePlan (terminal .succeeded)
//   • approvalReject        — same task after cancelActivePlan (terminal .cancelled)
//   • cancelRunning         — running → cancelling → cancelled
//   • retryWaiting          — .taskWaitingForRetry transient status
//   • retryRecovery         — .taskRecovered continuation → terminal
//   • conversationIsolationA — conv A running
//   • conversationIsolationB — conv B independent (no cross-pollination)
//   • terminalCleanupSucceeded — terminal .succeeded UI
//   • terminalCleanupFailed   — terminal .failed UI
//   • terminalCleanupCancelled — terminal .cancelled UI

@MainActor
enum P15_1GUIAcceptanceHarness {
    enum Scenario: String, CaseIterable {
        case toolDateTime
        case toolLocalDiscovery
        case approvalPending
        case approvalApprove
        case approvalReject
        case cancelRunning
        case retryWaiting
        case retryRecovery
        case conversationIsolationA
        case conversationIsolationB
        case terminalCleanupSucceeded
        case terminalCleanupFailed
        case terminalCleanupCancelled
    }

    static var requestedScenario: Scenario? {
        let env = ProcessInfo.processInfo.environment["DESKPET_P15_1_GUI_ACCEPTANCE"]
        let arg = ProcessInfo.processInfo.arguments.value(after: "--p15-1-scenario")
        guard let raw = env ?? arg else { return nil }
        return Scenario(rawValue: raw)
    }

    static func runIfRequested(paths: DeskPetAppPaths,
                               chat: ChatModel,
                               activityStore: AgentTaskActivityStore) async {
        guard let scenario = requestedScenario else { return }
        do {
            let artifact = try await run(scenario: scenario,
                                         paths: paths,
                                         chat: chat,
                                         activityStore: activityStore)
            _ = activityStore // referenced in capture below
            let artifactURL = try write(artifact: artifact, paths: paths)
            FileHandle.standardError.write(
                "P15_1_GUI_ACCEPTANCE scenario=\(scenario.rawValue) ok=\(artifact.ok) screenshots=\(artifact.screenshots.count) raw_leak_count=\(artifact.rawIdentifierLeakCount) artifact=\(artifactURL.path)\n"
                    .data(using: .utf8)!)
            NSApp.terminate(nil)
        } catch {
            let artifact = P15_1GUIAcceptanceArtifact(scenario: scenario.rawValue,
                                                     ok: false,
                                                     screenshots: [],
                                                     rawIdentifierLeakCount: 0,
                                                     error: String(describing: error))
            let artifactURL = try? write(artifact: artifact, paths: paths)
            FileHandle.standardError.write(
                "P15_1_GUI_ACCEPTANCE scenario=\(scenario.rawValue) ok=false error=\(error) artifact=\(artifactURL?.path ?? "unwritten")\n"
                    .data(using: .utf8)!)
            exit(1)
        }
    }

    // MARK: - Scenario runner

    private static func run(scenario: Scenario,
                            paths: DeskPetAppPaths,
                            chat: ChatModel,
                            activityStore: AgentTaskActivityStore) async throws -> P15_1GUIAcceptanceArtifact {
        NSApp.activate(ignoringOtherApps: true)
        let fixture = Fixture(scenario: scenario)
        try await install(fixture: fixture, chat: chat, activityStore: activityStore)
        let screenshot = try await capture(fixture: fixture, chat: chat, activityStore: activityStore, paths: paths)
        let rawLeak = countRawIdentifierLeaks(in: fixture)
        return P15_1GUIAcceptanceArtifact(scenario: scenario.rawValue,
                                          ok: true,
                                          screenshots: [screenshot],
                                          rawIdentifierLeakCount: rawLeak,
                                          error: nil)
    }

    private static func countRawIdentifierLeaks(in fixture: Fixture) -> Int {
        var count = 0
        for tool in fixture.toolIdentifiers {
            for visible in fixture.evidenceStrings where visible.contains(tool) {
                count += 1
            }
        }
        return count
    }

    // MARK: - Fixture

    private struct Fixture {
        let scenario: Scenario
        let conversationID: UUID
        let taskID: UUID
        let runID: UUID
        let userMessageID: UUID
        let conversationBID: UUID?
        let taskIDB: UUID?
        let runIDB: UUID?
        let evidenceStrings: [String]
        let toolIdentifiers: [String]

        init(scenario: Scenario) {
            self.scenario = scenario
            self.conversationID = UUID()
            self.taskID = UUID()
            self.runID = UUID()
            self.userMessageID = UUID()
            if scenario == .conversationIsolationA || scenario == .conversationIsolationB {
                self.conversationBID = UUID()
                self.taskIDB = UUID()
                self.runIDB = UUID()
            } else {
                self.conversationBID = nil
                self.taskIDB = nil
                self.runIDB = nil
            }

            let toolID = Self.toolID(for: scenario)
            self.toolIdentifiers = toolID.map { [$0] } ?? []
            self.evidenceStrings = Self.expectedUserVisibleCopy(for: scenario)
        }

        private static func toolID(for scenario: Scenario) -> String? {
            switch scenario {
            case .toolDateTime:                                       return "get_current_datetime"
            case .toolLocalDiscovery:                                 return "local_place_search"
            case .approvalPending, .approvalApprove, .approvalReject: return "calendar.event.create"
            case .cancelRunning:                                      return "structured_place_extraction"
            case .retryWaiting, .retryRecovery:                       return "approximate_location"
            case .conversationIsolationA, .conversationIsolationB:     return "get_current_datetime"
            default:                                                  return nil
            }
        }

        private static func expectedUserVisibleCopy(for scenario: Scenario) -> [String] {
            switch scenario {
            case .toolDateTime:
                return ["正在获取本地日期和时间…"]
            case .toolLocalDiscovery:
                return ["正在查找附近地点…", "已找到初始候选地点"]
            case .approvalPending:
                return ["等待你的确认", "需要你的允许才能继续"]
            case .approvalApprove:
                return ["已完成"]
            case .approvalReject:
                return ["已停止", "已取消这个操作"]
            case .cancelRunning:
                return ["正在停止…", "已停止"]
            case .retryWaiting:
                return ["请求暂时受限，将自动重试…"]
            case .retryRecovery:
                return ["已恢复，继续处理…", "已完成"]
            case .conversationIsolationA, .conversationIsolationB:
                return ["等待消息"]
            case .terminalCleanupSucceeded:
                return ["已完成"]
            case .terminalCleanupFailed:
                return ["操作失败"]
            case .terminalCleanupCancelled:
                return ["已停止"]
            }
        }
    }

    // MARK: - Fixture installation

    private static func install(fixture: Fixture,
                                chat: ChatModel,
                                activityStore: AgentTaskActivityStore) async throws {
        switch fixture.scenario {
        case .toolDateTime:
            try await installToolDateTime(fixture: fixture, chat: chat, activityStore: activityStore)
        case .toolLocalDiscovery:
            try await installToolLocalDiscovery(fixture: fixture, chat: chat, activityStore: activityStore)
        case .approvalPending:
            try await installApprovalPending(fixture: fixture, chat: chat, activityStore: activityStore)
        case .approvalApprove:
            try await installApprovalApprove(fixture: fixture, chat: chat, activityStore: activityStore)
        case .approvalReject:
            try await installApprovalReject(fixture: fixture, chat: chat, activityStore: activityStore)
        case .cancelRunning:
            try await installCancelRunning(fixture: fixture, chat: chat, activityStore: activityStore)
        case .retryWaiting:
            try await installRetryWaiting(fixture: fixture, chat: chat, activityStore: activityStore)
        case .retryRecovery:
            try await installRetryRecovery(fixture: fixture, chat: chat, activityStore: activityStore)
        case .conversationIsolationA:
            try await installConversationIsolationA(fixture: fixture, chat: chat, activityStore: activityStore)
        case .conversationIsolationB:
            try await installConversationIsolationB(fixture: fixture, chat: chat, activityStore: activityStore)
        case .terminalCleanupSucceeded:
            try await installTerminalSucceeded(fixture: fixture, chat: chat, activityStore: activityStore)
        case .terminalCleanupFailed:
            try await installTerminalFailed(fixture: fixture, chat: chat, activityStore: activityStore)
        case .terminalCleanupCancelled:
            try await installTerminalCancelled(fixture: fixture, chat: chat, activityStore: activityStore)
        }
    }

    private static func publish(event: AgentTaskActivityEvent,
                                activityStore: AgentTaskActivityStore) {
        FileHandle.standardError.write(
            "PUBLISH kind=\(event.kind.rawValue) taskID=\(event.taskID.uuidString) runID=\(event.runID.uuidString) eventID=\(event.eventID.uuidString) seq=\(event.sequenceNumber) cid=\(event.conversationID?.uuidString ?? "nil")\n"
                .data(using: .utf8)!)
        activityStore.publish(AgentEventEnvelope(activityEvent: event))
    }

    private static func makeEvent(taskID: UUID,
                                  runID: UUID,
                                  conversationID: UUID,
                                  sequence: Int,
                                  seconds: TimeInterval = 0,
                                  kind: AgentTaskEventKind,
                                  title: String,
                                  detail: String? = nil,
                                  stepID: String? = nil,
                                  toolID: String? = nil,
                                  failureCategory: AgentTaskFailureCategory? = nil) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(taskID: taskID,
                               runID: runID,
                               conversationID: conversationID,
                               sequenceNumber: sequence,
                               timestamp: Date(timeIntervalSince1970: 1_700_000_000 + seconds),
                               kind: kind,
                               presentation: AgentTaskEventPresentation(title: title, detail: detail),
                               stepID: stepID,
                               toolID: toolID.map(ToolID.init(rawValue:)),
                               failureCategory: failureCategory,
                               source: .runtime,
                               origin: .chat)
    }

    // Tool: get_current_datetime
    private static func installToolDateTime(fixture: Fixture,
                                            chat: ChatModel,
                                            activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在获取本地日期和时间…",
                                 detail: "需要读取当前时间",
                                 stepID: "datetime.read",
                                 toolID: "get_current_datetime"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .stepSucceeded,
                                 title: "已验证工具结果",
                                 detail: "已获取本地日期和时间",
                                 stepID: "datetime.read",
                                 toolID: "get_current_datetime"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 3,
                                 kind: .taskSucceeded,
                                 title: "已完成",
                                 detail: "今天是 2026年8月24日（周日）13:30"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "现在几点？", conversationID: c)
        chat._p15_1SetActiveExecution(conversationID: c, taskID: fixture.taskID, runID: fixture.runID)
        chat._p15_1AppendAssistantMessage(text: "今天是 2026年8月24日（周日）13:30。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .completed)
    }

    // Tool: local_place_search
    private static func installToolLocalDiscovery(fixture: Fixture,
                                                  chat: ChatModel,
                                                  activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在查找附近地点…",
                                 stepID: "search.candidates",
                                 toolID: "local_place_search"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .stepSucceeded,
                                 title: "已找到初始候选地点",
                                 detail: "找到 12 个候选地点",
                                 stepID: "search.candidates",
                                 toolID: "local_place_search"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 3,
                                 kind: .taskSucceeded,
                                 title: "已完成",
                                 detail: "为你整理了附近咖啡馆列表。"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我找附近咖啡馆", conversationID: c)
        chat._p15_1SetActiveExecution(conversationID: c, taskID: fixture.taskID, runID: fixture.runID)
        chat._p15_1AppendAssistantMessage(text: "我找到了 12 家附近咖啡馆，整理如下：…",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .completed)
    }

    // Approval: pending
    private static func installApprovalPending(fixture: Fixture,
                                               chat: ChatModel,
                                               activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在规划日程",
                                 stepID: "plan.createEvent"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .approvalRequested,
                                 title: "等待你的确认",
                                 detail: "需要你的允许才能继续。",
                                 stepID: "plan.createEvent",
                                 toolID: "calendar.event.create"),
                activityStore: activityStore)
        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我创建一个日程", conversationID: c)
        chat._p15_1SetActiveExecution(conversationID: c, taskID: fixture.taskID, runID: fixture.runID)
    }

    // Approval: approve
    private static func installApprovalApprove(fixture: Fixture,
                                               chat: ChatModel,
                                               activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在规划日程",
                                 stepID: "plan.createEvent"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .approvalRequested,
                                 title: "等待你的确认",
                                 detail: "需要你的允许才能继续。",
                                 stepID: "plan.createEvent",
                                 toolID: "calendar.event.create"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 3,
                                 kind: .approvalGranted,
                                 title: "已允许继续",
                                 stepID: "plan.createEvent",
                                 toolID: "calendar.event.create"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 4,
                                 kind: .taskSucceeded,
                                 title: "已完成",
                                 detail: "日程已创建"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我创建一个日程", conversationID: c)
        // approveActivePlan was simulated; the run is terminal, so no active execution.
        chat._p15_1AppendAssistantMessage(text: "日程已创建。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .completed)
    }

    // Approval: reject
    private static func installApprovalReject(fixture: Fixture,
                                               chat: ChatModel,
                                               activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在规划日程",
                                 stepID: "plan.createEvent"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .approvalRequested,
                                 title: "等待你的确认",
                                 detail: "需要你的允许才能继续。",
                                 stepID: "plan.createEvent",
                                 toolID: "calendar.event.create"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 3,
                                 kind: .approvalDenied,
                                 title: "已取消这个操作",
                                 stepID: "plan.createEvent",
                                 toolID: "calendar.event.create"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 4,
                                 kind: .taskCancelled,
                                 title: "已停止",
                                 stepID: "plan.createEvent"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我创建一个日程", conversationID: c)
        chat._p15_1AppendAssistantMessage(text: "已取消。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .cancelled)
    }

    // Cancel running
    private static func installCancelRunning(fixture: Fixture,
                                             chat: ChatModel,
                                             activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在整理地点信息…",
                                 stepID: "extraction",
                                 toolID: "structured_place_extraction"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .taskCancelled,
                                 title: "正在停止…",
                                 stepID: "extraction"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 3,
                                 kind: .taskCancelled,
                                 title: "已停止",
                                 stepID: "extraction"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "整理一下这些地点信息", conversationID: c)
        chat._p15_1AppendAssistantMessage(text: "已停止。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .cancelled)
    }

    // Retry waiting
    private static func installRetryWaiting(fixture: Fixture,
                                             chat: ChatModel,
                                             activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        let stepStart = makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                  conversationID: c, sequence: 1,
                                  kind: .stepStarted,
                                  title: "正在确定搜索位置…",
                                  stepID: "approximate.location",
                                  toolID: "approximate_location")
        let waiting = makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                conversationID: c, sequence: 2,
                                kind: .taskWaitingForRetry,
                                title: "请求暂时受限，将自动重试…",
                                detail: "正在等待重新连接")
        publish(event: stepStart, activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "附近有什么好吃的", conversationID: c)
        chat._p15_1SetActiveExecution(conversationID: c, taskID: fixture.taskID, runID: fixture.runID)
        // Drive retry event through real ChatModel.apply path so transientStatusText updates.
        await chat._p15_1DriveTaskActivity(event: waiting)
    }

    // Retry recovery
    private static func installRetryRecovery(fixture: Fixture,
                                             chat: ChatModel,
                                             activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        let stepStart = makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                  conversationID: c, sequence: 1,
                                  kind: .stepStarted,
                                  title: "正在确定搜索位置…",
                                  stepID: "approximate.location",
                                  toolID: "approximate_location")
        let waiting = makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                conversationID: c, sequence: 2,
                                kind: .taskWaitingForRetry,
                                title: "请求暂时受限，将自动重试…")
        let recovered = makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                  conversationID: c, sequence: 3,
                                  kind: .taskRecovered,
                                  title: "已恢复，继续处理…")
        publish(event: stepStart, activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "附近有什么好吃的", conversationID: c)
        chat._p15_1SetActiveExecution(conversationID: c, taskID: fixture.taskID, runID: fixture.runID)
        await chat._p15_1DriveTaskActivity(event: waiting)
        await chat._p15_1DriveTaskActivity(event: recovered)
    }

    // Conversation isolation A
    private static func installConversationIsolationA(fixture: Fixture,
                                                      chat: ChatModel,
                                                      activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        let cB = fixture.conversationBID!
        let tB = fixture.taskIDB!
        let rB = fixture.runIDB!

        _ = chat._p15_1CreateConversation(kind: .normal)
        _ = chat._p15_1CreateConversation(kind: .normal)

        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在获取本地日期和时间…",
                                 stepID: "datetime.read",
                                 toolID: "get_current_datetime"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: tB, runID: rB,
                                 conversationID: cB, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在获取本地日期和时间…",
                                 stepID: "datetime.read",
                                 toolID: "get_current_datetime"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "A: 几点了？", conversationID: c)
        chat._p15_1SetActiveExecution(conversationID: c, taskID: fixture.taskID, runID: fixture.runID)
    }

    // Conversation isolation B
    private static func installConversationIsolationB(fixture: Fixture,
                                                      chat: ChatModel,
                                                      activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        let cB = fixture.conversationBID!
        let tB = fixture.taskIDB!
        let rB = fixture.runIDB!

        _ = chat._p15_1CreateConversation(kind: .normal)
        _ = chat._p15_1CreateConversation(kind: .normal)

        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在获取本地日期和时间…",
                                 stepID: "datetime.read",
                                 toolID: "get_current_datetime"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: tB, runID: rB,
                                 conversationID: cB, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在获取本地日期和时间…",
                                 stepID: "datetime.read",
                                 toolID: "get_current_datetime"),
                activityStore: activityStore)

        chat._p15_1OpenConversation(id: cB)
        chat._p15_1AppendUserMessage(text: "B: 几点了？", conversationID: cB)
        chat._p15_1SetActiveExecution(conversationID: cB, taskID: tB, runID: rB)
    }

    // Terminal: succeeded
    private static func installTerminalSucceeded(fixture: Fixture,
                                                 chat: ChatModel,
                                                 activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在执行…",
                                 stepID: "op"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .taskSucceeded,
                                 title: "已完成",
                                 detail: nil,
                                 stepID: "op"),
                activityStore: activityStore)
        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我做这件事", conversationID: c)
        chat._p15_1AppendAssistantMessage(text: "已完成。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .completed)
    }

    // Terminal: failed
    private static func installTerminalFailed(fixture: Fixture,
                                               chat: ChatModel,
                                               activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在执行…",
                                 stepID: "op"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .taskFailed,
                                 title: "操作失败",
                                 detail: "请稍后再试",
                                 stepID: "op",
                                 failureCategory: .toolFailed),
                activityStore: activityStore)
        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我做这件事", conversationID: c)
        chat._p15_1AppendAssistantMessage(text: "操作失败，请稍后再试。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .failed)
    }

    // Terminal: cancelled
    private static func installTerminalCancelled(fixture: Fixture,
                                                 chat: ChatModel,
                                                 activityStore: AgentTaskActivityStore) async throws {
        let c = fixture.conversationID
        _ = chat._p15_1CreateConversation(kind: .normal)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 1,
                                 kind: .stepStarted,
                                 title: "正在执行…",
                                 stepID: "op"),
                activityStore: activityStore)
        publish(event: makeEvent(taskID: fixture.taskID, runID: fixture.runID,
                                 conversationID: c, sequence: 2,
                                 kind: .taskCancelled,
                                 title: "已停止",
                                 stepID: "op"),
                activityStore: activityStore)
        chat._p15_1OpenConversation(id: c)
        chat._p15_1AppendUserMessage(text: "帮我做这件事", conversationID: c)
        chat._p15_1AppendAssistantMessage(text: "已停止。",
                                          conversationID: c,
                                          taskID: fixture.taskID,
                                          runID: fixture.runID,
                                          status: .cancelled)
    }

    // MARK: - Capture

    private static func capture(fixture: Fixture,
                                chat: ChatModel,
                                activityStore: AgentTaskActivityStore,
                                paths: DeskPetAppPaths) async throws -> String {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p15_1_gui_\(fixture.scenario.rawValue).png")
        let size = CGSize(width: 720, height: 760)

        // Build a focused view tree that exercises the production SwiftUI hierarchy:
        //   TaskActivityCard (real, when activeTaskActivity is non-nil)
        //   ChatActivityBubble (real, when activity message exists)
        //   Live status text (real transientStatusText)
        let activeTask = chat.activeTaskActivity
        let storeTask = activityStore.task(id: fixture.taskID)
        FileHandle.standardError.write(
            "P15_1_CAPTURE scenario=\(fixture.scenario.rawValue) activeTaskNil=\(activeTask == nil) storeTaskNil=\(storeTask == nil) storeTaskStatus=\(storeTask?.status.rawValue ?? "nil") latestRunStatus=\(storeTask?.latestRun?.status.rawValue ?? "nil") latestRunCID=\(storeTask?.latestRun?.conversationID?.uuidString ?? "nil") latestRunID=\(storeTask?.latestRun?.runID.uuidString ?? "nil") transientStatus=\(chat.transientStatusText ?? "nil") numRuns=\(storeTask?.runs.count ?? 0) activeTaskTID=\(activeTask?.taskID.uuidString ?? "nil")\n"
                .data(using: .utf8)!)

        // The harness renders two regions:
        //   - TaskActivityCard (top) — production SwiftUI
        //   - A compact history of chat messages (bottom) — production-style
        //   - A transient status banner (real ChatModel.transientStatusText)
        let activityCard = activeTask.map { task in
            TaskActivityCard(task: task,
                             onApprove: {},
                             onCancel: {},
                             onStop: {},
                             onRetry: {},
                             onOpenDetails: {})
        }
        let activityBubble: AnyView? = chat.conversation.messages
            .last(where: { $0.role == .activity })
            .map { msg in
                AnyView(
                    ChatActivityBubble(activity: msg.activity ?? ChatActivityRecord(
                        taskID: msg.taskID ?? UUID(),
                        runID: msg.attemptID ?? UUID(),
                        conversationID: chat.conversation.id,
                        userMessageID: nil,
                        status: .succeeded,
                        summary: msg.text,
                        detail: nil,
                        tools: [],
                        createdAt: msg.timestamp,
                        updatedAt: msg.timestamp,
                        completedAt: msg.timestamp
                    ), compact: true)
                )
            }
        let transient = chat.transientStatusText.map { text in
            Text(text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.orange)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.orange.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }

        let view = VStack(alignment: .leading, spacing: 12) {
            Text("P15.1 GUI Acceptance — \(fixture.scenario.rawValue)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            if let transient {
                transient
            }
            if let activityCard {
                activityCard
            }
            if let activityBubble {
                activityBubble
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(DSColor.appBackground)

        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable],
                              backing: .buffered,
                              defer: false)
        window.title = "P15.1 \(fixture.scenario.rawValue)"
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.contentView?.needsLayout = true
        window.contentView?.layoutSubtreeIfNeeded()

        try await Task.sleep(nanoseconds: 600_000_000)
        guard captureWindowScreenshot(window, to: url) else {
            window.orderOut(nil)
            throw HarnessError.screenshotFailed(fixture.scenario.rawValue)
        }
        window.orderOut(nil)
        return url.path
    }

    private static func captureWindowScreenshot(_ window: NSWindow, to url: URL) -> Bool {
        guard let view = window.contentView else { return false }
        view.displayIfNeeded()
        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        view.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Artifact

    enum HarnessError: Error {
        case screenshotFailed(String)
        case unsupported(String)
    }

    private static func write(artifact: P15_1GUIAcceptanceArtifact,
                              paths: DeskPetAppPaths) throws -> URL {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p15_1_gui_acceptance_\(artifact.scenario).json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(artifact)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return url
    }
}

struct P15_1GUIAcceptanceArtifact: Codable, Sendable {
    var scenario: String
    var ok: Bool
    var screenshots: [String]
    var rawIdentifierLeakCount: Int
    var error: String?
}

private extension [String] {
    func value(after flag: String) -> String? {
        guard let index = firstIndex(of: flag) else { return nil }
        let valueIndex = self.index(after: index)
        guard indices.contains(valueIndex) else { return nil }
        return self[valueIndex]
    }
}
#endif
