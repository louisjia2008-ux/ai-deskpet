import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// Shared P5.0 in-memory fakes. All side-effect-free; no network, no filesystem outside temp, no
// dependency on real time or real macOS permissions.

struct P5FakeContext: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event {
            return AgentContext(userText: message.text,
                                intentContext: message.metadata.intentContext)
        }
        return AgentContext()
    }
}

struct P5RespondModel: StructuredDecisionProviding {
    var text: String = ""
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: text)),
                                 decisionSource: .modelStructured, modelProvider: "fake")
    }
}

struct P5ObservationEchoModel: StructuredDecisionProviding {
    var fallbackText: String = ""
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        let text = context.observations.last?.summary ?? fallbackText
        return StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: text)),
                                        decisionSource: .modelStructured, modelProvider: "fake-observation-echo")
    }
}

struct P5FakeConversation: ConversationGenerating {
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

struct P5SlowConversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                continuation.yield(.metadata(.trueStreaming))
                continuation.yield(.delta(sequence: 1, text: "first"))
                try? await Task.sleep(nanoseconds: 200_000_000)
                if Task.isCancelled { continuation.finish(); return }
                continuation.yield(.delta(sequence: 2, text: "second"))
                continuation.yield(.completed(emotion: .neutral, viaCloud: false))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

actor P5FakeExecutor: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        if step.capabilityID == "get_current_datetime" {
            let output = #"{"status":"success","timestamp":"2026-07-24T06:30:00Z","iso8601":"2026-07-24T06:30:00Z","timezone":"Asia/Shanghai","local_time":"2026-07-24 14:30:00 GMT+8","local":"2026-07-24 14:30:00 GMT+8"}"#
            return ToolOutcome(ok: true, output: output)
        }
        return ToolOutcome(ok: true, output: "did \(step.capabilityID)")
    }
}

// App-policy CapabilityGate fakes (the layer the new PermissionGate composes over).

struct P5AllowAppGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .granted(CapabilityToken(raw: "tok", taskID: taskID, expiresAt: .distantFuture))
    }
}

struct P5DenyAppGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .denied(reason: "denied")
    }
}

// Runtime PermissionGate fakes (above the app gate).

struct P5AllowPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID, applicationPolicyGranted: true,
                            systemAuthorizationRequired: false, systemAuthorizationStatus: .notRequired)
    }
}

struct P5DenyPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID, applicationPolicyGranted: false,
                            systemAuthorizationRequired: false, systemAuthorizationStatus: .notRequired,
                            denialReason: "denied")
    }
}

// Action executor that records what it performed.
actor P5RecordingActionExecutor: ActionExecuting {
    private(set) var performed: [String] = []
    func perform(_ action: DeskPetAction, correlationID: UUID?) async -> ActionResult {
        performed.append(Self.label(action))
        return ActionResult(ok: true, detail: "ok")
    }
    func count() -> Int { performed.count }
    func labels() -> [String] { performed }
    static func label(_ action: DeskPetAction) -> String {
        switch action {
        case .speak: return "speak"
        case .setExpression: return "expression"
        case .playMotion: return "motion"
        case .showNotification: return "notification"
        case .requestPermission: return "requestPermission"
        case .invokeTool: return "invokeTool"
        case .wait: return "wait"
        case .updatePresence: return "presence"
        }
    }
}

struct P5SlowActionExecutor: ActionExecuting {
    func perform(_ action: DeskPetAction, correlationID: UUID?) async -> ActionResult {
        try? await Task.sleep(nanoseconds: 300_000_000)
        return ActionResult(ok: true)
    }
}

// A tool that sleeps so timeout / cancellation can be exercised.
struct P5SlowTool: RuntimeTool {
    let identifier = "slow"
    let displayName = "Slow"
    let toolDescription = "Sleeps, for timeout/cancellation tests."
    let requiredCapabilities: [String] = []
    let riskLevel: ToolRiskLevel = .localReadOnlyNoPrivateData
    var timeout: TimeInterval = 0.05
    func execute(arguments: [String: String], context: ToolContext) async throws -> ToolInvocationResult {
        try await Task.sleep(nanoseconds: 300_000_000)
        return ToolInvocationResult(ok: true, output: "slow")
    }
}

func p5ToolContext() -> ToolContext { ToolContext(correlationID: nil, clock: WallClock()) }

func p5Coordinator(model: StructuredDecisionProviding = P5RespondModel(),
                   conversation: ConversationGenerating = P5FakeConversation(),
                   gate: CapabilityGate = P5AllowAppGate()) -> PetAgentRuntimeCoordinator {
    PetAgentRuntimeCoordinator(context: P5FakeContext(), model: model, conversation: conversation,
                               gate: gate, executor: P5FakeExecutor(),
                               policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
}

func p5ActionEnvelope(_ action: DeskPetAction, _ priority: ActionPriority,
                      id: UUID = UUID(), createdAt: Date = Date(), timeout: TimeInterval? = nil) -> ActionEnvelope {
    ActionEnvelope(id: id, action: action, priority: priority, source: .assistant,
                   createdAt: createdAt, timeout: timeout)
}
