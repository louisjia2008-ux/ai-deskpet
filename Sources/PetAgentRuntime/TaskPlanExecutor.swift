import Foundation
import AICore
import PetBrainCore

public struct PlanExecutionContext: Sendable {
    public typealias CancellationCheck = @Sendable () async -> Bool
    public typealias EventSink = @Sendable (PlanExecutionEvent) async -> Void

    public var taskID: UUID
    public var turnID: UUID
    public var startedAt: Date
    public var locale: Locale
    public var timeZone: TimeZone
    public var clock: RuntimeClock
    public var gate: any CapabilityGate
    public var toolPlatformExecutor: any ToolPlatformExecuting
    public var systemAuthorization: any SystemAuthorizationProviding
    public var observationSanitizer: any ObservationSanitizing
    public var logger: any SafeToolLogger
    public var isCancelled: CancellationCheck
    public var eventSink: EventSink

    public init(taskID: UUID,
                turnID: UUID,
                startedAt: Date,
                locale: Locale = .current,
                timeZone: TimeZone = .current,
                clock: RuntimeClock = WallClock(),
                gate: any CapabilityGate,
                toolPlatformExecutor: any ToolPlatformExecuting,
                systemAuthorization: any SystemAuthorizationProviding,
                observationSanitizer: any ObservationSanitizing = DefaultObservationSanitizer(),
                logger: any SafeToolLogger = NoopSafeToolLogger(),
                isCancelled: @escaping CancellationCheck = { false },
                eventSink: @escaping EventSink = { _ in }) {
        self.taskID = taskID
        self.turnID = turnID
        self.startedAt = startedAt
        self.locale = locale
        self.timeZone = timeZone
        self.clock = clock
        self.gate = gate
        self.toolPlatformExecutor = toolPlatformExecutor
        self.systemAuthorization = systemAuthorization
        self.observationSanitizer = observationSanitizer
        self.logger = logger
        self.isCancelled = isCancelled
        self.eventSink = eventSink
    }
}

public struct PlanStepExecutionRecord: Sendable, Equatable {
    public var stepID: TaskPlanStepID
    public var toolID: ToolID
    public var status: PlanStepStatus
    public var observation: AgentToolObservation?
    public var durationMilliseconds: Int?
    public var isTruncated: Bool

    public init(stepID: TaskPlanStepID,
                toolID: ToolID,
                status: PlanStepStatus,
                observation: AgentToolObservation? = nil,
                durationMilliseconds: Int? = nil,
                isTruncated: Bool = false) {
        self.stepID = stepID
        self.toolID = toolID
        self.status = status
        self.observation = observation
        self.durationMilliseconds = durationMilliseconds
        self.isTruncated = isTruncated
    }
}

public struct PlanExecutionResult: Sendable, Equatable {
    public var records: [PlanStepExecutionRecord]
    public var observations: [AgentToolObservation]
    public var status: PlanStatus
    public var stopReason: AgentLoopStopReason
    public var replanCount: Int

    public init(records: [PlanStepExecutionRecord],
                observations: [AgentToolObservation],
                status: PlanStatus,
                stopReason: AgentLoopStopReason,
                replanCount: Int = 0) {
        self.records = records
        self.observations = observations
        self.status = status
        self.stopReason = stopReason
        self.replanCount = replanCount
    }
}

public protocol TaskPlanExecuting: Sendable {
    func execute(plan: ValidatedTaskPlan,
                 context: PlanExecutionContext,
                 initialCompletedFingerprints: Set<String>) -> AsyncThrowingStream<PlanExecutionEvent, Error>
}

public struct DefaultTaskPlanExecutor: TaskPlanExecuting {
    public init() {}

    public func execute(plan: ValidatedTaskPlan,
                        context: PlanExecutionContext,
                        initialCompletedFingerprints: Set<String> = []) -> AsyncThrowingStream<PlanExecutionEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var state = TaskPlanRuntimeState(validated: plan)
                await emit(.planCreated(state.presentationSnapshot()))
                var completedFingerprints = initialCompletedFingerprints
                do {
                    for step in plan.plan.steps {
                        if await context.isCancelled() || Task.isCancelled {
                            state.cancelRemaining()
                            await emit(.planCancelled(state.presentationSnapshot()))
                            continuation.finish(throwing: PlanError.cancelled)
                            return
                        }
                        if context.clock.now().timeIntervalSince(context.startedAt) >= plan.plannerLimits.plannedTurnDeadline {
                            state.cancelRemaining()
                            await emit(.failed(.turnDeadlineExceeded, state.presentationSnapshot()))
                            continuation.finish(throwing: PlanError.turnDeadlineExceeded)
                            return
                        }
                        if completedFingerprints.contains(step.fingerprint) {
                            state.update(step.id, status: .succeeded)
                            await emit(.stepSkipped(step.id, .succeeded, state.presentationSnapshot()))
                            continue
                        }
                        if state.hasFailedDependency(for: step) {
                            state.update(step.id, status: .skippedDependency)
                            await emit(.stepSkipped(step.id, .skippedDependency, state.presentationSnapshot()))
                            continue
                        }
                        guard let entry = plan.toolCatalogSnapshot.lookup(step.toolID),
                              entry.enabled,
                              entry.manifest.availability == .available else {
                            let record = state.record(step: step,
                                                      status: .failed,
                                                      observation: nil,
                                                      durationMilliseconds: nil)
                            state.records.append(record)
                            await emit(.stepFinished(step.id, .failed, state.presentationSnapshot()))
                            continue
                        }

                        state.update(step.id, status: .running)
                        await emit(.stepStarted(step.id, state.presentationSnapshot()))
                        let started = context.clock.now()
                        let request = AgentToolCallRequest(callID: "\(plan.plan.id.rawValue)-\(step.id.rawValue)",
                                                           toolName: entry.manifest.id.rawValue,
                                                           arguments: step.arguments,
                                                           userVisibleSummary: entry.manifest.userVisibleExecutionSummary)
                        let (token, deniedObservation) = await permissionToken(for: entry.manifest,
                                                                               request: request,
                                                                               context: context)
                        if let deniedObservation {
                            let record = state.record(step: step,
                                                      status: .denied,
                                                      observation: deniedObservation,
                                                      durationMilliseconds: duration(from: started, clock: context.clock))
                            state.records.append(record)
                            state.observations.append(deniedObservation)
                            state.update(step.id, status: .denied)
                            await emit(.stepFinished(step.id, .denied, state.presentationSnapshot()))
                            continue
                        }

                        let toolContext = ToolExecutionContext(taskID: context.taskID,
                                                               runID: context.turnID,
                                                               turnID: context.turnID,
                                                               callID: request.callID,
                                                               toolID: entry.manifest.id,
                                                               locale: context.locale,
                                                               timeZone: context.timeZone,
                                                               clock: context.clock,
                                                               capabilityToken: token,
                                                               permissionAlreadyEvaluated: true,
                                                               deadline: context.startedAt.addingTimeInterval(plan.plannerLimits.plannedTurnDeadline),
                                                               logger: context.logger)
                        let execution = await context.toolPlatformExecutor.executeTool(request: request,
                                                                                       context: toolContext)
                        let elapsed = duration(from: started, clock: context.clock)
                        if await context.isCancelled() || Task.isCancelled {
                            state.cancelRemaining()
                            await emit(.planCancelled(state.presentationSnapshot()))
                            continuation.finish(throwing: PlanError.cancelled)
                            return
                        }
                        switch execution {
                        case .success(let result):
                            let observation = planObservation(for: request,
                                                              result: result,
                                                              manifest: entry.manifest,
                                                              context: context,
                                                              maxCharacters: plan.plannerLimits.maxVisibleSummaryCharacters)
                            let status = planStatus(for: result.status)
                            let record = state.record(step: step,
                                                      status: status,
                                                      observation: observation,
                                                      durationMilliseconds: elapsed,
                                                      isTruncated: result.metadata.truncated)
                            state.records.append(record)
                            state.observations.append(observation)
                            state.update(step.id, status: status)
                            if status.isSuccessful { completedFingerprints.insert(step.fingerprint) }
                            await emit(.stepFinished(step.id, status, state.presentationSnapshot()))
                        case .failure(let error):
                            let observation = platformErrorObservation(for: request,
                                                                       error: error,
                                                                       maxCharacters: plan.plannerLimits.maxVisibleSummaryCharacters)
                            let status = planStatus(for: error)
                            let record = state.record(step: step,
                                                      status: status,
                                                      observation: observation,
                                                      durationMilliseconds: elapsed)
                            state.records.append(record)
                            state.observations.append(observation)
                            state.update(step.id, status: status)
                            await emit(.stepFinished(step.id, status, state.presentationSnapshot()))
                        }
                    }
                    state.status = state.terminalStatus()
                    let snapshot = state.presentationSnapshot()
                    await emit(.completed(snapshot))
                    continuation.finish()
                } catch {
                    await emit(.failed(.executionFailed, state.presentationSnapshot()))
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }

            func emit(_ event: PlanExecutionEvent) async {
                await context.eventSink(event)
                continuation.yield(event)
            }
        }
    }

    public func run(plan: ValidatedTaskPlan,
                    context: PlanExecutionContext,
                    initialCompletedFingerprints: Set<String> = []) async throws -> PlanExecutionResult {
        var records: [PlanStepExecutionRecord] = []
        var finalStatus: PlanStatus = .failed
        for try await event in execute(plan: plan,
                                       context: context,
                                       initialCompletedFingerprints: initialCompletedFingerprints) {
            switch event {
            case .stepFinished(let stepID, let status, _):
                if let step = plan.plan.steps.first(where: { $0.id == stepID }) {
                    records.append(PlanStepExecutionRecord(stepID: stepID, toolID: step.toolID, status: status))
                }
            case .completed(let snapshot):
                finalStatus = snapshot.status
            default:
                break
            }
        }
        // Recreate the authoritative result from events emitted through the state snapshot would be lossy.
        // Controller integration uses `runSynchronous` below for full observation records.
        return PlanExecutionResult(records: records,
                                   observations: [],
                                   status: finalStatus,
                                   stopReason: finalStatus == .completed ? .completed : .toolFailure)
    }

    public func runSynchronous(plan: ValidatedTaskPlan,
                               context: PlanExecutionContext,
                               initialCompletedFingerprints: Set<String> = []) async throws -> PlanExecutionResult {
        var state = TaskPlanRuntimeState(validated: plan)
        await context.eventSink(.planCreated(state.presentationSnapshot()))
        var completedFingerprints = initialCompletedFingerprints

        for step in plan.plan.steps {
            if await context.isCancelled() || Task.isCancelled {
                state.cancelRemaining()
                await context.eventSink(.planCancelled(state.presentationSnapshot()))
                throw PlanError.cancelled
            }
            if context.clock.now().timeIntervalSince(context.startedAt) >= plan.plannerLimits.plannedTurnDeadline {
                state.cancelRemaining()
                await context.eventSink(.failed(.turnDeadlineExceeded, state.presentationSnapshot()))
                throw PlanError.turnDeadlineExceeded
            }
            if completedFingerprints.contains(step.fingerprint) {
                state.update(step.id, status: .succeeded)
                await context.eventSink(.stepSkipped(step.id, .succeeded, state.presentationSnapshot()))
                continue
            }
            if state.hasFailedDependency(for: step) {
                let record = state.record(step: step, status: .skippedDependency)
                state.records.append(record)
                state.update(step.id, status: .skippedDependency)
                await context.eventSink(.stepSkipped(step.id, .skippedDependency, state.presentationSnapshot()))
                continue
            }
            guard let entry = plan.toolCatalogSnapshot.lookup(step.toolID),
                  entry.enabled,
                  entry.manifest.availability == .available else {
                let record = state.record(step: step, status: .failed)
                state.records.append(record)
                state.update(step.id, status: .failed)
                await context.eventSink(.stepFinished(step.id, .failed, state.presentationSnapshot()))
                continue
            }

            state.update(step.id, status: .running)
            await context.eventSink(.stepStarted(step.id, state.presentationSnapshot()))
            let request = AgentToolCallRequest(callID: "\(plan.plan.id.rawValue)-\(step.id.rawValue)",
                                               toolName: entry.manifest.id.rawValue,
                                               arguments: step.arguments,
                                               userVisibleSummary: entry.manifest.userVisibleExecutionSummary)
            let started = context.clock.now()
            let (token, deniedObservation) = await permissionToken(for: entry.manifest,
                                                                   request: request,
                                                                   context: context)
            if let deniedObservation {
                let record = state.record(step: step,
                                          status: .denied,
                                          observation: deniedObservation,
                                          durationMilliseconds: duration(from: started, clock: context.clock))
                state.records.append(record)
                state.observations.append(deniedObservation)
                state.update(step.id, status: .denied)
                await context.eventSink(.stepFinished(step.id, .denied, state.presentationSnapshot()))
                continue
            }

            let toolContext = ToolExecutionContext(taskID: context.taskID,
                                                   runID: context.turnID,
                                                   turnID: context.turnID,
                                                   callID: request.callID,
                                                   toolID: entry.manifest.id,
                                                   locale: context.locale,
                                                   timeZone: context.timeZone,
                                                   clock: context.clock,
                                                   capabilityToken: token,
                                                   permissionAlreadyEvaluated: true,
                                                   deadline: context.startedAt.addingTimeInterval(plan.plannerLimits.plannedTurnDeadline),
                                                   logger: context.logger)
            let execution = await context.toolPlatformExecutor.executeTool(request: request,
                                                                           context: toolContext)
            let elapsed = duration(from: started, clock: context.clock)
            if await context.isCancelled() || Task.isCancelled {
                state.cancelRemaining()
                await context.eventSink(.planCancelled(state.presentationSnapshot()))
                throw PlanError.cancelled
            }
            switch execution {
            case .success(let result):
                let observation = planObservation(for: request,
                                                  result: result,
                                                  manifest: entry.manifest,
                                                  context: context,
                                                  maxCharacters: plan.plannerLimits.maxVisibleSummaryCharacters)
                let status = planStatus(for: result.status)
                let record = state.record(step: step,
                                          status: status,
                                          observation: observation,
                                          durationMilliseconds: elapsed,
                                          isTruncated: result.metadata.truncated)
                state.records.append(record)
                state.observations.append(observation)
                state.update(step.id, status: status)
                if status.isSuccessful { completedFingerprints.insert(step.fingerprint) }
                await context.eventSink(.stepFinished(step.id, status, state.presentationSnapshot()))
            case .failure(let error):
                let observation = platformErrorObservation(for: request,
                                                           error: error,
                                                           maxCharacters: plan.plannerLimits.maxVisibleSummaryCharacters)
                let status = planStatus(for: error)
                let record = state.record(step: step,
                                          status: status,
                                          observation: observation,
                                          durationMilliseconds: elapsed)
                state.records.append(record)
                state.observations.append(observation)
                state.update(step.id, status: status)
                await context.eventSink(.stepFinished(step.id, status, state.presentationSnapshot()))
            }
        }

        state.status = state.terminalStatus()
        await context.eventSink(.completed(state.presentationSnapshot()))
        return PlanExecutionResult(records: state.records,
                                   observations: state.observations,
                                   status: state.status,
                                   stopReason: state.stopReason())
    }

    private func permissionToken(for manifest: ToolManifest,
                                 request: AgentToolCallRequest,
                                 context: PlanExecutionContext) async -> (CapabilityToken?, AgentToolObservation?) {
        var token: CapabilityToken?
        if let capabilityID = manifest.permissionRequirement.capabilityID {
            let outcome = await context.gate.evaluate(capabilityID: capabilityID,
                                                      reason: manifest.userVisibleExecutionSummary,
                                                      taskID: context.taskID)
            switch outcome {
            case .granted(let granted):
                token = granted
            case .askUser:
                return (nil, deniedObservation(for: request, summary: "需要权限确认", code: "permission_required"))
            case .denied:
                return (nil, deniedObservation(for: request, summary: "权限被拒绝", code: "permission_denied"))
            }
        }

        if let systemPermission = manifest.permissionRequirement.systemPermission,
           let capabilityID = manifest.permissionRequirement.capabilityID,
           context.systemAuthorization.requiresSystemAuthorization(capabilityID) {
            let status = await context.systemAuthorization.status(for: capabilityID)
            guard status == .granted else {
                return (nil, AgentToolObservation(callID: request.callID,
                                                  toolName: request.toolName,
                                                  status: .denied,
                                                  content: .object([
                                                    "status": .string(status.rawValue),
                                                    "systemPermission": .string(systemPermission.rawValue),
                                                  ]),
                                                  userSafeSummary: "需要系统授权"))
            }
        }
        return (token, nil)
    }

    private func planObservation(for request: AgentToolCallRequest,
                                 result: ToolExecutionResult,
                                 manifest: ToolManifest,
                                 context: PlanExecutionContext,
                                 maxCharacters: Int) -> AgentToolObservation {
        let base = context.observationSanitizer.observation(for: request,
                                                            result: result,
                                                            maxCharacters: maxCharacters)
        guard TaskPlanValidator.normalizedRisk(manifest.riskLevel) == .privateDataReadOnly else {
            return base
        }
        var safeContent: [String: AgentJSONValue] = [
            "status": .string(result.status.rawValue),
            "privateDataRead": .bool(true),
            "truncated": .bool(result.metadata.truncated),
        ]
        if let itemCount = result.metadata.itemCount {
            safeContent["itemCount"] = .number(Double(itemCount))
        }
        return AgentToolObservation(callID: base.callID,
                                    toolName: base.toolName,
                                    status: base.status,
                                    content: .object(safeContent),
                                    userSafeSummary: base.userSafeSummary,
                                    isTruncated: base.isTruncated)
    }

    private func platformErrorObservation(for request: AgentToolCallRequest,
                                          error: ToolPlatformError,
                                          maxCharacters: Int) -> AgentToolObservation {
        let status: AgentLoopObservationStatus
        let summary: String
        let code: String
        switch error {
        case .permissionDenied, .systemPermissionMissing, .toolDisabled:
            status = .denied; summary = "权限被拒绝"; code = "permission_denied"
        case .timedOut:
            status = .timeout; summary = "工具执行超时"; code = "timed_out"
        case .cancelled:
            status = .failed; summary = "工具已取消"; code = "cancelled"
        case .invalidArguments, .schemaValidationFailed:
            status = .failed; summary = "工具参数无效"; code = "invalid_arguments"
        case .unknownTool, .toolUnavailable:
            status = .failed; summary = "工具不可用"; code = "tool_unavailable"
        default:
            status = .failed; summary = "工具执行失败"; code = "execution_failed"
        }
        let safe = AgentPrivacyRedactor.safeText(summary, maxLength: maxCharacters)
        return AgentToolObservation(callID: request.callID,
                                    toolName: request.toolName,
                                    status: status,
                                    content: .object([
                                        "status": .string(status.rawValue),
                                        "error": .string(code),
                                    ]),
                                    userSafeSummary: safe.text,
                                    isTruncated: safe.truncated)
    }

    private func deniedObservation(for request: AgentToolCallRequest,
                                   summary: String,
                                   code: String) -> AgentToolObservation {
        AgentToolObservation(callID: request.callID,
                             toolName: request.toolName,
                             status: .denied,
                             content: .object([
                                "status": .string("denied"),
                                "error": .string(code),
                             ]),
                             userSafeSummary: summary)
    }

    private func planStatus(for status: ToolExecutionStatus) -> PlanStepStatus {
        switch status {
        case .success:
            return .succeeded
        case .partial:
            return .partial
        case .denied:
            return .denied
        case .failed:
            return .failed
        case .timedOut:
            return .timedOut
        case .cancelled:
            return .cancelled
        }
    }

    private func planStatus(for error: ToolPlatformError) -> PlanStepStatus {
        switch error {
        case .permissionDenied, .systemPermissionMissing, .toolDisabled:
            return .denied
        case .timedOut:
            return .timedOut
        case .cancelled:
            return .cancelled
        default:
            return .failed
        }
    }

    private func duration(from start: Date, clock: RuntimeClock) -> Int {
        max(0, Int(clock.now().timeIntervalSince(start) * 1_000))
    }
}

public struct TaskPlanRuntimeState: Sendable, Equatable {
    public var validated: ValidatedTaskPlan
    public var status: PlanStatus
    public var stepStatuses: [TaskPlanStepID: PlanStepStatus]
    public var records: [PlanStepExecutionRecord]
    public var observations: [AgentToolObservation]

    public init(validated: ValidatedTaskPlan,
                status: PlanStatus = .executing,
                records: [PlanStepExecutionRecord] = [],
                observations: [AgentToolObservation] = []) {
        self.validated = validated
        self.status = status
        self.stepStatuses = Dictionary(uniqueKeysWithValues: validated.plan.steps.map { ($0.id, PlanStepStatus.pending) })
        self.records = records
        self.observations = observations
    }

    public mutating func update(_ stepID: TaskPlanStepID, status: PlanStepStatus) {
        stepStatuses[stepID] = status
    }

    public mutating func cancelRemaining() {
        status = .cancelled
        for step in validated.plan.steps where stepStatuses[step.id]?.isTerminal != true {
            stepStatuses[step.id] = .cancelled
        }
    }

    public func hasFailedDependency(for step: TaskPlanStep) -> Bool {
        step.dependsOn.contains { dependency in
            guard let status = stepStatuses[dependency] else { return true }
            return !status.isSuccessful
        }
    }

    public func record(step: TaskPlanStep,
                       status: PlanStepStatus,
                       observation: AgentToolObservation? = nil,
                       durationMilliseconds: Int? = nil,
                       isTruncated: Bool = false) -> PlanStepExecutionRecord {
        PlanStepExecutionRecord(stepID: step.id,
                                toolID: step.toolID,
                                status: status,
                                observation: observation,
                                durationMilliseconds: durationMilliseconds,
                                isTruncated: isTruncated)
    }

    public func terminalStatus() -> PlanStatus {
        let statuses = validated.plan.steps.map { stepStatuses[$0.id] ?? .failed }
        if statuses.allSatisfy({ $0 == .succeeded || $0 == .partial }) {
            return .completed
        }
        if statuses.contains(where: { $0 == .succeeded || $0 == .partial }) {
            return .partiallyCompleted
        }
        if statuses.allSatisfy({ $0 == .cancelled }) {
            return .cancelled
        }
        return .failed
    }

    public func stopReason() -> AgentLoopStopReason {
        switch terminalStatus() {
        case .completed, .partiallyCompleted:
            return .completed
        case .cancelled:
            return .cancelled
        case .failed:
            if stepStatuses.values.contains(.timedOut) { return .toolTimeout }
            if stepStatuses.values.contains(.denied) { return .permissionDenied }
            return .toolFailure
        default:
            return .toolFailure
        }
    }

    public func presentationSnapshot() -> PlanPresentationSnapshot {
        PlanPresentationSnapshot(id: validated.plan.id,
                                 goalSummary: validated.plan.goalSummary,
                                 status: status,
                                 approvalRequirement: validated.plan.approvalRequirement,
                                 steps: validated.plan.steps.map { step in
            let entry = validated.toolCatalogSnapshot.lookup(step.toolID)
            let risk = entry.map { TaskPlanValidator.normalizedRisk($0.manifest.riskLevel) } ?? .unknown
            return PlanPresentationStep(id: step.id,
                                        ordinal: step.ordinal,
                                        title: step.title,
                                        toolDisplayName: entry?.manifest.displayName ?? "工具",
                                        riskLevel: risk,
                                        status: stepStatuses[step.id] ?? .pending,
                                        involvesPrivateData: risk == .privateDataReadOnly)
        },
                                 containsPrivateDataRead: validated.plan.riskSummary.containsPrivateDataRead,
                                 canApprove: status == .awaitingApproval,
                                 canCancel: [.awaitingApproval, .approved, .executing, .replanning, .verifying, .synthesizing].contains(status))
    }
}
