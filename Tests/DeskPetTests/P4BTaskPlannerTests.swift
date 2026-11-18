import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

final class P4BTaskPlannerTests: XCTestCase {
    func testParserAcceptsStrictTwoStepPlanAndRejectsMixedProse() throws {
        let raw = try TaskPlanParser.parse(raw: """
        {"goal_summary":"检查当前状态","steps":[
          {"title":"获取时间","tool":"test.tool.a","arguments":{},"depends_on":[]},
          {"title":"读取系统","tool":"test.tool.b","arguments":{},"depends_on":["step_1"]}
        ]}
        """)
        XCTAssertEqual(raw.goalSummary, "检查当前状态")
        XCTAssertEqual(raw.steps.map(\.tool.rawValue), ["test.tool.a", "test.tool.b"])

        XCTAssertThrowsError(try TaskPlanParser.parse(raw: #"sure {"goal_summary":"x","steps":[]}"#)) {
            XCTAssertEqual($0 as? TaskPlanParseError, .malformedJSON)
        }
    }

    func testDecisionParserParsesPlanAndNormalizesSingleStepPlanToToolCall() throws {
        let plan = try AgentLoopDecisionParser.parse(raw: """
        {"type":"propose_plan","goal_summary":"多步","steps":[
          {"title":"A","tool":"test.tool.a","arguments":{},"depends_on":[]},
          {"title":"B","tool":"test.tool.b","arguments":{},"depends_on":[]}
        ]}
        """)
        guard case .proposePlan(let raw) = plan.decision else { return XCTFail("expected plan") }
        XCTAssertEqual(raw.steps.count, 2)

        let single = try AgentLoopDecisionParser.parse(raw: """
        {"type":"propose_plan","goal_summary":"单步","steps":[
          {"id":"one","title":"A","tool":"test.tool.a","arguments":{},"depends_on":[]}
        ]}
        """)
        guard case .toolCall(let request) = single.decision else { return XCTFail("expected tool fallback") }
        XCTAssertEqual(request.toolName, "test.tool.a")
    }

    func testValidatorRejectsUnsafeMalformedAndDuplicatePlans() throws {
        let snapshot = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: P4BToolA.manifest, enabled: true),
            ToolCatalogEntry(manifest: P4BBooleanTool.manifest, enabled: true),
            ToolCatalogEntry(manifest: P4BP2Tool.manifest, enabled: true),
        ])

        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", tool: "missing.tool"),
            rawStep("B", tool: "test.tool.a"),
        ]), snapshot: snapshot)) { XCTAssertPlanError($0, .unknownTool) }

        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", tool: "test.tool.bool", arguments: .object(["include_all_day": .string("yes")])),
            rawStep("B", tool: "test.tool.a"),
        ]), snapshot: snapshot)) { XCTAssertPlanError($0, .invalidArguments) }

        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", id: "dup", tool: "test.tool.a"),
            rawStep("B", id: "dup", tool: "test.tool.bool", arguments: .object(["include_all_day": .bool(true)])),
        ]), snapshot: snapshot)) { XCTAssertPlanError($0, .duplicateStep) }

        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("A again", tool: "test.tool.a"),
        ]), snapshot: snapshot)) { XCTAssertPlanError($0, .duplicateFingerprint) }

        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", tool: "test.tool.a", dependsOn: ["step_2"]),
            rawStep("B", tool: "test.tool.bool", arguments: .object(["include_all_day": .bool(true)])),
        ]), snapshot: snapshot)) { XCTAssertPlanError($0, .invalidDependency) }

        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", tool: "test.tool.p2"),
            rawStep("B", tool: "test.tool.a"),
        ]), snapshot: snapshot)) { XCTAssertPlanError($0, .unsupportedRisk) }

        XCTAssertThrowsError(try TaskPlanParser.parse(raw: """
        {"goal_summary":"x","steps":[{"title":"A","tool":"test.tool.a","arguments":{},"risk":"P0"}]}
        """)) { XCTAssertEqual($0 as? TaskPlanParseError, .forbiddenField("risk")) }
    }

    func testDisabledAndTooManyStepsAreRejectedBeforeExecution() throws {
        let disabledSnapshot = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: P4BToolA.manifest, enabled: false),
            ToolCatalogEntry(manifest: P4BToolB.manifest, enabled: true),
        ])
        XCTAssertThrowsError(try validate(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("B", tool: "test.tool.b"),
        ]), snapshot: disabledSnapshot)) { XCTAssertPlanError($0, .toolDisabled) }

        let many = plan(steps: (0..<7).map { index in
            RawTaskPlanStep(id: "s\(index)",
                            title: "Step \(index)",
                            tool: index % 2 == 0 ? "test.tool.a" : "test.tool.b",
                            arguments: .object(["value": .number(Double(index))]))
        })
        XCTAssertThrowsError(try validate(many, snapshot: p4bSnapshot())) {
            XCTAssertPlanError($0, .tooManySteps)
        }
    }

    func testDirectFinalAndSingleToolDoNotCreatePlanEvents() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let events = P4BPlanEventRecorder()
        let finalProvider = P4BScriptedProvider([.finalResponse(AgentFinalResponse(text: "ok"))])
        let final = await p4bController(provider: finalProvider, registry: registry, events: events)
            .run(agentContext: AgentContext(userText: "hello"), taskID: UUID())
        XCTAssertEqual(final.finalResponse?.text, "ok")
        let initialSnapshots = await events.snapshots()
        XCTAssertEqual(initialSnapshots.count, 0)

        let single = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
        ])), decisionSource: .modelStructured)
        let toolResult = await p4bController(provider: P4BScriptedProvider([.finalResponse(AgentFinalResponse(text: "done"))]),
                                             registry: registry,
                                             events: events)
            .run(agentContext: AgentContext(userText: "one tool"), taskID: UUID(), initialDecision: single)
        XCTAssertEqual(toolResult.usedToolNames, ["test.tool.a"])
        let singleCalls = await recorder.calls()
        XCTAssertEqual(singleCalls, ["test.tool.a"])
    }

    func testP0PlanAutoExecutesSeriallyAndSynthesizesOnce() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let events = P4BPlanEventRecorder()
        let initial = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("B", tool: "test.tool.b", dependsOn: ["step_1"]),
        ])), decisionSource: .modelStructured)
        let provider = P4BScriptedProvider([.finalResponse(AgentFinalResponse(text: "综合完成"))])

        let result = await p4bController(provider: provider, registry: registry, events: events)
            .run(agentContext: AgentContext(userText: "multi"), taskID: UUID(), initialDecision: initial)

        let calls = await recorder.calls()
        let providerCalls = await provider.callCount()
        let snapshots = await events.snapshots()
        XCTAssertEqual(calls, ["test.tool.a", "test.tool.b"])
        XCTAssertEqual(result.finalResponse?.text, "综合完成")
        XCTAssertEqual(result.planStepCount, 2)
        XCTAssertEqual(result.planApprovalRequired, false)
        XCTAssertEqual(providerCalls, 1)
        XCTAssertTrue(snapshots.contains { $0.status == .synthesizing })
    }

    func testP1PlanWaitsForApprovalAndDeclineExecutesNothing() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let events = P4BPlanEventRecorder()
        let approval = P4BApprovalHandler(decision: .declined)
        let initial = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("Calendar", tool: "test.tool.calendar"),
        ])), decisionSource: .modelStructured)

        let result = await p4bController(provider: P4BScriptedProvider([.finalResponse(AgentFinalResponse(text: "never"))]),
                                         registry: registry,
                                         events: events,
                                         approval: approval)
            .run(agentContext: AgentContext(userText: "calendar"), taskID: UUID(), initialDecision: initial)

        XCTAssertTrue(result.usedToolNames.isEmpty)
        let calls = await recorder.calls()
        let snapshots = await events.snapshots()
        XCTAssertEqual(calls, [])
        XCTAssertEqual(result.finalResponse?.text, "计划已取消。")
        XCTAssertTrue(snapshots.contains { $0.status == .awaitingApproval && $0.canApprove })
    }

    func testP1PlanApprovedExecutesAndPrivateObservationIsMinimized() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let initial = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("Calendar", tool: "test.tool.calendar"),
        ])), decisionSource: .modelStructured)

        let result = await p4bController(provider: P4BScriptedProvider([.finalResponse(AgentFinalResponse(text: "部分综合"))]),
                                         registry: registry,
                                         approval: P4BApprovalHandler(decision: .approved))
            .run(agentContext: AgentContext(userText: "calendar"), taskID: UUID(), initialDecision: initial)

        let calls = await recorder.calls()
        XCTAssertEqual(calls, ["test.tool.a", "test.tool.calendar"])
        XCTAssertEqual(result.toolStatuses, [.success, .success])
        let calendar = try XCTUnwrap(result.observations.last { $0.toolName == "test.tool.calendar" })
        XCTAssertTrue(calendar.content.jsonString.contains("privateDataRead"))
        XCTAssertFalse(calendar.content.jsonString.contains("Secret Calendar Title"))
        XCTAssertEqual(result.planApprovalRequired, true)
        XCTAssertEqual(result.planApprovalGranted, true)
    }

    func testDependencyFailureSkipsDependentStepButContinuesIndependentStep() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let events = P4BPlanEventRecorder()
        let initial = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("Fail", tool: "test.tool.fail"),
            rawStep("Depends", tool: "test.tool.b", dependsOn: ["step_1"]),
            rawStep("Independent", tool: "test.tool.a", arguments: .object(["value": .number(3)])),
        ])), decisionSource: .modelStructured)

        let result = await p4bController(provider: P4BScriptedProvider([
                                            .finalResponse(AgentFinalResponse(text: "partial")),
                                            .finalResponse(AgentFinalResponse(text: "partial")),
                                         ]),
                                         registry: registry,
                                         events: events)
            .run(agentContext: AgentContext(userText: "partial"), taskID: UUID(), initialDecision: initial)

        let calls = await recorder.calls()
        let snapshots = await events.snapshots()
        XCTAssertEqual(calls, ["test.tool.fail", "test.tool.a"])
        XCTAssertEqual(result.finalResponse?.text, "partial")
        XCTAssertTrue(snapshots.contains { snapshot in
            snapshot.steps.contains { $0.title == "Depends" && $0.status == .skippedDependency }
        })
    }

    func testReplanRunsOnceWithoutReexecutingCompletedFingerprint() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let initial = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("Fail", tool: "test.tool.fail"),
        ])), decisionSource: .modelStructured)
        let replan = AgentLoopDecision.proposePlan(plan(steps: [
            rawStep("A again", tool: "test.tool.a"),
            rawStep("B", tool: "test.tool.b"),
        ]))
        let provider = P4BScriptedProvider([replan, .finalResponse(AgentFinalResponse(text: "replanned"))])

        let result = await p4bController(provider: provider, registry: registry)
            .run(agentContext: AgentContext(userText: "replan"), taskID: UUID(), initialDecision: initial)

        let calls = await recorder.calls()
        XCTAssertEqual(calls, ["test.tool.a", "test.tool.fail", "test.tool.b"])
        XCTAssertEqual(result.planReplanCount, 1)
        XCTAssertEqual(result.finalResponse?.text, "replanned")
    }

    func testFinalSynthesisCannotCallAnotherTool() async throws {
        let recorder = P4BExecutionRecorder()
        let registry = try await p4bRegistry(recorder: recorder)
        let initial = AgentLoopDecisionResult(decision: .proposePlan(plan(steps: [
            rawStep("A", tool: "test.tool.a"),
            rawStep("B", tool: "test.tool.b"),
        ])), decisionSource: .modelStructured)
        let provider = P4BScriptedProvider([
            .toolCall(AgentToolCallRequest(callID: "bad-final",
                                           toolName: "test.tool.a",
                                           arguments: .object([:]),
                                           userVisibleSummary: "bad")),
        ])

        let result = await p4bController(provider: provider, registry: registry)
            .run(agentContext: AgentContext(userText: "synthesis"), taskID: UUID(), initialDecision: initial)

        let calls = await recorder.calls()
        XCTAssertEqual(calls, ["test.tool.a", "test.tool.b"])
        XCTAssertFalse(result.finalResponse?.text.contains("bad-final") == true)
        XCTAssertTrue(result.finalResponse?.text.contains("test.tool.a") == true)
    }

    func testPlanLedgerMetadataAndUnknownFutureStatusDecodeSafely() throws {
        let event = AgentTaskLedgerEvent(taskID: UUID(),
                                         attemptID: UUID(),
                                         conversationID: UUID(),
                                         userMessageID: UUID(),
                                         state: .succeeded,
                                         kind: .completed,
                                         sequence: 1,
                                         usedToolNames: ["test.tool.calendar"],
                                         toolStatuses: ["success"],
                                         planID: "plan-safe",
                                         planVersion: 1,
                                         planStepCount: 2,
                                         planRiskLevel: "P1 私人数据只读",
                                         planApprovalRequired: true,
                                         planApprovalGranted: true,
                                         planReplanCount: 0,
                                         planResultItemCount: 2,
                                         planResultTruncated: false)
        let encoded = try String(data: JSONEncoder().encode(event), encoding: .utf8) ?? ""
        XCTAssertFalse(encoded.contains("include_all_day"))
        XCTAssertFalse(encoded.contains("Secret Calendar Title"))

        let statusData = #""futureStatus""#.data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode(PlanStatus.self, from: statusData), .unknown)
        XCTAssertEqual(try JSONDecoder().decode(PlanStepStatus.self, from: statusData), .unknown)
    }
}

private func plan(steps: [RawTaskPlanStep]) -> RawTaskPlan {
    RawTaskPlan(goalSummary: "测试计划", steps: steps)
}

private func rawStep(_ title: String,
                     id: String? = nil,
                     tool: ToolID,
                     arguments: AgentJSONValue = .object([:]),
                     dependsOn: [String] = []) -> RawTaskPlanStep {
    RawTaskPlanStep(id: id,
                    title: title,
                    tool: tool,
                    arguments: arguments,
                    dependsOn: dependsOn,
                    userVisibleSummary: title)
}

private func validate(_ raw: RawTaskPlan,
                      snapshot: ToolCatalogSnapshot) throws -> ValidatedTaskPlan {
    try TaskPlanValidator.validate(raw,
                                   snapshot: snapshot,
                                   createdAt: Date(timeIntervalSince1970: 1_700_000_000),
                                   limits: PlannerLimits(),
                                   id: "plan-test")
}

private func p4bSnapshot() -> ToolCatalogSnapshot {
    ToolCatalogSnapshot(entries: [
        ToolCatalogEntry(manifest: P4BToolA.manifest, enabled: true),
        ToolCatalogEntry(manifest: P4BToolB.manifest, enabled: true),
        ToolCatalogEntry(manifest: P4BBooleanTool.manifest, enabled: true),
        ToolCatalogEntry(manifest: P4BCalendarTool.manifest, enabled: true),
        ToolCatalogEntry(manifest: P4BFailingTool.manifest, enabled: true),
    ])
}

private func XCTAssertPlanError(_ error: Error,
                                _ expected: TaskPlanValidationError,
                                file: StaticString = #filePath,
                                line: UInt = #line) {
    switch (error, expected) {
    case (PlanError.planValidationFailed(let actual), _):
        XCTAssertEqual(actual, expected, file: file, line: line)
    case (PlanError.unknownTool(_), .unknownTool),
         (PlanError.toolDisabled(_), .toolDisabled),
         (PlanError.invalidArguments(_), .invalidArguments),
         (PlanError.invalidDependency(_), .invalidDependency),
         (PlanError.unsupportedRisk(_), .unsupportedRisk):
        break
    default:
        XCTFail("Unexpected error \(error)", file: file, line: line)
    }
}

private func p4bRegistry(recorder: P4BExecutionRecorder) async throws -> ToolRegistry {
    let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink(),
                                clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))
    try await registry.registerAgentTool(AnyAgentTool(P4BToolA(recorder: recorder)))
    try await registry.registerAgentTool(AnyAgentTool(P4BToolB(recorder: recorder)))
    try await registry.registerAgentTool(AnyAgentTool(P4BBooleanTool(recorder: recorder)))
    try await registry.registerAgentTool(AnyAgentTool(P4BCalendarTool(recorder: recorder)))
    try await registry.registerAgentTool(AnyAgentTool(P4BFailingTool(recorder: recorder)))
    return registry
}

private func p4bController(provider: any AgentLoopDecisionProviding,
                           registry: ToolRegistry,
                           events: P4BPlanEventRecorder = P4BPlanEventRecorder(),
                           approval: any TaskPlanApprovalHandling = AutoTaskPlanApprovalHandler()) -> AgentLoopController {
    AgentLoopController(provider: provider,
                        gate: P5AllowAppGate(),
                        executor: P5FakeExecutor(),
                        toolCatalogProvider: registry,
                        toolPlatformExecutor: registry,
                        systemAuthorization: P4BSystemAuthorization(),
                        planApprovalHandler: approval,
                        policy: AgentPolicy(allowTools: true, maxSteps: 6, maxIterations: 4,
                                            maxToolCalls: 6, maxWallClock: 90, tier: .developerID),
                        limits: AgentLoopLimits(maxIterations: 4, maxToolCalls: 6),
                        plannerLimits: PlannerLimits(planApprovalTimeout: 0.2,
                                                     finalSynthesisTimeout: 1,
                                                     plannedTurnDeadline: 5),
                        clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)),
                        planEventSink: { event in await events.record(event) })
}

private actor P4BExecutionRecorder {
    private var values: [String] = []
    func record(_ value: String) { values.append(value) }
    func calls() -> [String] { values }
}

private actor P4BPlanEventRecorder {
    private var values: [PlanPresentationSnapshot] = []

    func record(_ event: PlanExecutionEvent) {
        switch event {
        case .planCreated(let snapshot),
             .approvalRequired(let snapshot),
             .planApproved(let snapshot),
             .planCancelled(let snapshot),
             .stepStarted(_, let snapshot),
             .stepFinished(_, _, let snapshot),
             .stepSkipped(_, _, let snapshot),
             .replanning(let snapshot),
             .verificationStarted(let snapshot),
             .verificationCompleted(_, let snapshot),
             .synthesisStarted(let snapshot),
             .completed(let snapshot):
            values.append(snapshot)
        case .failed(_, let snapshot):
            if let snapshot { values.append(snapshot) }
        }
    }

    func snapshots() -> [PlanPresentationSnapshot] { values }
}

private actor P4BScriptedProvider: AgentLoopDecisionProviding {
    private var decisions: [AgentLoopDecision]
    private var count = 0

    init(_ decisions: [AgentLoopDecision]) {
        self.decisions = decisions
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        count += 1
        let decision = decisions.isEmpty ? AgentLoopDecision.finalResponse(AgentFinalResponse(text: "done"))
                                         : decisions.removeFirst()
        return AgentLoopDecisionResult(decision: decision,
                                       decisionSource: .modelStructured,
                                       modelProvider: "p4b")
    }

    func callCount() -> Int { count }
}

private struct P4BApprovalHandler: TaskPlanApprovalHandling {
    var decision: PlanApprovalDecision

    func requestApproval(for plan: ValidatedTaskPlan,
                         snapshot: PlanPresentationSnapshot) async -> PlanApprovalDecision {
        decision
    }
}

private struct P4BSystemAuthorization: SystemAuthorizationProviding {
    func requiresSystemAuthorization(_ capabilityID: String) -> Bool {
        capabilityID == "calendar.events.read"
    }

    func status(for capabilityID: String) async -> SystemAuthorizationStatus {
        .granted
    }
}

private struct P4BToolA: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = p4bManifest(id: "test.tool.a", displayName: "工具 A")
    let recorder: P4BExecutionRecorder?
    init(recorder: P4BExecutionRecorder? = nil) { self.recorder = recorder }
    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        await recorder?.record(Self.manifest.id.rawValue)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "A 完成",
                                   structuredData: .object(["status": .string("success")]),
                                   modelContent: "A 完成")
    }
}

private struct P4BToolB: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = p4bManifest(id: "test.tool.b", displayName: "工具 B")
    let recorder: P4BExecutionRecorder?
    init(recorder: P4BExecutionRecorder? = nil) { self.recorder = recorder }
    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        await recorder?.record(Self.manifest.id.rawValue)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "B 完成",
                                   structuredData: .object(["status": .string("success")]),
                                   modelContent: "B 完成")
    }
}

private struct P4BBooleanTool: AgentTool {
    struct Input: Decodable, Sendable { var includeAllDay: Bool? }
    static let manifest = ToolManifest(
        id: "test.tool.bool",
        displayName: "布尔工具",
        shortDescription: "Boolean schema test tool.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .none,
        inputSchema: ToolJSONSchema(type: .object,
                                    properties: ["include_all_day": ToolJSONSchema(type: .boolean)],
                                    required: [],
                                    additionalProperties: false),
        outputContract: ToolOutputContract(description: "ok"),
        userVisibleExecutionSummary: "执行布尔工具")
    let recorder: P4BExecutionRecorder?
    init(recorder: P4BExecutionRecorder? = nil) { self.recorder = recorder }
    func execute(input: Input, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        await recorder?.record(Self.manifest.id.rawValue)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "布尔完成",
                                   structuredData: .object(["status": .string("success")]),
                                   modelContent: "布尔完成")
    }
}

private struct P4BCalendarTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = ToolManifest(
        id: "test.tool.calendar",
        displayName: "日历测试",
        shortDescription: "Private read-only test calendar.",
        category: .calendar,
        riskLevel: .privateDataReadOnly,
        permissionRequirement: .capabilityAndSystemPermission(capabilityID: "calendar.events.read",
                                                              systemPermission: .calendarEvents),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "calendar", maxItems: 1),
        userVisibleExecutionSummary: "读取日历测试")
    let recorder: P4BExecutionRecorder?
    init(recorder: P4BExecutionRecorder? = nil) { self.recorder = recorder }
    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        await recorder?.record(Self.manifest.id.rawValue)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "已查询 1 个日历事件",
                                   structuredData: .object([
                                    "status": .string("success"),
                                    "title": .string("Secret Calendar Title"),
                                   ]),
                                   modelContent: "已查询 1 个日历事件",
                                   metadata: ToolExecutionMetadata(itemCount: 1))
    }
}

private struct P4BFailingTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = p4bManifest(id: "test.tool.fail", displayName: "失败工具")
    let recorder: P4BExecutionRecorder?
    init(recorder: P4BExecutionRecorder? = nil) { self.recorder = recorder }
    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        await recorder?.record(Self.manifest.id.rawValue)
        return ToolExecutionResult(status: .failed,
                                   userSafeSummary: "失败",
                                   structuredData: .object(["status": .string("failed")]),
                                   modelContent: "失败")
    }
}

private struct P4BP2Tool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = p4bManifest(id: "test.tool.p2",
                                      displayName: "P2 工具",
                                      risk: .externalSideEffectReversible)
    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "should not run",
                            structuredData: .object([:]))
    }
}

private func p4bManifest(id: ToolID,
                         displayName: String,
                         risk: ToolRiskLevel = .localReadOnlyNoPrivateData) -> ToolManifest {
    ToolManifest(id: id,
                 displayName: displayName,
                 shortDescription: "P4-B test tool.",
                 category: .utility,
                 riskLevel: risk,
                 permissionRequirement: .none,
                 inputSchema: ToolJSONSchema(type: .object,
                                             properties: ["value": ToolJSONSchema(type: .number)],
                                             required: [],
                                             additionalProperties: false),
                 outputContract: ToolOutputContract(description: "ok"),
                 userVisibleExecutionSummary: "执行\(displayName)")
}
