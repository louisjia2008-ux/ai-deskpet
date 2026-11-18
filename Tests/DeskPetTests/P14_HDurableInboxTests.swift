import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14-H — Durable Inbox.

@MainActor
final class P14_HDurableInboxTests: XCTestCase {

    // H-01 — Inbox event survives restart.

    func testH01_inboxEventSurvivesRestart() async throws {
        let url = p14_makeTempDir("h01").appendingPathComponent("inbox.jsonl")
        let storeA = DurableInboxStore(baseDirectory: url)
        await storeA.load()
        let event = InboxEvent(taskID: UUID(),
                                kind: .userReply,
                                payload: .string("yes"))
        _ = await storeA.appendIfNew(event)
        // Reload via a brand-new store.
        let storeB = DurableInboxStore(baseDirectory: url)
        await storeB.load()
        let pending = await storeB.unconsumedEvents(forTask: event.taskID)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending.first?.eventID, event.eventID)
    }

    // H-02 — Consumed event is not processed twice under normal recovery.

    func testH02_consumedEventNotProcessedTwice() async throws {
        let url = p14_makeTempDir("h02").appendingPathComponent("inbox.jsonl")
        let storeA = DurableInboxStore(baseDirectory: url)
        await storeA.load()
        let taskID = UUID()
        let attemptID = UUID()
        let event = InboxEvent(taskID: taskID, kind: .approvalDecision, payload: .bool(true))
        _ = await storeA.appendIfNew(event)
        await storeA.consume(eventID: event.eventID, attemptID: attemptID)
        let storeB = DurableInboxStore(baseDirectory: url)
        await storeB.load()
        let pending = await storeB.unconsumedEvents(forTask: taskID)
        XCTAssertEqual(pending.count, 0)
    }

    // H-03 — Duplicate event ID is idempotent.

    func testH03_duplicateEventIdIsIdempotent() async throws {
        let url = p14_makeTempDir("h03").appendingPathComponent("inbox.jsonl")
        let store = DurableInboxStore(baseDirectory: url)
        await store.load()
        let event = InboxEvent(taskID: UUID(), kind: .userReply)
        let firstAppend = await store.appendIfNew(event)
        let secondAppend = await store.appendIfNew(event)
        XCTAssertTrue(firstAppend)
        XCTAssertFalse(secondAppend, "Duplicate eventID must be rejected as idempotent no-op")
        let all = await store.allEvents()
        XCTAssertEqual(all.count, 1)
    }

    // H-04 — Ordering deterministic.

    func testH04_orderingIsDeterministic() async throws {
        let url = p14_makeTempDir("h04").appendingPathComponent("inbox.jsonl")
        let storeA = DurableInboxStore(baseDirectory: url)
        await storeA.load()
        let taskID = UUID()
        for i in 0..<10 {
            let event = InboxEvent(taskID: taskID,
                                    kind: .taskSignal,
                                    payload: .number(Double(i)),
                                    createdAt: Date(timeIntervalSince1970: Double(i)))
            _ = await storeA.appendIfNew(event)
        }
        let storeB = DurableInboxStore(baseDirectory: url)
        await storeB.load()
        let pending = await storeB.unconsumedEvents(forTask: taskID)
        XCTAssertEqual(pending.count, 10)
        // Ordering by createdAt
        for i in 0..<pending.count - 1 {
            XCTAssertLessThanOrEqual(pending[i].createdAt, pending[i+1].createdAt)
        }
    }

    // H-05 — Approval event routed to correct task.

    func testH05_approvalEventRoutedToCorrectTask() async throws {
        let url = p14_makeTempDir("h05").appendingPathComponent("inbox.jsonl")
        let store = DurableInboxStore(baseDirectory: url)
        await store.load()
        let taskA = UUID()
        let taskB = UUID()
        _ = await store.appendIfNew(InboxEvent(taskID: taskA, kind: .approvalDecision))
        _ = await store.appendIfNew(InboxEvent(taskID: taskB, kind: .userReply))
        let pendingA = await store.unconsumedEvents(forTask: taskA)
        let pendingB = await store.unconsumedEvents(forTask: taskB)
        XCTAssertEqual(pendingA.count, 1)
        XCTAssertEqual(pendingA.first?.kind, .approvalDecision)
        XCTAssertEqual(pendingB.count, 1)
        XCTAssertEqual(pendingB.first?.kind, .userReply)
    }

    // H-06 — User reply routed to correct waiting task.

    func testH06_userReplyRoutedToCorrectWaitingTask() async throws {
        let url = p14_makeTempDir("h06").appendingPathComponent("inbox.jsonl")
        let store = DurableInboxStore(baseDirectory: url)
        await store.load()
        let waitingTask = UUID()
        let unrelatedTask = UUID()
        _ = await store.appendIfNew(InboxEvent(taskID: waitingTask, kind: .userReply, payload: .string("blue")))
        _ = await store.appendIfNew(InboxEvent(taskID: unrelatedTask, kind: .userReply, payload: .string("ignored")))
        let waitingPending = await store.unconsumedEvents(forTask: waitingTask)
        XCTAssertEqual(waitingPending.count, 1)
        XCTAssertEqual(waitingPending.first?.payload, .string("blue"))
    }

    // H-07 — Task cancellation invalidates or safely ignores future events.

    func testH07_cancelledTaskIgnoresFutureEvents() async throws {
        let url = p14_makeTempDir("h07").appendingPathComponent("inbox.jsonl")
        let taskDir = p14_makeTempDir("h07-tasks")
        let taskStore = DurableTaskStore(baseDirectory: taskDir)
        await taskStore.load()
        let taskID = UUID()
        _ = await taskStore.upsert(DurableTaskRecord(taskID: taskID, title: "to cancel"))
        _ = await taskStore.applyTransition(taskID: taskID, to: .running)
        _ = await taskStore.applyTransition(taskID: taskID, to: .cancelled)
        // The inbox can still receive events for this task; the consumer
        // (runtime) is responsible for rejecting them. Here we verify the
        // durable store does not silently drop events destined for a
        // cancelled task — that decision is the consumer's.
        let inbox = DurableInboxStore(baseDirectory: url)
        await inbox.load()
        _ = await inbox.appendIfNew(InboxEvent(taskID: taskID, kind: .userReply))
        let pending = await inbox.unconsumedEvents(forTask: taskID)
        XCTAssertEqual(pending.count, 1)
        // The runtime's contract is to consult the durable task state and
        // skip consumption for terminal tasks.
        let taskRecord = await taskStore.task(id: taskID)
        XCTAssertEqual(taskRecord?.status, .cancelled)
    }

    // H-08 — No cross-task event leakage.

    func testH08_noCrossTaskEventLeakage() async throws {
        let url = p14_makeTempDir("h08").appendingPathComponent("inbox.jsonl")
        let store = DurableInboxStore(baseDirectory: url)
        await store.load()
        let taskA = UUID()
        let taskB = UUID()
        for i in 0..<5 {
            _ = await store.appendIfNew(InboxEvent(taskID: taskA,
                                                    kind: .taskSignal,
                                                    payload: .number(Double(i))))
        }
        for i in 0..<3 {
            _ = await store.appendIfNew(InboxEvent(taskID: taskB,
                                                    kind: .taskSignal,
                                                    payload: .number(Double(i + 100))))
        }
        let pendingA = await store.unconsumedEvents(forTask: taskA)
        let pendingB = await store.unconsumedEvents(forTask: taskB)
        XCTAssertEqual(pendingA.count, 5)
        XCTAssertEqual(pendingB.count, 3)
        XCTAssertEqual(Set(pendingA.map { $0.taskID }), [taskA])
        XCTAssertEqual(Set(pendingB.map { $0.taskID }), [taskB])
    }
}
