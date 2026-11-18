import XCTest
@testable import DeskPet
@testable import PetAgentRuntime

final class P9DLocalDiscoveryPresentationTests: XCTestCase {
    func testCompleteResultBuildsCompletePresentation() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "chengdu-house", name: "Chengdu House"),
            P9DFixtures.candidate(id: "spice-alley", name: "Spice Alley", coordinate: nil),
        ], rankedCandidateIDs: ["spice-alley", "chengdu-house"], verifierVerdict: .pass)

        let presentation = P9DFixtures.presentation(snapshot: snapshot, runState: .succeeded)

        XCTAssertEqual(presentation.status, .complete)
        XCTAssertEqual(presentation.candidates.map(\.id), ["spice-alley", "chengdu-house"])
        XCTAssertEqual(presentation.mapAnnotations.map(\.id), ["chengdu-house"])
        XCTAssertEqual(presentation.querySummary.locationLabel, "San Francisco, CA")
        XCTAssertEqual(presentation.querySummary.resultCountSummary, "2 个候选地点")
    }

    func testPartialResultBuildsPartialPresentation() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "partial", verificationStatus: .partiallyVerified),
        ], verifierVerdict: .partialPass, warnings: ["route estimate partial"])

        let presentation = P9DFixtures.presentation(snapshot: snapshot, runState: .partiallySucceeded)

        XCTAssertEqual(presentation.status, .partial)
        XCTAssertEqual(presentation.candidates.first?.verificationState, .partial)
        XCTAssertTrue(presentation.querySummary.statusSummary.contains("部分结果"))
    }

    func testEmptyCandidateListBuildsEmptyState() {
        let snapshot = P9DFixtures.snapshot(candidates: [])

        let presentation = P9DFixtures.presentation(snapshot: snapshot, runState: .succeeded)

        XCTAssertEqual(presentation.status, .empty(.noCandidates))
        XCTAssertTrue(presentation.candidates.isEmpty)
        XCTAssertTrue(presentation.mapAnnotations.isEmpty)
    }

    func testCancelledWorkflowBuildsCancelledPresentationWithoutCards() {
        let snapshot = P9DFixtures.snapshot(stage: .cancelled, candidates: [
            P9DFixtures.candidate(id: "hidden-after-cancel"),
        ])

        let presentation = P9DFixtures.presentation(snapshot: snapshot, runState: .cancelled)

        XCTAssertEqual(presentation.status, .cancelled)
        XCTAssertTrue(presentation.status.isTerminal)
        XCTAssertTrue(presentation.candidates.isEmpty)
        XCTAssertTrue(presentation.mapAnnotations.isEmpty)
    }

    func testFailedWorkflowBuildsFailedPresentationWithoutCards() {
        let snapshot = P9DFixtures.snapshot(stage: .recoveryBlocked, candidates: [
            P9DFixtures.candidate(id: "hidden-after-failure"),
        ])

        let presentation = P9DFixtures.presentation(snapshot: snapshot, runState: .failed)

        if case .failed(let error) = presentation.status {
            XCTAssertEqual(error.kind, .recoveryCorrupted)
        } else {
            XCTFail("Expected failed presentation")
        }
        XCTAssertTrue(presentation.candidates.isEmpty)
        XCTAssertTrue(presentation.mapAnnotations.isEmpty)
    }

    func testUnknownParkingDoesNotRenderAsNoParking() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "parking-unknown", parking: .unknown, parkingConfidence: 0),
        ], verifierVerdict: .partialPass)

        let candidate = P9DFixtures.presentation(snapshot: snapshot).candidates[0]

        XCTAssertEqual(candidate.parkingSummary, "停车信息待确认")
        XCTAssertEqual(candidate.field("停车")?.state, .unknown)
        XCTAssertFalse(candidate.parkingSummary.contains("没有停车"))
    }

    func testUnknownPriceDoesNotRenderAsCheap() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "price-unknown", price: .unknown, priceConfidence: 0),
        ], verifierVerdict: .partialPass)

        let candidate = P9DFixtures.presentation(snapshot: snapshot).candidates[0]

        XCTAssertEqual(candidate.priceSummary, "价格信息待确认")
        XCTAssertEqual(candidate.field("价格")?.state, .unknown)
        XCTAssertFalse(candidate.priceSummary.contains("便宜"))
    }

    func testPartialVerifierDoesNotRenderAsFullyConfirmed() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "partial-verifier", verificationStatus: .partiallyVerified),
        ], verifierVerdict: .partialPass, warnings: ["verification partial"])

        let presentation = P9DFixtures.presentation(snapshot: snapshot)

        XCTAssertEqual(presentation.status, .partial)
        XCTAssertEqual(presentation.candidates[0].verificationState, .partial)
        XCTAssertNotEqual(presentation.candidates[0].verificationLabel, "已确认")
    }

    func testStaleEvidenceIsMarkedStale() {
        let stale = P9DFixtures.finding(candidateID: "stale",
                                        criterion: "stale_evidence",
                                        status: .uncertain,
                                        severity: .warning,
                                        disposition: .includeWithWarning,
                                        reason: "Evidence may be stale")
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "stale",
                                  evidenceFreshness: "stale-source",
                                  evidenceConfidence: 0.5,
                                  verificationStatus: .stale),
        ], findings: [stale], verifierVerdict: .partialPass)

        let presentation = P9DFixtures.presentation(snapshot: snapshot)

        XCTAssertEqual(presentation.candidates[0].verificationState, .stale)
        XCTAssertEqual(presentation.evidenceSummary.staleCount, 1)
        XCTAssertEqual(presentation.evidenceSummary.items.first?.state, .stale)
    }

    func testConflictingEvidenceIsMarkedConflicting() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "conflict",
                                  opening: .conflicting,
                                  verificationStatus: .conflicting),
        ], verifierVerdict: .partialPass, warnings: ["opening sources conflict"])

        let candidate = P9DFixtures.presentation(snapshot: snapshot).candidates[0]

        XCTAssertEqual(candidate.verificationState, .conflicting)
        XCTAssertEqual(candidate.field("营业状态")?.state, .conflicting)
        XCTAssertTrue(candidate.openingSummary.contains("来源不一致"))
    }

    func testCandidateStableIDIsUsedForCardsAndMarkers() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "stable-candidate-id"),
        ])

        let presentation = P9DFixtures.presentation(snapshot: snapshot)

        XCTAssertEqual(presentation.candidates.first?.id, "stable-candidate-id")
        XCTAssertEqual(presentation.mapAnnotations.first?.id, "stable-candidate-id")
    }

    func testRecoveryBeforeAndAfterCandidateIDDoesNotChange() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "recoverable"),
        ])
        let live = P9DFixtures.presentation(snapshot: snapshot, recoveredFromCheckpoint: false)
        let recovered = P9DFixtures.presentation(snapshot: snapshot, recoveredFromCheckpoint: true)

        XCTAssertEqual(live.candidates.map(\.id), recovered.candidates.map(\.id))
        XCTAssertEqual(recovered.candidates.first?.id, "recoverable")
        XCTAssertTrue(recovered.recoveredFromCheckpoint)
    }

    func testMissingCoordinateDoesNotGenerateMapAnnotation() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "no-coordinate", coordinate: nil),
        ], verifierVerdict: .partialPass)

        let presentation = P9DFixtures.presentation(snapshot: snapshot)

        XCTAssertEqual(presentation.candidates.count, 1)
        XCTAssertTrue(presentation.mapAnnotations.isEmpty)
        XCTAssertFalse(presentation.candidates[0].hasValidCoordinate)
    }

    func testLowConfidenceCoordinateIsFilteredFromMap() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "low-confidence-coordinate",
                                  coordinate: PlaceCoordinate(latitude: 37.78,
                                                              longitude: -122.41,
                                                              horizontalAccuracyMeters: 60_000)),
        ], verifierVerdict: .partialPass)

        let presentation = P9DFixtures.presentation(snapshot: snapshot)

        XCTAssertTrue(presentation.mapAnnotations.isEmpty)
        XCTAssertFalse(presentation.candidates[0].hasValidCoordinate)
    }

    func testRouteDurationMissingDisplaysUnknown() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "no-route-duration",
                                  routeMeters: 3_200,
                                  routeDurationSeconds: nil),
        ], verifierVerdict: .partialPass)

        let candidate = P9DFixtures.presentation(snapshot: snapshot).candidates[0]

        XCTAssertEqual(candidate.routeDurationSummary, "未获得路线时间")
        XCTAssertEqual(candidate.field("路线时间")?.state, .unknown)
    }

    func testStraightLineDistanceAndRouteDistanceAreNotConflated() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "straight-only",
                                  routeMeters: nil,
                                  straightMeters: 2_414,
                                  routeDurationSeconds: nil),
        ], verifierVerdict: .partialPass)

        let candidate = P9DFixtures.presentation(snapshot: snapshot).candidates[0]

        XCTAssertTrue(candidate.distanceSummary.hasPrefix("直线约"))
        XCTAssertTrue(candidate.straightLineDistanceSummary.hasPrefix("直线约"))
        XCTAssertEqual(candidate.routeDistanceSummary, "未获得路线距离")
    }

    func testDefaultOrderKeepsSynthesisRankOrder() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "a", routeMeters: 5_000),
            P9DFixtures.candidate(id: "b", routeMeters: 1_000),
            P9DFixtures.candidate(id: "c", routeMeters: 3_000),
        ], rankedCandidateIDs: ["c", "a", "b"])

        let presentation = P9DFixtures.presentation(snapshot: snapshot, sortMode: .recommended)

        XCTAssertEqual(presentation.candidates.map(\.id), ["c", "a", "b"])
    }

    func testDistanceSortDoesNotMutateDomainDocument() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "far", routeMeters: 5_000),
            P9DFixtures.candidate(id: "near", routeMeters: 900),
        ], rankedCandidateIDs: ["far", "near"])

        let sorted = P9DFixtures.presentation(snapshot: snapshot, sortMode: .distance)

        XCTAssertEqual(sorted.candidates.map(\.id), ["near", "far"])
        XCTAssertEqual(snapshot.rankedCandidateIDs, ["far", "near"])
        XCTAssertEqual(snapshot.mergedCandidates.map(\.stableID), ["far", "near"])
    }

    func testRouteDurationSortOrdersUnknownLast() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "unknown-duration", routeDurationSeconds: nil),
            P9DFixtures.candidate(id: "short-duration", routeDurationSeconds: 360),
            P9DFixtures.candidate(id: "long-duration", routeDurationSeconds: 1_200),
        ])

        let sorted = P9DFixtures.presentation(snapshot: snapshot, sortMode: .routeDuration)

        XCTAssertEqual(sorted.candidates.map(\.id), ["short-duration", "long-duration", "unknown-duration"])
    }

    func testVerificationSortIsStableWithinSameScore() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "partial-a", verificationStatus: .partiallyVerified),
            P9DFixtures.candidate(id: "verified", verificationStatus: .verified),
            P9DFixtures.candidate(id: "partial-b", verificationStatus: .partiallyVerified),
        ], verifierVerdict: .partialPass)

        let sorted = P9DFixtures.presentation(snapshot: snapshot, sortMode: .verification)

        XCTAssertEqual(sorted.candidates.map(\.id), ["verified", "partial-a", "partial-b"])
    }

    func testSelectedCandidateDoesNotMutateDurableResult() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "first"),
            P9DFixtures.candidate(id: "second"),
        ])

        let selected = P9DFixtures.presentation(snapshot: snapshot, selectedCandidateID: "second")

        XCTAssertEqual(selected.selectedCandidateID, "second")
        XCTAssertEqual(selected.candidates.map(\.isSelected), [false, true])
        XCTAssertNil(snapshot.synthesizedResultRevision)
        XCTAssertEqual(snapshot.mergedCandidates.map(\.stableID), ["first", "second"])
    }

    func testCoordinateConflictFindingFiltersMarkerButKeepsCard() {
        let finding = P9DFixtures.finding(candidateID: "coordinate-conflict",
                                         criterion: "coordinate_conflict",
                                         status: .failed,
                                         severity: .warning,
                                         disposition: .includeWithWarning,
                                         reason: "Coordinate and address conflict")
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "coordinate-conflict"),
        ], findings: [finding], verifierVerdict: .partialPass)

        let presentation = P9DFixtures.presentation(snapshot: snapshot)

        XCTAssertEqual(presentation.candidates.count, 1)
        XCTAssertTrue(presentation.mapAnnotations.isEmpty)
        XCTAssertFalse(presentation.candidates[0].hasValidCoordinate)
    }

    @MainActor
    func testCompleteCheckpointRecoveryBuildsCardsFromCheckpoint() async throws {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "checkpoint-card"),
        ])
        let checkpoint = try P9DFixtures.checkpoint(snapshot: snapshot, state: .succeeded)
        let checkpointStore = AgentCheckpointStore(baseDirectory: P9DFixtures.tempDirectory("complete-checkpoint"))
        try await checkpointStore.save(checkpoint)
        let store = LocalDiscoveryPresentationStore(checkpointStore: checkpointStore)

        await store.load(taskID: snapshot.taskID, runID: snapshot.runID)
        let presentation = store.presentation(taskID: snapshot.taskID,
                                              runID: snapshot.runID,
                                              sortMode: .recommended,
                                              selectedCandidateID: nil,
                                              recoveredFromCheckpoint: true,
                                              includeDeveloperDiagnostics: true)

        XCTAssertEqual(presentation?.status, .complete)
        XCTAssertEqual(presentation?.candidates.map(\.id), ["checkpoint-card"])
        XCTAssertTrue(presentation?.recoveredFromCheckpoint == true)
        XCTAssertEqual(presentation?.developerDiagnostics?.checkpointRecoveryFlag, true)
    }

    @MainActor
    func testPartialCheckpointRecoveryBuildsPartialCards() async throws {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "partial-checkpoint", verificationStatus: .partiallyVerified),
        ], verifierVerdict: .partialPass, warnings: ["partial checkpoint"])
        let checkpoint = try P9DFixtures.checkpoint(snapshot: snapshot, state: .partiallySucceeded)
        let checkpointStore = AgentCheckpointStore(baseDirectory: P9DFixtures.tempDirectory("partial-checkpoint"))
        try await checkpointStore.save(checkpoint)
        let store = LocalDiscoveryPresentationStore(checkpointStore: checkpointStore)

        await store.load(taskID: snapshot.taskID, runID: snapshot.runID)
        let presentation = store.presentation(taskID: snapshot.taskID,
                                              runID: snapshot.runID,
                                              sortMode: .recommended,
                                              selectedCandidateID: nil,
                                              recoveredFromCheckpoint: true,
                                              includeDeveloperDiagnostics: false)

        XCTAssertEqual(presentation?.status, .partial)
        XCTAssertEqual(presentation?.candidates.first?.verificationState, .partial)
    }

    @MainActor
    func testCancelledCheckpointRecoveryStaysCancelled() async throws {
        let snapshot = P9DFixtures.snapshot(stage: .cancelled, candidates: [
            P9DFixtures.candidate(id: "cancelled-checkpoint"),
        ])
        let checkpoint = try P9DFixtures.checkpoint(snapshot: snapshot, state: .cancelled, resultDocument: nil)
        let checkpointStore = AgentCheckpointStore(baseDirectory: P9DFixtures.tempDirectory("cancelled-checkpoint"))
        try await checkpointStore.save(checkpoint)
        let store = LocalDiscoveryPresentationStore(checkpointStore: checkpointStore)

        await store.load(taskID: snapshot.taskID, runID: snapshot.runID)
        let presentation = store.presentation(taskID: snapshot.taskID,
                                              runID: snapshot.runID,
                                              sortMode: .recommended,
                                              selectedCandidateID: "cancelled-checkpoint",
                                              recoveredFromCheckpoint: true,
                                              includeDeveloperDiagnostics: false)

        XCTAssertEqual(presentation?.status, .cancelled)
        XCTAssertTrue(presentation?.candidates.isEmpty == true)
    }

    @MainActor
    func testFailedCheckpointRecoveryStaysFailed() async throws {
        let snapshot = P9DFixtures.snapshot(stage: .recoveryBlocked, candidates: [
            P9DFixtures.candidate(id: "failed-checkpoint"),
        ])
        let checkpoint = try P9DFixtures.checkpoint(snapshot: snapshot, state: .failed, resultDocument: nil)
        let checkpointStore = AgentCheckpointStore(baseDirectory: P9DFixtures.tempDirectory("failed-checkpoint"))
        try await checkpointStore.save(checkpoint)
        let store = LocalDiscoveryPresentationStore(checkpointStore: checkpointStore)

        await store.load(taskID: snapshot.taskID, runID: snapshot.runID)
        let presentation = store.presentation(taskID: snapshot.taskID,
                                              runID: snapshot.runID,
                                              sortMode: .recommended,
                                              selectedCandidateID: nil,
                                              recoveredFromCheckpoint: true,
                                              includeDeveloperDiagnostics: false)

        if case .failed = presentation?.status {
            XCTAssertTrue(true)
        } else {
            XCTFail("Expected failed recovery presentation")
        }
        XCTAssertTrue(presentation?.candidates.isEmpty == true)
    }

    func testRecoveredPresentationDoesNotExposeToolIDsInUserMode() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "privacy"),
        ], toolCompletionIDs: ["local_place_search:privacy"])

        let presentation = P9DFixtures.presentation(snapshot: snapshot,
                                                    recoveredFromCheckpoint: true,
                                                    includeDeveloperDiagnostics: false)

        XCTAssertNil(presentation.developerDiagnostics)
        XCTAssertNil(presentation.evidenceSummary.items.first?.developerToolID)
    }

    func testDeveloperModeShowsDiagnosticsSeparately() {
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "developer"),
        ], toolCompletionIDs: ["local_place_search:developer"])

        let presentation = P9DFixtures.presentation(snapshot: snapshot,
                                                    recoveredFromCheckpoint: true,
                                                    includeDeveloperDiagnostics: true)

        XCTAssertEqual(presentation.developerDiagnostics?.workflowStage, "resultSynthesized")
        XCTAssertEqual(presentation.developerDiagnostics?.toolCompletionIDs.count, 1)
        XCTAssertEqual(presentation.candidates.first?.developerDiagnostics?.checkpointRecoveryFlag, true)
    }

    func testPresentationModelHasNoExternalActionDispatchDescriptors() {
        let action = PlaceActionDescriptor(actionID: "open-map",
                                           type: .openMaps,
                                           label: "Open Maps",
                                           targetReference: "mapkit:privacy",
                                           permissionRequirement: .futureDispatchRequired)
        let snapshot = P9DFixtures.snapshot(candidates: [
            P9DFixtures.candidate(id: "action-source", actionDescriptors: [action]),
        ])

        let candidate = P9DFixtures.presentation(snapshot: snapshot).candidates[0]

        XCTAssertEqual(candidate.name, "Chengdu House")
        XCTAssertFalse(candidate.accessibilityLabel.contains("open-map"))
        XCTAssertFalse(candidate.fields.contains { $0.value.contains("Open Maps") })
    }
}

private enum P9DFixtures {
    static let now = Date(timeIntervalSince1970: 1_785_369_600)

    static func presentation(snapshot: LocalDiscoveryWorkflowSnapshot,
                             runState: AgentRunState = .succeeded,
                             sortMode: LocalDiscoverySortMode = .recommended,
                             selectedCandidateID: LocalDiscoveryCandidateID? = nil,
                             recoveredFromCheckpoint: Bool = false,
                             includeDeveloperDiagnostics: Bool = false) -> LocalDiscoveryPresentation {
        LocalDiscoveryPresentationAdapter.make(snapshot: snapshot,
                                               runState: runState,
                                               resultDocument: resultDocument(taskID: snapshot.taskID,
                                                                              runID: snapshot.runID,
                                                                              status: runState == .partiallySucceeded ? .partial : .completed),
                                               sortMode: sortMode,
                                               selectedCandidateID: selectedCandidateID,
                                               recoveredFromCheckpoint: recoveredFromCheckpoint,
                                               includeDeveloperDiagnostics: includeDeveloperDiagnostics)
    }

    static func snapshot(stage: LocalDiscoveryWorkflowStage = .resultSynthesized,
                         candidates: [PlaceCandidate],
                         findings: [PlaceVerificationFinding] = [],
                         rankedCandidateIDs: [String]? = nil,
                         verifierVerdict: LocalDiscoveryVerifierVerdict = .pass,
                         warnings: [String] = [],
                         toolCompletionIDs: [String] = []) -> LocalDiscoveryWorkflowSnapshot {
        let taskID = UUID()
        let runID = UUID()
        let completions = toolCompletionIDs.map {
            LocalDiscoveryToolCompletionIdentity(taskID: taskID,
                                                 runID: runID,
                                                 workflowStage: .resultSynthesized,
                                                 toolID: $0.components(separatedBy: ":").first ?? $0,
                                                 normalizedInputDigest: "digest-\($0)",
                                                 targetID: $0.components(separatedBy: ":").last,
                                                 completedAt: now)
        }
        return LocalDiscoveryWorkflowSnapshot(taskID: taskID,
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
                                              extractionEvidenceIDs: [],
                                              validatorFindings: findings,
                                              verifierDisposition: LocalDiscoveryVerifierReport(verdict: verifierVerdict),
                                              rankedCandidateIDs: rankedCandidateIDs ?? candidates.map(\.stableID),
                                              toolCompletions: completions,
                                              backend: "fixture",
                                              warnings: warnings,
                                              updatedAt: now)
    }

    static func query() -> PlaceQuery {
        PlaceQuery(queryID: "query-p9d",
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
                    PlaceConstraint(id: "open",
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

    static func candidate(id: String,
                          name: String = "Chengdu House",
                          coordinate: PlaceCoordinate? = PlaceCoordinate(latitude: 37.78,
                                                                         longitude: -122.41,
                                                                         horizontalAccuracyMeters: 30),
                          routeMeters: Double? = 3_200,
                          straightMeters: Double? = 2_600,
                          routeDurationSeconds: Double? = 720,
                          opening: PlaceOpeningStatusValue = .open,
                          price: PlacePriceValue = .maximumPerPerson(amount: 35, currencyCode: "USD"),
                          priceConfidence: Double = 0.8,
                          parking: PlaceParkingAvailability = .available,
                          parkingConfidence: Double = 0.8,
                          evidenceFreshness: String = "current-task",
                          evidenceConfidence: Double = 0.9,
                          verificationStatus: PlaceVerificationStatus = .verified,
                          actionDescriptors: [PlaceActionDescriptor] = []) -> PlaceCandidate {
        let evidence = PlaceEvidenceReference(evidenceID: "evidence-\(id)",
                                              sourceToolID: "webpage_read",
                                              sourceURL: "https://example.com/\(id)",
                                              claim: "candidate evidence for \(id)",
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
        let straightDistance = straightMeters.map {
            PlaceDistance(meters: $0,
                          kind: .straightLine,
                          source: "haversine",
                          calculatedAt: now,
                          uncertaintyReason: "straight-line only")
        }
        let travel = (routeDistance != nil || straightDistance != nil || routeDurationSeconds != nil)
            ? PlaceTravelEstimate(transportMode: .automobile,
                                  straightLineDistance: straightDistance,
                                  routeDistance: routeDistance,
                                  estimatedTravelDurationSeconds: routeDurationSeconds,
                                  calculationSource: "fixture",
                                  calculatedAt: now,
                                  uncertaintyReason: routeDistance == nil ? "route unavailable" : "route estimate")
            : nil
        let openingEvidence = opening == .unknown ? [] : [evidence]
        let targetTime = opening == .unknown ? nil : now
        let priceEvidence = price == .unknown ? [] : [evidence]
        let parkingEvidence = parking == .unknown ? [] : [evidence]
        return PlaceCandidate(stableID: id,
                              sourceEntityIDs: ["fixture:\(id)"],
                              name: name,
                              categories: [.sichuanRestaurant],
                              address: PlaceAddress(locality: "San Francisco",
                                                    region: "CA",
                                                    formatted: "\(id) Market St, San Francisco, CA"),
                              coordinate: coordinate,
                              distance: straightDistance,
                              travelEstimate: travel,
                              openingStatus: PlaceOpeningStatus(value: opening,
                                                                checkedAt: now,
                                                                targetTime: targetTime,
                                                                confidence: opening == .unknown ? 0 : 0.8,
                                                                source: "fixture",
                                                                evidenceReferences: openingEvidence,
                                                                uncertaintyReason: opening == .unknown ? "opening status unavailable" : nil),
                              priceEstimate: PlacePriceEstimate(value: price,
                                                                confidence: priceConfidence,
                                                                source: "fixture",
                                                                observedAt: now,
                                                                verifiedAt: price == .unknown ? nil : now,
                                                                evidenceReferences: priceEvidence,
                                                                uncertaintyReason: price == .unknown ? "price unavailable" : nil),
                              parkingInfo: PlaceParkingInfo(value: parking,
                                                            confidence: parkingConfidence,
                                                            source: "fixture",
                                                            observedAt: now,
                                                            verifiedAt: parking == .unknown ? nil : now,
                                                            evidenceReferences: parkingEvidence,
                                                            uncertaintyReason: parking == .unknown ? "parking unavailable" : nil),
                              evidenceReferences: [evidence],
                              freshness: evidenceFreshness,
                              verificationStatus: verificationStatus,
                              recommendationRationale: "可作为候选比较，仍需查看证据说明。",
                              actionDescriptors: actionDescriptors)
    }

    static func finding(candidateID: String,
                        criterion: String,
                        status: VerificationCriterionStatus,
                        severity: PlaceVerificationSeverity,
                        disposition: PlaceCandidateDisposition,
                        reason: String) -> PlaceVerificationFinding {
        PlaceVerificationFinding(id: "\(candidateID)-\(criterion)",
                                 candidateID: candidateID,
                                 criterion: criterion,
                                 status: status,
                                 severity: severity,
                                 evidenceIDs: ["evidence-\(candidateID)"],
                                 reason: reason,
                                 recommendedDisposition: disposition)
    }

    static func resultDocument(taskID: UUID,
                               runID: UUID,
                               status: AgentResultStatus = .completed) -> AgentResultDocument {
        AgentResultDocument(id: "local-discovery-\(runID.uuidString)",
                            taskID: taskID,
                            runID: runID,
                            title: "地点搜索结果",
                            summary: "找到候选地点。",
                            status: status,
                            generatedAt: now,
                            sections: [],
                            metadata: ["workflow": "localDiscovery"])
    }

    static func checkpoint(snapshot: LocalDiscoveryWorkflowSnapshot,
                           state: AgentRunState,
                           resultDocument: AgentResultDocument? = nil) throws -> AgentCheckpoint {
        let document = resultDocument ?? (state == .cancelled || state == .failed ? nil : self.resultDocument(taskID: snapshot.taskID,
                                                                                                             runID: snapshot.runID,
                                                                                                             status: state == .partiallySucceeded ? .partial : .completed))
        let projection = AgentRunProjection(taskID: snapshot.taskID,
                                            runID: snapshot.runID,
                                            state: state,
                                            events: [],
                                            createdAt: now,
                                            updatedAt: now,
                                            completedAt: state.isTerminal ? now : nil,
                                            resultDocument: document)
        return AgentCheckpoint(taskID: snapshot.taskID,
                               runID: snapshot.runID,
                               projection: projection,
                               replayState: AgentTimelineReplayState(taskID: snapshot.taskID,
                                                                     runID: snapshot.runID,
                                                                     events: []).jumpToEnd(),
                               phase: state.isTerminal ? .terminal : .active,
                               lastSequence: 10,
                               eventCount: 0,
                               resultDocument: document,
                               completedToolCallIDs: snapshot.toolCompletions.map(\.id),
                               completedStepIDs: [snapshot.currentStage.rawValue],
                               currentUIRevision: document?.revision,
                               evidenceIDs: snapshot.webpageEvidenceIDs + snapshot.extractionEvidenceIDs,
                               verifierState: snapshot.verifierDisposition?.verdict.rawValue ?? "unknown",
                               recoveryDisposition: snapshot.currentStage.rawValue,
                               domainPayloads: [
                                LocalDiscoveryWorkflowSnapshot.domainPayloadKey: try LocalDiscoveryJSON.jsonValue(from: snapshot),
                               ],
                               createdAt: now,
                               updatedAt: now)
    }

    static func tempDirectory(_ name: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("DeskPet-P9D-\(name)-\(UUID().uuidString)", isDirectory: true)
    }
}

private extension LocalDiscoveryCandidatePresentation {
    func field(_ label: String) -> LocalDiscoveryFieldPresentation? {
        fields.first { $0.label == label }
    }
}
