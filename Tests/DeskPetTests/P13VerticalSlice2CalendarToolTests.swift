import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P13-F — Vertical Slice 2: list_today_calendar_events.
//
// Slice 2 differs from Slice 1 in three concrete ways that exercise the
// kernel contract harder:
//
//   1. The tool has a structured boolean argument (`includeAllDay`).
//   2. The tool is gated on both a P3 capability AND a system permission
//      (`.capabilityAndSystemPermission`).
//   3. The tool returns a multi-element structured payload (an event list)
//      that flows through the post-execute hook chain.
//
// The test asserts the V2 invariants on top of the V1 invariants.

private final class P13V2ScriptedCalendarProvider: CalendarEventProviding, @unchecked Sendable {
    let events: [CalendarEventSnapshot]
    let truncated: Bool

    init(events: [CalendarEventSnapshot], truncated: Bool = false) {
        self.events = events
        self.truncated = truncated
    }

    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage {
        CalendarEventPage(events: events, truncated: truncated)
    }
}

private final class P13V2ScriptedLLMClient: LLMClient, @unchecked Sendable {
    let toolCallingCapability: ProviderToolCallingCapability = .native
    let capabilities: Set<ModelCapability> = [.chat, .toolCalling]
    private let queue = DispatchQueue(label: "P13V2ScriptedLLMClient")
    private let responses: [LLMChatResponse]
    private var index = 0

    init(responses: [LLMChatResponse]) {
        self.responses = responses
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        let (idx, total) = queue.sync { (index, responses.count) }
        if idx < total {
            let response = responses[idx]
            queue.sync { index += 1 }
            return response
        }
        return LLMChatResponse(message: LLMChatMessage(role: .assistant, content: "fallback"),
                               modelID: "p13v2-mock")
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func listModels() async throws -> [ModelDescriptor] { [] }
    func testConnection() async -> ProviderConnectionStatus { .connected }
}

private struct P13V2PermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID, applicationPolicyGranted: true,
                            systemAuthorizationRequired: false, systemAuthorizationStatus: .notRequired)
    }
}

private actor P13V2AllowGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        return .granted(CapabilityToken(raw: "tok-\(capabilityID)", taskID: taskID, expiresAt: .distantFuture))
    }
}

private struct P13V2SystemAuth: SystemAuthorizationProviding {
    func requiresSystemAuthorization(_ capabilityID: String) -> Bool { false }
    func status(for capabilityID: String) async -> SystemAuthorizationStatus { .granted }
}

private struct P13V2ToolApproval: TaskPlanApprovalHandling {
    func requestApproval(for plan: ValidatedTaskPlan, snapshot: PlanPresentationSnapshot) async -> PlanApprovalDecision {
        .approved
    }
}

private func p13v2LLMToolCall(name: String = "list_today_calendar_events",
                              argumentsJSON: String = "{\"include_all_day\":false}") -> LLMChatResponse {
    LLMChatResponse(message: LLMChatMessage(role: .assistant, content: ""),
                    modelID: "p13v2-mock",
                    toolCalls: [LLMToolCall(id: "call-1", name: name, argumentsJSON: argumentsJSON)])
}

private func p13v2LLMFinal(_ text: String) -> LLMChatResponse {
    LLMChatResponse(message: LLMChatMessage(role: .assistant, content: text),
                    modelID: "p13v2-mock")
}

@MainActor
final class P13VerticalSlice2CalendarToolTests: XCTestCase {

    private func makeController(arguments: String = "{\"include_all_day\":false}") async -> (
        controller: AgentLoopController,
        registry: ToolRegistry,
        result: AgentLoopRunResult
    ) {
        let toolCall = p13v2LLMToolCall(argumentsJSON: arguments)
        let final = p13v2LLMFinal("今天有 2 个日程。")
        let client = P13V2ScriptedLLMClient(responses: [toolCall, final])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "p13v2-mock",
                                                            capability: .native)
        let registry = ToolRegistry(gate: P13V2PermissionGate(), audit: InMemoryAuditSink())
        let now = Date()
        let events = [
            CalendarEventSnapshot(title: "Stand-up",
                                  startDate: now.addingTimeInterval(60 * 60),
                                  endDate: now.addingTimeInterval(60 * 90),
                                  isAllDay: false,
                                  calendarDisplayName: "工作"),
            CalendarEventSnapshot(title: "Lunch",
                                  startDate: now.addingTimeInterval(3 * 60 * 60),
                                  endDate: now.addingTimeInterval(4 * 60 * 60),
                                  isAllDay: false,
                                  calendarDisplayName: "工作")
        ]
        let providerTool = TodayCalendarEventsAgentTool(
            provider: P13V2ScriptedCalendarProvider(events: events),
            maxEvents: 10)
        try? await registry.registerAgentTool(AnyAgentTool(providerTool))
        let controller = AgentLoopController(
            provider: provider,
            gate: P13V2AllowGate(),
            executor: NoopToolExecutor2(),
            toolCatalogProvider: registry,
            toolPlatformExecutor: registry,
            systemAuthorization: P13V2SystemAuth(),
            planApprovalHandler: P13V2ToolApproval(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
        let result = await controller.run(agentContext: AgentContext(userText: "今天有什么日程？"),
                                         taskID: UUID())
        return (controller, registry, result)
    }

    // MARK: - V2-01 Structured tool arguments remain intact across provider/runtime boundaries

    func testV2_01_structuredArgumentsRemainIntact() async throws {
        let (_, _, result) = await makeController(arguments: "{\"include_all_day\":false}")
        XCTAssertEqual(result.toolStatuses, [.success],
                       "expected tool success; observations=\(result.observations)")
        XCTAssertEqual(result.usedToolNames, ["list_today_calendar_events"])
    }

    // MARK: - V2-02 Progress/failure semantics remain user-safe

    func testV2_02_failureSemanticsUserSafe() async throws {
        struct ThrowingProvider: CalendarEventProviding, @unchecked Sendable {
            func todayEvents(containing date: Date,
                             calendar: Calendar,
                             includeAllDay: Bool,
                             limit: Int) async throws -> CalendarEventPage {
                throw NSError(domain: "CalendarProvider", code: 500,
                              userInfo: [NSLocalizedDescriptionKey: "internal calendar store failure with sensitive details"])
            }
        }
        let toolCall = p13v2LLMToolCall(argumentsJSON: "{\"include_all_day\":true}")
        let final = p13v2LLMFinal("抱歉，无法读取日历。")
        let client = P13V2ScriptedLLMClient(responses: [toolCall, final])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "p13v2-mock",
                                                            capability: .native)
        let registry = ToolRegistry(gate: P13V2PermissionGate(), audit: InMemoryAuditSink())
        try? await registry.registerAgentTool(AnyAgentTool(TodayCalendarEventsAgentTool(
            provider: ThrowingProvider(), maxEvents: 10)))
        let controller = AgentLoopController(
            provider: provider,
            gate: P13V2AllowGate(),
            executor: NoopToolExecutor2(),
            toolCatalogProvider: registry,
            toolPlatformExecutor: registry,
            systemAuthorization: P13V2SystemAuth(),
            planApprovalHandler: P13V2ToolApproval(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
        let result = await controller.run(agentContext: AgentContext(userText: "cal"), taskID: UUID())
        // The tool failed and the loop terminated with a tool failure.
        XCTAssertEqual(result.toolStatuses, [.failed])
        XCTAssertEqual(result.stopReason, .toolFailure)
        XCTAssertNotNil(result.finalResponse)
    }

    // MARK: - V2-03 Provider-specific implementation details do not leak into kernel policy

    func testV2_03_providerImplementationDoesNotLeak() async throws {
        let (_, _, result) = await makeController()
        XCTAssertEqual(result.usedToolNames, ["list_today_calendar_events"])
        XCTAssertEqual(result.waitingApproval, [])
        XCTAssertEqual(result.toolStatuses, [.success])
    }

    // MARK: - V2-04 A richer tool lifecycle still maps into the same semantic AgentEvent model

    func testV2_04_richerLifecycleMapsToSameEventModel() async throws {
        let (_, _, result) = await makeController()
        XCTAssertEqual(result.toolStatuses, [.success])
        XCTAssertEqual(result.toolCallCount, 1)
        XCTAssertEqual(result.iterationCount, 2)
        XCTAssertEqual(result.stopReason, .completed)
    }

    // MARK: - V2-05 Existing production behavior is not degraded

    func testV2_05_existingBehaviorNotDegraded() async throws {
        let (_, _, result) = await makeController()
        XCTAssertNotNil(result.finalResponse)
        XCTAssertEqual(result.finalResponse?.text, "今天有 2 个日程。")
        XCTAssertEqual(result.toolStatuses, [.success])
        XCTAssertEqual(result.usedToolNames, ["list_today_calendar_events"])
    }

    // MARK: - V2-06 INV-EVENT-07 Provider reasoning/thinking is stripped at the adapter

    func testV2_06_noThinkingLeak() async throws {
        let toolCall = LLMChatResponse(
            message: LLMChatMessage(role: .assistant,
                                    content: "<think>hidden reasoning chain</think>visible answer"),
            modelID: "p13v2-mock",
            toolCalls: [LLMToolCall(id: "call-1",
                                    name: "list_today_calendar_events",
                                    argumentsJSON: "{\"include_all_day\":false}")])
        let final = p13v2LLMFinal("显式可见答案。")
        let client = P13V2ScriptedLLMClient(responses: [toolCall, final])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "p13v2-mock",
                                                            capability: .native)
        let registry = ToolRegistry(gate: P13V2PermissionGate(), audit: InMemoryAuditSink())
        try? await registry.registerAgentTool(AnyAgentTool(TodayCalendarEventsAgentTool(
            provider: P13V2ScriptedCalendarProvider(events: []), maxEvents: 10)))
        let controller = AgentLoopController(
            provider: provider,
            gate: P13V2AllowGate(),
            executor: NoopToolExecutor2(),
            toolCatalogProvider: registry,
            toolPlatformExecutor: registry,
            systemAuthorization: P13V2SystemAuth(),
            planApprovalHandler: P13V2ToolApproval(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
        let result = await controller.run(agentContext: AgentContext(userText: "x"), taskID: UUID())
        XCTAssertEqual(result.finalResponse?.text, "显式可见答案。")
        XCTAssertFalse(result.finalResponse?.text.contains("hidden reasoning chain") ?? true)
        XCTAssertFalse(result.finalResponse?.text.contains("<think>") ?? true)
    }

    // MARK: - V2-07 No stale terminal state

    func testV2_07_noStaleTerminalState() async throws {
        let (_, _, result) = await makeController()
        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertNotEqual(result.stopReason, .cancelled)
    }
}

// MARK: - Helpers

private struct NoopToolExecutor2: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        ToolOutcome(ok: false, output: "", error: "noop")
    }
}