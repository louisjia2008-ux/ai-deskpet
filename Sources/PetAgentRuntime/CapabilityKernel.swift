import Foundation
import CryptoKit
import AICore

public enum CapabilitySideEffectClass: String, Codable, Sendable, Hashable {
    case none
    case localRead
    case localWrite
    case externalRead
    case externalWrite
    case upload
    case delete
    case unknown

    public static func from(capability: Capability) -> CapabilitySideEffectClass {
        switch capability.direction {
        case .none:
            return .none
        case .read:
            return capability.id.hasPrefix("network.")
                || capability.id.hasPrefix("web.")
                || capability.id.hasPrefix("places.")
                || capability.id.hasPrefix("routes.")
                ? .externalRead : .localRead
        case .write:
            return capability.id.hasPrefix("network.")
                || capability.id.hasPrefix("place.")
                ? .externalWrite : .localWrite
        case .upload:
            return .upload
        case .delete:
            return .delete
        }
    }
}

public enum CapabilityPrivacyClass: String, Codable, Sendable, Hashable {
    case noPrivateData
    case workspaceData
    case personalData
    case screenData
    case secretData
    case approximateLocationData
    case externalData
    case unknown

    public static func infer(capabilityID: String) -> CapabilityPrivacyClass {
        if capabilityID.contains("keychain") { return .secretData }
        if capabilityID.hasPrefix("location.") { return .approximateLocationData }
        if capabilityID.contains("calendar") || capabilityID.contains("reminder") || capabilityID.contains("contacts") {
            return .personalData
        }
        if capabilityID.contains("screen") || capabilityID.contains("accessibility") { return .screenData }
        if capabilityID.contains("filesystem.workspace") { return .workspaceData }
        if capabilityID.contains("network")
            || capabilityID.hasPrefix("web.")
            || capabilityID.hasPrefix("places.")
            || capabilityID.hasPrefix("routes.")
            || capabilityID.hasPrefix("place.")
            || capabilityID.contains("mail")
            || capabilityID.contains("browser") {
            return .externalData
        }
        return .noPrivateData
    }
}

public enum CapabilityReliabilityLevel: String, Codable, Sendable, Hashable {
    case deterministic
    case systemFramework
    case officialAPI
    case structuredWeb
    case browserAutomation
    case computerUse
    case experimental
}

public enum CapabilityEvidenceProduction: String, Codable, Sendable, Hashable {
    case none
    case toolObservation
    case toolObservationWithContentHash
}

public struct CapabilityDescriptor: Codable, Sendable, Hashable, Identifiable {
    public var id: String { capabilityID }
    public var capabilityID: String
    public var version: Int
    public var inputSchema: ToolJSONSchema
    public var outputSchema: ToolJSONSchema?
    public var permissions: [ToolPermissionRequirement]
    public var sideEffect: CapabilitySideEffectClass
    public var privacy: CapabilityPrivacyClass
    public var cancellationSupported: Bool
    public var progressSupported: Bool
    public var timeoutSeconds: TimeInterval
    public var reliability: CapabilityReliabilityLevel
    public var evidenceProduction: CapabilityEvidenceProduction
    public var sourceToolID: ToolID?

    public init(capabilityID: String,
                version: Int,
                inputSchema: ToolJSONSchema,
                outputSchema: ToolJSONSchema? = nil,
                permissions: [ToolPermissionRequirement],
                sideEffect: CapabilitySideEffectClass,
                privacy: CapabilityPrivacyClass,
                cancellationSupported: Bool,
                progressSupported: Bool,
                timeoutSeconds: TimeInterval,
                reliability: CapabilityReliabilityLevel,
                evidenceProduction: CapabilityEvidenceProduction = .toolObservation,
                sourceToolID: ToolID? = nil) {
        self.capabilityID = AgentPrivacyRedactor.safeIdentifier(capabilityID, fallback: "unknown_capability")
        self.version = max(1, version)
        self.inputSchema = inputSchema
        self.outputSchema = outputSchema
        self.permissions = permissions
        self.sideEffect = sideEffect
        self.privacy = privacy
        self.cancellationSupported = cancellationSupported
        self.progressSupported = progressSupported
        self.timeoutSeconds = max(0.1, timeoutSeconds)
        self.reliability = reliability
        self.evidenceProduction = evidenceProduction
        self.sourceToolID = sourceToolID
    }

    public static func from(capability: Capability) -> CapabilityDescriptor {
        CapabilityDescriptor(capabilityID: capability.id,
                             version: 1,
                             inputSchema: .strictEmptyObject,
                             permissions: [.capability(capability.id)],
                             sideEffect: .from(capability: capability),
                             privacy: .infer(capabilityID: capability.id),
                             cancellationSupported: true,
                             progressSupported: false,
                             timeoutSeconds: 8,
                             reliability: reliability(for: capability.id),
                             evidenceProduction: evidenceProduction(for: capability.id))
    }

    public static func from(manifest: ToolManifest) -> CapabilityDescriptor {
        let capabilityID = manifest.permissionRequirement.capabilityID ?? manifest.id.rawValue
        let capability = CapabilityCatalog.lookup(capabilityID)
        return CapabilityDescriptor(capabilityID: capabilityID,
                                    version: manifest.version,
                                    inputSchema: manifest.inputSchema,
                                    outputSchema: manifest.outputContract.schema,
                                    permissions: [manifest.permissionRequirement],
                                    sideEffect: capability.map(CapabilitySideEffectClass.from(capability:)) ?? .unknown,
                                    privacy: .infer(capabilityID: capabilityID),
                                    cancellationSupported: true,
                                    progressSupported: false,
                                    timeoutSeconds: manifest.executionCharacteristics.timeoutSeconds,
                                    reliability: reliability(for: capabilityID),
                                    evidenceProduction: evidenceProduction(for: capabilityID),
                                    sourceToolID: manifest.id)
    }

    private static func reliability(for capabilityID: String) -> CapabilityReliabilityLevel {
        if capabilityID.hasPrefix("network.") || capabilityID.hasPrefix("web.") { return .structuredWeb }
        if capabilityID.hasPrefix("places.") || capabilityID.hasPrefix("routes.") || capabilityID.hasPrefix("location.") {
            return .systemFramework
        }
        if capabilityID.hasPrefix("place.") { return .systemFramework }
        if capabilityID.hasPrefix("browser.") { return .browserAutomation }
        if capabilityID.hasPrefix("accessibility.") { return .computerUse }
        return .systemFramework
    }

    private static func evidenceProduction(for capabilityID: String) -> CapabilityEvidenceProduction {
        if capabilityID.hasPrefix("web.page.") || capabilityID.hasPrefix("web.structured_data.") {
            return .toolObservationWithContentHash
        }
        if capabilityID.hasPrefix("location.")
            || capabilityID.hasPrefix("places.")
            || capabilityID.hasPrefix("routes.")
            || capabilityID.hasPrefix("place.")
            || capabilityID.hasPrefix("network.") {
            return .toolObservation
        }
        return .none
    }
}

public enum CapabilityGraphNodeKind: String, Codable, Sendable, Hashable {
    case capability
    case tool
    case workflow
}

public struct CapabilityGraphNode: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: CapabilityGraphNodeKind
    public var label: String
    public var descriptor: CapabilityDescriptor?

    public init(id: String, kind: CapabilityGraphNodeKind, label: String, descriptor: CapabilityDescriptor? = nil) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.kind = kind
        self.label = AgentPrivacyRedactor.safeSummary(label, fallback: id)
        self.descriptor = descriptor
    }
}

public enum CapabilityGraphEdgeKind: String, Codable, Sendable, Hashable {
    case requires
    case provides
    case precedes
}

public struct CapabilityGraphEdge: Codable, Sendable, Hashable {
    public var from: String
    public var to: String
    public var kind: CapabilityGraphEdgeKind

    public init(from: String, to: String, kind: CapabilityGraphEdgeKind) {
        self.from = AgentEventRedactor.safeIdentifier(from)
        self.to = AgentEventRedactor.safeIdentifier(to)
        self.kind = kind
    }
}

public struct CapabilityGraph: Codable, Sendable, Hashable {
    public var nodes: [CapabilityGraphNode]
    public var edges: [CapabilityGraphEdge]

    public init(nodes: [CapabilityGraphNode] = [], edges: [CapabilityGraphEdge] = []) {
        self.nodes = nodes.sorted { $0.id < $1.id }
        self.edges = edges.sorted {
            if $0.from != $1.from { return $0.from < $1.from }
            if $0.to != $1.to { return $0.to < $1.to }
            return $0.kind.rawValue < $1.kind.rawValue
        }
    }

    public func node(_ id: String) -> CapabilityGraphNode? {
        nodes.first { $0.id == AgentEventRedactor.safeIdentifier(id) }
    }

    public func edges(from id: String, kind: CapabilityGraphEdgeKind? = nil) -> [CapabilityGraphEdge] {
        let safeID = AgentEventRedactor.safeIdentifier(id)
        return edges.filter { $0.from == safeID && (kind == nil || $0.kind == kind) }
    }
}

public enum CapabilityGapKind: String, Codable, Sendable, Hashable {
    case unknownCapability
    case missingTool
    case disabledTool
    case permanentlyDenied
}

public struct CapabilityGap: Codable, Sendable, Hashable, Identifiable {
    public var id: String { requiredID }
    public var requiredID: String
    public var kind: CapabilityGapKind
    public var message: String

    public init(requiredID: String, kind: CapabilityGapKind, message: String) {
        self.requiredID = AgentEventRedactor.safeIdentifier(requiredID)
        self.kind = kind
        self.message = AgentPrivacyRedactor.safeSummary(message, fallback: kind.rawValue)
    }
}

public struct CapabilityGapReport: Codable, Sendable, Hashable {
    public var available: [String]
    public var gaps: [CapabilityGap]

    public init(available: [String], gaps: [CapabilityGap]) {
        self.available = available.map(AgentEventRedactor.safeIdentifier).sorted()
        self.gaps = gaps.sorted { $0.requiredID < $1.requiredID }
    }

    public var hasGaps: Bool { !gaps.isEmpty }
}

public struct CapabilityDuplicateFinding: Codable, Sendable, Hashable, Identifiable {
    public var id: String { duplicateID }
    public var duplicateID: String
    public var existingSource: String
    public var candidateSource: String

    public init(duplicateID: String, existingSource: String, candidateSource: String) {
        self.duplicateID = AgentEventRedactor.safeIdentifier(duplicateID)
        self.existingSource = AgentPrivacyRedactor.safeSummary(existingSource, fallback: "existing")
        self.candidateSource = AgentPrivacyRedactor.safeSummary(candidateSource, fallback: "candidate")
    }
}

public struct CapabilityKernel: Sendable {
    public init() {}

    public func descriptors(from snapshot: CapabilityCatalogSnapshot) -> [CapabilityDescriptor] {
        var descriptors: [String: CapabilityDescriptor] = [:]
        for capability in snapshot.capabilities {
            descriptors[capability.id] = .from(capability: capability)
        }
        for manifest in snapshot.toolCatalog.manifests {
            let descriptor = CapabilityDescriptor.from(manifest: manifest)
            descriptors[descriptor.capabilityID] = descriptor
        }
        return descriptors.values.sorted { $0.capabilityID < $1.capabilityID }
    }

    public func graph(from snapshot: CapabilityCatalogSnapshot, workflows: [DynamicWorkflow] = []) -> CapabilityGraph {
        var nodes: [CapabilityGraphNode] = []
        var edges: [CapabilityGraphEdge] = []
        // P18.1 — PAR-005 closure. Upstream `descriptors(from:)`
        // already deduplicates via `[String: CapabilityDescriptor]`
        // (last-wins). The `uniqueKeysWithValues:` call was redundant
        // but theoretically crash-prone if upstream ever returned a
        // sequence with duplicates. We use `uniquingKeysWith:`
        // (first-wins) defensively — the upstream invariant guarantees
        // we never see duplicates, but if a future refactor breaks
        // that, the graph() function will not crash.
        let descriptors = Dictionary(
            descriptors(from: snapshot).map { ($0.capabilityID, $0) },
            uniquingKeysWith: { first, _ in first })

        for capability in snapshot.capabilities {
            let id = "capability:\(capability.id)"
            nodes.append(CapabilityGraphNode(id: id,
                                             kind: .capability,
                                             label: capability.id,
                                             descriptor: descriptors[capability.id] ?? .from(capability: capability)))
        }
        for entry in snapshot.toolCatalog.entries {
            let toolID = "tool:\(entry.manifest.id.rawValue)"
            nodes.append(CapabilityGraphNode(id: toolID,
                                             kind: .tool,
                                             label: entry.manifest.displayName,
                                             descriptor: .from(manifest: entry.manifest)))
            for capabilityID in entry.manifest.permissionRequirement.p6CapabilityIDs {
                let capID = "capability:\(capabilityID)"
                edges.append(CapabilityGraphEdge(from: toolID, to: capID, kind: .requires))
                edges.append(CapabilityGraphEdge(from: capID, to: toolID, kind: .provides))
            }
        }
        for workflow in workflows {
            let workflowID = "workflow:\(workflow.id)"
            nodes.append(CapabilityGraphNode(id: workflowID,
                                             kind: .workflow,
                                             label: workflow.id))
            for step in workflow.steps {
                edges.append(CapabilityGraphEdge(from: workflowID,
                                                 to: "tool:\(step.toolID.rawValue)",
                                                 kind: .requires))
            }
            for pair in zip(workflow.steps, workflow.steps.dropFirst()) {
                edges.append(CapabilityGraphEdge(from: "tool:\(pair.0.toolID.rawValue)",
                                                 to: "tool:\(pair.1.toolID.rawValue)",
                                                 kind: .precedes))
            }
        }
        return CapabilityGraph(nodes: nodes, edges: Array(Set(edges)))
    }

    public func detectGaps(requiredIDs: [String],
                           in snapshot: CapabilityCatalogSnapshot,
                           policy: AgentPolicy? = nil) -> CapabilityGapReport {
        var available: [String] = []
        var gaps: [CapabilityGap] = []
        for rawID in requiredIDs {
            let id = AgentEventRedactor.safeIdentifier(rawID)
            if let entry = snapshot.toolCatalog.lookup(ToolID(rawValue: id)) {
                if entry.enabled && entry.manifest.availability == .available {
                    available.append(id)
                } else {
                    gaps.append(CapabilityGap(requiredID: id,
                                              kind: .disabledTool,
                                              message: "\(id) 当前不可用"))
                }
                continue
            }
            if snapshot.capabilities.contains(where: { $0.id == id }) {
                available.append(id)
                continue
            }
            if let capability = CapabilityCatalog.lookup(id), let policy, policy.tier.isPermanentlyDenied(capability) {
                gaps.append(CapabilityGap(requiredID: id,
                                          kind: .permanentlyDenied,
                                          message: "\(id) 被当前分发渠道永久禁用"))
            } else if CapabilityCatalog.lookup(id) != nil {
                gaps.append(CapabilityGap(requiredID: id,
                                          kind: .missingTool,
                                          message: "\(id) 没有可执行工具或未在本轮快照中暴露"))
            } else {
                gaps.append(CapabilityGap(requiredID: id,
                                          kind: .unknownCapability,
                                          message: "未知能力或工具：\(id)"))
            }
        }
        return CapabilityGapReport(available: available, gaps: gaps)
    }

    public func duplicateFindings(existing: ToolCatalogSnapshot,
                                  candidates: [ToolManifest],
                                  generatedIDs: Set<ToolID> = []) -> [CapabilityDuplicateFinding] {
        var seen: [String: String] = [:]
        for manifest in existing.manifests {
            seen[manifest.id.rawValue] = "releaseCatalog"
        }
        for id in generatedIDs {
            seen[id.rawValue] = "toolFactory"
        }
        var findings: [CapabilityDuplicateFinding] = []
        for manifest in candidates {
            if let source = seen[manifest.id.rawValue] {
                findings.append(CapabilityDuplicateFinding(duplicateID: manifest.id.rawValue,
                                                           existingSource: source,
                                                           candidateSource: "proposal"))
            }
            seen[manifest.id.rawValue] = "proposal"
        }
        return findings
    }
}

public struct WorkflowToolRequirement: Codable, Sendable, Hashable, Identifiable {
    public var id: String { stepID }
    public var stepID: String
    public var toolID: ToolID
    public var arguments: AgentJSONValue
    public var outputSchema: ToolJSONSchema?
    public var userVisibleSummary: String

    public init(stepID: String,
                toolID: ToolID,
                arguments: AgentJSONValue,
                outputSchema: ToolJSONSchema? = nil,
                userVisibleSummary: String = "正在执行能力组合") {
        self.stepID = AgentEventRedactor.safeIdentifier(stepID)
        self.toolID = toolID
        self.arguments = arguments
        self.outputSchema = outputSchema
        self.userVisibleSummary = AgentPrivacyRedactor.safeSummary(userVisibleSummary,
                                                                   fallback: "正在执行能力组合")
    }
}

public struct WorkflowCompositionRequest: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var version: Int
    public var goal: String
    public var steps: [WorkflowToolRequirement]

    public init(id: String, version: Int = 1, goal: String, steps: [WorkflowToolRequirement]) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.version = max(1, version)
        self.goal = AgentPrivacyRedactor.safeText(goal, maxLength: 400).text
        self.steps = steps
    }
}

public struct DynamicWorkflowStep: Codable, Sendable, Hashable, Identifiable {
    public var id: String { stepID }
    public var stepID: String
    public var toolID: ToolID
    public var arguments: AgentJSONValue
    public var outputSchema: ToolJSONSchema?
    public var userVisibleSummary: String

    public init(stepID: String,
                toolID: ToolID,
                arguments: AgentJSONValue,
                outputSchema: ToolJSONSchema? = nil,
                userVisibleSummary: String) {
        self.stepID = AgentEventRedactor.safeIdentifier(stepID)
        self.toolID = toolID
        self.arguments = arguments
        self.outputSchema = outputSchema
        self.userVisibleSummary = AgentPrivacyRedactor.safeSummary(userVisibleSummary,
                                                                   fallback: "正在执行能力组合")
    }
}

public struct DynamicWorkflow: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var version: Int
    public var goal: String
    public var steps: [DynamicWorkflowStep]
    public var requiredToolIDs: [ToolID]

    public init(id: String,
                version: Int,
                goal: String,
                steps: [DynamicWorkflowStep]) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.version = max(1, version)
        self.goal = AgentPrivacyRedactor.safeText(goal, maxLength: 400).text
        self.steps = steps
        self.requiredToolIDs = steps.map(\.toolID)
    }
}

public struct WorkflowCompositionResult: Sendable, Equatable {
    public var workflow: DynamicWorkflow?
    public var gapReport: CapabilityGapReport

    public init(workflow: DynamicWorkflow?, gapReport: CapabilityGapReport) {
        self.workflow = workflow
        self.gapReport = gapReport
    }
}

public struct DynamicWorkflowComposer: Sendable {
    private let kernel: CapabilityKernel

    public init(kernel: CapabilityKernel = CapabilityKernel()) {
        self.kernel = kernel
    }

    public func compose(_ request: WorkflowCompositionRequest,
                        from snapshot: CapabilityCatalogSnapshot,
                        policy: AgentPolicy? = nil) -> WorkflowCompositionResult {
        let gaps = kernel.detectGaps(requiredIDs: request.steps.map { $0.toolID.rawValue },
                                     in: snapshot,
                                     policy: policy)
        guard !gaps.hasGaps else {
            return WorkflowCompositionResult(workflow: nil, gapReport: gaps)
        }
        let steps = request.steps.map {
            DynamicWorkflowStep(stepID: $0.stepID,
                                toolID: $0.toolID,
                                arguments: $0.arguments,
                                outputSchema: $0.outputSchema,
                                userVisibleSummary: $0.userVisibleSummary)
        }
        return WorkflowCompositionResult(workflow: DynamicWorkflow(id: request.id,
                                                                   version: request.version,
                                                                   goal: request.goal,
                                                                   steps: steps),
                                         gapReport: gaps)
    }
}

public enum DynamicWorkflowExecutionStatus: String, Codable, Sendable, Hashable {
    case success
    case denied
    case failed
    case timedOut
    case cancelled
}

public struct DynamicWorkflowExecutionReport: Sendable, Equatable {
    public var status: DynamicWorkflowExecutionStatus
    public var observations: [AgentToolObservation]
    public var evidence: [AgentEvidenceRecord]
    public var outputs: [String: AgentJSONValue]
    public var failedStepID: String?
    public var message: String

    public init(status: DynamicWorkflowExecutionStatus,
                observations: [AgentToolObservation] = [],
                evidence: [AgentEvidenceRecord] = [],
                outputs: [String: AgentJSONValue] = [:],
                failedStepID: String? = nil,
                message: String = "") {
        self.status = status
        self.observations = observations
        self.evidence = evidence
        self.outputs = outputs
        self.failedStepID = failedStepID.map(AgentEventRedactor.safeIdentifier)
        self.message = AgentPrivacyRedactor.safeSummary(message, fallback: status.rawValue)
    }
}

public struct DynamicWorkflowExecutor: Sendable {
    private let toolPlatform: any ToolPlatformExecuting
    private let permissionGate: any PermissionGate
    private let observationSanitizer: any ObservationSanitizing
    private let clock: RuntimeClock

    public init(toolPlatform: any ToolPlatformExecuting,
                permissionGate: any PermissionGate,
                observationSanitizer: any ObservationSanitizing = DefaultObservationSanitizer(),
                clock: RuntimeClock = WallClock()) {
        self.toolPlatform = toolPlatform
        self.permissionGate = permissionGate
        self.observationSanitizer = observationSanitizer
        self.clock = clock
    }

    public func execute(_ workflow: DynamicWorkflow,
                        taskID: UUID,
                        runID: UUID,
                        toolCatalog: ToolCatalogSnapshot,
                        locale: Locale = .current,
                        timeZone: TimeZone = .current) async -> DynamicWorkflowExecutionReport {
        var observations: [AgentToolObservation] = []
        var evidence: [AgentEvidenceRecord] = []
        var outputs: [String: AgentJSONValue] = [:]
        let turnID = runID

        for step in workflow.steps {
            if Task.isCancelled {
                return DynamicWorkflowExecutionReport(status: .cancelled,
                                                      observations: observations,
                                                      evidence: evidence,
                                                      outputs: outputs,
                                                      failedStepID: step.stepID,
                                                      message: "workflow cancelled")
            }
            guard let entry = toolCatalog.lookup(step.toolID) else {
                return failureReport(.failed,
                                     callID: step.stepID,
                                     toolID: step.toolID,
                                     status: .failed,
                                     summary: "工具不存在",
                                     content: .object(["error": .string("unknown tool")]),
                                     observations: observations,
                                     evidence: evidence,
                                     outputs: outputs,
                                     taskID: taskID)
            }
            guard entry.enabled, entry.manifest.availability == .available else {
                return failureReport(.failed,
                                     callID: step.stepID,
                                     toolID: step.toolID,
                                     status: .failed,
                                     summary: "工具不可用",
                                     content: .object(["error": .string("tool unavailable")]),
                                     observations: observations,
                                     evidence: evidence,
                                     outputs: outputs,
                                     taskID: taskID)
            }
            let inputValidation = ToolSchemaValidator.validate(step.arguments,
                                                               against: entry.manifest.inputSchema)
            guard inputValidation.accepted else {
                return failureReport(.failed,
                                     callID: step.stepID,
                                     toolID: step.toolID,
                                     status: .failed,
                                     summary: "能力组合参数无效",
                                     content: .object(["error": .string("invalid workflow arguments")]),
                                     observations: observations,
                                     evidence: evidence,
                                     outputs: outputs,
                                     taskID: taskID)
            }
            for capabilityID in entry.manifest.permissionRequirement.p6CapabilityIDs {
                let permission = await permissionGate.evaluate(capabilityID: capabilityID,
                                                               reason: "workflow:\(workflow.id):\(step.toolID.rawValue)",
                                                               correlationID: taskID)
                guard permission.isExecutable else {
                    return failureReport(.denied,
                                         callID: step.stepID,
                                         toolID: step.toolID,
                                         status: .denied,
                                         summary: "权限被拒绝",
                                         content: .object(["error": .string(permission.denialReason ?? "permission denied")]),
                                         observations: observations,
                                         evidence: evidence,
                                         outputs: outputs,
                                         taskID: taskID)
                }
            }

            let request = AgentToolCallRequest(callID: step.stepID,
                                               toolName: step.toolID.rawValue,
                                               arguments: step.arguments,
                                               userVisibleSummary: step.userVisibleSummary)
            let context = ToolExecutionContext(taskID: taskID,
                                               runID: turnID,
                                               turnID: turnID,
                                               callID: step.stepID,
                                               toolID: step.toolID,
                                               locale: locale,
                                               timeZone: timeZone,
                                               clock: clock,
                                               permissionAlreadyEvaluated: true)
            let result = await toolPlatform.executeTool(request: request, context: context)
            switch result {
            case .success(let toolResult):
                let observation = observationSanitizer.observation(for: request,
                                                                   result: toolResult,
                                                                   maxCharacters: 2_000)
                if let schema = step.outputSchema {
                    let validation = ToolSchemaValidator.validate(toolResult.structuredData, against: schema)
                    guard validation.accepted else {
                        var allObservations = observations
                        var allEvidence = evidence
                        allObservations.append(observation)
                        allEvidence.append(AgentEvidenceRecord.from(observation: observation,
                                                                    taskID: taskID,
                                                                    capturedAt: clock.now()))
                        return DynamicWorkflowExecutionReport(status: .failed,
                                                              observations: allObservations,
                                                              evidence: allEvidence,
                                                              outputs: outputs,
                                                              failedStepID: step.stepID,
                                                              message: "workflow output schema validation failed")
                    }
                }
                observations.append(observation)
                evidence.append(AgentEvidenceRecord.from(observation: observation,
                                                         taskID: taskID,
                                                         capturedAt: clock.now()))
                outputs[step.stepID] = toolResult.structuredData
                if toolResult.status == .timedOut {
                    return DynamicWorkflowExecutionReport(status: .timedOut,
                                                          observations: observations,
                                                          evidence: evidence,
                                                          outputs: outputs,
                                                          failedStepID: step.stepID,
                                                          message: "workflow tool timed out")
                }
                if toolResult.status == .cancelled {
                    return DynamicWorkflowExecutionReport(status: .cancelled,
                                                          observations: observations,
                                                          evidence: evidence,
                                                          outputs: outputs,
                                                          failedStepID: step.stepID,
                                                          message: "workflow tool cancelled")
                }
                if toolResult.status != .success && toolResult.status != .partial {
                    return DynamicWorkflowExecutionReport(status: .failed,
                                                          observations: observations,
                                                          evidence: evidence,
                                                          outputs: outputs,
                                                          failedStepID: step.stepID,
                                                          message: "workflow tool failed")
                }
            case .failure(.timedOut):
                return failureReport(.timedOut,
                                     callID: step.stepID,
                                     toolID: step.toolID,
                                     status: .timeout,
                                     summary: "工具执行超时",
                                     content: .object(["error": .string("timeout")]),
                                     observations: observations,
                                     evidence: evidence,
                                     outputs: outputs,
                                     taskID: taskID)
            case .failure(.cancelled):
                return failureReport(.cancelled,
                                     callID: step.stepID,
                                     toolID: step.toolID,
                                     status: .failed,
                                     summary: "工具已取消",
                                     content: .object(["error": .string("cancelled")]),
                                     observations: observations,
                                     evidence: evidence,
                                     outputs: outputs,
                                     taskID: taskID)
            case .failure(let error):
                return failureReport(.failed,
                                     callID: step.stepID,
                                     toolID: step.toolID,
                                     status: .failed,
                                     summary: "工具执行失败",
                                     content: .object(["error": .string("\(error)")]),
                                     observations: observations,
                                     evidence: evidence,
                                     outputs: outputs,
                                     taskID: taskID)
            }
        }

        return DynamicWorkflowExecutionReport(status: .success,
                                              observations: observations,
                                              evidence: evidence,
                                              outputs: outputs,
                                              message: "workflow completed")
    }

    private func failureReport(_ status: DynamicWorkflowExecutionStatus,
                               callID: String,
                               toolID: ToolID,
                               status observationStatus: AgentLoopObservationStatus,
                               summary: String,
                               content: AgentJSONValue,
                               observations: [AgentToolObservation],
                               evidence: [AgentEvidenceRecord],
                               outputs: [String: AgentJSONValue],
                               taskID: UUID) -> DynamicWorkflowExecutionReport {
        let observation = AgentToolObservation(callID: callID,
                                               toolName: toolID.rawValue,
                                               status: observationStatus,
                                               content: content,
                                               userSafeSummary: summary)
        var allObservations = observations
        var allEvidence = evidence
        allObservations.append(observation)
        allEvidence.append(AgentEvidenceRecord.from(observation: observation,
                                                    taskID: taskID,
                                                    capturedAt: clock.now()))
        return DynamicWorkflowExecutionReport(status: status,
                                              observations: allObservations,
                                              evidence: allEvidence,
                                              outputs: outputs,
                                              failedStepID: callID,
                                              message: summary)
    }
}

public enum EphemeralToolOperation: String, Codable, Sendable, Hashable {
    case sortUniqueNumbers
    case sortUniqueStrings
    case sumNumbers
}

public enum EphemeralScriptLanguage: String, Codable, Sendable, Hashable {
    case restrictedDataTransform
}

public enum ToolFactoryPromotionPolicy: String, Codable, Sendable, Hashable {
    case taskScopedOnly
    case reusableCandidateAfterVerification
}

public struct EphemeralToolVersionMetadata: Codable, Sendable, Hashable {
    public var version: Int
    public var sourceDigest: String
    public var createdAt: Date
    public var promotedAt: Date?

    public init(version: Int = 1, sourceDigest: String, createdAt: Date, promotedAt: Date? = nil) {
        self.version = max(1, version)
        self.sourceDigest = AgentEventRedactor.safeIdentifier(sourceDigest)
        self.createdAt = createdAt
        self.promotedAt = promotedAt
    }
}

public struct EphemeralToolProposal: Codable, Sendable, Hashable, Identifiable {
    public var id: ToolID { manifest.id }
    public var manifest: ToolManifest
    public var operation: EphemeralToolOperation
    public var language: EphemeralScriptLanguage
    public var source: String
    public var taskWorkspacePath: String
    public var outputSchema: ToolJSONSchema
    public var promotionPolicy: ToolFactoryPromotionPolicy
    public var versionMetadata: EphemeralToolVersionMetadata

    public init(manifest: ToolManifest,
                operation: EphemeralToolOperation,
                language: EphemeralScriptLanguage = .restrictedDataTransform,
                source: String,
                taskWorkspacePath: String,
                outputSchema: ToolJSONSchema,
                promotionPolicy: ToolFactoryPromotionPolicy = .reusableCandidateAfterVerification,
                createdAt: Date = Date()) {
        self.manifest = manifest
        self.operation = operation
        self.language = language
        self.source = AgentPrivacyRedactor.safeText(source, maxLength: 4_096).text
        self.taskWorkspacePath = EphemeralPathPolicy.normalized(taskWorkspacePath)
        self.outputSchema = outputSchema
        self.promotionPolicy = promotionPolicy
        self.versionMetadata = EphemeralToolVersionMetadata(version: manifest.version,
                                                            sourceDigest: Self.digest(source: source,
                                                                                      manifest: manifest,
                                                                                      operation: operation),
                                                            createdAt: createdAt)
    }

    private static func digest(source: String, manifest: ToolManifest, operation: EphemeralToolOperation) -> String {
        let raw = "\(manifest.id.rawValue)|\(manifest.version)|\(operation.rawValue)|\(source)"
        let digest = SHA256.hash(data: Data(raw.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

public enum ToolFactoryIssueSeverity: String, Codable, Sendable, Hashable {
    case warning
    case blocking
}

public struct ToolFactoryIssue: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var severity: ToolFactoryIssueSeverity
    public var message: String

    public init(id: String, severity: ToolFactoryIssueSeverity, message: String) {
        self.id = AgentEventRedactor.safeIdentifier(id)
        self.severity = severity
        self.message = AgentPrivacyRedactor.safeText(message, maxLength: 400).text
    }
}

public struct ToolFactoryStaticValidationReport: Codable, Sendable, Hashable {
    public var passed: Bool
    public var issues: [ToolFactoryIssue]
    public var duplicateFindings: [CapabilityDuplicateFinding]

    public init(passed: Bool,
                issues: [ToolFactoryIssue] = [],
                duplicateFindings: [CapabilityDuplicateFinding] = []) {
        self.passed = passed
        self.issues = issues
        self.duplicateFindings = duplicateFindings
    }
}

public struct ToolFactoryStaticValidator: Sendable {
    private let kernel: CapabilityKernel

    public init(kernel: CapabilityKernel = CapabilityKernel()) {
        self.kernel = kernel
    }

    public func validate(_ proposal: EphemeralToolProposal,
                         existingCatalog: ToolCatalogSnapshot,
                         generatedIDs: Set<ToolID> = []) -> ToolFactoryStaticValidationReport {
        var issues: [ToolFactoryIssue] = []
        let duplicates = kernel.duplicateFindings(existing: existingCatalog,
                                                  candidates: [proposal.manifest],
                                                  generatedIDs: generatedIDs)
        if !duplicates.isEmpty {
            issues.append(ToolFactoryIssue(id: "duplicate_tool_id",
                                           severity: .blocking,
                                           message: "临时工具 ID 与已有工具重复"))
        }
        if !proposal.manifest.id.rawValue.hasPrefix("ephemeral.") {
            issues.append(ToolFactoryIssue(id: "missing_ephemeral_namespace",
                                           severity: .blocking,
                                           message: "临时工具必须使用 ephemeral. 命名空间"))
        }
        if proposal.language != .restrictedDataTransform {
            issues.append(ToolFactoryIssue(id: "unsupported_language",
                                           severity: .blocking,
                                           message: "P6 仅允许受限数据转换语言"))
        }
        if proposal.manifest.riskLevel >= .destructiveOrSensitiveWrite || proposal.manifest.riskLevel == .unknown {
            issues.append(ToolFactoryIssue(id: "risk_too_high",
                                           severity: .blocking,
                                           message: "临时工具不得申请高风险或未知风险"))
        }
        if !proposal.manifest.inputSchema.additionalProperties {
            // Strict schemas are the intended path; no issue.
        } else {
            issues.append(ToolFactoryIssue(id: "input_schema_not_strict",
                                           severity: .blocking,
                                           message: "临时工具输入 Schema 必须拒绝未知字段"))
        }
        if proposal.manifest.inputSchema.type != .object || proposal.outputSchema.type != .object {
            issues.append(ToolFactoryIssue(id: "schema_root_not_object",
                                           severity: .blocking,
                                           message: "临时工具输入和输出 Schema 根节点必须是 object"))
        }
        if proposal.manifest.executionCharacteristics.timeoutSeconds > 30 {
            issues.append(ToolFactoryIssue(id: "timeout_too_large",
                                           severity: .blocking,
                                           message: "临时工具超时不得超过 30 秒"))
        }
        let workspaceCheck = EphemeralPathPolicy.validateWorkspaceRoot(proposal.taskWorkspacePath)
        if let workspaceIssue = workspaceCheck {
            issues.append(workspaceIssue)
        }
        switch proposal.manifest.permissionRequirement {
        case .none, .systemPermission:
            issues.append(ToolFactoryIssue(id: "missing_capability_gate",
                                           severity: .blocking,
                                           message: "临时工具必须声明可由 Permission Gate 评估的 capability"))
        case .capability(let capabilityID), .capabilityAndSystemPermission(let capabilityID, _):
            guard let capability = CapabilityCatalog.lookup(capabilityID) else {
                issues.append(ToolFactoryIssue(id: "unknown_capability",
                                               severity: .blocking,
                                               message: "未知 capability：\(capabilityID)"))
                break
            }
            if capability.risk >= .p4 {
                issues.append(ToolFactoryIssue(id: "forbidden_capability",
                                               severity: .blocking,
                                               message: "临时工具不得申请 P4 capability：\(capabilityID)"))
            }
            if ToolFactoryStaticValidator.forbiddenCapabilityIDs.contains(capabilityID)
                || capabilityID.hasPrefix("network.")
                || capabilityID.hasPrefix("keychain.") {
                issues.append(ToolFactoryIssue(id: "forbidden_capability",
                                               severity: .blocking,
                                               message: "临时工具禁用 capability：\(capabilityID)"))
            }
        }
        for term in ToolFactoryStaticValidator.forbiddenSourceTerms where proposal.source.localizedCaseInsensitiveContains(term) {
            issues.append(ToolFactoryIssue(id: "forbidden_source_term",
                                           severity: .blocking,
                                           message: "临时工具源码包含禁用片段"))
            break
        }
        let passed = !issues.contains { $0.severity == .blocking }
        return ToolFactoryStaticValidationReport(passed: passed,
                                                 issues: issues,
                                                 duplicateFindings: duplicates)
    }

    private static let forbiddenCapabilityIDs: Set<String> = [
        "shell.arbitrary",
        "shell.packageInstall",
        "git.push",
        "keychain.generalRead",
        "filesystem.moveToTrash",
        "contacts.read",
        "network.upload",
    ]

    private static let forbiddenSourceTerms = [
        "URLSession",
        "curl",
        "http://",
        "https://",
        "Keychain",
        "SecItem",
        "FileManager.default.homeDirectoryForCurrentUser",
        "/Users/",
        "/Volumes/",
        "ToolRegistry",
        "registerAgentTool",
        "register(",
        "Package.swift",
        "Sources/",
        ".git",
        "rm -",
        "git push",
    ]
}

public enum ToolFactoryLifecycleState: String, Codable, Sendable, Hashable {
    case capabilityGapDetected
    case workflowCompositionAttempt
    case ephemeralToolDesigned
    case staticValidation
    case sandboxTesting
    case adversarialReview
    case currentTaskExecution
    case resultVerification
    case reusableCandidate
    case promotionReview
    case reusableTool
    case deprecated
    case rejected
    case rolledBack
}

public enum ToolFactoryAuditEventKind: String, Codable, Sendable, Hashable {
    case proposed
    case staticValidationPassed
    case staticValidationFailed
    case sandboxStarted
    case sandboxPassed
    case sandboxFailed
    case executionStarted
    case executionPassed
    case executionFailed
    case verificationPassed
    case verificationFailed
    case reusableCandidateCreated
    case promotionRejected
    case promoted
    case rolledBack
}

public struct ToolFactoryAuditEvent: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var toolID: ToolID
    public var kind: ToolFactoryAuditEventKind
    public var timestamp: Date
    public var summary: String

    public init(id: UUID = UUID(),
                toolID: ToolID,
                kind: ToolFactoryAuditEventKind,
                timestamp: Date,
                summary: String) {
        self.id = id
        self.toolID = toolID
        self.kind = kind
        self.timestamp = timestamp
        self.summary = AgentPrivacyRedactor.safeSummary(summary, fallback: kind.rawValue)
    }
}

public struct EphemeralToolVerificationReport: Codable, Sendable, Hashable {
    public var verdict: PlanVerificationVerdict
    public var criteria: [CompletionCriterionResult]
    public var issues: [ToolSchemaValidationIssue]
    public var evidenceIDs: [String]

    public init(verdict: PlanVerificationVerdict,
                criteria: [CompletionCriterionResult],
                issues: [ToolSchemaValidationIssue] = [],
                evidenceIDs: [String] = []) {
        self.verdict = verdict
        self.criteria = criteria
        self.issues = issues
        self.evidenceIDs = evidenceIDs.map(AgentEventRedactor.safeIdentifier)
    }

    public var passed: Bool { verdict == .pass || verdict == .partialPass }
}

public struct EphemeralToolRunReport: Sendable, Equatable {
    public var status: ToolExecutionStatus
    public var result: ToolExecutionResult?
    public var observation: AgentToolObservation
    public var evidence: AgentEvidenceRecord
    public var verification: EphemeralToolVerificationReport

    public init(status: ToolExecutionStatus,
                result: ToolExecutionResult?,
                observation: AgentToolObservation,
                evidence: AgentEvidenceRecord,
                verification: EphemeralToolVerificationReport) {
        self.status = status
        self.result = result
        self.observation = observation
        self.evidence = evidence
        self.verification = verification
    }
}

public protocol EphemeralToolSandboxRunning: Sendable {
    func run(proposal: EphemeralToolProposal, arguments: AgentJSONValue) async throws -> ToolExecutionResult
}

public struct ToolFactoryDefaultDenyPermissionGate: PermissionGate {
    public init() {}

    public func evaluate(capabilityID: String,
                         reason: String,
                         correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: false,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired,
                            denialReason: "ToolFactory requires an injected PermissionGate")
    }
}

public struct RestrictedEphemeralToolRunner: EphemeralToolSandboxRunning {
    public init() {}

    public func run(proposal: EphemeralToolProposal, arguments: AgentJSONValue) async throws -> ToolExecutionResult {
        try Task.checkCancellation()
        if let deniedPath = EphemeralPathPolicy.deniedPath(in: arguments, workspaceRoot: proposal.taskWorkspacePath) {
            return ToolExecutionResult(status: .denied,
                                       userSafeSummary: "临时工具拒绝访问未授权路径",
                                       structuredData: .object([
                                           "status": .string("denied"),
                                           "reason": .string("unauthorized_path"),
                                           "path": .string(deniedPath),
                                       ]))
        }
        if let delay = arguments.numberValue(for: "delayMilliseconds"), delay > 0 {
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000))
            try Task.checkCancellation()
        }
        switch proposal.operation {
        case .sortUniqueNumbers:
            let values = arguments.arrayValue(for: "items")?.compactMap(\.numberValue) ?? []
            let unique = Array(Set(values)).sorted()
            return ToolExecutionResult(status: .success,
                                       userSafeSummary: "已完成临时排序去重",
                                       structuredData: .object([
                                           "status": .string("success"),
                                           "items": .array(unique.map(AgentJSONValue.number)),
                                           "itemCount": .number(Double(unique.count)),
                                           "workspace": .string(proposal.taskWorkspacePath),
                                           "ephemeral": .bool(true),
                                       ]))
        case .sortUniqueStrings:
            let values = arguments.arrayValue(for: "items")?.compactMap(\.plainStringValue) ?? []
            let unique = Array(Set(values)).sorted()
            return ToolExecutionResult(status: .success,
                                       userSafeSummary: "已完成临时文本排序去重",
                                       structuredData: .object([
                                           "status": .string("success"),
                                           "items": .array(unique.map(AgentJSONValue.string)),
                                           "itemCount": .number(Double(unique.count)),
                                           "workspace": .string(proposal.taskWorkspacePath),
                                           "ephemeral": .bool(true),
                                       ]))
        case .sumNumbers:
            let values = arguments.arrayValue(for: "items")?.compactMap(\.numberValue) ?? []
            let sum = values.reduce(0, +)
            return ToolExecutionResult(status: .success,
                                       userSafeSummary: "已完成临时求和",
                                       structuredData: .object([
                                           "status": .string("success"),
                                           "sum": .number(sum),
                                           "itemCount": .number(Double(values.count)),
                                           "workspace": .string(proposal.taskWorkspacePath),
                                           "ephemeral": .bool(true),
                                       ]))
        }
    }
}

public struct EphemeralToolOutputVerifier: Sendable {
    public init() {}

    public func verify(proposal: EphemeralToolProposal,
                       result: ToolExecutionResult,
                       evidence: AgentEvidenceRecord) -> EphemeralToolVerificationReport {
        var criteria: [CompletionCriterionResult] = []
        var issues: [ToolSchemaValidationIssue] = []
        if result.status == .success || result.status == .partial {
            criteria.append(CompletionCriterionResult(id: "tool_status",
                                                      status: .passed,
                                                      evidenceIDs: [evidence.id],
                                                      message: "临时工具返回成功状态"))
        } else {
            criteria.append(CompletionCriterionResult(id: "tool_status",
                                                      status: .failed,
                                                      evidenceIDs: [evidence.id],
                                                      message: "临时工具未成功执行"))
        }

        let schema = ToolSchemaValidator.validate(result.structuredData, against: proposal.outputSchema)
        if schema.accepted {
            criteria.append(CompletionCriterionResult(id: "output_schema",
                                                      status: .passed,
                                                      evidenceIDs: [evidence.id],
                                                      message: "输出通过 Schema 验证"))
        } else {
            issues = schema.issues
            criteria.append(CompletionCriterionResult(id: "output_schema",
                                                      status: .failed,
                                                      evidenceIDs: [evidence.id],
                                                      message: "输出未通过 Schema 验证"))
        }

        if result.structuredData.boolValue(for: "registerTool") == true {
            criteria.append(CompletionCriterionResult(id: "no_self_registration",
                                                      status: .failed,
                                                      evidenceIDs: [evidence.id],
                                                      message: "临时工具试图自我注册"))
        } else {
            criteria.append(CompletionCriterionResult(id: "no_self_registration",
                                                      status: .passed,
                                                      evidenceIDs: [evidence.id],
                                                      message: "未发现自我注册请求"))
        }

        let passed = criteria.allSatisfy { $0.status == .passed }
        return EphemeralToolVerificationReport(verdict: passed ? .pass : .fail,
                                               criteria: criteria,
                                               issues: issues,
                                               evidenceIDs: [evidence.id])
    }
}

public enum ToolFactoryPromotionResult: Sendable, Equatable {
    case promoted(version: Int)
    case rejected(reason: String)
}

public struct ToolFactoryRecord: Sendable, Equatable {
    public var proposal: EphemeralToolProposal
    public var staticValidation: ToolFactoryStaticValidationReport
    public var lastSandboxReport: EphemeralToolRunReport?
    public var lastExecutionReport: EphemeralToolRunReport?
    public var lifecycle: [ToolFactoryLifecycleState]

    public init(proposal: EphemeralToolProposal,
                staticValidation: ToolFactoryStaticValidationReport,
                lastSandboxReport: EphemeralToolRunReport? = nil,
                lastExecutionReport: EphemeralToolRunReport? = nil,
                lifecycle: [ToolFactoryLifecycleState]) {
        self.proposal = proposal
        self.staticValidation = staticValidation
        self.lastSandboxReport = lastSandboxReport
        self.lastExecutionReport = lastExecutionReport
        self.lifecycle = lifecycle
    }

    public var currentState: ToolFactoryLifecycleState {
        lifecycle.last ?? .capabilityGapDetected
    }
}

public actor ToolFactory {
    private let releaseCatalog: ToolCatalogSnapshot
    private let permissionGate: any PermissionGate
    private let staticValidator: ToolFactoryStaticValidator
    private let outputVerifier: EphemeralToolOutputVerifier
    private let clock: RuntimeClock
    private var records: [ToolID: ToolFactoryRecord] = [:]
    private var reusableRegistry: [ToolID: ToolManifest] = [:]
    private var auditEvents: [ToolFactoryAuditEvent] = []

    public init(releaseCatalog: ToolCatalogSnapshot = .empty,
                permissionGate: any PermissionGate = ToolFactoryDefaultDenyPermissionGate(),
                staticValidator: ToolFactoryStaticValidator = ToolFactoryStaticValidator(),
                outputVerifier: EphemeralToolOutputVerifier = EphemeralToolOutputVerifier(),
                clock: RuntimeClock = WallClock()) {
        self.releaseCatalog = releaseCatalog
        self.permissionGate = permissionGate
        self.staticValidator = staticValidator
        self.outputVerifier = outputVerifier
        self.clock = clock
    }

    @discardableResult
    public func propose(_ proposal: EphemeralToolProposal) -> ToolFactoryStaticValidationReport {
        let generatedIDs = Set(records.keys)
        let report = staticValidator.validate(proposal,
                                              existingCatalog: releaseCatalog,
                                              generatedIDs: generatedIDs)
        let lifecycle: [ToolFactoryLifecycleState] = report.passed
            ? [.capabilityGapDetected, .ephemeralToolDesigned, .staticValidation]
            : [.capabilityGapDetected, .ephemeralToolDesigned, .staticValidation, .rejected]
        records[proposal.id] = ToolFactoryRecord(proposal: proposal,
                                                 staticValidation: report,
                                                 lifecycle: lifecycle)
        audit(.proposed, toolID: proposal.id, summary: "ephemeral tool proposed")
        audit(report.passed ? .staticValidationPassed : .staticValidationFailed,
              toolID: proposal.id,
              summary: report.passed ? "static validation passed" : "static validation failed")
        return report
    }

    public func record(for toolID: ToolID) -> ToolFactoryRecord? {
        records[toolID]
    }

    public func auditLog() -> [ToolFactoryAuditEvent] {
        auditEvents
    }

    public func reusableRegistrySnapshot() -> ToolCatalogSnapshot {
        ToolCatalogSnapshot(entries: reusableRegistry.values.map {
            ToolCatalogEntry(manifest: $0, enabled: true)
        })
    }

    public func sandboxVerify(toolID: ToolID,
                              arguments: AgentJSONValue,
                              runner: any EphemeralToolSandboxRunning = RestrictedEphemeralToolRunner(),
                              taskID: UUID = UUID()) async -> EphemeralToolRunReport {
        guard var record = records[toolID], record.staticValidation.passed else {
            return syntheticReport(toolID: toolID,
                                   taskID: taskID,
                                   status: .denied,
                                   summary: "静态验证未通过",
                                   content: .object(["status": .string("denied")]))
        }
        append(.sandboxTesting, to: &record)
        records[toolID] = record
        audit(.sandboxStarted, toolID: toolID, summary: "sandbox verification started")
        if let denial = await authorizationDenial(for: record.proposal, taskID: taskID, phase: "sandbox") {
            let report = syntheticReport(toolID: toolID,
                                         taskID: taskID,
                                         status: .denied,
                                         summary: denial,
                                         content: .object([
                                             "status": .string("denied"),
                                             "reason": .string("permission_gate_denied"),
                                         ]))
            record.lastSandboxReport = report
            append(.rejected, to: &record)
            records[toolID] = record
            audit(.sandboxFailed, toolID: toolID, summary: "permission gate denied sandbox")
            return report
        }
        let report = await run(record.proposal, arguments: arguments, runner: runner, taskID: taskID)
        record.lastSandboxReport = report
        if report.status == .success && report.verification.passed {
            append(.adversarialReview, to: &record)
            audit(.sandboxPassed, toolID: toolID, summary: "sandbox verification passed")
        } else {
            append(.rejected, to: &record)
            audit(.sandboxFailed, toolID: toolID, summary: "sandbox verification failed")
        }
        records[toolID] = record
        return report
    }

    public func executeCurrentTask(toolID: ToolID,
                                   arguments: AgentJSONValue,
                                   runner: any EphemeralToolSandboxRunning = RestrictedEphemeralToolRunner(),
                                   taskID: UUID = UUID()) async -> EphemeralToolRunReport {
        guard var record = records[toolID],
              record.staticValidation.passed,
              record.lifecycle.contains(.adversarialReview) else {
            return syntheticReport(toolID: toolID,
                                   taskID: taskID,
                                   status: .denied,
                                   summary: "临时工具尚未通过沙盒验证",
                                   content: .object(["status": .string("denied")]))
        }
        append(.currentTaskExecution, to: &record)
        records[toolID] = record
        audit(.executionStarted, toolID: toolID, summary: "current task execution started")
        if let denial = await authorizationDenial(for: record.proposal, taskID: taskID, phase: "execution") {
            let report = syntheticReport(toolID: toolID,
                                         taskID: taskID,
                                         status: .denied,
                                         summary: denial,
                                         content: .object([
                                             "status": .string("denied"),
                                             "reason": .string("permission_gate_denied"),
                                         ]))
            record.lastExecutionReport = report
            append(.resultVerification, to: &record)
            append(.rejected, to: &record)
            records[toolID] = record
            audit(.executionFailed, toolID: toolID, summary: "permission gate denied execution")
            audit(.verificationFailed, toolID: toolID, summary: "result verification failed")
            return report
        }
        let report = await run(record.proposal, arguments: arguments, runner: runner, taskID: taskID)
        record.lastExecutionReport = report
        append(.resultVerification, to: &record)
        if report.status == .success && report.verification.passed {
            if record.proposal.promotionPolicy == .reusableCandidateAfterVerification {
                append(.reusableCandidate, to: &record)
                audit(.reusableCandidateCreated, toolID: toolID, summary: "reusable candidate only; not promoted")
            }
            audit(.executionPassed, toolID: toolID, summary: "current task execution passed")
            audit(.verificationPassed, toolID: toolID, summary: "result verification passed")
        } else {
            append(.rejected, to: &record)
            audit(.executionFailed, toolID: toolID, summary: "current task execution failed")
            audit(.verificationFailed, toolID: toolID, summary: "result verification failed")
        }
        records[toolID] = record
        return report
    }

    public func promote(toolID: ToolID, approved: Bool) -> ToolFactoryPromotionResult {
        guard var record = records[toolID] else {
            return .rejected(reason: "unknown tool")
        }
        append(.promotionReview, to: &record)
        guard approved else {
            records[toolID] = record
            audit(.promotionRejected, toolID: toolID, summary: "promotion rejected")
            return .rejected(reason: "未经用户批准")
        }
        guard record.lifecycle.contains(.reusableCandidate),
              record.lastExecutionReport?.status == .success,
              record.lastExecutionReport?.verification.passed == true else {
            records[toolID] = record
            audit(.promotionRejected, toolID: toolID, summary: "not a verified reusable candidate")
            return .rejected(reason: "尚未形成已验证的可复用候选")
        }
        guard releaseCatalog.lookup(toolID) == nil,
              reusableRegistry[toolID] == nil else {
            records[toolID] = record
            audit(.promotionRejected, toolID: toolID, summary: "duplicate reusable tool")
            return .rejected(reason: "工具 ID 重复")
        }
        var manifest = record.proposal.manifest
        manifest.version = max(manifest.version, record.proposal.versionMetadata.version)
        reusableRegistry[toolID] = manifest
        append(.reusableTool, to: &record)
        records[toolID] = record
        audit(.promoted, toolID: toolID, summary: "promoted to reusable review registry")
        return .promoted(version: manifest.version)
    }

    @discardableResult
    public func rollback(toolID: ToolID) -> Bool {
        guard var record = records[toolID] else { return false }
        reusableRegistry.removeValue(forKey: toolID)
        append(.rolledBack, to: &record)
        records[toolID] = record
        audit(.rolledBack, toolID: toolID, summary: "rolled back")
        return true
    }

    private func run(_ proposal: EphemeralToolProposal,
                     arguments: AgentJSONValue,
                     runner: any EphemeralToolSandboxRunning,
                     taskID: UUID) async -> EphemeralToolRunReport {
        let request = AgentToolCallRequest(callID: "ephemeral-\(proposal.id.rawValue)",
                                           toolName: proposal.id.rawValue,
                                           arguments: arguments,
                                           userVisibleSummary: proposal.manifest.userVisibleExecutionSummary)
        do {
            let result = try await withTimeout(seconds: proposal.manifest.executionCharacteristics.timeoutSeconds) {
                try await runner.run(proposal: proposal, arguments: arguments)
            }
            return report(for: request, proposal: proposal, result: result, taskID: taskID)
        } catch is RuntimeTimeoutError {
            return syntheticReport(request: request,
                                   proposal: proposal,
                                   taskID: taskID,
                                   status: .timedOut,
                                   summary: "临时工具执行超时",
                                   content: .object(["status": .string("timedOut")]))
        } catch is CancellationError {
            return syntheticReport(request: request,
                                   proposal: proposal,
                                   taskID: taskID,
                                   status: .cancelled,
                                   summary: "临时工具已取消",
                                   content: .object(["status": .string("cancelled")]))
        } catch {
            return syntheticReport(request: request,
                                   proposal: proposal,
                                   taskID: taskID,
                                   status: .failed,
                                   summary: "临时工具执行失败",
                                   content: .object(["status": .string("failed")]))
        }
    }

    private func authorizationDenial(for proposal: EphemeralToolProposal,
                                     taskID: UUID,
                                     phase: String) async -> String? {
        let capabilityIDs = proposal.manifest.permissionRequirement.p6CapabilityIDs
        guard !capabilityIDs.isEmpty else { return "临时工具缺少 Permission Gate capability" }
        for capabilityID in capabilityIDs {
            let permission = await permissionGate.evaluate(capabilityID: capabilityID,
                                                           reason: "toolFactory:\(phase):\(proposal.id.rawValue)",
                                                           correlationID: taskID)
            if !permission.isExecutable {
                return permission.denialReason ?? "permission denied"
            }
        }
        return nil
    }

    private func report(for request: AgentToolCallRequest,
                        proposal: EphemeralToolProposal,
                        result: ToolExecutionResult,
                        taskID: UUID) -> EphemeralToolRunReport {
        let observation = DefaultObservationSanitizer().observation(for: request,
                                                                    result: result,
                                                                    maxCharacters: 2_000)
        let evidence = AgentEvidenceRecord.from(observation: observation,
                                                taskID: taskID,
                                                capturedAt: clock.now())
        let verification = outputVerifier.verify(proposal: proposal,
                                                 result: result,
                                                 evidence: evidence)
        let finalStatus: ToolExecutionStatus
        if verification.passed {
            finalStatus = result.status
        } else if result.status == .timedOut || result.status == .cancelled || result.status == .denied {
            finalStatus = result.status
        } else {
            finalStatus = .failed
        }
        return EphemeralToolRunReport(status: finalStatus,
                                      result: result,
                                      observation: observation,
                                      evidence: evidence,
                                      verification: verification)
    }

    private func syntheticReport(toolID: ToolID,
                                 taskID: UUID,
                                 status: ToolExecutionStatus,
                                 summary: String,
                                 content: AgentJSONValue) -> EphemeralToolRunReport {
        let manifest = ToolManifest(id: toolID,
                                    displayName: toolID.rawValue,
                                    shortDescription: summary,
                                    category: .utility,
                                    riskLevel: .localReadOnlyNoPrivateData,
                                    permissionRequirement: .capability("state.read"),
                                    inputSchema: .strictEmptyObject,
                                    outputContract: ToolOutputContract(description: "synthetic failure"),
                                    userVisibleExecutionSummary: summary)
        let proposal = EphemeralToolProposal(manifest: manifest,
                                             operation: .sortUniqueNumbers,
                                             source: "synthetic",
                                             taskWorkspacePath: "/private/tmp/deskpet-ephemeral-synthetic",
                                             outputSchema: ToolJSONSchema(type: .object, additionalProperties: true))
        let request = AgentToolCallRequest(callID: "ephemeral-\(toolID.rawValue)",
                                           toolName: toolID.rawValue,
                                           arguments: .object([:]),
                                           userVisibleSummary: summary)
        return syntheticReport(request: request,
                               proposal: proposal,
                               taskID: taskID,
                               status: status,
                               summary: summary,
                               content: content)
    }

    private func syntheticReport(request: AgentToolCallRequest,
                                 proposal: EphemeralToolProposal,
                                 taskID: UUID,
                                 status: ToolExecutionStatus,
                                 summary: String,
                                 content: AgentJSONValue) -> EphemeralToolRunReport {
        let result = ToolExecutionResult(status: status,
                                         userSafeSummary: summary,
                                         structuredData: content)
        return report(for: request, proposal: proposal, result: result, taskID: taskID)
    }

    private func append(_ state: ToolFactoryLifecycleState, to record: inout ToolFactoryRecord) {
        if record.lifecycle.last != state {
            record.lifecycle.append(state)
        }
    }

    private func audit(_ kind: ToolFactoryAuditEventKind, toolID: ToolID, summary: String) {
        auditEvents.append(ToolFactoryAuditEvent(toolID: toolID,
                                                 kind: kind,
                                                 timestamp: clock.now(),
                                                 summary: summary))
    }
}

private enum EphemeralPathPolicy {
    static func normalized(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return URL(fileURLWithPath: trimmed).standardizedFileURL.path
    }

    static func validateWorkspaceRoot(_ root: String) -> ToolFactoryIssue? {
        let normalizedRoot = normalized(root)
        guard normalizedRoot.hasPrefix("/") else {
            return ToolFactoryIssue(id: "workspace_not_absolute",
                                    severity: .blocking,
                                    message: "task workspace 必须是绝对路径")
        }
        let parts = normalizedRoot.split(separator: "/")
        guard parts.count >= 2, normalizedRoot != "/" else {
            return ToolFactoryIssue(id: "workspace_too_broad",
                                    severity: .blocking,
                                    message: "task workspace 不能指向全盘或过宽目录")
        }
        if normalizedRoot.contains("/.git") || normalizedRoot.hasSuffix("/Sources") {
            return ToolFactoryIssue(id: "workspace_points_to_source",
                                    severity: .blocking,
                                    message: "task workspace 不能指向源码或 Git 目录")
        }
        return nil
    }

    static func deniedPath(in value: AgentJSONValue, workspaceRoot: String) -> String? {
        deniedPath(in: value, workspaceRoot: normalized(workspaceRoot), keyPath: [])
    }

    private static func deniedPath(in value: AgentJSONValue,
                                   workspaceRoot: String,
                                   keyPath: [String]) -> String? {
        switch value {
        case .object(let object):
            for (key, child) in object {
                let next = keyPath + [key]
                if key.localizedCaseInsensitiveContains("path"),
                   case .string(let path) = child,
                   !isAllowed(path, workspaceRoot: workspaceRoot) {
                    return path
                }
                if let denied = deniedPath(in: child, workspaceRoot: workspaceRoot, keyPath: next) {
                    return denied
                }
            }
            return nil
        case .array(let values):
            for value in values {
                if let denied = deniedPath(in: value, workspaceRoot: workspaceRoot, keyPath: keyPath) {
                    return denied
                }
            }
            return nil
        case .null, .bool, .number, .string:
            return nil
        }
    }

    private static func isAllowed(_ path: String, workspaceRoot: String) -> Bool {
        let normalizedPath = normalized(path)
        guard normalizedPath == workspaceRoot || normalizedPath.hasPrefix(workspaceRoot + "/") else {
            return false
        }
        if normalizedPath.contains("/.git/")
            || normalizedPath.contains("/Sources/")
            || normalizedPath.hasSuffix("/Package.swift") {
            return false
        }
        return true
    }
}

private extension ToolPermissionRequirement {
    var p6CapabilityIDs: [String] {
        switch self {
        case .none, .systemPermission:
            return []
        case .capability(let capabilityID):
            return [capabilityID]
        case .capabilityAndSystemPermission(let capabilityID, _):
            return [capabilityID]
        }
    }
}

private extension AgentJSONValue {
    var plainStringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    func arrayValue(for key: String) -> [AgentJSONValue]? {
        guard case .object(let object) = self,
              case .array(let values)? = object[key] else { return nil }
        return values
    }

    func numberValue(for key: String) -> Double? {
        guard case .object(let object) = self,
              case .number(let value)? = object[key] else { return nil }
        return value
    }

    func boolValue(for key: String) -> Bool? {
        guard case .object(let object) = self,
              case .bool(let value)? = object[key] else { return nil }
        return value
    }
}
