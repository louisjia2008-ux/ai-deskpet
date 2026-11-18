import Foundation
import AICore

// P13-D: Post-execute hook for tool results.
//
// Before P13, redaction of model-visible tool results happened at *activity*
// time (AgentPrivacyRedactor.safeSummary / AgentTaskActivityRedactor.safeText).
// That meant the model still received raw calendar `title` / `location`
// fields, raw reasoning text, raw internal tool identifiers, etc. The kernel
// and UI then redacted the *display* copy.
//
// P13-D adds a hooks seam so the *model-visible* result is rewritten before it
// leaves the registry. The hook chain runs in registration order; each hook
// receives the previous hook's output and returns either a replacement value
// or nil to preserve the current value. The chain is total — every hook must
// not throw; throwing hooks are caught by the registry and logged, the chain
// continues.

/// A typed tool execution identity. Stable across the whole tool-call
/// lifecycle: registration, gate, side-effect ledger, execution, post-hook.
public struct ToolExecutionIdentity: Sendable, Equatable, Hashable {
    public var toolID: String
    public var callID: String
    public var taskID: UUID?
    public var runID: UUID?

    public init(toolID: String, callID: String, taskID: UUID? = nil, runID: UUID? = nil) {
        self.toolID = toolID
        self.callID = callID
        self.taskID = taskID
        self.runID = runID
    }
}

/// The input/output pair for a post-execute hook. The `value` is the canonical
/// lossless-JSON result the tool produced; hooks may rewrite it (or rewrite
/// the model-facing `userSafeSummary` / `modelContent`) before the kernel
/// forwards the result to the model.
public struct ToolPostExecuteContext: Sendable {
    public var identity: ToolExecutionIdentity
    public var toolArguments: [String: AgentJSONValue]
    public var value: AgentJSONValue
    public var userSafeSummary: String
    public var modelContent: String?
    public var status: ToolExecutionStatus

    public init(identity: ToolExecutionIdentity,
                toolArguments: [String: AgentJSONValue],
                value: AgentJSONValue,
                userSafeSummary: String,
                modelContent: String? = nil,
                status: ToolExecutionStatus) {
        self.identity = identity
        self.toolArguments = toolArguments
        self.value = value
        self.userSafeSummary = userSafeSummary
        self.modelContent = modelContent
        self.status = status
    }
}

public protocol ToolPostExecuteHook: Sendable {
    /// Human-readable identifier for diagnostics (must not leak to UI text).
    var hookID: String { get }
    /// Pure synchronous classifier; returns true when this hook should run for
    /// the given context. The kernel calls hooks in registration order until
    /// one returns nil for the value/summary pair, at which point the chain
    /// stops.
    func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext?
}

/// Reference implementation that redacts reasoning / thinking tokens and
/// privacy tokens from the model-visible value and user-safe summary. This
/// logic was previously split between `AgentPrivacyRedactor.safeSummary`
/// (Sources/PetAgentRuntime/AgentLoopModels.swift:460-468) and
/// `AgentTaskActivityRedactor.safeText` (Sources/PetAgentRuntime/AgentTaskActivityModels.swift:716-739).
public struct PrivacyToolPostExecuteHook: ToolPostExecuteHook {
    public let hookID: String

    public init(hookID: String = "privacy") {
        self.hookID = hookID
    }

    /// Forbidden privacy tokens. Mirrors the legacy `AgentPrivacyRedactor.safeText` policy.
    public static let forbiddenTokens: [String] = [
        "reasoning", "thinking", "analysis",
        "推理", "思维链", "分析用户", "根据我的推理"
    ]

    /// True if any forbidden token appears in `text` (case-sensitive substring match per token).
    public static func containsForbiddenToken(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        let joined = forbiddenTokens.joined(separator: "|")
        return text.range(of: joined, options: [.regularExpression]) != nil
    }

    /// INV-RESULT-07 — Apply the canonical privacy transformation to a legacy `RuntimeTool`
    /// result text. Used by the legacy `RuntimeTool.invoke` path through
    /// `PresentationActionExecutor`. Returns the original text if clean, `"[redacted]"`
    /// if a forbidden token is present.
    public static func sanitizeLegacyText(_ text: String) -> String {
        guard !text.isEmpty else { return "[redacted]" }
        if containsForbiddenToken(text) { return "[redacted]" }
        return text
    }

    /// INV-RESULT-05 — Walk the JSON value and redact forbidden tokens at the leaf level.
    /// Preserves the structural shape (objects stay objects, arrays stay arrays). If a leaf
    /// string contains a forbidden token, the leaf is replaced with `.string("[redacted]")`.
    /// If a leaf is empty and forbidden, it is also redacted.
    public static func redactLeaf(_ value: AgentJSONValue) -> AgentJSONValue {
        switch value {
        case .string(let s):
            if containsForbiddenToken(s) { return .string("[redacted]") }
            return .string(s)
        case .array(let items):
            return .array(items.map(redactLeaf))
        case .object(let dict):
            var newDict: [String: AgentJSONValue] = [:]
            for (k, v) in dict {
                newDict[k] = redactLeaf(v)
            }
            return .object(newDict)
        case .number, .bool, .null:
            return value
        }
    }

    public func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
        var updated = context
        // INV-RESULT-05 — Apply leaf-level redaction so the structured shape is preserved.
        updated.value = Self.redactLeaf(context.value)

        let joined = Self.forbiddenTokens.joined(separator: "|")
        let forbiddenInSummary = context.userSafeSummary.range(of: joined, options: [.regularExpression]) != nil
        if forbiddenInSummary {
            updated.userSafeSummary = "[redacted]"
        } else {
            let summaryResult = AgentPrivacyRedactor.safeText(context.userSafeSummary, maxLength: 200)
            updated.userSafeSummary = summaryResult.text
        }
        if let modelContent = context.modelContent,
           modelContent.range(of: joined, options: [.regularExpression]) != nil {
            updated.modelContent = "[redacted]"
        }
        return updated
    }
}

public enum ToolPostExecuteHookChainOutcome: Sendable {
    case rewritten(ToolPostExecuteContext)
    case hookFailed(hookID: String, fallback: ToolPostExecuteContext)
}

/// Run a list of hooks in order. A nil return short-circuits the chain and
/// the latest non-nil context is returned. A throw (which should never
/// happen for a well-behaved hook) is logged as `hookFailed` and the chain
/// continues with the previous context.
public struct ToolPostExecuteHookChain: Sendable {
    public var hooks: [any ToolPostExecuteHook]

    public init(hooks: [any ToolPostExecuteHook] = []) {
        self.hooks = hooks
    }

    public func run(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext {
        var current = context
        for hook in hooks {
            if let next = hook.rewrite(current) {
                current = next
            }
        }
        return current
    }
}