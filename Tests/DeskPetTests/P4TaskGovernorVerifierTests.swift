import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore

final class P4TaskGovernorVerifierTests: XCTestCase {
    func testGovernorClassifiesRisk0ThroughRisk3AndRequiresConfirmationForWrites() throws {
        let governor = DefaultTaskGovernor()
        let budget = TaskGovernorBudget(maxAutonomousSteps: 4)
        let risk0 = governor.assess(goal: PlanningGoal(text: "hello"), plan: nil, budget: budget)
        XCTAssertEqual(risk0.riskLevel, .risk0)
        XCTAssertFalse(risk0.requiresVerifier)

        let readPlan = try p4gValidatedPlan(tools: [
            p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData),
            p4gManifest(id: "test.public.rank", risk: .localReadOnlyNoPrivateData),
        ])
        let risk1 = governor.assess(goal: PlanningGoal(text: "查公开信息"), plan: readPlan, budget: budget)
        XCTAssertEqual(risk1.riskLevel, .risk1)
        XCTAssertTrue(risk1.roles.contains(.verifier))

        let privatePlan = try p4gValidatedPlan(tools: [
            p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData),
            p4gManifest(id: "test.private.read", risk: .privateDataReadOnly),
        ])
        let risk2 = governor.assess(goal: PlanningGoal(text: "读我的日历"), plan: privatePlan, budget: budget)
        XCTAssertEqual(risk2.riskLevel, .risk2)
        XCTAssertTrue(risk2.requiresPlanCritic)
        XCTAssertTrue(risk2.requiresUserConfirmation)

        let writeSnapshot = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData), enabled: true),
            ToolCatalogEntry(manifest: p4gManifest(id: "test.calendar.write", risk: .externalSideEffectReversible), enabled: true),
        ])
        XCTAssertThrowsError(try TaskPlanValidator.validate(
            RawTaskPlan(goalSummary: "写日历", steps: [
                p4gRawStep("读", tool: "test.public.read"),
                p4gRawStep("写", tool: "test.calendar.write"),
            ]),
            snapshot: writeSnapshot,
            createdAt: Date(),
            limits: PlannerLimits(),
            id: "p4-risk3")) { error in
            guard case PlanError.unsupportedRisk = error else {
                return XCTFail("expected unsupportedRisk, got \(error)")
            }
        }
        XCTAssertEqual(AgentRuntimeRiskLevel.from(toolRisk: .externalSideEffectReversible), .risk3)
    }

    func testCriticRejectsPlanThatMissesHardRequiredTool() async throws {
        let plan = try p4gValidatedPlan(tools: [
            p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData),
            p4gManifest(id: "test.public.rank", risk: .localReadOnlyNoPrivateData),
        ])
        let goal = PlanningGoal(text: "必须使用 test.public.verify 来核对结果")
        let assessment = DefaultTaskGovernor().assess(goal: goal,
                                                      plan: plan,
                                                      budget: TaskGovernorBudget(maxAutonomousSteps: 4))

        let report = await DeterministicPlanCritic().review(PlanCriticInput(
            goal: goal,
            plan: plan,
            constraints: PlanHardConstraint.infer(from: goal),
            assessment: assessment))

        XCTAssertEqual(report.verdict, .reject)
        XCTAssertTrue(report.findings.contains { $0.id == "missing_required_tool" && $0.severity == .blocking })
    }

    func testVerifierRejectsCompletionClaimWithoutExecutionEvidence() async throws {
        let plan = try p4gValidatedPlan(tools: [
            p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData),
            p4gManifest(id: "test.public.rank", risk: .localReadOnlyNoPrivateData),
        ])
        let assessment = DefaultTaskGovernor().assess(goal: PlanningGoal(text: "公开查询"),
                                                      plan: plan,
                                                      budget: TaskGovernorBudget())
        let report = await DeterministicPlanVerifier().verify(PlanVerificationInput(
            goal: PlanningGoal(text: "公开查询"),
            plan: plan,
            execution: PlanExecutionResult(records: [],
                                           observations: [],
                                           status: .completed,
                                           stopReason: .completed),
            finalResponse: AgentFinalResponse(text: "已完成", finishReason: "stop"),
            evidence: [],
            assessment: assessment))

        XCTAssertEqual(report.verdict, .fail)
        XCTAssertTrue(report.findings.contains { $0.id == "no_execution_evidence" })
    }

    func testVerifierRequestsRepairForOverclaimAndAcceptsRepairedPartialResult() async throws {
        let plan = try p4gValidatedPlan(tools: [
            p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData),
            p4gManifest(id: "test.public.rank", risk: .localReadOnlyNoPrivateData),
        ])
        let taskID = UUID()
        let success = p4gObservation(callID: "call-read", tool: "test.public.read", status: .success)
        let failure = p4gObservation(callID: "call-rank", tool: "test.public.rank", status: .failed)
        let execution = PlanExecutionResult(records: [
            PlanStepExecutionRecord(stepID: "step_1", toolID: "test.public.read", status: .succeeded, observation: success),
            PlanStepExecutionRecord(stepID: "step_2", toolID: "test.public.rank", status: .failed, observation: failure),
        ], observations: [success, failure], status: .partiallyCompleted, stopReason: .completed)
        let evidence = execution.observations.map {
            AgentEvidenceRecord.from(observation: $0, taskID: taskID, capturedAt: Date())
        }
        let assessment = DefaultTaskGovernor().assess(goal: PlanningGoal(text: "公开查询"),
                                                      plan: plan,
                                                      budget: TaskGovernorBudget())
        let verifier = DeterministicPlanVerifier()
        let first = await verifier.verify(PlanVerificationInput(
            goal: PlanningGoal(text: "公开查询"),
            plan: plan,
            execution: execution,
            finalResponse: AgentFinalResponse(text: "已完成，全部成功", finishReason: "stop"),
            evidence: evidence,
            assessment: assessment))
        XCTAssertEqual(first.verdict, .repairRequired)

        let repaired = verifier.repairFinalResponse(for: first, observations: execution.observations)
        let second = await verifier.verify(PlanVerificationInput(
            goal: PlanningGoal(text: "公开查询"),
            plan: plan,
            execution: execution,
            finalResponse: repaired,
            evidence: evidence,
            assessment: assessment,
            repairAttempt: 1))
        XCTAssertEqual(second.verdict, .partialPass)
        XCTAssertEqual(second.terminalState, .partiallySucceeded)
    }

    func testControllerVerifierRepairControlsTerminalStateAndEmitsVerificationActivity() async throws {
        let platform = P4GPlatform(manifests: [
            p4gManifest(id: "test.public.read", risk: .localReadOnlyNoPrivateData),
            p4gManifest(id: "test.public.rank", risk: .localReadOnlyNoPrivateData),
        ], failingTools: ["test.public.rank"])
        let provider = P4GScriptedProvider([
            .finalResponse(AgentFinalResponse(text: "已完成，全部成功", finishReason: "stop"))
        ])
        let events = P4GPlanEvents()
        let controller = AgentLoopController(provider: provider,
                                             gate: P4GAllowGate(),
                                             executor: P5FakeExecutor(),
                                             toolCatalogProvider: platform,
                                             toolPlatformExecutor: platform,
                                             policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                             plannerLimits: PlannerLimits(maxPlanSteps: 4,
                                                                          maxPlanRepairs: 1,
                                                                          maxReplans: 0,
                                                                          finalSynthesisTimeout: 1,
                                                                          plannedTurnDeadline: 5),
                                             clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)),
                                             planEventSink: { event in await events.record(event) })
        let initial = AgentLoopDecisionResult(decision: .proposePlan(RawTaskPlan(goalSummary: "公开查询", steps: [
            p4gRawStep("读取", tool: "test.public.read"),
            p4gRawStep("排序", tool: "test.public.rank"),
        ])), decisionSource: .modelStructured)

        let result = await controller.run(agentContext: AgentContext(userText: "查公开信息"),
                                          taskID: UUID(),
                                          initialDecision: initial)
        let labels = await events.labels()

        XCTAssertEqual(result.terminalState, .partiallySucceeded)
        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertTrue(result.finalResponse?.text.contains("不能标记为已完成") == true)
        XCTAssertTrue(labels.contains("verificationStarted"))
        XCTAssertTrue(labels.contains("verificationCompleted:partialPass"))
    }
}

private func p4gManifest(id: ToolID, risk: ToolRiskLevel) -> ToolManifest {
    ToolManifest(id: id,
                 displayName: id.rawValue,
                 shortDescription: "P4 governor test tool",
                 category: .utility,
                 riskLevel: risk,
                 permissionRequirement: risk == .privateDataReadOnly ? .capability("\(id.rawValue).capability") : .none,
                 inputSchema: .strictEmptyObject,
                 outputContract: ToolOutputContract(description: "test output"),
                 userVisibleExecutionSummary: "执行 \(id.rawValue)")
}

private func p4gRawStep(_ title: String, tool: ToolID) -> RawTaskPlanStep {
    RawTaskPlanStep(title: title, tool: tool, arguments: .object([:]), dependsOn: [], userVisibleSummary: title)
}

private func p4gValidatedPlan(tools: [ToolManifest]) throws -> ValidatedTaskPlan {
    let snapshot = ToolCatalogSnapshot(entries: tools.map { ToolCatalogEntry(manifest: $0, enabled: true) })
    let steps = tools.enumerated().map { index, manifest in
        RawTaskPlanStep(id: "s\(index)",
                        title: "Step \(index)",
                        tool: manifest.id,
                        arguments: .object([:]),
                        dependsOn: index == 0 ? [] : ["step_\(index)"],
                        userVisibleSummary: "Step \(index)")
    }
    return try TaskPlanValidator.validate(RawTaskPlan(goalSummary: "P4 测试", steps: steps),
                                          snapshot: snapshot,
                                          createdAt: Date(),
                                          limits: PlannerLimits(maxPlanSteps: 4),
                                          id: "p4-test-plan")
}

private func p4gObservation(callID: String,
                            tool: String,
                            status: AgentLoopObservationStatus) -> AgentToolObservation {
    AgentToolObservation(callID: callID,
                         toolName: tool,
                         status: status,
                         content: .object(["status": .string(status.rawValue),
                                           "summary": .string("\(tool) \(status.rawValue)")]),
                         userSafeSummary: "\(tool) \(status.rawValue)")
}

private actor P4GPlatform: ToolCatalogProviding, ToolPlatformExecuting {
    private let snapshot: ToolCatalogSnapshot
    private let failingTools: Set<String>

    init(manifests: [ToolManifest], failingTools: Set<String> = []) {
        self.snapshot = ToolCatalogSnapshot(entries: manifests.map { ToolCatalogEntry(manifest: $0, enabled: true) })
        self.failingTools = failingTools
    }

    func toolCatalogSnapshot(for policy: AgentPolicy) async -> ToolCatalogSnapshot {
        snapshot
    }

    func executeTool(request: AgentToolCallRequest,
                     context: ToolExecutionContext) async -> Result<ToolExecutionResult, ToolPlatformError> {
        if failingTools.contains(request.toolName) {
            return .success(ToolExecutionResult(status: .failed,
                                                userSafeSummary: "\(request.toolName) failed",
                                                structuredData: .object(["status": .string("failed")])))
        }
        return .success(ToolExecutionResult(status: .success,
                                            userSafeSummary: "\(request.toolName) ok",
                                            structuredData: .object(["status": .string("success")])))
    }
}

private actor P4GScriptedProvider: AgentLoopDecisionProviding {
    private var decisions: [AgentLoopDecision]

    init(_ decisions: [AgentLoopDecision]) {
        self.decisions = decisions
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        let decision = decisions.isEmpty ? AgentLoopDecision.finalResponse(AgentFinalResponse(text: "done"))
                                         : decisions.removeFirst()
        return AgentLoopDecisionResult(decision: decision, decisionSource: .modelStructured, modelProvider: "p4g")
    }
}

private struct P4GAllowGate: CapabilityGate {
    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        .granted(CapabilityToken(raw: "p4g", taskID: taskID, expiresAt: .distantFuture))
    }
}

private actor P4GPlanEvents {
    private var values: [String] = []

    func record(_ event: PlanExecutionEvent) {
        switch event {
        case .verificationStarted:
            values.append("verificationStarted")
        case .verificationCompleted(let report, _):
            values.append("verificationCompleted:\(report.verdict.rawValue)")
        default:
            break
        }
    }

    func labels() -> [String] { values }
}
