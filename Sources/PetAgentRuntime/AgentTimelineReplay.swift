import Foundation

public enum AgentReplayFilter: String, Codable, Sendable, Hashable, CaseIterable {
    case all
    case toolsOnly
    case errorsOnly
    case userActionsOnly
}

public struct AgentFailureFocus: Codable, Sendable, Hashable {
    public var phase: String
    public var category: String
    public var toolID: String?
    public var retryable: Bool
    public var suggestedAction: String

    public init(phase: String,
                category: String,
                toolID: String? = nil,
                retryable: Bool,
                suggestedAction: String) {
        self.phase = AgentEventRedactor.safeIdentifier(phase)
        self.category = AgentEventRedactor.safeIdentifier(category)
        self.toolID = toolID.map(AgentEventRedactor.safeIdentifier)
        self.retryable = retryable
        self.suggestedAction = AgentEventRedactor.safeText(suggestedAction, maxLength: 180)
    }
}

public struct AgentTimelineReplayState: Codable, Sendable, Hashable {
    public var schemaVersion: Int
    public var taskID: UUID
    public var runID: UUID?
    public var allEvents: [AgentEventEnvelope]
    public var activeIndex: Int
    public var filter: AgentReplayFilter
    public var playbackRate: Double
    public var isPlaying: Bool

    public var visibleEvents: [AgentEventEnvelope] {
        filteredEvents.prefix(max(0, min(activeIndex + 1, filteredEvents.count))).map { $0 }
    }

    public var filteredEvents: [AgentEventEnvelope] {
        allEvents.sortedForReplay().filter { event in
            switch filter {
            case .all:
                return true
            case .toolsOnly:
                return event.kind.isToolEvent
            case .errorsOnly:
                return event.kind.isFailureEvent
            case .userActionsOnly:
                return event.kind.isUserActionEvent
            }
        }
    }

    public init(schemaVersion: Int = 1,
                taskID: UUID,
                runID: UUID? = nil,
                events: [AgentEventEnvelope],
                activeIndex: Int = 0,
                filter: AgentReplayFilter = .all,
                playbackRate: Double = 1,
                isPlaying: Bool = false) {
        self.schemaVersion = schemaVersion
        self.taskID = taskID
        self.runID = runID
        self.allEvents = events.map { AgentEventRedactor.redact($0, level: .diagnostic) }.sortedForReplay()
        self.activeIndex = max(0, activeIndex)
        self.filter = filter
        self.playbackRate = min(max(playbackRate, 0.5), 4)
        self.isPlaying = isPlaying
    }

    public func play() -> AgentTimelineReplayState {
        var copy = self
        copy.isPlaying = true
        return copy
    }

    public func pause() -> AgentTimelineReplayState {
        var copy = self
        copy.isPlaying = false
        return copy
    }

    public func restart() -> AgentTimelineReplayState {
        var copy = self
        copy.activeIndex = 0
        copy.isPlaying = false
        return copy
    }

    public func jumpToEnd() -> AgentTimelineReplayState {
        var copy = self
        copy.activeIndex = max(0, filteredEvents.count - 1)
        copy.isPlaying = false
        return copy
    }

    public func seek(to index: Int) -> AgentTimelineReplayState {
        var copy = self
        copy.activeIndex = max(0, min(index, max(0, filteredEvents.count - 1)))
        return copy
    }

    public func withFilter(_ filter: AgentReplayFilter) -> AgentTimelineReplayState {
        var copy = self
        copy.filter = filter
        copy.activeIndex = min(copy.activeIndex, max(0, copy.filteredEvents.count - 1))
        return copy
    }

    public func withPlaybackRate(_ rate: Double) -> AgentTimelineReplayState {
        var copy = self
        copy.playbackRate = min(max(rate, 0.5), 4)
        return copy
    }

    public func nextFrame() -> AgentTimelineReplayState {
        var copy = self
        copy.activeIndex = min(copy.activeIndex + 1, max(0, filteredEvents.count - 1))
        if copy.activeIndex >= max(0, filteredEvents.count - 1) {
            copy.isPlaying = false
        }
        return copy
    }

    public func jumpToFailure() -> AgentTimelineReplayState {
        guard let index = filteredEvents.firstIndex(where: { $0.kind.isFailureEvent }) else { return self }
        return seek(to: index)
    }

    public func jumpToPermissionWait() -> AgentTimelineReplayState {
        guard let index = filteredEvents.firstIndex(where: { $0.kind == .toolPermissionRequired || $0.kind == .waitingForUser }) else {
            return self
        }
        return seek(to: index)
    }

    public func failureFocus() -> AgentFailureFocus? {
        guard let failure = allEvents.sortedForReplay().first(where: { $0.kind.isFailureEvent }) else { return nil }
        switch failure.payload {
        case .failure(let payload):
            return AgentFailureFocus(phase: payload.phase,
                                     category: payload.category,
                                     retryable: payload.retryable,
                                     suggestedAction: payload.retryable ? "检查参数后重试" : "需要人工处理后再运行")
        case .tool(let payload):
            return AgentFailureFocus(phase: "tool",
                                     category: payload.errorCategory ?? failure.kind.rawValue,
                                     toolID: payload.toolID,
                                     retryable: payload.retryable ?? false,
                                     suggestedAction: payload.retryable == true ? "重试该任务" : "检查工具设置")
        case .activity(let payload):
            return AgentFailureFocus(phase: "runtime",
                                     category: payload.failureCategory ?? failure.kind.rawValue,
                                     toolID: payload.toolID,
                                     retryable: payload.failureCategory != "permissionDenied",
                                     suggestedAction: payload.failureCategory == "permissionDenied" ? "重新授权后再试" : "查看详情后重试")
        default:
            return AgentFailureFocus(phase: failure.source.rawValue,
                                     category: failure.kind.rawValue,
                                     retryable: false,
                                     suggestedAction: "查看脱敏诊断详情")
        }
    }
}

public struct AgentDiagnosticReport: Codable, Sendable, Hashable {
    public var schemaVersion: Int
    public var appVersion: String
    public var buildVersion: String
    public var macOSVersion: String
    public var taskID: UUID
    public var runID: UUID?
    public var providerKind: String?
    public var modelID: String?
    public var generatedAt: Date
    public var events: [AgentEventEnvelope]
    public var failureFocus: AgentFailureFocus?
    public var featureFlags: [String]

    public init(schemaVersion: Int = 1,
                appVersion: String = "unknown",
                buildVersion: String = "unknown",
                macOSVersion: String = ProcessInfo.processInfo.operatingSystemVersionString,
                taskID: UUID,
                runID: UUID? = nil,
                providerKind: String? = nil,
                modelID: String? = nil,
                generatedAt: Date = Date(),
                events: [AgentEventEnvelope],
                failureFocus: AgentFailureFocus? = nil,
                featureFlags: [String] = []) {
        self.schemaVersion = schemaVersion
        self.appVersion = AgentEventRedactor.safeIdentifier(appVersion)
        self.buildVersion = AgentEventRedactor.safeIdentifier(buildVersion)
        self.macOSVersion = AgentEventRedactor.safeText(macOSVersion, maxLength: 80)
        self.taskID = taskID
        self.runID = runID
        self.providerKind = providerKind.map(AgentEventRedactor.safeIdentifier)
        self.modelID = modelID.map(AgentEventRedactor.safeIdentifier)
        self.generatedAt = generatedAt
        self.events = events.map { AgentEventRedactor.redact($0, level: .diagnostic) }.sortedForReplay()
        self.failureFocus = failureFocus
        self.featureFlags = featureFlags.map(AgentEventRedactor.safeIdentifier)
    }
}

public enum AgentDiagnosticExportFormat: String, Sendable, Hashable, CaseIterable {
    case json
    case markdown
}

public enum AgentDiagnosticExporter {
    public static func report(taskID: UUID,
                              runID: UUID? = nil,
                              events: [AgentEventEnvelope],
                              appVersion: String = "unknown",
                              buildVersion: String = "unknown",
                              providerKind: String? = nil,
                              modelID: String? = nil,
                              featureFlags: [String] = [],
                              generatedAt: Date = Date()) -> AgentDiagnosticReport {
        let replay = AgentTimelineReplayState(taskID: taskID, runID: runID, events: events)
        return AgentDiagnosticReport(appVersion: appVersion,
                                     buildVersion: buildVersion,
                                     taskID: taskID,
                                     runID: runID,
                                     providerKind: providerKind,
                                     modelID: modelID,
                                     generatedAt: generatedAt,
                                     events: events,
                                     failureFocus: replay.failureFocus(),
                                     featureFlags: featureFlags)
    }

    public static func export(_ report: AgentDiagnosticReport,
                              format: AgentDiagnosticExportFormat) throws -> Data {
        switch format {
        case .json:
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            return try encoder.encode(report)
        case .markdown:
            return Data(markdown(report).utf8)
        }
    }

    public static func markdown(_ report: AgentDiagnosticReport) -> String {
        var lines: [String] = [
            "# DeskPet Agent Diagnostic Report",
            "",
            "- Schema: \(report.schemaVersion)",
            "- App: \(report.appVersion) (\(report.buildVersion))",
            "- macOS: \(report.macOSVersion)",
            "- Task: \(report.taskID.uuidString)",
            "- Run: \(report.runID?.uuidString ?? "all")",
            "- Provider: \(report.providerKind ?? "unknown")",
            "- Model: \(report.modelID ?? "unknown")",
            "- Generated: \(ISO8601DateFormatter().string(from: report.generatedAt))",
            ""
        ]
        if let focus = report.failureFocus {
            lines.append("## Failure Focus")
            lines.append("")
            lines.append("- Phase: \(focus.phase)")
            lines.append("- Category: \(focus.category)")
            lines.append("- Tool: \(focus.toolID ?? "n/a")")
            lines.append("- Retryable: \(focus.retryable ? "yes" : "no")")
            lines.append("- Suggested Action: \(focus.suggestedAction)")
            lines.append("")
        }
        lines.append("## Timeline")
        lines.append("")
        for event in report.events.sortedForReplay() {
            lines.append("- [\(event.sequence)] \(event.kind.rawValue) · \(event.source.rawValue) · \(event.payload.safeMarkdownSummary)")
        }
        lines.append("")
        return AgentEventRedactor.safeText(lines.joined(separator: "\n"), maxLength: 40_000)
    }
}

private extension AgentEventPayload {
    var safeMarkdownSummary: String {
        switch self {
        case .empty:
            return ""
        case .activity(let value):
            return [value.title, value.detail].compactMap { $0 }.joined(separator: " - ")
        case .task(let value):
            return [value.title, value.status].compactMap { $0 }.joined(separator: " - ")
        case .run(let value):
            return value.reason ?? "run"
        case .step(let value):
            return [value.title, value.safeSummary].compactMap { $0 }.joined(separator: " - ")
        case .model(let value):
            return value.safeSummary ?? value.finishReason ?? "model"
        case .tool(let value):
            return [value.displayName, value.safeSummary, value.errorCategory].compactMap { $0 }.joined(separator: " - ")
        case .permission(let value):
            return [value.capabilityID, value.decision, value.safeReason].compactMap { $0 }.joined(separator: " - ")
        case .provider(let value):
            return [value.providerKind, value.modelID, value.safeSummary, value.errorCategory].compactMap { $0 }.joined(separator: " - ")
        case .userAction(let value):
            return [value.action, value.safeSummary].compactMap { $0 }.joined(separator: " - ")
        case .result(let value):
            return [value.title, value.summary].joined(separator: " - ")
        case .failure(let value):
            return [value.phase, value.category, value.safeSummary].joined(separator: " - ")
        case .diagnostic(let value):
            return [value.category, value.safeSummary].joined(separator: " - ")
        }
    }
}

private extension AgentEventKind {
    var isToolEvent: Bool {
        switch self {
        case .toolRequested, .toolValidated, .toolValidationFailed, .toolPermissionRequired,
             .toolPermissionGranted, .toolPermissionDenied, .toolStarted, .toolProgress,
             .toolSucceeded, .toolFailed, .toolCancelled, .observationProduced,
             .observationDeliveredToModel:
            return true
        default:
            return false
        }
    }

    var isFailureEvent: Bool {
        switch self {
        case .taskFailed, .runFailed, .stepFailed, .modelRequestFailed, .toolValidationFailed,
             .toolPermissionDenied, .toolFailed, .providerAuthenticationFailed, .providerUnavailable,
             .providerRequestFailed, .recoveryFailed, .taskInterrupted, .warning:
            return true
        default:
            return false
        }
    }

    var isUserActionEvent: Bool {
        switch self {
        case .waitingForUser, .userActionReceived, .userActionCancelled, .userActionTimedOut,
             .uiInteractionRequested, .uiInteractionResolved,
             .toolPermissionRequired, .toolPermissionGranted, .toolPermissionDenied:
            return true
        default:
            return false
        }
    }
}
