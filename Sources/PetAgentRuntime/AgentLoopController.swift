import Foundation
import AICore
import PetBrainCore

public struct AgentLoopRunResult: Sendable, Equatable {
    public var finalResponse: AgentFinalResponse?
    public var stopReason: AgentLoopStopReason
    public var observations: [AgentToolObservation]
    public var usedToolNames: [String]
    public var toolStatuses: [AgentLoopObservationStatus]
    public var iterationCount: Int
    public var toolCallCount: Int
    public var waitingApproval: [String]
    public var terminalState: AgentTaskState
    public var planID: String?
    public var planVersion: Int?
    public var planStepCount: Int?
    public var planRiskLevel: String?
    public var planApprovalRequired: Bool?
    public var planApprovalGranted: Bool?
    public var planReplanCount: Int?
    public var planResultItemCount: Int?
    public var planResultTruncated: Bool?
    public var memoryCandidates: [MemoryCandidate]
    public var resultDocument: AgentResultDocument?
    public var resultIssues: [AgentResultValidationIssue]

    public init(finalResponse: AgentFinalResponse? = nil,
                stopReason: AgentLoopStopReason,
                observations: [AgentToolObservation] = [],
                usedToolNames: [String] = [],
                toolStatuses: [AgentLoopObservationStatus] = [],
                iterationCount: Int = 0,
                toolCallCount: Int = 0,
                waitingApproval: [String] = [],
                terminalState: AgentTaskState = .succeeded,
                planID: String? = nil,
                planVersion: Int? = nil,
                planStepCount: Int? = nil,
                planRiskLevel: String? = nil,
                planApprovalRequired: Bool? = nil,
                planApprovalGranted: Bool? = nil,
                planReplanCount: Int? = nil,
                planResultItemCount: Int? = nil,
                planResultTruncated: Bool? = nil,
                memoryCandidates: [MemoryCandidate] = [],
                resultDocument: AgentResultDocument? = nil,
                resultIssues: [AgentResultValidationIssue] = []) {
        self.finalResponse = finalResponse
        self.stopReason = stopReason
        self.observations = observations
        self.usedToolNames = usedToolNames
        self.toolStatuses = toolStatuses
        self.iterationCount = iterationCount
        self.toolCallCount = toolCallCount
        self.waitingApproval = waitingApproval
        self.terminalState = terminalState
        self.planID = planID
        self.planVersion = planVersion
        self.planStepCount = planStepCount
        self.planRiskLevel = planRiskLevel
        self.planApprovalRequired = planApprovalRequired
        self.planApprovalGranted = planApprovalGranted
        self.planReplanCount = planReplanCount
        self.planResultItemCount = planResultItemCount
        self.planResultTruncated = planResultTruncated
        self.memoryCandidates = memoryCandidates
        self.resultDocument = resultDocument
        self.resultIssues = resultIssues
    }
}

public struct AgentLoopController: Sendable {
    public typealias StateSink = @Sendable (AgentLoopState) async -> Void
    public typealias PlanEventSink = @Sendable (PlanExecutionEvent) async -> Void
    public typealias CancellationCheck = @Sendable () async -> Bool

    private let provider: any AgentLoopDecisionProviding
    private let gate: any CapabilityGate
    private let executor: any ToolExecuting
    private let toolCatalogProvider: (any ToolCatalogProviding)?
    private let toolPlatformExecutor: (any ToolPlatformExecuting)?
    private let systemAuthorization: any SystemAuthorizationProviding
    private let observationSanitizer: any ObservationSanitizing
    private let planApprovalHandler: any TaskPlanApprovalHandling
    private let taskGovernor: any TaskGoverning
    private let planCritic: any TaskPlanCritiquing
    private let planVerifier: any TaskPlanVerifying
    private let policy: AgentPolicy
    private let limits: AgentLoopLimits
    private let plannerLimits: PlannerLimits
    private let clock: RuntimeClock
    private let localeProvider: @Sendable () -> Locale
    private let timeZoneProvider: @Sendable () -> TimeZone
    private let stateSink: StateSink
    private let planEventSink: PlanEventSink

    public init(provider: any AgentLoopDecisionProviding,
                gate: any CapabilityGate,
                executor: any ToolExecuting,
                toolCatalogProvider: (any ToolCatalogProviding)? = nil,
                toolPlatformExecutor: (any ToolPlatformExecuting)? = nil,
                systemAuthorization: any SystemAuthorizationProviding = DefaultSystemAuthorizationPolicy(),
                observationSanitizer: any ObservationSanitizing = DefaultObservationSanitizer(),
                planApprovalHandler: any TaskPlanApprovalHandling = AutoTaskPlanApprovalHandler(),
                taskGovernor: any TaskGoverning = DefaultTaskGovernor(),
                planCritic: any TaskPlanCritiquing = DeterministicPlanCritic(),
                planVerifier: any TaskPlanVerifying = DeterministicPlanVerifier(),
                policy: AgentPolicy,
                limits: AgentLoopLimits? = nil,
                plannerLimits: PlannerLimits = PlannerLimits(),
                clock: RuntimeClock = WallClock(),
                localeProvider: @escaping @Sendable () -> Locale = { .current },
                timeZoneProvider: @escaping @Sendable () -> TimeZone = { .current },
                stateSink: @escaping StateSink = { _ in },
                planEventSink: @escaping PlanEventSink = { _ in }) {
        self.provider = provider
        self.gate = gate
        self.executor = executor
        self.toolCatalogProvider = toolCatalogProvider
        self.toolPlatformExecutor = toolPlatformExecutor
        self.systemAuthorization = systemAuthorization
        self.observationSanitizer = observationSanitizer
        self.planApprovalHandler = planApprovalHandler
        self.taskGovernor = taskGovernor
        self.planCritic = planCritic
        self.planVerifier = planVerifier
        self.policy = policy
        self.limits = limits ?? AgentLoopLimits.forPolicy(policy)
        self.plannerLimits = plannerLimits
        self.clock = clock
        self.localeProvider = localeProvider
        self.timeZoneProvider = timeZoneProvider
        self.stateSink = stateSink
        self.planEventSink = planEventSink
    }

    public func run(agentContext: AgentContext,
                    taskID: UUID,
                    runID: UUID? = nil,
                    initialDecision: AgentLoopDecisionResult? = nil,
                    isCancelled: @escaping CancellationCheck = { false }) async -> AgentLoopRunResult {
        await stateSink(.preparing)
        let turnID = runID ?? UUID()
        let turnToolCatalog = await toolCatalogProvider?.toolCatalogSnapshot(for: policy) ?? .empty
        let availableCapabilities = turnToolCatalog.entries.isEmpty
            ? CapabilityCatalogSnapshot.forPolicy(policy)
            : turnToolCatalog.capabilitySnapshot()
        let requiredToolName = Self.requiredToolName(for: agentContext)
        let startedAt = clock.now()
        var observations: [AgentToolObservation] = []
        var usedTools: [String] = []
        var statuses: [AgentLoopObservationStatus] = []
        var observedToolRequests: [AgentToolCallRequest] = []
        var callIDs = Set<String>()
        var toolCallCount = 0
        var lastFingerprint: String?
        var repeatedIdenticalCount = 0

        for iteration in 0..<limits.maxIterations {
            if await isCancelled() || Task.isCancelled {
                await stateSink(.cancelled)
                return result(stop: .cancelled, observations: observations, tools: usedTools,
                              statuses: statuses, iteration: iteration, toolCalls: toolCallCount,
                              terminalState: .cancelled)
            }
            if clock.now().timeIntervalSince(startedAt) >= limits.turnDeadline {
                return await finishAfterLimit(.iterationLimit, agentContext: agentContext,
                                              observations: observations, tools: usedTools,
                                              statuses: statuses, iteration: iteration,
                                              toolCalls: toolCallCount,
                                              toolRequests: observedToolRequests,
                                              availableCapabilities: availableCapabilities,
                                              taskID: taskID,
                                              isCancelled: isCancelled)
            }

            let decisionResult: AgentLoopDecisionResult
            if iteration == 0, let initialDecision {
                decisionResult = initialDecision
            } else {
                await stateSink(.requestingModel(iteration: iteration))
                do {
                    decisionResult = try await nextDecision(agentContext: agentContext,
                                                            observations: observations,
                                                            toolRequests: observedToolRequests,
                                                            availableCapabilities: availableCapabilities,
                                                            iteration: iteration,
                                                            repairAttempt: 0,
                                                            timeout: limits.modelRequestTimeout)
                } catch is RuntimeTimeoutError {
                    await stateSink(.failed(.modelTimeout))
                    return result(stop: .modelTimeout, observations: observations, tools: usedTools,
                                  statuses: statuses, iteration: iteration + 1,
                                  toolCalls: toolCallCount, terminalState: .failed)
                } catch is CancellationError {
                    await stateSink(.cancelled)
                    return result(stop: .cancelled, observations: observations, tools: usedTools,
                                  statuses: statuses, iteration: iteration + 1,
                                  toolCalls: toolCallCount, terminalState: .cancelled)
                } catch AgentLoopRuntimeError.providerResponseMalformed {
                    do {
                        decisionResult = try await repairDecision(agentContext: agentContext,
                                                                  observations: observations,
                                                                  toolRequests: observedToolRequests,
                                                                  availableCapabilities: availableCapabilities,
                                                                  iteration: iteration)
                    } catch {
                        await stateSink(.failed(.malformedDecision))
                        return result(final: fallbackFinal(for: .malformedDecision, observations: observations),
                                      stop: .malformedDecision, observations: observations,
                                      tools: usedTools, statuses: statuses,
                                      iteration: iteration + 1, toolCalls: toolCallCount,
                                      terminalState: .failed)
                    }
                } catch {
                    await stateSink(.failed(.providerFailure))
                    return result(final: fallbackFinal(for: .providerFailure, observations: observations),
                                  stop: .providerFailure, observations: observations,
                                  tools: usedTools, statuses: statuses,
                                  iteration: iteration + 1, toolCalls: toolCallCount,
                                  terminalState: .failed)
                }
            }

            switch decisionResult.decision {
            case .finalResponse(let response):
                if let failure = unmetRequiredToolFinal(requiredToolName: requiredToolName,
                                                        observations: observations) {
                    await stateSink(.failed(.toolFailure))
                    return result(final: failure,
                                  stop: .toolFailure,
                                  observations: observations,
                                  tools: usedTools,
                                  statuses: statuses,
                                  iteration: iteration + 1,
                                  toolCalls: toolCallCount,
                                  terminalState: .failed)
                }
                if let failureReason = terminalToolFailureBeforeFinal(statuses: statuses) {
                    await stateSink(.failed(failureReason))
                    return result(final: fallbackFinal(for: failureReason, observations: observations),
                                  stop: failureReason,
                                  observations: observations,
                                  tools: usedTools,
                                  statuses: statuses,
                                  iteration: iteration + 1,
                                  toolCalls: toolCallCount,
                                  terminalState: .failed)
                }
                await stateSink(.finishing)
                await stateSink(.completed(.completed))
                return result(final: ensureFinalText(response, observations: observations),
                              stop: .completed, observations: observations,
                              tools: usedTools, statuses: statuses,
                              iteration: iteration + 1, toolCalls: toolCallCount,
                              memoryCandidates: decisionResult.memoryCandidates,
                              resultDocument: decisionResult.resultDocument,
                              resultIssues: decisionResult.resultIssues)

            case .proposePlan(let rawPlan):
                if let request = TaskPlanValidator.singleToolFallback(from: rawPlan) {
                    let normalized = AgentLoopDecisionResult(decision: .toolCall(request),
                                                             decisionSource: decisionResult.decisionSource,
                                                             providerMetadata: decisionResult.providerMetadata,
                                                             modelProvider: decisionResult.modelProvider,
                                                             latency: decisionResult.latency)
                    return await run(agentContext: agentContext,
                                     taskID: taskID,
                                     initialDecision: normalized,
                                     isCancelled: isCancelled)
                }
                guard policy.allowTools, let platformExecutor = toolPlatformExecutor else {
                    await stateSink(.failed(.toolFailure))
                    return result(final: AgentFinalResponse(text: "当前环境不支持多步骤计划执行。", finishReason: "plan_unavailable"),
                                  stop: .toolFailure,
                                  observations: observations,
                                  tools: usedTools,
                                  statuses: statuses,
                                  iteration: iteration + 1,
                                  toolCalls: toolCallCount,
                                  terminalState: .failed)
                }
                do {
                    let planID = TaskPlanID(rawValue: "plan-\(taskID.uuidString)")
                    let validated = try TaskPlanValidator.validate(rawPlan,
                                                                    snapshot: turnToolCatalog,
                                                                    createdAt: clock.now(),
                                                                    limits: plannerLimits,
                                                                    id: planID)
                    let goal = PlanningGoal(text: agentContext.userText ?? rawPlan.goalSummary)
                    let assessment = taskGovernor.assess(goal: goal,
                                                         plan: validated,
                                                         budget: TaskGovernorBudget(plannerLimits: plannerLimits))
                    let critique = await planCritic.review(PlanCriticInput(
                        goal: goal,
                        plan: validated,
                        constraints: PlanHardConstraint.infer(from: goal),
                        assessment: assessment))
                    guard critique.allowsExecution else {
                        let snapshot = planSnapshot(for: validated, records: [], status: .failed)
                        await planEventSink(.failed(.planCriticRejected, snapshot))
                        return result(final: AgentFinalResponse(text: PlanError.planCriticRejected.userVisibleMessage,
                                                                finishReason: "plan_critic_rejected"),
                                      stop: .toolFailure,
                                      observations: observations,
                                      tools: usedTools,
                                      statuses: statuses,
                                      iteration: iteration + 1,
                                      toolCalls: toolCallCount,
                                      terminalState: .failed,
                                      planID: validated.plan.id.rawValue,
                                      planVersion: validated.plan.version,
                                      planStepCount: validated.plan.steps.count,
                                      planRiskLevel: assessment.riskLevel.displayName,
                                      planApprovalRequired: validated.plan.approvalRequirement == .userApproval,
                                      planApprovalGranted: false,
                                      planReplanCount: 0,
                                      planResultItemCount: 0,
                                      planResultTruncated: false,
                                      resultIssues: critique.resultIssues)
                    }
                    let planResult = try await runTaskPlan(validated,
                                                           agentContext: agentContext,
                                                           taskID: taskID,
                                                           turnID: turnID,
                                                           startedAt: startedAt,
                                                           availableCapabilities: availableCapabilities,
                                                           platformExecutor: platformExecutor,
                                                           iteration: iteration,
                                                           isCancelled: isCancelled)
                    let planObservations = planResult.observations
                    observations.append(contentsOf: planObservations)
                    usedTools.append(contentsOf: planResult.records.compactMap { record in
                        record.status == .skippedDependency ? nil : record.toolID.rawValue
                    })
                    statuses.append(contentsOf: planResult.records.compactMap { record in
                        record.status == .skippedDependency ? nil : loopStatus(for: record.status)
                    })
                    toolCallCount += planResult.records.filter {
                        ![PlanStepStatus.skippedDependency, .cancelled].contains($0.status)
                    }.count

                    await stateSink(.finishing)
                    await planEventSink(.synthesisStarted(planSnapshot(for: validated,
                                                                       records: planResult.records,
                                                                       status: .synthesizing)))
                    let final = try await synthesizePlanFinal(agentContext: agentContext,
                                                              observations: observations,
                                                              toolRequests: planToolRequests(validated.plan),
                                                              iteration: iteration + 1)
                    let evidence = planResult.observations.map {
                        AgentEvidenceRecord.from(observation: $0,
                                                 taskID: taskID,
                                                 capturedAt: clock.now())
                    }
                    await planEventSink(.verificationStarted(planSnapshot(for: validated,
                                                                          records: planResult.records,
                                                                          status: .verifying)))
                    var verifiedFinal = ensureFinalText(final, observations: observations)
                    var verification = await planVerifier.verify(PlanVerificationInput(
                        goal: goal,
                        plan: validated,
                        execution: planResult,
                        finalResponse: verifiedFinal,
                        evidence: evidence,
                        assessment: assessment))
                    var verificationRepairs = 0
                    if verification.verdict == .repairRequired,
                       assessment.budget.maxVerificationRepairs > 0 {
                        verifiedFinal = planVerifier.repairFinalResponse(for: verification,
                                                                         observations: observations)
                        verificationRepairs = 1
                        verification = await planVerifier.verify(PlanVerificationInput(
                            goal: goal,
                            plan: validated,
                            execution: planResult,
                            finalResponse: verifiedFinal,
                            evidence: evidence,
                            assessment: assessment,
                            repairAttempt: verificationRepairs))
                    }
                    let verifiedSnapshotStatus: PlanStatus = verification.allowsTerminalSuccess
                        ? (verification.verdict == .pass ? .completed : .partiallyCompleted)
                        : .failed
                    await planEventSink(.verificationCompleted(
                        verification,
                        planSnapshot(for: validated,
                                     records: planResult.records,
                                     status: verifiedSnapshotStatus)))
                    guard verification.allowsTerminalSuccess else {
                        await stateSink(.failed(.toolFailure))
                        let error: PlanError = verificationRepairs >= assessment.budget.maxVerificationRepairs
                            ? .verificationRepairBudgetExceeded
                            : .verificationFailed
                        return result(final: AgentFinalResponse(text: error.userVisibleMessage,
                                                                finishReason: "plan_verification_failed"),
                                      stop: .toolFailure,
                                      observations: observations,
                                      tools: usedTools,
                                      statuses: statuses,
                                      iteration: iteration + 1,
                                      toolCalls: toolCallCount,
                                      terminalState: .failed,
                                      planID: validated.plan.id.rawValue,
                                      planVersion: validated.plan.version,
                                      planStepCount: validated.plan.steps.count,
                                      planRiskLevel: assessment.riskLevel.displayName,
                                      planApprovalRequired: validated.plan.approvalRequirement == .userApproval,
                                      planApprovalGranted: validated.plan.approvalRequirement != .userApproval || !planResult.records.isEmpty,
                                      planReplanCount: planResult.replanCount,
                                      planResultItemCount: evidence.count,
                                      planResultTruncated: planResult.observations.contains(where: \.isTruncated),
                                      resultIssues: verification.resultIssues)
                    }
                    await stateSink(.completed(.completed))
                    return result(final: verifiedFinal,
                                  stop: .completed,
                                  observations: observations,
                                  tools: usedTools,
                                  statuses: statuses,
                                  iteration: iteration + 1,
                                  toolCalls: toolCallCount,
                                  terminalState: verification.terminalState,
                                  planID: validated.plan.id.rawValue,
                                  planVersion: validated.plan.version,
                                  planStepCount: validated.plan.steps.count,
                                  planRiskLevel: assessment.riskLevel.displayName,
                                  planApprovalRequired: validated.plan.approvalRequirement == .userApproval,
                                  planApprovalGranted: validated.plan.approvalRequirement != .userApproval || !planResult.records.isEmpty,
                                  planReplanCount: planResult.replanCount,
                                  planResultItemCount: evidence.count,
                                  planResultTruncated: planResult.observations.contains(where: \.isTruncated),
                                  resultIssues: verification.resultIssues)
                } catch let error as PlanError {
                    await stateSink(error == .cancelled ? .cancelled : .failed(.toolFailure))
                    return result(final: AgentFinalResponse(text: error.userVisibleMessage,
                                                            finishReason: "plan_\(String(describing: error))"),
                                  stop: error == .cancelled ? .cancelled : .toolFailure,
                                  observations: observations,
                                  tools: usedTools,
                                  statuses: statuses,
                                  iteration: iteration + 1,
                                  toolCalls: toolCallCount,
                                  terminalState: error == .cancelled ? .cancelled : .failed)
                } catch {
                    await stateSink(.failed(.toolFailure))
                    return result(final: AgentFinalResponse(text: "计划执行失败，已停止。", finishReason: "plan_failed"),
                                  stop: .toolFailure,
                                  observations: observations,
                                  tools: usedTools,
                                  statuses: statuses,
                                  iteration: iteration + 1,
                                  toolCalls: toolCallCount,
                                  terminalState: .failed)
                }

            case .toolCall(let request):
                guard policy.allowTools else {
                    let obs = observation(for: request, status: .denied,
                                          summary: "当前模式不执行工具操作",
                                          content: .object(["error": .string("tools disabled")]))
                    observations.append(obs); statuses.append(.denied)
                    await stateSink(.toolObserved(obs))
                    return await finishAfterLimit(.permissionDenied, agentContext: agentContext,
                                                  observations: observations, tools: usedTools,
                                                  statuses: statuses, iteration: iteration + 1,
                                                  toolCalls: toolCallCount,
                                                  toolRequests: observedToolRequests,
                                                  availableCapabilities: availableCapabilities,
                                                  taskID: taskID,
                                                  isCancelled: isCancelled)
                }
                guard toolCallCount < limits.maxToolCalls else {
                    return await finishAfterLimit(.toolCallLimit, agentContext: agentContext,
                                                  observations: observations, tools: usedTools,
                                                  statuses: statuses, iteration: iteration,
                                                  toolCalls: toolCallCount,
                                                  toolRequests: observedToolRequests,
                                                  availableCapabilities: availableCapabilities,
                                                  taskID: taskID,
                                                  isCancelled: isCancelled)
                }
                guard callIDs.insert(request.callID).inserted else {
                    return await finishAfterLimit(.repeatedToolCall, agentContext: agentContext,
                                                  observations: observations, tools: usedTools,
                                                  statuses: statuses, iteration: iteration + 1,
                                                  toolCalls: toolCallCount,
                                                  toolRequests: observedToolRequests,
                                                  availableCapabilities: availableCapabilities,
                                                  taskID: taskID,
                                                  isCancelled: isCancelled)
                }

                if let platformExecutor = toolPlatformExecutor {
                    guard let entry = turnToolCatalog.lookup(ToolID(rawValue: request.toolName)) else {
                        let obs = observation(for: request, status: .failed,
                                              summary: "工具不可用",
                                              content: .object(["error": .string("unknown tool")]))
                        observations.append(obs); statuses.append(.failed)
                        observedToolRequests.append(request)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                        continue
                    }

                    let manifest = entry.manifest
                    let safeRequest = AgentToolCallRequest(callID: request.callID,
                                                           toolName: manifest.id.rawValue,
                                                           arguments: request.arguments,
                                                           userVisibleSummary: manifest.userVisibleExecutionSummary)
                    let validation = ToolSchemaValidator.validate(safeRequest.arguments,
                                                                  against: manifest.inputSchema)
                    guard validation.accepted else {
                        let obs = observation(for: safeRequest, status: .failed,
                                              summary: "工具参数无效",
                                              content: .object([
                                                "error": .string("schema validation failed"),
                                                "path": .string(validation.issues.first?.path ?? "$"),
                                              ]))
                        observations.append(obs); statuses.append(.failed)
                        observedToolRequests.append(safeRequest)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                        continue
                    }

                    let fingerprint = safeRequest.fingerprint
                    if fingerprint == lastFingerprint {
                        repeatedIdenticalCount += 1
                        if repeatedIdenticalCount >= limits.maxRepeatedIdenticalToolCalls {
                            return await finishAfterLimit(.repeatedToolCall, agentContext: agentContext,
                                                          observations: observations, tools: usedTools,
                                                          statuses: statuses, iteration: iteration + 1,
                                                          toolCalls: toolCallCount,
                                                          toolRequests: observedToolRequests,
                                                          availableCapabilities: availableCapabilities,
                                                          taskID: taskID,
                                                          isCancelled: isCancelled)
                        }
                    } else {
                        repeatedIdenticalCount = 0
                        lastFingerprint = fingerprint
                    }

                    var token: CapabilityToken?
                    if let capabilityID = manifest.permissionRequirement.capabilityID {
                        let gateOutcome = await gate.evaluate(capabilityID: capabilityID,
                                                              reason: manifest.userVisibleExecutionSummary,
                                                              taskID: taskID)
                        switch gateOutcome {
                        case .askUser:
                            await stateSink(.awaitingToolApproval(toolName: manifest.id.rawValue))
                            return result(final: AgentFinalResponse(text: "需要用户确认权限，但当前运行没有可用的确认通道，已停止。",
                                                                    finishReason: "permission_unavailable"),
                                          stop: .permissionDenied, observations: observations,
                                          tools: usedTools, statuses: statuses,
                                          iteration: iteration + 1, toolCalls: toolCallCount,
                                          terminalState: .failed)
                        case .denied(let reason):
                            let obs = observation(for: safeRequest, status: .denied,
                                                  summary: "权限被拒绝",
                                                  content: .object(["error": .string(reason)]))
                            observations.append(obs); statuses.append(.denied)
                            observedToolRequests.append(safeRequest)
                            await stateSink(.toolObserved(obs))
                            await stateSink(.feedingObservation(iteration: iteration))
                            continue
                        case .granted(let grantedToken):
                            token = grantedToken
                        }
                    }

                    if let systemPermission = manifest.permissionRequirement.systemPermission,
                       let capabilityID = manifest.permissionRequirement.capabilityID,
                       systemAuthorization.requiresSystemAuthorization(capabilityID) {
                        let status = await systemAuthorization.status(for: capabilityID)
                        guard status == .granted else {
                            let obs = observation(for: safeRequest, status: .denied,
                                                  summary: "需要系统授权",
                                                  content: .object([
                                                    "error": .string("system permission missing"),
                                                    "systemPermission": .string(systemPermission.rawValue),
                                                    "status": .string(status.rawValue),
                                                  ]))
                            observations.append(obs); statuses.append(.denied)
                            observedToolRequests.append(safeRequest)
                            await stateSink(.toolObserved(obs))
                            await stateSink(.feedingObservation(iteration: iteration))
                            continue
                        }
                    }

                    await stateSink(.executingTool(toolName: manifest.id.rawValue))
                    let context = ToolExecutionContext(taskID: taskID,
                                                       runID: turnID,
                                                       turnID: turnID,
                                                       callID: safeRequest.callID,
                                                       toolID: manifest.id,
                                                       locale: localeProvider(),
                                                       timeZone: timeZoneProvider(),
                                                       clock: clock,
                                                       capabilityToken: token,
                                                       permissionAlreadyEvaluated: true,
                                                       deadline: startedAt.addingTimeInterval(limits.turnDeadline))
                    let execution = await platformExecutor.executeTool(request: safeRequest, context: context)
                    toolCallCount += 1
                    usedTools.append(manifest.id.rawValue)
                    observedToolRequests.append(safeRequest)
                    switch execution {
                    case .success(let result):
                        let obs = observationSanitizer.observation(for: safeRequest,
                                                                   result: result,
                                                                   maxCharacters: limits.maxObservationCharacters)
                        statuses.append(obs.status)
                        observations.append(obs)
                        await stateSink(.toolObserved(obs))
                    case .failure(let error):
                        let obs = observation(for: safeRequest, error: error)
                        statuses.append(obs.status)
                        observations.append(obs)
                        await stateSink(.toolObserved(obs))
                    }
                    await stateSink(.feedingObservation(iteration: iteration))
                    continue
                }

                guard CapabilityCatalog.lookup(request.toolName) != nil,
                      CapabilityCatalogSnapshot.forPolicy(policy).contains(request.toolName) else {
                    let obs = observation(for: request, status: .failed,
                                          summary: "工具不可用",
                                          content: .object(["error": .string("unknown tool")]))
                        observations.append(obs); statuses.append(.failed)
                        observedToolRequests.append(request)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                        continue
                }

                let arguments: [String: String]
                do {
                    arguments = try request.arguments.stringArguments()
                } catch {
                    let obs = observation(for: request, status: .failed,
                                          summary: "工具参数无效",
                                          content: .object(["error": .string("invalid arguments")]))
                        observations.append(obs); statuses.append(.failed)
                        observedToolRequests.append(request)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                        continue
                }

                let fingerprint = request.fingerprint
                if fingerprint == lastFingerprint {
                    repeatedIdenticalCount += 1
                    if repeatedIdenticalCount >= limits.maxRepeatedIdenticalToolCalls {
                        return await finishAfterLimit(.repeatedToolCall, agentContext: agentContext,
                                                      observations: observations, tools: usedTools,
                                                      statuses: statuses, iteration: iteration + 1,
                                                      toolCalls: toolCallCount,
                                                      toolRequests: observedToolRequests,
                                                      availableCapabilities: availableCapabilities,
                                                      taskID: taskID,
                                                      isCancelled: isCancelled)
                    }
                } else {
                    repeatedIdenticalCount = 0
                    lastFingerprint = fingerprint
                }

                await stateSink(.executingTool(toolName: request.toolName))
                let gateOutcome = await gate.evaluate(capabilityID: request.toolName,
                                                      reason: request.userVisibleSummary,
                                                      taskID: taskID)
                switch gateOutcome {
                case .askUser:
                    // P15 — fail-closed: do NOT execute the tool when the gate
                    // returns `.askUser`. Surface the wait via the canonical
                    // `waitingApproval` channel so `PetAgentRuntimeCoordinator`
                    // emits `.waitingForApproval(...)` events that drive a
                    // `TaskActivityCard` with friendly "等待你的确认" / "需要
                    // 你的允许才能继续" copy plus 允许 / 不允许 buttons. The
                    // coordinator short-circuits assistant bubble emission for
                    // this case (P16 GAP-01) so we never surface an extra chat
                    // message that contradicts the visible approval card. The
                    // legacy code path returned `terminalState: .failed`
                    // immediately, which was a UX regression — a user-facing
                    // assistant should NOT report failure when the only blocker
                    // is a pending user approval.
                    await stateSink(.awaitingToolApproval(toolName: request.toolName))
                    var waiting: [String] = []
                    if !waiting.contains(request.toolName) {
                        waiting.append(request.toolName)
                    }
                    return result(final: AgentFinalResponse(text: "需要你的允许才能继续。",
                                                            finishReason: "permission_unavailable"),
                                  stop: .permissionDenied, observations: observations,
                                  tools: usedTools, statuses: statuses,
                                  iteration: iteration + 1, toolCalls: toolCallCount,
                                  waitingApproval: waiting,
                                  terminalState: .failed)
                case .denied(let reason):
                    let obs = observation(for: request, status: .denied,
                                          summary: "权限被拒绝",
                                          content: .object(["error": .string(reason)]))
                    observations.append(obs); statuses.append(.denied)
                    observedToolRequests.append(request)
                    await stateSink(.toolObserved(obs))
                    await stateSink(.feedingObservation(iteration: iteration))
                    continue
                case .granted(let token):
                    do {
                        let step = AgentPlanStep(description: request.userVisibleSummary,
                                                 capabilityID: request.toolName,
                                                 params: arguments)
                    let outcome = try await withTimeout(seconds: limits.toolExecutionTimeout) {
                        await executor.execute(step: step, token: token)
                    }
                        toolCallCount += 1
                        usedTools.append(request.toolName)
                        let status: AgentLoopObservationStatus = outcome.ok ? .success : .failed
                        statuses.append(status)
                        let obs = observation(for: request, outcome: outcome, status: status)
                        observations.append(obs)
                        observedToolRequests.append(request)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                    } catch is RuntimeTimeoutError {
                        toolCallCount += 1
                        usedTools.append(request.toolName)
                        statuses.append(.timeout)
                        let obs = observation(for: request, status: .timeout,
                                              summary: "工具执行超时",
                                              content: .object(["error": .string("timeout")]))
                        observations.append(obs)
                        observedToolRequests.append(request)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                    } catch is CancellationError {
                        await stateSink(.cancelled)
                        return result(stop: .cancelled, observations: observations, tools: usedTools,
                                      statuses: statuses, iteration: iteration + 1,
                                      toolCalls: toolCallCount, terminalState: .cancelled)
                    } catch {
                        toolCallCount += 1
                        usedTools.append(request.toolName)
                        statuses.append(.failed)
                        let obs = observation(for: request, status: .failed,
                                              summary: "工具执行失败",
                                              content: .object(["error": .string("tool failed")]))
                        observations.append(obs)
                        observedToolRequests.append(request)
                        await stateSink(.toolObserved(obs))
                        await stateSink(.feedingObservation(iteration: iteration))
                    }
                }
            }
        }

        return await finishAfterLimit(.iterationLimit, agentContext: agentContext,
                                      observations: observations, tools: usedTools,
                                      statuses: statuses,
                                      iteration: limits.maxIterations,
                                      toolCalls: toolCallCount,
                                      toolRequests: observedToolRequests,
                                      availableCapabilities: availableCapabilities,
                                      taskID: taskID,
                                      isCancelled: isCancelled)
    }

    private static func requiredToolName(for agentContext: AgentContext) -> String? {
        RuntimeRequestPreparer.prepare(userText: agentContext.userText,
                                       context: agentContext.intentContext)
            .requiredCapabilities
            .first?
            .toolName
    }

    private func unmetRequiredToolFinal(requiredToolName: String?,
                                        observations: [AgentToolObservation]) -> AgentFinalResponse? {
        guard let requiredToolName else { return nil }
        if observations.contains(where: { $0.toolName == requiredToolName && $0.status == .success }) {
            return nil
        }
        let finishReason = observations.contains(where: { $0.toolName == requiredToolName })
            ? "requiredToolFailed"
            : "requiredToolNotExecuted"
        let text: String
        switch requiredToolName {
        case "get_current_datetime":
            text = "未能调用日期时间工具"
        default:
            text = "必要工具未成功执行，任务未完成。"
        }
        return AgentFinalResponse(text: text,
                                  finishReason: finishReason,
                                  providerMetadata: ["requiredTool": requiredToolName])
    }

    private func runTaskPlan(_ validated: ValidatedTaskPlan,
                             agentContext: AgentContext,
                             taskID: UUID,
                             turnID: UUID,
                             startedAt: Date,
                             availableCapabilities: CapabilityCatalogSnapshot,
                             platformExecutor: any ToolPlatformExecuting,
                             iteration: Int,
                             isCancelled: @escaping CancellationCheck) async throws -> PlanExecutionResult {
        var approvalState = TaskPlanRuntimeState(validated: validated, status: .validating)
        await planEventSink(.planCreated(approvalState.presentationSnapshot()))
        switch validated.plan.approvalRequirement {
        case .none:
            break
        case .blocked:
            throw PlanError.unsupportedRisk(validated.plan.riskSummary.highestRisk.displayName)
        case .userApproval:
            approvalState.status = .awaitingApproval
            let snapshot = approvalState.presentationSnapshot()
            await planEventSink(.approvalRequired(snapshot))
            let decision = await planApprovalHandler.requestApproval(for: validated, snapshot: snapshot)
            switch decision {
            case .approved:
                approvalState.status = .approved
                await planEventSink(.planApproved(approvalState.presentationSnapshot()))
            case .declined:
                approvalState.cancelRemaining()
                await planEventSink(.planCancelled(approvalState.presentationSnapshot()))
                throw PlanError.approvalDeclined
            case .timedOut:
                approvalState.cancelRemaining()
                await planEventSink(.planCancelled(approvalState.presentationSnapshot()))
                throw PlanError.approvalTimedOut
            case .cancelled:
                approvalState.cancelRemaining()
                await planEventSink(.planCancelled(approvalState.presentationSnapshot()))
                throw PlanError.cancelled
            }
        }

        if await isCancelled() || Task.isCancelled {
            approvalState.cancelRemaining()
            await planEventSink(.planCancelled(approvalState.presentationSnapshot()))
            throw PlanError.cancelled
        }

        let executionContext = PlanExecutionContext(
            taskID: taskID,
            turnID: turnID,
            startedAt: startedAt,
            locale: .current,
            timeZone: .current,
            clock: clock,
            gate: gate,
            toolPlatformExecutor: platformExecutor,
            systemAuthorization: systemAuthorization,
            observationSanitizer: observationSanitizer,
            isCancelled: isCancelled,
            eventSink: planEventSink)
        let executor = DefaultTaskPlanExecutor()
        var result = try await executor.runSynchronous(plan: validated,
                                                       context: executionContext)

        if shouldAttemptReplan(result),
           let replan = try await attemptReplan(original: validated,
                                                agentContext: agentContext,
                                                observations: result.observations,
                                                completedFingerprints: completedFingerprints(from: validated, result: result),
                                                taskID: taskID,
                                                turnID: turnID,
                                                startedAt: startedAt,
                                                platformExecutor: platformExecutor,
                                                iteration: iteration,
                                                isCancelled: isCancelled) {
            result.records.append(contentsOf: replan.records)
            result.observations.append(contentsOf: replan.observations)
            result.status = mergedPlanStatus([result.status, replan.status])
            result.stopReason = result.status == .completed || result.status == .partiallyCompleted ? .completed : replan.stopReason
            result.replanCount = 1
        }
        return result
    }

    private func attemptReplan(original: ValidatedTaskPlan,
                               agentContext: AgentContext,
                               observations: [AgentToolObservation],
                               completedFingerprints: Set<String>,
                               taskID: UUID,
                               turnID: UUID,
                               startedAt: Date,
                               platformExecutor: any ToolPlatformExecuting,
                               iteration: Int,
                               isCancelled: @escaping CancellationCheck) async throws -> PlanExecutionResult? {
        guard plannerLimits.maxReplans > 0,
              !observations.contains(where: { $0.status == .denied }) else { return nil }
        var replanState = TaskPlanRuntimeState(validated: original, status: .replanning)
        await planEventSink(.replanning(replanState.presentationSnapshot()))
        let decision = try? await nextDecision(agentContext: agentContext,
                                               observations: observations,
                                               toolRequests: planToolRequests(original.plan),
                                               availableCapabilities: original.toolCatalogSnapshot.capabilitySnapshot(),
                                               iteration: iteration + 1,
                                               repairAttempt: 0,
                                               timeout: plannerLimits.planningTimeout)
        guard let decision, case .proposePlan(let raw) = decision.decision else {
            return nil
        }
        let replanID = TaskPlanID(rawValue: "\(original.plan.id.rawValue)-replan_1")
        let validated = try TaskPlanValidator.validate(raw,
                                                       snapshot: original.toolCatalogSnapshot,
                                                       createdAt: clock.now(),
                                                       limits: plannerLimits,
                                                       id: replanID)
        guard TaskPlanValidator.normalizedRisk(validated.plan.riskSummary.highestRisk)
                <= TaskPlanValidator.normalizedRisk(original.plan.riskSummary.highestRisk) else {
            throw PlanError.replanFailed
        }
        if validated.plan.approvalRequirement == .userApproval,
           validated.plan.steps.contains(where: { !completedFingerprints.contains($0.fingerprint) }) {
            replanState = TaskPlanRuntimeState(validated: validated, status: .awaitingApproval)
            let snapshot = replanState.presentationSnapshot()
            await planEventSink(.approvalRequired(snapshot))
            let decision = await planApprovalHandler.requestApproval(for: validated, snapshot: snapshot)
            guard decision == .approved else { throw PlanError.approvalDeclined }
            replanState.status = .approved
            await planEventSink(.planApproved(replanState.presentationSnapshot()))
        }
        let executionContext = PlanExecutionContext(
            taskID: taskID,
            turnID: turnID,
            startedAt: startedAt,
            locale: .current,
            timeZone: .current,
            clock: clock,
            gate: gate,
            toolPlatformExecutor: platformExecutor,
            systemAuthorization: systemAuthorization,
            observationSanitizer: observationSanitizer,
            isCancelled: isCancelled,
            eventSink: planEventSink)
        return try await DefaultTaskPlanExecutor().runSynchronous(plan: validated,
                                                                  context: executionContext,
                                                                  initialCompletedFingerprints: completedFingerprints)
    }

    private func shouldAttemptReplan(_ result: PlanExecutionResult) -> Bool {
        guard plannerLimits.maxReplans > 0 else { return false }
        guard result.records.contains(where: { [.failed, .timedOut].contains($0.status) }) else { return false }
        guard !result.records.contains(where: { $0.status == .denied || $0.status == .cancelled }) else { return false }
        return true
    }

    private func completedFingerprints(from plan: ValidatedTaskPlan,
                                       result: PlanExecutionResult) -> Set<String> {
        let successful = Set(result.records.filter { $0.status.isSuccessful }.map(\.stepID))
        return Set(plan.plan.steps.filter { successful.contains($0.id) }.map(\.fingerprint))
    }

    private func mergedPlanStatus(_ statuses: [PlanStatus]) -> PlanStatus {
        if statuses.allSatisfy({ $0 == .completed }) { return .completed }
        if statuses.contains(where: { $0 == .completed || $0 == .partiallyCompleted }) { return .partiallyCompleted }
        if statuses.contains(.cancelled) { return .cancelled }
        return .failed
    }

    private func synthesizePlanFinal(agentContext: AgentContext,
                                     observations: [AgentToolObservation],
                                     toolRequests: [AgentToolCallRequest],
                                     iteration: Int) async throws -> AgentFinalResponse {
        let emptyCapabilities = CapabilityCatalogSnapshot(capabilities: [], toolCatalog: .empty)
        let final = try await nextDecision(agentContext: agentContext,
                                           observations: observations,
                                           toolRequests: toolRequests,
                                           availableCapabilities: emptyCapabilities,
                                           iteration: iteration,
                                           repairAttempt: 0,
                                           timeout: plannerLimits.finalSynthesisTimeout)
        switch final.decision {
        case .finalResponse(let response):
            return response
        case .toolCall, .proposePlan:
            return AgentFinalResponse(text: summarizeObservations(observations),
                                      finishReason: "plan_synthesis_tool_blocked")
        }
    }

    private func planToolRequests(_ plan: TaskPlan) -> [AgentToolCallRequest] {
        plan.steps.map {
            AgentToolCallRequest(callID: "\(plan.id.rawValue)-\($0.id.rawValue)",
                                 toolName: $0.toolID.rawValue,
                                 arguments: $0.arguments,
                                 userVisibleSummary: $0.userVisibleSummary)
        }
    }

    private func planSnapshot(for validated: ValidatedTaskPlan,
                              records: [PlanStepExecutionRecord],
                              status: PlanStatus) -> PlanPresentationSnapshot {
        var state = TaskPlanRuntimeState(validated: validated, status: status)
        for record in records {
            state.update(record.stepID, status: record.status)
        }
        return state.presentationSnapshot()
    }

    private func loopStatus(for status: PlanStepStatus) -> AgentLoopObservationStatus {
        switch status {
        case .succeeded, .partial:
            return .success
        case .denied:
            return .denied
        case .timedOut:
            return .timeout
        case .pending, .running, .failed, .cancelled, .skippedDependency, .unknown:
            return .failed
        }
    }

    private func nextDecision(agentContext: AgentContext,
                              observations: [AgentToolObservation],
                              toolRequests: [AgentToolCallRequest],
                              availableCapabilities: CapabilityCatalogSnapshot,
                              iteration: Int,
                              repairAttempt: Int,
                              timeout: TimeInterval) async throws -> AgentLoopDecisionResult {
        let context = AgentLoopDecisionContext(agentContext: agentContext,
                                               observations: observations,
                                               toolCalls: toolRequests,
                                               iteration: iteration,
                                               repairAttempt: repairAttempt)
        return try await withTimeout(seconds: timeout) {
            try await provider.decide(context: context,
                                      availableCapabilities: availableCapabilities)
        }
    }

    private func repairDecision(agentContext: AgentContext,
                                observations: [AgentToolObservation],
                                toolRequests: [AgentToolCallRequest],
                                availableCapabilities: CapabilityCatalogSnapshot,
                                iteration: Int) async throws -> AgentLoopDecisionResult {
        guard limits.maxConsecutiveParseRepairs > 0 else {
            throw AgentLoopRuntimeError.decisionParseFailed
        }
        return try await nextDecision(agentContext: agentContext,
                                      observations: observations,
                                      toolRequests: toolRequests,
                                      availableCapabilities: availableCapabilities,
                                      iteration: iteration,
                                      repairAttempt: 1,
                                      timeout: limits.decisionRepairTimeout)
    }

    private func finishAfterLimit(_ reason: AgentLoopStopReason,
                                  agentContext: AgentContext,
                                  observations: [AgentToolObservation],
                                  tools: [String],
                                  statuses: [AgentLoopObservationStatus],
                                  iteration: Int,
                                  toolCalls: Int,
                                  toolRequests: [AgentToolCallRequest],
                                  availableCapabilities: CapabilityCatalogSnapshot,
                                  taskID: UUID,
                                  isCancelled: @escaping CancellationCheck) async -> AgentLoopRunResult {
        if await isCancelled() || Task.isCancelled {
            await stateSink(.cancelled)
            return result(stop: .cancelled, observations: observations, tools: tools,
                          statuses: statuses, iteration: iteration, toolCalls: toolCalls,
                          terminalState: .cancelled)
        }
        await stateSink(.finishing)
        if let final = try? await nextDecision(agentContext: agentContext,
                                               observations: observations,
                                               toolRequests: toolRequests,
                                               availableCapabilities: availableCapabilities,
                                               iteration: iteration,
                                               repairAttempt: 0,
                                               timeout: limits.modelRequestTimeout),
           case .finalResponse(let response) = final.decision {
            await stateSink(.completed(reason))
            return result(final: ensureFinalText(response, observations: observations),
                          stop: reason, observations: observations, tools: tools,
                          statuses: statuses, iteration: iteration, toolCalls: toolCalls,
                          terminalState: terminalState(for: reason, statuses: statuses),
                          memoryCandidates: final.memoryCandidates,
                          resultDocument: final.resultDocument,
                          resultIssues: final.resultIssues)
        }
        let fallback = fallbackFinal(for: reason, observations: observations)
        await stateSink(reason == .cancelled ? .cancelled : .failed(reason))
        return result(final: fallback, stop: reason, observations: observations,
                      tools: tools, statuses: statuses, iteration: iteration,
                      toolCalls: toolCalls, terminalState: terminalState(for: reason, statuses: statuses))
    }

    private func ensureFinalText(_ response: AgentFinalResponse,
                                 observations: [AgentToolObservation]) -> AgentFinalResponse {
        guard response.text.isEmpty, !observations.isEmpty else { return response }
        return AgentFinalResponse(text: summarizeObservations(observations), finishReason: response.finishReason,
                                  providerMetadata: response.providerMetadata)
    }

    private func fallbackFinal(for reason: AgentLoopStopReason,
                               observations: [AgentToolObservation]) -> AgentFinalResponse {
        let text: String
        switch reason {
        case .completed:
            text = summarizeObservations(observations)
        case .cancelled:
            text = "已取消。"
        case .modelTimeout:
            text = "模型响应超时，先停在这里。"
        case .toolTimeout:
            text = "工具执行超时，我先基于已知结果回答。"
        case .iterationLimit, .toolCallLimit:
            text = observations.isEmpty ? "任务达到安全限制，已停止继续执行。"
                                        : summarizeObservations(observations)
        case .repeatedToolCall:
            text = deterministicFallback(for: observations)
        case .malformedDecision:
            text = "模型返回的结构化决策无效，已停止工具执行。"
        case .permissionDenied:
            text = "权限未允许，我不能继续执行该工具。"
        case .providerFailure:
            text = "模型调用失败，先停在这里。"
        case .toolFailure:
            text = "工具执行失败，我先基于已有结果回答。"
        }
        return AgentFinalResponse(text: text, finishReason: reason.rawValue)
    }

    private func summarizeObservations(_ observations: [AgentToolObservation]) -> String {
        guard !observations.isEmpty else { return "" }
        let lines = observations.suffix(3).map { observation in
            "\(observation.toolName)：\(observation.userSafeSummary)"
        }
        return lines.joined(separator: "\n")
    }

    private func terminalToolFailureBeforeFinal(statuses: [AgentLoopObservationStatus]) -> AgentLoopStopReason? {
        switch statuses.last {
        case .denied:
            return .permissionDenied
        case .failed:
            return .toolFailure
        case .timeout:
            return .toolTimeout
        case .success, .none:
            return nil
        }
    }

    private func deterministicFallback(for observations: [AgentToolObservation]) -> String {
        if let observation = observations.last(where: {
            $0.toolName == "get_current_datetime" && $0.status == .success
        }) {
            let local = observation.content.stringValue(for: "local_time")
                ?? observation.content.stringValue(for: "local")
                ?? observation.content.stringValue(for: "timestamp")
                ?? observation.content.stringValue(for: "iso8601")
            if let local {
                if let timezone = observation.content.stringValue(for: "timezone") {
                    return "当前本地时间：\(local)（\(timezone)）"
                }
                return "当前本地时间：\(local)"
            }
        }
        return "工具已经执行，但模型未能整理最终回复，请重试。"
    }

    private func result(final: AgentFinalResponse? = nil,
                        stop: AgentLoopStopReason,
                        observations: [AgentToolObservation],
                        tools: [String],
                        statuses: [AgentLoopObservationStatus],
                        iteration: Int,
                        toolCalls: Int,
                        waitingApproval: [String] = [],
                        terminalState: AgentTaskState = .succeeded,
                        planID: String? = nil,
                        planVersion: Int? = nil,
                        planStepCount: Int? = nil,
                        planRiskLevel: String? = nil,
                        planApprovalRequired: Bool? = nil,
                        planApprovalGranted: Bool? = nil,
                        planReplanCount: Int? = nil,
                        planResultItemCount: Int? = nil,
                        planResultTruncated: Bool? = nil,
                        memoryCandidates: [MemoryCandidate] = [],
                        resultDocument: AgentResultDocument? = nil,
                        resultIssues: [AgentResultValidationIssue] = []) -> AgentLoopRunResult {
        AgentLoopRunResult(finalResponse: final, stopReason: stop,
                           observations: observations,
                           usedToolNames: tools,
                           toolStatuses: statuses,
                           iterationCount: iteration,
                           toolCallCount: toolCalls,
                           waitingApproval: waitingApproval,
                           terminalState: terminalState,
                           planID: planID,
                           planVersion: planVersion,
                           planStepCount: planStepCount,
                           planRiskLevel: planRiskLevel,
                           planApprovalRequired: planApprovalRequired,
                           planApprovalGranted: planApprovalGranted,
                           planReplanCount: planReplanCount,
                           planResultItemCount: planResultItemCount,
                           planResultTruncated: planResultTruncated,
                           memoryCandidates: memoryCandidates,
                           resultDocument: resultDocument,
                           resultIssues: resultIssues)
    }

    private func terminalState(for reason: AgentLoopStopReason,
                               statuses: [AgentLoopObservationStatus]) -> AgentTaskState {
        switch reason {
        case .completed:
            return statuses.contains(where: { $0 != .success }) ? .partiallySucceeded : .succeeded
        case .cancelled:
            return .cancelled
        case .permissionDenied:
            return .failed
        case .repeatedToolCall:
            guard !statuses.isEmpty else { return .failed }
            return statuses.allSatisfy { $0 == .success } ? .succeeded : .partiallySucceeded
        case .iterationLimit, .toolCallLimit:
            return statuses.isEmpty ? .failed : .partiallySucceeded
        default:
            return .failed
        }
    }

    private func observation(for request: AgentToolCallRequest,
                             outcome: ToolOutcome,
                             status: AgentLoopObservationStatus) -> AgentToolObservation {
        let raw = outcome.ok ? outcome.output : (outcome.error ?? "tool failed")
        let safe = AgentPrivacyRedactor.safeText(raw, maxLength: limits.maxObservationCharacters)
        let content = structuredObservationContent(from: safe.text,
                                                   status: status,
                                                   contentKey: outcome.ok ? "output" : "error")
        return AgentToolObservation(callID: request.callID,
                                    toolName: request.toolName,
                                    status: status,
                                    content: content,
                                    userSafeSummary: safe.text.isEmpty ? status.rawValue : safe.text,
                                    isTruncated: safe.truncated)
    }

    private func observation(for request: AgentToolCallRequest,
                             error: ToolPlatformError) -> AgentToolObservation {
        let status: AgentLoopObservationStatus
        let summary: String
        let code: String
        switch error {
        case .unknownTool:
            status = .failed; summary = "工具不可用"; code = "unknown_tool"
        case .duplicateRegistration:
            status = .failed; summary = "工具注册异常"; code = "duplicate_registration"
        case .toolDisabled:
            status = .denied; summary = "工具已停用"; code = "tool_disabled"
        case .toolUnavailable:
            status = .failed; summary = "工具暂不可用"; code = "tool_unavailable"
        case .invalidArguments, .schemaValidationFailed:
            status = .failed; summary = "工具参数无效"; code = "invalid_arguments"
        case .permissionDenied:
            status = .denied; summary = "权限被拒绝"; code = "permission_denied"
        case .systemPermissionMissing:
            status = .denied; summary = "需要系统授权"; code = "system_permission_missing"
        case .timedOut:
            status = .timeout; summary = "工具执行超时"; code = "timed_out"
        case .cancelled:
            status = .failed; summary = "工具已取消"; code = "cancelled"
        case .resultTooLarge:
            status = .failed; summary = "工具结果过大"; code = "result_too_large"
        case .unsupportedProviderSchema:
            status = .failed; summary = "Provider 不支持该工具 schema"; code = "unsupported_provider_schema"
        case .executionFailed, .internalInvariantViolation:
            status = .failed; summary = "工具执行失败"; code = "execution_failed"
        }
        return observation(for: request,
                           status: status,
                           summary: summary,
                           content: .object([
                            "status": .string(status.rawValue),
                            "error": .string(code),
                           ]))
    }

    private func structuredObservationContent(from raw: String,
                                              status: AgentLoopObservationStatus,
                                              contentKey: String) -> AgentJSONValue {
        if let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data),
           let value = try? AgentJSONValue.fromJSONObject(json),
           case .object(var object) = value {
            if object["status"] == nil {
                object["status"] = .string(status.rawValue)
            }
            return .object(object)
        }
        return .object([
            "status": .string(status.rawValue),
            contentKey: .string(raw),
        ])
    }

    private func observation(for request: AgentToolCallRequest,
                             status: AgentLoopObservationStatus,
                             summary: String,
                             content: AgentJSONValue) -> AgentToolObservation {
        let safe = AgentPrivacyRedactor.safeText(summary, maxLength: limits.maxObservationCharacters)
        return AgentToolObservation(callID: request.callID,
                                    toolName: request.toolName,
                                    status: status,
                                    content: content,
                                    userSafeSummary: safe.text,
                                    isTruncated: safe.truncated)
    }
}

private extension AgentJSONValue {
    func stringValue(for key: String) -> String? {
        guard case .object(let object) = self,
              case .string(let value)? = object[key],
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }
}
