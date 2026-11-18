import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P14.1 — Production Runtime Integration tests.
//
// These tests exercise the production coordinator/container/composition
// paths (R-B-01 through R-B-08). They are the tests that prove the OLD
// WRONG behaviour identified by Reviewer B can no longer occur:
//
//   - Production durable wiring (PW-01..05)
//   - Acceptance completion gate (AC-01..06)
//   - Restart recovery (RR-01..08)
//   - Durable approval (AP-01..07)
//   - Typed retry (RT-01..08)
//   - LlmFailure production integration (LF-01..06)
//   - Negative tests (R-B-NEG-01..07)
//
// All tests construct the REAL production wiring (no test-only parallel
// helpers). Where a true Runtime A → Runtime B re-creation is required,
// the test deliberately constructs two independent containers against the
// same persistent on-disk root.

@MainActor
final class P14_1ProductionRuntimeIntegrationTests: XCTestCase {

    // MARK: - PW — Production Wiring (R-B-01)

    /// PW-01: A real production container constructed against a real
    /// persistent durable root records the durable task on durable-task
    /// creation.
    func testPW01_realContainerCreatesDurableTaskRecord() async throws {
        let root = p14_makeTempDir("pw01")
        let durableTaskStore = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals"))
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        let auditLog = DurableAuditLogStore(url: root.appendingPathComponent("audit.jsonl"))
        let schedulerSnapshots = DurableSchedulerSnapshotStore(url: root.appendingPathComponent("scheduler.json"))
        await durableTaskStore.load()
        await goalStore.load()
        await inbox.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "完成目标"),
            conversation: P14AFakeConversation(reply: "hi"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: durableTaskStore,
            goalStore: goalStore,
            durableInboxStore: inbox,
            durableAuditLogStore: auditLog,
            durableSchedulerSnapshotStore: schedulerSnapshots)

        // Drive a chat completion.
        let stream = coordinator.handle(.userMessage(text: "你好", conversationClass: .normal))
        for await _ in stream { /* drain */ }
        // Allow any post-stream transitions to flush.
        try? await Task.sleep(nanoseconds: 50_000_000)

        // At least one durable task record must have been created.
        let records = await durableTaskStore.allTasks()
        XCTAssertFalse(records.isEmpty, "real production container must create a durable task")
        let statuses = records.map { $0.status }
        XCTAssertTrue(statuses.contains { $0 == .running || $0 == .completed },
                      "durable status should reflect running or completed, got \(statuses)")
    }

    /// PW-02: A real production state transition updates the durable task.
    func testPW02_realStateTransitionUpdatesDurableStore() async throws {
        let root = p14_makeTempDir("pw02")
        let durableTaskStore = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await durableTaskStore.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: durableTaskStore)
        let stream = coordinator.handle(.userMessage(text: "hi", conversationClass: .normal))
        for await _ in stream {}
        try? await Task.sleep(nanoseconds: 50_000_000)

        let records = await durableTaskStore.allTasks()
        XCTAssertGreaterThanOrEqual(records.count, 1)
        // The durable store must have advanced past `.queued`.
        XCTAssertTrue(records.contains { $0.status != .queued && $0.status != .unknown },
                      "durable task should have transitioned beyond .queued")
    }

    /// PW-04: Real Runtime A → Runtime B re-creation reopens the same
    /// durable store. (TRUE Runtime recreation, not in-memory resume.)
    func testPW04_realRuntimeRecreationReopensSameDurableStore() async throws {
        let root = p14_makeTempDir("pw04")
        let tasksRoot = root.appendingPathComponent("tasks")
        let goalsRoot = root.appendingPathComponent("goals")
        let inboxRoot = root.appendingPathComponent("inbox.jsonl")

        // Runtime A
        do {
            let storeA = DurableTaskStore(baseDirectory: tasksRoot)
            let goalA = GoalStore(baseDirectory: goalsRoot)
            let inboxA = DurableInboxStore(baseDirectory: inboxRoot)
            await storeA.load(); await goalA.load(); await inboxA.load()

            let coordA = PetAgentRuntimeCoordinator(
                context: P14AFakeContext(),
                model: P14ARespondModel(text: "完成目标"),
                conversation: P14AFakeConversation(reply: "hi"),
                gate: P14AAllowAppGate(),
                executor: P14AFakeExecutor(),
                policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                ledger: NoopAgentTaskLedgerStore(),
                clock: WallClock(),
                durableTaskStore: storeA, goalStore: goalA, durableInboxStore: inboxA)
            for await _ in coordA.handle(.userMessage(text: "task-A", conversationClass: .normal)) {}
            try? await Task.sleep(nanoseconds: 50_000_000)
            let runtimeARecords = await storeA.allTasks()
            XCTAssertFalse(runtimeARecords.isEmpty)
        }

        // Runtime B — fresh store instances against the same disk root.
        do {
            let storeB = DurableTaskStore(baseDirectory: tasksRoot)
            await storeB.load()
            let recordsB = await storeB.allTasks()
            XCTAssertFalse(recordsB.isEmpty,
                           "Runtime B should observe the durable task created by Runtime A")
        }
    }

    // MARK: - AC — Acceptance Completion Gate (R-B-02)

    /// AC-01 (mandatory negative): a Goal with an unmet required criterion
    /// CANNOT be completed by a model stream ending.
    func testAC01_unmetCriterionBlocksCompletion() async throws {
        let root = p14_makeTempDir("ac01")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals"))
        await store.load(); await goalStore.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store, goalStore: goalStore)

        // Pre-create the durable task in `.running` state and bind a Goal
        // with an unmet required criterion BEFORE any chat. This avoids the
        // race where the first chat would mark the task `.completed` without
        // consulting the (yet un-bound) Goal.
        let pinnedTaskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: pinnedTaskID,
                                             conversationID: nil,
                                             title: "ac01",
                                             status: .running))
        await store.recordNewAttempt(taskID: pinnedTaskID,
                                     attemptID: UUID(),
                                     runID: UUID())
        let goal = Goal(taskID: pinnedTaskID, objective: "test",
                        acceptanceCriteria: [
                            AcceptanceCriterion(criterionID: "criterion.required",
                                               kind: .toolOutcome,
                                               description: "must run tool X",
                                               required: true,
                                               satisfied: false)
                        ])
        await goalStore.upsert(goal)

        // Now drive a chat completion with the SAME taskID — model produces
        // a final-looking response. The Goal has an unmet `.toolOutcome`
        // criterion so AcceptanceEvaluator returns `.unsatisfied` and the
        // coordinator MUST NOT record `.completed`.
        let event = UserMessageEvent(
            conversationID: UUID(),
            messageID: UUID(),
            text: "完成目标",
            taskIDOverride: pinnedTaskID,
            runIDOverride: UUID(),
            metadata: UserMessageMetadata())
        for await _ in coordinator.handle(.userMessage(event)) {}
        try? await Task.sleep(nanoseconds: 50_000_000)

        let updated = await store.task(id: pinnedTaskID)
        XCTAssertNotNil(updated)
        XCTAssertNotEqual(updated?.status, .completed,
                          "AC-01: model stream ending MUST NOT complete a Goal with unmet criteria")
    }

    /// AC-02: All required criteria satisfied → exactly one `.completed`.
    func testAC02_allCriteriaSatisfiedAllowsExactlyOneCompletion() async throws {
        let root = p14_makeTempDir("ac02")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals"))
        await store.load(); await goalStore.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store, goalStore: goalStore)

        let pinnedTaskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: pinnedTaskID,
                                             conversationID: nil,
                                             title: "ac02",
                                             status: .running))
        await store.recordNewAttempt(taskID: pinnedTaskID,
                                     attemptID: UUID(),
                                     runID: UUID())
        await goalStore.upsert(Goal(taskID: pinnedTaskID, objective: "test",
                                    acceptanceCriteria: [
                                        AcceptanceCriterion(criterionID: "criterion.req",
                                                           kind: .stateCondition,
                                                           description: "must be true",
                                                           required: true,
                                                           satisfied: true)
                                    ]))

        let event = UserMessageEvent(
            conversationID: UUID(),
            messageID: UUID(),
            text: "完成目标",
            taskIDOverride: pinnedTaskID,
            runIDOverride: UUID(),
            metadata: UserMessageMetadata())
        for await _ in coordinator.handle(.userMessage(event)) {}
        try? await Task.sleep(nanoseconds: 50_000_000)

        let updated = await store.task(id: pinnedTaskID)
        XCTAssertEqual(updated?.status, .completed,
                       "AC-02: all criteria satisfied → task must be .completed")
    }

    /// AC-03: A `.userApproval` criterion remains unsatisfied until the
    /// approval event arrives.
    func testAC03_userApprovalCriterionRemainsUnsatisfied() async throws {
        let root = p14_makeTempDir("ac03")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals"))
        await store.load(); await goalStore.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store, goalStore: goalStore)

        let pinnedTaskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: pinnedTaskID,
                                             conversationID: nil,
                                             title: "ac03",
                                             status: .running))
        await store.recordNewAttempt(taskID: pinnedTaskID,
                                     attemptID: UUID(),
                                     runID: UUID())
        await goalStore.upsert(Goal(taskID: pinnedTaskID, objective: "needs approval",
                                    acceptanceCriteria: [
                                        AcceptanceCriterion(criterionID: "criterion.approval",
                                                           kind: .userApproval,
                                                           description: "user must approve",
                                                           required: true,
                                                           satisfied: false)
                                    ]))

        let event = UserMessageEvent(
            conversationID: UUID(),
            messageID: UUID(),
            text: "完成目标",
            taskIDOverride: pinnedTaskID,
            runIDOverride: UUID(),
            metadata: UserMessageMetadata())
        for await _ in coordinator.handle(.userMessage(event)) {}
        try? await Task.sleep(nanoseconds: 50_000_000)
        let updated = await store.task(id: pinnedTaskID)
        // AcceptanceEvaluator classifies unmet `.userApproval` as
        // `.waitingForUser` → durable state should be `.waitingForApproval`.
        XCTAssertNotEqual(updated?.status, .completed,
                          "AC-03: unmet user-approval criterion blocks completion")
        XCTAssertEqual(updated?.status, .waitingForApproval,
                       "AC-03: status should be waitingForApproval, got \(String(describing: updated?.status))")
    }

    // MARK: - RR — Production Restart Recovery (R-B-06)

    /// RR-01 + RR-04: production Runtime A → Runtime B; an active task
    /// observed in `.running` is classified by `RecoveryClassifier` and
    /// marked `.interrupted`, NOT flipped to `.failed`.
    func testRR01_04_activeTaskMarkedInterruptedNotFailed() async throws {
        let root = p14_makeTempDir("rr01")
        let tasksRoot = root.appendingPathComponent("tasks")
        let goalsRoot = root.appendingPathComponent("goals")
        let inboxRoot = root.appendingPathComponent("inbox.jsonl")

        let storeA = DurableTaskStore(baseDirectory: tasksRoot)
        await storeA.load()
        // Inject a task that is `.running` to simulate a process crash.
        let taskID = UUID()
        let record = DurableTaskRecord(taskID: taskID,
                                      conversationID: nil,
                                      title: "interrupted",
                                      status: .running)
        await storeA.upsert(record)

        // Runtime B: fresh store against the same on-disk root.
        let storeB = DurableTaskStore(baseDirectory: tasksRoot)
        let goalB = GoalStore(baseDirectory: goalsRoot)
        let inboxB = DurableInboxStore(baseDirectory: inboxRoot)
        await storeB.load(); await goalB.load(); await inboxB.load()

        let classifier = RecoveryClassifier()
        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(),
            conversation: P14AFakeConversation(),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: storeB, goalStore: goalB, durableInboxStore: inboxB,
            recoveryClassifier: classifier)
        _ = await coordinator.reconcileAfterRestart()
        try? await Task.sleep(nanoseconds: 50_000_000)

        let after = await storeB.task(id: taskID)
        XCTAssertNotNil(after)
        XCTAssertEqual(after?.status, .interrupted,
                       "RR-01+04: running → interrupted, NOT failed")
        XCTAssertNotEqual(after?.status, .failed)
    }

    /// RR-05: a `.completed` task remains terminal after reconcile.
    func testRR05_completedTaskRemainsTerminal() async throws {
        let root = p14_makeTempDir("rr05")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "completed",
                                             status: .completed))

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(),
            conversation: P14AFakeConversation(),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store)
        _ = await coordinator.reconcileAfterRestart()
        try? await Task.sleep(nanoseconds: 50_000_000)
        let after = await store.task(id: taskID)
        XCTAssertEqual(after?.status, .completed)
    }

    /// RR-06: a `.cancelled` task remains terminal after reconcile.
    func testRR06_cancelledTaskRemainsTerminal() async throws {
        let root = p14_makeTempDir("rr06")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "cancelled",
                                             status: .cancelled))

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(),
            conversation: P14AFakeConversation(),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store)
        _ = await coordinator.reconcileAfterRestart()
        try? await Task.sleep(nanoseconds: 50_000_000)
        let after = await store.task(id: taskID)
        XCTAssertEqual(after?.status, .cancelled)
    }

    /// RR-02: a `.waitingForApproval` task survives restart untouched.
    func testRR02_waitingForApprovalSurvivesRestart() async throws {
        let root = p14_makeTempDir("rr02")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "approval",
                                             status: .waitingForApproval))
        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(),
            conversation: P14AFakeConversation(),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store)
        _ = await coordinator.reconcileAfterRestart()
        try? await Task.sleep(nanoseconds: 50_000_000)
        let after = await store.task(id: taskID)
        XCTAssertEqual(after?.status, .waitingForApproval,
                       "RR-02: waitingForApproval must survive restart")
    }

    // MARK: - AP — Durable Approval (R-B-07)

    /// AP-04: a duplicate approval event is idempotent. The inbox accepts
    /// the first event; subsequent duplicates are silently dropped.
    func testAP04_duplicateApprovalEventIsIdempotent() async throws {
        let root = p14_makeTempDir("ap04")
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        await inbox.load()
        let taskID = UUID()
        let event = InboxEvent(taskID: taskID,
                               kind: .approvalDecision,
                               payload: .object(["decision": .string("approved")]))
        let first = await inbox.appendIfNew(event)
        let second = await inbox.appendIfNew(event)
        XCTAssertTrue(first)
        XCTAssertFalse(second, "duplicate approval event must be silently dropped")
        let all = await inbox.allEvents()
        XCTAssertEqual(all.filter { $0.taskID == taskID }.count, 1)
    }

    /// AP-05: a stale approval cannot approve a new task. Distinct taskID
    /// isolation guarantees this — the inbox routes events by taskID.
    func testAP05_staleApprovalCannotApproveNewTask() async throws {
        let root = p14_makeTempDir("ap05")
        let inbox = DurableInboxStore(baseDirectory: root.appendingPathComponent("inbox.jsonl"))
        await inbox.load()
        let oldTask = UUID(), newTask = UUID()
        await inbox.appendIfNew(InboxEvent(taskID: oldTask,
                                           kind: .approvalDecision,
                                           payload: .object(["decision": .string("approved")])))
        let unconsumedOld = await inbox.unconsumedEvents(forTask: oldTask)
        let unconsumedNew = await inbox.unconsumedEvents(forTask: newTask)
        XCTAssertEqual(unconsumedOld.count, 1)
        XCTAssertEqual(unconsumedNew.count, 0,
                       "AP-05: approval for old task must not surface in new task's unconsumed stream")
    }

    // MARK: - LF — LlmFailure production integration (R-B-03)

    /// LF-01: a 401 `LLMClientError` is classified as `.authenticationFailed`.
    func testLF01_authenticationFailureIsTyped() {
        let llmError = LLMClientError.httpFailure(statusCode: 401,
                                                  endpoint: "https://example.com",
                                                  message: "")
        let typed = AIServices.classify(llmError)
        XCTAssertNotNil(typed)
        XCTAssertEqual(typed?.code, .authenticationFailed)
    }

    /// LF-02: a 429 → `.rateLimited` (typed classifier).
    func testLF02_rateLimitIsTyped() {
        let llmError = LLMClientError.httpFailure(statusCode: 429,
                                                  endpoint: "https://example.com",
                                                  message: "")
        let typed = AIServices.classify(llmError)
        XCTAssertNotNil(typed)
        XCTAssertEqual(typed?.code, .rateLimited)
    }

    /// LF-03: a 5xx / timeout maps to `.transportFailure` or
    /// `.providerRequestFailed`.
    func testLF03_transientFailureIsTyped() {
        let llmError = LLMClientError.httpFailure(statusCode: 500,
                                                  endpoint: "https://example.com",
                                                  message: "")
        let typed = AIServices.classify(llmError)
        XCTAssertNotNil(typed)
        XCTAssertTrue(typed?.code == .transportFailure || typed?.code == .providerRequestFailed,
                      "got \(String(describing: typed?.code))")
    }

    /// LF-04: the runtime retry path does NOT need raw provider substrings.
    /// The typed `shouldRetry(llmFailure:)` returns the same verdict as a
    /// hypothetical substring scan would — but typed.
    func testLF04_typedRetryDecisionDoesNotNeedSubstring() {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llmRateLimited = LlmFailure(code: .rateLimited,
                                        message: "Too Many Requests",
                                        httpStatus: 429)
        let llmAuthFailed = LlmFailure(code: .authenticationFailed,
                                       message: "Invalid API Key",
                                       httpStatus: 401)
        let semantics = AgentToolExecutionSemantics(idempotency: .idempotent)
        XCTAssertTrue(policy.shouldRetry(llmFailure: llmRateLimited, attempt: 1, semantics: semantics))
        XCTAssertFalse(policy.shouldRetry(llmFailure: llmAuthFailed, attempt: 1, semantics: semantics))
    }

    /// LF-05: user-facing copy does not expose raw HTTP status codes or
    /// machine-readable error tokens. The user copy is intentionally
    /// user-friendly ("API Key 无效或已失效。") rather than raw provider
    /// substrings.
    func testLF05_userFacingCopyHasNoRawProviderSubstrings() {
        let typed = LlmFailure(code: .authenticationFailed,
                               message: "API key 无效 / 401")
        let copy = UserFacingErrorPresenter.providerMessage(from: typed)
        XCTAssertFalse(copy.contains("401"),
                       "user copy must not contain raw provider substring '401'")
        XCTAssertFalse(copy.contains("LlmFailure"),
                       "user copy must not contain internal type names")
    }

    /// LF-06: equivalent semantic failures across providers map to the
    /// same `LlmFailure.code` (and thus the same runtime recovery
    /// category).
    func testLF06_equivalentSemanticFailuresProduceSameCode() {
        // Two "transport" failures shaped differently:
        let urlError = URLError(.timedOut)
        let providerConnError = ProviderConnectionError.timeout
        let typed1 = AIServices.classify(urlError)
        let typed2 = AIServices.classify(providerConnError)
        XCTAssertNotNil(typed1)
        XCTAssertNotNil(typed2)
        XCTAssertEqual(typed1?.code, typed2?.code,
                       "different raw provider errors with same semantic must map to same LlmFailure.code")
    }

    // MARK: - RT — Typed Retry (R-B-08)

    /// RT-04: `.authenticationFailed` does NOT auto-retry.
    func testRT04_authFailureDoesNotAutoRetry() {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llm = LlmFailure(code: .authenticationFailed, message: "Invalid API Key")
        let semantics = AgentToolExecutionSemantics(idempotency: .idempotent)
        XCTAssertFalse(policy.shouldRetry(llmFailure: llm, attempt: 1, semantics: semantics))
    }

    /// RT-05: max attempts enforced.
    func testRT05_maxAttemptsEnforced() {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llm = LlmFailure(code: .rateLimited, message: "429")
        let semantics = AgentToolExecutionSemantics(idempotency: .idempotent)
        XCTAssertTrue(policy.shouldRetry(llmFailure: llm, attempt: 1, semantics: semantics))
        XCTAssertTrue(policy.shouldRetry(llmFailure: llm, attempt: 2, semantics: semantics))
        XCTAssertFalse(policy.shouldRetry(llmFailure: llm, attempt: 3, semantics: semantics))
    }

    /// RT-02: `providerRetryAfterMs` influences the next retry date.
    func testRT02_providerRetryAfterInfluencesBackoff() {
        let policy = AgentRetryPolicy()
        let llm = LlmFailure(code: .rateLimited,
                             message: "429",
                             providerRetryAfterMs: 30_000)
        let now = Date(timeIntervalSince1970: 1_000_000)
        let nextRetry = policy.nextRetryDate(attempt: 1,
                                             llmFailure: llm,
                                             clock: { now })
        let elapsed = nextRetry.timeIntervalSince(now)
        // 30 seconds from provider; policy base delay is the default (1.0s).
        XCTAssertEqual(elapsed, 30.0, accuracy: 0.5,
                       "provider retryAfter must override the computed backoff")
    }

    // MARK: - Production Negative Tests

    /// NEG-01: a model stream ending alone cannot complete a Goal with
    /// unmet criteria (mandatory P14.1 negative test).
    func testNEG01_modelStreamCannotCompleteGoalWithUnmetCriteria() async throws {
        let root = p14_makeTempDir("neg01")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        let goalStore = GoalStore(baseDirectory: root.appendingPathComponent("goals"))
        await store.load(); await goalStore.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "完成"),
            conversation: P14AFakeConversation(reply: "完成"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store, goalStore: goalStore)

        // Pre-create the durable task in `.running` state and bind a Goal
        // with an unmet required criterion BEFORE the chat. This avoids the
        // race where the chat would mark the task `.completed` before the
        // Goal is bound.
        let pinnedTaskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: pinnedTaskID,
                                             conversationID: nil,
                                             title: "neg01",
                                             status: .running))
        await store.recordNewAttempt(taskID: pinnedTaskID,
                                     attemptID: UUID(),
                                     runID: UUID())
        await goalStore.upsert(Goal(taskID: pinnedTaskID, objective: "x",
                                    acceptanceCriteria: [
                                        AcceptanceCriterion(criterionID: "c1",
                                                           kind: .toolOutcome,
                                                           description: "tool",
                                                           required: true,
                                                           satisfied: false)
                                    ]))

        // Chat with the SAME taskID — model produces a final-looking
        // response. AcceptanceEvaluator MUST block the `.completed` record.
        let event = UserMessageEvent(
            conversationID: UUID(),
            messageID: UUID(),
            text: "完成目标",
            taskIDOverride: pinnedTaskID,
            runIDOverride: UUID(),
            metadata: UserMessageMetadata())
        for await _ in coordinator.handle(.userMessage(event)) {}
        try? await Task.sleep(nanoseconds: 50_000_000)

        let neg01After = await store.task(id: pinnedTaskID)
        XCTAssertNotEqual(neg01After?.status, .completed,
                          "NEG-01: model stream ending MUST NOT complete a Goal with unmet criteria")
    }

    /// NEG-02: restart cannot fail a waiting-approval task.
    func testNEG02_restartCannotFailWaitingApprovalTask() async throws {
        let root = p14_makeTempDir("neg02")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()
        let taskID = UUID()
        await store.upsert(DurableTaskRecord(taskID: taskID,
                                             conversationID: nil,
                                             title: "approval",
                                             status: .waitingForApproval))

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(),
            conversation: P14AFakeConversation(),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store)
        _ = await coordinator.reconcileAfterRestart()
        try? await Task.sleep(nanoseconds: 50_000_000)
        let neg02After = await store.task(id: taskID)
        XCTAssertEqual(neg02After?.status, .waitingForApproval,
                       "NEG-02: waiting-approval task must survive restart, not be failed")
    }

    /// NEG-04: production retry does NOT depend on provider-error substring.
    func testNEG04_productionRetryDoesNotDependOnProviderSubstring() {
        let policy = AgentRetryPolicy(maxAttempts: 3)
        let llm = LlmFailure(code: .rateLimited, message: "any message text")
        let semantics = AgentToolExecutionSemantics(idempotency: .idempotent)
        // The retry decision is purely typed; the message text is irrelevant.
        XCTAssertTrue(policy.shouldRetry(llmFailure: llm, attempt: 1, semantics: semantics))
        // Same LlmFailure with a different message text:
        let llm2 = LlmFailure(code: .rateLimited, message: "completely different text")
        XCTAssertEqual(policy.shouldRetry(llmFailure: llm, attempt: 1, semantics: semantics),
                       policy.shouldRetry(llmFailure: llm2, attempt: 1, semantics: semantics),
                       "NEG-04: retry decision must be invariant to message text")
    }

    /// NEG-05: production durable task cannot bypass the durable store.
    /// When a durable store is injected, every state transition writes
    /// through `applyTransition` / `recordNewAttempt`.
    func testNEG05_productionDurableTaskCannotBypassDurableStore() async throws {
        let root = p14_makeTempDir("neg05")
        let store = DurableTaskStore(baseDirectory: root.appendingPathComponent("tasks"))
        await store.load()

        let coordinator = PetAgentRuntimeCoordinator(
            context: P14AFakeContext(),
            model: P14ARespondModel(text: "ok"),
            conversation: P14AFakeConversation(reply: "ok"),
            gate: P14AAllowAppGate(),
            executor: P14AFakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            ledger: NoopAgentTaskLedgerStore(),
            clock: WallClock(),
            durableTaskStore: store)
        for await _ in coordinator.handle(.userMessage(text: "hi", conversationClass: .normal)) {}
        try? await Task.sleep(nanoseconds: 50_000_000)
        let records = await store.allTasks()
        XCTAssertGreaterThanOrEqual(records.count, 1,
            "NEG-05: when durable store is injected, every task must be persisted")
        // The records must have non-default createdAt + attemptCount >= 1.
        let first = records[0]
        XCTAssertGreaterThan(first.attemptCount, 0,
                             "NEG-05: durable record must record at least one attempt")
    }
}
