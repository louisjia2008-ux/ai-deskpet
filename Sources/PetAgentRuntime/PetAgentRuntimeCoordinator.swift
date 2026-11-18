import Foundation
import AICore
import PetBrainCore
import os.lock

public struct AgentRunResult: Sendable, Equatable {
    public var presentation: CharacterPresentation?
    public var executedSteps: [String]
    public var deniedSteps: [String]
    public var taskState: AgentTaskState?
    public var proactive: ProactiveDecision?
    public var waitingApproval: [String]
    public var cancelled: Bool
    public var stopReason: AgentLoopStopReason?
    public var observations: [AgentToolObservation]
    public init(presentation: CharacterPresentation? = nil, executedSteps: [String] = [],
                deniedSteps: [String] = [], taskState: AgentTaskState? = nil,
                proactive: ProactiveDecision? = nil, waitingApproval: [String] = [], cancelled: Bool = false,
                stopReason: AgentLoopStopReason? = nil, observations: [AgentToolObservation] = []) {
        self.presentation = presentation; self.executedSteps = executedSteps; self.deniedSteps = deniedSteps
        self.taskState = taskState; self.proactive = proactive; self.waitingApproval = waitingApproval
        self.cancelled = cancelled
        self.stopReason = stopReason; self.observations = observations
    }
}

/// THE single top-level runtime (P4.3). Every user message, proactive candidate, and task event
/// enters here. The model only proposes; every side effect goes through the CapabilityGate; the
/// demoted conversation provider only generates text. No external runtime, no UI, no direct effects.
public actor PetAgentRuntimeCoordinator {

    private let context: AgentContextBuilding
    private let decisionEngine: DecisionEngine
    private let loopDecisionProviderFactory: @Sendable () async -> any AgentLoopDecisionProviding
    var conversation: ConversationGenerating
    private let gate: CapabilityGate
    private let executor: ToolExecuting
    private let toolCatalogProvider: (any ToolCatalogProviding)?
    private let toolPlatformExecutor: (any ToolPlatformExecuting)?
    private let systemAuthorization: any SystemAuthorizationProviding
    private let ledger: AgentTaskLedgerPersisting
    var clock: RuntimeClock
    private let localeProvider: @Sendable () -> Locale
    private let timeZoneProvider: @Sendable () -> TimeZone
    private let localDiscoveryStructuredPlannerFactory: (@Sendable () async -> (any LocalDiscoveryStructuredPlanning)?)?
    private let checkpointStore: AgentCheckpointStore?
    private let policy: AgentPolicy
    private let reflection: ReflectionSink
    private let renderer = CharacterRenderer()
    // P14.1 — durable task kernel stores (R-B-01). Optional so pre-existing
    // DEBUG harnesses that instantiate the coordinator without a durable
    // kernel keep working. When nil, durable mirror writes are no-ops.
    var durableTaskStore: DurableTaskStore?
    private let goalStore: GoalStore?
    private let durableInboxStore: DurableInboxStore?
    private let durableAuditLogStore: DurableAuditLogStore?
    private let durableSchedulerSnapshotStore: DurableSchedulerSnapshotStore?
    private let recoveryClassifier: RecoveryClassifier
    private let acceptanceEvaluator: AcceptanceEvaluator
    /// P-DSK-01 — single durable seam. When non-nil, every persistence call
    /// (record / mirror / inbox / audit) routes through this sink; the four
    /// helper methods below become thin pass-throughs. When nil, the helpers
    /// fall back to the legacy direct-store path (DEBUG harnesses with no
    /// durable kernel).
    public var durableSink: (any DurableSink)?
    var retryPolicy: AgentRetryPolicy
    /// P14.5 — Live retry wakeup authority. When the runtime is alive,
    /// the scheduler holds registered `(taskID, deadline)` wakeups for
    /// `.waitingForRetry` tasks. The `RuntimeLifecycleController` owns
    /// the periodic driver that calls `driveDueWork()` on this actor.
    /// Optional so DEBUG harnesses without a lifecycle still work.
    var retryScheduler: RuntimeRetryScheduler?

    private var seenEvents: Set<UUID> = []                 // dedup (§4.2)
    struct ActiveGeneration: Sendable {
        var taskID: UUID
        var attemptID: UUID
        var userMessageID: UUID
        var assistantID: UUID
        var sequence: Int
        var isLocalDiscovery: Bool = false
    }
    var activeByConversation: [UUID: ActiveGeneration] = [:]
    var lastActiveByConversation: [UUID: ActiveGeneration] = [:]
    /// Cross-file accessors (the converse extension lives in a sibling
    /// file). Read-only — writes happen on the coordinator itself.
    func _activeByConversation() -> [UUID: ActiveGeneration] { activeByConversation }
    func _lastActiveByConversation() -> [UUID: ActiveGeneration] { lastActiveByConversation }
    /// P14.2 — R-A-F3 closure. Map every active attempt by taskID so a
    /// delegated / agentic child run can be cancelled by its durable parent
    /// taskID even when the child uses a different conversationID (e.g.,
    /// `runDelegatedTask` recursing into a separate `ActiveGeneration`).
    /// `cancel(taskID:)` removes from this map; `isCancelled(taskID:)`
    /// queries it. INV-CANCEL-01 + INV-CANCEL-02.
    private var activeByTaskID: [UUID: ActiveGeneration] = [:]
    private var lastActiveByTaskID: [UUID: ActiveGeneration] = [:]
    private var cancelled: Set<UUID> = []                  // cancelled assistant ids
    private var cancelledConversations: Set<UUID> = []
    private var cancellationRecordedAttempts: Set<UUID> = []
    private var localDiscoveryAttemptIDs: Set<UUID> = []
    private var ledgerSequenceByTask: [UUID: Int] = [:]
    private var activitySequenceByRun: [UUID: Int] = [:]
    /// Privacy dye: taskIDs born from private conversations (doc §12.4). All
    /// disk funnels — legacy ledger (`record`), durable mirror
    /// (`mirrorDurable`), durable inbox, checkpoint tombstones — skip dyed
    /// tasks entirely: no rows, no audit, no resume. Live UI via eventHub
    /// envelopes is unaffected (the activity store gates disk separately).
    /// Unbounded UUID set, matching existing style (seenEvents,
    /// ledgerSequenceByTask hold the same class of key).
    var privateTaskIDs = Set<UUID>()
    /// Dye a task from its triggering message. Child runs inherit via
    /// `runDelegatedTask` (parent dye), so private subtrees stay private.
    func dyeFrom(_ ume: UserMessageEvent, taskID: UUID) {
        if ume.conversationClass == .privateChat { privateTaskIDs.insert(taskID) }
    }
    func isPrivateTask(_ taskID: UUID) -> Bool { privateTaskIDs.contains(taskID) }
    /// Async snapshot reader used by the `DurableSink` seam. Reads the live
    /// dye set (the actor's mutable `privateTaskIDs`) on every call so the
    /// sink never sees a stale snapshot. Async so callers (typically the
    /// container's init path) can `await` from a non-isolated context
    /// without breaking Swift 6 actor-isolation.
    public func isPrivateTaskLookup() async -> Set<UUID> { privateTaskIDs }
    /// P14.2 — durable-keyed approval supervisor (R-A-F1). The pre-existing
    /// `pendingPlanApprovals` (keyed by conversationID) only worked inside a
    /// live Runtime A. After restart, the durable task ID is the stable key,
    /// so `awaitPlanApproval` is re-routed through `supervisor` on Runtime B
    /// recovery.
    let supervisor: TaskSupervisor
    /// Compatibility shim: keeps `awaitPlanApproval(conversationID:planID:timeout:)`
    /// call sites in legacy code paths (P14.1 tests) working by mapping the
    /// conversationID to the last-active durable taskID.
    private struct PendingPlanApproval: Sendable {
        var planID: TaskPlanID
        var continuation: CheckedContinuation<PlanApprovalDecision, Never>
    }
    private var pendingPlanApprovals: [UUID: PendingPlanApproval] = [:]
    /// INV-CANCEL-02 — stale callback suppression (R-A-F4). Set of attemptIDs
    /// for which the durable task has already terminalized (cancelled,
    /// completed, failed). Any async completion (model stream chunk, tool
    /// observation, etc.) that targets one of these attemptIDs is dropped
    /// before mutating state.
    private var terminalizedAttempts: Set<UUID> = []

    public init(context: AgentContextBuilding, model: StructuredDecisionProviding,
                conversation: ConversationGenerating, gate: CapabilityGate,
                executor: ToolExecuting, policy: AgentPolicy,
                toolCatalogProvider: (any ToolCatalogProviding)? = nil,
                toolPlatformExecutor: (any ToolPlatformExecuting)? = nil,
                systemAuthorization: any SystemAuthorizationProviding = DefaultSystemAuthorizationPolicy(),
                ledger: AgentTaskLedgerPersisting = NoopAgentTaskLedgerStore(),
                clock: RuntimeClock = WallClock(),
                localeProvider: @escaping @Sendable () -> Locale = { .current },
                timeZoneProvider: @escaping @Sendable () -> TimeZone = { .current },
                localDiscoveryStructuredPlannerFactory: (@Sendable () async -> (any LocalDiscoveryStructuredPlanning)?)? = nil,
                checkpointStore: AgentCheckpointStore? = nil,
                reflection: ReflectionSink = NoopReflectionSink(),
                loopDecisionProvider: (any AgentLoopDecisionProviding)? = nil,
                loopDecisionProviderFactory: (@Sendable () async -> any AgentLoopDecisionProviding)? = nil,
                // P14.1 — durable task kernel injection (R-B-01). All optional.
                durableTaskStore: DurableTaskStore? = nil,
                goalStore: GoalStore? = nil,
                durableInboxStore: DurableInboxStore? = nil,
                durableAuditLogStore: DurableAuditLogStore? = nil,
                durableSchedulerSnapshotStore: DurableSchedulerSnapshotStore? = nil,
                recoveryClassifier: RecoveryClassifier = RecoveryClassifier(),
                acceptanceEvaluator: AcceptanceEvaluator = AcceptanceEvaluator(),
                retryPolicy: AgentRetryPolicy = AgentRetryPolicy(),
                // P14.2 — durable-keyed task supervisor (R-A-F1). Defaults
                // to a fresh in-memory supervisor for DEBUG harnesses.
                supervisor: TaskSupervisor? = nil,
                // P14.5 — live retry wakeup scheduler. When nil, the
                // runtime falls back to startup-time `evaluateRetries`
                // only and never wakes a task while alive. Tests may
                // inject a fresh actor.
                retryScheduler: RuntimeRetryScheduler? = nil) {
        self.context = context
        self.decisionEngine = DecisionEngine(provider: model)
        let defaultLoopProvider = loopDecisionProvider ?? StructuredAgentLoopDecisionAdapter(provider: model)
        self.loopDecisionProviderFactory = loopDecisionProviderFactory ?? { defaultLoopProvider }
        self.conversation = conversation
        self.gate = gate
        self.executor = executor
        self.toolCatalogProvider = toolCatalogProvider
        self.toolPlatformExecutor = toolPlatformExecutor
        self.systemAuthorization = systemAuthorization
        self.ledger = ledger
        self.policy = policy
        self.clock = clock
        self.localeProvider = localeProvider
        self.timeZoneProvider = timeZoneProvider
        self.localDiscoveryStructuredPlannerFactory = localDiscoveryStructuredPlannerFactory
        self.checkpointStore = checkpointStore
        self.reflection = reflection
        // P14.1 — wire durable kernel stores. Defaults preserve pre-existing
        // behavior for any DEBUG harness / older caller that does not pass them.
        self.durableTaskStore = durableTaskStore
        self.goalStore = goalStore
        self.durableInboxStore = durableInboxStore
        self.durableAuditLogStore = durableAuditLogStore
        self.durableSchedulerSnapshotStore = durableSchedulerSnapshotStore
        self.recoveryClassifier = recoveryClassifier
        self.acceptanceEvaluator = acceptanceEvaluator
        self.retryPolicy = retryPolicy
        self.retryScheduler = retryScheduler
        // P14.2 — wire the durable-keyed task supervisor. Audit hook routes
        // stale-callback drops through the durable audit log when present.
        if let sink = supervisor { self.supervisor = sink }
        else if let audit = durableAuditLogStore {
            self.supervisor = TaskSupervisor(auditSink: { kind, summary in
                Task { [audit] in
                    let auditKind: RuntimeAuditKind = (kind == "staleCallbackDropped")
                        ? .staleCallbackDropped
                        : (kind == "continuationRecovered" ? .continuationRecovered : .warning)
                    await audit.record(RuntimeAuditEvent(kind: auditKind,
                                                         summary: summary,
                                                         timestamp: Date()))
                }
            })
        } else {
            self.supervisor = TaskSupervisor()
        }
    }

    // MARK: Privacy-safe task activity stream

    fileprivate func nextActivitySequence(runID: UUID) -> Int {
        let next = (activitySequenceByRun[runID] ?? -1) + 1
        activitySequenceByRun[runID] = next
        return next
    }

    func emitActivity(kind: AgentTaskEventKind,
                              taskID: UUID,
                              runID: UUID,
                              conversationID: UUID?,
                              userMessageID: UUID?,
                              title: String,
                              detail: String? = nil,
                              stepID: String? = nil,
                              toolName: String? = nil,
                              failureCategory: AgentTaskFailureCategory? = nil,
                              emit: @Sendable (PetAgentRuntimeOutput) -> Void) async {
        let event = AgentTaskActivityEvent(
            taskID: taskID,
            runID: runID,
            conversationID: conversationID,
            userMessageID: userMessageID,
            sequenceNumber: nextActivitySequence(runID: runID),
            timestamp: clock.now(),
            kind: kind,
            presentation: AgentTaskEventPresentation(title: title, detail: detail),
            stepID: stepID,
            toolID: toolName.map { ToolID(rawValue: $0) },
            failureCategory: failureCategory,
            source: .runtime)
        emit(.taskActivity(event))
    }

    func emitResultDocument(_ document: AgentResultDocument?,
                                    taskID: UUID,
                                    runID: UUID,
                                    conversationID: UUID?,
                                    userMessageID: UUID?,
                                    emit: @Sendable (PetAgentRuntimeOutput) -> Void) async {
        guard var document else { return }
        document.taskID = taskID
        document.runID = runID
        let event = AgentTaskActivityEvent(
            taskID: taskID,
            runID: runID,
            conversationID: conversationID,
            userMessageID: userMessageID,
            sequenceNumber: nextActivitySequence(runID: runID),
            timestamp: clock.now(),
            kind: .resultProduced,
            presentation: AgentTaskEventPresentation(title: "结果已生成", detail: document.summary),
            source: .runtime,
            resultDocument: document)
        emit(.taskActivity(event))
    }

    func reflectMemoryCandidates(_ candidates: [MemoryCandidate], isPrivate: Bool = false) async {
        // Privacy dye: no learning from private conversations — not even
        // derived suggestions. The live reply is unaffected.
        guard !isPrivate, !candidates.isEmpty else { return }
        await reflection.reflectCandidates(candidates)
    }

    func emitActivity(for state: AgentLoopState,
                              taskID: UUID,
                              runID: UUID,
                              conversationID: UUID,
                              userMessageID: UUID,
                              emit: @Sendable (PetAgentRuntimeOutput) -> Void) async {
        switch state {
        case .preparing:
            await emitActivity(kind: .planningStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "正在准备任务", emit: emit)
        case .requestingModel:
            await emitActivity(kind: .planningStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "正在判断下一步", emit: emit)
        case .executingTool(let toolName):
            await emitActivity(kind: .stepStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: Self.toolActivitySummary(toolName),
                               stepID: "tool-\(toolName)", toolName: toolName, emit: emit)
        case .toolObserved(let observation):
            let succeeded = observation.status == .success
            // P19.1 — pipe the runtime-sanitized `userSafeSummary` into the event's
            // `presentation.detail` on success. `AgentToolObservation.userSafeSummary`
            // is already produced by `AgentPrivacyRedactor.safeSummary` in the
            // `AgentToolObservation.init`, so this value is safe to display. The
            // `ToolOutputPreviewBuilder` runs an additional `safeText` pass before
            // the chat activity bubble renders it. On failure we keep the existing
            // category-specific failure detail so the user still gets a clear reason.
            let detail: String? = succeeded
                ? (observation.userSafeSummary.isEmpty
                    ? nil
                    : observation.userSafeSummary)
                : Self.toolObservationFailureDetail(observation)
            await emitActivity(kind: succeeded ? .stepSucceeded : .stepFailed,
                               taskID: taskID,
                               runID: runID,
                               conversationID: conversationID,
                               userMessageID: userMessageID,
                               title: Self.toolObservationActivityTitle(observation),
                               detail: detail,
                               stepID: "tool-\(observation.toolName)",
                               toolName: observation.toolName,
                               failureCategory: succeeded ? nil : .toolFailed,
                               emit: emit)
        case .awaitingToolApproval(let toolName):
            await emitActivity(kind: .approvalRequested, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "等待工具权限确认",
                               detail: Self.toolActivitySummary(toolName),
                               stepID: "tool-\(toolName)", toolName: toolName, emit: emit)
        case .finishing:
            await emitActivity(kind: .synthesisStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "正在整理最终答复", emit: emit)
        case .failed(let reason):
            await emitActivity(kind: .stepFailed, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "任务遇到问题",
                               detail: reason.userVisibleSummary,
                               failureCategory: reason.activityFailureCategory,
                               emit: emit)
        case .cancelled:
            await emitActivity(kind: .taskCancelled, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "任务已取消",
                               failureCategory: .cancelled,
                               emit: emit)
        case .idle, .feedingObservation, .completed:
            break
        }
    }

    func emitActivity(for event: PlanExecutionEvent,
                              taskID: UUID,
                              runID: UUID,
                              conversationID: UUID,
                              userMessageID: UUID,
                              emit: @Sendable (PetAgentRuntimeOutput) -> Void) async {
        switch event {
        case .planCreated(let snapshot):
            await emitActivity(kind: .planProposed, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "已生成计划", detail: snapshot.goalSummary, emit: emit)
        case .approvalRequired(let snapshot):
            await emitActivity(kind: .approvalRequested, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: snapshot.containsPrivateDataRead ? "此任务需要读取私人数据" : "等待执行确认",
                               detail: snapshot.containsPrivateDataRead ? "将读取日历可用性，不显示事件详情" : snapshot.goalSummary,
                               emit: emit)
        case .planApproved:
            await emitActivity(kind: .approvalGranted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "已允许执行计划", emit: emit)
        case .planCancelled:
            await emitActivity(kind: .taskCancelled, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "计划已取消",
                               failureCategory: .cancelled,
                               emit: emit)
        case .stepStarted(let stepID, let snapshot):
            let step = snapshot.steps.first { $0.id == stepID }
            await emitActivity(kind: .stepStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: step?.title ?? "正在执行步骤",
                               detail: step?.toolDisplayName,
                               stepID: stepID.rawValue,
                               emit: emit)
        case .stepFinished(let stepID, let status, let snapshot):
            let step = snapshot.steps.first { $0.id == stepID }
            let kind: AgentTaskEventKind
            let category: AgentTaskFailureCategory?
            switch status {
            case .succeeded, .partial:
                kind = .stepSucceeded
                category = nil
            case .denied:
                kind = .stepFailed
                category = .permissionDenied
            case .timedOut:
                kind = .stepFailed
                category = .toolTimedOut
            case .failed:
                kind = .stepFailed
                category = .toolFailed
            case .cancelled:
                kind = .taskCancelled
                category = .cancelled
            case .skippedDependency:
                kind = .stepSkipped
                category = nil
            case .pending, .running, .unknown:
                kind = .stepFailed
                category = .unknown
            }
            await emitActivity(kind: kind, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: step?.title ?? "步骤已更新",
                               detail: status.activityDetail,
                               stepID: stepID.rawValue,
                               failureCategory: category,
                               emit: emit)
        case .stepSkipped(let stepID, let status, let snapshot):
            let step = snapshot.steps.first { $0.id == stepID }
            await emitActivity(kind: .stepSkipped, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: step?.title ?? "步骤已跳过",
                               detail: status.activityDetail,
                               stepID: stepID.rawValue,
                               emit: emit)
        case .replanning:
            await emitActivity(kind: .replanStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "正在重新规划剩余步骤", emit: emit)
        case .verificationStarted:
            await emitActivity(kind: .verificationStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "正在验证执行结果", emit: emit)
        case .verificationCompleted(let report, _):
            let succeeded = report.allowsTerminalSuccess
            await emitActivity(kind: succeeded ? .verificationSucceeded : .verificationFailed,
                               taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: succeeded ? "验证完成" : "验证未通过",
                               detail: report.findings.first?.message,
                               failureCategory: succeeded ? nil : .validationFailed,
                               emit: emit)
        case .synthesisStarted:
            await emitActivity(kind: .synthesisStarted, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "正在整理最终答复", emit: emit)
        case .completed:
            await emitActivity(kind: .synthesisSucceeded, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "步骤执行完成", emit: emit)
        case .failed(let error, _):
            await emitActivity(kind: .taskFailed, taskID: taskID, runID: runID,
                               conversationID: conversationID, userMessageID: userMessageID,
                               title: "任务未完成",
                               detail: error.userVisibleMessage,
                               failureCategory: error.activityFailureCategory,
                               emit: emit)
        }
    }

    // MARK: Cancellation (§7.1, idempotent)

    public func cancel(conversationID: UUID) async {
        cancelledConversations.insert(conversationID)
        // P14.2 — R-A-F3: also discover delegated attempts that may be
        // active under a different conversationID. The agentic loop
        // registers attempts in `activeByTaskID`; a delegated child
        // run's `userMessageID` is its parent conversationID but the
        // child may not appear in `activeByConversation`. Scan the
        // taskID-keyed map and cancel any active attempt that owns
        // this conversationID.
        var cancelledTaskIDs: Set<UUID> = []
        for (tid, active) in activeByTaskID where active.userMessageID == conversationID {
            await terminateActiveAttempt(active: active,
                                          taskID: tid,
                                          cancelReason: "userCancelled:delegated",
                                          conversationID: conversationID)
            cancelledTaskIDs.insert(tid)
        }
        if let active = activeByConversation[conversationID] ?? lastActiveByConversation[conversationID] {
            cancelled.insert(active.assistantID)
            // P14.2 — INV-CANCEL-02 — mark this attempt as terminalized so
            // any in-flight async callbacks (model stream chunks, tool
            // results) are dropped before mutating durable state (R-A-F4).
            terminalizedAttempts.insert(active.attemptID)
            if active.isLocalDiscovery || localDiscoveryAttemptIDs.contains(active.attemptID) {
                // Privacy dye: no checkpoint tombstones for private tasks.
                if !privateTaskIDs.contains(active.taskID) {
                    try? await checkpointStore?.markLocalDiscoverySnapshotCancelled(taskID: active.taskID,
                                                                                    runID: active.attemptID,
                                                                                    conversationID: conversationID,
                                                                                    updatedAt: clock.now())
                }
            }
            if cancellationRecordedAttempts.insert(active.attemptID).inserted {
                try? await record(kind: .cancelled, state: .cancelled, taskID: active.taskID,
                                  attemptID: active.attemptID, conversationID: conversationID,
                                  userMessageID: active.userMessageID,
                                  assistantMessageID: active.assistantID,
                                  cancelReason: "userCancelled", terminal: true)
                // P14.1 — mirror cancellation into the durable kernel (R-B-01).
                await mirrorDurable(taskID: active.taskID,
                                    attemptID: active.attemptID,
                                    legacyState: .cancelled,
                                    title: "userCancelled",
                                    conversationID: conversationID)
            }
            // P14.2 — also drop any pending supervisor continuation for this
            // task so a recovered Runtime B does not silently resume it.
            await supervisor.drop(taskID: active.taskID, reason: "userCancelled")
            cancelledTaskIDs.insert(active.taskID)
        }
        resolvePlanApproval(conversationID: conversationID, decision: .cancelled)
        // P14.1 — durable approval routing (R-B-07). On user cancel, route the
        // decision through the durable inbox and resolve the durable state.
        if let active = activeByConversation[conversationID] ?? lastActiveByConversation[conversationID] {
            await resolveDurableApproval(taskID: active.taskID,
                                         attemptID: active.attemptID,
                                         conversationID: conversationID,
                                         legacyState: .cancelled,
                                         decisionLabel: "cancelled")
        }
        for tid in cancelledTaskIDs {
            await supervisor.drop(taskID: tid, reason: "cancelSweep")
        }
    }

    /// P14.2 — R-A-F3 helper. Cancel a single active attempt by its
    /// `ActiveGeneration`. Used by `cancel(conversationID:)` to also
    /// terminate delegated child runs that share the parent
    /// conversationID but are registered under a different taskID.
    private func terminateActiveAttempt(active: ActiveGeneration,
                                         taskID: UUID,
                                         cancelReason: String,
                                         conversationID: UUID) async {
        cancelled.insert(active.assistantID)
        terminalizedAttempts.insert(active.attemptID)
        if active.isLocalDiscovery || localDiscoveryAttemptIDs.contains(active.attemptID) {
            // Privacy dye: no checkpoint tombstones for private tasks.
            if !privateTaskIDs.contains(active.taskID) {
                try? await checkpointStore?.markLocalDiscoverySnapshotCancelled(taskID: active.taskID,
                                                                                runID: active.attemptID,
                                                                                conversationID: conversationID,
                                                                                updatedAt: clock.now())
            }
        }
        if cancellationRecordedAttempts.insert(active.attemptID).inserted {
            try? await record(kind: .cancelled, state: .cancelled, taskID: active.taskID,
                              attemptID: active.attemptID,
                              conversationID: conversationID,
                              userMessageID: active.userMessageID,
                              assistantMessageID: active.assistantID,
                              cancelReason: cancelReason,
                              terminal: true)
            await mirrorDurable(taskID: active.taskID,
                                attemptID: active.attemptID,
                                legacyState: .cancelled,
                                title: cancelReason,
                                conversationID: conversationID)
        }
    }

    /// P14.2 — durable-keyed cancellation (R-A-F3). Cancels a delegated /
    /// agentic child run by its durable taskID, regardless of which
    /// conversationID the child was registered against. INV-CANCEL-01 +
    /// INV-CANCEL-02.
    public func cancel(taskID: UUID) async {
        if let active = activeByTaskID[taskID] ?? lastActiveByTaskID[taskID] {
            cancelled.insert(active.assistantID)
            cancelledConversations.insert(active.userMessageID) // approximate
            // Mark terminalized so any in-flight callbacks are dropped.
            terminalizedAttempts.insert(active.attemptID)
            if cancellationRecordedAttempts.insert(active.attemptID).inserted {
                try? await record(kind: .cancelled, state: .cancelled, taskID: active.taskID,
                                  attemptID: active.attemptID,
                                  conversationID: active.userMessageID,
                                  userMessageID: active.userMessageID,
                                  assistantMessageID: active.assistantID,
                                  cancelReason: "userCancelledByTaskID", terminal: true)
                await mirrorDurable(taskID: active.taskID,
                                    attemptID: active.attemptID,
                                    legacyState: .cancelled,
                                    title: "userCancelledByTaskID",
                                    conversationID: active.userMessageID)
            }
            await supervisor.drop(taskID: taskID, reason: "cancelByTaskID")
        } else if let store = durableTaskStore {
            // No in-memory active record (e.g. test seeded a durable record
            // directly, or this is a supervisor-initiated cancel). Apply the
            // durable `.cancelled` transition directly so the durable
            // kernel is the canonical source of truth (INV-CANCEL-01).
            // Privacy dye: never create durable rows for private tasks.
            if !privateTaskIDs.contains(taskID) {
                _ = await store.applyTransition(taskID: taskID, to: .cancelled)
            }
            await supervisor.drop(taskID: taskID, reason: "cancelByTaskID:durable")
        }
    }

    /// P14.2 — INV-CANCEL-02. Returns true when the attempt has been
    /// terminalized (cancelled / completed / failed) and any async callback
    /// targeting it must be dropped before mutating state.
    func isAttemptTerminalized(_ attemptID: UUID) -> Bool {
        terminalizedAttempts.contains(attemptID)
            || cancellationRecordedAttempts.contains(attemptID)
    }

    /// P14.2 — R-A-F3. Register an attempt as active for its durable taskID
    /// so `cancel(taskID:)` can reach it. Called from `runAgenticLoop` and
    /// `runDelegatedTask` at the start of execution. `endActiveAttempt` is
    /// called on terminalization.
    private func registerActiveAttempt(_ active: ActiveGeneration) {
        activeByTaskID[active.taskID] = active
        lastActiveByTaskID[active.taskID] = active
    }

    private func endActiveAttempt(taskID: UUID) {
        activeByTaskID[taskID] = nil
    }
    func isCancelled(_ mid: UUID, conversationID: UUID? = nil) -> Bool {
        cancelled.contains(mid) || conversationID.map { cancelledConversations.contains($0) } == true
    }

    public func approveActivePlan(conversationID: UUID) async {
        resolvePlanApproval(conversationID: conversationID, decision: .approved)
        // P14.1 fix F-02 (Reviewer B): durable approval routing (R-B-07).
        // Mirror the approval decision into the durable inbox + advance the
        // durable task to `.running`. Without this, an approval survives
        // only in-memory and is lost across restart.
        if let active = activeByConversation[conversationID] ?? lastActiveByConversation[conversationID] {
            await resolveDurableApproval(taskID: active.taskID,
                                        attemptID: active.attemptID,
                                        conversationID: conversationID,
                                        legacyState: .running,
                                        decisionLabel: "approved")
            // P14.2 — also resume any supervisor continuation registered by
            // the recovery scan for this taskID (R-A-F1). Without this, the
            // supervisor continuation outlives the live in-memory map.
            _ = await supervisor.resumeApproval(taskID: active.taskID, decision: .approved)
        }
    }

    public func cancelActivePlan(conversationID: UUID) async {
        resolvePlanApproval(conversationID: conversationID, decision: .declined)
        // P14.1 fix F-02 (Reviewer B): durable approval routing (R-B-07).
        if let active = activeByConversation[conversationID] ?? lastActiveByConversation[conversationID] {
            await resolveDurableApproval(taskID: active.taskID,
                                        attemptID: active.attemptID,
                                        conversationID: conversationID,
                                        legacyState: .cancelled,
                                        decisionLabel: "declined")
            // P14.2 — also drop any supervisor continuation (R-A-F1).
            _ = await supervisor.resumeApproval(taskID: active.taskID, decision: .declined)
        }
    }

    private func resolvePlanApproval(conversationID: UUID, decision: PlanApprovalDecision) {
        guard let pending = pendingPlanApprovals.removeValue(forKey: conversationID) else { return }
        pending.continuation.resume(returning: decision)
    }

    private func awaitPlanApproval(conversationID: UUID,
                                   planID: TaskPlanID,
                                   timeout: TimeInterval) async -> PlanApprovalDecision {
        await withCheckedContinuation { continuation in
            pendingPlanApprovals[conversationID] = PendingPlanApproval(planID: planID,
                                                                       continuation: continuation)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                await self?.timeoutPlanApproval(conversationID: conversationID, planID: planID)
            }
        }
    }

    private func timeoutPlanApproval(conversationID: UUID, planID: TaskPlanID) {
        guard let pending = pendingPlanApprovals[conversationID],
              pending.planID == planID else { return }
        pendingPlanApprovals.removeValue(forKey: conversationID)
        pending.continuation.resume(returning: .timedOut)
    }

    // MARK: - P14.2 — taskID-keyed approval (R-A-F1)
    //
    // The conversationID-keyed path above continues to work for the live
    // Runtime A flow. On Runtime B startup we have neither a live
    // `activeByConversation` nor the original CheckedContinuation; the only
    // durable identity we have is the taskID. The methods below let the
    // supervisor-based recovery flow target durable tasks directly.

    /// Resume a pending approval on a durable task. R-A-F1 — this is the
    /// primary entry point Runtime B uses to consume an approval that
    /// arrived durably while the runtime was down.
    @discardableResult
    public func approveActivePlan(taskID: UUID) async -> Bool {
        let resumed = await supervisor.resumeApproval(taskID: taskID, decision: .approved)
        guard resumed else { return false }
        // Advance the durable task to `.running` and consume any pending
        // inbox events (R-B-07).
        if let active = lastActiveByConversation.values.first(where: { $0.taskID == taskID }) {
            await resolveDurableApproval(taskID: taskID,
                                         attemptID: active.attemptID,
                                         conversationID: active.userMessageID,
                                         legacyState: .running,
                                         decisionLabel: "approved")
        } else {
            let active = await self.durableActiveFor(taskID: taskID)
            if let active {
                await resolveDurableApproval(taskID: taskID,
                                             attemptID: active.attemptID,
                                             conversationID: active.userMessageID,
                                             legacyState: .running,
                                             decisionLabel: "approved")
            } else {
                // No in-memory active record. The durable record alone is the
                // source of truth. Mark the durable task `.waitingForApproval →
                // .running` so the supervisor can advance the agentic loop.
                if let store = durableTaskStore {
                    _ = await store.applyTransition(taskID: taskID, to: .running)
                }
                if let inbox = durableInboxStore {
                    // Find the attemptID from the unconsumed inbox events for this task.
                    let unconsumed = await inbox.unconsumedEvents(forTask: taskID)
                    let attemptID = unconsumed.first.flatMap { ev -> UUID? in
                        if case .object(let obj) = ev.payload,
                           case .string(let s) = obj["attemptID"] ?? .null {
                            return UUID(uuidString: s)
                        }
                        return nil
                    } ?? UUID()
                    await inbox.consumeAll(forTask: taskID, attemptID: attemptID)
                }
            }
        }
        return true
    }

    @discardableResult
    public func cancelActivePlan(taskID: UUID) async -> Bool {
        let resumed = await supervisor.resumeApproval(taskID: taskID, decision: .declined)
        guard resumed else { return false }
        if let active = lastActiveByConversation.values.first(where: { $0.taskID == taskID }) {
            await resolveDurableApproval(taskID: taskID,
                                         attemptID: active.attemptID,
                                         conversationID: active.userMessageID,
                                         legacyState: .cancelled,
                                         decisionLabel: "declined")
        } else {
            let active = await self.durableActiveFor(taskID: taskID)
            if let active {
                await resolveDurableApproval(taskID: taskID,
                                             attemptID: active.attemptID,
                                             conversationID: active.userMessageID,
                                             legacyState: .cancelled,
                                             decisionLabel: "declined")
            } else if let store = durableTaskStore {
                _ = await store.applyTransition(taskID: taskID, to: .cancelled)
            }
        }
        return true
    }

    /// Await a plan approval on a durable task via the supervisor. Used by
    /// `recoverPendingApprovals()` on Runtime B and by any new flow that
    /// wants durable-keyed continuation semantics.
    public func awaitPlanApproval(taskID: UUID,
                                  planID: TaskPlanID,
                                  timeout: TimeInterval) async -> PlanApprovalDecision {
        await supervisor.awaitApproval(taskID: taskID, timeout: timeout, clock: { [clock] in clock.now() })
    }

    /// Drop a pending approval (cancel the wait). Used by `cancel(conversationID:)`
    /// when the same taskID has a supervisor continuation.
    public func cancelPlanApproval(taskID: UUID) async {
        await supervisor.drop(taskID: taskID, reason: "coordinator:cancel")
    }

    /// Look up an active in-memory record for the given taskID by scanning
    /// the lastActiveByConversation map. Returns nil if the task is not
    /// in flight in the current runtime.
    private func durableActiveFor(taskID: UUID) async -> ActiveGeneration? {
        for active in lastActiveByConversation.values where active.taskID == taskID {
            return active
        }
        return nil
    }

    // MARK: Streaming entry — the path the chat UI subscribes to (§5.1)

    public nonisolated func handle(_ event: PetAgentEvent) -> AsyncStream<PetAgentRuntimeOutput> {
        AsyncStream { continuation in
            let task = Task { await self.process(event) { continuation.yield($0) }; continuation.finish() }
            continuation.onTermination = { termination in
                task.cancel()
                guard case .cancelled = termination,
                      case .userMessage(let ume) = event else { return }
                Task { await self.cancel(conversationID: ume.conversationID) }
            }
        }
    }

    private func process(_ event: PetAgentEvent, emit: @escaping @Sendable (PetAgentRuntimeOutput) -> Void) async {
        guard case .userMessage(let ume) = event else { return }
        guard seenEvents.insert(ume.eventID).inserted else { return }   // dedup
        cancelledConversations.remove(ume.conversationID)
        var ctx = await context.build(for: event)
        if ctx.intentContext == nil {
            ctx.intentContext = ume.metadata.intentContext
        }
        let structuredDecision = await decisionEngine.decideStructured(context: ctx, policy: policy)
        await reflectMemoryCandidates(structuredDecision.memoryCandidates, isPrivate: ume.conversationClass == .privateChat)
        let decision = structuredDecision.decision
        let source = structuredDecision.decisionSource
        let taskId = ume.taskIDOverride ?? ume.retryOfTaskID ?? UUID()
        let attemptID = ume.runIDOverride ?? UUID()
        dyeFrom(ume, taskID: taskId)
        do {
            try await record(kind: .created, state: .queued, taskID: taskId, attemptID: attemptID,
                             conversationID: ume.conversationID, userMessageID: ume.messageID,
                             retryOfTaskID: ume.retryOfTaskID,
                             regeneratedFromMessageID: ume.regeneratedFromMessageID,
                             decisionSource: source,
                             providerStreamingCapability: conversation.streamingCapability)
            // P14.1 — mirror task creation into the durable kernel (R-B-01).
            await mirrorDurable(taskID: taskId, attemptID: attemptID,
                                legacyState: .queued,
                                title: "taskCreated",
                                conversationID: ume.conversationID)
            try await record(kind: .started, state: .running, taskID: taskId, attemptID: attemptID,
                             conversationID: ume.conversationID, userMessageID: ume.messageID,
                             retryOfTaskID: ume.retryOfTaskID,
                             regeneratedFromMessageID: ume.regeneratedFromMessageID,
                             decisionSource: source,
                             providerStreamingCapability: conversation.streamingCapability)
            // P14.1 — mirror task start (R-B-01).
            await mirrorDurable(taskID: taskId, attemptID: attemptID,
                                legacyState: .running,
                                title: "taskStarted",
                                conversationID: ume.conversationID)
        } catch {
            emit(.failed(messageID: nil, reason: "任务记录写入失败"))
            return
        }
        emit(.taskStarted(taskID: taskId, attemptID: attemptID, source: source))
        await emitActivity(kind: .taskCreated,
                           taskID: taskId,
                           runID: attemptID,
                           conversationID: ume.conversationID,
                           userMessageID: ume.messageID,
                           title: "正在处理用户请求",
                           detail: ume.retryOfTaskID == nil ? nil : "这是一次重试运行",
                           emit: emit)

        let preparedRequest = RuntimeRequestPreparer.prepare(userText: ume.text,
                                                             context: ctx.intentContext)
        if preparedRequest.executionMode == .localDiscoveryWorkflow,
           let localDiscoveryDecision = preparedRequest.localDiscoveryIntentDecision {
            await runLocalDiscoveryWorkflow(ume: ume,
                                            ctx: ctx,
                                            taskID: taskId,
                                            attemptID: attemptID,
                                            source: .ruleBasedFallback,
                                            decision: localDiscoveryDecision,
                                            emit: emit)
            return
        }
        if let requiredTool = preparedRequest.requiredToolDecision {
            await runBoundedToolLoop(ume: ume, ctx: ctx, taskID: taskId, attemptID: attemptID,
                                     source: requiredTool.decisionSource, initial: requiredTool, emit: emit)
            return
        }

        switch decision {
        case .respond, .proposePlan, .askClarification, .decline, .noAction:
            let initial = StructuredAgentLoopDecisionAdapter.map(structuredDecision)
            switch initial.decision {
            case .finalResponse(let response):
                await converse(ume: ume, ctx: ctx, preset: response.text, taskID: taskId, attemptID: attemptID,
                               source: source, emit: emit,
                               resultDocument: initial.resultDocument)
            case .toolCall, .proposePlan:
                await runBoundedToolLoop(ume: ume, ctx: ctx, taskID: taskId, attemptID: attemptID,
                                         source: source, initial: initial, emit: emit)
            }
        case .delegate(let delegation):
            let res = await runAgenticLoop(goal: delegation.goal, initialDecision: decision, ctx: ctx,
                                           ume: ume, taskID: taskId, attemptID: attemptID, source: source)
            for cap in res.waiting { emit(.waitingForApproval(capabilityID: cap)) }
            emit(.presentation(res.presentation))
        }
    }

    private func runBoundedToolLoop(ume: UserMessageEvent, ctx: AgentContext,
                                    taskID: UUID, attemptID: UUID,
                                    source: DecisionSource,
                                    initial: AgentLoopDecisionResult,
                                    emit: @escaping @Sendable (PetAgentRuntimeOutput) -> Void) async {
        let assistantID = UUID()
        let active = ActiveGeneration(taskID: taskID, attemptID: attemptID,
                                      userMessageID: ume.messageID,
                                      assistantID: assistantID,
                                      sequence: 0)
        activeByConversation[ume.conversationID] = active
        lastActiveByConversation[ume.conversationID] = active
        localDiscoveryAttemptIDs.insert(attemptID)
        defer {
            if activeByConversation[ume.conversationID]?.assistantID == assistantID {
                activeByConversation[ume.conversationID] = nil
            }
        }

        let controller = AgentLoopController(
            provider: await loopDecisionProviderFactory(),
            gate: gate,
            executor: executor,
            toolCatalogProvider: toolCatalogProvider,
            toolPlatformExecutor: toolPlatformExecutor,
            systemAuthorization: systemAuthorization,
            planApprovalHandler: ClosureTaskPlanApprovalHandler { [weak self] plan, _ in
                guard let self else { return .cancelled }
                return await self.awaitPlanApproval(conversationID: ume.conversationID,
                                                    planID: plan.plan.id,
                                                    timeout: plan.plannerLimits.planApprovalTimeout)
            },
            policy: policy,
            limits: AgentLoopLimits.forPolicy(policy),
            clock: clock,
            localeProvider: localeProvider,
            timeZoneProvider: timeZoneProvider,
            stateSink: { state in
                emit(.loopStateChanged(state))
                await self.emitActivity(for: state,
                                        taskID: taskID,
                                        runID: attemptID,
                                        conversationID: ume.conversationID,
                                        userMessageID: ume.messageID,
                                        emit: emit)
            },
            planEventSink: { event in
                if let snapshot = Self.presentationSnapshot(from: event) {
                    emit(.planUpdated(snapshot))
                }
                await self.emitActivity(for: event,
                                        taskID: taskID,
                                        runID: attemptID,
                                        conversationID: ume.conversationID,
                                        userMessageID: ume.messageID,
                                        emit: emit)
            })
        var loop = await controller.run(agentContext: ctx, taskID: taskID, runID: attemptID, initialDecision: initial) {
            await self.isCancelledAssistant(for: ume.conversationID)
        }
        await verifyCurrentDateTimeResultIfNeeded(loop: &loop,
                                                  taskID: taskID,
                                                  runID: attemptID,
                                                  conversationID: ume.conversationID,
                                                  userMessageID: ume.messageID,
                                                  emit: emit)

        // 22-field record() collapsed via the pure aggregator (field-by-field
        // pinned by BoundedToolLoopTerminalRecordTests). `terminal` and the
        // kind/state selection stay identical to the legacy inline logic.
        let payload = BoundedToolLoopTerminalRecord.project(loop: loop, modelProvider: initial.modelProvider)
        try? await record(kind: payload.kind, state: payload.state,
                          taskID: taskID, attemptID: attemptID,
                          conversationID: ume.conversationID,
                          userMessageID: ume.messageID,
                          retryOfTaskID: ume.retryOfTaskID,
                          regeneratedFromMessageID: ume.regeneratedFromMessageID,
                          decisionSource: source,
                          agentLoopState: payload.agentLoopState,
                          stopReason: payload.stopReason,
                          iterationCount: payload.iterationCount,
                          toolCallCount: payload.toolCallCount,
                          usedToolNames: payload.usedToolNames,
                          toolStatuses: payload.toolStatuses,
                          planID: payload.planID,
                          planVersion: payload.planVersion,
                          planStepCount: payload.planStepCount,
                          planRiskLevel: payload.planRiskLevel,
                          planApprovalRequired: payload.planApprovalRequired,
                          planApprovalGranted: payload.planApprovalGranted,
                          planReplanCount: payload.planReplanCount,
                          planResultItemCount: payload.planResultItemCount,
                          planResultTruncated: payload.planResultTruncated,
modelProvider: payload.modelProvider,
                           terminal: payload.terminal)
        // P14.2 — R-B-F05: gate the durable mirror through acceptance.
        await mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: loop.terminalState,
            title: "loopTerminal:\(loop.stopReason.rawValue)",
            conversationID: ume.conversationID)
        await reflectMemoryCandidates(loop.memoryCandidates, isPrivate: ume.conversationClass == .privateChat)
        await reflectLoopOutcome(loop, userText: ctx.userText, goal: ume.text, isPrivate: ume.conversationClass == .privateChat)

        for cap in loop.waitingApproval {
            emit(.waitingForApproval(capabilityID: cap))
        }
        // P16 GAP-01: when the loop is blocked on user approval, the runtime
        // approval surface (NSAlert or in-app TaskActivityCard) is already in
        // front of the user with friendly "等待你的确认" / "需要你的允许才能继续"
        // copy. Skip `converse()` entirely so we don't surface an additional
        // developer-facing assistant bubble that contradicts the visible
        // approval card. The approval decision resumes the loop.
        if !loop.waitingApproval.isEmpty {
            return
        }
        if loop.stopReason == .cancelled {
            await emitActivity(kind: .taskCancelled,
                               taskID: taskID,
                               runID: attemptID,
                               conversationID: ume.conversationID,
                               userMessageID: ume.messageID,
                               title: "任务已取消",
                               failureCategory: .cancelled,
                               emit: emit)
            emit(.cancelled(messageID: assistantID))
            return
        }

        let final = loop.finalResponse ?? AgentFinalResponse(text: "任务已停止。", finishReason: loop.stopReason.rawValue)
        await converse(ume: ume, ctx: ctx, preset: final.text,
                       taskID: taskID, attemptID: attemptID, source: source,
                       emit: emit, assistantID: assistantID, loopResult: loop,
                       resultDocument: loop.resultDocument)
    }

    private func runLocalDiscoveryWorkflow(ume: UserMessageEvent,
                                           ctx: AgentContext,
                                           taskID: UUID,
                                           attemptID: UUID,
                                           source: DecisionSource,
                                           decision: LocalDiscoveryIntentDecision,
                                           emit: @escaping @Sendable (PetAgentRuntimeOutput) -> Void) async {
        dyeFrom(ume, taskID: taskID)
        let assistantID = UUID()
        let active = ActiveGeneration(taskID: taskID,
                                      attemptID: attemptID,
                                      userMessageID: ume.messageID,
                                      assistantID: assistantID,
                                      sequence: 0,
                                      isLocalDiscovery: true)
        activeByConversation[ume.conversationID] = active
        lastActiveByConversation[ume.conversationID] = active
        defer {
            if activeByConversation[ume.conversationID]?.assistantID == assistantID {
                activeByConversation[ume.conversationID] = nil
            }
        }

        guard let toolCatalogProvider, let toolPlatformExecutor else {
            let loop = AgentLoopRunResult(finalResponse: AgentFinalResponse(
                                            text: "Local Discovery 工具平台未就绪，无法执行地点发现工作流。",
                                            finishReason: AgentLoopStopReason.toolFailure.rawValue,
                                            providerMetadata: ["workflow": "localDiscovery"]),
                                          stopReason: .toolFailure,
                                          iterationCount: 1,
                                          toolCallCount: 0,
                                          terminalState: .failed)
            await converse(ume: ume,
                           ctx: ctx,
                           preset: loop.finalResponse?.text ?? "",
                           taskID: taskID,
                           attemptID: attemptID,
                           source: source,
                           emit: emit,
                           assistantID: assistantID,
                           loopResult: loop,
                           resultDocument: nil)
            return
        }

        let structuredPlanner = await localDiscoveryStructuredPlannerSnapshotWithDeadline()
        let workflow = LocalDiscoveryWorkflow(toolCatalogProvider: toolCatalogProvider,
                                              toolPlatformExecutor: toolPlatformExecutor,
                                              gate: gate,
                                              systemAuthorization: systemAuthorization,
                                              policy: policy,
                                              clock: clock,
                                              localeProvider: localeProvider,
                                              timeZoneProvider: timeZoneProvider,
                                              structuredPlanner: structuredPlanner,
                                              checkpointStore: checkpointStore,
                                              conversationID: ume.conversationID)
let outcome = await workflow.run(userText: ume.text,
                                         decision: decision,
                                         conversationContext: ctx.intentContext,
                                         taskID: taskID,
                                         runID: attemptID,
                                         isCancelled: {
                                            await self.isCancelledAssistant(for: ume.conversationID)
                                         },
                                         activitySink: { activity in
                                            await self.emitActivity(kind: activity.kind,
                                                                    taskID: taskID,
                                                                    runID: attemptID,
                                                                    conversationID: ume.conversationID,
                                                                    userMessageID: ume.messageID,
                                                                    title: activity.title,
                                                                    detail: activity.detail,
                                                                    stepID: activity.stepID,
                                                                    toolName: activity.toolName,
                                                                    failureCategory: activity.failureCategory,
                                                                    emit: emit)
                                         })
        let loop = outcome.loopResult
        // 16-field terminal record collapsed via the pure aggregator (the
        // plan* fields stay nil since the local-discovery workflow does not
        // produce a structured plan; the `localDiscovery:` prefix tells log
        // readers this branch apart from the bounded tool-loop one).
        let payload = LocalDiscoveryTerminalRecord.project(loop: loop,
                                                          modelProvider: "local-discovery-workflow")
        try? await record(kind: payload.kind, state: payload.state,
                          taskID: taskID, attemptID: attemptID,
                          conversationID: ume.conversationID,
                          userMessageID: ume.messageID,
                          retryOfTaskID: ume.retryOfTaskID,
                          regeneratedFromMessageID: ume.regeneratedFromMessageID,
                          decisionSource: source,
                          agentLoopState: payload.agentLoopState,
                          stopReason: payload.stopReason,
                          iterationCount: payload.iterationCount,
                          toolCallCount: payload.toolCallCount,
                          usedToolNames: payload.usedToolNames,
                          toolStatuses: payload.toolStatuses,
                          modelProvider: payload.modelProvider,
                          terminal: payload.terminal)
        // P14.2 — R-B-F05: gate the durable mirror through acceptance. A
        // Goal-backed local discovery task whose criteria are unmet must
        // NOT be marked `.completed` by the workflow.
        await mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: loop.terminalState,
            title: "localDiscovery:\(loop.stopReason.rawValue)",
            conversationID: ume.conversationID)
        await reflectLoopOutcome(loop, userText: ctx.userText, goal: ume.text, isPrivate: ume.conversationClass == .privateChat)

        if loop.stopReason == .cancelled {
            await emitActivity(kind: .taskCancelled,
                               taskID: taskID,
                               runID: attemptID,
                               conversationID: ume.conversationID,
                               userMessageID: ume.messageID,
                               title: "任务已取消",
                               failureCategory: .cancelled,
                               emit: emit)
            emit(.cancelled(messageID: assistantID))
            return
        }

        let final = loop.finalResponse ?? AgentFinalResponse(text: "Local Discovery 工作流已停止。",
                                                             finishReason: loop.stopReason.rawValue)
        await converse(ume: ume,
                       ctx: ctx,
                       preset: final.text,
                       taskID: taskID,
                       attemptID: attemptID,
                       source: source,
                       emit: emit,
                       assistantID: assistantID,
                       loopResult: loop,
                       resultDocument: loop.resultDocument)
    }

    private func localDiscoveryStructuredPlannerSnapshotWithDeadline() async -> (any LocalDiscoveryStructuredPlanning)? {
        guard let factory = localDiscoveryStructuredPlannerFactory else { return nil }
        let timeout = min(10, max(2, policy.maxWallClock * 0.2))
        let factoryTask = Task {
            await factory()
        }
        let timeoutTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
            return nil as (any LocalDiscoveryStructuredPlanning)?
        }
        let gate = LocalDiscoveryPlannerFactoryDeadlineGate()
        defer {
            factoryTask.cancel()
            timeoutTask.cancel()
        }

        return await withCheckedContinuation { continuation in
            Task {
                let planner = await factoryTask.value
                if gate.claim() {
                    continuation.resume(returning: planner)
                }
            }
            Task {
                let planner = await timeoutTask.value
                if gate.claim() {
                    factoryTask.cancel()
                    continuation.resume(returning: planner)
                }
            }
        }
    }

    private func reflectLoopOutcome(_ loop: AgentLoopRunResult, userText: String?, goal: String,
                                    isPrivate: Bool = false) async {
        // Privacy dye: no learning from private conversations.
        guard !isPrivate else { return }
        let denied = loop.observations.filter { $0.status != .success }.map(\.toolName)
        guard !loop.usedToolNames.isEmpty || !denied.isEmpty else { return }
        await reflection.reflect(TaskReflectionInput(
            goal: goal,
            userText: userText,
            executedCapabilities: loop.usedToolNames,
            deniedCapabilities: denied,
            succeeded: loop.stopReason == .completed && denied.isEmpty,
            cancelled: loop.stopReason == .cancelled))
    }

    private func verifyCurrentDateTimeResultIfNeeded(loop: inout AgentLoopRunResult,
                                                     taskID: UUID,
                                                     runID: UUID,
                                                     conversationID: UUID?,
                                                     userMessageID: UUID?,
                                                     emit: @Sendable (PetAgentRuntimeOutput) -> Void) async {
        guard CurrentDateTimeObservationVerifier.requiresVerification(loop) else { return }
        await emitActivity(kind: .verificationStarted,
                           taskID: taskID,
                           runID: runID,
                           conversationID: conversationID,
                           userMessageID: userMessageID,
                           title: "正在验证工具结果",
                           detail: "检查本地日期和时间工具返回",
                           stepID: "tool-get_current_datetime",
                           toolName: CurrentDateTimeObservationVerifier.toolName,
                           emit: emit)
        switch CurrentDateTimeObservationVerifier.verify(loop.observations) {
        case .succeeded:
            await emitActivity(kind: .verificationSucceeded,
                               taskID: taskID,
                               runID: runID,
                               conversationID: conversationID,
                               userMessageID: userMessageID,
                               title: "已验证工具结果",
                               detail: "日期时间结果来自工具返回",
                               stepID: "tool-get_current_datetime",
                               toolName: CurrentDateTimeObservationVerifier.toolName,
                               emit: emit)
        case .failed(let detail):
            await emitActivity(kind: .verificationFailed,
                               taskID: taskID,
                               runID: runID,
                               conversationID: conversationID,
                               userMessageID: userMessageID,
                               title: "工具结果验证失败",
                               detail: detail,
                               stepID: "tool-get_current_datetime",
                               toolName: CurrentDateTimeObservationVerifier.toolName,
                               failureCategory: .validationFailed,
                               emit: emit)
            if loop.stopReason == .completed {
                loop.stopReason = .toolFailure
                loop.terminalState = .failed
                loop.finalResponse = AgentFinalResponse(text: "工具结果验证失败，已停止使用该结果。",
                                                        finishReason: AgentLoopStopReason.toolFailure.rawValue)
            }
        }
    }


    // MARK: Agentic loop — propose → gate → execute → observe → re-decide (P1)
    // askUser fail-closed (§12); the model only ever proposes — every step still passes the gate.

    private struct PlanRunResult: Sendable {
        var executed: [String]; var denied: [String]; var waiting: [String]
        var state: AgentTaskState; var presentation: CharacterPresentation
        var observations: [ToolObservation] = []
    }

    /// One round of a plan: gate + execute each step, producing observations to feed back. Mutates the
    /// shared task coordinator so lifecycle/state stays continuous across loop rounds.
    private struct StepPassResult: Sendable {
        var executed: [String] = []; var denied: [String] = []; var waiting: [String] = []
        var observations: [ToolObservation] = []
    }

    private func executeSteps(_ plan: AgentPlan, coord: inout AgentTaskCoordinator,
                              ume: UserMessageEvent, taskID: UUID, attemptID: UUID,
                              source: DecisionSource) async -> StepPassResult {
        var pass = StepPassResult()
        for step in ActionScheduler().order(plan) {
            let outcome = await gate.evaluate(capabilityID: step.capabilityID, reason: step.description, taskID: taskID)
            switch outcome {
            case .granted(let token):
                let toolOutcome = await executor.execute(step: step, token: token)
                coord.ingest(.fileChangeProposed(DiffRef(id: step.capabilityID), operationID: "op-\(taskID)-\(step.capabilityID)"))
                pass.executed.append(step.capabilityID)
                pass.observations.append(ToolObservation(
                    stepID: step.capabilityID, capabilityID: step.capabilityID, ok: toolOutcome.ok,
                    summary: Self.observationSummary(toolOutcome)))
            case .askUser:                                  // fail closed — do NOT execute (§12)
                coord.ingest(.stateChanged(.awaitingPermission))
                coord.ingest(.capabilityRequested(CapabilityRequest(capability: step.capabilityID, reason: "awaiting approval")))
                try? await record(kind: .waitingForApproval, state: .awaitingPermission,
                                  taskID: taskID, attemptID: attemptID,
                                  conversationID: ume.conversationID,
                                  userMessageID: ume.messageID,
                                  retryOfTaskID: ume.retryOfTaskID,
                                  regeneratedFromMessageID: ume.regeneratedFromMessageID,
                                  decisionSource: source)
                // P14.1 — mirror waiting-for-approval state into the durable
                // kernel and append an `approvalDecisionRequested` event so the
                // approval can be rehydrated by a fresh Runtime B (R-B-07).
                await mirrorWaitingForApproval(taskID: taskID,
                                               attemptID: attemptID,
                                               conversationID: ume.conversationID)
                pass.waiting.append(step.capabilityID)
            case .denied:
                coord.ingest(.capabilityRequested(CapabilityRequest(capability: step.capabilityID, reason: "denied")))
                pass.denied.append(step.capabilityID)
            }
        }
        return pass
    }

    /// The iterative driver. Runs the initial proposed plan, folds its observations into context, and
    /// re-asks the decision engine until it returns a terminal decision or a budget/guard fires. Every
    /// side effect still goes through `executeSteps` → gate; the model never holds a grant.
    private func runAgenticLoop(goal: String, initialDecision: AgentDecision, ctx: AgentContext,
                                ume: UserMessageEvent, taskID: UUID, attemptID: UUID,
                                source: DecisionSource, policy: AgentPolicy? = nil,
                                parentTaskID: UUID? = nil) async -> PlanRunResult {
        dyeFrom(ume, taskID: taskID)
        let policy = policy ?? self.policy
        var coord = AgentTaskCoordinator(definition: AgentTaskDefinition(goal: goal, workspace: "agent"))
        coord.start(); coord.approve(); coord.ingest(.stateChanged(.preparing)); coord.ingest(.stateChanged(.running))

        var executed: [String] = [], denied: [String] = []
        var observations: [ToolObservation] = []
        var executedSignatures = Set<String>()
        let start = clock.now()
        var currentDecision = initialDecision
        var terminalDecision: AgentDecision? = nil

        // P14.2 — R-A-F3: register the attempt as active for its durable
        // taskID so `cancel(taskID:)` can reach it. The de-registration on
        // every return path (success, fail, cancel) is the
        // `endActiveAttempt(taskID:)` helper.
        let childActive = ActiveGeneration(taskID: taskID,
                                           attemptID: attemptID,
                                           userMessageID: ume.messageID,
                                           assistantID: UUID(),
                                           sequence: 0)
        registerActiveAttempt(childActive)
        defer { endActiveAttempt(taskID: taskID) }

        loop: for iteration in 0..<max(1, policy.maxIterations) {
            // P14.2 — R-A-F3: cancellation check at the top of every
            // iteration, before model call, before tool execution, before
            // checkpoint write, before state transition.
            if isCancelledAssistant(for: ume.conversationID) || Task.isCancelled || isAttemptTerminalized(attemptID) {
                coord.cancel()
                return PlanRunResult(executed: executed, denied: denied, waiting: [], state: coord.state,
                                     presentation: render("已取消。", mode: .casual, emotion: .neutral),
                                     observations: observations)
            }
            // Per-iteration shared record() args — built once, reused by every
            // dispatch arm below (pure aggregator, not a write).
            let iterCtx = AgenticLoopIterationContext(
                taskID: taskID, attemptID: attemptID,
                conversationID: ume.conversationID, userMessageID: ume.messageID,
                retryOfTaskID: ume.retryOfTaskID,
                regeneratedFromMessageID: ume.regeneratedFromMessageID,
                parentTaskID: parentTaskID, source: source, iteration: iteration)
            switch currentDecision {
            case .proposePlan(let proposal):
                let plan = AgentPlanner.plan(from: .proposePlan(proposal)) ?? AgentPlan(goal: goal, steps: [])
                // P14.2 — R-A-F3: cancellation check before tool execution.
                if isAttemptTerminalized(attemptID) { coord.cancel(); break loop }
                let pass = await executeSteps(plan, coord: &coord, ume: ume, taskID: taskID,
                                              attemptID: attemptID, source: source)
                // P14.2 — R-A-F3: cancellation check after tool execution.
                if isAttemptTerminalized(attemptID) { coord.cancel(); break loop }
                if !pass.waiting.isEmpty {                   // fail-closed: stop the loop, await approval
                    // P16 GAP-01: avoid the developer-facing placeholder copy
                    // "审批界面尚未完成…". The companion TaskActivityCard with
                    // "等待你的确认" / "需要你的允许才能继续" copy and 允许 /
                    // 不允许 buttons is the canonical approval surface.
                    return PlanRunResult(executed: executed, denied: denied, waiting: pass.waiting, state: coord.state,
                                         presentation: render("需要你的允许才能继续。",
                                                              mode: .permissionRequest, emotion: .neutral),
                                         observations: observations)
                }
                executed.append(contentsOf: pass.executed)
                denied.append(contentsOf: pass.denied)
                observations.append(contentsOf: pass.observations)
                for step in plan.steps { executedSignatures.insert(StepSignature.compute(step)) }
// P14.2 — R-A-F3: cancellation check before checkpoint write.
                if isAttemptTerminalized(attemptID) { coord.cancel(); break loop }
                try? await record(kind: .toolObserved, state: .running, taskID: iterCtx.taskID,
                                  attemptID: iterCtx.attemptID,
                                  conversationID: iterCtx.conversationID,
                                  userMessageID: iterCtx.userMessageID,
                                  retryOfTaskID: iterCtx.retryOfTaskID,
                                  regeneratedFromMessageID: iterCtx.regeneratedFromMessageID,
                                  parentTaskID: iterCtx.parentTaskID,
                                  operationID: iterCtx.operationID(prefix: "iter"),
                                  decisionSource: iterCtx.source,
                                  outputSequence: iterCtx.iteration)
            case .delegate(let delegation):
                let summary = await runDelegatedTask(delegation, parentPolicy: policy, ctx: ctx, ume: ume,
                                                     parentTaskID: taskID)
                observations.append(ToolObservation(stepID: "delegate", capabilityID: "agent.delegate",
                                                    ok: true, summary: summary))
                try? await record(kind: .delegated, state: .running, taskID: iterCtx.taskID,
                                  attemptID: iterCtx.attemptID,
                                  conversationID: iterCtx.conversationID,
                                  userMessageID: iterCtx.userMessageID,
                                  retryOfTaskID: iterCtx.retryOfTaskID,
                                  regeneratedFromMessageID: iterCtx.regeneratedFromMessageID,
                                  parentTaskID: iterCtx.parentTaskID,
                                  operationID: iterCtx.operationID(prefix: "delegate"),
                                  decisionSource: iterCtx.source,
                                  outputSequence: iterCtx.iteration)
            default:
                terminalDecision = currentDecision; break loop
            }

            // Budget guards (pure): any of {toolCalls, iterations, wallClock} hit ⇒ break.
            if AgenticLoopMath.isBudgetExhausted(
                executedCount: executed.count,
                iterationIndex: iteration,
                maxToolCalls: policy.maxToolCalls,
                maxIterations: max(1, policy.maxIterations),
                elapsedSeconds: clock.now().timeIntervalSince(start),
                maxWallClock: policy.maxWallClock) {
                break loop
            }

            // P14.2 — R-A-F3: cancellation check before model re-decide.
            if isAttemptTerminalized(attemptID) { coord.cancel(); break loop }

            // Re-decide with observations folded in.
            var ctx2 = ctx
            ctx2.observations = observations
            let (next, _) = await decisionEngine.decide(context: ctx2, policy: policy)
            // Progress guard (pure): if every proposed step was already executed, we're
            // making no progress. The math helper handles the dedup signature.
            if AgenticLoopMath.isNoProgress(next: next, executedSignatures: executedSignatures) {
                break loop
            }
            currentDecision = next
        }

        // P14.2 — R-A-F3 + R-A-F4: before recording the agentic-loop
        // terminal state, check whether this attempt has already been
        // terminalized by `cancel(taskID:)` or a stale callback.
        // If yes, drop the terminal write entirely — the durable store
        // already encodes the canonical terminal state (.cancelled).
        if isAttemptTerminalized(attemptID) {
            // Emit a stale-callback audit so operators can see what
            // happened, but do NOT emit a successful completion event.
            await recordAudit(kind: .staleCallbackDropped, correlationID: taskID,
                                  summary: "agenticLoop:terminalized:\(attemptID)",
                                  timestamp: clock.now())
            return PlanRunResult(executed: executed, denied: denied, waiting: [],
                                 state: .cancelled,
                                 presentation: render("已取消。", mode: .casual, emotion: .neutral),
                                 observations: observations)
        }
        coord.ingest(.stateChanged(denied.isEmpty ? .succeeded : .partiallySucceeded))
        try? await record(kind: denied.isEmpty ? .completed : .failed,
                          state: denied.isEmpty ? .succeeded : .partiallySucceeded,
                          taskID: taskID, attemptID: attemptID,
                          conversationID: ume.conversationID, userMessageID: ume.messageID,
                          retryOfTaskID: ume.retryOfTaskID,
                          regeneratedFromMessageID: ume.regeneratedFromMessageID,
                          parentTaskID: parentTaskID,
                          decisionSource: source, terminal: true)
        // P14.2 — R-B-F05: gate the durable mirror through acceptance. A
        // Goal-backed task whose criteria are unmet must NOT be marked
        // `.completed` by the agentic loop — the supervisor must remain
        // able to resume it.
        await mirrorTerminalDurableIfAcceptable(
            taskID: taskID, attemptID: attemptID,
            legacyState: denied.isEmpty ? .succeeded : .partiallySucceeded,
            title: "agenticLoopTerminal",
            conversationID: ume.conversationID)

        // P4 self-evolution: reflect on tool-tasks only (pure chat never reaches here). Side channel —
        // it only proposes memories; it cannot change this task's outcome.
        if !executed.isEmpty || !denied.isEmpty {
            await reflection.reflect(TaskReflectionInput(
                goal: goal, userText: ctx.userText, executedCapabilities: executed,
                deniedCapabilities: denied, succeeded: denied.isEmpty, cancelled: false))
        }

        let presentation = terminalPresentation(terminalDecision, goal: goal,
                                                executed: executed, denied: denied)
        return PlanRunResult(executed: executed, denied: denied, waiting: [], state: coord.state,
                             presentation: presentation, observations: observations)
    }

    /// Runs a sub-goal as a bounded child agent (P3). The child gets a least-privilege capability
    /// subset (intersection of the requested subset and the parent's), a deeper delegation level, and
    /// its own scratchpad; it reports only a textual summary back to the parent. Child ledger events
    /// carry `parentTaskID` for the parent/child chain.
    private func runDelegatedTask(_ delegation: DelegationDecision, parentPolicy: AgentPolicy,
                                  ctx: AgentContext, ume: UserMessageEvent, parentTaskID: UUID) async -> String {
        let parentAllow = parentPolicy.capabilityAllowlist
        let requested = Set(delegation.allowedCapabilities)
        let childAllow = parentAllow.map { $0.intersection(requested) } ?? requested
        let childPolicy = AgentPolicy(
            allowTools: parentPolicy.allowTools, maxSteps: parentPolicy.maxSteps,
            maxIterations: parentPolicy.maxIterations, maxToolCalls: parentPolicy.maxToolCalls,
            maxWallClock: parentPolicy.maxWallClock, capabilityAllowlist: childAllow,
            maxDelegationDepth: parentPolicy.maxDelegationDepth,
            delegationDepth: parentPolicy.delegationDepth + 1, tier: parentPolicy.tier)

        var childCtx = ctx
        childCtx.userText = delegation.goal
        childCtx.observations = []
        let (childDecision, childSource) = await decisionEngine.decide(context: childCtx, policy: childPolicy)
        let childTaskID = UUID(), childAttemptID = UUID()
        if privateTaskIDs.contains(parentTaskID) { privateTaskIDs.insert(childTaskID) }
        let res = await runAgenticLoop(goal: delegation.goal, initialDecision: childDecision, ctx: childCtx,
                                       ume: ume, taskID: childTaskID, attemptID: childAttemptID,
                                       source: childSource, policy: childPolicy, parentTaskID: parentTaskID)
        let body = res.presentation.bubbles.joined()
        let summary = "[子任务] \(delegation.goal)：执行 \(res.executed.count) 步" +
            (res.denied.isEmpty ? "" : "，\(res.denied.count) 步被拦") +
            (body.isEmpty ? "" : "。\(body)")
        return summary.count <= 512 ? summary : String(summary.prefix(512))
    }

    /// Prefer a terminal model decision's own text; otherwise summarize what the loop executed.
    private func terminalPresentation(_ decision: AgentDecision?, goal: String,
                                      executed: [String], denied: [String]) -> CharacterPresentation {
        switch decision {
        case .respond(let r) where !r.text.isEmpty:
            return render(r.text, mode: .casual, emotion: r.emotion)
        case .askClarification(let c):
            return render(c.question, mode: .focusedAssistant, emotion: .thinking)
        case .decline(let d):
            return render(d.reason, mode: .focusedAssistant, emotion: .neutral)
        default:
            let summary = denied.isEmpty ? "完成了 \(executed.count) 步：\(goal)"
                                         : "完成 \(executed.count) 步，\(denied.count) 步被权限拦下：\(goal)"
            return render(summary, mode: .taskCompletion, emotion: .happy)
        }
    }

    private static func stepSignature(_ step: AgentPlanStep) -> String {
        let params = step.params.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        return "\(step.capabilityID)|\(params)"
    }

    private static func observationSummary(_ outcome: ToolOutcome) -> String {
        let raw = outcome.ok ? outcome.output : (outcome.error ?? "failed")
        return raw.count <= 256 ? raw : String(raw.prefix(256))
    }

    private static func presentationSnapshot(from event: PlanExecutionEvent) -> PlanPresentationSnapshot? {
        switch event {
        case .planCreated(let snapshot),
             .approvalRequired(let snapshot),
             .planApproved(let snapshot),
             .planCancelled(let snapshot),
             .stepStarted(_, let snapshot),
             .stepFinished(_, _, let snapshot),
             .stepSkipped(_, _, let snapshot),
             .replanning(let snapshot),
             .verificationStarted(let snapshot),
             .verificationCompleted(_, let snapshot),
             .synthesisStarted(let snapshot),
             .completed(let snapshot):
            return snapshot
        case .failed(_, let snapshot):
            return snapshot
        }
    }

    func isCancelledAssistant(for conversationID: UUID) -> Bool {
        if cancelledConversations.contains(conversationID) { return true }
        guard let active = activeByConversation[conversationID] else { return false }
        return cancelled.contains(active.assistantID)
    }

    // MARK: Non-streaming convenience (tests / self-test) — same engine, aggregated result

    public func run(_ event: PetAgentEvent) async -> AgentRunResult {
        guard case .userMessage(let ume) = event else { return AgentRunResult() }
        _ = seenEvents.insert(ume.eventID)
        let ctx = await context.build(for: event)
        let (decision, source) = await decisionEngine.decide(context: ctx, policy: policy)
        switch decision {
        case .respond(let response):
            var buffer = response.text; var emotion: PetEmotion = response.emotion
            if response.text.isEmpty {
                let req = ConversationRequest(text: ume.text, memoryHints: ctx.memoryHints,
                                              isPrivate: ume.conversationClass == .privateChat,
                                              useScreen: ume.metadata.useScreen)
                if let collected = try? await collect(req) { buffer = collected.0; emotion = collected.1 }
            }
            return AgentRunResult(presentation: render(buffer, mode: .casual, emotion: emotion))
        case .proposePlan:
            let taskID = UUID()
            let initial = StructuredAgentLoopDecisionAdapter.map(StructuredDecisionResult(
                decision: decision, decisionSource: source, modelProvider: "structured-adapter"))
            let controller = AgentLoopController(provider: await loopDecisionProviderFactory(),
                                                 gate: gate,
                                                 executor: executor,
                                                 toolCatalogProvider: toolCatalogProvider,
                                                 toolPlatformExecutor: toolPlatformExecutor,
                                                 systemAuthorization: systemAuthorization,
                                                 policy: policy,
                                                 limits: AgentLoopLimits.forPolicy(policy),
                                                 clock: clock,
                                                 localeProvider: localeProvider,
                                                 timeZoneProvider: timeZoneProvider)
            let loop = await controller.run(agentContext: ctx, taskID: taskID, initialDecision: initial)
            await reflectLoopOutcome(loop, userText: ctx.userText, goal: ctx.userText ?? "agent", isPrivate: ume.conversationClass == .privateChat)
            let final = loop.finalResponse?.text ?? (loop.stopReason == .cancelled ? "已取消。" : "")
            let denied = loop.observations.filter { $0.status != .success }.map(\.toolName)
            return AgentRunResult(presentation: render(final, mode: .casual, emotion: .neutral),
                                  executedSteps: loop.usedToolNames,
                                  deniedSteps: denied,
                                  taskState: loop.terminalState,
                                  waitingApproval: loop.waitingApproval,
                                  stopReason: loop.stopReason,
                                  observations: loop.observations)
        case .delegate(let delegation):
            let taskID = UUID()
            let attemptID = UUID()
            let res = await runAgenticLoop(goal: delegation.goal, initialDecision: decision, ctx: ctx,
                                           ume: ume, taskID: taskID, attemptID: attemptID,
                                           source: source)
            return AgentRunResult(presentation: res.presentation, executedSteps: res.executed,
                                  deniedSteps: res.denied, taskState: res.state, waitingApproval: res.waiting)
        case .askClarification(let clarification):
            return AgentRunResult(presentation: render(clarification.question, mode: .focusedAssistant, emotion: .thinking))
        case .decline(let decline):
            return AgentRunResult(presentation: render(decline.reason, mode: .focusedAssistant, emotion: .neutral))
        case .noAction:
            return AgentRunResult()
        }
    }

    private func collect(_ req: ConversationRequest) async throws -> (String, PetEmotion) {
        var buffer = ""; var emotion: PetEmotion = .neutral
        for try await chunk in conversation.generate(req) {
            switch chunk {
            case .metadata:
                break
            case .delta(_, let text):
                buffer += text
            case .completed(let e, _):
                emotion = e
            case .typedError(let failure):
                // P14.2 — R-B-F01: surface the typed failure to the
                // caller via rethrow. The `try? await collect(...)` call
                // site in `run(...)` converts this to an empty buffer.
                throw ConversationGenerationError(message: failure.message)
            }
        }
        return (buffer, emotion)
    }

    public func reconcileAfterRestart() async -> [AgentTaskSnapshot] {
        // P14.1 — R-B-06 closure. Production restart now consults
        // `RecoveryClassifier` rather than blindly flipping non-terminal
        // tasks to `.failed / interruptedByRestart`. The old behaviour
        // destroyed recoverable / waiting state on every launch.
        let active = (try? await ledger.activeTasks()) ?? []

        // Drive the durable kernel first when available: classify each
        // persisted durable record and apply the recovery action.
        if let store = durableTaskStore {
            await store.load()
            for record in await store.nonTerminalTasks() {
                let classification = await recoveryClassifier.classify(record)
                switch classification.action {
                case .leaveUnchanged,
                     .waitingForApprovalSurvives,
                     .waitingForUserInputSurvives,
                     .waitingForToolSurvives,
                     .waitingForRetrySurvives:
                    // Waiting and paused/interrupted states survive untouched.
                    // No `applyTransition` call — the durable record already
                    // encodes the correct state.
                    continue
                case .markInterrupted:
                    // Active at time of crash → mark interrupted so a new
                    // attempt can be created. This is the legitimate
                    // "interrupted by restart" transition.
                    _ = await store.applyTransition(taskID: record.taskID,
                                                    to: .interrupted)
                case .unknownStateReviewRequired:
                    // Persisted as `.unknown`. Manual review required; do NOT
                    // auto-flip to terminal. Leave the record as-is and emit
                    // a `RuntimeAuditEvent.invalidTransition` so an operator
                    // can see it.
                    if let audit = durableAuditLogStore {
                        await audit.record(RuntimeAuditEvent(kind: .invalidTransition,
                                                             correlationID: record.taskID,
                                                             summary: "recovery:unknownStateReviewRequired",
                                                             timestamp: clock.now()))
                    }
                }
            }
        }

        // Legacy ledger reconciliation: also classify the in-process ledger
        // snapshot through `RecoveryClassifier` and translate its actions
        // into legacy record events. Where a durable task exists for the
        // same taskID, the legacy record is left alone (the durable store is
        // authoritative — INV-INT-02). Where the durable store is absent,
        // the legacy record is updated through the legacy semantics but
        // without destroying recoverable states.
        for snapshot in active where !snapshot.state.isTerminal {
            // Pre-existing legacy behaviour: `.awaitingPermission` is left
            // alone (this corresponds to durable `.waitingForApproval`).
            if snapshot.state == .awaitingPermission { continue }
            let legacyAction: RecoveryClassification.Action
            switch snapshot.state {
            case .running, .preparing, .queued, .draft, .recovering, .cancelling:
                legacyAction = .markInterrupted
            case .awaitingUserInput, .paused, .awaitingApproval:
                legacyAction = .leaveUnchanged
            default:
                legacyAction = .markInterrupted
            }
            switch legacyAction {
            case .leaveUnchanged,
                 .waitingForApprovalSurvives,
                 .waitingForUserInputSurvives,
                 .waitingForToolSurvives,
                 .waitingForRetrySurvives:
                continue
            case .markInterrupted:
                try? await record(kind: .interruptedByRestart, state: .recovering,
                                  taskID: snapshot.taskID, attemptID: snapshot.attemptID,
                                  conversationID: snapshot.conversationID,
                                  userMessageID: snapshot.userMessageID,
                                  assistantMessageID: snapshot.assistantMessageID,
                                  retryOfTaskID: snapshot.retryOfTaskID,
                                  regeneratedFromMessageID: snapshot.regeneratedFromMessageID,
                                  failureReason: "interruptedByRestart", terminal: false)
                await mirrorDurable(taskID: snapshot.taskID,
                                    attemptID: snapshot.attemptID,
                                    legacyState: .recovering,
                                    title: "reconciled:interrupted",
                                    conversationID: snapshot.conversationID)
            case .unknownStateReviewRequired:
                continue
            }
        }
        return active
    }

    // MARK: - P14.4 — retry deadline enforcement + REAL execution driver (INV-RD-01..04, INV-EXEC-01..05)
    //
    // Walk every durable `.waitingForRetry` task and decide, against an
    // injectable clock, whether the deadline has elapsed. Tasks whose
    // `nextRetryAt` is still in the future remain `.waitingForRetry`
    // (early retry prevented — INV-RD-01 + INV-RD-02). Tasks whose
    // deadline has elapsed:
    //   1. acquire a fresh attemptID (idempotency via `recordNewAttempt`
    //      guarantees no duplicate retries — INV-RD-03);
    //   2. transition to `.running`;
    //   3. emit `RuntimeAuditKind.retryResumed`;
    //   4. **drive REAL production execution** via `resumeExecution(...)`
    //      which calls the authoritative `coordinator.handle(event)`
    //      pipeline — invoking `converse()` → `conversation.generate(...)`.
    //      The provider/model/tool boundary is exercised end-to-end.
    // `.cancelled` is terminal and is filtered out — INV-RD-04.
    //
    // `now:` is an injectable closure so tests can advance the clock
    // deterministically without `Task.sleep`.
    @discardableResult
    public func evaluateRetries(now: @escaping @Sendable () -> Date = { Date() }) async -> Set<UUID> {
        guard let store = durableTaskStore else { return [] }
        let nowDate = now()
        var resumed: Set<UUID> = []
        let nonTerminal = await store.nonTerminalTasks()
        for record in nonTerminal where record.status == .waitingForRetry {
            // INV-RD-04 — cancel wins; if the record is cancelled mid-sleep,
            // it should not be transitioned. The classifier already filters
            // terminal records out via `nonTerminalTasks()`, but defensive
            // double-check.
            guard !record.status.isTerminal else { continue }
            // INV-RD-01 — deadline is execution-authoritative. When the
            // record has no `nextRetryAt`, we treat the deadline as
            // "unknown" and leave the record unchanged (matches the
            // existing test-helper behavior — callers that transition into
            // `.waitingForRetry` without an explicit `nextRetryAt` get a
            // nil deadline which means "do not auto-retry").
            guard let deadline = record.nextRetryAt else { continue }
            // INV-RD-02 — restart cannot bypass deadline. If the deadline
            // is in the future, the record stays `.waitingForRetry`.
            guard nowDate >= deadline else { continue }
            if await driveSingleRetry(taskID: record.taskID, now: { nowDate }) {
                resumed.insert(record.taskID)
            }
        }
        return resumed
    }

    /// P14.4 — single-task retry eligibility + execution. Used by
    /// `evaluateRetries` for the startup-time batch path AND by
    /// `RuntimeRetryScheduler` for the live wakeup path. Both share
    /// the SAME authoritative primitive — no duplicated decision logic
    /// (per §15). Returns idempotent is enforced by the actor's
    /// serialized execution: only the first call observing
    /// `.waitingForRetry` transitions + creates the attempt; concurrent
    /// callers observing `.running` (already transitioned) bail out
    /// (INV-WAKE-01).
    @discardableResult
    public func driveSingleRetry(taskID: UUID, now: @escaping @Sendable () async -> Date = { Date() }) async -> Bool {
        guard let store = durableTaskStore else { return false }
        let nowDate = await now()
        guard let record = await store.task(id: taskID) else { return false }
        // Terminal records never resume (INV-WAKE-05).
        guard !record.status.isTerminal else { return false }
        guard record.status == .waitingForRetry else {
            // Already transitioned (or in some other state). For the
            // single-task primitive, only `.waitingForRetry` is
            // eligible. Other non-terminal states are no-ops.
            return false
        }
        guard let deadline = record.nextRetryAt else { return false }
        guard nowDate >= deadline else { return false }
        // Atomic on the actor: only the first concurrent caller
        // observes `.waitingForRetry` and transitions. Subsequent
        // concurrent callers observe `.running` and bail.
        // INV-RD-03 + INV-WAKE-01.
        let attemptID = UUID()
        _ = await store.recordNewAttempt(taskID: taskID, attemptID: attemptID, runID: attemptID)
        _ = await store.applyTransition(taskID: taskID, to: .running)
        if let audit = durableAuditLogStore {
            await audit.record(RuntimeAuditEvent(kind: .retryResumed,
                                                 correlationID: taskID,
                                                 summary: "elapsed=\(Int(deadline.timeIntervalSince(nowDate) * -1))s",
                                                 timestamp: nowDate))
        }
        // Drive REAL production execution. Pass `attemptID` as the
        // UME's `runIDOverride` so the pipeline's `mirrorDurable` reuses
        // the existing attempt (no duplicate attempt records).
        _ = await resumeExecution(taskID: taskID, now: { nowDate }, reuseAttemptID: attemptID)
        return true
    }

    /// P14.4 — shared executable resume primitive. INV-EXEC-01..05.
    ///
    /// Drives real production execution from durable state. Used by:
    ///   - `recoverPendingApprovals` after the supervisor observes
    ///     `.approved` (post-approval resume, A1);
    ///   - `evaluateRetries(now:)` for each deadline-eligible task
    ///     (Runtime A→B retry, R1);
    ///   - `RuntimeRetryScheduler.driveDueWork` for live wakeup
    ///     (live retry, L1).
    ///
    /// The method reconstructs a `UserMessageEvent` from durable intent
    /// (NOT replaying user chat text), keyed by the durable `taskID`
    /// via `taskIDOverride`. It then invokes the authoritative
    /// `coordinator.handle(event)` pipeline — which calls `process →
    /// converse → conversation.generate(...)`. The real provider/model
    /// boundary is exercised; the resulting stream of `PetAgentRuntimeOutput`
    /// events drives the durable observation/acceptance chain.
@discardableResult
    public func resumeExecution(taskID: UUID,
                                 now: @escaping @Sendable () async -> Date = { Date() },
                                 reuseAttemptID: UUID? = nil) async -> PostApprovalOutcome {
        guard let store = durableTaskStore else {
            return .noDurableKernel(taskID: taskID)
        }
        guard var record = await store.task(id: taskID) else {
            return .noSuchTask(taskID: taskID)
        }
        // P14.4 — `resumeExecution` is invoked by THREE callers:
        //   1. supervisor Task after approval (record is `.running` already)
        //   2. `driveSingleRetry` / `evaluateRetries` (record is `.running` already)
        //   3. `RuntimeRetryScheduler.driveDueWork` (record is `.running` already)
        // All three callers transition the record to `.running` BEFORE
        // calling `resumeExecution`. So we just verify the state and
        // drive the pipeline.
        //
        // If the record is `.waitingForRetry` (an unanticipated caller),
        // we transition it here as a defensive fallback. This is NOT
        // the production retry path — production uses
        // `driveSingleRetry` which owns the transition.
        if record.status == .waitingForRetry {
            let newAttemptID = UUID()
            _ = await store.recordNewAttempt(taskID: taskID, attemptID: newAttemptID, runID: newAttemptID)
            _ = await store.applyTransition(taskID: taskID, to: .running)
            if let audit = durableAuditLogStore {
                await audit.record(RuntimeAuditEvent(kind: .retryResumed,
                                                     correlationID: taskID,
                                                     summary: "resumeExecution-fallback",
                                                     timestamp: await now()))
            }
            record = (await store.task(id: taskID)) ?? record
        }
        guard record.status == .running else {
            return .unexpectedState(taskID: taskID, state: record.status)
        }
        // Reconstruct a UME from durable intent. The conversationID is
        // the durable record's conversationID (or a fresh UUID if the
        // record didn't capture one — the test fixtures always set it).
        // The text is a deterministic recovery marker that the provider
        // fixture recognizes. `taskIDOverride` routes the synthetic
        // event to the SAME durable taskID; `runIDOverride` produces
        // a controlled fresh runID for the new attempt.
        //
        // If `reuseAttemptID` is provided (from `driveSingleRetry`),
        // use it so the pipeline's `mirrorDurable` sees an existing
        // attempt and skips creating a duplicate (INV-WAKE-01
        // — exactly one attempt per retry wakeup).
        let conversationID = record.conversationID ?? UUID()
        let runID = reuseAttemptID ?? UUID()
        let recoveredText = "__p14_4_resume__:taskID=\(taskID.uuidString):phase=\(record.title)"
        let recoveredUME = UserMessageEvent(
            conversationID: conversationID,
            messageID: UUID(),
            text: recoveredText,
            conversationClass: .normal,
            createdAt: await now(),
            taskIDOverride: taskID,
            runIDOverride: runID
        )
        // INV-EXEC-03 — recovery uses durable intent. We do NOT replay
        // the user's original chat text; we construct the UME from
        // durable state only.
        // INV-EXEC-04 — same taskID, controlled new runID via
        // `runIDOverride`.
        // INV-EXEC-05 — single driver: this is the only resume
        // primitive; both approval and retry converge here.
        let auditTime = await now()
        if let audit = durableAuditLogStore {
            await audit.record(RuntimeAuditEvent(kind: .postApprovalResumed,
                                                 correlationID: taskID,
                                                 summary: "recovered:\(record.title)",
                                                 timestamp: auditTime))
        }
        // Drain the authoritative pipeline synchronously. The
        // AsyncStream returned by `handle` finishes when `process`
        // returns. The pipeline emits `PetAgentRuntimeOutput` events
        // that drive durable state (via `mirrorDurable`,
        // `mirrorTerminalDurableIfAcceptable`).
        let stream = handle(.userMessage(recoveredUME))
        for await output in stream {
            // The pipeline handles state mutation, observation
            // persistence, and acceptance evaluation internally. We
            // simply drain here.
            _ = output
        }
        // After the pipeline drains, re-read the durable record to
        // determine the final outcome (the pipeline transitioned the
        // record to `.completed` if acceptance was met, otherwise it
        // is `.running` / `.waitingForApproval` / etc.).
        let finalRecord = await store.task(id: taskID) ?? record
        if finalRecord.status == .completed {
            // Reconstruct the evaluation by reading the goal + criteria.
            if let goal = await durableGoal(forTask: taskID) {
                return .completed(taskID: taskID, evaluation: acceptanceEvaluator.mayComplete(goal: goal))
            }
            return .noGoalBound(taskID: taskID)
        }
        if let goal = await durableGoal(forTask: taskID) {
            let evaluation = acceptanceEvaluator.mayComplete(goal: goal)
            switch evaluation {
            case .allSatisfied:
                // Goal is satisfied but the record hasn't transitioned
                // yet (shouldn't happen — the pipeline does it). Report
                // it; the caller can decide what to do.
                return .completed(taskID: taskID, evaluation: evaluation)
            case .waitingForUser(let missing):
                return .awaitingUser(taskID: taskID, missing: missing.map(\.criterionID))
            case .unsatisfied(let missing):
                return .awaitingCriteria(taskID: taskID, missing: missing.map(\.criterionID))
            }
        }
        return .noGoalBound(taskID: taskID)
    }

    /// P14.4 — back-compat shim. `recoverPendingApprovals` previously
    /// called `resumeAgenticWorkAfterApproval(taskID:)` to drive
    /// post-approval execution. P14.4 collapses the post-approval path
    /// and the retry path into the same `resumeExecution(taskID:now:)`
    /// primitive. This shim preserves the old name for any existing
    /// callers / tests; new tests should call `resumeExecution` directly.
    @discardableResult
    public func resumeAgenticWorkAfterApproval(taskID: UUID) async -> PostApprovalOutcome {
        await resumeExecution(taskID: taskID, now: { [clock] in clock.now() })
    }

    /// P14.4 — INV-ACR-01..05 + INV-RD-01..04 outcome surface.
    public enum PostApprovalOutcome: Sendable, Equatable {
        case completed(taskID: UUID, evaluation: AcceptanceEvaluation)
        case awaitingUser(taskID: UUID, missing: [String])
        case awaitingCriteria(taskID: UUID, missing: [String])
        case noGoalBound(taskID: UUID)
        case noDurableKernel(taskID: UUID)
        case noSuchTask(taskID: UUID)
        case unexpectedState(taskID: UUID, state: DurableTaskState)
    }

    /// P14.1 — R-B-07 rehydration helper. After restart, walk the durable
    /// inbox for unconsumed `approvalDecisionRequested` events and rebuild
    /// `pendingPlanApprovals` so the user can still approve / decline across
    /// a process restart.
    public func rehydratePendingApprovals() async {
        guard let inbox = durableInboxStore else { return }
        for event in await inbox.allEvents() where event.consumedAt == nil {
            switch event.kind {
            case .approvalDecisionRequested:
                // The runtime is back online; clear the request so the user
                // sees a fresh prompt. The actual approval flow is driven by
                // the supervisor loop, not by recreating the original
                // continuation (which is gone after restart).
                await inbox.consume(eventID: event.eventID,
                                    attemptID: event.consumedByAttemptID ?? UUID())
            default:
                continue
            }
        }
    }

    // MARK: - P14.2 — continuation reconstruction (R-A-F1)
    //
    // Walk every durable `.waitingForApproval` record on Runtime B and create
    // a fresh `CheckedContinuation` (via TaskSupervisor) keyed by taskID.
    // When the user approves / declines (or the runtime resumes the task),
    // the continuation is consumed and the agentic loop can continue.
    //
    // This is the executable-intent piece: persistence is already in place
    // (durable task + durable inbox). The supervisor wires the two halves
    // together. The continuation itself is not persisted — only the durable
    // facts that triggered its creation.
    //
    // Invariants enforced:
    //   INV-CONT-01 — restored tasks regain an executable continuation path.
    //   INV-CONT-02 — no user re-prompt required (recovery is automatic).
    //   INV-CONT-03 — same taskID, new attemptID/runID if appropriate.
    //   INV-CONT-04 — at most one active continuation per taskID
    //                  (TaskSupervisor.reserveRecovery enforces this).
    //
    // Returns the set of taskIDs that were recovered (test diagnostics).
    @discardableResult
    public func recoverPendingApprovals(timeout: TimeInterval = 1800) async -> Set<UUID> {
        guard let store = durableTaskStore else { return [] }
        await store.load()
        let waiting = await store.allTasks().filter { $0.status == .waitingForApproval }
        var recovered: Set<UUID> = []
        for record in waiting {
            // INV-CONT-04 — only one recovery scan may own a given taskID.
            guard await supervisor.reserveRecovery(taskID: record.taskID) else { continue }
            recovered.insert(record.taskID)
            // Emit an audit event so operators can see the recovery.
            if let audit = durableAuditLogStore {
                await audit.record(RuntimeAuditEvent(kind: .continuationRecovered,
                                                     correlationID: record.taskID,
                                                     summary: "recovered:\(record.title)",
                                                     timestamp: clock.now()))
            }
            // INV-CONT-01 — actually create the continuation. Spawn a
            // background task that drives `awaitPlanApproval(taskID:)` for
            // the recovered taskID. When the user approves / declines via
            // `approveActivePlan(taskID:)` / `cancelActivePlan(taskID:)`,
            // the supervisor continuation is consumed and this task
            // completes. The supervisor itself owns the lifetime — the
            // `awaitPlanApproval` call registers a CheckedContinuation.
            let recoveredTaskID = record.taskID
            Task { [weak self] in
                let decision = await self?.awaitPlanApproval(
                    taskID: recoveredTaskID,
                    planID: TaskPlanID(rawValue: "recovered:\(record.title)"),
                    timeout: timeout)
                if let decision {
                    // Decision consumed by `approveActivePlan(taskID:)` etc.;
                    // here we just record the outcome so audit observers
                    // can see what happened.
                    if let audit = self?.durableAuditLogStore {
                        await audit.record(RuntimeAuditEvent(
                            kind: .continuationRecovered,
                            correlationID: recoveredTaskID,
                            summary: "recoveredDecision:\(decision)",
                            timestamp: Date()))
                    }
                    // P14.4 — drive REAL production execution after
                    // approval (INV-ACR-01..05). The recovery path is
                    // the supervisor-driven resume; the user does NOT
                    // re-send a message.
                    if decision == .approved {
                        _ = await self?.resumeAgenticWorkAfterApproval(taskID: recoveredTaskID)
                    }
                }
            }
        }
        return recovered
    }

    func record(kind: RuntimeLedgerEventKind, state: AgentTaskState, taskID: UUID,
                        attemptID: UUID, conversationID: UUID, userMessageID: UUID,
                        assistantMessageID: UUID? = nil, retryOfTaskID: UUID? = nil,
                        regeneratedFromMessageID: UUID? = nil, parentTaskID: UUID? = nil,
                        operationID: String? = nil,
                        decisionSource: DecisionSource? = nil,
                        providerStreamingCapability: ConversationProviderStreamingCapability? = nil,
                        agentLoopState: String? = nil,
                        stopReason: AgentLoopStopReason? = nil,
                        iterationCount: Int? = nil,
                        toolCallCount: Int? = nil,
                        usedToolNames: [String]? = nil,
                        toolStatuses: [String]? = nil,
                        planID: String? = nil,
                        planVersion: Int? = nil,
                        planStepCount: Int? = nil,
                        planRiskLevel: String? = nil,
                        planApprovalRequired: Bool? = nil,
                        planApprovalGranted: Bool? = nil,
                        planReplanCount: Int? = nil,
                        planResultItemCount: Int? = nil,
                        planResultTruncated: Bool? = nil,
                        modelProvider: String? = nil,
                        latencyMilliseconds: Int? = nil,
                        failureReason: String? = nil, cancelReason: String? = nil,
                        outputSequence: Int? = nil, terminal: Bool = false) async throws {
        // Privacy dye: private tasks leave no ledger rows (and no sequence
        // counters — there is nothing to order). Live UI flows through
        // eventHub envelopes, which this gate does not touch.
        guard !privateTaskIDs.contains(taskID) else { return }
        // P-DSK-01 — sink-first. When the seam is wired, the sink carries
        // the privacy gate (see `CoordinatedDurableSink.record(_:)`). This
        // helper becomes a thin pass-through; the legacy direct-store path
        // below only runs when the seam is nil (DEBUG harnesses without a
        // durable kernel).
        if let sink = durableSink {
            let next = (ledgerSequenceByTask[taskID] ?? -1) + 1
            ledgerSequenceByTask[taskID] = next
            let now = clock.now()
            try await sink.record(AgentTaskLedgerEvent(
                taskID: taskID, attemptID: attemptID, conversationID: conversationID,
                userMessageID: userMessageID, assistantMessageID: assistantMessageID,
                retryOfTaskID: retryOfTaskID, regeneratedFromMessageID: regeneratedFromMessageID,
                parentTaskID: parentTaskID,
                state: state, kind: kind, sequence: next, operationID: operationID,
                decisionSource: decisionSource,
                providerStreamingCapability: providerStreamingCapability,
                agentLoopState: agentLoopState,
                stopReason: stopReason,
                iterationCount: iterationCount,
                toolCallCount: toolCallCount,
                usedToolNames: usedToolNames,
                toolStatuses: toolStatuses,
                planID: planID,
                planVersion: planVersion,
                planStepCount: planStepCount,
                planRiskLevel: planRiskLevel,
                planApprovalRequired: planApprovalRequired,
                planApprovalGranted: planApprovalGranted,
                planReplanCount: planReplanCount,
                planResultItemCount: planResultItemCount,
                planResultTruncated: planResultTruncated,
                modelProvider: modelProvider,
                latencyMilliseconds: latencyMilliseconds,
                failureReason: failureReason, cancelReason: cancelReason,
                outputSequence: outputSequence, createdAt: now, updatedAt: now,
                terminalAt: terminal ? now : nil))
            return
        }
        if let operationID, try await ledger.hasOperationID(operationID) { return }
        let next = (ledgerSequenceByTask[taskID] ?? -1) + 1
        ledgerSequenceByTask[taskID] = next
        let now = clock.now()
        try await ledger.append(AgentTaskLedgerEvent(
            taskID: taskID, attemptID: attemptID, conversationID: conversationID,
            userMessageID: userMessageID, assistantMessageID: assistantMessageID,
            retryOfTaskID: retryOfTaskID, regeneratedFromMessageID: regeneratedFromMessageID,
            parentTaskID: parentTaskID,
            state: state, kind: kind, sequence: next, operationID: operationID,
            decisionSource: decisionSource,
            providerStreamingCapability: providerStreamingCapability,
            agentLoopState: agentLoopState,
            stopReason: stopReason,
            iterationCount: iterationCount,
            toolCallCount: toolCallCount,
            usedToolNames: usedToolNames,
            toolStatuses: toolStatuses,
            planID: planID,
            planVersion: planVersion,
            planStepCount: planStepCount,
            planRiskLevel: planRiskLevel,
            planApprovalRequired: planApprovalRequired,
            planApprovalGranted: planApprovalGranted,
            planReplanCount: planReplanCount,
            planResultItemCount: planResultItemCount,
            planResultTruncated: planResultTruncated,
            modelProvider: modelProvider,
            latencyMilliseconds: latencyMilliseconds,
            failureReason: failureReason, cancelReason: cancelReason,
            outputSequence: outputSequence, createdAt: now, updatedAt: now,
            terminalAt: terminal ? now : nil))
    }

    // MARK: - P14.1 — durable task kernel mirror (R-B-01 wiring)
    //
    // The legacy `record(...)` helper above writes to the in-process
    // `AgentTaskLedgerPersisting` for the activity stream. P14.1 mirrors every
    // meaningful state transition into `DurableTaskStore` (and on the chat
    // completion path also enforces `AcceptanceEvaluator`, R-B-02). When the
    // durable kernel is not injected (DEBUG harnesses, isolated unit tests),
    // these helpers are pure no-ops; the legacy ledger remains the single
    // source of truth for that caller.

    /// Translate a legacy `AgentTaskState` record call into a durable
    /// transition. Routes through the `DurableSink` seam when one is wired;
    /// falls back to the legacy direct-store path otherwise (DEBUG harnesses
    /// without a durable kernel still work without the seam).
    func mirrorDurable(taskID: UUID,
                                   attemptID: UUID,
                                   legacyState: AgentTaskState,
                                   title: String,
                                   failure: DurableFailureRecord? = nil,
                                   origin: AgentTaskOrigin? = nil,
                                   conversationID: UUID? = nil) async {
        if let sink = durableSink {
            await sink.mirrorDurable(taskID: taskID, attemptID: attemptID,
                                     legacyState: legacyState, title: title,
                                     failure: failure,
                                     conversationID: conversationID)
            return
        }
        // Privacy dye: no durable rows, no attempts, no audit for private
        // tasks — including no resume. See `privateTaskIDs`.
        guard !privateTaskIDs.contains(taskID) else { return }
        guard let store = durableTaskStore else { return }
        let durable = DurableTaskState(legacy: legacyState)
        // Create or upsert the task record so the durable store has a row
        // before the first transition is applied (R-B-01 invariant: durable
        // store is the authoritative record).
        //
        // P14.1 fix F-2 (Reviewer A): seed the new record at the translated
        // durable state (NOT at `.queued`), so a single applyTransition can
        // succeed from non-terminal → terminal without rejecting an illegal
        // `.queued → .completed` jump. When the legacy record observes a
        // terminal state on the first mirrorDurable call (e.g., a child
        // task created and immediately completed by `runAgenticLoop`), the
        // seeded record must start at the matching durable state.
        if await store.task(id: taskID) == nil {
            let record = DurableTaskRecord(taskID: taskID,
                                          conversationID: conversationID,
                                          title: title,
                                          status: durable,
                                          retryPolicy: retryPolicy,
                                          origin: origin)
            await store.upsert(record)
        } else {
            // Apply the transition. The store enforces INV-DUR-03 (terminal
            // exactly-once) so a redundant terminal record on a re-entry
            // attempt is rejected silently — that is desired.
            let applied = await store.applyTransition(taskID: taskID, to: durable, failure: failure)
            // P14.1 fix F-6 (Reviewer A): emit an `.invalidTransition`
            // audit event when the durable transition was rejected. The
            // production docstring contract at DurableTaskState.swift:31
            // requires this — mirrorDurable previously broke it.
            if applied == nil, let audit = durableAuditLogStore {
                let current = await store.task(id: taskID)
                await audit.record(RuntimeAuditEvent(kind: .invalidTransition,
                                                     correlationID: taskID,
                                                     summary: "rejected legacy=\(legacyState.rawValue) current=\(current?.status.rawValue ?? "?")",
                                                     timestamp: clock.now()))
            }
        }
        // Mirror attempt record on first observation of an attemptID.
        if await store.attempt(id: attemptID) == nil {
            _ = await store.recordNewAttempt(taskID: taskID,
                                             attemptID: attemptID,
                                             runID: attemptID)
        }
        // Optional audit-log mirror.
        if let audit = durableAuditLogStore {
            await audit.record(RuntimeAuditEvent(kind: .errorRecovery,
                                                 correlationID: taskID,
                                                 summary: "legacy=\(legacyState.rawValue) durable=\(durable.rawValue)",
                                                 timestamp: clock.now()))
        }
    }

    /// Resolve the durable Goal associated with a task, if any. Used by
    /// R-B-02 to gate `.completed` on acceptance criteria.
    func durableGoal(forTask taskID: UUID) async -> Goal? {
        guard let store = goalStore else { return nil }
        let goals = await store.goals(forTask: taskID)
        return goals.first
    }

    /// Evaluate whether the durable task may transition to `.completed`. This
    /// is the R-B-02 gate. When no Goal is associated with the task, the
    /// runtime behaviour is preserved (model stream completion alone is
    /// sufficient).
    func acceptanceAllowsCompletion(taskID: UUID) async -> (allowed: Bool,
                                                                       evaluation: AcceptanceEvaluation?,
                                                                       goal: Goal?) {
        guard let goal = await durableGoal(forTask: taskID) else {
            // No goal bound to this task → preserve legacy semantics.
            return (true, nil, nil)
        }
        let evaluation = acceptanceEvaluator.mayComplete(goal: goal)
        switch evaluation {
        case .allSatisfied:
            return (true, evaluation, goal)
        case .waitingForUser, .unsatisfied:
            // Forbidden: a model stream ending alone CANNOT complete a
            // Goal-backed task. R-B-02 enforces this.
            return (false, evaluation, goal)
        }
    }

/// P14.2 — R-B-F05 closure. Single source of truth for "may this task
    /// record `.completed` (or `.failed`)". Both `converse`,
    /// `runAgenticLoop`, and `runLocalDiscoveryWorkflow` call this helper
    /// before recording a terminal state, so Goal-backed tasks can never
    /// bypass `AcceptanceEvaluator`.
    @discardableResult
    func mirrorTerminalDurableIfAcceptable(taskID: UUID,
                                            attemptID: UUID,
                                            legacyState: AgentTaskState,
                                            title: String,
                                            conversationID: UUID?) async -> CompletionGateOutcome {
        let acceptance = await acceptanceAllowsCompletion(taskID: taskID)
        if !acceptance.allowed {
            // Goal is bound but acceptance is not satisfied. Persist the
            // durable state to a non-terminal that the supervisor loop can
            // pick up later. We do NOT mark `.completed`.
            switch acceptance.evaluation {
            case .waitingForUser(let missing):
                await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                    legacyState: .awaitingApproval,
                                    title: "waitingForUserApproval",
                                    conversationID: conversationID)
                await appendInbox(InboxEvent(
                    taskID: taskID,
                    kind: .approvalDecisionRequested,
                    payload: .object(["attemptID": .string(attemptID.uuidString)])))
                return .blockedWaitingForUser(missing)
            case .unsatisfied(let missing):
                await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                    legacyState: .running,
                                    title: "criteria-unsatisfied",
                                    conversationID: conversationID)
                return .blockedUnsatisfied(missing)
            case .allSatisfied:
                // Should not happen when `!acceptance.allowed`, but handle
                // defensively.
                await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                    legacyState: legacyState, title: title,
                                    conversationID: conversationID)
                return .allowed
            case .none:
                return .noGoalBound
            }
        }
        if acceptance.goal == nil {
            await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                legacyState: legacyState, title: title,
                                conversationID: conversationID)
            return .noGoalBound
        }
        await mirrorDurable(taskID: taskID, attemptID: attemptID,
                            legacyState: legacyState, title: title,
                            conversationID: conversationID)
        return .allowed
    }

    /// Apply a waiting approval state on the durable task when a plan-mode
    /// approval is required (R-B-07). No-op when stores are absent.
    func mirrorWaitingForApproval(taskID: UUID,
                                              attemptID: UUID,
                                              conversationID: UUID?) async {
        guard durableTaskStore != nil else { return }
        await mirrorDurable(taskID: taskID,
                            attemptID: attemptID,
                            legacyState: .awaitingApproval,
                            title: "waitingForApproval",
                            conversationID: conversationID)
        await appendInbox(InboxEvent(
            taskID: taskID,
            kind: .approvalDecisionRequested,
            payload: .object(["attemptID": .string(attemptID.uuidString)])))
    }

    /// Single funnel for durable-inbox writes. Privacy dye: private tasks never
    /// touch the inbox (no requests, no decisions, no consumes — there is
    /// nothing persisted to resolve after restart).
    func appendInbox(_ event: InboxEvent) async {
        // P-DSK-01 — sink-first. When the seam is wired, the sink carries
        // the privacy gate; the legacy guard below only runs when nil.
        if let sink = durableSink {
            await sink.appendInbox(event)
            return
        }
        guard !privateTaskIDs.contains(event.taskID) else { return }
        guard let inbox = durableInboxStore else { return }
        await inbox.appendIfNew(event)
    }

    /// Single funnel for task-correlated durable-audit writes. Private tasks
    /// never reach the audit log. (The supervisor's task-less hook has no
    /// correlation ID and stays as-is.)
    func recordAudit(kind: RuntimeAuditKind, correlationID: UUID,
                             summary: String, timestamp: Date) async {
        // P-DSK-01 — sink-first. The seam's privacy gate covers
        // correlationID-gated writes; task-less hooks (correlationID == nil)
        // still pass through (the sink carve-out preserves this).
        if let sink = durableSink {
            await sink.recordAudit(RuntimeAuditEvent(kind: kind,
                                                     correlationID: correlationID,
                                                     summary: summary,
                                                     timestamp: timestamp))
            return
        }
        guard !privateTaskIDs.contains(correlationID) else { return }
        guard let audit = durableAuditLogStore else { return }
        await audit.record(RuntimeAuditEvent(kind: kind, correlationID: correlationID,
                                             summary: summary, timestamp: timestamp))
    }

    /// P-DSK-02 — cancel-record aggregator funnel. The three cancel sites
    /// (`cancel(conversationID:)`, `cancel(taskID:)`, the cancel branch of
    /// `terminateActiveAttempt`) emitted the same 9-field `record(kind:
    /// .cancelled, state: .cancelled, ..., cancelReason: "...", terminal:
    /// true)` block. The aggregator captures the shared shape so callers
    /// assemble a struct instead of hand-rolling the record call. The
    /// underlying `record(...)` helper is sink-first (P-DSK-01), so the
    /// privacy gate is preserved whenever the seam is wired.
    func recordCancellation(_ payload: CancellationRecord) async {
        try? await record(kind: payload.kind, state: payload.state,
                          taskID: payload.taskID, attemptID: payload.attemptID,
                          conversationID: payload.conversationID,
                          userMessageID: payload.userMessageID,
                          assistantMessageID: payload.assistantMessageID,
                          cancelReason: payload.cancelReason,
                          terminal: payload.terminal)
    }

    /// Apply the durable state transition that follows an approval decision
    /// (R-B-07). Called from `approveActivePlan`, `cancelActivePlan`, and
    /// `cancel(decision: .cancelled)`.
    func resolveDurableApproval(taskID: UUID?,
                                           attemptID: UUID,
                                           conversationID: UUID?,
                                           legacyState: AgentTaskState,
                                           decisionLabel: String) async {
        guard let taskID else { return }
        guard !privateTaskIDs.contains(taskID) else { return }
        if durableInboxStore != nil {
            await appendInbox(InboxEvent(
                taskID: taskID,
                kind: .approvalDecision,
                payload: .object([
                    "decision": .string(decisionLabel),
                    "attemptID": .string(attemptID.uuidString)
                ])))
            await durableInboxStore?.consumeAll(forTask: taskID, attemptID: attemptID)
        }
        await mirrorDurable(taskID: taskID,
                            attemptID: attemptID,
                            legacyState: legacyState,
                            title: "approval:\(decisionLabel)",
                            conversationID: conversationID)
    }

    public func runProactive(_ inputs: ProactiveInputs, line: String = "要不要歇一会儿？") -> AgentRunResult {
        let decision = ProactivePolicyEngine.decide(inputs)
        let pres: CharacterPresentation? = (decision == .allow) ? render(line, mode: .casual, emotion: .happy) : nil
        return AgentRunResult(presentation: pres, proactive: decision)
    }

    func render(_ text: String, mode: CharacterSpeakingMode, emotion: PetEmotion,
                        viaCloud: Bool = false) -> CharacterPresentation {
        let resp = SemanticResponse(text: text, kind: .chat, route: .character, viaCloud: viaCloud)
        return renderer.render(resp, persona: .canonical, emotion: .neutral, speakingMode: mode,
                               animationIntent: .explain).withEmotion(emotion)
    }

    private static func toolActivitySummary(_ toolName: String) -> String {
        switch toolName {
        case "get_current_datetime":
            return "正在获取本地日期和时间…"
        case "get_system_profile":
            return "正在读取系统信息"
        case "get_frontmost_application":
            return "正在读取当前应用"
        case "list_today_calendar_events", "calendar.events.read":
            return "正在读取日历信息"
        default:
            return "正在执行工具"
        }
    }

    private static func toolObservationActivityTitle(_ observation: AgentToolObservation) -> String {
        switch (observation.toolName, observation.status) {
        case ("get_current_datetime", .success):
            return "已获取本地日期和时间"
        case ("get_current_datetime", _):
            return "未能调用日期时间工具"
        case (_, .success):
            return "工具执行完成"
        default:
            return "工具执行失败"
        }
    }

    private static func toolObservationFailureDetail(_ observation: AgentToolObservation) -> String {
        switch observation.status {
        case .denied:
            return "权限未允许"
        case .timeout:
            return "工具执行超时"
        case .failed:
            return "工具未成功完成"
        case .success:
            return ""
        }
    }

    // P-CSP-01 — moved to ConversePipelineHelpers (pure, unit-tested).
    // No body: callers go through the helper directly.
}

/// P14.2 — R-B-F05 closure. Outcome of `mirrorTerminalDurableIfAcceptable`.
/// Callers can distinguish "allowed" vs "blocked waiting for user"
/// vs "blocked unsatisfied" for observability + audit.
public enum CompletionGateOutcome: Sendable, Equatable {
    case allowed
    case blockedWaitingForUser([AcceptanceCriterion])
    case blockedUnsatisfied([AcceptanceCriterion])
    case noGoalBound
}

private extension CharacterPresentation {
    func withEmotion(_ e: PetEmotion) -> CharacterPresentation {
        CharacterPresentation(bubbles: bubbles, speakingMode: speakingMode, emotion: e,
                              animationIntent: animationIntent, suggestions: suggestions,
                              viaCloud: viaCloud, priority: priority)
    }
}

private enum CurrentDateTimeVerificationResult: Equatable {
    case succeeded
    case failed(String)
}

private enum CurrentDateTimeObservationVerifier {
    static let toolName = "get_current_datetime"

    static func requiresVerification(_ loop: AgentLoopRunResult) -> Bool {
        loop.usedToolNames.contains(toolName) || loop.observations.contains { $0.toolName == toolName }
    }

    static func verify(_ observations: [AgentToolObservation]) -> CurrentDateTimeVerificationResult {
        guard let observation = observations.last(where: { $0.toolName == toolName }) else {
            return .failed("未收到日期时间工具结果")
        }
        guard observation.status == .success else {
            return .failed(failureDetail(for: observation.status))
        }
        guard stringValue(for: "status", in: observation.content)?.lowercased() == "success" else {
            return .failed("日期时间工具未返回成功状态")
        }
        let hasTime = ["local_time", "local", "timestamp", "iso8601"].contains {
            stringValue(for: $0, in: observation.content) != nil
        }
        guard hasTime else {
            return .failed("日期时间工具结果缺少时间字段")
        }
        guard stringValue(for: "timezone", in: observation.content) != nil else {
            return .failed("日期时间工具结果缺少时区")
        }
        return .succeeded
    }

    private static func failureDetail(for status: AgentLoopObservationStatus) -> String {
        switch status {
        case .denied:
            return "日期时间工具权限未允许"
        case .failed:
            return "日期时间工具执行失败"
        case .timeout:
            return "日期时间工具执行超时"
        case .success:
            return "日期时间工具结果无效"
        }
    }

    private static func stringValue(for key: String, in content: AgentJSONValue) -> String? {
        guard case .object(let object) = content,
              case .string(let value)? = object[key] else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

}

extension AgentLoopStopReason {
    var userVisibleSummary: String {
        switch self {
        case .completed:
            return "任务已完成"
        case .cancelled:
            return "任务已取消"
        case .modelTimeout:
            return "模型响应超时"
        case .toolTimeout:
            return "工具执行超时"
        case .toolCallLimit, .iterationLimit, .repeatedToolCall:
            return "任务达到安全限制"
        case .malformedDecision:
            return "模型返回格式无效"
        case .permissionDenied:
            return "权限被拒绝"
        case .providerFailure:
            return "模型服务不可用"
        case .toolFailure:
            return "工具执行失败"
        }
    }

    var activityFailureCategory: AgentTaskFailureCategory {
        switch self {
        case .cancelled:
            return .cancelled
        case .modelTimeout, .providerFailure:
            return .providerUnavailable
        case .permissionDenied:
            return .permissionDenied
        case .malformedDecision:
            return .planningFailed
        case .toolTimeout:
            return .toolTimedOut
        case .toolFailure, .toolCallLimit, .iterationLimit, .repeatedToolCall:
            return .toolFailed
        case .completed:
            return .unknown
        }
    }
}

private extension PlanStepStatus {
    var activityDetail: String {
        switch self {
        case .pending:
            return "等待执行"
        case .running:
            return "正在执行"
        case .succeeded:
            return "已完成"
        case .partial:
            return "部分完成"
        case .denied:
            return "权限被拒绝"
        case .failed:
            return "执行失败"
        case .timedOut:
            return "执行超时"
        case .cancelled:
            return "已取消"
        case .skippedDependency:
            return "因前置步骤失败而跳过"
        case .unknown:
            return "状态未知"
        }
    }
}

private extension PlanError {
    var activityFailureCategory: AgentTaskFailureCategory {
        switch self {
        case .approvalDeclined:
            return .approvalRejected
        case .approvalTimedOut:
            return .approvalTimedOut
        case .plannerUnavailable, .plannerTimeout, .malformedPlan, .planRepairFailed:
            return .planningFailed
        case .planValidationFailed, .tooFewSteps, .tooManySteps, .unknownTool, .toolDisabled,
             .invalidArguments, .invalidDependency, .cyclicDependency, .unsupportedRisk,
             .approvalRequired, .internalInvariantViolation, .planCriticRejected,
             .verificationFailed, .verificationRepairBudgetExceeded:
            return .validationFailed
        case .executionFailed, .replanFailed:
            return .toolFailed
        case .synthesisFailed:
            return .synthesisFailed
        case .turnDeadlineExceeded:
            return .toolTimedOut
        case .cancelled:
            return .cancelled
        }
    }
}

// P18.3 — U-18: First-claim-wins gate (sibling of
// `LocalDiscoveryPlannerDeadlineGate` in
// `Sources/PetAgentRuntime/LocalDiscovery/LocalDiscoveryWorkflow.swift`).
//
// The mutable `claimed` state lives in an `OSAllocatedUnfairLock<Bool>` (an
// `os.lock` primitive that is itself `Sendable`), so the class can declare
// unconditional `Sendable` conformance instead of `@unchecked Sendable`.
// Two concurrent `Task { ... }` callers (the factory task and the timeout
// task) may race; the lock guarantees the "exactly one resume" invariant
// for `localDiscoveryStructuredPlannerSnapshotWithDeadline()`.
//
// DO NOT add a second mutable field without extending the lock coverage.
private final class LocalDiscoveryPlannerFactoryDeadlineGate: Sendable {
    private let claimed = OSAllocatedUnfairLock<Bool>(initialState: false)

    func claim() -> Bool {
        claimed.withLockUnchecked { c in
            guard !c else { return false }
            c = true
            return true
        }
    }
}
