import Foundation
import AICore
import PetBrainCore
import PetAgentRuntime

// App-side adapters that back the NATIVE PetAgentRuntime with real services. No OpenClaw anywhere.

/// Builds runtime context from the same boundary for chat and proactive paths. Private chats do
/// not receive long-term memory hints.
final class AppAgentContextBuilder: AgentContextBuilding, @unchecked Sendable {
    private let repository: PetBrainRepository
    init(repository: PetBrainRepository) { self.repository = repository }

    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event {
            let hints = message.conversationClass == .privateChat
                ? []
                : await repository.memoryHints(forCloud: false)
            return AgentContext(userText: message.text,
                                memoryHints: hints,
                                intentContext: message.metadata.intentContext)
        }
        return AgentContext()
    }
}

/// StructuredDecisionProviding — a temporary, explicit rule-based fallback. Tool-shaped requests
/// become untrusted proposals only after semantic traps are filtered; everything else returns an
/// empty `.respond`, which tells the Coordinator to invoke the conversation provider. This provider
/// never generates chat text, grants permission, or executes tools.
final class ReasoningModelAdapter: StructuredDecisionProviding, @unchecked Sendable {
    init() {}

    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        // P1 agentic loop: once any step has been executed this task, the rule-based stub has nothing
        // more to propose — converge to a concise final answer based on sanitized observations.
        // A real structured-decision model would instead reason over the observations here.
        if !context.observations.isEmpty {
            let summary = context.observations.suffix(3).map { observation in
                "\(observation.capabilityID)：\(observation.summary)"
            }.joined(separator: "\n")
            return StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: summary)),
                                            decisionSource: .ruleBasedFallback,
                                            validationResult: .valid, modelProvider: "rule-based-fallback")
        }
        let text = context.userText ?? ""
        let decision: AgentDecision
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            decision = .noAction(NoActionDecision(reason: "no user text"))
        } else if Self.isDangerousUnsupportedRequest(text) {
            decision = .decline(DeclineDecision(reason: "这个请求涉及高风险或不受支持的直接执行，我不能处理。"))
        } else if Self.isReminderText(text) {
            decision = Self.reminderDecision(for: text, availableCapabilities: availableCapabilities)
        } else if let cap = AssistantCapabilityMap.capability(for: text),
                  (availableCapabilities.contains(cap.capability) || Self.requiresToolExecution(cap.capability)),
                  !Self.isSemanticTrap(text) {
            decision = .proposePlan(AgentPlanProposal(goal: text, steps: [
                AgentPlanProposalStep(id: "step-1", description: cap.reason,
                                      capabilityID: cap.capability)
            ]))
        } else {
            decision = .respond(ConversationResponseDecision())
        }
        return StructuredDecisionResult(decision: decision, decisionSource: .ruleBasedFallback,
                                        validationResult: .valid, modelProvider: "rule-based-fallback")
    }

    private static func reminderDecision(for text: String,
                                         availableCapabilities: CapabilityCatalogSnapshot) -> AgentDecision {
        if isSemanticTrap(text) {
            return .respond(ConversationResponseDecision())
        }
        guard hasUsableReminderTime(text) else {
            return .askClarification(ClarificationDecision(question: "需要什么时候提醒你？"))
        }
        let capabilityID = availableCapabilities.contains("reminder.local.create")
            ? "reminder.local.create"
            : "reminders.create"
        guard availableCapabilities.contains(capabilityID) else {
            return .decline(DeclineDecision(reason: "当前模式不允许创建提醒。"))
        }
        return .proposePlan(AgentPlanProposal(goal: text, steps: [
            AgentPlanProposalStep(
                id: "reminder-1",
                description: "创建本地提醒",
                capabilityID: capabilityID,
                arguments: [
                    "title": reminderTitle(from: text),
                    "resolvedDate": "requires-local-resolution",
                    "timezone": TimeZone.current.identifier
                ])
        ]))
    }

    private static func isReminderText(_ text: String) -> Bool {
        text.contains("提醒")
    }

    private static func requiresToolExecution(_ capabilityID: String) -> Bool {
        capabilityID == "get_current_datetime"
    }

    private static func isSemanticTrap(_ text: String) -> Bool {
        let traps = ["不要提醒", "不用提醒", "别提醒", "已经设", "已经设置", "解释", "怎么设置", "如何设置",
                     "如果", "假设", "别人说", "他说", "她说", "他们说", "引用", "“提醒", "\"提醒"]
        return traps.contains { text.contains($0) }
    }

    private static func hasUsableReminderTime(_ text: String) -> Bool {
        if text.range(of: #"\d{1,2}[:：]\d{2}"#, options: .regularExpression) != nil { return true }
        let timeWords = ["今天", "明天", "后天", "早上", "上午", "中午", "下午", "晚上", "今晚", "点", "分钟后", "小时后"]
        return timeWords.contains { text.contains($0) }
    }

    private static func reminderTitle(from text: String) -> String {
        let stripped = text
            .replacingOccurrences(of: "提醒我", with: "")
            .replacingOccurrences(of: "提醒", with: "")
        let title = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "提醒事项" : String(title.prefix(80))
    }

    private static func isDangerousUnsupportedRequest(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return lowered.contains("rm -rf") ||
            lowered.contains("shell.execute") ||
            lowered.contains("sudo ") ||
            text.contains("删除所有") ||
            text.contains("绕过权限")
    }
}

/// Demoted legacy conversation provider: owns text generation through the existing app AI service,
/// but it does not publish messages, mutate the task ledger, or call tools.
final class LegacyConversationProvider: ConversationGenerating, @unchecked Sendable {
    let streamingCapability: ConversationProviderStreamingCapability = .nonStreaming
    private let services: AIServices
    init(_ services: AIServices) { self.services = services }

    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                let response = try await services.generate(ModelRequest(text: request.text,
                                                                          memoryHints: request.memoryHints,
                                                                          route: .character,
                                                                          isPrivate: request.isPrivate,
                                                                          useScreen: request.useScreen,
                                                                          requiresMemory: false))
                if Task.isCancelled {
                    continuation.finish()
                    return
                }
                if response.kind == .error {
                    continuation.finish(throwing: ConversationGenerationError(message: response.text))
                    return
                }
                continuation.yield(.metadata(.nonStreaming))
                continuation.yield(.delta(sequence: 1, text: response.text))
                let emotion = response.emotionProposal
                    .map { EmotionReducer().apply($0, to: .neutral, elapsed: 0).dominant } ?? .neutral
                continuation.yield(.completed(emotion: emotion,
                                              viaCloud: response.viaCloud))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// P14.2 — R-B-F01 closure. Production-reachable typed-failure path.
    /// When `AIServices.classify(error)` returns a `LlmFailure`, this
    /// method surfaces it directly so the coordinator's `converse()`
    /// catch block can route the typed failure into
    /// `AgentRetryPolicy.shouldRetry(llmFailure:)` rather than relying
    /// on stringly-typed `errorCategory: "runtimeFailed"`.
    func typedGenerate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { @MainActor in
                do {
                    let response = try await services.generateTyped(ModelRequest(text: request.text,
                                                                                 memoryHints: request.memoryHints,
                                                                                 route: .character,
                                                                                 isPrivate: request.isPrivate,
                                                                                 useScreen: request.useScreen,
                                                                                 requiresMemory: false))
                    if Task.isCancelled {
                        continuation.finish(); return
                    }
                    if response.ok {
                        continuation.yield(.metadata(.nonStreaming))
                        continuation.yield(.delta(sequence: 1, text: response.reply))
                        let emotion = response.emotionProposal
                            .map { EmotionReducer().apply($0, to: .neutral, elapsed: 0).dominant } ?? .neutral
                        continuation.yield(.completed(emotion: emotion, viaCloud: response.viaCloud))
                        continuation.finish()
                    } else {
                        // The `AIServices.generateTyped(...)` path already
                        // routes through `Self.classify(...)` so we have a
                        // typed `LlmFailure` available.
                        let llmFailure = response.llmFailure
                            ?? LlmFailure(code: .unknown, message: response.reply)
                        continuation.yield(.typedError(llmFailure))
                        continuation.finish(throwing: ConversationGenerationError(message: llmFailure.message))
                    }
                } catch {
                    // P18.5 — INV-CANCEL-04: a cancellation is not a provider
                    // failure. Drop it silently (mirrors the `Task.isCancelled`
                    // guard on the success path above) so the coordinator sees
                    // a clean stream end rather than a `.typedError` chunk that
                    // would be recorded/surfaced as a failure.
                    if error is CancellationError || Task.isCancelled {
                        continuation.finish()
                        return
                    }
                    let llmFailure = AIServices.classify(error)
                        ?? LlmFailure(code: .unknown, message: String(describing: error))
                    continuation.yield(.typedError(llmFailure))
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// The async approval callback the gate consults for P1+ effects (P3). Returns the user's decision.
typealias CapabilityApprover = @Sendable (_ capabilityID: String, _ reason: String, _ risk: RiskLevel) async -> ApprovalDecision

/// CapabilityGate backed by the real Capability Broker. The runtime calls this for EVERY side
/// effect; the model/planner can't reach it. P0 auto-grants. P1+ go through the injected approver
/// (P3); with no approver wired the gate stays fail-closed (`.askUser`). Session-trusted capabilities
/// and the "trust reversible this session" switch skip the prompt.
actor BrokerCapabilityGate: CapabilityGate {
    private var broker: CapabilityBroker
    private var approver: CapabilityApprover?
    private var sessionTrusted: Set<String> = []
    private var trustReversibleThisSession = false
    /// When set, the current run is an unattended scheduled task — P1+ effects never prompt (P5).
    private var autonomousRun: ScheduledAutonomy?

    init(tier: DistributionTier, approver: CapabilityApprover? = nil) {
        self.broker = CapabilityBroker(tier: tier)
        self.approver = approver
    }

    func setApprover(_ approver: CapabilityApprover?) { self.approver = approver }
    func setTrustReversible(_ on: Bool) { trustReversibleThisSession = on }
    /// Marks (or clears) that effects evaluated now belong to an unattended scheduled run.
    func setAutonomousRun(_ autonomy: ScheduledAutonomy?) { autonomousRun = autonomy }
    /// Clears session trust (e.g. on logout / new session).
    func resetSessionTrust() { sessionTrusted.removeAll(); trustReversibleThisSession = false }

    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        let req = GrantRequest(capabilityID: capabilityID, reason: reason, taskID: taskID, duration: .onceImmediate)
        switch broker.request(req) {
        case .denied(let r):
            return .denied(reason: r)                          // tier ceiling etc. — wins over everything
        case .granted(let g):
            return .granted(g.token)
        case .needsApproval(let level, _):
            if level == .auto { return grantOrDeny(req) }      // P0
            // Unattended scheduled run: no human to prompt → only pre-authorized caps run, rest defer.
            if let autonomy = autonomousRun {
                switch autonomy {
                case .notifyOnly: return .askUser
                case .preauthorized(let caps): return caps.contains(capabilityID) ? grantOrDeny(req) : .askUser
                }
            }
            let risk = CapabilityCatalog.lookup(capabilityID)?.risk ?? .p4
            if sessionTrusted.contains(capabilityID) { return grantOrDeny(req) }
            if trustReversibleThisSession, risk == .p1 || risk == .p2 { return grantOrDeny(req) }
            guard let approver else { return .askUser }        // fail-closed when no UI approver
            switch await approver(capabilityID, reason, risk) {
            case .deny: return .denied(reason: "用户拒绝")
            case .allowSession: sessionTrusted.insert(capabilityID); return grantOrDeny(req)
            case .allowOnce: return grantOrDeny(req)
            }
        }
    }

    private func grantOrDeny(_ req: GrantRequest) -> GateOutcome {
        guard let g = broker.approve(req) else { return .denied(reason: "授权失败") }
        return .granted(g.token)
    }
}

/// P4 self-evolution: turns a finished tool-task into *suggested* memories via the pure
/// `TaskReflector`, then files them through the de-duped `MemoryModel.suggest`. Suggestions need user
/// confirmation before they influence future context — this sink never writes a confirmed memory,
/// grants a capability, or changes code.
struct MemoryReflectionSink: ReflectionSink {
    let memory: MemoryModel
    init(_ memory: MemoryModel) { self.memory = memory }
    func reflect(_ input: TaskReflectionInput) async {
        let candidates = TaskReflector.reflectCandidates(input)
        await reflectCandidates(candidates)
    }

    func reflectCandidates(_ candidates: [MemoryCandidate]) async {
        guard !candidates.isEmpty else { return }
        await MainActor.run { memory.ingest(candidates) }
    }
}

/// ToolExecuting via the isolated out-of-process ToolRunner. Reached ONLY after a grant.
final class IsolatedToolExecutor: ToolExecuting, @unchecked Sendable {
    private let runner: ToolRunnerService
    init(_ runner: ToolRunnerService) { self.runner = runner }
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        // Defense in depth: fail closed before IPC on expired/bound-mismatched tokens.
        // The runner re-checks independently (it does not trust the app process).
        guard Date() < token.expiresAt else {
            return ToolOutcome(ok: false, output: "", error: "token expired")
        }
        if let bound = token.capabilityID, bound != step.capabilityID {
            return ToolOutcome(ok: false, output: "", error: "token not bound to \(step.capabilityID)")
        }
        let inv = ToolInvocation(capabilityID: step.capabilityID, token: token, params: step.params)
        let r = await runner.invoke(inv)
        return ToolOutcome(ok: r.ok, output: r.output, error: r.error)
    }
}
