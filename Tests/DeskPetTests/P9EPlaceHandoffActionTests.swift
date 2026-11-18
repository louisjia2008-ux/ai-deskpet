import XCTest
@testable import DeskPet
@testable import PetAgentRuntime

final class P9EPlaceHandoffEligibilityTests: XCTestCase {
    func testValidCoordinateEnablesOpenInMaps() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openInMaps,
                                                                    context: context(coordinate: coordinate()))

        XCTAssertTrue(eligibility.isAvailable)
    }

    func testValidAddressEnablesOpenInMaps() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openInMaps,
                                                                    context: context(coordinate: nil,
                                                                                     address: address()))

        XCTAssertTrue(eligibility.isAvailable)
    }

    func testNoCoordinateOrAddressDisablesMapAction() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openInMaps,
                                                                    context: context(coordinate: nil,
                                                                                     address: nil))

        XCTAssertFalse(eligibility.isAvailable)
        XCTAssertTrue(eligibility.blockingReasons.contains(.missingMapDestination))
    }

    func testConflictingCoordinateBlocksDirections() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openDirections,
                                                                    context: context(findings: [conflict("coordinate")]))

        XCTAssertFalse(eligibility.isAvailable)
        XCTAssertTrue(eligibility.blockingReasons.contains(.coordinateAddressConflict))
    }

    func testPartialCoordinateProducesWarning() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openInMaps,
                                                                    context: context(coordinate: PlaceCoordinate(latitude: 37.78,
                                                                                                                 longitude: -122.41,
                                                                                                                 horizontalAccuracyMeters: 6_500)))

        XCTAssertTrue(eligibility.isAvailable)
        XCTAssertTrue(eligibility.warnings.contains(.partialCoordinate))
    }

    func testOfficialHTTPSWebsiteEnablesWebsiteAction() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openOfficialWebsite,
                                                                    context: context(webLinks: [officialWebsite("https://example.com")]))

        XCTAssertTrue(eligibility.isAvailable)
    }

    func testDirectoryURLDoesNotEnableOfficialWebsiteAction() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openOfficialWebsite,
                                                                    context: context(webLinks: [PlaceWebLink(id: "source",
                                                                                                             kind: .source,
                                                                                                             title: "Directory",
                                                                                                             url: "https://directory.example/place",
                                                                                                             evidenceReferences: evidence())]))

        XCTAssertFalse(eligibility.isAvailable)
        XCTAssertTrue(eligibility.blockingReasons.contains(.websiteMissing))
    }

    func testUnsafeWebsiteSchemesAndCredentialsAreRejected() {
        let credentialURL = "https://" + ["fixture-user", "fixture-pass"].joined(separator: ":") + "@example.invalid"
        let cases: [(String, PlaceHandoffBlockingReason)] = [
            ("javascript:alert(1)", .urlSchemeNotAllowed),
            ("file:///tmp/index.html", .urlSchemeNotAllowed),
            ("data:text/html,<h1>x</h1>", .urlSchemeNotAllowed),
            ("ftp://example.com/menu", .urlSchemeNotAllowed),
            (credentialURL, .urlCredentialsRejected),
            ("https:///missing-host", .urlHostMissing),
            ("chrome://settings", .urlSchemeNotAllowed),
        ]

        for (rawURL, reason) in cases {
            let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openOfficialWebsite,
                                                                        context: context(webLinks: [officialWebsite(rawURL)]))
            XCTAssertFalse(eligibility.isAvailable, rawURL)
            XCTAssertTrue(eligibility.blockingReasons.contains(reason), rawURL)
        }
    }

    func testWebsiteSpoofingRisksWarnOrBlock() {
        let unicode = PlaceHandoffURLValidator.validate("https://ｅxample.com",
                                                        classification: .official)
        let punycode = PlaceHandoffURLValidator.validate("https://xn--e1awd7f.com",
                                                         classification: .official)
        let redirector = PlaceHandoffURLValidator.validate("https://example.com/redirect?url=https://evil.example",
                                                           classification: .official)
        let tracking = PlaceHandoffURLValidator.validate("https://example.com/path?token=secret&utm_source=test",
                                                         classification: .official)
        let credentialSpoof = PlaceHandoffURLValidator.validate("https://trusted.example@evil.example",
                                                                classification: .official)

        XCTAssertTrue(unicode.warnings.contains(.unicodeHost))
        XCTAssertTrue(punycode.warnings.contains(.punycodeHost))
        XCTAssertTrue(redirector.warnings.contains(.redirectorURL))
        XCTAssertTrue(tracking.warnings.contains(.trackingQueryRemovedFromAudit))
        XCTAssertTrue(credentialSpoof.blockingReasons.contains(.urlCredentialsRejected))
        XCTAssertFalse(tracking.sanitizedAuditSummary?.contains("secret") ?? true)
    }

    func testValidPhoneEnablesPhoneHandoff() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.startPhoneHandoff,
                                                                    context: context(contact: PlaceContact(phoneNumber: "(415) 555-0123",
                                                                                                           displayPhone: "(415) 555-0123")))

        XCTAssertTrue(eligibility.isAvailable)
    }

    func testConflictingPhoneBlocksPhoneHandoff() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.startPhoneHandoff,
                                                                    context: context(contact: PlaceContact(phoneNumber: "+14155550123"),
                                                                                     findings: [conflict("phone")]))

        XCTAssertFalse(eligibility.isAvailable)
        XCTAssertTrue(eligibility.blockingReasons.contains(.phoneConflict))
    }

    func testUnsafePhoneValuesAreRejected() {
        let cases: [(String, PlaceHandoffBlockingReason)] = [
            ("*123#", .phoneUSSDRejected),
            ("415,555,0123", .phonePauseWaitRejected),
            ("telprompt:+14155550123", .phoneInvalid),
            ("+14155550123<script>", .phoneInvalid),
            (String(repeating: "1", count: 32), .phoneInvalid),
        ]

        for (raw, reason) in cases {
            let result = PlacePhoneNumberValidator.validate(rawNumber: raw)
            XCTAssertTrue(result.blockingReasons.contains(reason), raw)
        }
    }

    func testPhoneNormalizationPreservesDialableMainNumberAndWarnings() {
        let international = PlacePhoneNumberValidator.validate(rawNumber: "+44 20 7946 0958")
        let localUS = PlacePhoneNumberValidator.validate(rawNumber: "(415) 555-0123")
        let extensionNumber = PlacePhoneNumberValidator.validate(rawNumber: "+1 415 555 0123 ext. 44")
        let vanity = PlacePhoneNumberValidator.validate(rawNumber: "1-800-FLOWERS")

        XCTAssertEqual(international.normalizedNumber, "+442079460958")
        XCTAssertEqual(localUS.normalizedNumber, "+14155550123")
        XCTAssertEqual(extensionNumber.normalizedNumber, "+14155550123")
        XCTAssertTrue(extensionNumber.warnings.contains(.phoneExtensionRequiresManualEntry))
        XCTAssertEqual(vanity.normalizedNumber, "+18003569377")
        XCTAssertTrue(vanity.warnings.contains(.vanityPhoneNumberNormalized))
    }

    func testStaleWebsiteAndPhoneProduceWarnings() {
        let staleWebsite = PlaceHandoffEligibilityEvaluator.evaluate(.openOfficialWebsite,
                                                                     context: context(webLinks: [officialWebsite("https://example.com",
                                                                                                                  evidenceReferences: evidence(freshness: "stale-source"))],
                                                                                      verificationStatus: .stale,
                                                                                      freshness: "stale-source"))
        let stalePhone = PlaceHandoffEligibilityEvaluator.evaluate(.startPhoneHandoff,
                                                                   context: context(contact: PlaceContact(phoneNumber: "+14155550123"),
                                                                                    verificationStatus: .stale,
                                                                                    freshness: "stale-source"))

        XCTAssertTrue(staleWebsite.isAvailable)
        XCTAssertTrue(staleWebsite.warnings.contains(.staleEvidence))
        XCTAssertTrue(stalePhone.isAvailable)
        XCTAssertTrue(stalePhone.warnings.contains(.staleEvidence))
    }

    func testCandidateNoLongerPresentBlocksAction() {
        let eligibility = PlaceHandoffEligibilityEvaluator.evaluate(.openInMaps,
                                                                    context: context(isPresent: false))

        XCTAssertFalse(eligibility.isAvailable)
        XCTAssertTrue(eligibility.blockingReasons.contains(.candidateNoLongerPresent))
    }
}

@MainActor
final class P9EPlaceHandoffExecutionTests: XCTestCase {
    func testPrepareRequiresExplicitClickAndDoesNotDispatch() async {
        let dispatcher = FakePlaceHandoffDispatcher(result: .accepted("已交给系统地图"))
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock())
        let candidate = candidatePresentation(context: context())

        XCTAssertNil(viewModel.activePreview)
        let initialCount = await dispatcher.invocationCount()
        XCTAssertEqual(initialCount, 0)

        viewModel.prepare(action: .openInMaps, candidate: candidate)

        XCTAssertNotNil(viewModel.activePreview)
        let previewCount = await dispatcher.invocationCount()
        XCTAssertEqual(previewCount, 0)
    }

    func testConfirmationCloseDoesNotDispatch() async throws {
        let dispatcher = FakePlaceHandoffDispatcher(result: .accepted("已交给系统地图"))
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock())
        viewModel.prepare(action: .openInMaps, candidate: candidatePresentation(context: context()))
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

        viewModel.dismissActivePreview()

        let count = await dispatcher.invocationCount()
        XCTAssertEqual(count, 0)
        XCTAssertEqual(viewModel.record(for: requestID)?.state, .cancelled)
    }

    func testConfirmDispatchesExactlyOnceAndDoubleClickIsDeduped() async throws {
        let dispatcher = FakePlaceHandoffDispatcher(result: .accepted("已交给系统地图"))
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock())
        viewModel.prepare(action: .openInMaps, candidate: candidatePresentation(context: context()))
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

        await viewModel.confirm(requestID)
        await viewModel.confirm(requestID)

        let count = await dispatcher.invocationCount()
        XCTAssertEqual(count, 1)
        XCTAssertEqual(viewModel.record(for: requestID)?.state, .handedOff)
        XCTAssertEqual(viewModel.record(for: requestID)?.duplicateDispatchCount, 1)
    }

    func testDeniedAndCancelledPermissionDoNotDispatch() async throws {
        for decision in [PlaceHandoffPermissionDecision.denied("denied"), .cancelled("cancelled")] {
            let dispatcher = FakePlaceHandoffDispatcher(result: .accepted("已交给系统地图"))
            let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(decision),
                                                  dispatcher: dispatcher,
                                                  clock: TestClock())
            viewModel.prepare(action: .openDirections, candidate: candidatePresentation(context: context()))
            let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

            await viewModel.confirm(requestID)

            let count = await dispatcher.invocationCount()
            let state = viewModel.record(for: requestID)?.state
            XCTAssertEqual(count, 0)
            XCTAssertTrue(state == .rejected || state == .cancelled)
        }
    }

    func testPreviewContainsCandidateWarningAndImmutableDestination() throws {
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: FakePlaceHandoffDispatcher(result: .accepted("已交给默认浏览器")),
                                              clock: TestClock())
        let original = candidatePresentation(context: context(webLinks: [officialWebsite("https://example.com",
                                                                                         evidenceReferences: evidence(freshness: "stale-source"))],
                                                             verificationStatus: .stale,
                                                             freshness: "stale-source"))
        let changed = candidatePresentation(context: context(webLinks: [officialWebsite("https://changed.example")]))

        viewModel.prepare(action: .openOfficialWebsite, candidate: original)
        let preview = try XCTUnwrap(viewModel.activePreview)
        XCTAssertTrue(preview.candidateName.contains("Test Place"))
        XCTAssertTrue(preview.warnings.contains(PlaceHandoffWarning.staleEvidence.userMessage))

        _ = changed
        if case .website(let url, _) = preview.request.destination {
            XCTAssertEqual(url.host, "example.com")
        } else {
            XCTFail("Expected website destination")
        }
    }

    func testDispatcherStatusesMapToTerminalStates() async throws {
        let cases: [(PlaceHandoffDispatchStatus, PlaceHandoffExecutionState)] = [
            (.acceptedBySystem, .handedOff),
            (.rejected, .rejected),
            (.unavailableHandler, .rejected),
            (.malformedDestination, .rejected),
            (.cancelledBeforeSubmit, .cancelled),
            (.cancelledAfterSubmit, .handedOff),
            (.failed, .failed),
            (.timedOut, .failed),
            (.duplicateRequest, .rejected),
        ]

        for (status, expectedState) in cases {
            let dispatcher = FakePlaceHandoffDispatcher(result: PlaceHandoffDispatchResult(status: status,
                                                                                           userMessage: status.rawValue,
                                                                                           submittedToSystem: status == .acceptedBySystem || status == .cancelledAfterSubmit))
            let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                                  dispatcher: dispatcher,
                                                  clock: TestClock())
            viewModel.prepare(action: .openInMaps, candidate: candidatePresentation(context: context(candidateID: "candidate-\(status.rawValue)")))
            let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

            await viewModel.confirm(requestID)

            XCTAssertEqual(viewModel.record(for: requestID)?.state, expectedState, status.rawValue)
            let count = await dispatcher.invocationCount()
            XCTAssertEqual(count, 1, status.rawValue)
        }
    }

    func testRecoveryNeverDispatchesAndRetryCreatesNewAttempt() async throws {
        let request = try request(action: .openInMaps, context: context())
        let oldAttempt = PlaceHandoffRequestBuilder.newAttemptID(requestID: request.requestID,
                                                                 attemptIndex: 1)
        let dispatching = PlaceHandoffExecutionRecord(request: request,
                                                      state: .dispatching,
                                                      attemptID: oldAttempt,
                                                      permissionDecision: "approved",
                                                      updatedAt: Date(timeIntervalSinceReferenceDate: 0))
        let dispatcher = FakePlaceHandoffDispatcher(result: .accepted("已交给系统地图"))
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock(),
                                              initialRecords: [dispatching])

        XCTAssertEqual(viewModel.record(for: request.requestID)?.state, .interrupted)
        let recoveredCount = await dispatcher.invocationCount()
        XCTAssertEqual(recoveredCount, 0)

        viewModel.prepare(action: .openInMaps, candidate: candidatePresentation(context: context()))
        await viewModel.retry(request.requestID)

        let retryCount = await dispatcher.invocationCount()
        let attemptIDs = await dispatcher.attemptIDs()
        XCTAssertEqual(retryCount, 1)
        XCTAssertEqual(attemptIDs.first, PlaceHandoffRequestBuilder.newAttemptID(requestID: request.requestID,
                                                                                 attemptIndex: 2))
        XCTAssertEqual(viewModel.record(for: request.requestID)?.state, .handedOff)
    }

    func testRecoveredTerminalStatesDoNotReexecute() async throws {
        let request = try request(action: .openInMaps, context: context())
        let terminalStates: [PlaceHandoffExecutionState] = [.handedOff, .cancelled, .rejected, .failed]

        for state in terminalStates {
            let dispatcher = FakePlaceHandoffDispatcher(result: .accepted("已交给系统地图"))
            let record = PlaceHandoffExecutionRecord(request: request,
                                                     state: state,
                                                     updatedAt: Date(timeIntervalSinceReferenceDate: 0))
            let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                                  dispatcher: dispatcher,
                                                  clock: TestClock(),
                                                  initialRecords: [record])

            XCTAssertEqual(viewModel.record(for: request.requestID)?.state, state)
            let count = await dispatcher.invocationCount()
            XCTAssertEqual(count, 0)
        }
    }

    func testAuditSummarySanitizesURLAndPhone() throws {
        let websiteRequest = try request(action: .openOfficialWebsite,
                                         context: context(webLinks: [officialWebsite("https://example.com/book?token=secret&utm_source=test#section")]))
        let phoneRequest = try request(action: .startPhoneHandoff,
                                       context: context(contact: PlaceContact(phoneNumber: "+14155550123",
                                                                              displayPhone: "(415) 555-0123")))

        XCTAssertFalse(websiteRequest.destination.auditSummary.contains("secret"))
        XCTAssertFalse(websiteRequest.destination.auditSummary.contains("utm_source"))
        XCTAssertFalse(websiteRequest.destination.auditSummary.contains("#section"))
        XCTAssertTrue(phoneRequest.destination.auditSummary.contains("...0123"))
        XCTAssertFalse(phoneRequest.destination.auditSummary.contains("+14155550123"))
    }

    func testDispatchingStateDisablesActionAndTerminalClearsRunningState() async throws {
        let dispatcher = SlowPlaceHandoffDispatcher()
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock())
        let candidate = candidatePresentation(context: context())
        viewModel.prepare(action: .openInMaps, candidate: candidate)
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

        let task = Task {
            await viewModel.confirm(requestID)
        }
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertTrue(viewModel.isDispatching(action: .openInMaps, candidate: candidate))
        await viewModel.confirm(requestID)
        XCTAssertEqual(viewModel.record(for: requestID)?.duplicateDispatchCount, 1)

        await task.value
        XCTAssertFalse(viewModel.isDispatching(action: .openInMaps, candidate: candidate))
        XCTAssertEqual(viewModel.record(for: requestID)?.state, .handedOff)
        let count = await dispatcher.invocationCount()
        XCTAssertEqual(count, 1)
    }
}

@MainActor
final class P9EPlaceHandoffPresentationViewModelTests: XCTestCase {
    func testActionPresentationExposesEligibleActionsUnavailableReasonsAndAccessibility() {
        let available = candidatePresentation(context: context())
        let blocked = candidatePresentation(context: context(coordinate: nil,
                                                            address: nil,
                                                            contact: PlaceContact(),
                                                            webLinks: []))

        let mapsAction = action(.openInMaps, in: available)
        XCTAssertTrue(mapsAction.eligibility.isAvailable)
        XCTAssertEqual(mapsAction.compactTitle, "地图")
        XCTAssertEqual(mapsAction.accessibilityLabel, "在地图中打开")
        XCTAssertEqual(mapsAction.accessibilityHint, "需要点击后预览并确认")

        let blockedMap = action(.openInMaps, in: blocked)
        let blockedWebsite = action(.openOfficialWebsite, in: blocked)
        let blockedPhone = action(.startPhoneHandoff, in: blocked)
        XCTAssertFalse(blockedMap.eligibility.isAvailable)
        XCTAssertTrue(blockedMap.eligibility.blockingReasons.contains(.missingMapDestination))
        XCTAssertTrue(blockedMap.accessibilityHint.contains("地图"))
        XCTAssertFalse(blockedWebsite.eligibility.isAvailable)
        XCTAssertTrue(blockedWebsite.eligibility.blockingReasons.contains(.websiteMissing))
        XCTAssertFalse(blockedPhone.eligibility.isAvailable)
        XCTAssertTrue(blockedPhone.eligibility.blockingReasons.contains(.phoneMissing))
    }

    func testPreviewSeparatesUserWarningsFromDeveloperDiagnostics() throws {
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: FakePlaceHandoffDispatcher(result: .accepted("已交给默认浏览器")),
                                              clock: TestClock())
        let candidate = candidatePresentation(context: context(webLinks: [officialWebsite("https://example.com",
                                                                                          evidenceReferences: evidence(freshness: "stale-source"))],
                                                              verificationStatus: .stale,
                                                              freshness: "stale-source"))

        viewModel.prepare(action: .openOfficialWebsite, candidate: candidate)

        let preview = try XCTUnwrap(viewModel.activePreview)
        XCTAssertTrue(preview.warnings.contains(PlaceHandoffWarning.staleEvidence.userMessage))
        XCTAssertFalse(preview.warnings.contains("place.openOfficialWebsite"))
        XCTAssertTrue(preview.developerDiagnostics.contains { $0.id == "action" && $0.value == PlaceHandoffActionKind.openOfficialWebsite.rawValue })
        XCTAssertTrue(preview.developerDiagnostics.contains { $0.id == "request" && $0.value == preview.request.requestID })
    }

    private func action(_ kind: PlaceHandoffActionKind,
                        in candidate: LocalDiscoveryCandidatePresentation) -> PlaceHandoffActionPresentation {
        candidate.handoffActions.first(where: { $0.action == kind })!
    }
}

final class P9FSystemPlaceHandoffDispatcherBoundaryTests: XCTestCase {
    @MainActor
    func testPhoneResolverNilMakesActionUnavailableBeforeConfirmation() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: nil)
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: FakePlaceHandoffDispatcher(result: .accepted("unused")),
                                              clock: TestClock(),
                                              handlerResolver: resolver,
                                              releaseSupportPolicy: .internalConformanceForTesting)
        let candidate = candidatePresentation(context: context())
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)
        let phone = try XCTUnwrap(candidate.handoffActions.first { $0.action == .startPhoneHandoff })

        let eligibility = viewModel.environmentEligibility(for: phone, candidate: candidate)

        XCTAssertFalse(eligibility.isAvailable)
        XCTAssertTrue(eligibility.blockingReasons.contains(.phoneHandlerUnavailable))
    }

    @MainActor
    func testPhoneResolverHandlerMakesActionEligible() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: FakePlaceHandoffDispatcher(result: .accepted("unused")),
                                              clock: TestClock(),
                                              handlerResolver: resolver,
                                              releaseSupportPolicy: .internalConformanceForTesting)
        let candidate = candidatePresentation(context: context())
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)
        let phone = try XCTUnwrap(candidate.handoffActions.first { $0.action == .startPhoneHandoff })

        let eligibility = viewModel.environmentEligibility(for: phone, candidate: candidate)

        XCTAssertTrue(eligibility.isAvailable)
        XCTAssertFalse(eligibility.blockingReasons.contains(.phoneHandlerUnavailable))
    }

    func testPhoneHandlerExistsButAsyncOpenErrorFails() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: false,
            runningApplicationBundleIdentifier: nil,
            runningApplicationDisplayName: nil,
            errorCategory: "NSWorkspaceOpenError.-10814",
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 10)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      urlOpener: { _ in XCTFail("phone must not use generic URL opener"); return false },
                                                      mapItemOpener: { _, _ in XCTFail("phone must not use map opener"); return false },
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)

        let result = await dispatcher.dispatch(phoneRequest(), attemptID: "p9f-phone-open-error")

        XCTAssertEqual(result.status, .failed)
        XCTAssertFalse(result.submittedToSystem)
        XCTAssertEqual(result.externalHandlerAudit?.phoneHandlerRegistered, true)
        XCTAssertEqual(result.externalHandlerAudit?.systemOpenAccepted, false)
        XCTAssertEqual(result.externalHandlerAudit?.failureReason, .systemOpenFailed)
        XCTAssertEqual(result.externalHandlerAudit?.handlerUIVisibility, .unverified)
    }

    func testPhoneHandlerExistsAndReturnsRunningApplicationHandsOff() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 11)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)

        let result = await dispatcher.dispatch(phoneRequest(), attemptID: "p9f-phone-open-success")

        XCTAssertEqual(result.status, .acceptedBySystem)
        XCTAssertTrue(result.submittedToSystem)
        XCTAssertEqual(result.externalHandlerAudit?.phoneHandlerRegistered, true)
        XCTAssertEqual(result.externalHandlerAudit?.systemOpenAccepted, true)
        XCTAssertEqual(result.externalHandlerAudit?.runningApplicationReturned, true)
        XCTAssertEqual(result.externalHandlerAudit?.returnedHandlerBundleIdentifier, "com.apple.FaceTime")
    }

    @MainActor
    func testHandedOffPhoneDefaultsVisibilityToUnverifiedAndDoesNotAutoFailWhenUIIsUnobserved() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 12)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock(),
                                              handlerResolver: resolver,
                                              releaseSupportPolicy: .internalConformanceForTesting)
        let candidate = candidatePresentation(context: context())
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)
        viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

        await viewModel.confirm(requestID)

        let record = try XCTUnwrap(viewModel.record(for: requestID))
        XCTAssertEqual(record.state, .handedOff)
        XCTAssertEqual(record.externalHandlerAudit?.handlerUIVisibility, .unverified)
        XCTAssertNotEqual(record.externalHandlerAudit?.handlerUIVisibility, .humanObserved)
    }

    func testOnlyHumanAcceptanceCanMarkPhoneHandlerVisibilityObserved() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 13)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)

        let result = await dispatcher.dispatch(phoneRequest(), attemptID: "p9f-phone-human-observed")

        XCTAssertEqual(result.externalHandlerAudit?.handlerUIVisibility, .unverified)
        XCTAssertNotEqual(result.externalHandlerAudit?.handlerUIVisibility, .humanObserved)
    }

    func testRecoveryPreservesUnverifiedVisibilityAndDoesNotUpgrade() throws {
        let request = phoneRequest()
        let record = PlaceHandoffExecutionRecord(
            request: request,
            state: .handedOff,
            dispatchStatus: .acceptedBySystem,
            terminalMessage: "已交给系统电话处理程序",
            updatedAt: Date(timeIntervalSinceReferenceDate: 20),
            externalHandlerAudit: PlaceHandoffExternalHandlerAudit(
                phoneHandlerRegistered: true,
                systemOpenAccepted: true,
                runningApplicationReturned: true,
                returnedHandlerBundleIdentifier: "com.apple.FaceTime",
                handlerUIVisibility: .unverified,
                openCompletionTimestamp: Date(timeIntervalSinceReferenceDate: 19)))

        let recovered = PlaceHandoffRecoveryPolicy.recover([record],
                                                           now: Date(timeIntervalSinceReferenceDate: 30))

        XCTAssertEqual(recovered.first?.state, .handedOff)
        XCTAssertEqual(recovered.first?.externalHandlerAudit?.handlerUIVisibility, .unverified)
    }

    @MainActor
    func testRecoveryDoesNotReopenPhoneURL() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 21)))
        let dispatcher = SystemPlaceHandoffDispatcher(handlerResolver: resolver,
                                                      phoneOpener: opener)
        let request = phoneRequest()
        let initial = PlaceHandoffExecutionRecord(request: request,
                                                  state: .handedOff,
                                                  dispatchStatus: .acceptedBySystem,
                                                  terminalMessage: "已交给系统电话处理程序",
                                                  updatedAt: Date(timeIntervalSinceReferenceDate: 22),
                                                  externalHandlerAudit: PlaceHandoffExternalHandlerAudit(
                                                    phoneHandlerRegistered: true,
                                                    systemOpenAccepted: true,
                                                    runningApplicationReturned: true,
                                                    handlerUIVisibility: .unverified))
        _ = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                  dispatcher: dispatcher,
                                  clock: TestClock(),
                                  handlerResolver: resolver,
                                  initialRecords: [initial])

        let openCount = await opener.openCount()

        XCTAssertEqual(openCount, 0)
    }

    @MainActor
    func testHandlerCacheDoesNotPolluteDifferentSchemes() throws {
        let cache = ExternalURLHandlerAvailabilityCache()
        let tel = try XCTUnwrap(URL(string: "tel:+14155550123"))
        let facetime = try XCTUnwrap(URL(string: "facetime:+14155550123"))

        cache.update(url: tel,
                     handlerURL: nil,
                     resolvedAt: Date(timeIntervalSinceReferenceDate: 31))

        XCTAssertEqual(cache.availability(for: tel, now: Date(timeIntervalSinceReferenceDate: 31))?.isRegistered, false)
        XCTAssertNil(cache.availability(for: facetime, now: Date(timeIntervalSinceReferenceDate: 31)))
    }

    @MainActor
    func testDefaultFakeResolverDoesNotOpenSystemApp() async throws {
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              clock: TestClock())
        let candidate = candidatePresentation(context: context())

        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)
        viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)

        let request = try request(action: .startPhoneHandoff, context: candidate.handoffContext)
        let record = try XCTUnwrap(viewModel.record(for: request.requestID))
        XCTAssertEqual(record.state, .rejected)
        XCTAssertEqual(record.externalHandlerAudit?.phoneHandlerRegistered, false)
        XCTAssertEqual(record.externalHandlerAudit?.systemOpenAccepted, false)
    }

    func testPhoneHandoffDoesNotFallbackToFaceTimeOrCustomScheme() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 32)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)

        _ = await dispatcher.dispatch(phoneRequest(), attemptID: "p9f-phone-no-fallback")

        let openedSchemes = await opener.openedURLs().compactMap { $0.scheme?.lowercased() }
        let resolvedSchemes = await resolver.requestedSchemes()
        XCTAssertEqual(openedSchemes, ["tel"])
        XCTAssertEqual(resolvedSchemes, ["tel"])
        XCTAssertFalse(openedSchemes.contains("facetime"))
        XCTAssertFalse(openedSchemes.contains("facetime-audio"))
    }

    @MainActor
    func testPhoneAuditDoesNotRecordFullNumber() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 33)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: dispatcher,
                                              clock: TestClock(),
                                              handlerResolver: resolver,
                                              releaseSupportPolicy: .internalConformanceForTesting)
        let candidate = candidatePresentation(context: context(contact: PlaceContact(phoneNumber: "+14155550123",
                                                                                     displayPhone: "(415) 555-0123")))
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)
        viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

        await viewModel.confirm(requestID)

        let record = try XCTUnwrap(viewModel.record(for: requestID))
        let auditText = ([record.sanitizedDestinationSummary, record.terminalMessage ?? ""] +
                         record.auditEvents.map(\.sanitizedDestinationSummary) +
                         record.auditEvents.compactMap(\.diagnosticSummary)).joined(separator: "\n")
        XCTAssertFalse(auditText.contains("+14155550123"))
        XCTAssertTrue(auditText.contains("...0123"))
    }

    @MainActor
    func testHandlerUnavailableDoesNotRecordHandedOff() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: nil)
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              dispatcher: FakePlaceHandoffDispatcher(result: .accepted("unused")),
                                              clock: TestClock(),
                                              handlerResolver: resolver)
        let candidate = candidatePresentation(context: context())
        await viewModel.refreshExternalHandlerEligibility(action: .startPhoneHandoff,
                                                         candidate: candidate)

        viewModel.prepare(action: .startPhoneHandoff, candidate: candidate)

        let request = try request(action: .startPhoneHandoff, context: candidate.handoffContext)
        let record = try XCTUnwrap(viewModel.record(for: request.requestID))
        XCTAssertEqual(record.state, .rejected)
        XCTAssertEqual(record.dispatchStatus, .unavailableHandler)
        XCTAssertNotEqual(record.state, .handedOff)
        XCTAssertEqual(record.externalHandlerAudit?.failureReason, .systemHandlerUnavailable)
    }

    func testPhoneOpenCompletionIsHandledOnce() async throws {
        let resolver = FakeExternalURLHandlerResolver(handlerURL: try fakeHandlerURL())
        let opener = FakeExternalURLSystemOpener(result: ExternalURLOpenResult(
            systemOpenAccepted: true,
            runningApplicationBundleIdentifier: "com.apple.FaceTime",
            runningApplicationDisplayName: "FaceTime",
            errorCategory: nil,
            completionTimestamp: Date(timeIntervalSinceReferenceDate: 34)))
        let dispatcher = SystemPlaceHandoffDispatcher(releaseSupportPolicy: .internalConformanceForTesting,
                                                      handlerResolver: resolver,
                                                      phoneOpener: opener)

        _ = await dispatcher.dispatch(phoneRequest(), attemptID: "p9f-phone-once")

        let openCount = await opener.openCount()
        XCTAssertEqual(openCount, 1)
    }

    func testDirectMaliciousURLRequestsAreRejectedBeforeExternalOpen() async throws {
        let cases = [
            "javascript:alert(1)",
            "file:///tmp/p9f.html",
            "data:text/html,<h1>p9f</h1>",
        ]

        for rawURL in cases {
            let openers = RecordingSystemOpeners()
            let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                          mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
            let request = directRequest(action: .openOfficialWebsite,
                                        destination: .website(url: try XCTUnwrap(URL(string: rawURL)),
                                                              classification: .official))

            let result = await dispatcher.dispatch(request, attemptID: "p9f-malicious-url-\(rawURL.count)")

            XCTAssertEqual(result.status, .malformedDestination, rawURL)
            XCTAssertFalse(result.submittedToSystem, rawURL)
            let invocationCount = await openers.invocationCount()
            XCTAssertEqual(invocationCount, 0, rawURL)
        }
    }

    func testDirectCredentialAndNonOfficialWebsiteRequestsAreRejectedBeforeExternalOpen() async throws {
        let credentialURL = "https://" + ["fixture-user", "fixture-pass"].joined(separator: ":") + "@example.invalid"
        let cases: [(URL, WebsiteClassification)] = [
            (try XCTUnwrap(URL(string: credentialURL)), .official),
            (try XCTUnwrap(URL(string: "https://directory.example/place")), .directory),
            (try XCTUnwrap(URL(string: "https:///missing-host")), .official),
        ]

        for (url, classification) in cases {
            let openers = RecordingSystemOpeners()
            let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                          mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
            let request = directRequest(action: .openOfficialWebsite,
                                        destination: .website(url: url, classification: classification))

            let result = await dispatcher.dispatch(request, attemptID: "p9f-website-\(classification.rawValue)")

            XCTAssertEqual(result.status, .malformedDestination)
            XCTAssertFalse(result.submittedToSystem)
            let invocationCount = await openers.invocationCount()
            XCTAssertEqual(invocationCount, 0)
        }
    }

    func testDirectInvalidPhoneRequestsAreRejectedBeforeExternalOpen() async {
        let cases = [
            "telprompt:+14155550123",
            "*123#",
            "+14155550123,44",
            "+14155550123;44",
        ]

        for rawNumber in cases {
            let openers = RecordingSystemOpeners()
            let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                          mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
            let request = directRequest(action: .startPhoneHandoff,
                                        destination: .phone(normalizedNumber: rawNumber,
                                                            displayNumber: "P9F test number"))

            let result = await dispatcher.dispatch(request, attemptID: "p9f-phone-\(rawNumber.count)")

            XCTAssertEqual(result.status, .malformedDestination, rawNumber)
            XCTAssertFalse(result.submittedToSystem, rawNumber)
            let invocationCount = await openers.invocationCount()
            XCTAssertEqual(invocationCount, 0, rawNumber)
        }
    }

    func testDirectInvalidCoordinateAndMissingDirectionsOriginAreRejectedBeforeExternalOpen() async {
        let openers = RecordingSystemOpeners()
        let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                      mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
        let invalidMap = directRequest(action: .openInMaps,
                                       destination: .mapPlace(name: "P9F Place",
                                                              coordinate: PlaceCoordinate(latitude: 999,
                                                                                          longitude: -122.41),
                                                              postalAddress: nil))
        let missingOrigin = directRequest(action: .openDirections,
                                          destination: .directions(destinationName: "P9F Place",
                                                                   destinationCoordinate: coordinate(),
                                                                   destinationAddress: nil,
                                                                   origin: .none))

        let mapResult = await dispatcher.dispatch(invalidMap, attemptID: "p9f-invalid-coordinate")
        let directionsResult = await dispatcher.dispatch(missingOrigin, attemptID: "p9f-missing-origin")

        XCTAssertEqual(mapResult.status, .malformedDestination)
        XCTAssertEqual(directionsResult.status, .malformedDestination)
        XCTAssertFalse(mapResult.submittedToSystem)
        XCTAssertFalse(directionsResult.submittedToSystem)
        let invocationCount = await openers.invocationCount()
        XCTAssertEqual(invocationCount, 0)
    }

    func testPreviewDestinationMutationIsRejectedByRequestIDIntegrityBeforeExternalOpen() async throws {
        let openers = RecordingSystemOpeners()
        let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                      mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
        let original = try request(action: .openOfficialWebsite,
                                   context: context(webLinks: [officialWebsite("https://example.com")]))
        let mutated = PlaceHandoffRequest(requestID: original.requestID,
                                          taskID: original.taskID,
                                          runID: original.runID,
                                          candidateID: original.candidateID,
                                          action: original.action,
                                          destination: .website(url: try XCTUnwrap(URL(string: "https://changed.example")),
                                                                classification: .official),
                                          evidenceState: original.evidenceState,
                                          requestedAt: original.requestedAt)

        let result = await dispatcher.dispatch(mutated, attemptID: "p9f-mutated-destination")

        XCTAssertEqual(result.status, .malformedDestination)
        XCTAssertTrue(result.diagnosticSummary.contains(PlaceHandoffBlockingReason.dataCorrupted.rawValue))
        XCTAssertFalse(result.submittedToSystem)
        let invocationCount = await openers.invocationCount()
        XCTAssertEqual(invocationCount, 0)
    }

    func testActionDestinationMismatchIsRejectedBeforeExternalOpen() async throws {
        let openers = RecordingSystemOpeners()
        let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                      mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
        let destination = PlaceHandoffDestination.website(url: try XCTUnwrap(URL(string: "https://example.com")),
                                                          classification: .official)
        let request = directRequest(action: .openInMaps, destination: destination)

        let result = await dispatcher.dispatch(request, attemptID: "p9f-action-destination-mismatch")

        XCTAssertEqual(result.status, .malformedDestination)
        XCTAssertFalse(result.submittedToSystem)
        let invocationCount = await openers.invocationCount()
        XCTAssertEqual(invocationCount, 0)
    }

    func testDuplicateTerminalRequestDoesNotReopenExternalApplication() async throws {
        let openers = RecordingSystemOpeners()
        let dispatcher = SystemPlaceHandoffDispatcher(urlOpener: { url in await openers.openURL(url) },
                                                      mapItemOpener: { name, coordinate in await openers.openMapItem(name: name, coordinate: coordinate) })
        let request = directRequest(action: .openOfficialWebsite,
                                    destination: .website(url: try XCTUnwrap(URL(string: "https://example.com")),
                                                          classification: .official))

        let first = await dispatcher.dispatch(request, attemptID: "p9f-duplicate-attempt")
        let second = await dispatcher.dispatch(request, attemptID: "p9f-duplicate-attempt")

        XCTAssertEqual(first.status, .acceptedBySystem)
        XCTAssertTrue(first.submittedToSystem)
        XCTAssertEqual(second.status, .duplicateRequest)
        XCTAssertFalse(second.submittedToSystem)
        let invocationCount = await openers.invocationCount()
        XCTAssertEqual(invocationCount, 1)
    }

    @MainActor
    func testDefaultViewModelFakeModeDoesNotOpenExternalApplications() async throws {
        let viewModel = PlaceHandoffViewModel(authorizer: FakePlaceHandoffAuthorizer(.approved),
                                              clock: TestClock())
        viewModel.prepare(action: .openOfficialWebsite,
                          candidate: candidatePresentation(context: context(webLinks: [officialWebsite("https://example.com")])))
        let requestID = try XCTUnwrap(viewModel.activePreview?.request.requestID)

        await viewModel.confirm(requestID)

        let record = try XCTUnwrap(viewModel.record(for: requestID))
        XCTAssertEqual(record.dispatchStatus, .unavailableHandler)
        XCTAssertEqual(record.state, .rejected)
    }
}

private struct FakePlaceHandoffAuthorizer: PlaceHandoffAuthorizing {
    private let decision: PlaceHandoffPermissionDecision

    init(_ decision: PlaceHandoffPermissionDecision) {
        self.decision = decision
    }

    func authorize(_ request: PlaceHandoffRequest) async -> PlaceHandoffPermissionDecision {
        decision
    }
}

private actor FakePlaceHandoffDispatcher: PlaceHandoffDispatching {
    private var result: PlaceHandoffDispatchResult
    private var attempts: [PlaceHandoffAttemptID] = []
    private var requests: [PlaceHandoffRequest] = []

    init(result: PlaceHandoffDispatchResult) {
        self.result = result
    }

    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        requests.append(request)
        attempts.append(attemptID)
        return result
    }

    func invocationCount() -> Int {
        attempts.count
    }

    func attemptIDs() -> [PlaceHandoffAttemptID] {
        attempts
    }
}

private actor SlowPlaceHandoffDispatcher: PlaceHandoffDispatching {
    private var attempts: [PlaceHandoffAttemptID] = []

    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        attempts.append(attemptID)
        try? await Task.sleep(nanoseconds: 250_000_000)
        return .accepted("已交给系统地图")
    }

    func invocationCount() -> Int {
        attempts.count
    }
}

private actor RecordingSystemOpeners {
    private var openedURLs: [URL] = []
    private var openedMapItems: [(name: String, coordinate: PlaceCoordinate)] = []

    func openURL(_ url: URL) -> Bool {
        openedURLs.append(url)
        return true
    }

    func openMapItem(name: String, coordinate: PlaceCoordinate) -> Bool {
        openedMapItems.append((name, coordinate))
        return true
    }

    func invocationCount() -> Int {
        openedURLs.count + openedMapItems.count
    }
}

private actor FakeExternalURLHandlerResolver: ExternalURLHandlerResolving {
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

private actor FakeExternalURLSystemOpener: ExternalURLSystemOpening {
    private let result: ExternalURLOpenResult
    private var urls: [URL] = []

    init(result: ExternalURLOpenResult) {
        self.result = result
    }

    func open(_ url: URL) async -> ExternalURLOpenResult {
        urls.append(url)
        return result
    }

    func openedURLs() -> [URL] {
        urls
    }

    func openCount() -> Int {
        urls.count
    }
}

private let p9eTaskID = UUID(uuidString: "00000000-0000-0000-0000-000000000901")!
private let p9eRunID = UUID(uuidString: "00000000-0000-0000-0000-000000000902")!

private func phoneRequest(normalizedNumber: String = "+14155550123") -> PlaceHandoffRequest {
    directRequest(action: .startPhoneHandoff,
                  destination: .phone(normalizedNumber: normalizedNumber,
                                      displayNumber: "(415) 555-0123"))
}

private func fakeHandlerURL(bundleIdentifier: String = "com.example.P9FPhoneHandler",
                            displayName: String = "P9F Phone Handler") throws -> URL {
    let appURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("p9f-phone-handler-\(UUID().uuidString)", isDirectory: true)
        .appendingPathExtension("app")
    let contents = appURL.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    let plist: [String: Any] = [
        "CFBundleIdentifier": bundleIdentifier,
        "CFBundleName": displayName,
        "CFBundleDisplayName": displayName,
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: plist,
                                                  format: .xml,
                                                  options: 0)
    try data.write(to: contents.appendingPathComponent("Info.plist"), options: .atomic)
    return appURL
}

private func context(candidateID: String = "test-place",
                     coordinate: PlaceCoordinate? = coordinate(),
                     address: PlaceAddress? = address(),
                     contact: PlaceContact = PlaceContact(phoneNumber: "+14155550123",
                                                          displayPhone: "(415) 555-0123"),
                     webLinks: [PlaceWebLink] = [officialWebsite("https://example.com")],
                     evidenceReferences: [PlaceEvidenceReference] = evidence(),
                     verificationStatus: PlaceVerificationStatus = .verified,
                     freshness: String = "current-task",
                     findings: [PlaceVerificationFinding] = [],
                     directionsOrigin: DirectionsOrigin = .currentLocation(.approximateCurrentLocation),
                     isPresent: Bool = true) -> PlaceHandoffCandidateContext {
    PlaceHandoffCandidateContext(taskID: p9eTaskID,
                                 runID: p9eRunID,
                                 candidateID: candidateID,
                                 name: "Test Place",
                                 address: address,
                                 coordinate: coordinate,
                                 contact: contact,
                                 webLinks: webLinks,
                                 evidenceReferences: evidenceReferences,
                                 verificationStatus: verificationStatus,
                                 freshness: freshness,
                                 findings: findings,
                                 directionsOrigin: directionsOrigin,
                                 isPresentInCurrentPresentation: isPresent)
}

private func candidatePresentation(context: PlaceHandoffCandidateContext) -> LocalDiscoveryCandidatePresentation {
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
                                        isSelected: false,
                                        hasValidCoordinate: context.coordinate != nil,
                                        coordinate: context.coordinate.map { LocalDiscoveryCoordinatePresentation(latitude: $0.latitude,
                                                                                                                   longitude: $0.longitude,
                                                                                                                   accuracyMeters: $0.horizontalAccuracyMeters) },
                                        fields: [],
                                        evidence: [],
                                        conflictSummaries: [],
                                        unknownSummaries: [],
                                        handoffContext: context,
                                        handoffActions: PlaceHandoffEligibilityEvaluator.actionPresentations(for: context),
                                        developerDiagnostics: nil,
                                        accessibilityLabel: context.name)
}

private func request(action: PlaceHandoffActionKind,
                     context: PlaceHandoffCandidateContext) throws -> PlaceHandoffRequest {
    switch PlaceHandoffRequestBuilder.makeRequest(action: action, context: context) {
    case .success(let request):
        return request
    case .failure(let eligibility):
        throw eligibility
    }
}

private func directRequest(action: PlaceHandoffActionKind,
                           destination: PlaceHandoffDestination,
                           requestID: PlaceHandoffRequestID? = nil,
                           candidateID: LocalDiscoveryCandidateID = "test-place") -> PlaceHandoffRequest {
    let stableRequestID = PlaceHandoffRequestBuilder.stableRequestID(taskID: p9eTaskID,
                                                                     runID: p9eRunID,
                                                                     candidateID: candidateID,
                                                                     action: action,
                                                                     destination: destination)
    return PlaceHandoffRequest(requestID: requestID ?? stableRequestID,
                               taskID: p9eTaskID,
                               runID: p9eRunID,
                               candidateID: candidateID,
                               action: action,
                               destination: destination,
                               evidenceState: .confirmed,
                               requestedAt: Date(timeIntervalSinceReferenceDate: 0))
}

private func coordinate() -> PlaceCoordinate {
    PlaceCoordinate(latitude: 37.78,
                    longitude: -122.41,
                    horizontalAccuracyMeters: 10)
}

private func address() -> PlaceAddress {
    PlaceAddress(street: "123 Main St",
                 locality: "San Francisco",
                 region: "CA",
                 postalCode: "94105",
                 countryCode: "US",
                 formatted: "123 Main St, San Francisco, CA")
}

private func officialWebsite(_ url: String,
                             evidenceReferences: [PlaceEvidenceReference] = evidence()) -> PlaceWebLink {
    PlaceWebLink(id: "official",
                 kind: .officialWebsite,
                 title: "Official Website",
                 url: url,
                 evidenceReferences: evidenceReferences)
}

private func evidence(freshness: String = "current-task",
                      confidence: Double = 0.95) -> [PlaceEvidenceReference] {
    [
        PlaceEvidenceReference(evidenceID: "evidence-\(freshness)-\(Int(confidence * 100))",
                               sourceToolID: ToolID(rawValue: "local_place_search"),
                               sourceURL: "https://provider.example/place",
                               claim: "candidate field supported",
                               observedAt: Date(timeIntervalSinceReferenceDate: 0),
                               freshness: freshness,
                               confidence: confidence),
    ]
}

private func conflict(_ field: String,
                      candidateID: String = "test-place") -> PlaceVerificationFinding {
    PlaceVerificationFinding(id: "conflict-\(field)",
                             candidateID: candidateID,
                             criterion: field,
                             status: .failed,
                             severity: .blocking,
                             evidenceIDs: ["conflict-evidence"],
                             reason: "\(field) sources conflict",
                             recommendedDisposition: .excludeConflict)
}
