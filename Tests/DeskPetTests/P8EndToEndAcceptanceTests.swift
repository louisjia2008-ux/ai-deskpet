import XCTest
import Foundation
@testable import AICore
@testable import DeskPet
@testable import PetAgentRuntime

final class P8EndToEndAcceptanceTests: XCTestCase {
    func testFlow1OrdinaryStreamingStopProducesCancelledTerminalWithoutThinkingLeak() {
        let sanitizer = StreamingModelResponseSanitizer()
        let visible1 = sanitizer.ingest(contentDelta: "你好")
        let hidden = sanitizer.ingest(contentDelta: "<think>internal plan")
        let visible2 = sanitizer.ingest(contentDelta: "</think>，我在。")
        let finished = sanitizer.finish()
        let visibleText = [visible1.visibleText, hidden.visibleText, visible2.visibleText, finished.visibleText].joined()

        XCTAssertEqual(visibleText, "你好，我在。")
        XCTAssertTrue(hidden.hadReasoning || visible2.hadReasoning)
        XCTAssertFalse(visibleText.localizedCaseInsensitiveContains("think"))
        XCTAssertFalse(visibleText.localizedCaseInsensitiveContains("internal"))

        let taskID = UUID()
        let runID = UUID()
        let events = [
            p8Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p8Event(.modelRequestStarted, taskID: taskID, runID: runID, sequence: 2),
            p8Event(.modelResponseStreaming, taskID: taskID, runID: runID, sequence: 3,
                    payload: .model(.init(provider: "fixture",
                                          modelID: "streaming-chat",
                                          safeSummary: visibleText))),
            p8Event(.taskCancelled, taskID: taskID, runID: runID, sequence: 4,
                    payload: .failure(.init(phase: "modelStreaming",
                                            category: "userStopped",
                                            safeSummary: "用户停止生成",
                                            recoverable: false,
                                            retryable: true))),
            p8Event(.modelResponseCompleted, taskID: taskID, runID: runID, sequence: 5),
        ]

        let projection = AgentTaskProjectionReducer.reduce(envelopes: events)
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID, runID: runID, events: events)
        let plan = AgentRecoveryPlanner().plan(from: checkpoint)

        XCTAssertEqual(projection.run(id: runID)?.state, .cancelled)
        XCTAssertFalse(projection.run(id: runID)?.events.contains { $0.kind == .modelResponseCompleted } ?? true)
        XCTAssertEqual(plan.strategy, .replayOnly)
        XCTAssertFalse(plan.shouldEmitRecoveryEvents)
    }

    func testFlow2And3DateTimeToolSuccessFailureAndReplayDetail() {
        let successTask = UUID()
        let successRun = UUID()
        let successEvents = [
            p8Event(.taskStarted, taskID: successTask, runID: successRun, sequence: 1,
                    payload: .activity(.init(title: "现在几点？", conversationID: UUID()))),
            p8ToolEvent(.toolStarted, taskID: successTask, runID: successRun, sequence: 2,
                        toolID: "get_current_datetime", toolCallID: "time-call", displayName: "读取当前日期时间"),
            p8ToolEvent(.toolSucceeded, taskID: successTask, runID: successRun, sequence: 3,
                        toolID: "get_current_datetime", toolCallID: "time-call", displayName: "读取当前日期时间",
                        summary: "2026-07-24 15:31 Asia/Shanghai"),
            p8Event(.observationProduced, taskID: successTask, runID: successRun, sequence: 4),
            p8Event(.verificationStarted, taskID: successTask, runID: successRun, sequence: 5),
            p8Event(.verificationSucceeded, taskID: successTask, runID: successRun, sequence: 6),
            p8Event(.modelResponseCompleted, taskID: successTask, runID: successRun, sequence: 7),
            p8Event(.taskSucceeded, taskID: successTask, runID: successRun, sequence: 8,
                    payload: .task(.init(title: "任务已完成", status: "succeeded"))),
        ]
        let successActivity = AgentTaskActivityReducer.reduce(
            taskID: successTask,
            events: successEvents.map(AgentTaskActivityEvent.init(eventEnvelope:)))
        let replay = AgentTimelineReplayState(taskID: successTask, runID: successRun, events: successEvents).jumpToEnd()

        XCTAssertEqual(successActivity.latestRun?.status, .succeeded)
        XCTAssertTrue(successActivity.latestRun?.events.contains {
            $0.toolID?.rawValue == "get_current_datetime" && $0.presentation.title.contains("日期")
        } ?? false)
        XCTAssertTrue(replay.visibleEvents.contains { $0.kind == .toolStarted })
        XCTAssertTrue(replay.visibleEvents.contains { $0.kind == .verificationSucceeded })

        let failedTask = UUID()
        let failedRun = UUID()
        let failureEvents = [
            p8Event(.taskStarted, taskID: failedTask, runID: failedRun, sequence: 1),
            p8ToolEvent(.toolStarted, taskID: failedTask, runID: failedRun, sequence: 2,
                        toolID: "get_current_datetime", toolCallID: "time-call", displayName: "读取当前日期时间"),
            p8Event(.toolFailed, taskID: failedTask, runID: failedRun, sequence: 3,
                    payload: .failure(.init(phase: "tool",
                                            category: "toolFailed",
                                            safeSummary: "系统时间工具返回失败",
                                            recoverable: true,
                                            retryable: true))),
            p8Event(.taskFailed, taskID: failedTask, runID: failedRun, sequence: 4,
                    payload: .failure(.init(phase: "runtime",
                                            category: "toolFailed",
                                            safeSummary: "可以重试",
                                            recoverable: true,
                                            retryable: true))),
        ]
        let failedActivity = AgentTaskActivityReducer.reduce(
            taskID: failedTask,
            events: failureEvents.map(AgentTaskActivityEvent.init(eventEnvelope:)))

        XCTAssertEqual(failedActivity.latestRun?.status, .failed)
        XCTAssertNotEqual(failedActivity.latestRun?.status, .succeeded)
        XCTAssertEqual(failedActivity.latestRun?.failureCategory, .toolFailed)
    }

    func testFlow4VerifierRejectsOverclaimThenRepairControlsTerminalState() async throws {
        let plan = try p8ValidatedPlan()
        let taskID = UUID()
        let read = p8Observation(callID: "read", tool: "fixture.read", status: .success)
        let rank = p8Observation(callID: "rank", tool: "fixture.rank", status: .failed)
        let execution = PlanExecutionResult(
            records: [
                PlanStepExecutionRecord(stepID: "s0", toolID: "fixture.read", status: .succeeded, observation: read),
                PlanStepExecutionRecord(stepID: "s1", toolID: "fixture.rank", status: .failed, observation: rank),
            ],
            observations: [read, rank],
            status: .partiallyCompleted,
            stopReason: .completed)
        let evidence = execution.observations.map {
            AgentEvidenceRecord.from(observation: $0, taskID: taskID, capturedAt: Date())
        }
        let verifier = DeterministicPlanVerifier()
        let assessment = DefaultTaskGovernor().assess(goal: PlanningGoal(text: "公开查询"),
                                                      plan: plan,
                                                      budget: TaskGovernorBudget())
        let first = await verifier.verify(PlanVerificationInput(
            goal: PlanningGoal(text: "公开查询"),
            plan: plan,
            execution: execution,
            finalResponse: AgentFinalResponse(text: "已完成，全部成功", finishReason: "stop"),
            evidence: evidence,
            assessment: assessment))
        XCTAssertEqual(first.verdict, .repairRequired)

        let repaired = verifier.repairFinalResponse(for: first, observations: execution.observations)
        let second = await verifier.verify(PlanVerificationInput(
            goal: PlanningGoal(text: "公开查询"),
            plan: plan,
            execution: execution,
            finalResponse: repaired,
            evidence: evidence,
            assessment: assessment,
            repairAttempt: 1))
        XCTAssertEqual(second.verdict, .partialPass)
        XCTAssertEqual(second.terminalState, .partiallySucceeded)
    }

    func testFlow5And6PermissionAllowOnceAndDenyDoNotBypassExecution() async {
        let clock = TestClock(start: Date(timeIntervalSince1970: 1_800_000_000))
        let store = ToolInvocationApprovalStore(clock: clock)
        let taskID = UUID()
        let runID = UUID()
        let arguments: AgentJSONValue = .object(["scope": .string("one-task")])
        let grant = await store.grant(taskID: taskID,
                                      runID: runID,
                                      toolCallID: "call-1",
                                      toolID: "calendar.event.create",
                                      arguments: arguments)
        guard case .granted = await store.consume(grantID: grant.id,
                                                  taskID: taskID,
                                                  runID: runID,
                                                  toolCallID: "call-1",
                                                  toolID: "calendar.event.create",
                                                  arguments: arguments) else {
            return XCTFail("allow once should grant current task")
        }
        guard case .denied(let replayReason) = await store.consume(grantID: grant.id,
                                                                   taskID: taskID,
                                                                   runID: runID,
                                                                   toolCallID: "call-1",
                                                                   toolID: "calendar.event.create",
                                                                   arguments: arguments) else {
            return XCTFail("allow once should not replay")
        }
        XCTAssertEqual(replayReason, "approval already consumed")

        let deniedTask = UUID()
        let deniedRun = UUID()
        let deniedEvents = [
            p8Event(.taskStarted, taskID: deniedTask, runID: deniedRun, sequence: 1),
            p8Event(.toolPermissionRequired, taskID: deniedTask, runID: deniedRun, sequence: 2,
                    payload: .permission(.init(capabilityID: "calendar.write", safeReason: "需要写日历"))),
            p8Event(.toolPermissionDenied, taskID: deniedTask, runID: deniedRun, sequence: 3,
                    payload: .permission(.init(capabilityID: "calendar.write",
                                               decision: "denied",
                                               safeReason: "用户拒绝"))),
            p8Event(.taskFailed, taskID: deniedTask, runID: deniedRun, sequence: 4,
                    payload: .failure(.init(phase: "permission",
                                            category: "approvalRejected",
                                            safeSummary: "已提供不写日历的降级方案",
                                            recoverable: false,
                                            retryable: true))),
            p8ToolEvent(.toolStarted, taskID: deniedTask, runID: deniedRun, sequence: 5,
                        toolID: "calendar.event.create", toolCallID: "late", displayName: "不得执行"),
        ]
        let projection = AgentTaskProjectionReducer.reduce(envelopes: deniedEvents)
        guard let run = projection.run(id: deniedRun) else {
            return XCTFail("missing denied run")
        }

        XCTAssertEqual(run.state, .failed)
        XCTAssertFalse(run.events.contains { $0.kind == .toolStarted })
    }

    func testFlow7DynamicChoiceUIInteractionCollapsesAndContinues() {
        let taskID = UUID()
        let runID = UUID()
        let snapshot = p8Document(taskID: taskID, runID: runID, revision: 0, status: .loading, sections: [
            .init(id: "status", state: .init(kind: .streaming, summary: "候选逐步出现"),
                  component: .emptyState(.init(message: "正在核对候选")))
        ])
        let choiceSection = AgentResultSection(
            id: "restaurant-choice",
            title: "选择候选",
            state: .init(kind: .unverified, summary: "fixture 候选"),
            component: .choiceList(.init(choices: [
                .init(id: "chengdu-house", title: "Chengdu House", subtitle: "川菜"),
                .init(id: "mala-room", title: "Mala Room", subtitle: "火锅"),
            ])))
        let fill = AgentResultPatchReducer.apply(
            AgentResultPatch(documentID: snapshot.id,
                             taskID: taskID,
                             runID: runID,
                             baseRevision: 0,
                             revision: 1,
                             operations: [
                                .removeSection(id: "status"),
                                .upsertSection(choiceSection),
                                .setStatus(.partial),
                                .setSummary("候选已出现"),
                             ]),
            to: snapshot,
            toolCatalog: p8Catalog())
        XCTAssertTrue(fill.accepted, "\(fill.issues)")

        let interaction = AgentResultInteractionEvent(taskID: taskID,
                                                      runID: runID,
                                                      documentID: snapshot.id,
                                                      componentID: "restaurant-choice",
                                                      actionID: "chengdu-house",
                                                      payload: .object(["choiceID": .string("chengdu-house")]))
        let resolved = AgentResultPatchReducer.apply(
            AgentResultPatch(documentID: snapshot.id,
                             taskID: taskID,
                             runID: runID,
                             baseRevision: 1,
                             revision: 2,
                             operations: [
                                .resolveChoice(componentID: "restaurant-choice",
                                               choiceID: "chengdu-house",
                                               summary: "已选择：Chengdu House"),
                                .setSummary("Agent 将继续提供导航、电话和菜单入口"),
                                .setStatus(.completed),
                             ]),
            to: fill.document,
            toolCatalog: p8Catalog())
        XCTAssertTrue(resolved.accepted, "\(resolved.issues)")

        let events = [
            p8ResultEvent(document: snapshot, sequence: 1),
            p8ResultEvent(document: fill.document, sequence: 2, baseRevision: 0),
            interaction.envelope(sequence: 3),
            p8ResultEvent(document: resolved.document, sequence: 4, baseRevision: 1),
            p8Event(.modelRequestStarted, taskID: taskID, runID: runID, sequence: 5),
            p8Event(.taskSucceeded, taskID: taskID, runID: runID, sequence: 6),
        ].map(AgentTaskActivityEvent.init(eventEnvelope:))
        let activity = AgentTaskActivityReducer.reduce(taskID: taskID, events: events)

        XCTAssertEqual(activity.latestRun?.status, .succeeded)
        XCTAssertEqual(activity.latestRun?.resultDocument?.revision, 2)
        XCTAssertTrue(activity.latestRun?.resultDocument?.sections.contains {
            $0.id == "restaurant-choice" && $0.state?.kind == .collapsed
        } ?? false)
    }

    func testFlow8CancellationStopsLateVisibleEventsAcrossModelToolAndVerifier() {
        let cancelScenarios: [(AgentEventKind, AgentEventKind)] = [
            (.modelResponseStreaming, .modelResponseCompleted),
            (.toolStarted, .toolSucceeded),
            (.verificationStarted, .verificationSucceeded),
        ]
        for (activeKind, lateKind) in cancelScenarios {
            let taskID = UUID()
            let runID = UUID()
            let events = [
                p8Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
                p8Event(activeKind, taskID: taskID, runID: runID, sequence: 2),
                p8Event(.taskCancelled, taskID: taskID, runID: runID, sequence: 3,
                        payload: .failure(.init(phase: "cancel",
                                                category: "userStopped",
                                                safeSummary: "用户取消",
                                                recoverable: false,
                                                retryable: true))),
                p8Event(lateKind, taskID: taskID, runID: runID, sequence: 4),
                p8Event(.taskSucceeded, taskID: taskID, runID: runID, sequence: 5),
            ]
            let run = AgentTaskProjectionReducer.reduce(envelopes: events).run(id: runID)
            XCTAssertEqual(run?.state, .cancelled)
            XCTAssertFalse(run?.events.contains { $0.sequence >= 4 } ?? true)
        }
    }

    func testFlow9ToolFactoryEphemeralLifecycleDoesNotAutoPromote() async {
        let factory = ToolFactory(permissionGate: P8PermissionGate(), clock: TestClock())
        let proposal = p8EphemeralProposal()
        let staticReport = await factory.propose(proposal)
        XCTAssertTrue(staticReport.passed, "\(staticReport.issues)")

        let sandbox = await factory.sandboxVerify(toolID: proposal.id, arguments: p8EphemeralArguments())
        XCTAssertEqual(sandbox.status, .success)
        XCTAssertTrue(sandbox.verification.passed)

        let execution = await factory.executeCurrentTask(toolID: proposal.id, arguments: p8EphemeralArguments())
        XCTAssertEqual(execution.status, .success)
        XCTAssertTrue(execution.verification.passed)
        let reusable = await factory.reusableRegistrySnapshot()
        let record = await factory.record(for: proposal.id)
        XCTAssertTrue(reusable.entries.isEmpty)
        XCTAssertTrue(record?.lifecycle.contains(.reusableCandidate) ?? false)
    }

    func testFlow10RestartReplayCheckpointDoesNotRepeatSideEffect() async throws {
        let taskID = UUID()
        let runID = UUID()
        let directory = URL(fileURLWithPath: "/private/tmp/deskpet-p8-replay-\(UUID().uuidString)", isDirectory: true)
        let store = AgentRunEventStore(baseDirectory: directory)
        var ledger = AgentSideEffectLedger()
        XCTAssertTrue(ledger.recordStart(operationID: "write-once",
                                         taskID: taskID,
                                         runID: runID,
                                         toolID: "filesystem.workspace.write",
                                         arguments: .object(["path": .string("fixture.txt")])))
        XCTAssertTrue(ledger.recordCompletion(operationID: "write-once",
                                              status: .succeeded,
                                              result: .object(["status": .string("success")])))
        let events = [
            p8Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p8ToolEvent(.toolStarted, taskID: taskID, runID: runID, sequence: 2,
                        toolID: "filesystem.workspace.write", toolCallID: "write", displayName: "写入文件"),
            p8ToolEvent(.toolSucceeded, taskID: taskID, runID: runID, sequence: 3,
                        toolID: "filesystem.workspace.write", toolCallID: "write", displayName: "写入文件"),
            p8Event(.observationProduced, taskID: taskID, runID: runID, sequence: 4),
        ]
        for event in events { try await store.append(event) }

        let reloaded = try await AgentRunEventStore(baseDirectory: directory).loadEvents(runID: runID)
        let checkpoint = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                             runID: runID,
                                                             events: reloaded,
                                                             sideEffectLedger: ledger)
        let plan = AgentRecoveryPlanner().plan(from: checkpoint)

        XCTAssertEqual(plan.strategy, .resumeModelSynthesis)
        XCTAssertFalse(plan.shouldRepeatSideEffects)
        XCTAssertFalse(ledger.shouldExecute(operationID: "write-once"))
        XCTAssertEqual(checkpoint.completedSideEffectOperationIDs, ["write-once"])
    }

    func testFlow11ParallelReadOnlyToolsPreserveSequenceAndParentRelationship() {
        let taskID = UUID()
        let runID = UUID()
        let parentID = UUID()
        let events = [
            p8Event(.taskStarted, taskID: taskID, runID: runID, sequence: 1),
            p8Event(.stepStarted, id: parentID, taskID: taskID, runID: runID, sequence: 2,
                    payload: .step(.init(stepID: "parallel-read",
                                         title: "并行读取",
                                         safeSummary: "两个只读工具并行"))),
            p8ToolEvent(.toolStarted, taskID: taskID, runID: runID, sequence: 3,
                        parentEventID: parentID,
                        toolID: "fixture.read.a", toolCallID: "read-a", displayName: "读取 A"),
            p8ToolEvent(.toolStarted, taskID: taskID, runID: runID, sequence: 4,
                        parentEventID: parentID,
                        toolID: "fixture.read.b", toolCallID: "read-b", displayName: "读取 B"),
            p8ToolEvent(.toolSucceeded, taskID: taskID, runID: runID, sequence: 5,
                        parentEventID: parentID,
                        toolID: "fixture.read.a", toolCallID: "read-a", displayName: "读取 A"),
            p8ToolEvent(.toolSucceeded, taskID: taskID, runID: runID, sequence: 6,
                        parentEventID: parentID,
                        toolID: "fixture.read.b", toolCallID: "read-b", displayName: "读取 B"),
            p8Event(.taskSucceeded, taskID: taskID, runID: runID, sequence: 7),
        ]
        let run = AgentTaskProjectionReducer.reduce(envelopes: events).run(id: runID)
        let toolEvents = run?.events.filter {
            [.toolStarted, .toolCompleted].contains($0.kind)
        } ?? []

        XCTAssertEqual(run?.state, .succeeded)
        XCTAssertEqual(toolEvents.map(\.sequence), [3, 4, 5, 6])
        XCTAssertEqual(Set(toolEvents.compactMap(\.parentEventID)), [parentID])
        XCTAssertEqual(Set(toolEvents.map { $0.envelope().parentEventID }), [parentID])
    }

    @MainActor
    func testFlow12OldTaskIsolationTerminalDoesNotBecomeActiveInNewConversation() {
        let store = AgentTaskActivityStore(persistence: nil, runEventStore: nil)
        let oldConversation = UUID()
        let newConversation = UUID()
        let oldTask = UUID()
        let oldRun = UUID()
        let newTask = UUID()
        let newRun = UUID()

        store.publish(p8Event(.taskStarted, taskID: oldTask, runID: oldRun, sequence: 1,
                              payload: .activity(.init(title: "旧任务",
                                                       conversationID: oldConversation))))
        store.publish(p8Event(.taskSucceeded, taskID: oldTask, runID: oldRun, sequence: 2,
                              payload: .activity(.init(title: "旧任务完成",
                                                       conversationID: oldConversation))))
        store.publish(p8Event(.taskStarted, taskID: newTask, runID: newRun, sequence: 1,
                              payload: .activity(.init(title: "新任务",
                                                       conversationID: newConversation))))

        XCTAssertEqual(store.latestTask(conversationID: oldConversation)?.latestRun?.status, .succeeded)
        XCTAssertEqual(store.latestTask(conversationID: newConversation)?.latestRun?.status, .running)
        XCTAssertEqual(store.activeTasks.map(\.taskID), [newTask])
        XCTAssertFalse(store.activeTasks.contains { $0.taskID == oldTask })
    }

    func testP8AutomationDataRootUsesUniqueTemporaryDirectoryAndReportsUnsafeRoots() throws {
        let base = URL(fileURLWithPath: "/private/tmp/deskpet-p8-xcui-\(UUID().uuidString)", isDirectory: true)
        let first = try DeskPetAppEnvironment.automation(profileID: "p8A",
                                                         dataRootMode: .appTemporary,
                                                         resetProfile: false,
                                                         temporaryDirectory: base)
        let second = try DeskPetAppEnvironment.automation(profileID: "p8B",
                                                          dataRootMode: .appTemporary,
                                                          resetProfile: false,
                                                          temporaryDirectory: base)
        let firstRoot = try XCTUnwrap(first.paths.profileRoot)
        let secondRoot = try XCTUnwrap(second.paths.profileRoot)

        XCTAssertEqual(firstRoot.deletingLastPathComponent().resolvingSymlinksInPath(),
                       secondRoot.deletingLastPathComponent().resolvingSymlinksInPath())
        XCTAssertTrue(firstRoot.path.contains("/DeskPetAutomation/p8A"))
        XCTAssertTrue(secondRoot.path.contains("/DeskPetAutomation/p8B"))
        XCTAssertNotEqual(firstRoot, secondRoot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstRoot.appendingPathComponent(".deskpet-automation-profile").path))
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "p8Unsafe",
                                                                  dataRoot: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)))
    }
}

private actor P8PermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: true,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired)
    }
}

private func p8Event(_ kind: AgentEventKind,
                     id: UUID = UUID(),
                     taskID: UUID,
                     runID: UUID,
                     sequence: UInt64,
                     parentEventID: UUID? = nil,
                     source: AgentEventSource = .runtime,
                     payload: AgentEventPayload = .empty) -> AgentEventEnvelope {
    AgentEventEnvelope(id: id,
                       taskID: taskID,
                       runID: runID,
                       sequence: sequence,
                       timestamp: Date(timeIntervalSince1970: 1_800_000_000 + TimeInterval(sequence)),
                       source: source,
                       parentEventID: parentEventID,
                       kind: kind,
                       payload: payload)
}

private func p8ToolEvent(_ kind: AgentEventKind,
                         taskID: UUID,
                         runID: UUID,
                         sequence: UInt64,
                         parentEventID: UUID? = nil,
                         toolID: String,
                         toolCallID: String,
                         displayName: String,
                         summary: String? = nil) -> AgentEventEnvelope {
    p8Event(kind,
            taskID: taskID,
            runID: runID,
            sequence: sequence,
            parentEventID: parentEventID,
            payload: .tool(.init(toolID: toolID,
                                 toolCallID: toolCallID,
                                 displayName: displayName,
                                 safeSummary: summary)))
}

private func p8Document(taskID: UUID,
                        runID: UUID,
                        revision: Int,
                        status: AgentResultStatus,
                        sections: [AgentResultSection]) -> AgentResultDocument {
    AgentResultDocument(id: "p8-fixture-result",
                        taskID: taskID,
                        runID: runID,
                        revision: revision,
                        title: "P8 fixture result",
                        summary: "fixture-based GUI flow",
                        status: status,
                        generatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                        sections: sections)
}

private func p8ResultEvent(document: AgentResultDocument,
                           sequence: UInt64,
                           baseRevision: Int? = nil) -> AgentEventEnvelope {
    p8Event(baseRevision == nil ? .resultSnapshot : .resultPatch,
            taskID: document.taskID,
            runID: document.runID,
            sequence: sequence,
            payload: .result(.init(title: document.title,
                                   summary: document.summary,
                                   document: document,
                                   eventKind: baseRevision == nil ? .snapshot : .patch,
                                   baseRevision: baseRevision)))
}

private func p8Catalog() -> ToolCatalogSnapshot {
    ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests.map {
        ToolCatalogEntry(manifest: $0, enabled: true)
    })
}

private func p8Manifest(id: String) -> ToolManifest {
    ToolManifest(id: ToolID(rawValue: id),
                 displayName: id,
                 shortDescription: "P8 verifier fixture",
                 category: .utility,
                 riskLevel: .localReadOnlyNoPrivateData,
                 permissionRequirement: .none,
                 inputSchema: .strictEmptyObject,
                 outputContract: ToolOutputContract(description: "fixture output"),
                 userVisibleExecutionSummary: "执行 \(id)")
}

private func p8ValidatedPlan() throws -> ValidatedTaskPlan {
    let tools = [p8Manifest(id: "fixture.read"), p8Manifest(id: "fixture.rank")]
    let snapshot = ToolCatalogSnapshot(entries: tools.map { ToolCatalogEntry(manifest: $0, enabled: true) })
    let steps = tools.enumerated().map { index, tool in
        RawTaskPlanStep(id: "s\(index)",
                        title: "Step \(index)",
                        tool: tool.id,
                        arguments: .object([:]),
                        dependsOn: index == 0 ? [] : ["s0"],
                        userVisibleSummary: "Step \(index)")
    }
    return try TaskPlanValidator.validate(RawTaskPlan(goalSummary: "P8 fixture", steps: steps),
                                          snapshot: snapshot,
                                          createdAt: Date(),
                                          limits: PlannerLimits(maxPlanSteps: 4),
                                          id: "p8-plan")
}

private func p8Observation(callID: String,
                           tool: String,
                           status: AgentLoopObservationStatus) -> AgentToolObservation {
    AgentToolObservation(callID: callID,
                         toolName: tool,
                         status: status,
                         content: .object(["status": .string(status.rawValue)]),
                         userSafeSummary: "\(tool) \(status.rawValue)")
}

private func p8EphemeralProposal() -> EphemeralToolProposal {
    let manifest = ToolManifest(id: "ephemeral.p8_sort_numbers",
                                displayName: "P8 sort numbers",
                                shortDescription: "Sorts task-scoped fixture numbers.",
                                category: .utility,
                                riskLevel: .externalSideEffectReversible,
                                permissionRequirement: .capability("filesystem.workspace.write"),
                                inputSchema: p8EphemeralInputSchema(),
                                outputContract: ToolOutputContract(description: "sorted numbers"),
                                executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 1),
                                userVisibleExecutionSummary: "运行 P8 临时工具")
    return EphemeralToolProposal(manifest: manifest,
                                 operation: .sortUniqueNumbers,
                                 source: "restrictedDataTransform sortUniqueNumbers",
                                 taskWorkspacePath: "/private/tmp/deskpet-p8-task",
                                 outputSchema: p8ItemsOutputSchema())
}

private func p8EphemeralInputSchema() -> ToolJSONSchema {
    ToolJSONSchema(type: .object,
                   properties: [
                    "items": ToolJSONSchema(type: .array,
                                            items: ToolJSONSchema(type: .number),
                                            minItems: 1,
                                            maxItems: 16),
                    "path": ToolJSONSchema(type: .string, minLength: 1, maxLength: 240),
                   ],
                   required: ["items", "path"],
                   additionalProperties: false)
}

private func p8ItemsOutputSchema() -> ToolJSONSchema {
    ToolJSONSchema(type: .object,
                   properties: [
                    "status": ToolJSONSchema(type: .string),
                    "items": ToolJSONSchema(type: .array,
                                            items: ToolJSONSchema(type: .number),
                                            minItems: 1,
                                            maxItems: 16),
                   ],
                   required: ["status", "items"],
                   additionalProperties: true)
}

private func p8EphemeralArguments() -> AgentJSONValue {
    .object([
        "items": .array([.number(3), .number(1), .number(3)]),
        "path": .string("/private/tmp/deskpet-p8-task/input.json"),
    ])
}
