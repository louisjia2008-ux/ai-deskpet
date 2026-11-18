import Foundation
import AICore
import PetBrainCore
import PetAgentRuntime

#if DEBUG
enum AutomationAgentScript: String, Sendable {
    case plainChat = "p8_plain_chat"
    case slowChat = "p8_slow_chat"
    case verifierRepair = "p8_verifier_repair"
    case dynamicChoice = "p8_dynamic_choice"
    case toolFailure = "p8_tool_failure"
    case permissionRequired = "p8_permission_required"
    case unknown

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let raw = environment["DESKPET_AUTOMATION_AGENT_SCRIPT"]
            ?? ProcessInfo.processInfo.arguments.value(after: "--automation-agent-script")
            ?? ""
        self = AutomationAgentScript(rawValue: raw) ?? .unknown
    }
}

private extension [String] {
    func value(after flag: String) -> String? {
        guard let index = firstIndex(of: flag) else { return nil }
        let valueIndex = self.index(after: index)
        guard indices.contains(valueIndex) else { return nil }
        return self[valueIndex]
    }
}

final class AutomationStructuredDecisionProvider: StructuredDecisionProviding, @unchecked Sendable {
    private let script: AutomationAgentScript

    init(script: AutomationAgentScript = AutomationAgentScript()) {
        self.script = script
    }

    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        if Self.isDateTimeRequest(context.userText) {
            return StructuredDecisionResult(
                decision: .proposePlan(AgentPlanProposal(goal: context.userText ?? "P8 datetime tool", steps: [
                    AgentPlanProposalStep(id: "datetime-1",
                                          description: "读取当前日期和时间",
                                          capabilityID: "get_current_datetime")
                ])),
                decisionSource: .ruleBasedFallback,
                modelProvider: "automation-script")
        }
        switch script {
        case .toolFailure:
            return StructuredDecisionResult(
                decision: .proposePlan(AgentPlanProposal(goal: context.userText ?? "P8 tool failure", steps: [
                    AgentPlanProposalStep(id: "fail-1",
                                          description: "先读取允许的系统信息，再验证缺失工具失败状态",
                                          capabilityID: "get_system_profile")
                ])),
                decisionSource: .ruleBasedFallback,
                modelProvider: "automation-script")
        case .permissionRequired:
            return StructuredDecisionResult(
                decision: .proposePlan(AgentPlanProposal(goal: context.userText ?? "P8 permission required", steps: [
                    AgentPlanProposalStep(id: "permission-1",
                                          description: "请求可逆写入权限以验证允许和拒绝路径",
                                          capabilityID: "filesystem.workspace.write",
                                          toolID: "automation.p8_reversible_write")
                ])),
                decisionSource: .ruleBasedFallback,
                modelProvider: "automation-script")
        case .dynamicChoice:
            return StructuredDecisionResult(
                decision: .proposePlan(AgentPlanProposal(goal: context.userText ?? "P8 dynamic choice", steps: [
                    AgentPlanProposalStep(id: "choice-context",
                                          description: "读取系统信息后生成动态选择结果",
                                          capabilityID: "get_system_profile")
                ])),
                decisionSource: .ruleBasedFallback,
                modelProvider: "automation-script")
        default:
            return StructuredDecisionResult(decision: .respond(ConversationResponseDecision()),
                                            decisionSource: .ruleBasedFallback,
                                            modelProvider: "automation-script")
        }
    }

    private static func isDateTimeRequest(_ text: String?) -> Bool {
        let normalized = (text ?? "").lowercased()
        return normalized.contains("date") || normalized.contains("time") || normalized.contains("时间") || normalized.contains("日期")
    }
}

final class AutomationConversationProvider: ConversationGenerating, @unchecked Sendable {
    let streamingCapability: ConversationProviderStreamingCapability = .trueStreaming
    private let script: AutomationAgentScript

    init(script: AutomationAgentScript = AutomationAgentScript()) {
        self.script = script
    }

    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            let script = self.script
            let task = Task {
                continuation.yield(.metadata(.trueStreaming))
                let chunks = Self.chunks(for: script, request: request)
                for (index, chunk) in chunks.enumerated() {
                    if Task.isCancelled {
                        continuation.finish()
                        return
                    }
                    continuation.yield(.delta(sequence: index + 1, text: chunk))
                    try? await Task.sleep(nanoseconds: Self.chunkDelayNanoseconds(for: script))
                }
                continuation.yield(.completed(emotion: .neutral, viaCloud: false))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func chunkDelayNanoseconds(for script: AutomationAgentScript) -> UInt64 {
        script == .slowChat ? 1_400_000_000 : 120_000_000
    }

    private static func chunks(for script: AutomationAgentScript, request: ConversationRequest) -> [String] {
        switch script {
        case .plainChat:
            return ["P8 普通流式聊天：", "已通过真实 ChatModel 和 RuntimeCoordinator。"]
        case .slowChat:
            return [
                "P8 慢速流式聊天开始。",
                " 仍在生成第一段。",
                " 仍在生成第二段。",
                " 仍在生成第三段。",
                " 仍在生成第四段。",
                " 仍在生成第五段。"
            ]
        case .verifierRepair:
            return ["P8 verifier rejection：", "先拒绝过度完成声明，再以部分完成收敛。"]
        case .dynamicChoice:
            return ["P8 动态选择 UI：", "候选已生成，等待用户选择。"]
        default:
            return ["P8 automation reply：", request.text.isEmpty ? "done" : request.text]
        }
    }
}

actor AutomationAgentLoopDecisionProvider: AgentLoopDecisionProviding {
    private let script: AutomationAgentScript

    init(script: AutomationAgentScript = AutomationAgentScript()) {
        self.script = script
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        switch script {
        case .toolFailure:
            return AgentLoopDecisionResult(
                decision: .toolCall(AgentToolCallRequest(callID: "p8-missing-tool",
                                                         toolName: "p8.fixture.missing_tool",
                                                         arguments: .object([:]),
                                                         userVisibleSummary: "执行缺失工具")),
                decisionSource: .modelStructured,
                modelProvider: "automation-script")
        case .permissionRequired:
            if context.observations.isEmpty {
                return AgentLoopDecisionResult(
                    decision: .toolCall(AgentToolCallRequest(callID: "p8-reversible-write",
                                                             toolName: "automation.p8_reversible_write",
                                                             arguments: .object([:]),
                                                             userVisibleSummary: "执行 P8 可逆写入 fixture")),
                    decisionSource: .modelStructured,
                    modelProvider: "automation-script")
            }
            return AgentLoopDecisionResult(
                decision: .finalResponse(AgentFinalResponse(text: "权限路径已完成。")),
                decisionSource: .modelStructured,
                modelProvider: "automation-script")
        case .dynamicChoice:
            return AgentLoopDecisionResult(
                decision: .finalResponse(AgentFinalResponse(text: "候选结果已生成。")),
                decisionSource: .modelStructured,
                resultDocument: Self.choiceDocument(),
                modelProvider: "automation-script")
        case .verifierRepair:
            return AgentLoopDecisionResult(
                decision: .finalResponse(AgentFinalResponse(text: "验证器拒绝了过度声明，已修复为部分完成。")),
                decisionSource: .modelStructured,
                providerMetadata: ["verifier": "repairRequired", "terminalState": "partiallySucceeded"],
                modelProvider: "automation-script")
        case .plainChat, .slowChat, .unknown:
            return AgentLoopDecisionResult(
                decision: .finalResponse(AgentFinalResponse(text: "P8 loop automation complete.")),
                decisionSource: .modelStructured,
                modelProvider: "automation-script")
        }
    }

    private static func choiceDocument() -> AgentResultDocument {
        let taskID = UUID()
        let runID = UUID()
        return AgentResultDocument(
            id: "p8-gui-choice-result",
            taskID: taskID,
            runID: runID,
            title: "P8 动态选择",
            summary: "候选已出现",
            status: .partial,
            generatedAt: Date(),
            sections: [
                AgentResultSection(
                    id: "p8-choice",
                    title: "选择候选",
                    state: AgentResultComponentState(kind: .unverified, summary: "等待选择"),
                    component: .choiceList(ChoiceListComponent(choices: [
                        ChoiceItem(id: "alpha", title: "Alpha 候选", subtitle: "P8 fixture"),
                        ChoiceItem(id: "beta", title: "Beta 候选", subtitle: "P8 fixture")
                    ])))
            ])
    }
}

struct AutomationP8ReversibleAgentTool: AgentTool {
    typealias Input = EmptyToolInput

    static let manifest = ToolManifest(
        id: "automation.p8_reversible_write",
        displayName: "P8 可逆写入 fixture",
        shortDescription: "Automation-only reversible fixture tool for GUI permission acceptance.",
        category: .utility,
        riskLevel: .externalSideEffectReversible,
        permissionRequirement: .capability("filesystem.workspace.write"),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "P8 automation permission result"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 1, maxResultBytes: 2_048),
        userVisibleExecutionSummary: "执行 P8 可逆写入 fixture")

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "P8 可逆写入 fixture 已执行",
                            structuredData: .object([
                                "status": .string("success"),
                                "scope": .string("automation-only")
                            ]),
                            modelContent: "P8 可逆写入 fixture 已执行")
    }
}
#endif
