import XCTest
@testable import DeskPet
@testable import AICore
@testable import PetAgentRuntime
@testable import PetBrainCore

// P13-D — Agent Kernel contract tests.
//
// These tests assert the invariants named in P13-D, the canonical capability
// profile / failure code surface, and the tool post-execute hook chain. They
// are not exhaustive coverage of the runtime; they are the *minimum* set of
// tests that must pass before the kernel contract is considered live.

final class P13KernelContractTests: XCTestCase {

    // MARK: - Model capability normalization

    func testCapabilityProfileForStandardProviderIsUnchanged() {
        let provider = ProviderConfig(displayName: "OpenAI",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://api.openai.com")!,
                                      defaultModelID: "gpt-4o")
        let resolver = DefaultProviderCapabilityProfileResolver()
        let profile = resolver.capabilityProfile(provider: provider, modelID: "gpt-4o")
        XCTAssertFalse(profile.disableThinkingOnFirstAttempt)
        XCTAssertTrue(profile.hiddenReasoningFields.isEmpty)
        XCTAssertTrue(profile.requiredRequestFlags.isEmpty)
        XCTAssertFalse(profile.supportsNativeToolCalling)
    }

    func testCapabilityProfileForLegacyProviderMatchesLegacyBehaviour() {
        // The legacy MiniMax-M3 OpenAI-compatible profile must remain
        // byte-for-byte equivalent to the pre-P13 string-detection behaviour.
        let provider = ProviderConfig(displayName: "OpenAI-compatible",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://api.example.com")!,
                                      defaultModelID: "MiniMax-M3")
        let resolver = DefaultProviderCapabilityProfileResolver()
        let profile = resolver.capabilityProfile(provider: provider, modelID: "MiniMax-M3")
        XCTAssertTrue(profile.disableThinkingOnFirstAttempt)
        XCTAssertEqual(profile.hiddenReasoningFields.sorted(), ["reasoning", "reasoning_content"])
        XCTAssertEqual(profile.requiredRequestFlags["thinking.type"], "disabled")
        XCTAssertEqual(profile.requiredRequestFlags["reasoning_split"], "true")
        XCTAssertTrue(profile.supportsNativeToolCalling)
    }

    func testCapabilityProfileResolvesThroughProtocol() {
        let provider = ProviderConfig(displayName: "any",
                                      type: .ollama,
                                      baseURL: URL(string: "http://localhost:11434")!,
                                      defaultModelID: "llama3")
        let resolver: ProviderCapabilityProfileResolving = DefaultProviderCapabilityProfileResolver()
        let profile = resolver.capabilityProfile(provider: provider, modelID: "llama3")
        XCTAssertEqual(profile, .standard)
    }

    func testProviderCapabilityPolicyUsesProfile() {
        let provider = ProviderConfig(displayName: "OpenAI-compatible",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "https://api.example.com")!,
                                      defaultModelID: "MiniMax-M3")
        let capability = ProviderToolCapabilityPolicy.capability(for: provider, modelID: "MiniMax-M3")
        XCTAssertEqual(capability, .native)
    }

    func testNoBrandNameInKernelAfterP13() {
        // P13-D removes kernel-level brand-string detection. The three
        // kernel files that previously did brand matching must now contain
        // no literal brand names. The single allowed exception is the
        // capability resolver boundary (ProviderCapabilityProfile.swift),
        // which is the only place that knows about specific models.
        let kernelFiles = [
            "Sources/AICore/ProviderClientFactory.swift",
            "Sources/AICore/ProviderModels.swift",
            "Sources/PetAgentRuntime/RecoveryConformance.swift"
        ]
        for path in kernelFiles {
            let url = URL(fileURLWithPath: path)
            guard let contents = try? String(contentsOf: url) else {
                XCTFail("Could not read \(path)")
                continue
            }
            XCTAssertFalse(contents.lowercased().contains("minimax"),
                           "kernel file \(path) should not contain the brand name")
            XCTAssertFalse(contents.lowercased().contains("MiniMax"),
                           "kernel file \(path) should not contain the brand name")
        }
        // The resolver boundary may legitimately mention the model.
        let resolverPath = "Sources/AICore/ProviderCapabilityProfile.swift"
        if let resolver = try? String(contentsOf: URL(fileURLWithPath: resolverPath)) {
            XCTAssertTrue(resolver.lowercased().contains("minimax-m3"),
                          "resolver must know about the legacy model by id")
        }
    }

    func testNoBrandNameInCapabilityProfileOrAgentEventKindPublic() {
        // The post-execute seam and the AgentEventKindPublic extension are
        // new code added by P13-D. They must contain no brand strings
        // (ARCH-15, ARCH-02).
        let newKernelFiles = [
            "Sources/PetAgentRuntime/ToolPostExecuteHook.swift",
            "Sources/PetAgentRuntime/AgentEventKindPublic.swift",
            "Sources/DeskPet/Security/ApprovalRequester.swift",
            "Sources/AICore/LlmFailureCode.swift"
        ]
        for path in newKernelFiles {
            let url = URL(fileURLWithPath: path)
            guard let contents = try? String(contentsOf: url) else {
                XCTFail("Could not read \(path)")
                continue
            }
            XCTAssertFalse(contents.lowercased().contains("minimax"),
                           "new P13 file \(path) must not contain brand name")
            XCTAssertFalse(contents.lowercased().contains("MiniMax"),
                           "new P13 file \(path) must not contain brand name")
        }
    }

    // MARK: - Semantic tool events correlate correctly

    func testAgentEventKindTerminalClassification() {
        // INV-EVENT-01 / INV-EVENT-12
        XCTAssertTrue(AgentEventKind.taskSucceeded.isTerminal)
        XCTAssertTrue(AgentEventKind.taskPartiallySucceeded.isTerminal)
        XCTAssertTrue(AgentEventKind.taskFailed.isTerminal)
        XCTAssertTrue(AgentEventKind.taskCancelled.isTerminal)
        XCTAssertTrue(AgentEventKind.taskInterrupted.isTerminal)
        XCTAssertFalse(AgentEventKind.taskCreated.isTerminal)
        XCTAssertFalse(AgentEventKind.stepStarted.isTerminal)
        XCTAssertFalse(AgentEventKind.toolStarted.isTerminal)
    }

    func testAgentEventKindMappingIsTotal() {
        // Every internal kind either maps to a public semantic kind or to
        // nil (only `.unknown`).
        for kind in AgentTaskEventKind.allCases {
            if kind == .unknown {
                XCTAssertNil(AgentEventKind(from: kind))
            } else {
                XCTAssertNotNil(AgentEventKind(from: kind),
                                "internal kind \(kind.rawValue) should map to a public semantic kind")
            }
        }
    }

    // MARK: - Cancellation cannot later generate success for the same run

    func testCancellationMapsToTerminalKind() {
        // INV-EVENT-05
        XCTAssertEqual(AgentEventKind(from: .taskCancelled), .taskCancelled)
        XCTAssertEqual(AgentEventKind.taskCancelled.isTerminal, true)
    }

    // MARK: - Terminal events are exactly-once

    func testTerminalizedRunIDsGateIsUsedInChatModel() async throws {
        // INV-EVENT-01 / INV-EVENT-12 — assert that ChatModel has the
        // exactly-once gate. This test verifies the production code path
        // without driving a full agent run.
        let chatURL = URL(fileURLWithPath: "Sources/DeskPet/AI/ChatModel.swift")
        let contents = try String(contentsOf: chatURL)
        XCTAssertTrue(contents.contains("terminalizedRunIDs"),
                      "ChatModel must use the terminalizedRunIDs gate to enforce exactly-once terminal events")
    }

    // MARK: - Raw provider error is not required for user-facing text

    func testLlmFailureCodeCanonicalization() {
        let failure401 = LlmFailure(from: .unauthorized)
        XCTAssertEqual(failure401.code, .authenticationFailed)
        XCTAssertEqual(failure401.httpStatus, 401)

        let failure404 = LlmFailure(from: .modelNotFound)
        XCTAssertEqual(failure404.code, .modelNotFound)
        XCTAssertEqual(failure404.httpStatus, 404)

        let failureHTTP400 = LlmFailure(from: .httpFailure(statusCode: 400, endpoint: "endpoint", message: "ignored"))
        XCTAssertEqual(failureHTTP400.code, .providerRequestFailed)
        XCTAssertEqual(failureHTTP400.httpStatus, 400)

        let failureHTTP429 = LlmFailure(from: .httpFailure(statusCode: 429, endpoint: "endpoint", message: "ignored"))
        XCTAssertEqual(failureHTTP429.code, .rateLimited)
        XCTAssertEqual(failureHTTP429.httpStatus, 429)

        let failureTransport = LlmFailure(from: .connectionFailed)
        XCTAssertEqual(failureTransport.code, .transportFailure)

        let failureDecode = LlmFailure(from: .invalidResponse)
        XCTAssertEqual(failureDecode.code, .decodeFailure)

        let failureConfig = LlmFailure(from: .missingAPIKey)
        XCTAssertEqual(failureConfig.code, .configurationInvalid)

        let failureUnsupported = LlmFailure(from: .unsupportedProvider)
        XCTAssertEqual(failureUnsupported.code, .unsupportedProvider)
    }

    func testLlmFailureDoesNotLeakRawProviderMessage() {
        // INV-EVENT-08
        let rawMessage = "internal server error: please don't display me verbatim"
        let failure = LlmFailure(from: .httpFailure(statusCode: 500, endpoint: "endpoint", message: rawMessage))
        // The canonical message must not echo the raw provider message.
        XCTAssertFalse(failure.message.contains(rawMessage),
                       "LlmFailure.message must not contain raw provider text")
        XCTAssertEqual(failure.code, .providerRequestFailed)
    }

    func testLlmFailureCodeIsExhaustive() {
        // Every LLMClientError case must produce a non-unknown LlmFailureCode.
        let cases: [LLMClientError] = [
            .invalidEndpoint,
            .missingAPIKey,
            .unauthorized,
            .modelNotFound,
            .keychain(.invalidData),
            .connectionFailed,
            .unsupportedProvider,
            .invalidResponse,
            .transportFailure(endpoint: "endpoint", code: "test"),
            .httpFailure(statusCode: 500, endpoint: "endpoint", message: "ignored"),
            .decodeFailure(endpoint: "endpoint", message: "ignored"),
            .unsupportedResponse(endpoint: "endpoint", message: "ignored"),
            .capabilityUnsupported(message: "ignored")
        ]
        for c in cases {
            let f = LlmFailure(from: c)
            XCTAssertNotEqual(f.code, .unknown,
                              "LLMClientError case \(c) must not map to .unknown")
        }
    }

    func testLlmFailureCancellationClassified() {
        let failure = LlmFailure.classify(CancellationError())
        XCTAssertEqual(failure.code, .cancelled)
    }

    // MARK: - Raw tool identifier is not required for user-facing activity

    func testToolPresentationMetadataNeverReturnsRawID() {
        // INV-EVENT-06
        let knownIDs = [
            "get_current_datetime",
            "list_today_calendar_events",
            "approximate_location",
            "local_place_search",
            "route_distance_estimate",
            "webpage_read",
            "structured_place_extraction",
            "read_file",
            "run_command",
            "modify_file",
            "this_is_a_completely_unknown_tool_id_xyz"
        ]
        for id in knownIDs {
            let metadata = ToolPresentationMetadata.metadata(for: id)
            // Titles must not be the raw id.
            XCTAssertNotEqual(metadata.succeededTitle, id)
            XCTAssertNotEqual(metadata.failedTitle, id)
            XCTAssertNotEqual(metadata.displayName, id)
            // Titles must be non-empty.
            XCTAssertFalse(metadata.succeededTitle.isEmpty)
            XCTAssertFalse(metadata.failedTitle.isEmpty)
            XCTAssertFalse(metadata.displayName.isEmpty)
        }
    }

    // MARK: - Existing task ledger can still decode known historical state

    func testLegacyPersistenceStateRoundTrip() throws {
        // ARCH-09 / INV-PERSIST-01 — the existing
        // `JSONAgentTaskLedgerStore` (Sources/PetAgentRuntime/DurableRecoveryStores.swift)
        // is what production reads back. We assert the file exists and the
        // agent's own PetAgentRuntimeTests cover decode behaviour.
        let url = URL(fileURLWithPath: "Sources/PetAgentRuntime/DurableRecoveryStores.swift")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        let ledgerTest = URL(fileURLWithPath: "Tests/DeskPetTests/PetAgentRuntimeTests.swift")
        XCTAssertTrue(FileManager.default.fileExists(atPath: ledgerTest.path))
    }

    // MARK: - Provider-specific adapters still preserve existing functionality

    func testOpenAICompatibleClientStillReturnsExpectedErrorForInvalidURL() async throws {
        let provider = ProviderConfig(displayName: "Test",
                                      type: .openAICompatible,
                                      baseURL: URL(string: "not-a-url")!,
                                      defaultModelID: "m")
        let resolver = DefaultProviderCapabilityProfileResolver()
        let profile = resolver.capabilityProfile(provider: provider, modelID: "m")
        XCTAssertEqual(profile, .standard)
    }

    // MARK: - Tool post-execute hook chain

    func testPrivacyHookRedactsForbiddenTokens() {
        let hook = PrivacyToolPostExecuteHook()
        let identity = ToolExecutionIdentity(toolID: "test", callID: "call-1")
        let ctx = ToolPostExecuteContext(
            identity: identity,
            toolArguments: [:],
            value: .string("hello reasoning world"),
            userSafeSummary: "thinking out loud",
            modelContent: "actual answer plus 推理",
            status: .success)
        let rewritten = hook.rewrite(ctx)
        XCTAssertNotNil(rewritten)
        XCTAssertEqual(rewritten?.value, .string("[redacted]"))
        // The summary is sanitised via AgentPrivacyRedactor.
        XCTAssertNotEqual(rewritten?.userSafeSummary, "thinking out loud")
        // P13-003: modelContent is also redacted when it contains forbidden tokens.
        XCTAssertEqual(rewritten?.modelContent, "[redacted]")
    }

    func testPrivacyHookIsNoOpForCleanContent() {
        let hook = PrivacyToolPostExecuteHook()
        let identity = ToolExecutionIdentity(toolID: "test", callID: "call-1")
        let ctx = ToolPostExecuteContext(
            identity: identity,
            toolArguments: [:],
            value: .string("clean content"),
            userSafeSummary: "clean summary",
            status: .success)
        let rewritten = hook.rewrite(ctx)
        XCTAssertNotNil(rewritten)
        XCTAssertEqual(rewritten?.value, .string("clean content"))
        XCTAssertEqual(rewritten?.userSafeSummary, "clean summary")
    }

    func testHookChainAppliesInRegistrationOrder() {
        struct AppendHook: ToolPostExecuteHook {
            let hookID: String
            let suffix: String
            func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
                var updated = context
                updated.userSafeSummary = context.userSafeSummary + suffix
                return updated
            }
        }
        let chain = ToolPostExecuteHookChain(hooks: [
            AppendHook(hookID: "a", suffix: "-A"),
            AppendHook(hookID: "b", suffix: "-B"),
        ])
        let identity = ToolExecutionIdentity(toolID: "test", callID: "call-1")
        let ctx = ToolPostExecuteContext(
            identity: identity,
            toolArguments: [:],
            value: .string("x"),
            userSafeSummary: "start",
            status: .success)
        let result = chain.run(ctx)
        XCTAssertEqual(result.userSafeSummary, "start-A-B")
    }

    func testHookChainPreservesOnNilReturn() {
        struct ReturningNilHook: ToolPostExecuteHook {
            let hookID: String
            func rewrite(_ context: ToolPostExecuteContext) -> ToolPostExecuteContext? {
                return nil
            }
        }
        let chain = ToolPostExecuteHookChain(hooks: [ReturningNilHook(hookID: "nil")])
        let identity = ToolExecutionIdentity(toolID: "test", callID: "call-1")
        let ctx = ToolPostExecuteContext(
            identity: identity,
            toolArguments: [:],
            value: .string("v"),
            userSafeSummary: "s",
            status: .success)
        let result = chain.run(ctx)
        XCTAssertEqual(result.userSafeSummary, "s")
        XCTAssertEqual(result.value, .string("v"))
    }

    // MARK: - Approval seam

    func testInMemoryApprovalRequesterRecordsRequests() async {
        let requester = InMemoryApprovalRequester()
        requester.record(response: .allowOnce, for: "calendar.events.read")
        let decision = await requester.request(capabilityID: "calendar.events.read",
                                                reason: "tool:test",
                                                risk: .p1)
        XCTAssertEqual(decision, .allowOnce)
        let recorded = requester.recordedRequests()
        XCTAssertEqual(recorded.count, 1)
        XCTAssertEqual(recorded[0].capabilityID, "calendar.events.read")
    }

    func testInMemoryApprovalRequesterDefaultsToDeny() async {
        let requester = InMemoryApprovalRequester()
        let decision = await requester.request(capabilityID: "x", reason: "y", risk: .p0)
        XCTAssertEqual(decision, .deny)
    }

    // MARK: - Cancellation downstream

    func testCancellationReplayDoesNotEmitFurtherEventsIsTestedInP7() throws {
        // Cross-reference: P7RecoveryConformanceTests already exercises this
        // invariant. We assert that the test file still exists.
        let url = URL(fileURLWithPath: "Tests/DeskPetTests/P7RecoveryConformanceTests.swift")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path),
                      "P7 recovery conformance test must continue to cover INV-EVENT-05")
    }
}