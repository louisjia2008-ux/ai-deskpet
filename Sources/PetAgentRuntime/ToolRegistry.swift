import Foundation
import AICore
import PetBrainCore

// P5.0 introduced the first registry; P4-A keeps that compatibility surface but makes this actor the
// authoritative Tool Platform registry. Release tools are `AgentTool`s with manifests, schema
// validation, typed inputs/results, immutable per-turn snapshots, and policy filtering. Legacy
// `RuntimeTool`s remain only as a migration/test boundary.

public enum RuntimeToolError: Error, Equatable, Sendable {
    case duplicateIdentifier(String)
    case notFound(String)
    case capabilityNotPermitted(String)
    case timedOut
    case cancelled
    case executionFailed(String)
}

public struct ToolInvocationResult: Sendable, Equatable {
    public var ok: Bool
    public var output: String
    public var error: String?
    public init(ok: Bool, output: String = "", error: String? = nil) {
        self.ok = ok; self.output = output; self.error = error
    }
}

/// The minimal dependencies a tool is allowed to see. Deliberately tiny so tools cannot reach into
/// app state. `diagnostics` lets read-only tools report runtime status without any privileged access.
public struct ToolContext: Sendable {
    public let correlationID: UUID?
    public let clock: RuntimeClock
    public let diagnostics: @Sendable () async -> RuntimeDiagnosticsSnapshot

    public init(correlationID: UUID?, clock: RuntimeClock,
                diagnostics: @escaping @Sendable () async -> RuntimeDiagnosticsSnapshot = { .empty }) {
        self.correlationID = correlationID
        self.clock = clock
        self.diagnostics = diagnostics
    }
}

public protocol RuntimeTool: Sendable {
    var identifier: String { get }
    var displayName: String { get }
    var toolDescription: String { get }
    var requiredCapabilities: [String] { get }
    var riskLevel: ToolRiskLevel { get }
    var timeout: TimeInterval { get }
    func execute(arguments: [String: String], context: ToolContext) async throws -> ToolInvocationResult
}

public actor ToolRegistry: ToolCatalogProviding, ToolPlatformExecuting {
    private var tools: [String: any RuntimeTool] = [:]
    private var agentTools: [ToolID: AnyAgentTool] = [:]
    private let gate: PermissionGate
    private let audit: RuntimeAuditSink
    private let bus: RuntimeEventBus?
    private let clock: RuntimeClock
    private let toolPolicy: any ToolPolicyStore
    private let sideEffectLedgerStore: AgentSideEffectLedgerStore?
    private let postExecuteHooks: ToolPostExecuteHookChain

    public init(gate: PermissionGate, audit: RuntimeAuditSink,
                bus: RuntimeEventBus? = nil,
                clock: RuntimeClock = WallClock(),
                toolPolicy: any ToolPolicyStore = AllowAllToolPolicyStore(),
                sideEffectLedgerStore: AgentSideEffectLedgerStore? = nil,
                postExecuteHooks: ToolPostExecuteHookChain = ToolPostExecuteHookChain(hooks: [PrivacyToolPostExecuteHook()])) {
        self.gate = gate
        self.audit = audit
        self.bus = bus
        self.clock = clock
        self.toolPolicy = toolPolicy
        self.sideEffectLedgerStore = sideEffectLedgerStore
        self.postExecuteHooks = postExecuteHooks
    }

    public func register(_ tool: any RuntimeTool) async throws {
        guard tools[tool.identifier] == nil else {
            throw RuntimeToolError.duplicateIdentifier(tool.identifier)
        }
        guard agentTools[ToolID(rawValue: tool.identifier)] == nil else {
            throw RuntimeToolError.duplicateIdentifier(tool.identifier)
        }
        tools[tool.identifier] = tool
        await audit.record(RuntimeAuditEvent(kind: .toolRegistered, summary: tool.identifier, timestamp: clock.now()))
        await bus?.publish(.toolRegistered(tool.identifier))
    }

    public func register<T: AgentTool>(_ tool: T) async throws {
        try await registerAgentTool(AnyAgentTool(tool))
    }

    public func registerAgentTool(_ tool: AnyAgentTool) async throws {
        let id = tool.manifest.id
        guard agentTools[id] == nil else {
            throw ToolPlatformError.duplicateRegistration(id.rawValue)
        }
        guard tools[id.rawValue] == nil else {
            throw ToolPlatformError.duplicateRegistration(id.rawValue)
        }
        agentTools[id] = tool
        await audit.record(RuntimeAuditEvent(kind: .toolRegistered, summary: id.rawValue, timestamp: clock.now()))
        await bus?.publish(.toolRegistered(id.rawValue))
    }

    public func count() -> Int { tools.count + agentTools.count }
    public func identifiers() -> [String] {
        Array(Set(tools.keys).union(agentTools.keys.map(\.rawValue))).sorted()
    }
    public func lookup(_ identifier: String) -> (any RuntimeTool)? { tools[identifier] }
    public func manifest(for identifier: String) -> ToolManifest? {
        agentTools[ToolID(rawValue: identifier)]?.manifest
    }

    public func toolCatalogSnapshot(for policy: AgentPolicy) async -> ToolCatalogSnapshot {
        guard policy.allowTools else { return .empty }
        var entries: [ToolCatalogEntry] = []
        for tool in agentTools.values {
            let manifest = tool.manifest
            guard manifest.availability == .available else { continue }
            if let capabilityID = manifest.permissionRequirement.capabilityID,
               let capability = CapabilityCatalog.lookup(capabilityID),
               policy.tier.isPermanentlyDenied(capability) {
                continue
            }
            if let allowlist = policy.capabilityAllowlist,
               let capabilityID = manifest.permissionRequirement.capabilityID,
               !allowlist.contains(capabilityID),
               !allowlist.contains(manifest.id.rawValue) {
                continue
            }
            let enabled = await toolPolicy.isToolEnabled(manifest.id)
            guard enabled else { continue }
            entries.append(ToolCatalogEntry(manifest: manifest, enabled: enabled))
        }
        return ToolCatalogSnapshot(entries: entries)
    }

    public func invoke(_ identifier: String, arguments: [String: String],
                       context: ToolContext) async -> Result<ToolInvocationResult, RuntimeToolError> {
        guard let tool = tools[identifier] else { return .failure(.notFound(identifier)) }

        for capability in tool.requiredCapabilities {
            let permission = await gate.evaluate(capabilityID: capability,
                                                 reason: "tool:\(identifier)",
                                                 correlationID: context.correlationID)
            guard permission.isExecutable else {
                await audit.record(RuntimeAuditEvent(kind: .toolInvocationFailed, capabilityID: capability,
                                                     correlationID: context.correlationID,
                                                     summary: "capabilityNotPermitted", timestamp: clock.now()))
                return .failure(.capabilityNotPermitted(capability))
            }
        }

        await bus?.publish(.toolInvocationStarted(identifier))
        await audit.record(RuntimeAuditEvent(kind: .toolInvocationStarted, correlationID: context.correlationID,
                                             summary: identifier, timestamp: clock.now()))
        do {
            let result = try await withTimeout(seconds: tool.timeout) {
                try await tool.execute(arguments: arguments, context: context)
            }
            await bus?.publish(.toolInvocationFinished(identifier, ok: result.ok))
            await audit.record(RuntimeAuditEvent(kind: .toolInvocationFinished, correlationID: context.correlationID,
                                                 summary: "\(identifier) ok=\(result.ok)", timestamp: clock.now()))
            return .success(result)
        } catch is RuntimeTimeoutError {
            await audit.record(RuntimeAuditEvent(kind: .timeout, correlationID: context.correlationID,
                                                 summary: identifier, timestamp: clock.now()))
            return .failure(.timedOut)
        } catch is CancellationError {
            await audit.record(RuntimeAuditEvent(kind: .cancellation, correlationID: context.correlationID,
                                                 summary: identifier, timestamp: clock.now()))
            return .failure(.cancelled)
        } catch {
            return .failure(.executionFailed("\(error)"))
        }
    }

    public func executeTool(request: AgentToolCallRequest,
                            context: ToolExecutionContext) async -> Result<ToolExecutionResult, ToolPlatformError> {
        let id = ToolID(rawValue: request.toolName)
        guard let tool = agentTools[id] else {
            return .failure(.unknownTool(id.rawValue))
        }
        guard tool.manifest.availability == .available else {
            return .failure(.toolUnavailable(id.rawValue))
        }
        let validation = ToolSchemaValidator.validate(request.arguments,
                                                      against: tool.manifest.inputSchema)
        guard validation.accepted else {
            return .failure(.schemaValidationFailed(validation.issues))
        }
        if !context.permissionAlreadyEvaluated {
            for capabilityID in tool.manifest.permissionRequirement.capabilityIDs {
                let permission = await gate.evaluate(capabilityID: capabilityID,
                                                     reason: "tool:\(id.rawValue)",
                                                     correlationID: context.taskID)
                guard permission.isExecutable else {
                    await audit.record(RuntimeAuditEvent(kind: .permissionDenied,
                                                         capabilityID: capabilityID,
                                                         correlationID: context.taskID,
                                                         summary: RuntimeAuditRedactor.redact(permission.denialReason ?? "permission denied"),
                                                         timestamp: clock.now()))
                    return .failure(.permissionDenied(capabilityID))
                }
            }
        }
        let sideEffectOperation: String?
        if tool.manifest.requiresDurableSideEffect,
           let taskID = context.taskID,
           let runID = context.runID,
           let sideEffectLedgerStore {
            let idempotencyKey = AgentSideEffectLedgerStore.idempotencyKey(taskID: taskID,
                                                                          runID: runID,
                                                                          toolID: id,
                                                                          arguments: request.arguments)
            let operationID = idempotencyKey
            do {
                let begin = try await sideEffectLedgerStore.begin(operationID: operationID,
                                                                  idempotencyKey: idempotencyKey,
                                                                  taskID: taskID,
                                                                  runID: runID,
                                                                  toolID: id,
                                                                  capabilityID: tool.manifest.permissionRequirement.capabilityID,
                                                                  operationKind: tool.manifest.riskLevel.durableOperationKind,
                                                                  arguments: request.arguments,
                                                                  retryPolicy: AgentRetryPolicy(maxAttempts: 1),
                                                                  at: clock.now())
                switch begin {
                case .started(let operation):
                    sideEffectOperation = operation
                case .alreadySucceeded(let result):
                    await audit.record(RuntimeAuditEvent(kind: .toolInvocationFinished,
                                                         correlationID: UUID(uuidString: context.callID),
                                                         summary: "\(id.rawValue) reused durable side effect",
                                                         timestamp: clock.now()))
                    // INV-RESULT-06 — Replay must apply the canonical transformation to a
                    // previously persisted result. Pre-P13.1 ledger entries may contain raw
                    // pre-hook content; re-applying the chain keeps replay safe under the
                    // current policy.
                    let identity = ToolExecutionIdentity(toolID: id.rawValue,
                                                        callID: context.callID,
                                                        taskID: context.taskID,
                                                        runID: context.runID)
                    let replayed = postExecuteHooks.run(ToolPostExecuteContext(
                        identity: identity,
                        toolArguments: Self.argumentsDictionary(request.arguments),
                        value: result.structuredData,
                        userSafeSummary: result.userSafeSummary,
                        modelContent: result.modelContent,
                        status: result.status))
                    var replayedResult = result
                    replayedResult.structuredData = replayed.value
                    replayedResult.userSafeSummary = replayed.userSafeSummary
                    replayedResult.modelContent = replayed.modelContent
                    // INV-FC-01 / INV-FC-05 / INV-FC-07 — Replay must also pass the
                    // canonical schema gate. A stricter future policy hook might
                    // restructure the result into a schema-invalid shape; replay must
                    // fail closed (controlled failure, no new ledger entry, no success
                    // observation to the model).
                    if let outputSchema = tool.manifest.outputContract.schema {
                        let replayValidation = ToolSchemaValidator.validate(replayedResult.structuredData,
                                                                           against: outputSchema)
                        if !replayValidation.accepted {
                            await audit.record(RuntimeAuditEvent(kind: .toolInvocationFailed,
                                                                 correlationID: UUID(uuidString: context.callID),
                                                                 summary: "\(id.rawValue) replay canonicalization failed output schema; failing closed",
                                                                 timestamp: clock.now()))
                            return .failure(.schemaValidationFailed(replayValidation.issues))
                        }
                    }
                    return .success(replayedResult)
                case .blockedOutcomeUnknown:
                    await audit.record(RuntimeAuditEvent(kind: .toolInvocationFailed,
                                                         correlationID: UUID(uuidString: context.callID),
                                                         summary: "\(id.rawValue) side effect outcome unknown",
                                                         timestamp: clock.now()))
                    return .failure(.executionFailed("side effect outcome unknown"))
                }
            } catch {
                return .failure(.executionFailed("side effect ledger unavailable"))
            }
        } else {
            sideEffectOperation = nil
        }
        await bus?.publish(.toolInvocationStarted(id.rawValue))
        await audit.record(RuntimeAuditEvent(kind: .toolInvocationStarted,
                                             correlationID: UUID(uuidString: context.callID),
                                             summary: id.rawValue,
                                             timestamp: clock.now()))
        let started = clock.now()
        do {
            let raw = try await withTimeout(seconds: tool.manifest.executionCharacteristics.timeoutSeconds) {
                try await tool.execute(arguments: request.arguments, context: context)
            }
            var result = raw.limited(to: tool.manifest.executionCharacteristics.maxResultBytes)
            let duration = Int(clock.now().timeIntervalSince(started) * 1_000)
            if result.metadata.durationMilliseconds == nil {
                result.metadata.durationMilliseconds = max(0, duration)
            }
            if let outputSchema = tool.manifest.outputContract.schema {
                let outputValidation = ToolSchemaValidator.validate(result.structuredData, against: outputSchema)
                guard outputValidation.accepted else {
                    if let operationID = sideEffectOperation,
                       let taskID = context.taskID,
                       let runID = context.runID,
                       let sideEffectLedgerStore {
                        try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                                  taskID: taskID,
                                                                  runID: runID,
                                                                  status: .failed,
                                                                  result: ToolExecutionResult(status: .failed,
                                                                                              userSafeSummary: "工具输出结构无效",
                                                                                              structuredData: .object(["error": .string("output schema validation failed")])),
                                                                  at: clock.now())
                    }
                    await context.logger.record(toolID: id, status: .failed, metadata: result.metadata)
                    await bus?.publish(.toolInvocationFinished(id.rawValue, ok: false))
                    await audit.record(RuntimeAuditEvent(kind: .toolInvocationFailed,
                                                         correlationID: UUID(uuidString: context.callID),
                                                         summary: "\(id.rawValue) output schema validation failed",
                                                         timestamp: clock.now()))
                    return .failure(.schemaValidationFailed(outputValidation.issues))
                }
            }
            // INV-RESULT-01 / INV-RESULT-03 / INV-RESULT-04 — Canonical transformation runs
            // AFTER raw contract validation and BEFORE the durable ledger / event emission
            // / return. The transformed (canonical safe) result is what becomes durable and
            // what reaches the model.
            let identity = ToolExecutionIdentity(toolID: id.rawValue,
                                                callID: context.callID,
                                                taskID: context.taskID,
                                                runID: context.runID)
            let rewritten = postExecuteHooks.run(ToolPostExecuteContext(
                identity: identity,
                toolArguments: Self.argumentsDictionary(request.arguments),
                value: result.structuredData,
                userSafeSummary: result.userSafeSummary,
                modelContent: result.modelContent,
                status: result.status))
            let mutatedValue = rewritten.value != result.structuredData
            let mutatedSummary = rewritten.userSafeSummary != result.userSafeSummary
            let mutatedModelContent = rewritten.modelContent != result.modelContent
            var canonical = result
            if mutatedValue || mutatedSummary || mutatedModelContent {
                canonical.structuredData = rewritten.value
                canonical.userSafeSummary = rewritten.userSafeSummary
                canonical.modelContent = rewritten.modelContent
            }
            // INV-FC-05 — Defense-in-depth content safety gate. The hook chain
            // is the primary defence; this gate guarantees the boundary is
            // self-defending even when (a) the chain is empty, (b) the first
            // hook returns nil, or (c) the protocol is widened to throwing in
            // the future. Apply leaf-level redaction to `structuredData` and
            // forbidden-token scrub to `modelContent`; if either indicates an
            // unsafe canonical value, fail closed.
            canonical.structuredData = PrivacyToolPostExecuteHook.redactLeaf(canonical.structuredData)
            if let modelContent = canonical.modelContent,
               PrivacyToolPostExecuteHook.containsForbiddenToken(modelContent) {
                canonical.modelContent = "[redacted]"
            }
            if !mutatedValue && !mutatedSummary && !mutatedModelContent {
                // Hooks did not mutate — the canonical value is the raw `result`.
                // The content safety gate above already redacted unsafe leaves.
                // If after redaction the structuredData still contains forbidden
                // tokens (e.g. when the leaves are not strings, or the hook
                // chain is empty), fail closed.
                if Self.containsForbiddenToken(in: canonical.structuredData) {
                    await audit.record(RuntimeAuditEvent(kind: .toolInvocationFailed,
                                                         correlationID: UUID(uuidString: context.callID),
                                                         summary: "\(id.rawValue) canonical content contained forbidden tokens; failing closed",
                                                         timestamp: clock.now()))
                    await context.logger.record(toolID: id, status: .failed, metadata: canonical.metadata)
                    await bus?.publish(.toolInvocationFinished(id.rawValue, ok: false))
                    if let operationID = sideEffectOperation,
                       let taskID = context.taskID,
                       let runID = context.runID,
                       let sideEffectLedgerStore {
                        try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                                  taskID: taskID,
                                                                  runID: runID,
                                                                  status: .failed,
                                                                  result: ToolExecutionResult(status: .failed,
                                                                                              userSafeSummary: "Tool result could not be safely processed.",
                                                                                              structuredData: .object(["error": .string("canonical content failed safety check")])),
                                                                  at: clock.now())
                    }
                    return .failure(.executionFailed("canonical content failed safety check"))
                }
            }
            // INV-FC-01 / INV-FC-05 / INV-FC-06 — Final canonical validation gate.
            // Whether or not hooks mutated, re-validate the canonical `structuredData`
            // against the declared output schema. On failure, do NOT fall back to the
            // raw result (a schema-valid raw result can still be unsafe: it may carry
            // forbidden privacy tokens that the hook chain was supposed to remove).
            // Resolve to a controlled semantic failure instead, per §10 / §11 / §12.
            if let outputSchema = tool.manifest.outputContract.schema {
                let canonicalValidation = ToolSchemaValidator.validate(canonical.structuredData,
                                                                      against: outputSchema)
                if !canonicalValidation.accepted {
                    await audit.record(RuntimeAuditEvent(kind: .toolInvocationFailed,
                                                         correlationID: UUID(uuidString: context.callID),
                                                         summary: "\(id.rawValue) canonical result failed output schema; failing closed",
                                                         timestamp: clock.now()))
                    await context.logger.record(toolID: id, status: .failed, metadata: canonical.metadata)
                    await bus?.publish(.toolInvocationFinished(id.rawValue, ok: false))
                    if let operationID = sideEffectOperation,
                       let taskID = context.taskID,
                       let runID = context.runID,
                       let sideEffectLedgerStore {
                        try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                                  taskID: taskID,
                                                                  runID: runID,
                                                                  status: .failed,
                                                                  result: ToolExecutionResult(status: .failed,
                                                                                              userSafeSummary: "Tool result could not be safely processed.",
                                                                                              structuredData: .object(["error": .string("canonical result validation failed")])),
                                                                  at: clock.now())
                    }
                    return .failure(.schemaValidationFailed(canonicalValidation.issues))
                }
            }
            await context.logger.record(toolID: id, status: canonical.status, metadata: canonical.metadata)
            await bus?.publish(.toolInvocationFinished(id.rawValue, ok: canonical.status == .success || canonical.status == .partial))
            await audit.record(RuntimeAuditEvent(kind: .toolInvocationFinished,
                                                 correlationID: UUID(uuidString: context.callID),
                                                 summary: "\(id.rawValue) status=\(canonical.status.rawValue) truncated=\(canonical.metadata.truncated) postHookRewritten=\(mutatedValue || mutatedSummary || mutatedModelContent)",
                                                 timestamp: clock.now()))
            if let operationID = sideEffectOperation,
               let taskID = context.taskID,
               let runID = context.runID,
               let sideEffectLedgerStore {
                try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                          taskID: taskID,
                                                          runID: runID,
                                                          status: canonical.status.sideEffectStatus,
                                                          result: canonical,
                                                          at: clock.now())
            }
            return .success(canonical)
        } catch is RuntimeTimeoutError {
            if let operationID = sideEffectOperation,
               let taskID = context.taskID,
               let runID = context.runID,
               let sideEffectLedgerStore {
                try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                          taskID: taskID,
                                                          runID: runID,
                                                          status: .failed,
                                                          result: ToolExecutionResult(status: .timedOut,
                                                                                      userSafeSummary: "工具执行超时",
                                                                                      structuredData: .object(["error": .string("timeout")])),
                                                          at: clock.now())
            }
            return .failure(.timedOut)
        } catch is CancellationError {
            if let operationID = sideEffectOperation,
               let taskID = context.taskID,
               let runID = context.runID,
               let sideEffectLedgerStore {
                try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                          taskID: taskID,
                                                          runID: runID,
                                                          status: .cancelled,
                                                          result: ToolExecutionResult(status: .cancelled,
                                                                                      userSafeSummary: "工具已取消",
                                                                                      structuredData: .object(["error": .string("cancelled")])),
                                                          at: clock.now())
            }
            return .failure(.cancelled)
        } catch let error as ToolPlatformError {
            if let operationID = sideEffectOperation,
               let taskID = context.taskID,
               let runID = context.runID,
               let sideEffectLedgerStore {
                try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                          taskID: taskID,
                                                          runID: runID,
                                                          status: .failed,
                                                          result: ToolExecutionResult(status: .failed,
                                                                                      userSafeSummary: "工具执行失败",
                                                                                      structuredData: .object(["error": .string("toolPlatformError")])),
                                                          at: clock.now())
            }
            return .failure(error)
        } catch {
            if let operationID = sideEffectOperation,
               let taskID = context.taskID,
               let runID = context.runID,
               let sideEffectLedgerStore {
                try? await sideEffectLedgerStore.complete(operationID: operationID,
                                                          taskID: taskID,
                                                          runID: runID,
                                                          status: .failed,
                                                          result: ToolExecutionResult(status: .failed,
                                                                                      userSafeSummary: "工具执行失败",
                                                                                      structuredData: .object(["error": .string("tool failed")])),
                                                          at: clock.now())
            }
            return .failure(.executionFailed("tool execution failed"))
        }
    }

    /// INV-RESULT-08 — Best-effort conversion of `request.arguments` (an `AgentJSONValue`)
    /// into a `[String: AgentJSONValue]` for hook context. If the request value is not an
    /// object, returns an empty dictionary so hooks always see a well-typed input.
    static func argumentsDictionary(_ arguments: AgentJSONValue) -> [String: AgentJSONValue] {
        if case .object(let dict) = arguments {
            return dict
        }
        return [:]
    }

    /// INV-FC-05 — Recursively scan an `AgentJSONValue` for any leaf string
    /// containing a forbidden privacy token. Used by the registry's defense-in-
    /// depth content safety gate to ensure the canonical result is safe
    /// regardless of hook-chain state (empty chain, nil-returning hook,
    /// future throwing-hook widening).
    static func containsForbiddenToken(in value: AgentJSONValue) -> Bool {
        switch value {
        case .string(let s):
            return PrivacyToolPostExecuteHook.containsForbiddenToken(s)
        case .array(let items):
            return items.contains { containsForbiddenToken(in: $0) }
        case .object(let dict):
            return dict.values.contains { containsForbiddenToken(in: $0) }
        case .number, .bool, .null:
            return false
        }
    }
}

private extension ToolManifest {
    var requiresDurableSideEffect: Bool {
        switch riskLevel {
        case .externalSideEffectReversible, .destructiveOrSensitiveWrite, .highRisk:
            return true
        case .localReadOnlyNoPrivateData, .privateDataReadOnly, .externalReadOnly, .safe, .sensitive, .unknown:
            return false
        }
    }
}

private extension ToolRiskLevel {
    var durableOperationKind: String {
        switch self {
        case .externalSideEffectReversible:
            return "externalWrite"
        case .destructiveOrSensitiveWrite, .highRisk:
            return "destructiveOrSensitiveWrite"
        case .localReadOnlyNoPrivateData, .safe:
            return "readOnly"
        case .privateDataReadOnly, .externalReadOnly, .sensitive:
            return "privateRead"
        case .unknown:
            return "unknown"
        }
    }
}

private extension ToolExecutionStatus {
    var sideEffectStatus: AgentSideEffectStatus {
        switch self {
        case .success, .partial:
            return .succeeded
        case .cancelled:
            return .cancelled
        case .denied, .failed, .timedOut:
            return .failed
        }
    }
}

// MARK: - Sample, side-effect-free tools (doc §6.5)

/// Returns its `text` argument unchanged. No capabilities, no side effects.
public struct EchoTool: RuntimeTool {
    public init() {}
    public let identifier = "echo"
    public let displayName = "Echo"
    public let toolDescription = "Returns the provided text unchanged. Side-effect free."
    public let requiredCapabilities: [String] = []
    public let riskLevel: ToolRiskLevel = .localReadOnlyNoPrivateData
    public let timeout: TimeInterval = 2
    public func execute(arguments: [String: String], context: ToolContext) async throws -> ToolInvocationResult {
        ToolInvocationResult(ok: true, output: arguments["text"] ?? "")
    }
}

/// Reports the current runtime diagnostics snapshot. Requires the P0 `state.read` capability so the
/// capability path is exercised, but performs no side effects.
public struct CurrentRuntimeStatusTool: RuntimeTool {
    public init() {}
    public let identifier = "runtime.status"
    public let displayName = "Runtime Status"
    public let toolDescription = "Reports coarse runtime diagnostics (no conversation content)."
    public let requiredCapabilities: [String] = ["state.read"]
    public let riskLevel: ToolRiskLevel = .localReadOnlyNoPrivateData
    public let timeout: TimeInterval = 2
    public func execute(arguments: [String: String], context: ToolContext) async throws -> ToolInvocationResult {
        let snapshot = await context.diagnostics()
        return ToolInvocationResult(ok: true, output: snapshot.compactSummary)
    }
}

public struct CurrentDateTimeTool: RuntimeTool {
    private let timeZoneProvider: @Sendable () -> TimeZone

    public init(timeZoneProvider: @escaping @Sendable () -> TimeZone = { .current }) {
        self.timeZoneProvider = timeZoneProvider
    }

    public let identifier = "get_current_datetime"
    public let displayName = "Current Date Time"
    public let toolDescription = "Returns the current local date and time. Read-only and side-effect free."
    public let requiredCapabilities: [String] = ["get_current_datetime"]
    public let riskLevel: ToolRiskLevel = .localReadOnlyNoPrivateData
    public let timeout: TimeInterval = 2

    public func execute(arguments: [String: String], context: ToolContext) async throws -> ToolInvocationResult {
        let timeZone = timeZoneProvider()
        let now = context.clock.now()
        let iso = ISO8601DateFormatter()
        iso.timeZone = timeZone
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = timeZone
        local.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"
        let isoString = iso.string(from: now)
        let localString = local.string(from: now)
        let payload: [String: String] = [
            "status": "success",
            "timestamp": isoString,
            "iso8601": isoString,
            "timezone": timeZone.identifier,
            "local_time": localString,
            "local": localString,
        ]
        let data = (try? JSONEncoder().encode(payload)) ?? Data()
        let output = String(data: data, encoding: .utf8) ?? local.string(from: now)
        return ToolInvocationResult(ok: true, output: output)
    }
}
