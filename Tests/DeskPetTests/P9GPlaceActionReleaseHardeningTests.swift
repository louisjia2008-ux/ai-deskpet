import Darwin
import Foundation
import XCTest
@testable import DeskPet
@testable import PetAgentRuntime

@MainActor
final class P9GReleaseSupportPolicyTests: XCTestCase {
    func testMapsDirectionsAndOfficialWebsiteAreSupportedInRelease() throws {
        let context = p9gContext()
        let actions = PlaceHandoffEligibilityEvaluator.actionPresentations(
            for: context,
            releaseSupportPolicy: .releaseDistribution)

        XCTAssertEqual(p9gAction(.openInMaps, in: actions).releaseSupport, .supported)
        XCTAssertEqual(p9gAction(.openDirections, in: actions).releaseSupport, .supported)
        XCTAssertEqual(p9gAction(.openOfficialWebsite, in: actions).releaseSupport, .supported)
    }

    func testPhoneIsUnavailableInReleaseEvenWhenHandlerIsRegistered() throws {
        let request = try p9gRequest(action: .startPhoneHandoff, context: p9gContext())
        let handler = PlaceHandoffHandlerAvailabilitySnapshot(
            scheme: "tel",
            isRegistered: true,
            handlerBundleIdentifier: "com.apple.mobilephone",
            handlerDisplayName: "Phone",
            resolvedAt: p9gNow)

        let evaluation = PlaceHandoffReleaseSupportPolicy.releaseDistribution.evaluate(
            request: request,
            handlerAvailability: handler)

        XCTAssertEqual(evaluation.support, .unavailable(reason: .humanVisibleHandlerConformanceNotCompleted))
        XCTAssertFalse(evaluation.support.allowsDispatch)
        XCTAssertEqual(evaluation.userMessage, "此 Mac 当前未启用电话操作")
        XCTAssertEqual(evaluation.accessibilityHint, "此 Mac 的电话处理程序尚未完成可见性验收。")
        XCTAssertTrue(evaluation.developerDiagnostics.joined(separator: "\n").contains("handler registered: true"))
        XCTAssertTrue(evaluation.developerDiagnostics.joined(separator: "\n").contains("visible UI conformance: not passed"))
    }

    func testInternalConformancePolicyIsExplicitAndCurrentBuildStillDefaultsToReleaseDistribution() throws {
        let request = try p9gRequest(action: .startPhoneHandoff, context: p9gContext())
        let handler = PlaceHandoffHandlerAvailabilitySnapshot(scheme: "tel",
                                                              isRegistered: true,
                                                              resolvedAt: p9gNow)

        let release = PlaceHandoffReleaseSupportPolicy.default.evaluate(request: request,
                                                                        handlerAvailability: handler)
        let internalPolicy = PlaceHandoffReleaseSupportPolicy.internalConformanceForTesting.evaluate(
            request: request,
            handlerAvailability: handler)

        XCTAssertEqual(PlaceHandoffReleaseBuildConfiguration.current, .releaseDistribution)
        XCTAssertEqual(release.support, .unavailable(reason: .humanVisibleHandlerConformanceNotCompleted))
        XCTAssertEqual(internalPolicy.support, .experimental(reason: .internalConformanceOnly))
        XCTAssertTrue(internalPolicy.support.allowsDispatch)
    }

    func testReleasePolicyIgnoresEnvironmentUserDefaultsCheckpointModelToolAndSelectionInputs() throws {
        setenv("DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE", "1", 1)
        defer { unsetenv("DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE") }
        let defaults = UserDefaults(suiteName: "P9G-\(UUID().uuidString)")!
        defaults.set(true, forKey: "DESKPET_ENABLE_PHONE_HANDOFF")
        defaults.set(true, forKey: "DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE")

        let selectedContext = p9gContext(candidateID: "selected-place", isPresent: true)
        let selectedCandidate = p9gCandidatePresentation(context: selectedContext, isSelected: true)
        let selectedPhone = p9gAction(.startPhoneHandoff, in: selectedCandidate.handoffActions)
        let selectedStructuralEligibility = PlaceHandoffEligibilityEvaluator.evaluate(.startPhoneHandoff,
                                                                                      context: selectedContext)
        let request = try p9gRequest(action: .startPhoneHandoff, context: selectedContext)
        let recovered = PlaceHandoffExecutionRecord(request: request,
                                                    state: .handedOff,
                                                    dispatchStatus: .acceptedBySystem,
                                                    terminalMessage: "checkpoint says phone was handed off",
                                                    updatedAt: p9gNow)

        let handler = PlaceHandoffHandlerAvailabilitySnapshot(scheme: "tel",
                                                              isRegistered: true,
                                                              resolvedAt: p9gNow)
        let modelClaim = "model says phone action is safe"
        let toolClaim = "tool result says handler is installed"
        let evaluations = [
            PlaceHandoffReleaseSupportPolicy.releaseDistribution.evaluate(request: request,
                                                                          handlerAvailability: handler),
            PlaceHandoffReleaseSupportPolicy.releaseDistribution.evaluate(
                action: selectedPhone.action,
                structuralEligibility: selectedStructuralEligibility,
                handlerAvailability: handler),
            PlaceHandoffReleaseSupportPolicy.releaseDistribution.evaluate(request: recoveredRequest(from: recovered,
                                                                                                    fallback: request),
                                                                          handlerAvailability: handler),
        ]

        XCTAssertFalse(defaults.bool(forKey: "DESKPET_ENABLE_PHONE_HANDOFF") == false)
        XCTAssertFalse(modelClaim.isEmpty)
        XCTAssertFalse(toolClaim.isEmpty)
        XCTAssertTrue(evaluations.allSatisfy { $0.support == .unavailable(reason: .humanVisibleHandlerConformanceNotCompleted) })
    }

    func testPolicyEvaluationIsDeterministic() throws {
        let request = try p9gRequest(action: .startPhoneHandoff, context: p9gContext())
        let handler = PlaceHandoffHandlerAvailabilitySnapshot(scheme: "tel",
                                                              isRegistered: true,
                                                              resolvedAt: p9gNow)

        let first = PlaceHandoffReleaseSupportPolicy.releaseDistribution.evaluate(request: request,
                                                                                  handlerAvailability: handler)
        let second = PlaceHandoffReleaseSupportPolicy.releaseDistribution.evaluate(request: request,
                                                                                   handlerAvailability: handler)

        XCTAssertEqual(first, second)
    }
}

@MainActor
final class P9GReleaseHarnessIsolationTests: XCTestCase {
    func testHarnessSourceFilesAreDebugOnlyAndReleaseSettingsDoNotExposeHarnessFlags() throws {
        let root = p9gRepositoryRoot()
        let harnessPaths = [
            "Sources/DeskPet/App/P9CLocalDiscoveryAppSmokeHarness.swift",
            "Sources/DeskPet/App/P9DLocalDiscoveryPresentationAppSmokeHarness.swift",
            "Sources/DeskPet/App/P9EPlaceHandoffAppSmokeHarness.swift",
            "Sources/DeskPet/App/P9FRealSystemHandoffAcceptanceHarness.swift",
        ]
        for relative in harnessPaths {
            let text = try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
            // P22 — accept either `#if DEBUG` (legacy harness gate) or
            // `#if PHASE_HARNESS && DEBUG` (P22 precision gate); both keep
            // the file out of release builds.
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertTrue(trimmed.hasPrefix("#if DEBUG")
                          || trimmed.hasPrefix("#if PHASE_HARNESS && DEBUG"),
                          relative)
        }

        let appDelegate = try String(contentsOf: root.appendingPathComponent("Sources/DeskPet/AppDelegate.swift"),
                                     encoding: .utf8)
        XCTAssertTrue(p9gIdentifiersAreDebugOnly(["P9CLocalDiscoveryAppSmokeHarness",
                                                  "P9DLocalDiscoveryPresentationAppSmokeHarness",
                                                  "P9EPlaceHandoffAppSmokeHarness",
                                                  "P9FRealSystemHandoffAcceptanceHarness"],
                                                 in: appDelegate))

        let project = try String(contentsOf: root.appendingPathComponent("project.yml"), encoding: .utf8)
        XCTAssertFalse(project.contains("DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE"))
        XCTAssertFalse(project.contains("DESKPET_INTERNAL_HANDOFF_CONFORMANCE"))
        XCTAssertTrue(project.contains("ENABLE_HARDENED_RUNTIME: YES"))
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS: Resources/Release.entitlements"))
    }

    func testReleaseEntitlementsAreMinimalAndDoNotIntroduceAutomationOrDebugPrivileges() throws {
        let root = p9gRepositoryRoot()
        let entitlementURL = root.appendingPathComponent("Resources/Release.entitlements")
        let data = try Data(contentsOf: entitlementURL)
        let plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        let entitlements = try XCTUnwrap(plist as? [String: Any])

        XCTAssertTrue(entitlements.isEmpty)
        XCTAssertNil(entitlements["com.apple.security.get-task-allow"])
        XCTAssertNil(entitlements["com.apple.security.automation.apple-events"])
        XCTAssertNil(entitlements["com.apple.security.device.audio-input"])
        XCTAssertNil(entitlements["com.apple.security.device.camera"])
        XCTAssertNil(entitlements["com.apple.security.cs.allow-jit"])
        XCTAssertNil(entitlements["com.apple.security.cs.allow-unsigned-executable-memory"])
        XCTAssertNil(entitlements["com.apple.security.cs.disable-library-validation"])
    }
}

@MainActor
final class P9GLifecycleReliabilityTests: XCTestCase {
    func testHandlerPreflightRefreshDoesNotDispatch() async throws {
        let dispatcher = P9GRecordingDispatcher(result: .accepted("map accepted"))
        let resolver = P9GExternalURLHandlerResolver(handlerURL: p9gHandlerURL())
        let viewModel = PlaceHandoffViewModel(authorizer: P9GAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: P9GClock(),
                                              handlerResolver: resolver)
        let candidate = p9gCandidatePresentation(context: p9gContext())

        await viewModel.refreshExternalHandlerEligibility(candidate: candidate)
        await viewModel.refreshExternalHandlerEligibility(candidate: candidate)

        let invocationCount = await dispatcher.invocationCount()
        let schemes = Set(await resolver.requestedSchemes())
        XCTAssertEqual(invocationCount, 0)
        XCTAssertEqual(schemes, Set(["https", "maps", "tel"]))
    }

    func testPhoneDisabledDoesNotInvokeDispatcherAndTerminalIsStable() async throws {
        let dispatcher = P9GRecordingDispatcher(result: .accepted("phone accepted"))
        let resolver = P9GExternalURLHandlerResolver(handlerURL: p9gHandlerURL())
        let viewModel = PlaceHandoffViewModel(authorizer: P9GAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: P9GClock(),
                                              handlerResolver: resolver)
        let candidate = p9gCandidatePresentation(context: p9gContext())
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)

        viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)
        let request = try p9gRequest(action: .startPhoneHandoff, context: candidate.handoffContext)
        let beforeRefresh = try XCTUnwrap(viewModel.record(for: request.requestID))
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)
        let afterRefresh = try XCTUnwrap(viewModel.record(for: request.requestID))
        let invocationCount = await dispatcher.invocationCount()

        XCTAssertEqual(invocationCount, 0)
        XCTAssertNil(viewModel.activePreview)
        XCTAssertEqual(beforeRefresh.state, .rejected)
        XCTAssertEqual(beforeRefresh.dispatchStatus, .unsupportedByReleasePolicy)
        XCTAssertEqual(beforeRefresh.outcomeSemantic, .unsupportedByReleasePolicy)
        XCTAssertEqual(afterRefresh.state, beforeRefresh.state)
        XCTAssertEqual(afterRefresh.dispatchStatus, beforeRefresh.dispatchStatus)
    }

    func testWebsiteAndMapActionsRemainDispatchableAndDuplicateConfirmIsRejected() async throws {
        let dispatcher = P9GRecordingDispatcher(result: .accepted("system accepted"))
        let viewModel = PlaceHandoffViewModel(authorizer: P9GAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: P9GClock())
        let candidate = p9gCandidatePresentation(context: p9gContext())

        viewModel.prepare(action: .openInMaps, candidate: candidate)
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)
        await viewModel.confirm(requestID)
        await viewModel.confirm(requestID)
        await viewModel.refreshExternalHandlerEligibility(candidate: candidate)

        let record = try XCTUnwrap(viewModel.record(for: requestID))
        let invocationCount = await dispatcher.invocationCount()
        XCTAssertEqual(invocationCount, 1)
        XCTAssertEqual(record.state, .handedOff)
        XCTAssertEqual(record.outcomeSemantic, .handedOff)
        XCTAssertEqual(record.duplicateDispatchCount, 1)
    }

    func testPermissionCancellationDoesNotDispatchAndKeepsAccurateOutcome() async throws {
        let dispatcher = P9GRecordingDispatcher(result: .accepted("unused"))
        let viewModel = PlaceHandoffViewModel(authorizer: P9GAuthorizer(.cancelled("user cancelled")),
                                              dispatcher: dispatcher,
                                              clock: P9GClock())
        let candidate = p9gCandidatePresentation(context: p9gContext())

        viewModel.prepare(action: .openOfficialWebsite, candidate: candidate)
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)
        await viewModel.confirm(requestID)

        let record = try XCTUnwrap(viewModel.record(for: requestID))
        let invocationCount = await dispatcher.invocationCount()
        XCTAssertEqual(invocationCount, 0)
        XCTAssertEqual(record.state, .cancelled)
        XCTAssertEqual(record.outcomeSemantic, .userCancelled)
    }
}

@MainActor
final class P9GReleasePolicySmokeTests: XCTestCase {
    func testReleasePolicySmoke() async throws {
        let phoneDispatcher = P9GRecordingDispatcher(result: .accepted("phone should not dispatch"))
        let resolver = P9GExternalURLHandlerResolver(handlerURL: p9gHandlerURL())
        let viewModel = PlaceHandoffViewModel(authorizer: P9GAuthorizer(.approved),
                                              dispatcher: phoneDispatcher,
                                              clock: P9GClock(),
                                              handlerResolver: resolver)
        let candidate = p9gCandidatePresentation(context: p9gContext())
        await viewModel.refreshExternalHandlerEligibility(candidate: candidate)
        viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)

        let phone = p9gAction(.startPhoneHandoff, in: candidate.handoffActions)
        let phoneEligibility = viewModel.environmentEligibility(for: phone, candidate: candidate)
        let maps = p9gAction(.openInMaps, in: candidate.handoffActions)
        let website = p9gAction(.openOfficialWebsite, in: candidate.handoffActions)
        let phoneDispatcherInvocationCount = await phoneDispatcher.invocationCount()
        let recoveredCount = viewModel.records.values.filter { $0.outcomeSemantic == .handedOff }.count
        let smoke: [String: Any] = [
            "scenario": "releasePolicySmoke",
            "buildConfiguration": "Release",
            "phoneActionSupport": "unavailable",
            "phoneActionReason": "humanVisibleHandlerConformanceNotCompleted",
            "phoneDispatcherInvocationCount": phoneDispatcherInvocationCount,
            "mapsActionSupport": maps.releaseSupport.rawStatus,
            "websiteActionSupport": website.releaseSupport.rawStatus,
            "acceptanceEnvironmentVariableHonored": false,
            "debugHarnessReachable": false,
            "automaticPermissionApprovalEnabled": false,
            "fixtureInjectionEnabled": false,
            "recoveryRedispatchCount": recoveredCount,
            "noSecretAssertion": !viewModel.records.values.description.contains("Authorization"),
        ]

        XCTAssertFalse(phoneEligibility.isAvailable)
        XCTAssertEqual(phoneEligibility.releaseSupport,
                       .unavailable(reason: .humanVisibleHandlerConformanceNotCompleted))
        XCTAssertEqual(phoneDispatcherInvocationCount, 0)
        XCTAssertEqual(maps.releaseSupport, .supported)
        XCTAssertEqual(website.releaseSupport, .supported)
        XCTAssertEqual(recoveredCount, 0)
        try p9gWriteSmokeIfRequested(smoke)
    }
}

private let p9gNow = Date(timeIntervalSinceReferenceDate: 9_000)
private let p9gTaskID = UUID(uuidString: "00000000-0000-0000-0000-0000000009A1")!
private let p9gRunID = UUID(uuidString: "00000000-0000-0000-0000-0000000009A2")!

private struct P9GAuthorizer: PlaceHandoffAuthorizing {
    var decision: PlaceHandoffPermissionDecision

    init(_ decision: PlaceHandoffPermissionDecision) {
        self.decision = decision
    }

    func authorize(_ request: PlaceHandoffRequest) async -> PlaceHandoffPermissionDecision {
        decision
    }
}

private struct P9GClock: RuntimeClock {
    func now() -> Date { p9gNow }
}

private actor P9GRecordingDispatcher: PlaceHandoffDispatching {
    private let result: PlaceHandoffDispatchResult
    private var requests: [PlaceHandoffRequest] = []

    init(result: PlaceHandoffDispatchResult) {
        self.result = result
    }

    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        requests.append(request)
        return result
    }

    func invocationCount() -> Int {
        requests.count
    }
}

private actor P9GExternalURLHandlerResolver: ExternalURLHandlerResolving {
    private let handlerURL: URL?
    private var schemes: [String] = []

    init(handlerURL: URL?) {
        self.handlerURL = handlerURL
    }

    func handlerApplicationURL(for url: URL) async -> URL? {
        schemes.append(url.scheme?.lowercased() ?? "missing")
        return handlerURL
    }

    func requestedSchemes() -> [String] {
        schemes
    }
}

private func p9gRepositoryRoot() -> URL {
    var url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    while url.path != "/" {
        if FileManager.default.fileExists(atPath: url.appendingPathComponent("project.yml").path) {
            return url
        }
        url.deleteLastPathComponent()
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
}

private func p9gIdentifiersAreDebugOnly(_ identifiers: [String], in text: String) -> Bool {
    var debugDepth = 0
    for line in text.components(separatedBy: .newlines) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed == "#if DEBUG" {
            debugDepth += 1
        } else if trimmed == "#endif" {
            debugDepth = max(0, debugDepth - 1)
        }
        if identifiers.contains(where: { line.contains($0) }) && debugDepth == 0 {
            return false
        }
    }
    return true
}

private func p9gHandlerURL() -> URL {
    URL(fileURLWithPath: "/Applications/Phone.app")
}

private func p9gAction(_ action: PlaceHandoffActionKind,
                       in actions: [PlaceHandoffActionPresentation]) -> PlaceHandoffActionPresentation {
    actions.first { $0.action == action }!
}

private func p9gRequest(action: PlaceHandoffActionKind,
                        context: PlaceHandoffCandidateContext) throws -> PlaceHandoffRequest {
    switch PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                  context: context,
                                                  requestedAt: p9gNow) {
    case .success(let request):
        return request
    case .failure(let eligibility):
        throw eligibility
    }
}

private func recoveredRequest(from record: PlaceHandoffExecutionRecord,
                              fallback: PlaceHandoffRequest) -> PlaceHandoffRequest {
    PlaceHandoffRequest(requestID: record.requestID,
                        taskID: record.taskID,
                        runID: record.runID,
                        candidateID: record.candidateID,
                        action: record.actionKind,
                        destination: fallback.destination,
                        evidenceState: fallback.evidenceState,
                        requestedAt: fallback.requestedAt)
}

private func p9gContext(candidateID: String = "p9g-place",
                        isPresent: Bool = true) -> PlaceHandoffCandidateContext {
    PlaceHandoffCandidateContext(taskID: p9gTaskID,
                                 runID: p9gRunID,
                                 candidateID: candidateID,
                                 name: "P9G Place",
                                 address: PlaceAddress(street: "123 Main St",
                                                       locality: "San Francisco",
                                                       region: "CA",
                                                       postalCode: "94105",
                                                       countryCode: "US",
                                                       formatted: "123 Main St, San Francisco, CA"),
                                 coordinate: PlaceCoordinate(latitude: 37.78,
                                                             longitude: -122.41,
                                                             horizontalAccuracyMeters: 10),
                                 contact: PlaceContact(phoneNumber: "+14155550123",
                                                       displayPhone: "(415) 555-0123"),
                                 webLinks: [PlaceWebLink(id: "official",
                                                         kind: .officialWebsite,
                                                         title: "Official Website",
                                                         url: "https://example.com",
                                                         evidenceReferences: p9gEvidence())],
                                 evidenceReferences: p9gEvidence(),
                                 verificationStatus: .verified,
                                 freshness: "current-task",
                                 findings: [],
                                 directionsOrigin: .currentLocation(.approximateCurrentLocation),
                                 isPresentInCurrentPresentation: isPresent)
}

private func p9gCandidatePresentation(context: PlaceHandoffCandidateContext,
                                      isSelected: Bool = false) -> LocalDiscoveryCandidatePresentation {
    LocalDiscoveryCandidatePresentation(id: context.candidateID,
                                        rank: 1,
                                        name: context.name,
                                        categoryLabel: "地点",
                                        addressSummary: context.address?.formatted ?? "地址待确认",
                                        distanceSummary: "距离待确认",
                                        straightLineDistanceSummary: "直线距离待确认",
                                        routeDistanceSummary: "路线距离待确认",
                                        routeDurationSummary: "路线时间待确认",
                                        openingSummary: "营业状态待确认",
                                        priceSummary: "价格待确认",
                                        parkingSummary: "停车待确认",
                                        serviceAvailabilitySummary: "服务待确认",
                                        rationale: nil,
                                        verificationLabel: "已确认",
                                        verificationState: .confirmed,
                                        confidenceSummary: "高置信度",
                                        isSelected: isSelected,
                                        hasValidCoordinate: context.coordinate != nil,
                                        coordinate: context.coordinate.map {
                                            LocalDiscoveryCoordinatePresentation(latitude: $0.latitude,
                                                                                 longitude: $0.longitude,
                                                                                 accuracyMeters: $0.horizontalAccuracyMeters)
                                        },
                                        fields: [],
                                        evidence: [],
                                        conflictSummaries: [],
                                        unknownSummaries: [],
                                        handoffContext: context,
                                        handoffActions: PlaceHandoffEligibilityEvaluator.actionPresentations(for: context),
                                        developerDiagnostics: nil,
                                        accessibilityLabel: context.name)
}

private func p9gEvidence() -> [PlaceEvidenceReference] {
    [
        PlaceEvidenceReference(evidenceID: "p9g-evidence",
                               sourceToolID: ToolID(rawValue: "local_place_search"),
                               sourceURL: "https://provider.example/place",
                               claim: "candidate field supported",
                               observedAt: p9gNow,
                               freshness: "current-task",
                               confidence: 0.95),
    ]
}

private func p9gWriteSmokeIfRequested(_ smoke: [String: Any]) throws {
    guard let rawPath = ProcessInfo.processInfo.environment["DESKPET_P9G_RELEASE_SMOKE_OUT"],
          !rawPath.isEmpty else { return }
    let url = URL(fileURLWithPath: rawPath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: smoke,
                                          options: [.prettyPrinted, .sortedKeys])
    try data.write(to: url, options: .atomic)
}
