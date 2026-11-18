import Foundation
import AICore
import PetBrainCore
import os.lock

public struct LocalDiscoveryWorkflowActivity: Sendable, Equatable {
    public var kind: AgentTaskEventKind
    public var title: String
    public var detail: String?
    public var stepID: String?
    public var toolName: String?
    public var failureCategory: AgentTaskFailureCategory?

    public init(kind: AgentTaskEventKind,
                title: String,
                detail: String? = nil,
                stepID: String? = nil,
                toolName: String? = nil,
                failureCategory: AgentTaskFailureCategory? = nil) {
        self.kind = kind
        self.title = AgentPrivacyRedactor.safeSummary(title, fallback: "Local Discovery")
        self.detail = detail.map { AgentPrivacyRedactor.safeText($0, maxLength: 500).text }
        self.stepID = stepID.map(AgentEventRedactor.safeIdentifier)
        self.toolName = toolName.map(AgentEventRedactor.safeIdentifier)
        self.failureCategory = failureCategory
    }
}

public struct LocalDiscoveryWorkflowRunOutcome: Sendable, Equatable {
    public var loopResult: AgentLoopRunResult
    public var decision: LocalDiscoveryIntentDecision
    public var plannedQuery: LocalDiscoveryPlannedQuery
    public var localResult: LocalDiscoveryResult?
    public var verifierReport: LocalDiscoveryVerifierReport

    public init(loopResult: AgentLoopRunResult,
                decision: LocalDiscoveryIntentDecision,
                plannedQuery: LocalDiscoveryPlannedQuery,
                localResult: LocalDiscoveryResult?,
                verifierReport: LocalDiscoveryVerifierReport) {
        self.loopResult = loopResult
        self.decision = decision
        self.plannedQuery = plannedQuery
        self.localResult = localResult
        self.verifierReport = verifierReport
    }
}

public struct LocalDiscoveryWorkflow: Sendable {
    public typealias ActivitySink = @Sendable (LocalDiscoveryWorkflowActivity) async -> Void
    public typealias CancellationCheck = @Sendable () async -> Bool

    private let toolCatalogProvider: any ToolCatalogProviding
    private let toolPlatformExecutor: any ToolPlatformExecuting
    private let gate: any CapabilityGate
    private let systemAuthorization: any SystemAuthorizationProviding
    private let observationSanitizer: any ObservationSanitizing
    private let policy: AgentPolicy
    private let searchPolicy: LocalDiscoverySearchPolicy
    private let clock: RuntimeClock
    private let localeProvider: @Sendable () -> Locale
    private let timeZoneProvider: @Sendable () -> TimeZone
    private let structuredPlanner: (any LocalDiscoveryStructuredPlanning)?
    private let checkpointStore: AgentCheckpointStore?
    private let conversationID: UUID?

    public init(toolCatalogProvider: any ToolCatalogProviding,
                toolPlatformExecutor: any ToolPlatformExecuting,
                gate: any CapabilityGate,
                systemAuthorization: any SystemAuthorizationProviding = DefaultSystemAuthorizationPolicy(),
                observationSanitizer: any ObservationSanitizing = DefaultObservationSanitizer(),
                policy: AgentPolicy,
                searchPolicy: LocalDiscoverySearchPolicy = LocalDiscoverySearchPolicy(),
                clock: RuntimeClock = WallClock(),
                localeProvider: @escaping @Sendable () -> Locale = { .current },
                timeZoneProvider: @escaping @Sendable () -> TimeZone = { .current },
                structuredPlanner: (any LocalDiscoveryStructuredPlanning)? = nil,
                checkpointStore: AgentCheckpointStore? = nil,
                conversationID: UUID? = nil) {
        self.toolCatalogProvider = toolCatalogProvider
        self.toolPlatformExecutor = toolPlatformExecutor
        self.gate = gate
        self.systemAuthorization = systemAuthorization
        self.observationSanitizer = observationSanitizer
        self.policy = policy
        self.searchPolicy = searchPolicy
        self.clock = clock
        self.localeProvider = localeProvider
        self.timeZoneProvider = timeZoneProvider
        self.structuredPlanner = structuredPlanner
        self.checkpointStore = checkpointStore
        self.conversationID = conversationID
    }

    public func run(userText: String,
                    decision: LocalDiscoveryIntentDecision,
                    conversationContext: ConversationIntentContext?,
                    taskID: UUID,
                    runID: UUID,
                    isCancelled: @escaping CancellationCheck,
                    activitySink: @escaping ActivitySink = { _ in }) async -> LocalDiscoveryWorkflowRunOutcome {
        let locale = localeProvider()
        let timeZone = timeZoneProvider()
        let now = clock.now()
        let planner = LocalDiscoveryQueryPlanner(policy: searchPolicy)
        var planned = LocalDiscoveryPlannedQuery(status: .notLocalDiscovery)
        var observations: [AgentToolObservation] = []
        var statuses: [AgentLoopObservationStatus] = []
        var usedTools: [String] = []
        var evidence: [AgentEvidenceRecord] = []
        var toolCallCount = 0
        var warnings: [String] = []
        var checkpointLabels: [String] = []
        let catalog = await toolCatalogProvider.toolCatalogSnapshot(for: policy)
        let deadline = now.addingTimeInterval(searchPolicy.maximumExecutionDurationSeconds)
        let recoveryLoad = await checkpointStore?.loadLocalDiscoverySnapshot(taskID: taskID, runID: runID)
        var workflowSnapshot: LocalDiscoveryWorkflowSnapshot
        switch recoveryLoad {
        case .terminal(let snapshot):
            planned = snapshot.plannedQuery
            let final = AgentFinalResponse(text: snapshot.currentStage == .cancelled
                                           ? "搜索已停止，已找到的未完成候选不会作为已验证结果推荐。"
                                           : "已恢复此前完成的 Local Discovery 结果。",
                                           finishReason: snapshot.currentStage.rawValue,
                                           providerMetadata: ["workflow": "localDiscovery", "recovery": "terminalReplay"])
            let loop = AgentLoopRunResult(finalResponse: final,
                                          stopReason: snapshot.currentStage == .cancelled ? .cancelled : .completed,
                                          observations: [],
                                          usedToolNames: snapshot.toolCompletions.map(\.toolID),
                                          toolStatuses: [],
                                          iterationCount: 0,
                                          toolCallCount: 0,
                                          terminalState: snapshot.currentStage == .cancelled ? .cancelled : .succeeded)
            return LocalDiscoveryWorkflowRunOutcome(loopResult: loop,
                                                    decision: decision,
                                                    plannedQuery: planned,
                                                    localResult: nil,
                                                    verifierReport: snapshot.verifierDisposition ?? LocalDiscoveryVerifierReport(verdict: .partialPass))
        case .recovered(let snapshot):
            workflowSnapshot = snapshot
            planned = snapshot.plannedQuery
            warnings = snapshot.warnings
            await activitySink(LocalDiscoveryWorkflowActivity(kind: .stepProgress,
                                                             title: "正在恢复地点搜索任务",
                                                             detail: snapshot.currentStage.rawValue,
                                                             stepID: "localDiscoveryRecovery"))
        case .recoveryBlocked(let reason):
            workflowSnapshot = LocalDiscoveryWorkflowSnapshot(taskID: taskID,
                                                              runID: runID,
                                                              currentStage: .recoveryBlocked,
                                                              searchPolicySnapshot: searchPolicy,
                                                              warnings: [reason],
                                                              updatedAt: now)
            let report = LocalDiscoveryVerifierReport(verdict: .fail,
                                                      issues: [.init(path: "$.recovery", message: reason)])
            return finishRecoveredBlocked(reason: reason,
                                          decision: decision,
                                          plannedQuery: planned,
                                          verifierReport: report)
        case .missing, .none:
            workflowSnapshot = LocalDiscoveryWorkflowSnapshot(taskID: taskID,
                                                              runID: runID,
                                                              searchPolicySnapshot: searchPolicy,
                                                              updatedAt: now)
        }
        var completedRouteCandidateIDs = Set(workflowSnapshot.completedRouteCandidateIDs)
        var completedEnrichmentCandidateIDs = Set(workflowSnapshot.completedEnrichmentCandidateIDs)
        var completedToolIdentities = Set(workflowSnapshot.toolCompletions)
        var lastCheckpointSequence = workflowSnapshot.lastAppliedEventSequence

        func emit(_ activity: LocalDiscoveryWorkflowActivity) async {
            guard await !isCancelled() else { return }
            await activitySink(activity)
        }

        func cancelledOutcome() -> LocalDiscoveryWorkflowRunOutcome {
            let final = AgentFinalResponse(text: "搜索已停止，已找到的未完成候选不会作为已验证结果推荐。",
                                           finishReason: "cancelled",
                                           providerMetadata: ["workflow": "localDiscovery"])
            let loop = AgentLoopRunResult(finalResponse: final,
                                          stopReason: .cancelled,
                                          observations: observations,
                                          usedToolNames: usedTools,
                                          toolStatuses: statuses,
                                          iterationCount: 1,
                                          toolCallCount: toolCallCount,
                                          terminalState: .cancelled)
            return LocalDiscoveryWorkflowRunOutcome(loopResult: loop,
                                                    decision: decision,
                                                    plannedQuery: planned,
                                                    localResult: nil,
                                                    verifierReport: LocalDiscoveryVerifierReport(verdict: .fail,
                                                                                                 issues: [.init(path: "$", message: "cancelled")]))
        }

        func finishRecoveredBlocked(reason: String,
                                    decision: LocalDiscoveryIntentDecision,
                                    plannedQuery: LocalDiscoveryPlannedQuery,
                                    verifierReport: LocalDiscoveryVerifierReport) -> LocalDiscoveryWorkflowRunOutcome {
            let final = AgentFinalResponse(text: "恢复状态不可安全确认，已停止以避免重复地点搜索或网页读取。",
                                           finishReason: "recoveryBlocked",
                                           providerMetadata: ["workflow": "localDiscovery", "recovery": reason])
            let loop = AgentLoopRunResult(finalResponse: final,
                                          stopReason: .toolFailure,
                                          observations: [],
                                          usedToolNames: [],
                                          toolStatuses: [],
                                          iterationCount: 0,
                                          toolCallCount: 0,
                                          terminalState: .failed)
            return LocalDiscoveryWorkflowRunOutcome(loopResult: loop,
                                                    decision: decision,
                                                    plannedQuery: plannedQuery,
                                                    localResult: nil,
                                                    verifierReport: verifierReport)
        }

        func finish(finalText: String,
                    stopReason: AgentLoopStopReason,
                    terminalState: AgentTaskState,
                    document: AgentResultDocument?,
                    localResult: LocalDiscoveryResult?,
                    verifierReport: LocalDiscoveryVerifierReport) -> LocalDiscoveryWorkflowRunOutcome {
            let final = AgentFinalResponse(text: finalText,
                                           finishReason: stopReason.rawValue,
                                           providerMetadata: [
                                            "workflow": "localDiscovery",
                                            "verifier": verifierReport.verdict.rawValue,
                                           ])
            let loop = AgentLoopRunResult(finalResponse: final,
                                          stopReason: stopReason,
                                          observations: observations,
                                          usedToolNames: Array(Set(usedTools)).sorted(),
                                          toolStatuses: statuses,
                                          iterationCount: 1,
                                          toolCallCount: toolCallCount,
                                          terminalState: terminalState,
                                          resultDocument: document,
                                          resultIssues: verifierReport.issues)
            return LocalDiscoveryWorkflowRunOutcome(loopResult: loop,
                                                    decision: decision,
                                                    plannedQuery: planned,
                                                    localResult: localResult,
                                                    verifierReport: verifierReport)
        }

        func recordCheckpoint(_ label: String,
                              stage: LocalDiscoveryWorkflowStage,
                              configure: ((inout LocalDiscoveryWorkflowSnapshot) -> Void)? = nil) async {
            checkpointLabels.append(label)
            lastCheckpointSequence += 1
            workflowSnapshot.currentStage = stage
            workflowSnapshot.lastAppliedEventSequence = lastCheckpointSequence
            workflowSnapshot.updatedAt = clock.now()
            workflowSnapshot.toolCompletions = Array(completedToolIdentities)
            workflowSnapshot.completedRouteCandidateIDs = Array(completedRouteCandidateIDs).sorted()
            workflowSnapshot.completedEnrichmentCandidateIDs = Array(completedEnrichmentCandidateIDs).sorted()
            workflowSnapshot.warnings = warnings
            configure?(&workflowSnapshot)
            try? await checkpointStore?.saveLocalDiscoverySnapshot(workflowSnapshot,
                                                                   state: stage == .cancelled ? .cancelled : .running,
                                                                   conversationID: conversationID,
                                                                   lastSequence: lastCheckpointSequence)
            await emit(LocalDiscoveryWorkflowActivity(kind: .stepProgress,
                                                      title: "已保存工作流检查点",
                                                      detail: label,
                                                      stepID: "localDiscoveryCheckpoint"))
        }

        func recordCancelledCheckpoint() async {
            await recordCheckpoint("cancelled",
                                   stage: .cancelled)
        }

        func toolIdentity(stage: LocalDiscoveryWorkflowStage,
                          toolName: String,
                          arguments: AgentJSONValue,
                          targetID: String?,
                          result: ToolExecutionResult) -> LocalDiscoveryToolCompletionIdentity {
            LocalDiscoveryToolCompletionIdentity(taskID: taskID,
                                                 runID: runID,
                                                 workflowStage: stage,
                                                 toolID: toolName,
                                                 normalizedInputDigest: AgentSideEffectLedger.digest(arguments),
                                                 targetID: targetID,
                                                 evidenceIDs: result.structuredData.evidenceReferences().map(\.evidenceID),
                                                 completedAt: clock.now())
        }

        func failureObservation(_ request: AgentToolCallRequest,
                                status: AgentLoopObservationStatus,
                                summary: String,
                                content: AgentJSONValue) -> AgentToolObservation {
            AgentToolObservation(callID: request.callID,
                                 toolName: request.toolName,
                                 status: status,
                                 content: content,
                                 userSafeSummary: summary)
        }

        func executeTool(toolName: String,
                         callID: String,
                         arguments: AgentJSONValue,
                         summary: String) async -> Result<ToolExecutionResult, ToolPlatformError> {
            if await isCancelled() || Task.isCancelled { return .failure(.cancelled) }
            guard toolCallCount < searchPolicy.maximumTotalToolCalls else {
                return .failure(.toolUnavailable("local discovery tool-call budget exhausted"))
            }
            let toolID = ToolID(rawValue: toolName)
            guard let entry = catalog.lookup(toolID), entry.enabled else {
                return .failure(.unknownTool(toolName))
            }
            let request = AgentToolCallRequest(callID: callID,
                                               toolName: toolName,
                                               arguments: arguments,
                                               userVisibleSummary: summary)
            var token: CapabilityToken?
            if let capabilityID = entry.manifest.permissionRequirement.capabilityID {
                let gateOutcome = await gate.evaluate(capabilityID: capabilityID,
                                                      reason: summary,
                                                      taskID: taskID)
                switch gateOutcome {
                case .askUser:
                    await activitySink(LocalDiscoveryWorkflowActivity(kind: .approvalRequested,
                                                                      title: toolName == "approximate_location"
                                                                        ? "需要你允许使用大致位置"
                                                                        : "需要工具权限确认",
                                                                      detail: summary,
                                                                      stepID: "tool-\(toolName)",
                                                                      toolName: toolName))
                    let obs = failureObservation(request,
                                                 status: .denied,
                                                 summary: "需要权限确认",
                                                 content: .object(["error": .string("permission_required")]))
                    observations.append(obs)
                    statuses.append(.denied)
                    return .failure(.permissionDenied(capabilityID))
                case .denied(let reason):
                    let obs = failureObservation(request,
                                                 status: .denied,
                                                 summary: "权限未允许",
                                                 content: .object(["error": .string(reason)]))
                    observations.append(obs)
                    statuses.append(.denied)
                    return .failure(.permissionDenied(capabilityID))
                case .granted(let granted):
                    token = granted
                }
                if let systemPermission = entry.manifest.permissionRequirement.systemPermission,
                   systemAuthorization.requiresSystemAuthorization(capabilityID) {
                    let status = await systemAuthorization.status(for: capabilityID)
                    guard status == .granted else {
                        let obs = failureObservation(request,
                                                     status: .denied,
                                                     summary: "需要系统授权",
                                                     content: .object([
                                                        "error": .string("system permission missing"),
                                                        "systemPermission": .string(systemPermission.rawValue),
                                                        "status": .string(status.rawValue),
                                                     ]))
                        observations.append(obs)
                        statuses.append(.denied)
                        return .failure(.systemPermissionMissing(capabilityID))
                    }
                }
            }

            await emit(LocalDiscoveryWorkflowActivity(kind: .stepStarted,
                                                      title: summary,
                                                      stepID: "tool-\(toolName)",
                                                      toolName: toolName))
            let context = ToolExecutionContext(taskID: taskID,
                                               runID: runID,
                                               turnID: runID,
                                               callID: callID,
                                               toolID: toolID,
                                               locale: locale,
                                               timeZone: timeZone,
                                               clock: clock,
                                               capabilityToken: token,
                                               permissionAlreadyEvaluated: true,
                                               deadline: deadline)
            let result = await toolPlatformExecutor.executeTool(request: request, context: context)
            toolCallCount += 1
            usedTools.append(toolName)
            switch result {
            case .success(let output):
                let obs = observationSanitizer.observation(for: request,
                                                           result: output,
                                                           maxCharacters: 2_048)
                observations.append(obs)
                statuses.append(obs.status)
                evidence.append(AgentEvidenceRecord.from(observation: obs,
                                                         taskID: taskID,
                                                         capturedAt: clock.now()))
                await emit(LocalDiscoveryWorkflowActivity(kind: obs.status == .success ? .stepSucceeded : .stepProgress,
                                                          title: obs.status == .success ? "工具执行完成" : "工具未完成",
                                                          detail: output.userSafeSummary,
                                                          stepID: "tool-\(toolName)",
                                                          toolName: toolName,
                                                          failureCategory: nil))
                return .success(output)
            case .failure(let error):
                let status: AgentLoopObservationStatus
                switch error {
                case .permissionDenied, .systemPermissionMissing:
                    status = .denied
                case .timedOut:
                    status = .timeout
                default:
                    status = .failed
                }
                let obs = failureObservation(request,
                                             status: status,
                                             summary: Self.safeErrorSummary(error),
                                             content: .object(["error": .string(Self.safeErrorSummary(error))]))
                observations.append(obs)
                statuses.append(status)
                evidence.append(AgentEvidenceRecord.from(observation: obs,
                                                         taskID: taskID,
                                                         capturedAt: clock.now()))
                await emit(LocalDiscoveryWorkflowActivity(kind: error == .cancelled ? .taskCancelled : .stepProgress,
                                                          title: error == .cancelled ? "工具已取消" : "工具执行失败",
                                                          detail: Self.safeErrorSummary(error),
                                                          stepID: "tool-\(toolName)",
                                                          toolName: toolName,
                                                          failureCategory: error == .cancelled ? .cancelled : nil))
                return .failure(error)
            }
        }

        await emit(LocalDiscoveryWorkflowActivity(kind: .planningStarted,
                                                  title: "正在理解你的地点需求",
                                                  stepID: "classifyIntent"))
        guard await !isCancelled() else { return cancelledOutcome() }

        if workflowSnapshot.currentStage >= .queryApproved,
           workflowSnapshot.approvedQuery != nil {
            planned = workflowSnapshot.plannedQuery
            await emit(LocalDiscoveryWorkflowActivity(kind: .stepProgress,
                                                      title: "已恢复地点筛选条件",
                                                      detail: Self.querySummary(planned),
                                                      stepID: "buildQuery"))
        } else if let structuredPlanner {
            do {
                let plannerRequest = LocalDiscoveryStructuredPlannerRequest(
                    userText: userText,
                    decision: decision,
                    conversationContext: conversationContext,
                    now: now,
                    locale: locale,
                    timeZone: timeZone,
                    availableCapabilityIDs: catalog.entries.map { $0.manifest.id.rawValue },
                    permissionStateSummary: ["location.approximate.read": decision.requiresLocationPermission ? "mayRequest" : "notRequired"],
                    policy: searchPolicy)
                planned = try await Self.withPlannerDeadline(seconds: Self.plannerTimeoutSeconds(searchPolicy)) {
                    try await structuredPlanner.planLocalDiscovery(request: plannerRequest,
                                                                   fallbackPlanner: planner)
                }
            } catch is CancellationError {
                await recordCancelledCheckpoint()
                return cancelledOutcome()
            } catch LocalDiscoveryStructuredPlannerError.cancelled {
                await recordCancelledCheckpoint()
                return cancelledOutcome()
            } catch {
                planned = planner.plan(userText: userText,
                                       decision: decision,
                                       conversationContext: conversationContext,
                                       now: now,
                                       locale: locale,
                                       timeZone: timeZone)
                planned.assumptions.append("模型结构化 planner 不可用，使用 deterministic fallback。")
            }
        } else {
            planned = planner.plan(userText: userText,
                                   decision: decision,
                                   conversationContext: conversationContext,
                                   now: now,
                                   locale: locale,
                                   timeZone: timeZone)
        }
        await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                  title: "已识别筛选条件",
                                                  detail: Self.querySummary(planned),
                                                  stepID: "buildQuery"))
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        guard planned.status == .ready, let query = planned.query else {
            let document = Self.requiresInputDocument(taskID: taskID,
                                                     runID: runID,
                                                     planned: planned,
                                                     generatedAt: clock.now())
            await emit(LocalDiscoveryWorkflowActivity(kind: .userInteractionRequested,
                                                      title: "需要你补充地点信息",
                                                      detail: planned.missingInformation.first ?? "可以告诉我城市、邮编或附近地标吗？",
                                                      stepID: "resolveLocation"))
            return finish(finalText: planned.missingInformation.first ?? "可以告诉我城市、邮编或附近地标吗？",
                          stopReason: .permissionDenied,
                          terminalState: .awaitingUserInput,
                          document: document,
                          localResult: nil,
                          verifierReport: LocalDiscoveryVerifierReport(verdict: .repairRequired,
                                                                       issues: [.init(path: "$.query", message: "requires user input")]))
        }
        await recordCheckpoint("query approved",
                               stage: .queryApproved) { snapshot in
            snapshot.approvedQuery = planned.query
            snapshot.plannedAssumptions = planned.assumptions
            snapshot.plannedMissingInformation = planned.missingInformation
            snapshot.plannedUnsupportedRequirements = planned.unsupportedRequirements
            snapshot.plannedRepairAttempts = planned.repairAttempts
            snapshot.plannedUsedDeterministicFallback = planned.usedDeterministicFallback
        }

        await emit(LocalDiscoveryWorkflowActivity(kind: .stepStarted,
                                                  title: "正在确定搜索位置",
                                                  stepID: "resolveLocation"))
        let resolvedLocation: ResolvedLocalDiscoveryLocation
        if workflowSnapshot.currentStage >= .locationResolved,
           let restored = workflowSnapshot.resolvedLocation {
            resolvedLocation = ResolvedLocalDiscoveryLocation(snapshot: restored)
            await emit(LocalDiscoveryWorkflowActivity(kind: .stepProgress,
                                                      title: "已恢复搜索位置",
                                                      detail: resolvedLocation.label,
                                                      stepID: "resolveLocation"))
        } else {
            switch query.locationInput.kind {
            case .explicitRegion, .address, .postalCode:
                resolvedLocation = Self.resolvedExplicitLocation(query.locationInput.label)
            await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                      title: "已使用你提供的位置",
                                                      detail: resolvedLocation.label,
                                                      stepID: "resolveLocation"))
            case .approximateCurrentLocation:
                let arguments: AgentJSONValue = .object([
                    "desiredAccuracyLevel": .string("city"),
                    "purpose": .string("local discovery search origin"),
                    "taskScope": .string(taskID.uuidString),
                ])
                let location = await executeTool(toolName: "approximate_location",
                                                 callID: "localDiscovery-location-\(runID.uuidString)",
                                                 arguments: arguments,
                                                 summary: "正在获取大致位置")
                switch location {
                case .success(let output) where output.status == .success:
                    completedToolIdentities.insert(toolIdentity(stage: .locationResolved,
                                                                toolName: "approximate_location",
                                                                arguments: arguments,
                                                                targetID: "approximate_location",
                                                                result: output))
                    resolvedLocation = ResolvedLocalDiscoveryLocation(label: output.structuredData.stringValue("regionDescription") ?? "approximate current location",
                                                                      coordinate: output.structuredData.coordinateValue("coordinate"),
                                                                      source: "approximate_location")
                    await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                              title: "已确定搜索位置",
                                                              detail: resolvedLocation.label,
                                                              stepID: "resolveLocation"))
                case .success, .failure(.permissionDenied):
                    await emit(LocalDiscoveryWorkflowActivity(kind: .userInteractionRequested,
                                                              title: "位置权限未允许",
                                                              detail: "可以告诉我城市、邮编或附近地标吗？",
                                                              stepID: "resolveLocation",
                                                              failureCategory: .permissionDenied))
                    let document = Self.requiresInputDocument(taskID: taskID,
                                                             runID: runID,
                                                             planned: planned,
                                                             generatedAt: clock.now())
                    return finish(finalText: "我不能在未授权时推断你的位置。可以告诉我城市、邮编或附近地标吗？",
                                  stopReason: .permissionDenied,
                                  terminalState: .awaitingUserInput,
                                  document: document,
                                  localResult: nil,
                                  verifierReport: LocalDiscoveryVerifierReport(verdict: .repairRequired,
                                                                               issues: [.init(path: "$.location", message: "approximate location denied")]))
                case .failure(.cancelled):
                    await recordCancelledCheckpoint()
                    return cancelledOutcome()
                case .failure(let error):
                    let document = Self.requiresInputDocument(taskID: taskID,
                                                             runID: runID,
                                                             planned: planned,
                                                             generatedAt: clock.now())
                    return finish(finalText: "我暂时不能确定搜索位置。可以告诉我城市、邮编或附近地标吗？",
                                  stopReason: .toolFailure,
                                  terminalState: .awaitingUserInput,
                                  document: document,
                                  localResult: nil,
                                  verifierReport: LocalDiscoveryVerifierReport(verdict: .repairRequired,
                                                                               issues: [.init(path: "$.location", message: Self.safeErrorSummary(error))]))
                }
            default:
                let document = Self.requiresInputDocument(taskID: taskID,
                                                         runID: runID,
                                                         planned: planned,
                                                         generatedAt: clock.now())
                return finish(finalText: "可以告诉我城市、邮编或附近地标吗？",
                              stopReason: .permissionDenied,
                              terminalState: .awaitingUserInput,
                              document: document,
                              localResult: nil,
                              verifierReport: LocalDiscoveryVerifierReport(verdict: .repairRequired,
                                                                           issues: [.init(path: "$.location", message: "missing location")]))
            }
        }
        await recordCheckpoint("location resolved",
                               stage: .locationResolved) { snapshot in
            snapshot.resolvedLocation = resolvedLocation.snapshot
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        await emit(LocalDiscoveryWorkflowActivity(kind: .stepStarted,
                                                  title: "正在搜索附近地点",
                                                  stepID: "searchCandidates",
                                                  toolName: "local_place_search"))
        var searchCandidates: [PlaceCandidate] = workflowSnapshot.rawCandidates
        var backend = workflowSnapshot.backend
        var expansionRounds = 0
        while searchCandidates.isEmpty
            && workflowSnapshot.currentStage < .initialSearchCompleted
            && expansionRounds <= searchPolicy.maximumExpansionRounds {
            let searchText = expansionRounds == 0 ? query.searchText : Self.broadenedSearchText(query.searchText,
                                                                                                  category: query.category)
            if expansionRounds > 0 {
                await emit(LocalDiscoveryWorkflowActivity(kind: .replanStarted,
                                                          title: "正在放宽搜索词再试一次",
                                                          detail: searchText,
                                                          stepID: "searchCandidates"))
            }
            let arguments = Self.searchArguments(query: query,
                                                 searchText: searchText,
                                                 resolvedLocation: resolvedLocation,
                                                 policy: searchPolicy,
                                                 locale: locale)
            let output = await executeTool(toolName: "local_place_search",
                                           callID: "localDiscovery-search-\(expansionRounds)-\(runID.uuidString)",
                                           arguments: arguments,
                                           summary: "正在搜索地点")
            switch output {
            case .success(let result):
                completedToolIdentities.insert(toolIdentity(stage: .initialSearchCompleted,
                                                            toolName: "local_place_search",
                                                            arguments: arguments,
                                                            targetID: "search-\(expansionRounds)",
                                                            result: result))
                backend = result.structuredData.stringValue("backend") ?? backend
                searchCandidates = result.structuredData.arrayValue("candidates")?.compactMap {
                    try? LocalDiscoveryJSON.decoded(PlaceCandidate.self, from: $0)
                } ?? []
            case .failure(.cancelled):
                await recordCancelledCheckpoint()
                return cancelledOutcome()
            case .failure(let error):
                warnings.append("地点搜索失败：\(Self.safeErrorSummary(error))")
                break
            }
            expansionRounds += 1
        }
        await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                  title: "已找到 \(searchCandidates.count) 个初始候选",
                                                  stepID: "searchCandidates",
                                                  toolName: "local_place_search"))
        await recordCheckpoint("initial search completed",
                               stage: .initialSearchCompleted) { snapshot in
            snapshot.rawCandidates = searchCandidates
            snapshot.backend = backend
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        await emit(LocalDiscoveryWorkflowActivity(kind: .stepStarted,
                                                  title: "正在合并重复地点",
                                                  stepID: "deduplicateCandidates"))
        let candidatesFromSnapshot = workflowSnapshot.currentStage >= .dedupCompleted
            && !workflowSnapshot.mergedCandidates.isEmpty
        let dedupReport = candidatesFromSnapshot
            ? PlaceDeduplicationResult(candidates: workflowSnapshot.mergedCandidates, conflicts: [])
            : PlaceCandidateDeduplicator().deduplicate(searchCandidates)
        var candidates = dedupReport.candidates
        let conflictCount = dedupReport.conflicts.count
        await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                  title: "已合并为 \(candidates.count) 个不同地点",
                                                  detail: "来源冲突 \(conflictCount) 个",
                                                  stepID: "deduplicateCandidates"))
        await recordCheckpoint("dedup completed",
                               stage: .dedupCompleted) { snapshot in
            snapshot.mergedCandidates = candidates
            snapshot.pendingRouteCandidateIDs = candidates.prefix(searchPolicy.maximumRouteCandidates).map(\.stableID)
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        await emit(LocalDiscoveryWorkflowActivity(kind: .stepStarted,
                                                  title: "正在估算距离和路线",
                                                  stepID: "estimateDistances",
                                                  toolName: "route_distance_estimate"))
        if let origin = resolvedLocation.coordinate {
            let routeLimit = min(candidates.count, searchPolicy.maximumRouteCandidates)
            for index in candidates.indices.prefix(routeLimit) {
                guard await !isCancelled() else {
                    await recordCancelledCheckpoint()
                    return cancelledOutcome()
                }
                let candidateID = candidates[index].stableID
                if completedRouteCandidateIDs.contains(candidateID) {
                    continue
                }
                guard let destination = candidates[index].coordinate else { continue }
                let arguments: AgentJSONValue = .object([
                    "origin": .coordinate(origin),
                    "destination": .coordinate(destination),
                    "transportMode": .string((query.travelLimit?.transportMode ?? .automobile).rawValue),
                ])
                let output = await executeTool(toolName: "route_distance_estimate",
                                               callID: "localDiscovery-route-\(index)-\(runID.uuidString)",
                                               arguments: arguments,
                                               summary: "正在估算距离")
                switch output {
                case .success(let result):
                    completedToolIdentities.insert(toolIdentity(stage: .routeItemCompleted,
                                                                toolName: "route_distance_estimate",
                                                                arguments: arguments,
                                                                targetID: candidateID,
                                                                result: result))
                    candidates[index] = Self.candidate(candidates[index],
                                                       applyingRouteOutput: result.structuredData,
                                                       transportMode: query.travelLimit?.transportMode ?? .automobile)
                    completedRouteCandidateIDs.insert(candidateID)
                    await recordCheckpoint("route item completed",
                                           stage: .routeItemCompleted) { snapshot in
                        snapshot.mergedCandidates = candidates
                        snapshot.completedRouteCandidateIDs = Array(completedRouteCandidateIDs).sorted()
                        snapshot.pendingRouteCandidateIDs = candidates
                            .prefix(searchPolicy.maximumRouteCandidates)
                            .map(\.stableID)
                            .filter { !completedRouteCandidateIDs.contains($0) }
                    }
                case .failure(.cancelled):
                    await recordCancelledCheckpoint()
                    return cancelledOutcome()
                case .failure(let error):
                    warnings.append("\(candidates[index].name) 路线估算失败：\(Self.safeErrorSummary(error))")
                    continue
                }
            }
        } else {
            warnings.append("没有可审计的起点坐标，路线时间保持 unknown。")
        }
        await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                  title: "距离和路线估算已完成",
                                                  stepID: "estimateDistances",
                                                  toolName: "route_distance_estimate"))
        await recordCheckpoint("route batch completed",
                               stage: .routeBatchCompleted) { snapshot in
            snapshot.mergedCandidates = candidates
            snapshot.completedRouteCandidateIDs = Array(completedRouteCandidateIDs).sorted()
            snapshot.pendingRouteCandidateIDs = []
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        let enrichmentTargets = Self.enrichmentTargets(from: candidates,
                                                       query: query,
                                                       limit: searchPolicy.enrichmentCandidateCount)
        await emit(LocalDiscoveryWorkflowActivity(kind: .stepStarted,
                                                  title: "正在补充营业时间和其他信息",
                                                  detail: "选择 \(enrichmentTargets.count) 个候选补充网页证据",
                                                  stepID: "enrichCandidates"))
        for (ordinal, index) in enrichmentTargets.enumerated() {
            guard await !isCancelled() else {
                await recordCancelledCheckpoint()
                return cancelledOutcome()
            }
            await emit(LocalDiscoveryWorkflowActivity(kind: .stepProgress,
                                                      title: "正在核对第 \(ordinal + 1)/\(enrichmentTargets.count) 个候选",
                                                      detail: candidates[index].name,
                                                      stepID: "enrichCandidates"))
            let candidateID = candidates[index].stableID
            if completedEnrichmentCandidateIDs.contains(candidateID) {
                continue
            }
            guard let url = Self.enrichmentURL(for: candidates[index]) else { continue }
            let alreadyReadURL = completedToolIdentities.contains {
                $0.toolID == "webpage_read" && $0.targetID == AgentEventRedactor.safeIdentifier(url)
            }
            if alreadyReadURL {
                warnings.append("\(candidates[index].name) 的网页已在恢复前读取；为避免重复网络请求，本轮不重新读取，结构化补充保持 unknown。")
                completedEnrichmentCandidateIDs.insert(candidateID)
                continue
            }
            let webArguments: AgentJSONValue = .object([
                "url": .string(url),
                "extractionPurpose": .string("local discovery candidate enrichment"),
                "allowedContentTypes": .array([.string("text/html")]),
                "sizeLimitBytes": .number(65_536),
            ])
            let web = await executeTool(toolName: "webpage_read",
                                        callID: "localDiscovery-web-\(ordinal)-\(runID.uuidString)",
                                        arguments: webArguments,
                                        summary: "正在读取网页")
            switch web {
            case .success(let page):
                completedToolIdentities.insert(toolIdentity(stage: .enrichmentItemCompleted,
                                                            toolName: "webpage_read",
                                                            arguments: webArguments,
                                                            targetID: url,
                                                            result: page))
                let extraction = await executeTool(toolName: "structured_place_extraction",
                                                   callID: "localDiscovery-extract-\(ordinal)-\(runID.uuidString)",
                                                   arguments: Self.extractionArguments(from: page.structuredData),
                                                   summary: "正在提取网页中的地点信息")
                switch extraction {
                case .success(let fields):
                    completedToolIdentities.insert(toolIdentity(stage: .enrichmentItemCompleted,
                                                                toolName: "structured_place_extraction",
                                                                arguments: Self.extractionArguments(from: page.structuredData),
                                                                targetID: candidateID,
                                                                result: fields))
                    candidates[index] = Self.candidate(candidates[index],
                                                       applyingWebOutput: page.structuredData,
                                                       extractionOutput: fields.structuredData,
                                                       now: clock.now())
                    completedEnrichmentCandidateIDs.insert(candidateID)
                    await recordCheckpoint("enrichment item completed",
                                           stage: .enrichmentItemCompleted) { snapshot in
                        snapshot.mergedCandidates = candidates
                        snapshot.completedEnrichmentCandidateIDs = Array(completedEnrichmentCandidateIDs).sorted()
                        snapshot.pendingEnrichmentCandidateIDs = enrichmentTargets.map { candidates[$0].stableID }
                            .filter { !completedEnrichmentCandidateIDs.contains($0) }
                        snapshot.webpageEvidenceIDs = Array(Set(snapshot.webpageEvidenceIDs + page.structuredData.evidenceReferences().map(\.evidenceID))).sorted()
                        snapshot.extractionEvidenceIDs = Array(Set(snapshot.extractionEvidenceIDs + fields.structuredData.evidenceReferences().map(\.evidenceID))).sorted()
                    }
                case .failure(.cancelled):
                    await recordCancelledCheckpoint()
                    return cancelledOutcome()
                case .failure(let error):
                    warnings.append("\(candidates[index].name) 结构化提取失败：\(Self.safeErrorSummary(error))")
                }
            case .failure(.cancelled):
                await recordCancelledCheckpoint()
                return cancelledOutcome()
            case .failure(let error):
                warnings.append("\(candidates[index].name) 网页补充失败：\(Self.safeErrorSummary(error))")
                continue
            }
        }
        await emit(LocalDiscoveryWorkflowActivity(kind: .stepSucceeded,
                                                  title: "网页补充已完成",
                                                  detail: warnings.isEmpty ? nil : "部分信息无法确认",
                                                  stepID: "enrichCandidates"))
        await recordCheckpoint("enrichment batch completed",
                               stage: .enrichmentBatchCompleted) { snapshot in
            snapshot.mergedCandidates = candidates
            snapshot.completedEnrichmentCandidateIDs = Array(completedEnrichmentCandidateIDs).sorted()
            snapshot.pendingEnrichmentCandidateIDs = []
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        await emit(LocalDiscoveryWorkflowActivity(kind: .verificationStarted,
                                                  title: "正在验证最终结果",
                                                  stepID: "validateCandidates"))
        let validator = LocalDiscoveryValidator(now: clock.now())
        let validation = workflowSnapshot.currentStage >= .validationCompleted
            && !workflowSnapshot.validatorFindings.isEmpty
            ? LocalDiscoveryValidationReport(findings: workflowSnapshot.validatorFindings)
            : validator.validate(query: query, candidates: candidates)
        var included: [PlaceCandidate] = []
        var excluded: [PlaceCandidate] = []
        for var candidate in candidates {
            let candidateFindings = validation.findings.filter { $0.candidateID == candidate.stableID }
            candidate.findings = candidateFindings
            candidate.verificationStatus = Self.fieldStatus(from: candidateFindings)
            candidate.recommendationRationale = Self.recommendationRationale(candidate,
                                                                             findings: candidateFindings,
                                                                             unsupportedRequirements: planned.unsupportedRequirements)
            let disposition = validation.disposition(for: candidate.stableID)
            switch disposition {
            case .excludeHardConstraintFailure, .excludeConflict:
                excluded.append(candidate)
            case .requiresMoreEvidence:
                included.append(candidate)
            case .includeVerified, .includeWithWarning:
                included.append(candidate)
            }
        }
        included = Self.rank(included, query: query)
        await emit(LocalDiscoveryWorkflowActivity(kind: .verificationSucceeded,
                                                  title: "已排除 \(excluded.count) 个不满足硬条件的地点",
                                                  detail: validation.findings.contains(where: { $0.status == .uncertain }) ? "部分信息无法确认" : nil,
                                                  stepID: "validateCandidates"))
        await recordCheckpoint("validation completed",
                               stage: .validationCompleted) { snapshot in
            snapshot.mergedCandidates = candidates
            snapshot.validatorFindings = validation.findings
            snapshot.rankedCandidateIDs = included.map(\.stableID)
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        let status: LocalDiscoveryResultStatus
        let terminalState: AgentTaskState
        if included.isEmpty && searchCandidates.isEmpty {
            status = .noMatchingResults
            terminalState = .partiallySucceeded
        } else if validation.findings.contains(where: { $0.status == .uncertain || $0.severity == .warning })
            || !warnings.isEmpty
            || !planned.unsupportedRequirements.isEmpty {
            status = .partialResultsAvailable
            terminalState = .partiallySucceeded
        } else {
            status = .verifiedResultsAvailable
            terminalState = .succeeded
        }

        let result = LocalDiscoveryResult(resultID: "local-discovery-result-\(runID.uuidString)",
                                          query: query,
                                          status: status,
                                          candidates: included,
                                          excludedCandidates: excluded,
                                          evidence: evidence,
                                          findings: validation.findings,
                                          usedCapabilities: usedTools,
                                          backend: backend,
                                          generatedAt: clock.now(),
                                          freshness: "current-task")
        let verifier = workflowSnapshot.currentStage >= .verifierCompleted
            ? (workflowSnapshot.verifierDisposition ?? LocalDiscoveryWorkflowVerifier.verify(originalRequest: userText,
                                                                                            plannedQuery: planned,
                                                                                            result: result))
            : LocalDiscoveryWorkflowVerifier.verify(originalRequest: userText,
                                                    plannedQuery: planned,
                                                    result: result)
        await emit(LocalDiscoveryWorkflowActivity(kind: verifier.verdict == .pass || verifier.verdict == .partialPass
                                                  ? .verificationSucceeded : .verificationFailed,
                                                  title: verifier.verdict == .pass ? "验证完成" : "验证保留限制",
                                                  detail: verifier.issues.first?.message,
                                                  stepID: "genericVerifier",
                                                  failureCategory: verifier.verdict == .repairRequired || verifier.verdict == .fail ? .validationFailed : nil))
        await recordCheckpoint("verifier completed",
                               stage: .verifierCompleted) { snapshot in
            snapshot.verifierDisposition = verifier
            snapshot.rankedCandidateIDs = included.map(\.stableID)
        }
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }

        let document = Self.resultDocument(taskID: taskID,
                                           runID: runID,
                                           result: result,
                                           planned: planned,
                                           resolvedLocation: resolvedLocation,
                                           warnings: warnings + Self.verifierWarnings(verifier),
                                           checkpoints: checkpointLabels,
                                           generatedAt: clock.now())
        await emit(LocalDiscoveryWorkflowActivity(kind: .synthesisStarted,
                                                  title: "正在整理候选结果",
                                                  stepID: "synthesizeResult"))
        guard await !isCancelled() else {
            await recordCancelledCheckpoint()
            return cancelledOutcome()
        }
        let finalText = Self.finalText(for: result,
                                       planned: planned,
                                       warnings: warnings,
                                       verifier: verifier)
        let stopReason: AgentLoopStopReason = verifier.verdict == .fail || verifier.verdict == .repairRequired ? .toolFailure : .completed
        let finalTerminal: AgentTaskState = stopReason == .completed ? terminalState : .partiallySucceeded
        await recordCheckpoint("result synthesized",
                               stage: .resultSynthesized) { snapshot in
            snapshot.verifierDisposition = verifier
            snapshot.rankedCandidateIDs = included.map(\.stableID)
            snapshot.synthesizedResultRevision = document.revision
        }
        try? await checkpointStore?.saveLocalDiscoverySnapshot(workflowSnapshot,
                                                              resultDocument: document,
                                                              state: Self.runState(from: finalTerminal),
                                                              phase: .terminal,
                                                              conversationID: conversationID,
                                                              lastSequence: workflowSnapshot.lastAppliedEventSequence)
        return finish(finalText: finalText,
                      stopReason: stopReason,
                      terminalState: finalTerminal,
                      document: document,
                      localResult: result,
                      verifierReport: verifier)
    }

    private struct ResolvedLocalDiscoveryLocation: Sendable, Equatable {
        var label: String
        var coordinate: PlaceCoordinate?
        var source: String

        init(label: String, coordinate: PlaceCoordinate?, source: String) {
            self.label = label
            self.coordinate = coordinate
            self.source = source
        }

        init(snapshot: LocalDiscoveryResolvedLocationSnapshot) {
            self.label = snapshot.label
            self.coordinate = snapshot.coordinate
            self.source = snapshot.source
        }

        var snapshot: LocalDiscoveryResolvedLocationSnapshot {
            LocalDiscoveryResolvedLocationSnapshot(label: label,
                                                   coordinate: coordinate,
                                                   source: source)
        }
    }

    private static func resolvedExplicitLocation(_ label: String?) -> ResolvedLocalDiscoveryLocation {
        let safeLabel = label ?? "explicit region"
        let lower = safeLabel.lowercased()
        let coordinate: PlaceCoordinate?
        if lower.contains("san francisco") {
            coordinate = PlaceCoordinate(latitude: 37.7749, longitude: -122.4194, horizontalAccuracyMeters: 8_000)
        } else if lower.contains("san jose") {
            coordinate = PlaceCoordinate(latitude: 37.3382, longitude: -121.8863, horizontalAccuracyMeters: 8_000)
        } else if lower.contains("ucla") {
            coordinate = PlaceCoordinate(latitude: 34.0689, longitude: -118.4452, horizontalAccuracyMeters: 1_500)
        } else if lower.contains("los angeles") {
            coordinate = PlaceCoordinate(latitude: 34.0522, longitude: -118.2437, horizontalAccuracyMeters: 10_000)
        } else {
            coordinate = nil
        }
        return ResolvedLocalDiscoveryLocation(label: safeLabel,
                                              coordinate: coordinate,
                                              source: coordinate == nil ? "explicit_region" : "known_region_centroid")
    }

    private static func searchArguments(query: PlaceQuery,
                                        searchText: String,
                                        resolvedLocation: ResolvedLocalDiscoveryLocation,
                                        policy: LocalDiscoverySearchPolicy,
                                        locale: Locale) -> AgentJSONValue {
        var object: [String: AgentJSONValue] = [
            "queryText": .string(searchText),
            "category": .string(query.category.rawValue),
            "radiusMeters": .number(policy.defaultRadiusMeters),
            "resultLimit": .number(Double(query.resultLimit)),
            "locale": .string(locale.identifier),
        ]
        if query.locationInput.kind == .approximateCurrentLocation,
           let coordinate = resolvedLocation.coordinate {
            object["center"] = .coordinate(coordinate)
        } else if query.locationInput.kind != .approximateCurrentLocation {
            object["regionText"] = .string(query.locationInput.label ?? resolvedLocation.label)
        }
        return .object(object)
    }

    private static func broadenedSearchText(_ searchText: String, category: PlaceCategory) -> String {
        switch category.rawValue {
        case "sichuan_restaurant":
            return "Chinese restaurant"
        case "golf_driving_range":
            return "golf practice range"
        case "electronics_store":
            return "electronics store"
        default:
            return searchText
        }
    }

    private static func candidate(_ candidate: PlaceCandidate,
                                  applyingRouteOutput output: AgentJSONValue,
                                  transportMode: PlaceTransportMode) -> PlaceCandidate {
        var copy = candidate
        let calculatedAt = output.dateValue("calculatedAt") ?? Date()
        let straight = output.doubleValue("straightLineDistanceMeters").map {
            PlaceDistance(meters: $0,
                          kind: .straightLine,
                          source: output.stringValue("calculationSource") ?? "route_distance_estimate",
                          calculatedAt: calculatedAt,
                          uncertaintyReason: output.stringValue("uncertaintyReason"))
        }
        let route = output.doubleValue("routeDistanceMeters").map {
            PlaceDistance(meters: $0,
                          kind: .route,
                          source: output.stringValue("calculationSource") ?? "route_distance_estimate",
                          calculatedAt: calculatedAt)
        }
        copy.travelEstimate = PlaceTravelEstimate(transportMode: transportMode,
                                                  straightLineDistance: straight,
                                                  routeDistance: route,
                                                  estimatedTravelDurationSeconds: output.doubleValue("estimatedTravelDurationSeconds"),
                                                  calculationSource: output.stringValue("calculationSource") ?? "route_distance_estimate",
                                                  calculatedAt: calculatedAt,
                                                  uncertaintyReason: output.stringValue("uncertaintyReason"))
        copy.distance = route ?? straight
        copy.evidenceReferences.append(contentsOf: output.evidenceReferences())
        return copy
    }

    private static func enrichmentTargets(from candidates: [PlaceCandidate],
                                          query: PlaceQuery,
                                          limit: Int) -> [Array<PlaceCandidate>.Index] {
        let indexed = candidates.indices.map { index -> (Int, Int, Double) in
            let candidate = candidates[index]
            var score = 0
            if candidate.categories.contains(where: { $0.rawValue == query.category.rawValue }) { score += 20 }
            if candidate.priceEstimate.value == .unknown { score += 4 }
            if candidate.openingStatus.value == .unknown { score += 4 }
            if candidate.parkingInfo.value == .unknown { score += 2 }
            if enrichmentURL(for: candidate) != nil { score += 10 }
            let distance = candidate.travelEstimate?.routeDistance?.meters
                ?? candidate.travelEstimate?.straightLineDistance?.meters
                ?? Double.greatestFiniteMagnitude
            return (index, score, distance)
        }
        return indexed
            .sorted {
                if $0.1 != $1.1 { return $0.1 > $1.1 }
                return $0.2 < $1.2
            }
            .prefix(limit)
            .map(\.0)
    }

    private static func enrichmentURL(for candidate: PlaceCandidate) -> String? {
        candidate.webLinks.first { link in
            switch link.kind {
            case .officialWebsite, .menu, .source:
                return true
            case .maps, .other:
                return false
            }
        }?.url
    }

    private static func extractionArguments(from page: AgentJSONValue) -> AgentJSONValue {
        .object([
            "evidenceID": .string(page.evidenceReferences().first?.evidenceID ?? "webpage-evidence"),
            "canonicalURL": .string(page.stringValue("canonicalURL") ?? ""),
            "pageTitle": .string(page.stringValue("pageTitle") ?? ""),
            "extractedText": .string(page.stringValue("extractedText") ?? ""),
            "structuredMetadata": .array(page.arrayValue("structuredMetadata") ?? []),
            "fields": .array([
                .string("openingHours"),
                .string("phone"),
                .string("website"),
                .string("price"),
                .string("parking"),
            ]),
            "fetchedAt": .string(page.stringValue("fetchedAt") ?? ISO8601DateFormatter().string(from: Date())),
        ])
    }

    private static func candidate(_ candidate: PlaceCandidate,
                                  applyingWebOutput page: AgentJSONValue,
                                  extractionOutput: AgentJSONValue,
                                  now: Date) -> PlaceCandidate {
        var copy = candidate
        copy.evidenceReferences.append(contentsOf: page.evidenceReferences())
        copy.evidenceReferences.append(contentsOf: extractionOutput.evidenceReferences())
        let fields = extractionOutput.objectValue("extractedFields") ?? [:]
        if let phone = fields["phone"]?.objectValue?["value"]?.stringScalar {
            copy.contact = PlaceContact(phoneNumber: phone, displayPhone: phone)
        }
        if let website = fields["website"]?.objectValue?["value"]?.stringScalar,
           !copy.webLinks.contains(where: { $0.url == website }) {
            copy.webLinks.append(PlaceWebLink(id: "\(copy.stableID)-website",
                                              kind: .officialWebsite,
                                              title: "Website",
                                              url: website,
                                              evidenceReferences: fields["website"]?.evidenceReferences() ?? []))
        }
        if let price = fields["priceHints"]?.objectValue?["value"]?.stringScalar {
            copy.priceEstimate = PlacePriceEstimate(value: priceLevel(from: price),
                                                    confidence: fields["priceHints"]?.objectValue?["confidence"]?.doubleScalar ?? 0.45,
                                                    source: fields["priceHints"]?.objectValue?["source"]?.stringScalar ?? "structured_place_extraction",
                                                    observedAt: now,
                                                    evidenceReferences: fields["priceHints"]?.evidenceReferences() ?? [])
        }
        if let parking = fields["parkingHints"]?.objectValue,
           parking["status"]?.stringScalar != "unknown" {
            copy.parkingInfo = PlaceParkingInfo(value: .available,
                                                confidence: parking["confidence"]?.doubleScalar ?? 0.45,
                                                source: parking["source"]?.stringScalar ?? "structured_place_extraction",
                                                observedAt: now,
                                                evidenceReferences: fields["parkingHints"]?.evidenceReferences() ?? [],
                                                uncertaintyReason: parking["uncertaintyReason"]?.stringScalar)
        }
        if let opening = fields["openingHours"]?.objectValue,
           opening["status"]?.stringScalar != "unknown" {
            let values = opening["value"]?.arrayValue?.compactMap(\.stringScalar) ?? []
            copy.openingHours = PlaceOpeningHours(timezone: TimeZone.current.identifier,
                                                  valueSummary: values.joined(separator: "; "),
                                                  confidence: opening["confidence"]?.doubleScalar ?? 0.6,
                                                  source: opening["source"]?.stringScalar ?? "structured_place_extraction",
                                                  observedAt: now,
                                                  uncertaintyReason: "opening intervals captured but target-time status was not deterministically proven")
            copy.openingStatus = PlaceOpeningStatus(value: .unknown,
                                                    checkedAt: now,
                                                    targetTime: nil,
                                                    confidence: 0.3,
                                                    source: "structured_place_extraction",
                                                    evidenceReferences: fields["openingHours"]?.evidenceReferences() ?? [],
                                                    uncertaintyReason: "opening hours found but target-time verification is unknown")
        }
        return copy
    }

    private static func priceLevel(from raw: String) -> PlacePriceValue {
        let count = raw.filter { $0 == "$" }.count
        if count > 0 { return .level(count) }
        if let amount = Double(raw.filter { $0.isNumber || $0 == "." }) {
            return .maximumPerPerson(amount: amount, currencyCode: "USD")
        }
        return .unknown
    }

    private static func fieldStatus(from findings: [PlaceVerificationFinding]) -> PlaceVerificationStatus {
        if findings.contains(where: { $0.recommendedDisposition == .excludeConflict }) { return .conflicting }
        if findings.contains(where: { $0.severity == .blocking && $0.status == .failed }) { return .unsupported }
        if findings.contains(where: { $0.status == .uncertain || $0.severity == .warning }) { return .partiallyVerified }
        return .verified
    }

    private static func recommendationRationale(_ candidate: PlaceCandidate,
                                                findings: [PlaceVerificationFinding],
                                                unsupportedRequirements: [String]) -> String {
        var parts: [String] = []
        if findings.contains(where: { $0.criterion == "category" && $0.status == .passed }) {
            parts.append("类别与请求匹配")
        }
        if let route = candidate.travelEstimate?.routeDistance {
            parts.append("路线距离约 \(formatDistance(route.meters))")
        } else if let straight = candidate.travelEstimate?.straightLineDistance {
            parts.append("只有直线距离约 \(formatDistance(straight.meters))，不是驾驶距离")
        }
        if candidate.openingStatus.value == .unknown {
            parts.append("营业状态未知")
        }
        if unsupportedRequirements.contains("live_inventory") {
            parts.append("可能有售，建议电话确认；未验证实时库存")
        }
        return parts.joined(separator: "；")
    }

    private static func rank(_ candidates: [PlaceCandidate], query: PlaceQuery) -> [PlaceCandidate] {
        candidates.sorted { lhs, rhs in
            let lhsScore = rankScore(lhs, query: query)
            let rhsScore = rankScore(rhs, query: query)
            if lhsScore != rhsScore { return lhsScore > rhsScore }
            let lhsDistance = lhs.travelEstimate?.routeDistance?.meters ?? lhs.travelEstimate?.straightLineDistance?.meters ?? Double.greatestFiniteMagnitude
            let rhsDistance = rhs.travelEstimate?.routeDistance?.meters ?? rhs.travelEstimate?.straightLineDistance?.meters ?? Double.greatestFiniteMagnitude
            if lhsDistance != rhsDistance { return lhsDistance < rhsDistance }
            return lhs.name < rhs.name
        }
    }

    private static func rankScore(_ candidate: PlaceCandidate, query: PlaceQuery) -> Int {
        var score = 0
        if candidate.categories.contains(where: { $0.rawValue == query.category.rawValue }) { score += 100 }
        switch candidate.verificationStatus {
        case .verified: score += 80
        case .partiallyVerified: score += 50
        case .unknown: score += 20
        case .conflicting, .unsupported, .stale: score -= 50
        }
        if candidate.openingStatus.value == .open { score += 20 }
        if candidate.travelEstimate?.routeDistance != nil { score += 10 }
        if !candidate.evidenceReferences.isEmpty { score += min(10, candidate.evidenceReferences.count) }
        return score
    }

    private static func resultDocument(taskID: UUID,
                                       runID: UUID,
                                       result: LocalDiscoveryResult,
                                       planned: LocalDiscoveryPlannedQuery,
                                       resolvedLocation: ResolvedLocalDiscoveryLocation,
                                       warnings: [String],
                                       checkpoints: [String],
                                       generatedAt: Date) -> AgentResultDocument {
        var sections: [AgentResultSection] = [
            AgentResultSection(id: "status",
                               component: .status(StatusComponent(label: statusLabel(result.status),
                                                                  status: result.status.agentResultStatus,
                                                                  detail: result.status.rawValue))),
            AgentResultSection(id: "query",
                               title: "Query",
                               component: .keyValue(KeyValueComponent(rows: [
                                KeyValueRow(id: "search", key: "Search", value: result.query.searchText),
                                KeyValueRow(id: "category", key: "Category", value: result.query.category.rawValue),
                                KeyValueRow(id: "location", key: "Location", value: resolvedLocation.label),
                                KeyValueRow(id: "assumptions", key: "Assumptions", value: planned.assumptions.joined(separator: "；")),
                               ]))),
        ]
        if result.candidates.isEmpty {
            sections.append(AgentResultSection(id: "empty",
                                               component: .emptyState(EmptyStateComponent(message: "没有足够证据推荐满足硬条件的地点。"))))
        } else {
            sections.append(AgentResultSection(id: "candidates",
                                               title: "Candidates",
                                               component: .cardGrid(CardGridComponent(cards: result.candidates.enumerated().map {
                                                candidateCard(rank: $0.offset + 1, candidate: $0.element)
                                               }))))
        }
        if !warnings.isEmpty {
            sections.append(AgentResultSection(id: "warnings",
                                               title: "Warnings",
                                               component: .list(ListComponent(items: Array(Set(warnings)).sorted()))))
        }
        if !checkpoints.isEmpty {
            sections.append(AgentResultSection(id: "checkpoints",
                                               title: "Recovery",
                                               component: .list(ListComponent(items: checkpoints))))
        }
        let points = result.candidates.compactMap { candidate -> MapPoint? in
            guard let coordinate = candidate.coordinate else { return nil }
            return MapPoint(id: candidate.stableID,
                            title: candidate.name,
                            coordinate: MapCoordinate(latitude: coordinate.latitude,
                                                      longitude: coordinate.longitude))
        }
        if !points.isEmpty {
            sections.append(AgentResultSection(id: "map",
                                               title: "Map",
                                               component: .map(MapComponent(title: "候选地点",
                                                                           center: resolvedLocation.coordinate.map {
                                                                            MapCoordinate(latitude: $0.latitude, longitude: $0.longitude)
                                                                           },
                                                                           points: points))))
        }
        let sources = Array(result.candidates.flatMap(\.webLinks).prefix(20)).map {
            AgentResultSource(id: $0.id, title: $0.title, url: $0.url)
        }
        if !sources.isEmpty {
            sections.append(AgentResultSection(id: "sources",
                                               title: "Sources",
                                               component: .sourceList(SourceListComponent(sourceIDs: sources.map(\.id)))))
        }
        return AgentResultDocument(id: "local-discovery-\(runID.uuidString)",
                                   taskID: taskID,
                                   runID: runID,
                                   title: "Local Discovery",
                                   summary: "\(result.candidates.count) 个候选，排除 \(result.excludedCandidates.count) 个，冲突 \(result.findings.filter { $0.recommendedDisposition == .excludeConflict }.count) 个",
                                   status: result.status.agentResultStatus,
                                   generatedAt: generatedAt,
                                   freshness: result.freshness,
                                   sections: sections,
                                   sources: sources,
                                   metadata: [
                                    "workflow": "localDiscovery",
                                    "localDiscoveryStatus": result.status.rawValue,
                                    "unsupportedRequirements": planned.unsupportedRequirements.joined(separator: ","),
                                   ])
    }

    private static func requiresInputDocument(taskID: UUID,
                                              runID: UUID,
                                              planned: LocalDiscoveryPlannedQuery,
                                              generatedAt: Date) -> AgentResultDocument {
        AgentResultDocument(id: "local-discovery-input-\(runID.uuidString)",
                            taskID: taskID,
                            runID: runID,
                            title: "Local Discovery",
                            summary: planned.missingInformation.first ?? "需要更多地点信息",
                            status: .partial,
                            generatedAt: generatedAt,
                            sections: [
                                AgentResultSection(id: "requires-input",
                                                   component: .form(FormComponent(fields: [
                                                    FormField(id: "location",
                                                              label: "城市、邮编或附近地标",
                                                              placeholder: "例如 San Francisco、95112 或 UCLA",
                                                              required: true),
                                                   ]))),
                            ],
                            metadata: ["workflow": "localDiscovery", "status": "requiresUserInput"])
    }

    private static func candidateCard(rank: Int, candidate: PlaceCandidate) -> ComparisonCard {
        var rows = [
            KeyValueRow(id: "\(candidate.stableID)-rank", key: "Rank", value: "\(rank)"),
            KeyValueRow(id: "\(candidate.stableID)-category", key: "Category", value: candidate.categories.map(\.rawValue).joined(separator: ", ")),
            KeyValueRow(id: "\(candidate.stableID)-address", key: "Address", value: candidate.address?.formatted ?? "unknown"),
            KeyValueRow(id: "\(candidate.stableID)-distance", key: "Distance", value: distanceSummary(candidate)),
            KeyValueRow(id: "\(candidate.stableID)-opening", key: "Opening", value: openingSummary(candidate)),
            KeyValueRow(id: "\(candidate.stableID)-price", key: "Price", value: priceSummary(candidate)),
            KeyValueRow(id: "\(candidate.stableID)-parking", key: "Parking", value: parkingSummary(candidate)),
            KeyValueRow(id: "\(candidate.stableID)-verification", key: "Verification", value: candidate.verificationStatus.rawValue),
        ]
        if let rationale = candidate.recommendationRationale {
            rows.append(KeyValueRow(id: "\(candidate.stableID)-reasons", key: "Reasons", value: rationale))
        }
        return ComparisonCard(id: candidate.stableID,
                              title: candidate.name,
                              subtitle: candidate.address?.formatted,
                              attributes: rows,
                              badge: candidate.verificationStatus.rawValue)
    }

    private static func finalText(for result: LocalDiscoveryResult,
                                  planned: LocalDiscoveryPlannedQuery,
                                  warnings: [String],
                                  verifier: LocalDiscoveryVerifierReport) -> String {
        if result.candidates.isEmpty {
            return "我没有找到足够证据支持的匹配地点。没有把未知或冲突字段改写成已验证结果。"
        }
        var text = "我通过 Local Discovery workflow 找到 \(result.candidates.count) 个候选，排除 \(result.excludedCandidates.count) 个不满足硬条件或冲突的地点。"
        if result.status == .partialResultsAvailable || verifier.verdict == .partialPass {
            text += " 部分字段仍是 unknown 或 partial，结果里已保留这些不确定性。"
        }
        if planned.unsupportedRequirements.contains("live_inventory") {
            text += " 对商品门店只能说明可能有售，不能证明实时库存，建议电话确认。"
        }
        if !warnings.isEmpty {
            text += " 另有 \(warnings.count) 条补充警告已写入结果。"
        }
        return text
    }

    private static func verifierWarnings(_ report: LocalDiscoveryVerifierReport) -> [String] {
        report.issues.map { "\($0.path): \($0.message)" }
    }

    private static func querySummary(_ planned: LocalDiscoveryPlannedQuery) -> String {
        guard let query = planned.query else { return planned.status.rawValue }
        return "\(query.searchText) / \(query.category.rawValue) / \(query.locationInput.kind.rawValue)"
    }

    private static func statusLabel(_ status: LocalDiscoveryResultStatus) -> String {
        switch status {
        case .verifiedResultsAvailable:
            return "有已验证候选"
        case .partialResultsAvailable, .partial:
            return "有部分候选"
        case .noMatchingResults:
            return "没有匹配结果"
        case .requiresUserInput:
            return "需要用户输入"
        case .cancelled:
            return "已取消"
        case .failed:
            return "失败"
        case .completed:
            return "完成"
        case .loading:
            return "加载中"
        }
    }

    private static func runState(from state: AgentTaskState) -> AgentRunState {
        switch state {
        case .succeeded:
            return .succeeded
        case .partiallySucceeded:
            return .partiallySucceeded
        case .failed:
            return .failed
        case .cancelled:
            return .cancelled
        case .awaitingUserInput:
            return .awaitingUserInput
        case .awaitingPermission:
            return .awaitingPermission
        case .recovering:
            return .recovering
        case .running:
            return .running
        default:
            return .unknown
        }
    }

    private static func distanceSummary(_ candidate: PlaceCandidate) -> String {
        if let route = candidate.travelEstimate?.routeDistance {
            var text = "route \(formatDistance(route.meters))"
            if let seconds = candidate.travelEstimate?.estimatedTravelDurationSeconds {
                text += " / \(Int(seconds / 60)) min"
            }
            return text
        }
        if let straight = candidate.travelEstimate?.straightLineDistance ?? candidate.distance {
            return "straight-line \(formatDistance(straight.meters))"
        }
        return "unknown"
    }

    private static func openingSummary(_ candidate: PlaceCandidate) -> String {
        switch candidate.openingStatus.value {
        case .open, .closed, .conflicting:
            return candidate.openingStatus.value.rawValue
        case .unknown:
            return candidate.openingHours?.valueSummary ?? "unknown"
        }
    }

    private static func priceSummary(_ candidate: PlaceCandidate) -> String {
        switch candidate.priceEstimate.value {
        case .level(let level):
            return String(repeating: "$", count: max(1, level))
        case .maximumPerPerson(let amount, let currency):
            return "\(currency) \(Int(amount)) max/person"
        case .rangePerPerson(let min, let max, let currency):
            return "\(currency) \(Int(min))-\(Int(max))/person"
        case .unknown:
            return "unknown"
        }
    }

    private static func parkingSummary(_ candidate: PlaceCandidate) -> String {
        candidate.parkingInfo.value.rawValue
    }

    private static func formatDistance(_ meters: Double) -> String {
        if meters >= 1_609.34 {
            return String(format: "%.1f mi", meters / 1_609.34)
        }
        return "\(Int(meters)) m"
    }

    private static func safeErrorSummary(_ error: ToolPlatformError) -> String {
        switch error {
        case .unknownTool(let tool): return "unknown tool \(tool)"
        case .toolDisabled(let tool): return "tool disabled \(tool)"
        case .toolUnavailable(let tool): return "tool unavailable \(tool)"
        case .invalidArguments: return "invalid arguments"
        case .schemaValidationFailed: return "schema validation failed"
        case .permissionDenied(let capability): return "permission denied \(capability)"
        case .systemPermissionMissing(let capability): return "system permission missing \(capability)"
        case .executionFailed(let reason): return reason
        case .timedOut: return "timed out"
        case .cancelled: return "cancelled"
        case .resultTooLarge: return "result too large"
        case .unsupportedProviderSchema(let reason): return reason
        case .internalInvariantViolation(let reason): return reason
        case .duplicateRegistration(let tool): return "duplicate tool \(tool)"
        }
    }

    private static func plannerTimeoutSeconds(_ policy: LocalDiscoverySearchPolicy) -> TimeInterval {
        min(10, max(2, policy.maximumExecutionDurationSeconds * 0.2))
    }

    private static func withPlannerDeadline<T: Sendable>(
        seconds: TimeInterval,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let operationTask = Task {
            try await operation()
        }
        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            throw RuntimeTimeoutError()
        }
        let gate = LocalDiscoveryPlannerDeadlineGate()
        defer {
            operationTask.cancel()
            timeoutTask.cancel()
        }

        return try await withCheckedThrowingContinuation { continuation in
            Task {
                do {
                    let value = try await operationTask.value
                    if gate.claim() {
                        continuation.resume(returning: value)
                    }
                } catch {
                    if gate.claim() {
                        continuation.resume(throwing: error)
                    }
                }
            }
            Task {
                do {
                    try await timeoutTask.value
                    if gate.claim() {
                        operationTask.cancel()
                        continuation.resume(throwing: RuntimeTimeoutError())
                    }
                } catch {
                    if gate.claim() {
                        operationTask.cancel()
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }
}

// P18.3 — U-17: First-claim-wins gate. `@unchecked Sendable` is justified by
// the NSLock around the single mutable `claimed: Bool` field. The compound
// invariant — "exactly one of (operation completion, timeout) resumes the
// enclosing continuation" — is enforced by:
//
//   1. `claim()` runs check-then-set under `lock.lock()` (atomic).
//   2. The loser observes `claimed == true` and silently returns false;
//      the loser never invokes `continuation.resume`.
//   3. The gate is local to `withPlannerDeadline<T>(...)` so the
//      continuation cannot be captured by a third party.
//
// DO NOT introduce a second mutable field into this gate without extending
// the lock to cover both, and DO NOT rely on actor isolation here — the
// gate is captured by two `Task { ... }` blocks that run on the global
// cooperative pool, not on a serial actor.
// P18.3 — the gate's mutable `claimed` flag now lives in an
// `OSAllocatedUnfairLock<Bool>`, so the class can declare unconditional
// `Sendable` conformance instead of `@unchecked Sendable`. The race-free
// "exactly one resume" invariant is preserved by the unfair lock.
private final class LocalDiscoveryPlannerDeadlineGate: Sendable {
    private let claimed = OSAllocatedUnfairLock<Bool>(initialState: false)

    func claim() -> Bool {
        claimed.withLockUnchecked { c in
            guard !c else { return false }
            c = true
            return true
        }
    }
}

private extension LocalDiscoveryResultStatus {
    var agentResultStatus: AgentResultStatus {
        switch self {
        case .loading:
            return .loading
        case .verifiedResultsAvailable, .completed:
            return .completed
        case .partialResultsAvailable, .partial, .requiresUserInput, .noMatchingResults, .cancelled:
            return .partial
        case .failed:
            return .failed
        }
    }
}

private extension AgentJSONValue {
    static func coordinate(_ coordinate: PlaceCoordinate) -> AgentJSONValue {
        var object: [String: AgentJSONValue] = [
            "latitude": .number(coordinate.latitude),
            "longitude": .number(coordinate.longitude),
        ]
        if let accuracy = coordinate.horizontalAccuracyMeters {
            object["horizontalAccuracyMeters"] = .number(accuracy)
        }
        return .object(object)
    }

    var stringScalar: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var doubleScalar: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var arrayValue: [AgentJSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }

    var objectValue: [String: AgentJSONValue]? {
        if case .object(let values) = self { return values }
        return nil
    }

    func objectValue(_ key: String) -> [String: AgentJSONValue]? {
        guard case .object(let object) = self,
              case .object(let child)? = object[key] else { return nil }
        return child
    }

    func arrayValue(_ key: String) -> [AgentJSONValue]? {
        guard case .object(let object) = self,
              case .array(let values)? = object[key] else { return nil }
        return values
    }

    func stringValue(_ key: String) -> String? {
        guard case .object(let object) = self,
              case .string(let value)? = object[key] else { return nil }
        return value
    }

    func doubleValue(_ key: String) -> Double? {
        guard case .object(let object) = self,
              case .number(let value)? = object[key] else { return nil }
        return value
    }

    func dateValue(_ key: String) -> Date? {
        guard let value = stringValue(key) else { return nil }
        return ISO8601DateFormatter().date(from: value)
    }

    func coordinateValue(_ key: String) -> PlaceCoordinate? {
        guard let object = objectValue(key),
              let latitude = object["latitude"]?.doubleScalar,
              let longitude = object["longitude"]?.doubleScalar else { return nil }
        return PlaceCoordinate(latitude: latitude,
                               longitude: longitude,
                               horizontalAccuracyMeters: object["horizontalAccuracyMeters"]?.doubleScalar)
    }

    func evidenceReferences() -> [PlaceEvidenceReference] {
        guard let values = arrayValue("evidenceReferences") else { return [] }
        return values.compactMap { try? LocalDiscoveryJSON.decoded(PlaceEvidenceReference.self, from: $0) }
    }
}
