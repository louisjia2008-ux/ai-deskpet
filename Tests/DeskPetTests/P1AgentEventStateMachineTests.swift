import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime

final class P1AgentEventStateMachineTests: XCTestCase {
    func testStreamEventLiftsMessageMetadataAndRoundTripsEnvelopeKind() {
        let taskID = UUID()
        let runID = UUID()
        let conversationID = UUID()
        let userMessageID = UUID()
        let assistantMessageID = UUID()
        let parentEventID = UUID()
        let envelope = AgentEventEnvelope(
            taskID: taskID,
            runID: runID,
            sequence: 7,
            source: .provider,
            kind: .modelResponseStreaming,
            payload: .task(.init(title: "回复中",
                                 status: "streaming",
                                 currentStep: "model",
                                 conversationID: conversationID,
                                 userMessageID: userMessageID,
                                 origin: AgentTaskOrigin.chat.rawValue,
                                 providerKind: "ollama",
                                 modelID: "qwen")))

        let stream = AgentStreamEvent(envelope: envelope,
                                      assistantMessageID: assistantMessageID,
                                      agentID: "planner#1",
                                      parentEventID: parentEventID)

        XCTAssertEqual(stream.kind, .modelDelta)
        XCTAssertEqual(stream.taskID, taskID)
        XCTAssertEqual(stream.runID, runID)
        XCTAssertEqual(stream.conversationID, conversationID)
        XCTAssertEqual(stream.userMessageID, userMessageID)
        XCTAssertEqual(stream.assistantMessageID, assistantMessageID)
        XCTAssertEqual(stream.parentEventID, parentEventID)
        XCTAssertEqual(stream.agentID, "planner_1")
        XCTAssertEqual(stream.envelope().kind, .modelResponseStreaming)
    }

    func testProjectionReducerUsesTargetStatesAndRejectsPostTerminalEvents() {
        let taskID = UUID()
        let runID = UUID()
        let result = AgentResultDocument(
            id: "result-1",
            taskID: taskID,
            runID: runID,
            title: "结果",
            summary: "已完成",
            status: .completed,
            generatedAt: Date(timeIntervalSince1970: 7),
            sections: [
                AgentResultSection(id: "summary", component: .text(.init("完成")))
            ])
        let events = [
            p1Stream(.taskCreated, taskID: taskID, runID: runID, sequence: 0),
            p1Stream(.taskQueued, taskID: taskID, runID: runID, sequence: 1),
            p1Stream(.modelRequestStarted, taskID: taskID, runID: runID, sequence: 2),
            p1Stream(.toolApprovalRequired, taskID: taskID, runID: runID, sequence: 3),
            p1Stream(.toolApprovalGranted, taskID: taskID, runID: runID, sequence: 4),
            p1Stream(.toolStarted, taskID: taskID, runID: runID, sequence: 5,
                     payload: .tool(.init(toolID: "get_current_datetime",
                                          toolCallID: "call-1",
                                          displayName: "Current Date"))),
            p1Stream(.toolObservation, taskID: taskID, runID: runID, sequence: 6),
            p1Stream(.modelDelta, taskID: taskID, runID: runID, sequence: 7),
            p1Stream(.resultSnapshot, taskID: taskID, runID: runID, sequence: 8,
                     payload: .result(.init(title: result.title, summary: result.summary, document: result))),
            p1Stream(.taskCompleted, taskID: taskID, runID: runID, sequence: 9),
            p1Stream(.modelDelta, taskID: taskID, runID: runID, sequence: 10),
        ]

        let projection = AgentTaskProjectionReducer.reduce(streamEvents: events)
        let run = projection.run(id: runID)

        XCTAssertEqual(run?.state, .succeeded)
        XCTAssertEqual(run?.events.map(\.sequence), Array(0...9).map(UInt64.init))
        XCTAssertEqual(run?.resultDocument?.id, result.id)
        XCTAssertNil(run?.currentStepTitle)
        XCTAssertEqual(projection.terminalTasks.map(\.taskID), [taskID])
        XCTAssertTrue(projection.activeTasks.isEmpty)
    }

    @MainActor
    func testActivityStoreMaintainsCanonicalProjectionFromSharedEvents() {
        let store = AgentTaskActivityStore(persistence: nil)
        let taskID = UUID()
        let runID = UUID()
        let events = [
            p1Activity(.taskCreated, taskID: taskID, runID: runID, sequence: 0),
            p1Activity(.approvalRequested, taskID: taskID, runID: runID, sequence: 1),
        ]

        events.forEach { store.publish(AgentEventEnvelope(activityEvent: $0)) }

        XCTAssertEqual(store.task(id: taskID)?.latestRun?.status, .waitingForApproval)
        XCTAssertEqual(store.canonicalTask(id: taskID)?.latestRun?.state, .awaitingApproval)
        XCTAssertEqual(store.waitingTasks.map(\.taskID), [taskID])
        XCTAssertTrue(store.canonicalTasks.first?.latestRun?.isWaiting == true)

        store.publish(AgentEventEnvelope(activityEvent: p1Activity(.approvalGranted, taskID: taskID, runID: runID, sequence: 2)))
        store.publish(AgentEventEnvelope(activityEvent: p1Activity(.stepStarted, taskID: taskID, runID: runID, sequence: 3)))
        store.publish(AgentEventEnvelope(activityEvent: p1Activity(.taskSucceeded, taskID: taskID, runID: runID, sequence: 4)))

        XCTAssertEqual(store.task(id: taskID)?.latestRun?.status, .succeeded)
        XCTAssertEqual(store.canonicalTask(id: taskID)?.latestRun?.state, .succeeded)
        XCTAssertTrue(store.activeTasks.isEmpty)
        XCTAssertTrue(store.canonicalTasks.first?.latestRun?.isTerminal == true)
    }

    private func p1Stream(_ kind: AgentStreamEventKind,
                          taskID: UUID,
                          runID: UUID,
                          sequence: UInt64,
                          payload: AgentEventPayload = .empty) -> AgentStreamEvent {
        AgentStreamEvent(taskID: taskID,
                         runID: runID,
                         sequence: sequence,
                         timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)),
                         source: .runtime,
                         kind: kind,
                         payload: payload)
    }

    private func p1Activity(_ kind: AgentTaskEventKind,
                            taskID: UUID,
                            runID: UUID,
                            sequence: Int) -> AgentTaskActivityEvent {
        AgentTaskActivityEvent(taskID: taskID,
                               runID: runID,
                               sequenceNumber: sequence,
                               timestamp: Date(timeIntervalSince1970: TimeInterval(sequence)),
                               kind: kind,
                               presentation: .init(title: kind.rawValue))
    }
}
