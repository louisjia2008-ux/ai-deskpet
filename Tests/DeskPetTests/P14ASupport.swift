import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14 shared test helpers.

@MainActor
func p14A_waitUntil(_ predicate: @MainActor @escaping () -> Bool,
                    timeout: TimeInterval = 2.0) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if predicate() { return }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

func p14_makeTempDir(_ tag: String) -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("p14-\(tag)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@MainActor
func p14A_readAppShellViewBody() -> String {
    let url = URL(fileURLWithPath: #filePath)
    // P14ASupport.swift lives at <workspace>/Tests/DeskPetTests/P14ASupport.swift
    // Walk up three levels to reach the workspace root.
    let projectRoot = url.deletingLastPathComponent()  // Tests/DeskPetTests
        .deletingLastPathComponent()                    // Tests
        .deletingLastPathComponent()                    // workspace root
    let appShell = projectRoot.appendingPathComponent("Sources/DeskPet/UI/AppShellView.swift")
    return (try? String(contentsOf: appShell, encoding: .utf8)) ?? ""
}

// MARK: - P14A fakes

struct P14AFakeContext: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event {
            return AgentContext(userText: message.text,
                                intentContext: message.metadata.intentContext)
        }
        return AgentContext()
    }
}

struct P14ARespondModel: StructuredDecisionProviding {
    var text: String = ""
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: text)),
                                 decisionSource: .modelStructured, modelProvider: "p14a-fake")
    }
}

struct P14AFakeConversation: ConversationGenerating {
    var reply: String = "hi"
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        let reply = self.reply
        return AsyncThrowingStream { continuation in
            continuation.yield(.metadata(.nonStreaming))
            continuation.yield(.delta(sequence: 1, text: reply))
            continuation.yield(.completed(emotion: .neutral, viaCloud: false))
            continuation.finish()
        }
    }
}

struct P14ASlowConversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                continuation.yield(.metadata(.trueStreaming))
                try? await Task.sleep(nanoseconds: 250_000_000)
                if Task.isCancelled { continuation.finish(); return }
                continuation.yield(.delta(sequence: 1, text: "partial"))
                try? await Task.sleep(nanoseconds: 250_000_000)
                if Task.isCancelled { continuation.finish(); return }
                continuation.yield(.delta(sequence: 2, text: " more"))
                continuation.yield(.completed(emotion: .neutral, viaCloud: false))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

actor P14AFakeExecutor: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        if step.capabilityID == "get_current_datetime" {
            let output = #"{"status":"success","timestamp":"2026-07-24T06:30:00Z","iso8601":"2026-07-24T06:30:00Z","timezone":"Asia/Shanghai","local_time":"2026-07-24 14:30:00 GMT+8","local":"2026-07-24 14:30:00 GMT+8"}"#
            return ToolOutcome(ok: true, output: output)
        }
        return ToolOutcome(ok: true, output: "did \(step.capabilityID)")
    }
}

struct P14AAllowAppGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .granted(CapabilityToken(raw: "tok", taskID: taskID, expiresAt: .distantFuture))
    }
}

struct P14AAllowPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID, applicationPolicyGranted: true,
                            systemAuthorizationRequired: false, systemAuthorizationStatus: .notRequired)
    }
}

struct P14ACalendarFakeProvider: CalendarEventProviding, @unchecked Sendable {
    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage {
        CalendarEventPage(events: [], truncated: false)
    }
}

// MARK: - Coordinator factory

@MainActor
func p14A_singleCoordinator(model: StructuredDecisionProviding = P14ARespondModel(),
                            conversation: ConversationGenerating = P14AFakeConversation(),
                            gate: CapabilityGate = P14AAllowAppGate(),
                            executor: ToolExecuting = P14AFakeExecutor()) -> PetAgentRuntimeCoordinator {
    PetAgentRuntimeCoordinator(context: P14AFakeContext(),
                               model: model,
                               conversation: conversation,
                               gate: gate,
                               executor: executor,
                               policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
}

// P14.2 — variant that threads the durable stores through the
// production coordinator. Used by the vertical slice tests.
@MainActor
func p14A_singleCoordinator(model: StructuredDecisionProviding,
                            conversation: ConversationGenerating,
                            gate: CapabilityGate,
                            executor: ToolExecuting,
                            taskStore: DurableTaskStore,
                            goalStore: GoalStore,
                            inbox: DurableInboxStore,
                            audit: DurableAuditLogStore) -> PetAgentRuntimeCoordinator {
    PetAgentRuntimeCoordinator(context: P14AFakeContext(),
                               model: model,
                               conversation: conversation,
                               gate: gate,
                               executor: executor,
                               policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                               durableTaskStore: taskStore,
                               goalStore: goalStore,
                               durableInboxStore: inbox,
                               durableAuditLogStore: audit)
}

@MainActor
func p14A_chatModel(coordinator: PetAgentRuntimeCoordinator,
                    activityStore: AgentTaskActivityStore,
                    scheduler: AgentTaskScheduler) -> ChatModel {
    let memory = MemoryModel(store: MemoryStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("p14a-mem-\(UUID().uuidString).json")))
    let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                              repository: JSONMemoryRepository(memory))
    let chatStore = ChatStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("p14a-chat-\(UUID().uuidString).json"))
    return ChatModel(runtime: coordinator,
                     services: services,
                     store: chatStore,
                     activityStore: activityStore,
                     scheduler: scheduler)
}

// MARK: - Routing chat (uses the production tool path)

@MainActor
func p14A_routingChat(model: StructuredDecisionProviding,
                      platform: P14ARecordingToolPlatform) -> (ChatModel, AgentTaskScheduler, AgentTaskActivityStore) {
    let activityStore = AgentTaskActivityStore(persistence: nil, runEventStore: nil)
    let scheduler = AgentTaskScheduler(maxConcurrent: 1, eventHub: activityStore.eventHub)
    let memory = MemoryModel(store: MemoryStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("p14a-rt-mem-\(UUID().uuidString).json")))
    let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/tmp/missing-deskpet-llm")),
                              repository: JSONMemoryRepository(memory))
    let chatStore = ChatStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("p14a-rt-chat-\(UUID().uuidString).json"))
    let runtime = PetAgentRuntimeCoordinator(
        context: P14AFakeContext(),
        model: model,
        conversation: P14AFakeConversation(reply: "unused"),
        gate: P14AAllowAppGate(),
        executor: P14AFakeExecutor(),
        policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
        toolCatalogProvider: platform,
        toolPlatformExecutor: platform,
        systemAuthorization: DefaultSystemAuthorizationPolicy(),
        clock: WallClock())
    let chat = ChatModel(runtime: runtime,
                         services: services,
                         store: chatStore,
                         activityStore: activityStore,
                         scheduler: scheduler)
    return (chat, scheduler, activityStore)
}

// MARK: - Recording tool platform

actor P14ARecordingToolPlatform: ToolCatalogProviding, ToolPlatformExecuting {
    private let registry = ToolRegistry(gate: P14AAllowPermissionGate(), audit: InMemoryAuditSink())
    private var executions: [AgentToolCallRequest] = []
    private var results: [(String, ToolExecutionResult)] = []

    init() {}

    func registerCurrentDateTimeTool() async throws {
        try await registry.registerAgentTool(AnyAgentTool(CurrentDateTimeAgentTool()))
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

    func snapshot() async -> ToolCatalogSnapshot {
        await registry.toolCatalogSnapshot(for: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
    }
}
