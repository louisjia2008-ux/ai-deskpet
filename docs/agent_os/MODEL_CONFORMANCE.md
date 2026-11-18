# Model Conformance P7

Model conformance defines what each provider/model can safely do.

## Current Model Policy

- `ProviderType`: OpenAI-compatible, Anthropic, Ollama, LM Studio, custom HTTP, Gemini.
- `ModelCapability`: chat, vision, streaming, tool calling, embeddings, local, offline.
- `ProviderToolCapabilityPolicy`: native, structured JSON fallback, or unsupported.
- MiniMax M3 has special handling for native tool calling, `thinking.type=disabled`, and `reasoning_split=true`.
- Current app-level conversation provider honestly reports `nonStreaming`.

## Current Tests

Provider adapter coverage exists in:

- `P31ProviderAdapterAcceptanceTests`
- `CompanionChatViewModelTests`
- `P4AToolPlatformTests`

These cover provider routing, keychain failures, authentication/model/network errors, thinking block sanitization, native tool schema, JSON fallback, and unsupported provider behavior.

P2 adds:

- true SSE parsing for OpenAI-compatible providers
- true NDJSON parsing for Ollama
- streamed tool-call fragment accumulation
- malformed streamed argument rejection
- stateful split-tag thinking redaction
- ChatModel stream coalescing
- opt-in live probes for Ollama and MiniMax real transports
- opt-in live cancellation probe after a real MiniMax text delta

## Target Profile

`ModelConformanceProfile` now records:

- provider id
- provider type
- model id
- adapter version
- conformance version
- true streaming support
- native tool-call support
- streaming tool-argument support
- parallel tool-call support
- structured output support
- reasoning separation support
- vision support
- tool calling mode
- hidden reasoning fields
- schema and tool-call reliability scores
- required request flags
- known incompatible flags
- max autonomous steps
- allowed and forbidden model roles
- repair requirements
- expiry
- evidence summary
- last verified date

## P7 Runtime Gate

`ModelConformanceGate` checks a concrete request before the model is used for a runtime role. It reports:

- missing or expired persisted profile
- missing required capabilities
- unsupported native tool calling
- unsupported true streaming
- unsupported parallel tool calling
- denied role
- incompatible request flags
- max autonomous-step violations

The allowed roles are explicit: responder, planner, tool caller, verifier, and synthesizer. A chat-only model can still answer ordinary messages, but it cannot be selected for native tool calling or true-streaming recovery unless the profile says those modes are supported.

Production routing uses `ModelConformanceProfileStore` through `PersistedModelConformanceRoutingPolicy`. Router initialization and preflight selection fail closed when a persisted profile is missing, expired, version-incompatible, or insufficient for the requested role/transport/tool mode.

## MiniMax M3 Profile

MiniMax M3 remains OpenAI-compatible in the current provider path. The conformance profile derives:

- `ProviderToolCapabilityPolicy` result for native or structured JSON fallback tool calls
- required `thinking.type=disabled`
- required `reasoning_split=true`
- hidden reasoning field names that must not become visible text
- tool-caller role only when the model actually has tool-calling capability

## P7 Recovery Use

Recovery uses the conformance profile when a provider stream is interrupted:

- true-streaming provider: `AgentRecoveryPlanner` may retry the provider stream
- non-streaming or unproven provider: recovery resumes synthesis from already recorded evidence instead of pretending streamed chunks are reliable

## Remaining Gaps

- No automated scheduled refresh of live provider conformance evidence.
- No context-window or response-token limit fixture is stored yet.
- The 2026-07-27 real macOS XCUITest recovery attempt was blocked before the product test body by Xcode automation-mode initialization. P7 recovery/integration was later accepted through the 2026-07-28 DEBUG App process seed/reload harness, which launched separate DeskPet app processes against the same isolated data root and proved the rebuilt `ModelRouter` applied the persisted conformance profile. The XCUITest runner should still be repaired for fresh visual GUI acceptance.

## P2 Live Proof

Live true-streaming proof requires `DESKPET_LIVE_PROVIDER_PROBE=1`.

- Local: `testLiveOllamaStreamChatUsesRealAdapterTransportWhenEnabled` passed against local Ollama.
- Cloud: `testLiveMiniMaxStreamChatUsesRealAdapterTransportWhenEnabled` passed against MiniMax via `https://api.minimaxi.com/v1`.
- Cloud cancellation: `testLiveMiniMaxStreamCancellationStopsRealAdapterTransportWhenEnabled` passed against MiniMax after observing at least one real streamed text delta and then cancelling the consuming task. No key value is printed or persisted by the test.
- In the restricted sandbox these live probes fail at transport permission; the successful evidence was collected by rerunning the same tests outside the sandbox.

## Rule

A provider may only be marked `trueStreaming` after real incremental provider chunks are observed. Full-text slicing or timer-based fake deltas are not acceptable.
