import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime

final class P6ResultSchemaTests: XCTestCase {
    private let taskID = UUID()
    private let runID = UUID()

    func testValidDocumentDecodesAndValidates() throws {
        let document = validDocument()
        let data = try JSONEncoder().encode(document)
        let decoded = try JSONDecoder().decode(AgentResultDocument.self, from: data)
        let result = AgentResultValidator.validate(decoded, toolCatalog: releaseSnapshot())
        XCTAssertTrue(result.accepted, "\(result.issues)")
        XCTAssertEqual(result.document?.sources.first?.title, "DeskPet")
    }

    func testUnknownComponentRejectsAtDecodeBoundary() {
        let json = """
        {"type":"chart","payload":{}}
        """
        XCTAssertThrowsError(try JSONDecoder().decode(AgentResultComponent.self, from: Data(json.utf8)))
    }

    func testUnsupportedSchemaVersionRejects() {
        var document = validDocument()
        document.schemaVersion = 99
        let result = AgentResultValidator.validate(document, toolCatalog: releaseSnapshot())
        XCTAssertFalse(result.accepted)
        XCTAssertTrue(result.issues.contains { $0.message == "unsupported schemaVersion" })
    }

    func testTableRowAndDuplicateIDLimitsReject() {
        var document = validDocument()
        document.sections = [
            .init(id: "dup", component: .text(.init("A"))),
            .init(id: "dup", component: .table(.init(columns: ["A"], rows: Array(repeating: ["x"], count: 3))))
        ]
        let result = AgentResultValidator.validate(document,
                                                   toolCatalog: releaseSnapshot(),
                                                   limits: .init(maxTableRows: 2))
        XCTAssertFalse(result.accepted)
        XCTAssertTrue(result.issues.contains { $0.message == "duplicate id" })
        XCTAssertTrue(result.issues.contains { $0.message == "too many table rows" })
    }

    func testInvalidURLSchemeRejects() {
        var document = validDocument()
        document.sources = [.init(id: "bad", title: "Bad", url: "file:///etc/passwd")]
        document.sections = [.init(id: "sources", component: .sourceList(.init(sourceIDs: ["bad"])))]
        let result = AgentResultValidator.validate(document, toolCatalog: releaseSnapshot())
        XCTAssertFalse(result.accepted)
        XCTAssertTrue(result.issues.contains { $0.message == "invalid url scheme" })
    }

    func testUnregisteredToolActionAndArgumentMismatchReject() {
        let badTool = AgentResultAction(id: "missing", title: "Run", toolID: "not_registered")
        var missing = validDocument()
        missing.actions = [badTool]
        missing.sections.append(.init(id: "actions", component: .actionRow(.init(actionIDs: ["missing"]))))
        XCTAssertFalse(AgentResultValidator.validate(missing, toolCatalog: releaseSnapshot()).accepted)

        let badArgs = AgentResultAction(id: "bad-args", title: "Time", toolID: "get_current_datetime",
                                        arguments: .object(["unexpected": .string("x")]),
                                        requiresApproval: false)
        var mismatch = validDocument()
        mismatch.actions = [badArgs]
        mismatch.sections.append(.init(id: "action-row", component: .actionRow(.init(actionIDs: ["bad-args"]))))
        let result = AgentResultValidator.validate(mismatch, toolCatalog: releaseSnapshot())
        XCTAssertFalse(result.accepted)
        XCTAssertTrue(result.issues.contains { $0.message == "arguments schema mismatch" })
    }

    func testExternalWriteActionRequiresApproval() {
        let manifest = ToolManifest(id: "debug.external.write",
                                    displayName: "Debug Write",
                                    shortDescription: "Writes externally in tests",
                                    category: .developer,
                                    riskLevel: .externalSideEffectReversible,
                                    permissionRequirement: .none,
                                    inputSchema: .strictEmptyObject,
                                    outputContract: .init(description: "ok"),
                                    userVisibleExecutionSummary: "Writing")
        let snapshot = ToolCatalogSnapshot(entries: [.init(manifest: manifest, enabled: true)])
        var document = validDocument()
        document.actions = [.init(id: "write", title: "Write", toolID: "debug.external.write",
                                  arguments: .object([:]), requiresApproval: false)]
        document.sections.append(.init(id: "write-row", component: .actionRow(.init(actionIDs: ["write"]))))
        let result = AgentResultValidator.validate(document, toolCatalog: snapshot)
        XCTAssertFalse(result.accepted)
        XCTAssertTrue(result.issues.contains { $0.message == "approval required" })
    }

    func testInvalidResultFallbackPreservesUserSummary() {
        var document = validDocument()
        document.schemaVersion = 100
        let result = AgentResultValidator.validate(document, toolCatalog: releaseSnapshot())
        let fallback = AgentResultValidator.fallbackText(from: document, issues: result.issues)
        XCTAssertTrue(fallback.contains(document.summary))
        XCTAssertTrue(fallback.contains("降级"))
    }

    func testSupplementParserLocallyDropsInvalidResultButKeepsMemoryCandidates() throws {
        let payload = """
        {
          "memoryCandidates": [{
            "proposedScope": "semantic",
            "canonicalKey": "preference.default_language",
            "summary": "以后默认用中文回复我。",
            "normalizedValue": "zh",
            "confidence": 0.9,
            "sensitivityHint": "ordinary",
            "sourceKind": "explicitUserStatement",
            "evidenceKind": "explicitUserStatement",
            "explicitlyRequestedByUser": true,
            "authoredByAssistant": false
          }],
          "resultDocument": {
            "schemaVersion": 99,
            "id": "bad",
            "taskID": "\(taskID.uuidString)",
            "runID": "\(runID.uuidString)",
            "title": "Bad",
            "summary": "Bad",
            "status": "completed",
            "generatedAt": "2026-01-01T00:00:00Z",
            "lastUpdatedAt": "2026-01-01T00:00:00Z",
            "sections": [],
            "sources": [],
            "actions": [],
            "metadata": {}
          }
        }
        """
        let parsed = StructuredDecisionSupplementParser.parse(raw: payload, toolCatalog: releaseSnapshot())
        XCTAssertEqual(parsed.memoryCandidates.count, 1)
        XCTAssertNil(parsed.resultDocument)
        XCTAssertFalse(parsed.resultIssues.isEmpty)
    }

    func testDebugTravelFixtureValidatesAndProductionManifestDoesNotContainSampleTool() throws {
        #if DEBUG
        let document = P6DebugTravelFixture.sampleDocument(taskID: taskID, runID: runID)
        let result = AgentResultValidator.validate(document, toolCatalog: releaseSnapshot())
        XCTAssertTrue(result.accepted, "\(result.issues)")
        XCTAssertTrue(document.summary.contains("DEBUG fixture"))
        #endif
        let ids = ToolPlatformAssembly.releaseManifests.map(\.id.rawValue)
        XCTAssertFalse(ids.contains("debug_travel_sample"))
        XCTAssertFalse(ids.contains("sample_travel_compare"))
    }

    private func validDocument() -> AgentResultDocument {
        AgentResultDocument(
            id: "result-1",
            taskID: taskID,
            runID: runID,
            title: "结果",
            summary: "可读摘要",
            status: .completed,
            generatedAt: Date(timeIntervalSince1970: 1_800_000_000),
            sections: [
                .init(id: "text", component: .text(.init("hello"))),
                .init(id: "source-list", component: .sourceList(.init(sourceIDs: ["deskpet"])))
            ],
            sources: [
                .init(id: "deskpet", title: "DeskPet", url: "https://example.com", lastUpdatedAt: nil)
            ])
    }

    private func releaseSnapshot() -> ToolCatalogSnapshot {
        ToolCatalogSnapshot(entries: ToolPlatformAssembly.releaseManifests.map {
            ToolCatalogEntry(manifest: $0, enabled: true)
        })
    }
}
