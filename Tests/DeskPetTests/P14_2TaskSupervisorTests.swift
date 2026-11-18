import XCTest
import Foundation
import AICore
@testable import PetAgentRuntime

/// P14.2 — Task Supervisor Tests.
///
/// Unit tests for the `TaskSupervisor` actor that backs the durable-keyed
/// approval continuation path (R-A-F1). These tests verify the
/// per-taskID atomicity of `awaitApproval` / `resumeApproval` / `drop`
/// and the `recoveryReservations` gate.

final class TaskSupervisorTests: XCTestCase {
    func testAwaitApprovalResumeRoundTrip() async throws {
        let supervisor = TaskSupervisor()
        let taskID = UUID()
        let awaiting = Task<PlanApprovalDecision, Never> {
            await supervisor.awaitApproval(taskID: taskID, timeout: 5.0)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        let resumed = await supervisor.resumeApproval(taskID: taskID, decision: .approved)
        XCTAssertTrue(resumed)
        let decision = await awaiting.value
        XCTAssertEqual(decision, .approved)
    }

    func testResumeApprovalWithoutPendingReturnsFalse() async throws {
        let supervisor = TaskSupervisor()
        let taskID = UUID()
        let resumed = await supervisor.resumeApproval(taskID: taskID, decision: .approved)
        XCTAssertFalse(resumed,
                       "Resuming without a pending continuation must return false (R-A-F4)")
    }

    func testDropConsumesPendingContinuation() async throws {
        let supervisor = TaskSupervisor()
        let taskID = UUID()
        let awaiting = Task<PlanApprovalDecision, Never> {
            await supervisor.awaitApproval(taskID: taskID, timeout: 5.0)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        let dropped = await supervisor.drop(taskID: taskID)
        XCTAssertTrue(dropped)
        let decision = await awaiting.value
        XCTAssertEqual(decision, .cancelled)
    }

    func testReserveRecoveryAtomic() async throws {
        let supervisor = TaskSupervisor()
        let taskID = UUID()
        let first = await supervisor.reserveRecovery(taskID: taskID)
        let second = await supervisor.reserveRecovery(taskID: taskID)
        XCTAssertTrue(first, "First reserve must succeed")
        XCTAssertFalse(second, "Second reserve must fail (INV-CONT-04)")
        let snap = await supervisor.recoveryReservationsSnapshot()
        XCTAssertTrue(snap.contains(taskID))
    }

    func testTimeoutReturnsTimedOut() async throws {
        let supervisor = TaskSupervisor()
        let taskID = UUID()
        let awaiting = Task<PlanApprovalDecision, Never> {
            await supervisor.awaitApproval(taskID: taskID, timeout: 0.1)
        }
        let decision = await awaiting.value
        XCTAssertEqual(decision, .timedOut)
    }

    // FA-04 closure: two concurrent `awaitApproval` calls must NOT orphan
    // the first continuation. The second caller observes `.declined` so
    // neither continuation leaks.
    func testConcurrentAwaitApprovalsDoNotOrphan() async throws {
        let supervisor = TaskSupervisor()
        let taskID = UUID()
        let first = Task<PlanApprovalDecision, Never> {
            await supervisor.awaitApproval(taskID: taskID, timeout: 5.0)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        // Second awaiter arrives while the first is still pending.
        let second = Task<PlanApprovalDecision, Never> {
            await supervisor.awaitApproval(taskID: taskID, timeout: 5.0)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        // The first continuation must still be resumable; the second
        // must NOT have overwritten it.
        let resumed = await supervisor.resumeApproval(taskID: taskID, decision: .approved)
        XCTAssertTrue(resumed, "First continuation must still be reachable")
        let firstDecision = await first.value
        XCTAssertEqual(firstDecision, .approved)
        let secondDecision = await second.value
        XCTAssertEqual(secondDecision, .declined,
                       "Second concurrent awaiter must observe .declined, not orphan")
    }
}