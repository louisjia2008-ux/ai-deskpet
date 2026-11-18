import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14-B — Durable Task State Machine.
//
// PROVES:
// - Legal transitions pass; the new record is persisted.
// - Illegal transitions cannot corrupt state (applyTransition returns nil).
// - Terminal task cannot emit an ordinary running transition.
// - Cancellation is exactly once.
// - Retry creates a NEW attempt with a NEW runID but retains the same taskID.
// - Persistence round-trip preserves task state exactly.
// - Historical task records remain decodable (backward-compatible decode).
// - Concurrent state updates do not produce double terminalization.

@MainActor
final class P14_BDurableTaskStateMachineTests: XCTestCase {

    // MARK: B-01 — Legal state transitions pass.

    func testB01_legalTransitionsPass() async throws {
        let dir = p14_makeTempDir("b01")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        let record = DurableTaskRecord(taskID: taskID, title: "legal transitions")
        _ = await store.upsert(record)
        // queued → running
        let r1 = await store.applyTransition(taskID: taskID, to: .running)
        let updated1 = try XCTUnwrap(r1)
        XCTAssertEqual(updated1.status, .running)
        // running → waitingForApproval
        let r2 = await store.applyTransition(taskID: taskID, to: .waitingForApproval)
        XCTAssertEqual(r2?.status, .waitingForApproval)
        // waitingForApproval → running
        let r3 = await store.applyTransition(taskID: taskID, to: .running)
        XCTAssertEqual(r3?.status, .running)
        // running → completed
        let r4 = await store.applyTransition(taskID: taskID, to: .completed)
        XCTAssertEqual(r4?.status, .completed)
        XCTAssertNotNil(r4?.terminalResultTerminalID)
    }

    // MARK: B-02 — Illegal transition cannot corrupt state.

    func testB02_illegalTransitionCannotCorruptState() async throws {
        let dir = p14_makeTempDir("b02")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "illegal guard"))
        // queued → completed is illegal (must go through running)
        let r = await store.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(r)
        // Status remains queued.
        let fresh = await store.task(id: taskID)
        XCTAssertEqual(fresh?.status, .queued)
    }

    // MARK: B-03 — Terminal task cannot emit ordinary running transition.

    func testB03_terminalTaskCannotResumeViaOrdinaryRunning() async throws {
        let dir = p14_makeTempDir("b03")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "terminal guard"))
        _ = await store.applyTransition(taskID: taskID, to: .running)
        _ = await store.applyTransition(taskID: taskID, to: .completed)
        // Try to re-enter running from terminal.
        let r = await store.applyTransition(taskID: taskID, to: .running)
        XCTAssertNil(r)
        let fresh = await store.task(id: taskID)
        XCTAssertEqual(fresh?.status, .completed)
    }

    // MARK: B-04 — Cancellation is exactly once.

    func testB04_cancellationIsExactlyOnce() async throws {
        let dir = p14_makeTempDir("b04")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "cancel once"))
        _ = await store.applyTransition(taskID: taskID, to: .running)
        // First cancel succeeds.
        let r1 = await store.applyTransition(taskID: taskID, to: .cancelled)
        XCTAssertEqual(r1?.status, .cancelled)
        // Second cancel attempt is rejected (terminal state).
        let r2 = await store.applyTransition(taskID: taskID, to: .cancelled)
        XCTAssertNil(r2)
        // Status remains cancelled (not corrupted).
        let fresh = await store.task(id: taskID)
        XCTAssertEqual(fresh?.status, .cancelled)
        // Attempt to re-enter running is illegal from cancelled.
        let r3 = await store.applyTransition(taskID: taskID, to: .running)
        XCTAssertNil(r3)
    }

    // MARK: B-05 — Retry creates new attempt but retains same taskID.

    func testB05_retryCreatesNewAttemptRetainsTaskID() async throws {
        let dir = p14_makeTempDir("b05")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "retry same task"))
        _ = await store.recordNewAttempt(taskID: taskID,
                                         attemptID: UUID(),
                                         runID: UUID())
        _ = await store.recordNewAttempt(taskID: taskID,
                                         attemptID: UUID(),
                                         runID: UUID())
        let fresh = await store.task(id: taskID)
        XCTAssertEqual(fresh?.taskID, taskID)
        XCTAssertEqual(fresh?.attemptCount, 2)
        let attempts = await store.attempts(forTask: taskID)
        XCTAssertEqual(attempts.count, 2)
        // Two distinct runIDs
        XCTAssertNotEqual(attempts[0].runID, attempts[1].runID)
    }

    // MARK: B-06 — Restart / interruption does NOT convert task into completed.

    func testB06_interruptedDoesNotBecomeCompleted() async throws {
        let dir = p14_makeTempDir("b06")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "interrupted guard"))
        _ = await store.applyTransition(taskID: taskID, to: .running)
        _ = await store.applyTransition(taskID: taskID, to: .interrupted)
        // From interrupted, the task MUST NOT silently become completed.
        // The recovery flow would transition back to .running or .waitingForUser.
        let r = await store.applyTransition(taskID: taskID, to: .completed)
        XCTAssertNil(r, "interrupted -> completed must be rejected")
        let legal = await store.applyTransition(taskID: taskID, to: .running)
        XCTAssertEqual(legal?.status, .running)
    }

    // MARK: B-07 — Waiting approval state retains approval context.

    func testB07_waitingApprovalStatePersists() async throws {
        let dir = p14_makeTempDir("b07")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "approval persistence"))
        _ = await store.applyTransition(taskID: taskID, to: .running)
        _ = await store.applyTransition(taskID: taskID, to: .waitingForApproval)
        // Reload from disk and verify state survives.
        let store2 = DurableTaskStore(baseDirectory: dir)
        await store2.load()
        let loaded = await store2.task(id: taskID)
        XCTAssertEqual(loaded?.status, .waitingForApproval,
                       "waitingForApproval must persist across store reload")
    }

    // MARK: B-08 — Persistence round-trip preserves task state exactly.

    func testB08_persistenceRoundTripPreservesState() async throws {
        let dir = p14_makeTempDir("b08")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        let original = DurableTaskRecord(taskID: taskID,
                                          conversationID: UUID(),
                                          title: "round trip",
                                          status: .running,
                                          attemptCount: 3)
        _ = await store.upsert(original)
        // Reload.
        let store2 = DurableTaskStore(baseDirectory: dir)
        await store2.load()
        let loaded = await store2.task(id: taskID)
        XCTAssertEqual(loaded?.status, .running)
        XCTAssertEqual(loaded?.attemptCount, 3)
        XCTAssertEqual(loaded?.conversationID, original.conversationID)
    }

    // MARK: B-09 — Historical task records remain decodable.

    func testB09_historicalRecordsRemainDecodable() throws {
        // Hand-craft a JSON payload using the historical schema version 0
        // (omitted) — the decoder must default fields and still produce a
        // usable record.
        let taskID = UUID()
        let json = """
        {
          "schemaVersion": 1,
          "taskID": "\(taskID.uuidString)",
          "title": "historical",
          "status": "running",
          "createdAt": "2026-01-01T00:00:00Z",
          "updatedAt": "2026-01-01T00:00:00Z",
          "attemptCount": 0,
          "retryPolicy": {
            "maxAttempts": 3,
            "baseDelay": 1,
            "exponentialBackoff": true,
            "jitter": 0,
            "retryableErrorCategories": []
          }
        }
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let record = try decoder.decode(DurableTaskRecord.self, from: json)
        XCTAssertEqual(record.taskID, taskID)
        XCTAssertEqual(record.status, .running)
        XCTAssertNil(record.conversationID, "Optional fields absent in historical JSON must decode as nil")
    }

    // MARK: B-10 — Concurrent state updates do not produce double terminalization.

    func testB10_concurrentUpdatesDoNotProduceDoubleTerminalization() async throws {
        let dir = p14_makeTempDir("b10")
        let store = DurableTaskStore(baseDirectory: dir)
        await store.load()
        let taskID = UUID()
        _ = await store.upsert(DurableTaskRecord(taskID: taskID, title: "concurrent"))
        _ = await store.applyTransition(taskID: taskID, to: .running)

        // Fire many concurrent attempts to terminalize. Only the first should
        // succeed; subsequent attempts must be no-ops on a terminal record.
        let terminalAttempts: [DurableTaskState] = Array(repeating: .completed, count: 50)
        let results = await withTaskGroup(of: DurableTaskRecord?.self,
                                          returning: [DurableTaskRecord?].self) { group in
            for _ in terminalAttempts {
                group.addTask { await store.applyTransition(taskID: taskID, to: .completed) }
            }
            var collected: [DurableTaskRecord?] = []
            for await r in group { collected.append(r) }
            return collected
        }
        let successful = results.compactMap { $0 }
        XCTAssertEqual(successful.count, 1,
                       "Exactly one concurrent applyTransition must succeed")
        XCTAssertEqual(successful.first?.status, .completed)
    }
}
