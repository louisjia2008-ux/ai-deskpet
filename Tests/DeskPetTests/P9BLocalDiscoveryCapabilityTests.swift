import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore

final class P9BLocalDiscoveryCapabilityTests: XCTestCase {
    func testCapabilityCatalogAddsReadOnlyLocalDiscoveryIDsWithoutReplacingLegacyNetworkCapabilities() {
        let expected: [(String, RiskLevel)] = [
            ("location.approximate.read", .p1),
            ("places.search.read", .p3),
            ("places.details.read", .p3),
            ("routes.estimate.read", .p3),
            ("web.page.read", .p3),
            ("web.structured_data.read", .p3),
        ]

        for (id, risk) in expected {
            let capability = CapabilityCatalog.lookup(id)
            XCTAssertEqual(capability?.direction, .read, id)
            XCTAssertEqual(capability?.risk, risk, id)
        }

        XCTAssertNotNil(CapabilityCatalog.lookup("network.search"))
        XCTAssertNotNil(CapabilityCatalog.lookup("network.fetch"))
        XCTAssertNotNil(CapabilityCatalog.lookup("browser.control"))
        XCTAssertNil(CapabilityCatalog.lookup("restaurant.search"))

        let ids = CapabilityCatalog.all.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    func testP9CapabilityPolicyFilteringKeepsLocationSeparateFromExternalSearch() {
        let appStore = CapabilityCatalogSnapshot.forPolicy(AgentPolicy(allowTools: true,
                                                                       maxSteps: 4,
                                                                       tier: .appStore))
        XCTAssertTrue(appStore.contains("location.approximate.read"))
        XCTAssertFalse(appStore.contains("places.search.read"))
        XCTAssertFalse(appStore.contains("web.page.read"))

        let developerID = CapabilityCatalogSnapshot.forPolicy(AgentPolicy(allowTools: true,
                                                                          maxSteps: 4,
                                                                          tier: .developerID))
        XCTAssertTrue(developerID.contains("location.approximate.read"))
        XCTAssertTrue(developerID.contains("places.search.read"))
        XCTAssertFalse(developerID.contains("web.page.read"))
        XCTAssertFalse(developerID.contains("network.fetch"))
        XCTAssertFalse(developerID.contains("network.search"))
    }

    func testCapabilityDescriptorsClassifyP9PrivacySideEffectsReliabilityAndEvidence() {
        let snapshot = CapabilityCatalogSnapshot(capabilities: [
            CapabilityCatalog.lookup("location.approximate.read")!,
            CapabilityCatalog.lookup("places.search.read")!,
            CapabilityCatalog.lookup("routes.estimate.read")!,
            CapabilityCatalog.lookup("web.page.read")!,
        ])

        let descriptors = CapabilityKernel().descriptors(from: snapshot)
        let location = descriptors.first { $0.capabilityID == "location.approximate.read" }
        XCTAssertEqual(location?.sideEffect, .localRead)
        XCTAssertEqual(location?.privacy, .approximateLocationData)
        XCTAssertEqual(location?.reliability, .systemFramework)
        XCTAssertEqual(location?.evidenceProduction, .toolObservation)

        let places = descriptors.first { $0.capabilityID == "places.search.read" }
        XCTAssertEqual(places?.sideEffect, .externalRead)
        XCTAssertEqual(places?.privacy, .externalData)
        XCTAssertEqual(places?.reliability, .systemFramework)
        XCTAssertEqual(places?.evidenceProduction, .toolObservation)

        let web = descriptors.first { $0.capabilityID == "web.page.read" }
        XCTAssertEqual(web?.sideEffect, .externalRead)
        XCTAssertEqual(web?.privacy, .externalData)
        XCTAssertEqual(web?.reliability, .structuredWeb)
        XCTAssertEqual(web?.evidenceProduction, .toolObservationWithContentHash)
    }

    func testManifestDescriptorCarriesOutputSchemaAndP9Metadata() {
        let manifest = ToolManifest(
            id: "local_place_search",
            version: 1,
            displayName: "地点搜索",
            shortDescription: "Searches local places through a read-only backend.",
            category: .places,
            riskLevel: .externalReadOnly,
            permissionRequirement: .capability("places.search.read"),
            inputSchema: LocalDiscoveryToolSchemas.placeSearchInput,
            outputContract: ToolOutputContract(description: "Structured place search result",
                                               maxItems: 20,
                                               schema: LocalDiscoveryToolSchemas.placeSearchOutput),
            executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 12, maxResultBytes: 65_536),
            userVisibleExecutionSummary: "正在搜索地点")

        let descriptor = CapabilityDescriptor.from(manifest: manifest)
        XCTAssertEqual(descriptor.capabilityID, "places.search.read")
        XCTAssertEqual(descriptor.version, 1)
        XCTAssertEqual(descriptor.outputSchema, LocalDiscoveryToolSchemas.placeSearchOutput)
        XCTAssertEqual(descriptor.sideEffect, .externalRead)
        XCTAssertEqual(descriptor.privacy, .externalData)
        XCTAssertEqual(descriptor.evidenceProduction, .toolObservation)
        XCTAssertEqual(descriptor.sourceToolID, "local_place_search")
    }

    func testToolRegistryValidatesManifestOutputSchema() async throws {
        let registry = ToolRegistry(gate: P9BAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(P9BInvalidPlaceSearchOutputTool())

        let request = AgentToolCallRequest(callID: "call",
                                           toolName: "fixture.invalid_place_search_output",
                                           arguments: .object(["queryText": .string("Sichuan restaurant"),
                                                               "resultLimit": .number(3)]),
                                           userVisibleSummary: "正在搜索地点")
        let result = await registry.executeTool(
            request: request,
            context: ToolExecutionContext(turnID: UUID(),
                                          callID: "call",
                                          toolID: "fixture.invalid_place_search_output"))

        switch result {
        case .failure(.schemaValidationFailed(let issues)):
            XCTAssertTrue(issues.contains { $0.path == "$.usedFixture" })
        default:
            XCTFail("Expected output schema validation failure, got \(result)")
        }
    }

    func testToolRegistryAcceptsValidManifestOutputSchema() async throws {
        let registry = ToolRegistry(gate: P9BAllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(P9BValidPlaceSearchOutputTool())

        let request = AgentToolCallRequest(callID: "call",
                                           toolName: "fixture.valid_place_search_output",
                                           arguments: .object(["queryText": .string("golf driving range"),
                                                               "resultLimit": .number(2)]),
                                           userVisibleSummary: "正在搜索地点")
        let result = await registry.executeTool(
            request: request,
            context: ToolExecutionContext(turnID: UUID(),
                                          callID: "call",
                                          toolID: "fixture.valid_place_search_output"))

        switch result {
        case .success(let output):
            XCTAssertEqual(output.status, .success)
            XCTAssertEqual(output.structuredData.intValue("resultCount"), 0)
        default:
            XCTFail("Expected schema-valid tool output, got \(result)")
        }
    }
}

private struct P9BInvalidPlaceSearchOutputTool: AgentTool {
    typealias Input = P9BPlaceSearchInput

    static let manifest = P9BPlaceSearchManifest.make(id: "fixture.invalid_place_search_output")

    func execute(input: P9BPlaceSearchInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "invalid fixture output",
                            structuredData: .object([
                                "status": .string("success"),
                                "backend": .string("fixture"),
                                "query": .string(input.queryText),
                                "inputLocationType": .string("explicitRegion"),
                                "resultCount": .number(0),
                                "candidates": .array([]),
                                "evidenceReferences": .array([]),
                                "fetchedAt": .string("2026-07-28T00:00:00Z"),
                            ]))
    }
}

private struct P9BValidPlaceSearchOutputTool: AgentTool {
    typealias Input = P9BPlaceSearchInput

    static let manifest = P9BPlaceSearchManifest.make(id: "fixture.valid_place_search_output")

    func execute(input: P9BPlaceSearchInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "valid fixture output",
                            structuredData: .object([
                                "status": .string("success"),
                                "backend": .string("fixture"),
                                "query": .string(input.queryText),
                                "inputLocationType": .string("explicitRegion"),
                                "resultCount": .number(0),
                                "candidates": .array([]),
                                "evidenceReferences": .array([]),
                                "fetchedAt": .string("2026-07-28T00:00:00Z"),
                                "usedFixture": .bool(false),
                            ]))
    }
}

private struct P9BPlaceSearchInput: Decodable, Sendable {
    var queryText: String
    var resultLimit: Int
}

private enum P9BPlaceSearchManifest {
    static func make(id: ToolID) -> ToolManifest {
        ToolManifest(
            id: id,
            displayName: "Fixture Place Search",
            shortDescription: "Fixture used only to validate ToolRegistry output schema enforcement.",
            category: .places,
            riskLevel: .externalReadOnly,
            permissionRequirement: .capability("places.search.read"),
            inputSchema: LocalDiscoveryToolSchemas.placeSearchInput,
            outputContract: ToolOutputContract(description: "Structured place search result",
                                               maxItems: 20,
                                               schema: LocalDiscoveryToolSchemas.placeSearchOutput),
            userVisibleExecutionSummary: "正在搜索地点")
    }
}

private struct P9BAllowPermissionGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: true,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired)
    }
}

private extension AgentJSONValue {
    func intValue(_ key: String) -> Int? {
        guard case .object(let object) = self,
              case .number(let value)? = object[key] else {
            return nil
        }
        return Int(value)
    }
}
