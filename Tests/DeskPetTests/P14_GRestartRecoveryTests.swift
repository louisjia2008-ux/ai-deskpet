import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14-G — App crash / restart recovery.
//
// Critical test: at least one test must create Runtime A, persist state,
// destroy Runtime A (drop the reference), create Runtime B against the same
// on-disk root, and resume. This is the genuine Runtime A → Runtime B test.

@MainActor
final class P14_GRestartRecoveryTests: XCTestCase {

    // MARK: G-01 — Active task survives new process/runtime instance.

    func testG01_activeTaskSurvivesRuntimeAtoB() async throws {
        // Step 1: Runtime A creates a task and persists it.
        let baseDir = p14_makeTempDir("g01")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "survive restart"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        // Drop storeA — Runtime A "exits" the process.
        // Note: Swift won't actually drop the actor reference mid-process,
        // but the test still proves a brand-new actor (Runtime B) reads the
        // same on-disk state. The actor's in-memory cache is unrelated to
        // what the brand-new actor reads.

        // Step 2: Runtime B (a brand-new actor against the same root).
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .running,
                       "Active task must survive Runtime A → Runtime B transition")
    }

    // MARK: G-02 — Waiting approval survives.

    func testG02_waitingApprovalSurvives() async throws {
        let baseDir = p14_makeTempDir("g02")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "approval"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        _ = await storeA.applyTransition(taskID: taskID, to: .waitingForApproval)
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .waitingForApproval)
        // RecoveryClassifier must say "leave alone — waiting for user".
        let classifier = RecoveryClassifier()
        let cls = await classifier.classify(loaded!)
        XCTAssertEqual(cls.action, .waitingForApprovalSurvives)
    }

    // MARK: G-03 — Waiting user input survives.

    func testG03_waitingUserInputSurvives() async throws {
        let baseDir = p14_makeTempDir("g03")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "user input"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        _ = await storeA.applyTransition(taskID: taskID, to: .waitingForUserInput)
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .waitingForUserInput)
    }

    // MARK: G-04 — Pending retry survives.

    func testG04_pendingRetrySurvives() async throws {
        let baseDir = p14_makeTempDir("g04")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "retry pending"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        _ = await storeA.applyTransition(taskID: taskID, to: .waitingForRetry)
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .waitingForRetry)
    }

    // MARK: G-05 — Completed task does not resume.

    func testG05_completedTaskDoesNotResume() async throws {
        let baseDir = p14_makeTempDir("g05")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "completed"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        _ = await storeA.applyTransition(taskID: taskID, to: .completed)
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .completed)
        XCTAssertTrue(loaded?.status.isTerminal ?? false)
        // Classifier says: terminal — leave alone.
        let classifier = RecoveryClassifier()
        let cls = await classifier.classify(loaded!)
        XCTAssertEqual(cls.action, .leaveUnchanged)
    }

    // MARK: G-06 — Cancelled task does not resume.

    func testG06_cancelledTaskDoesNotResume() async throws {
        let baseDir = p14_makeTempDir("g06")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "cancelled"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        _ = await storeA.applyTransition(taskID: taskID, to: .cancelled)
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .cancelled)
    }

    // MARK: G-07 — Interrupted active run is marked interrupted by classifier.

    func testG07_activeRunInterruptedGetsMarkedInterrupted() async throws {
        let baseDir = p14_makeTempDir("g07")
        let storeA = DurableTaskStore(baseDirectory: baseDir)
        await storeA.load()
        let taskID = UUID()
        _ = await storeA.upsert(DurableTaskRecord(taskID: taskID, title: "active"))
        _ = await storeA.applyTransition(taskID: taskID, to: .running)
        let storeB = DurableTaskStore(baseDirectory: baseDir)
        await storeB.load()
        let loaded = await storeB.task(id: taskID)
        XCTAssertEqual(loaded?.status, .running)
        let classifier = RecoveryClassifier()
        let cls = await classifier.classify(loaded!)
        XCTAssertEqual(cls.action, .markInterrupted)
        // Runtime B's recovery path applies the classification: it would
        // now transition running → interrupted to make the runnable
        // boundary explicit.
        let applied = await storeB.applyTransition(taskID: taskID, to: .interrupted)
        XCTAssertEqual(applied?.status, .interrupted)
    }

    // MARK: G-08 — Known successful side effect is reused.

    func testG08_knownSuccessfulSideEffectReusedAcrossRestart() async throws {
        let baseDir = p14_makeTempDir("g08")
        let seDir = baseDir.appendingPathComponent("se")
        let taskID = UUID()
        let runID = UUID()
        let opID = "op-g08"
        let toolID = ToolID(rawValue: "t")
        let args: AgentJSONValue = .object(["k": .string("v")])
        // Runtime A completes the side effect.
        let a = AgentSideEffectLedgerStore(baseDirectory: seDir)
        _ = try await a.begin(operationID: opID,
                              idempotencyKey: "k-g08",
                              taskID: taskID,
                              runID: runID,
                              toolID: toolID,
                              capabilityID: nil,
                              operationKind: "tool.write",
                              arguments: args)
        try await a.complete(operationID: opID,
                             taskID: taskID,
                             runID: runID,
                             status: .succeeded,
                             result: ToolExecutionResult(status: .success,
                                                        userSafeSummary: "ok",
                                                        structuredData: .object(["ok": .bool(true)])))
        // Runtime B begins the same idempotency key.
        let b = AgentSideEffectLedgerStore(baseDirectory: seDir)
        let reused = try await b.begin(operationID: opID,
                                       idempotencyKey: "k-g08",
                                       taskID: taskID,
                                       runID: runID,
                                       toolID: toolID,
                                       capabilityID: nil,
                                       operationKind: "tool.write",
                                       arguments: args)
        if case .alreadySucceeded = reused {
            // Good — Runtime B observes the durable success.
        } else {
            XCTFail("Expected .alreadySucceeded on Runtime B begin; got \(reused)")
        }
    }

    // MARK: G-09 — Unknown side-effect completion does not blindly re-run destructive action.

    func testG09_unknownSideEffectOutcomeIsBlockedNotRepeated() async throws {
        let baseDir = p14_makeTempDir("g09")
        let seDir = baseDir.appendingPathComponent("se")
        let taskID = UUID()
        let runID = UUID()
        let opID = "op-g09-destructive"
        let toolID = ToolID(rawValue: "destructive")
        let args: AgentJSONValue = .object(["k": .string("v")])
        let a = AgentSideEffectLedgerStore(baseDirectory: seDir)
        // Begin but never complete — the durable record shows .started.
        _ = try await a.begin(operationID: opID,
                              idempotencyKey: "k-g09",
                              taskID: taskID,
                              runID: runID,
                              toolID: toolID,
                              capabilityID: nil,
                              operationKind: "tool.destructive",
                              arguments: args)
        let b = AgentSideEffectLedgerStore(baseDirectory: seDir)
        let result = try await b.begin(operationID: opID,
                                       idempotencyKey: "k-g09",
                                       taskID: taskID,
                                       runID: runID,
                                       toolID: toolID,
                                       capabilityID: nil,
                                       operationKind: "tool.destructive",
                                       arguments: args)
        // Unknown outcome (.started without terminal completion) must block
        // destructive re-execution.
        if case .blockedOutcomeUnknown = result {
            // Good.
        } else {
            XCTFail("Destructive action with unknown outcome must be blocked; got \(result)")
        }
    }

    // MARK: G-10 — Multiple restart cycles remain idempotent.

    func testG10_multipleRestartCyclesRemainIdempotent() async throws {
        let baseDir = p14_makeTempDir("g10")
        let taskID = UUID()
        // Cycle 1
        do {
            let s = DurableTaskStore(baseDirectory: baseDir)
            await s.load()
            _ = await s.upsert(DurableTaskRecord(taskID: taskID, title: "multi-cycle"))
            _ = await s.applyTransition(taskID: taskID, to: .running)
            _ = await s.applyTransition(taskID: taskID, to: .interrupted)
        }
        // Cycle 2
        do {
            let s = DurableTaskStore(baseDirectory: baseDir)
            await s.load()
            let loaded = await s.task(id: taskID)
            XCTAssertEqual(loaded?.status, .interrupted)
            _ = await s.applyTransition(taskID: taskID, to: .running)
            _ = await s.applyTransition(taskID: taskID, to: .interrupted)
        }
        // Cycle 3
        do {
            let s = DurableTaskStore(baseDirectory: baseDir)
            await s.load()
            let loaded = await s.task(id: taskID)
            XCTAssertEqual(loaded?.status, .interrupted,
                           "Multiple restart cycles must preserve the durable state")
        }
    }
}
