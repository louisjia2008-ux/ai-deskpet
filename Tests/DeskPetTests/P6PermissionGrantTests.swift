import XCTest
import Foundation
@testable import PetAgentRuntime

final class P6PermissionGrantTests: XCTestCase {
    func testRiskClassMapping() {
        XCTAssertEqual(ToolRiskLevel.localReadOnlyNoPrivateData.p6RiskClass, .readOnly)
        XCTAssertEqual(ToolRiskLevel.privateDataReadOnly.p6RiskClass, .readOnly)
        XCTAssertEqual(ToolRiskLevel.externalSideEffectReversible.p6RiskClass, .externalWrite)
        XCTAssertEqual(ToolRiskLevel.destructiveOrSensitiveWrite.p6RiskClass, .highRisk)
    }

    func testApprovalTokenIsBoundToExactArgumentsAndSingleUse() async {
        let clock = TestClock(start: Date(timeIntervalSince1970: 1_800_000_000))
        let store = ToolInvocationApprovalStore(clock: clock)
        let taskID = UUID()
        let runID = UUID()
        let arguments: AgentJSONValue = .object(["path": .string("notes.md")])
        let grant = await store.grant(taskID: taskID,
                                      runID: runID,
                                      toolCallID: "call-1",
                                      toolID: "filesystem.workspace.write",
                                      arguments: arguments)
        let changedArguments: AgentJSONValue = .object(["path": .string("other.md")])
        let mismatch = await store.consume(grantID: grant.id,
                                           taskID: taskID,
                                           runID: runID,
                                           toolCallID: "call-1",
                                           toolID: "filesystem.workspace.write",
                                           arguments: changedArguments)
        guard case .denied(let mismatchReason) = mismatch else { return XCTFail("expected argument mismatch") }
        XCTAssertEqual(mismatchReason, "argument hash mismatch")

        let granted = await store.consume(grantID: grant.id,
                                          taskID: taskID,
                                          runID: runID,
                                          toolCallID: "call-1",
                                          toolID: "filesystem.workspace.write",
                                          arguments: arguments)
        guard case .granted = granted else { return XCTFail("expected grant") }

        let replay = await store.consume(grantID: grant.id,
                                         taskID: taskID,
                                         runID: runID,
                                         toolCallID: "call-1",
                                         toolID: "filesystem.workspace.write",
                                         arguments: arguments)
        guard case .denied(let replayReason) = replay else { return XCTFail("expected replay denial") }
        XCTAssertEqual(replayReason, "approval already consumed")
    }

    func testExpiredTaskRunToolAndCallMismatchReject() async {
        let clock = TestClock(start: Date(timeIntervalSince1970: 1_800_000_000))
        let store = ToolInvocationApprovalStore(clock: clock)
        let taskID = UUID()
        let runID = UUID()
        let arguments: AgentJSONValue = .object([:])
        let grant = await store.grant(taskID: taskID,
                                      runID: runID,
                                      toolCallID: "call-1",
                                      toolID: "get_current_datetime",
                                      arguments: arguments,
                                      ttl: 1)
        let wrongTask = await store.consume(grantID: grant.id,
                                            taskID: UUID(),
                                            runID: runID,
                                            toolCallID: "call-1",
                                            toolID: "get_current_datetime",
                                            arguments: arguments)
        guard case .denied(let taskReason) = wrongTask else { return XCTFail("expected task mismatch") }
        XCTAssertEqual(taskReason, "taskID mismatch")

        let wrongRun = await store.consume(grantID: grant.id,
                                           taskID: taskID,
                                           runID: UUID(),
                                           toolCallID: "call-1",
                                           toolID: "get_current_datetime",
                                           arguments: arguments)
        guard case .denied(let runReason) = wrongRun else { return XCTFail("expected run mismatch") }
        XCTAssertEqual(runReason, "runID mismatch")

        let wrongTool = await store.consume(grantID: grant.id,
                                            taskID: taskID,
                                            runID: runID,
                                            toolCallID: "call-1",
                                            toolID: "get_system_profile",
                                            arguments: arguments)
        guard case .denied(let toolReason) = wrongTool else { return XCTFail("expected tool mismatch") }
        XCTAssertEqual(toolReason, "toolID mismatch")

        let wrongCall = await store.consume(grantID: grant.id,
                                            taskID: taskID,
                                            runID: runID,
                                            toolCallID: "call-2",
                                            toolID: "get_current_datetime",
                                            arguments: arguments)
        guard case .denied(let callReason) = wrongCall else { return XCTFail("expected call mismatch") }
        XCTAssertEqual(callReason, "toolCallID mismatch")

        clock.advance(by: 2)
        let expired = await store.consume(grantID: grant.id,
                                          taskID: taskID,
                                          runID: runID,
                                          toolCallID: "call-1",
                                          toolID: "get_current_datetime",
                                          arguments: arguments)
        guard case .denied(let expiredReason) = expired else { return XCTFail("expected expired denial") }
        XCTAssertEqual(expiredReason, "approval expired")
    }
}
