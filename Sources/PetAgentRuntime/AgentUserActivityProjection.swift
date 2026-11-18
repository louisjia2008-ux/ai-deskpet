import Foundation

/// P15 — Runtime → Product Activity Projection.
///
/// This is the AUTHORITATIVE source of user-visible execution state for
/// all DeskPet UI surfaces (FloatingChat, ChatView, TaskActivityCard,
/// history bubbles, control panels).
///
/// Design contract:
/// - Single source of truth; UI never independently infers core task truth.
/// - Tool IDs, provider IDs, attempt IDs, scheduler wakeups, raw errors,
///   raw JSON, internal prompts, model thinking/reasoning, internal tool
///   arguments, and stack traces are STRIPPED at this layer.
/// - Plain semantic phases only — no raw enum cases from runtime.
/// - Equatable + Sendable + Codable for safe transport across actors.
public enum UserActivityPhase: String, Codable, Sendable, Hashable, CaseIterable {
    case idle
    case thinking
    case usingTool
    case waitingForApproval
    case waitingForRetry
    case recovering
    case cancelling
    case completed
    case failed
    case cancelled
}

/// User-visible semantic tool category. NEVER raw tool IDs.
public enum UserToolCategory: String, Codable, Sendable, Hashable, CaseIterable {
    case dateTime
    case location
    case placeSearch
    case route
    case webpage
    case calendar
    case file
    case command
    case automation
    case system
    case generic
}

/// User-visible retry state.
public enum UserRetryState: String, Codable, Sendable, Hashable {
    case none
    case waiting         // waitingForRetry — backoff in progress
    case scheduled       // retryScheduled — wakeup registered
    case retrying        // resumed, re-running provider
    case succeeded       // retry succeeded
    case failed          // retry exhausted or failed
}

/// Authoritative user-visible activity presentation.
public struct AgentUserActivityPresentation: Equatable, Sendable, Codable, Hashable {
    public let phase: UserActivityPhase
    public let title: String
    public let detail: String?
    public let toolCategory: UserToolCategory?
    public let retryState: UserRetryState
    public let canCancel: Bool
    public let requiresApproval: Bool
    public let isRawInternalToolIDVisible: Bool

    public init(phase: UserActivityPhase,
                title: String,
                detail: String? = nil,
                toolCategory: UserToolCategory? = nil,
                retryState: UserRetryState = .none,
                canCancel: Bool = false,
                requiresApproval: Bool = false,
                isRawInternalToolIDVisible: Bool = false) {
        self.phase = phase
        self.title = Self.safeTitle(title)
        self.detail = detail.map(Self.safeTitle)
        self.toolCategory = toolCategory
        self.retryState = retryState
        self.canCancel = canCancel
        self.requiresApproval = requiresApproval
        self.isRawInternalToolIDVisible = isRawInternalToolIDVisible
    }

    public static let idle = AgentUserActivityPresentation(
        phase: .idle,
        title: "等待消息",
        canCancel: false,
        requiresApproval: false
    )

    public static let failed = AgentUserActivityPresentation(
        phase: .failed,
        title: "操作没有完成",
        canCancel: false,
        requiresApproval: false
    )

    public static let cancelled = AgentUserActivityPresentation(
        phase: .cancelled,
        title: "已停止",
        canCancel: false,
        requiresApproval: false
    )

    public static let completed = AgentUserActivityPresentation(
        phase: .completed,
        title: "已完成",
        canCancel: false,
        requiresApproval: false
    )

    static func safeTitle(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "处理中" }
        return String(trimmed.prefix(120))
    }
}

// MARK: - Public projection API

public enum AgentUserActivityProjector {

    /// Project a typed `RuntimeActivitySnapshot` to the user-visible model.
    /// This is the SINGLE entry point all UI surfaces should use.
    public static func project(_ snapshot: RuntimeActivitySnapshot) -> AgentUserActivityPresentation {
        switch snapshot.runtimeState {
        case .idle:
            return .idle
        case .planning:
            return AgentUserActivityPresentation(
                phase: .thinking,
                title: "正在处理请求",
                detail: nil,
                canCancel: false,
                requiresApproval: false)
        case .running:
            return projectRunning(snapshot)
        case .waitingForRetry:
            return AgentUserActivityPresentation(
                phase: .waitingForRetry,
                title: "请求暂时受限，将自动重试…",
                detail: "正在等待重新连接",
                toolCategory: snapshot.toolCategory,
                retryState: .waiting,
                canCancel: true,
                requiresApproval: false)
        case .waitingForApproval:
            return AgentUserActivityPresentation(
                phase: .waitingForApproval,
                title: "等待你的确认",
                detail: snapshot.capabilityFriendlyDetail,
                toolCategory: snapshot.toolCategory,
                retryState: .none,
                canCancel: true,
                requiresApproval: true)
        case .cancelling:
            return AgentUserActivityPresentation(
                phase: .cancelling,
                title: "正在停止…",
                detail: nil,
                canCancel: false,
                requiresApproval: false)
        case .completed:
            return .completed
        case .failed:
            return AgentUserActivityPresentation(
                phase: .failed,
                title: snapshot.userFacingFailureTitle ?? "操作没有完成",
                detail: snapshot.userFacingFailureDetail,
                toolCategory: snapshot.toolCategory,
                canCancel: false,
                requiresApproval: false)
        case .cancelled:
            return .cancelled
        case .recovering:
            return AgentUserActivityPresentation(
                phase: .recovering,
                title: "已恢复，继续处理…",
                detail: snapshot.toolCategory != nil ? "重新执行操作" : nil,
                toolCategory: snapshot.toolCategory,
                retryState: .retrying,
                canCancel: true,
                requiresApproval: false)
        }
    }

    private static func projectRunning(_ snapshot: RuntimeActivitySnapshot) -> AgentUserActivityPresentation {
        if let tool = snapshot.activeToolCall {
            return AgentUserActivityPresentation(
                phase: .usingTool,
                title: tool.userVisibleRunningTitle,
                detail: nil,
                toolCategory: tool.userCategory,
                retryState: .none,
                canCancel: true,
                requiresApproval: false)
        }
        if snapshot.hasThinkingEvent {
            return AgentUserActivityPresentation(
                phase: .thinking,
                title: "正在生成回复",
                detail: nil,
                canCancel: true,
                requiresApproval: false)
        }
        return AgentUserActivityPresentation(
            phase: .thinking,
            title: "正在处理",
            detail: nil,
            canCancel: true,
            requiresApproval: false)
    }
}

// MARK: - Runtime snapshot input (decoupled from internal runtime types)

public enum RuntimeExecutionState: String, Codable, Sendable, Hashable {
    case idle
    case planning
    case running
    case waitingForRetry
    case waitingForApproval
    case cancelling
    case completed
    case failed
    case cancelled
    case recovering
}

public struct RuntimeActivityToolCall: Equatable, Sendable, Hashable, Codable {
    public let internalToolID: String
    public let userVisibleRunningTitle: String
    public let userCategory: UserToolCategory

    public init(internalToolID: String,
                userVisibleRunningTitle: String,
                userCategory: UserToolCategory) {
        self.internalToolID = internalToolID
        self.userVisibleRunningTitle = AgentUserActivityPresentation.safeTitle(userVisibleRunningTitle)
        self.userCategory = userCategory
    }
}

public struct RuntimeActivitySnapshot: Sendable, Codable, Hashable {
    public let runtimeState: RuntimeExecutionState
    public let activeToolCall: RuntimeActivityToolCall?
    public let toolCategory: UserToolCategory?
    public let hasThinkingEvent: Bool
    public let capabilityFriendlyDetail: String?
    public let userFacingFailureTitle: String?
    public let userFacingFailureDetail: String?

    public init(runtimeState: RuntimeExecutionState,
                activeToolCall: RuntimeActivityToolCall? = nil,
                toolCategory: UserToolCategory? = nil,
                hasThinkingEvent: Bool = false,
                capabilityFriendlyDetail: String? = nil,
                userFacingFailureTitle: String? = nil,
                userFacingFailureDetail: String? = nil) {
        self.runtimeState = runtimeState
        self.activeToolCall = activeToolCall
        self.toolCategory = toolCategory
        self.hasThinkingEvent = hasThinkingEvent
        self.capabilityFriendlyDetail = capabilityFriendlyDetail.map(AgentUserActivityPresentation.safeTitle)
        self.userFacingFailureTitle = userFacingFailureTitle.map(AgentUserActivityPresentation.safeTitle)
        self.userFacingFailureDetail = userFacingFailureDetail.map(AgentUserActivityPresentation.safeTitle)
    }
}
