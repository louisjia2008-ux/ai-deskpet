import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

private struct P31FakeLLMClient: LLMClient {
    var toolCallingCapability: ProviderToolCallingCapability
    var capabilities: Set<ModelCapability>
    var response: LLMChatResponse
    var delayNanos: UInt64 = 0

    init(toolCallingCapability: ProviderToolCallingCapability,
         capabilities: Set<ModelCapability> = [.chat],
         response: LLMChatResponse,
         delayNanos: UInt64 = 0) {
        self.toolCallingCapability = toolCallingCapability
        self.capabilities = capabilities
        self.response = response
        self.delayNanos = delayNanos
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        if delayNanos > 0 { try await Task.sleep(nanoseconds: delayNanos) }
        return response
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func listModels() async throws -> [ModelDescriptor] { [] }
    func testConnection() async -> ProviderConnectionStatus { .connected }
}

private actor P31HTTPClient: ProviderHTTPClient {
    let response: ProviderHTTPResponse
    private(set) var captured: URLRequest?

    init(response: ProviderHTTPResponse) {
        self.response = response
    }

    func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        captured = request
        return response
    }

    func request() -> URLRequest? { captured }
}

private actor P31SequenceHTTPClient: ProviderHTTPClient {
    private var responses: [ProviderHTTPResponse]
    private var errors: [Error?]
    private var captured: [URLRequest] = []

    init(responses: [ProviderHTTPResponse], errors: [Error?] = []) {
        self.responses = responses
        self.errors = errors
    }

    func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        captured.append(request)
        if !errors.isEmpty, let error = errors.removeFirst() {
            throw error
        }
        guard !responses.isEmpty else {
            return ProviderHTTPResponse(statusCode: 500, data: Data())
        }
        return responses.removeFirst()
    }

    func requests() -> [URLRequest] { captured }
}

private actor P31AllowGate: CapabilityGate {
    private(set) var seen: [String] = []

    func evaluate(capabilityID: String, reason: String, taskID: UUID) async -> GateOutcome {
        seen.append(capabilityID)
        return .granted(CapabilityToken(raw: "tok-\(capabilityID)", taskID: taskID, expiresAt: .distantFuture))
    }

    func count() -> Int { seen.count }
}

private actor P31Executor: ToolExecuting {
    private(set) var executed: [String] = []
    private var active = 0
    private(set) var maxActive = 0
    var cancelled = false
    var delayNanos: UInt64 = 0
    var output = "ok"

    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        active += 1
        maxActive = max(maxActive, active)
        defer { active -= 1 }
        executed.append(step.capabilityID)
        if delayNanos > 0 {
            do {
                try await Task.sleep(nanoseconds: delayNanos)
            } catch {
                cancelled = true
                return ToolOutcome(ok: false, output: "", error: "cancelled")
            }
        }
        return ToolOutcome(ok: true, output: output)
    }

    func count() -> Int { executed.count }
    func maxActiveCount() -> Int { maxActive }
    func wasCancelled() -> Bool { cancelled }
    func setDelay(_ nanos: UInt64) { delayNanos = nanos }
    func setOutput(_ value: String) { output = value }
}

private actor P31FailingExecutor: ToolExecuting {
    private(set) var executed: [String] = []

    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        executed.append(step.capabilityID)
        return ToolOutcome(ok: false, output: "", error: "failed")
    }

    func count() -> Int { executed.count }
}

private actor P31ScriptedProvider: AgentLoopDecisionProviding {
    private var decisions: [AgentLoopDecisionResult]
    private let delayNanos: UInt64
    private(set) var cancelled = false

    init(_ decisions: [AgentLoopDecisionResult], delayNanos: UInt64 = 0) {
        self.decisions = decisions
        self.delayNanos = delayNanos
    }

    func decide(context: AgentLoopDecisionContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> AgentLoopDecisionResult {
        if delayNanos > 0 {
            do {
                try await Task.sleep(nanoseconds: delayNanos)
            } catch {
                cancelled = true
                throw error
            }
        }
        guard !decisions.isEmpty else {
            return p31Final("done")
        }
        return decisions.removeFirst()
    }

    func wasCancelled() -> Bool { cancelled }
}

private struct P31ToolModel: StructuredDecisionProviding {
    func decide(context: AgentContext,
                availableCapabilities: CapabilityCatalogSnapshot) async throws -> StructuredDecisionResult {
        if context.observations.isEmpty {
            return StructuredDecisionResult(decision: .proposePlan(AgentPlanProposal(goal: "time", steps: [
                AgentPlanProposalStep(id: "time-1", description: "获取当前本地时间",
                                      capabilityID: "get_current_datetime")
            ])), decisionSource: .modelStructured, modelProvider: "p31")
        }
        return StructuredDecisionResult(decision: .respond(ConversationResponseDecision(text: "fallback final")),
                                        decisionSource: .modelStructured, modelProvider: "p31")
    }
}

private struct P31ContextBuilder: AgentContextBuilding {
    func build(for event: PetAgentEvent) async -> AgentContext {
        if case .userMessage(let message) = event {
            return AgentContext(userText: message.text)
        }
        return AgentContext()
    }
}

private struct P31Conversation: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.delta(sequence: 1, text: "plain"))
            continuation.yield(.completed(emotion: .neutral, viaCloud: false))
            continuation.finish()
        }
    }
}

private struct P31EventKit: EventKitAccess {
    func createReminder(title: String, due: Date?, notes: String?) async -> Result<String, ToolFailure> { .failure(ToolFailure(message: "not used")) }
    func createCalendarEvent(title: String, start: Date, end: Date, notes: String?) async -> Result<String, ToolFailure> { .failure(ToolFailure(message: "not used")) }
    func readReminders(limit: Int) async -> Result<[String], ToolFailure> { .failure(ToolFailure(message: "not used")) }
    func readCalendarEvents(daysAhead: Int, limit: Int) async -> Result<[String], ToolFailure> { .failure(ToolFailure(message: "not used")) }
}

private func p31Final(_ text: String) -> AgentLoopDecisionResult {
    AgentLoopDecisionResult(decision: .finalResponse(AgentFinalResponse(text: text)),
                            decisionSource: .modelStructured,
                            modelProvider: "p31")
}

private func p31Tool(_ name: String, callID: String = "call-1") -> AgentLoopDecisionResult {
    AgentLoopDecisionResult(decision: .toolCall(AgentToolCallRequest(
        callID: callID,
        toolName: name,
        arguments: .object([:]),
        userVisibleSummary: ProviderNativeToolCallAdapter.defaultSummary(for: name))),
        decisionSource: .modelStructured,
        modelProvider: "p31")
}

private actor P31FactoryCounter {
    private var value = 0

    func next() -> Int {
        value += 1
        return value
    }

    func current() -> Int { value }
}

private final class P31ScriptedLLMClient: LLMClient, @unchecked Sendable {
    let toolCallingCapability: ProviderToolCallingCapability
    let capabilities: Set<ModelCapability>
    private let lock = NSLock()
    private var responses: [LLMChatResponse]
    private var delays: [UInt64]
    private var requests: [LLMChatRequest] = []

    init(toolCallingCapability: ProviderToolCallingCapability,
         capabilities: Set<ModelCapability> = [.chat, .toolCalling],
         responses: [LLMChatResponse],
         delays: [UInt64] = []) {
        self.toolCallingCapability = toolCallingCapability
        self.capabilities = capabilities
        self.responses = responses
        self.delays = delays
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        let (delay, response) = nextResponse(for: request)
        if delay > 0 { try await Task.sleep(nanoseconds: delay) }
        return response
    }

    private func nextResponse(for request: LLMChatRequest) -> (UInt64, LLMChatResponse) {
        lock.lock()
        defer { lock.unlock() }
        requests.append(request)
        let delay = delays.isEmpty ? 0 : delays.removeFirst()
        let response = responses.isEmpty ? p31LLMFinal("fallback") : responses.removeFirst()
        return (delay, response)
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func listModels() async throws -> [ModelDescriptor] { [] }
    func testConnection() async -> ProviderConnectionStatus { .connected }

    func capturedRequests() -> [LLMChatRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }
}

private final class P31StreamingLLMClient: LLMClient, @unchecked Sendable {
    let toolCallingCapability: ProviderToolCallingCapability = .native
    let capabilities: Set<ModelCapability> = [.chat, .toolCalling]
    private let lock = NSLock()
    private var streamRequests: [LLMChatRequest] = []
    private var sendRequests: [LLMChatRequest] = []
    private let deltas: [LLMChatResponseDelta]

    init(deltas: [LLMChatResponseDelta]) {
        self.deltas = deltas
    }

    func sendChat(_ request: LLMChatRequest) async throws -> LLMChatResponse {
        recordSendRequest(request)
        return p31LLMFinal("fallback-send")
    }

    private func recordSendRequest(_ request: LLMChatRequest) {
        lock.lock()
        defer { lock.unlock() }
        sendRequests.append(request)
    }

    func streamChat(_ request: LLMChatRequest) -> AsyncThrowingStream<LLMChatResponseDelta, Error> {
        lock.lock()
        streamRequests.append(request)
        let captured = deltas
        lock.unlock()
        return AsyncThrowingStream { continuation in
            for delta in captured {
                continuation.yield(delta)
            }
            continuation.finish()
        }
    }

    func listModels() async throws -> [ModelDescriptor] { [] }
    func testConnection() async -> ProviderConnectionStatus { .connected }

    func requestCounts() -> (stream: Int, send: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (streamRequests.count, sendRequests.count)
    }
}

private func p31LLMTool(id: String? = "call-time",
                        name: String = "get_current_datetime",
                        arguments: String = "{}") -> LLMChatResponse {
    LLMChatResponse(message: LLMChatMessage(role: .assistant, content: ""),
                    modelID: "minimax-m3",
                    toolCalls: [LLMToolCall(id: id, name: name, argumentsJSON: arguments)])
}

private func p31LLMFinal(_ text: String) -> LLMChatResponse {
    LLMChatResponse(message: LLMChatMessage(role: .assistant, content: text),
                    modelID: "minimax-m3")
}

private func p31StreamingCapabilities() -> CapabilityCatalogSnapshot {
    CapabilityCatalogSnapshot(
        capabilities: [CapabilityCatalog.lookup("get_current_datetime")!],
        toolCatalog: ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: CurrentDateTimeAgentTool.manifest, enabled: true),
        ]))
}

private func p31DateOutput(timeZone: String = "America/Los_Angeles") -> String {
    """
    {"status":"success","timestamp":"2026-07-10T11:35:00-07:00","iso8601":"2026-07-10T11:35:00-07:00","timezone":"\(timeZone)","local_time":"2026-07-10 11:35:00","local":"2026-07-10 11:35:00"}
    """
}

@MainActor
final class P31ProviderAdapterAcceptanceTests: XCTestCase {
    func testProviderCapabilityNative() {
        let provider = ProviderConfig(displayName: "Native",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com")!,
                                      capabilities: [.chat, .toolCalling])
        XCTAssertEqual(ProviderToolCapabilityPolicy.capability(for: provider), .native)
    }

    func testProviderCapabilityJSONFallback() {
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      capabilities: [.chat, .local])
        XCTAssertEqual(ProviderToolCapabilityPolicy.capability(for: provider), .structuredJSONFallback)
    }

    func testProviderCapabilityUnsupported() {
        let provider = ProviderConfig(displayName: "Manual",
                                      type: .customHTTP,
                                      baseURL: URL(string: "https://example.com")!,
                                      capabilities: [.chat])
        XCTAssertEqual(ProviderToolCapabilityPolicy.capability(for: provider), .unsupported)
    }

    func testOpenAICompatibleStreamChatParsesSSEVisibleReasoningAndToolDeltas() async throws {
        let body = """
        data: {"model":"m","choices":[{"delta":{"content":"<thi"}}]}
        data: {"model":"m","choices":[{"delta":{"content":"nk>hidden</think>visible","reasoning_content":"field-hidden","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_current_datetime","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}
        data: [DONE]
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let secrets = InMemorySecretStore()
        try await secrets.save("placeholder-key", for: "secret")
        let provider = ProviderConfig(displayName: "MiniMax",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com/v1")!,
                                      apiKeySecretID: "secret",
                                      capabilities: [.chat, .toolCalling])
        let client = try await ProviderClientFactory(http: http, secretStore: secrets).makeClient(provider: provider)

        var deltas: [LLMChatResponseDelta] = []
        for try await delta in client.streamChat(LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "time")
        ], modelID: "MiniMax-M3")) {
            deltas.append(delta)
        }

        XCTAssertEqual(deltas.map(\.textDelta).joined(), "visible")
        XCTAssertFalse(deltas.map(\.textDelta).joined().contains("hidden"))
        XCTAssertTrue(deltas.map(\.reasoningDelta).joined().contains("field-hidden"))
        XCTAssertEqual(deltas.flatMap(\.toolCallDeltas).first?.nameFragment, "get_current_datetime")
        XCTAssertEqual(deltas.first { !$0.usage.isEmpty }?.usage["totalTokens"], 3)
        let captured = await http.request()
        let requestBody = try XCTUnwrap(captured?.httpBody.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })
        XCTAssertEqual(requestBody["stream"] as? Bool, true)
        let thinking = requestBody["thinking"] as? [String: Any]
        XCTAssertEqual(thinking?["type"] as? String, "disabled")
        XCTAssertEqual(requestBody["reasoning_split"] as? Bool, true)
    }

    func testOllamaStreamChatParsesNDJSONAndRequestsTrueStreaming() async throws {
        let body = """
        {"model":"qwen","message":{"role":"assistant","content":"<thi","thinking":"field-hidden"},"done":false}
        {"model":"qwen","message":{"role":"assistant","content":"nk>hidden</think>ok","tool_calls":[{"id":"call_1","function":{"name":"get_current_datetime","arguments":{}}}]},"done":true}
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      capabilities: [.chat, .local, .toolCalling])
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore()).makeClient(provider: provider)

        var deltas: [LLMChatResponseDelta] = []
        for try await delta in client.streamChat(LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "time")
        ], modelID: "qwen")) {
            deltas.append(delta)
        }

        XCTAssertEqual(deltas.map(\.textDelta).joined(), "ok")
        XCTAssertFalse(deltas.map(\.textDelta).joined().contains("hidden"))
        XCTAssertTrue(deltas.map(\.reasoningDelta).joined().contains("field-hidden"))
        XCTAssertEqual(deltas.flatMap(\.toolCallDeltas).first?.nameFragment, "get_current_datetime")
        let captured = await http.request()
        let requestBody = try XCTUnwrap(captured?.httpBody.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })
        XCTAssertEqual(requestBody["stream"] as? Bool, true)
        XCTAssertEqual(requestBody["think"] as? Bool, false)
    }

    func testLiveOllamaStreamChatUsesRealAdapterTransportWhenEnabled() async throws {
        try requireLiveProviderProbe()
        let environment = ProcessInfo.processInfo.environment
        let baseURL = try XCTUnwrap(URL(string: environment["DESKPET_LIVE_OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434"))
        let modelID = environment["DESKPET_LIVE_OLLAMA_MODEL"] ?? "qwen3.5:0.8b"
        let provider = ProviderConfig(displayName: "Live Ollama",
                                      type: .ollama,
                                      baseURL: baseURL,
                                      enabled: true,
                                      capabilities: [.chat, .streaming, .local, .offline])
        let client = try await ProviderClientFactory(secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        let deltas = try await collectLiveStreamDeltas(client: client, modelID: modelID)
        let visibleText = deltas.map(\.textDelta).joined()

        XCTAssertGreaterThan(deltas.count, 1)
        XCTAssertFalse(visibleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        XCTAssertFalse(visibleText.localizedCaseInsensitiveContains("<think"))
        XCTAssertFalse(visibleText.localizedCaseInsensitiveContains("</think"))
        XCTAssertTrue(deltas.contains { $0.finishReason != nil })
        XCTAssertFalse(deltas.contains { $0.cancellationAcknowledged })
    }

    func testLiveMiniMaxStreamChatUsesRealAdapterTransportWhenEnabled() async throws {
        try requireLiveProviderProbe()
        let apiKey = try liveEnvironmentValue("MINIMAX_API_KEY")
        let environment = ProcessInfo.processInfo.environment
        let baseURL = try XCTUnwrap(URL(string: environment["DESKPET_LIVE_MINIMAX_BASE_URL"] ?? "https://api.minimaxi.com/v1"))
        let modelID = environment["DESKPET_LIVE_MINIMAX_MODEL"] ?? "MiniMax-M3"
        let secrets = InMemorySecretStore()
        try await secrets.save(apiKey, for: "minimax-live-api-key")
        let provider = ProviderConfig(displayName: "MiniMax Live",
                                      type: .openAICompatible,
                                      baseURL: baseURL,
                                      apiKeySecretID: "minimax-live-api-key",
                                      defaultModelID: modelID,
                                      enabled: true,
                                      capabilities: [.chat, .streaming, .toolCalling])
        let client = try await ProviderClientFactory(secretStore: secrets).makeClient(provider: provider)

        let deltas = try await collectLiveStreamDeltas(client: client, modelID: modelID)
        let visibleText = deltas.map(\.textDelta).joined()

        XCTAssertGreaterThan(deltas.count, 1)
        XCTAssertFalse(visibleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        XCTAssertFalse(visibleText.localizedCaseInsensitiveContains("<think"))
        XCTAssertFalse(visibleText.localizedCaseInsensitiveContains("</think"))
        XCTAssertTrue(deltas.contains { $0.finishReason != nil })
        XCTAssertFalse(deltas.contains { $0.cancellationAcknowledged })
    }

    func testLiveMiniMaxStreamCancellationStopsRealAdapterTransportWhenEnabled() async throws {
        try requireLiveProviderProbe()
        let apiKey = try liveEnvironmentValue("MINIMAX_API_KEY")
        let environment = ProcessInfo.processInfo.environment
        let baseURL = try XCTUnwrap(URL(string: environment["DESKPET_LIVE_MINIMAX_BASE_URL"] ?? "https://api.minimaxi.com/v1"))
        let modelID = environment["DESKPET_LIVE_MINIMAX_MODEL"] ?? "MiniMax-M3"
        let secrets = InMemorySecretStore()
        try await secrets.save(apiKey, for: "minimax-live-api-key")
        let provider = ProviderConfig(displayName: "MiniMax Live",
                                      type: .openAICompatible,
                                      baseURL: baseURL,
                                      apiKeySecretID: "minimax-live-api-key",
                                      defaultModelID: modelID,
                                      enabled: true,
                                      capabilities: [.chat, .streaming, .toolCalling])
        let client = try await ProviderClientFactory(secretStore: secrets).makeClient(provider: provider)
        let request = LLMChatRequest(messages: [
            LLMChatMessage(role: .user,
                           content: "Count slowly from one to twenty, one number per line.")
        ], modelID: modelID, temperature: 0.2, maxTokens: 128)
        let recorder = P31DeltaRecorder()
        let task = Task { () throws -> [LLMChatResponseDelta] in
            do {
                for try await delta in client.streamChat(request) {
                    await recorder.append(delta)
                    if await recorder.count() == 1 {
                        try await Task.sleep(nanoseconds: 10_000_000_000)
                    }
                }
            } catch is CancellationError {
                return await recorder.snapshot()
            }
            return await recorder.snapshot()
        }

        try await waitUntilAsync { await recorder.count() > 0 }
        task.cancel()
        let deltas = try await task.value
        XCTAssertFalse(deltas.isEmpty)
        XCTAssertFalse(deltas.contains { $0.finishReason != nil }, "cancelled stream should not reach normal finish")
    }

    func testNativeSingleToolCallMapping() throws {
        let result = try ProviderNativeToolCallAdapter.map([
            LLMToolCall(id: "native-1", name: "get_current_datetime", argumentsJSON: "{}")
        ])
        guard case .toolCall(let request) = result.decision else { return XCTFail("expected tool") }
        XCTAssertEqual(request.callID, "native-1")
        XCTAssertEqual(request.toolName, "get_current_datetime")
    }

    func testNativeToolCallMissingCallIDIsDeterministic() throws {
        let requests = try ProviderNativeToolCallAdapter.requests(from: [
            LLMToolCall(id: nil, name: "get_current_datetime", argumentsJSON: "{}")
        ])
        XCTAssertEqual(requests.first?.callID, "provider-call-1")
    }

    func testNativeArgumentsMalformedIsRejected() {
        XCTAssertThrowsError(try ProviderNativeToolCallAdapter.requests(from: [
            LLMToolCall(id: "bad", name: "get_current_datetime", argumentsJSON: "{")
        ]))
    }

    func testOpenAICompatibleNativeRequestEncodesToolSchemaAndParsesToolCall() async throws {
        let body = """
        {"model":"m","choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"tc1","type":"function","function":{"name":"get_current_datetime","arguments":"{}"}}]}}]}
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let secrets = InMemorySecretStore()
        try await secrets.save("placeholder-key", for: "secret")
        let provider = ProviderConfig(displayName: "Native",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com/v1")!,
                                      apiKeySecretID: "secret",
                                      capabilities: [.chat, .toolCalling])
        let client = try await ProviderClientFactory(http: http, secretStore: secrets).makeClient(provider: provider)
        let response = try await client.sendChat(LLMChatRequest(messages: [LLMChatMessage(role: .user, content: "time")],
                                                                modelID: "m",
                                                                tools: ProviderToolSchemaBuilder.definitions(
                                                                    from: CapabilityCatalogSnapshot(capabilities: [
                                                                        CapabilityCatalog.lookup("get_current_datetime")!
                                                                    ]))))
        let requestBody = await http.request()?.httpBody.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }
        XCTAssertNotNil(requestBody?["tools"])
        XCTAssertEqual(response.toolCalls.first?.name, "get_current_datetime")
    }

    func testOpenAICompatibleParsesLegacyFunctionCallAsToolCall() async throws {
        let body = """
        {"model":"m","choices":[{"message":{"role":"assistant","content":null,"function_call":{"name":"get_current_datetime","arguments":"{}"}}}]}
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let secrets = InMemorySecretStore()
        try await secrets.save("placeholder-key", for: "secret")
        let provider = ProviderConfig(displayName: "MiniMax",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com/v1")!,
                                      apiKeySecretID: "secret",
                                      capabilities: [.chat, .toolCalling])
        let client = try await ProviderClientFactory(http: http, secretStore: secrets).makeClient(provider: provider)
        let response = try await client.sendChat(LLMChatRequest(messages: [LLMChatMessage(role: .user, content: "time")],
                                                                modelID: "m",
                                                                tools: ProviderToolSchemaBuilder.definitions(
                                                                    from: ToolCatalogSnapshot(entries: [
                                                                        ToolCatalogEntry(manifest: CurrentDateTimeAgentTool.manifest,
                                                                                         enabled: true)
                                                                    ]))))
        XCTAssertEqual(response.toolCalls.first?.name, "get_current_datetime")
        XCTAssertEqual(response.toolCalls.first?.argumentsJSON, "{}")
    }

    func testDatetimeToolSchemaUsesStrictEmptyObjectFromManifest() throws {
        let definitions = ProviderToolSchemaBuilder.definitions(from: ToolCatalogSnapshot(entries: [
            ToolCatalogEntry(manifest: CurrentDateTimeAgentTool.manifest, enabled: true)
        ]))
        let timeTool = try XCTUnwrap(definitions.first { $0.name == "get_current_datetime" })
        let encoded = String(data: try JSONEncoder().encode(timeTool.parameters), encoding: .utf8) ?? ""
        XCTAssertTrue(encoded.contains(#""type":"object""#))
        XCTAssertTrue(encoded.contains(#""additionalProperties":false"#))
        XCTAssertTrue(encoded.contains(#""properties":{}"#))
    }

    func testOpenAICompatibleEncodesAssistantToolCallsAndToolRoleMessage() async throws {
        let body = #"{"model":"m","choices":[{"message":{"role":"assistant","content":"final"}}]}"#
            .data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let secrets = InMemorySecretStore()
        try await secrets.save("placeholder-key", for: "secret")
        let provider = ProviderConfig(displayName: "MiniMax",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://example.com/v1")!,
                                      apiKeySecretID: "secret",
                                      capabilities: [.chat, .toolCalling])
        let client = try await ProviderClientFactory(http: http, secretStore: secrets).makeClient(provider: provider)
        _ = try await client.sendChat(LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "time"),
            LLMChatMessage(role: .assistant,
                           content: "",
                           toolCalls: [LLMToolCall(id: "call_123",
                                                   name: "get_current_datetime",
                                                   argumentsJSON: "{}")]),
            LLMChatMessage(role: .tool,
                           content: p31DateOutput(),
                           toolCallID: "call_123",
                           name: "get_current_datetime")
        ], modelID: "m"))
        let captured = await http.request()
        let requestBody = try XCTUnwrap(captured?.httpBody.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })
        let messages = try XCTUnwrap(requestBody["messages"] as? [[String: Any]])
        let assistant = try XCTUnwrap(messages.first { ($0["role"] as? String) == "assistant" })
        let tool = try XCTUnwrap(messages.first { ($0["role"] as? String) == "tool" })
        XCTAssertTrue(assistant["content"] is NSNull)
        XCTAssertNotNil(assistant["tool_calls"])
        XCTAssertEqual(tool["tool_call_id"] as? String, "call_123")
        XCTAssertEqual(tool["name"] as? String, "get_current_datetime")
    }

    func testOllamaChatDisablesThinkingAndParsesVisibleContent() async throws {
        let body = """
        {"model":"qwen3.5:0.8b","message":{"role":"assistant","content":"P6_PROVIDER_OK","thinking":"hidden reasoning"},"done":true}
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true,
                                      capabilities: [.chat, .local, .offline])
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        let response = try await client.sendChat(LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "say ok")
        ], modelID: "qwen3.5:0.8b"))
        let maybeCaptured = await http.request()
        let captured = try XCTUnwrap(maybeCaptured)
        let requestBody = try XCTUnwrap(captured.httpBody.flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        })

        XCTAssertEqual(captured.url?.path, "/api/chat")
        XCTAssertEqual(requestBody["think"] as? Bool, false)
        XCTAssertEqual(requestBody["stream"] as? Bool, false)
        XCTAssertEqual(response.message.content, "P6_PROVIDER_OK")
        XCTAssertEqual(response.message.metadata["hadReasoning"], "true")
    }

    func testOllamaChatParsesToolCallsWhenVisibleContentIsEmpty() async throws {
        let body = """
        {"model":"qwen3.5:0.8b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_1","function":{"name":"get_current_datetime","arguments":{"timezone":"local"}}}]},"done":true}
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true,
                                      capabilities: [.chat, .local])
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        let response = try await client.sendChat(LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "time")
        ], modelID: "qwen3.5:0.8b"))

        XCTAssertEqual(response.toolCalls.first?.name, "get_current_datetime")
        XCTAssertTrue(response.toolCalls.first?.argumentsJSON.contains("timezone") == true)
    }

    func testOllamaThinkingOnlyResponseIsUnsupportedResponseNotConnectionFailure() async throws {
        let body = """
        {"model":"qwen3.5:0.8b","message":{"role":"assistant","content":"","thinking":"hidden only"},"done":true}
        """.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: body))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        do {
            _ = try await client.sendChat(LLMChatRequest(messages: [
                LLMChatMessage(role: .user, content: "hello")
            ], modelID: "qwen3.5:0.8b"))
            XCTFail("expected unsupported response")
        } catch let error as LLMClientError {
            XCTAssertEqual(error.failureStage, .decode)
            XCTAssertTrue(error.diagnosticSummary.contains("empty visible content"))
            XCTAssertEqual(error.errorDescription, "provider response unsupported")
        }
    }

    func testOllamaMalformedResponseMapsToDecodeFailure() async throws {
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: Data("{".utf8)))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        do {
            _ = try await client.sendChat(LLMChatRequest(messages: [
                LLMChatMessage(role: .user, content: "hello")
            ], modelID: "qwen3.5:0.8b"))
            XCTFail("expected decode failure")
        } catch let error as LLMClientError {
            XCTAssertEqual(error.failureStage, .decode)
            XCTAssertTrue(error.diagnosticSummary.contains("ollama chat decode failed"))
        }
    }

    func testOllamaHTTPFailureIsClassifiedAndRedacted() async throws {
        let body = #"{"error":"Authorization: Bearer secret-token-value"}"#.data(using: .utf8)!
        let http = P31HTTPClient(response: ProviderHTTPResponse(statusCode: 500, data: body))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        do {
            _ = try await client.sendChat(LLMChatRequest(messages: [
                LLMChatMessage(role: .user, content: "hello")
            ], modelID: "qwen3.5:0.8b"))
            XCTFail("expected http failure")
        } catch let error as LLMClientError {
            XCTAssertEqual(error.failureStage, .http)
            XCTAssertTrue(error.diagnosticSummary.contains("status=500"))
            XCTAssertFalse(error.diagnosticSummary.contains("secret-token-value"))
        }
    }

    func testOllamaTransportFailureIncludesSafeEndpointAndStage() async throws {
        let http = P31SequenceHTTPClient(responses: [],
                                         errors: [URLError(.cannotConnectToHost)])
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        do {
            _ = try await client.sendChat(LLMChatRequest(messages: [
                LLMChatMessage(role: .user, content: "hello")
            ], modelID: "qwen3.5:0.8b"))
            XCTFail("expected transport failure")
        } catch let error as LLMClientError {
            XCTAssertEqual(error.failureStage, .transport)
            XCTAssertTrue(error.diagnosticSummary.contains("http://localhost:11434/api/chat"))
            XCTAssertEqual(error.errorDescription, "connection failed")
        }
    }

    func testOllamaConnectionTestAndChatUseCanonicalEndpoints() async throws {
        let tags = #"{"models":[{"name":"qwen3.5:0.8b"}]}"#.data(using: .utf8)!
        let chat = #"{"model":"qwen3.5:0.8b","message":{"role":"assistant","content":"ok"},"done":true}"#
            .data(using: .utf8)!
        let http = P31SequenceHTTPClient(responses: [
            ProviderHTTPResponse(statusCode: 200, data: tags),
            ProviderHTTPResponse(statusCode: 200, data: chat),
        ])
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434/")!,
                                      enabled: true)
        let client = try await ProviderClientFactory(http: http, secretStore: InMemorySecretStore())
            .makeClient(provider: provider)

        _ = try await client.listModels()
        _ = try await client.sendChat(LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "hello")
        ], modelID: "qwen3.5:0.8b"))
        let paths = await http.requests().map { $0.url?.path }

        XCTAssertEqual(paths, ["/api/tags", "/api/chat"])
    }

    func testOllamaStreamingChunkParserSeparatesThinkingFromVisibleText() throws {
        let chunk = try OllamaStreamingChunkParser.parseLine(
            #"{"message":{"role":"assistant","content":"ok","thinking":"hidden"},"done":false}"#)
        let done = try OllamaStreamingChunkParser.parseLine(
            #"{"message":{"role":"assistant","content":""},"done":true}"#)

        XCTAssertEqual(chunk.textDelta, "ok")
        XCTAssertEqual(chunk.thinkingDelta, "hidden")
        XCTAssertFalse(chunk.done)
        XCTAssertTrue(done.done)
    }

    func testStreamingToolNameFragments() throws {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [.init(index: 0, callID: "c1", nameFragment: "get_current_")]))
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [.init(index: 0, nameFragment: "datetime", argumentsFragment: "{}")]))
        guard case .toolCalls(let calls) = try acc.finish() else { return XCTFail("expected tool") }
        XCTAssertEqual(calls.first?.toolName, "get_current_datetime")
    }

    func testStreamingArgumentsFragments() throws {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [.init(index: 0, callID: "c1", nameFragment: "state.read", argumentsFragment: #"{"a":"#)]))
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [.init(index: 0, argumentsFragment: #""b"}"#)]))
        guard case .toolCalls(let calls) = try acc.finish() else { return XCTFail("expected tool") }
        let arguments = try XCTUnwrap(calls.first?.arguments.stringArguments())
        XCTAssertEqual(arguments["a"], "b")
    }

    func testMultipleToolCallIndexesDeterministicOrdering() throws {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [
            .init(index: 1, callID: "b", nameFragment: "timer.local", argumentsFragment: #"{"durationSeconds":1}"#),
            .init(index: 0, callID: "a", nameFragment: "get_current_datetime", argumentsFragment: "{}"),
        ]))
        guard case .toolCalls(let calls) = try acc.finish() else { return XCTFail("expected tools") }
        XCTAssertEqual(calls.map(\.callID), ["a", "b"])
    }

    func testCancelledStreamDoesNotReturnPartialToolCall() {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [.init(index: 0, nameFragment: "get_current_datetime", argumentsFragment: "{")]))
        acc.cancel()
        XCTAssertThrowsError(try acc.finish())
    }

    func testIncompleteStreamedJSONIsRejected() {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(toolCallDeltas: [.init(index: 0, nameFragment: "get_current_datetime", argumentsFragment: "{")]))
        XCTAssertThrowsError(try acc.finish())
    }

    func testReasoningDeltaIsRemoved() throws {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(textDelta: "最终", reasoningDelta: "secret"))
        guard case .finalText(let text) = try acc.finish() else { return XCTFail("expected final") }
        XCTAssertEqual(text, "最终")
    }

    func testSplitThinkTagsAreRemoved() throws {
        let acc = ProviderToolCallStreamAccumulator()
        acc.ingest(ProviderStreamEvent(textDelta: "<thi"))
        acc.ingest(ProviderStreamEvent(textDelta: "nk>内部</think>可见"))
        guard case .finalText(let text) = try acc.finish() else { return XCTFail("expected final") }
        XCTAssertEqual(text, "可见")
    }

    func testStreamingSanitizerWithholdsSplitThinkOpeningUntilVisibleText() {
        let sanitizer = StreamingModelResponseSanitizer()
        let first = sanitizer.ingest(contentDelta: "<thi")
        let second = sanitizer.ingest(contentDelta: "nk>内部</think>可见")
        XCTAssertEqual(first.visibleText, "")
        XCTAssertEqual(second.visibleText, "可见")
        XCTAssertTrue(second.hadReasoning)
    }

    @MainActor
    func testChatResponseDeltaCoalescerDropsDuplicateSequencesAndFlushesFinalText() {
        let coalescer = ChatResponseDeltaCoalescer()
        let messageID = UUID()
        XCTAssertTrue(coalescer.ingest(messageID: messageID, sequence: 1, text: "a"))
        XCTAssertFalse(coalescer.ingest(messageID: messageID, sequence: 1, text: "duplicate"))
        XCTAssertFalse(coalescer.ingest(messageID: messageID, sequence: 2, text: "b"))
        XCTAssertEqual(coalescer.flush(messageID: messageID), "ab")
        XCTAssertNil(coalescer.flush(messageID: messageID))
    }

    func testNativeDecisionUsesStreamedFinalTextWithoutSendChatFallback() async throws {
        let client = P31StreamingLLMClient(deltas: [
            ProviderDelta(textDelta: "<thi"),
            ProviderDelta(textDelta: "nk>hidden</think>stream final", finishReason: "stop"),
        ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "stream-model",
                                                            capability: .native)
        let result = try await provider.decide(
            context: AgentLoopDecisionContext(agentContext: AgentContext(userText: "hi")),
            availableCapabilities: p31StreamingCapabilities())

        guard case .finalResponse(let final) = result.decision else {
            return XCTFail("expected final")
        }
        XCTAssertEqual(final.text, "stream final")
        XCTAssertEqual(result.providerMetadata["streaming"], "true")
        XCTAssertEqual(client.requestCounts().stream, 1)
        XCTAssertEqual(client.requestCounts().send, 0)
    }

    func testNativeDecisionUsesStreamedToolCallFragmentsWithCatalogValidation() async throws {
        let client = P31StreamingLLMClient(deltas: [
            ProviderDelta(toolCallDeltas: [
                LLMToolCallDelta(index: 0, callID: "stream-call", nameFragment: "get_current_"),
            ]),
            ProviderDelta(toolCallDeltas: [
                LLMToolCallDelta(index: 0, nameFragment: "datetime", argumentsFragment: "{}"),
            ], finishReason: "tool_calls"),
        ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "stream-model",
                                                            capability: .native)
        let result = try await provider.decide(
            context: AgentLoopDecisionContext(agentContext: AgentContext(userText: "time")),
            availableCapabilities: p31StreamingCapabilities())

        guard case .toolCall(let request) = result.decision else {
            return XCTFail("expected tool call")
        }
        XCTAssertEqual(request.callID, "stream-call")
        XCTAssertEqual(request.toolName, "get_current_datetime")
        XCTAssertEqual(request.arguments, .object([:]))
        XCTAssertEqual(result.providerMetadata["streaming"], "true")
        XCTAssertEqual(client.requestCounts().stream, 1)
        XCTAssertEqual(client.requestCounts().send, 0)
    }

    func testUnclosedThinkTagIsRemoved() throws {
        let result = ModelResponseSanitizer.sanitize(content: "可见 <THINK>内部")
        XCTAssertEqual(result.visibleText, "可见")
        XCTAssertTrue(result.hadReasoning)
    }

    func testThinkTextInsideStructuredArgumentsRemainsIntact() throws {
        let requests = try ProviderNativeToolCallAdapter.requests(from: [
            LLMToolCall(id: "c", name: "state.read", argumentsJSON: #"{"text":"<think>literal</think>"}"#)
        ])
        let arguments = try requests[0].arguments.stringArguments()
        XCTAssertEqual(arguments["text"], "<think>literal</think>")
    }

    func testJSONFallbackValidPlainJSON() throws {
        let result = try AgentLoopDecisionParser.parse(raw: #"{"type":"final","text":"ok"}"#)
        guard case .finalResponse(let final) = result.decision else { return XCTFail("expected final") }
        XCTAssertEqual(final.text, "ok")
    }

    func testJSONFallbackAllowedCodeFence() throws {
        let result = try AgentLoopDecisionParser.parse(raw: """
        ```json
        {"type":"final","text":"ok"}
        ```
        """)
        guard case .finalResponse(let final) = result.decision else { return XCTFail("expected final") }
        XCTAssertEqual(final.text, "ok")
    }

    func testMixedProseAndJSONIsRejected() {
        XCTAssertThrowsError(try AgentLoopDecisionParser.parse(raw: #"sure {"type":"final","text":"ok"}"#))
    }

    func testDuplicateJSONFieldIsRejected() {
        XCTAssertThrowsError(try AgentLoopDecisionParser.parse(raw: #"{"type":"final","type":"tool_call","text":"ok"}"#))
    }

    func testRepairSucceedsOnce() async {
        let provider = RawAgentLoopDecisionProvider { context, _ in
            context.repairAttempt == 0 ? "{" : #"{"type":"final","text":"repair"}"#
        }
        let result = await controller(provider: provider).run(agentContext: AgentContext(userText: "x"), taskID: UUID())
        XCTAssertEqual(result.finalResponse?.text, "repair")
    }

    func testRepairFailureStopsLoop() async {
        let provider = RawAgentLoopDecisionProvider { _, _ in "{" }
        let result = await controller(provider: provider).run(agentContext: AgentContext(userText: "x"), taskID: UUID())
        XCTAssertEqual(result.stopReason, .malformedDecision)
    }

    func testCurrentDateTimeToolPassesCapabilityGateWithFakeClock() async throws {
        let clock = TestClock(start: Date(timeIntervalSince1970: 1_700_000_000))
        let executor = InProcessToolExecutor(eventKit: P31EventKit(),
                                             clock: clock,
                                             timeZoneProvider: { TimeZone(identifier: "Asia/Shanghai")! },
                                             scheduleTimer: { _, _ in })
        let result = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("done")
        ]), executor: executor).run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime"])
        XCTAssertEqual(result.toolStatuses, [.success])
        let content = result.observations.first?.content.canonicalString ?? ""
        XCTAssertTrue(content.contains("Asia") && content.contains("Shanghai"))
    }

    func testModelTimeoutCancelsProviderTask() async {
        let provider = P31ScriptedProvider([p31Final("late")], delayNanos: 300_000_000)
        let result = await controller(provider: provider,
                                      limits: AgentLoopLimits(modelRequestTimeout: 0.05))
            .run(agentContext: AgentContext(userText: "x"), taskID: UUID())
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(result.stopReason, .modelTimeout)
        let wasCancelled = await provider.wasCancelled()
        XCTAssertTrue(wasCancelled)
    }

    func testToolTimeoutCancelsToolTask() async {
        let executor = P31Executor()
        await executor.setDelay(300_000_000)
        let result = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("after timeout")
        ]), executor: executor,
        limits: AgentLoopLimits(toolExecutionTimeout: 0.05))
            .run(agentContext: AgentContext(userText: "x"), taskID: UUID())
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(result.toolStatuses, [.timeout])
        let wasCancelled = await executor.wasCancelled()
        XCTAssertTrue(wasCancelled)
    }

    func testLateResultAfterTimeoutIsIgnored() async {
        let executor = P31Executor()
        await executor.setDelay(300_000_000)
        await executor.setOutput("late success")
        let result = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("timeout final")
        ]), executor: executor,
        limits: AgentLoopLimits(toolExecutionTimeout: 0.05))
            .run(agentContext: AgentContext(userText: "x"), taskID: UUID())
        XCTAssertEqual(result.observations.first?.status, .timeout)
        XCTAssertFalse(result.observations.first?.userSafeSummary.contains("late success") == true)
    }

    func testProviderSnapshotStableDuringProviderSwitch() async {
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let factoryCalls = P31FactoryCounter()
        let coordinator = PetAgentRuntimeCoordinator(
            context: P31ContextBuilder(),
            model: P31ToolModel(),
            conversation: P31Conversation(),
            gate: P31AllowGate(),
            executor: executor,
            policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
            loopDecisionProviderFactory: {
                let count = await factoryCalls.next()
                return P31ScriptedProvider([p31Final("provider-\(count)")])
            })
        var text = ""
        for await output in coordinator.handle(.userMessage(text: "time", conversationClass: .normal)) {
            if case .responseDelta(_, _, let delta) = output { text += delta }
        }
        XCTAssertEqual(text, "provider-1")
        let count = await factoryCalls.current()
        XCTAssertEqual(count, 1)
    }

    func testSimultaneousSubmissionDoesNotCreateTwoActiveLoops() async {
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: P31Executor(),
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: P31ScriptedProvider([p31Final("done")]))
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing")),
                                  repository: JSONMemoryRepository(MemoryModel(store: MemoryStore(
                                    fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p31-memory-\(UUID().uuidString).json")))))
        let chat = ChatModel(runtime: runtime, services: services,
                             store: ChatStore(fileURL: FileManager.default.temporaryDirectory
                                .appendingPathComponent("p31-chat-\(UUID().uuidString).json")),
                             activityStore: AgentTaskActivityStore(persistence: nil))
        chat.send("one")
        chat.send("two")
        await waitUntil { !chat.busy }
        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .user }.count, 1)
    }

    func testSharedUIObservesSameActiveStateAndFinalOnce() async {
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: P31Executor(),
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: P31ScriptedProvider([p31Final("done")]))
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing")),
                                  repository: JSONMemoryRepository(MemoryModel(store: MemoryStore(
                                    fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p31-memory-\(UUID().uuidString).json")))))
        let chat = ChatModel(runtime: runtime, services: services,
                             store: ChatStore(fileURL: FileManager.default.temporaryDirectory
                                .appendingPathComponent("p31-chat-\(UUID().uuidString).json")),
                             activityStore: AgentTaskActivityStore(persistence: nil))
        let providers = ProviderStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p31-providers-\(UUID().uuidString).json"),
                                      secretStore: InMemorySecretStore())
        let control = CompanionChatViewModel(chat: chat, providers: providers)
        chat.send("time")
        XCTAssertEqual(control.transientStatusText, chat.transientStatusText)
        await waitUntil { !chat.busy }
        XCTAssertEqual(control.messages.filter { $0.role == .pet }.count, 1)
        XCTAssertNil(chat.transientStatusText)
    }

    func testLedgerContainsTimeoutMetadataWithoutSensitiveContent() async {
        let ledger = P31Ledger()
        let resultProvider = P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("timeout")
        ])
        let executor = P31Executor()
        await executor.setDelay(300_000_000)
        let coordinator = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                     model: P31ToolModel(),
                                                     conversation: P31Conversation(),
                                                     gate: P31AllowGate(),
                                                     executor: executor,
                                                     policy: AgentPolicy(allowTools: true,
                                                                         maxSteps: 4,
                                                                         maxWallClock: 0.2,
                                                                         tier: .developerID),
                                                     ledger: ledger,
                                                     loopDecisionProvider: resultProvider)
        for await _ in coordinator.handle(.userMessage(text: "time", conversationClass: .normal)) {}
        let events = await ledger.all()
        let encoded = String(data: (try? JSONEncoder().encode(events)) ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(events.contains { $0.toolStatuses?.contains("timeout") == true })
        XCTAssertFalse(encoded.contains("Authorization"))
        XCTAssertFalse(encoded.contains("Bearer"))
    }

    func testNativeAssistantToolCallsMessageIsPreservedInSecondRequest() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "call_123"),
                                                      p31LLMFinal("现在是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "minimax-m3",
                                                            capability: .native,
                                                            modelProvider: "minimax")
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        _ = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "请调用工具告诉我当前本地时间。"), taskID: UUID())
        let second = try XCTUnwrap(client.capturedRequests().dropFirst().first)
        let assistant = try XCTUnwrap(second.messages.first { !$0.toolCalls.isEmpty })
        XCTAssertEqual(assistant.role, .assistant)
        XCTAssertEqual(assistant.toolCalls.first?.id, "call_123")
        XCTAssertEqual(assistant.toolCalls.first?.name, "get_current_datetime")
    }

    func testToolResultUsesToolRoleAndMatchingNativeCallID() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "call_match"),
                                                      p31LLMFinal("done")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        _ = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let second = try XCTUnwrap(client.capturedRequests().dropFirst().first)
        let tool = try XCTUnwrap(second.messages.first { $0.role == .tool })
        XCTAssertEqual(tool.toolCallID, "call_match")
        XCTAssertEqual(tool.name, "get_current_datetime")
        XCTAssertTrue(tool.content.contains("2026-07-10T11:35:00-07:00"))
    }

    func testDeterministicMissingCallIDRemainsStableThroughToolResult() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: nil),
                                                      p31LLMFinal("done")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        _ = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let second = try XCTUnwrap(client.capturedRequests().dropFirst().first)
        let assistant = try XCTUnwrap(second.messages.first { !$0.toolCalls.isEmpty })
        let tool = try XCTUnwrap(second.messages.first { $0.role == .tool })
        XCTAssertEqual(assistant.toolCalls.first?.id, "provider-call-1")
        XCTAssertEqual(tool.toolCallID, "provider-call-1")
    }

    func testRuleBasedInitialToolSynthesizesAssistantToolCallForNativeContinuation() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMFinal("当前本地时间是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let initial = p31Tool("get_current_datetime", callID: "rule-call-1")
        _ = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "请调用工具告诉我当前本地时间。"),
                 taskID: UUID(),
                 initialDecision: initial)
        let request = try XCTUnwrap(client.capturedRequests().first)
        let assistant = try XCTUnwrap(request.messages.first { !$0.toolCalls.isEmpty })
        let tool = try XCTUnwrap(request.messages.first { $0.role == .tool })
        XCTAssertEqual(assistant.toolCalls.first?.id, "rule-call-1")
        XCTAssertEqual(tool.toolCallID, "rule-call-1")
        XCTAssertEqual(tool.name, "get_current_datetime")
    }

    func testToolObservationIncludesDatetimeTimezoneAndStatus() async throws {
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput(timeZone: "Asia/Shanghai"))
        let result = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("done")
        ]), executor: executor).run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let content = try XCTUnwrap(result.observations.first?.content)
        XCTAssertTrue(content.jsonString.contains(#""status":"success""#))
        XCTAssertTrue(content.jsonString.contains(#""timestamp":"2026-07-10T11:35:00-07:00""#))
        XCTAssertTrue(content.jsonString.contains(#""timezone":"Asia\/Shanghai""#)
                      || content.jsonString.contains(#""timezone":"Asia/Shanghai""#))
        XCTAssertTrue(content.jsonString.contains(#""local_time":"2026-07-10 11:35:00""#))
    }

    func testSuccessfulToolObservationPayloadIsNotEmpty() async throws {
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("done")
        ]), executor: executor).run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let payload = try XCTUnwrap(result.observations.first?.content.jsonString)
        XCTAssertGreaterThan(payload.count, 80)
        XCTAssertFalse(payload.contains(#""output":""""#))
    }

    func testNativeToolSuccessFollowedByFinalTextCompletesNormally() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "call_ok"),
                                                      p31LLMFinal("当前本地时间是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertEqual(result.finalResponse?.text, "当前本地时间是 11:35")
        let executedCount = await executor.count()
        XCTAssertEqual(executedCount, 1)
    }

    func testRequiredDatetimeRequestFailsWhenProviderReturnsFinalWithoutTool() async {
        let executor = P31Executor()
        let result = await controller(provider: P31ScriptedProvider([
            p31Final("我无法直接获取设备实时日期和时间。")
        ]), executor: executor)
            .run(agentContext: AgentContext(userText: "告诉我现在的本地日期和时间。"), taskID: UUID())

        XCTAssertEqual(result.stopReason, .toolFailure)
        XCTAssertEqual(result.terminalState, .failed)
        XCTAssertEqual(result.finalResponse?.text, "未能调用日期时间工具")
        let executedCount = await executor.count()
        XCTAssertEqual(executedCount, 0)
    }

    func testRequiredDatetimeRequestSucceedsOnlyAfterToolObservation() async {
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput(timeZone: "Asia/Shanghai"))
        let result = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime"),
            p31Final("当前本地时间是 2026-07-10 11:35:00")
        ]), executor: executor)
            .run(agentContext: AgentContext(userText: "告诉我现在的本地日期和时间。"), taskID: UUID())

        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertEqual(result.terminalState, .succeeded)
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime"])
        XCTAssertEqual(result.toolStatuses, [.success])
    }

    func testNativeRepeatedToolCallTriggersForcedFinalRetryWithoutTools() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "call_repeat"),
                                                      p31LLMTool(id: "call_repeat_2"),
                                                      p31LLMFinal("最终答案：11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let requests = client.capturedRequests()
        XCTAssertEqual(requests.count, 3)
        XCTAssertTrue(requests[1].tools.isEmpty)
        XCTAssertTrue(requests[2].tools.isEmpty)
        XCTAssertEqual(result.finalResponse?.text, "最终答案：11:35")
        let executedCount = await executor.count()
        XCTAssertEqual(executedCount, 1)
    }

    func testForcedFinalRetryFinalTextIsReturnedToUser() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "call_repeat"),
                                                      p31LLMTool(id: "call_repeat_again"),
                                                      p31LLMFinal("下午")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "现在属于上午下午还是晚上"), taskID: UUID())
        XCTAssertEqual(result.finalResponse?.text, "下午")
        XCTAssertFalse(result.finalResponse?.text.contains("相同工具调用") == true)
        XCTAssertFalse(result.finalResponse?.text.contains("repeatedToolCall") == true)
    }

    func testControllerRepeatedToolGuardDoesNotExposeInternalWording() async {
        let provider = P31ScriptedProvider([
            p31Tool("get_current_datetime", callID: "a"),
            p31Tool("get_current_datetime", callID: "b"),
            p31Final("使用已有结果回答")
        ])
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        XCTAssertEqual(result.stopReason, .repeatedToolCall)
        XCTAssertEqual(result.finalResponse?.text, "使用已有结果回答")
        XCTAssertFalse(result.finalResponse?.text.contains("相同工具调用") == true)
    }

    func testChatModelNeverPersistsInternalRepeatedToolWording() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "repeat"),
                                                      p31LLMFinal("当前本地时间是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: executor,
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: provider)
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing")),
                                  repository: JSONMemoryRepository(MemoryModel(store: MemoryStore(
                                    fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p311-memory-\(UUID().uuidString).json")))))
        let chat = ChatModel(runtime: runtime, services: services,
                             store: ChatStore(fileURL: FileManager.default.temporaryDirectory
                                .appendingPathComponent("p311-chat-\(UUID().uuidString).json")),
                             activityStore: AgentTaskActivityStore(persistence: nil))
        chat.send("告诉我现在的本地日期和时间。")
        await waitUntil { !chat.busy }
        let petMessages = chat.conversation.messages.filter { $0.role == .pet }
        XCTAssertEqual(petMessages.count, 1)
        XCTAssertFalse(petMessages[0].text.contains("相同工具调用"))
        XCTAssertFalse(petMessages[0].text.contains("repeatedToolCall"))
    }

    func testRepeatedFingerprintScopedToOneTurnAndSameToolAllowedAgain() async {
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let first = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime", callID: "first"),
            p31Final("one")
        ]), executor: executor).run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        let second = await controller(provider: P31ScriptedProvider([
            p31Tool("get_current_datetime", callID: "second"),
            p31Final("two")
        ]), executor: executor).run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        XCTAssertEqual(first.stopReason, .completed)
        XCTAssertEqual(second.stopReason, .completed)
        let executedCount = await executor.count()
        XCTAssertEqual(executedCount, 2)
    }

    func testTwoConsecutiveRuntimeRequestsExecuteTimeToolIndependently() async {
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let factoryCalls = P31FactoryCounter()
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: executor,
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProviderFactory: {
            _ = await factoryCalls.next()
            return P31ScriptedProvider([p31Final("done")])
        })
        for await _ in runtime.handle(.userMessage(text: "请调用工具告诉我当前本地时间。", conversationClass: .normal)) {}
        for await _ in runtime.handle(.userMessage(text: "请调用工具告诉我当前本地时间。", conversationClass: .normal)) {}
        let executedCount = await executor.count()
        let factoryCount = await factoryCalls.current()
        XCTAssertEqual(executedCount, 2)
        XCTAssertEqual(factoryCount, 2)
    }

    func testJSONFallbackDoesNotUseNativeToolRoleMessages() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .structuredJSONFallback,
                                          capabilities: [.chat],
                                          responses: [p31LLMFinal(#"{"type":"final","text":"ok"}"#)])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "local",
                                                            capability: .structuredJSONFallback)
        _ = try await provider.decide(context: AgentLoopDecisionContext(agentContext: AgentContext(userText: "hi"),
                                                                        observations: [
                                                                            AgentToolObservation(callID: "c",
                                                                                                 toolName: "get_current_datetime",
                                                                                                 status: .success,
                                                                                                 content: .object([:]),
                                                                                                 userSafeSummary: "ok")
                                                                        ],
                                                                        toolCalls: [
                                                                            AgentToolCallRequest(callID: "c",
                                                                                                 toolName: "get_current_datetime",
                                                                                                 arguments: .object([:]),
                                                                                                 userVisibleSummary: "time")
                                                                        ]),
                                      availableCapabilities: CapabilityCatalogSnapshot(capabilities: [
                                        CapabilityCatalog.lookup("get_current_datetime")!
                                      ]))
        let request = try XCTUnwrap(client.capturedRequests().first)
        XCTAssertFalse(request.messages.contains { $0.role == .tool })
        XCTAssertTrue(request.tools.isEmpty)
    }

    func testJSONFallbackToolThenPlainTextContinuationCompletes() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .structuredJSONFallback,
                                          responses: [
                                            p31LLMFinal(#"{"type":"tool_call","call_id":"time-1","tool":"get_current_datetime","arguments":{},"user_visible_summary":"正在获取本地日期和时间…"}"#),
                                            p31LLMFinal("P11_TOOL_DONE 当前本地时间是 2026-07-10 11:35:00。")
                                          ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "local",
                                                            capability: .structuredJSONFallback)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "Use the available tool to get the current local date and time."),
                 taskID: UUID())

        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertEqual(result.terminalState, .succeeded)
        XCTAssertEqual(result.finalResponse?.text, "P11_TOOL_DONE 当前本地时间是 2026-07-10 11:35:00。")
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime"])
        let executedCount = await executor.count()
        XCTAssertEqual(executedCount, 1)
    }

    func testJSONFallbackMalformedInitialPlanningStillFails() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .structuredJSONFallback,
                                          responses: [
                                            p31LLMFinal("I will just answer without JSON."),
                                            p31LLMFinal("Still not a planning object.")
                                          ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "local",
                                                            capability: .structuredJSONFallback)
        let result = await controller(provider: provider)
            .run(agentContext: AgentContext(userText: "Use a tool."), taskID: UUID())

        XCTAssertEqual(result.stopReason, .malformedDecision)
        XCTAssertEqual(result.terminalState, .failed)
        XCTAssertFalse(result.finalResponse?.text.contains("I will just answer") == true)
    }

    func testJSONFallbackSecondToolAfterObservationStillExecutes() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .structuredJSONFallback,
                                          responses: [
                                            p31LLMFinal(#"{"type":"tool_call","call_id":"time-1","tool":"get_current_datetime","arguments":{},"user_visible_summary":"正在获取本地日期和时间…"}"#),
                                            p31LLMFinal(#"{"type":"tool_call","call_id":"state-1","tool":"state.read","arguments":{},"user_visible_summary":"正在读取当前应用状态"}"#),
                                            p31LLMFinal("两个工具都已完成。")
                                          ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "local",
                                                            capability: .structuredJSONFallback)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "Use two read-only tools."), taskID: UUID())

        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime", "state.read"])
        XCTAssertEqual(result.finalResponse?.text, "两个工具都已完成。")
        let executedCount = await executor.count()
        XCTAssertEqual(executedCount, 2)
    }

    func testJSONFallbackMalformedContinuationActionFailsSafely() async {
        let malformedAction = #"{"type":"tool_call","call_id":"broken","tool""#
        let client = P31ScriptedLLMClient(toolCallingCapability: .structuredJSONFallback,
                                          responses: [
                                            p31LLMFinal(#"{"type":"tool_call","call_id":"time-1","tool":"get_current_datetime","arguments":{},"user_visible_summary":"正在获取本地日期和时间…"}"#),
                                            p31LLMFinal(malformedAction),
                                            p31LLMFinal(malformedAction)
                                          ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "local",
                                                            capability: .structuredJSONFallback)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "Use a tool and continue."), taskID: UUID())

        XCTAssertEqual(result.stopReason, .malformedDecision)
        XCTAssertEqual(result.terminalState, .failed)
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime"])
        XCTAssertFalse(result.finalResponse?.text.contains(malformedAction) == true)
    }

    func testNativeToolCallLaneStillAcceptsPlainFinalAfterTool() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [
                                            p31LLMTool(id: "native-time"),
                                            p31LLMFinal("Native final still works.")
                                          ])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client,
                                                            modelID: "native",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let result = await controller(provider: provider, executor: executor)
            .run(agentContext: AgentContext(userText: "time"), taskID: UUID())

        XCTAssertEqual(result.stopReason, .completed)
        XCTAssertEqual(result.finalResponse?.text, "Native final still works.")
        XCTAssertEqual(result.usedToolNames, ["get_current_datetime"])
    }

    func testCancellationBetweenToolExecutionAndFinalizationPreventsLateResponse() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMTool(id: "cancel"),
                                                      p31LLMFinal("late")],
                                          delays: [0, 500_000_000])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let task = Task {
            await controller(provider: provider, executor: executor)
                .run(agentContext: AgentContext(userText: "time"), taskID: UUID())
        }
        try? await Task.sleep(nanoseconds: 80_000_000)
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result.stopReason, .cancelled)
        XCTAssertNil(result.finalResponse)
    }

    func testFinalAssistantMessageAppearsExactlyOnceAndTransientClearsAfterNativeFinalization() async {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMFinal("当前本地时间是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: executor,
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: provider)
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing")),
                                  repository: JSONMemoryRepository(MemoryModel(store: MemoryStore(
                                    fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p311-memory-\(UUID().uuidString).json")))))
        let chat = ChatModel(runtime: runtime, services: services,
                             store: ChatStore(fileURL: FileManager.default.temporaryDirectory
                                .appendingPathComponent("p311-chat-\(UUID().uuidString).json")),
                             activityStore: AgentTaskActivityStore(persistence: nil))
        chat.send("请调用工具告诉我当前本地时间。")
        await waitUntil { !chat.busy }
        XCTAssertEqual(chat.conversation.messages.filter { $0.role == .pet }.count, 1)
        XCTAssertNil(chat.transientStatusText)
    }

    func testRuntimeActivityRecordsDatetimeToolStartVerifySynthesizeAndCompleteInOrder() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMFinal("当前本地时间是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setOutput(p31DateOutput())
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: executor,
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: provider)

        var finalText = ""
        var activities: [AgentTaskActivityEvent] = []
        var outputLabels: [String] = []
        for await output in runtime.handle(.userMessage(text: "告诉我现在的本地日期和时间。", conversationClass: .normal)) {
            switch output {
            case .taskActivity(let event):
                activities.append(event)
                if event.kind == .synthesisStarted && event.presentation.title == "正在生成最终答复" {
                    outputLabels.append("finalSynthesisStarted")
                } else {
                    outputLabels.append(event.kind.rawValue)
                }
            case .responseDelta(_, _, let text):
                finalText += text
                outputLabels.append("responseDelta")
            default:
                break
            }
        }

        let stepStarted = try XCTUnwrap(outputLabels.firstIndex(of: AgentTaskEventKind.stepStarted.rawValue))
        let stepSucceeded = try XCTUnwrap(outputLabels.firstIndex(of: AgentTaskEventKind.stepSucceeded.rawValue))
        let verificationStarted = try XCTUnwrap(outputLabels.firstIndex(of: AgentTaskEventKind.verificationStarted.rawValue))
        let verificationSucceeded = try XCTUnwrap(outputLabels.firstIndex(of: AgentTaskEventKind.verificationSucceeded.rawValue))
        let synthesisStarted = try XCTUnwrap(outputLabels.firstIndex(of: "finalSynthesisStarted"))
        let responseDelta = try XCTUnwrap(outputLabels.firstIndex(of: "responseDelta"))
        let synthesisSucceeded = try XCTUnwrap(outputLabels.firstIndex(of: AgentTaskEventKind.synthesisSucceeded.rawValue))
        let taskSucceeded = try XCTUnwrap(outputLabels.firstIndex(of: AgentTaskEventKind.taskSucceeded.rawValue))
        XCTAssertLessThan(stepStarted, stepSucceeded)
        XCTAssertLessThan(stepSucceeded, verificationStarted)
        XCTAssertLessThan(verificationStarted, verificationSucceeded)
        XCTAssertLessThan(verificationSucceeded, synthesisStarted)
        XCTAssertLessThan(synthesisStarted, responseDelta)
        XCTAssertLessThan(responseDelta, synthesisSucceeded)
        XCTAssertLessThan(synthesisSucceeded, taskSucceeded)
        XCTAssertEqual(finalText, "当前本地时间是 11:35")
        XCTAssertTrue(activities.contains {
            $0.kind == .stepStarted
                && $0.presentation.title == "正在获取本地日期和时间…"
                && $0.toolID?.rawValue == "get_current_datetime"
        })
        XCTAssertTrue(activities.contains {
            $0.kind == .verificationSucceeded
                && $0.presentation.title == "已验证工具结果"
                && $0.toolID?.rawValue == "get_current_datetime"
        })
        let run = AgentTaskActivityReducer.reduceRun(events: activities)
        XCTAssertEqual(run.userVisibleEvents.map(\.presentation.title),
                       ["正在获取本地日期和时间…", "已获取本地日期和时间", "已验证工具结果", "已完成"])
        XCTAssertEqual(run.userVisibleTerminalSummary, "已完成 · 1 个步骤 · 用时 <1 秒")
    }

    func testRuntimeActivityRecordsDatetimeToolFailureAsTaskFailed() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMFinal("我无法直接获取设备实时日期和时间。")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31FailingExecutor()
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: executor,
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: provider)

        var finalText = ""
        var activities: [AgentTaskActivityEvent] = []
        for await output in runtime.handle(.userMessage(text: "告诉我现在的本地日期和时间。", conversationClass: .normal)) {
            if case .responseDelta(_, _, let text) = output {
                finalText += text
            }
            if case .taskActivity(let event) = output {
                activities.append(event)
            }
        }

        XCTAssertEqual(finalText, "未能调用日期时间工具")
        let labels = activities.map(\.kind.rawValue)
        let stepFailed = try XCTUnwrap(labels.firstIndex(of: AgentTaskEventKind.stepFailed.rawValue))
        let verificationFailed = try XCTUnwrap(labels.firstIndex(of: AgentTaskEventKind.verificationFailed.rawValue))
        let taskFailed = try XCTUnwrap(labels.firstIndex(of: AgentTaskEventKind.taskFailed.rawValue))
        XCTAssertLessThan(stepFailed, verificationFailed)
        XCTAssertLessThan(verificationFailed, taskFailed)
        XCTAssertTrue(activities.contains { $0.kind == .stepFailed && $0.presentation.title == "未能调用日期时间工具" })
        XCTAssertTrue(activities.contains {
            $0.kind == .verificationFailed
                && $0.presentation.title == "工具结果验证失败"
                && $0.failureCategory == .validationFailed
        })
        XCTAssertTrue(activities.contains { $0.kind == .taskFailed && $0.presentation.title == "任务未完成" })
        XCTAssertFalse(activities.contains { $0.kind == .taskSucceeded })
    }

    func testDatetimeToolActivityStoreReplayAndSharedChatSurfaceStayConsistent() async throws {
        let client = P31ScriptedLLMClient(toolCallingCapability: .native,
                                          responses: [p31LLMFinal("当前本地时间是 11:35")])
        let provider = LLMProviderAgentLoopDecisionProvider(client: client, modelID: "minimax-m3",
                                                            capability: .native)
        let executor = P31Executor()
        await executor.setDelay(200_000_000)
        await executor.setOutput(p31DateOutput())
        let runtime = PetAgentRuntimeCoordinator(context: P31ContextBuilder(),
                                                 model: P31ToolModel(),
                                                 conversation: P31Conversation(),
                                                 gate: P31AllowGate(),
                                                 executor: executor,
                                                 policy: AgentPolicy(allowTools: true, maxSteps: 4, tier: .developerID),
                                                 loopDecisionProvider: provider)
        let activityStore = AgentTaskActivityStore(persistence: nil)
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing")),
                                  repository: JSONMemoryRepository(MemoryModel(store: MemoryStore(
                                    fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p311-memory-\(UUID().uuidString).json")))))
        let chat = ChatModel(runtime: runtime, services: services,
                             store: ChatStore(fileURL: FileManager.default.temporaryDirectory
                                .appendingPathComponent("p311-chat-\(UUID().uuidString).json")),
                             activityStore: activityStore)
        let providers = ProviderStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("p311-providers-\(UUID().uuidString).json"),
                                      secretStore: InMemorySecretStore())
        let control = CompanionChatViewModel(chat: chat, providers: providers)

        chat.send("请调用工具告诉我当前本地时间。")
        await waitUntil {
            control.activeTask?.latestRun?.events.contains {
                $0.kind == .stepStarted && $0.toolID?.rawValue == "get_current_datetime"
            } == true
        }
        let liveRun = try XCTUnwrap(control.activeTask?.latestRun)
        XCTAssertEqual(control.transientStatusText, "正在获取本地日期和时间…")
        XCTAssertTrue(liveRun.userVisibleEvents.map(\.presentation.title).contains("正在获取本地日期和时间…"))
        let taskID = liveRun.taskID
        let runID = liveRun.runID

        await waitUntil { !chat.busy }
        let activityMessage = try XCTUnwrap(control.messages.last { $0.role == .activity })
        let activity = try XCTUnwrap(activityMessage.activity)
        XCTAssertEqual(activity.taskID, taskID)
        XCTAssertEqual(activity.runID, runID)
        XCTAssertEqual(activity.status, .succeeded)
        XCTAssertEqual(activity.tools.map(\.toolID), ["get_current_datetime"])
        XCTAssertEqual(activity.tools.first?.status, .succeeded)
        XCTAssertEqual(activity.summary, "已获取本地日期和时间")
        let replayRun = try XCTUnwrap(activityStore.task(id: taskID)?.latestRun)
        XCTAssertEqual(replayRun.runID, runID)
        let replayKinds = replayRun.events.map(\.kind.rawValue)
        XCTAssertTrue(replayRun.events.contains { $0.kind == .verificationSucceeded },
                      replayKinds.joined(separator: ","))
        XCTAssertEqual(replayRun.userVisibleEvents.map(\.presentation.title),
                       ["正在获取本地日期和时间…", "已获取本地日期和时间", "已验证工具结果", "已完成"],
                       replayKinds.joined(separator: ","))
        let canonicalRun = try XCTUnwrap(activityStore.canonicalTask(id: taskID)?.latestRun)
        XCTAssertEqual(canonicalRun.runID, runID)
        XCTAssertEqual(canonicalRun.state, .succeeded)
        let canonicalKinds = canonicalRun.events.map(\.kind.rawValue)
        XCTAssertTrue(canonicalRun.events.contains { $0.kind == .verifierCompleted },
                      canonicalKinds.joined(separator: ","))
    }

    private func controller(provider: any AgentLoopDecisionProviding,
                            executor: any ToolExecuting = P31Executor(),
                            limits: AgentLoopLimits = AgentLoopLimits()) -> AgentLoopController {
        AgentLoopController(provider: provider,
                            gate: P31AllowGate(),
                            executor: executor,
                            policy: AgentPolicy(allowTools: true, maxSteps: 4,
                                                maxIterations: limits.maxIterations,
                                                maxToolCalls: limits.maxToolCalls,
                                                maxWallClock: limits.turnDeadline,
                                                tier: .developerID),
                            limits: limits)
    }

    private func waitUntil(_ predicate: @MainActor @escaping () -> Bool,
                           timeout: TimeInterval = 2,
                           file: StaticString = #filePath,
                           line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out waiting for predicate", file: file, line: line)
    }

    private func waitUntilAsync(_ predicate: @escaping () async -> Bool,
                                timeout: TimeInterval = 20,
                                file: StaticString = #filePath,
                                line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("Timed out waiting for async predicate", file: file, line: line)
    }

    private func requireLiveProviderProbe() throws {
        guard ProcessInfo.processInfo.environment["DESKPET_LIVE_PROVIDER_PROBE"] == "1" else {
            throw XCTSkip("Set DESKPET_LIVE_PROVIDER_PROBE=1 to run live provider streaming probes.")
        }
    }

    private func liveEnvironmentValue(_ key: String) throws -> String {
        let value = ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !value.isEmpty else {
            throw XCTSkip("\(key) is not set; live cloud provider probe skipped.")
        }
        return value
    }

    private func collectLiveStreamDeltas(client: any LLMClient,
                                         modelID: String) async throws -> [LLMChatResponseDelta] {
        var deltas: [LLMChatResponseDelta] = []
        let request = LLMChatRequest(messages: [
            LLMChatMessage(role: .user, content: "Count from one to five, one number per line.")
        ], modelID: modelID, temperature: 0.2, maxTokens: 24)
        for try await delta in client.streamChat(request) {
            deltas.append(delta)
            if deltas.count > 200 { break }
        }
        return deltas
    }
}

private actor P31DeltaRecorder {
    private var deltas: [LLMChatResponseDelta] = []

    func append(_ delta: LLMChatResponseDelta) {
        deltas.append(delta)
    }

    func count() -> Int {
        deltas.count
    }

    func snapshot() -> [LLMChatResponseDelta] {
        deltas
    }
}

private actor P31Ledger: AgentTaskLedgerPersisting {
    private var stored: [AgentTaskLedgerEvent] = []

    func append(_ event: AgentTaskLedgerEvent) async throws { stored.append(event) }
    func events(for taskID: UUID) async throws -> [AgentTaskLedgerEvent] { stored.filter { $0.taskID == taskID } }
    func activeTasks() async throws -> [AgentTaskSnapshot] { [] }
    func hasOperationID(_ operationID: String) async throws -> Bool { stored.contains { $0.operationID == operationID } }
    func all() -> [AgentTaskLedgerEvent] { stored }
}
