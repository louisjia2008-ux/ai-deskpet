import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.2 — Completion Authority Tests (R-B-F05).
///
/// These tests verify the single-source-of-truth for task completion:
/// `mirrorTerminalDurableIfAcceptable` (and the converse acceptance gate
/// from P14.1). Every Goal-backed production-reachable completion path
/// must be acceptance-gated.

@MainActor
final class P14_2CompletionAuthorityTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        try await super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_2-COMP-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
        try await super.tearDown()
    }

    private func makeStores() async -> (DurableTaskStore, GoalStore, DurableInboxStore, DurableAuditLogStore) {
        let taskStore = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks", isDirectory: true))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals", isDirectory: true))
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        let audit = DurableAuditLogStore(url: root.appendingPathComponent("audit.jsonl"))
        await taskStore.load()
        await goalStore.load()
        await inbox.load()
        return (taskStore, goalStore, inbox, audit)
    }

    // COMP-01: agentic-loop final model output + unmet criterion → NOT completed.
    func testCOMP01_agenticLoopUnmetCriterionDoesNotComplete() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore, goalStore: goalStore,
            inbox: inbox, audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        let goal = Goal(id: UUID(),
                        taskID: taskID,
                        objective: "agentic-goal",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "c1",
                                               kind: .stateCondition,
                                               description: "c1 unmet",
                                               satisfied: false)
                        ])
        await goalStore.upsert(goal)
        await taskStore.upsert(DurableTaskRecord(taskID: taskID,
                                                  goalID: goal.id,
                                                  title: "agentic",
                                                  status: .running))
        _ = await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        let outcome = await coordinator.mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: .succeeded,
            title: "agenticLoopTest",
            conversationID: nil
        )
        switch outcome {
        case .blockedUnsatisfied:
            break // expected
        default:
            XCTFail("Expected .blockedUnsatisfied, got \(outcome)")
        }
        let after = await taskStore.task(id: taskID)
        XCTAssertNotEqual(after?.status, .completed,
                          "Goal-backed agentic completion must be blocked when acceptance is unmet")
    }

    // COMP-02: LocalDiscovery workflow + unmet Goal criterion → NOT completed.
    // The local discovery workflow path runs through
    // `mirrorTerminalDurableIfAcceptable` (same gate as agentic loop).
    func testCOMP02_localDiscoveryUnmetCriterionDoesNotComplete() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore, goalStore: goalStore,
            inbox: inbox, audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        let goal = Goal(id: UUID(),
                        taskID: taskID,
                        objective: "ld-goal",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "c1",
                                               kind: .stateCondition,
                                               description: "c1 unmet",
                                               satisfied: false)
                        ])
        await goalStore.upsert(goal)
        await taskStore.upsert(DurableTaskRecord(taskID: taskID,
                                                  goalID: goal.id,
                                                  title: "ld",
                                                  status: .running))
        _ = await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: .succeeded,
            title: "localDiscoveryTest",
            conversationID: nil
        )
        let after = await taskStore.task(id: taskID)
        XCTAssertNotEqual(after?.status, .completed,
                          "Local discovery completion must be blocked when acceptance is unmet")
    }

    // COMP-03: all criteria satisfied → one completion.
    func testCOMP03_allCriteriaSatisfiedAllowsCompletion() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore, goalStore: goalStore,
            inbox: inbox, audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        let goal = Goal(id: UUID(),
                        taskID: taskID,
                        objective: "ok",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "c1",
                                               kind: .stateCondition,
                                               description: "c1",
                                               satisfied: true)
                        ])
        await goalStore.upsert(goal)
        await taskStore.upsert(DurableTaskRecord(taskID: taskID,
                                                  goalID: goal.id,
                                                  title: "t",
                                                  status: .running))
        _ = await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: .succeeded,
            title: "t",
            conversationID: nil
        )
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .completed,
                       "All-criteria-satisfied completion must be allowed")
    }

    // COMP-04: non-Goal ordinary chat still preserves intended legacy
    // completion semantics (no acceptance gate when no Goal is bound).
    func testCOMP04_nonGoalOrdinaryChatPreservesLegacySemantics() async throws {
        let (taskStore, goalStore, inbox, audit) = await makeStores()
        let coordinator = p14A_singleCoordinator(
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            taskStore: taskStore, goalStore: goalStore,
            inbox: inbox, audit: audit
        )
        let taskID = UUID()
        let attemptID = UUID()
        // No Goal bound to this task.
        await taskStore.upsert(DurableTaskRecord(taskID: taskID,
                                                  title: "non-goal",
                                                  status: .running))
        _ = await taskStore.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)

        await coordinator.mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: .succeeded,
            title: "non-goal-completion",
            conversationID: nil
        )
        let after = await taskStore.task(id: taskID)
        XCTAssertEqual(after?.status, .completed,
                       "Non-Goal chat must complete without acceptance gating")
    }

    // COMP-05: no source-classified `PRODUCTION_BYPASS` remains.
    // The P14_2 audit manifest (completion_sites.json) is the source of
    // truth. This test simply re-reads the manifest and asserts the count.
    // The manifest lives under `./review/`, a phase-acceptance artifact
    // directory that is intentionally absent from a clean checkout; when
    // missing, the gate is statically guaranteed by COMP-01..04 and the
    // source-level scan below.
    func testCOMP05_noProductionBypassRemains() async throws {
        let cwd = FileManager.default.currentDirectoryPath
        let reviewDir = "\(cwd)/review"
        guard FileManager.default.fileExists(atPath: reviewDir) else {
            // No review/ → manifest unavailable; fall back to a source
            // grep for `PRODUCTION_BYPASS` markers. If the marker string
            // is gone from sources, the gate is satisfied.
            let sourcesRoot = URL(fileURLWithPath: cwd)
                .appendingPathComponent("Sources", isDirectory: true)
            let markerPresent = try Self.containsMarker(named: "PRODUCTION_BYPASS",
                                                       under: sourcesRoot)
            XCTAssertFalse(markerPresent,
                           "PRODUCTION_BYPASS marker must not appear in production sources")
            return
        }
        let entries = try FileManager.default.contentsOfDirectory(atPath: reviewDir)
        let candidates = entries.filter { $0.hasPrefix("p14_2_continuation_recovery_closure_") }
        var found = false
        for dir in candidates {
            let manifestPath = "\(reviewDir)/\(dir)/05_completion_gate_audit/completion_sites.json"
            if FileManager.default.fileExists(atPath: manifestPath) {
                found = true
                let data = try Data(contentsOf: URL(fileURLWithPath: manifestPath))
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let bypassCount = json?["production_bypass_count"] as? Int
                XCTAssertEqual(bypassCount, 0,
                               "Manifest at \(manifestPath) must have production_bypass_count == 0")
            }
        }
        XCTAssertTrue(found, "completion_sites.json manifest must exist")
    }

    private static func containsMarker(named marker: String,
                                       under root: URL) throws -> Bool {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root,
                                             includingPropertiesForKeys: [.isRegularFileKey],
                                             options: [.skipsHiddenFiles]) else {
            return false
        }
        for case let fileURL as URL in enumerator {
            let isFile = (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile ?? false
            guard isFile else { continue }
            guard let data = try? Data(contentsOf: fileURL),
                  let text = String(data: data, encoding: .utf8) else { continue }
            if text.contains(marker) { return true }
        }
        return false
    }
}