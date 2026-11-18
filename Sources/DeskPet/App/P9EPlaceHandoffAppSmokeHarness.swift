#if PHASE_HARNESS && DEBUG
import AppKit
import Foundation
import PetAgentRuntime
import SwiftUI

@MainActor
enum P9EPlaceHandoffAppSmokeHarness {
    enum Scenario: String {
        case mapsAccepted
        case directionsDenied
        case websiteBlocked
        case phoneCancelled
        case handedOffRecovery
        case interruptedRecovery
    }

    static var requestedScenario: Scenario? {
        guard let raw = ProcessInfo.processInfo.environment["DESKPET_P9E_APP_SMOKE_HARNESS"]
                ?? ProcessInfo.processInfo.arguments.value(after: "--p9e-smoke-scenario") else {
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
            FileHandle.standardError.write("P9E_APP_SMOKE scenario=\(scenario.rawValue) ok=\(artifact.ok) artifact=\(artifactURL.path)\n".data(using: .utf8)!)
            NSApp.terminate(nil)
        } catch {
            let artifact = P9EAppSmokeArtifact.failure(scenario: scenario.rawValue,
                                                       error: String(describing: error),
                                                       pendingActivityCount: activityStore.activeTasks.count)
            let artifactURL = try? write(artifact: artifact, paths: paths)
            FileHandle.standardError.write("P9E_APP_SMOKE scenario=\(scenario.rawValue) ok=false error=\(error) artifact=\(artifactURL?.path ?? "unwritten")\n".data(using: .utf8)!)
            exit(1)
        }
    }

    private static func run(scenario: Scenario,
                            paths: DeskPetAppPaths,
                            chat: ChatModel,
                            activityStore: AgentTaskActivityStore,
                            checkpointStore: AgentCheckpointStore) async throws -> P9EAppSmokeArtifact {
        NSApp.activate(ignoringOtherApps: true)
        let fixture = Fixture(scenario: scenario)
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
                                                                                  includeDeveloperDiagnostics: true),
              let candidate = presentation.candidates.first(where: { $0.id == fixture.selectedCandidateID }) else {
            throw HarnessError.presentationMissing
        }

        let dispatcher = FakeDispatcher(result: .accepted("已交给系统地图"))
        let authorizer = FakeAuthorizer(decision: scenario == .directionsDenied ? .denied("权限已拒绝") : .approved)
        let initialRecords = try initialRecords(for: scenario, candidate: candidate)
        let viewModel = PlaceHandoffViewModel(authorizer: authorizer,
                                              dispatcher: dispatcher,
                                              recordStore: nil,
                                              handlerResolver: FakeHandlerResolver(),
                                              initialRecords: initialRecords)
        chat.placeHandoffViewModel = viewModel

        var screenshots: [String] = []
        let action = actionKind(for: scenario)
        switch scenario {
        case .mapsAccepted:
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "candidate_action_row",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "narrow_floating_actions",
                                                       layout: .compact,
                                                       size: CGSize(width: 430, height: 760),
                                                       chat: chat,
                                                       paths: paths))
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "wide_result_card_actions",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "dark_mode",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths,
                                                       appearance: NSAppearance(named: .darkAqua)))
            await viewModel.refreshExternalHandlerEligibility(action: .openInMaps, candidate: candidate)
            viewModel.prepare(action: .openInMaps, candidate: candidate)
            screenshots.append(try await capturePreview(name: "map_action_preview",
                                                        viewModel: viewModel,
                                                        paths: paths,
                                                        scenario: scenario))
            if let requestID = viewModel.activePreview?.request.requestID {
                await viewModel.confirm(requestID)
            }
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "handed_off_terminal",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
        case .directionsDenied:
            await viewModel.refreshExternalHandlerEligibility(action: .openDirections, candidate: candidate)
            viewModel.prepare(action: .openDirections, candidate: candidate)
            screenshots.append(try await capturePreview(name: "directions_location_warning",
                                                        viewModel: viewModel,
                                                        paths: paths,
                                                        scenario: scenario))
            if let requestID = viewModel.activePreview?.request.requestID {
                await viewModel.confirm(requestID)
            }
            screenshots.append(try await capturePreview(name: "permission_denied",
                                                        viewModel: viewModel,
                                                        paths: paths,
                                                        scenario: scenario))
        case .websiteBlocked:
            await viewModel.refreshExternalHandlerEligibility(action: .openOfficialWebsite, candidate: candidate)
            viewModel.prepare(action: .openOfficialWebsite, candidate: candidate)
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "website_security_warning",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
        case .phoneCancelled:
            await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff, candidate: candidate)
            viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)
            screenshots.append(try await capturePreview(name: "phone_confirmation",
                                                        viewModel: viewModel,
                                                        paths: paths,
                                                        scenario: scenario))
            if let requestID = viewModel.activePreview?.request.requestID {
                viewModel.cancel(requestID)
            }
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "cancelled_terminal",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
        case .handedOffRecovery:
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "handed_off_recovery",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
        case .interruptedRecovery:
            screenshots.append(try await captureResult(fixture: fixture,
                                                       name: "interrupted_recovery",
                                                       layout: .wide,
                                                       size: CGSize(width: 1_020, height: 820),
                                                       chat: chat,
                                                       paths: paths))
        }

        let requestID = viewModel.activePreview?.request.requestID
            ?? viewModel.records.values.first?.requestID
            ?? ""
        let record = requestID.isEmpty ? nil : viewModel.record(for: requestID)
        let dispatcherInvocationCount = await dispatcher.invocationCount()
        let duplicateCount = record?.duplicateDispatchCount ?? 0
        let noSecret = noSecretsDetected(viewModel: viewModel)
        let artifact = P9EAppSmokeArtifact(scenario: scenario.rawValue,
                                           ok: acceptanceOK(scenario: scenario,
                                                            record: record,
                                                            previewVisible: viewModel.activePreview != nil,
                                                            dispatcherInvocationCount: dispatcherInvocationCount,
                                                            screenshots: screenshots,
                                                            noSecretAssertion: noSecret),
                                           appPID: ProcessInfo.processInfo.processIdentifier,
                                           taskID: fixture.snapshot.taskID.uuidString,
                                           runID: fixture.snapshot.runID.uuidString,
                                           candidateID: candidate.id,
                                           requestID: requestID,
                                           attemptID: record?.attemptID ?? "",
                                           actionKind: action.rawValue,
                                           previewVisible: viewModel.activePreview != nil,
                                           permissionDecision: record?.permissionDecision ?? (scenario == .websiteBlocked ? "blocked" : ""),
                                           executionState: record?.state.rawValue ?? (scenario == .websiteBlocked ? "rejected" : "awaitingConfirmation"),
                                           dispatcherInvocationCount: dispatcherInvocationCount,
                                           duplicateDispatchCount: duplicateCount,
                                           externalApplicationActuallyOpened: false,
                                           recoveredFromCheckpoint: fixture.recoveredFromCheckpoint,
                                           autoReexecuted: fixture.recoveredFromCheckpoint && dispatcherInvocationCount > 0,
                                           pendingActivityCount: activityStore.activeTasks.count,
                                           loadingVisible: record?.state == .dispatching,
                                           noSecretAssertion: noSecret,
                                           screenshots: screenshots,
                                           error: nil)
        return artifact.ok ? artifact : artifact.with(error: "acceptance predicates not satisfied")
    }

    private static func initialRecords(for scenario: Scenario,
                                       candidate: LocalDiscoveryCandidatePresentation) throws -> [PlaceHandoffExecutionRecord] {
        guard scenario == .handedOffRecovery || scenario == .interruptedRecovery else { return [] }
        let request = try request(action: .openInMaps, candidate: candidate)
        let attemptID = PlaceHandoffRequestBuilder.newAttemptID(requestID: request.requestID, attemptIndex: 1)
        switch scenario {
        case .handedOffRecovery:
            return [PlaceHandoffExecutionRecord(request: request,
                                                state: .handedOff,
                                                attemptID: attemptID,
                                                permissionDecision: "approved",
                                                dispatchStatus: .acceptedBySystem,
                                                terminalMessage: "已交给系统地图",
                                                updatedAt: Fixture.now)]
        case .interruptedRecovery:
            return [PlaceHandoffExecutionRecord(request: request,
                                                state: .dispatching,
                                                attemptID: attemptID,
                                                permissionDecision: "approved",
                                                terminalMessage: "正在交给系统",
                                                updatedAt: Fixture.now)]
        default:
            return []
        }
    }

    private static func actionKind(for scenario: Scenario) -> PlaceHandoffActionKind {
        switch scenario {
        case .mapsAccepted, .handedOffRecovery, .interruptedRecovery:
            return .openInMaps
        case .directionsDenied:
            return .openDirections
        case .websiteBlocked:
            return .openOfficialWebsite
        case .phoneCancelled:
            return .startPhoneHandoff
        }
    }

    private static func request(action: PlaceHandoffActionKind,
                                candidate: LocalDiscoveryCandidatePresentation) throws -> PlaceHandoffRequest {
        switch PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                      context: candidate.handoffContext,
                                                      requestedAt: Fixture.now) {
        case .success(let request):
            return request
        case .failure(let eligibility):
            throw eligibility
        }
    }

    private static func install(fixture: Fixture,
                                activityStore: AgentTaskActivityStore,
                                checkpointStore: AgentCheckpointStore) async throws {
        publishActivity(fixture: fixture, activityStore: activityStore)
        try await checkpointStore.save(fixture.checkpoint())
    }

    private static func publishActivity(fixture: Fixture,
                                        activityStore: AgentTaskActivityStore) {
        let taskID = fixture.snapshot.taskID
        let runID = fixture.snapshot.runID
        let conversationID = fixture.conversationID
        let document = Fixture.resultDocument(taskID: taskID, runID: runID)
        let events = [
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 0,
                                   timestamp: Fixture.now,
                                   kind: .taskCreated,
                                   presentation: AgentTaskEventPresentation(title: "地点搜索",
                                                                            detail: "P9E handoff fixture"),
                                   source: .chat,
                                   origin: .chat),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 1,
                                   timestamp: Fixture.now.addingTimeInterval(1),
                                   kind: .resultProduced,
                                   presentation: AgentTaskEventPresentation(title: "地点结果已生成",
                                                                            detail: "候选地点已可操作"),
                                   source: .runtime,
                                   origin: .chat,
                                   resultDocument: document),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 2,
                                   timestamp: Fixture.now.addingTimeInterval(2),
                                   kind: .taskSucceeded,
                                   presentation: AgentTaskEventPresentation(title: "地点搜索已完成",
                                                                            detail: "P9E handoff fixture complete"),
                                   source: .runtime,
                                   origin: .chat,
                                   resultDocument: document),
        ]
        for event in events {
            activityStore.publish(AgentEventEnvelope(activityEvent: event))
        }
    }

    private static func captureResult(fixture: Fixture,
                                      name: String,
                                      layout: LocalDiscoveryResultContainerView.LayoutMode,
                                      size: CGSize,
                                      chat: ChatModel,
                                      paths: DeskPetAppPaths,
                                      appearance: NSAppearance? = nil) async throws -> String {
        let view = LocalDiscoveryResultContainerView(taskID: fixture.snapshot.taskID,
                                                     runID: fixture.snapshot.runID,
                                                     store: chat.localDiscoveryPresentationStore,
                                                     placeHandoffViewModel: chat.placeHandoffViewModel,
                                                     layout: layout,
                                                     recoveredFromCheckpoint: fixture.recoveredFromCheckpoint,
                                                     developerMode: false,
                                                     initialSelectedCandidateID: fixture.selectedCandidateID)
            .frame(width: size.width, height: size.height)
            .background(DSColor.appBackground)
        return try await capture(view: view,
                                 fileName: "p9e_app_smoke_\(fixture.scenario)_\(name).png",
                                 size: size,
                                 paths: paths,
                                 appearance: appearance)
    }

    private static func capturePreview(name: String,
                                       viewModel: PlaceHandoffViewModel,
                                       paths: DeskPetAppPaths,
                                       scenario: Scenario) async throws -> String {
        guard let preview = viewModel.activePreview else {
            throw HarnessError.previewMissing
        }
        let view = PlaceHandoffPreviewSheet(preview: preview,
                                            record: viewModel.record(for: preview.request.requestID),
                                            developerMode: false,
                                            onCancel: {},
                                            onConfirm: {},
                                            onRetry: {})
            .frame(width: 480, height: 520)
            .background(DSColor.appBackground)
        return try await capture(view: view,
                                 fileName: "p9e_app_smoke_\(scenario.rawValue)_\(name).png",
                                 size: CGSize(width: 480, height: 520),
                                 paths: paths)
    }

    private static func capture<V: View>(view: V,
                                         fileName: String,
                                         size: CGSize,
                                         paths: DeskPetAppPaths,
                                         appearance: NSAppearance? = nil) async throws -> String {
        let url = paths.applicationSupportRoot.appendingPathComponent(fileName)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable],
                              backing: .buffered,
                              defer: false)
        window.title = fileName
        window.appearance = appearance
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.contentView?.needsLayout = true
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 450_000_000)
        guard captureWindowScreenshot(window, to: url) else {
            window.orderOut(nil)
            throw HarnessError.screenshotFailed(fileName)
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
                                     record: PlaceHandoffExecutionRecord?,
                                     previewVisible: Bool,
                                     dispatcherInvocationCount: Int,
                                     screenshots: [String],
                                     noSecretAssertion: Bool) -> Bool {
        guard noSecretAssertion, !screenshots.isEmpty else { return false }
        switch scenario {
        case .mapsAccepted:
            return record?.state == .handedOff
                && dispatcherInvocationCount == 1
                && record?.duplicateDispatchCount == 0
                && screenshots.count >= 6
        case .directionsDenied:
            return record?.state == .rejected
                && record?.permissionDecision == "denied"
                && dispatcherInvocationCount == 0
        case .websiteBlocked:
            return !previewVisible && dispatcherInvocationCount == 0
        case .phoneCancelled:
            return record?.state == .cancelled
                && dispatcherInvocationCount == 0
        case .handedOffRecovery:
            return record?.state == .handedOff
                && dispatcherInvocationCount == 0
        case .interruptedRecovery:
            return record?.state == .interrupted
                && dispatcherInvocationCount == 0
        }
    }

    private static func noSecretsDetected(viewModel: PlaceHandoffViewModel) -> Bool {
        let text = viewModel.records.values.flatMap { record in
            [record.sanitizedDestinationSummary,
             record.terminalMessage ?? "",
             record.permissionDecision ?? ""] + record.auditEvents.map(\.sanitizedDestinationSummary)
        }.joined(separator: "\n").lowercased()
        let forbidden = ["sk-", "authorization", "bearer ", "cookie", "password=", "token=secret"]
        return !forbidden.contains { text.contains($0) }
    }

    private static func write(artifact: P9EAppSmokeArtifact,
                              paths: DeskPetAppPaths) throws -> URL {
        let url = paths.applicationSupportRoot
            .appendingPathComponent("p9e_app_smoke_\(artifact.scenario).json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(artifact)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return url
    }
}

private struct P9EAppSmokeArtifact: Codable, Sendable {
    var scenario: String
    var ok: Bool
    var appPID: Int32
    var taskID: String
    var runID: String
    var candidateID: String
    var requestID: String
    var attemptID: String
    var actionKind: String
    var previewVisible: Bool
    var permissionDecision: String
    var executionState: String
    var dispatcherInvocationCount: Int
    var duplicateDispatchCount: Int
    var externalApplicationActuallyOpened: Bool
    var recoveredFromCheckpoint: Bool
    var autoReexecuted: Bool
    var pendingActivityCount: Int
    var loadingVisible: Bool
    var noSecretAssertion: Bool
    var screenshots: [String]
    var error: String?

    func with(error: String) -> P9EAppSmokeArtifact {
        var copy = self
        copy.ok = false
        copy.error = error
        return copy
    }

    static func failure(scenario: String,
                        error: String,
                        pendingActivityCount: Int) -> P9EAppSmokeArtifact {
        P9EAppSmokeArtifact(scenario: scenario,
                            ok: false,
                            appPID: ProcessInfo.processInfo.processIdentifier,
                            taskID: "",
                            runID: "",
                            candidateID: "",
                            requestID: "",
                            attemptID: "",
                            actionKind: "",
                            previewVisible: false,
                            permissionDecision: "",
                            executionState: "failed",
                            dispatcherInvocationCount: 0,
                            duplicateDispatchCount: 0,
                            externalApplicationActuallyOpened: false,
                            recoveredFromCheckpoint: false,
                            autoReexecuted: false,
                            pendingActivityCount: pendingActivityCount,
                            loadingVisible: false,
                            noSecretAssertion: false,
                            screenshots: [],
                            error: error)
    }
}

private enum HarnessError: Error, CustomStringConvertible {
    case presentationMissing
    case previewMissing
    case screenshotFailed(String)

    var description: String {
        switch self {
        case .presentationMissing: return "presentation missing"
        case .previewMissing: return "preview missing"
        case .screenshotFailed(let name): return "screenshot failed: \(name)"
        }
    }
}

private struct FakeHandlerResolver: ExternalURLHandlerResolving {
    func handlerApplicationURL(for url: URL) async -> URL? {
        if url.scheme?.lowercased() == "tel" {
            return URL(fileURLWithPath: "/System/Applications/FaceTime.app", isDirectory: true)
        }
        if url.scheme?.lowercased() == "maps" {
            return URL(fileURLWithPath: "/System/Applications/Maps.app", isDirectory: true)
        }
        return URL(fileURLWithPath: "/System/Applications/Safari.app", isDirectory: true)
    }
}

private struct FakeAuthorizer: PlaceHandoffAuthorizing {
    var decision: PlaceHandoffPermissionDecision

    func authorize(_ request: PlaceHandoffRequest) async -> PlaceHandoffPermissionDecision {
        decision
    }
}

private actor FakeDispatcher: PlaceHandoffDispatching {
    private var result: PlaceHandoffDispatchResult
    private var invocations: [(PlaceHandoffRequest, PlaceHandoffAttemptID)] = []

    init(result: PlaceHandoffDispatchResult) {
        self.result = result
    }

    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        invocations.append((request, attemptID))
        return result
    }

    func invocationCount() -> Int {
        invocations.count
    }
}

private struct Fixture {
    static let now = Date(timeIntervalSince1970: 1_785_456_000)

    var scenario: String
    var snapshot: LocalDiscoveryWorkflowSnapshot
    var conversationID: UUID
    var recoveredFromCheckpoint: Bool
    var selectedCandidateID: String

    init(scenario: P9EPlaceHandoffAppSmokeHarness.Scenario) {
        let taskID = UUID()
        let runID = UUID()
        let candidateID = "p9e-place"
        let candidate = Self.candidate(id: candidateID, scenario: scenario)
        self.scenario = scenario.rawValue
        self.snapshot = Self.snapshot(taskID: taskID,
                                      runID: runID,
                                      candidates: [candidate],
                                      rankedCandidateIDs: [candidateID])
        self.conversationID = UUID()
        self.recoveredFromCheckpoint = scenario == .handedOffRecovery || scenario == .interruptedRecovery
        self.selectedCandidateID = candidateID
    }

    func checkpoint() throws -> AgentCheckpoint {
        let document = Self.resultDocument(taskID: snapshot.taskID, runID: snapshot.runID)
        let projection = AgentRunProjection(taskID: snapshot.taskID,
                                            runID: snapshot.runID,
                                            conversationID: conversationID,
                                            state: .succeeded,
                                            events: [],
                                            createdAt: Self.now,
                                            updatedAt: Self.now,
                                            completedAt: Self.now,
                                            terminalSummary: "P9E handoff fixture",
                                            resultDocument: document)
        return AgentCheckpoint(taskID: snapshot.taskID,
                               runID: snapshot.runID,
                               conversationID: conversationID,
                               projection: projection,
                               replayState: AgentTimelineReplayState(taskID: snapshot.taskID,
                                                                     runID: snapshot.runID,
                                                                     events: []).jumpToEnd(),
                               phase: .terminal,
                               lastSequence: 2,
                               eventCount: 3,
                               resultDocument: document,
                               completedToolCallIDs: snapshot.toolCompletions.map(\.id),
                               completedStepIDs: [snapshot.currentStage.rawValue],
                               currentUIRevision: document.revision,
                               evidenceIDs: snapshot.webpageEvidenceIDs + snapshot.extractionEvidenceIDs,
                               verifierState: "pass",
                               recoveryDisposition: snapshot.currentStage.rawValue,
                               domainPayloads: [
                                LocalDiscoveryWorkflowSnapshot.domainPayloadKey: try LocalDiscoveryJSON.jsonValue(from: snapshot),
                               ],
                               createdAt: Self.now,
                               updatedAt: Self.now)
    }

    static func snapshot(taskID: UUID,
                         runID: UUID,
                         candidates: [PlaceCandidate],
                         rankedCandidateIDs: [String]) -> LocalDiscoveryWorkflowSnapshot {
        LocalDiscoveryWorkflowSnapshot(taskID: taskID,
                                       runID: runID,
                                       currentStage: .resultSynthesized,
                                       approvedQuery: query(),
                                       resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Francisco, CA",
                                                                                               coordinate: PlaceCoordinate(latitude: 37.7749,
                                                                                                                           longitude: -122.4194),
                                                                                               source: "fixture"),
                                       searchPolicySnapshot: LocalDiscoverySearchPolicy(),
                                       rawCandidates: candidates,
                                       mergedCandidates: candidates,
                                       completedRouteCandidateIDs: rankedCandidateIDs,
                                       completedEnrichmentCandidateIDs: rankedCandidateIDs,
                                       webpageEvidenceIDs: candidates.flatMap { $0.evidenceReferences.map(\.evidenceID) },
                                       extractionEvidenceIDs: candidates.map { "extract-\($0.stableID)" },
                                       validatorFindings: candidates.flatMap(\.findings),
                                       verifierDisposition: LocalDiscoveryVerifierReport(verdict: .pass),
                                       rankedCandidateIDs: rankedCandidateIDs,
                                       toolCompletions: [
                                        LocalDiscoveryToolCompletionIdentity(taskID: taskID,
                                                                             runID: runID,
                                                                             workflowStage: .initialSearchCompleted,
                                                                             toolID: "local_place_search",
                                                                             normalizedInputDigest: "search",
                                                                             completedAt: now),
                                       ],
                                       backend: "fixture",
                                       warnings: [],
                                       updatedAt: now)
    }

    static func query() -> PlaceQuery {
        PlaceQuery(queryID: "p9e-app-smoke-query",
                   rawUserIntent: "找一个可交接到地图、浏览器或电话的地点。",
                   searchText: "P9E place",
                   category: .restaurant,
                   locationInput: PlaceLocationInput(kind: .explicitRegion, label: "San Francisco, CA"),
                   resultLimit: 1,
                   locale: "zh_Hans_US",
                   timezone: "America/Los_Angeles",
                   createdAt: now)
    }

    static func candidate(id: String,
                          scenario: P9EPlaceHandoffAppSmokeHarness.Scenario) -> PlaceCandidate {
        let evidence = PlaceEvidenceReference(evidenceID: "evidence-\(id)",
                                              sourceToolID: "local_place_search",
                                              sourceURL: "https://provider.example/\(id)",
                                              claim: "public place evidence for \(id)",
                                              observedAt: now,
                                              freshness: scenario == .directionsDenied ? "stale-source" : "current-task",
                                              confidence: 0.95)
        let website: PlaceWebLink
        if scenario == .websiteBlocked {
            website = PlaceWebLink(id: "official",
                                   kind: .officialWebsite,
                                   title: "Official Website",
                                   url: "javascript:alert(1)",
                                   evidenceReferences: [evidence])
        } else {
            website = PlaceWebLink(id: "official",
                                   kind: .officialWebsite,
                                   title: "Official Website",
                                   url: "https://example.com/p9e",
                                   evidenceReferences: [evidence])
        }
        return PlaceCandidate(stableID: id,
                              sourceEntityIDs: ["fixture:\(id)"],
                              name: "P9E Test Place",
                              categories: [.restaurant],
                              address: PlaceAddress(street: "123 Main St",
                                                    locality: "San Francisco",
                                                    region: "CA",
                                                    countryCode: "US",
                                                    formatted: "123 Main St, San Francisco, CA"),
                              coordinate: PlaceCoordinate(latitude: 37.78,
                                                          longitude: -122.41,
                                                          horizontalAccuracyMeters: scenario == .directionsDenied ? 6_500 : 30),
                              openingStatus: PlaceOpeningStatus(value: .unknown,
                                                                uncertaintyReason: "not checked"),
                              contact: PlaceContact(phoneNumber: "+14155550123",
                                                    displayPhone: "(415) 555-0123"),
                              webLinks: [website],
                              evidenceReferences: [evidence],
                              freshness: scenario == .directionsDenied ? "stale-source" : "current-task",
                              verificationStatus: scenario == .directionsDenied ? .stale : .verified,
                              recommendationRationale: "P9E handoff fixture candidate.")
    }

    static func resultDocument(taskID: UUID,
                               runID: UUID) -> AgentResultDocument {
        AgentResultDocument(id: "local-discovery-\(runID.uuidString)",
                            taskID: taskID,
                            runID: runID,
                            title: "地点搜索结果",
                            summary: "P9E handoff fixture.",
                            status: .completed,
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
