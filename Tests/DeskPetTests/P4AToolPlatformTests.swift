import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import AICore

final class P4AToolPlatformTests: XCTestCase {

    func testReleaseManifestsHaveUniqueToolIDsAndExpectedTools() {
        let manifests = ToolPlatformAssembly.releaseManifests
        let ids = manifests.map(\.id.rawValue)
        XCTAssertEqual(Set(ids).count, ids.count)
        XCTAssertEqual(Set(ids), [
            "approximate_location",
            "get_current_datetime",
            "get_frontmost_application",
            "get_system_profile",
            "list_today_calendar_events",
            "local_place_search",
            "route_distance_estimate",
            "structured_place_extraction",
        ])
        XCTAssertFalse(ids.contains("echo"))
        XCTAssertFalse(ids.contains("runtime.status"))
        XCTAssertFalse(ids.contains("calendar.event.create"))
    }

    func testRegistryRejectsDuplicateAgentToolRegistration() async throws {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(CurrentDateTimeAgentTool())
        do {
            try await registry.register(CurrentDateTimeAgentTool())
            XCTFail("duplicate tool id should throw")
        } catch ToolPlatformError.duplicateRegistration(let id) {
            XCTAssertEqual(id, "get_current_datetime")
        }
    }

    func testSnapshotSortsAndFiltersDisabledTools() async throws {
        let policy = InMemoryToolPolicyStore()
        await policy.setEnabled(false, for: "get_frontmost_application")
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink(), toolPolicy: policy)
        for tool in ToolPlatformAssembly.releaseTools {
            try await registry.registerAgentTool(tool)
        }

        let snapshot = await registry.toolCatalogSnapshot(for: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
        let ids = snapshot.entries.map { $0.manifest.id.rawValue }
        XCTAssertFalse(ids.contains("get_frontmost_application"))
        XCTAssertEqual(ids, ids.sorted { lhs, rhs in
            let l = snapshot.lookup(ToolID(rawValue: lhs))!.manifest
            let r = snapshot.lookup(ToolID(rawValue: rhs))!.manifest
            if l.category != r.category { return l.category.rawValue < r.category.rawValue }
            if l.displayName != r.displayName { return l.displayName < r.displayName }
            return l.id.rawValue < r.id.rawValue
        })
    }

    func testSnapshotIsImmutableAfterPolicyMutation() async throws {
        let policy = InMemoryToolPolicyStore()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink(), toolPolicy: policy)
        try await registry.register(CurrentDateTimeAgentTool())
        let agentPolicy = AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID)

        let before = await registry.toolCatalogSnapshot(for: agentPolicy)
        await policy.setEnabled(false, for: "get_current_datetime")
        let after = await registry.toolCatalogSnapshot(for: agentPolicy)

        XCTAssertTrue(before.contains("get_current_datetime"))
        XCTAssertFalse(after.contains("get_current_datetime"))
    }

    func testSchemaRejectsUnknownPropertiesAndWrongTypes() {
        let empty = CurrentDateTimeAgentTool.manifest.inputSchema
        XCTAssertFalse(ToolSchemaValidator.validate(.object(["extra": .string("x")]), against: empty).accepted)

        let calendar = TodayCalendarEventsAgentTool.manifest.inputSchema
        let result = ToolSchemaValidator.validate(.object(["include_all_day": .string("yes")]), against: calendar)
        XCTAssertFalse(result.accepted)
        XCTAssertEqual(result.issues.first?.path, "$.include_all_day")
    }

    func testSchemaIntegerAndDepthLimitsAreStrict() {
        let integer = ToolJSONSchema(type: .integer)
        XCTAssertFalse(ToolSchemaValidator.validate(.number(1.5), against: integer).accepted)

        let nested = AgentJSONValue.array([.array([.array([.array([.string("x")])])])])
        let schema = ToolJSONSchema(type: .array, items: ToolJSONSchema(type: .array, items: ToolJSONSchema(type: .array)))
        XCTAssertFalse(ToolSchemaValidator.validate(nested, against: schema, limits: ToolSchemaValidationLimits(maxDepth: 1)).accepted)
    }

    func testProviderSchemaComesFromToolCatalogSnapshot() {
        let snapshot = ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests.map {
            ToolCatalogEntry(manifest: $0, enabled: true)
        })
        let definitions = ProviderToolSchemaBuilder.definitions(from: snapshot)
        XCTAssertEqual(definitions.map(\.name), snapshot.entries.map { $0.manifest.id.rawValue })
        let time = definitions.first { $0.name == "get_current_datetime" }
        XCTAssertEqual(time?.parameters.objectValue?["additionalProperties"], .bool(false))
        let calendar = definitions.first { $0.name == "list_today_calendar_events" }
        XCTAssertNotNil(calendar?.parameters.objectValue?["properties"]?.objectValue?["include_all_day"])
    }

    func testNativeToolCallKeepsBooleanArgumentsForRuntimeValidator() throws {
        let request = try ProviderNativeToolCallAdapter.requests(from: [
            LLMToolCall(id: "c1", name: "list_today_calendar_events", argumentsJSON: #"{"include_all_day":true}"#),
        ], toolCatalog: ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: TodayCalendarEventsAgentTool.manifest, enabled: true),
        ])).first
        XCTAssertEqual(request?.arguments, .object(["include_all_day": .bool(true)]))
        XCTAssertEqual(request?.userVisibleSummary, "正在查询今日日历")
    }

    func testCurrentDateTimeUsesInjectedClockTimezoneAndLocale() async throws {
        let tool = AnyAgentTool(CurrentDateTimeAgentTool())
        let locale = Locale(identifier: "zh_Hans_CN")
        let context = ToolExecutionContext(turnID: UUID(), callID: "call",
                                           toolID: "get_current_datetime",
                                           locale: locale,
                                           timeZone: TimeZone(identifier: "Asia/Shanghai")!,
                                           clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))
        let result = try await tool.execute(arguments: .object([:]), context: context)
        XCTAssertEqual(result.status, .success)
        XCTAssertEqual(result.structuredData.stringValue("timeZoneIdentifier"), "Asia/Shanghai")
        XCTAssertEqual(result.structuredData.stringValue("localeIdentifier"), locale.identifier)
        XCTAssertNotNil(result.structuredData.stringValue("local_time"))
    }

    func testCurrentDateTimeHonorsInjectedTimeZoneAcrossLocalesAndDST() async throws {
        struct Case {
            var name: String
            var locale: Locale
            var timeZone: TimeZone
            var instant: Date
            var expectedDate: String
            var expectedOffset: String
            var forbiddenFragments: [String] = []
        }

        let iso = ISO8601DateFormatter()
        let cases = [
            Case(name: "Chinese locale with Pacific daylight time",
                 locale: Locale(identifier: "zh_CN"),
                 timeZone: TimeZone(identifier: "America/Los_Angeles")!,
                 instant: iso.date(from: "2026-07-14T05:30:00Z")!,
                 expectedDate: "2026-07-13",
                 expectedOffset: "-07:00",
                 forbiddenFragments: ["北京时间", "Asia/Shanghai", "UTC+08:00", "GMT+8"]),
            Case(name: "Pacific standard time",
                 locale: Locale(identifier: "zh_CN"),
                 timeZone: TimeZone(identifier: "America/Los_Angeles")!,
                 instant: iso.date(from: "2026-01-14T20:30:00Z")!,
                 expectedDate: "2026-01-14",
                 expectedOffset: "-08:00",
                 forbiddenFragments: ["北京时间", "Asia/Shanghai", "UTC+08:00", "GMT+8"]),
            Case(name: "Shanghai time",
                 locale: Locale(identifier: "zh_CN"),
                 timeZone: TimeZone(identifier: "Asia/Shanghai")!,
                 instant: iso.date(from: "2026-07-14T05:30:00Z")!,
                 expectedDate: "2026-07-14",
                 expectedOffset: "+08:00"),
            Case(name: "UTC",
                 locale: Locale(identifier: "en_US"),
                 timeZone: TimeZone(secondsFromGMT: 0)!,
                 instant: iso.date(from: "2026-07-14T05:30:00Z")!,
                 expectedDate: "2026-07-14",
                 expectedOffset: "+00:00"),
            Case(name: "English locale with China timezone",
                 locale: Locale(identifier: "en_US"),
                 timeZone: TimeZone(identifier: "Asia/Shanghai")!,
                 instant: iso.date(from: "2026-07-14T05:30:00Z")!,
                 expectedDate: "2026-07-14",
                 expectedOffset: "+08:00")
        ]

        let tool = AnyAgentTool(CurrentDateTimeAgentTool())
        for testCase in cases {
            let context = ToolExecutionContext(turnID: UUID(),
                                               callID: testCase.name,
                                               toolID: "get_current_datetime",
                                               locale: testCase.locale,
                                               timeZone: testCase.timeZone,
                                               clock: TestClock(start: testCase.instant))
            let result = try await tool.execute(arguments: .object([:]), context: context)
            let content = result.modelContent ?? ""

            XCTAssertEqual(result.status, .success, testCase.name)
            XCTAssertEqual(result.structuredData.stringValue("localDate"), testCase.expectedDate, testCase.name)
            XCTAssertEqual(result.structuredData.stringValue("timeZoneIdentifier"), testCase.timeZone.identifier, testCase.name)
            XCTAssertEqual(result.structuredData.stringValue("utcOffset"), testCase.expectedOffset, testCase.name)
            XCTAssertEqual(result.structuredData.stringValue("localeIdentifier"), testCase.locale.identifier, testCase.name)
            XCTAssertNotNil(result.structuredData.stringValue("weekday"), testCase.name)
            XCTAssertTrue(content.contains(testCase.expectedOffset), testCase.name)
            for forbidden in testCase.forbiddenFragments {
                XCTAssertFalse(content.contains(forbidden), "\(testCase.name) should not contain \(forbidden)")
            }
        }
    }

    func testSystemProfileReturnsOnlyAllowlistedFields() async throws {
        let tool = AnyAgentTool(SystemProfileAgentTool(provider: FakeSystemProfileProvider()))
        let result = try await tool.execute(arguments: .object([:]), context: p4Context(toolID: "get_system_profile"))
        guard case .object(let object) = result.structuredData else { return XCTFail("expected object") }
        XCTAssertNotNil(object["macOSVersion"])
        XCTAssertNil(object["username"])
        XCTAssertNil(object["homeDirectory"])
        XCTAssertNil(object["hostname"])
        XCTAssertNil(object["serialNumber"])
    }

    func testFrontmostApplicationDoesNotReturnWindowContent() async throws {
        let tool = AnyAgentTool(FrontmostApplicationAgentTool(provider: FakeFrontmostApplicationProvider()))
        let result = try await tool.execute(arguments: .object([:]), context: p4Context(toolID: "get_frontmost_application"))
        guard case .object(let object) = result.structuredData else { return XCTFail("expected object") }
        XCTAssertEqual(object["applicationName"], .string("Finder"))
        XCTAssertNil(object["windowTitle"])
        XCTAssertNil(object["url"])
        XCTAssertNil(object["filePath"])
    }

    func testCalendarToolDefaultsIncludeAllDayAndMinimizesFields() async throws {
        let provider = RecordingCalendarProvider(events: [
            CalendarEventSnapshot(title: "Standup",
                                  startDate: Date(timeIntervalSince1970: 1_700_010_000),
                                  endDate: Date(timeIntervalSince1970: 1_700_013_600),
                                  isAllDay: false,
                                  calendarDisplayName: "Work"),
        ])
        let tool = AnyAgentTool(TodayCalendarEventsAgentTool(provider: provider, maxEvents: 50))
        let result = try await tool.execute(arguments: .object([:]), context: p4Context(toolID: "list_today_calendar_events"))
        let includeAllDay = await provider.lastIncludeAllDay
        XCTAssertEqual(includeAllDay, true)
        guard case .object(let object) = result.structuredData,
              case .array(let events)? = object["events"],
              case .object(let first)? = events.first else {
            return XCTFail("expected event")
        }
        XCTAssertNotNil(first["title"])
        XCTAssertNil(first["notes"])
        XCTAssertNil(first["attendees"])
        XCTAssertNil(first["meetingURL"])
        XCTAssertNil(first["location"])
        XCTAssertNil(first["eventIdentifier"])
    }

    func testCalendarSystemPermissionMissingDoesNotAccessProvider() async throws {
        let calendar = RecordingCalendarProvider(events: [])
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(TodayCalendarEventsAgentTool(provider: calendar))
        let provider = P4AScriptedLoopProvider([
            .toolCall(AgentToolCallRequest(callID: "c1",
                                           toolName: "list_today_calendar_events",
                                           arguments: .object([:]),
                                           userVisibleSummary: "model summary")),
            .finalResponse(AgentFinalResponse(text: "done")),
        ])
        let controller = AgentLoopController(provider: provider,
                                             gate: P5AllowAppGate(),
                                             executor: P5FakeExecutor(),
                                             toolCatalogProvider: registry,
                                             toolPlatformExecutor: registry,
                                             systemAuthorization: P4ASystemAuthorization(status: .notDetermined),
                                             policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))
        let result = await controller.run(agentContext: AgentContext(userText: "calendar"), taskID: UUID())
        XCTAssertEqual(result.toolStatuses, [.denied])
        let accessed = await calendar.accessCount
        XCTAssertEqual(accessed, 0)
    }

    @MainActor
    func testReleaseRegistryFromCompositionRootContainsReleaseFormalToolsAndDoesNotQueryCalendarPermission() async {
        let system = RecordingSystemAuthorization(statuses: ["calendar.events.read": .notDetermined])
        let container = await AgentRuntimeContainer(
            tier: .developerID,
            context: P5FakeContext(),
            model: P5RespondModel(),
            conversation: P5FakeConversation(),
            executor: P5FakeExecutor(),
            ledger: NoopAgentTaskLedgerStore(),
            presentationDriver: RecordingPresentationDriver(),
            systemAuthorization: system)

        await container.bootstrap()

        let identifiers = await container.toolRegistry.identifiers()
        let toolCount = await container.toolRegistry.count()
        let legacyLookup = await container.toolRegistry.lookup("get_current_datetime")
        XCTAssertEqual(identifiers, [
            "approximate_location",
            "get_current_datetime",
            "get_frontmost_application",
            "get_system_profile",
            "list_today_calendar_events",
            "local_place_search",
            "route_distance_estimate",
            "structured_place_extraction",
        ])
        XCTAssertEqual(toolCount, 8)
        XCTAssertNil(legacyLookup)
        XCTAssertFalse(identifiers.contains("echo"))
        XCTAssertFalse(identifiers.contains("runtime.status"))
        XCTAssertEqual(system.statusCallCount(), 0)
    }

    func testLegacyRuntimeToolCannotCreateSecondReleaseRegistration() async throws {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(CurrentDateTimeAgentTool())

        do {
            try await registry.register(CurrentDateTimeTool())
            XCTFail("legacy RuntimeTool with release AgentTool id must be rejected")
        } catch RuntimeToolError.duplicateIdentifier(let id) {
            XCTAssertEqual(id, "get_current_datetime")
        }

        let count = await registry.count()
        let identifiers = await registry.identifiers()
        XCTAssertEqual(count, 1)
        XCTAssertEqual(identifiers, ["get_current_datetime"])
    }

    func testTurnSnapshotAllowsCurrentTurnAfterPolicyChangesAndRemovesToolNextTurn() async throws {
        let policy = InMemoryToolPolicyStore()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink(), toolPolicy: policy)
        try await registry.register(CurrentDateTimeAgentTool())
        let provider = SnapshotMutatingLoopProvider(policy: policy, disabledToolID: "get_current_datetime")
        let controller = AgentLoopController(provider: provider,
                                             gate: P5AllowAppGate(),
                                             executor: P5FakeExecutor(),
                                             toolCatalogProvider: registry,
                                             toolPlatformExecutor: registry,
                                             systemAuthorization: RecordingSystemAuthorization(),
                                             policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                             clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))

        let result = await controller.run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let nextSnapshot = await registry.toolCatalogSnapshot(for: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))

        let capturedSnapshots = await provider.capturedSnapshots()
        XCTAssertEqual(capturedSnapshots, [["get_current_datetime"], ["get_current_datetime"]])
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime"])
        XCTAssertEqual(result.toolStatuses, [.success])
        XCTAssertFalse(nextSnapshot.contains("get_current_datetime"))
    }

    func testDisabledToolIsNotExposedOrExecutedOnNextTurn() async throws {
        let policy = InMemoryToolPolicyStore(enabled: ["get_current_datetime": false])
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink(), toolPolicy: policy)
        try await registry.register(CurrentDateTimeAgentTool())
        let provider = SnapshotRecordingLoopProvider(decisions: [
            .toolCall(AgentToolCallRequest(callID: "disabled-1",
                                           toolName: "get_current_datetime",
                                           arguments: .object([:]),
                                           userVisibleSummary: "model tried disabled")),
            .finalResponse(AgentFinalResponse(text: "done")),
        ])
        let controller = AgentLoopController(provider: provider,
                                             gate: P5AllowAppGate(),
                                             executor: P5FakeExecutor(),
                                             toolCatalogProvider: registry,
                                             toolPlatformExecutor: registry,
                                             policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID))

        let result = await controller.run(agentContext: AgentContext(userText: "time"), taskID: UUID())

        let capturedSnapshots = await provider.capturedSnapshots()
        XCTAssertEqual(capturedSnapshots.first, [])
        XCTAssertEqual(result.toolCallCount, 0)
        XCTAssertTrue(result.usedToolNames.isEmpty)
        XCTAssertEqual(result.toolStatuses, [.failed])
        XCTAssertEqual(result.observations.first?.content.stringValue("error"), "unknown tool")
    }

    func testRequiredFieldsPayloadDepthArrayAndPathValidationAreStrict() {
        let schema = ToolJSONSchema(
            type: .object,
            properties: [
                "name": ToolJSONSchema(type: .string),
                "count": ToolJSONSchema(type: .integer),
                "items": ToolJSONSchema(type: .array, items: ToolJSONSchema(
                    type: .object,
                    properties: ["enabled": ToolJSONSchema(type: .boolean)],
                    required: ["enabled"],
                    additionalProperties: false)),
            ],
            required: ["name", "count"],
            additionalProperties: false)

        let missing = ToolSchemaValidator.validate(.object(["count": .number(1)]), against: schema)
        XCTAssertFalse(missing.accepted)
        XCTAssertEqual(missing.issues.first?.path, "$.name")

        let wrongType = ToolSchemaValidator.validate(.object(["name": .string("n"), "count": .string("1")]), against: schema)
        XCTAssertFalse(wrongType.accepted)
        XCTAssertEqual(wrongType.issues.first?.path, "$.count")

        let fractionalInteger = ToolSchemaValidator.validate(.object(["name": .string("n"), "count": .number(1.5)]), against: schema)
        XCTAssertFalse(fractionalInteger.accepted)
        XCTAssertEqual(fractionalInteger.issues.first?.path, "$.count")

        let unknown = ToolSchemaValidator.validate(.object(["name": .string("n"), "count": .number(1), "extra": .bool(true)]), against: schema)
        XCTAssertFalse(unknown.accepted)
        XCTAssertEqual(unknown.issues.first?.path, "$.extra")

        let nestedPath = ToolSchemaValidator.validate(.object([
            "name": .string("n"),
            "count": .number(1),
            "items": .array([.object([:])]),
        ]), against: schema)
        XCTAssertFalse(nestedPath.accepted)
        XCTAssertEqual(nestedPath.issues.first?.path, "$.items[0].enabled")

        let oversized = ToolSchemaValidator.validate(.string(String(repeating: "x", count: 16_385)),
                                                     against: ToolJSONSchema(type: .string))
        XCTAssertFalse(oversized.accepted)
        XCTAssertEqual(oversized.issues.first?.path, "$")

        let tooDeep = ToolSchemaValidator.validate(P4AToolPlatformTests.nestedArray(depth: 13),
                                                   against: P4AToolPlatformTests.nestedArraySchema(depth: 13))
        XCTAssertFalse(tooDeep.accepted)
        XCTAssertTrue(tooDeep.issues.contains { $0.message.contains("depth") })

        let tooManyItems = ToolSchemaValidator.validate(.array(Array(repeating: .number(1), count: 65)),
                                                        against: ToolJSONSchema(type: .array, items: ToolJSONSchema(type: .integer)))
        XCTAssertFalse(tooManyItems.accepted)
        XCTAssertEqual(tooManyItems.issues.first?.path, "$")
    }

    func testProviderExportedSchemaMatchesRuntimeValidatorConstraints() {
        let snapshot = ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests.map {
            ToolCatalogEntry(manifest: $0, enabled: true)
        })
        let definitions = ProviderToolSchemaBuilder.definitions(from: snapshot)
        let timeDefinition = definitions.first { $0.name == "get_current_datetime" }
        let calendarDefinition = definitions.first { $0.name == "list_today_calendar_events" }

        XCTAssertEqual(timeDefinition?.parameters.objectValue?["additionalProperties"], .bool(false))
        XCTAssertFalse(ToolSchemaValidator.validate(.object(["extra": .string("x")]),
                                                    against: CurrentDateTimeAgentTool.manifest.inputSchema).accepted)
        XCTAssertEqual(calendarDefinition?.parameters.objectValue?["properties"]?.objectValue?["include_all_day"]?.objectValue?["type"],
                       .string("boolean"))
        XCTAssertFalse(ToolSchemaValidator.validate(.object(["include_all_day": .string("yes")]),
                                                    against: TodayCalendarEventsAgentTool.manifest.inputSchema).accepted)
        XCTAssertTrue(ToolSchemaValidator.validate(.object(["include_all_day": .bool(false)]),
                                                   against: TodayCalendarEventsAgentTool.manifest.inputSchema).accepted)
    }

    func testUnknownInvalidDeniedAndSystemMissingToolCallsDoNotExecuteProviders() async throws {
        let calendar = RecordingCalendarProvider(events: [])
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(TodayCalendarEventsAgentTool(provider: calendar))

        let unknown = await p4RunToolLoop(registry: registry,
                                          request: AgentToolCallRequest(callID: "unknown",
                                                                        toolName: "missing.tool",
                                                                        arguments: .object([:]),
                                                                        userVisibleSummary: "missing"),
                                          systemStatus: .granted)
        XCTAssertEqual(unknown.result.toolCallCount, 0)
        XCTAssertEqual(unknown.result.toolStatuses, [.failed])
        let unknownAccessCount = await calendar.accessCount
        XCTAssertEqual(unknownAccessCount, 0)

        let invalid = await p4RunToolLoop(registry: registry,
                                          request: AgentToolCallRequest(callID: "invalid",
                                                                        toolName: "list_today_calendar_events",
                                                                        arguments: .object(["include_all_day": .string("yes")]),
                                                                        userVisibleSummary: "invalid"),
                                          systemStatus: .granted)
        XCTAssertEqual(invalid.result.toolCallCount, 0)
        XCTAssertEqual(invalid.result.toolStatuses, [.failed])
        XCTAssertEqual(invalid.result.observations.first?.content.stringValue("error"), "schema validation failed")
        let invalidAccessCount = await calendar.accessCount
        XCTAssertEqual(invalidAccessCount, 0)

        let denied = await p4RunToolLoop(registry: registry,
                                         request: AgentToolCallRequest(callID: "denied",
                                                                       toolName: "list_today_calendar_events",
                                                                       arguments: .object([:]),
                                                                       userVisibleSummary: "denied"),
                                         gate: P5DenyAppGate(),
                                         systemStatus: .granted)
        XCTAssertEqual(denied.result.toolCallCount, 0)
        XCTAssertEqual(denied.result.toolStatuses, [.denied])
        let deniedAccessCount = await calendar.accessCount
        XCTAssertEqual(deniedAccessCount, 0)

        let systemMissing = await p4RunToolLoop(registry: registry,
                                                request: AgentToolCallRequest(callID: "system",
                                                                              toolName: "list_today_calendar_events",
                                                                              arguments: .object([:]),
                                                                              userVisibleSummary: "system"),
                                                systemStatus: .notDetermined)
        XCTAssertEqual(systemMissing.result.toolCallCount, 0)
        XCTAssertEqual(systemMissing.result.toolStatuses, [.denied])
        XCTAssertEqual(systemMissing.result.observations.first?.content.stringValue("status"), "notDetermined")
        let systemMissingAccessCount = await calendar.accessCount
        XCTAssertEqual(systemMissingAccessCount, 0)
    }

    func testCancellationPropagatesToAgentTool() async throws {
        let probe = CancellationProbe()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(CancellableAgentTool(probe: probe))
        let request = AgentToolCallRequest(callID: "cancel",
                                           toolName: CancellableAgentTool.manifest.id.rawValue,
                                           arguments: .object([:]),
                                           userVisibleSummary: "cancel")
        let task = Task {
            await registry.executeTool(request: request, context: p4Context(toolID: CancellableAgentTool.manifest.id))
        }
        await yieldUntil { await probe.didStart() }

        task.cancel()
        let result = await task.value

        guard case .failure(.cancelled) = result else { return XCTFail("expected cancellation") }
        let didCancel = await probe.didCancel()
        XCTAssertTrue(didCancel)
    }

    func testTimeoutCancelsAgentToolAndLateResultDoesNotReachObservationOrLogger() async throws {
        let probe = LateResultProbe()
        let logger = RecordingSafeToolLogger()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(LateTimeoutAgentTool(probe: probe))
        let request = AgentToolCallRequest(callID: "timeout",
                                           toolName: LateTimeoutAgentTool.manifest.id.rawValue,
                                           arguments: .object([:]),
                                           userVisibleSummary: "timeout")
        let context = ToolExecutionContext(turnID: UUID(),
                                           callID: "timeout",
                                           toolID: LateTimeoutAgentTool.manifest.id,
                                           clock: TestClock(),
                                           logger: logger)

        let result = await registry.executeTool(request: request, context: context)

        guard case .failure(.timedOut) = result else { return XCTFail("expected timedOut") }
        let didReceiveCancellation = await probe.didReceiveCancellation()
        let timeoutLogEntries = await logger.entries()
        XCTAssertTrue(didReceiveCancellation)
        XCTAssertEqual(timeoutLogEntries.count, 0)
    }

    func testResultSizeLimitTruncatesStructuredDataAndSetsLoggerMetadata() async throws {
        let logger = RecordingSafeToolLogger()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(LargeResultAgentTool())
        let request = AgentToolCallRequest(callID: "large",
                                           toolName: LargeResultAgentTool.manifest.id.rawValue,
                                           arguments: .object([:]),
                                           userVisibleSummary: "large")
        let context = ToolExecutionContext(turnID: UUID(),
                                           callID: "large",
                                           toolID: LargeResultAgentTool.manifest.id,
                                           logger: logger)

        let result = await registry.executeTool(request: request, context: context)

        guard case .success(let value) = result else { return XCTFail("expected success") }
        XCTAssertEqual(value.metadata.truncated, true)
        XCTAssertEqual(value.structuredData.stringValue("status"), "success")
        XCTAssertEqual(value.structuredData.boolValue("truncated"), true)
        let logEntries = await logger.entries()
        XCTAssertEqual(logEntries.first?.metadata.truncated, true)
    }

    func testNativeAndJSONFallbackToolCallingCompleteWithoutRawToolResultInFinalAnswer() async throws {
        let snapshot = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: CurrentDateTimeAgentTool.manifest, enabled: true),
        ])
        let nativeClient = ScriptedLLMClient(capability: .native, responses: [
            LLMChatResponse(message: LLMChatMessage(role: .assistant, content: ""),
                            modelID: "native",
                            toolCalls: [LLMToolCall(id: "native-1",
                                                    name: "get_current_datetime",
                                                    argumentsJSON: "{}")]),
            LLMChatResponse(message: LLMChatMessage(role: .assistant, content: "当前本地时间：固定值"),
                            modelID: "native"),
        ])
        let nativeProvider = LLMProviderAgentLoopDecisionProvider(client: nativeClient, modelID: "native")
        let native = await p4RunToolLoop(provider: nativeProvider, snapshot: snapshot)

        XCTAssertEqual(native.result.usedToolNames, ["get_current_datetime"])
        XCTAssertEqual(native.result.finalResponse?.text, "当前本地时间：固定值")
        XCTAssertFalse(native.result.finalResponse?.text.contains("structuredData") == true)
        XCTAssertEqual(nativeClient.requests().first?.tools.map(\.name), ["get_current_datetime"])
        XCTAssertEqual(nativeClient.requests().last?.tools, [])

        let fallbackClient = ScriptedLLMClient(capability: .structuredJSONFallback, responses: [
            LLMChatResponse(message: LLMChatMessage(role: .assistant,
                                                    content: #"{"type":"tool_call","call_id":"json-1","tool":"get_current_datetime","arguments":{},"user_visible_summary":"time"}"#),
                            modelID: "json"),
            LLMChatResponse(message: LLMChatMessage(role: .assistant,
                                                    content: #"{"type":"final","text":"当前本地时间：固定值"}"#),
                            modelID: "json"),
        ])
        let fallbackProvider = LLMProviderAgentLoopDecisionProvider(client: fallbackClient, modelID: "json")
        let fallback = await p4RunToolLoop(provider: fallbackProvider, snapshot: snapshot)
        let firstFallbackMessages = fallbackClient.requests().first?.messages.map(\.content).joined(separator: "\n") ?? ""

        XCTAssertEqual(fallback.result.usedToolNames, ["get_current_datetime"])
        XCTAssertEqual(fallback.result.finalResponse?.text, "当前本地时间：固定值")
        XCTAssertTrue(firstFallbackMessages.contains("Available tools for this turn"))
        XCTAssertTrue(firstFallbackMessages.contains("get_current_datetime"))
        XCTAssertFalse(fallback.result.finalResponse?.text.contains("call_id") == true)
    }

    func testUnsupportedProviderDoesNotExposeTools() async {
        let client = ScriptedLLMClient(capability: .unsupported, responses: [
            LLMChatResponse(message: LLMChatMessage(role: .assistant, content: "普通回答"), modelID: "plain"),
        ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "plain")
        let snapshot = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: CurrentDateTimeAgentTool.manifest, enabled: true),
        ])

        let run = await p4RunToolLoop(provider: provider, snapshot: snapshot)

        XCTAssertEqual(run.result.finalResponse?.text, "普通回答")
        XCTAssertTrue(run.result.usedToolNames.isEmpty)
        XCTAssertEqual(client.requests().first?.tools, [])
    }

    func testSystemProfileSerializedOutputExcludesPrivateIdentifiersAndUsesInjectedVersion() async throws {
        let tool = AnyAgentTool(SystemProfileAgentTool(provider: FakeSystemProfileProvider()))
        let result = try await tool.execute(arguments: .object([:]), context: p4Context(toolID: "get_system_profile"))
        let payload = result.structuredData.jsonString

        XCTAssertEqual(result.structuredData.stringValue("deskPetAppVersion"), "1.2.3")
        XCTAssertEqual(result.structuredData.stringValue("deskPetBuildVersion"), "456")
        XCTAssertTrue(payload.contains("macOSVersion"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("username"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("homeDirectory"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("hostname"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("serial"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("hardwareUUID"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("ipAddress"))
        XCTAssertFalse(payload.localizedCaseInsensitiveContains("environment"))
    }

    func testFrontmostApplicationUnavailableAndNoScreenOrAccessibilityPermissionSurface() async throws {
        let provider = RecordingFrontmostApplicationProvider(snapshot: FrontmostApplicationSnapshot(
            applicationName: nil,
            bundleIdentifier: nil,
            isDeskPet: false,
            observedAt: Date(timeIntervalSince1970: 1_700_000_000)))
        let tool = AnyAgentTool(FrontmostApplicationAgentTool(provider: provider))
        let result = try await tool.execute(arguments: .object([:]), context: p4Context(toolID: "get_frontmost_application"))

        let accessCount = await provider.accessCount()
        XCTAssertEqual(accessCount, 1)
        XCTAssertEqual(result.structuredData.stringValue("status"), "unavailable")
        XCTAssertNil(result.structuredData.stringValue("windowTitle"))
        XCTAssertNil(result.structuredData.stringValue("url"))
        XCTAssertNil(result.structuredData.stringValue("filePath"))
        XCTAssertNil(FrontmostApplicationAgentTool.manifest.permissionRequirement.systemPermission)
        XCTAssertEqual(FrontmostApplicationAgentTool.manifest.permissionRequirement.capabilityID, "get_frontmost_application")
    }

    func testCalendarProviderCalledOnlyWhenAppAndSystemPermissionsAllow() async throws {
        let calendar = RecordingCalendarProvider(events: [])
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(TodayCalendarEventsAgentTool(provider: calendar))

        let run = await p4RunToolLoop(registry: registry,
                                      request: AgentToolCallRequest(callID: "calendar-allow",
                                                                    toolName: "list_today_calendar_events",
                                                                    arguments: .object([:]),
                                                                    userVisibleSummary: "calendar"),
                                      systemStatus: .granted)

        XCTAssertEqual(run.result.toolStatuses, [.success])
        let accessCount = await calendar.accessCount
        let includeAllDay = await calendar.lastIncludeAllDay
        let limit = await calendar.lastLimit
        XCTAssertEqual(accessCount, 1)
        XCTAssertEqual(includeAllDay, true)
        XCTAssertEqual(limit, 50)
    }

    func testCalendarPermissionDeniedAndNotDeterminedDoNotCallProvider() async throws {
        let deniedCalendar = RecordingCalendarProvider(events: [])
        let deniedRegistry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await deniedRegistry.register(TodayCalendarEventsAgentTool(provider: deniedCalendar))
        let denied = await p4RunToolLoop(registry: deniedRegistry,
                                         request: AgentToolCallRequest(callID: "calendar-denied",
                                                                       toolName: "list_today_calendar_events",
                                                                       arguments: .object([:]),
                                                                       userVisibleSummary: "calendar"),
                                         systemStatus: .denied)

        XCTAssertEqual(denied.result.toolStatuses, [.denied])
        XCTAssertEqual(denied.result.observations.first?.content.stringValue("status"), "denied")
        let deniedAccessCount = await deniedCalendar.accessCount
        XCTAssertEqual(deniedAccessCount, 0)

        let undecidedCalendar = RecordingCalendarProvider(events: [])
        let undecidedRegistry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await undecidedRegistry.register(TodayCalendarEventsAgentTool(provider: undecidedCalendar))
        let notDetermined = await p4RunToolLoop(registry: undecidedRegistry,
                                                request: AgentToolCallRequest(callID: "calendar-undecided",
                                                                              toolName: "list_today_calendar_events",
                                                                              arguments: .object([:]),
                                                                              userVisibleSummary: "calendar"),
                                                systemStatus: .notDetermined)

        XCTAssertEqual(notDetermined.result.toolStatuses, [.denied])
        XCTAssertEqual(notDetermined.result.observations.first?.content.stringValue("status"), "notDetermined")
        let undecidedAccessCount = await undecidedCalendar.accessCount
        XCTAssertEqual(undecidedAccessCount, 0)
    }

    func testCalendarEmptyResultReturnsSuccessWithEmptyArray() async throws {
        let provider = RecordingCalendarProvider(events: [])
        let tool = AnyAgentTool(TodayCalendarEventsAgentTool(provider: provider))
        let result = try await tool.execute(arguments: .object([:]), context: p4Context(toolID: "list_today_calendar_events"))

        XCTAssertEqual(result.status, .success)
        XCTAssertEqual(result.userSafeSummary, "今天没有日历事件")
        XCTAssertEqual(result.structuredData.numberValue("itemCount"), 0)
        XCTAssertEqual(result.structuredData.arrayValue("events")?.count, 0)
    }

    func testCalendarAllDayCrossMidnightAndDSTBoundariesUseInjectedCalendar() async throws {
        var shanghai = Calendar(identifier: .gregorian)
        shanghai.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let targetDay = shanghai.date(from: DateComponents(year: 2026, month: 7, day: 12, hour: 10))!
        let crossMidnight = CalendarEventSnapshot(
            title: "Cross Midnight",
            startDate: shanghai.date(from: DateComponents(year: 2026, month: 7, day: 11, hour: 23, minute: 30))!,
            endDate: shanghai.date(from: DateComponents(year: 2026, month: 7, day: 12, hour: 1))!,
            isAllDay: false,
            calendarDisplayName: "Work")
        let previousOnly = CalendarEventSnapshot(
            title: "Previous Only",
            startDate: shanghai.date(from: DateComponents(year: 2026, month: 7, day: 11, hour: 20))!,
            endDate: shanghai.date(from: DateComponents(year: 2026, month: 7, day: 11, hour: 21))!,
            isAllDay: false,
            calendarDisplayName: "Work")
        let allDay = CalendarEventSnapshot(
            title: "All Day",
            startDate: shanghai.startOfDay(for: targetDay),
            endDate: shanghai.date(byAdding: .day, value: 1, to: shanghai.startOfDay(for: targetDay))!,
            isAllDay: true,
            calendarDisplayName: "Home")
        let provider = FilteringCalendarProvider(events: [previousOnly, crossMidnight, allDay])
        let context = ToolExecutionContext(turnID: UUID(),
                                           callID: "calendar",
                                           toolID: "list_today_calendar_events",
                                           locale: Locale(identifier: "en_US_POSIX"),
                                           timeZone: shanghai.timeZone,
                                           clock: TestClock(start: targetDay))
        let result = try await AnyAgentTool(TodayCalendarEventsAgentTool(provider: provider)).execute(arguments: .object([:]), context: context)
        let eventTitles = result.structuredData.arrayValue("events")?.compactMap { $0.stringValue("title") } ?? []

        XCTAssertEqual(eventTitles, ["Cross Midnight", "All Day"])
        XCTAssertTrue(result.structuredData.arrayValue("events")?.contains { $0.boolValue("isAllDay") == true } == true)

        var newYork = Calendar(identifier: .gregorian)
        newYork.timeZone = TimeZone(identifier: "America/New_York")!
        let dstDate = newYork.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 12))!
        let dstWindow = try CalendarDayWindow(containing: dstDate, calendar: newYork)
        XCTAssertEqual(dstWindow.end.timeIntervalSince(dstWindow.start), 23 * 60 * 60)
        XCTAssertTrue(dstWindow.intersects(
            startDate: newYork.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 23, minute: 30))!,
            endDate: newYork.date(from: DateComponents(year: 2026, month: 3, day: 9, hour: 0, minute: 30))!))
        XCTAssertFalse(dstWindow.intersects(startDate: dstWindow.end, endDate: dstWindow.end.addingTimeInterval(60)))
    }

    func testCalendarEventsAreStablySortedAndTruncatedAtFifty() async throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let base = calendar.date(from: DateComponents(year: 2026, month: 7, day: 12, hour: 9))!
        let events = (0..<60).reversed().map { index in
            CalendarEventSnapshot(title: String(format: "Event %02d", index),
                                  startDate: base.addingTimeInterval(Double(index) * 60),
                                  endDate: base.addingTimeInterval(Double(index + 1) * 60),
                                  isAllDay: false,
                                  calendarDisplayName: "Work")
        }
        let provider = RecordingCalendarProvider(events: events)
        let context = ToolExecutionContext(turnID: UUID(),
                                           callID: "calendar",
                                           toolID: "list_today_calendar_events",
                                           timeZone: calendar.timeZone,
                                           clock: TestClock(start: base))

        let result = try await AnyAgentTool(TodayCalendarEventsAgentTool(provider: provider, maxEvents: 50))
            .execute(arguments: .object([:]), context: context)
        let titles = result.structuredData.arrayValue("events")?.compactMap { $0.stringValue("title") } ?? []

        XCTAssertEqual(titles.first, "Event 00")
        XCTAssertEqual(titles.last, "Event 49")
        XCTAssertEqual(titles.count, 50)
        XCTAssertEqual(result.structuredData.boolValue("truncated"), true)
        XCTAssertEqual(result.metadata.itemCount, 50)
        XCTAssertEqual(result.metadata.truncated, true)
    }

    @MainActor
    func testToolEnablementPersistsAndRollsBackOnPersistenceFailure() throws {
        let goodURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("p4a-prefs-\(UUID().uuidString).json")
        let good = PreferencesModel(fileURL: goodURL)
        good.setToolEnabled("get_current_datetime", false)
        let goodData = try Data(contentsOf: goodURL)
        let decoded = try JSONDecoder().decode(AppPreferences.self, from: goodData)
        XCTAssertEqual(decoded.toolPolicies["get_current_datetime"]?.enabled, false)
        XCTAssertEqual(good.isToolEnabled("get_current_datetime"), false)

        let directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("p4a-prefs-dir-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let failing = PreferencesModel(fileURL: directoryURL)
        failing.setToolEnabled("get_current_datetime", false)

        XCTAssertEqual(failing.isToolEnabled("get_current_datetime"), true)
        XCTAssertEqual(failing.lastPersistenceError, "设置保存失败")
    }

    @MainActor
    func testCalendarDeskPetEnablementIsIndependentFromSystemAuthorization() async throws {
        let prefsURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("p4a-calendar-prefs-\(UUID().uuidString).json")
        let prefs = PreferencesModel(fileURL: prefsURL)
        let system = InMemorySystemAuthorizationStore()

        prefs.setToolEnabled("list_today_calendar_events", false)
        await system.set(.granted, for: "calendar.events.read")

        let enabled = prefs.toolPolicies["list_today_calendar_events"]?.enabled ?? true
        let status = await system.status(for: "calendar.events.read")
        XCTAssertEqual(enabled, false)
        XCTAssertEqual(status, .granted)
        XCTAssertEqual(prefs.permissions.tools, .notRequested)
    }

    func testRemovedToolPoliciesAndFutureManifestEnumsDecodeSafely() throws {
        var basePreferences = AppPreferences()
        basePreferences.toolPolicies["removed.legacy.tool"] = ToolPolicyPreference(enabled: false)
        let preferences = try JSONDecoder().decode(AppPreferences.self,
                                                   from: JSONEncoder().encode(basePreferences))
        XCTAssertEqual(preferences.toolPolicies["removed.legacy.tool"]?.enabled, false)

        let data = try JSONEncoder().encode(CurrentDateTimeAgentTool.manifest)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object["category"] = "futureCategory"
        object["riskLevel"] = "futureRisk"
        let mutated = try JSONSerialization.data(withJSONObject: object)
        let manifest = try JSONDecoder().decode(ToolManifest.self, from: mutated)

        XCTAssertEqual(manifest.category, .unknown)
        XCTAssertEqual(manifest.riskLevel, .unknown)
    }

    func testToolArgumentsResultsReasoningAndCalendarDetailsStayOutOfLogsLedgerAndAssistantOutput() async throws {
        let secretTitle = "Secret Board Meeting"
        let secretTime = "2026-07-12T09:30"
        let event = CalendarEventSnapshot(title: secretTitle,
                                          startDate: ISO8601DateFormatter().date(from: "\(secretTime):00Z")!,
                                          endDate: ISO8601DateFormatter().date(from: "2026-07-12T10:00:00Z")!,
                                          isAllDay: false,
                                          calendarDisplayName: "Private")
        let provider = RecordingCalendarProvider(events: [event])
        let audit = InMemoryAuditSink()
        let logger = RecordingSafeToolLogger()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: audit)
        try await registry.register(TodayCalendarEventsAgentTool(provider: provider))
        try await registry.register(CurrentDateTimeAgentTool())
        let request = AgentToolCallRequest(callID: "privacy",
                                           toolName: "list_today_calendar_events",
                                           arguments: .object(["include_all_day": .bool(true)]),
                                           userVisibleSummary: "calendar")
        let directResult = await registry.executeTool(
            request: request,
            context: ToolExecutionContext(turnID: UUID(),
                                          callID: "privacy",
                                          toolID: "list_today_calendar_events",
                                          timeZone: TimeZone(secondsFromGMT: 0)!,
                                          clock: TestClock(start: event.startDate),
                                          logger: logger))
        guard case .success = directResult else { return XCTFail("expected direct tool success") }
        let encodedLogs = try String(data: JSONEncoder().encode(await logger.entries()), encoding: .utf8) ?? ""
        let encodedAudit = try String(data: JSONEncoder().encode(await audit.all()), encoding: .utf8) ?? ""

        XCTAssertFalse(encodedLogs.contains(secretTitle))
        XCTAssertFalse(encodedLogs.contains(secretTime))
        XCTAssertFalse(encodedLogs.contains("include_all_day"))
        XCTAssertFalse(encodedAudit.contains(secretTitle))
        XCTAssertFalse(encodedAudit.contains(secretTime))

        let ledger = RecordingLedger()
        let loopProvider = P4AScriptedLoopProvider([
            .finalResponse(AgentFinalResponse(text: "日历查询完成")),
        ])
        let model = P4APlanModel(toolName: "get_current_datetime", arguments: [:])
        let coordinator = PetAgentRuntimeCoordinator(
            context: P5FakeContext(),
            model: model,
            conversation: P5FakeConversation(reply: "日历查询完成"),
            gate: P5AllowAppGate(),
            executor: P5FakeExecutor(),
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            toolCatalogProvider: registry,
            toolPlatformExecutor: registry,
            systemAuthorization: RecordingSystemAuthorization(statuses: ["calendar.events.read": .granted]),
            ledger: ledger,
            loopDecisionProvider: loopProvider)
        var responseStarted = 0
        var responseCompleted = 0
        var finalText = ""
        for await output in coordinator.handle(.userMessage(UserMessageEvent(conversationID: UUID(), text: "calendar"))) {
            switch output {
            case .responseStarted:
                responseStarted += 1
            case .responseCompleted:
                responseCompleted += 1
            case .responseDelta(_, _, let text):
                finalText += text
            default:
                break
            }
        }
        let encodedLedger = try String(data: JSONEncoder().encode(await ledger.all()), encoding: .utf8) ?? ""
        let syntheticCalendarLedger = try String(data: JSONEncoder().encode([
            AgentTaskLedgerEvent(taskID: UUID(),
                                 attemptID: UUID(),
                                 conversationID: UUID(),
                                 userMessageID: UUID(),
                                 state: .succeeded,
                                 kind: .toolObserved,
                                 sequence: 0,
                                 stopReason: .completed,
                                 iterationCount: 2,
                                 toolCallCount: 1,
                                 usedToolNames: ["list_today_calendar_events"],
                                 toolStatuses: ["success"],
                                 createdAt: Date(timeIntervalSince1970: 1_700_000_000),
                                 updatedAt: Date(timeIntervalSince1970: 1_700_000_000),
                                 terminalAt: Date(timeIntervalSince1970: 1_700_000_000)),
        ]), encoding: .utf8) ?? ""

        XCTAssertEqual(responseStarted, 1)
        XCTAssertEqual(responseCompleted, 1)
        XCTAssertEqual(finalText, "日历查询完成")
        XCTAssertFalse(finalText.contains(secretTitle))
        XCTAssertFalse(finalText.contains("ToolExecutionResult"))
        XCTAssertFalse(encodedLedger.contains(secretTitle))
        XCTAssertFalse(encodedLedger.contains(secretTime))
        XCTAssertFalse(syntheticCalendarLedger.contains(secretTitle))
        XCTAssertFalse(syntheticCalendarLedger.contains(secretTime))

        let accumulator = ProviderToolCallStreamAccumulator()
        accumulator.ingest(ProviderStreamEvent(textDelta: "visible", reasoningDelta: "hidden reasoning"))
        guard case .finalText(let text) = try accumulator.finish() else {
            return XCTFail("expected final text")
        }
        XCTAssertEqual(text, "visible")
        XCTAssertFalse(text.contains("hidden reasoning"))
    }

    func testNativeProviderSchemaAndJSONFallbackInstructionUseSameSnapshot() {
        let snapshot = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: CurrentDateTimeAgentTool.manifest, enabled: true),
            ToolCatalogEntry(manifest: TodayCalendarEventsAgentTool.manifest, enabled: true),
        ])
        let native = ProviderToolSchemaBuilder.definitions(from: snapshot)
        let fallback = ProviderToolSchemaBuilder.jsonFallbackInstruction(from: snapshot)

        XCTAssertEqual(native.map(\.name), snapshot.entries.map { $0.manifest.id.rawValue })
        for entry in snapshot.entries {
            XCTAssertTrue(fallback.contains(entry.manifest.id.rawValue))
            XCTAssertTrue(fallback.contains(entry.manifest.shortDescription))
        }
        XCTAssertFalse(fallback.contains("runtime.status"))
    }

    @MainActor
    func testChatModelClearsTransientStateForSuccessFailureDeniedCancelAndTimeout() async throws {
        let success = p4ChatModel(runtime: p5Coordinator(conversation: P5FakeConversation(reply: "ok")))
        success.send("success")
        await yieldUntilMain { !success.busy }
        XCTAssertNil(success.transientStatusText)

        let failure = p4ChatModel(runtime: p5Coordinator(conversation: P4AFailingConversation()))
        failure.send("failure")
        await yieldUntilMain { !failure.busy }
        XCTAssertNil(failure.transientStatusText)
        XCTAssertTrue(failure.conversation.messages.contains { $0.status == .failed })

        let cancel = p4ChatModel(runtime: p5Coordinator(conversation: P4ANeverEndingConversation()))
        cancel.send("cancel")
        cancel.stopGenerating()
        await yieldUntilMain { !cancel.busy }
        XCTAssertNil(cancel.transientStatusText)

        let denied = try await p4ToolChatModel(tool: AnyAgentTool(CurrentDateTimeAgentTool()),
                                               gate: P5DenyAppGate())
        denied.send("denied")
        await yieldUntilMain { !denied.busy }
        XCTAssertNil(denied.transientStatusText)

        let timeout = try await p4ToolChatModel(tool: AnyAgentTool(ImmediateTimeoutDateTimeAgentTool()),
                                                gate: P5AllowAppGate())
        timeout.send("timeout")
        await yieldUntilMain { !timeout.busy }
        XCTAssertNil(timeout.transientStatusText)
    }

    private static func nestedArray(depth: Int) -> AgentJSONValue {
        guard depth > 0 else { return .string("leaf") }
        return .array([nestedArray(depth: depth - 1)])
    }

    private static func nestedArraySchema(depth: Int) -> ToolJSONSchema {
        guard depth > 0 else { return ToolJSONSchema(type: .string) }
        return ToolJSONSchema(type: .array, items: nestedArraySchema(depth: depth - 1))
    }
}

private struct FakeSystemProfileProvider: SystemProfileProviding {
    func snapshot(locale: Locale, timeZone: TimeZone) async -> SystemProfileSnapshot {
        SystemProfileSnapshot(macOSVersion: "macOS 14.0",
                              operatingSystemBuild: "23A000",
                              cpuArchitecture: "arm64",
                              logicalProcessorCount: 8,
                              physicalMemoryBytes: 16_000_000_000,
                              localeIdentifier: locale.identifier,
                              timeZoneIdentifier: timeZone.identifier,
                              appVersion: "1.2.3",
                              appBuild: "456")
    }
}

private struct FakeFrontmostApplicationProvider: FrontmostApplicationProviding {
    func frontmostApplication(observedAt: Date) async -> FrontmostApplicationSnapshot {
        FrontmostApplicationSnapshot(applicationName: "Finder",
                                     bundleIdentifier: "com.apple.finder",
                                     isDeskPet: false,
                                     observedAt: observedAt)
    }
}

private actor RecordingCalendarProvider: CalendarEventProviding {
    private let events: [CalendarEventSnapshot]
    private(set) var accessCount = 0
    private(set) var lastIncludeAllDay: Bool?
    private(set) var lastDate: Date?
    private(set) var lastCalendar: Calendar?
    private(set) var lastLimit: Int?

    init(events: [CalendarEventSnapshot]) {
        self.events = events
    }

    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage {
        accessCount += 1
        lastIncludeAllDay = includeAllDay
        lastDate = date
        lastCalendar = calendar
        lastLimit = limit
        return CalendarEventPage(events: events, truncated: events.count > limit)
    }
}

private actor FilteringCalendarProvider: CalendarEventProviding {
    private let events: [CalendarEventSnapshot]

    init(events: [CalendarEventSnapshot]) {
        self.events = events
    }

    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage {
        let window = try CalendarDayWindow(containing: date, calendar: calendar)
        let filtered = events
            .filter { includeAllDay || !$0.isAllDay }
            .filter { window.intersects(startDate: $0.startDate, endDate: $0.endDate) }
            .sorted {
                if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
                return $0.title < $1.title
            }
        return CalendarEventPage(events: Array(filtered.prefix(limit)), truncated: filtered.count > limit)
    }
}

private actor RecordingFrontmostApplicationProvider: FrontmostApplicationProviding {
    private let snapshot: FrontmostApplicationSnapshot
    private var count = 0

    init(snapshot: FrontmostApplicationSnapshot) {
        self.snapshot = snapshot
    }

    func frontmostApplication(observedAt: Date) async -> FrontmostApplicationSnapshot {
        count += 1
        return FrontmostApplicationSnapshot(applicationName: snapshot.applicationName,
                                            bundleIdentifier: snapshot.bundleIdentifier,
                                            isDeskPet: snapshot.isDeskPet,
                                            observedAt: observedAt)
    }

    func accessCount() -> Int { count }
}

private final class RecordingSystemAuthorization: SystemAuthorizationProviding, @unchecked Sendable {
    private let statuses: [String: SystemAuthorizationStatus]
    private let gated: Set<String>
    nonisolated(unsafe) private var statusCount = 0

    init(statuses: [String: SystemAuthorizationStatus] = [:],
         gated: Set<String> = ["calendar.events.read"]) {
        self.statuses = statuses
        self.gated = gated
    }

    func requiresSystemAuthorization(_ capabilityID: String) -> Bool {
        gated.contains(capabilityID)
    }

    func status(for capabilityID: String) async -> SystemAuthorizationStatus {
        statusCount += 1
        return statuses[capabilityID] ?? (gated.contains(capabilityID) ? .notDetermined : .notRequired)
    }

    func statusCallCount() -> Int {
        statusCount
    }
}

private actor SnapshotMutatingLoopProvider: AgentLoopDecisionProviding {
    private let policy: InMemoryToolPolicyStore
    private let disabledToolID: ToolID
    private var snapshots: [[String]] = []

    init(policy: InMemoryToolPolicyStore, disabledToolID: ToolID) {
        self.policy = policy
        self.disabledToolID = disabledToolID
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        snapshots.append(availableCapabilities.toolCatalog.entries.map { $0.manifest.id.rawValue })
        if context.iteration == 0 {
            await policy.setEnabled(false, for: disabledToolID)
            return AgentLoopDecisionResult(decision: .toolCall(AgentToolCallRequest(
                callID: "snapshot-1",
                toolName: disabledToolID.rawValue,
                arguments: .object([:]),
                userVisibleSummary: "snapshot")),
                                       decisionSource: .modelStructured,
                                       modelProvider: "p4a-snapshot")
        }
        return AgentLoopDecisionResult(decision: .finalResponse(AgentFinalResponse(text: "done")),
                                       decisionSource: .modelStructured,
                                       modelProvider: "p4a-snapshot")
    }

    func capturedSnapshots() -> [[String]] { snapshots }
}

private actor SnapshotRecordingLoopProvider: AgentLoopDecisionProviding {
    private let decisions: [AgentLoopDecision]
    private var snapshots: [[String]] = []

    init(decisions: [AgentLoopDecision]) {
        self.decisions = decisions
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        snapshots.append(availableCapabilities.toolCatalog.entries.map { $0.manifest.id.rawValue })
        let index = min(context.iteration, max(0, decisions.count - 1))
        return AgentLoopDecisionResult(decision: decisions[index],
                                       decisionSource: .modelStructured,
                                       modelProvider: "p4a-snapshot")
    }

    func capturedSnapshots() -> [[String]] { snapshots }
}

private struct P4ASystemAuthorization: SystemAuthorizationProviding {
    var status: SystemAuthorizationStatus

    func requiresSystemAuthorization(_ capabilityID: String) -> Bool {
        capabilityID == "calendar.events.read"
    }

    func status(for capabilityID: String) async -> SystemAuthorizationStatus {
        status
    }
}

private struct P4AScriptedLoopProvider: AgentLoopDecisionProviding {
    private var decisions: [AgentLoopDecision]

    init(_ decisions: [AgentLoopDecision]) {
        self.decisions = decisions
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        let index = min(context.iteration, max(0, decisions.count - 1))
        return AgentLoopDecisionResult(decision: decisions[index],
                                       decisionSource: .modelStructured,
                                       modelProvider: "p4a-test")
    }
}

private struct P4APlanModel: StructuredDecisionProviding {
    var toolName: String
    var arguments: [String: String]

    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        StructuredDecisionResult(decision: .proposePlan(AgentPlanProposal(
            goal: context.userText ?? "tool",
            steps: [AgentPlanProposalStep(id: "p4a-step",
                                          description: "run tool",
                                          capabilityID: toolName,
                                          arguments: arguments)])),
                                 decisionSource: .modelStructured,
                                 modelProvider: "p4a-plan")
    }
}

private enum P4ATestConversationError: Error {
    case failed
}

private struct P4AFailingConversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: P4ATestConversationError.failed)
        }
    }
}

private struct P4ANeverEndingConversation: ConversationGenerating {
    var streamingCapability: ConversationProviderStreamingCapability { .trueStreaming }

    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.metadata(.trueStreaming))
        }
    }
}

private struct ImmediateTimeoutDateTimeAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = ToolManifest(
        id: "get_current_datetime",
        displayName: "Timeout Date Time",
        shortDescription: "Test-only timeout status for current time.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .capability("get_current_datetime"),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "timeout"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 512),
        userVisibleExecutionSummary: "Testing timeout status")

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .timedOut,
                            userSafeSummary: "工具执行超时",
                            structuredData: .object(["status": .string("timedOut")]),
                            modelContent: "工具执行超时")
    }
}

@MainActor
private func p4ChatModel(runtime: PetAgentRuntimeCoordinator) -> ChatModel {
    let memoryURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("p4a-memory-\(UUID().uuidString).json")
    let memory = MemoryModel(store: MemoryStore(fileURL: memoryURL))
    let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing-deskpet-llm")),
                              repository: JSONMemoryRepository(memory))
    let store = ChatStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("p4a-chat-\(UUID().uuidString).json"))
    return ChatModel(runtime: runtime,
                     services: services,
                     store: store,
                     activityStore: AgentTaskActivityStore(persistence: nil))
}

@MainActor
private func p4ToolChatModel(tool: AnyAgentTool,
                             gate: any CapabilityGate) async throws -> ChatModel {
    let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
    try await registry.registerAgentTool(tool)
    let runtime = PetAgentRuntimeCoordinator(
        context: P5FakeContext(),
        model: P4APlanModel(toolName: "get_current_datetime", arguments: [:]),
        conversation: P5FakeConversation(reply: "done"),
        gate: gate,
        executor: P5FakeExecutor(),
        policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
        toolCatalogProvider: registry,
        toolPlatformExecutor: registry,
        systemAuthorization: RecordingSystemAuthorization())
    return p4ChatModel(runtime: runtime)
}

private struct StaticToolCatalogProvider: ToolCatalogProviding {
    var snapshot: ToolCatalogSnapshot

    func toolCatalogSnapshot(for policy: AgentPolicy) async -> ToolCatalogSnapshot {
        snapshot
    }
}

private struct RegistryToolRun {
    var result: AgentLoopRunResult
}

private func p4RunToolLoop(registry: ToolRegistry,
                           request: AgentToolCallRequest,
                           gate: any CapabilityGate = P5AllowAppGate(),
                           systemStatus: SystemAuthorizationStatus) async -> RegistryToolRun {
    let provider = P4AScriptedLoopProvider([
        .toolCall(request),
        .finalResponse(AgentFinalResponse(text: "done")),
    ])
    let controller = AgentLoopController(provider: provider,
                                         gate: gate,
                                         executor: P5FakeExecutor(),
                                         toolCatalogProvider: registry,
                                         toolPlatformExecutor: registry,
                                         systemAuthorization: RecordingSystemAuthorization(statuses: [
                                            "calendar.events.read": systemStatus,
                                         ]),
                                         policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                         clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))
    return RegistryToolRun(result: await controller.run(agentContext: AgentContext(userText: "tool"), taskID: UUID()))
}

private func p4RunToolLoop(provider: any AgentLoopDecisionProviding,
                           snapshot: ToolCatalogSnapshot) async -> RegistryToolRun {
    let registry = ToolRegistry(gate: P5AllowPermissionGate(),
                                audit: InMemoryAuditSink(),
                                clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))
    for tool in ToolPlatformAssembly.releaseTools where snapshot.contains(tool.manifest.id.rawValue) {
        try? await registry.registerAgentTool(tool)
    }
    let controller = AgentLoopController(provider: provider,
                                         gate: P5AllowAppGate(),
                                         executor: P5FakeExecutor(),
                                         toolCatalogProvider: StaticToolCatalogProvider(snapshot: snapshot),
                                         toolPlatformExecutor: registry,
                                         systemAuthorization: RecordingSystemAuthorization(statuses: [
                                            "calendar.events.read": .granted,
                                         ]),
                                         policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                         clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))
    return RegistryToolRun(result: await controller.run(agentContext: AgentContext(userText: "tool"), taskID: UUID()))
}

private actor CancellationProbe {
    private var started = false
    private var cancelled = false
    private var continuation: CheckedContinuation<ToolExecutionResult, Error>?

    func wait() async throws -> ToolExecutionResult {
        started = true
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
            }
        } onCancel: {
            Task { await self.cancel() }
        }
    }

    func cancel() {
        cancelled = true
        continuation?.resume(throwing: CancellationError())
        continuation = nil
    }

    func didStart() -> Bool { started }
    func didCancel() -> Bool { cancelled }
}

private struct CancellableAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = ToolManifest(
        id: "test.cancellable",
        displayName: "Cancellable",
        shortDescription: "Test-only cancellable tool.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .none,
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "test"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 5, maxResultBytes: 512),
        userVisibleExecutionSummary: "Testing cancellation")
    let probe: CancellationProbe

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try await probe.wait()
    }
}

private actor LateResultProbe {
    private var cancelled = false
    private var continuation: CheckedContinuation<ToolExecutionResult, Error>?

    func waitForLateResult() async throws -> ToolExecutionResult {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
            }
        } onCancel: {
            Task { await self.markCancelled() }
        }
    }

    func markCancelled() {
        cancelled = true
        continuation?.resume(throwing: CancellationError())
        continuation = nil
    }

    func didReceiveCancellation() -> Bool { cancelled }
}

private struct LateTimeoutAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = ToolManifest(
        id: "test.timeout",
        displayName: "Timeout",
        shortDescription: "Test-only timeout tool.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .none,
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "test"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 0.1, maxResultBytes: 512),
        userVisibleExecutionSummary: "Testing timeout")
    let probe: LateResultProbe

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        try await probe.waitForLateResult()
    }
}

private struct LargeResultAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = ToolManifest(
        id: "test.large_result",
        displayName: "Large Result",
        shortDescription: "Test-only large result tool.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .none,
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "test"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 512),
        userVisibleExecutionSummary: "Testing large result")

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let values = Dictionary(uniqueKeysWithValues: (0..<200).map { index in
            ("field_\(index)", AgentJSONValue.number(Double(index)))
        })
        return ToolExecutionResult(status: .success,
                                   userSafeSummary: "large",
                                   structuredData: .object(values))
    }
}

private struct SafeToolLogEntry: Codable, Equatable {
    var toolID: String
    var status: ToolExecutionStatus
    var metadata: ToolExecutionMetadata
}

private actor RecordingSafeToolLogger: SafeToolLogger {
    private var values: [SafeToolLogEntry] = []

    func record(toolID: ToolID, status: ToolExecutionStatus, metadata: ToolExecutionMetadata) async {
        values.append(SafeToolLogEntry(toolID: toolID.rawValue, status: status, metadata: metadata))
    }

    func entries() -> [SafeToolLogEntry] { values }
}

private actor RecordingLedger: AgentTaskLedgerPersisting {
    private var values: [AgentTaskLedgerEvent] = []

    func append(_ event: AgentTaskLedgerEvent) async throws {
        values.append(event)
    }

    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] {
        values.filter { $0.taskID == taskID }
    }

    func activeTasks() async throws -> [AgentTaskSnapshot] { [] }

    func hasOperationID(_ operationID: String) async throws -> Bool {
        values.contains { $0.operationID == operationID }
    }

    func all() -> [AgentTaskLedgerEvent] { values }
}

private final class ScriptedLLMClient: LLMClient, @unchecked Sendable {
    let capabilities: Set<ModelCapability>
    let toolCallingCapability: ProviderToolCallingCapability
    nonisolated(unsafe) private var remaining: [LLMChatResponse]
    nonisolated(unsafe) private var captured: [LLMChatRequest] = []

    init(capability: ProviderToolCallingCapability, responses: [LLMChatResponse]) {
        self.capabilities = capability == .native ? [.chat, .toolCalling] : [.chat]
        self.toolCallingCapability = capability
        self.remaining = responses
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        captured.append(request)
        let response = remaining.isEmpty
            ? LLMChatResponse(message: LLMChatMessage(role: .assistant, content: ""), modelID: request.modelID)
            : remaining.removeFirst()
        return response
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func listModels() async throws -> [ModelDescriptor] { [] }

    func testConnection() async -> ProviderConnectionStatus { .connected }

    func requests() -> [LLMChatRequest] {
        captured
    }
}

private func p4Context(toolID: ToolID) -> ToolExecutionContext {
    ToolExecutionContext(turnID: UUID(),
                         callID: "call",
                         toolID: toolID,
                         locale: Locale(identifier: "en_US_POSIX"),
                         timeZone: TimeZone(secondsFromGMT: 0)!,
                         clock: TestClock(start: Date(timeIntervalSince1970: 1_700_000_000)))
}

private func yieldUntil(_ predicate: @escaping () async -> Bool,
                        attempts: Int = 1_000,
                        file: StaticString = #filePath,
                        line: UInt = #line) async {
    for _ in 0..<attempts {
        if await predicate() { return }
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
    XCTFail("Timed out waiting for async predicate", file: file, line: line)
}

@MainActor
private func yieldUntilMain(_ predicate: @MainActor @escaping () -> Bool,
                            attempts: Int = 1_000,
                            file: StaticString = #filePath,
                            line: UInt = #line) async {
    for _ in 0..<attempts {
        if predicate() { return }
        await Task.yield()
    }
    XCTFail("Timed out waiting for main-actor predicate", file: file, line: line)
}

private extension LLMJSONValue {
    var objectValue: [String: LLMJSONValue]? {
        guard case .object(let object) = storage else { return nil }
        return object
    }
}

private extension AgentJSONValue {
    func stringValue(_ key: String) -> String? {
        guard case .object(let object) = self,
              case .string(let value)? = object[key] else { return nil }
        return value
    }

    func boolValue(_ key: String) -> Bool? {
        guard case .object(let object) = self,
              case .bool(let value)? = object[key] else { return nil }
        return value
    }

    func numberValue(_ key: String) -> Double? {
        guard case .object(let object) = self,
              case .number(let value)? = object[key] else { return nil }
        return value
    }

    func arrayValue(_ key: String) -> [AgentJSONValue]? {
        guard case .object(let object) = self,
              case .array(let value)? = object[key] else { return nil }
        return value
    }
}
