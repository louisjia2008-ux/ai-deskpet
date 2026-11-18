import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

final class P9CLocalDiscoveryWorkflowTests: XCTestCase {
    private let testNow = Date(timeIntervalSince1970: 1_785_196_800) // 2026-07-28T19:20:00Z

    func testIntentClassificationRecognizesDiscoveryAndRejectsAdjacentTasks() {
        let restaurant = LocalDiscoveryIntentClassifier.classify(userText: "找附近的川菜馆")
        XCTAssertTrue(restaurant.isLocalDiscovery)
        XCTAssertEqual(restaurant.requestedCategory, .sichuanRestaurant)
        XCTAssertTrue(restaurant.requiresLocationPermission)

        let golf = LocalDiscoveryIntentClassifier.classify(userText: "找 San Jose 附近今晚还能练球的高尔夫练习场")
        XCTAssertTrue(golf.isLocalDiscovery)
        XCTAssertEqual(golf.requestedCategory, .golfDrivingRange)
        XCTAssertEqual(golf.explicitLocation, "San Jose, CA")
        XCTAssertFalse(golf.requiresLocationPermission)

        let product = LocalDiscoveryIntentClassifier.classify(userText: "帮我找附近可能卖 USB-C 笔记本充电器的商店")
        XCTAssertTrue(product.isLocalDiscovery)
        XCTAssertEqual(product.requestKind, .productStoreDiscovery)
        XCTAssertTrue(product.unsupportedRequirements.contains("live_inventory"))

        XCTAssertFalse(LocalDiscoveryIntentClassifier.classify(userText: "川菜是什么？").isLocalDiscovery)
        XCTAssertFalse(LocalDiscoveryIntentClassifier.classify(userText: "UCLA 的电话是多少？").isLocalDiscovery)
        XCTAssertFalse(LocalDiscoveryIntentClassifier.classify(userText: "从 UCLA 到 LAX 怎么去？").isLocalDiscovery)
    }

    func testRuntimeRequestPreparerRoutesNaturalLanguageToLocalDiscoveryWorkflow() {
        let prepared = RuntimeRequestPreparer.prepare(
            userText: "帮我找 San Jose 附近今晚还能练球的高尔夫练习场。",
            context: nil)

        XCTAssertEqual(prepared.executionMode, .localDiscoveryWorkflow)
        XCTAssertEqual(prepared.inferredCapabilities, [.localDiscovery])
        XCTAssertEqual(prepared.localDiscoveryIntentDecision?.requestedCategory, .golfDrivingRange)
        XCTAssertNil(prepared.requiredToolDecision)
    }

    func testActivityReducerProjectsLocalDiscoveryToolLifecycle() {
        let taskID = UUID()
        let runID = UUID()
        let started = AgentEventEnvelope(taskID: taskID,
                                         runID: runID,
                                         sequence: 0,
                                         timestamp: testNow,
                                         source: .toolRuntime,
                                         kind: .toolStarted,
                                         payload: .tool(.init(toolID: "local_place_search",
                                                              toolCallID: "search-1",
                                                              displayName: "本地地点搜索",
                                                              safeSummary: "正在搜索地点",
                                                              riskLevel: "read-only")))
        let succeeded = AgentEventEnvelope(taskID: taskID,
                                           runID: runID,
                                           sequence: 1,
                                           timestamp: testNow.addingTimeInterval(1),
                                           source: .toolRuntime,
                                           kind: .toolSucceeded,
                                           payload: .tool(.init(toolID: "local_place_search",
                                                                toolCallID: "search-1",
                                                                displayName: "本地地点搜索",
                                                                safeSummary: "找到 2 个候选地点",
                                                                riskLevel: "read-only",
                                                                resultCategory: "success")))

        let items = AgentActivityReducer.reduce(events: [started, succeeded], visibility: .user)

        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.title, "已找到初始候选地点")
        XCTAssertEqual(items.first?.status, .succeeded)
    }

    func testQueryPlannerExtractsHardSoftBudgetTimeAndTravelSemantics() throws {
        let decision = LocalDiscoveryIntentClassifier.classify(
            userText: "帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好，开车 20 分钟以内。")
        let planned = LocalDiscoveryQueryPlanner(policy: LocalDiscoverySearchPolicy(defaultRadiusMeters: 6_000))
            .plan(userText: "帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好，开车 20 分钟以内。",
                  decision: decision,
                  now: testNow,
                  locale: Locale(identifier: "zh_Hans_US"),
                  timeZone: TimeZone(identifier: "Asia/Shanghai")!)
        let query = try XCTUnwrap(planned.query)

        XCTAssertEqual(planned.status, .ready)
        XCTAssertEqual(query.locationInput.kind, .explicitRegion)
        XCTAssertEqual(query.locationInput.label, "San Francisco, CA")
        XCTAssertEqual(query.timezone, "America/Los_Angeles")
        XCTAssertEqual(query.category, .sichuanRestaurant)
        XCTAssertEqual(query.budget?.maximumAmount, 40)
        XCTAssertEqual(query.budget?.perPerson, true)
        XCTAssertEqual(query.travelLimit?.maximumTravelTimeSeconds, 20 * 60)
        XCTAssertTrue(query.hardConstraints.contains { $0.kind == .openAt })
        XCTAssertTrue(query.hardConstraints.contains { $0.kind == .priceMaximum })
        XCTAssertTrue(query.hardConstraints.contains { $0.kind == .travelTimeMaximum })
        XCTAssertTrue(query.softPreferences.contains { $0.kind == .parkingPreference })
        XCTAssertFalse(query.hardConstraints.contains { $0.kind == .parkingPreference })
    }

    func testExplicitLocationWorkflowSkipsUnavailableNativeWebEnrichment() async throws {
        let platform = P9CFakeLocalDiscoveryPlatform()
        let outcome = await workflow(platform: platform).run(
            userText: "帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { false })

        let calls = await platform.calls()
        XCTAssertFalse(calls.contains("approximate_location"))
        XCTAssertTrue(calls.contains("local_place_search"))
        XCTAssertTrue(calls.contains("route_distance_estimate"))
        XCTAssertFalse(calls.contains("webpage_read"))
        XCTAssertFalse(calls.contains("structured_place_extraction"))
        XCTAssertLessThan(calls.firstIndex(of: "local_place_search")!, calls.firstIndex(of: "route_distance_estimate")!)
        XCTAssertEqual(outcome.localResult?.query.locationInput.kind, .explicitRegion)
        XCTAssertNotNil(outcome.loopResult.resultDocument)
        XCTAssertEqual(outcome.loopResult.terminalState, .partiallySucceeded)
    }

    func testNearbyDeniedLocationAwaitsUserInputAndDoesNotSearch() async {
        let platform = P9CFakeLocalDiscoveryPlatform(locationDenied: true)
        let outcome = await workflow(platform: platform).run(
            userText: "帮我找附近今晚还营业的川菜馆。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找附近今晚还营业的川菜馆。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { false })

        let calls = await platform.calls()
        XCTAssertEqual(calls, ["approximate_location"])
        XCTAssertEqual(outcome.loopResult.terminalState, .awaitingUserInput)
        XCTAssertEqual(outcome.loopResult.stopReason, .permissionDenied)
        XCTAssertTrue(outcome.loopResult.finalResponse?.text.contains("城市、邮编或附近地标") ?? false)
    }

    func testRouteFallbackDoesNotOverclaimDrivingDistance() async throws {
        let platform = P9CFakeLocalDiscoveryPlatform(routePartial: true)
        let outcome = await workflow(platform: platform).run(
            userText: "帮我找 San Jose 附近今晚还能练球、关门比较晚的高尔夫练习场。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Jose 附近今晚还能练球、关门比较晚的高尔夫练习场。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { false })
        let candidate = try XCTUnwrap(outcome.localResult?.candidates.first)

        XCTAssertNotNil(candidate.travelEstimate?.straightLineDistance)
        XCTAssertNil(candidate.travelEstimate?.routeDistance)
        XCTAssertTrue(candidate.recommendationRationale?.contains("不是驾驶距离") ?? false)
        XCTAssertNotEqual(outcome.verifierReport.verdict, .pass)
    }

    func testCancellationStopsBeforeToolActivityCompletes() async {
        let platform = P9CFakeLocalDiscoveryPlatform()
        let activityRecorder = P9CActivityRecorder()
        let outcome = await workflow(platform: platform).run(
            userText: "帮我找 San Francisco 附近今晚营业的川菜馆。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Francisco 附近今晚营业的川菜馆。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { true },
            activitySink: { await activityRecorder.append($0) })

        XCTAssertEqual(outcome.loopResult.terminalState, .cancelled)
        let calls = await platform.calls()
        let activities = await activityRecorder.values()
        XCTAssertTrue(calls.isEmpty)
        XCTAssertLessThanOrEqual(activities.count, 1)
    }

    func testModelStructuredPlannerAcceptsValidPlaceQuery() async throws {
        let client = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category, .openAt, .priceMaximum],
                         soft: [.parkingPreference],
                         budgetScope: "perPerson",
                         budgetMaximum: 40)
        ])
        let planned = try await structuredPlanner(client: client).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(planned.status, .ready)
        XCTAssertEqual(planned.query?.category, .sichuanRestaurant)
        XCTAssertEqual(planned.query?.budget?.maximumAmount, 40)
        XCTAssertFalse(planned.usedDeterministicFallback)
        let clientRequestCount = client.requestCount()
        XCTAssertEqual(clientRequestCount, 1)
    }

    func testModelStructuredPlannerNormalizesProviderCategoryAliases() async throws {
        let client = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: "Sichuan Restaurants",
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category],
                         soft: [])
        ])
        let planned = try await structuredPlanner(client: client).planLocalDiscovery(
            request: structuredPlannerRequest("Sichuan restaurant in San Francisco"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(planned.status, .ready)
        XCTAssertEqual(planned.query?.category, .sichuanRestaurant)
        XCTAssertFalse(planned.usedDeterministicFallback)
    }

    func testModelStructuredPlannerIgnoresNoMissingInformationPlaceholders() async throws {
        let client = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category],
                         soft: [],
                         missingInformation: ["None"])
        ])
        let planned = try await structuredPlanner(client: client).planLocalDiscovery(
            request: structuredPlannerRequest("Sichuan restaurant in San Francisco"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(planned.status, .ready)
        XCTAssertTrue(planned.missingInformation.isEmpty)
        XCTAssertFalse(planned.usedDeterministicFallback)
    }

    func testModelStructuredPlannerDoesNotBlockOnUnrequestedOptionalPreferenceGaps() async throws {
        let client = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco",
                         hard: [.category],
                         soft: [],
                         missingInformation: [
                            "Budget or price range preference",
                            "Current or approximate user location within San Francisco",
                            "Desired dining time (lunch/dinner, openNow)",
                            "Dine-in vs takeout preference",
                            "Maximum distance from a reference point within SF",
                            "Party size or reservation need",
                         ])
        ])
        let planned = try await structuredPlanner(client: client).planLocalDiscovery(
            request: structuredPlannerRequest("Sichuan restaurant in San Francisco"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(planned.status, .ready)
        XCTAssertTrue(planned.missingInformation.isEmpty)
    }

    func testModelStructuredPlannerPromotesUnknownLocationKindWhenExplicitLabelIsPreserved() async throws {
        let client = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.unknown.rawValue,
                         locationLabel: "San Francisco",
                         hard: [.category],
                         soft: [],
                         missingInformation: [
                            "Dietary restrictions or spice tolerance",
                            "Preference for restaurant ambiance (casual, upscale, etc.)",
                            "Specific neighborhood preference",
                            "User's approximate current location within San Francisco",
                         ])
        ])
        let planned = try await structuredPlanner(client: client).planLocalDiscovery(
            request: structuredPlannerRequest("Sichuan restaurant in San Francisco"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(planned.status, .ready)
        XCTAssertEqual(planned.query?.locationInput.kind, .explicitRegion)
        XCTAssertTrue(planned.missingInformation.isEmpty)
    }

    func testModelStructuredPlannerRepairsInvalidJSONAndEnum() async throws {
        let request = structuredPlannerRequest("帮我找 UCLA 附近停车方便的中餐。")
        let repaired = p9cDraftJSON(searchText: "Chinese restaurant",
                                    category: PlaceCategory.chineseRestaurant.rawValue,
                                    locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                                    locationLabel: "UCLA",
                                    hard: [.category],
                                    soft: [.parkingPreference])
        let invalidJSONClient = P9CFakeLLMClient(responses: ["not json", repaired])
        let invalidEnumClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Chinese restaurant",
                         category: PlaceCategory.chineseRestaurant.rawValue,
                         locationKind: "near_me",
                         locationLabel: "UCLA",
                         hard: [.category],
                         soft: [.parkingPreference]),
            repaired,
        ])

        let invalidJSONPlan = try await structuredPlanner(client: invalidJSONClient).planLocalDiscovery(
            request: request,
            fallbackPlanner: LocalDiscoveryQueryPlanner())
        let invalidEnumPlan = try await structuredPlanner(client: invalidEnumClient).planLocalDiscovery(
            request: request,
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(invalidJSONPlan.status, .ready)
        XCTAssertEqual(invalidJSONPlan.repairAttempts, 1)
        let invalidJSONRequestCount = invalidJSONClient.requestCount()
        XCTAssertEqual(invalidJSONRequestCount, 2)
        XCTAssertEqual(invalidEnumPlan.query?.locationInput.label, "UCLA")
        XCTAssertEqual(invalidEnumPlan.repairAttempts, 1)
        let invalidEnumRequestCount = invalidEnumClient.requestCount()
        XCTAssertEqual(invalidEnumRequestCount, 2)
    }

    func testModelStructuredPlannerRepairsHardSoftParkingConfusion() async throws {
        let client = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category, .parkingPreference],
                         soft: []),
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category],
                         soft: [.parkingPreference]),
        ])

        let planned = try await structuredPlanner(client: client).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近的川菜馆，停车方便最好。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertTrue(planned.query?.softPreferences.contains { $0.kind == .parkingPreference } ?? false)
        XCTAssertFalse(planned.query?.hardConstraints.contains { $0.kind == .parkingPreference } ?? true)
        XCTAssertEqual(planned.repairAttempts, 1)
    }

    func testModelStructuredPlannerClarifiesContradictoryBudgetAndRejectsInventedCandidates() async throws {
        let budgetClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category, .priceMaximum],
                         soft: [],
                         budgetScope: "perPerson",
                         budgetMaximum: 40)
        ])
        let budgetPlan = try await structuredPlanner(client: budgetClient).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近人均 40 美元以内、总预算 100 美元以内的川菜馆。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(budgetPlan.status, .requiresClarification)
        XCTAssertTrue(budgetPlan.missingInformation.contains { $0.contains("预算") })

        let inventedClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category, .openAt],
                         soft: [.parkingPreference],
                         extra: ["candidates": [["name": "Fake Place"]]])
        ])
        let inventedPlan = try await structuredPlanner(client: inventedClient, maxRepairAttempts: 0).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近今晚营业、停车方便最好、人均 40 美元以内的川菜馆。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(inventedPlan.status, .requiresClarification)
        XCTAssertTrue(inventedPlan.usedDeterministicFallback)
        XCTAssertTrue(inventedPlan.missingInformation.contains { $0.contains("确认") })
    }

    func testModelStructuredPlannerPreservesUCLAAndNearbyPermissionSemantics() async throws {
        let uclaClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Chinese restaurant",
                         category: PlaceCategory.chineseRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "UCLA",
                         hard: [.category],
                         soft: [.parkingPreference])
        ])
        let uclaPlan = try await structuredPlanner(client: uclaClient).planLocalDiscovery(
            request: structuredPlannerRequest("找 UCLA 附近停车方便的中餐。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(uclaPlan.query?.locationInput.kind, .explicitRegion)
        XCTAssertEqual(uclaPlan.query?.locationInput.label, "UCLA")

        let nearbyClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "current city",
                         hard: [.category],
                         soft: []),
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.approximateCurrentLocation.rawValue,
                         locationLabel: nil,
                         hard: [.category],
                         soft: []),
        ])
        let nearbyPlan = try await structuredPlanner(client: nearbyClient).planLocalDiscovery(
            request: structuredPlannerRequest("找附近的川菜馆。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(nearbyPlan.query?.locationInput.kind, .approximateCurrentLocation)
        XCTAssertEqual(nearbyPlan.repairAttempts, 1)
    }

    func testModelStructuredPlannerPreservesUnsupportedInventoryAndFallbackBounds() async throws {
        let inventoryClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "electronics store",
                         category: PlaceCategory.electronicsStore.rawValue,
                         locationKind: PlaceLocationInputKind.approximateCurrentLocation.rawValue,
                         locationLabel: nil,
                         hard: [.category],
                         soft: [],
                         unsupported: ["live_inventory"])
        ])
        let inventoryPlan = try await structuredPlanner(client: inventoryClient).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找附近可能卖 USB-C 笔记本充电器的商店。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        XCTAssertEqual(inventoryPlan.status, .ready)
        XCTAssertTrue(inventoryPlan.unsupportedRequirements.contains("live_inventory"))

        let repairClient = P9CFakeLLMClient(responses: ["bad", "still bad", "still bad"])
        let repairPlan = try await structuredPlanner(client: repairClient, maxRepairAttempts: 2).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())

        let repairRequestCount = repairClient.requestCount()
        XCTAssertEqual(repairRequestCount, 3)
        XCTAssertEqual(repairPlan.status, .requiresClarification)
        XCTAssertTrue(repairPlan.usedDeterministicFallback)
    }

    func testModelStructuredPlannerDeterministicFallbackAndConformanceGuards() async throws {
        let simpleClient = P9CFakeLLMClient(responses: ["bad json"])
        let simplePlan = try await structuredPlanner(client: simpleClient, maxRepairAttempts: 0).planLocalDiscovery(
            request: structuredPlannerRequest("Sichuan restaurant in San Francisco"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())
        XCTAssertEqual(simplePlan.status, .ready)
        XCTAssertTrue(simplePlan.usedDeterministicFallback)

        let complexClient = P9CFakeLLMClient(responses: ["bad json"])
        let complexPlan = try await structuredPlanner(client: complexClient, maxRepairAttempts: 0).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近今晚营业、人均 40 美元以内、停车方便最好、开车 20 分钟以内的川菜馆。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())
        XCTAssertEqual(complexPlan.status, .requiresClarification)

        let deniedProfile = ModelConformanceProfile(providerID: "provider",
                                                    providerType: .openAICompatible,
                                                    modelID: "model",
                                                    capabilities: [.chat],
                                                    toolCalling: .unsupported,
                                                    trueStreamingSupported: false,
                                                    allowedRoles: [.responder],
                                                    forbiddenRoles: [.planner])
        let decision = try PersistedModelConformanceRoutingPolicy(profiles: [deniedProfile]).evaluate(
            ModelRouter.ConformanceRequest(providerID: "provider",
                                           modelID: "model",
                                           roleID: ModelConformanceRole.planner.rawValue,
                                           requiresNativeToolCalling: false,
                                           requiresTrueStreaming: false,
                                           requestedAutonomousSteps: 1))
        XCTAssertFalse(decision.allowed)
        XCTAssertTrue(decision.issues.contains("role_denied:planner"))

        let reasoningClient = P9CFakeLLMClient(responses: [
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category],
                         soft: [],
                         extra: ["reasoning": "hidden chain of thought"]),
            p9cDraftJSON(searchText: "Sichuan restaurant",
                         category: PlaceCategory.sichuanRestaurant.rawValue,
                         locationKind: PlaceLocationInputKind.explicitRegion.rawValue,
                         locationLabel: "San Francisco, CA",
                         hard: [.category],
                         soft: []),
        ])
        let reasoningPlan = try await structuredPlanner(client: reasoningClient).planLocalDiscovery(
            request: structuredPlannerRequest("帮我找 San Francisco 附近的川菜馆。"),
            fallbackPlanner: LocalDiscoveryQueryPlanner())
        XCTAssertFalse(reasoningPlan.assumptions.contains { $0.localizedCaseInsensitiveContains("hidden chain") })
        XCTAssertEqual(reasoningPlan.repairAttempts, 1)
    }

    func testWorkflowFallsBackWhenStructuredPlannerExceedsDeadline() async throws {
        let policy = LocalDiscoverySearchPolicy(defaultCandidateCount: 2,
                                                enrichmentCandidateCount: 0,
                                                maximumExecutionDurationSeconds: 5,
                                                maximumRouteCandidates: 1)
        let platform = P9CFakeLocalDiscoveryPlatform(candidateCount: 1)
        let outcome = await workflow(platform: platform,
                                     structuredPlanner: P9CSlowStructuredPlanner(),
                                     searchPolicy: policy).run(
            userText: "Sichuan restaurant in San Francisco",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "Sichuan restaurant in San Francisco"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { false })

        XCTAssertEqual(outcome.plannedQuery.status, .ready)
        XCTAssertTrue(outcome.plannedQuery.usedDeterministicFallback)
        XCTAssertTrue(outcome.plannedQuery.assumptions.contains { $0.contains("deterministic fallback") })
        XCTAssertTrue(outcome.loopResult.usedToolNames.contains("local_place_search"))
        XCTAssertNotNil(outcome.loopResult.resultDocument)
    }

    func testWorkflowRecoverySkipsSearchAfterStoredDedupSnapshot() async throws {
        let taskID = UUID()
        let runID = UUID()
        let root = p9cTempRoot("search-skip")
        let storeA = AgentCheckpointStore(baseDirectory: root)
        let query = try readyQuery("帮我找 San Jose 附近今晚还能练球的高尔夫练习场。")
        let candidates = p9cCandidates(count: 3, category: .golfDrivingRange)
        try await storeA.saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .dedupCompleted,
            approvedQuery: query,
            resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Jose, CA",
                                                                     coordinate: PlaceCoordinate(latitude: 37.3382, longitude: -121.8863),
                                                                     source: "explicit"),
            searchPolicySnapshot: recoverySearchPolicy(route: 2, enrichment: 0),
            rawCandidates: candidates,
            mergedCandidates: candidates,
            pendingRouteCandidateIDs: Array(candidates.prefix(2).map(\.stableID)),
            backend: "fixture",
            updatedAt: testNow),
            state: .running,
            lastSequence: 4)
        let loadResult = await AgentCheckpointStore(baseDirectory: root).loadLocalDiscoverySnapshot(taskID: taskID,
                                                                                                    runID: runID)
        guard case .recovered = loadResult else {
            XCTFail("expected recovered snapshot, got \(loadResult)")
            return
        }

        let platform = P9CFakeLocalDiscoveryPlatform(candidateCount: 3)
        _ = await workflow(platform: platform,
                           checkpointStore: AgentCheckpointStore(baseDirectory: root),
                           searchPolicy: recoverySearchPolicy(route: 2, enrichment: 0)).run(
            userText: query.rawUserIntent,
            decision: LocalDiscoveryIntentClassifier.classify(userText: query.rawUserIntent),
            conversationContext: nil,
            taskID: taskID,
            runID: runID,
            isCancelled: { false })

        let calls = await platform.calls()
        XCTAssertFalse(calls.contains("local_place_search"))
        XCTAssertEqual(calls.filter { $0 == "route_distance_estimate" }.count, 2)
    }

    func testWorkflowRecoverySkipsCompletedPartialRouteItems() async throws {
        let taskID = UUID()
        let runID = UUID()
        let root = p9cTempRoot("route-skip")
        let query = try readyQuery("帮我找 San Jose 附近今晚还能练球的高尔夫练习场。")
        let candidates = p9cCandidates(count: 5, category: .golfDrivingRange)
        try await AgentCheckpointStore(baseDirectory: root).saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .routeItemCompleted,
            approvedQuery: query,
            resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Jose, CA",
                                                                     coordinate: PlaceCoordinate(latitude: 37.3382, longitude: -121.8863),
                                                                     source: "explicit"),
            searchPolicySnapshot: recoverySearchPolicy(route: 5, enrichment: 0),
            rawCandidates: candidates,
            mergedCandidates: candidates,
            completedRouteCandidateIDs: Array(candidates.prefix(2).map(\.stableID)),
            pendingRouteCandidateIDs: Array(candidates.dropFirst(2).prefix(3).map(\.stableID)),
            backend: "fixture",
            updatedAt: testNow),
            state: .running,
            lastSequence: 6)

        let platform = P9CFakeLocalDiscoveryPlatform(candidateCount: 5)
        _ = await workflow(platform: platform,
                           checkpointStore: AgentCheckpointStore(baseDirectory: root),
                           searchPolicy: recoverySearchPolicy(route: 5, enrichment: 0)).run(
            userText: query.rawUserIntent,
            decision: LocalDiscoveryIntentClassifier.classify(userText: query.rawUserIntent),
            conversationContext: nil,
            taskID: taskID,
            runID: runID,
            isCancelled: { false })

        let calls = await platform.calls()
        XCTAssertFalse(calls.contains("local_place_search"))
        XCTAssertEqual(calls.filter { $0 == "route_distance_estimate" }.count, 3)
    }

    func testWorkflowRecoveryDoesNotResumeUnavailableNativeWebEnrichment() async throws {
        let taskID = UUID()
        let runID = UUID()
        let root = p9cTempRoot("enrichment-skip")
        let query = try readyQuery("帮我找 San Francisco 附近今晚营业的川菜馆。")
        let candidates = p9cCandidates(count: 3, category: .sichuanRestaurant)
        try await AgentCheckpointStore(baseDirectory: root).saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .enrichmentItemCompleted,
            approvedQuery: query,
            resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Francisco, CA",
                                                                     coordinate: PlaceCoordinate(latitude: 37.7749, longitude: -122.4194),
                                                                     source: "explicit"),
            searchPolicySnapshot: recoverySearchPolicy(route: 3, enrichment: 2),
            rawCandidates: candidates,
            mergedCandidates: candidates,
            completedRouteCandidateIDs: candidates.map(\.stableID),
            completedEnrichmentCandidateIDs: [candidates[0].stableID],
            pendingEnrichmentCandidateIDs: [candidates[1].stableID],
            backend: "fixture",
            updatedAt: testNow),
            state: .running,
            lastSequence: 8)

        let platform = P9CFakeLocalDiscoveryPlatform(candidateCount: 3)
        _ = await workflow(platform: platform,
                           checkpointStore: AgentCheckpointStore(baseDirectory: root),
                           searchPolicy: recoverySearchPolicy(route: 3, enrichment: 2)).run(
            userText: query.rawUserIntent,
            decision: LocalDiscoveryIntentClassifier.classify(userText: query.rawUserIntent),
            conversationContext: nil,
            taskID: taskID,
            runID: runID,
            isCancelled: { false })

        let calls = await platform.calls()
        XCTAssertFalse(calls.contains("local_place_search"))
        XCTAssertEqual(calls.filter { $0 == "webpage_read" }.count, 0)
        XCTAssertEqual(calls.filter { $0 == "structured_place_extraction" }.count, 0)
    }

    func testWorkflowRecoveryResumesAfterValidationAndDoesNotResumeCancelledOrCorruptedSnapshots() async throws {
        let taskID = UUID()
        let runID = UUID()
        let root = p9cTempRoot("validation-resume")
        let query = try readyQuery("帮我找 San Francisco 附近今晚营业的川菜馆。")
        let candidates = p9cCandidates(count: 2, category: .sichuanRestaurant)
        try await AgentCheckpointStore(baseDirectory: root).saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .validationCompleted,
            approvedQuery: query,
            resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Francisco, CA",
                                                                     coordinate: PlaceCoordinate(latitude: 37.7749, longitude: -122.4194),
                                                                     source: "explicit"),
            searchPolicySnapshot: recoverySearchPolicy(route: 2, enrichment: 1),
            rawCandidates: candidates,
            mergedCandidates: candidates,
            completedRouteCandidateIDs: candidates.map(\.stableID),
            completedEnrichmentCandidateIDs: [candidates[0].stableID],
            validatorFindings: [
                PlaceVerificationFinding(id: "fixture-uncertain-evidence",
                                         candidateID: candidates[0].stableID,
                                         criterion: "evidence",
                                         status: .uncertain,
                                         severity: .warning,
                                         reason: "fixture uncertain evidence",
                                         recommendedDisposition: .includeWithWarning)
            ],
            backend: "fixture",
            updatedAt: testNow),
            state: .running,
            lastSequence: 10)

        let platform = P9CFakeLocalDiscoveryPlatform(candidateCount: 2)
        let outcome = await workflow(platform: platform,
                                     checkpointStore: AgentCheckpointStore(baseDirectory: root),
                                     searchPolicy: recoverySearchPolicy(route: 2, enrichment: 1)).run(
            userText: query.rawUserIntent,
            decision: LocalDiscoveryIntentClassifier.classify(userText: query.rawUserIntent),
            conversationContext: nil,
            taskID: taskID,
            runID: runID,
            isCancelled: { false })

        let validationCalls = await platform.calls()
        XCTAssertTrue(validationCalls.isEmpty)
        XCTAssertNotNil(outcome.loopResult.resultDocument)

        let cancelledTaskID = UUID()
        let cancelledRunID = UUID()
        let cancelledRoot = p9cTempRoot("cancel-no-resume")
        try await AgentCheckpointStore(baseDirectory: cancelledRoot).saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: cancelledTaskID,
            runID: cancelledRunID,
            currentStage: .cancelled,
            approvedQuery: query,
            searchPolicySnapshot: recoverySearchPolicy(route: 2, enrichment: 1),
            updatedAt: testNow),
            state: .cancelled,
            phase: .terminal,
            lastSequence: 11)
        let cancelledPlatform = P9CFakeLocalDiscoveryPlatform()
        let cancelledOutcome = await workflow(platform: cancelledPlatform,
                                              checkpointStore: AgentCheckpointStore(baseDirectory: cancelledRoot)).run(
            userText: query.rawUserIntent,
            decision: LocalDiscoveryIntentClassifier.classify(userText: query.rawUserIntent),
            conversationContext: nil,
            taskID: cancelledTaskID,
            runID: cancelledRunID,
            isCancelled: { false })
        XCTAssertEqual(cancelledOutcome.loopResult.terminalState, .cancelled)
        let cancelledCalls = await cancelledPlatform.calls()
        XCTAssertTrue(cancelledCalls.isEmpty)

        let corruptedTaskID = UUID()
        let corruptedRunID = UUID()
        let corruptedRoot = p9cTempRoot("corrupted")
        let corruptedStore = AgentCheckpointStore(baseDirectory: corruptedRoot)
        try await corruptedStore.save(AgentCheckpoint(
            taskID: corruptedTaskID,
            runID: corruptedRunID,
            projection: AgentRunProjection(taskID: corruptedTaskID,
                                           runID: corruptedRunID,
                                           state: .running,
                                           events: [],
                                           createdAt: testNow,
                                           updatedAt: testNow),
            replayState: AgentTimelineReplayState(taskID: corruptedTaskID,
                                                  runID: corruptedRunID,
                                                  events: []),
            phase: .active,
            lastSequence: 1,
            eventCount: 0,
            domainPayloads: [LocalDiscoveryWorkflowSnapshot.domainPayloadKey: .object(["bad": .string("payload")])],
            createdAt: testNow))
        let corruptedPlatform = P9CFakeLocalDiscoveryPlatform()
        let corruptedOutcome = await workflow(platform: corruptedPlatform,
                                              checkpointStore: AgentCheckpointStore(baseDirectory: corruptedRoot)).run(
            userText: query.rawUserIntent,
            decision: LocalDiscoveryIntentClassifier.classify(userText: query.rawUserIntent),
            conversationContext: nil,
            taskID: corruptedTaskID,
            runID: corruptedRunID,
            isCancelled: { false })
        XCTAssertEqual(corruptedOutcome.loopResult.terminalState, .failed)
        let corruptedCalls = await corruptedPlatform.calls()
        XCTAssertTrue(corruptedCalls.isEmpty)
    }

    @MainActor
    func testTerminalActivityCheckpointPreservesLocalDiscoveryDomainSnapshot() async throws {
        let taskID = UUID()
        let runID = UUID()
        let root = p9cTempRoot("terminal-domain-payload")
        let runStore = AgentRunEventStore(baseDirectory: root.appendingPathComponent("events", isDirectory: true))
        let checkpointStore = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        let query = try readyQuery("帮我找 San Jose 附近今晚还能练球的高尔夫练习场。")
        let candidates = p9cCandidates(count: 2, category: .golfDrivingRange)
        try await checkpointStore.saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .resultSynthesized,
            approvedQuery: query,
            resolvedLocation: LocalDiscoveryResolvedLocationSnapshot(label: "San Jose, CA",
                                                                     coordinate: PlaceCoordinate(latitude: 37.3382, longitude: -121.8863),
                                                                     source: "explicit"),
            searchPolicySnapshot: recoverySearchPolicy(route: 2, enrichment: 0),
            rawCandidates: candidates,
            mergedCandidates: candidates,
            completedRouteCandidateIDs: candidates.map(\.stableID),
            validatorFindings: [],
            synthesizedResultRevision: 1,
            backend: "fixture",
            updatedAt: testNow),
            state: .partiallySucceeded,
            phase: .terminal,
            lastSequence: 12)

        let activityStore = AgentTaskActivityStore(persistence: nil,
                                                   eventHub: AgentEventHub(),
                                                   runEventStore: runStore,
                                                   checkpointStore: checkpointStore)
        activityStore.publish(AgentEventEnvelope(activityEvent: AgentTaskActivityEvent(
            taskID: taskID,
            runID: runID,
            sequenceNumber: 13,
            timestamp: testNow.addingTimeInterval(1),
            kind: .taskPartiallySucceeded,
            presentation: AgentTaskEventPresentation(title: "任务部分完成", detail: "Local Discovery partial result"),
            source: .runtime)))

        try await waitUntilAsync(timeout: 2, description: "terminal checkpoint preserved domain payload") {
            guard let loaded = try? await checkpointStore.load(taskID: taskID, runID: runID),
                  loaded.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] != nil else {
                return false
            }
            return loaded.phase == .terminal && loaded.lastSequence == 13
        }

        guard let loaded = try await checkpointStore.load(taskID: taskID, runID: runID),
              let payload = loaded.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] else {
            XCTFail("expected localDiscoveryWorkflow domain payload")
            return
        }
        let restored = try LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload)
        XCTAssertEqual(restored.currentStage, .resultSynthesized)
        XCTAssertEqual(restored.rankedCandidateIDs, [])
        XCTAssertEqual(loaded.phase, .terminal)
    }

    func testCancelledAppCheckpointGetsLocalDiscoveryDomainSnapshot() async throws {
        let taskID = UUID()
        let runID = UUID()
        let conversationID = UUID()
        let root = p9cTempRoot("cancel-domain-payload")
        let checkpointStore = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        let cancelledEvent = AgentEventEnvelope(taskID: taskID,
                                                runID: runID,
                                                sequence: 9,
                                                timestamp: testNow,
                                                source: .scheduler,
                                                visibility: .user,
                                                kind: .taskCancelled,
                                                payload: .empty)
        let generic = AgentCheckpointBuilder().checkpoint(taskID: taskID,
                                                          runID: runID,
                                                          events: [cancelledEvent],
                                                          createdAt: testNow)
        try await checkpointStore.save(generic)

        try await checkpointStore.markLocalDiscoverySnapshotCancelled(taskID: taskID,
                                                                      runID: runID,
                                                                      conversationID: conversationID,
                                                                      updatedAt: testNow.addingTimeInterval(1))

        guard let loaded = try await checkpointStore.load(taskID: taskID, runID: runID),
              let payload = loaded.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] else {
            XCTFail("expected cancelled localDiscoveryWorkflow domain payload")
            return
        }
        let snapshot = try LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload)
        XCTAssertEqual(snapshot.currentStage, .cancelled)
        XCTAssertEqual(loaded.phase, .terminal)
        XCTAssertEqual(loaded.projection.state, .cancelled)
        XCTAssertEqual(loaded.eventCount, 1)
        XCTAssertEqual(loaded.lastSequence, 9)
    }

    func testCheckpointSaveDoesNotRegressLocalDiscoveryDomainStage() async throws {
        let taskID = UUID()
        let runID = UUID()
        let root = p9cTempRoot("domain-stage-monotonic")
        let checkpointStore = AgentCheckpointStore(baseDirectory: root.appendingPathComponent("checkpoints", isDirectory: true))
        try await checkpointStore.saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .resultSynthesized,
            searchPolicySnapshot: recoverySearchPolicy(route: 1, enrichment: 0),
            lastAppliedEventSequence: 42,
            updatedAt: testNow),
            state: .partiallySucceeded,
            phase: .terminal,
            lastSequence: 42)
        try await checkpointStore.saveLocalDiscoverySnapshot(LocalDiscoveryWorkflowSnapshot(
            taskID: taskID,
            runID: runID,
            currentStage: .validationCompleted,
            searchPolicySnapshot: recoverySearchPolicy(route: 1, enrichment: 0),
            lastAppliedEventSequence: 40,
            updatedAt: testNow.addingTimeInterval(1)),
            state: .running,
            phase: .active,
            lastSequence: 40)

        guard let loaded = try await checkpointStore.load(taskID: taskID, runID: runID),
              let payload = loaded.domainPayloads[LocalDiscoveryWorkflowSnapshot.domainPayloadKey] else {
            XCTFail("expected localDiscoveryWorkflow domain payload")
            return
        }
        let snapshot = try LocalDiscoveryJSON.decoded(LocalDiscoveryWorkflowSnapshot.self, from: payload)
        XCTAssertEqual(snapshot.currentStage, .resultSynthesized)
        XCTAssertEqual(loaded.phase, .terminal)
        XCTAssertEqual(loaded.projection.state, .partiallySucceeded)
        XCTAssertEqual(loaded.lastSequence, 42)
    }

    func testFullStageCancellationBarriers() async throws {
        let plannerCancelled = await workflow(platform: P9CFakeLocalDiscoveryPlatform(),
                                              structuredPlanner: P9CCancellingStructuredPlanner()).run(
            userText: "帮我找 San Francisco 附近今晚营业的川菜馆。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Francisco 附近今晚营业的川菜馆。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { false })
        XCTAssertEqual(plannerCancelled.loopResult.terminalState, .cancelled)

        try await assertToolCancellation(toolName: "approximate_location",
                                         text: "帮我找附近今晚营业的川菜馆。",
                                         expectedCalls: ["approximate_location"])
        try await assertToolCancellation(toolName: "local_place_search",
                                         text: "帮我找 San Francisco 附近今晚营业的川菜馆。",
                                         expectedCalls: ["local_place_search"])
        try await assertToolCancellation(toolName: "route_distance_estimate",
                                         text: "帮我找 San Francisco 附近今晚营业的川菜馆。",
                                         expectedCalls: ["local_place_search", "route_distance_estimate"])
        let validatorBarrier = P9CCancellationBarrier(cancelAtStepID: "validateCandidates",
                                                      cancelOnKind: .verificationStarted)
        let validatorOutcome = await workflow(platform: P9CFakeLocalDiscoveryPlatform(),
                                              searchPolicy: recoverySearchPolicy(route: 1, enrichment: 1)).run(
            userText: "帮我找 San Francisco 附近今晚营业的川菜馆。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Francisco 附近今晚营业的川菜馆。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { await validatorBarrier.isCancelled() },
            activitySink: { await validatorBarrier.append($0) })
        XCTAssertEqual(validatorOutcome.loopResult.terminalState, .cancelled)
        let validatorHasGenericVerifier = await validatorBarrier.hasEvent(stepID: "genericVerifier")
        XCTAssertFalse(validatorHasGenericVerifier)

        let verifierBarrier = P9CCancellationBarrier(cancelAtStepID: "validateCandidates",
                                                     cancelOnKind: .verificationSucceeded)
        let verifierOutcome = await workflow(platform: P9CFakeLocalDiscoveryPlatform(),
                                             searchPolicy: recoverySearchPolicy(route: 1, enrichment: 1)).run(
            userText: "帮我找 San Francisco 附近今晚营业的川菜馆。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Francisco 附近今晚营业的川菜馆。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { await verifierBarrier.isCancelled() },
            activitySink: { await verifierBarrier.append($0) })
        XCTAssertEqual(verifierOutcome.loopResult.terminalState, .cancelled)
        let verifierHasGenericVerifier = await verifierBarrier.hasEvent(stepID: "genericVerifier")
        XCTAssertFalse(verifierHasGenericVerifier)

        let synthesisBarrier = P9CCancellationBarrier(cancelAtStepID: "synthesizeResult",
                                                      cancelOnKind: .synthesisStarted)
        let synthesisOutcome = await workflow(platform: P9CFakeLocalDiscoveryPlatform(),
                                              searchPolicy: recoverySearchPolicy(route: 1, enrichment: 1)).run(
            userText: "帮我找 San Francisco 附近今晚营业的川菜馆。",
            decision: LocalDiscoveryIntentClassifier.classify(userText: "帮我找 San Francisco 附近今晚营业的川菜馆。"),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { await synthesisBarrier.isCancelled() },
            activitySink: { await synthesisBarrier.append($0) })
        XCTAssertEqual(synthesisOutcome.loopResult.terminalState, .cancelled)
        XCTAssertNil(synthesisOutcome.loopResult.resultDocument)
    }

    private func workflow(platform: P9CFakeLocalDiscoveryPlatform,
                          structuredPlanner: (any LocalDiscoveryStructuredPlanning)? = nil,
                          checkpointStore: AgentCheckpointStore? = nil,
                          searchPolicy: LocalDiscoverySearchPolicy? = nil) -> LocalDiscoveryWorkflow {
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in .allowSession })
        return LocalDiscoveryWorkflow(toolCatalogProvider: platform,
                                      toolPlatformExecutor: platform,
                                      gate: gate,
                                      policy: AgentPolicy(allowTools: true,
                                                          maxSteps: 4,
                                                          maxIterations: 4,
                                                          maxToolCalls: 24,
                                                          maxWallClock: 60,
                                                          tier: .developerID),
                                      searchPolicy: searchPolicy ?? LocalDiscoverySearchPolicy(defaultCandidateCount: 3,
                                                                                                enrichmentCandidateCount: 1,
                                                                                                maximumRouteCandidates: 2),
                                      clock: TestClock(start: testNow),
                                      localeProvider: { Locale(identifier: "en_US") },
                                      timeZoneProvider: { TimeZone(identifier: "America/Los_Angeles")! },
                                      structuredPlanner: structuredPlanner,
                                      checkpointStore: checkpointStore)
    }

    private func structuredPlanner(client: P9CFakeLLMClient,
                                   maxRepairAttempts: Int = 2) -> LocalDiscoveryModelStructuredPlanner {
        LocalDiscoveryModelStructuredPlanner(
            client: client,
            modelID: "fake-model",
            modelProvider: "fixture:fake-model",
            conformance: LocalDiscoveryPlannerConformance(providerID: "fixture",
                                                          modelID: "fake-model",
                                                          supportsStructuredOutput: true,
                                                          requiresOutputRepair: true,
                                                          supportsReasoningSeparation: true,
                                                          maxAutonomousSteps: 4),
            maxRepairAttempts: maxRepairAttempts)
    }

    private func structuredPlannerRequest(_ text: String) -> LocalDiscoveryStructuredPlannerRequest {
        LocalDiscoveryStructuredPlannerRequest(
            userText: text,
            decision: LocalDiscoveryIntentClassifier.classify(userText: text),
            now: testNow,
            locale: Locale(identifier: "en_US"),
            timeZone: TimeZone(identifier: "America/Los_Angeles")!,
            availableCapabilityIDs: [
                "approximate_location",
                "local_place_search",
                "route_distance_estimate",
                "webpage_read",
                "structured_place_extraction",
            ],
            permissionStateSummary: ["location.approximate.read": "mayRequest"],
            policy: LocalDiscoverySearchPolicy())
    }

    private func readyQuery(_ text: String) throws -> PlaceQuery {
        let planned = LocalDiscoveryQueryPlanner().plan(userText: text,
                                                       decision: LocalDiscoveryIntentClassifier.classify(userText: text),
                                                       now: testNow,
                                                       locale: Locale(identifier: "en_US"),
                                                       timeZone: TimeZone(identifier: "America/Los_Angeles")!)
        return try XCTUnwrap(planned.query)
    }

    private func recoverySearchPolicy(route: Int, enrichment: Int) -> LocalDiscoverySearchPolicy {
        LocalDiscoverySearchPolicy(defaultCandidateCount: max(route, enrichment, 3),
                                   enrichmentCandidateCount: enrichment,
                                   maximumRouteCandidates: route,
                                   maximumTotalToolCalls: 32)
    }

    private func assertToolCancellation(toolName: String,
                                        text: String,
                                        expectedCalls: [String],
                                        file: StaticString = #filePath,
                                        line: UInt = #line) async throws {
        let platform = P9CFakeLocalDiscoveryPlatform(cancelledTools: [toolName])
        let outcome = await workflow(platform: platform,
                                     searchPolicy: recoverySearchPolicy(route: 1, enrichment: 1)).run(
            userText: text,
            decision: LocalDiscoveryIntentClassifier.classify(userText: text),
            conversationContext: nil,
            taskID: UUID(),
            runID: UUID(),
            isCancelled: { false })
        XCTAssertEqual(outcome.loopResult.terminalState, .cancelled, file: file, line: line)
        let calls = await platform.calls()
        XCTAssertEqual(Array(calls.prefix(expectedCalls.count)), expectedCalls, file: file, line: line)
    }

    @MainActor
    private func waitUntilAsync(timeout: TimeInterval,
                                description: String,
                                predicate: @MainActor @escaping () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("Timed out waiting for \(description)")
    }
}

final class P9CLocalDiscoveryLiveWorkflowProbeTests: XCTestCase {
    func testLiveMiniMaxStructuredPlannerUsesModelRouterAndConformanceWhenEnabled() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["DESKPET_P9C_LIVE_STRUCTURED_PLANNER_PROBE"] == "1" else {
            throw XCTSkip("Set DESKPET_P9C_LIVE_STRUCTURED_PLANNER_PROBE=1 to run live structured planner probe.")
        }
        let apiKey = try liveEnvironmentValue("MINIMAX_API_KEY", environment: environment)
        let baseURL = try XCTUnwrap(URL(string: environment["DESKPET_LIVE_MINIMAX_BASE_URL"] ?? "https://api.minimaxi.com/v1"))
        let modelID = environment["DESKPET_LIVE_MINIMAX_MODEL"] ?? "MiniMax-M3"
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-p9c-live-structured-planner-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let secretStore = InMemorySecretStore()
        let profileStore = ModelConformanceProfileStore(baseDirectory: root.appendingPathComponent("profiles", isDirectory: true))
        let providerID = "p9c-live-minimax"
        let secretID = "p9c-live-minimax-key"
        try await secretStore.save(apiKey, for: secretID)
        let provider = ProviderConfig(id: providerID,
                                      displayName: "P9C MiniMax Live",
                                      type: .openAICompatible,
                                      baseURL: baseURL,
                                      apiKeySecretID: secretID,
                                      defaultModelID: modelID,
                                      enabled: true,
                                      capabilities: [.chat, .streaming, .toolCalling])
        let providerStore = await MainActor.run {
            ProviderStore(fileURL: root.appendingPathComponent("providers.json"),
                          secretStore: secretStore,
                          conformanceProfileStore: profileStore)
        }
        let saveResult = await providerStore.upsert(provider, manualModelID: modelID)
        XCTAssertTrue(saveResult.isSuccess, saveResult.errorMessage ?? "provider save failed")
        await MainActor.run {
            providerStore.setDefault(role: .tool, providerID: providerID, modelID: modelID)
        }
        let profile = ModelConformanceProfile(providerID: providerID,
                                              providerType: provider.type,
                                              modelID: modelID,
                                              adapterVersion: provider.type.rawValue,
                                              capabilities: provider.capabilities,
                                              toolCalling: .native,
                                              trueStreamingSupported: true,
                                              supportsStreamingToolArguments: true,
                                              supportsStructuredOutput: true,
                                              supportsReasoningSeparation: true,
                                              schemaReliability: 0.8,
                                              toolCallReliability: 0.8,
                                              hiddenReasoningFields: ["reasoning", "reasoning_content"],
                                              requiredRequestFlags: ["thinking.type": "disabled", "reasoning_split": "true"],
                                              maxToolCalls: 8,
                                              allowedRoles: [.planner, .responder, .toolCaller, .synthesizer],
                                              maxAutonomousSteps: 4,
                                              requiresOutputRepair: false,
                                              evidenceSummary: "P9C live structured planner opt-in probe")
        try await profileStore.save(profile)

        let policy = try await profileStore.routingPolicy()
        let route = await ModelRouter().route(.tool,
                                              providers: await MainActor.run { providerStore.providers },
                                              defaults: await MainActor.run { providerStore.defaults },
                                              secretStore: secretStore,
                                              conformancePolicy: policy,
                                              requestedAutonomousSteps: 2)
        let selection: ModelRouter.Selection
        switch route {
        case .success(let routed):
            selection = routed
        case .failure(let error):
            XCTFail("ModelRouter failed live planner route: \(error)")
            return
        }
        XCTAssertEqual(selection.provider.id, providerID)
        XCTAssertEqual(selection.modelID, modelID)
        XCTAssertEqual(selection.conformance?.allowed, true)

        let client = try await ProviderClientFactory(secretStore: secretStore).makeClient(provider: selection.provider)
        let conformance = LocalDiscoveryPlannerConformance(providerID: providerID,
                                                           modelID: modelID,
                                                           supportsStructuredOutput: true,
                                                           requiresOutputRepair: false,
                                                           supportsReasoningSeparation: true,
                                                           maxAutonomousSteps: selection.conformance?.maxAutonomousSteps ?? 4)
        let planner = LocalDiscoveryModelStructuredPlanner(client: client,
                                                           modelID: selection.modelID,
                                                           modelProvider: "\(selection.provider.type.rawValue):\(selection.modelID)",
                                                           conformance: conformance,
                                                           maxRepairAttempts: 2)
        let livePlannerText = "Sichuan restaurant in San Francisco"
        let request = LocalDiscoveryStructuredPlannerRequest(
            userText: livePlannerText,
            decision: LocalDiscoveryIntentClassifier.classify(userText: livePlannerText),
            now: Date(timeIntervalSince1970: 1_785_196_800),
            locale: Locale(identifier: "zh_Hans_US"),
            timeZone: TimeZone(identifier: "America/Los_Angeles")!,
            availableCapabilityIDs: [
                "approximate_location",
                "local_place_search",
                "route_distance_estimate",
                "webpage_read",
                "structured_place_extraction",
            ],
            permissionStateSummary: ["location.approximate.read": "notRequested"],
            policy: LocalDiscoverySearchPolicy())
        let planned = try await planner.planLocalDiscovery(request: request,
                                                           fallbackPlanner: LocalDiscoveryQueryPlanner())
        let record = P9CLiveStructuredPlannerRecord(provider: selection.provider.type.rawValue,
                                                    modelID: selection.modelID,
                                                    structuredMode: conformance.supportsStructuredOutput ? "native_or_constrained" : "text_constrained",
                                                    repairRounds: planned.repairAttempts,
                                                    usedDeterministicFallback: planned.usedDeterministicFallback,
                                                    status: planned.status.rawValue,
                                                    category: planned.query?.category.rawValue,
                                                    locationKind: planned.query?.locationInput.kind.rawValue,
                                                    explicitLocation: planned.query?.locationInput.label,
                                                    missingInformation: planned.missingInformation,
                                                    unsupportedRequirements: planned.unsupportedRequirements)
        print("P9C_LIVE_STRUCTURED_PLANNER_RESULT \(try record.jsonLine())")

        XCTAssertEqual(planned.status, .ready)
        XCTAssertFalse(planned.usedDeterministicFallback)
        XCTAssertEqual(planned.query?.locationInput.kind, .explicitRegion)
        XCTAssertTrue(planned.query?.locationInput.label?.localizedCaseInsensitiveContains("San Francisco") == true)
        XCTAssertEqual(planned.query?.category, .sichuanRestaurant)
    }

    func testLiveNaturalLanguageSichuanRestaurantWorkflowProbe() async throws {
        try await runLiveProbe(id: "p9c-live-sichuan",
                               text: "帮我找 San Francisco 附近今晚营业、人均 40 美元以内的川菜馆，停车方便最好。")
    }

    func testLiveNaturalLanguageGolfDrivingRangeWorkflowProbe() async throws {
        try await runLiveProbe(id: "p9c-live-golf",
                               text: "帮我找 San Jose 附近今晚还能练球、关门比较晚的高尔夫练习场。")
    }

    private func runLiveProbe(id: String, text: String) async throws {
        guard ProcessInfo.processInfo.environment["DESKPET_P9C_LIVE_WORKFLOW_PROBE"] == "1" else {
            throw XCTSkip("Set DESKPET_P9C_LIVE_WORKFLOW_PROBE=1 to run live P9C Local Discovery workflow probes.")
        }
        let appGate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in .allowSession })
        let permissionGate = CapabilityPermissionGate(appGate: appGate,
                                                      audit: InMemoryAuditSink(),
                                                      clock: WallClock())
        let registry = ToolRegistry(gate: permissionGate, audit: InMemoryAuditSink())
        for tool in ToolPlatformAssembly.releaseTools {
            try await registry.registerAgentTool(tool)
        }

        let taskID = UUID()
        let runID = UUID()
        let decision = LocalDiscoveryIntentClassifier.classify(userText: text)
        let workflow = LocalDiscoveryWorkflow(toolCatalogProvider: registry,
                                              toolPlatformExecutor: registry,
                                              gate: appGate,
                                              policy: AgentPolicy(allowTools: true,
                                                                  maxSteps: 4,
                                                                  maxIterations: 4,
                                                                  maxToolCalls: 24,
                                                                  maxWallClock: 60,
                                                                  tier: .developerID),
                                              searchPolicy: LocalDiscoverySearchPolicy(defaultCandidateCount: 5,
                                                                                        enrichmentCandidateCount: 2,
                                                                                        maximumRouteCandidates: 3),
                                              clock: WallClock(),
                                              localeProvider: { Locale(identifier: "en_US") },
                                              timeZoneProvider: { TimeZone(identifier: "America/Los_Angeles")! })
        let activityRecorder = P9CStringRecorder()
        let outcome = await workflow.run(userText: text,
                                         decision: decision,
                                         conversationContext: nil,
                                         taskID: taskID,
                                         runID: runID,
                                         isCancelled: { false },
                                         activitySink: {
                                            await activityRecorder.append($0.title)
                                         })
        let activities = await activityRecorder.values()
        let record = P9CLiveWorkflowRecord(probeID: id,
                                           rawText: text,
                                           plannedCategory: outcome.plannedQuery.query?.category.rawValue,
                                           plannedLocationKind: outcome.plannedQuery.query?.locationInput.kind.rawValue,
                                           usedTools: outcome.loopResult.usedToolNames,
                                           toolCallCount: outcome.loopResult.toolCallCount,
                                           terminalState: outcome.loopResult.terminalState.rawValue,
                                           stopReason: outcome.loopResult.stopReason.rawValue,
                                           verifierVerdict: outcome.verifierReport.verdict.rawValue,
                                           resultStatus: outcome.localResult?.status.rawValue,
                                           candidateCount: outcome.localResult?.candidates.count ?? 0,
                                           excludedCount: outcome.localResult?.excludedCandidates.count ?? 0,
                                           evidenceCount: outcome.localResult?.evidence.count ?? 0,
                                           activityCount: activities.count,
                                           firstActivities: Array(activities.prefix(8)))
        print("P9C_LIVE_WORKFLOW_RESULT \(try record.jsonLine())")

        XCTAssertEqual(outcome.plannedQuery.query?.rawUserIntent, text)
        XCTAssertTrue(outcome.loopResult.usedToolNames.contains("local_place_search"))
        if (outcome.localResult?.candidates.count ?? 0) > 0 {
            XCTAssertTrue(outcome.loopResult.usedToolNames.contains("route_distance_estimate")
                          || outcome.loopResult.finalResponse?.text.contains("路线时间保持 unknown") == true)
        } else {
            XCTAssertEqual(outcome.localResult?.status, .noMatchingResults)
        }
        XCTAssertNotNil(outcome.loopResult.resultDocument)
    }

    private func liveEnvironmentValue(_ key: String,
                                      environment: [String: String]) throws -> String {
        let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !value.isEmpty else {
            throw XCTSkip("\(key) is not set; live structured planner probe skipped.")
        }
        return value
    }
}

private struct P9CLiveStructuredPlannerRecord: Codable, Sendable {
    var provider: String
    var modelID: String
    var structuredMode: String
    var repairRounds: Int
    var usedDeterministicFallback: Bool
    var status: String
    var category: String?
    var locationKind: String?
    var explicitLocation: String?
    var missingInformation: [String]
    var unsupportedRequirements: [String]

    func jsonLine() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(data: try encoder.encode(self), encoding: .utf8) ?? "{}"
    }
}

private struct P9CLiveWorkflowRecord: Codable, Sendable {
    var probeID: String
    var rawText: String
    var plannedCategory: String?
    var plannedLocationKind: String?
    var usedTools: [String]
    var toolCallCount: Int
    var terminalState: String
    var stopReason: String
    var verifierVerdict: String
    var resultStatus: String?
    var candidateCount: Int
    var excludedCount: Int
    var evidenceCount: Int
    var activityCount: Int
    var firstActivities: [String]

    func jsonLine() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(data: try encoder.encode(self), encoding: .utf8) ?? "{}"
    }
}

private final class P9CFakeLLMClient: LLMClient, @unchecked Sendable {
    let capabilities: Set<ModelCapability> = [.chat, .toolCalling]
    let toolCallingCapability: ProviderToolCallingCapability = .native
    private let queue = DispatchQueue(label: "P9CFakeLLMClient")
    private var responses: [String]
    private var requests: [LLMChatRequest] = []

    init(responses: [String]) {
        self.responses = responses
    }

    func requestCount() -> Int {
        queue.sync { requests.count }
    }

    func capturedRequests() -> [LLMChatRequest] {
        queue.sync { requests }
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        let content = queue.sync { () -> String in
            requests.append(request)
            return responses.isEmpty ? "{}" : responses.removeFirst()
        }
        return LLMChatResponse(message: LLMChatMessage(role: .assistant, content: content),
                               modelID: request.modelID)
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish()
        }
    }

    func listModels() async throws -> [ModelDescriptor] { [] }
    func testConnection() async -> ProviderConnectionStatus { .connected }
}

private struct P9CCancellingStructuredPlanner: LocalDiscoveryStructuredPlanning {
    func planLocalDiscovery(request: LocalDiscoveryStructuredPlannerRequest,
                            fallbackPlanner: LocalDiscoveryQueryPlanner) async throws -> LocalDiscoveryPlannedQuery {
        throw CancellationError()
    }
}

private struct P9CSlowStructuredPlanner: LocalDiscoveryStructuredPlanning {
    func planLocalDiscovery(request: LocalDiscoveryStructuredPlannerRequest,
                            fallbackPlanner: LocalDiscoveryQueryPlanner) async throws -> LocalDiscoveryPlannedQuery {
        try await Task.sleep(nanoseconds: 60_000_000_000)
        return fallbackPlanner.plan(userText: request.userText,
                                    decision: request.decision,
                                    conversationContext: request.conversationContext,
                                    now: request.now,
                                    locale: request.locale,
                                    timeZone: request.timeZone)
    }
}

private actor P9CCancellationBarrier {
    private let cancelAtStepID: String
    private let cancelOnKind: AgentTaskEventKind
    private var cancelled = false
    private var events: [LocalDiscoveryWorkflowActivity] = []

    init(cancelAtStepID: String, cancelOnKind: AgentTaskEventKind) {
        self.cancelAtStepID = cancelAtStepID
        self.cancelOnKind = cancelOnKind
    }

    func append(_ event: LocalDiscoveryWorkflowActivity) {
        events.append(event)
        if event.stepID == cancelAtStepID && event.kind == cancelOnKind {
            cancelled = true
        }
    }

    func isCancelled() -> Bool { cancelled }

    func hasEvent(stepID: String) -> Bool {
        events.contains { $0.stepID == stepID }
    }
}

private func p9cDraftJSON(searchText: String,
                          category: String,
                          locationKind: String,
                          locationLabel: String?,
                          hard: [PlaceConstraintKind],
                          soft: [PlaceConstraintKind],
                          budgetScope: String? = nil,
                          budgetMaximum: Double? = nil,
                          missingInformation: [String] = [],
                          unsupported: [String] = [],
                          extra: [String: Any] = [:]) -> String {
    var location: [String: Any] = ["kind": locationKind]
    if let locationLabel {
        location["label"] = locationLabel
    }
    var object: [String: Any] = [
        "isLocalDiscovery": true,
        "searchText": searchText,
        "category": category,
        "locationInput": location,
        "hardConstraints": hard.map { constraint in
            ["kind": constraint.rawValue, "priority": PlaceConstraintPriority.hard.rawValue, "value": constraint.rawValue]
        },
        "softPreferences": soft.map { constraint in
            ["kind": constraint.rawValue, "priority": PlaceConstraintPriority.soft.rawValue, "value": constraint.rawValue]
        },
        "resultLimit": 5,
        "assumptions": [],
        "missingInformation": missingInformation,
        "unsupportedRequirements": unsupported,
    ]
    if let budgetScope {
        var budget: [String: Any] = [
            "scope": budgetScope,
            "currencyCode": "USD",
        ]
        if let budgetMaximum {
            budget["maximumAmount"] = budgetMaximum
        }
        object["budget"] = budget
    }
    for (key, value) in extra {
        object[key] = value
    }
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(data: data, encoding: .utf8)!
}

private func p9cCandidates(count: Int, category: PlaceCategory) -> [PlaceCandidate] {
    (0..<count).map { index in
        let evidence = PlaceEvidenceReference(evidenceID: "snapshot-evidence-\(index)",
                                              sourceToolID: "local_place_search",
                                              sourceURL: nil,
                                              claim: "snapshot candidate",
                                              observedAt: Date(timeIntervalSince1970: 1_785_196_800),
                                              freshness: "fixture-current",
                                              confidence: 0.8)
        return PlaceCandidate(stableID: "candidate-\(index)",
                              sourceEntityIDs: ["snapshot:\(index)"],
                              name: category == .golfDrivingRange ? "Range \(index)" : "Candidate \(index)",
                              categories: [category],
                              address: PlaceAddress(formatted: "\(index) Test St"),
                              coordinate: PlaceCoordinate(latitude: 37.78 + Double(index) * 0.01,
                                                          longitude: -122.41 - Double(index) * 0.01),
                              webLinks: [
                                PlaceWebLink(id: "candidate-\(index)-source",
                                             kind: .source,
                                             title: "Fixture source",
                                             url: "https://example.com/candidate-\(index)",
                                             evidenceReferences: [evidence]),
                              ],
                              evidenceReferences: [evidence],
                              freshness: "fixture-current")
    }
}

private func p9cTempRoot(_ name: String) -> URL {
    URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("deskpet-p9c-closeout-\(name)-\(UUID().uuidString)", isDirectory: true)
}

private actor P9CFakeLocalDiscoveryPlatform: ToolCatalogProviding, ToolPlatformExecuting {
    private var recordedCalls: [String] = []
    private let locationDenied: Bool
    private let routePartial: Bool
    private let candidateCount: Int
    private let cancelledTools: Set<String>

    init(locationDenied: Bool = false,
         routePartial: Bool = false,
         candidateCount: Int = 2,
         cancelledTools: Set<String> = []) {
        self.locationDenied = locationDenied
        self.routePartial = routePartial
        self.candidateCount = max(0, candidateCount)
        self.cancelledTools = cancelledTools
    }

    func calls() -> [String] { recordedCalls }

    func toolCatalogSnapshot(for policy: AgentPolicy) async -> ToolCatalogSnapshot {
        let localIDs: Set<String> = [
            "approximate_location",
            "local_place_search",
            "route_distance_estimate",
            "webpage_read",
            "structured_place_extraction",
        ]
        return ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests
            .filter { localIDs.contains($0.id.rawValue) }
            .map { ToolCatalogEntry(manifest: $0, enabled: true) })
    }

    func executeTool(request: AgentToolCallRequest,
                     context: ToolExecutionContext) async -> Result<ToolExecutionResult, ToolPlatformError> {
        recordedCalls.append(request.toolName)
        if cancelledTools.contains(request.toolName) {
            return .failure(.cancelled)
        }
        switch request.toolName {
        case "approximate_location":
            return .success(locationOutput(context: context))
        case "local_place_search":
            return .success(searchOutput(request: request, context: context))
        case "route_distance_estimate":
            return .success(routeOutput(context: context))
        case "webpage_read":
            return .success(webOutput(context: context))
        case "structured_place_extraction":
            return .success(extractionOutput(context: context))
        default:
            return .failure(.unknownTool(request.toolName))
        }
    }

    private func locationOutput(context: ToolExecutionContext) -> ToolExecutionResult {
        let evidence = evidenceReference(context: context, claim: "fixture approximate location")
        if locationDenied {
            return ToolExecutionResult(status: .denied,
                                       userSafeSummary: "位置权限被拒绝",
                                       structuredData: .object([
                                        "status": .string("denied"),
                                        "authorizationState": .string("denied"),
                                        "capturedAt": .string(iso(context.clock.now())),
                                        "source": .string("fixture"),
                                        "evidenceReferences": .array([try! LocalDiscoveryJSON.jsonValue(from: evidence)]),
                                       ]))
        }
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "已获取大致位置",
                                   structuredData: .object([
                                    "status": .string("success"),
                                    "authorizationState": .string("granted"),
                                    "coordinate": .object([
                                        "latitude": .number(37.7749),
                                        "longitude": .number(-122.4194),
                                        "horizontalAccuracyMeters": .number(3_000),
                                    ]),
                                    "regionDescription": .string("San Francisco"),
                                    "capturedAt": .string(iso(context.clock.now())),
                                    "source": .string("fixture"),
                                    "evidenceReferences": .array([try! LocalDiscoveryJSON.jsonValue(from: evidence)]),
                                   ]))
    }

    private func searchOutput(request: AgentToolCallRequest,
                              context: ToolExecutionContext) -> ToolExecutionResult {
        let category = PlaceCategory(rawValue: request.arguments.stringValue("category") ?? "place")
        let evidence = evidenceReference(context: context, claim: "fixture local search")
        let candidates = (0..<candidateCount).map { index in
            PlaceCandidate(stableID: "candidate-\(index)",
                           sourceEntityIDs: ["fixture:\(index)"],
                           name: category == .golfDrivingRange ? "Range \(index)" : "Candidate \(index)",
                           categories: [category],
                           address: PlaceAddress(formatted: "\(index) Test St"),
                           coordinate: PlaceCoordinate(latitude: 37.78 + Double(index) * 0.01,
                                                       longitude: -122.41 - Double(index) * 0.01),
                           webLinks: [
                            PlaceWebLink(id: "candidate-\(index)-source",
                                         kind: .source,
                                         title: "Fixture source",
                                         url: "https://example.com/candidate-\(index)",
                                         evidenceReferences: [evidence]),
                           ],
                           evidenceReferences: [evidence],
                           freshness: "fixture-current",
                           verificationStatus: .unknown,
                           actionDescriptors: [
                            PlaceActionDescriptor(actionID: "show-\(index)",
                                                  type: .showDetails,
                                                  label: "Show details",
                                                  targetReference: "candidate-\(index)",
                                                  permissionRequirement: .none),
                           ])
        }
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "找到 2 个候选地点",
                                   structuredData: .object([
                                    "status": .string("success"),
                                    "backend": .string("fixture"),
                                    "query": .string(request.arguments.stringValue("queryText") ?? ""),
                                    "inputLocationType": .string("fixture"),
                                    "resultCount": .number(Double(candidates.count)),
                                    "candidates": .array(candidates.map { try! LocalDiscoveryJSON.jsonValue(from: $0) }),
                                    "evidenceReferences": .array([try! LocalDiscoveryJSON.jsonValue(from: evidence)]),
                                    "fetchedAt": .string(iso(context.clock.now())),
                                    "usedFixture": .bool(true),
                                   ]),
                                   metadata: ToolExecutionMetadata(itemCount: candidates.count))
    }

    private func routeOutput(context: ToolExecutionContext) -> ToolExecutionResult {
        let evidence = evidenceReference(context: context, claim: "fixture route")
        var output: [String: AgentJSONValue] = [
            "status": .string(routePartial ? "partial" : "success"),
            "transportMode": .string("automobile"),
            "straightLineDistanceMeters": .number(1_200),
            "calculationSource": .string(routePartial ? "haversine" : "fixture-route"),
            "calculatedAt": .string(iso(context.clock.now())),
            "evidenceReferences": .array([try! LocalDiscoveryJSON.jsonValue(from: evidence)]),
            "usedFixture": .bool(true),
        ]
        if !routePartial {
            output["routeDistanceMeters"] = .number(1_800)
            output["estimatedTravelDurationSeconds"] = .number(480)
        } else {
            output["uncertaintyReason"] = .string("route unavailable")
        }
        return ToolExecutionResult(status: routePartial ? .partial : .success,
                                   userSafeSummary: routePartial ? "已计算直线距离" : "已估算路线距离",
                                   structuredData: .object(output))
    }

    private func webOutput(context: ToolExecutionContext) -> ToolExecutionResult {
        let evidence = evidenceReference(context: context, claim: "fixture webpage")
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "已读取网页",
                                   structuredData: .object([
                                    "status": .string("success"),
                                    "canonicalURL": .string("https://example.com/candidate"),
                                    "pageTitle": .string("Fixture Candidate"),
                                    "extractedText": .string("Free parking nearby."),
                                    "structuredMetadata": .array([
                                        .object([
                                            "@type": .string("Restaurant"),
                                            "telephone": .string("+1 415 555 0100"),
                                            "priceRange": .string("$$"),
                                            "openingHours": .array([.string("Mo-Su 17:00-22:00")]),
                                        ]),
                                    ]),
                                    "fetchedAt": .string(iso(context.clock.now())),
                                    "contentHash": .string("fixture-hash"),
                                    "contentIsUntrusted": .bool(true),
                                    "evidenceReferences": .array([try! LocalDiscoveryJSON.jsonValue(from: evidence)]),
                                   ]))
    }

    private func extractionOutput(context: ToolExecutionContext) -> ToolExecutionResult {
        let evidence = evidenceReference(context: context, claim: "fixture extraction")
        let evidenceValue = try! LocalDiscoveryJSON.jsonValue(from: evidence)
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "已提取结构化字段",
                                   structuredData: .object([
                                    "status": .string("success"),
                                    "sourceEvidenceID": .string("fixture-web"),
                                    "extractedFields": .object([
                                        "phone": field("+1 415 555 0100", evidence: evidenceValue),
                                        "website": field("https://example.com/candidate", evidence: evidenceValue),
                                        "priceHints": field("$$", evidence: evidenceValue),
                                        "parkingHints": .object([
                                            "status": .string("partiallyVerified"),
                                            "value": .array([.string("free parking")]),
                                            "confidence": .number(0.45),
                                            "source": .string("pageText"),
                                            "uncertaintyReason": .string("parking text is a hint"),
                                            "evidenceReferences": .array([evidenceValue]),
                                        ]),
                                        "openingHours": .object([
                                            "status": .string("partiallyVerified"),
                                            "value": .array([.string("Mo-Su 17:00-22:00")]),
                                            "confidence": .number(0.8),
                                            "source": .string("structuredMetadata"),
                                            "evidenceReferences": .array([evidenceValue]),
                                        ]),
                                    ]),
                                    "warnings": .array([]),
                                    "evidenceReferences": .array([evidenceValue]),
                                    "usedFixture": .bool(true),
                                   ]))
    }

    private func evidenceReference(context: ToolExecutionContext,
                                   claim: String) -> PlaceEvidenceReference {
        PlaceEvidenceReference(evidenceID: "evidence-\(context.callID)",
                               sourceToolID: context.toolID,
                               sourceURL: nil,
                               claim: claim,
                               observedAt: context.clock.now(),
                               freshness: "fixture-current",
                               confidence: 0.8)
    }

    private func field(_ value: String, evidence: AgentJSONValue) -> AgentJSONValue {
        .object([
            "status": .string("partiallyVerified"),
            "value": .string(value),
            "confidence": .number(0.75),
            "source": .string("fixture"),
            "evidenceReferences": .array([evidence]),
        ])
    }

    private func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}

private actor P9CActivityRecorder {
    private var events: [LocalDiscoveryWorkflowActivity] = []

    func append(_ event: LocalDiscoveryWorkflowActivity) {
        events.append(event)
    }

    func values() -> [LocalDiscoveryWorkflowActivity] {
        events
    }
}

private actor P9CStringRecorder {
    private var strings: [String] = []

    func append(_ value: String) {
        strings.append(value)
    }

    func values() -> [String] {
        strings
    }
}

private extension AgentJSONValue {
    func stringValue(_ key: String) -> String? {
        guard case .object(let object) = self,
              case .string(let value)? = object[key] else { return nil }
        return value
    }
}
