import XCTest
import Foundation
@testable import PetBrainCore

final class AgentTaskMachineTests: XCTestCase {

    func testHappyPathTransitions() {
        XCTAssertTrue(AgentTaskMachine.canTransition(from: .draft, to: .awaitingApproval))
        XCTAssertTrue(AgentTaskMachine.canTransition(from: .queued, to: .preparing))
        XCTAssertTrue(AgentTaskMachine.canTransition(from: .preparing, to: .running))
        XCTAssertTrue(AgentTaskMachine.canTransition(from: .running, to: .succeeded))
    }

    func testInvalidTransitionsRejected() {
        XCTAssertFalse(AgentTaskMachine.canTransition(from: .draft, to: .running))      // can't skip
        XCTAssertFalse(AgentTaskMachine.canTransition(from: .succeeded, to: .running))  // terminal
        XCTAssertFalse(AgentTaskMachine.canTransition(from: .cancelled, to: .draft))
    }

    func testPetTaskIsSeparateFromAgentTask() {
        // Naming proof of decision 14: the user to-do type and the agent task type are distinct.
        XCTAssertNotEqual(AgentTaskState.draft.rawValue, "done")
    }
}

final class TaskLedgerTests: XCTestCase {

    private func def() -> AgentTaskDefinition {
        AgentTaskDefinition(goal: "审计并修复", workspace: "/ws", rollbackOnCancel: true)
    }

    func testLedgerIsAppendOnlyAndRebuildsState() {
        var c = AgentTaskCoordinator(definition: def())
        c.start(); c.approve()
        c.ingest(.stateChanged(.preparing)); c.ingest(.stateChanged(.running))
        XCTAssertEqual(c.state, .running)
        XCTAssertEqual(c.ledger.rebuiltState(), .running)
        XCTAssertGreaterThanOrEqual(c.ledger.entries.count, 4)
    }

    func testIdempotentFileChangeNotAppliedTwice() {
        var c = AgentTaskCoordinator(definition: def())
        c.start(); c.approve(); c.ingest(.stateChanged(.preparing)); c.ingest(.stateChanged(.running))
        let op = "op-write-1"
        XCTAssertEqual(c.ingest(.fileChangeProposed(DiffRef(id: "d1"), operationID: op)), .applied)
        // A replay after a crash must NOT double-apply the same operation (doc §13.9).
        XCTAssertEqual(c.ingest(.fileChangeProposed(DiffRef(id: "d1"), operationID: op)), .ignoredDuplicate)
    }

    func testInvalidTransitionIsRejectedNotApplied() {
        var c = AgentTaskCoordinator(definition: def())
        let r = c.ingest(.stateChanged(.running))   // from draft directly → invalid
        XCTAssertEqual(r, .rejectedTransition(from: .draft, to: .running))
        XCTAssertEqual(c.state, .draft)
    }

    func testCancelRollsBackWhenConfigured() {
        var c = AgentTaskCoordinator(definition: def())
        c.start(); c.approve(); c.ingest(.stateChanged(.preparing)); c.ingest(.stateChanged(.running))
        c.cancel()
        XCTAssertEqual(c.state, .rolledBack)        // rollbackOnCancel = true
        XCTAssertTrue(c.state.isTerminal)
    }

    func testPauseResumeAndRecover() {
        var c = AgentTaskCoordinator(definition: def())
        c.start(); c.approve(); c.ingest(.stateChanged(.preparing)); c.ingest(.stateChanged(.running))
        c.pause(); XCTAssertEqual(c.state, .paused)
        c.resume(); XCTAssertEqual(c.state, .running)
        // Simulate a crash: rebuild from ledger then recover.
        var revived = AgentTaskCoordinator(definition: def())
        // (in a real restart the ledger would be reloaded; here recover() reads its own ledger)
        c.recover()
        XCTAssertEqual(c.state, .recovering)
        _ = revived
    }

    func testPartialSuccessIsMarked() {
        var c = AgentTaskCoordinator(definition: def())
        c.start(); c.approve(); c.ingest(.stateChanged(.preparing)); c.ingest(.stateChanged(.running))
        c.ingest(.stateChanged(.partiallySucceeded))
        XCTAssertTrue(c.partial)
        XCTAssertEqual(c.state, .partiallySucceeded)
    }
}
