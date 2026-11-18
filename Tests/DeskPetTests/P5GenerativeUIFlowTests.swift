import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime

final class P5GenerativeUIFlowTests: XCTestCase {
    func testExtendedSchemaComponentsValidate() {
        let document = p5Document(sections: [
            .init(id: "status", component: .status(.init(label: "正在核对", status: .loading))),
            .init(id: "progress", component: .progress(.init(label: "载入候选", value: 0.4))),
            .init(id: "choice", component: .choiceList(.init(choices: [
                .init(id: "chengdu-house", title: "Chengdu House", subtitle: "川菜", badge: "候选")
            ]))),
            .init(id: "cards", component: .cardGrid(.init(cards: [
                .init(id: "card-1", title: "Chengdu House", attributes: [
                    .init(id: "rating", key: "评分", value: "4.6")
                ])
            ]))),
            .init(id: "comparison", component: .comparisonList(.init(items: [
                .init(id: "cmp-1", title: "近", attributes: [
                    .init(id: "distance", key: "距离", value: "1.2 km")
                ])
            ]))),
            .init(id: "form", component: .form(.init(fields: [
                .init(id: "party", label: "人数", value: "2", required: true)
            ]))),
            .init(id: "confirm", component: .confirmation(.init(message: "是否继续？"))),
            .init(id: "map", component: .map(.init(title: "候选位置",
                                                    center: .init(latitude: 30.65, longitude: 104.07),
                                                    points: [
                                                        .init(id: "p1", title: "Chengdu House",
                                                              coordinate: .init(latitude: 30.66, longitude: 104.06))
                                                    ]))),
            .init(id: "chart", component: .chart(.init(kind: .bar, series: [
                .init(id: "score", name: "综合评分", values: [
                    .init(id: "taste", label: "口味", value: 4.6)
                ])
            ]))),
            .init(id: "artifact", component: .artifact(.init(title: "候选清单",
                                                             kind: "json",
                                                             url: "https://example.com/result.json"))),
            .init(id: "empty", component: .emptyState(.init(message: "暂无更多候选")))
        ])

        let result = AgentResultValidator.validate(document, toolCatalog: p5Catalog())
        XCTAssertTrue(result.accepted, "\(result.issues)")
    }

    func testInvalidSchemaRejectsUnsafeValues() {
        let document = p5Document(sections: [
            .init(id: "bad-progress", component: .progress(.init(label: "bad", value: 1, total: 0))),
            .init(id: "bad-map", component: .map(.init(center: .init(latitude: 91, longitude: 0)))),
            .init(id: "bad-chart", component: .chart(.init(kind: .bar, series: [
                .init(id: "bad", name: "bad", values: [
                    .init(id: "nan", label: "nan", value: Double.nan)
                ])
            ])))
        ])

        let result = AgentResultValidator.validate(document, toolCatalog: p5Catalog())
        XCTAssertFalse(result.accepted)
        XCTAssertTrue(result.issues.contains { $0.message == "invalid progress" })
        XCTAssertTrue(result.issues.contains { $0.message == "invalid coordinate" })
        XCTAssertTrue(result.issues.contains { $0.message == "invalid chart value" })
    }

    func testPatchRejectsOutOfOrderRevisionAndKeepsSnapshot() {
        let snapshot = p5Document(revision: 1, sections: [
            .init(id: "summary", component: .text(.init("原始结果")))
        ])
        let patch = AgentResultPatch(documentID: snapshot.id,
                                     taskID: snapshot.taskID,
                                     runID: snapshot.runID,
                                     baseRevision: 0,
                                     revision: 2,
                                     operations: [.setSummary("不应应用")])

        let applied = AgentResultPatchReducer.apply(patch, to: snapshot, toolCatalog: p5Catalog())
        XCTAssertFalse(applied.accepted)
        XCTAssertEqual(applied.document.summary, snapshot.summary)
        XCTAssertTrue(applied.issues.contains { $0.message == "patch revision mismatch" })
    }

    func testChoiceFlowStreamsPatchesRecordsInteractionAndReplaysResolvedSummary() {
        let taskID = UUID()
        let runID = UUID()
        let snapshot = p5Document(taskID: taskID, runID: runID, revision: 0, status: .loading, sections: [
            .init(id: "skeleton", state: .init(kind: .streaming, summary: "正在核对候选"),
                  component: .emptyState(.init(message: "正在核对候选")))
        ])
        let choiceSection = AgentResultSection(
            id: "restaurant-choice",
            title: "选择餐厅",
            state: .init(kind: .unverified, summary: "候选仍在核对"),
            component: .choiceList(.init(choices: [
                .init(id: "chengdu-house", title: "Chengdu House", subtitle: "川菜"),
                .init(id: "mala-room", title: "Mala Room", subtitle: "火锅")
            ])))
        let fillPatch = AgentResultPatch(documentID: snapshot.id,
                                         taskID: taskID,
                                         runID: runID,
                                         baseRevision: 0,
                                         revision: 1,
                                         operations: [
                                            .removeSection(id: "skeleton"),
                                            .upsertSection(choiceSection),
                                            .setStatus(.partial),
                                            .setSummary("已找到 2 个候选，正在等待选择")
                                         ])
        let filled = AgentResultPatchReducer.apply(fillPatch, to: snapshot, toolCatalog: p5Catalog())
        XCTAssertTrue(filled.accepted, "\(filled.issues)")

        let interaction = AgentResultInteractionEvent(taskID: taskID,
                                                      runID: runID,
                                                      documentID: snapshot.id,
                                                      componentID: "restaurant-choice",
                                                      actionID: "chengdu-house",
                                                      payload: .object([
                                                        "choiceID": .string("chengdu-house"),
                                                        "title": .string("Chengdu House")
                                                      ]))
        let resolvePatch = AgentResultPatch(documentID: snapshot.id,
                                            taskID: taskID,
                                            runID: runID,
                                            baseRevision: 1,
                                            revision: 2,
                                            operations: [
                                                .resolveChoice(componentID: "restaurant-choice",
                                                               choiceID: "chengdu-house",
                                                               summary: "已选择：Chengdu House"),
                                                .setStatus(.completed),
                                                .setSummary("已选择 Chengdu House")
                                            ])
        let resolved = AgentResultPatchReducer.apply(resolvePatch, to: filled.document, toolCatalog: p5Catalog())
        XCTAssertTrue(resolved.accepted, "\(resolved.issues)")

        let envelopes = [
            resultEnvelope(kind: .resultSnapshot, document: snapshot, sequence: 0),
            resultEnvelope(kind: .resultPatch, document: filled.document, sequence: 1, baseRevision: 0),
            interaction.envelope(sequence: 2),
            resultEnvelope(kind: .resultPatch, document: resolved.document, sequence: 3, baseRevision: 1),
            AgentEventEnvelope(taskID: taskID, runID: runID, sequence: 4,
                               source: .runtime, kind: .taskSucceeded,
                               payload: .task(.init(title: "任务已完成")))
        ]
        let activityEvents = envelopes.map(AgentTaskActivityEvent.init(eventEnvelope:))
        let activity = AgentTaskActivityReducer.reduce(taskID: taskID, events: activityEvents)
        let projection = AgentTaskProjectionReducer.reduce(envelopes: envelopes)

        XCTAssertEqual(activity.latestRun?.status, .succeeded)
        XCTAssertEqual(activity.latestRun?.resultDocument?.revision, 2)
        XCTAssertEqual(projection.task(id: taskID)?.latestRun?.resultDocument?.revision, 2)
        XCTAssertTrue(activity.latestRun?.resultDocument?.sections.contains {
            $0.id == "restaurant-choice" && $0.state?.kind == .collapsed && $0.state?.summary == "已选择：Chengdu House"
        } ?? false)
    }

    func testPostTerminalPatchUpdatesResultWithoutChangingTerminalState() {
        let taskID = UUID()
        let runID = UUID()
        let snapshot = p5Document(taskID: taskID, runID: runID, revision: 0, status: .completed, sections: [
            .init(id: "restaurant-choice", component: .choiceList(.init(choices: [
                .init(id: "chengdu-house", title: "Chengdu House")
            ])))
        ])
        let patch = AgentResultPatch(documentID: snapshot.id,
                                     taskID: taskID,
                                     runID: runID,
                                     baseRevision: 0,
                                     revision: 1,
                                     operations: [
                                        .resolveChoice(componentID: "restaurant-choice",
                                                       choiceID: "chengdu-house",
                                                       summary: "已选择：Chengdu House")
                                     ])
        let applied = AgentResultPatchReducer.apply(patch, to: snapshot, toolCatalog: p5Catalog())
        XCTAssertTrue(applied.accepted, "\(applied.issues)")

        let events = [
            resultEnvelope(kind: .resultSnapshot, document: snapshot, sequence: 0),
            AgentEventEnvelope(taskID: taskID, runID: runID, sequence: 1,
                               source: .runtime, kind: .taskSucceeded,
                               payload: .task(.init(title: "任务已完成"))),
            resultEnvelope(kind: .resultPatch, document: applied.document, sequence: 2, baseRevision: 0)
        ].map(AgentTaskActivityEvent.init(eventEnvelope:))
        let run = AgentTaskActivityReducer.reduce(taskID: taskID, events: events).latestRun
        XCTAssertEqual(run?.status, .succeeded)
        XCTAssertEqual(run?.resultDocument?.revision, 1)
    }

    private func p5Document(taskID: UUID = UUID(),
                            runID: UUID = UUID(),
                            revision: Int = 0,
                            status: AgentResultStatus = .completed,
                            sections: [AgentResultSection]) -> AgentResultDocument {
        AgentResultDocument(id: "p5-choice-result",
                            taskID: taskID,
                            runID: runID,
                            revision: revision,
                            title: "餐厅候选",
                            summary: "fixture-based UI 验收",
                            status: status,
                            generatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                            sections: sections)
    }

    private func resultEnvelope(kind: AgentEventKind,
                                document: AgentResultDocument,
                                sequence: UInt64,
                                baseRevision: Int? = nil) -> AgentEventEnvelope {
        AgentEventEnvelope(taskID: document.taskID,
                           runID: document.runID,
                           sequence: sequence,
                           source: .runtime,
                           kind: kind,
                           payload: .result(.init(title: document.title,
                                                   summary: document.summary,
                                                   document: document,
                                                   eventKind: kind == .resultPatch ? .patch : .snapshot,
                                                   baseRevision: baseRevision)))
    }

    private func p5Catalog() -> ToolCatalogSnapshot {
        ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests.map {
            ToolCatalogEntry(manifest: $0, enabled: true)
        })
    }
}
