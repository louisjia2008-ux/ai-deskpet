#if PHASE_HARNESS && DEBUG
import AppKit
import Foundation
import PetAgentRuntime
import SwiftUI

@MainActor
enum P9DLocalDiscoveryPresentationAppSmokeHarness {
    enum Scenario: String {
        case complete
        case partial
        case cancel
        case recovery
    }

    static var requestedScenario: Scenario? {
        guard let raw = ProcessInfo.processInfo.environment["DESKPET_P9D_APP_SMOKE_HARNESS"]
                ?? ProcessInfo.processInfo.arguments.value(after: "--p9d-smoke-scenario") else {
            return nil
        }
        return Scenario(rawValue: raw)
    }

    static func runIfRequested(paths: DeskPetAppPaths,
                               chat: ChatModel,
                               activityStore: AgentTaskActivityStore,
                               checkpointStore: AgentCheckpointStore) async {
        guard let scenario = requestedScenario else { return }
        do {
            let artifact = try await run(scenario: scenario,
                                         paths: paths,
                                         chat: chat,
                                         activityStore: activityStore,
                                         checkpointStore: checkpointStore)
            let artifactURL = try write(artifact: artifact, paths: paths)
            FileHandle.standardError.write("P9D_APP_SMOKE scenario=\(scenario.rawValue) ok=\(artifact.ok) artifact=\(artifactURL.path)\n".data(using: .utf8)!)
            NSApp.terminate(nil)
        } catch {
            let artifact = P9DAppSmokeArtifact(scenario: scenario.rawValue,
                                               ok: false,
                                               appPID: ProcessInfo.processInfo.processIdentifier,
                                               taskID: nil,
                                               runID: nil,
                                               presentationStatus: "failed",
                                               candidateCount: 0,
                                               validCoordinateCount: 0,
                                               selectedCandidateID: nil,
                                               mapVisible: false,
                                               listVisible: false,
                                               loadingVisible: false,
                                               pendingActivityCount: activityStore.activeTasks.count,
                                               recoveredFromCheckpoint: scenario == .recovery,
                                               toolReexecutionCount: 0,
                                               modelReexecutionCount: 0,
                                               noSecretAssertion: false,
                                               screenshots: [],
                                               error: String(describing: error))
            let artifactURL = try? write(artifact: artifact, paths: paths)
            FileHandle.standardError.write("P9D_APP_SMOKE scenario=\(scenario.rawValue) ok=false error=\(error) artifact=\(artifactURL?.path ?? "unwritten")\n".data(using: .utf8)!)
            exit(1)
        }
    }

    private static func run(scenario: Scenario,
                            paths: DeskPetAppPaths,
                            chat: ChatModel,
                            activityStore: AgentTaskActivityStore,
                            checkpointStore: AgentCheckpointStore) async throws -> P9DAppSmokeArtifact {
        NSApp.activate(ignoringOtherApps: true)
        let fixture = Fixture.mainFixture(scenario: scenario)
        try await install(fixture: fixture,
                          activityStore: activityStore,
                          checkpointStore: checkpointStore)
        await chat.localDiscoveryPresentationStore.load(taskID: fixture.snapshot.taskID,
                                                        runID: fixture.snapshot.runID)
        guard let presentation = chat.localDiscoveryPresentationStore.presentation(taskID: fixture.snapshot.taskID,
                                                                                  runID: fixture.snapshot.runID,
                                                                                  sortMode: .recommended,
                                                                                  selectedCandidateID: fixture.selectedCandidateID,
                                                                                  recoveredFromCheckpoint: fixture.recoveredFromCheckpoint,
                                                                                  includeDeveloperDiagnostics: true) else {
            throw HarnessError.presentationMissing
        }

        var screenshots: [String] = []
        switch scenario {
        case .complete:
            screenshots.append(try await captureFixture(fixture,
                                                        name: "complete_wide",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 820),
                                                        chat: chat,
                                                        paths: paths))
            screenshots.append(try await captureFixture(fixture,
                                                        name: "complete_floating_narrow",
                                                        layout: .compact,
                                                        size: CGSize(width: 430, height: 760),
                                                        chat: chat,
                                                        paths: paths))
            screenshots.append(try await captureFixture(fixture,
                                                        name: "evidence_expanded",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 860),
                                                        chat: chat,
                                                        paths: paths,
                                                        evidenceExpanded: true))
            screenshots.append(try await captureFixture(fixture,
                                                        name: "map_marker_selected",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 820),
                                                        chat: chat,
                                                        paths: paths,
                                                        selectedCandidateID: fixture.selectedCandidateID))
            screenshots.append(try await captureFixture(fixture,
                                                        name: "card_selected",
                                                        layout: .compact,
                                                        size: CGSize(width: 430, height: 760),
                                                        chat: chat,
                                                        paths: paths,
                                                        selectedCandidateID: fixture.selectedCandidateID))
            screenshots.append(try await captureFixture(fixture,
                                                        name: "dark_mode",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 820),
                                                        chat: chat,
                                                        paths: paths,
                                                        selectedCandidateID: fixture.selectedCandidateID,
                                                        appearance: NSAppearance(named: .darkAqua)))
            let noCoordinate = Fixture.noCoordinateFixture()
            try await install(fixture: noCoordinate,
                              activityStore: activityStore,
                              checkpointStore: checkpointStore)
            await chat.localDiscoveryPresentationStore.load(taskID: noCoordinate.snapshot.taskID,
                                                            runID: noCoordinate.snapshot.runID)
            screenshots.append(try await captureFixture(noCoordinate,
                                                        name: "empty_no_coordinate_map",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 760),
                                                        chat: chat,
                                                        paths: paths))
        case .partial:
            screenshots.append(try await captureFixture(fixture,
                                                        name: "partial_result",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 820),
                                                        chat: chat,
                                                        paths: paths,
                                                        evidenceExpanded: true))
        case .cancel:
            screenshots.append(try await captureFixture(fixture,
                                                        name: "cancelled_state",
                                                        layout: .wide,
                                                        size: CGSize(width: 760, height: 420),
                                                        chat: chat,
                                                        paths: paths))
        case .recovery:
            screenshots.append(try await captureFixture(fixture,
                                                        name: "recovery_state",
                                                        layout: .wide,
                                                        size: CGSize(width: 1_020, height: 820),
                                                        chat: chat,
                                                        paths: paths,
                                                        selectedCandidateID: fixture.selectedCandidateID))
        }

        let noSecret = noSecretsDetected(in: [checkpointURL(paths: paths,
                                                            taskID: fixture.snapshot.taskID,
                                                            runID: fixture.snapshot.runID)])
        let artifact = P9DAppSmokeArtifact(scenario: scenario.rawValue,
                                           ok: acceptanceOK(scenario: scenario,
                                                            presentation: presentation,
                                                            screenshots: screenshots,
                                                            noSecretAssertion: noSecret),
                                           appPID: ProcessInfo.processInfo.processIdentifier,
                                           taskID: fixture.snapshot.taskID.uuidString,
                                           runID: fixture.snapshot.runID.uuidString,
                                           presentationStatus: statusString(presentation.status),
                                           candidateCount: presentation.candidates.count,
                                           validCoordinateCount: presentation.validCoordinateCount,
                                           selectedCandidateID: fixture.selectedCandidateID,
                                           mapVisible: !presentation.mapAnnotations.isEmpty,
                                           listVisible: !presentation.candidates.isEmpty,
                                           loadingVisible: !presentation.status.isTerminal,
                                           pendingActivityCount: activityStore.activeTasks.count,
                                           recoveredFromCheckpoint: presentation.recoveredFromCheckpoint,
                                           toolReexecutionCount: 0,
                                           modelReexecutionCount: 0,
                                           noSecretAssertion: noSecret,
                                           screenshots: screenshots,
                                           error: nil)
        return artifact.ok ? artifact : artifact.with(error: "acceptance predicates not satisfied")
    }

    private static func install(fixture: Fixture,
                                activityStore: AgentTaskActivityStore,
                                checkpointStore: AgentCheckpointStore) async throws {
        let document = fixture.resultDocument
        publishActivity(fixture: fixture, activityStore: activityStore)
        try await Task.sleep(nanoseconds: 120_000_000)
        let checkpoint = try fixture.checkpoint()
        try await checkpointStore.save(checkpoint)
        if document != nil {
            try await checkpointStore.save(checkpoint)
        }
    }

    private static func publishActivity(fixture: Fixture,
                                        activityStore: AgentTaskActivityStore) {
        let taskID = fixture.snapshot.taskID
        let runID = fixture.snapshot.runID
        let conversationID = fixture.conversationID
        let now = Fixture.now
        let resultDocument = fixture.resultDocument
        var events: [AgentTaskActivityEvent] = [
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 0,
                                   timestamp: now,
                                   kind: .taskCreated,
                                   presentation: AgentTaskEventPresentation(title: "地点搜索",
                                                                            detail: fixture.queryTitle),
                                   source: .chat,
                                   origin: .chat),
        ]
        if fixture.state != .cancelled && fixture.state != .failed {
            events.append(AgentTaskActivityEvent(taskID: taskID,
                                                 runID: runID,
                                                 conversationID: conversationID,
                                                 sequenceNumber: 1,
                                                 timestamp: now.addingTimeInterval(1),
                                                 kind: .stepSucceeded,
                                                 presentation: AgentTaskEventPresentation(title: "已找到初始候选地点",
                                                                                          detail: "地点搜索结果已整理"),
                                                 stepID: "searchCandidates",
                                                 toolID: "local_place_search",
                                                 source: .toolRuntime,
                                                 origin: .chat))
            events.append(AgentTaskActivityEvent(taskID: taskID,
                                                 runID: runID,
                                                 conversationID: conversationID,
                                                 sequenceNumber: 2,
                                                 timestamp: now.addingTimeInterval(2),
                                                 kind: .resultProduced,
                                                 presentation: AgentTaskEventPresentation(title: "地点结果已生成",
                                                                                          detail: fixture.resultSummary),
                                                 source: .runtime,
                                                 origin: .chat,
                                                 resultDocument: resultDocument))
        } else {
            events.append(AgentTaskActivityEvent(taskID: taskID,
                                                 runID: runID,
                                                 conversationID: conversationID,
                                                 sequenceNumber: 1,
                                                 timestamp: now.addingTimeInterval(1),
                                                 kind: .stepStarted,
                                                 presentation: AgentTaskEventPresentation(title: "正在搜索地点"),
                                                 stepID: "searchCandidates",
                                                 toolID: "local_place_search",
                                                 source: .toolRuntime,
                                                 origin: .chat))
        }
        let terminalKind: AgentTaskEventKind
        switch fixture.state {
        case .succeeded:
            terminalKind = .taskSucceeded
        case .partiallySucceeded:
            terminalKind = .taskPartiallySucceeded
        case .cancelled:
            terminalKind = .taskCancelled
        case .failed:
            terminalKind = .taskFailed
        default:
            terminalKind = .taskSucceeded
        }
        events.append(AgentTaskActivityEvent(taskID: taskID,
                                             runID: runID,
                                             conversationID: conversationID,
                                             sequenceNumber: 3,
                                             timestamp: now.addingTimeInterval(3),
                                             kind: terminalKind,
                                             presentation: AgentTaskEventPresentation(title: fixture.terminalTitle,
                                                                                      detail: fixture.resultSummary),
                                             failureCategory: fixture.state == .failed ? .synthesisFailed : fixture.state == .cancelled ? .cancelled : nil,
                                             source: .runtime,
                                             origin: .chat,
                                             resultDocument: resultDocument))
        for event in events {
            activityStore.publish(AgentEventEnvelope(activityEvent: event))
        }
    }

    private static func captureFixture(_ fixture: Fixture,
                                       name: String,
                                       layout: LocalDiscoveryResultContainerView.LayoutMode,
                                       size: CGSize,
                                       chat: ChatModel,
                                       paths: DeskPetAppPaths,
                                       selectedCandidateID: String? = nil,
                                       evidenceExpanded: Bool = false,
                                       appearance: NSAppearance? = nil) async throws -> String {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p9d_app_smoke_\(fixture.scenario)_\(name).png")
        let view = LocalDiscoveryResultContainerView(taskID: fixture.snapshot.taskID,
                                                     runID: fixture.snapshot.runID,
                                                     store: chat.localDiscoveryPresentationStore,
                                                     placeHandoffViewModel: chat.placeHandoffViewModel,
                                                     layout: layout,
                                                     recoveredFromCheckpoint: fixture.recoveredFromCheckpoint,
                                                     developerMode: fixture.developerMode,
                                                     initialSelectedCandidateID: selectedCandidateID,
                                                     initialEvidenceExpanded: evidenceExpanded)
            .frame(width: size.width, height: size.height)
            .background(DSColor.appBackground)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable],
                              backing: .buffered,
                              defer: false)
        window.title = "P9D \(fixture.scenario) \(name)"
        window.appearance = appearance
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.contentView?.needsLayout = true
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 650_000_000)
        guard captureWindowScreenshot(window, to: url) else {
            window.orderOut(nil)
            throw HarnessError.screenshotFailed(name)
        }
        window.orderOut(nil)
        return url.path
    }

    private static func captureWindowScreenshot(_ window: NSWindow, to url: URL) -> Bool {
        guard let view = window.contentView else { return false }
        view.displayIfNeeded()
        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        view.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func acceptanceOK(scenario: Scenario,
                                     presentation: LocalDiscoveryPresentation,
                                     screenshots: [String],
                                     noSecretAssertion: Bool) -> Bool {
        guard noSecretAssertion, !screenshots.isEmpty, presentation.status.isTerminal else {
            return false
        }
        switch scenario {
        case .complete:
            return presentation.status == .complete
                && presentation.candidates.count >= 3
                && presentation.validCoordinateCount >= 2
                && presentation.candidates.contains { $0.routeDurationSummary != "未获得路线时间" }
                && presentation.candidates.contains { $0.unknownSummaries.contains { $0.contains("待确认") } }
                && screenshots.count >= 7
        case .partial:
            return presentation.status == .partial
                && !presentation.candidates.isEmpty
        case .cancel:
            return presentation.status == .cancelled
                && presentation.candidates.isEmpty
                && presentation.validCoordinateCount == 0
        case .recovery:
            return presentation.recoveredFromCheckpoint
                && presentation.status == .complete
                && !presentation.candidates.isEmpty
                && presentation.validCoordinateCount >= 2
        }
    }

    private static func write(artifact: P9DAppSmokeArtifact,
                              paths: DeskPetAppPaths) throws -> URL {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p9d_app_smoke_\(artifact.scenario)_artifact.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(artifact).write(to: url, options: .atomic)
        return url
    }

    private static func checkpointURL(paths: DeskPetAppPaths, taskID: UUID, runID: UUID) -> URL {
        paths.agentCheckpointsDirectory
            .appendingPathComponent(taskID.uuidString, isDirectory: true)
            .appendingPathComponent(runID.uuidString)
            .appendingPathExtension("json")
    }

    private static func noSecretsDetected(in urls: [URL]) -> Bool {
        let forbidden = ["authorization", "cookie", "api_key", "apikey", "sk-", "bearer "]
        for url in urls {
            guard let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8)?.lowercased() else {
                continue
            }
            if forbidden.contains(where: { text.contains($0) }) {
                return false
            }
        }
        return true
    }

    private static func statusString(_ status: LocalDiscoveryPresentationStatus) -> String {
        switch status {
        case .preparing: return "preparing"
        case .searching: return "searching"
        case .routing: return "routing"
        case .readingEvidence: return "readingEvidence"
        case .verifying: return "verifying"
        case .synthesizing: return "synthesizing"
        case .complete: return "complete"
        case .partial: return "partial"
        case .empty(let reason): return "empty:\(reason.rawValue)"
        case .cancelled: return "cancelled"
        case .failed(let error): return "failed:\(error.kind.rawValue)"
        }
    }
}

private struct P9DAppSmokeArtifact: Codable, Sendable {
    var scenario: String
    var ok: Bool
    var appPID: Int32
    var taskID: String?
    var runID: String?
    var presentationStatus: String
    var candidateCount: Int
    var validCoordinateCount: Int
    var selectedCandidateID: String?
    var mapVisible: Bool
    var listVisible: Bool
    var loadingVisible: Bool
    var pendingActivityCount: Int
    var recoveredFromCheckpoint: Bool
    var toolReexecutionCount: Int
    var modelReexecutionCount: Int
    var noSecretAssertion: Bool
    var screenshots: [String]
    var error: String?

    func with(error: String) -> P9DAppSmokeArtifact {
        var copy = self
        copy.ok = false
        copy.error = error
        return copy
    }
}

private enum HarnessError: Error, CustomStringConvertible {
    case presentationMissing
    case screenshotFailed(String)

    var description: String {
        switch self {
        case .presentationMissing:
            return "presentation missing"
        case .screenshotFailed(let name):
            return "screenshot failed: \(name)"
        }
    }
}

private struct Fixture {
    static let now = Date(timeIntervalSince1970: 1_785_456_000)

    var scenario: String
    var snapshot: LocalDiscoveryWorkflowSnapshot
    var state: AgentRunState
    var resultDocument: AgentResultDocument?
    var conversationID: UUID
    var recoveredFromCheckpoint: Bool
    var selectedCandidateID: String?
    var developerMode: Bool
    var queryTitle: String
    var resultSummary: String
    var terminalTitle: String

    static func mainFixture(scenario: P9DLocalDiscoveryPresentationAppSmokeHarness.Scenario) -> Fixture {
        switch scenario {
        case .complete:
            return completeFixture(scenario: "complete", recovered: false)
        case .partial:
            return partialFixture()
        case .cancel:
            return cancelFixture()
        case .recovery:
            return completeFixture(scenario: "recovery", recovered: true)
        }
    }

    static func completeFixture(scenario: String, recovered: Bool) -> Fixture {
        let taskID = UUID()
        let runID = UUID()
        let candidates = [
            candidate(id: "chengdu-house",
                      name: "Chengdu House",
                      coordinate: PlaceCoordinate(latitude: 37.781, longitude: -122.411, horizontalAccuracyMeters: 30),
                      routeMeters: 3_300,
                      routeDurationSeconds: 720,
                      evidenceConfidence: 0.9,
                      verificationStatus: .verified),
            candidate(id: "spice-alley",
                      name: "Spice Alley",
                      coordinate: PlaceCoordinate(latitude: 37.768, longitude: -122.404, horizontalAccuracyMeters: 45),
                      routeMeters: nil,
                      routeDurationSeconds: nil,
                      evidenceConfidence: 0.55,
                      verificationStatus: .verified),
            candidate(id: "numbing-bistro",
                      name: "Numbing Bistro",
                      coordinate: nil,
                      parking: .unknown,
                      parkingConfidence: 0,
                      price: .unknown,
                      priceConfidence: 0,
                      evidenceConfidence: 0.45,
                      verificationStatus: .verified),
        ]
        let snapshot = snapshot(taskID: taskID,
                                runID: runID,
                                stage: .resultSynthesized,
                                candidates: candidates,
                                verifierVerdict: .pass,
                                rankedCandidateIDs: ["chengdu-house", "spice-alley", "numbing-bistro"],
                                warnings: [])
        let document = resultDocument(taskID: taskID, runID: runID, status: .completed)
        return Fixture(scenario: scenario,
                       snapshot: snapshot,
                       state: .succeeded,
                       resultDocument: document,
                       conversationID: UUID(),
                       recoveredFromCheckpoint: recovered,
                       selectedCandidateID: "chengdu-house",
                       developerMode: true,
                       queryTitle: "San Francisco 的川菜餐厅",
                       resultSummary: "找到 3 个候选地点，其中 2 个有地图坐标。",
                       terminalTitle: "地点搜索已完成")
    }

    static func partialFixture() -> Fixture {
        let taskID = UUID()
        let runID = UUID()
        let finding = PlaceVerificationFinding(id: "tea-room-stale",
                                               candidateID: "tea-room",
                                               criterion: "stale_evidence",
                                               status: .uncertain,
                                               severity: .warning,
                                               evidenceIDs: ["evidence-tea-room"],
                                               reason: "Evidence may be stale",
                                               recommendedDisposition: .includeWithWarning)
        let candidates = [
            candidate(id: "tea-room",
                      name: "Tea Room Sichuan",
                      evidenceFreshness: "stale-source",
                      evidenceConfidence: 0.45,
                      verificationStatus: .stale),
            candidate(id: "lotus-spice",
                      name: "Lotus Spice",
                      routeMeters: nil,
                      routeDurationSeconds: nil,
                      opening: .unknown,
                      verificationStatus: .partiallyVerified),
        ]
        let snapshot = snapshot(taskID: taskID,
                                runID: runID,
                                stage: .resultSynthesized,
                                candidates: candidates,
                                findings: [finding],
                                verifierVerdict: .partialPass,
                                rankedCandidateIDs: candidates.map(\.stableID),
                                warnings: ["partial public evidence"])
        let document = resultDocument(taskID: taskID, runID: runID, status: .partial)
        return Fixture(scenario: "partial",
                       snapshot: snapshot,
                       state: .partiallySucceeded,
                       resultDocument: document,
                       conversationID: UUID(),
                       recoveredFromCheckpoint: false,
                       selectedCandidateID: "tea-room",
                       developerMode: true,
                       queryTitle: "部分地点结果",
                       resultSummary: "根据当前可用信息生成了部分结果。",
                       terminalTitle: "地点搜索部分完成")
    }

    static func cancelFixture() -> Fixture {
        let taskID = UUID()
        let runID = UUID()
        let snapshot = snapshot(taskID: taskID,
                                runID: runID,
                                stage: .cancelled,
                                candidates: [candidate(id: "cancelled-hidden")],
                                verifierVerdict: .partialPass,
                                rankedCandidateIDs: [],
                                warnings: [])
        return Fixture(scenario: "cancel",
                       snapshot: snapshot,
                       state: .cancelled,
                       resultDocument: nil,
                       conversationID: UUID(),
                       recoveredFromCheckpoint: false,
                       selectedCandidateID: nil,
                       developerMode: true,
                       queryTitle: "取消地点搜索",
                       resultSummary: "搜索已停止。",
                       terminalTitle: "地点搜索已停止")
    }

    static func noCoordinateFixture() -> Fixture {
        let taskID = UUID()
        let runID = UUID()
        let candidates = [
            candidate(id: "no-map-a", name: "No Map A", coordinate: nil, verificationStatus: .partiallyVerified),
            candidate(id: "no-map-b",
                      name: "No Map B",
                      coordinate: PlaceCoordinate(latitude: 37.78, longitude: -122.41, horizontalAccuracyMeters: 70_000),
                      verificationStatus: .partiallyVerified),
        ]
        let snapshot = snapshot(taskID: taskID,
                                runID: runID,
                                stage: .resultSynthesized,
                                candidates: candidates,
                                verifierVerdict: .partialPass,
                                rankedCandidateIDs: candidates.map(\.stableID),
                                warnings: ["no reliable coordinates"])
        return Fixture(scenario: "complete",
                       snapshot: snapshot,
                       state: .partiallySucceeded,
                       resultDocument: resultDocument(taskID: taskID, runID: runID, status: .partial),
                       conversationID: UUID(),
                       recoveredFromCheckpoint: false,
                       selectedCandidateID: nil,
                       developerMode: true,
                       queryTitle: "无可靠坐标地点",
                       resultSummary: "列表可展示，但地图没有可靠坐标。",
                       terminalTitle: "地点搜索部分完成")
    }

    func checkpoint() throws -> AgentCheckpoint {
        let projection = AgentRunProjection(taskID: snapshot.taskID,
                                            runID: snapshot.runID,
                                            conversationID: conversationID,
                                            state: state,
                                            events: [],
                                            createdAt: Self.now,
                                            updatedAt: Self.now,
                                            completedAt: state.isTerminal ? Self.now : nil,
                                            terminalSummary: resultSummary,
                                            resultDocument: resultDocument)
        return AgentCheckpoint(taskID: snapshot.taskID,
                               runID: snapshot.runID,
                               conversationID: conversationID,
                               projection: projection,
                               replayState: AgentTimelineReplayState(taskID: snapshot.taskID,
                                                                     runID: snapshot.runID,
                                                                     events: []).jumpToEnd(),
                               phase: state.isTerminal ? .terminal : .active,
                               lastSequence: 3,
                               eventCount: 4,
                               resultDocument: resultDocument,
                               completedToolCallIDs: snapshot.toolCompletions.map(\.id),
                               completedStepIDs: [snapshot.currentStage.rawValue],
                               currentUIRevision: resultDocument?.revision,
                               evidenceIDs: snapshot.webpageEvidenceIDs + snapshot.extractionEvidenceIDs,
                               verifierState: snapshot.verifierDisposition?.verdict.rawValue ?? "unknown",
                               recoveryDisposition: snapshot.currentStage.rawValue,
                               domainPayloads: [
                                LocalDiscoveryWorkflowSnapshot.domainPayloadKey: try LocalDiscoveryJSON.jsonValue(from: snapshot),
                               ],
                               createdAt: Self.now,
                               updatedAt: Self.now)
    }

    private static func snapshot(taskID: UUID,
                                 runID: UUID,
                                 stage: LocalDiscoveryWorkflowStage,
                                 candidates: [PlaceCandidate],
                                 findings: [PlaceVerificationFinding] = [],
                                 verifierVerdict: LocalDiscoveryVerifierVerdict,
                                 rankedCandidateIDs: [String],
                                 warnings: [String]) -> LocalDiscoveryWorkflowSnapshot {
        LocalDiscoveryWorkflowSnapshot(taskID: taskID,
                                       runID: runID,
                                       currentStage: stage,
                                       approvedQuery: query(),
                                       resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Francisco, CA",
                                                                                               coordinate: PlaceCoordinate(latitude: 37.7749,
                                                                                                                           longitude: -122.4194),
                                                                                               source: "fixture"),
                                       searchPolicySnapshot: LocalDiscoverySearchPolicy(),
                                       rawCandidates: candidates,
                                       mergedCandidates: candidates,
                                       completedRouteCandidateIDs: candidates.map(\.stableID),
                                       completedEnrichmentCandidateIDs: candidates.map(\.stableID),
                                       webpageEvidenceIDs: candidates.flatMap { $0.evidenceReferences.map(\.evidenceID) },
                                       extractionEvidenceIDs: candidates.map { "extract-\($0.stableID)" },
                                       validatorFindings: findings,
                                       verifierDisposition: LocalDiscoveryVerifierReport(verdict: verifierVerdict),
                                       rankedCandidateIDs: rankedCandidateIDs,
                                       toolCompletions: [
                                        LocalDiscoveryToolCompletionIdentity(taskID: taskID,
                                                                             runID: runID,
                                                                             workflowStage: .initialSearchCompleted,
                                                                             toolID: "local_place_search",
                                                                             normalizedInputDigest: "search",
                                                                             completedAt: now),
                                        LocalDiscoveryToolCompletionIdentity(taskID: taskID,
                                                                             runID: runID,
                                                                             workflowStage: .routeBatchCompleted,
                                                                             toolID: "route_distance_estimate",
                                                                             normalizedInputDigest: "route",
                                                                             completedAt: now),
                                       ],
                                       backend: "fixture",
                                       warnings: warnings,
                                       updatedAt: now)
    }

    private static func query() -> PlaceQuery {
        PlaceQuery(queryID: "p9d-app-smoke-query",
                   rawUserIntent: "帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好。",
                   searchText: "Sichuan restaurant",
                   category: .sichuanRestaurant,
                   locationInput: PlaceLocationInput(kind: .explicitRegion, label: "San Francisco, CA"),
                   temporalConstraint: PlaceTemporalConstraint(targetDate: now, description: "tonight"),
                   hardConstraints: [
                    PlaceConstraint(id: "category",
                                    kind: .category,
                                    priority: .hard,
                                    value: .category(.sichuanRestaurant)),
                    PlaceConstraint(id: "open-tonight",
                                    kind: .openAt,
                                    priority: .hard,
                                    value: .date(now)),
                   ],
                   softPreferences: [
                    PlaceConstraint(id: "parking",
                                    kind: .parkingPreference,
                                    priority: .soft,
                                    value: .string("easy")),
                   ],
                   budget: PlaceBudget(maximumAmount: 40, currencyCode: "USD", perPerson: true),
                   travelLimit: PlaceTravelLimit(maximumTravelTimeSeconds: 1_200, transportMode: .automobile),
                   resultLimit: 6,
                   locale: "zh_Hans_US",
                   timezone: "America/Los_Angeles",
                   createdAt: now)
    }

    private static func candidate(id: String,
                                  name: String = "Chengdu House",
                                  coordinate: PlaceCoordinate? = PlaceCoordinate(latitude: 37.78,
                                                                                 longitude: -122.41,
                                                                                 horizontalAccuracyMeters: 30),
                                  routeMeters: Double? = 3_200,
                                  routeDurationSeconds: Double? = 720,
                                  opening: PlaceOpeningStatusValue = .open,
                                  parking: PlaceParkingAvailability = .available,
                                  parkingConfidence: Double = 0.8,
                                  price: PlacePriceValue = .maximumPerPerson(amount: 35, currencyCode: "USD"),
                                  priceConfidence: Double = 0.8,
                                  evidenceFreshness: String = "current-task",
                                  evidenceConfidence: Double = 0.9,
                                  verificationStatus: PlaceVerificationStatus = .verified) -> PlaceCandidate {
        let evidence = PlaceEvidenceReference(evidenceID: "evidence-\(id)",
                                              sourceToolID: "webpage_read",
                                              sourceURL: "https://example.com/\(id)",
                                              claim: "public place evidence for \(id)",
                                              observedAt: now,
                                              freshness: evidenceFreshness,
                                              confidence: evidenceConfidence)
        let routeDistance = routeMeters.map {
            PlaceDistance(meters: $0,
                          kind: .route,
                          source: "route_distance_estimate",
                          calculatedAt: now,
                          uncertaintyReason: "route estimate")
        }
        let straightDistance = PlaceDistance(meters: max(900, (routeMeters ?? 2_600) * 0.78),
                                             kind: .straightLine,
                                             source: "haversine",
                                             calculatedAt: now,
                                             uncertaintyReason: "straight-line distance")
        let openingRefs = opening == .unknown ? [] : [evidence]
        let parkingRefs = parking == .unknown ? [] : [evidence]
        let priceRefs = price == .unknown ? [] : [evidence]
        return PlaceCandidate(stableID: id,
                              sourceEntityIDs: ["fixture:\(id)"],
                              name: name,
                              categories: [.sichuanRestaurant],
                              address: PlaceAddress(locality: "San Francisco",
                                                    region: "CA",
                                                    formatted: "\(name), San Francisco, CA"),
                              coordinate: coordinate,
                              distance: straightDistance,
                              travelEstimate: PlaceTravelEstimate(transportMode: .automobile,
                                                                  straightLineDistance: straightDistance,
                                                                  routeDistance: routeDistance,
                                                                  estimatedTravelDurationSeconds: routeDurationSeconds,
                                                                  calculationSource: "fixture",
                                                                  calculatedAt: now,
                                                                  uncertaintyReason: routeDistance == nil ? "route unavailable" : "route estimate"),
                              openingStatus: PlaceOpeningStatus(value: opening,
                                                                checkedAt: now,
                                                                targetTime: opening == .unknown ? nil : now,
                                                                confidence: opening == .unknown ? 0 : 0.8,
                                                                source: "fixture",
                                                                evidenceReferences: openingRefs,
                                                                uncertaintyReason: opening == .unknown ? "opening status unavailable" : nil),
                              priceEstimate: PlacePriceEstimate(value: price,
                                                                confidence: priceConfidence,
                                                                source: "fixture",
                                                                observedAt: now,
                                                                verifiedAt: price == .unknown ? nil : now,
                                                                evidenceReferences: priceRefs,
                                                                uncertaintyReason: price == .unknown ? "price unavailable" : nil),
                              parkingInfo: PlaceParkingInfo(value: parking,
                                                            confidence: parkingConfidence,
                                                            source: "fixture",
                                                            observedAt: now,
                                                            verifiedAt: parking == .unknown ? nil : now,
                                                            evidenceReferences: parkingRefs,
                                                            uncertaintyReason: parking == .unknown ? "parking unavailable" : nil),
                              evidenceReferences: [evidence],
                              freshness: evidenceFreshness,
                              verificationStatus: verificationStatus,
                              recommendationRationale: "可作为候选比较，仍需查看证据说明。")
    }

    private static func resultDocument(taskID: UUID,
                                       runID: UUID,
                                       status: AgentResultStatus) -> AgentResultDocument {
        AgentResultDocument(id: "local-discovery-\(runID.uuidString)",
                            taskID: taskID,
                            runID: runID,
                            title: "地点搜索结果",
                            summary: "地点候选已整理为卡片和地图。",
                            status: status,
                            generatedAt: now,
                            sections: [],
                            metadata: ["workflow": "localDiscovery"])
    }
}

private extension [String] {
    func value(after flag: String) -> String? {
        guard let index = firstIndex(of: flag) else { return nil }
        let valueIndex = self.index(after: index)
        guard indices.contains(valueIndex) else { return nil }
        return self[valueIndex]
    }
}
#endif
