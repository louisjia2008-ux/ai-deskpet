import Foundation

public enum AgentActivityCategory: String, Codable, Sendable, Hashable, CaseIterable {
    case planning
    case provider
    case tool
    case permission
    case userAction
    case file
    case command
    case network
    case memory
    case result
    case warning
}

public enum AgentActivityStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case pending
    case running
    case waiting
    case succeeded
    case failed
    case cancelled
    case skipped
}

public struct AgentActivityDetail: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var title: String
    public var value: String?
    public var visibility: AgentEventVisibility

    public init(id: UUID = UUID(),
                title: String,
                value: String? = nil,
                visibility: AgentEventVisibility = .developer) {
        self.id = id
        self.title = AgentEventRedactor.safeText(title, maxLength: 120)
        self.value = value.map { AgentEventRedactor.safeText($0, maxLength: 240) }
        self.visibility = visibility
    }
}

public struct AgentActivityItem: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskID: UUID
    public var runID: UUID
    public var stepID: String?
    public var category: AgentActivityCategory
    public var title: String
    public var subtitle: String?
    public var status: AgentActivityStatus
    public var startedAt: Date
    public var finishedAt: Date?
    public var progress: Double?
    public var details: [AgentActivityDetail]
    public var isExpandable: Bool

    public init(id: UUID,
                taskID: UUID,
                runID: UUID,
                stepID: String? = nil,
                category: AgentActivityCategory,
                title: String,
                subtitle: String? = nil,
                status: AgentActivityStatus,
                startedAt: Date,
                finishedAt: Date? = nil,
                progress: Double? = nil,
                details: [AgentActivityDetail] = [],
                isExpandable: Bool = false) {
        self.id = id
        self.taskID = taskID
        self.runID = runID
        self.stepID = stepID.map(AgentEventRedactor.safeIdentifier)
        self.category = category
        self.title = AgentEventRedactor.safeText(title, maxLength: 120)
        self.subtitle = subtitle.map { AgentEventRedactor.safeText($0, maxLength: 180) }
        self.status = status
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.progress = progress
        self.details = details
        self.isExpandable = isExpandable || !details.isEmpty
    }
}

public struct ToolPresentationMetadata: Codable, Sendable, Hashable {
    public var toolID: String
    public var displayName: String
    public var runningTitle: String
    public var succeededTitle: String
    public var failedTitle: String
    public var icon: String
    public var category: AgentActivityCategory
    public var riskLevel: String
    public var defaultExpanded: Bool

    public init(toolID: String,
                displayName: String,
                runningTitle: String,
                succeededTitle: String,
                failedTitle: String,
                icon: String,
                category: AgentActivityCategory = .tool,
                riskLevel: String = "low",
                defaultExpanded: Bool = false) {
        self.toolID = AgentEventRedactor.safeIdentifier(toolID)
        self.displayName = AgentEventRedactor.safeText(displayName, maxLength: 80)
        self.runningTitle = AgentEventRedactor.safeText(runningTitle, maxLength: 120)
        self.succeededTitle = AgentEventRedactor.safeText(succeededTitle, maxLength: 120)
        self.failedTitle = AgentEventRedactor.safeText(failedTitle, maxLength: 120)
        self.icon = icon
        self.category = category
        self.riskLevel = AgentEventRedactor.safeIdentifier(riskLevel)
        self.defaultExpanded = defaultExpanded
    }

    public static func metadata(for toolID: String) -> ToolPresentationMetadata {
        if let metadata = catalog[toolID] {
            return metadata
        }

        let lower = toolID.lowercased()
        if lower.contains("calendar") {
            return ToolPresentationMetadata(toolID: toolID,
                                            displayName: "日历操作",
                                            runningTitle: "正在处理日历…",
                                            succeededTitle: "日历已更新",
                                            failedTitle: "日历操作没有完成",
                                            icon: "calendar",
                                            category: .permission,
                                            riskLevel: "private-write")
        }
        if lower.contains("map") || lower.contains("route") || lower.contains("direction") {
            return ToolPresentationMetadata(toolID: toolID,
                                            displayName: "地图操作",
                                            runningTitle: "正在打开地图…",
                                            succeededTitle: "地图已打开",
                                            failedTitle: "地图操作没有完成",
                                            icon: "map",
                                            category: .network,
                                            riskLevel: "external")
        }
        if lower.contains("search") || lower.contains("place") {
            return ToolPresentationMetadata(toolID: toolID,
                                            displayName: "查找地点",
                                            runningTitle: "正在查找地点…",
                                            succeededTitle: "已找到地点结果",
                                            failedTitle: "地点查找没有完成",
                                            icon: "magnifyingglass",
                                            category: .network,
                                            riskLevel: "read-only")
        }
        if lower.contains("file") || lower.contains("workspace") {
            return ToolPresentationMetadata(toolID: toolID,
                                            displayName: "文件操作",
                                            runningTitle: "正在处理文件…",
                                            succeededTitle: "文件操作已完成",
                                            failedTitle: "文件操作没有完成",
                                            icon: "doc.text",
                                            category: .file,
                                            riskLevel: "medium")
        }

        return ToolPresentationMetadata(toolID: toolID,
                                        displayName: "工具操作",
                                        runningTitle: "正在执行操作…",
                                        succeededTitle: "操作已完成",
                                        failedTitle: "这个操作没有完成",
                                        icon: "wrench.and.screwdriver")
    }

    private static let catalog: [String: ToolPresentationMetadata] = [
        "get_current_datetime": ToolPresentationMetadata(
            toolID: "get_current_datetime",
            displayName: "本地日期和时间",
            runningTitle: "正在获取本地日期和时间…",
            succeededTitle: "已获取本地日期和时间",
            failedTitle: "未能获取本地日期和时间",
            icon: "clock"),
        "get_system_profile": ToolPresentationMetadata(
            toolID: "get_system_profile",
            displayName: "系统信息",
            runningTitle: "正在读取系统信息…",
            succeededTitle: "已读取系统信息",
            failedTitle: "未能读取系统信息",
            icon: "desktopcomputer"),
        "get_frontmost_application": ToolPresentationMetadata(
            toolID: "get_frontmost_application",
            displayName: "当前应用",
            runningTitle: "正在查看当前应用…",
            succeededTitle: "已查看当前应用",
            failedTitle: "未能查看当前应用",
            icon: "macwindow"),
        "list_today_calendar_events": ToolPresentationMetadata(
            toolID: "list_today_calendar_events",
            displayName: "今日日历",
            runningTitle: "正在查询今日日历…",
            succeededTitle: "已查询今日日历",
            failedTitle: "未能查询今日日历",
            icon: "calendar",
            category: .permission,
            riskLevel: "private-read"),
        "approximate_location": ToolPresentationMetadata(
            toolID: "approximate_location",
            displayName: "大致位置",
            runningTitle: "正在确定搜索位置…",
            succeededTitle: "已确定搜索位置",
            failedTitle: "未能确定搜索位置",
            icon: "location",
            category: .permission,
            riskLevel: "private-read"),
        "local_place_search": ToolPresentationMetadata(
            toolID: "local_place_search",
            displayName: "附近地点",
            runningTitle: "正在查找附近地点…",
            succeededTitle: "已找到初始候选地点",
            failedTitle: "地点查找没有完成",
            icon: "magnifyingglass",
            category: .network,
            riskLevel: "read-only"),
        "route_distance_estimate": ToolPresentationMetadata(
            toolID: "route_distance_estimate",
            displayName: "路线距离",
            runningTitle: "正在估算路线距离…",
            succeededTitle: "已估算路线距离",
            failedTitle: "路线估算没有完成",
            icon: "map",
            category: .network,
            riskLevel: "read-only"),
        "webpage_read": ToolPresentationMetadata(
            toolID: "webpage_read",
            displayName: "网页信息",
            runningTitle: "正在补充网页信息…",
            succeededTitle: "已补充网页信息",
            failedTitle: "网页补充没有完成",
            icon: "doc.text.magnifyingglass",
            category: .network,
            riskLevel: "read-only"),
        "structured_place_extraction": ToolPresentationMetadata(
            toolID: "structured_place_extraction",
            displayName: "地点信息整理",
            runningTitle: "正在整理地点信息…",
            succeededTitle: "已整理地点信息",
            failedTitle: "地点信息整理没有完成",
            icon: "list.bullet.rectangle",
            category: .tool,
            riskLevel: "read-only"),
        "read_file": ToolPresentationMetadata(
            toolID: "read_file",
            displayName: "读取文件",
            runningTitle: "正在读取文件…",
            succeededTitle: "已读取文件",
            failedTitle: "未能读取文件",
            icon: "doc.text",
            category: .file,
            riskLevel: "medium"),
        "run_command": ToolPresentationMetadata(
            toolID: "run_command",
            displayName: "运行指令",
            runningTitle: "正在运行指令…",
            succeededTitle: "已运行指令",
            failedTitle: "未能运行指令",
            icon: "terminal",
            category: .command,
            riskLevel: "high",
            defaultExpanded: true),
        "modify_file": ToolPresentationMetadata(
            toolID: "modify_file",
            displayName: "编辑文件",
            runningTitle: "正在编辑文件…",
            succeededTitle: "已编辑文件",
            failedTitle: "未能编辑文件",
            icon: "square.and.pencil",
            category: .file,
            riskLevel: "high",
            defaultExpanded: true),
        "automation.p8_reversible_write": ToolPresentationMetadata(
            toolID: "automation.p8_reversible_write",
            displayName: "测试写入操作",
            runningTitle: "正在执行测试写入…",
            succeededTitle: "测试写入已完成",
            failedTitle: "测试写入没有完成",
            icon: "square.and.pencil",
            category: .file,
            riskLevel: "medium"),
        "p8.fixture.missing_tool": ToolPresentationMetadata(
            toolID: "p8.fixture.missing_tool",
            displayName: "测试工具",
            runningTitle: "正在执行测试工具…",
            succeededTitle: "测试工具已完成",
            failedTitle: "这个操作没有完成",
            icon: "wrench.and.screwdriver"),
        "calendar.event.create": ToolPresentationMetadata(
            toolID: "calendar.event.create",
            displayName: "创建日程",
            runningTitle: "正在创建日程…",
            succeededTitle: "日程已创建",
            failedTitle: "日程没有创建",
            icon: "calendar.badge.plus",
            category: .permission,
            riskLevel: "private-write")
    ]
}

public enum AgentActivityReducer {
    private static let localDiscoveryToolIDs: Set<String> = [
        "approximate_location",
        "local_place_search",
        "route_distance_estimate",
        "webpage_read",
        "structured_place_extraction",
    ]
    private static let localDiscoveryStageIDs: Set<String> = [
        "classifyIntent",
        "buildQuery",
        "resolveLocation",
        "searchCandidates",
        "deduplicateCandidates",
        "estimateDistances",
        "enrichCandidates",
        "validateCandidates",
        "genericVerifier",
        "synthesizeResult",
        "localDiscoveryCheckpoint",
    ]

    public static func reduce(events rawEvents: [AgentEventEnvelope],
                              visibility: AgentEventVisibility = .user) -> [AgentActivityItem] {
        if visibility == .user {
            return reduceUserVisible(events: rawEvents)
        }
        var items: [AgentActivityItem] = []
        var itemIndexByToolKey: [String: Int] = [:]
        var seenEventIDs = Set<UUID>()

        for event in rawEvents.sortedForReplay() where seenEventIDs.insert(event.id).inserted {
            let safe = AgentEventRedactor.redact(event, level: visibility == .diagnostic ? .diagnostic : .normal)
            switch safe.kind {
            case .toolRequested, .toolValidated, .toolValidationFailed, .toolPermissionRequired,
                 .toolPermissionGranted, .toolPermissionDenied, .toolStarted, .toolProgress,
                 .toolSucceeded, .toolFailed, .toolCancelled, .observationProduced,
                 .observationDeliveredToModel:
                reduceToolEvent(safe, into: &items, indexByKey: &itemIndexByToolKey, visibility: visibility)
            default:
                items.append(item(for: safe, visibility: visibility))
            }
        }

        return items.sorted {
            if $0.startedAt != $1.startedAt { return $0.startedAt < $1.startedAt }
            return $0.id.uuidString < $1.id.uuidString
        }
    }

    private static func reduceUserVisible(events rawEvents: [AgentEventEnvelope]) -> [AgentActivityItem] {
        let events = deduplicatedSorted(rawEvents).map {
            AgentEventRedactor.redact($0, level: .normal)
        }
        guard let first = events.first else { return [] }

        var items: [AgentActivityItem] = []
        let terminal = terminalEvent(in: events)
        if let started = firstCurrentDateTimeEvent(in: events, matching: isCurrentDateTimeStart) {
            items.append(userItem(from: started,
                                  category: .tool,
                                  title: "正在获取本地日期和时间…",
                                  status: .running,
                                  finishedAt: nil))
        }
        if let succeeded = firstCurrentDateTimeEvent(in: events, matching: isCurrentDateTimeSuccess) {
            items.append(userItem(from: succeeded,
                                  category: .tool,
                                  title: "已获取本地日期和时间",
                                  status: .succeeded,
                                  finishedAt: succeeded.timestamp))
        } else if let failed = firstCurrentDateTimeEvent(in: events, matching: isCurrentDateTimeFailure) {
            items.append(userItem(from: failed,
                                  category: .tool,
                                  title: "未能获取本地日期和时间",
                                  subtitle: failed.safeSubtitle,
                                  status: activityStatus(for: failed.kind),
                                  finishedAt: failed.timestamp))
        }

        let localDiscoveryItems = userVisibleLocalDiscoveryItems(in: events)
        if !localDiscoveryItems.isEmpty {
            items.append(contentsOf: localDiscoveryItems)
        } else if items.isEmpty, terminal == nil, hasOrdinaryGenerationEvent(in: events) {
            let base = events.last ?? first
            items.append(userItem(from: base,
                                  category: .result,
                                  title: "正在生成回复……",
                                  status: .running,
                                  finishedAt: nil))
        }

        if let waiting = firstWaitingEvent(in: events), terminal == nil, items.isEmpty {
            items.append(userItem(from: waiting,
                                  category: .permission,
                                  title: "等待你的确认",
                                  subtitle: "需要你的允许才能继续。",
                                  status: .waiting,
                                  finishedAt: nil))
        }
        if let terminal {
            items.append(userItem(from: terminal,
                                  category: .result,
                                  title: terminalTitle(for: terminal),
                                  subtitle: terminalSubtitle(for: terminal),
                                  status: activityStatus(for: terminal.kind),
                                  finishedAt: terminal.timestamp))
        }

        return items.sorted {
            if $0.startedAt != $1.startedAt { return $0.startedAt < $1.startedAt }
            return $0.id.uuidString < $1.id.uuidString
        }
    }

    private static func userVisibleLocalDiscoveryItems(in events: [AgentEventEnvelope]) -> [AgentActivityItem] {
        var items: [AgentActivityItem] = []
        var indexByKey: [String: Int] = [:]
        for event in events where isLocalDiscoveryToolEvent(event) {
            reduceToolEvent(event, into: &items, indexByKey: &indexByKey, visibility: .user)
        }
        for event in events where isLocalDiscoveryStageEvent(event) {
            items.append(userItem(from: event,
                                  category: localDiscoveryCategory(for: event),
                                  title: event.safeTitle,
                                  subtitle: event.safeSubtitle,
                                  status: activityStatus(for: event.kind),
                                  finishedAt: activityStatus(for: event.kind).isTerminal ? event.timestamp : nil))
        }
        return items
    }

    private static func isLocalDiscoveryToolEvent(_ event: AgentEventEnvelope) -> Bool {
        guard isToolLifecycleEvent(event.kind) else { return false }
        let toolID = event.toolPayload?.toolID ?? event.activityToolID
        return localDiscoveryToolIDs.contains(toolID ?? "")
    }

    private static func isLocalDiscoveryStageEvent(_ event: AgentEventEnvelope) -> Bool {
        guard case .activity = event.payload else { return false }
        guard let stepID = event.activityStepID else { return false }
        return localDiscoveryStageIDs.contains(stepID)
    }

    private static func isToolLifecycleEvent(_ kind: AgentEventKind) -> Bool {
        switch kind {
        case .toolRequested, .toolValidated, .toolValidationFailed, .toolPermissionRequired,
             .toolPermissionGranted, .toolPermissionDenied, .toolStarted, .toolProgress,
             .toolSucceeded, .toolFailed, .toolCancelled, .observationProduced,
             .observationDeliveredToModel:
            return true
        default:
            return false
        }
    }

    private static func localDiscoveryCategory(for event: AgentEventEnvelope) -> AgentActivityCategory {
        switch event.kind {
        case .verificationStarted, .verificationSucceeded, .verificationFailed:
            return .result
        case .toolPermissionRequired, .waitingForUser:
            return .permission
        case .stepFailed, .taskFailed:
            return .warning
        default:
            return .planning
        }
    }

    private static func deduplicatedSorted(_ events: [AgentEventEnvelope]) -> [AgentEventEnvelope] {
        var seenEventIDs = Set<UUID>()
        return events.sortedForReplay().filter { seenEventIDs.insert($0.id).inserted }
    }

    private static func userItem(from event: AgentEventEnvelope,
                                 category: AgentActivityCategory,
                                 title: String,
                                 subtitle: String? = nil,
                                 status: AgentActivityStatus,
                                 finishedAt: Date?) -> AgentActivityItem {
        AgentActivityItem(id: event.id,
                          taskID: event.taskID,
                          runID: event.runID,
                          stepID: event.activityStepID,
                          category: category,
                          title: title,
                          subtitle: subtitle,
                          status: status,
                          startedAt: event.timestamp,
                          finishedAt: finishedAt,
                          progress: event.progress,
                          details: [],
                          isExpandable: false)
    }

    private static func firstCurrentDateTimeEvent(
        in events: [AgentEventEnvelope],
        matching predicate: (AgentEventKind) -> Bool
    ) -> AgentEventEnvelope? {
        events.first { isCurrentDateTimeEvent($0) && predicate($0.kind) }
    }

    private static func isCurrentDateTimeStart(_ kind: AgentEventKind) -> Bool {
        switch kind {
        case .toolRequested, .toolValidated, .toolStarted, .toolProgress:
            return true
        default:
            return false
        }
    }

    private static func isCurrentDateTimeSuccess(_ kind: AgentEventKind) -> Bool {
        switch kind {
        case .toolSucceeded, .observationProduced, .observationDeliveredToModel:
            return true
        default:
            return false
        }
    }

    private static func isCurrentDateTimeFailure(_ kind: AgentEventKind) -> Bool {
        switch kind {
        case .toolValidationFailed, .toolPermissionDenied, .toolFailed, .toolCancelled:
            return true
        default:
            return false
        }
    }

    private static func isCurrentDateTimeEvent(_ event: AgentEventEnvelope) -> Bool {
        event.activityToolID == "get_current_datetime"
            || event.toolPayload?.toolID == "get_current_datetime"
            || event.activityStepID?.contains("get_current_datetime") == true
            || event.activityStepID == "currentDateTime"
    }

    private static func terminalEvent(in events: [AgentEventEnvelope]) -> AgentEventEnvelope? {
        events.last {
            switch $0.kind {
            case .taskSucceeded, .taskPartiallySucceeded, .taskFailed, .taskCancelled,
                 .runCompleted, .runFailed, .runCancelled:
                return true
            default:
                return false
            }
        }
    }

    private static func firstWaitingEvent(in events: [AgentEventEnvelope]) -> AgentEventEnvelope? {
        events.first {
            switch $0.kind {
            case .toolPermissionRequired, .waitingForUser:
                return true
            default:
                return false
            }
        }
    }

    private static func hasOrdinaryGenerationEvent(in events: [AgentEventEnvelope]) -> Bool {
        events.contains {
            switch $0.kind {
            case .modelRequestStarted, .modelResponseStreaming, .modelResponseCompleted,
                 .providerRequestStarted, .providerResponseReceived, .taskStarted,
                 .runStarted, .runRetryStarted:
                return true
            default:
                return false
            }
        }
    }

    private static func terminalTitle(for event: AgentEventEnvelope) -> String {
        switch event.kind {
        case .taskSucceeded, .taskPartiallySucceeded, .runCompleted:
            return "已完成"
        case .taskCancelled, .runCancelled:
            return "已停止"
        case .taskFailed, .runFailed:
            return "操作失败"
        default:
            return "任务结束"
        }
    }

    private static func terminalSubtitle(for event: AgentEventEnvelope) -> String? {
        switch event.kind {
        case .taskFailed, .runFailed, .taskPartiallySucceeded:
            return userFacingFailureSubtitle(event.safeSubtitle ?? event.safeTitle)
        default:
            return nil
        }
    }

    private static func userFacingFailureSubtitle(_ raw: String) -> String {
        let lower = raw.lowercased()
        if lower.contains("401") || lower.contains("auth") {
            return "API Key 无效或已失效。"
        }
        if lower.contains("404") || lower.contains("model not found") {
            return "当前选择的模型不可用。"
        }
        if lower.contains("permission") || lower.contains("denied") || lower.contains("拒绝") {
            return "已取消这个操作。"
        }
        if lower.contains("connection") || lower.contains("network") || lower.contains("provider") {
            return "暂时无法连接到模型。"
        }
        if raw.contains("{") || raw.contains("_") {
            return "这个操作没有完成。"
        }
        return raw
    }

    private static func reduceToolEvent(_ event: AgentEventEnvelope,
                                        into items: inout [AgentActivityItem],
                                        indexByKey: inout [String: Int],
                                        visibility: AgentEventVisibility) {
        let tool = event.toolPayload
        let toolID = tool?.toolID ?? event.activityToolID ?? "tool"
        let metadata = ToolPresentationMetadata.metadata(for: toolID)
        let key = tool?.toolExecutionID?.uuidString
            ?? tool?.toolCallID
            ?? event.activityStepID
            ?? "\(event.runID.uuidString)-\(toolID)"
        let status = activityStatus(for: event.kind)
        let title = title(for: status, metadata: metadata, fallback: event.safeTitle)
        let detail = detail(for: event, visibility: visibility)
        if let index = indexByKey[key] {
            items[index].status = statusPriority(items[index].status, status)
            items[index].title = title
            items[index].subtitle = event.safeSubtitle ?? items[index].subtitle
            items[index].finishedAt = status.isTerminal ? event.timestamp : items[index].finishedAt
            items[index].progress = event.progress ?? items[index].progress
            items[index].details.append(detail)
            items[index].isExpandable = true
        } else {
            let item = AgentActivityItem(id: event.id,
                                         taskID: event.taskID,
                                         runID: event.runID,
                                         stepID: event.activityStepID,
                                         category: metadata.category,
                                         title: title,
                                         subtitle: event.safeSubtitle,
                                         status: status,
                                         startedAt: event.timestamp,
                                         finishedAt: status.isTerminal ? event.timestamp : nil,
                                         progress: event.progress,
                                         details: [detail],
                                         isExpandable: metadata.defaultExpanded)
            indexByKey[key] = items.count
            items.append(item)
        }
    }

    private static func item(for event: AgentEventEnvelope,
                             visibility: AgentEventVisibility) -> AgentActivityItem {
        AgentActivityItem(id: event.id,
                          taskID: event.taskID,
                          runID: event.runID,
                          stepID: event.activityStepID,
                          category: category(for: event.kind),
                          title: event.safeTitle,
                          subtitle: event.safeSubtitle,
                          status: activityStatus(for: event.kind),
                          startedAt: event.timestamp,
                          finishedAt: activityStatus(for: event.kind).isTerminal ? event.timestamp : nil,
                          progress: event.progress,
                          details: [detail(for: event, visibility: visibility)],
                          isExpandable: visibility != .user)
    }

    private static func title(for status: AgentActivityStatus,
                              metadata: ToolPresentationMetadata,
                              fallback: String) -> String {
        switch status {
        case .succeeded:
            return metadata.succeededTitle
        case .failed, .cancelled:
            return metadata.failedTitle
        case .running:
            return metadata.runningTitle
        case .waiting:
            return "等待确认：\(metadata.displayName)"
        case .pending:
            return "准备操作：\(metadata.displayName)"
        case .skipped:
            return "已跳过：\(metadata.displayName)"
        }
    }

    private static func detail(for event: AgentEventEnvelope,
                               visibility: AgentEventVisibility) -> AgentActivityDetail {
        let developerValue = [
            "kind=\(event.kind.rawValue)",
            "sequence=\(event.sequence)"
        ].joined(separator: " ")
        let value: String?
        if visibility == .user {
            value = event.safeSubtitle
        } else {
            value = [developerValue, event.safeSubtitle].compactMap { $0 }.joined(separator: " · ")
        }
        return AgentActivityDetail(title: event.kind.rawValue,
                                   value: value,
                                   visibility: visibility == .user ? .user : .developer)
    }

    private static func activityStatus(for kind: AgentEventKind) -> AgentActivityStatus {
        switch kind {
        case .taskCreated, .taskQueued, .runStarted, .runRetryStarted, .toolRequested, .toolValidated:
            return .pending
        case .taskWaitingForRetry, .taskRecovered:
            return .running
        case .taskStarted, .taskResumed, .stepStarted, .stepProgress, .modelRequestStarted,
             .modelResponseStreaming, .toolStarted, .toolProgress, .providerRequestStarted,
             .verificationStarted, .recoveryStarted:
            return .running
        case .toolPermissionRequired, .waitingForUser, .uiInteractionRequested:
            return .waiting
        case .taskSucceeded, .taskPartiallySucceeded, .runCompleted, .stepSucceeded,
             .modelResponseCompleted, .toolPermissionGranted, .toolSucceeded,
             .observationProduced, .observationDeliveredToModel, .providerResponseReceived,
             .userActionReceived, .uiInteractionResolved, .verificationSucceeded, .recoverySucceeded,
             .resultProduced, .resultSnapshot, .resultPatch:
            return .succeeded
        case .taskFailed, .runFailed, .stepFailed, .modelRequestFailed, .toolValidationFailed,
             .toolPermissionDenied, .toolFailed, .providerAuthenticationFailed, .providerUnavailable,
             .providerRequestFailed, .verificationFailed, .recoveryFailed:
            return .failed
        case .taskCancelled, .runCancelled, .toolCancelled, .userActionCancelled:
            return .cancelled
        case .stepSkipped:
            return .skipped
        case .taskPaused:
            return .waiting
        case .taskInterrupted, .providerRateLimited, .warning, .diagnostic, .userActionTimedOut, .unknown:
            return .failed
        }
    }

    private static func statusPriority(_ current: AgentActivityStatus,
                                       _ incoming: AgentActivityStatus) -> AgentActivityStatus {
        if incoming.isTerminal { return incoming }
        if current.isTerminal { return current }
        if incoming == .waiting { return .waiting }
        if incoming == .running { return .running }
        return current
    }

    private static func category(for kind: AgentEventKind) -> AgentActivityCategory {
        switch kind {
        case .providerRequestStarted, .providerResponseReceived, .providerRateLimited,
             .providerAuthenticationFailed, .providerUnavailable, .providerRequestFailed:
            return .provider
        case .toolRequested, .toolValidated, .toolValidationFailed, .toolPermissionRequired,
             .toolPermissionGranted, .toolPermissionDenied, .toolStarted, .toolProgress,
             .toolSucceeded, .toolFailed, .toolCancelled, .observationProduced, .observationDeliveredToModel:
            return .tool
        case .waitingForUser, .userActionReceived, .userActionCancelled, .userActionTimedOut,
             .uiInteractionRequested, .uiInteractionResolved:
            return .userAction
        case .warning, .diagnostic:
            return .warning
        case .verificationStarted, .verificationSucceeded, .verificationFailed,
             .resultProduced, .resultSnapshot, .resultPatch:
            return .result
        case .taskSucceeded, .taskPartiallySucceeded, .taskFailed, .taskCancelled, .runCompleted,
             .runFailed, .runCancelled:
            return .result
        default:
            return .planning
        }
    }
}

private extension AgentActivityStatus {
    var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .cancelled, .skipped:
            return true
        case .pending, .running, .waiting:
            return false
        }
    }
}

private extension AgentEventEnvelope {
    var toolPayload: AgentEventPayload.ToolPayload? {
        guard case .tool(let payload) = payload else { return nil }
        return payload
    }

    var activityPayload: AgentEventPayload.ActivityPayload? {
        guard case .activity(let payload) = payload else { return nil }
        return payload
    }

    var activityToolID: String? {
        activityPayload?.toolID
    }

    var activityStepID: String? {
        switch payload {
        case .activity(let value):
            return value.stepID
        case .step(let value):
            return value.stepID
        default:
            return nil
        }
    }

    var progress: Double? {
        switch payload {
        case .step(let value):
            return value.progress
        default:
            return nil
        }
    }

    var safeTitle: String {
        switch payload {
        case .activity(let value):
            return value.title
        case .task(let value):
            return value.title
        case .step(let value):
            return value.title
        case .model(let value):
            return value.safeSummary ?? kind.rawValue
        case .tool(let value):
            return value.safeSummary ?? value.displayName
        case .permission(let value):
            return value.safeReason ?? value.capabilityID
        case .provider(let value):
            return value.safeSummary ?? value.errorCategory ?? kind.rawValue
        case .userAction(let value):
            return value.safeSummary ?? value.action
        case .result(let value):
            return value.title
        case .failure(let value):
            return value.safeSummary
        case .diagnostic(let value):
            return value.safeSummary
        case .run(let value):
            return value.reason ?? kind.rawValue
        case .empty:
            return kind.rawValue
        }
    }

    var safeSubtitle: String? {
        switch payload {
        case .activity(let value):
            return value.detail
        case .failure(let value):
            return value.category
        case .provider(let value):
            return value.httpStatus.map { "HTTP \($0)" } ?? value.errorCategory
        case .tool(let value):
            return value.resultCategory ?? value.errorCategory ?? value.riskLevel
        case .result(let value):
            return value.summary
        default:
            return nil
        }
    }
}
