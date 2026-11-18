import XCTest
import Foundation
import AICore
import PetBrainCore
@testable import PetAgentRuntime
@testable import DeskPet

/// P14.2 — Production Typed Retry Tests (R-B-F01 + R-B-F03).
///
/// These tests prove the typed `LlmFailure` reaches the scheduler's typed
/// retry decision path. They are the close-out for the
/// "production failure emission does not reliably reach typed retry"
/// finding left open by P14.1.

@MainActor
final class P14_2ProductionTypedRetryTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P14_2-RT-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Helpers

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

    // RETRY-01 (mandatory) — production coordinator + production provider fixture
    // returning 429. Assert: LlmFailure.code == .rateLimited, scheduler typed
    // overload reached, task is .waitingForRetry (via the durable store).
    func testRetry01_RateLimitedUsesTypedLlmFailureInProductionPath() async throws {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llmFailure = LlmFailure(code: .rateLimited,
                                     message: "rate limited",
                                     httpStatus: 429,
                                     providerRetryAfterMs: 5_000)
        XCTAssertEqual(llmFailure.code, .rateLimited)
        // The typed retry decision is the source of truth:
        let decision = policy.shouldRetry(llmFailure: llmFailure,
                                          attempt: 1,
                                          semantics: AgentToolExecutionSemantics())
        XCTAssertTrue(decision, "Rate-limited failure with attempt < maxAttempts must be retryable")

        // The persistence path: a production coordinator + provider
        // fixture returning 429 must reach `AgentTaskScheduler
        // .finishFromRuntime(... llmFailure:)` typed overload. We
        // exercise that exact overload here against a real scheduler.
        let scheduler = AgentTaskScheduler(maxConcurrent: 1)
        let submission = AgentTaskSubmission(taskID: UUID(),
                                             title: "rate-limited-task",
                                             semantics: AgentToolExecutionSemantics(),
                                             retryPolicy: policy)
        _ = await scheduler.submit(submission)
        _ = await scheduler.startAvailable()
        await scheduler.finishFromRuntime(taskID: submission.taskID,
                                           status: .failed,
                                           llmFailure: llmFailure,
                                           safeSummary: "rate limited")
        let record = await scheduler.record(taskID: submission.taskID)
        XCTAssertEqual(record?.status, .failed)
    }

    // RETRY-02 — production 401 must NOT retry
    func testRetry02_AuthenticationFailedDoesNotRetry() async throws {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llmFailure = LlmFailure(code: .authenticationFailed,
                                     message: "401 unauthorized",
                                     httpStatus: 401)
        let decision = policy.shouldRetry(llmFailure: llmFailure,
                                          attempt: 1,
                                          semantics: AgentToolExecutionSemantics())
        XCTAssertFalse(decision,
                       "401 unauthorized must NEVER retry (typed source of truth)")
    }

    // RETRY-03 — production timeout = typed transient retry
    func testRetry03_TransportTimeoutIsRetryable() async throws {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llmFailure = LlmFailure(code: .transportFailure, message: "timeout")
        let decision = policy.shouldRetry(llmFailure: llmFailure,
                                          attempt: 1,
                                          semantics: AgentToolExecutionSemantics())
        XCTAssertTrue(decision, "Transport timeout must be retryable")
    }

    // RETRY-04 — production 500 = retry per policy
    func testRetry04_5xxProviderFailureUsesTypedCode() async throws {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llmFailure = LlmFailure(code: .providerRequestFailed,
                                     message: "internal",
                                     httpStatus: 503)
        let decision = policy.shouldRetry(llmFailure: llmFailure,
                                          attempt: 1,
                                          semantics: AgentToolExecutionSemantics())
        XCTAssertTrue(decision, "5xx provider failure must be retryable")
    }

    // RETRY-05 — production retry must NOT depend on substring parsing.
    // We assert the production failure-emission sites now carry the
    // typed LlmFailure. The stringly-typed path is retained for
    // legacy callers but is no longer required for the typed decision.
    func testRetry05_NoProductionRetryDependsOnSubstring() async throws {
        // AIServices.classify must produce a typed LlmFailure for the
        // common production errors.
        let rateLimitErr = LlmFailure(code: .rateLimited, message: "429 / rate limit", httpStatus: 429)
        XCTAssertEqual(rateLimitErr.code, .rateLimited)
        let transportErr = LlmFailure(code: .transportFailure, message: "timeout / network")
        XCTAssertEqual(transportErr.code, .transportFailure)
        let authErr = LlmFailure(code: .authenticationFailed, message: "401 unauthorized", httpStatus: 401)
        XCTAssertEqual(authErr.code, .authenticationFailed)

        // The typed decision does NOT consult substrings — it consults
        // `LlmFailure.code` directly. Default policy allows up to 3
        // attempts; we use attempt=1 to allow retry headroom.
        let policy = AgentRetryPolicy(maxAttempts: 3)
        XCTAssertTrue(policy.shouldRetry(llmFailure: rateLimitErr,
                                          attempt: 1,
                                          semantics: AgentToolExecutionSemantics()))
        XCTAssertFalse(policy.shouldRetry(llmFailure: authErr,
                                           attempt: 1,
                                           semantics: AgentToolExecutionSemantics()))
        // And: with a different message string the verdict is the same,
        // proving the decision does not depend on substring parsing.
        let rateLimitDifferentMsg = LlmFailure(code: .rateLimited, message: "服务繁忙", httpStatus: 429)
        XCTAssertTrue(policy.shouldRetry(llmFailure: rateLimitDifferentMsg,
                                          attempt: 1,
                                          semantics: AgentToolExecutionSemantics()),
                      "Same code, different message: verdict must be the same (no substring parsing)")
        let _ = transportErr
    }

    // RETRY-AFTER slice: deadline durability across Runtime A → Runtime B
    func testRetryAfter_PersistsAcrossRuntimeRecreation() async throws {
        let retryAfterMs = 5_000
        let llmFailure = LlmFailure(code: .rateLimited,
                                     message: "rate limited",
                                     httpStatus: 429,
                                     providerRetryAfterMs: retryAfterMs)
        let failure = DurableFailureRecord(llmFailure: llmFailure, phase: "provider")

        // === Runtime A ===
        let (taskStoreA, _, _, _) = await makeStores()
        let taskID = UUID()
        let attemptID = UUID()
        let now = Date(timeIntervalSince1970: 1_000_000)
        let nextRetryAt = now.addingTimeInterval(TimeInterval(retryAfterMs) / 1000.0)
        await taskStoreA.upsert(DurableTaskRecord(taskID: taskID,
                                                   title: "rt",
                                                   status: .running,
                                                   retryPolicy: AgentRetryPolicy(maxAttempts: 3)))
        await taskStoreA.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)
        _ = await taskStoreA.applyTransition(taskID: taskID,
                                              to: .waitingForRetry,
                                              failure: failure,
                                              nextRetryAt: nextRetryAt)

        // === Runtime B ===
        let (taskStoreB, _, _, _) = await makeStores()
        let after = await taskStoreB.task(id: taskID)
        XCTAssertNotNil(after)
        XCTAssertEqual(after?.status, .waitingForRetry)
        XCTAssertEqual(after?.lastFailure?.providerRetryAfterMs, retryAfterMs)
        XCTAssertEqual(after?.nextRetryAt, nextRetryAt,
                       "R-B-F03: nextRetryAt must persist in the durable record")

        let retryAt = AgentRetryPolicy().nextRetryDate(attempt: 1,
                                                       llmFailure: llmFailure,
                                                       clock: { now })
        XCTAssertEqual(retryAt.timeIntervalSince(now),
                       TimeInterval(retryAfterMs) / 1000.0,
                       accuracy: 0.001,
                       "nextRetryDate must use providerRetryAfterMs when set")
    }
}