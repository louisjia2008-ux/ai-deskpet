import XCTest
import Foundation
import AICore
import PetAgentRuntime
@testable import DeskPet

private struct ChatMockProviderHTTPClient: ProviderHTTPClient {
    var response: ProviderHTTPResponse

    func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        response
    }
}

private actor RecordingProviderChatHTTPClient: ProviderHTTPClient {
    enum Behavior: Sendable {
        case response(ProviderHTTPResponse)
        case responses([ProviderHTTPResponse])
        case networkFailure
    }

    struct CapturedRequest: Sendable {
        var url: URL?
        var method: String?
        var authorization: String?
        var body: Data?
    }

    private let behavior: Behavior
    private var captured: CapturedRequest?
    private var count = 0

    init(behavior: Behavior) {
        self.behavior = behavior
    }

    func data(for request: URLRequest) async throws -> ProviderHTTPResponse {
        count += 1
        captured = CapturedRequest(url: request.url,
                                   method: request.httpMethod,
                                   authorization: request.value(forHTTPHeaderField: "Authorization"),
                                   body: request.httpBody)
        switch behavior {
        case .response(let response):
            return response
        case .responses(let responses):
            return responses[min(count - 1, max(responses.count - 1, 0))]
        case .networkFailure:
            throw URLError(.notConnectedToInternet)
        }
    }

    func requestCount() -> Int { count }
    func capturedRequest() -> CapturedRequest? { captured }
}

private enum ChatRuntimeTestError: Error {
    case failed
}

private enum ChatSecretStoreError: Error {
    case readFailed
}

private actor ReadFailingSecretStore: SecretStore {
    private var secrets: Set<String> = []

    func save(_ secret: String, for secretID: String) async throws {
        secrets.insert(secretID)
    }

    func read(_ secretID: String) async throws -> String? {
        throw ChatSecretStoreError.readFailed
    }

    func delete(_ secretID: String) async throws {
        secrets.remove(secretID)
    }

    func exists(_ secretID: String) async -> Bool {
        secrets.contains(secretID)
    }
}

private struct FailingConversationProvider: ConversationGenerating {
    func generate(_ request: ConversationRequest) -> AsyncThrowingStream<ConversationChunk, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: ChatRuntimeTestError.failed)
        }
    }
}

@MainActor
final class CompanionChatViewModelTests: XCTestCase {
    private let providerPlaceholder = "Provider client is configured; chat execution is routed by the app runtime."

    private func readyProviderStore() async -> ProviderStore {
        let data = #"{"models":[{"name":"llama3.2"}]}"#.data(using: .utf8)!
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let store = ProviderStore(
            fileURL: url,
            secretStore: InMemorySecretStore(),
            http: ChatMockProviderHTTPClient(response: ProviderHTTPResponse(statusCode: 200, data: data)))
        let provider = ProviderConfig(displayName: "Ollama",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      enabled: true)
        await store.upsert(provider)
        await store.refreshModels(providerID: provider.id)
        return store
    }

    private func providerBackedChat(http: RecordingProviderChatHTTPClient,
                                    providerID: String = "provider-minimax",
                                    displayName: String = "MiniMax CN",
                                    baseURL: URL = URL(string: "https://api.minimaxi.com/v1")!,
                                    modelID: String = "MiniMax-M3",
                                    secretStore customSecretStore: (any SecretStore)? = nil) async -> ChatModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("providers-\(UUID().uuidString).json")
        let secretStore: any SecretStore
        if let customSecretStore {
            secretStore = customSecretStore
        } else {
            secretStore = InMemorySecretStore()
        }
        let providers = ProviderStore(fileURL: url, secretStore: secretStore)
        let provider = ProviderConfig(id: providerID,
                                      displayName: displayName,
                                      type: .openAICompatible,
                                      baseURL: baseURL,
                                      defaultModelID: modelID,
                                      enabled: true)
        await providers.upsert(provider,
                               apiKey: "test-key-placeholder",
                               manualModelID: modelID)

        let memoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("memory-\(UUID().uuidString).json")
        let memory = MemoryModel(store: MemoryStore(fileURL: memoryURL))
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing-deskpet-llm")),
                                  repository: JSONMemoryRepository(memory),
                                  providers: providers,
                                  providerHTTPClient: http)
        let runtime = p5Coordinator(conversation: LegacyConversationProvider(services))
        let store = ChatStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-\(UUID().uuidString).json"))
        return ChatModel(runtime: runtime,
                         services: services,
                         store: store,
                         activityStore: AgentTaskActivityStore(persistence: nil))
    }

    private func chatModel(conversation: ConversationGenerating = P5FakeConversation(reply: "在呢")) -> ChatModel {
        let memoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("memory-\(UUID().uuidString).json")
        let memory = MemoryModel(store: MemoryStore(fileURL: memoryURL))
        let services = AIServices(llm: LLMService(helperURL: URL(fileURLWithPath: "/missing-deskpet-llm")),
                                  repository: JSONMemoryRepository(memory))
        return ChatModel(runtime: p5Coordinator(conversation: conversation),
                         services: services,
                         activityStore: AgentTaskActivityStore(persistence: nil))
    }

    func testSendingMessageAppendsUserMessage() async {
        let providers = await readyProviderStore()
        let chat = chatModel()
        let viewModel = CompanionChatViewModel(chat: chat, providers: providers)

        viewModel.send("你好")

        XCTAssertEqual(viewModel.messages.first?.role, .user)
        XCTAssertEqual(viewModel.messages.first?.text, "你好")
    }

    func testSuccessfulRuntimeResponseAppendsAssistantMessage() async {
        let providers = await readyProviderStore()
        let chat = chatModel(conversation: P5FakeConversation(reply: "在呢，一起加油"))
        let viewModel = CompanionChatViewModel(chat: chat, providers: providers)

        viewModel.send("陪我聊聊")
        await waitUntil {
            viewModel.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        XCTAssertTrue(viewModel.messages.contains {
            $0.role == .pet && $0.text.contains("一起加油") && $0.status == .completed
        })
    }

    func testRuntimeErrorAppendsReadableErrorState() async {
        let providers = await readyProviderStore()
        let chat = chatModel(conversation: FailingConversationProvider())
        let viewModel = CompanionChatViewModel(chat: chat, providers: providers)

        viewModel.send("会失败吗")
        await waitUntil {
            viewModel.messages.contains { $0.role == .pet && $0.status == .failed }
        }

        let failed = viewModel.messages.first { $0.role == .pet && $0.status == .failed }
        XCTAssertEqual(failed?.text, "生成失败")
    }

    func testChatModelSendUsesSelectedProviderAndModel() async {
        let body = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"收到"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http)

        chat.send("请只回复两个字：收到")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        let captured = await http.capturedRequest()
        let requestCount = await http.requestCount()
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(captured?.method, "POST")
        XCTAssertEqual(captured?.url?.absoluteString, "https://api.minimaxi.com/v1/chat/completions")
        XCTAssertEqual(captured?.authorization, "Bearer test-key-placeholder")
        let requestBody = captured?.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertEqual(requestBody?["model"] as? String, "MiniMax-M3")
        let thinking = requestBody?["thinking"] as? [String: Any]
        XCTAssertEqual(thinking?["type"] as? String, "disabled")
        XCTAssertEqual(requestBody?["reasoning_split"] as? Bool, true)
    }

    func testProviderReplyBecomesVisibleChatMessageContent() async {
        let body = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"收到"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http)

        chat.send("请只回复两个字：收到")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "收到")
        XCTAssertFalse(chat.conversation.messages.contains { $0.text.contains(providerPlaceholder) })
    }

    func testProviderThinkingBlockIsSanitizedBeforeChatMessage() async {
        let body = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"<think>内部推理</think>好的呢"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http)

        chat.send("从今往后你的名字就叫美美了")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "好的呢")
        XCTAssertFalse(reply?.text.contains("<think>") == true)
        XCTAssertFalse(reply?.text.contains("内部推理") == true)
    }

    func testProviderReasoningContentIsNotDisplayed() async {
        let body = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"收到","reasoning_content":"内部推理"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http)

        chat.send("请只回复两个字：收到")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "收到")
        XCTAssertFalse(reply?.text.contains("内部推理") == true)
    }

    func testProviderReasoningOnlyFailsWithoutDisplayingReasoning() async {
        let body = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"","reasoning_content":"内部推理"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http)

        chat.send("你好")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .failed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "回复没有完成。")
        XCTAssertFalse(reply?.text.contains("内部推理") == true)
    }

    func testMiniMaxThinkingOptionIsNotSentToOtherOpenAICompatibleProviders() async {
        let body = #"{"model":"gpt-test","choices":[{"message":{"role":"assistant","content":"收到"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http,
                                            providerID: "provider-openai-compatible",
                                            displayName: "Generic Compatible",
                                            baseURL: URL(string: "https://example.com/v1")!,
                                            modelID: "gpt-test")

        chat.send("你好")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        let captured = await http.capturedRequest()
        let requestBody = captured?.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertNil(requestBody?["thinking"])
        XCTAssertNil(requestBody?["reasoning_split"])
    }

    func testMiniMaxThinkingOptionFallsBackWhenServerRejectsIt() async {
        let rejected = ProviderHTTPResponse(statusCode: 400, data: Data())
        let acceptedBody = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"收到"}}]}"#
            .data(using: .utf8)!
        let accepted = ProviderHTTPResponse(statusCode: 200, data: acceptedBody)
        let http = RecordingProviderChatHTTPClient(behavior: .responses([rejected, accepted]))
        let chat = await providerBackedChat(http: http)

        chat.send("请只回复两个字：收到")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .completed }
        }

        let requestCount = await http.requestCount()
        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(requestCount, 2)
        XCTAssertEqual(reply?.text, "收到")
    }

    func testProviderAuthenticationFailureIsUserVisibleAndNotPlaceholder() async {
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 401, data: Data())))
        let chat = await providerBackedChat(http: http)

        chat.send("你好")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .failed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "API Key 无效或已失效。")
        XCTAssertFalse(reply?.text.contains(providerPlaceholder) == true)
    }

    func testProviderModelNotFoundIsUserVisibleAndNotPlaceholder() async {
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 404, data: Data())))
        let chat = await providerBackedChat(http: http)

        chat.send("你好")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .failed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "当前选择的模型不可用。")
        XCTAssertFalse(reply?.text.contains(providerPlaceholder) == true)
    }

    func testProviderNetworkFailureIsUserVisibleAndNotPlaceholder() async {
        let http = RecordingProviderChatHTTPClient(behavior: .networkFailure)
        let chat = await providerBackedChat(http: http)

        chat.send("你好")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .failed }
        }

        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(reply?.text, "暂时无法连接到模型。")
        XCTAssertFalse(reply?.text.contains(providerPlaceholder) == true)
    }

    func testP12RuntimeFailurePresenterKeepsUserFacingRecoveryText() {
        XCTAssertEqual(
            UserFacingErrorPresenter.runtimeFailureMessage(from: "上次生成被应用重启打断，可以重试。"),
            "上次生成被应用重启打断，可以重试。")
        XCTAssertEqual(
            UserFacingErrorPresenter.runtimeFailureMessage(from: "permission denied calendar.event.create"),
            "已取消这个操作。")
        XCTAssertEqual(
            UserFacingErrorPresenter.runtimeFailureMessage(from: #"{"error":"tool_failed","tool":"internal.debug"}"#),
            "这个操作没有完成。")
    }

    func testProviderSecretReadFailureIsUserVisibleAsAPIKeyEmptyAndNotPlaceholder() async {
        let body = #"{"model":"MiniMax-M3","choices":[{"message":{"role":"assistant","content":"收到"}}]}"#
            .data(using: .utf8)!
        let http = RecordingProviderChatHTTPClient(behavior: .response(
            ProviderHTTPResponse(statusCode: 200, data: body)))
        let chat = await providerBackedChat(http: http,
                                            secretStore: ReadFailingSecretStore())

        chat.send("你好")
        await waitUntil {
            chat.conversation.messages.contains { $0.role == .pet && $0.status == .failed }
        }

        let requestCount = await http.requestCount()
        let reply = chat.conversation.messages.last { $0.role == .pet }
        XCTAssertEqual(requestCount, 0)
        XCTAssertEqual(reply?.text, "还没有可用的 AI 模型。")
        XCTAssertFalse(reply?.text.contains(providerPlaceholder) == true)
        XCTAssertFalse(reply?.text.contains("模型调用失败") == true)
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
}
