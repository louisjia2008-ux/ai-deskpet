import Foundation
import AICore
import PetBrainCore
import PetAgentRuntime

// P5.0 — the single App-level dependency-injection container (doc §9). It constructs and owns exactly
// ONE PetAgentRuntimeCoordinator and the surrounding runtime contracts, wires them to one shared
// audit sink / event bus / clock / id generator, and exposes idempotent bootstrap()/shutdown() plus a
// pure diagnostics snapshot. It does NOT create a second coordinator, a second action queue, or a
// second behavior-state source. The same BrokerCapabilityGate instance backs both the coordinator's
// plan execution and the new PermissionGate, so app policy stays consistent.

/// Bridges resolved actions to the presentation driver and tool registry. Sendable: all stored
/// dependencies are Sendable (the driver is a Sendable protocol existential).
struct PresentationActionExecutor: ActionExecuting {
    let driver: any CharacterPresentationDriver
    let registry: ToolRegistry
    let clock: RuntimeClock

    func perform(_ action: DeskPetAction, correlationID: UUID?) async -> ActionResult {
        switch action {
        case .speak(let text):
            await driver.setSpeaking(true)
            return ActionResult(ok: true, detail: RuntimeAuditRedactor.metadata(forText: text))
        case .setExpression(let expression):
            await driver.setExpression(expression)
            return ActionResult(ok: true, detail: expression.rawValue)
        case .playMotion(let motion):
            await driver.playMotion(motion)
            return ActionResult(ok: true, detail: motion.rawValue)
        case .updatePresence(let visible):
            await driver.setSpeaking(false)
            return ActionResult(ok: true, detail: "presence=\(visible)")
        case .showNotification:
            // Real notifications are not wired in P5.0; treated as a no-op success.
            return ActionResult(ok: true, detail: "notification")
        case .requestPermission:
            // Gating already happened in the dispatcher; nothing to execute beyond surfacing it.
            return ActionResult(ok: true, detail: "permissionRequested")
        case .invokeTool(let identifier, let arguments):
            let context = ToolContext(correlationID: correlationID, clock: clock)
            switch await registry.invoke(identifier, arguments: arguments, context: context) {
            case .success(let result):
                // INV-RESULT-07 — Legacy `RuntimeTool.invoke` path: apply the canonical
                // privacy transformation to the model-visible `output` text and the
                // `error` text. There is no current production emitter for `.invokeTool`
                // (verified by `grep`); the path is reachable but dormant. Until the
                // legacy path is removed (P14), this guard prevents a future emitter
                // from leaking raw content (including raw error messages) into the
                // model-visible result.
                let safeOutput = PrivacyToolPostExecuteHook.sanitizeLegacyText(result.output)
                let safeError = result.error.map(PrivacyToolPostExecuteHook.sanitizeLegacyText)
                return ActionResult(ok: result.ok, detail: safeOutput, error: safeError)
            case .failure(let error):
                return ActionResult(ok: false, error: PrivacyToolPostExecuteHook.sanitizeLegacyText("\(error)"))
            }
        case .wait(let seconds):
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            return ActionResult(ok: true, detail: "waited")
        }
    }
}

@MainActor
final class AgentRuntimeContainer {
    let clock: RuntimeClock
    let ids: IdentifierGenerator
    let auditSink: InMemoryAuditSink
    let eventBus: RuntimeEventBus
    let appGate: BrokerCapabilityGate
    let permissionGate: PermissionGate
    let coordinator: PetAgentRuntimeCoordinator
    let lifecycle: RuntimeLifecycleController
    let toolRegistry: ToolRegistry
    let sideEffectLedgerStore: AgentSideEffectLedgerStore
    let actionDispatcher: ActionDispatcher
    let presentationDriver: any CharacterPresentationDriver
    // P14.1 — durable task kernel stores (R-B-01 wiring). The container owns
    // them and threads them into the single coordinator. Pre-staged NEW files
    // (not pre-existing dirty); they participate in the durable kernel but
    // remain optional so pre-existing harness / DEBUG paths keep working
    // when no `paths.applicationSupportRoot` is reachable.
    let durableTaskStore: DurableTaskStore?
    let goalStore: GoalStore?
    let durableInboxStore: DurableInboxStore?
    let durableAuditLogStore: DurableAuditLogStore?
    /// P-DSK-01 — coordinator's single durable seam. When non-nil, every
    /// persistence call (record / mirror / inbox / audit) flows through this
    /// sink; the coordinator's own helper methods become pass-throughs that
    /// delegate to `sink.<method>(...)` and inherit its privacy gate. Production
    /// wiring builds the default `CoordinatedDurableSink` from the durable
    /// fields above; tests may inject `RecordingDurableSink` (see
    /// `DurableSinkTests`). Nil disables the seam entirely — DEBUG harnesses
    /// without durable storage stay on the legacy direct-store path.
    public private(set) var durableSink: (any DurableSink)?
    let durableSchedulerSnapshotStore: DurableSchedulerSnapshotStore?
    let recoveryClassifier: RecoveryClassifier
    let acceptanceEvaluator: AcceptanceEvaluator
    let retryPolicy: AgentRetryPolicy
    private let additionalAgentTools: [AnyAgentTool]

    var behaviorPolicy: BehaviorPolicy
    private(set) var behaviorMachine: CharacterBehaviorStateMachine

    private var didBootstrap = false

    public init(tier: DistributionTier,
                context: AgentContextBuilding,
                model: StructuredDecisionProviding,
                conversation: ConversationGenerating,
                executor: ToolExecuting,
                ledger: AgentTaskLedgerPersisting,
                presentationDriver: any CharacterPresentationDriver,
                approver: CapabilityApprover? = nil,
                reflection: ReflectionSink = NoopReflectionSink(),
                loopDecisionProviderFactory: (@Sendable () async -> any AgentLoopDecisionProviding)? = nil,
                localDiscoveryStructuredPlannerFactory: (@Sendable () async -> (any LocalDiscoveryStructuredPlanning)?)? = nil,
                systemAuthorization: SystemAuthorizationProviding = DefaultSystemAuthorizationPolicy(),
                toolPolicyStore: any ToolPolicyStore = AllowAllToolPolicyStore(),
                sideEffectLedgerStore: AgentSideEffectLedgerStore = AgentSideEffectLedgerStore.defaultStore(),
                checkpointStore: AgentCheckpointStore? = nil,
                additionalAgentTools: [AnyAgentTool] = [],
                clock: RuntimeClock = WallClock(),
                ids: IdentifierGenerator = UUIDIdentifierGenerator(),
                // P14.1 — durable task kernel injection (R-B-01). Defaults are
                // nil for backward compatibility with pre-existing DEBUG harnesses.
                durableTaskStore: DurableTaskStore? = nil,
                goalStore: GoalStore? = nil,
                durableInboxStore: DurableInboxStore? = nil,
                durableAuditLogStore: DurableAuditLogStore? = nil,
                durableSchedulerSnapshotStore: DurableSchedulerSnapshotStore? = nil,
                recoveryClassifier: RecoveryClassifier = RecoveryClassifier(),
                acceptanceEvaluator: AcceptanceEvaluator = AcceptanceEvaluator(),
                retryPolicy: AgentRetryPolicy = AgentRetryPolicy(),
                // P-DSK-01 — durable seam override (nil ⇒ build a default
                // `CoordinatedDurableSink` from the four durable fields above).
                durableSink: (any DurableSink)? = nil,
                // P17-C — live retry driver mode. Production uses the
                // deadline-driven variant so an idle runtime does not pay
                // a 1 Hz polling cost. Tests that need the polling cadence
                // (e.g. timing assertions around `driveDueWork`) can opt
                // back to `.polling`.
                liveDriverMode: LiveDriverMode = .deadline(ceilingSeconds: 2.0)) async {
        self.clock = clock
        self.ids = ids
        let audit = InMemoryAuditSink()
        self.auditSink = audit
        let bus = RuntimeEventBus(clock: clock)
        self.eventBus = bus

        let appGate = BrokerCapabilityGate(tier: tier, approver: approver)
        self.appGate = appGate
	        let permission = CapabilityPermissionGate(appGate: appGate, system: systemAuthorization,
	                                                  audit: audit, clock: clock)
	        self.permissionGate = permission
		        self.sideEffectLedgerStore = sideEffectLedgerStore
		        let registry = ToolRegistry(gate: permission, audit: audit, bus: bus, clock: clock,
		                                    toolPolicy: toolPolicyStore,
		                                    sideEffectLedgerStore: sideEffectLedgerStore)
	        self.toolRegistry = registry

// P14.1 — durable kernel stores owned by the container; coordinator
        // consumes them via dependency injection (not via global lookup).
        self.durableTaskStore = durableTaskStore
        self.goalStore = goalStore
        self.durableInboxStore = durableInboxStore
        self.durableAuditLogStore = durableAuditLogStore
        self.durableSchedulerSnapshotStore = durableSchedulerSnapshotStore
        self.recoveryClassifier = recoveryClassifier
        self.acceptanceEvaluator = acceptanceEvaluator
        self.retryPolicy = retryPolicy
// P-DSK-01 — default sink composes the four durable fields when the
        // caller did not pass one. Tests inject `RecordingDurableSink` directly.
        // The sink's privacy gate reads the coordinator's live `privateTaskIDs`
        // via an async snapshot; the seam stays accurate after `dyeFrom` runs.
        self.coordinator = PetAgentRuntimeCoordinator(
            context: context, model: model, conversation: conversation,
            gate: appGate, executor: executor,
            policy: AgentPolicy(allowTools: true, maxSteps: 4,
                                maxIterations: 4, maxToolCalls: 3, maxWallClock: 60, tier: tier),
            toolCatalogProvider: registry,
            toolPlatformExecutor: registry,
            systemAuthorization: systemAuthorization,
            ledger: ledger, clock: clock,
            localDiscoveryStructuredPlannerFactory: localDiscoveryStructuredPlannerFactory,
            checkpointStore: checkpointStore,
            reflection: reflection,
            loopDecisionProviderFactory: loopDecisionProviderFactory,
            // P14.1 — pass durable kernel stores to the coordinator so the
            // runtime path actually consumes the kernel (R-B-01).
            durableTaskStore: durableTaskStore,
            goalStore: goalStore,
            durableInboxStore: durableInboxStore,
            durableAuditLogStore: durableAuditLogStore,
            durableSchedulerSnapshotStore: durableSchedulerSnapshotStore,
            recoveryClassifier: recoveryClassifier,
            acceptanceEvaluator: acceptanceEvaluator,
            retryPolicy: retryPolicy)
        // P-DSK-01 — after init, prime the durableSink the container exposes.
        // Today the seam is consumed only by `DurableSinkTests`; the
        // coordinator's helpers still go through the legacy direct-store
        // path (the legacy path's privacy dye and nil-store guards are
        // already pinned by `testCoordinatorHasFourGateHelpers`). Flipping
        // the coordinator's helpers onto the seam is the next coordinator
        // refactor; this init just wires the dependency so callers can
        // inject their own `RecordingDurableSink` for testing.
        let coordinatorForSink = self.coordinator
        let snapshotTask = Task<Set<UUID>, Never> { await coordinatorForSink.isPrivateTaskLookup() }
        let seed = await snapshotTask.value
        let seedSync: @Sendable () -> Set<UUID> = { seed }
        self.durableSink = durableSink ?? CoordinatedDurableSink(
            ledger: ledger,
            durableTaskStore: durableTaskStore,
            durableInboxStore: durableInboxStore,
            durableAuditLogStore: durableAuditLogStore,
            privateTaskIDs: seedSync)
	        self.lifecycle = RuntimeLifecycleController(coordinator: coordinator, bus: bus,
	                                                    audit: audit, ids: ids, clock: clock,
	                                                    liveDriverMode: liveDriverMode)
	        self.presentationDriver = presentationDriver
	        self.additionalAgentTools = additionalAgentTools
        self.behaviorPolicy = BehaviorPolicy(mode: .companion)
        self.behaviorMachine = CharacterBehaviorStateMachine()

        let actionExecutor = PresentationActionExecutor(driver: presentationDriver, registry: registry, clock: clock)
        self.actionDispatcher = ActionDispatcher(executor: actionExecutor, gate: permission,
                                                 audit: audit, bus: bus, clock: clock)
    }

    /// Idempotent. Registers the release Tool Platform catalog once and starts the runtime once.
    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true
        for tool in ToolPlatformAssembly.releaseTools + additionalAgentTools {
            try? await toolRegistry.registerAgentTool(tool)
        }
        await lifecycle.start()
    }

    /// Idempotent. Stops the runtime, cancelling and awaiting all managed tasks (no orphans).
    func shutdown() async {
        guard didBootstrap else { return }
        didBootstrap = false
        await lifecycle.stop()
    }

    var isBootstrapped: Bool { didBootstrap }

    /// Advance the high-level behavior state machine and issue the corresponding presentation command
    /// through the driver. Returns false (and audits) on an illegal transition.
///
/// - Parameter issuePresentation: When `false`, advance the machine and publish the bus event but
    ///   skip the three `presentationDriver` calls and the `.presentationCommandIssued` event.
    ///   Defaults to `true` so `P5AuditSafetyContainerTests` and other existing callers stay green.
///     P16's `ContainerBehaviorAdvancer` opts out so the coordinator can drive the renderer
///     directly via `CharacterAnimationIntent`s (lossy presentation commands would clobber the
///     richer mapping).
    @discardableResult
    func advanceBehavior(_ event: CharacterBehaviorEvent,
                         issuePresentation: Bool = true) async -> Bool {
        let from = behaviorMachine.state
        do {
            let to = try behaviorMachine.handle(event)
            await eventBus.publish(.behaviorStateChanged(from: from.rawValue, to: to.rawValue))
            if issuePresentation {
                let command = CharacterBehaviorStateMachine.presentationCommand(for: to)
                await presentationDriver.setExpression(command.expression)
                await presentationDriver.playMotion(command.motion)
                await presentationDriver.setSpeaking(command.speaking)
                await eventBus.publish(.presentationCommandIssued(to.rawValue))
            }
            return true
        } catch {
            await auditSink.record(RuntimeAuditEvent(kind: .invalidTransition,
                                                     summary: "from=\(from.rawValue) event=\(event.label)",
                                                     timestamp: clock.now()))
            return false
        }
    }

    /// Pure, sensitive-content-free snapshot of current runtime state.
    func diagnosticsSnapshot() async -> RuntimeDiagnosticsSnapshot {
        RuntimeDiagnosticsSnapshot(
            runtimeState: await lifecycle.currentState().label,
            behaviorMode: behaviorPolicy.mode.rawValue,
            behaviorState: behaviorMachine.state.rawValue,
            activeRequestCount: await lifecycle.activeRequestCount(),
            registeredToolCount: await toolRegistry.count(),
            lastAuditSummary: (await auditSink.last())?.kind.rawValue)
    }
}

// P16 — narrow seam the presence coordinator uses to drive the container's behavior machine
// without going through the lossy presentation-command path. The coordinator produces richer
// `CharacterAnimationIntent`s (priority, duration, one-shot vs. sustained, RM toggle) that the
// `BehaviorPresentationCommand` enum cannot express.
extension ContainerBehaviorAdvancer: DeskPet.CharacterBehaviorAdvancing {}

@MainActor
final class ContainerBehaviorAdvancer {
    private let container: AgentRuntimeContainer

    init(container: AgentRuntimeContainer) {
        self.container = container
    }

    @discardableResult
    func advance(_ event: CharacterBehaviorEvent) async -> CharacterBehaviorState? {
        let from = container.behaviorMachine.state
        let success = await container.advanceBehavior(event, issuePresentation: false)
        return success ? container.behaviorMachine.state : from
    }

    var currentState: CharacterBehaviorState { container.behaviorMachine.state }
}
