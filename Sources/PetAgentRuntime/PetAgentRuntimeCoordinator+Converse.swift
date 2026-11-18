import Foundation
import AICore
import PetBrainCore

// MARK: - Conversation turn pipeline (streaming reply path)
//
// Moved verbatim from PetAgentRuntimeCoordinator.swift: `converse` was ~475
// lines inside the coordinator. It stays on the coordinator (same actor
// isolation, same ordering semantics) — this file only gives the turn
// pipeline its own home. Phase extraction happens here incrementally.
extension PetAgentRuntimeCoordinator {

    func _setActive(_ gen: ActiveGeneration?, for cid: UUID) {
        activeByConversation[cid] = gen
        if gen != nil { lastActiveByConversation[cid] = gen }
    }
    func converse(ume: UserMessageEvent, ctx: AgentContext, preset: String,
                          taskID: UUID, attemptID: UUID, source: DecisionSource,
                          emit: @Sendable (PetAgentRuntimeOutput) -> Void,
                          assistantID providedAssistantID: UUID? = nil,
                          loopResult: AgentLoopRunResult? = nil,
                          resultDocument: AgentResultDocument? = nil) async {
        let assistantID = providedAssistantID ?? UUID()
        let active = ActiveGeneration(taskID: taskID, attemptID: attemptID,
                                      userMessageID: ume.messageID,
                                      assistantID: assistantID,
                                      sequence: 0)
        _setActive(active, for: ume.conversationID)
        // last-active mirrored by _setActive
        defer {
            if _activeByConversation()[ume.conversationID]?.assistantID == assistantID {
                _setActive(nil, for: ume.conversationID)
            }
        }
        do {
            try await record(kind: .responseStarted, state: .running, taskID: taskID,
                             attemptID: attemptID, conversationID: ume.conversationID,
                             userMessageID: ume.messageID, assistantMessageID: assistantID,
                             retryOfTaskID: ume.retryOfTaskID,
                             regeneratedFromMessageID: ume.regeneratedFromMessageID,
                             decisionSource: source,
                             providerStreamingCapability: conversation.streamingCapability)
        } catch {
            emit(.failed(messageID: assistantID, reason: "任务记录写入失败")); return
        }
        emit(.providerMetadata(conversation.streamingCapability))
        await emitActivity(kind: .synthesisStarted,
                           taskID: taskID,
                           runID: attemptID,
                           conversationID: ume.conversationID,
                           userMessageID: ume.messageID,
                           title: "正在生成最终答复",
                           emit: emit)
        emit(.responseStarted(messageID: assistantID))

        var buffer = ""
        var emotion: PetEmotion = .neutral
        var viaCloud = false
        var pendingTypedFailure: LlmFailure? = nil  // P14.2 — R-B-F01
        var outputSeq = 0
        var terminated = false

        if !preset.isEmpty {
            buffer = preset
            outputSeq += 1
            if await emitDelta(assistantID: assistantID, text: preset, outputSeq: outputSeq,
                               ume: ume, taskID: taskID, attemptID: attemptID, source: source, emit: emit) {
                terminated = true
            }
        } else {
            let req = ConversationRequest(text: ume.text, memoryHints: ctx.memoryHints,
                                          isPrivate: ume.conversationClass == .privateChat,
                                          useScreen: ume.metadata.useScreen)
            do {
                for try await chunk in conversation.generate(req) {
                    // P14.2 — R-A-F3 + R-A-F4: cancel check now considers
                    // `terminalizedAttempts` (covers both conversationID
                    // cancel and durable taskID cancel). When the attempt
                    // is already terminalized, drop the chunk and bail.
                    if isCancelled(assistantID, conversationID: ume.conversationID) || Task.isCancelled || isAttemptTerminalized(attemptID) {
                        await emitActivity(kind: .taskCancelled,
                                           taskID: taskID,
                                           runID: attemptID,
                                           conversationID: ume.conversationID,
                                           userMessageID: ume.messageID,
                                           title: "任务已取消",
                                           failureCategory: .cancelled,
                                           emit: emit)
                        emit(.cancelled(messageID: assistantID)); return
                    }
                    switch chunk {
                    case .metadata(let capability):
                        emit(.providerMetadata(capability))
                    case .delta(let seq, let t):
                        outputSeq = max(outputSeq + 1, seq)
                        buffer += t
                        if await emitDelta(assistantID: assistantID, text: t, outputSeq: outputSeq,
                                           ume: ume, taskID: taskID, attemptID: attemptID,
                                           source: source, emit: emit) {
                            terminated = true
                            return
                        }
                    case .completed(let e, let vc): emotion = e; viaCloud = vc
                    case .typedError(let failure):
                        // P14.2 — R-B-F01 closure. The provider surfaced a
                        // typed failure. Treat the chunk the same way the
                        // `catch` block does but use the typed `LlmFailure`
                        // for retry classification when persisting.
                        pendingTypedFailure = failure
                        throw ConversationGenerationError(message: failure.message)
                    }
                }
            } catch {
                // P14.2 — R-A-F4: drop the failure record when the attempt
                // is already terminalized. The durable record is the
                // authoritative truth.
                //
                // P18.5 — INV-CANCEL-03: a cancellation MUST terminalize as
                // `.cancelled`, never as `.failed` / `.waitingForRetry`. The
                // pre-chunk guard above already covers the in-loop case; this
                // mirrors its full predicate set for a cancellation that
                // surfaces as a *thrown* error instead — a structured
                // `CancellationError`, or a `cancel(conversationID:)` that
                // raced ahead of / behind attempt registration so
                // `terminalizedAttempts` was not (yet) set for this attempt.
                // Without this, such a cancelled turn was recorded as a
                // generic provider failure (violating §20) and could enter
                // the retry-classification path below.
                if error is CancellationError
                    || Task.isCancelled
                    || isCancelled(assistantID, conversationID: ume.conversationID)
                    || isAttemptTerminalized(attemptID) {
                    if isAttemptTerminalized(attemptID) {
                        await recordAudit(kind: .staleCallbackDropped, correlationID: taskID,
                                          summary: ConverseAuditSummary.converseCatchTerminalized(attemptID: attemptID),
                                          timestamp: clock.now())
                    }
                    emit(.cancelled(messageID: assistantID))
                    return
                }
                let reason = ConversePipelineHelpers.userFacingGenerationError(error)
                // P14.2 — R-B-F01 closure. The typed `LlmFailure` (when
                // surfaced via `.typedError(...)`) is persisted into the
                // durable `lastFailure` so the supervisor / scheduler
                // can use it on retry. The legacy stringly-typed
                // `failureReason` field remains populated for the
                // activity stream and audit.
                let typedFailure = pendingTypedFailure
                let durableFailure: DurableFailureRecord? = typedFailure.map {
                    DurableFailureRecord(llmFailure: $0, phase: "provider")
                }
                // P14.5 — R-B-F03 / INV-RH-01..05 closure. Decide
                // retryability from the typed `LlmFailure` via the
                // authoritative `AgentRetryPolicy.shouldRetry(...)`.
                // When the failure is retryable AND this is the
                // first failure (the durable record was never set
                // to `.waitingForRetry` previously — `nextRetryAt`
                // being nil signals a fresh user-message attempt),
                // transition to `.waitingForRetry` and register a
                // wakeup. For non-retryable failures OR when the
                // catch block fires during a wakeup-driven retry
                // attempt (`nextRetryAt` already populated), keep
                // the existing `.failed` terminal behavior — the
                // scheduler's `driveSingleRetry` already owns the
                // retry handoff for the prior `.waitingForRetry`.
                let currentTask = await durableTaskStore?.task(id: taskID)
                let attemptCount = currentTask?.attemptCount ?? 1
                let semantics = AgentToolExecutionSemantics(idempotency: .idempotent)
                let retryable = typedFailure.map {
                    retryPolicy.shouldRetry(llmFailure: $0,
                                            attempt: attemptCount,
                                            semantics: semantics)
                } ?? false
                let isFreshFirstAttempt = currentTask.map { record in
                    // First-attempt signal: the durable record has
                    // no `nextRetryAt` set (i.e., never transitioned
                    // to `.waitingForRetry` previously). Wakeup-
                    // driven retries always carry a `nextRetryAt`.
                    record.nextRetryAt == nil
                } ?? true
                if let typedFailure, retryable,
                   let store = durableTaskStore, isFreshFirstAttempt {
                    // P14.5 — production retry handoff. The catch
                    // block routes a typed retryable failure to
                    // `.waitingForRetry` instead of `.failed` (terminal).
                    // The next attempt runs via
                    // `evaluateRetries(now:)` at startup AND via
                    // `RuntimeRetryScheduler.driveDueWork()` while
                    // the runtime is alive.
                    let nextRetryAt = retryPolicy.nextRetryDate(
                        attempt: attemptCount,
                        llmFailure: typedFailure,
                        clock: { [clock] in clock.now() }
                    )
                    // Persist `.waitingForRetry` with the typed
                    // failure attached as `lastFailure` and the
                    // computed `nextRetryAt`.
                    _ = await store.applyTransition(
                        taskID: taskID,
                        to: .waitingForRetry,
                        failure: durableFailure,
                        nextRetryAt: nextRetryAt)
                    // P15 — surface the retry wait to the UI via a
                    // dedicated activity event so the FloatingChat
                    // header / ChatModel.transientStatusText can show
                    // "请求暂时受限，将自动重试…" instead of generic
                    // "正在生成回复……". The event is informational —
                    // it does NOT trigger completion.
                    await emitActivity(kind: .taskWaitingForRetry,
                                       taskID: taskID,
                                       runID: attemptID,
                                       conversationID: ume.conversationID,
                                       userMessageID: ume.messageID,
                                       title: "请求暂时受限，将自动重试…",
                                       detail: "稍等几秒后会自动继续",
                                       emit: emit)
                    // Register a wakeup with the live retry
                    // scheduler (when injected). The
                    // `RuntimeLifecycleController.start()` periodic
                    // driver will call `driveDueWork()` to fire it.
                    if let scheduler = retryScheduler {
                        await scheduler.registerWakeup(taskID: taskID, deadline: nextRetryAt)
                    }
                    // Activity stream + audit so observers see the
                    // waiting-for-retry state. The legacy record
                    // event remains `.failed` for activity
                    // observability (the durable state is the
                    // authoritative truth).
                    try? await record(kind: .failed, state: .failed, taskID: taskID, attemptID: attemptID,
                                      conversationID: ume.conversationID, userMessageID: ume.messageID,
                                      assistantMessageID: assistantID, retryOfTaskID: ume.retryOfTaskID,
                                      regeneratedFromMessageID: ume.regeneratedFromMessageID,
                                      decisionSource: source,
                                      stopReason: loopResult?.stopReason,
                                      iterationCount: loopResult?.iterationCount,
                                      toolCallCount: loopResult?.toolCallCount,
                                      usedToolNames: loopResult?.usedToolNames,
                                      toolStatuses: loopResult?.toolStatuses.map(\.rawValue),
                                      planID: loopResult?.planID,
                                      planVersion: loopResult?.planVersion,
                                      planStepCount: loopResult?.planStepCount,
                                      planRiskLevel: loopResult?.planRiskLevel,
                                      planApprovalRequired: loopResult?.planApprovalRequired,
                                      planApprovalGranted: loopResult?.planApprovalGranted,
                                      planReplanCount: loopResult?.planReplanCount,
                                      planResultItemCount: loopResult?.planResultItemCount,
                                      planResultTruncated: loopResult?.planResultTruncated,
                                      failureReason: reason, terminal: false)
                    await emitActivity(kind: .taskFailed,
                                       taskID: taskID,
                                       runID: attemptID,
                                       conversationID: ume.conversationID,
                                       userMessageID: ume.messageID,
                                       title: "等待重试",
                                       detail: reason,
                                       failureCategory: .providerUnavailable,
                                       emit: emit)
                    await recordAudit(kind: .retryScheduled, correlationID: taskID,
                                          summary: "nextRetryAt=\(Int(nextRetryAt.timeIntervalSinceNow))s code=\(typedFailure.code.rawValue)",
                                          timestamp: clock.now())
                    emit(.typedFailed(messageID: assistantID,
                                      llmFailure: typedFailure,
                                      reason: reason))
                    emit(.failed(messageID: assistantID, reason: reason)); return
                }
                // Non-retryable typed failure OR no typed failure
                // (legacy stringly-typed): keep existing
                // `.failed` terminal behavior. The task does NOT
                // become `.waitingForRetry`; no scheduler wakeup.
                try? await record(kind: .failed, state: .failed, taskID: taskID, attemptID: attemptID,
                                  conversationID: ume.conversationID, userMessageID: ume.messageID,
                                  assistantMessageID: assistantID, retryOfTaskID: ume.retryOfTaskID,
                                  regeneratedFromMessageID: ume.regeneratedFromMessageID,
                                  decisionSource: source,
                                  stopReason: loopResult?.stopReason,
                                  iterationCount: loopResult?.iterationCount,
                                  toolCallCount: loopResult?.toolCallCount,
                                  usedToolNames: loopResult?.usedToolNames,
                                  toolStatuses: loopResult?.toolStatuses.map(\.rawValue),
                                  planID: loopResult?.planID,
                                  planVersion: loopResult?.planVersion,
                                  planStepCount: loopResult?.planStepCount,
                                  planRiskLevel: loopResult?.planRiskLevel,
                                  planApprovalRequired: loopResult?.planApprovalRequired,
                                  planApprovalGranted: loopResult?.planApprovalGranted,
                                  planReplanCount: loopResult?.planReplanCount,
                                  planResultItemCount: loopResult?.planResultItemCount,
                                  planResultTruncated: loopResult?.planResultTruncated,
                                  failureReason: reason, terminal: true)
                // P14.1 + P14.2 — mirror failure into the durable kernel
                // (R-B-01) with the typed `LlmFailure` attached when
                // available so the scheduler's typed retry path is the
                // source of truth for retry classification (R-B-F01).
                await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                    legacyState: .failed,
                                    title: "generationFailed",
                                    failure: durableFailure,
                                    conversationID: ume.conversationID)
                await emitActivity(kind: .taskFailed,
                                   taskID: taskID,
                                   runID: attemptID,
                                   conversationID: ume.conversationID,
                                   userMessageID: ume.messageID,
 title: "最终答复生成失败",
                                    detail: reason,
                                    failureCategory: .providerUnavailable,
                                    emit: emit)
                // P14.2 — R-B-F01: emit the typed-failure variant when
                // the typed `LlmFailure` is available so consumers can
                // route the typed scheduler retry path.
                if let typedFailure {
                    emit(.typedFailed(messageID: assistantID,
                                      llmFailure: typedFailure,
                                      reason: reason))
                }
                emit(.failed(messageID: assistantID, reason: reason)); return
            }
        }
        if terminated { return }
        if isCancelled(assistantID, conversationID: ume.conversationID) || Task.isCancelled {
            await emitActivity(kind: .taskCancelled,
                               taskID: taskID,
                               runID: attemptID,
                               conversationID: ume.conversationID,
                               userMessageID: ume.messageID,
                               title: "任务已取消",
                               failureCategory: .cancelled,
                               emit: emit)
            emit(.cancelled(messageID: assistantID)); return
        }
        let finalState = loopResult?.terminalState ?? .succeeded

        // P14.1 — R-B-02 acceptance gate. A model stream ending alone is NOT
        // sufficient for a Goal-backed task to complete. When a Goal is bound
        // to this task, consult `AcceptanceEvaluator.mayComplete(goal:)`:
        //   .allSatisfied → allow `.completed`
        //   .waitingForUser → durable `.waitingForApproval` (NOT completed)
        //   .unsatisfied   → continue running (NOT completed)
        // When no Goal is bound, preserve legacy semantics.
        let acceptance = await acceptanceAllowsCompletion(taskID: taskID)
        if !acceptance.allowed {
            switch acceptance.evaluation {
            case .waitingForUser(let missing):
                // Goal needs explicit user input/approval — keep the response
                // visible but DO NOT mark the task complete. Persist durable
                // waiting state (R-B-02 + R-B-07).
                try? await record(kind: .waitingForApproval, state: .awaitingPermission,
                                  taskID: taskID, attemptID: attemptID,
                                  conversationID: ume.conversationID,
                                  userMessageID: ume.messageID,
                                  assistantMessageID: assistantID,
                                  retryOfTaskID: ume.retryOfTaskID,
                                  regeneratedFromMessageID: ume.regeneratedFromMessageID,
                                  decisionSource: source,
                                  planApprovalRequired: true,
                                  planApprovalGranted: false)
                await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                    legacyState: .awaitingApproval,
                                    title: "waitingForUserApproval",
                                    conversationID: ume.conversationID)
                await appendInbox(ConverseInboxBuilder.approvalDecisionRequested(
                    taskID: taskID,
                    missing: missing.map { $0.criterionID }))
                await emitActivity(kind: .taskPartiallySucceeded,
                                   taskID: taskID,
                                   runID: attemptID,
                                   conversationID: ume.conversationID,
                                   userMessageID: ume.messageID,
                                   title: "等待你确认",
                                   detail: "已生成答复，但任务目标还未完全满足",
                                   emit: emit)
                emit(.responseCompleted(messageID: assistantID, emotion: emotion, viaCloud: viaCloud))
                emit(.presentation(render(buffer, mode: .casual, emotion: emotion, viaCloud: viaCloud)))
                return
            case .unsatisfied(let missing):
                // Goal is not satisfied by the model response alone. Continue
                // running the loop; do NOT mark complete. Persist durable
                // `.running` state and emit a re-entrant signal so the
                // supervisor can retry (R-B-02).
                try? await record(kind: .responseDelta, state: .running,
                                  taskID: taskID, attemptID: attemptID,
                                  conversationID: ume.conversationID,
                                  userMessageID: ume.messageID,
                                  assistantMessageID: assistantID,
                                  retryOfTaskID: ume.retryOfTaskID,
                                  regeneratedFromMessageID: ume.regeneratedFromMessageID,
                                  decisionSource: source,
                                  failureReason: "criteria-unsatisfied:\(missing.map { $0.criterionID }.joined(separator: ","))")
                await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                    legacyState: .running,
                                    title: "criteria-unsatisfied",
                                    conversationID: ume.conversationID)
                await emitActivity(kind: .taskPartiallySucceeded,
                                   taskID: taskID,
                                   runID: attemptID,
                                   conversationID: ume.conversationID,
                                   userMessageID: ume.messageID,
                                   title: "继续执行",
                                   detail: "目标还有未满足的条件",
                                   emit: emit)
                emit(.responseCompleted(messageID: assistantID, emotion: emotion, viaCloud: viaCloud))
                emit(.presentation(render(buffer, mode: .casual, emotion: emotion, viaCloud: viaCloud)))
                return
            default:
                break
            }
        }

        // P14.2 — R-A-F4: drop the completion write if the attempt has
        // already been terminalized by `cancel(taskID:)` or a concurrent
        // `cancel(conversationID:)`. Emit a stale-callback audit so the
        // event is observable; do NOT emit a successful completion.
        if isAttemptTerminalized(attemptID) {
            await recordAudit(kind: .staleCallbackDropped, correlationID: taskID,
                                  summary: ConverseAuditSummary.converseTerminalized(attemptID: attemptID),
                                  timestamp: clock.now())
            emit(.cancelled(messageID: assistantID))
            return
        }

        do {
            try await record(kind: .completed, state: finalState, taskID: taskID, attemptID: attemptID,
                             conversationID: ume.conversationID, userMessageID: ume.messageID,
                             assistantMessageID: assistantID, retryOfTaskID: ume.retryOfTaskID,
                             regeneratedFromMessageID: ume.regeneratedFromMessageID,
                             decisionSource: source,
                             providerStreamingCapability: conversation.streamingCapability,
                             agentLoopState: loopResult.map { "completed:\($0.stopReason.rawValue)" },
                             stopReason: loopResult?.stopReason,
                             iterationCount: loopResult?.iterationCount,
                             toolCallCount: loopResult?.toolCallCount,
                             usedToolNames: loopResult?.usedToolNames,
                             toolStatuses: loopResult?.toolStatuses.map(\.rawValue),
                             planID: loopResult?.planID,
                             planVersion: loopResult?.planVersion,
                             planStepCount: loopResult?.planStepCount,
                             planRiskLevel: loopResult?.planRiskLevel,
                             planApprovalRequired: loopResult?.planApprovalRequired,
                             planApprovalGranted: loopResult?.planApprovalGranted,
                             planReplanCount: loopResult?.planReplanCount,
                             planResultItemCount: loopResult?.planResultItemCount,
                             planResultTruncated: loopResult?.planResultTruncated,
                             outputSequence: outputSeq, terminal: true)
            // P14.1 — mirror completion into the durable kernel (R-B-01).
            await mirrorDurable(taskID: taskID, attemptID: attemptID,
                                legacyState: .succeeded,
                                title: "taskCompleted",
                                conversationID: ume.conversationID)
        } catch {
            emit(.failed(messageID: assistantID, reason: "任务记录写入失败")); return
        }
        await emitActivity(kind: .synthesisSucceeded,
                           taskID: taskID,
                           runID: attemptID,
                           conversationID: ume.conversationID,
                           userMessageID: ume.messageID,
                           title: "最终答复已生成",
                           emit: emit)
        await emitResultDocument(resultDocument ?? loopResult?.resultDocument,
                                 taskID: taskID,
                                 runID: attemptID,
                                 conversationID: ume.conversationID,
                                 userMessageID: ume.messageID,
                                 emit: emit)
        let terminalActivity = ConversePipelineHelpers.terminalActivityDescriptor(for: finalState,
                                                               stopReason: loopResult?.stopReason)
        await emitActivity(kind: terminalActivity.kind,
                           taskID: taskID,
                           runID: attemptID,
                           conversationID: ume.conversationID,
                           userMessageID: ume.messageID,
                           title: terminalActivity.title,
                           detail: loopResult?.stopReason == nil ? nil : loopResult?.stopReason.userVisibleSummary,
                           failureCategory: terminalActivity.failureCategory,
                           emit: emit)
        // Privacy dye: never extract memories from private user text —
        // not even explicit "记住…" cues (see reflectMemoryCandidates gate).
        if !privateTaskIDs.contains(taskID) {
            await reflectMemoryCandidates(UserAuthoredMemoryCandidateExtractor.candidates(
                from: ume.text,
                sourceReference: MemorySourceReference(conversationID: ume.conversationID,
                                                       messageID: ume.messageID,
                                                       taskID: taskID,
                                                       runID: attemptID,
                                                       eventID: ume.eventID)))
        }
        emit(.responseCompleted(messageID: assistantID, emotion: emotion, viaCloud: viaCloud))
        emit(.presentation(render(buffer, mode: .casual, emotion: emotion, viaCloud: viaCloud)))
    }

    func emitDelta(assistantID: UUID, text: String, outputSeq: Int, ume: UserMessageEvent,
                           taskID: UUID, attemptID: UUID, source: DecisionSource,
                           emit: @Sendable (PetAgentRuntimeOutput) -> Void) async -> Bool {
        do {
            try await record(kind: .responseDelta, state: .running, taskID: taskID, attemptID: attemptID,
                             conversationID: ume.conversationID, userMessageID: ume.messageID,
                             assistantMessageID: assistantID, retryOfTaskID: ume.retryOfTaskID,
                             regeneratedFromMessageID: ume.regeneratedFromMessageID,
                             decisionSource: source,
                             providerStreamingCapability: conversation.streamingCapability,
                             outputSequence: outputSeq)
        } catch {
            emit(.failed(messageID: assistantID, reason: "任务记录写入失败"))
            return true
        }
        emit(.responseDelta(messageID: assistantID, sequence: outputSeq, text: text))
        return false
    }
}