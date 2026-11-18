import XCTest
import Foundation
@testable import PetAgentRuntime
@testable import AICore

final class P6CapabilityKernelToolFactoryTests: XCTestCase {
    func testCapabilityCompositionRunsThroughPermissionGateAndToolPlatform() async throws {
        let load = p6Manifest(id: "fixture.load_numbers", capabilityID: "state.read")
        let rank = p6Manifest(id: "fixture.rank_numbers", capabilityID: "state.read", inputSchema: p6ItemsInputSchema())
        let catalog = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: load, enabled: true),
            ToolCatalogEntry(manifest: rank, enabled: true),
        ])
        let snapshot = CapabilityCatalogSnapshot(capabilities: CapabilityCatalog.all, toolCatalog: catalog)
        let request = WorkflowCompositionRequest(
            id: "workflow.rank_numbers",
            goal: "Sort a structured number list using composed capabilities",
            steps: [
                WorkflowToolRequirement(stepID: "load",
                                        toolID: "fixture.load_numbers",
                                        arguments: .object([:]),
                                        outputSchema: p6ItemsOutputSchema(),
                                        userVisibleSummary: "读取结构化数字"),
                WorkflowToolRequirement(stepID: "rank",
                                        toolID: "fixture.rank_numbers",
                                        arguments: .object(["items": .array([.number(3), .number(1), .number(3)])]),
                                        outputSchema: p6ItemsOutputSchema(),
                                        userVisibleSummary: "排序去重"),
            ])

        let composition = DynamicWorkflowComposer().compose(request, from: snapshot)
        let workflow = try XCTUnwrap(composition.workflow)
        XCTAssertFalse(composition.gapReport.hasGaps)

        let graph = CapabilityKernel().graph(from: snapshot, workflows: [workflow])
        XCTAssertNotNil(graph.node("workflow:workflow.rank_numbers"))
        XCTAssertTrue(graph.edges(from: "workflow:workflow.rank_numbers").contains {
            $0.to == "tool:fixture.rank_numbers" && $0.kind == .requires
        })

        let platform = P6RecordingToolPlatform()
        let gate = P6RecordingPermissionGate()
        let report = await DynamicWorkflowExecutor(toolPlatform: platform,
                                                   permissionGate: gate)
            .execute(workflow,
                     taskID: UUID(),
                     runID: UUID(),
                     toolCatalog: catalog)

        XCTAssertEqual(report.status, .success)
        let toolNames = await platform.toolNames()
        let capabilityIDs = await gate.capabilityIDs()
        XCTAssertEqual(toolNames, ["fixture.load_numbers", "fixture.rank_numbers"])
        XCTAssertEqual(capabilityIDs, ["state.read", "state.read"])
        XCTAssertEqual(report.outputs["rank"]?.objectArrayNumbers("items"), [1, 3])
        XCTAssertEqual(report.evidence.count, 2)
    }

    func testCapabilityDescriptorsAndGapDetectionClassifyUnavailableNeeds() {
        let manifest = p6Manifest(id: "fixture.read_workspace", capabilityID: "filesystem.workspace.read")
        let snapshot = CapabilityCatalogSnapshot(
            capabilities: CapabilityCatalogSnapshot.forPolicy(AgentPolicy(allowTools: true,
                                                                          maxSteps: 4,
                                                                          tier: .appStore)).capabilities,
            toolCatalog: ToolCatalogSnapshot(entries: [ToolCatalogEntry(manifest: manifest, enabled: true)]))
        let kernel = CapabilityKernel()
        let descriptors = kernel.descriptors(from: snapshot)
        XCTAssertEqual(descriptors.first { $0.sourceToolID == "fixture.read_workspace" }?.privacy, .workspaceData)

        let report = kernel.detectGaps(requiredIDs: [
            "fixture.read_workspace",
            "network.fetch",
            "restaurant.search",
        ], in: snapshot, policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .appStore))

        XCTAssertEqual(report.available, ["fixture.read_workspace"])
        XCTAssertEqual(report.gaps.first { $0.requiredID == "network.fetch" }?.kind, .permanentlyDenied)
        XCTAssertEqual(report.gaps.first { $0.requiredID == "restaurant.search" }?.kind, .unknownCapability)
    }

    func testStaticValidatorRejectsDuplicateDangerousAndSelfRegisteringProposals() {
        let proposal = p6EphemeralProposal(id: "ephemeral.sort_numbers",
                                           source: "restricted sort unique")
        let catalog = ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: proposal.manifest, enabled: true),
        ])
        let duplicate = ToolFactoryStaticValidator().validate(proposal, existingCatalog: catalog)
        XCTAssertFalse(duplicate.passed)
        XCTAssertTrue(duplicate.duplicateFindings.contains { $0.duplicateID == "ephemeral.sort_numbers" })

        var dangerousManifest = proposal.manifest
        dangerousManifest.id = "ephemeral.upload_numbers"
        dangerousManifest.permissionRequirement = .capability("network.upload")
        let dangerous = EphemeralToolProposal(manifest: dangerousManifest,
                                              operation: .sortUniqueNumbers,
                                              source: "URLSession.shared data registerAgentTool",
                                              taskWorkspacePath: "/private/tmp/deskpet-p6-task",
                                              outputSchema: p6ItemsOutputSchema())
        let report = ToolFactoryStaticValidator().validate(dangerous, existingCatalog: .empty)
        XCTAssertFalse(report.passed)
        XCTAssertTrue(report.issues.contains { $0.id == "forbidden_capability" })
        XCTAssertTrue(report.issues.contains { $0.id == "forbidden_source_term" })
    }

    func testSafeEphemeralToolRunsVerifiesAndDoesNotAutoPromote() async {
        let gate = P6RecordingPermissionGate()
        let factory = ToolFactory(permissionGate: gate, clock: TestClock())
        let proposal = p6EphemeralProposal()
        let staticReport = await factory.propose(proposal)
        XCTAssertTrue(staticReport.passed)

        let sandbox = await factory.sandboxVerify(toolID: proposal.id,
                                                  arguments: p6EphemeralArguments())
        XCTAssertEqual(sandbox.status, .success)
        XCTAssertTrue(sandbox.verification.passed)

        let execution = await factory.executeCurrentTask(toolID: proposal.id,
                                                         arguments: p6EphemeralArguments())
        XCTAssertEqual(execution.status, .success)
        XCTAssertTrue(execution.verification.passed)
        XCTAssertEqual(execution.result?.structuredData.objectArrayNumbers("items"), [1, 3])
        let reusableBeforePromotion = await factory.reusableRegistrySnapshot()
        let recordBeforePromotion = await factory.record(for: proposal.id)
        let capabilityIDs = await gate.capabilityIDs()
        XCTAssertTrue(reusableBeforePromotion.entries.isEmpty)
        XCTAssertTrue(recordBeforePromotion?.lifecycle.contains(.reusableCandidate) ?? false)
        XCTAssertEqual(capabilityIDs, ["filesystem.workspace.write", "filesystem.workspace.write"])

        let promoted = await factory.promote(toolID: proposal.id, approved: true)
        XCTAssertEqual(promoted, .promoted(version: 1))
        let reusableAfterPromotion = await factory.reusableRegistrySnapshot()
        XCTAssertTrue(reusableAfterPromotion.contains(proposal.id.rawValue))

        let rolledBack = await factory.rollback(toolID: proposal.id)
        let reusableAfterRollback = await factory.reusableRegistrySnapshot()
        XCTAssertTrue(rolledBack)
        XCTAssertFalse(reusableAfterRollback.contains(proposal.id.rawValue))
    }

    func testEphemeralToolCanBeCancelledAndNeverBecomesReusable() async {
        let factory = ToolFactory(permissionGate: P6RecordingPermissionGate())
        let proposal = p6EphemeralProposal(id: "ephemeral.cancel_numbers", timeoutSeconds: 1)
        let staticReport = await factory.propose(proposal)
        XCTAssertTrue(staticReport.passed)
        _ = await factory.sandboxVerify(toolID: proposal.id,
                                        arguments: p6EphemeralArguments())

        let task = Task {
            await factory.executeCurrentTask(toolID: proposal.id,
                                             arguments: p6EphemeralArguments(delayMilliseconds: 500))
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
        task.cancel()
        let report = await task.value

        XCTAssertEqual(report.status, .cancelled)
        let reusableAfterCancellation = await factory.reusableRegistrySnapshot()
        XCTAssertTrue(reusableAfterCancellation.entries.isEmpty)
    }

    func testEphemeralTimeoutAndUnauthorizedFileAccessAreRejectedWithoutReusableRegistry() async {
        let timeoutFactory = ToolFactory(permissionGate: P6RecordingPermissionGate())
        let timeoutProposal = p6EphemeralProposal(id: "ephemeral.timeout_numbers", timeoutSeconds: 0.03)
        let timeoutStaticReport = await timeoutFactory.propose(timeoutProposal)
        XCTAssertTrue(timeoutStaticReport.passed)
        _ = await timeoutFactory.sandboxVerify(toolID: timeoutProposal.id,
                                               arguments: p6EphemeralArguments())
        let timedOut = await timeoutFactory.executeCurrentTask(toolID: timeoutProposal.id,
                                                              arguments: p6EphemeralArguments(delayMilliseconds: 200))
        XCTAssertEqual(timedOut.status, .timedOut)
        let timeoutReusable = await timeoutFactory.reusableRegistrySnapshot()
        XCTAssertTrue(timeoutReusable.entries.isEmpty)

        let deniedFactory = ToolFactory(permissionGate: P6RecordingPermissionGate())
        let deniedProposal = p6EphemeralProposal(id: "ephemeral.denied_path")
        let deniedStaticReport = await deniedFactory.propose(deniedProposal)
        XCTAssertTrue(deniedStaticReport.passed)
        _ = await deniedFactory.sandboxVerify(toolID: deniedProposal.id,
                                              arguments: p6EphemeralArguments())
        let denied = await deniedFactory.executeCurrentTask(
            toolID: deniedProposal.id,
            arguments: p6EphemeralArguments(path: "/private/tmp/outside/id_rsa"))
        XCTAssertEqual(denied.status, .denied)
        let deniedReusable = await deniedFactory.reusableRegistrySnapshot()
        XCTAssertTrue(deniedReusable.entries.isEmpty)
    }
}

private actor P6RecordingPermissionGate: PermissionGate {
    private var seen: [String] = []

    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        seen.append(capabilityID)
        return EffectivePermission(capabilityID: capabilityID,
                                   applicationPolicyGranted: true,
                                   systemAuthorizationRequired: false,
                                   systemAuthorizationStatus: .notRequired)
    }

    func capabilityIDs() -> [String] { seen }
}

private actor P6RecordingToolPlatform: ToolPlatformExecuting {
    private var names: [String] = []

    func executeTool(request: AgentToolCallRequest,
                     context: ToolExecutionContext) async -> Result<ToolExecutionResult, ToolPlatformError> {
        names.append(request.toolName)
        switch request.toolName {
        case "fixture.load_numbers":
            return .success(ToolExecutionResult(status: .success,
                                                userSafeSummary: "loaded",
                                                structuredData: .object([
                                                    "status": .string("success"),
                                                    "items": .array([.number(3), .number(1), .number(3)]),
                                                ])))
        case "fixture.rank_numbers":
            let unique = Array(Set(request.arguments.objectArrayNumbers("items") ?? [])).sorted()
            return .success(ToolExecutionResult(status: .success,
                                                userSafeSummary: "ranked",
                                                structuredData: .object([
                                                    "status": .string("success"),
                                                    "items": .array(unique.map(AgentJSONValue.number)),
                                                ])))
        default:
            return .failure(.unknownTool(request.toolName))
        }
    }

    func toolNames() -> [String] { names }
}

private func p6Manifest(id: String,
                        capabilityID: String,
                        inputSchema: ToolJSONSchema = .strictEmptyObject,
                        timeoutSeconds: TimeInterval = 1) -> ToolManifest {
    ToolManifest(id: ToolID(rawValue: id),
                 displayName: id,
                 shortDescription: "fixture",
                 category: .utility,
                 riskLevel: .localReadOnlyNoPrivateData,
                 permissionRequirement: .capability(capabilityID),
                 inputSchema: inputSchema,
                 outputContract: ToolOutputContract(description: "fixture output"),
                 executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: timeoutSeconds),
                 userVisibleExecutionSummary: "fixture")
}

private func p6EphemeralProposal(id: String = "ephemeral.sort_numbers",
                                 source: String = "restrictedDataTransform sortUniqueNumbers",
                                 timeoutSeconds: TimeInterval = 1) -> EphemeralToolProposal {
    let manifest = ToolManifest(id: ToolID(rawValue: id),
                                displayName: "Sort unique numbers",
                                shortDescription: "Sorts and deduplicates task-scoped structured numbers.",
                                category: .utility,
                                riskLevel: .externalSideEffectReversible,
                                permissionRequirement: .capability("filesystem.workspace.write"),
                                inputSchema: p6EphemeralInputSchema(),
                                outputContract: ToolOutputContract(description: "sorted unique numbers"),
                                executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: timeoutSeconds),
                                userVisibleExecutionSummary: "正在运行临时排序工具")
    return EphemeralToolProposal(manifest: manifest,
                                 operation: .sortUniqueNumbers,
                                 source: source,
                                 taskWorkspacePath: "/private/tmp/deskpet-p6-task",
                                 outputSchema: p6ItemsOutputSchema())
}

private func p6ItemsInputSchema() -> ToolJSONSchema {
    ToolJSONSchema(type: .object,
                   properties: [
                       "items": ToolJSONSchema(type: .array,
                                               items: ToolJSONSchema(type: .number),
                                               minItems: 1,
                                               maxItems: 16),
                   ],
                   required: ["items"],
                   additionalProperties: false)
}

private func p6EphemeralInputSchema() -> ToolJSONSchema {
    ToolJSONSchema(type: .object,
                   properties: [
                       "items": ToolJSONSchema(type: .array,
                                               items: ToolJSONSchema(type: .number),
                                               minItems: 1,
                                               maxItems: 16),
                       "path": ToolJSONSchema(type: .string, minLength: 1, maxLength: 240),
                       "delayMilliseconds": ToolJSONSchema(type: .number, minimum: 0, maximum: 1_000),
                   ],
                   required: ["items", "path"],
                   additionalProperties: false)
}

private func p6ItemsOutputSchema() -> ToolJSONSchema {
    ToolJSONSchema(type: .object,
                   properties: [
                       "status": ToolJSONSchema(type: .string),
                       "items": ToolJSONSchema(type: .array,
                                               items: ToolJSONSchema(type: .number),
                                               minItems: 1,
                                               maxItems: 16),
                       "itemCount": ToolJSONSchema(type: .integer, minimum: 0, maximum: 16),
                       "workspace": ToolJSONSchema(type: .string, minLength: 1, maxLength: 240),
                       "ephemeral": ToolJSONSchema(type: .boolean),
                   ],
                   required: ["status", "items"],
                   additionalProperties: true)
}

private func p6EphemeralArguments(path: String = "/private/tmp/deskpet-p6-task/input.json",
                                  delayMilliseconds: Double = 0) -> AgentJSONValue {
    .object([
        "items": .array([.number(3), .number(1), .number(3)]),
        "path": .string(path),
        "delayMilliseconds": .number(delayMilliseconds),
    ])
}

private extension AgentJSONValue {
    func objectArrayNumbers(_ key: String) -> [Double]? {
        guard case .object(let object) = self,
              case .array(let values)? = object[key] else { return nil }
        return values.compactMap {
            if case .number(let number) = $0 { return number }
            return nil
        }
    }
}
