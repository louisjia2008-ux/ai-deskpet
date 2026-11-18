import Foundation
import Combine
import CoreGraphics
import PetAgentRuntime

@MainActor
protocol CharacterBehaviorAdvancing: AnyObject {
    func advance(_ event: CharacterBehaviorEvent) async -> CharacterBehaviorState?
    var currentState: CharacterBehaviorState { get }
}

@MainActor
final class CharacterPresenceCoordinator {

    // MARK: - Configuration
    struct Configuration {
        var policy: CharacterPresencePolicy = .default
        /// Optional seam for the renderer's current intent — used by `reconcile(nowDate:)` to
        /// re-issue the sustained semantic intent when the renderer state has drifted (and the
        /// renderer's priority arbitration rejects a lower-priority reissue). When `nil`,
        /// reconcile() becomes a no-op (keeps unit tests that don't need the seam running).
        var currentRendererIntent: (() -> CharacterAnimationIntent?)? = nil
    }

    // MARK: - Public state snapshot (for presence-bridge wiring + tests + smoke harness)
    struct State {
        var machineState: CharacterBehaviorState
        var hasActiveTask: Bool
        var hasWaitingTask: Bool
        var isResponding: Bool
        var chatVisible: Bool
        var chatAttentive: Bool
        var reduceMotion: Bool
        var lastSuccessIntentAt: Date?
        var lastFailureIntentAt: Date?
        var lastGreetAt: Date?
        var lastEnteredStateAt: Date
        var derivedVisualSemantic: CharacterPresenceSemantic?
        var lastDispatchedIntent: CharacterAnimationIntent?
        var isHydrated: Bool

        /// Mirrors `CharacterBehaviorState.suppressesAmbient` so the overlay's proactivity gate
        /// can be wired without leaking dormant-architecture vocabulary into proactivity.
        var suppressesAmbient: Bool {
            switch machineState {
            case .sleeping, .dormant: return true
            default: return false
            }
        }
    }

    // MARK: - Inputs
    let activityStore: AgentTaskActivityStore
    let chatStore: FloatingChatStateStore
    private let advancer: any CharacterBehaviorAdvancing
    private let configuration: Configuration
    private let mapping: CharacterPresenceMapping
    private let now: () -> Date
    private let applyIntent: (CharacterAnimationIntent) -> Void
    private let onPresenceEngage: ((Bool) -> Void)?

    // MARK: - Subscriptions
    private var cancellables: Set<AnyCancellable> = []
    /// Test-only override seam for `reconcile` — see `installRendererIntentSeam`. Stored
    /// separately from `configuration.currentRendererIntent` because Configuration is value-type
    /// captured at init time.
    private var reconciliationRendererIntent: (() -> CharacterAnimationIntent?)?
    private var lastChatVisibilityState: FloatingChatVisibilityState
    private var lastChatVisibilityChangeAt: Date
    private var lastIsResponding: Bool
    private var lastUserInteractionAt: Date
    private var lastTaskActivityAt: Date
    private var lastRespondingFallingEdgeAt: Date
    private var isHydrated: Bool = false
    private var snapshot: Snapshot = .initial
    /// Tracks which terminal `taskID`s we've already reacted to so a single terminal only fires
    /// one success/failure/cancel reaction (and the success/failure cooldowns further dedup).
    /// R2-13: an ordered Array for FIFO eviction (Sets in Swift do not guarantee iteration
    /// order, so the prior `Set.first` eviction was effectively random). Membership is
    /// tracked separately in `reactedTerminalIDsSet` for O(1) lookups.
    private var reactedTerminalIDs: [UUID] = []
    private var reactedTerminalIDsSet: Set<UUID> = []
    /// Set by `ingestChatAnimationEvent(.responseStarted|.responseDelta)`, cleared on
    /// `responseFinished|.responseFailed|.responseCancelled` — drives `.speaking` derivation.
    private var streamingResponse: Bool = false
    /// Edge-detect for `onPresenceEngage`: only fire on transitions.
    private var lastEngagedState: Bool = false
    /// R2-9: the timestamp of the LAST DISPATCHED sustained (non-one-shot) semantic.
    /// Used as the dwell base for demotion timing so event-adjacent demotions
    /// (`fire(.finished)` immediately followed by a derive demotion) don't measure
    /// dwell-elapsed ≈ 0 and get silently deferred.
    private var lastDispatchedSustainedAt: Date?
    /// R2-9: a demotion that was deferred because the dwell window had not yet
    /// elapsed. Retried on the next 1 Hz tick (`tickOneSecond`).
    private var pendingDemotion: CharacterPresenceSemantic?
    /// R2-9: dwell base at the time the pending demotion was deferred. The retry
    /// reuses this so the demotion fires when the dwell window has fully elapsed
    /// from the ORIGINAL sustained semantic, not from `now()`.
    private var pendingDemotionDwellBase: Date?

    // MARK: - Public read-only
    private(set) var state: State = State(machineState: .idle,
                                          hasActiveTask: false,
                                          hasWaitingTask: false,
                                          isResponding: false,
                                          chatVisible: false,
                                          chatAttentive: false,
                                          reduceMotion: false,
                                          lastSuccessIntentAt: nil,
                                          lastFailureIntentAt: nil,
                                          lastGreetAt: nil,
                                          lastEnteredStateAt: Date(timeIntervalSince1970: 0),
                                          derivedVisualSemantic: nil,
                                          isHydrated: false)

    init(activityStore: AgentTaskActivityStore,
         chatStore: FloatingChatStateStore,
         advancer: any CharacterBehaviorAdvancing,
         configuration: Configuration = Configuration(),
         mapping: CharacterPresenceMapping = .live,
         now: @escaping () -> Date = Date.init,
         applyIntent: @escaping (CharacterAnimationIntent) -> Void,
         onPresenceEngage: ((Bool) -> Void)? = nil) {
        self.activityStore = activityStore
        self.chatStore = chatStore
        self.advancer = advancer
        self.configuration = configuration
        self.mapping = mapping
        self.now = now
        self.applyIntent = applyIntent
        self.onPresenceEngage = onPresenceEngage
        let startDate = now()
        self.lastChatVisibilityState = chatStore.visibilityState
        self.lastChatVisibilityChangeAt = startDate
        self.lastIsResponding = chatStore.isResponding
        self.lastUserInteractionAt = startDate
        self.lastTaskActivityAt = startDate
        self.lastRespondingFallingEdgeAt = startDate
    }

    // MARK: - Snapshot (cheap derived inputs)

    private struct Snapshot {
        var tasks: [AgentTaskActivitySnapshot]
        var recentTerminalTasks: [AgentTaskActivitySnapshot]
        var activeTasks: [AgentTaskActivitySnapshot]
        var waitingTasks: [AgentTaskActivitySnapshot]
        var chatEngaged: Bool   // capsuleActive / expanded / taskHUD — the user is "using" chat
        var chatAttentive: Bool // expanded / taskHUD — gaze + listening
        var isResponding: Bool
        var streamingResponse: Bool // responseStarted/responseDelta active → .speaking
        var machineState: CharacterBehaviorState

        static let initial = Snapshot(tasks: [], recentTerminalTasks: [],
                                      activeTasks: [], waitingTasks: [],
                                      chatEngaged: false, chatAttentive: false,
                                      isResponding: false, streamingResponse: false,
                                      machineState: .idle)
    }

    private func refreshSnapshot(nowDate: Date) {
        let tasks = activityStore.tasks
        let active = activityStore.activeTasks
        let waiting = activityStore.waitingTasks
        let terminal = activityStore.recentTerminalTasks
        let vis = chatStore.visibilityState
        snapshot = Snapshot(tasks: tasks,
                            recentTerminalTasks: terminal,
                            activeTasks: active,
                            waitingTasks: waiting,
                            chatEngaged: (vis == .capsuleActive || vis == .expanded || vis == .taskHUD),
                            chatAttentive: (vis == .expanded || vis == .taskHUD),
                            isResponding: chatStore.isResponding,
                            streamingResponse: streamingResponse,
                            machineState: advancer.currentState)
    }

    // MARK: - Lifecycle

    func start() async {
        isHydrated = false
        // First emission is silent — `isHydrated = false` means no terminal reactions may fire
        // for pre-existing snapshots (persisted interrupted runs, etc.). Hydration is only
        // flipped AFTER the first derive so the initial-terminals guard is real.
        await ingestChatChange(visibility: chatStore.visibilityState, isResponding: chatStore.isResponding, nowDate: now())
        subscribe()
        refreshSnapshot(nowDate: now())
        await driveInitialStart(nowDate: now())
        isHydrated = true
    }

    func stop() async {
        cancellables.removeAll()
        let n = now()
        let s = mapping.neutralReset(now: n.timeIntervalSinceReferenceDate)
        applyIntent(s)
        _ = await advancer.advance(.shutdown)
        // R1-9: reset edge-detect so a subsequent start() can re-fire rising edges.
        let wasEngaged = lastEngagedState
        lastEngagedState = false
        if wasEngaged { onPresenceEngage?(false) }
    }

    private func subscribe() {
        var stream = Set<AnyCancellable>()
        activityStore.$tasks
            .dropFirst()                                  // skip the first emission = hydration
            .sink { [weak self] _ in
                guard let self else { return }
                self.lastTaskActivityAt = self.now()
                self.refreshSnapshot(nowDate: self.now())
                Task { @MainActor in await self.deriveAndDispatch(reason: .tasksChanged) }
            }
            .store(in: &stream)

        chatStore.$visibilityState
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] newState in
                guard let self else { return }
                self.lastChatVisibilityChangeAt = self.now()
                self.refreshSnapshot(nowDate: self.lastChatVisibilityChangeAt)
                Task { @MainActor in await self.ingestChatChange(visibility: newState,
                                                                  isResponding: self.chatStore.isResponding,
                                                                  nowDate: self.lastChatVisibilityChangeAt) }
            }
            .store(in: &stream)

        chatStore.$isResponding
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] responding in
                guard let self else { return }
                let now = self.now()
                if !self.lastIsResponding && responding {
                    // Rising edge → wake source + user message semantics.
                    self.lastUserInteractionAt = now
                    Task { @MainActor in
                        if self.advancer.currentState == .sleeping {
                            await self.fire(.wake, now: now)
                        } else if self.advancer.currentState == .observing {
                            await self.fire(.userMessage, now: now)
                        } else if self.advancer.currentState == .idle {
                            await self.fire(.userMessage, now: now)
                        }
                        await self.deriveAndDispatch(reason: .respondingEdge)
                    }
                } else if self.lastIsResponding && !responding {
                    self.lastRespondingFallingEdgeAt = now
                    // R2-11: clear `streamingResponse` on the falling edge. Without
                    // this, an abnormal stream termination (provider drop, view
                    // teardown mid-stream) leaves the coordinator pinned in
                    // `.speaking` indefinitely — `engagedMachineState` returns
                    // `.speaking`, reconcile sustains `speaking` p60 blocking all
                    // lower-priority demotions, and `maybeSleep` is gated on
                    // `machine != .idle`. Clearing on the falling edge of the
                    // upstream `isResponding` flag is safe because the upstream
                    // signal is a strict superset of "a response is active".
                    self.streamingResponse = false
                    Task { @MainActor in await self.deriveAndDispatch(reason: .respondingFallingEdge) }
                }
                self.lastIsResponding = responding
            }
            .store(in: &stream)

        cancellables = stream
    }

    // MARK: - External funnels

    func ingestChatAnimationEvent(_ event: PetAgentAnimationEvent) async {
        switch event {
        case .responseStarted, .responseDelta:
            // R1-8: streaming tokens fire at tens per second — do not run the full
            // deriveAndDispatch pipeline per token. Just refresh the streaming flag so
            // the next derive (next task change, chat change, or 1 Hz tick) picks up
            // `.speaking`. Also forward the immediate speaking p60 intent so the
            // visual is renewed at the moment the token arrives.
            streamingResponse = true
            let n = now()
            applyIntent(AgentAnimationEventMapper.intent(for: event, now: n.timeIntervalSinceReferenceDate))
            return
        case .responseFinished:
            // R1-4: chat-origin reply completion produces a jump p68 + machine `.finished`.
            // Forward the mapper intent (pre-P16 chat-origin jump) AND drive the machine.
            let n = now()
            streamingResponse = false
            applyIntent(AgentAnimationEventMapper.intent(for: event, now: n.timeIntervalSinceReferenceDate))
            await fire(.finished, now: n)
            await deriveAndDispatch(reason: .chatEvent)
        case .responseFailed:
            // R1-4: chat-origin failure → taskFailed pose + machine `.recoverFromError`.
            let n = now()
            streamingResponse = false
            applyIntent(AgentAnimationEventMapper.intent(for: event, now: n.timeIntervalSinceReferenceDate))
            await fire(.recoverFromError, now: n)
            await deriveAndDispatch(reason: .chatEvent)
        case .responseCancelled:
            // R1-4: cancel → neutral reset intent + machine `.interrupt` (which traps in
            // .interrupted — handled by applyEngagementTransition chaining).
            let n = now()
            streamingResponse = false
            // R5-1: when the renderer holds a sustained `.speaking` p60
            // (the streaming funnel's steady state from ~1 s after
            // stream start), the base `mapping.neutralReset` priority
            // (p59) cannot displace it. Raise the clearing priority
            // above the stuck sustained visual via
            // `clearingPriorityForStuckRenderer` — preserves live-stream
            // protection (machine == .speaking → no raise) but clears a
            // stale post-cancel `.speaking` within one beat.
            let cancelClearingPriority = clearingPriorityForStuckRenderer(nowDate: n)
            applyIntent(CharacterAnimationIntent(state: .idle,
                                                emotion: .neutral,
                                                priority: cancelClearingPriority,
                                                interruptPolicy: .interruptLowerPriority,
                                                duration: configuration.policy.neutralResetDuration,
                                                source: .agentRuntime,
                                                createdAt: n.timeIntervalSinceReferenceDate))
            await fire(.interrupt, now: n)
            await deriveAndDispatch(reason: .chatEvent)
        case .thinkingStarted, .thinkingFinished:
            // Coordinator owns thinking via isResponding + snapshots; legacy funnel events are swallowed.
            await deriveAndDispatch(reason: .chatEventSwallowed)
        case .userMessageReceived, .listeningStarted:
            let n = now()
            applyIntent(AgentAnimationEventMapper.intent(for: event, now: n.timeIntervalSinceReferenceDate))
            await deriveAndDispatch(reason: .chatEvent)
        case .taskSucceeded, .terminalFailure:
            // Legacy pre-P16 task-event intents (chat origin). The terminal-transition derivation
            // from snapshots (R1-4) handles canonical reactivity. We forward the mapper intent
            // for immediate visual feedback when sourced from the chat funnel.
            let n = now()
            applyIntent(AgentAnimationEventMapper.intent(for: event, now: n.timeIntervalSinceReferenceDate))
            await deriveAndDispatch(reason: .chatEvent)
        case .emotionChanged, .greeting:
            // Forward through the legacy mapper; no special lifecycle.
            let n = now()
            applyIntent(AgentAnimationEventMapper.intent(for: event, now: n.timeIntervalSinceReferenceDate))
        case .taskRunning, .taskReview, .providerWaiting:
            await deriveAndDispatch(reason: .chatEvent)
        }
    }

    func noteUserInteraction(now nowDate: Date? = nil, suppressGreet: Bool = false) {
        let n = nowDate ?? now()
        lastUserInteractionAt = n
        // R1-3: a rising user-interaction while sleeping MUST wake the pet (`.sleeping → .wake`)
        // and dispatch the .idle visual so the renderer exits the sleeping pose. Also revoke
        // suppressWander via the edge-detected onPresenceEngage callback.
        // R2-2: dispatch with `clearing: true` so the wake-intent is raised to
        // `neutralResetPriority` (p59) which beats the sustained sleeping p40 visual —
        // without it, the renderer FSM priority check rejects wake-idle p10 < sleeping p40
        // and the pet stays visually asleep after the mouse-down wake. Also emit the
        // optional wake-greet one-shot (p44 greet beats sleeping p40, but the clearing
        // intent at p59 would beat the greet at p44 if applied first — see R3-2).
        // R3-2: dispatch the optional wake-greet one-shot BEFORE the clearing
        // wake dispatch. When greet fires (cooldown allows), its p44
        // beats the sleeping p40 — the renderer leaves .sleeping via the
        // greet one-shot, NOT via the clearing p59 dispatch. To keep the
        // greet visible during its 0.72s window we MUST skip the wake
        // clearing dispatch when greet fired (the clearing p59 would
        // otherwise immediately override the greet). When greet did NOT
        // fire (cooldown skip), fall back to the R2-2 clearing dispatch
        // to un-stick the sleeping visual.
        // R4-3: the smoke harness's settle loop calls
        // `noteUserInteraction` per iteration to keep the pet awake
        // (lastUserInteractionAt refresh). When the pet is `.sleeping`
        // at the start of the settle (e.g. step 08 settling a pet that
        // drifted to .sleeping during its body wait), the first
        // `noteUserInteraction` call fires the wake-greet one-shot
        // and stamps `lastGreetAt`, consuming the 30 s
        // `greetOnWakeCooldown` BEFORE step 13 can fire its own wake.
        // Step 13 then takes the cooldown-skipped fallback path and
        // never shows `.greet`. Suppression hook (`suppressGreet: true`)
        // lets the harness refresh the inactivity timestamp without
        // touching the greet cooldown.
        if advancer.currentState == .sleeping && !suppressGreet {
            Task {
                let greeted = await emitOptionalWakeGreet(nowDate: n)
                if greeted {
                    // Greet already won against sleeping; advance the
                    // machine to .idle without a clearing visual so the
                    // greet one-shot plays through its full 0.72 s
                    // window. Plain wake-idle p10 is correctly rejected
                    // against greet p44 → renderer stays at .greet.
                    _ = await advancer.advance(.wake)
                    state.machineState = advancer.currentState
                    state.lastEnteredStateAt = n
                    // R4-4: the greeted branch advances the machine to
                    // .idle but never goes through `deriveAndDispatch`
                    // (and reconcile dispatches bypass `dispatchSemantic`
                    // so the edge-detect `state.derivedVisualSemantic`
                    // there doesn't fire either). Without this stamp the
                    // public snapshot keeps the pre-wake `.sleeping`
                    // semantic until the next chat/task derive —
                    // visible as smoke step 08 / 13's
                    // `derivedVisualSemantic == .sleeping` while
                    // `machineState == .idle`. Stamp it to .idle
                    // directly so the post-wake state is internally
                    // consistent within the same turn.
                    state.derivedVisualSemantic = .idle
                } else {
                    // No greet (cooldown skip); clearing-intent wake.
                    await fire(.wake, now: n, visualIntent: .idle, clearing: true)
                }
            }
        }
    }

    func setReduceMotion(_ reduce: Bool) {
        if state.reduceMotion != reduce {
            state.reduceMotion = reduce
            Task { await deriveAndDispatch(reason: .reduceMotionChanged) }
        }
    }

    // MARK: - Test-only seams

    /// Test-only seam to install a renderer-intent reader for `reconcile(nowDate:)`. Production
    /// wiring sets up the same closure via `configuration.currentRendererIntent`, but tests
    /// constructed without a renderer back-reference need a way to mutate the Configuration
    /// after construction. Kept separate from `Configuration` because Configuration is a
    /// value-type captured at init time.
    func installRendererIntentSeam(_ seam: @escaping () -> CharacterAnimationIntent?) {
        reconciliationRendererIntent = seam
    }

    /// Test-only accessor for the cancellable subscription count (lifecycle teardown test).
    var subscriptionCount: Int { cancellables.count }

    // MARK: - 1 Hz tick

    func tickOneSecond(now nowDate: Date? = nil) async {
        let n = nowDate ?? now()
        refreshSnapshot(nowDate: n)
        // R2-9: retry any pending demotion before reconcile so a deferred demotion
        // can fire as soon as the dwell window has fully elapsed. (Without this,
        // event-adjacent demotions that fired at t=0 with a 1.5 s dwell were
        // permanently dropped because `fire()` reset `lastEnteredStateAt` to t=0.)
        replayPendingDemotion(nowDate: n)
        // Reconcile: if the actual visual state has diverged from the sustained intent, re-issue.
        // (See plan §1.5 last rule.)
        await reconcile(nowDate: n)
        await staleSweep(nowDate: n)
        await maybeSleep(nowDate: n)
    }

    // MARK: - Derivation

    private enum DeriveReason {
        case start
        case tasksChanged
        case respondingEdge
        case respondingFallingEdge
        case chatEvent
        case chatEventSwallowed
        case reduceMotionChanged
        case reconcile
        case staleSweep
        case sleepWake
        case notifyHungUp
        case initial
    }

    private func ingestChatChange(visibility: FloatingChatVisibilityState,
                                   isResponding: Bool,
                                   nowDate: Date) async {
        // Compute the rising/falling-edge semantic (chat hide / capsule-collapse). Falling
        // edges fire `.finished` so the listening p45 visual (or recovery/chained engaged
        // state) is cleared within one tick — the trap-state fix from R1-5.
        //
        // R3-1: the falling edge must also raise the intent priority to
        // `neutralResetPriority` (p59) via `clearing: true` so the
        // neutral-reset intent BEATS the sustained listening p45 /
        // attentiveLite p45 / sleeping p40 visual the machine is leaving. The
        // prior version dispatched only `.finished` (no visualIntent) and
        // then delegated to `deriveAndDispatch` which would dispatch `.idle`
        // at p10 — rejected by the renderer's FSM arbitration for any
        // sustained visual above p10. The reconcile-stuck threshold then
        // could not heal it (threshold was ≥50 to protect locomotion p30,
        // missing listening p45 and sleeping p40). Result: pet frozen in the
        // listening pose after a normal "expand chat, read ≥1.5 s, close"
        // interaction, with the sleep visual permanently undisplayable.
        // See `reconcile(nowDate:)` R3-1 lowering the stuck-comparison against
        // the SEMANTIC's own priority to also self-heal this case.
        let prev = lastChatVisibilityState
        if prev != visibility {
            switch (prev, visibility) {
            case (_, .capsuleActive):
                if prev == .capsuleIdle || prev == .hidden {
                    await fire(.userLooked, now: nowDate)
                }
            case (_, .expanded), (_, .taskHUD):
                await fire(.userMessage, now: nowDate)
            case (.expanded, .capsuleIdle), (.expanded, .hidden),
                 (.taskHUD, .capsuleIdle), (.taskHUD, .hidden),
                 (.capsuleActive, .capsuleIdle), (.capsuleActive, .hidden):
                // Chat was engaged and is now unengaged → emit .finished
                // AND a clearing intent so the listening p45 /
                // attentiveLite p45 / sleeping p40 sustained visual is
                // replaced within one tick (R3-1). Without `clearing: true`
                // the subsequent `deriveAndDispatch` would dispatch plain
                // `.idle` p10 — rejected by the renderer FSM against any
                // sustained visual above p10, leaving the pet stuck in
                // the listening pose after a normal chat close.
                await fire(.finished, now: nowDate, visualIntent: .idle, clearing: true)
            default:
                break
            }
            lastChatVisibilityState = visibility
        }
        await deriveAndDispatch(reason: .chatEvent, nowDate: nowDate)
    }

    private func deriveAndDispatch(reason: DeriveReason,
                                   nowDate: Date? = nil) async {
        let n = nowDate ?? now()
        refreshSnapshot(nowDate: n)
        await deriveEvents(reason: reason, nowDate: n)
        if let next = derivedSemanticForCurrentState(nowDate: n) {
            dispatchSemantic(next, nowDate: n)
        } else {
            // Stale-state: ensure a baseline idle rendering intent is applied. We do NOT use
            // `mapping.neutralReset` here because that intent carries `policy.neutralResetPriority`
            // (currently p59) which is intentionally above taskRunning/taskReview/listening so
            // it can clear those sustained visuals — but if applied at startup, it would also
            // LOCK out every subsequent lower-priority intent until it expires (the renderer's
            // FSM priority arbitration rejects anything below currentIntent.priority). Use a
            // plain idle p10 instead so the initial state is the lowest-priority intent and any
            // real engagement can override it.
            dispatchSemantic(.idle, nowDate: n)
            state.derivedVisualSemantic = .idle
        }
    }

    /// Look at the current machine state + activity + chat presence + isResponding → emit events,
    /// then derive the requested visual semantic.
    private func deriveEvents(reason: DeriveReason, nowDate: Date) async {
        let machine = snapshot.machineState
        let hasActive = !snapshot.activeTasks.isEmpty
        let hasWaiting = !snapshot.waitingTasks.isEmpty
        let anyTask = hasActive || hasWaiting

        // 1) If the machine is .dormant and we're starting → fire .start once.
        if machine == .dormant {
            if reason == .start || reason == .initial {
                await fire(.start, now: nowDate)
                return
            }
        }

        // 2) If we're sleeping, evaluate wake triggers.
        if machine == .sleeping {
            let last = state.lastEnteredStateAt
            let shouldWake = (lastUserInteractionAt > last)
                || (snapshot.chatEngaged && lastChatVisibilityChangeAt > last)
                || (anyTask && lastTaskActivityAt > last)
                || (snapshot.isResponding && lastRespondingFallingEdgeAt > last)
            if shouldWake {
                // R2-2: clearing=true so the wake-idle intent is raised to
                // `neutralResetPriority` (p59) which beats the sustained sleeping
                // p40 visual. Without it the renderer FSM rejects wake-idle p10
                // and the pet stays visually asleep after the wake.
                //
                // R3-2: dispatch the optional wake-greet one-shot BEFORE
                // the clearing wake dispatch. When greet fires, its p44
                // beats the sleeping p40 → the renderer leaves .sleeping
                // via the greet one-shot. To keep greet visible, skip
                // the wake clearing when greet actually fired (the
                // clearing p59 would otherwise immediately override
                // greet p44). When greet is cooldown-skipped, fall
                // back to the R2-2 clearing dispatch to un-stick the
                // sleeping visual.
                let greeted = await emitOptionalWakeGreet(nowDate: nowDate)
                if greeted {
                    // Greet already won against sleeping; advance the
                    // machine to .idle without a clearing visual so the
                    // greet one-shot plays through its full 0.72 s
                    // window. Plain wake-idle p10 is correctly rejected
                    // against greet p44 → renderer stays at .greet.
                    _ = await advancer.advance(.wake)
                    state.machineState = advancer.currentState
                    state.lastEnteredStateAt = nowDate
                    // R4-4: stamp `derivedVisualSemantic` to `.idle`
                    // so the public snapshot is consistent with the
                    // post-wake machine state within the same turn
                    // (this branch advances the machine WITHOUT going
                    // through `deriveAndDispatch` → `dispatchSemantic`,
                    // so the edge-detected `state.derivedVisualSemantic`
                    // would otherwise stay at the pre-wake value).
                    state.derivedVisualSemantic = .idle
                } else {
                    await fire(.wake, now: nowDate, visualIntent: .idle, clearing: true)
                }
                return
            }
        }

        // R2-3: trap-state exit on the 1 Hz tick. Without this, .interrupted /
        // .errorRecovery (entered via a failed/cancelled terminal with no subsequent
        // store/chat event) strand forever and reconcile re-issues the recovery
        // beat every tick → a perpetual 1 Hz reacting twitch. Re-read the live
        // advancer state after each advance so the engagement check below operates
        // on the real machine (the local `machine` snapshot captured at :421 is
        // stale across the terminal reaction pass).
        let liveMachine = advancer.currentState
        if liveMachine == .interrupted || liveMachine == .errorRecovery,
           !snapshot.activeTasks.contains(where: { task in
               task.status == .running || task.status == .synthesizing || task.status == .partiallySucceeded
           }),
           !snapshot.isResponding {
            await applyEngagementTransition(from: liveMachine, to: .idle, nowDate: nowDate)
            // Re-read after the transition chain (which may have recursed via
            // applyEngagementTransition → .recovered → .idle) so the snapshot
            // used in step 4 below reflects the post-recovery machine state.
            return
        }

        // 3) Terminal transitions from snapshots — R1-4 implementation. Hydration guard:
        // `reactedTerminalIDs` and the snapshot's recentTerminalTasks are both empty until
        // we have a non-hydrated snapshot (start() explicitly sets `isHydrated = true` only
        // after the first derive; anything observed before that is from the persisted baseline
        // and never fires reactions). Cooldowns dedupe the one-shot visually; the dedup set
        // dedupes per terminal task ID.
        if isHydrated {
            await deriveTerminalReactions(reason: reason, nowDate: nowDate)
        }

        // R2-3: re-read live machine state after step 3 so step 4's engagement
        // check operates on the up-to-date advancer (which is what subsequent
        // derives consume). Without this, the engagement check below compares
        // against the stale pre-step-3 machine and skips the recovery chaining.
        let liveMachineAfterTerminals = advancer.currentState
        let engaged = engagedMachineState(nowDate: nowDate)
        if engaged != liveMachineAfterTerminals {
            await applyEngagementTransition(from: liveMachineAfterTerminals, to: engaged, nowDate: nowDate)
        }

        // 5) Stale sweep signals — finish recovery/beat before stale-state reissue.
        // R1-1 / R1-7: stale sweep is gated on TASK-originated engaged states (not listening);
        // chat-only engagement is cleared by ingestChatChange's falling-edge `.finished`.
        let stale: Bool = !anyTask && !snapshot.isResponding &&
            taskEngagedSet.contains(advancer.currentState) && reason == .staleSweep
        if stale, advancer.currentState != .interrupted, advancer.currentState != .errorRecovery {
            await fireRecovery(reason: .stale, nowDate: nowDate)
        }
    }

    /// Walk the snapshot's recent terminals; for each NEW terminal (not previously reacted to)
    /// synthesize the corresponding machine event + visual intent with cooldowns.
    /// R1-4 — terminal-transition derivation with hydration guard (the persistence baseline
    /// never fires reactions) and per-task dedupe.
    private func deriveTerminalReactions(reason: DeriveReason, nowDate: Date) async {
        for task in snapshot.recentTerminalTasks {
            let key = task.taskID
            guard !reactedTerminalIDs.contains(key) else { continue }
            reactedTerminalIDs.append(key)
            reactedTerminalIDsSet.insert(key)
            let cooldownOK: Bool
            switch task.status {
            case .succeeded, .partiallySucceeded:
                cooldownOK = (state.lastSuccessIntentAt == nil) ||
                    (nowDate.timeIntervalSince(state.lastSuccessIntentAt!) >= configuration.policy.successCooldown)
                if cooldownOK {
                    applyIntent(mapping.intent(for: .success, context: renderContext(nowDate: nowDate)))
                    state.lastSuccessIntentAt = nowDate
                }
                _ = await advancer.advance(.finished)
            case .failed:
                cooldownOK = (state.lastFailureIntentAt == nil) ||
                    (nowDate.timeIntervalSince(state.lastFailureIntentAt!) >= configuration.policy.failureCooldown)
                if cooldownOK {
                    applyIntent(mapping.intent(for: .failure, context: renderContext(nowDate: nowDate)))
                    state.lastFailureIntentAt = nowDate
                }
                _ = await advancer.advance(.recoverFromError)
            case .cancelled:
                _ = await advancer.advance(.interrupt)
            default:
                // Other statuses (rare — terminal events only here, but stay safe).
                _ = reason
            }
            state.machineState = advancer.currentState
        }
        // Bound the dedupe list so it cannot grow forever. R2-13: evict in
        // FIFO insertion order (Array.removeFirst) — the prior Set.first
        // eviction was effectively random.
        if reactedTerminalIDs.count > 256 {
            let excess = reactedTerminalIDs.count - 256
            for _ in 0..<excess {
                if !reactedTerminalIDs.isEmpty {
                    let first = reactedTerminalIDs.removeFirst()
                    reactedTerminalIDsSet.remove(first)
                }
            }
        }
    }

    /// Helper used by `deriveTerminalReactions` for rendering-context construction.
    private func renderContext(nowDate: Date) -> CharacterPresenceRenderContext {
        var ctx = CharacterPresenceRenderContext(reduceMotion: state.reduceMotion)
        ctx.createdAt = nowDate.timeIntervalSinceReferenceDate
        return ctx
    }

    /// Engaged states that originated from TASK activity (planning / running / synthesizing /
    /// waiting-for-permission / speaking response). Stale-sweep uses this gate to fire `.finished`
    /// when no active/waiting tasks remain and the user is not responding — i.e. the task-originated
    /// state is stale. Listening (chat-only engagement) is NOT in this set: opening chat without
    /// a task should leave the pet in `.listening` (this is the stuck-listening trap the
    /// chat-hide falling-edge case in `ingestChatChange` cleans up — not the stale sweep).
    private let taskEngagedSet: Set<CharacterBehaviorState> = [
        .thinking, .acting, .waitingForPermission, .speaking
    ]

    /// "Engaged" in the broadest sense (presence-bridge / pet-hold gating). Includes
    /// listening so the pet physically holds still while the user has chat open.
    private let engagedSet: Set<CharacterBehaviorState> = [
        .listening, .thinking, .acting, .waitingForPermission, .speaking, .sleeping
    ]

    private func engagedMachineState(nowDate: Date) -> CharacterBehaviorState {
        // Translate the deduped inputs into the machine's vocabulary.
        let hasActive = !snapshot.activeTasks.isEmpty
        let hasWaiting = !snapshot.waitingTasks.isEmpty
        // Prefer the highest-priority informative state.
        if hasWaiting { return .waitingForPermission }
        let hasRunning = snapshot.activeTasks.contains { task in
            task.status == .running || task.status == .synthesizing || task.status == .partiallySucceeded
        }
        if hasRunning { return .acting }
        if snapshot.streamingResponse { return .speaking }
        if hasActive && snapshot.isResponding { return .acting }
        if snapshot.isResponding {
            // Chat is responding but no stream yet → thinking.
            return .thinking
        }
        if snapshot.chatAttentive { return .listening }
        if snapshot.chatEngaged && chatStore.visibilityState == .capsuleActive { return .observing }
        // No engagement source: confirm we're sleeping if we should be, else idle.
        if advancer.currentState == .sleeping { return .sleeping }
        return .idle
    }

    private func applyEngagementTransition(from: CharacterBehaviorState,
                                           to: CharacterBehaviorState,
                                           nowDate: Date) async {
        // Recovery chain (R1-5): .interrupted / .errorRecovery must always have a legal exit
        // within 1 tick when inputs change — emit `.recovered` then the new engagement event.
        if from == .interrupted || from == .errorRecovery {
            // R2-1: clearing=true so the `.recovered` chain dispatches the neutral-reset
            // intent (idle p59) which beats any stuck `reacting` p46 / `taskFailed` p70
            // sustained visual — without it the trap-state exit fires the machine
            // event but the renderer stays stuck at `.reacting`.
            await fire(.recovered, now: nowDate, visualIntent: to == .idle ? .idle : nil, clearing: true)
            // After recovery, fall through to the now-`from == .idle` case so the new
            // engaged state is entered correctly.
            await applyEngagementTransition(from: .idle, to: to, nowDate: nowDate)
            return
        }

        // Demotion chain (R1-1): every engaged → idle transition dispatches machine `.finished`
        // so the sustained taskRunning/taskReview/listening visual clears within one tick.
        // R2-1: clearing=true so the demotion dispatches neutral-reset (idle p59) which beats
        // stuck working p55 / review p58 / waiting p50 / listening p45 / sleeping p40. Without
        // it the demotion would only fire `idle` p10 — rejected by the renderer's FSM priority
        // arbitration for any sustained visual with priority > 10.
        if engagedSet.contains(from), to == .idle {
            await fire(.finished, now: nowDate, visualIntent: .idle, clearing: true)
            return
        }
        // Same for .listening → .idle when chat hides (handled here uniformly). Already covered.

        // Standard chains below.
        switch (from, to) {
        case (.idle, .listening), (.observing, .listening):
            // R2-7: chat engagement from idle — dispatch the .attentive
            // listening p45 visual so the renderer transitions out of idle
            // when the user opens chat with no other engagement (no task,
            // no responding). Without this row the standard chain fell
            // through to `default: break` and the smoke step 05 / 13 captured
            // semantic=.idle instead of .attentive.
            await fire(.userMessage, now: nowDate, visualIntent: .attentive)
        case (.idle, .thinking), (.observing, .thinking), (.listening, .thinking):
            await fire(.beginThinking, now: nowDate, visualIntent: .thinking)
        case (.acting, .thinking):
            // No direct .acting → .thinking in the FSM table. Chain through .finished and
            // .beginThinking so a task that completed while the chat became responsive can
            // re-derive as "thinking" (the canonical "inference" state). Step-ordering: the
            // task already reached a terminal via the snapshot derivation (R1-4), so the
            // machine is stale at .acting; the new engagement signal is "chat responding".
            //
            // R3-4: dispatch a REAL clearing visual (clearing .thinking at p59)
            // instead of `visualIntent: nil` — the previous `nil` clearing
            // dispatch was inert (fire only dispatches when visualIntent is
            // set) so the stuck working p55 visual blocked the plain
            // thinking p50 apply and the chain needed the reconcile-stuck
            // self-heal a tick later.
            await fire(.finished, now: nowDate, visualIntent: .thinking, clearing: true)
            await fire(.beginThinking, now: nowDate, visualIntent: .thinking)
        case (.idle, .acting), (.observing, .acting), (.listening, .acting):
            await fire(.beginActing, now: nowDate, visualIntent: .working)
        case (.thinking, .acting):
            await fire(.beginActing, now: nowDate, visualIntent: .working)
        case (.speaking, .acting):
            await fire(.beginActing, now: nowDate, visualIntent: .working)
        case (.thinking, .speaking), (.acting, .speaking):
            await fire(.beginSpeaking, now: nowDate, visualIntent: .speaking)
        case (.waitingForPermission, .acting):
            await fire(.permissionResolved, now: nowDate, visualIntent: .working)
        case (.idle, .waitingForPermission),
             (.observing, .waitingForPermission),
             (.acting, .waitingForPermission),
             (.thinking, .waitingForPermission):
            // R2-1: clearing=true so .waiting beats stuck working p55 visuals when the
            // waiting task arrives AFTER a working task without a clean `.finished`
            // transition (the FSM table permits this — see R2-4 — and the renderer
            // otherwise keeps showing working indefinitely).
            await fire(.needPermission, now: nowDate, visualIntent: .waiting, clearing: true)
        case (.sleeping, .idle):
            // R2-2: dispatching a clearing intent on wake so the sleeping p40 visual
            // (sustained, no duration) is actually replaced. Without clearing the
            // renderer FSM priority check rejects wake-idle p10 < sleeping p40.
            await fire(.wake, now: nowDate, visualIntent: .idle, clearing: true)
        case (.idle, .sleeping):
            await fire(.sleep, now: nowDate, visualIntent: .sleeping)
        case (.sleeping, _):
            // Any other wake-source state — emit .wake and transition to .idle first.
            await fire(.wake, now: nowDate, visualIntent: .idle, clearing: true)
            await applyEngagementTransition(from: .idle, to: to, nowDate: nowDate)
        default:
            break
        }
    }

    /// Returns the visual semantic that should be applied *now*, deriving from snapshots/stores.
    private func derivedSemanticForCurrentState(nowDate: Date) -> CharacterPresenceSemantic? {
        let machine = advancer.currentState
        let hasActive = !snapshot.activeTasks.isEmpty
        let hasWaiting = !snapshot.waitingTasks.isEmpty
        let hasRunning = snapshot.activeTasks.contains { $0.status == .running }
        let hasSynthesizing = snapshot.activeTasks.contains { $0.status == .synthesizing }

        // Engagement overrides idle/observing.
        if machine == .waitingForPermission { return .waiting }
        if machine == .acting {
            if hasSynthesizing { return .review }
            return .working
        }
        if machine == .thinking { return .thinking }
        if machine == .speaking { return .speaking }
        if machine == .listening {
            if snapshot.chatAttentive { return .attentive }
            return .attentiveLite
        }
        if machine == .interrupted || machine == .errorRecovery {
            return .recovery
        }
        if machine == .sleeping { return .sleeping }
        if machine == .idle {
            if snapshot.isResponding { return .thinking }
            return .idle
        }
        if machine == .observing { return .idle }
        if machine == .dormant { return nil }
        // No engagement: explicit idle.
        _ = hasActive; _ = hasWaiting; _ = hasRunning
        return .idle
    }

    private func dispatchSemantic(_ semantic: CharacterPresenceSemantic,
                                 nowDate: Date,
                                 clearing: Bool = false,
                                 demotionBase: Date? = nil) {
        var ctx = CharacterPresenceRenderContext(reduceMotion: state.reduceMotion)
        ctx.createdAt = nowDate.timeIntervalSinceReferenceDate
        let baseIntent = mapping.intent(for: semantic, context: ctx)
        // R2-1: clearing dispatches raise the intent priority to `neutralResetPriority`
        // (p59) so the renderer FSM arbitration actually displaces stuck sustained
        // visuals (taskRunning p55 / taskReview p58 / taskWaiting p50 / sleeping p40 /
        // taskFailed p70 etc.). Without this, the demotion / reconcile / staleSweep
        // paths could not clear the pet's visual once it landed on a higher-priority
        // sustained state — the renderer FSM priority check at
        // `CharacterAnimationStateMachine.apply:30` would silently reject every
        // lower-priority reissue and the visual would persist until some unrelated
        // ≥p55 event arrived. The clearing intent carries a short
        // `neutralResetDuration` (0.20 s) so it expires quickly and does not block
        // legitimate lower-priority writers (locomotion reassert at p30 etc.) for
        // longer than one beat.
        let intent: CharacterAnimationIntent
        if clearing {
            // R5-1: raise the clearing priority above the renderer's stuck sustained
            // visual when the renderer is provably stale (machine state disagrees
            // with the renderer visual). Live-stream protection: if the machine
            // state agrees with the renderer's visual, the visual is live and the
            // base `neutralResetPriority` is kept so the live stream is NOT
            // displaced. One-shots, locomotion, and ambient visuals are never
            // raised (they either carry finite durations or come from non-agent
            // sources — see `clearingPriorityForStuckRenderer` for the exact
            // gate). Without this, a `stopGenerating` mid-stream strands the pet
            // in the sustained `.speaking` pose indefinitely: the streaming
            // funnel keeps writing `.speaking` p60/nil-duration, every clearing
            // path caps at p59, the renderer FSM rejects, and the
            // reconcile-stuck path retries the futile p59 pair forever (the
            // p60-nil is permanently unclearable).
            let clearingPriority = clearingPriorityForStuckRenderer(nowDate: nowDate)
            intent = CharacterAnimationIntent(
                state: baseIntent.state,
                emotion: baseIntent.emotion,
                locomotionDirection: baseIntent.locomotionDirection,
                speedTier: baseIntent.speedTier,
                speedPointsPerSecond: baseIntent.speedPointsPerSecond,
                intensity: baseIntent.intensity,
                priority: clearingPriority,
                interruptPolicy: .interruptLowerPriority,
                duration: configuration.policy.neutralResetDuration,
                source: baseIntent.source,
                createdAt: baseIntent.createdAt)
        } else {
            intent = baseIntent
        }

        // R1-6 minimum dwell + debounce:
        //  - Demotions (semantic becomes lower priority than the last dispatched) are deferred
        //    until `sustainedMinDwell` has elapsed in the current state; promotions and one-shots
        //    (success/failure/recovery) are never deferred.
        //  - Identical semantic + identical resolved intent → no dispatch.
        let lastSem = state.derivedVisualSemantic
        // R2-9: the dwell base is the timestamp of the LAST DISPATCHED sustained
        // semantic, not `state.lastEnteredStateAt` (which gets clobbered by every
        // `fire()` advance). Without this, an event-adjacent demotion (fire(.finished)
        // immediately followed by a derivate demotion) measures dwell-elapsed ≈ 0
        // and is always deferred, even though the sustained semantic has been
        // visible for the full dwell window.
        let dwellBase = demotionBase ?? lastDispatchedSustainedAt ?? state.lastEnteredStateAt
        let dwellOK = (lastSem == nil) ||
            nowDate.timeIntervalSince(dwellBase) >= configuration.policy.sustainedMinDwell
        let isDemotion: Bool = {
            guard let lastSem else { return false }
            let lastPrio = priorityForSemantics(lastSem, policy: configuration.policy, reduceMotion: state.reduceMotion)
            let nextPrio = priorityForSemantics(semantic, policy: configuration.policy, reduceMotion: state.reduceMotion)
            return nextPrio < lastPrio
        }()
        let isOneShot: Bool = {
            switch semantic {
            case .success, .failure, .recovery: return true
            default: return false
            }
        }()
        // R2-1: clearing dispatches ignore dwell (they explicitly want to clear NOW).
        let deferredDemotion = !clearing && isDemotion && !dwellOK && !isOneShot
        if let lastSem, lastSem == semantic,
           let lastIntent = state.lastDispatchedIntent,
           intentEquivalent(lastIntent, intent) {
            // Debounce: no semantic change, no intent change → skip.
            return
        }
        if deferredDemotion {
            // R2-9: track the pending demotion so the 1 Hz tick retries it once
            // the dwell window has elapsed. Without this, event-adjacent demotions
            // (fire(.finished) → derivate demotion) are silently dropped because
            // `fire()` resets `lastEnteredStateAt` immediately before the derivate
            // measures it.
            pendingDemotion = semantic
            pendingDemotionDwellBase = dwellBase
            return
        }
        applyIntent(intent)
        state.derivedVisualSemantic = semantic
        state.lastEnteredStateAt = nowDate
        state.lastDispatchedIntent = intent
        if !isOneShot {
            // R2-9: only sustained semantically-mapped intents reset the dwell
            // base for the next demotion. One-shots have their own duration and
            // don't block subsequent demotions.
            self.lastDispatchedSustainedAt = nowDate
        }
        // R2-9: a successful dispatch clears the pending demotion.
        pendingDemotion = nil
        pendingDemotionDwellBase = nil
        // R1-9 edge-detect engage.
        let engaged = engagedSet.contains(advancer.currentState)
        if engaged != lastEngagedState {
            lastEngagedState = engaged
            onPresenceEngage?(engaged)
        }
    }

    /// R2-9: replay a pending demotion once the dwell window has elapsed. Called
    /// from `tickOneSecond` so event-adjacent demotions don't get silently dropped.
    private func replayPendingDemotion(nowDate: Date) {
        guard let pending = pendingDemotion,
              let base = pendingDemotionDwellBase else { return }
        // R3-3: only dispatch once the FULL dwell window has elapsed
        // against the original sustained semantic's dwell base. Without
        // this, an event-adjacent demotion deferred at dwell≈0 (e.g.
        // working dispatched at t0, fast terminal at t0+0.05) replays at
        // the next tick (≤1 s later), letting the sustained semantic
        // display as little as ~0-1 s instead of the contracted
        // sustainedMinDwell (1.5 s). This is a bounded violation of
        // the R1-6 anti-thrash dwell contract.
        guard nowDate.timeIntervalSince(base) >= configuration.policy.sustainedMinDwell else {
            return
        }
        // R2-1 + R2-10: a replayed pending demotion is necessarily a demotion from
        // a higher-priority sustained state. Use `clearing: true` so the
        // neutral-reset intent (p59) is dispatched instead of the plain semantic
        // intent (e.g. idle p10) — the renderer FSM priority arbitration at
        // `CharacterAnimationStateMachine.apply:30` would otherwise reject the
        // reissue against any stuck working p55 / review p58 / waiting p50
        // visual and the demotion would silently fail (the exact R2-10 defect
        // the reviewer flagged in `testMinimumDwellDefersDemotion`).
        dispatchSemantic(pending, nowDate: nowDate, clearing: true, demotionBase: base)
    }

    /// Compare two intents for the purpose of debounce (same effective renderer request).
    /// Compares state + priority + duration; intentionally ignores emotion/intensity/source
    /// because those vary per dispatch context but represent the same presence signal.
    private func intentEquivalent(_ a: CharacterAnimationIntent, _ b: CharacterAnimationIntent) -> Bool {
        a.state == b.state && a.priority == b.priority && (a.duration ?? -1) == (b.duration ?? -1)
    }

    /// Resolve the priority of a semantic, mirroring `CharacterPresenceMapping.intent`.
    private func priorityForSemantics(_ semantic: CharacterPresenceSemantic,
                                      policy: CharacterPresencePolicy,
                                      reduceMotion: Bool) -> Int {
        switch semantic {
        case .idle: return CharacterAnimationIntent.defaultPriority(for: .idle)
        case .attentiveLite, .attentive: return policy.priorityListening
        case .thinking: return policy.priorityThinking
        case .working: return policy.priorityWorking
        case .review: return policy.priorityReview
        case .waiting: return policy.priorityWaiting
        case .speaking: return policy.prioritySpeaking
        case .success: return policy.prioritySuccess
        case .failure: return policy.priorityFailure
        case .recovery: return policy.priorityReactionBeat
        case .sleeping: return policy.prioritySleeping
        }
    }

    private func fireRecovery(reason: RecoverReason, nowDate: Date) async {
        // Used for stale-state sweep: produces a brief recovery beat before transitioning to idle.
        _ = await advancer.advance(.interrupt)
        var ctx = CharacterPresenceRenderContext(reduceMotion: state.reduceMotion)
        ctx.createdAt = nowDate.timeIntervalSinceReferenceDate
        applyIntent(mapping.intent(for: .recovery, context: ctx))
        _ = await advancer.advance(.recovered)
    }

    private enum RecoverReason { case stale, cancel, failure }

    private func fire(_ event: CharacterBehaviorEvent,
                      now nowDate: Date,
                      visualIntent: CharacterPresenceSemantic? = nil,
                      clearing: Bool = false) async {
        _ = await advancer.advance(event)
        state.machineState = advancer.currentState
        state.lastEnteredStateAt = nowDate
        if let visualIntent {
            // R2-1: clearing=true is forwarded through dispatchSemantic so the
            // demotion chain (engaged → .idle) and the trap-state exit
            // (.interrupted / .errorRecovery → .idle via .recovered) both raise
            // the intent priority to `neutralResetPriority` (p59) and clear any
            // stuck sustained visual within one beat.
            dispatchSemantic(visualIntent, nowDate: nowDate, clearing: clearing)
        }
    }

    /// Emit the optional wake-greet one-shot, gated by `greetOnWakeCooldown`. Called from
    /// `deriveEvents` wake path so a fresh wake does not spam the user with greetings.
    /// R3-2: returns whether the greet was actually dispatched so the wake path can skip
    /// the clearing wake visual when greet just won against the sleeping visual
    /// (otherwise the clearing p59 would immediately override greet p44 and the
    /// one-shot would be invisible).
    ///
    /// R5-5: pre-applies a plain `.idle` anchor with `.alwaysInterrupt` BEFORE
    /// the greet so the renderer's `lastStableState` becomes `.idle`
    /// (instead of `.sleeping` from the pre-wake state). When the greet
    /// one-shot expires 0.72 s later, the FSM's
    /// `nextStateAfterExpiring(.greet)` returns `lastStableState` —
    /// which is now `.idle` — so the renderer stays at `.idle` instead
    /// of regressing to the just-exited `.sleeping` pose for the ≤1 s
    /// gap before the next reconcile tick. The two `applyIntent` calls
    /// happen synchronously within the same coordinator hop so the
    /// brief `.idle` between them is never rendered (the FSM's
    /// `apply` is synchronous and `update(now:)` is only called from
    /// `PetScene.update` between hops).
    @discardableResult
    private func emitOptionalWakeGreet(nowDate: Date) async -> Bool {
        let last = state.lastGreetAt
        let cooldownOK = (last == nil) ||
            (nowDate.timeIntervalSince(last!) >= configuration.policy.greetOnWakeCooldown)
        guard cooldownOK else { return false }
        let n = nowDate.timeIntervalSinceReferenceDate
        // Plain `.idle` anchor — `.alwaysInterrupt` forces the state
        // transition regardless of the sleeping p40 the renderer
        // currently holds. `lastStableState` is updated to `.idle`
        // (because `.idle` is stable per `isStable(_:)`); the next
        // apply — the greet — keeps `.idle` as `lastStableState`
        // (because `.greet` is not stable).
        applyIntent(CharacterAnimationIntent(state: .idle,
                                             emotion: .neutral,
                                             priority: CharacterAnimationIntent.defaultPriority(for: .idle),
                                             interruptPolicy: .alwaysInterrupt,
                                             source: .agentRuntime,
                                             createdAt: n))
        applyIntent(mapping.wakeGreet(now: n))
        state.lastGreetAt = nowDate
        return true
    }

    private func driveInitialStart(nowDate: Date) async {
        await deriveAndDispatch(reason: .initial, nowDate: nowDate)
    }

    // MARK: - Reconcile + sleep + stale

    private func reconcile(nowDate: Date) async {
        // R1-2: real reconciliation — every 1 Hz tick, compare the sustained semantic's resolved
        // intent vs. the renderer's currently-applied intent (via the configured seam). If the
        // renderer has drifted, dispatch the sustained semantic intent.
        //
        // R2-1: when the divergence is a stuck sustained visual (renderer's current intent
        // priority > the semantic's normal intent priority), the dispatch routes through
        // `clearing=true` so the intent is raised to `neutralResetPriority` (p59). The
        // clearing intent carries a short `neutralResetDuration` (0.20 s) so it expires
        // quickly and does not block legitimate lower-priority writers (locomotion reassert
        // p30, blink p12, idle look-around p12) for longer than one beat. Locomotion reassert
        // is gated by `priority >= 50` so it does NOT trigger clearing and the walk visual
        // wins the FSM arbitration correctly.
        guard let reader = reconciliationRendererIntent ?? configuration.currentRendererIntent else { return }
        let rendererIntent = reader()
        let machine = advancer.currentState
        let n = nowDate
        let semantic: CharacterPresenceSemantic?
        switch machine {
        case .idle, .observing, .dormant: semantic = .idle
        case .listening: semantic = snapshot.chatAttentive ? .attentive : .attentiveLite
        case .thinking: semantic = .thinking
        case .acting:
            let hasSynth = snapshot.activeTasks.contains { $0.status == .synthesizing }
            semantic = hasSynth ? .review : .working
        case .speaking: semantic = .speaking
        case .waitingForPermission: semantic = .waiting
        case .interrupted, .errorRecovery: semantic = .recovery
        case .sleeping: semantic = .sleeping
        }
        guard let semantic else { return }
        let expectedState = Self.rendererState(forSemantic: semantic, reduceMotion: state.reduceMotion)
        if let rendererIntent, rendererIntent.state == expectedState {
            // Renderer already on the expected state — no divergence, no dispatch.
            return
        }
        var ctx = CharacterPresenceRenderContext(reduceMotion: state.reduceMotion)
        ctx.createdAt = n.timeIntervalSinceReferenceDate
        let sustained = mapping.intent(for: semantic, context: ctx)
        // R2-1: clearing gate — fire the high-priority clearing intent when the
        // renderer's current intent is actually stuck above the semantic's normal
        // priority. Locomotion reassert (p35), blink (p14), idle look-around (p13)
        // are correctly NOT cleared because their priorities are below the
        // SEMANTIC's priority (listening p45, sleeping p40, working p55, …).
        //
        // R3-1: previously the stuck gate used a fixed `>= 50` threshold
        // (designed to also exclude locomotion p30). That threshold
        // missed the listening p45 / sleeping p40 cases — exactly the
        // sustained visuals the chat-hide dwell-elapsed dispatch can
        // strand (idle p10 → listening/sleeping rejected → reconcile
        // reissues plain semantic → rejected again forever). Compare
        // against the SEMANTIC's own priority (so any higher-than-semantic
        // visual triggers the clear) so the chat-hide self-heals on the
        // next reconcile tick even if the dispatch chain drops the
        // clearing flag.
        //
        // R4-1: the stuck gate MUST only fire on genuinely-stuck AGENT
        // sustained visuals — never on locomotion (walk p35), ambient
        // (blink p14 / idleLookAround p13) or in-flight one-shots
        // (jump / greet / taskFailed / reacting / landing). Without this
        // restriction the reconcile-stuck path murders every wander
        // walk visual within one tick (p35 walk > p10 idle semantic
        // would otherwise trigger a p59 idle clear that the FSM
        // applies; the walk reassert at p35 is then rejected against
        // the sticky p59 floor forever and the pet glides in idle
        // pose). The four conjunctive tests:
        //
        //   1. priority > semanticPriority (the original R3-1 comparison)
        //   2. rendererIntent.duration == nil (one-shots carry finite
        //      durations and expire naturally — see R4-3 for the
        //      explicit non-expired one-shot exemption; this is the
        //      sustained-only half of the same check)
        //   3. rendererIntent.source == .agentRuntime (locomotion writes
        //      come from .desktopInteraction; ambient writes come from
        //      .rendererFallback; the clear must never displace them)
        //   4. rendererIntent.state is one of the agent-sustained set
        //      {listening, thinking, speaking, taskWaiting, taskRunning,
        //      taskReview, sleeping} (excludes every locomotion, ambient
        //      and one-shot state by enumeration)
        let semanticPriority = priorityForSemantics(semantic,
                                                     policy: configuration.policy,
                                                     reduceMotion: state.reduceMotion)
        let rendererPriority = rendererIntent?.priority ?? 0
        let isAgentRuntimeSustained = rendererIntent.map {
            $0.source == .agentRuntime &&
            Self.agentSustainedStates.contains($0.state) &&
            $0.duration == nil
        } ?? false
        let stuck = rendererPriority > semanticPriority && isAgentRuntimeSustained
        if stuck {
            // R4-2: the clearing intent now carries the SHORT
            // `neutralResetDuration` (0.20 s) AND is immediately followed
            // in the SAME tick by the plain sustained intent at its
            // natural priority. The old R3-4 no-duration variant created
            // a permanent p59 floor (FSM `update(now:)` never expires a
            // nil-duration intent) that froze every ambient blink /
            // idleLookAround / listening / sleeping / task* dispatch
            // (priorities all < 59) behind it for as long as the pet
            // stayed in the same machine state — up to 1 s of visual
            // dead-time on every engagement transition plus a permanent
            // starvation of the ambient idle life. The new sequence is:
            //
            //   1. clearing intent at p59 / neutralResetDuration — beats
            //      the stuck sustained visual, expires after 0.20 s.
            //   2. plain sustained intent at its natural priority —
            //      re-asserted in the same tick so it can take over the
            //      slot the clearing just vacated. The plain re-issue
            //      uses `.replaceSameKind` so the FSM's same-state
            //      priority bypass lets it land even though the clearing
            //      has p59 > plain's natural priority. Legitimate
            //      higher-priority writers (jump p68, taskFailed p70)
            //      still beat the clearing via `.interruptLowerPriority`.
            //      Self-keep semantics for sustained states live in
            //      `nextStateAfterExpiring` so the clearing expiry
            //      doesn't bounce through lastStableState.
            //
            // The combination (short-duration clearing + immediate plain
            // follow-up) restores the R2-1 contract (clear the stuck
            // visual within one beat) AND the R1-2 contract (every
            // reconcile tick re-issues the sustained semantic at its
            // natural priority so writers aren't locked out).
            // R5-1: the reconcile stuck clearing path also raises above the
            // stuck renderer priority when the renderer is provably stale
            // (machine != renderer state). Mirrors `dispatchSemantic`'s
            // clearing branch — live-stream protection: a live stream
            // (machine == .speaking) keeps the base p59 so the stream is
            // NOT displaced.
            let stuckClearingPriority = clearingPriorityForStuckRenderer(nowDate: n)
            let clearing = CharacterAnimationIntent(
                state: sustained.state,
                emotion: sustained.emotion,
                locomotionDirection: sustained.locomotionDirection,
                speedTier: sustained.speedTier,
                speedPointsPerSecond: sustained.speedPointsPerSecond,
                intensity: sustained.intensity,
                priority: stuckClearingPriority,
                interruptPolicy: .interruptLowerPriority,
                // R4-2: SHORT `neutralResetDuration` (0.20 s) so the
                // clearing intent is NOT a permanent priority floor.
                // The plain sustained re-issue below takes over the
                // slot within the same beat.
                duration: configuration.policy.neutralResetDuration,
                source: sustained.source,
                createdAt: sustained.createdAt)
            applyIntent(clearing)
            // R4-2: re-issue the plain sustained intent at its natural
            // priority in the SAME tick with `.replaceSameKind`. The FSM
            // arbitration (`CharacterAnimationStateMachine.apply:31-32`)
            // skips the priority check when the incoming intent's state
            // matches the current intent's state, so the plain re-issue
            // is accepted even though its priority is below the
            // clearing's p59. The renderer lands on the target sustained
            // state within the same apply pair; subsequent legitimate
            // lower-priority writers (blink / idleLookAround / walk
            // reassert) are accepted as soon as the clearing priority
            // drops 0.20 s later. No idle flash, no priority floor.
            var plainReissue = sustained
            plainReissue.interruptPolicy = .replaceSameKind
            applyIntent(plainReissue)
        } else {
            applyIntent(sustained)
        }
    }

    /// R4-1: agent-sustained renderer states eligible for the reconcile-stuck
    /// clearing path. Excludes locomotion (start/walk/brisk/run/stop/turn),
    /// ambient (blink / idleLookAround / look_*), and one-shots (jump /
    /// greet / taskFailed / reacting / landing). The stuck gate is
    /// conjunctive with `source == .agentRuntime && duration == nil` so the
    /// enumeration here is defensive against any future state additions.
    ///
    /// R5-3: `.look1125` is included so the reconcile backstop covers a
    /// stranded RM `.thinking` pose. Under Reduce Motion, semantic
    /// `.thinking` maps to `.look1125` p50/nil-duration (a sustained
    /// visual — same shape as the non-RM `.thinking` p50/nil-duration).
    /// Without `.look1125` in this set, a stranded RM thinking pose
    /// would silently bypass the backstop and remain uncleared (the
    /// FSM rejects every lower-priority reissue — the same defect the
    /// R4-1 set was created to close). All other `.look_*` states
    /// remain excluded: they are ambient gaze one-shots the renderer
    /// scheduler drives, not coordinator-sustained visuals.
    private static let agentSustainedStates: Set<CharacterAnimationState> = [
        .listening, .thinking, .speaking,
        .taskWaiting, .taskRunning, .taskReview,
        .sleeping,
        .look1125
    ]

    /// R5-1: inverse of `rendererState(forSemantic:reduceMotion:)` — map
    /// a renderer state back to the machine state it represents. Returns
    /// `nil` for locomotion, ambient, and one-shot states (none of
    /// which represent a machine state — they are either
    /// writer-originated or transient overlays and are explicitly
    /// excluded from the clearing raise gate).
    private static func machineState(forRendererState renderer: CharacterAnimationState,
                                     reduceMotion: Bool) -> CharacterBehaviorState? {
        switch renderer {
        case .speaking: return .speaking
        case .thinking, .look1125: return .thinking
        case .taskRunning, .taskReview: return .acting
        case .taskWaiting: return .waitingForPermission
        case .listening: return .listening
        case .sleeping: return .sleeping
        default: return nil
        }
    }

    /// R5-1: compute the priority to use for a clearing intent that must
    /// displace the renderer's currently-stuck sustained visual. Returns
    /// `max(neutralResetPriority, rendererPriority + 1)` when the renderer
    /// holds a sustained agent visual that the machine has provably LEFT
    /// (live-stream protection: if the machine state still agrees with
    /// the renderer state, the visual is live and the base
    /// `neutralResetPriority` is returned so the live stream is NOT
    /// displaced). One-shots, locomotion, and ambient visuals never
    /// raise — they either carry finite durations or come from
    /// non-agent sources. When no renderer seam is configured (e.g.
    /// unit tests without a renderer back-reference) the base
    /// priority is returned.
    private func clearingPriorityForStuckRenderer(nowDate: Date) -> Int {
        let base = configuration.policy.neutralResetPriority
        guard let reader = reconciliationRendererIntent ?? configuration.currentRendererIntent else {
            return base
        }
        guard let rendererIntent = reader() else { return base }
        // Only raise for sustained agent visuals (one-shots expire naturally
        // via `update(now:)` in the renderer FSM).
        guard rendererIntent.duration == nil,
              rendererIntent.source == .agentRuntime,
              Self.agentSustainedStates.contains(rendererIntent.state) else {
            return base
        }
        // Live-stream protection: if the machine is still in the state the
        // renderer's visual represents, the visual is live — don't displace
        // it. Stale-stream healing: if the machine has left the renderer's
        // state, the visual is stale (e.g. streaming response ended but the
        // renderer's nil-duration p60 intent never expired) and must be
        // displaced.
        guard let rendererMachine = Self.machineState(forRendererState: rendererIntent.state,
                                                       reduceMotion: state.reduceMotion) else {
            return base
        }
        if rendererMachine == advancer.currentState {
            return base  // LIVE — keep the base priority.
        }
        // STALE — raise above the stuck renderer priority.
        return max(base, rendererIntent.priority + 1)
    }

    /// Maps a presence semantic to the renderer state it would produce (mirroring
    /// `CharacterPresenceMapping.intent` decisions — keep in sync).
    static func rendererState(forSemantic semantic: CharacterPresenceSemantic,
                              reduceMotion: Bool) -> CharacterAnimationState {
        switch semantic {
        case .idle: return .idle
        case .attentiveLite, .attentive: return .listening
        case .thinking: return reduceMotion ? .look1125 : .thinking
        case .working: return .taskRunning
        case .review: return .taskReview
        case .waiting: return .taskWaiting
        case .speaking: return .speaking
        case .success: return .jump
        case .failure: return .taskFailed
        case .recovery: return .reacting
        case .sleeping: return .sleeping
        }
    }

    private func staleSweep(nowDate: Date) async {
        let machine = advancer.currentState
        let anyTask = !snapshot.activeTasks.isEmpty || !snapshot.waitingTasks.isEmpty
        // R2-3: trap-state exit on the 1 Hz tick. .interrupted / .errorRecovery
        // (entered via a failed/cancelled terminal with no subsequent store/chat
        // event) would otherwise strand the machine indefinitely while reconcile
        // re-applies a 0.30 s reacting one-shot every tick → a perpetual twitch.
        // Fire the recovery chain to advance the machine to .idle and dispatch
        // the clearing visual (R2-1).
        if (machine == .interrupted || machine == .errorRecovery),
           !anyTask, !snapshot.isResponding {
            await applyEngagementTransition(from: machine, to: .idle, nowDate: nowDate)
            return
        }
        // R1-1 / R1-7: stale sweep is gated on TASK-originated engaged states (not listening).
        // Chat-only engagement (listening with chat open) is kept; the chat-hide falling-edge
        // (in ingestChatChange) clears it explicitly when chat closes. Without this gate the
        // sweep wrongly fired `.finished` every tick after chat expanded, even though the user
        // was actively reading the chat panel.
        if !anyTask, !snapshot.isResponding, taskEngagedSet.contains(machine) {
            _ = await advancer.advance(.finished)
            // R2-1: staleSweep dispatches the corrective visual with clearing=true so
            // the neutral-reset intent (p59, 0.20 s) clears any stuck taskRunning p55 /
            // taskReview p58 / taskWaiting p50 visual. Without clearing, the post-sweep
            // semantic intent (idle p10 / listening p45) is rejected by the renderer's
            // FSM priority arbitration and the stale visual persists indefinitely.
            state.machineState = advancer.currentState
            // Compute a "post-sweep" expected semantic based on chat presence — listening if
            // chat is still engaged, else idle.
            let postSemantic: CharacterPresenceSemantic
            if snapshot.chatAttentive {
                postSemantic = .attentive
            } else if snapshot.chatEngaged {
                postSemantic = .attentiveLite
            } else {
                postSemantic = .idle
            }
            dispatchSemantic(postSemantic, nowDate: nowDate, clearing: true)
        }
    }

    private func maybeSleep(nowDate: Date) async {
        let machine = advancer.currentState
        let anyTask = !snapshot.activeTasks.isEmpty || !snapshot.waitingTasks.isEmpty
        if machine != .idle { return }
        if anyTask { return }
        if snapshot.chatEngaged { return }
        if snapshot.isResponding { return }
        let n = nowDate
        // R1-3: include all wake-source timestamps so chat-typing and post-task falling edges
        // also keep the pet awake. The original code only considered userInteraction + tasks.
        // R2-13: the `anyTask ? lastTaskActivityAt : nil` disjunct is dead — after the
        // `if anyTask { return }` gate above, `anyTask` is always false and the disjunct
        // resolves to `nil`. Drop it.
        let candidates: [Date] = [
            lastUserInteractionAt,
            lastChatVisibilityChangeAt,
            lastRespondingFallingEdgeAt
        ].compactMap { $0 }
        let lastInteraction = candidates.max() ?? n
        if n.timeIntervalSince(lastInteraction) >= configuration.policy.sleepAfterThreshold {
            // R1-3: dispatch the .sleeping visual + onPresenceEngage so the renderer
            // falls into the sleeping pose and the wander gate closes (overlayed via
            // edge-detected onPresenceEngage callback).
            await fire(.sleep, now: n, visualIntent: .sleeping)
        }
    }
}
