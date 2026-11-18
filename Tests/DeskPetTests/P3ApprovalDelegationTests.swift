import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P3 — approval gate (per-action prompt + session trust) and bounded subagent delegation.

// MARK: - Approval gate

private actor ApproverBox {
    private let decision: ApprovalDecision
    private(set) var calls = 0
    init(_ d: ApprovalDecision) { decision = d }
    func decide() -> ApprovalDecision { calls += 1; return decision }
    func count() -> Int { calls }
}

private func outcomeKind(_ o: GateOutcome) -> String {
    switch o {
    case .granted: return "granted"
    case .denied: return "denied"
    case .askUser: return "askUser"
    }
}

final class ApprovalGateTests: XCTestCase {
    private let p0 = "timer.local"
    private let p1 = "filesystem.workspace.read"
    private let p2 = "reminder.local.create"
    private let p3 = "network.fetch"

    func testNoApproverFailsClosedForP1PlusButGrantsP0() async {
        let gate = BrokerCapabilityGate(tier: .developerID)   // no approver
        let p0Out = await gate.evaluate(capabilityID: p0, reason: "r", taskID: UUID())
        let p2Out = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        XCTAssertEqual(outcomeKind(p0Out), "granted")
        XCTAssertEqual(outcomeKind(p2Out), "askUser")          // fail-closed (P1 behavior preserved)
    }

    func testAllowOnceGrantsButReprompts() async {
        let box = ApproverBox(.allowOnce)
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in await box.decide() })
        let first = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        let second = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        let calls = await box.count()
        XCTAssertEqual(outcomeKind(first), "granted")
        XCTAssertEqual(outcomeKind(second), "granted")
        XCTAssertEqual(calls, 2)                                // asked both times
    }

    func testAllowSessionTrustsForRestOfSession() async {
        let box = ApproverBox(.allowSession)
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in await box.decide() })
        _ = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        let second = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        let calls = await box.count()
        XCTAssertEqual(outcomeKind(second), "granted")
        XCTAssertEqual(calls, 1)                                // only asked once, then trusted
    }

    func testDenyBlocks() async {
        let box = ApproverBox(.deny)
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in await box.decide() })
        let out = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        XCTAssertEqual(outcomeKind(out), "denied")
    }

    func testTrustReversibleAutoApprovesP1P2ButNotP3() async {
        let box = ApproverBox(.deny)   // would deny if asked
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in await box.decide() })
        await gate.setTrustReversible(true)
        let p1Out = await gate.evaluate(capabilityID: p1, reason: "r", taskID: UUID())
        let p2Out = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        let p3Out = await gate.evaluate(capabilityID: p3, reason: "r", taskID: UUID())
        let calls = await box.count()
        XCTAssertEqual(outcomeKind(p1Out), "granted")
        XCTAssertEqual(outcomeKind(p2Out), "granted")
        XCTAssertEqual(outcomeKind(p3Out), "denied")           // P3 still went to approver (which denies)
        XCTAssertEqual(calls, 1)                                // only P3 asked
    }

    func testPermanentlyDeniedTierBeatsApprover() async {
        let box = ApproverBox(.allowSession)
        // App Store tier hard-caps at P2 → P3 is permanently denied regardless of approval.
        let gate = BrokerCapabilityGate(tier: .appStore, approver: { _, _, _ in await box.decide() })
        let out = await gate.evaluate(capabilityID: p3, reason: "r", taskID: UUID())
        let calls = await box.count()
        XCTAssertEqual(outcomeKind(out), "denied")
        XCTAssertEqual(calls, 0)                                // never even asked
    }
}

// MARK: - Delegation fakes

private struct DelegCtxBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let m) = event { return AgentContext(userText: m.text) }
        return AgentContext()
    }
}

private actor GrantAllGate: CapabilityGate {
    private(set) var seen: [String] = []
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen.append(capabilityID)
        return .granted(CapabilityToken(raw: "t", taskID: taskID, expiresAt: .distantFuture))
    }
    func capabilities() -> [String] { seen }
}

private actor CountingExec: ToolExecuting {
    private(set) var executed: [String] = []
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        executed.append(step.capabilityID)
        return ToolOutcome(ok: true, output: "did \(step.capabilityID)")
    }
    func count() -> Int { executed.count }
}

private struct StubConv: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { c in c.yield(.completed(emotion: .neutral, viaCloud: false)); c.finish() }
    }
}

private actor DelegLedger: AgentTaskLedgerPersisting {
    private(set) var stored: [AgentTaskLedgerEvent] = []
    func append(_ event: AgentTaskLedgerEvent) async throws { stored.append(event) }
    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] { stored.filter { $0.taskID == taskID } }
    func activeTasks() async throws -> [AgentTaskSnapshot] { [] }
    func hasOperationID(_ operationID: String) async throws -> Bool { stored.contains { $0.operationID == operationID } }
    func all() -> [AgentTaskLedgerEvent] { stored }
}

/// Parent (full catalog) delegates; child (narrowed snapshot) does the configured behavior.
private struct DelegatingModel: StructuredDecisionProviding {
    enum ChildBehavior { case workTimer, overreach, redelegate }
    let child: ChildBehavior
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        let decision: AgentDecision
        if !context.observations.isEmpty {
            decision = .respond(ConversationResponseDecision(text: "完成"))
        } else if availableCapabilities.contains("filesystem.workspace.write") {
            // Parent: still has the full catalog → delegate a sub-goal with a narrow subset.
            decision = .delegate(DelegationDecision(goal: "子目标", allowedCapabilities: ["timer.local"]))
        } else {
            // Child: narrowed snapshot.
            switch child {
            case .workTimer:
                decision = .proposePlan(AgentPlanProposal(goal: "子目标", steps: [
                    AgentPlanProposalStep(id: "c1", description: "计时", capabilityID: "timer.local")]))
            case .overreach:
                decision = .proposePlan(AgentPlanProposal(goal: "子目标", steps: [
                    AgentPlanProposalStep(id: "c1", description: "越权", capabilityID: "network.fetch")]))
            case .redelegate:
                decision = .delegate(DelegationDecision(goal: "孙目标", allowedCapabilities: ["timer.local"]))
            }
        }
        return StructuredDecisionResult(decision: decision, decisionSource: .modelStructured, modelProvider: "deleg")
    }
}

private func delegPolicy() -> AgentPolicy {
    AgentPolicy(allowTools: true, maxSteps: 4, maxIterations: 5, maxToolCalls: 8, maxWallClock: 60,
                maxDelegationDepth: 1, tier: .developerID)
}

final class P3DelegationValidatorTests: XCTestCase {
    private let caps = CapabilityCatalogSnapshot(capabilities: CapabilityCatalog.all)
    private func accepts(_ json: String) -> Bool {
        (try? StructuredDecisionValidator.validate(raw: json, availableCapabilities: caps)) != nil
    }

    func testAcceptsValidDelegation() {
        XCTAssertTrue(accepts(#"{"schemaVersion":1,"kind":"delegate","delegation":{"goal":"查资料并总结","allowedCapabilities":["network.search","filesystem.workspace.write"]}}"#))
    }
    func testRejectsInvalidDelegation() {
        XCTAssertFalse(accepts(#"{"schemaVersion":1,"kind":"delegate","delegation":{"goal":"","allowedCapabilities":["network.search"]}}"#))      // empty goal
        XCTAssertFalse(accepts(#"{"schemaVersion":1,"kind":"delegate","delegation":{"goal":"g","allowedCapabilities":[]}}"#))                    // empty caps
        XCTAssertFalse(accepts(#"{"schemaVersion":1,"kind":"delegate","delegation":{"goal":"g","allowedCapabilities":["bogus.capability"]}}"#))  // unknown cap
    }
}

final class DelegationTests: XCTestCase {
    func testChildExecutesNarrowedCapabilityAndSummaryFeedsParent() async {
        let exec = CountingExec()
        let ledger = DelegLedger()
        let c = PetAgentRuntimeCoordinator(context: DelegCtxBuilder(), model: DelegatingModel(child: .workTimer),
                                           conversation: StubConv(), gate: GrantAllGate(), executor: exec,
                                           policy: delegPolicy(), ledger: ledger)
        let r = await c.run(.userMessage(text: "帮我做个子任务", conversationClass: .normal))

        let execCount = await exec.count()
        let events = await ledger.all()
        XCTAssertEqual(execCount, 1)                                  // the child ran timer.local
        XCTAssertTrue(events.contains { $0.parentTaskID != nil })     // parent/child chain recorded
        XCTAssertTrue(events.contains { $0.kind == .delegated })      // parent recorded a delegation
        XCTAssertNotNil(r.presentation)
    }

    func testChildCannotExceedItsAllowlist() async {
        let exec = CountingExec()
        let c = PetAgentRuntimeCoordinator(context: DelegCtxBuilder(), model: DelegatingModel(child: .overreach),
                                           conversation: StubConv(), gate: GrantAllGate(), executor: exec,
                                           policy: delegPolicy(), ledger: DelegLedger())
        _ = await c.run(.userMessage(text: "帮我做个子任务", conversationClass: .normal))
        let execCount = await exec.count()
        XCTAssertEqual(execCount, 0)   // out-of-subset capability filtered before execution
    }

    func testDepthGuardStopsNestedDelegation() async {
        let exec = CountingExec()
        let ledger = DelegLedger()
        let c = PetAgentRuntimeCoordinator(context: DelegCtxBuilder(), model: DelegatingModel(child: .redelegate),
                                           conversation: StubConv(), gate: GrantAllGate(), executor: exec,
                                           policy: delegPolicy(), ledger: ledger)
        _ = await c.run(.userMessage(text: "帮我做个子任务", conversationClass: .normal))
        let execCount = await exec.count()
        let delegations = await ledger.all().filter { $0.kind == .delegated }.count
        XCTAssertEqual(execCount, 0)        // no work; child's re-delegation declined by depth guard
        XCTAssertEqual(delegations, 1)      // exactly one delegation (parent's); no infinite recursion
    }
}
