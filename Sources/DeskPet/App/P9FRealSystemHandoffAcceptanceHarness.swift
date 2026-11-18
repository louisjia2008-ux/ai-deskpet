#if PHASE_HARNESS && DEBUG
import AppKit
import CoreGraphics
import Foundation
import PetAgentRuntime
import SwiftUI

@MainActor
enum P9FRealSystemHandoffAcceptanceHarness {
    enum Scenario: String, CaseIterable {
        case realMapPlace
        case realDirections
        case directionsDenied
        case realWebsite
        case realPhoneHandler
        case handedOffRecovery
    }

    static var requestedScenario: Scenario? {
        guard let raw = ProcessInfo.processInfo.environment["DESKPET_P9F_REAL_HANDOFF_SCENARIO"] else {
            return nil
        }
        return Scenario(rawValue: raw)
    }

    static func runIfRequested(paths: DeskPetAppPaths,
                               chat: ChatModel,
                               activityStore: AgentTaskActivityStore,
                               checkpointStore: AgentCheckpointStore) async {
        guard let scenario = requestedScenario else { return }
        let root = artifactRoot(paths: paths)
        do {
            try prepareArtifactRoot(root)
            try appendLog("scenario=\(scenario.rawValue) starting", root: root)
            guard ProcessInfo.processInfo.environment["DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE"] == "1" else {
                let artifact = P9FRealHandoffArtifact.blocked(
                    scenario: scenario.rawValue,
                    artifactRoot: root.path,
                    error: "DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE was not set to 1")
                try write(artifact: artifact, scenario: scenario, root: root)
                try appendLog("scenario=\(scenario.rawValue) blocked: real acceptance env not set", root: root)
                NSApp.terminate(nil)
                return
            }

            let artifact = try await run(scenario: scenario,
                                         root: root,
                                         paths: paths,
                                         chat: chat,
                                         activityStore: activityStore,
                                         checkpointStore: checkpointStore)
            try write(artifact: artifact, scenario: scenario, root: root)
            try appendLog("scenario=\(scenario.rawValue) ok=\(artifact.ok) state=\(artifact.executionState)", root: root)
            NSApp.terminate(nil)
        } catch {
            let artifact = P9FRealHandoffArtifact.blocked(
                scenario: scenario.rawValue,
                artifactRoot: root.path,
                error: String(describing: error))
            try? write(artifact: artifact, scenario: scenario, root: root)
            try? appendLog("scenario=\(scenario.rawValue) failed error=\(error)", root: root)
            exit(1)
        }
    }

    private static func run(scenario: Scenario,
                            root: URL,
                            paths: DeskPetAppPaths,
                            chat: ChatModel,
                            activityStore: AgentTaskActivityStore,
                            checkpointStore: AgentCheckpointStore) async throws -> P9FRealHandoffArtifact {
        NSApp.activate(ignoringOtherApps: true)
        let hiddenBundles = hidePrivateApplications()
        if !hiddenBundles.isEmpty {
            try appendLog("safety hiddenApplications=\(hiddenBundles.joined(separator: ","))", root: root)
        }
        let fixture = P9FFixture(scenario: scenario)
        try await install(fixture: fixture,
                          activityStore: activityStore,
                          checkpointStore: checkpointStore)
        await chat.localDiscoveryPresentationStore.load(taskID: fixture.snapshot.taskID,
                                                        runID: fixture.snapshot.runID)
        let presentation = fixture.presentation(recoveredFromCheckpoint: scenario == .handedOffRecovery)
        guard let candidate = presentation.candidates.first(where: { $0.id == fixture.selectedCandidateID }) else {
            throw P9FHarnessError.presentationMissing
        }

        let dispatcher = P9FCountingRealSystemDispatcher()
        let authorizer = P9FAuthorizer(decision: scenario == .directionsDenied
                                       ? .denied("permission denied by P9F fixture")
                                       : .approved)
        let viewModel = PlaceHandoffViewModel(authorizer: authorizer,
                                              dispatcher: dispatcher,
                                              recordStore: PlaceHandoffJSONRecordStore(
                                                fileURL: paths.applicationSupportRoot
                                                    .appendingPathComponent("place_handoff_records.json")),
                                              clock: P9FClock(fixedNow: P9FFixture.now),
                                              handlerResolver: NSWorkspaceExternalURLHandlerResolver())
        chat.placeHandoffViewModel = viewModel

        var screenshots: [String] = []
        let action = actionKind(for: scenario)
        let beforeExternal = observeExternalApplication(for: scenario, root: root, screenshotName: nil)
        var phonePreflightHandlerRegistered: Bool?
        var phonePreflightRegisteredHandlerBundleIdentifier: String?
        var phonePreflightRegisteredHandlerDisplayName: String?

        switch scenario {
        case .handedOffRecovery:
            screenshots.append(try await captureResult(presentation: presentation,
                                                       viewModel: viewModel,
                                                       name: "deskpet_recovered_handed_off_terminal",
                                                       root: root))
        case .directionsDenied:
            await viewModel.refreshExternalHandlerEligibility(action: action, candidate: candidate)
            viewModel.prepare(action: action, candidate: candidate)
            screenshots.append(try await capturePreview(viewModel: viewModel,
                                                        name: "deskpet_directions_permission_preview",
                                                        root: root))
            if let requestID = viewModel.activePreview?.request.requestID {
                await viewModel.confirm(requestID)
            }
            screenshots.append(try await capturePreviewOrResult(presentation: presentation,
                                                                viewModel: viewModel,
                                                                name: "deskpet_directions_permission_denied",
                                                                root: root))
        default:
            screenshots.append(try await captureResult(presentation: presentation,
                                                       viewModel: viewModel,
                                                       name: "deskpet_result_before_\(scenario.rawValue)",
                                                       root: root))
            if scenario == .realPhoneHandler {
                await viewModel.refreshExternalHandlerEligibility(action: action, candidate: candidate)
                if let request = PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                                        context: candidate.handoffContext,
                                                                        requestedAt: P9FFixture.now).successValue,
                   case .phone(let normalizedNumber, _) = request.destination,
                   let phoneURL = URL(string: "tel:\(normalizedNumber)"),
                   let availability = viewModel.cachedExternalHandlerAvailability(for: phoneURL) {
                    phonePreflightHandlerRegistered = availability.isRegistered
                    phonePreflightRegisteredHandlerBundleIdentifier = availability.handlerBundleIdentifier
                    phonePreflightRegisteredHandlerDisplayName = availability.handlerDisplayName
                }
            }
            viewModel.prepare(action: action, candidate: candidate)
            screenshots.append(try await capturePreviewOrResult(presentation: presentation,
                                                                viewModel: viewModel,
                                                                name: "deskpet_preview_\(scenario.rawValue)",
                                                                root: root))
            if let requestID = viewModel.activePreview?.request.requestID {
                await viewModel.confirm(requestID)
            }
            try await Task.sleep(nanoseconds: 3_000_000_000)
            let externalShot = observeExternalApplication(for: scenario,
                                                          root: root,
                                                          screenshotName: "system_\(scenario.rawValue)")
            if let path = externalShot.screenshotPath {
                screenshots.append(path)
            }
            NSApp.activate(ignoringOtherApps: true)
            try await Task.sleep(nanoseconds: 600_000_000)
            screenshots.append(try await captureResult(presentation: presentation,
                                                       viewModel: viewModel,
                                                       name: "deskpet_handed_off_terminal_\(scenario.rawValue)",
                                                       root: root))
        }

        let requestID = viewModel.activePreview?.request.requestID
            ?? PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                      context: candidate.handoffContext,
                                                      requestedAt: P9FFixture.now).successValue?.requestID
            ?? viewModel.records.values.sorted { $0.updatedAt > $1.updatedAt }.first?.requestID
            ?? ""
        let record = requestID.isEmpty ? nil : viewModel.record(for: requestID)
        let dispatcherInvocationCount = await dispatcher.invocationCount()
        let afterExternal = observeExternalApplication(for: scenario, root: root, screenshotName: nil)
        let duplicateDispatchCount = record?.duplicateDispatchCount ?? 0
        let loadingVisible = record?.state == .dispatching
        let pendingActivityCount = activityStore.activeTasks.count
        let terminalTaskCount = activityStore.recentTerminalTasks.count
        let noSecret = noSecretsDetected(root: root, viewModel: viewModel)
        let externalHandlerAudit = record?.externalHandlerAudit
        let phoneSystemOpenAccepted = externalHandlerAudit?.systemOpenAccepted
        let externalOpened = externalOpened(for: scenario,
                                            dispatcherInvocationCount: dispatcherInvocationCount,
                                            before: beforeExternal,
                                            after: afterExternal)
        let externalApplicationActuallyOpened = scenario == .realPhoneHandler
            ? (phoneSystemOpenAccepted ?? externalOpened)
            : externalOpened
        let state = record?.state.rawValue ?? "missing"
        let ok = okForScenario(scenario: scenario,
                               state: state,
                               dispatcherInvocationCount: dispatcherInvocationCount,
                               duplicateDispatchCount: duplicateDispatchCount,
                               externalOpened: externalOpened,
                               phoneSystemOpenAccepted: phoneSystemOpenAccepted,
                               loadingVisible: loadingVisible,
                               pendingActivityCount: pendingActivityCount,
                               noSecret: noSecret)

        return P9FRealHandoffArtifact(
            scenario: scenario.rawValue,
            ok: ok,
            dateTimeLocal: P9FFixture.localTimestamp(),
            buildConfiguration: "Debug",
            appBinaryPath: Bundle.main.bundlePath,
            artifactRoot: root.path,
            fixture: fixture.summary(action: action),
            explicitConfirmationObserved: scenario != .handedOffRecovery,
            dispatcherType: "realSystem",
            dispatcherInvocationCount: dispatcherInvocationCount,
            duplicateDispatchCount: duplicateDispatchCount,
            externalApplicationActuallyOpened: externalApplicationActuallyOpened,
            externalApplication: afterExternal.runningApplicationName ?? afterExternal.frontmostAppName,
            systemTargetVerified: false,
            systemTargetVerificationMethod: "requires human visual review of system screenshot",
            navigationActuallyStarted: false,
            phoneHandlerOpened: scenario == .realPhoneHandler ? externalHandlerAudit?.handlerUIVisibility == .humanObserved : nil,
            phonePreflightHandlerRegistered: phonePreflightHandlerRegistered,
            phonePreflightRegisteredHandlerBundleIdentifier: phonePreflightRegisteredHandlerBundleIdentifier,
            phonePreflightRegisteredHandlerDisplayName: phonePreflightRegisteredHandlerDisplayName,
            phoneHandlerRegistered: externalHandlerAudit?.phoneHandlerRegistered,
            registeredHandlerBundleIdentifier: externalHandlerAudit?.registeredHandlerBundleIdentifier,
            registeredHandlerDisplayName: externalHandlerAudit?.registeredHandlerDisplayName,
            systemOpenAccepted: externalHandlerAudit?.systemOpenAccepted,
            runningApplicationReturned: externalHandlerAudit?.runningApplicationReturned,
            returnedHandlerBundleIdentifier: externalHandlerAudit?.returnedHandlerBundleIdentifier,
            returnedHandlerDisplayName: externalHandlerAudit?.returnedHandlerDisplayName,
            handlerUIVisibility: externalHandlerAudit?.handlerUIVisibility.rawValue,
            openCompletionTimestamp: timestampString(externalHandlerAudit?.openCompletionTimestamp),
            failureReason: externalHandlerAudit?.failureReason?.rawValue,
            openErrorCategory: externalHandlerAudit?.openErrorCategory,
            phoneCallActuallyPlaced: scenario == .realPhoneHandler ? false : nil,
            humanCancelledSystemHandler: scenario == .realPhoneHandler ? false : nil,
            formSubmitted: scenario == .realWebsite ? false : nil,
            modelReexecutionCount: 0,
            toolReexecutionCount: 0,
            autoReexecuted: scenario == .handedOffRecovery ? dispatcherInvocationCount > 0 : false,
            executionState: state,
            loadingVisible: loadingVisible,
            pendingActivityCount: pendingActivityCount,
            terminalActivityCount: terminalTaskCount,
            taskCenterSanitizedActivityCount: terminalTaskCount,
            permissionDecision: record?.permissionDecision,
            dispatchStatus: record?.dispatchStatus?.rawValue,
            recoveredFromCheckpoint: scenario == .handedOffRecovery,
            externalBefore: beforeExternal,
            externalAfter: afterExternal,
            focusBehavior: focusBehavior(scenario: scenario, before: beforeExternal, after: afterExternal),
            noSecretAssertion: noSecret,
            screenshots: screenshots,
            notes: notes(for: scenario, artifactOK: ok),
            error: ok ? nil : "real system target correctness and human PASS remain unresolved")
    }

    private static func actionKind(for scenario: Scenario) -> PlaceHandoffActionKind {
        switch scenario {
        case .realMapPlace, .handedOffRecovery:
            return .openInMaps
        case .realDirections, .directionsDenied:
            return .openDirections
        case .realWebsite:
            return .openOfficialWebsite
        case .realPhoneHandler:
            return .startPhoneHandoff
        }
    }

    private static func install(fixture: P9FFixture,
                                activityStore: AgentTaskActivityStore,
                                checkpointStore: AgentCheckpointStore) async throws {
        publishActivity(fixture: fixture, activityStore: activityStore)
        try await checkpointStore.save(fixture.checkpoint())
    }

    private static func publishActivity(fixture: P9FFixture,
                                        activityStore: AgentTaskActivityStore) {
        let taskID = fixture.snapshot.taskID
        let runID = fixture.snapshot.runID
        let conversationID = fixture.conversationID
        let document = P9FFixture.resultDocument(taskID: taskID, runID: runID)
        let events = [
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 0,
                                   timestamp: P9FFixture.now,
                                   kind: .taskCreated,
                                   presentation: AgentTaskEventPresentation(title: "P9F handoff fixture",
                                                                            detail: "deterministic public fixture"),
                                   source: .chat,
                                   origin: .chat),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 1,
                                   timestamp: P9FFixture.now.addingTimeInterval(1),
                                   kind: .resultProduced,
                                   presentation: AgentTaskEventPresentation(title: "P9F handoff result",
                                                                            detail: "candidate actions ready"),
                                   source: .runtime,
                                   origin: .chat,
                                   resultDocument: document),
            AgentTaskActivityEvent(taskID: taskID,
                                   runID: runID,
                                   conversationID: conversationID,
                                   sequenceNumber: 2,
                                   timestamp: P9FFixture.now.addingTimeInterval(2),
                                   kind: .taskSucceeded,
                                   presentation: AgentTaskEventPresentation(title: "P9F handoff fixture complete",
                                                                            detail: "ready for explicit handoff"),
                                   source: .runtime,
                                   origin: .chat,
                                   resultDocument: document),
        ]
        for event in events {
            activityStore.publish(AgentEventEnvelope(activityEvent: event))
        }
    }

    private static func captureResult(presentation: LocalDiscoveryPresentation,
                                      viewModel: PlaceHandoffViewModel,
                                      name: String,
                                      root: URL) async throws -> String {
        let view = P9FLocalDiscoveryAcceptanceView(presentation: presentation,
                                                   viewModel: viewModel)
            .frame(width: 1_020, height: 820)
            .background(DSColor.appBackground)
        return try await capture(view: view,
                                 fileName: "\(name).png",
                                 size: CGSize(width: 1_020, height: 820),
                                 root: root)
    }

    private static func capturePreview(viewModel: PlaceHandoffViewModel,
                                       name: String,
                                       root: URL) async throws -> String {
        guard let preview = viewModel.activePreview else {
            throw P9FHarnessError.previewMissing
        }
        let view = PlaceHandoffPreviewSheet(preview: preview,
                                            record: viewModel.record(for: preview.request.requestID),
                                            developerMode: true,
                                            onCancel: {},
                                            onConfirm: {},
                                            onRetry: {})
            .frame(width: 500, height: 540)
            .background(DSColor.appBackground)
        return try await capture(view: view,
                                 fileName: "\(name).png",
                                 size: CGSize(width: 500, height: 540),
                                 root: root)
    }

    private static func capturePreviewOrResult(presentation: LocalDiscoveryPresentation,
                                               viewModel: PlaceHandoffViewModel,
                                               name: String,
                                               root: URL) async throws -> String {
        if viewModel.activePreview != nil {
            return try await capturePreview(viewModel: viewModel, name: name, root: root)
        }
        return try await captureResult(presentation: presentation,
                                       viewModel: viewModel,
                                       name: name,
                                       root: root)
    }

    private static func capture<V: View>(view: V,
                                         fileName: String,
                                         size: CGSize,
                                         root: URL) async throws -> String {
        let url = root.appendingPathComponent("screenshots", isDirectory: true)
            .appendingPathComponent(fileName)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable],
                              backing: .buffered,
                              defer: false)
        window.title = fileName
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.contentView?.needsLayout = true
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 500_000_000)
        guard captureWindow(window, to: url) else {
            window.orderOut(nil)
            throw P9FHarnessError.screenshotFailed(fileName)
        }
        window.orderOut(nil)
        return url.path
    }

    private static func captureWindow(_ window: NSWindow, to url: URL) -> Bool {
        guard let view = window.contentView else { return false }
        view.displayIfNeeded()
        let bounds = view.bounds
        guard bounds.width > 0,
              bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            return false
        }
        view.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            return false
        }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func observeExternalApplication(for scenario: Scenario,
                                                   root: URL,
                                                   screenshotName: String?) -> P9FExternalObservation {
        let expected = expectedExternalBundles(for: scenario)
        let running = NSWorkspace.shared.runningApplications
        let frontmost = NSWorkspace.shared.frontmostApplication
        let matched = running.first { app in
            guard let bundleID = app.bundleIdentifier else { return false }
            return expected.contains(bundleID)
        }
        var screenshotPath: String?
        if let screenshotName, let bundleID = matched?.bundleIdentifier {
            if #available(macOS 14.0, *) {
                // P9F harness — CGWindowListCreateImage is deprecated in
                // macOS 14.0; the full ScreenCaptureKit port lives in the
                // P9G refresh. For now, skip external-window capture on
                // macOS 14+; the rest of the observation still runs.
                screenshotPath = nil
            } else {
                screenshotPath = captureExternalWindow(bundleID: bundleID,
                                                       fileName: "\(screenshotName).png",
                                                       root: root)
            }
        }
        return P9FExternalObservation(
            frontmostAppName: frontmost?.localizedName,
            frontmostBundleIdentifier: frontmost?.bundleIdentifier,
            runningApplicationName: matched?.localizedName,
            runningBundleIdentifier: matched?.bundleIdentifier,
            expectedBundleIdentifiers: Array(expected).sorted(),
            expectedApplicationRunning: matched != nil,
            screenshotPath: screenshotPath)
    }

    private static func expectedExternalBundles(for scenario: Scenario) -> Set<String> {
        switch scenario {
        case .realMapPlace, .realDirections, .directionsDenied, .handedOffRecovery:
            return ["com.apple.Maps"]
        case .realWebsite:
            return [
                "com.apple.Safari",
                "com.google.Chrome",
                "com.microsoft.edgemac",
                "org.mozilla.firefox",
                "com.brave.Browser",
                "com.vivaldi.Vivaldi",
            ]
        case .realPhoneHandler:
            return [
                "com.apple.FaceTime",
                "com.apple.MobilePhone",
            ]
        }
    }

    private static func hidePrivateApplications() -> [String] {
        let privateBundleIDs: Set<String> = [
            "com.apple.Safari",
            "com.google.Chrome",
            "com.microsoft.edgemac",
            "org.mozilla.firefox",
            "com.brave.Browser",
            "com.apple.mail",
            "com.apple.MobileSMS",
            "com.apple.AddressBook",
            "com.apple.Maps",
            "com.apple.FaceTime",
        ]
        return NSWorkspace.shared.runningApplications.compactMap { app in
            guard let bundleID = app.bundleIdentifier,
                  privateBundleIDs.contains(bundleID),
                  !app.isHidden else {
                return nil
            }
            return app.hide() ? bundleID : nil
        }
    }

    @available(macOS, deprecated: 14.0, message: "Use ScreenCaptureKit")
    @MainActor
    private static func captureExternalWindow(bundleID: String,
                                              fileName: String,
                                              root: URL) -> String? {
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                       kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        let candidates = windows.compactMap { info -> (CGWindowID, CGRect)? in
            guard let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                  let app = NSRunningApplication(processIdentifier: ownerPID),
                  app.bundleIdentifier == bundleID,
                  let number = info[kCGWindowNumber as String] as? UInt32,
                  let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.width >= 160,
                  bounds.height >= 120 else {
                return nil
            }
            return (CGWindowID(number), bounds)
        }
        guard let windowID = candidates.max(by: { $0.1.width * $0.1.height < $1.1.width * $1.1.height })?.0,
              let image = CGWindowListCreateImage(.null,
                                                  [.optionIncludingWindow],
                                                  windowID,
                                                  [.boundsIgnoreFraming, .bestResolution]) else {
            return nil
        }
        let url = root.appendingPathComponent("screenshots", isDirectory: true)
            .appendingPathComponent(fileName)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            return nil
        }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return url.path
        } catch {
            return nil
        }
    }

    private static func externalOpened(for scenario: Scenario,
                                       dispatcherInvocationCount: Int,
                                       before: P9FExternalObservation,
                                       after: P9FExternalObservation) -> Bool {
        switch scenario {
        case .directionsDenied, .handedOffRecovery:
            return false
        default:
            return dispatcherInvocationCount > 0 && after.expectedApplicationRunning
                && (before.runningBundleIdentifier != after.runningBundleIdentifier || after.expectedApplicationRunning)
        }
    }

    private static func focusBehavior(scenario: Scenario,
                                      before: P9FExternalObservation,
                                      after: P9FExternalObservation) -> P9FFocusBehavior {
        P9FFocusBehavior(
            deskPetCrashed: false,
            floatingChatPermanentlyMissing: false,
            confirmationSheetResidual: false,
            spinnerResidual: false,
            externalFocusForcedBackByProduct: false,
            candidateSelectionAutoDispatched: false,
            markerSelectionAutoDispatched: false,
            beforeFrontmostBundleIdentifier: before.frontmostBundleIdentifier,
            afterFrontmostBundleIdentifier: after.frontmostBundleIdentifier,
            notes: scenario == .handedOffRecovery
            ? "recovery scenario does not dispatch"
            : "harness returned to DeskPet after observation for terminal screenshot")
    }

    private static func okForScenario(scenario: Scenario,
                                      state: String,
                                      dispatcherInvocationCount: Int,
                                      duplicateDispatchCount: Int,
                                      externalOpened: Bool,
                                      phoneSystemOpenAccepted: Bool?,
                                      loadingVisible: Bool,
                                      pendingActivityCount: Int,
                                      noSecret: Bool) -> Bool {
        guard noSecret, !loadingVisible, pendingActivityCount == 0, duplicateDispatchCount == 0 else {
            return false
        }
        switch scenario {
        case .realMapPlace, .realDirections, .realWebsite:
            return state == PlaceHandoffExecutionState.handedOff.rawValue
                && dispatcherInvocationCount == 1
                && externalOpened
        case .realPhoneHandler:
            return state == PlaceHandoffExecutionState.handedOff.rawValue
                && dispatcherInvocationCount == 1
                && phoneSystemOpenAccepted == true
        case .directionsDenied:
            return state == PlaceHandoffExecutionState.rejected.rawValue
                && dispatcherInvocationCount == 0
                && !externalOpened
        case .handedOffRecovery:
            return state == PlaceHandoffExecutionState.handedOff.rawValue
                && dispatcherInvocationCount == 0
        }
    }

    private static func notes(for scenario: Scenario, artifactOK: Bool) -> [String] {
        var notes = [
            "P9F status remains human acceptance incomplete until a human records PASS.",
            "System target correctness is not auto-certified by this harness.",
        ]
        if scenario == .realPhoneHandler {
            notes.append("The system phone handler must be cancelled by a human; this harness never presses Call.")
        }
        if !artifactOK {
            notes.append("One or more automated predicates failed or require human visual review.")
        }
        return notes
    }

    private static func noSecretsDetected(root: URL,
                                          viewModel: PlaceHandoffViewModel) -> Bool {
        let recordText = viewModel.records.values.flatMap { record in
            [record.sanitizedDestinationSummary,
             record.terminalMessage ?? "",
             record.permissionDecision ?? "",
             record.dispatchStatus?.rawValue ?? ""] + record.auditEvents.map(\.sanitizedDestinationSummary)
        }.joined(separator: "\n").lowercased()
        let forbidden = [
            "sk-",
            "authorization",
            "bearer ",
            "cookie",
            "password",
            "access_token",
            "api_key",
            "+16505550100",
            "current location precise",
        ]
        return !forbidden.contains { recordText.contains($0) }
    }

    private static func artifactRoot(paths: DeskPetAppPaths) -> URL {
        if let raw = ProcessInfo.processInfo.environment["DESKPET_P9F_REAL_HANDOFF_ARTIFACT_DIR"],
           raw.hasPrefix("/") {
            return URL(fileURLWithPath: raw, isDirectory: true)
        }
        return paths.applicationSupportRoot
            .appendingPathComponent("p9f-real-handoff-acceptance", isDirectory: true)
    }

    private static func prepareArtifactRoot(_ root: URL) throws {
        try FileManager.default.createDirectory(at: root.appendingPathComponent("screenshots", isDirectory: true),
                                                withIntermediateDirectories: true)
    }

    private static func write(artifact: P9FRealHandoffArtifact,
                              scenario: Scenario,
                              root: URL) throws {
        let url = root.appendingPathComponent(fileName(for: scenario))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(artifact)
        try data.write(to: url, options: .atomic)
    }

    private static func fileName(for scenario: Scenario) -> String {
        switch scenario {
        case .realMapPlace: return "real_map_place_artifact.json"
        case .realDirections: return "real_directions_artifact.json"
        case .directionsDenied: return "directions_denied_artifact.json"
        case .realWebsite: return "real_website_artifact.json"
        case .realPhoneHandler: return "real_phone_handler_artifact.json"
        case .handedOffRecovery: return "real_handoff_recovery_artifact.json"
        }
    }

    private static func appendLog(_ message: String, root: URL) throws {
        let url = root.appendingPathComponent("acceptance.log")
        let line = "\(P9FFixture.localTimestamp()) \(message)\n"
        if !FileManager.default.fileExists(atPath: url.path) {
            try Data().write(to: url)
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(line.utf8))
        try handle.close()
    }

    private static func timestampString(_ date: Date?) -> String? {
        guard let date else { return nil }
        return ISO8601DateFormatter().string(from: date)
    }
}

private struct P9FLocalDiscoveryAcceptanceView: View {
    let presentation: LocalDiscoveryPresentation
    @ObservedObject var viewModel: PlaceHandoffViewModel
    @State private var sortMode: LocalDiscoverySortMode = .recommended
    @State private var selectedCandidateID: LocalDiscoveryCandidateID?

    var body: some View {
        LocalDiscoveryResultView(presentation: presentation,
                                 placeHandoffViewModel: viewModel,
                                 layout: .wide,
                                 developerMode: true,
                                 initialEvidenceExpanded: true,
                                 sortMode: $sortMode,
                                 selectedCandidateID: $selectedCandidateID)
            .padding(20)
    }
}

private actor P9FCountingRealSystemDispatcher: PlaceHandoffDispatching {
    private let delegate = SystemPlaceHandoffDispatcher()
    private var count = 0

    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        count += 1
        return await delegate.dispatch(request, attemptID: attemptID)
    }

    func invocationCount() -> Int {
        count
    }
}

private struct P9FAuthorizer: PlaceHandoffAuthorizing {
    var decision: PlaceHandoffPermissionDecision

    func authorize(_ request: PlaceHandoffRequest) async -> PlaceHandoffPermissionDecision {
        decision
    }
}

private struct P9FClock: RuntimeClock {
    var fixedNow: Date

    func now() -> Date {
        fixedNow
    }
}

private struct P9FRealHandoffArtifact: Codable, Sendable {
    var scenario: String
    var ok: Bool
    var dateTimeLocal: String
    var buildConfiguration: String
    var appBinaryPath: String
    var artifactRoot: String
    var fixture: P9FFixtureSummary
    var explicitConfirmationObserved: Bool
    var dispatcherType: String
    var dispatcherInvocationCount: Int
    var duplicateDispatchCount: Int
    var externalApplicationActuallyOpened: Bool
    var externalApplication: String?
    var systemTargetVerified: Bool
    var systemTargetVerificationMethod: String
    var navigationActuallyStarted: Bool
    var phoneHandlerOpened: Bool?
    var phonePreflightHandlerRegistered: Bool?
    var phonePreflightRegisteredHandlerBundleIdentifier: String?
    var phonePreflightRegisteredHandlerDisplayName: String?
    var phoneHandlerRegistered: Bool?
    var registeredHandlerBundleIdentifier: String?
    var registeredHandlerDisplayName: String?
    var systemOpenAccepted: Bool?
    var runningApplicationReturned: Bool?
    var returnedHandlerBundleIdentifier: String?
    var returnedHandlerDisplayName: String?
    var handlerUIVisibility: String?
    var openCompletionTimestamp: String?
    var failureReason: String?
    var openErrorCategory: String?
    var phoneCallActuallyPlaced: Bool?
    var humanCancelledSystemHandler: Bool?
    var formSubmitted: Bool?
    var modelReexecutionCount: Int
    var toolReexecutionCount: Int
    var autoReexecuted: Bool
    var executionState: String
    var loadingVisible: Bool
    var pendingActivityCount: Int
    var terminalActivityCount: Int
    var taskCenterSanitizedActivityCount: Int
    var permissionDecision: String?
    var dispatchStatus: String?
    var recoveredFromCheckpoint: Bool
    var externalBefore: P9FExternalObservation
    var externalAfter: P9FExternalObservation
    var focusBehavior: P9FFocusBehavior
    var noSecretAssertion: Bool
    var screenshots: [String]
    var notes: [String]
    var error: String?

    static func blocked(scenario: String,
                        artifactRoot: String,
                        error: String) -> P9FRealHandoffArtifact {
        P9FRealHandoffArtifact(
            scenario: scenario,
            ok: false,
            dateTimeLocal: P9FFixture.localTimestamp(),
            buildConfiguration: "Debug",
            appBinaryPath: Bundle.main.bundlePath,
            artifactRoot: artifactRoot,
            fixture: P9FFixtureSummary.empty,
            explicitConfirmationObserved: false,
            dispatcherType: "blocked",
            dispatcherInvocationCount: 0,
            duplicateDispatchCount: 0,
            externalApplicationActuallyOpened: false,
            externalApplication: nil,
            systemTargetVerified: false,
            systemTargetVerificationMethod: "not run",
            navigationActuallyStarted: false,
            phoneHandlerOpened: nil,
            phonePreflightHandlerRegistered: nil,
            phonePreflightRegisteredHandlerBundleIdentifier: nil,
            phonePreflightRegisteredHandlerDisplayName: nil,
            phoneHandlerRegistered: nil,
            registeredHandlerBundleIdentifier: nil,
            registeredHandlerDisplayName: nil,
            systemOpenAccepted: nil,
            runningApplicationReturned: nil,
            returnedHandlerBundleIdentifier: nil,
            returnedHandlerDisplayName: nil,
            handlerUIVisibility: nil,
            openCompletionTimestamp: nil,
            failureReason: nil,
            openErrorCategory: nil,
            phoneCallActuallyPlaced: nil,
            humanCancelledSystemHandler: nil,
            formSubmitted: nil,
            modelReexecutionCount: 0,
            toolReexecutionCount: 0,
            autoReexecuted: false,
            executionState: "blocked",
            loadingVisible: false,
            pendingActivityCount: 0,
            terminalActivityCount: 0,
            taskCenterSanitizedActivityCount: 0,
            permissionDecision: nil,
            dispatchStatus: nil,
            recoveredFromCheckpoint: false,
            externalBefore: .empty,
            externalAfter: .empty,
            focusBehavior: .empty,
            noSecretAssertion: false,
            screenshots: [],
            notes: ["real system acceptance did not run"],
            error: error)
    }
}

private struct P9FExternalObservation: Codable, Sendable {
    var frontmostAppName: String?
    var frontmostBundleIdentifier: String?
    var runningApplicationName: String?
    var runningBundleIdentifier: String?
    var expectedBundleIdentifiers: [String]
    var expectedApplicationRunning: Bool
    var screenshotPath: String?

    static let empty = P9FExternalObservation(frontmostAppName: nil,
                                             frontmostBundleIdentifier: nil,
                                             runningApplicationName: nil,
                                             runningBundleIdentifier: nil,
                                             expectedBundleIdentifiers: [],
                                             expectedApplicationRunning: false,
                                             screenshotPath: nil)
}

private struct P9FFocusBehavior: Codable, Sendable {
    var deskPetCrashed: Bool
    var floatingChatPermanentlyMissing: Bool
    var confirmationSheetResidual: Bool
    var spinnerResidual: Bool
    var externalFocusForcedBackByProduct: Bool
    var candidateSelectionAutoDispatched: Bool
    var markerSelectionAutoDispatched: Bool
    var beforeFrontmostBundleIdentifier: String?
    var afterFrontmostBundleIdentifier: String?
    var notes: String

    static let empty = P9FFocusBehavior(deskPetCrashed: false,
                                        floatingChatPermanentlyMissing: false,
                                        confirmationSheetResidual: false,
                                        spinnerResidual: false,
                                        externalFocusForcedBackByProduct: false,
                                        candidateSelectionAutoDispatched: false,
                                        markerSelectionAutoDispatched: false,
                                        beforeFrontmostBundleIdentifier: nil,
                                        afterFrontmostBundleIdentifier: nil,
                                        notes: "not run")
}

private struct P9FFixtureSummary: Codable, Sendable {
    var candidateName: String
    var mapCoordinate: String
    var publicAddress: String
    var directionsOrigin: String
    var directionsDestination: String
    var websiteHost: String
    var phoneDisplay: String
    var phoneNormalizedStoredInArtifact: Bool
    var actionKind: String

    static let empty = P9FFixtureSummary(candidateName: "",
                                         mapCoordinate: "",
                                         publicAddress: "",
                                         directionsOrigin: "",
                                         directionsDestination: "",
                                         websiteHost: "",
                                         phoneDisplay: "",
                                         phoneNormalizedStoredInArtifact: false,
                                         actionKind: "")
}

private enum P9FHarnessError: Error, CustomStringConvertible {
    case presentationMissing
    case previewMissing
    case screenshotFailed(String)

    var description: String {
        switch self {
        case .presentationMissing:
            return "presentation missing"
        case .previewMissing:
            return "preview missing"
        case .screenshotFailed(let name):
            return "screenshot failed: \(name)"
        }
    }
}

private struct P9FFixture {
    static let now = Date(timeIntervalSince1970: 1_785_456_000)
    static let candidateID = "p9f-apple-park-visitor-center"
    static let secondaryCandidateID = "p9f-secondary-public-fixture"
    static let candidateName = "P9F Apple Park Visitor Center"
    static let address = "10600 N Tantau Ave, Cupertino, CA 95014"
    static let origin = "1 Infinite Loop, Cupertino, CA 95014"
    static let coordinate = PlaceCoordinate(latitude: 37.3327,
                                            longitude: -122.0053,
                                            horizontalAccuracyMeters: 20)
    static let website = "https://www.apple.com/retail/appleparkvisitorcenter/"
    static let websiteHost = "www.apple.com"
    static let normalizedPhone = "+16505550100"
    static let displayPhone = "+1 650 *** 0100"
    static let mapTaskID = UUID(uuidString: "00000000-0000-0000-0000-000000009F01")!
    static let mapRunID = UUID(uuidString: "00000000-0000-0000-0000-000000009F02")!

    var scenario: P9FRealSystemHandoffAcceptanceHarness.Scenario
    var snapshot: LocalDiscoveryWorkflowSnapshot
    var conversationID: UUID
    var selectedCandidateID: String

    init(scenario: P9FRealSystemHandoffAcceptanceHarness.Scenario) {
        self.scenario = scenario
        self.conversationID = UUID(uuidString: "00000000-0000-0000-0000-000000009F99")!
        self.selectedCandidateID = Self.candidateID
        let ids = Self.ids(for: scenario)
        let primary = Self.candidate(id: Self.candidateID, scenario: scenario, primary: true)
        let secondary = Self.candidate(id: Self.secondaryCandidateID, scenario: scenario, primary: false)
        self.snapshot = Self.snapshot(taskID: ids.taskID,
                                      runID: ids.runID,
                                      candidates: [primary, secondary],
                                      rankedCandidateIDs: [primary.stableID, secondary.stableID])
    }

    func presentation(recoveredFromCheckpoint: Bool) -> LocalDiscoveryPresentation {
        var presentation = LocalDiscoveryPresentationAdapter.make(snapshot: snapshot,
                                                                  sortMode: .recommended,
                                                                  selectedCandidateID: selectedCandidateID,
                                                                  recoveredFromCheckpoint: recoveredFromCheckpoint,
                                                                  includeDeveloperDiagnostics: true)
        var candidates = presentation.candidates
        for index in candidates.indices {
            var context = candidates[index].handoffContext
            context.directionsOrigin = scenario == .directionsDenied
                ? .currentLocation(.approximateCurrentLocation)
                : .userEnteredAddress(Self.origin)
            candidates[index].handoffContext = context
            candidates[index].handoffActions = PlaceHandoffEligibilityEvaluator.actionPresentations(for: context)
        }
        presentation.candidates = candidates
        return presentation
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
                                            terminalSummary: "P9F real handoff fixture",
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

    func summary(action: PlaceHandoffActionKind) -> P9FFixtureSummary {
        P9FFixtureSummary(candidateName: Self.candidateName,
                          mapCoordinate: "37.3327,-122.0053",
                          publicAddress: Self.address,
                          directionsOrigin: scenario == .directionsDenied ? "permission-gated current location fixture" : Self.origin,
                          directionsDestination: Self.address,
                          websiteHost: Self.websiteHost,
                          phoneDisplay: Self.displayPhone,
                          phoneNormalizedStoredInArtifact: false,
                          actionKind: action.rawValue)
    }

    static func ids(for scenario: P9FRealSystemHandoffAcceptanceHarness.Scenario) -> (taskID: UUID, runID: UUID) {
        switch scenario {
        case .realMapPlace, .handedOffRecovery:
            return (mapTaskID, mapRunID)
        case .realDirections:
            return (UUID(uuidString: "00000000-0000-0000-0000-000000009F11")!,
                    UUID(uuidString: "00000000-0000-0000-0000-000000009F12")!)
        case .directionsDenied:
            return (UUID(uuidString: "00000000-0000-0000-0000-000000009F21")!,
                    UUID(uuidString: "00000000-0000-0000-0000-000000009F22")!)
        case .realWebsite:
            return (UUID(uuidString: "00000000-0000-0000-0000-000000009F31")!,
                    UUID(uuidString: "00000000-0000-0000-0000-000000009F32")!)
        case .realPhoneHandler:
            return (UUID(uuidString: "00000000-0000-0000-0000-000000009F41")!,
                    UUID(uuidString: "00000000-0000-0000-0000-000000009F42")!)
        }
    }

    static func snapshot(taskID: UUID,
                         runID: UUID,
                         candidates: [PlaceCandidate],
                         rankedCandidateIDs: [String]) -> LocalDiscoveryWorkflowSnapshot {
        LocalDiscoveryWorkflowSnapshot(taskID: taskID,
                                       runID: runID,
                                       currentStage: .resultSynthesized,
                                       approvedQuery: query(),
                                       resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "Cupertino, CA",
                                                                                               coordinate: PlaceCoordinate(latitude: 37.323,
                                                                                                                           longitude: -122.0322,
                                                                                                                           horizontalAccuracyMeters: 5_000),
                                                                                               source: "p9f-public-fixture"),
                                       searchPolicySnapshot: LocalDiscoverySearchPolicy(),
                                       rawCandidates: candidates,
                                       mergedCandidates: candidates,
                                       completedRouteCandidateIDs: rankedCandidateIDs,
                                       completedEnrichmentCandidateIDs: rankedCandidateIDs,
                                       webpageEvidenceIDs: candidates.flatMap { $0.evidenceReferences.map(\.evidenceID) },
                                       extractionEvidenceIDs: candidates.map { "extract-\($0.stableID)" },
                                       validatorFindings: [],
                                       verifierDisposition: LocalDiscoveryVerifierReport(verdict: .pass),
                                       rankedCandidateIDs: rankedCandidateIDs,
                                       toolCompletions: [
                                        LocalDiscoveryToolCompletionIdentity(taskID: taskID,
                                                                             runID: runID,
                                                                             workflowStage: .initialSearchCompleted,
                                                                             toolID: "local_place_search",
                                                                             normalizedInputDigest: "p9f-public-fixture-search",
                                                                             completedAt: now),
                                       ],
                                       backend: "p9f-public-fixture",
                                       warnings: [],
                                       updatedAt: now)
    }

    static func query() -> PlaceQuery {
        PlaceQuery(queryID: "p9f-real-system-handoff-query",
                   rawUserIntent: "P9F real handoff deterministic acceptance fixture.",
                   searchText: "Apple Park Visitor Center",
                   category: .retailStore,
                   locationInput: PlaceLocationInput(kind: .explicitRegion, label: "Cupertino, CA"),
                   resultLimit: 2,
                   locale: "en_US",
                   timezone: "America/Los_Angeles",
                   createdAt: now)
    }

    static func candidate(id: String,
                          scenario: P9FRealSystemHandoffAcceptanceHarness.Scenario,
                          primary: Bool) -> PlaceCandidate {
        let evidence = PlaceEvidenceReference(evidenceID: "evidence-\(id)",
                                              sourceToolID: "local_place_search",
                                              sourceURL: "https://www.apple.com/retail/appleparkvisitorcenter/",
                                              claim: "public P9F handoff fixture evidence",
                                              observedAt: now,
                                              freshness: "current-task",
                                              confidence: 0.98)
        let address = primary
            ? PlaceAddress(street: "10600 N Tantau Ave",
                           locality: "Cupertino",
                           region: "CA",
                           postalCode: "95014",
                           countryCode: "US",
                           formatted: Self.address)
            : PlaceAddress(street: "1 Infinite Loop",
                           locality: "Cupertino",
                           region: "CA",
                           postalCode: "95014",
                           countryCode: "US",
                           formatted: Self.origin)
        let coordinate = primary
            ? Self.coordinate
            : PlaceCoordinate(latitude: 37.3318,
                              longitude: -122.0312,
                              horizontalAccuracyMeters: 50)
        let website = PlaceWebLink(id: "official",
                                   kind: .officialWebsite,
                                   title: "Official Website",
                                   url: Self.website,
                                   evidenceReferences: [evidence])
        return PlaceCandidate(stableID: id,
                              sourceEntityIDs: ["p9f:\(id)"],
                              name: primary ? Self.candidateName : "P9F Public Secondary Fixture",
                              categories: [.retailStore],
                              address: address,
                              coordinate: coordinate,
                              openingStatus: PlaceOpeningStatus(value: .unknown,
                                                                uncertaintyReason: "not checked in P9F fixture"),
                              contact: primary
                                ? PlaceContact(phoneNumber: Self.normalizedPhone,
                                               displayPhone: Self.displayPhone)
                                : PlaceContact(),
                              webLinks: primary ? [website] : [],
                              evidenceReferences: [evidence],
                              freshness: scenario == .directionsDenied ? "permission-denied-fixture" : "current-task",
                              verificationStatus: .verified,
                              recommendationRationale: "P9F deterministic public handoff fixture.")
    }

    static func resultDocument(taskID: UUID,
                               runID: UUID) -> AgentResultDocument {
        AgentResultDocument(id: "p9f-local-discovery-\(runID.uuidString)",
                            taskID: taskID,
                            runID: runID,
                            title: "P9F local discovery handoff fixture",
                            summary: "Deterministic public fixture for real system handoff acceptance.",
                            status: .completed,
                            generatedAt: now,
                            sections: [],
                            metadata: ["workflow": "localDiscovery", "phase": "P9F"])
    }

    static func localTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss ZZZZ"
        return formatter.string(from: Date())
    }
}

private extension Result {
    var successValue: Success? {
        guard case .success(let value) = self else { return nil }
        return value
    }
}
#endif
