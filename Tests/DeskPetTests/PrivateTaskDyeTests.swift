import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

/// Private-chat dye (doc §12.4 私密会话隔离): private tasks project to the live
/// UI but must not reach disk (activity JSONL, run events, checkpoints), and
/// the scheduler must not keep the raw user text in the queue title.
@MainActor
final class PrivateTaskDyeTests: XCTestCase {

    private actor FakeActivityPersistence: AgentTaskActivityEventPersisting {
        var appended: [AgentTaskActivityEvent] = []
        var replaced: [[AgentTaskActivityEvent]] = []
        func append(_ event: AgentTaskActivityEvent) async throws { appended.append(event) }
        func loadEvents() async throws -> [AgentTaskActivityEvent] { appended }
        func replaceAll(_ events: [AgentTaskActivityEvent]) async throws { replaced.append(events) }
        func clear() async throws { appended.removeAll(); replaced.removeAll() }
    }

    private func envelope(taskID: UUID, runID: UUID, seq: UInt64) -> AgentEventEnvelope {
        AgentEventEnvelope(taskID: taskID, runID: runID, sequence: seq,
                           source: .scheduler, kind: .taskQueued,
                           payload: .task(.init(title: "t", status: "queued")))
    }

    // MARK: - Codable compat: legacy payloads without isPrivate decode as false

    func testSubmissionDecodeCompat() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        // Legacy payload: a current submission with the isPrivate key stripped.
        let sub = AgentTaskSubmission(title: "hi")
        var obj = try JSONSerialization.jsonObject(with: encoder.encode(sub)) as! [String: Any]
        XCTAssertNotNil(obj["isPrivate"])   // new payloads carry the key…
        obj.removeValue(forKey: "isPrivate")
        let legacy = try JSONSerialization.data(withJSONObject: obj)
        let back = try decoder.decode(AgentTaskSubmission.self, from: legacy)
        XCTAssertFalse(back.isPrivate)      // …but old ones decode as non-private
        XCTAssertEqual(back.title, "hi")
        // Round-trip with the flag set.
        let priv = AgentTaskSubmission(title: "私密会话", isPrivate: true)
        let privBack = try decoder.decode(AgentTaskSubmission.self, from: encoder.encode(priv))
        XCTAssertTrue(privBack.isPrivate)
        // Queue record round-trip preserves the dye.
        let recData = try encoder.encode(AgentTaskQueueRecord(
            submission: priv, runID: UUID(), status: .queued, queueIndex: 0, attempt: 1, updatedAt: Date()))
        XCTAssertTrue(try decoder.decode(AgentTaskQueueRecord.self, from: recData).isPrivate)
    }

    func testSchedulerCarriesPrivateFlagAndRetryPreserves() async {
        let s = AgentTaskScheduler()
        let rec = await s.submit(AgentTaskSubmission(title: "secret prompt", isPrivate: true))
        XCTAssertTrue(rec.isPrivate)
        let privFlag = await s.isPrivateTask(rec.taskID)
        XCTAssertTrue(privFlag)
        let other = await s.submit(AgentTaskSubmission(title: "normal"))
        let otherFlag = await s.isPrivateTask(other.taskID)
        XCTAssertFalse(otherFlag)
        // Terminal-ize then retry: flag must survive (retry mutates the record).
        await s.finishFromRuntime(taskID: rec.taskID, status: .failed)
        let retried = await s.retry(taskID: rec.taskID, reason: "t")
        XCTAssertNotNil(retried)
        XCTAssertTrue(retried!.isPrivate)
        let stillPrivate = await s.isPrivateTask(rec.taskID)
        XCTAssertTrue(stillPrivate)
    }

    // MARK: - Activity store: private → memory only, public → persisted

    func testPrivateEventsSkipDiskButProjectLive() async throws {
        let fake = FakeActivityPersistence()
        let store = AgentTaskActivityStore(persistence: fake)
        let privTask = UUID(), privRun = UUID()
        let pubTask = UUID(), pubRun = UUID()

        store.markPrivate(taskID: privTask)
        XCTAssertTrue(store.isPrivate(taskID: privTask))
        XCTAssertFalse(store.isPrivate(taskID: pubTask))

        store.publish(envelope(taskID: privTask, runID: privRun, seq: 0))
        store.publish(envelope(taskID: pubTask, runID: pubRun, seq: 0))

        // Live projection sees both…
        XCTAssertNotNil(store.task(id: privTask))
        XCTAssertNotNil(store.task(id: pubTask))

        // …but disk sees only the public one.
        var sawPublic = false
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            await Task.yield()
            let appended = await fake.appended
            if appended.contains(where: { $0.taskID == pubTask }) { sawPublic = true; break }
        }
        XCTAssertTrue(sawPublic, "public event must reach persistence")
        let appended = await fake.appended
        XCTAssertFalse(appended.contains { $0.taskID == privTask },
                       "private event must never reach persistence")
    }

    func testPersistSnapshotExcludesPrivate() async throws {
        let fake = FakeActivityPersistence()
        let store = AgentTaskActivityStore(persistence: fake)
        let privTask = UUID()
        store.markPrivate(taskID: privTask)
        store.publish(envelope(taskID: privTask, runID: UUID(), seq: 0))
        // remove() triggers a full-snapshot rewrite — private must be filtered.
        store.remove(taskID: UUID())
        try? await Task.sleep(nanoseconds: 300_000_000)
        let replaced = await fake.replaced
        XCTAssertTrue(replaced.allSatisfy { $0.allSatisfy { $0.taskID != privTask } })
    }

    func testRemoveAndClearForgetDye() {
        let store = AgentTaskActivityStore(persistence: nil)
        let t = UUID()
        store.markPrivate(taskID: t)
        XCTAssertTrue(store.isPrivate(taskID: t))
        store.remove(taskID: t)
        XCTAssertFalse(store.isPrivate(taskID: t))
        store.markPrivate(taskID: t)
        store.clearHistory()
        XCTAssertFalse(store.isPrivate(taskID: t))
    }
}
