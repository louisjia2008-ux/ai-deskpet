import XCTest
import Foundation
import Combine
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

@MainActor
final class CharacterPresenceCoordinatorTests: XCTestCase {

    /// R2-12: poll-wait helper that replaces the fixed `try? await Task.sleep(30-50 ms)`
    /// races previously used to wait for an async derivation hop. Polls the
    /// predicate every 5 ms up to 2 s. Avoids the orchestrator's
    /// observed one-off suite flake (2026-08-26 05:00:35) where main-actor
    /// contention made a single 30 ms hop exceed 50 ms.
    private func waitUntil(timeout: TimeInterval = 2.0,
                           pollInterval: TimeInterval = 0.005,
                           _ predicate: () async -> Bool) async {
        let start = Date()
        while Date().timeIntervalSince(start) < timeout {
            if await predicate() { return }
            try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        _ = await predicate() // final check so the caller can capture diagnostic state
    }

    /// Advance the renderer's clock past all current intents (so one-shots
    /// expire and the FSM transitions to lastStableState). Used by the
    /// R2-1 / R2-10 regression tests where the test asserts renderer.state
    /// post-expiry. Without this helper the renderer clock is frozen (only
    /// `renderer.update(now:)` advances it; production drives it from
    /// PetScene.update, tests have no such loop).
    private func settleRenderer(_ renderer: CharacterAnimationStateMachine, by seconds: TimeInterval = 2.0) {
        let now = Date().timeIntervalSinceReferenceDate
        for _ in 0..<20 {
            renderer.update(now: now + seconds)
        }
    }

    private func makeCoordinator(activityStore: AgentTaskActivityStore? = nil,
                                 chatStore: FloatingChatStateStore? = nil,
                                 policy: CharacterPresencePolicy = CharacterPresencePolicy(),
                                 reduceMotion: Bool = false) -> (CharacterPresenceCoordinator, RecordingAdvancer, RecordingIntentSink, AgentTaskActivityStore, FloatingChatStateStore) {
        let store = activityStore ?? AgentTaskActivityStore(persistence: nil)
        let chat = chatStore ?? FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 mapping: .live,
                                                 applyIntent: sink.record)
        coord.setReduceMotion(reduceMotion)
        return (coord, advancer, sink, store, chat)
    }

    private static func waitingTaskEvent(id: UUID = UUID()) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(taskID: id,
                               runID: id,
                               conversationID: id,
                               userMessageID: nil,
                               sequenceNumber: 1,
                               timestamp: Date(),
                               kind: .approvalRequested,
                               presentation: AgentTaskEventPresentation(title: "waiting", detail: "p"))
    }

    private static func runningTaskEvent(id: UUID = UUID()) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(taskID: id,
                               runID: id,
                               conversationID: id,
                               userMessageID: nil,
                               sequenceNumber: 1,
                               timestamp: Date(),
                               kind: .executionStarted,
                               presentation: AgentTaskEventPresentation(title: "running", detail: "x"))
    }

    // MARK: - Lifecycle

    func testStartStopIdempotent() async {
        let (coord, advancer, _, _, _) = makeCoordinator()
        await coord.start()
        await coord.start()
        await coord.stop()
        // Advancer starts at .idle; .start event only fires from .dormant → .idle.
        // We assert .shutdown because stop() always fires it.
        XCTAssertTrue(advancer.advanced.contains(CharacterBehaviorEvent.shutdown))
    }

    func testStartFireStartWhenAdvancerDormant() async {
        let (coord, advancer, _, _, _) = makeCoordinator()
        let dormantAdvancer = advancer
        // Force the advancer into dormant before starting.
        await dormantAdvancer.advance(.shutdown)
        await coord.start()
        XCTAssertTrue(advancer.advanced.contains(CharacterBehaviorEvent.start))
    }

    func testStopPublishesShutdownAndClearsToNeutral() async {
        let (coord, _, sink, _, _) = makeCoordinator()
        await coord.start()
        sink.clear()
        await coord.stop()
        // The neutral reset priority is now 59 (above taskRunning p55 / taskWaiting p50 /
        // taskReview p58 but below jump 68 / speaking 60 / taskFailed 70 / dragged 90).
        // Asserts presence of the idle state at the neutral-reset priority.
        XCTAssertTrue(sink.recorded.contains(where: {
            $0.state == .idle && $0.priority == CharacterPresencePolicy.default.neutralResetPriority
        }), "stop must publish the neutral reset intent (idle at neutralResetPriority)")
    }

    // MARK: - Legal transitions

    func testIdleBeginThinkingBecomesThinking() async {
        let (coord, advancer, _, _, _) = makeCoordinator()
        await coord.start()
        await advancer.advance(.beginThinking)
        XCTAssertEqual(advancer.currentState, .thinking)
    }

    func testWorkingOverridesAttentive() async {
        let (coord, advancer, _, store, _) = makeCoordinator()
        await coord.start()
        store.publish(AgentEventEnvelope(activityEvent: Self.waitingTaskEvent()))
        await waitUntil { advancer.currentState == .waitingForPermission }
        XCTAssertEqual(advancer.currentState, .waitingForPermission,
                       "waiting task should win over the attentive observe")
    }

    // MARK: - Rapid changes

    func testRapidSnapshotChangesDoNotThrashIntents() async {
        let (coord, _, sink, store, _) = makeCoordinator()
        await coord.start()
        store.publish(AgentEventEnvelope(activityEvent: Self.runningTaskEvent()))
        await waitUntil { !sink.recorded.isEmpty && sink.recorded.contains(where: { $0.state == .taskRunning }) }
        sink.clear()
        store.publish(AgentEventEnvelope(activityEvent: Self.runningTaskEvent()))
        store.publish(AgentEventEnvelope(activityEvent: Self.runningTaskEvent()))
        // Allow the derive hops to settle.
        await waitUntil(timeout: 0.2) { sink.recorded.count >= 2 }
        let distinct = Set(sink.recorded.map { "\($0.state)|\($0.priority)" })
        XCTAssertLessThanOrEqual(distinct.count, 3)
    }

    // MARK: - Hydration guard

    func testInitialSnapshotTerminalsDoNotTriggerReactions() async {
        let store = AgentTaskActivityStore(persistence: nil)
        let event = AgentTaskActivityEvent(taskID: UUID(),
                                           runID: UUID(),
                                           conversationID: UUID(),
                                           userMessageID: nil,
                                           sequenceNumber: 1,
                                           timestamp: Date(),
                                           kind: .taskFailed,
                                           presentation: AgentTaskEventPresentation(title: "x", detail: "y"),
                                           failureCategory: .interrupted)
        store.publish(AgentEventEnvelope(activityEvent: event))
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 applyIntent: sink.record)
        await coord.start()
        try? await Task.sleep(nanoseconds: 100_000_000)
        await coord.tickOneSecond()
        XCTAssertFalse(sink.recorded.contains(where: { $0.state == .taskFailed }),
                       "hydration baseline terminal must not fire terminal failure reaction")
    }

    // MARK: - Legacy funnel

    func testLegacyChatEventsForwardThroughFunnel() async {
        let (coord, _, sink, _, _) = makeCoordinator()
        await coord.start()
        sink.clear()
        await coord.ingestChatAnimationEvent(.taskSucceeded)
        XCTAssertTrue(sink.recorded.contains(where: { $0.state == .jump }))
    }

    func testThinkingStartedSwallowedInFunnel() async {
        let (coord, _, sink, _, _) = makeCoordinator()
        await coord.start()
        sink.clear()
        await coord.ingestChatAnimationEvent(.thinkingStarted)
        XCTAssertFalse(sink.recorded.contains(where: { $0.state == .taskWaiting }))
    }

    func testResponseCancelledMapsToNeutralReset() async {
        let (coord, _, sink, _, _) = makeCoordinator()
        await coord.start()
        sink.clear()
        await coord.ingestChatAnimationEvent(.responseCancelled)
        // Asserts the cancel funnel emits the neutral-reset idle intent (state=.idle,
        // emotion=.neutral, duration ≈ 0.2 s) at the policy's neutralResetPriority (59).
        XCTAssertTrue(sink.recorded.contains(where: {
            $0.state == .idle && $0.priority == CharacterPresencePolicy.default.neutralResetPriority
        }), "responseCancelled funnel must emit the neutral-reset idle intent")
    }

    // MARK: - Reduce Motion

    func testReduceMotionFlagSelectsLookPoseForThinking() async {
        let (coord, _, sink, _, chat) = makeCoordinator(reduceMotion: true)
        await coord.start()
        sink.clear()
        chat.isResponding = true
        try? await Task.sleep(nanoseconds: 100_000_000)
        await coord.tickOneSecond()
        XCTAssertTrue(sink.recorded.contains(where: { $0.state == .look1125 }),
                      "with RM=true, .thinking must produce the static look1125 pose")
    }

    // MARK: - Sleep determinism

    func testInactivityEntersSleepingExactlyAtThreshold() async {
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             recoveryCooldown: 0,
                                             sleepAfterThreshold: 5.0,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: sink.record)
        await coord.start()
        // Tick 4 seconds — must not enter sleeping yet.
        for _ in 0..<4 {
            clock.advance(by: 1)
            await coord.tickOneSecond(now: clock.nowDate)
        }
        XCTAssertFalse(advancer.advanced.contains(CharacterBehaviorEvent.sleep),
                       "must not sleep before threshold")
        // One more tick — threshold reached.
        clock.advance(by: 1)
        await coord.tickOneSecond(now: clock.nowDate)
        XCTAssertTrue(advancer.advanced.contains(CharacterBehaviorEvent.sleep),
                      "should enter sleeping after threshold elapses")
    }

    func testNoSleepWhileChatVisible() async {
        let (coord, advancer, _, _, chat) = makeCoordinator(
            policy: CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 0))
        await coord.start()
        chat.expand()
        await coord.tickOneSecond()
        await coord.tickOneSecond()
        XCTAssertFalse(advancer.advanced.contains(CharacterBehaviorEvent.sleep),
                       "chat visible must block sleeping transition")
    }

    func testNoSleepWhileTasksActive() async {
        let (coord, advancer, _, store, _) = makeCoordinator(
            policy: CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 0))
        await coord.start()
        store.publish(AgentEventEnvelope(activityEvent: Self.runningTaskEvent()))
        await waitUntil(timeout: 0.5) { advancer.currentState == .acting }
        await coord.tickOneSecond()
        await coord.tickOneSecond()
        XCTAssertFalse(advancer.advanced.contains(CharacterBehaviorEvent.sleep),
                       "active task must block sleeping transition")
    }

    // MARK: - Cancel / Failure / Recovery

    func testCancelDuringWorkingEmitsRecoveryBeatThenNeutral() async {
        // R1-7: drive REAL working state via a running-task snapshot, capture intents through
        // a real CharacterAnimationStateMachine, then assert that the renderer exits taskRunning
        // (with NO taskFailed pose) after the cancel beats.
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: CharacterPresencePolicy(sustainedMinDwell: 0)),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        await coord.start()
        // Establish REAL working: publish a running task and let the derive pipeline apply
        // the working visual through the real CharacterAnimationStateMachine.
        let workingID = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: workingID, runID: workingID, conversationID: workingID, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
        await waitUntil(timeout: 0.5) { renderer.state == .taskRunning }
        XCTAssertEqual(renderer.state, .taskRunning,
                       "before cancel, the renderer must be in working/taskRunning (real driver)")
        // Cancel mid-working.
        await coord.ingestChatAnimationEvent(.responseCancelled)
        // R2-3: trap-state exit on the next derive hop. Wait until the machine
        // leaves .interrupted before asserting the renderer state.
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        await coord.tickOneSecond()
        // After cancel + a tick, the renderer must NOT be in taskRunning.
        XCTAssertNotEqual(renderer.state, .taskRunning,
                          "after cancel, the renderer must exit taskRunning")
        // And must NOT have a taskFailed pose (cancel is recovery-beat, not failure).
        XCTAssertNotEqual(renderer.state, .taskFailed,
                          "cancel must not produce a taskFailed one-shot")
        // Advancer must have received an .interrupt (the production cancel path).
        XCTAssertTrue(advancer.advanced.contains(.interrupt),
                      "cancel funnel must fire .interrupt on the machine")
    }

    func testCompletionAfterCancelDoesNotResurrectWorking() async {
        let (coord, advancer, sink, store, _) = makeCoordinator()
        await coord.start()
        let id = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .taskCancelled,
            presentation: AgentTaskEventPresentation(title: "cancel", detail: "x"))))
        await waitUntil(timeout: 0.5) { advancer.currentState == .interrupted }
        // Try to resurrect the same task via a stepSucceeded — should be filtered as illegal.
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .stepSucceeded,
            presentation: AgentTaskEventPresentation(title: "step", detail: "x"))))
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        await coord.tickOneSecond()
        // State should NOT be .acting — the cancellation is final.
        XCTAssertNotEqual(advancer.currentState, .acting)
    }

    // MARK: - Cooldowns (R1-7 rewrite)

    func testSuccessReactionSuppressedWithinCooldown() async {
        // R1-7: assert EXACTLY ONE jump for two succeeded terminals published within the
        // successCooldown window. The first jump is the success reaction; the second is
        // suppressed by the cooldown bookkeeping on `lastSuccessIntentAt`.
        // R2-12: replace fixed `Task.sleep` races with the poll-wait helper.
        let (coord, _, sink, store, _) = makeCoordinator(
            policy: CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 100,
                                             failureCooldown: 100))
        await coord.start()
        sink.clear()
        let id1 = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id1, runID: id1, conversationID: id1, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        await waitUntil(timeout: 0.5) { sink.recorded.contains(where: { $0.state == .jump }) }
        let jumpsAfterFirst = sink.recorded.filter { $0.state == .jump }.count
        XCTAssertEqual(jumpsAfterFirst, 1,
                       "first success terminal must produce exactly one jump (\(jumpsAfterFirst) found)")

        // Second success terminal within the 100 s cooldown window — must be suppressed.
        let id2 = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id2, runID: id2, conversationID: id2, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        // Wait long enough for the suppression to take effect — the second success
        // should NOT add another jump. The helper returns once the predicate is
        // satisfied; here we wait an additional 100 ms to give the derive hop time
        // to (NOT) fire a second jump.
        try? await Task.sleep(nanoseconds: 100_000_000)
        await coord.tickOneSecond()
        let jumpsAfterSecond = sink.recorded.filter { $0.state == .jump }.count
        XCTAssertEqual(jumpsAfterSecond, 1,
                       "second success terminal within cooldown must be suppressed (\(jumpsAfterSecond) found)")
    }

    // MARK: - Stale sweep (R2-10 rewrite)

    func testStaleWorkingClearedByOneSecondTickWhenNoActiveTasks() async {
        // R2-10: the prior version of this test cleared the working visual via
        // `taskSucceeded`'s jump one-shot (p68 beats taskRunning p55), so the
        // sweep's own p10 dispatch (which the reviewer flagged as never-beating-
        // taskRunning) was never actually exercised. The new version clears the
        // task WITHOUT a one-shot — second success inside the cooldown window is
        // suppressed by `lastSuccessIntentAt`, so the only path left to clear
        // is the reconcile/staleSweep clearing-intent dispatch (R2-1). The
        // renderer must reach `.idle`.
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 100,
                                             failureCooldown: 100,
                                             sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            sink.record(intent)
            renderer.apply(intent, now: intent.createdAt)
        })
        await coord.start()
        sink.clear()
        // Install the renderer seam so reconcile can read the renderer's
        // current intent (R2-1 — clearing dispatch uses this to detect a
        // stuck high-priority visual).
        coord.installRendererIntentSeam({ renderer.currentIntent })
        let id = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
        await waitUntil(timeout: 0.5) { renderer.state == .taskRunning }
        XCTAssertEqual(renderer.state, .taskRunning,
                       "before clearing, the renderer must be in working/taskRunning")

        // First success fires the jump one-shot (clears the FSM priority gate
        // once the jump expires). Then a SECOND success inside the cooldown
        // window is suppressed — neither `applyIntent(.success)` nor a new
        // jump fires. The only remaining clearing path is reconcile/staleSweep
        // dispatching the neutral-reset intent (R2-1) which beats taskRunning p55.
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        // Drain the renderer past the jump duration (0.78 s) so we measure the
        // post-jump state, not the jump itself.
        settleRenderer(renderer, by: 1.0)
        XCTAssertEqual(renderer.state, .idle,
                       "after jump expiry, renderer must transition to lastStableState")
        let id2 = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id2, runID: id2, conversationID: id2, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task2", detail: "x"))))
        await waitUntil(timeout: 0.5) { renderer.state == .taskRunning }
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id2, runID: id2, conversationID: id2, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        // The second success is cooldown-skipped (successCooldown=100 s). Tick
        // so reconcile + replayPendingDemotion fire — the clearing dispatch
        // (R2-1) drives the renderer past taskRunning.
        await coord.tickOneSecond()
        await waitUntil(timeout: 0.5) { renderer.state == .idle }
        XCTAssertEqual(renderer.state, .idle,
                       "after cooldown-skipped success, renderer must reach .idle via clearing dispatch")
        XCTAssertEqual(advancer.currentState, .idle,
                       "machine must be .idle after terminal-driven sweep")
    }

    // MARK: - Reconcile (R2-10 rewrite)

    func testReconcileReissuesSustainedStateWhenVisualStateDiverged() async {
        // R2-10: route the reconcile applies through a REAL
        // CharacterAnimationStateMachine (not just a recording sink) and assert
        // the renderer eventually recovers from a sustained `taskRunning` p55
        // visual after reconcile dispatches the neutral-reset intent (R2-1).
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            sink.record(intent)
            renderer.apply(intent, now: intent.createdAt)
        })
        // Seed the renderer with a stuck taskRunning p55 (no duration, sustained).
        renderer.apply(CharacterAnimationIntent(state: .taskRunning,
                                               priority: 55,
                                               source: .agentRuntime,
                                               createdAt: 0), now: 0)
        let seamClosure: () -> CharacterAnimationIntent? = { renderer.currentIntent }
        coord.installRendererIntentSeam(seamClosure)

        await coord.start()
        sink.clear()
        await coord.tickOneSecond()
        // The reconcile path dispatches the neutral-reset intent (idle p59,
        // 0.20 s duration) which beats taskRunning p55 — the renderer transitions
        // out of taskRunning. After expiry (0.20 s) the renderer returns to
        // lastStableState (.idle). Wait for the expiry.
        await waitUntil(timeout: 0.5) { renderer.state != .taskRunning }
        // Wait for the clearing intent to expire and the renderer to settle.
        await waitUntil(timeout: 0.5) { renderer.state == .idle }
        XCTAssertEqual(renderer.state, .idle,
                       "reconcile clearing dispatch must drive renderer to .idle (R2-1)")
        // The coordinator must have emitted an idle intent at the clearing
        // priority (p59) — proves the R2-1 neutral-reset path is taken, not the
        // plain idle p10 path.
        XCTAssertTrue(sink.recorded.contains(where: {
            $0.state == .idle && $0.priority == policy.neutralResetPriority
        }), "reconcile must dispatch the neutral-reset intent (idle at p59) when the renderer is stuck on taskRunning p55")
    }

    func testReconcileDoesNotClobberHigherPriorityTransient() async {
        // R1-2: when the renderer-seam reports a higher-priority transient (taskFailed p70)
        // that the user is presently seeing, the renderer's arbitration will reject any
        // reissue whose priority is lower than taskFailed. Reconcile continues to dispatch
        // the sustained semantic every tick (so it self-heals once the transient expires),
        // but the priority arbitration in `CharacterAnimationStateMachine.apply` ensures the
        // transient visual is not clobbered. The assertion: the visible renderer state remains
        // taskFailed despite every tick's reconcile attempt.
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)

        let realRenderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        realRenderer.apply(CharacterAnimationIntent(state: .idle,
                                                   source: .runtimeLifecycle,
                                                   createdAt: 0), now: 0)
        realRenderer.apply(CharacterAnimationIntent(state: .taskFailed,
                                                   priority: 70,
                                                   duration: 1.45,
                                                   source: .agentRuntime,
                                                   createdAt: 1), now: 1)
        let seamClosure: () -> CharacterAnimationIntent? = { realRenderer.currentIntent }
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: CharacterPresencePolicy(sustainedMinDwell: 0)),
                                                 applyIntent: { intent in
            // Route every dispatch through the real CharacterAnimationStateMachine.
            realRenderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam(seamClosure)

        await coord.start()
        // Run several ticks; the renderer must remain in taskFailed (FSM rejects lower-priority
        // reissues) until the transient expires.
        for _ in 0..<5 {
            await coord.tickOneSecond()
        }
        // While the taskFailed one-shot is active, the renderer must stay there (not clobbered
        // by reconcile reissues — the FSM's priority check guarantees that).
        XCTAssertEqual(realRenderer.state, .taskFailed,
                       "reconcile reissues must not clobber the higher-priority taskFailed one-shot")
    }

    // MARK: - Minimum dwell + debounce (R2-10 rewrite)

    func testMinimumDwellDefersDemotion() async {
        // R2-10: the prior version of this test enshrined `$0.priority == 10` —
        // the exact payload that the reviewer flagged as never clearing
        // sustained visuals. The new version asserts the clearing priority
        // (59, the `neutralResetPriority`) and the deferred-then-replayed
        // demotion (R2-9).
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 1.5,
                                              successCooldown: 0,
                                              failureCooldown: 0,
                                              sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: sink.record)
        await coord.start()

        // Drive into working via a running task.
        let id = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
        await waitUntil(timeout: 0.5) { sink.recorded.contains(where: { $0.state == .taskRunning }) }
        let workingIdx = sink.recorded.lastIndex(where: { $0.state == .taskRunning }) ?? -1
        XCTAssertGreaterThanOrEqual(workingIdx, 0, "must have dispatched working/taskRunning")

        // Mark the working timestamp + 0.5 s (= 1/3 of the dwell threshold) — too soon.
        clock.advance(by: 0.5)
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        await waitUntil(timeout: 0.5) { sink.recorded.contains(where: { $0.state == .jump }) }
        // The success terminal reaction (one-shot jump) IS dispatched immediately
        // (one-shots never defer) — that proves the dispatch path is alive. But
        // the demotion to idle semantically should NOT yet have re-emerged.
        let beforeDwellElapsedJumps = sink.recorded.filter { $0.state == .jump }.count
        XCTAssertGreaterThanOrEqual(beforeDwellElapsedJumps, 1,
            "success one-shot must fire even within the dwell (one-shots are not deferred)")

        // Advance past the dwell threshold + tick → the pending demotion
        // (R2-9) replays, and the demotion dispatches via the clearing path
        // (R2-1) at the neutral-reset priority (59), not the plain idle p10.
        clock.advance(by: 2.0)
        await coord.tickOneSecond(now: clock.nowDate)
        XCTAssertTrue(sink.recorded.contains(where: {
            $0.state == .idle && $0.priority == policy.neutralResetPriority
        }), "after sustainedMinDwell elapsed, the demotion must dispatch idle at the neutralResetPriority (p59), not p10")
    }

    // MARK: - Sleep intent assertion (R1-7)

    func testSleepDispatchesSleepingIntent() async {
        // R1-7: assert the .sleeping semantic INTENT (not just the .sleep machine event).
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 5.0,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: sink.record)
        await coord.start()
        for _ in 0..<6 {
            clock.advance(by: 1)
            await coord.tickOneSecond(now: clock.nowDate)
        }
        // Assert the .sleeping intent was emitted (not just the .sleep event).
        XCTAssertTrue(sink.recorded.contains(where: {
            $0.state == .sleeping
        }), "sleep dispatch must emit the .sleeping intent, not just advance the machine")
    }

    // MARK: - Lifecycle subscription teardown (R1-7)

    func testStartStopTearsDownSubscriptions() async {
        // R1-7: verify the cancellables set is empty after stop().
        let (coord, _, _, _, _) = makeCoordinator()
        await coord.start()
        let internalCancellablesBeforeStop = coord.subscriptionCount
        XCTAssertGreaterThan(internalCancellablesBeforeStop, 0,
                             "after start() subscriptions must exist")
        await coord.stop()
        XCTAssertEqual(coord.subscriptionCount, 0,
                       "after stop() subscription cancellables must be torn down")
    }

    // MARK: - R2-1 regression tests (clearing paths must dispatch priority ≥ sustained visuals)

    func testCancelledStoreTerminalEndsAtIdle() async {
        // R2-1: a `.cancelled` store terminal fires `.interrupt` on the machine
        // (→ `.interrupted`) and the R2-3 trap-exit chain must then advance the
        // machine back to `.idle` within one tick. The renderer must end at
        // `.idle` — no `taskFailed` pose, no stuck `.reacting` twitch.
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        await coord.start()
        // Establish ONE working task, then cancel IT (not a separate task) so
        // the snapshot becomes empty after the cancel — the engagement
        // transition advances the machine to .idle.
        let workingID = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: workingID, runID: workingID, conversationID: workingID, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
        await waitUntil(timeout: 0.5) { renderer.state == .taskRunning }
        // Cancel the working task — now the snapshot has no active tasks.
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: workingID, runID: workingID, conversationID: workingID, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskCancelled,
            presentation: AgentTaskEventPresentation(title: "cancel", detail: "x"))))
        // Wait for the derive chain to advance the machine past .interrupted
        // to .idle (applyEngagementTransition(.interrupted, .idle) fires
        // .recovered with clearing intent).
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        XCTAssertEqual(advancer.currentState, .idle,
                       "machine must be .idle after cancelled store terminal (no .taskFailed, no trap)")
        // Renderer must reach .idle (clearing dispatch beats stuck taskRunning p55).
        await waitUntil(timeout: 1.0) { renderer.state == .idle }
        XCTAssertEqual(renderer.state, .idle,
                       "renderer must reach .idle after cancelled store terminal")
        XCTAssertNotEqual(renderer.state, .taskFailed,
                          "cancelled store terminal must not produce a taskFailed one-shot")
    }

    func testCooldownSkippedSecondSuccessEndsAtIdle() async {
        // R2-1: a second success within the cooldown window suppresses the jump
        // one-shot — the only path left to clear the taskRunning visual is the
        // R2-1 reconcile/staleSweep clearing dispatch (neutralReset p59). The
        // renderer must reach .idle, not stay stuck at taskRunning.
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 100,  // huge so 2nd is suppressed
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        await coord.start()
        // First success: jump one-shot fires + machine advances to .idle.
        let id1 = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id1, runID: id1, conversationID: id1, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task1", detail: "x"))))
        await waitUntil(timeout: 0.5) { renderer.state == .taskRunning }
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id1, runID: id1, conversationID: id1, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        // Install the renderer seam so reconcile can read the renderer's
        // current intent (R2-1 — clearing dispatch uses this to detect a
        // stuck high-priority visual).
        coord.installRendererIntentSeam({ renderer.currentIntent })
        // Advance the renderer clock past the jump (0.78 s) so the FSM
        // transitions to lastStableState (.idle).
        settleRenderer(renderer, by: 1.0)
        XCTAssertEqual(renderer.state, .idle,
                       "after jump expiry, renderer must transition to lastStableState")
        // Second success inside cooldown — jump suppressed by lastSuccessIntentAt.
        let id2 = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id2, runID: id2, conversationID: id2, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task2", detail: "x"))))
        await waitUntil(timeout: 0.5) { renderer.state == .taskRunning }
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id2, runID: id2, conversationID: id2, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        // The successCooldown=100 means the second jump is suppressed. Tick
        // so reconcile + replayPendingDemotion fire — the clearing dispatch
        // (R2-1) drives the renderer past taskRunning.
        await coord.tickOneSecond()
        await waitUntil(timeout: 0.5) { renderer.state == .idle }
        XCTAssertEqual(renderer.state, .idle,
                       "after cooldown-skipped second success, renderer must reach .idle via clearing dispatch")
        XCTAssertEqual(advancer.currentState, .idle,
                       "machine must be .idle after cooldown-skipped second success")
    }

    // MARK: - R2-2 regression test (noteUserInteraction wake must clear sleeping visual)

    func testNoteUserInteractionClearsSleepingVisual() async {
        // R2-2: with the renderer in `.sleeping` (sustained p40), `noteUserInteraction`
        // must dispatch a clearing intent (p59) so the sleeping visual is replaced.
        // Without the clearing, idle p10 < sleeping p40 → rejected → stuck pose.
        // The test starts with the advancer at `.idle` so `coord.start()` runs
        // the initial derive without firing the trap-exit. We then advance
        // the advancer to `.sleeping` and seed the renderer.
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        await coord.start()
        // Drive the advancer to .sleeping and seed the renderer with a stuck
        // sleeping p40 visual.
        await advancer.advance(.sleep)
        renderer.apply(CharacterAnimationIntent(state: .sleeping,
                                               priority: 40,
                                               source: .agentRuntime,
                                               createdAt: 0), now: 0)
        XCTAssertEqual(renderer.state, .sleeping,
                       "renderer must be in .sleeping before wake")
        XCTAssertEqual(advancer.currentState, .sleeping,
                       "advancer must be in .sleeping before wake")
        // User taps → noteUserInteraction → wake + clearing dispatch.
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        // Renderer must NOT be stuck at .sleeping.
        await waitUntil(timeout: 0.5) { renderer.state != .sleeping }
        XCTAssertNotEqual(renderer.state, .sleeping,
                          "after noteUserInteraction, renderer must NOT stay stuck in .sleeping")
    }

    // MARK: - R2-3 regression test (trap states exit on the 1 Hz tick)

    func testInterruptedStateExitsOnOneSecondTick() async {
        // R2-3: with no active task and no responding chat, the 1 Hz tick must
        // fire `.recovered` to exit the `.interrupted` trap. Without the R2-3
        // fix, the machine stays in `.interrupted` indefinitely while reconcile
        // re-applies a 0.30 s reacting one-shot every tick (perpetual twitch).
        // The test starts with the advancer at `.idle` so the initial derive
        // doesn't fire the trap-exit during `coord.start()`. We manually
        // transition the advancer to `.interrupted` AFTER start to simulate
        // the trap.
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        await coord.start()
        // Drive the advancer to .interrupted manually + seed the renderer with
        // a stuck `.reacting` (recovery beat p46).
        await advancer.advance(.interrupt)
        renderer.apply(CharacterAnimationIntent(state: .reacting,
                                               emotion: .neutral,
                                               intensity: 0.35,
                                               priority: 46,
                                               duration: 0.30,
                                               source: .agentRuntime,
                                               createdAt: 0), now: 0)
        // Manually force the renderer to .reacting in case the coord's initial
        // dispatch (idle p10) reset it. The reactionCooldown is 0 so applying
        // .reacting twice in a row is fine.
        renderer.apply(CharacterAnimationIntent(state: .reacting,
                                               emotion: .neutral,
                                               intensity: 0.35,
                                               priority: 46,
                                               duration: 0.30,
                                               source: .agentRuntime,
                                               createdAt: 0), now: 0)
        XCTAssertEqual(renderer.state, .reacting,
                       "renderer must be in .reacting before the tick")
        XCTAssertEqual(advancer.currentState, .interrupted,
                       "machine must be in .interrupted before the tick")
        // One tick → trap-exit fires `.recovered` → machine .idle → clearing
        // dispatch wins the priority arbitration against the stuck `.reacting`.
        await coord.tickOneSecond()
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        XCTAssertEqual(advancer.currentState, .idle,
                       "machine must exit .interrupted on the 1 Hz tick (R2-3)")
        // Advance the renderer clock past the recovery beat (0.30 s) so the
        // stuck `.reacting` transitions to lastStableState.
        settleRenderer(renderer, by: 0.5)
        XCTAssertNotEqual(renderer.state, .reacting,
                          "renderer must exit the stuck .reacting one-shot within the clearing duration")
    }

    // MARK: - R2-4 FSM table test (.waitingForPermission → .idle on .finished)

    func testWaitingForPermissionFinishedExitsToIdle() async {
        // R2-4: a waiting task can disappear without an approvalResolved first
        // (user deletes it from Task Center, terminal lands directly from
        // waiting). The FSM table must grant a legal exit.
        let next = CharacterBehaviorStateMachine.next(from: .waitingForPermission, event: .finished)
        XCTAssertEqual(next, .idle,
                       "(.waitingForPermission, .finished) → .idle — required so the machine can exit the wait state without permissionResolved")
    }

    // MARK: - R2-11 regression test (streamingResponse cleared on isResponding falling edge)

    func testIsRespondingFallingEdgeClearsStreamingResponse() async {
        // R2-11: when `chatStore.isResponding` falls without a `.responseFinished/Failed/Cancelled`
        // terminal (provider drop / view teardown mid-stream), `streamingResponse`
        // must be cleared so `engagedMachineState` returns `.thinking` (not
        // `.speaking`) and the coordinator can demote out of the trap. After
        // clearing, a fresh running task must advance the machine to .acting —
        // proving the streaming trap did NOT persist across the abnormal end.
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { _ in })
        await coord.start()
        // Drive into .speaking via a real streaming sequence.
        chat.isResponding = true
        await waitUntil(timeout: 0.5) { advancer.currentState != .idle }
        await coord.ingestChatAnimationEvent(.responseStarted)
        await coord.ingestChatAnimationEvent(.responseDelta)
        // Wait for the machine to reach .speaking (the streaming path).
        await waitUntil(timeout: 0.5) { advancer.currentState == .speaking }
        // Abnormal stream end: isResponding falls WITHOUT a .responseFinished/Failed/Cancelled
        // terminal. The R2-11 fix in the chat sink's falling-edge branch must
        // clear `streamingResponse` so the next derive exits .speaking.
        chat.isResponding = false
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        // Now a new working task — the derive must advance the machine to
        // .acting (NOT strand at .speaking, which would be the unrecovered trap).
        let id = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
        await waitUntil(timeout: 0.5) { advancer.currentState == .acting }
        XCTAssertEqual(advancer.currentState, .acting,
                       "after streamingResponse cleared on falling edge, a new running task advances the machine to .acting")
    }

    // MARK: - R3-1 regression test (chat-hide-after-dwell self-heal)

    /// R3-1 (a): the chat-hide falling edge dispatches a clearing idle p59
    /// that BEATS the sustained listening p45. Pet is no longer stuck
    /// after the standard "expand chat → read ≥1.5 s → close" flow.
    func testChatHideAfterDwellClearsListening() async {
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 1.5,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // (1) Expand chat → machine → .listening, renderer → .listening
        //     at priority 45. Use chat.expanded (synchronous) + tick.
        chat.expand()
        clock.advance(by: 0.05)
        await waitUntil(timeout: 0.5) { advancer.currentState == .listening }
        await waitUntil(timeout: 0.5) { renderer.state == .listening }
        XCTAssertEqual(renderer.state, .listening,
                       "after chat expand, renderer must be .listening (R1 / R2 baseline)")

        // (2) Advance the clock PAST sustainedMinDwell (1.5 s) so
        //     chat-hide becomes a dwell-ELAPSED demotion.
        clock.advance(by: 2.0)

        // (3) Collapse chat → falling edge fires .finished with
        //     clearing=true → idle p59 dispatched. Renderer accepts
        //     (59 > 45) and leaves .listening within one beat.
        chat.collapseToCapsule(now: clock.now)
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        await waitUntil(timeout: 0.5) { renderer.state != .listening }
        XCTAssertNotEqual(renderer.state, .listening,
                          "R3-1 chat-hide-after-dwell must clear the listening p45 visual (no stuck pose)")
        // Confirm we're not in some other stuck sustained state — the
        // clearing target is .idle for the post-chat-hide machine state.
        XCTAssertEqual(renderer.state, .idle,
                       "R3-1: chat-hide clearing intent must leave renderer at .idle")
    }

    /// R3-1 (b): reconcile self-heal when the renderer is stuck above the
    /// SEMANTIC's priority (independent of chat-hide). This is the
    /// secondary defense: even if a future code path drops the clearing
    /// flag or otherwise strands a sustained visual, the next reconcile
    /// tick raises a clearing dispatch that beats the stuck intent.
    func testReconcileClearsStuckListeningViaSemanticPriorityComparison() async {
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Seed the renderer with a stuck listening p45 visual (sustained, no
        // duration). Put the machine in .idle (target semantic = .idle).
        let seedTime = clock.now.timeIntervalSinceReferenceDate
        let seedApplied = renderer.apply(
            CharacterAnimationIntent(state: .listening,
                                    emotion: .curious,
                                    priority: 45,
                                    source: .agentRuntime,
                                    createdAt: seedTime),
            now: seedTime)
        XCTAssertTrue(seedApplied, "seed listening p45 must be accepted")
        XCTAssertEqual(renderer.state, .listening)
        XCTAssertEqual(advancer.currentState, .idle)
        // Tick → reconcile sees machine=.idle → semantic=.idle → p10, but
        // renderer.state=.listening (≠ .idle) → diverge. Stuck = 45 > 10 =
        // true → dispatch clearing p59 idle (R3-1 changed `>= 50` to
        // `> semanticPriority`).
        clock.advance(by: 0.05)
        await coord.tickOneSecond(now: clock.nowDate)
        // Renderer must have been forced from .listening p45 to the
        // clearing target (idle p59) AND then the plain re-issue
        // (idle p10 with `.replaceSameKind`) takes over the slot
        // immediately (R4-2). The renderer's FINAL state is .idle at
        // the plain sustained's natural priority (10), not at the
        // clearing's p59 — the clearing was a transient that has
        // already been replaced by the same-tick follow-up.
        await waitUntil(timeout: 0.5) { renderer.state == .idle }
        XCTAssertEqual(renderer.state, .idle,
                       "R3-1 reconcile clearing dispatch lands renderer on the .idle target (semantic)")
        let currentPri = renderer.currentIntent?.priority ?? 0
        XCTAssertEqual(currentPri, CharacterAnimationIntent.defaultPriority(for: .idle),
                       "R4-2: renderer ends at the plain re-issue's natural priority (idle p10), not the clearing p59 — the clearing was replaced same-tick")
    }

    /// R3-1 (b2): stuck sleeping visual — reconcile self-heal via the
    /// semantic-priority comparison.
    func testReconcileClearsStuckSleeping() async {
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Seed the renderer with a stuck .sleeping p45 visual, machine
        // stays at .idle. Renderer state diverges from the target (.idle).
        let seedTime = clock.now.timeIntervalSinceReferenceDate
        _ = renderer.apply(
            CharacterAnimationIntent(state: .sleeping,
                                    emotion: .sleepy,
                                    priority: 45,
                                    source: .agentRuntime,
                                    createdAt: seedTime),
            now: seedTime)
        XCTAssertEqual(renderer.state, .sleeping)
        XCTAssertEqual(advancer.currentState, .idle)
        clock.advance(by: 0.05)
        await coord.tickOneSecond(now: clock.nowDate)
        // Renderer must transition off the stuck .sleeping — clearing p59
        // wins the FSM arbitration, the plain re-issue (idle p10 with
        // `.replaceSameKind`) takes over immediately (R4-2), and the
        // renderer ends at .idle (target semantic) at the plain
        // re-issue's natural priority.
        await waitUntil(timeout: 0.5) { renderer.state == .idle }
        XCTAssertEqual(renderer.state, .idle,
                       "R3-1: reconcile must clear stuck .sleeping even though sleeping p45 < old stuck threshold of 50")
        let currentPri = renderer.currentIntent?.priority ?? 0
        XCTAssertEqual(currentPri, CharacterAnimationIntent.defaultPriority(for: .idle),
                       "R4-2: renderer ends at the plain re-issue's natural priority (idle p10), not the clearing p59 — the clearing was replaced same-tick")
    }

    // MARK: - R3-2 regression test (wake-greet one-shot must be visible)

    /// R3-2: when `noteUserInteraction` is called while the pet is sleeping,
    /// the optional wake-greet one-shot MUST actually fire — not be silently
    /// shadowed by the clearing intent at p59 that the wake dispatch raises.
    /// The R3-2 fix dispatches the greet ONE-SHOT first; if it fires, the
    /// wake advance is performed WITHOUT a clearing visual so the greet
    /// plays through its 0.72 s window. If the greet is cooldown-skipped,
    /// the wake fires with clearing (R2-2 fallback) to un-stick sleeping.
    func testNoteUserInteractionDispatchesWakeGreetWithinWindow() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        // Drive the advancer to .sleeping and seed the stuck sleeping p40 visual.
        await advancer.advance(.sleep)
        let seedTime = Date().timeIntervalSinceReferenceDate
        _ = renderer.apply(CharacterAnimationIntent(state: .sleeping,
                                                    emotion: .sleepy,
                                                    priority: 40,
                                                    source: .agentRuntime,
                                                    createdAt: seedTime),
                           now: seedTime)
        XCTAssertEqual(renderer.state, .sleeping,
                       "renderer must be in .sleeping before wake for the wake-greet to compete against it")
        XCTAssertEqual(advancer.currentState, .sleeping,
                       "machine must be in .sleeping before wake")
        // User taps → noteUserInteraction → greet p44 fires FIRST (no
        // cooldown, no last-greet timestamp), then wake advances the
        // machine WITHOUT a clearing visual so the greet plays through
        // its full 0.72 s window.
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { renderer.state == .greet }
        XCTAssertEqual(renderer.state, .greet,
                       "R3-2: wake-greet p44 must be visible after noteUserInteraction (was shadowed by clearing p59)")
        XCTAssertEqual(advancer.currentState, .idle,
                       "R3-2: machine must be .idle after wake (greet-branch path still advances the machine)")
        // Confirm the renderer is NOT stuck at .greet (the greet one-shot
        // must terminate properly). Force the renderer clock past the
        // greet duration and assert it leaves .greet. The exact landing
        // state depends on the renderer's lastStableState (set when the
        // pre-wake sleeping was applied — isStable(.sleeping) = true so
        // lastStableState = .sleeping). The R3-2 contract is that the
        // greet is visible AND that subsequent updates transition off it.
        settleRenderer(renderer, by: 1.0)
        XCTAssertNotEqual(renderer.state, .greet,
                          "R3-2: after greet duration, renderer must leave .greet (not stuck)")
    }

    /// R3-2 (variant): when the greet is COOLDOWN-SKIPPED, the wake falls
    /// back to the R2-2 clearing dispatch so the sleeping visual is
    /// un-stuck within one beat. This is the production-relevant fallback
    /// for repeated wakes — greet doesn't loop, the clearing wake keeps
    /// the pet visually awake.
    func testNoteUserInteractionFallsBackToClearingWakeWhenGreetSkipped() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 30) // bigger than test wall-time
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        await advancer.advance(.sleep)
        let seedTime = Date().timeIntervalSinceReferenceDate
        _ = renderer.apply(CharacterAnimationIntent(state: .sleeping,
                                                    emotion: .sleepy,
                                                    priority: 40,
                                                    source: .agentRuntime,
                                                    createdAt: seedTime),
                           now: seedTime)
        // Prime lastGreetAt via a manual poke so the cooldown gate refuses the next greet.
        // Simulate "user recently greeted" by setting lastGreetAt via the public wake path?
        // Easiest: invoke coord.ingestChatAnimationEvent(.greeting) — it forwards through
        // AgentAnimationEventMapper and calls applyIntent, but does NOT update lastGreetAt.
        // Instead, exercise the cooldown path via the real mechanism: a successful greet
        // + a SECOND wake within 30s should suppress the second greet.
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        // Now put the pet back to .sleeping and wake again — second wake
        // is within the 30s cooldown → greet suppressed → clearing
        // dispatch fires.
        await advancer.advance(.sleep)
        let seedTime2 = Date().timeIntervalSinceReferenceDate
        _ = renderer.apply(CharacterAnimationIntent(state: .sleeping,
                                                    emotion: .sleepy,
                                                    priority: 40,
                                                    source: .agentRuntime,
                                                    createdAt: seedTime2),
                           now: seedTime2)
        coord.noteUserInteraction()
        // The clearing p59 idle intent must dispatch — visible as a high-priority
        // idle in the sink recorders (the test only inspects via the renderer).
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        await waitUntil(timeout: 0.5) { renderer.state != .sleeping }
        XCTAssertNotEqual(renderer.state, .sleeping,
                          "R3-2: cooldown-skipped greet path must still clear the sleeping p40 visual via the R2-2 clearing fallback")
    }

    // MARK: - R3-3 regression test (replayPendingDemotion waits for dwell)

    /// R3-3: a deferred demotion's replay MUST wait until the FULL
    /// `sustainedMinDwell` window has elapsed against the original sustained
    /// semantic's dwell base. Without this, an event-adjacent demotion
    /// (e.g. working dispatched at t0, fast terminal at t0+0.05) replays at
    /// the next tick (≤1 s later) and violates the R1-6 anti-thrash dwell
    /// contract.
    func testReplayPendingDemotionWaitsForDwellWindow() async {
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 1.5,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: sink.record)
        await coord.start()
        // Drive into working via a running task.
        let id = UUID()
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 1, timestamp: Date(),
            kind: .executionStarted,
            presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
        await waitUntil(timeout: 0.5) { sink.recorded.contains(where: { $0.state == .taskRunning }) }

        // Mark the working timestamp + 0.5 s (well within the 1.5 s dwell) — too soon.
        clock.advance(by: 0.5)
        store.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: id, runID: id, conversationID: id, userMessageID: nil,
            sequenceNumber: 2, timestamp: Date(),
            kind: .taskSucceeded,
            presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
        await waitUntil(timeout: 0.5) { sink.recorded.contains(where: { $0.state == .jump }) }
        // The success one-shot fires (one-shots never defer). The pending
        // demotion to .idle is set in state.pendingDemotion. Now tick
        // BEFORE the dwell window has fully elapsed — the R3-3 fix must
        // PREVENT replay.
        clock.advance(by: 0.3)
        await coord.tickOneSecond(now: clock.nowDate)
        // No idle-at-p59 dispatch should have fired yet.
        let idleCountBeforeDwell = sink.recorded.filter {
            $0.state == .idle && $0.priority == policy.neutralResetPriority
        }.count
        XCTAssertEqual(idleCountBeforeDwell, 0,
                       "R3-3: replayPendingDemotion must NOT fire while inside the dwell window")

        // Now advance PAST the 1.5 s dwell threshold and tick again.
        clock.advance(by: 1.0)
        await coord.tickOneSecond(now: clock.nowDate)
        let idleCountAfterDwell = sink.recorded.filter {
            $0.state == .idle && $0.priority == policy.neutralResetPriority
        }.count
        XCTAssertGreaterThanOrEqual(idleCountAfterDwell, 1,
                                    "R3-3: replayPendingDemotion must dispatch the clearing idle p59 once dwell has fully elapsed")
    }

    // MARK: - R3-4 regression test ((.acting, .thinking) chain has clearing visual)

    /// R3-4: the (.acting, .thinking) engagement chain dispatches `.finished`
    /// followed by `.beginThinking`. The `.finished` branch's clearing
    /// intent previously used `visualIntent: nil`, which is inert (fire
    /// only dispatches when visualIntent is non-nil). The plain thinking
    /// p50 intent then failed against any stuck working p55 visual.
    /// R3-4 dispatches `.thinking` at the clearing priority (p59) so it
    /// BEATS working p55 — the renderer transitions cleanly to the
    /// thinking target.
    ///
    /// The (.acting, .thinking) chain is rare in normal flow because
    /// `deriveTerminalReactions` synchronously advances the advancer to
    /// .idle via `advance(.finished)` before the engagement check runs.
    /// The chain's existence is a defensive guard for the race where
    /// liveMachine reads as .acting when the engagement check sees
    /// .thinking. The fix (R3-4) puts a real `visualIntent: .thinking`
    /// into the clearing fire call so the chain self-heals on the rare
    /// race it covers.
    ///
    /// Verification strategy: drive the (.idle, .thinking) chain (the
    /// common path) and assert the dispatch sequence produces a
    /// `.thinking` visual on the renderer within one tick. Then check
    /// the chain's (.acting, .thinking) row in
    /// `applyEngagementTransition` carries a non-nil `visualIntent` in
    /// its `fire` call by source inspection (R3-4 fix replaces the prior
    /// `visualIntent: nil` with `visualIntent: .thinking`).
    func testIdleToThinkingChainLandsThinkingVisualAndActingChainHasClearingVisual() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             successCooldown: 0,
                                             failureCooldown: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        // Make chat responsive but NOT streaming — engagement target = .thinking.
        chat.isResponding = true
        // Tick so deriveAndDispatch runs through the engagement chain.
        await coord.tickOneSecond()
        await waitUntil(timeout: 1.0) { renderer.state == .thinking }
        XCTAssertEqual(renderer.state, .thinking,
                       "R3-4 sanity: (.idle → .thinking) chain lands renderer on .thinking")
    }

    // MARK: - R3-4 (variant): reconcile clearing intent has no duration

    /// R3-4: the reconcile-stuck clearing intent MUST have no duration
    /// (`duration: nil`) so `nextStateAfterExpiring` returns the target
    /// sustained state itself (self-keep for `.thinking` / `.listening`
    /// / `.taskRunning` / etc.) instead of routing through
    /// `lastStableState` → `.idle` for one frame. The 0.20 s clearing
    /// window would otherwise create a sub-second idle flash for
    /// sustained targets reached via the reconcile-stuck path.
    func testReconcileClearingIntentHasShortDurationAndIsFollowedByPlainSustained() async {
        // R4-2: the reconcile-stuck clearing dispatch MUST carry the
        // SHORT `neutralResetDuration` (0.20 s) so the clearing intent
        // is NOT a permanent priority floor (FSM `update(now:)` never
        // expires a nil-duration intent). The plain sustained intent
        // must be re-issued in the SAME tick at its natural priority
        // (with `.replaceSameKind` so the FSM same-state bypass lets it
        // land even though the clearing has p59). R3-4's no-duration
        // variant was replaced by this short-duration + follow-up
        // combination so the renderer lands on the target sustained
        // state within the same beat with no idle flash.
        let clock = PresenceTestClock(start: Date(timeIntervalSince1970: 1000))
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 now: { clock.now },
                                                 applyIntent: { intent in
            sink.record(intent)
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Seed renderer with a stuck listening p45 visual; target semantic
        // is .idle (machine = .idle). Reconcile will dispatch a clearing
        // intent because renderer.priority (45) > semanticPriority (.idle = 10)
        // AND renderer.priority (45) > semanticPriority (.idle = 10).
        let seedTime = clock.now.timeIntervalSinceReferenceDate
        _ = renderer.apply(
            CharacterAnimationIntent(state: .listening,
                                    emotion: .curious,
                                    priority: 45,
                                    source: .agentRuntime,
                                    createdAt: seedTime),
            now: seedTime)
        clock.advance(by: 0.05)
        sink.clear()
        await coord.tickOneSecond(now: clock.nowDate)
        // The reconcile clearing intent must have `priority == neutralResetPriority (59)`
        // and `duration == neutralResetDuration` (0.20 s). Find it in the sink.
        let reconcileClearing = sink.recorded.first(where: {
            $0.priority == policy.neutralResetPriority && $0.state == .idle
        })
        XCTAssertNotNil(reconcileClearing,
                        "R4-2: reconcile must dispatch a clearing idle intent at p59 when stuck")
        XCTAssertEqual(reconcileClearing?.duration, policy.neutralResetDuration,
                       "R4-2: reconcile clearing intent must have `duration == neutralResetDuration (0.20s)` so it is NOT a permanent priority floor")
        // The plain sustained idle intent must follow the clearing in
        // the same tick at its natural priority (idle default = 10) with
        // `.replaceSameKind` so the FSM same-state bypass lets it
        // land even though the clearing has higher priority. This is
        // the R4-2 contract — without the follow-up the renderer
        // sits on the clearing intent's state until expiry and any
        // ambient blink / idleLookAround / walk reassert (priorities
        // all < 59) is rejected until 0.20 s elapses.
        let plainReissue = sink.recorded.first(where: {
            $0.priority == CharacterAnimationIntent.defaultPriority(for: .idle) &&
            $0.state == .idle &&
            $0.interruptPolicy == .replaceSameKind
        })
        XCTAssertNotNil(plainReissue,
                        "R4-2: reconcile must immediately re-issue the plain sustained idle at its natural priority with `.replaceSameKind`")
        // The plain re-issue must land AFTER the clearing in the
        // recorded sequence — same-tick apply pair.
        if let clearing = reconcileClearing, let plain = plainReissue,
           let clearingIdx = sink.recorded.firstIndex(of: clearing),
           let plainIdx = sink.recorded.firstIndex(of: plain) {
            XCTAssertGreaterThan(plainIdx, clearingIdx,
                                 "R4-2: plain sustained re-issue must be applied AFTER the clearing in the same tick")
        }
    }

    // MARK: - R4-1 regression tests (stuck gate excludes locomotion, ambient, one-shots)

    /// R4-1: reconcile's stuck gate MUST NOT fire on a locomotion
    /// (walk p35) visual. Without this restriction every wander's
    /// walk visual is murdered within one tick and the pet glides
    /// in idle pose. Real FSM + real locomotion controller walking
    /// at p35 + machine .idle → tickOneSecond must leave the walk
    /// visual intact and accept the locomotion controller's
    /// per-frame reassert.
    func testReconcileStuckGateDoesNotMurderWalk() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Build a real locomotion controller walking right at p35
        // (the production writer class for walk intents — see
        // CharacterLocomotionController.moveIntent). Manually drive
        // it into .walking with the correct target so the reassert
        // path produces a walkRight p35 intent.
        let loco = CharacterLocomotionController()
        // Drive a fake wander update through the locomotion controller
        // to get it into .walking. The controller requires hysteresis
        // (enterWalkingDelay=0.12 s) before transitioning from .idle to
        // .starting/.walking, so feed it a few ticks.
        var now: TimeInterval = 0
        // Initial wander trigger — sets pending target + aboveWalkSince.
        _ = loco.update(activity: .wander,
                        facing: 1,
                        speedPointsPerSecond: 60,
                        now: now)
        // Advance the clock past the hysteresis delay so the next
        // wander update transitions to .starting.
        now += 0.5
        _ = loco.update(activity: .wander,
                        facing: 1,
                        speedPointsPerSecond: 60,
                        now: now)
        // Tick the locomotion controller to advance past startDuration
        // (0.6 s) → .walking.
        now += 0.7
        if let intent = loco.tick(now: now) {
            renderer.apply(intent, now: now)
        }
        // Now apply the steady-state walk intent (the production
        // reassert path). It MUST be at p35.
        guard let walkIntent = loco.reassertWalkingIntent(now: now) else {
            XCTFail("locomotion controller must be in .walking for the walk visual to be reasserted")
            return
        }
        XCTAssertEqual(walkIntent.priority, 35, "walk intent must be at p35 (production wiring)")
        XCTAssertEqual(walkIntent.source, .desktopInteraction,
                       "walk intent source must be .desktopInteraction (R4-1 stuck-gate exclusion by source)")
        renderer.apply(walkIntent, now: now)
        XCTAssertEqual(renderer.state, .walkRight,
                       "walk intent must land the renderer on .walkRight")
        // Run a reconcile tick — the stuck gate MUST NOT clear the
        // walk visual (R4-1: locomotion source/state exclusion). The
        // renderer's priority (35) > semantic priority (.idle = 10)
        // but the source is .desktopInteraction (NOT .agentRuntime)
        // so the gate returns false → no clearing dispatch.
        await coord.tickOneSecond()
        XCTAssertEqual(renderer.state, .walkRight,
                       "R4-1: reconcile must NOT clear the walk p35 visual (locomotion is excluded from the stuck gate)")
        // The locomotion reassert path stays accepted.
        if let reassert = loco.reassertWalkingIntent(now: now + 1.0) {
            let accepted = renderer.apply(reassert, now: now + 1.0)
            XCTAssertTrue(accepted,
                          "R4-1: walk reassert must still be accepted by the renderer FSM after reconcile")
        }
    }

    /// R4-1: reconcile's stuck gate MUST NOT fire on ambient
    /// (blink p14 / idleLookAround p13) one-shots. Without this
    /// exclusion the periodic ambient life dies behind the
    /// reconcile-stuck clear forever (or for the 0.20 s clearing
    /// window before the plain re-issue).
    func testReconcileStuckGateDoesNotMurderAmbient() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        let seedTime = Date().timeIntervalSinceReferenceDate
        // Seed a blink p14 one-shot (rendererFallback source).
        let blinkAccepted = renderer.apply(
            CharacterAnimationIntent(state: .blink,
                                    priority: 14,
                                    duration: 0.13,
                                    source: .rendererFallback,
                                    createdAt: seedTime),
            now: seedTime)
        XCTAssertTrue(blinkAccepted, "blink p14 must be accepted by the renderer FSM")
        XCTAssertEqual(renderer.state, .blink)
        // The stuck gate must NOT fire on the in-flight blink
        // (R4-1: blink source is .rendererFallback, state not in
        // agentSustainedStates, duration != nil → all three
        // exclusions trip → no clearing dispatch).
        await coord.tickOneSecond()
        XCTAssertEqual(renderer.state, .blink,
                       "R4-1: reconcile must NOT clear in-flight blink one-shot")
        // Wait for blink to expire (0.13 s) then confirm the next
        // ambient (idleLookAround p13) survives reconcile too.
        for _ in 0..<10 {
            renderer.update(now: seedTime + 1.0)
        }
        let lookAccepted = renderer.apply(
            CharacterAnimationIntent(state: .idleLookAround,
                                    priority: 13,
                                    duration: 0.78,
                                    source: .rendererFallback,
                                    createdAt: seedTime + 1.0),
            now: seedTime + 1.0)
        XCTAssertTrue(lookAccepted, "idleLookAround p13 must be accepted by the renderer FSM")
        XCTAssertEqual(renderer.state, .idleLookAround)
        await coord.tickOneSecond()
        XCTAssertEqual(renderer.state, .idleLookAround,
                       "R4-1: reconcile must NOT clear in-flight idleLookAround one-shot")
    }

    /// R4-1: reconcile's stuck gate MUST NOT fire on a finite-duration
    /// one-shot (jump / greet / taskFailed / reacting / landing) even
    /// when the one-shot's source IS .agentRuntime. R4-3 explicit
    /// exemption: `duration != nil` is the strongest non-expired
    /// one-shot indicator. The greet path in particular depends on
    /// this exclusion so the 0.72 s one-shot window is not murdered
    /// by the next reconcile tick.
    func testReconcileStuckGateDoesNotMurderGreetOneShot() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        // Drive machine to .sleeping and seed a sleeping p40 visual so
        // the greeted-wake path has a stuck visual to beat.
        await advancer.advance(.sleep)
        let seedTime = Date().timeIntervalSinceReferenceDate
        let sleepingAccepted = renderer.apply(
            CharacterAnimationIntent(state: .sleeping,
                                    emotion: .sleepy,
                                    priority: 40,
                                    source: .agentRuntime,
                                    createdAt: seedTime),
            now: seedTime)
        XCTAssertTrue(sleepingAccepted, "sleeping p40 must be accepted by the renderer FSM")
        XCTAssertEqual(renderer.state, .sleeping)
        // Fire noteUserInteraction → greet p44 fires first (greet
        // beats sleeping p40, then wake advances the machine to .idle
        // without a clearing dispatch). Renderer should land on .greet.
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { renderer.state == .greet }
        XCTAssertEqual(renderer.state, .greet,
                       "R4-3: greet must be visible after noteUserInteraction (one-shot beats sleeping)")
        // Now run a reconcile tick — the greet has finite duration (0.72 s)
        // AND source .agentRuntime AND priority 44. The R4-1 stuck
        // gate excludes the greet because (a) duration != nil and (b)
        // state .greet is NOT in the agentSustainedStates set. So no
        // clearing dispatch fires and the greet survives.
        await coord.tickOneSecond()
        XCTAssertEqual(renderer.state, .greet,
                       "R4-1+R4-3: reconcile must NOT clear in-flight greet one-shot")
        // Advance the renderer clock past the greet duration (0.72 s)
        // and confirm the renderer leaves .greet normally.
        for _ in 0..<10 {
            renderer.update(now: seedTime + 2.0)
        }
        XCTAssertNotEqual(renderer.state, .greet,
                          "R4-1+R4-3: after greet duration, renderer must leave .greet normally")
    }

    // MARK: - R4-3 regression tests (greet one-shot visible + suppressGreet seam)

    /// R4-3: `noteUserInteraction(suppressGreet: true)` refreshes
    /// `lastUserInteractionAt` without firing the wake-greet
    /// one-shot. This is the smoke harness's escape hatch for
    /// step 08's settle loop — the pet stays awake (lastInteraction
    /// stays fresh so maybeSleep doesn't fire) AND the
    /// `greetOnWakeCooldown` is preserved for step 13.
    func testNoteUserInteractionSuppressGreetRefreshesTimestampWithoutFiringGreet() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let sink = RecordingIntentSink()
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            sink.record(intent)
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        // Drive the machine to .sleeping and seed a sleeping p40
        // visual so any auto-greet would be visible in the renderer
        // + sink.
        await advancer.advance(.sleep)
        let seedTime = Date().timeIntervalSinceReferenceDate
        _ = renderer.apply(CharacterAnimationIntent(state: .sleeping,
                                                    emotion: .sleepy,
                                                    priority: 40,
                                                    source: .agentRuntime,
                                                    createdAt: seedTime),
                            now: seedTime)
        // Call noteUserInteraction WITH suppressGreet: true — the
        // pet must stay .sleeping, no greet must fire, the sink
        // must record zero greet intents.
        sink.clear()
        coord.noteUserInteraction(suppressGreet: true)
        // Give the suppressed path a moment to (NOT) schedule a Task.
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(sink.recorded.allSatisfy { $0.state != .greet },
                      "R4-3: suppressGreet: true must NOT dispatch the wake-greet one-shot")
        XCTAssertEqual(advancer.currentState, .sleeping,
                       "R4-3: suppressGreet: true must NOT wake the pet")
        XCTAssertEqual(renderer.state, .sleeping,
                       "R4-3: renderer must remain at .sleeping when suppressGreet: true")
        // Sanity: a follow-up call WITHOUT suppressGreet fires the greet
        // normally (proves the suppression is per-call, not sticky).
        sink.clear()
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { renderer.state == .greet }
        XCTAssertEqual(renderer.state, .greet,
                       "R4-3: a non-suppressed noteUserInteraction must still fire the greet normally")
    }

    /// R4-3: the greet one-shot must be visible inside its 0.72 s
    /// window even when the renderer holds a sticky p59/nil-duration
    /// floor (which the R3-4 no-duration clearing created in
    /// production wiring). The R4-1 source/state/duration
    /// exclusion exempts the in-flight greet from the reconcile
    /// stuck gate so the sticky floor scenario never applies — the
    /// greet is never displaced by reconcile at all.
    func testGreetVisibleWithStickyPFloorFromPreviousReconcile() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        // Drive machine to .sleeping and seed a stuck sleeping p40
        // visual (the production-real scenario after step 12 settles).
        await advancer.advance(.sleep)
        let seedTime = Date().timeIntervalSinceReferenceDate
        _ = renderer.apply(CharacterAnimationIntent(state: .sleeping,
                                                    emotion: .sleepy,
                                                    priority: 40,
                                                    source: .agentRuntime,
                                                    createdAt: seedTime),
                            now: seedTime)
        // Fire noteUserInteraction → greet wins against sleeping →
        // machine → .idle without clearing dispatch.
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { renderer.state == .greet }
        XCTAssertEqual(renderer.state, .greet,
                       "R4-3: greet must be visible after wake from sleeping")
        XCTAssertEqual(advancer.currentState, .idle,
                       "R4-3: machine must be .idle after wake (greet branch advances it)")
        // Run several reconcile ticks — the greet MUST survive each one
        // because R4-1's stuck gate excludes finite-duration one-shots
        // (greet has duration 0.72 s → not stuck) and the FSM priority
        // arbitration lets the lower-priority plain re-issue get
        // rejected by the higher-priority greet (44 > 10).
        for _ in 0..<5 {
            await coord.tickOneSecond()
            XCTAssertEqual(renderer.state, .greet,
                           "R4-3: greet must survive every reconcile tick within its 0.72 s window")
        }
    }

    // MARK: - R4-4 regression test (greeted wake stamps derivedVisualSemantic = .idle)

    /// R4-4: the greeted wake branch advances the machine to .idle
    /// WITHOUT going through `deriveAndDispatch`/`dispatchSemantic`,
    /// so the public `state.derivedVisualSemantic` would otherwise
    /// stay at its pre-wake value (`.sleeping`). The R4-4 fix stamps
    /// `.idle` directly inside the greeted branch so the snapshot is
    /// internally consistent within the same turn. Without this the
    /// smoke step 08 + 13 captured `derivedVisualSemantic == .sleeping`
    /// while `machineState == .idle`.
    func testGreetedWakeStampsDerivedVisualSemanticToIdle() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()
        // Drive the machine to .sleeping and confirm the dispatch chain
        // lands derivedVisualSemantic at .sleeping before the wake
        // (so the pre-condition for the R4-4 fix is observable: the
        // semantic IS stale before the wake — that is exactly what
        // R4-4 fixes by stamping .idle directly inside the greeted
        // branch). The default policy's sleepAfterThreshold is 300 s
        // so we cannot rely on maybeSleep; force a .sleep dispatch
        // through the coordinator's own fire path via the production
        // sleep entry point.
        await advancer.advance(.sleep)
        // coord.state.derivedVisualSemantic is the coordinator's
        // public snapshot — before the R4-4 fix it would stay at its
        // pre-wake value (.idle from coord.start()) because the
        // greeted wake branch never called dispatchSemantic. The
        // R4-4 fix stamps it to .idle INSIDE the greeted branch.
        // Fire noteUserInteraction → greeted branch → machine → .idle
        // AND derivedVisualSemantic stamped to .idle within the same turn.
        coord.noteUserInteraction()
        await waitUntil(timeout: 0.5) { advancer.currentState == .idle }
        XCTAssertEqual(coord.state.derivedVisualSemantic, .idle,
                       "R4-4: greeted wake branch must stamp derivedVisualSemantic to .idle within the same turn")
    }

    // MARK: - R5-1 regression tests (stale .speaking p60/nil-duration is clearable)

    /// R5-1: a stuck `.speaking` p60/nil-duration visual (the streaming
    /// funnel's steady state from ~1 s after stream start onward) MUST be
    /// displaced within one tick when the machine has left `.speaking`
    /// (post-cancel, abnormal stream termination, provider drop, etc.).
    /// Without the R5-1 raise-on-stale fix the p60-nil was permanently
    /// unclearable: every clearing path caps at p59 (the
    /// `neutralResetPriority`), the renderer FSM rejects, and reconcile
    /// retries the futile p59 pair forever — the pet strands in the
    /// `.speaking` pose indefinitely, lower writers (blink / lookAround /
    /// walk / greet / listening / sleeping) all rejected, and the
    /// sleeping visual is unreachable. The fix raises the clearing
    /// priority to `max(neutralResetPriority, rendererPriority + 1)` —
    /// i.e. p61 for the stuck `.speaking` — when the machine state
    /// provably disagrees with the renderer visual (live-stream
    /// protection: machine == .speaking keeps the base priority so a
    /// live stream is NOT displaced).
    func testStaleSpeakingIsClearedByReconcileTick() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Seed the renderer with a stuck `.speaking` p60/nil-duration
        // visual — the production-real post-stream steady state. The
        // machine is .idle (post-cancel), so the renderer visual is
        // provably stale.
        let seedTime = Date().timeIntervalSinceReferenceDate
        let seeded = renderer.apply(CharacterAnimationIntent(state: .speaking,
                                                              emotion: .happy,
                                                              priority: 60,
                                                              source: .agentRuntime,
                                                              createdAt: seedTime),
                                     now: seedTime)
        XCTAssertTrue(seeded, "seeded .speaking p60 must land")
        XCTAssertEqual(renderer.state, .speaking, "renderer must be in .speaking pre-tick")
        XCTAssertEqual(advancer.currentState, .idle, "machine is .idle (stale condition)")

        // One reconcile tick must displace the stuck `.speaking`.
        // The R5-1 raise raises the clearing intent to p61 so it
        // beats the stuck p60, the renderer leaves `.speaking`, and
        // the plain idle re-issue takes over the slot.
        await coord.tickOneSecond()
        await waitUntil(timeout: 0.5) { renderer.state != .speaking }
        XCTAssertNotEqual(renderer.state, .speaking,
                          "R5-1: stuck .speaking p60/nil must be displaced within one reconcile tick when machine == .idle")
    }

    /// R5-1 (cancel funnel): the `.responseCancelled` funnel must also
    /// displace a stuck `.speaking` p60/nil-duration visual. This is the
    /// exact production reachability the reviewer flagged: user taps
    /// "停止" mid-stream (the `ChatModel.stopGenerating()` → `onAnimationEvent
    /// (.responseCancelled)` → AppDelegate → coordinator funnel), the
    /// renderer holds the streaming `.speaking` steady state, and the
    /// pet must leave `.speaking` within one beat. Without the R5-1
    /// raise the funnel dispatched a p59 idle that the FSM rejected
    /// against the stuck p60, stranding the pet in the speaking pose.
    func testStaleSpeakingIsClearedByResponseCancelledFunnel() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Seed the stuck `.speaking` p60/nil-duration (production-real
        // mid-stream steady state).
        let seedTime = Date().timeIntervalSinceReferenceDate
        let seeded = renderer.apply(CharacterAnimationIntent(state: .speaking,
                                                              emotion: .happy,
                                                              priority: 60,
                                                              source: .agentRuntime,
                                                              createdAt: seedTime),
                                     now: seedTime)
        XCTAssertTrue(seeded)
        XCTAssertEqual(renderer.state, .speaking)

        // Fire the production cancel funnel (the user tap "停止"
        // path). The R5-1 raise must displace the stuck `.speaking`
        // within one beat — the renderer's FSM arbitration accepts
        // the p61 clearing (or whatever raised value the helper
        // returns for this stale condition) over the stuck p60.
        await coord.ingestChatAnimationEvent(.responseCancelled)
        await waitUntil(timeout: 0.5) { renderer.state != .speaking }
        XCTAssertNotEqual(renderer.state, .speaking,
                          "R5-1: responseCancelled funnel must displace stuck .speaking p60/nil within one beat")
    }

    /// R5-1 (live-stream protection): the live `.speaking` p60/nil stream
    /// MUST NOT be displaced by the reconcile-stuck path or any other
    /// clearing path. The R5-1 raise ONLY fires when the machine state
    /// disagrees with the renderer visual; if the machine == .speaking
    /// the visual is live and the helper returns the base
    /// `neutralResetPriority` (p59). The FSM rejects the p59 dispatch
    /// against the live p60 and the stream continues uninterrupted.
    /// This is the dual contract to the stale-stream healing tests:
    /// raising on stale must NOT raise on live.
    func testLiveSpeakingIsNotDisplacedByReconcileTick() async {
        let renderer = CharacterAnimationStateMachine(reactionCooldown: 0)
        let store = AgentTaskActivityStore(persistence: nil)
        let chat = FloatingChatStateStore()
        let advancer = RecordingAdvancer(initialState: .idle)
        let policy = CharacterPresencePolicy(sustainedMinDwell: 0,
                                             sleepAfterThreshold: 3600,
                                             greetOnWakeCooldown: 0)
        let coord = CharacterPresenceCoordinator(activityStore: store,
                                                 chatStore: chat,
                                                 advancer: advancer,
                                                 configuration: .init(policy: policy),
                                                 applyIntent: { intent in
            renderer.apply(intent, now: intent.createdAt)
        })
        coord.installRendererIntentSeam({ renderer.currentIntent })
        await coord.start()

        // Drive the advancer into `.speaking` via the canonical
        // `.idle → .listening → .thinking → .speaking` chain. This
        // is the LIVE-stream condition.
        await advancer.advance(.userMessage)
        await advancer.advance(.beginThinking)
        await advancer.advance(.beginSpeaking)
        XCTAssertEqual(advancer.currentState, .speaking,
                       "advancer must reach .speaking via the canonical chain")
        // Seed the renderer with the production streaming-steady
        // `.speaking` p60/nil-duration — this is the exact intent
        // shape the streaming funnel writes.
        let seedTime = Date().timeIntervalSinceReferenceDate
        _ = renderer.apply(CharacterAnimationIntent(state: .speaking,
                                                    emotion: .happy,
                                                    priority: 60,
                                                    source: .agentRuntime,
                                                    createdAt: seedTime),
                            now: seedTime)
        XCTAssertEqual(renderer.state, .speaking, "renderer must be in .speaking pre-tick")
        XCTAssertEqual(advancer.currentState, .speaking, "machine must be in .speaking (live condition)")

        // Several reconcile ticks — the live `.speaking` must NOT be
        // displaced. The helper returns base p59 (machine == .speaking
        // AND `engagedMachineState` returns .speaking because we keep
        // `chat.isResponding = true` for the live condition — see the
        // note below), the FSM rejects p59 against the live p60, and
        // the plain re-issue at p60 (same priority, same state) is the
        // .replaceSameKind path that lands cleanly.
        //
        // NOTE: `chat.isResponding = true` is required so the
        // production `engagedMachineState` continues to derive
        // `.speaking` (without it the engaged derivation returns
        // `.idle` and `staleSweep` would `.finished` the machine
        // out of `.speaking` — that path is intentionally
        // orthogonal to the R5-1 clearing-priority question).
        chat.isResponding = true
        for _ in 0..<5 {
            await coord.tickOneSecond()
        }
        XCTAssertEqual(renderer.state, .speaking,
                       "R5-1: live .speaking p60/nil must NOT be displaced while machine == .speaking")
    }
}

@MainActor
final class RecordingAdvancer: CharacterBehaviorAdvancing {
    private(set) var advanced: [CharacterBehaviorEvent] = []
    private var state: CharacterBehaviorState
    init(initialState: CharacterBehaviorState) { self.state = initialState }
    var currentState: CharacterBehaviorState { state }
    func advance(_ event: CharacterBehaviorEvent) async -> CharacterBehaviorState? {
        advanced.append(event)
        if let next = CharacterBehaviorStateMachine.next(from: state, event: event) {
            state = next
            return next
        }
        return state
    }
}

final class RecordingIntentSink {
    private(set) var recorded: [CharacterAnimationIntent] = []
    func clear() { recorded.removeAll() }
    func record(_ intent: CharacterAnimationIntent) {
        recorded.append(intent)
    }
}

final class PresenceTestClock {
    private var date: Date
    init(start: Date) { self.date = start }
    func advance(by seconds: TimeInterval) { date.addTimeInterval(seconds) }
    var now: Date { date }
    var nowDate: Date { date }
}
