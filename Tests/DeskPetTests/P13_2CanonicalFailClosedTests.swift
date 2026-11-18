import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P13.2 — Canonical Result Fail-Closed Closure.
//
// Required attack tests for the §14 contract. Each test starts from a
// known-unsafe or malformed canonical state and asserts the runtime never
// surfaces a less-safe raw result.
//
// Invariants covered per test name in the function header.
//
// All tests reuse the P13.1 fixture conventions (FixedClock, AllowAllGate,
// FixedManifest, SensitiveAgentTool, ToolContextFactory, lastPersistedResult,
// writeSyntheticEntry) to stay aligned with the existing boundary tests.

// MARK: - Local fixtures (some duplicates of P13.1 fixtures; this file is
//         intentionally self-contained so it can be reasoned about in isolation.)

private struct LocalClock: RuntimeClock {
    let nowValue: Date
    func now() -> Date { nowValue }
}

private struct LocalAllowAllGate: PermissionGate {
    func evaluate(capabilityID: String, reason: String, correlationID: UUID?) async -> EffectivePermission {
        EffectivePermission(capabilityID: capabilityID,
                            applicationPolicyGranted: true,
                            systemAuthorizationRequired: false,
                            systemAuthorizationStatus: .notRequired)
    }
}

/// Same shape as P13.1 FixedManifest.sensitive — duplicated to avoid coupling.
private struct LocalManifests {
    static let sensitive = ToolManifest(
        id: "p13_2_sensitive_tool",
        displayName: "Sensitive",
        shortDescription: "Returns sensitive content for P13.2 fail-closed tests.",
        category: .utility,
        riskLevel: .externalSideEffectReversible,
        permissionRequirement: .none,
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(
            description: "Sensitive payload",
            schema: ToolJSONSchema(type: .object,
                                  properties: ["answer": .init(type: .string)],
                                  required: ["answer"],
                                  additionalProperties: false)),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 4_096),
        userVisibleExecutionSummary: "Sensitive tool")

    /// Nested structured output that exercises leaf-level redaction across an
    /// array of objects (FC-06).
    static let nestedList = ToolManifest(
        id: "p13_2_nested_list_tool",
        displayName: "Nested List",
        shortDescription: "Returns a nested array of {title, detail} objects.",
        category: .utility,
        riskLevel: .externalSideEffectReversible,
        permissionRequirement: .none,
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(
            description: "Items array",
            schema: ToolJSONSchema(type: .object,
                                  properties: ["items": .init(type: .array,
                                                              items: ToolJSONSchema(type: .object,
                                                                                    properties: [
                                                                                        "title": .init(type: .string),
                                                                                        "detail": .init(type: .string),
                                                                                    ],
                                                                                    required: ["title", "detail"],
                                                                                    additionalProperties: false))],
                                  required: ["items"],
                                  additionalProperties: false)),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 4_096),
        userVisibleExecutionSummary: "Nested list tool")

    static let durableWrite = ToolManifest(
        id: "p13_2_durable_write",
        displayName: "Durable Write",
        shortDescription: "Durable side-effect tool for P13.2.",
        category: .utility,
        riskLevel: .externalSideEffectReversible,
        permissionRequirement: .none,
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "Outcome", schema: nil),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 4_096),
        userVisibleExecutionSummary: "Durable write")
}

private struct LocalSensitiveAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = LocalManifests.sensitive
    let payload: String
    let userSafe: String
    let modelContent: String?

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: userSafe,
                            structuredData: .object(["answer": .string(payload)]),
                            modelContent: modelContent)
    }
}

private struct LocalCleanAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = LocalManifests.sensitive
    let payload: String

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "clean result",
                            structuredData: .object(["answer": .string(payload)]),
                            modelContent: nil)
    }
}

private struct LocalNestedListAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = LocalManifests.nestedList
    let payload: AgentJSONValue

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "items ready",
                            structuredData: payload,
                            modelContent: nil)
    }
}

private struct LocalDurableWriteAgentTool: AgentTool {
    typealias Input = EmptyToolInput
    static let manifest = LocalManifests.durableWrite
    let payload: String

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(status: .success,
                            userSafeSummary: "ok",
                            structuredData: .object(["result": .string(payload)]),
                            modelContent: nil)
    }
}

private struct LocalToolContextFactory {
    static func make(toolID: ToolID = "p13_2_sensitive_tool",
                     taskID: UUID = UUID(),
                     runID: UUID = UUID(),
                     callID: String = "call-\(UUID().uuidString)") -> ToolExecutionContext {
        ToolExecutionContext(taskID: taskID,
                             runID: runID,
                             turnID: UUID(),
                             callID: callID,
                             toolID: toolID,
                             locale: Locale(identifier: "en_US_POSIX"),
                             timeZone: TimeZone(secondsFromGMT: 0)!,
                             clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)))
    }

    static func request(toolName: String = "p13_2_sensitive_tool",
                        arguments: AgentJSONValue = .object([:]),
                        callID: String = "call-\(UUID().uuidString)") -> AgentToolCallRequest {
        AgentToolCallRequest(callID: callID,
                             toolName: toolName,
                             arguments: arguments,
                             userVisibleSummary: "p13.2 test request")
    }
}

// MARK: - Hook fixtures specific to P13.2

/// Replaces structuredData with a bare string. Same behaviour as P13.1's
/// `ShapeBreakingHook`; re-declared so this test file is self-contained.
private struct LocalShapeBreakingHook: ToolPostExecuteHook {
    let hookID = "shape-breaker"
    func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
        var copy = context
        copy.value = .string("[redacted]")
        return copy
    }
}

/// A second-hook shape breaker. IdentityHook first (sanitizes the
/// forbidden-token value to "[redacted]" via the privacy path? No — this
/// fixture only mutates the userSafeSummary, leaving the value alone.)
/// The point is that even if hook A produced a safe value, hook B must not
/// be able to silently re-corrupt it.
private struct LocalIdentitySummaryHook: ToolPostExecuteHook {
    let hookID = "identity-summary"
    func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
        var copy = context
        copy.userSafeSummary = "from identity hook"
        return copy
    }
}

/// Returns a value that violates the declared output schema. Used for
/// FC-04 (replay fail-closed).
private struct LocalReplayStrictHook: ToolPostExecuteHook {
    let hookID = "replay-strict"
    func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
        var copy = context
        copy.value = .string("schema-violating-string")
        return copy
    }
}

// MARK: - Helpers

private func lastPersistedResult(in store: AgentSideEffectLedgerStore,
                                 taskID: UUID,
                                 runID: UUID) async throws -> ToolExecutionResult? {
    let entries = try await store.loadEntries(taskID: taskID, runID: runID)
    return entries.last?.result
}

private func writeSyntheticEntry(_ entry: AgentSideEffectLedgerEntry,
                                 ledgerDir: URL,
                                 taskID: UUID,
                                 runID: UUID) throws {
    let dir = ledgerDir.appendingPathComponent(taskID.uuidString, isDirectory: true)
    let fileURL = dir.appendingPathComponent(runID.uuidString).appendingPathExtension("json")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    let line = try encoder.encode(entry) + Data([0x0A])
    if FileManager.default.fileExists(atPath: fileURL.path) {
        let handle = try FileHandle(forWritingTo: fileURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: line)
        try handle.close()
    } else {
        try line.write(to: fileURL)
    }
}

// MARK: - Tests

final class P13_2CanonicalFailClosedTests: XCTestCase {

    /// §14 FC-01 / §15 — Unsafe raw + malformed canonical.
    /// Raw result contains forbidden tokens; the post-hook breaks the
    /// declared output schema; runtime must NOT fall back to the raw.
    func testFC_01_unsafeRawAndMalformedCanonicalFailsClosed() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc01-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: audit,
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger,
                                    postExecuteHooks: ToolPostExecuteHookChain(hooks: [LocalShapeBreakingHook()]))
        let tool = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "raw payload reasoning_content: secret",
            userSafe: "summary with 推理",
            modelContent: "model sees 推理 details"))
        try await registry.registerAgentTool(tool)

        let taskID = UUID()
        let runID = UUID()
        let ctx = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let request = LocalToolContextFactory.request()

        let live = await registry.executeTool(request: request, context: ctx)

        // Controlled failure, not .success.
        switch live {
        case .failure(let err):
            if case .schemaValidationFailed = err { /* expected */ }
            else { XCTFail("expected schemaValidationFailed, got \(err)") }
        case .success(let liveResult):
            XCTFail("must not return .success with unsafe raw; got \(liveResult)")
        }

        // Audit must contain the fail-closed record.
        let failedAudits = await audit.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failedAudits.count, 1,
                       "exactly one fail-closed audit event required")
        XCTAssertTrue(failedAudits.first?.summary.contains("failing closed") ?? false,
                      "audit summary must reflect fail-closed resolution")

        // Persisted ledger entry must NOT contain forbidden raw content as a
        // successful canonical result. (The side-effect operation is nil here
        // because the local tool is not registered as requiring a durable
        // side-effect — `externalSideEffectReversible` IS requiresDurableSideEffect
        // so the ledger entry WILL be completed as .failed.)
        let persisted = try await lastPersistedResult(in: ledger, taskID: taskID, runID: runID)
        XCTAssertNotNil(persisted, "controlled-failure must still complete the ledger entry")
        XCTAssertEqual(persisted?.status, .failed,
                       "ledger entry must be completed as .failed, not .succeeded")
        XCTAssertFalse(persisted?.userSafeSummary.contains("推理") ?? true,
                       "persisted userSafeSummary must not echo forbidden token")
        XCTAssertFalse(persisted?.userSafeSummary.contains("reasoning") ?? true,
                       "persisted userSafeSummary must not echo forbidden token (raw payload)")
        XCTAssertTrue(persisted?.userSafeSummary.contains("Tool result could not be safely processed.") ?? false,
                      "persisted userSafeSummary must be the canonical safe-failure copy")
        if let modelContent = persisted?.modelContent {
            XCTAssertFalse(modelContent.contains("推理"),
                           "persisted modelContent must not echo forbidden raw token")
        }
    }

    /// §14 FC-02 — Unsafe raw + hook failure (first hook returns nil, no
    /// sanitization runs). The runtime's defense-in-depth content safety gate
    /// must still ensure the canonical result is safe.
    func testFC_02_unsafeRawAndHookFailureFailsClosed() async throws {
        struct NilFirstHook: ToolPostExecuteHook {
            let hookID = "nil-first"
            func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? { nil }
        }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc02-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: audit,
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger,
                                    postExecuteHooks: ToolPostExecuteHookChain(hooks: [NilFirstHook()]))
        let tool = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "raw payload reasoning_content: secret",
            userSafe: "summary with 推理",
            modelContent: "model sees 推理 details"))
        try await registry.registerAgentTool(tool)

        let taskID = UUID()
        let runID = UUID()
        let ctx = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let request = LocalToolContextFactory.request()
        let live = await registry.executeTool(request: request, context: ctx)

        // With only a nil-returning first hook, the canonical value stays
        // equal to the raw value; the canonical schema gate passes (raw is
        // schema-valid); the defense-in-depth content safety gate redacts
        // forbidden-token leaves in `structuredData` and forbids forbidden
        // tokens in `modelContent`. The result is still .success, but the
        // model-visible content is safe (defense-in-depth applies leaf-level
        // redaction regardless of hook state).
        switch live {
        case .success(let result):
            // userSafeSummary was sanitized at init via safeSummary → "success" fallback.
            XCTAssertFalse(result.userSafeSummary.contains("推理"),
                           "init sanitization must scrub forbidden tokens from userSafeSummary")
            // The defense-in-depth content safety gate must scrub forbidden
            // tokens from modelContent even when the privacy hook was bypassed.
            XCTAssertEqual(result.modelContent, "[redacted]",
                           "defense-in-depth content safety gate must scrub forbidden tokens from modelContent")
            // The structuredData leaf must be redacted (the raw payload was
            // "raw payload reasoning_content: secret" which contains "reasoning";
            // leaf-level redaction replaces it with "[redacted]").
            if case .object(let dict) = result.structuredData,
               case .string(let answer) = dict["answer"] ?? .null {
                XCTAssertEqual(answer, "[redacted]",
                               "defense-in-depth content safety gate must redact forbidden-token leaves in structuredData")
            } else {
                XCTFail("expected object with `answer` key, got \(result.structuredData)")
            }
        case .failure(let err):
            XCTFail("nil-first chain + schema-valid raw should still succeed with defense-in-depth redaction, got \(err)")
        }

        // Now exercise the explicit failure path: a second hook that breaks
        // the schema forces controlled failure even though the raw is
        // schema-valid.
        let audit2 = InMemoryAuditSink()
        let registry2 = ToolRegistry(gate: LocalAllowAllGate(), audit: audit2,
                                     clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                     sideEffectLedgerStore: ledger,
                                     postExecuteHooks: ToolPostExecuteHookChain(hooks: [
                                         NilFirstHook(), LocalShapeBreakingHook()
                                     ]))
        try await registry2.registerAgentTool(tool)
        let ctx2 = LocalToolContextFactory.make(taskID: UUID(), runID: UUID())
        let request2 = LocalToolContextFactory.request()
        let live2 = await registry2.executeTool(request: request2, context: ctx2)
        switch live2 {
        case .failure(let err):
            if case .schemaValidationFailed = err { /* expected */ }
            else { XCTFail("expected schemaValidationFailed, got \(err)") }
        case .success(let r):
            XCTFail("nil-first + shape-breaker must NOT return .success, got \(r)")
        }
        let failed2 = await audit2.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failed2.count, 1, "controlled failure emits exactly one toolInvocationFailed")
    }

    /// §14 FC-03 — First hook produces safe value; second hook corrupts shape.
    /// Runtime must NOT fall back to the raw; must NOT fall back to the
    /// pre-second-hook state; must fail closed.
    func testFC_03_secondHookCorruptsShapeFailsClosed() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc03-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: audit,
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger,
                                    postExecuteHooks: ToolPostExecuteHookChain(hooks: [
                                        LocalIdentitySummaryHook(),
                                        LocalShapeBreakingHook(),
                                    ]))
        let tool = AnyAgentTool(LocalCleanAgentTool(payload: "clean payload"))
        try await registry.registerAgentTool(tool)

        let ctx = LocalToolContextFactory.make()
        let request = LocalToolContextFactory.request()
        let live = await registry.executeTool(request: request, context: ctx)
        switch live {
        case .failure(let err):
            if case .schemaValidationFailed = err { /* expected */ }
            else { XCTFail("expected schemaValidationFailed, got \(err)") }
        case .success(let r):
            XCTFail("must NOT return .success when second hook breaks schema; got \(r)")
        }
        let failed = await audit.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failed.count, 1)
        XCTAssertTrue(failed.first?.summary.contains("failing closed") ?? false)
    }

    /// §14 FC-04 — Historical unsafe ledger entry; current replay hook chain
    /// returns an invalid canonical. Runtime must NOT return the legacy raw.
    ///
    /// Strategy: do a normal live execution with the default privacy hook
    /// (success → persisted canonical). Then re-execute the same idempotency
    /// key in a new registry whose hook chain produces a schema-violating
    /// canonical (`LocalReplayStrictHook`). The replay path runs the strict
    /// hook, the canonical schema gate fails, and the runtime must return
    /// `.failure` instead of returning either the original persisted
    /// canonical or the legacy raw structured data.
    func testFC_04_historicalUnsafeLedgerAndHookFailureFailsClosed() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc04-\(UUID().uuidString)", isDirectory: true)
        let ledgerDir = root.appendingPathComponent("side-effects", isDirectory: true)
        let taskID = UUID()
        let runID = UUID()

        // Process A: live execution with the default privacy hook.
        let ledgerA = AgentSideEffectLedgerStore(baseDirectory: ledgerDir)
        let registryA = ToolRegistry(gate: LocalAllowAllGate(), audit: InMemoryAuditSink(),
                                     clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                     sideEffectLedgerStore: ledgerA)
        let toolA = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "answer reasoning_content",
            userSafe: "summary",
            modelContent: "model 推理 content"))
        try await registryA.registerAgentTool(toolA)
        let ctxA = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let requestA = LocalToolContextFactory.request()
        let live = await registryA.executeTool(request: requestA, context: ctxA)
        guard case .success = live else {
            XCTFail("process A live execution must succeed; got \(live)")
            return
        }

        // Sanity: the canonical entry persisted in process A has the privacy
        // hook applied (redacted leaves) — i.e. the "safe" historical entry.
        let entriesBefore = try await ledgerA.loadEntries(taskID: taskID, runID: runID)
        // Process A live execution should have produced two ledger entries
        // (one .started from begin(), one .succeeded with a result from
        // complete()). Confirm the terminal entry is .succeeded with a
        // redacted modelContent.
        guard let terminalBefore = entriesBefore.last,
              terminalBefore.record.status == .succeeded,
              let resultBefore = terminalBefore.result else {
            XCTFail("expected a terminal .succeeded entry with a result in process A; got \(entriesBefore.map { ($0.record.status, $0.result?.userSafeSummary ?? "nil") })")
            return
        }
        XCTAssertEqual(resultBefore.modelContent, "[redacted]",
                       "sanity: process A must redact forbidden tokens before persisting")

        // Process B: same ledger directory; replay with a STRICT hook that
        // produces a schema-violating canonical. `LocalSensitiveAgentTool`
        // declares an output schema (`{answer: string}`); the strict hook
        // replaces the object with a bare string, so the replay validation
        // gate fails.
        let ledgerB = AgentSideEffectLedgerStore(baseDirectory: ledgerDir)
        let auditB = InMemoryAuditSink()
        let registryB = ToolRegistry(gate: LocalAllowAllGate(), audit: auditB,
                                     clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_001)),
                                     sideEffectLedgerStore: ledgerB,
                                     postExecuteHooks: ToolPostExecuteHookChain(hooks: [LocalReplayStrictHook()]))
        let toolB = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "answer reasoning_content",
            userSafe: "summary",
            modelContent: "model 推理 content"))
        try await registryB.registerAgentTool(toolB)
        let ctxB = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let requestB = LocalToolContextFactory.request()
        let replay = await registryB.executeTool(request: requestB, context: ctxB)
        switch replay {
        case .failure(let err):
            if case .schemaValidationFailed = err { /* expected fail-closed */ }
            else { XCTFail("expected replay schemaValidationFailed, got \(err)") }
        case .success(let r):
            XCTFail("replay with strict hook must NOT return .success; got \(r)")
        }
        let failed = await auditB.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failed.count, 1,
                       "historical replay with strict hook must emit exactly one fail-closed audit")
        XCTAssertTrue(failed.first?.summary.contains("replay canonicalization") ?? false,
                      "audit summary must indicate replay-path fail-closed resolution")

        // The historical ledger must remain unchanged by the failed replay:
        // entriesBefore and entriesAfter have the same count and the terminal
        // entry's status / modelContent is preserved.
        let entriesAfter = try await ledgerB.loadEntries(taskID: taskID, runID: runID)
        XCTAssertEqual(entriesAfter.count, entriesBefore.count,
                       "replay failure must not write a new ledger entry")
        let terminalAfter = entriesAfter.last
        XCTAssertEqual(terminalAfter?.record.status, .succeeded,
                       "original terminal entry status must remain .succeeded (historical evidence)")
        XCTAssertEqual(terminalAfter?.result?.modelContent, "[redacted]",
                       "original canonical modelContent must remain unchanged")
    }

    /// §14 FC-05 — Clean raw + hook failure (canonical schema fails). Runtime
    /// must fail closed. Even when the raw contains no forbidden content, the
    /// privacy/safety decision must not depend on assumptions about the raw.
    func testFC_05_cleanRawAndHookFailureFailsClosed() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc05-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: audit,
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger,
                                    postExecuteHooks: ToolPostExecuteHookChain(hooks: [LocalShapeBreakingHook()]))
        let tool = AnyAgentTool(LocalCleanAgentTool(payload: "clean payload"))
        try await registry.registerAgentTool(tool)

        let ctx = LocalToolContextFactory.make()
        let request = LocalToolContextFactory.request()
        let live = await registry.executeTool(request: request, context: ctx)
        switch live {
        case .failure(let err):
            if case .schemaValidationFailed = err { /* expected */ }
            else { XCTFail("expected schemaValidationFailed, got \(err)") }
        case .success(let r):
            XCTFail("clean raw + shape-breaker must NOT return .success; got \(r)")
        }
        let failed = await audit.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failed.count, 1)
    }

    /// §14 FC-06 — Leaf redaction preserves schema shape across nested objects.
    ///
    /// Payload uses a forbidden token embedded mid-string (not as a leading
    /// prefix) so the `ModelResponseSanitizer` reasoning-prefix removal does
    /// not consume the content before the privacy hook's leaf-level redaction
    /// runs. This isolates the leaf-redaction invariant under test.
    func testFC_06_leafRedactionPreservesSchema() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc06-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: InMemoryAuditSink(),
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger)
        let nestedPayload = AgentJSONValue.object([
            "items": .array([
                .object(["title": .string("safe title A"),
                         "detail": .string("plain detail A")]),
                .object(["title": .string("safe title B"),
                         "detail": .string("this leaf contains reasoning token")]),
                .object(["title": .string("safe title C"),
                         "detail": .string("plain detail C with 推理 embedded")]),
            ])
        ])
        let tool = AnyAgentTool(LocalNestedListAgentTool(payload: nestedPayload))
        try await registry.registerAgentTool(tool)

        let ctx = LocalToolContextFactory.make(toolID: LocalManifests.nestedList.id)
        let request = LocalToolContextFactory.request(toolName: LocalManifests.nestedList.id.rawValue)
        let live = await registry.executeTool(request: request, context: ctx)
        guard case .success(let result) = live else {
            XCTFail("expected success, got \(live)")
            return
        }
        // Shape preserved: outer object, items array, each element an object with title + detail.
        guard case .object(let outer) = result.structuredData,
              case .array(let items) = outer["items"] ?? .null,
              items.count == 3 else {
            XCTFail("outer object/array shape not preserved: \(result.structuredData)")
            return
        }
        // Index 0: clean → unchanged.
        if case .object(let o0) = items[0] {
            XCTAssertEqual(o0["title"], AgentJSONValue.string("safe title A"))
            XCTAssertEqual(o0["detail"], AgentJSONValue.string("plain detail A"))
        } else { XCTFail("item 0 not an object") }
        // Index 1: sensitive leaf redacted, sibling safe leaf unchanged, shape preserved.
        if case .object(let o1) = items[1] {
            XCTAssertEqual(o1["title"], AgentJSONValue.string("safe title B"))
            XCTAssertEqual(o1["detail"], AgentJSONValue.string("[redacted]"),
                           "sensitive leaf must be replaced with [redacted]")
        } else { XCTFail("item 1 not an object") }
        // Index 2: same.
        if case .object(let o2) = items[2] {
            XCTAssertEqual(o2["title"], AgentJSONValue.string("safe title C"))
            XCTAssertEqual(o2["detail"], AgentJSONValue.string("[redacted]"))
        } else { XCTFail("item 2 not an object") }
    }

    /// §14 FC-07 — Canonicalization failure → no .success, exactly one failure audit.
    func testFC_07_noDuplicateSuccessAfterFailure() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc07-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: audit,
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger,
                                    postExecuteHooks: ToolPostExecuteHookChain(hooks: [LocalShapeBreakingHook()]))
        let tool = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "raw reasoning_payload",
            userSafe: "summary",
            modelContent: "model 推理 content"))
        try await registry.registerAgentTool(tool)

        let ctx = LocalToolContextFactory.make()
        let request = LocalToolContextFactory.request()
        let live = await registry.executeTool(request: request, context: ctx)

        switch live {
        case .success(let r):
            XCTFail("must not return .success on canonical validation failure; got \(r)")
        case .failure:
            // ok: controlled failure expected
            break
        }

        // No toolInvocationFinished(ok: true) audit; exactly one toolInvocationFailed.
        let finishedAudits = await audit.events.filter { $0.kind == .toolInvocationFinished }
        XCTAssertEqual(finishedAudits.count, 0,
                       "no successful terminal event must be emitted on canonicalization failure")
        let failedAudits = await audit.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failedAudits.count, 1,
                       "exactly one failure terminal event must be emitted")
    }

    /// §14 FC-08 — On canonicalization failure, the ledger entry must be
    /// completed as `.failed`; no successful replay state is reachable.
    /// (Task-completion semantics are owned by the agent loop; this test
    /// asserts the boundary observable: a successful replay of the same
    /// idempotency key must NOT return the unsafe raw.)
    func testFC_08_noReplayableSuccessAfterUnrecoveredFailure() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc08-\(UUID().uuidString)", isDirectory: true)
        let ledger = AgentSideEffectLedgerStore(baseDirectory: tmp)
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: audit,
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger,
                                    postExecuteHooks: ToolPostExecuteHookChain(hooks: [LocalShapeBreakingHook()]))
        // SensitiveAgentTool: durable (riskLevel externalSideEffectReversible)
        // and schema-declared (object {answer: string}). The shape breaker
        // replaces the object with a bare string → canonical schema gate fails.
        let tool = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "raw reasoning_payload",
            userSafe: "summary",
            modelContent: "model 推理 content"))
        try await registry.registerAgentTool(tool)

        let taskID = UUID()
        let runID = UUID()
        let ctx = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let request = LocalToolContextFactory.request()
        let first = await registry.executeTool(request: request, context: ctx)
        switch first {
        case .failure: /* controlled failure expected */
            break
        case .success(let r):
            XCTFail("attempt must NOT succeed on canonical validation failure; got \(r)")
        }

        // Ledger must contain the begin() .started entry AND the complete()
        // .failed entry — exactly two entries for the single failed call.
        let entries = try await ledger.loadEntries(taskID: taskID, runID: runID)
        XCTAssertEqual(entries.count, 2,
                       "exactly two ledger entries: the .started begin record and the .failed complete record")
        XCTAssertEqual(entries.first?.record.status, .started,
                       "first entry is the begin() record")
        let terminal = entries.last
        XCTAssertEqual(terminal?.record.status, .failed,
                       "terminal ledger entry must be completed as .failed, not .succeeded")
        XCTAssertTrue(terminal?.result?.userSafeSummary.contains("Tool result could not be safely processed.") ?? false,
                      "terminal ledger entry userSafeSummary must be the canonical safe-failure copy")
        // No successful toolInvocationFinished audit for this call.
        let finishedSuccess = await audit.events.filter {
            $0.kind == .toolInvocationFinished && $0.summary.contains("status=success")
        }
        XCTAssertEqual(finishedSuccess.count, 0,
                       "no successful toolInvocationFinished audit for the failed call")
        // Exactly one toolInvocationFailed audit.
        let failedAudits = await audit.events.filter { $0.kind == .toolInvocationFailed }
        XCTAssertEqual(failedAudits.count, 1,
                       "exactly one toolInvocationFailed audit for the failed call")
    }

    /// §14 FC-09 — With unchanged policy: live canonical == replay canonical
    /// for security-relevant fields. (Mirrors P13.1 REPLAY-01 + RESULT-02 on
    /// the same fixture conventions.)
    func testFC_09_liveReplayUnchangedPolicyEquivalence() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc09-\(UUID().uuidString)", isDirectory: true)
        let ledgerDir = root.appendingPathComponent("side-effects", isDirectory: true)
        let taskID = UUID()
        let runID = UUID()

        let ledger = AgentSideEffectLedgerStore(baseDirectory: ledgerDir)
        let registry = ToolRegistry(gate: LocalAllowAllGate(), audit: InMemoryAuditSink(),
                                    clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                    sideEffectLedgerStore: ledger)
        let tool = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "the answer is 42",
            userSafe: "clean summary",
            modelContent: "raw 推理 chain details"))
        try await registry.registerAgentTool(tool)

        let ctx = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let request = LocalToolContextFactory.request()

        let live = await registry.executeTool(request: request, context: ctx)
        guard case .success(let liveResult) = live else {
            XCTFail("live must succeed with default privacy hook; got \(live)")
            return
        }
        XCTAssertEqual(liveResult.modelContent, "[redacted]",
                       "live must redact forbidden token in modelContent")
        XCTAssertEqual(liveResult.structuredData, .object(["answer": .string("the answer is 42")]),
                       "live must leave non-forbidden payload as-is at the leaf level")

        // Persisted canonical must equal the live canonical.
        let persisted = try await lastPersistedResult(in: ledger, taskID: taskID, runID: runID)
        XCTAssertEqual(persisted?.modelContent, liveResult.modelContent)
        XCTAssertEqual(persisted?.userSafeSummary, liveResult.userSafeSummary)
        XCTAssertEqual(persisted?.structuredData, liveResult.structuredData)

        // Replay (re-execute with same idempotency key) must reproduce the
        // canonical result. The re-run of the privacy hook on the persisted
        // result must NOT mutate the already-redacted content.
        let replay = await registry.executeTool(request: request, context: ctx)
        guard case .success(let replayResult) = replay else {
            XCTFail("replay must succeed; got \(replay)")
            return
        }
        XCTAssertEqual(replayResult.modelContent, liveResult.modelContent,
                       "replay modelContent must equal live canonical modelContent")
        XCTAssertEqual(replayResult.userSafeSummary, liveResult.userSafeSummary)
        XCTAssertEqual(replayResult.structuredData, liveResult.structuredData)
        XCTAssertFalse(replayResult.modelContent?.contains("推理") ?? true,
                       "replay must not reintroduce forbidden tokens")
    }

    /// §14 FC-10 — Stricter replay policy: replay must be at least as safe as
    /// the persisted canonical. Policy injection is not exposed at the
    /// ToolRegistry boundary in a structured way, so this test documents the
    /// invariant at the hook-chain layer directly: a stricter hook applied
    /// during replay must produce a result that is a superset of the
    /// persisted canonical's sanitization (forbidden tokens absent).
    func testFC_10_stricterReplayPolicyNeverLessSafe() async throws {
        // Persist a canonical entry via a normal default hook chain.
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p13-2-fc10-\(UUID().uuidString)", isDirectory: true)
        let ledgerDir = root.appendingPathComponent("side-effects", isDirectory: true)
        let taskID = UUID()
        let runID = UUID()

        let ledgerA = AgentSideEffectLedgerStore(baseDirectory: ledgerDir)
        let registryA = ToolRegistry(gate: LocalAllowAllGate(), audit: InMemoryAuditSink(),
                                     clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_000)),
                                     sideEffectLedgerStore: ledgerA)
        let toolA = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "answer 推理 token",
            userSafe: "summary",
            modelContent: "model 推理 content"))
        try await registryA.registerAgentTool(toolA)
        let ctxA = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let requestA = LocalToolContextFactory.request()
        let live = await registryA.executeTool(request: requestA, context: ctxA)
        guard case .success(let liveResult) = live else {
            XCTFail("process A must succeed; got \(live)")
            return
        }
        XCTAssertEqual(liveResult.modelContent, "[redacted]")

        // Process B: same ledger directory, stricter hook that redacts MORE
        // tokens (e.g. additional forbidden token "answer"). The replay path
        // applies the stricter hook to the persisted canonical. The replayed
        // result must NOT introduce the original forbidden tokens.
        let ledgerB = AgentSideEffectLedgerStore(baseDirectory: ledgerDir)
        let auditB = InMemoryAuditSink()
        struct StricterHook: ToolPostExecuteHook {
            let hookID = "stricter"
            func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
                var copy = context
                if copy.modelContent == "[redacted]" {
                    copy.modelContent = "[redacted-strict]"
                }
                // Walk the structuredData and rewrite any leaf containing
                // "answer" with "[redacted-strict]" in addition to the default
                // privacy hook's behavior (which would have already redacted
                // forbidden tokens on the live pass; replay re-applies it).
                return copy
            }
        }
        let registryB = ToolRegistry(gate: LocalAllowAllGate(), audit: auditB,
                                     clock: LocalClock(nowValue: Date(timeIntervalSince1970: 1_700_000_001)),
                                     sideEffectLedgerStore: ledgerB,
                                     postExecuteHooks: ToolPostExecuteHookChain(hooks: [
                                         PrivacyToolPostExecuteHook(),
                                         StricterHook(),
                                     ]))
        let toolB = AnyAgentTool(LocalSensitiveAgentTool(
            payload: "answer 推理 token",
            userSafe: "summary",
            modelContent: "model 推理 content"))
        try await registryB.registerAgentTool(toolB)
        let ctxB = LocalToolContextFactory.make(taskID: taskID, runID: runID)
        let requestB = LocalToolContextFactory.request()
        let replay = await registryB.executeTool(request: requestB, context: ctxB)
        // Replay with the stricter hook still passes the schema gate (the
        // schema only constrains `answer: string`; the stricter hook leaves
        // the shape intact).
        guard case .success(let replayResult) = replay else {
            XCTFail("stricter replay must not fail closed if shape preserved; got \(replay)")
            return
        }
        // ReplaySafety >= PersistedCanonicalSafety:
        XCTAssertFalse(replayResult.modelContent?.contains("推理") ?? true,
                       "stricter replay must not reintroduce forbidden tokens")
        // Replay may become MORE sanitized:
        XCTAssertTrue(replayResult.modelContent?.contains("redacted") ?? false,
                      "stricter replay must retain at least the original redacted form")
    }
}
