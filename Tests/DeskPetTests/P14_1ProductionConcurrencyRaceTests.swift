import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14.1 — Concurrency / Race tests for production integration.
//
// These tests exercise the production durable kernel under concurrent
// cancellation / approval / retry / restart conditions.

@MainActor
final class P14_1ProductionConcurrencyRaceTests: XCTestCase {

    /// CR-01: cancel vs acceptance completion. The durable task must be
    /// exactly once in `.cancelled` after a cancel race.
    func testCR01_cancelVsAcceptanceCompletion() async throws {
        let root = p14_makeTempDir("cr01")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals"))
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        await store.load(); await goalStore.load(); await inbox.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store, goalStore: goalStore, durableInboxStore: inbox)

        let taskID = UUID()
        let conversationID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: conversationID,
                                             title: "cr01",
                                             status: .running))
        await store.recordNewAttempt(taskID: taskID, attemptID: UUID(), runID: UUID())

        // Cancel the task and concurrently try to mark it complete via
        // applyTransition. Only one transition can win; the durable store
        // enforces INV-DUR-03 (terminal exactly-once).
        async let cancel = coordinator.cancel(conversationID: conversationID)
        async let complete = store.applyTransition(taskID: taskID, to: .completed)
        _ = await (cancel, complete)

        let after = await store.task(id: taskID)
        XCTAssertNotNil(after)
        // Whichever transition wins, the durable task must be terminal.
        XCTAssertTrue(after?.status.isTerminal == true,
                      "CR-01: task must reach a terminal state once and only once")
    }

    /// CR-02: approval arrives vs cancellation. Whichever sequence happens,
    /// the task must end in a terminal state.
    ///
    /// R5-2 (evidence-stability maintenance, outside P16 feature scope):
    /// Swift concurrency does NOT guarantee `async let` start-order under
    /// actor scheduling contention. `DurableTaskState.canTransition` grants
    /// BOTH (`.waitingForApproval → .running`) and
    /// (`.waitingForApproval → .cancelled`) — see `DurableTaskState.swift:103-106`.
    /// So BOTH orderings are legal:
    ///   - approval-first: approval returns non-nil
    ///     (`.waitingForApproval → .running`), then cancel returns non-nil
    ///     (`.running → .cancelled`).
    ///   - cancel-first: cancel returns non-nil
    ///     (`.waitingForApproval → .cancelled` — direct transition legal in
    ///     the FSM), then approval returns nil (terminal sealed,
    ///     `.cancelled → .running` rejected).
    /// In BOTH orderings the final task status is `.cancelled` (the
    /// production invariant of INV-DUR-03 — terminal exactly-once). The
    /// pre-R5-2 assertions hard-coded one ordering and flaked at ~18%
    /// observed scheduling inversions (13 personal full-suite runs: 11
    /// passed, 2 failed with the exact "approvalResult is nil" error).
    /// Assert on the final state AND at-least-one-wins ordering-
    /// independent invariant instead, documenting both legal
    /// interleavings — mirrors the R3-6 fix applied to CR-03 two tests
    /// below.
    func testCR02_approvalVsCancellation() async throws {
        let root = p14_makeTempDir("cr02")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "cr02",
                                             status: .waitingForApproval))

        async let approval = store.applyTransition(taskID: taskID, to: .running)
        async let cancel = store.applyTransition(taskID: taskID, to: .cancelled)
        let approvalResult = await approval
        let cancelResult = await cancel

        let after = await store.task(id: taskID)
        XCTAssertNotNil(after)
        // Both orderings converge to .cancelled (INV-DUR-03).
        XCTAssertEqual(after?.status, .cancelled,
                       "CR-02: final state must be .cancelled regardless of arrival order")
        // At least one of the two transitions must succeed — the other
        // may return nil (cancel-first seals the task terminal before
        // approval lands, or approval-first lands then cancel transitions
        // .running → .cancelled).
        XCTAssertTrue(approvalResult != nil || cancelResult != nil,
                      "CR-02: at least one of approval/cancel must succeed (.waitingForApproval → .running or .cancelled is legal)")
    }

    /// CR-03: retry wakeup vs cancellation. A cancellation transition
    /// from `.running` MUST succeed; a wakeup to `.running` after
    /// cancellation must be rejected (terminal sealed).
    ///
    /// R3-6 (evidence-stability maintenance, outside P16 feature scope):
    /// Swift concurrency does NOT guarantee `async let` start-order under
    /// actor scheduling contention. `DurableTaskState.canTransition` grants
    /// `.running → .running` (idempotent re-entry, see
    /// `DurableTaskState.swift:82`), so BOTH orderings are legal:
    ///   - cancel-first:   cancel returns non-nil (.running → .cancelled),
    ///                     then wakeup returns nil (.cancelled → .running
    ///                     rejected because terminal sealed).
    ///   - wakeup-first:   wakeup returns non-nil (.running → .running
    ///                     idempotent re-entry), then cancel returns
    ///                     non-nil (.running → .cancelled).
    /// In BOTH orderings the final task status is `.cancelled` (the
    /// production invariant of INV-DUR-03 — terminal exactly-once). The
    /// pre-R3-6 assertions hard-coded one ordering and flaked at ~1-in-4-6
    /// observed scheduling inversions. Assert on the final state instead,
    /// documenting the legal interleavings.
    func testCR03_retryWakeupVsCancellation() async throws {
        let root = p14_makeTempDir("cr03")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "cr03",
                                             status: .running))

        async let cancel = store.applyTransition(taskID: taskID, to: .cancelled)
        async let wakeup = store.applyTransition(taskID: taskID, to: .running)
        let cancelResult = await cancel
        _ = await wakeup   // result may be nil (cancel-first) OR non-nil (wakeup-first idempotent re-entry)

        XCTAssertNotNil(cancelResult,
                        "CR-03: cancellation must always succeed (.running → .cancelled is legal)")
        let after = await store.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled,
                       "CR-03: final task status must be .cancelled in both legal orderings")
    }

    /// CR-05: two approval events. The inbox is idempotent; both events
    /// for the same taskID must coexist (different eventIDs), and only
    /// one can be `consume`d as "the" approval.
    func testCR05_twoApprovalEvents() async throws {
        let root = p14_makeTempDir("cr05")
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        await inbox.load()
        let taskID = UUID()
        let event1 = InboxEvent(taskID: taskID,
                                kind: .approvalDecision,
                                payload: .object(["decision": .string("approved")]))
        let event2 = InboxEvent(taskID: taskID,
                                kind: .approvalDecision,
                                payload: .object(["decision": .string("declined")]))
        _ = await inbox.appendIfNew(event1)
        _ = await inbox.appendIfNew(event2)
        let all = await inbox.allEvents().filter { $0.taskID == taskID }
        XCTAssertEqual(all.count, 2,
                       "CR-05: both events are accepted (distinct eventIDs)")
        // Consume both — neither can be consumed twice.
        await inbox.consume(eventID: event1.eventID, attemptID: UUID())
        await inbox.consume(eventID: event2.eventID, attemptID: UUID())
        let unconsumed = await inbox.unconsumedEvents(forTask: taskID)
        XCTAssertEqual(unconsumed.count, 0)
    }

    /// CR-06: task terminalization vs stale model stream completion. A
    /// late model stream completion arriving AFTER `.cancelled` must NOT
    /// re-open the task. INV-DUR-03.
    func testCR06_terminalizationVsStaleCompletion() async throws {
        let root = p14_makeTempDir("cr06")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "cr06",
                                             status: .running))
        // Cancel first.
        let cancelResult = await store.applyTransition(taskID: taskID, to: .cancelled)
        XCTAssertNotNil(cancelResult)
        // Stale model completion arrives after — must be rejected.
        let staleResult = await store.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(staleResult,
                     "CR-06: stale .completed after .cancelled must be rejected (INV-DUR-03)")
        let afterCR06 = await store.task(id: taskID)
        XCTAssertEqual(afterCR06?.status, .cancelled)
    }
}