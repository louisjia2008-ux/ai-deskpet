import Foundation
import AICore

public enum AgentTaskEventKind: String, Codable, Sendable, Hashable, CaseIterable {
    case taskCreated
    case taskQueued
    case planningStarted
    case planProposed
    case approvalRequested
    case approvalGranted
    case approvalDenied
    case executionStarted
    case stepStarted
    case stepProgress
    case stepSucceeded
    case stepFailed
    case stepSkipped
    case replanStarted
    case replanSucceeded
    case replanFailed
    case verificationStarted
    case verificationSucceeded
    case verificationFailed
    case userInteractionRequested
    case userInteractionResolved
    case synthesisStarted
    case synthesisSucceeded
    case resultProduced
    case modelRequestStarted
    case modelResponseStreaming
    case modelResponseCompleted
    case modelRequestFailed
    case providerRequestStarted
    case providerResponseReceived
    case providerRateLimited
    case providerAuthenticationFailed
    case providerUnavailable
    case providerRequestFailed
    case taskSucceeded
    case taskPartiallySucceeded
    case taskFailed
    case taskCancelled
    case taskInterrupted
    case taskWaitingForRetry
    case taskRecovered
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentTaskEventKind(rawValue: raw) ?? .unknown
    }
}

public enum AgentTaskOrigin: String, Codable, Sendable, Hashable, CaseIterable {
    case chat
    case quickChat
    case scheduled
    case retry
    case system

    public init(source: AgentEventSource) {
        switch source {
        case .chat:
            self = .chat
        case .scheduler:
            self = .system
        case .runtime, .agentLoop, .toolRuntime, .permissionGate, .provider, .replay, .system:
            self = .system
        }
    }

    public init(safeRawValue rawValue: String?) {
        guard let rawValue, let value = AgentTaskOrigin(rawValue: rawValue) else {
            self = .system
            return
        }
        self = value
    }
}

public enum AgentTaskStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case created
    case queued
    case planning
    case waitingForApproval
    case waitingForPermission
    case waitingForUser
    case running
    case paused
    case synthesizing
    case partiallySucceeded
    case succeeded
    case failed
    case cancelled
    case interrupted
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentTaskStatus(rawValue: raw) ?? .unknown
    }

    public var isTerminal: Bool {
        switch self {
        case .succeeded, .partiallySucceeded, .failed, .cancelled:
            return true
        case .created, .queued, .planning, .waitingForApproval, .waitingForPermission, .waitingForUser,
             .running, .paused, .synthesizing, .interrupted, .unknown:
            return false
        }
    }
}

public enum AgentTaskFailureCategory: String, Codable, Sendable, Hashable, CaseIterable {
    case permissionDenied
    case approvalRejected
    case approvalTimedOut
    case planningFailed
    case validationFailed
    case toolTimedOut
    case toolFailed
    case providerUnavailable
    case synthesisFailed
    case cancelled
    case interrupted
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentTaskFailureCategory(rawValue: raw) ?? .unknown
    }
}

public struct AgentTaskEventPresentation: Codable, Sendable, Hashable {
    public var title: String
    public var detail: String?

    public init(title: String, detail: String? = nil) {
        self.title = AgentTaskActivityRedactor.safePresentation(title, fallback: "正在处理")
        self.detail = detail.map { AgentTaskActivityRedactor.safePresentation($0, fallback: "详情已隐藏") }
    }
}

public struct AgentTaskActivityEvent: Codable, Sendable, Hashable, Identifiable {
    public var schemaVersion: Int
    public var eventID: UUID
    public var taskID: UUID
    public var runID: UUID
    public var conversationID: UUID?
    public var userMessageID: UUID?
    public var sequenceNumber: Int
    public var timestamp: Date
    public var kind: AgentTaskEventKind
    public var presentation: AgentTaskEventPresentation
    public var stepID: String?
    public var toolID: ToolID?
    public var failureCategory: AgentTaskFailureCategory?
    public var source: AgentEventSource?
    public var origin: AgentTaskOrigin?
    public var providerKind: String?
    public var modelID: String?
    public var scheduleID: UUID?
    public var resultDocument: AgentResultDocument?

    public var id: UUID { eventID }

    public init(schemaVersion: Int = 1,
                eventID: UUID = UUID(),
                taskID: UUID,
                runID: UUID,
                conversationID: UUID? = nil,
                userMessageID: UUID? = nil,
                sequenceNumber: Int,
                timestamp: Date = Date(),
                kind: AgentTaskEventKind,
                presentation: AgentTaskEventPresentation,
                stepID: String? = nil,
                toolID: ToolID? = nil,
                failureCategory: AgentTaskFailureCategory? = nil,
                source: AgentEventSource? = nil,
                origin: AgentTaskOrigin? = nil,
                providerKind: String? = nil,
                modelID: String? = nil,
                scheduleID: UUID? = nil,
                resultDocument: AgentResultDocument? = nil) {
        self.schemaVersion = schemaVersion
        self.eventID = eventID
        self.taskID = taskID
        self.runID = runID
        self.conversationID = conversationID
        self.userMessageID = userMessageID
        self.sequenceNumber = max(0, sequenceNumber)
        self.timestamp = timestamp
        self.kind = kind
        self.presentation = AgentTaskEventPresentation(title: presentation.title, detail: presentation.detail)
        self.stepID = stepID.map { AgentPrivacyRedactor.safeIdentifier($0, fallback: "step") }
        self.toolID = toolID
        self.failureCategory = failureCategory
        self.source = source
        self.origin = origin
        self.providerKind = providerKind.map(AgentEventRedactor.safeIdentifier)
        self.modelID = modelID.map(AgentEventRedactor.safeIdentifier)
        self.scheduleID = scheduleID
        self.resultDocument = resultDocument
    }
}

public struct AgentTaskRunActivity: Codable, Sendable, Hashable, Identifiable {
    public var taskID: UUID
    public var runID: UUID
    public var conversationID: UUID?
    public var userMessageID: UUID?
    public var status: AgentTaskStatus
    public var events: [AgentTaskActivityEvent]
    public var createdAt: Date
    public var updatedAt: Date
    public var completedAt: Date?
    public var currentStepTitle: String?
    public var completedStepCount: Int
    public var totalStepCount: Int?
    public var terminalSummary: String?
    public var failureCategory: AgentTaskFailureCategory?
    public var source: AgentEventSource?
    public var origin: AgentTaskOrigin?
    public var providerKind: String?
    public var modelID: String?
    public var scheduleID: UUID?
    public var resultDocument: AgentResultDocument?

    public var id: UUID { runID }
    public var isWaitingForApproval: Bool { status == .waitingForApproval }
    public var canShowStopAction: Bool {
        status == .running
    }
    public var userVisibleEvents: [AgentTaskActivityEvent] {
        AgentTaskUserActivityPresenter.events(for: self)
    }
    public var userVisibleTerminalSummary: String? {
        AgentTaskUserActivityPresenter.terminalSummary(for: self)
    }

    public init(taskID: UUID,
                runID: UUID,
                conversationID: UUID? = nil,
                userMessageID: UUID? = nil,
                status: AgentTaskStatus = .queued,
                events: [AgentTaskActivityEvent] = [],
                createdAt: Date,
                updatedAt: Date,
                completedAt: Date? = nil,
                currentStepTitle: String? = nil,
                completedStepCount: Int = 0,
                totalStepCount: Int? = nil,
                terminalSummary: String? = nil,
                failureCategory: AgentTaskFailureCategory? = nil,
                source: AgentEventSource? = nil,
                origin: AgentTaskOrigin? = nil,
                providerKind: String? = nil,
                modelID: String? = nil,
                scheduleID: UUID? = nil,
                resultDocument: AgentResultDocument? = nil) {
        self.taskID = taskID
        self.runID = runID
        self.conversationID = conversationID
        self.userMessageID = userMessageID
        self.status = status
        self.events = events
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
        self.currentStepTitle = currentStepTitle
        self.completedStepCount = completedStepCount
        self.totalStepCount = totalStepCount
        self.terminalSummary = terminalSummary
        self.failureCategory = failureCategory
        self.source = source
        self.origin = origin
        self.providerKind = providerKind
        self.modelID = modelID
        self.scheduleID = scheduleID
        self.resultDocument = resultDocument
    }
}

public struct AgentTaskActivitySnapshot: Codable, Sendable, Hashable, Identifiable {
    public var taskID: UUID
    public var runs: [AgentTaskRunActivity]

    public var id: UUID { taskID }
    public var latestRun: AgentTaskRunActivity? {
        runs.enumerated().max { lhs, rhs in
            if lhs.element.updatedAt != rhs.element.updatedAt {
                return lhs.element.updatedAt < rhs.element.updatedAt
            }
            if lhs.element.createdAt != rhs.element.createdAt {
                return lhs.element.createdAt < rhs.element.createdAt
            }
            return lhs.offset < rhs.offset
        }?.element
    }
    public var status: AgentTaskStatus { latestRun?.status ?? .unknown }
    public var isTerminal: Bool { status.isTerminal }
    public var title: String { latestRun?.events.first?.presentation.title ?? "任务" }
    public var updatedAt: Date { latestRun?.updatedAt ?? .distantPast }

    public init(taskID: UUID, runs: [AgentTaskRunActivity]) {
        self.taskID = taskID
        self.runs = runs.enumerated().sorted { lhs, rhs in
            if lhs.element.createdAt != rhs.element.createdAt {
                return lhs.element.createdAt < rhs.element.createdAt
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }
}

public enum AgentTaskActivityRedactor {
    public static func safePresentation(_ raw: String, fallback: String) -> String {
        var text = AgentPrivacyRedactor.safeText(raw, maxLength: 160).text
        let replacements: [(String, String)] = [
            (#"(?i)authorization\s*[:=]\s*[^\s,;]+"#, "Authorization [redacted]"),
            (#"(?i)cookie\s*[:=]\s*[^\s,;]+"#, "Cookie [redacted]"),
            (#"(?i)reasoning_content"#, "reasoning [redacted]"),
            (#"(?i)chain[- ]of[- ]thought"#, "reasoning [redacted]"),
            (#"(?i)calendar\s+(title|location)\s*[:=]\s*[^\n]+"#, "calendar private field [redacted]"),
            (#"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, "[redacted-email]"),
            (#"\{[^{}]{0,240}\}"#, "[redacted-json]"),
        ]
        for (pattern, replacement) in replacements {
            text = replace(pattern: pattern, in: text, with: replacement)
        }
        let lowered = text.lowercased()
        let forbidden = ["reasoning", "thinking", "analysis", "思维链", "推理过程", "calendar title", "calendar location"]
        if text.isEmpty || forbidden.contains(where: { lowered.contains($0) }) {
            return fallback
        }
        return text
    }

    public static func redacted(_ event: AgentTaskActivityEvent) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(
            schemaVersion: event.schemaVersion,
            eventID: event.eventID,
            taskID: event.taskID,
            runID: event.runID,
            conversationID: event.conversationID,
            userMessageID: event.userMessageID,
            sequenceNumber: event.sequenceNumber,
            timestamp: event.timestamp,
            kind: event.kind,
            presentation: event.presentation,
            stepID: event.stepID,
            toolID: event.toolID,
            failureCategory: event.failureCategory,
            source: event.source,
            origin: event.origin,
            providerKind: event.providerKind,
            modelID: event.modelID,
            scheduleID: event.scheduleID,
            resultDocument: event.resultDocument)
    }

    private static func replace(pattern: String, in input: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return input }
        let range = NSRange(input.startIndex..<input.endIndex, in: input)
        return regex.stringByReplacingMatches(in: input, range: range, withTemplate: replacement)
    }
}

public enum AgentTaskActivityReducer {
    public static func reduce(taskID: UUID, events: [AgentTaskActivityEvent]) -> AgentTaskActivitySnapshot {
        let filtered = events.filter { $0.taskID == taskID }
        let grouped = Dictionary(grouping: filtered, by: \.runID)
        var firstSeenIndexByRunID: [UUID: Int] = [:]
        for (index, event) in filtered.enumerated() where firstSeenIndexByRunID[event.runID] == nil {
            firstSeenIndexByRunID[event.runID] = index
        }
        let runs = grouped.map { _, runEvents in reduceRun(events: runEvents) }.sorted {
            (firstSeenIndexByRunID[$0.runID] ?? Int.max) < (firstSeenIndexByRunID[$1.runID] ?? Int.max)
        }
        return AgentTaskActivitySnapshot(taskID: taskID, runs: runs)
    }

    public static func reduceRun(events rawEvents: [AgentTaskActivityEvent]) -> AgentTaskRunActivity {
        let sorted = rawEvents.enumerated().sorted { lhs, rhs in
            let left = lhs.element
            let right = rhs.element
            if left.runID == right.runID,
               left.source == right.source,
               left.sequenceNumber != right.sequenceNumber {
                return left.sequenceNumber < right.sequenceNumber
            }
            if left.timestamp != right.timestamp {
                return left.timestamp < right.timestamp
            }
            if left.sequenceNumber != right.sequenceNumber {
                return left.sequenceNumber < right.sequenceNumber
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
        guard let first = sorted.first else {
            let id = UUID()
            return AgentTaskRunActivity(taskID: id, runID: id, createdAt: .distantPast, updatedAt: .distantPast)
        }

        var accepted: [AgentTaskActivityEvent] = []
        var status: AgentTaskStatus = .queued
        var completedStepIDs = Set<String>()
        var seenStepIDs = Set<String>()
        var currentStepTitle: String?
        var terminalSummary: String?
        var completedAt: Date?
        var failureCategory: AgentTaskFailureCategory?
        var source: AgentEventSource?
        var origin: AgentTaskOrigin?
        var providerKind: String?
        var modelID: String?
        var scheduleID: UUID?
        var resultDocument: AgentResultDocument?

        for event in sorted {
            guard event.taskID == first.taskID, event.runID == first.runID else { continue }
            guard isLegal(event.kind, from: status) else { continue }
            accepted.append(event)
            source = source ?? event.source
            if origin == nil || origin == .system {
                origin = event.origin ?? origin
            }
            scheduleID = scheduleID ?? event.scheduleID
            providerKind = event.providerKind ?? providerKind
            modelID = event.modelID ?? modelID
            if let stepID = event.stepID { seenStepIDs.insert(stepID) }
            switch event.kind {
            case .stepStarted:
                currentStepTitle = event.presentation.title
            case .stepSucceeded:
                if let stepID = event.stepID { completedStepIDs.insert(stepID) }
                currentStepTitle = nil
            case .stepFailed, .stepSkipped, .verificationSucceeded:
                currentStepTitle = nil
            case .verificationStarted:
                currentStepTitle = event.presentation.title
            case .verificationFailed:
                currentStepTitle = nil
            case .taskSucceeded, .taskFailed, .taskCancelled:
                terminalSummary = event.presentation.title
                completedAt = event.timestamp
                failureCategory = event.failureCategory
                currentStepTitle = nil
            case .resultProduced:
                resultDocument = event.resultDocument ?? resultDocument
            default:
                break
            }
            status = nextStatus(after: event.kind, current: status)
            if status.isTerminal, completedAt == nil {
                completedAt = event.timestamp
            }
        }

        return AgentTaskRunActivity(
            taskID: first.taskID,
            runID: first.runID,
            conversationID: first.conversationID,
            userMessageID: first.userMessageID,
            status: status,
            events: accepted,
            createdAt: accepted.first?.timestamp ?? first.timestamp,
            updatedAt: accepted.last?.timestamp ?? first.timestamp,
            completedAt: completedAt,
            currentStepTitle: currentStepTitle,
            completedStepCount: completedStepIDs.count,
            totalStepCount: seenStepIDs.isEmpty ? nil : seenStepIDs.count,
            terminalSummary: terminalSummary,
            failureCategory: failureCategory,
            source: source,
            origin: origin,
            providerKind: providerKind,
            modelID: modelID,
            scheduleID: scheduleID,
            resultDocument: resultDocument)
    }

    public static func isLegal(_ kind: AgentTaskEventKind, from status: AgentTaskStatus) -> Bool {
        if status.isTerminal {
            return [.userInteractionResolved, .resultProduced].contains(kind)
        }
        switch status {
        case .waitingForApproval, .waitingForPermission:
            return [.approvalGranted, .approvalDenied, .taskCancelled, .taskFailed].contains(kind)
        case .created, .queued:
            return true
        case .planning:
            return kind != .taskCreated
        case .running:
            return kind != .planningStarted && kind != .planProposed && kind != .taskCreated
        case .synthesizing:
            return [.verificationStarted, .verificationSucceeded, .verificationFailed,
                    .userInteractionRequested, .userInteractionResolved,
                    .synthesisStarted, .synthesisSucceeded, .resultProduced,
                    .taskSucceeded, .taskPartiallySucceeded, .taskFailed, .taskCancelled].contains(kind)
        case .waitingForUser:
            return [.userInteractionResolved, .approvalGranted, .approvalDenied, .taskCancelled, .taskFailed].contains(kind)
        case .paused:
            return [.taskQueued, .executionStarted, .taskCancelled, .taskFailed].contains(kind)
        case .interrupted:
            return [.taskQueued, .taskCancelled, .taskFailed].contains(kind)
        case .unknown:
            return true
        case .partiallySucceeded, .succeeded, .failed, .cancelled:
            return false
        }
    }

    public static func nextStatus(after kind: AgentTaskEventKind,
                                  current: AgentTaskStatus) -> AgentTaskStatus {
        if current.isTerminal, [.userInteractionResolved, .resultProduced].contains(kind) {
            return current
        }
        switch kind {
        case .taskCreated:
            return current == .unknown ? .queued : current
        case .taskQueued:
            return .queued
        case .planningStarted, .planProposed:
            return .planning
        case .approvalRequested:
            return .waitingForApproval
        case .approvalGranted, .executionStarted, .stepStarted, .stepProgress, .stepSucceeded, .stepFailed,
             .stepSkipped, .replanStarted, .replanSucceeded, .replanFailed, .verificationStarted,
             .verificationSucceeded, .userInteractionResolved:
            return .running
        case .userInteractionRequested:
            return .waitingForUser
        case .verificationFailed:
            return .running
        case .approvalDenied:
            return .failed
        case .modelRequestStarted, .modelResponseStreaming, .modelResponseCompleted:
            return .running
        case .modelRequestFailed:
            return .failed
        case .providerRequestStarted, .providerResponseReceived:
            return .running
        case .providerRateLimited, .providerAuthenticationFailed, .providerUnavailable, .providerRequestFailed:
            return .failed
        case .synthesisStarted, .synthesisSucceeded, .resultProduced:
            return .synthesizing
        case .taskWaitingForRetry:
            return .running
        case .taskRecovered:
            return .running
        case .taskSucceeded:
            return .succeeded
        case .taskPartiallySucceeded:
            return .partiallySucceeded
        case .taskFailed:
            return .failed
        case .taskCancelled:
            return .cancelled
        case .taskInterrupted:
            return .interrupted
        case .unknown:
            return current
        }
    }
}

public enum AgentTaskUserActivityPresenter {
    public static func events(for run: AgentTaskRunActivity) -> [AgentTaskActivityEvent] {
        var result: [AgentTaskActivityEvent] = []
        if let started = firstDateTimeEvent(in: run, kinds: [.stepStarted, .stepProgress]) {
            result.append(displayEvent(from: started,
                                       kind: .stepStarted,
                                       title: "正在获取本地日期和时间…",
                                       detail: nil,
                                       stepID: "currentDateTime",
                                       toolID: ToolID(rawValue: "get_current_datetime")))
        }
        if let succeeded = firstDateTimeEvent(in: run, kinds: [.stepSucceeded]) {
            result.append(displayEvent(from: succeeded,
                                       kind: .stepSucceeded,
                                       title: "已获取本地日期和时间",
                                       detail: nil,
                                       stepID: "currentDateTime",
                                       toolID: ToolID(rawValue: "get_current_datetime")))
        } else if let failed = firstDateTimeEvent(in: run, kinds: [.stepFailed, .stepSkipped]) {
            result.append(displayEvent(from: failed,
                                       kind: .stepFailed,
                                       title: "未能获取本地日期和时间",
                                       detail: userFacingFailureSummary(for: run, terminal: failed),
                                       stepID: "currentDateTime",
                                       toolID: ToolID(rawValue: "get_current_datetime"),
                                       failureCategory: failed.failureCategory))
        }
        // P15 — surface verification step ("已验证工具结果") for the date-time
        // tool so users can see that the runtime confirmed the tool result.
        if firstDateTimeEvent(in: run, kinds: [.stepSucceeded]) != nil,
           let verified = firstDateTimeVerificationEvent(in: run) {
            result.append(displayEvent(from: verified,
                                       kind: .verificationSucceeded,
                                       title: "已验证工具结果",
                                       detail: nil,
                                       stepID: "currentDateTimeVerification",
                                       toolID: ToolID(rawValue: "get_current_datetime")))
        } else if !run.status.isTerminal, !run.isWaitingForApproval {
            let base = run.events.last ?? placeholderBase(for: run)
            result.append(displayEvent(from: base,
                                       kind: .modelResponseStreaming,
                                       title: "正在生成回复……",
                                       detail: nil))
        }

        if let terminal = terminalEvent(in: run) {
            result.append(displayEvent(from: terminal,
                                       kind: terminal.kind,
                                       title: terminalTitle(for: run),
                                       detail: terminalDetail(for: run, terminal: terminal),
                                       failureCategory: terminal.failureCategory))
        }

        if result.isEmpty, run.isWaitingForApproval, let event = run.events.last {
            result.append(displayEvent(from: event,
                                       kind: event.kind,
                                       title: "等待你的确认",
                                       detail: userFacingPermissionDetail(from: event)))
        }

        return result
    }

    public static func terminalSummary(for run: AgentTaskRunActivity) -> String? {
        guard run.status.isTerminal else { return nil }
        switch run.status {
        case .succeeded:
            let steps = max(1, run.totalStepCount ?? run.completedStepCount)
            return "已完成 · \(steps) 个步骤 · 用时 \(durationText(for: run))"
        case .partiallySucceeded:
            return "部分完成 · 用时 \(durationText(for: run))"
        case .failed:
            return userFacingFailureSummary(for: run)
        case .cancelled:
            return "已停止"
        default:
            return run.terminalSummary
        }
    }

    private static func firstDateTimeEvent(in run: AgentTaskRunActivity,
                                           kinds: Set<AgentTaskEventKind>) -> AgentTaskActivityEvent? {
        run.events.first {
            kinds.contains($0.kind)
                && ($0.toolID?.rawValue == "get_current_datetime"
                    || $0.stepID?.contains("get_current_datetime") == true
                    || $0.stepID == "currentDateTime")
        }
    }

    private static func firstDateTimeVerificationEvent(in run: AgentTaskRunActivity) -> AgentTaskActivityEvent? {
        run.events.first { event in
            (event.kind == .verificationSucceeded || event.kind == .verificationStarted)
                && (event.toolID?.rawValue == "get_current_datetime"
                    || event.stepID?.contains("get_current_datetime") == true
                    || event.stepID == "currentDateTimeVerification")
        }
    }

    private static func terminalEvent(in run: AgentTaskRunActivity) -> AgentTaskActivityEvent? {
        run.events.last {
            [.taskSucceeded, .taskPartiallySucceeded, .taskFailed, .taskCancelled].contains($0.kind)
        }
    }

    private static func terminalTitle(for run: AgentTaskRunActivity) -> String {
        switch run.status {
        case .succeeded:
            return "已完成"
        case .partiallySucceeded:
            return "部分完成"
        case .failed:
            return "操作失败"
        case .cancelled:
            return "已停止"
        default:
            return run.terminalSummary ?? "任务结束"
        }
    }

    private static func terminalDetail(for run: AgentTaskRunActivity,
                                       terminal: AgentTaskActivityEvent) -> String? {
        switch run.status {
        case .succeeded:
            return terminalSummary(for: run)
        case .failed, .partiallySucceeded:
            return userFacingFailureSummary(for: run, terminal: terminal)
        default:
            return terminal.presentation.detail
        }
    }

    private static func userFacingPermissionDetail(from event: AgentTaskActivityEvent) -> String {
        guard let detail = event.presentation.detail, !detail.isEmpty else {
            return "需要你的允许才能继续。"
        }
        let lower = detail.lowercased()
        if lower.contains(".") || lower.contains("_") {
            return "需要你的允许才能继续。"
        }
        return detail
    }

    private static func userFacingFailureSummary(for run: AgentTaskRunActivity,
                                                 terminal: AgentTaskActivityEvent? = nil) -> String {
        let category = terminal?.failureCategory ?? run.events.last?.failureCategory
        let raw = [terminal?.presentation.detail, run.terminalSummary]
            .compactMap { $0 }
            .first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if category == .providerUnavailable, let raw {
            return userFacingFailureSummary(fromRawText: raw)
        }
        switch category {
        case .permissionDenied, .approvalRejected, .approvalTimedOut:
            return "已取消这个操作。"
        case .providerUnavailable:
            return "暂时无法连接到模型。"
        case .toolTimedOut, .toolFailed, .validationFailed:
            return "这个操作没有完成。"
        case .interrupted:
            return "上次生成被应用重启打断，可以重试。"
        case .cancelled:
            return "已停止"
        case .planningFailed, .synthesisFailed:
            return "回复没有完成。"
        case .unknown, .none:
            break
        }

        guard let raw else { return "这个操作没有完成。" }
        return userFacingFailureSummary(fromRawText: raw)
    }

    private static func userFacingFailureSummary(fromRawText raw: String) -> String {
        let lower = raw.lowercased()
        if lower.contains("restart") || lower.contains("interrupted") || lower.contains("重启") {
            return "上次生成被应用重启打断，可以重试。"
        }
        if lower.contains("permission") || lower.contains("denied") || lower.contains("拒绝") {
            return "已取消这个操作。"
        }
        if lower.contains("401") || lower.contains("auth") {
            return "API Key 无效或已失效。"
        }
        if lower.contains("404") || lower.contains("model not found") {
            return "当前选择的模型不可用。"
        }
        if lower.contains("api key") || lower.contains("missing key") || lower.contains("empty") {
            return "还没有可用的 AI 模型。"
        }
        if lower.contains("network") || lower.contains("connection") || lower.contains("provider") {
            return "暂时无法连接到模型。"
        }
        if raw.contains(".") || raw.contains("_") || raw.contains("{") {
            return "这个操作没有完成。"
        }
        return AgentTaskActivityRedactor.safePresentation(raw, fallback: "这个操作没有完成。")
    }

    private static func durationText(for run: AgentTaskRunActivity) -> String {
        guard let completedAt = run.completedAt else { return "<1 秒" }
        let duration = max(0, completedAt.timeIntervalSince(run.createdAt))
        if duration < 1 { return "<1 秒" }
        return String(format: "%.1f 秒", duration)
    }

    private static func displayEvent(from event: AgentTaskActivityEvent,
                                     kind: AgentTaskEventKind,
                                     title: String,
                                     detail: String?,
                                     stepID: String? = nil,
                                     toolID: ToolID? = nil,
                                     failureCategory: AgentTaskFailureCategory? = nil) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(eventID: event.eventID,
                               taskID: event.taskID,
                               runID: event.runID,
                               conversationID: event.conversationID,
                               userMessageID: event.userMessageID,
                               sequenceNumber: event.sequenceNumber,
                               timestamp: event.timestamp,
                               kind: kind,
                               presentation: .init(title: title, detail: detail),
                               stepID: stepID ?? event.stepID,
                               toolID: toolID ?? event.toolID,
                               failureCategory: failureCategory ?? event.failureCategory,
                               source: event.source,
                               origin: event.origin,
                               providerKind: event.providerKind,
                               modelID: event.modelID,
                               scheduleID: event.scheduleID)
    }

    private static func placeholderBase(for run: AgentTaskRunActivity) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(taskID: run.taskID,
                               runID: run.runID,
                               conversationID: run.conversationID,
                               userMessageID: run.userMessageID,
                               sequenceNumber: 0,
                               timestamp: run.updatedAt,
                               kind: .modelResponseStreaming,
                               presentation: .init(title: "正在思考…"),
                               origin: run.origin,
                               providerKind: run.providerKind,
                               modelID: run.modelID,
                               scheduleID: run.scheduleID)
    }
}

public protocol AgentTaskActivityEventPersisting: Sendable {
    func append(_ event: AgentTaskActivityEvent) async throws
    func loadEvents() async throws -> [AgentTaskActivityEvent]
    func replaceAll(_ events: [AgentTaskActivityEvent]) async throws
    func clear() async throws
}

public actor JSONLAgentTaskActivityEventStore: AgentTaskActivityEventPersisting {
    private let url: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileURL: URL) {
        self.url = fileURL
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
    }

    public static func defaultStore() -> JSONLAgentTaskActivityEventStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DeskPet", isDirectory: true)
        return JSONLAgentTaskActivityEventStore(fileURL: base.appendingPathComponent("agent_task_activity.jsonl"))
    }

    public func append(_ event: AgentTaskActivityEvent) async throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try encoder.encode(AgentTaskActivityRedactor.redacted(event))
        let payload = try SealedStore.sealLine(data)
        let line = payload + Data([0x0A])
        if FileManager.default.fileExists(atPath: url.path) {
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try handle.close()
        } else {
            try line.write(to: url, options: .atomic)
        }
    }

    public func loadEvents() async throws -> [AgentTaskActivityEvent] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let data = try Data(contentsOf: url)
        guard let raw = String(data: data, encoding: .utf8) else { return [] }
        return raw.split(separator: "\n").compactMap { line in
            guard let lineData = line.data(using: .utf8),
                  let plain = try? SealedStore.openLine(lineData) else { return nil }
            return try? decoder.decode(AgentTaskActivityEvent.self, from: plain)
        }
    }

    public func replaceAll(_ events: [AgentTaskActivityEvent]) async throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let lines = try events.map { try encoder.encode(AgentTaskActivityRedactor.redacted($0)) }
        var data = Data()
        for line in lines {
            data.append(try SealedStore.sealLine(line))
            data.append(0x0A)
        }
        try data.write(to: url, options: .atomic)
    }

    public func clear() async throws {
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }
}
