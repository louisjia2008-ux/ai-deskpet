import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// MARK: - Local fakes (mirrors PetAgentRuntimeTests, file-private there)

private struct DyeContextBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event { return AgentContext(userText: message.text) }
        return AgentContext()
    }
}

private struct DyeReasoningModel: StructuredDecisionProviding {
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: "")),
                                 decisionSource: .modelStructured, modelProvider: "fake")
    }
}

private struct DyeConversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.metadata(.nonStreaming))
            continuation.yield(.delta(sequence: 1, text: "ok"))
            continuation.yield(.completed(emotion: .neutral, viaCloud: false))
            continuation.finish()
        }
    }
}

private actor DyeGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .denied(reason: "deny-all")
    }
}

private struct DyeExecutor: ToolExecuting {
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        ToolOutcome(ok: true, output: "unused")
    }
}

private actor DyeLedger: AgentTaskLedgerPersisting {
    private(set) var stored: [AgentTaskLedgerEvent] = []
    func append(_ event: AgentTaskLedgerEvent) async throws { stored.append(event) }
    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] {
        stored.filter { $0.taskID == taskID }
    }
    func activeTasks() async throws -> [AgentTaskSnapshot] { [] }
    func hasOperationID(_ operationID: String) async throws -> Bool {
        stored.contains { $0.operationID == operationID }
    }
}

private struct DyeReflection: ReflectionSink {
    let onReflect: @Sendable () -> Void
    func reflect(_ input: TaskReflectionInput) async { onReflect() }
    func reflectCandidates(_ candidates: [MemoryCandidate]) async { onReflect() }
}

/// Coordinator privacy dye (doc §12.4 全禁): private tasks leave no ledger
/// rows, no durable rows, no inbox/audit traces, and no memory reflection.
/// Live UI envelopes still flow (the activity store gates disk separately).
final class PrivateCoordinatorDyeTests: XCTestCase {

    private func tmpDir(_ name: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dye-\(name)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeCoordinator(ledger: DyeLedger,
                                 durable: DurableTaskStore,
                                 inbox: DurableInboxStore,
                                 audit: DurableAuditLogStore,
                                 reflectCount: ActorCounter) -> PetAgentRuntimeCoordinator {
        PetAgentRuntimeCoordinator(
            context: DyeContextBuilder(),
            model: DyeReasoningModel(),
            conversation: DyeConversation(),
            gate: DyeGate(),
            executor: DyeExecutor(),
            policy: AgentPolicy(allowTools: false, maxSteps: 2, tier: .developerID),
            ledger: ledger,
            reflection: DyeReflection(onReflect: { Task { await reflectCount.increment() } }),
            durableTaskStore: durable,
            durableInboxStore: inbox,
            durableAuditLogStore: audit)
    }

    /// Drives one chat turn to completion, returning its taskID.
    private func drive(_ c: PetAgentRuntimeCoordinator, text: String,
                       conversationClass: ConversationClass) async -> UUID {
        var taskID: UUID?
        for await output in c.handle(.userMessage(text: text, conversationClass: conversationClass)) {
            if case .taskStarted(let id, _, _) = output { taskID = id }
        }
        return taskID!
    }

    func testPrivateLeavesNoLedgerDurableInboxAuditTrace() async throws {
        let ledger = DyeLedger()
        let durable = DurableTaskStore(baseDirectory: tmpDir("durable"))
        let inbox = DurableInboxStore(baseDirectory: tmpDir("inbox"))
        let auditURL = tmpDir("audit").appendingPathComponent("audit.jsonl")
        let audit = DurableAuditLogStore(url: auditURL)
        let counter = ActorCounter()
        let c = makeCoordinator(ledger: ledger, durable: durable, inbox: inbox,
                                audit: audit, reflectCount: counter)

        let priv = await drive(c, text: "私密问题", conversationClass: .privateChat)
        let normal = await drive(c, text: "普通问题", conversationClass: .normal)

        let privIsPrivate = await c.isPrivateTask(priv)
        let normalIsPrivate = await c.isPrivateTask(normal)
        XCTAssertTrue(privIsPrivate)
        XCTAssertFalse(normalIsPrivate)

        // Legacy ledger: rows for normal, none for private.
        let privEvents = try await ledger.events(for: priv)
        let normalEvents = try await ledger.events(for: normal)
        XCTAssertTrue(privEvents.isEmpty, "private must leave no ledger rows")
        XCTAssertFalse(normalEvents.isEmpty, "normal must still record")

        // Durable kernel: row for normal, none for private.
        let privRow = await durable.task(id: priv)
        let normalRow = await durable.task(id: normal)
        XCTAssertNil(privRow)
        XCTAssertNotNil(normalRow)

        // Inbox + audit file: no private taskID anywhere.
        let inboxEvents = await inbox.allEvents()
        XCTAssertFalse(inboxEvents.contains { $0.taskID == priv })
        if let auditText = try? String(contentsOf: auditURL, encoding: .utf8) {
            XCTAssertFalse(auditText.contains(priv.uuidString), "audit must not mention private task")
            XCTAssertTrue(auditText.contains(normal.uuidString), "audit still records normal tasks")
        }
    }

    func testPrivateSkipsMemoryReflection() async {
        let ledger = DyeLedger()
        let durable = DurableTaskStore(baseDirectory: tmpDir("durable2"))
        let inbox = DurableInboxStore(baseDirectory: tmpDir("inbox2"))
        let audit = DurableAuditLogStore(url: tmpDir("audit2").appendingPathComponent("a.jsonl"))
        let counter = ActorCounter()

        // Private explicit-memory cue must not reflect…
        let c1 = makeCoordinator(ledger: ledger, durable: durable, inbox: inbox,
                                 audit: audit, reflectCount: counter)
        _ = await drive(c1, text: "请记住我喜欢喝咖啡", conversationClass: .privateChat)
        let afterPrivate = await counter.value()
        XCTAssertEqual(afterPrivate, 0, "no reflection from private text")

        // …while the same cue in a normal chat does.
        let c2 = makeCoordinator(ledger: ledger, durable: durable, inbox: inbox,
                                 audit: audit, reflectCount: counter)
        _ = await drive(c2, text: "请记住我喜欢喝咖啡", conversationClass: .normal)
        let afterNormal = await counter.value()
        XCTAssertGreaterThan(afterNormal, afterPrivate)
    }
}

private actor ActorCounter {
    private(set) var valueCount = 0
    func increment() { valueCount += 1 }
    func value() -> Int { valueCount }
}
