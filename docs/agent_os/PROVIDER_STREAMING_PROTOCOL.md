# Provider Streaming Protocol P2

P2 standardizes provider streaming as `ProviderDelta`, then adapts it into runtime and UI-facing flow without inventing a second provider router.

## Provider Path

- `ProviderStore` persists provider configs and defaults.
- `ModelRouter` selects the configured provider/model.
- `ProviderClientFactory` creates provider clients.
- `LLMClient.sendChat` returns full `LLMChatResponse`.
- `LLMClient.streamChat` now has true transport-backed implementations for OpenAI-compatible SSE and Ollama NDJSON.
- `LegacyConversationProvider` reports `nonStreaming` and emits one full-text delta.
- `LLMProviderAgentLoopDecisionProvider` tries `streamChat` first for native-capable providers, then falls back to `sendChat` only when no stream events are produced.
- `ProviderToolCallStreamAccumulator` is wired to streamed tool-call fragments before native tool execution.

## ProviderDelta

`ProviderDelta` represents:

- visible text delta
- hidden reasoning delta
- tool call id/name delta
- tool argument bytes delta
- provider metadata
- usage metadata
- finish reason
- error
- cancellation acknowledgement

Hidden reasoning must be retained only as hidden diagnostic metadata when needed for conformance debugging, never displayed as normal UI text and never persisted as memory.

## Thinking Separation

`ModelResponseSanitizer` still handles full strings and provider reasoning fields. P2 adds `StreamingModelResponseSanitizer` so split tags cannot leak:

```text
chunk 1: "<thi"
chunk 2: "nk>hidden"
chunk 3: "</think>visible"
```

The user-visible output for the example above must be only `visible`.

MiniMax M3 requests use the OpenAI-compatible `thinking: {"type":"disabled"}` control plus `reasoning_split: true`. Reasoning fields and inline `<think>`/`<thinking>` blocks are kept out of visible assistant text.

## Tool Argument Accumulation

Tool calls should execute only after:

- the provider has emitted a complete tool call
- tool id/name maps to a registered tool in `ToolCatalogSnapshot`
- arguments parse as JSON
- arguments pass `ToolSchemaValidator`
- capability and system permission checks pass

Partial tool argument bytes are diagnostic or hidden state. They are not tool facts and are not rendered as user activity.

## Stream Coalescer

`ChatModel.apply` now buffers `responseDelta` through `ChatResponseDeltaCoalescer` with:

- 30-50 ms UI flush cadence
- monotonic sequence protection
- cancellation barrier
- final flush before completion
- no fake token splitting for non-streaming providers

Terminal, failed, and cancelled runtime outputs flush or discard buffered text deterministically before message status changes.

## Live Provider Gate

P2 true-streaming proof is explicit:

- Local provider: `P31ProviderAdapterAcceptanceTests/testLiveOllamaStreamChatUsesRealAdapterTransportWhenEnabled`, with `DESKPET_LIVE_PROVIDER_PROBE=1`, passed against local Ollama at `127.0.0.1:11434`.
- Cloud provider: `P31ProviderAdapterAcceptanceTests/testLiveMiniMaxStreamChatUsesRealAdapterTransportWhenEnabled`, with `DESKPET_LIVE_PROVIDER_PROBE=1` and `MINIMAX_API_KEY` from the environment, passed against `https://api.minimaxi.com/v1`.
- Both live probes require network access outside the restricted test sandbox. In-sandbox runs fail at transport permission, not provider protocol.

The live probe tests are skipped by default so ordinary local and CI full suites do not unexpectedly call external services. They must be enabled intentionally for provider conformance evidence.

## Compatibility

Existing `ConversationProviderStreamingCapability.nonStreaming` remains valid. Non-streaming providers may emit one visible text delta and completion, but must be labelled non-streaming in runtime output, ledger, and docs.

## Deferred

- Persistent per-model conformance profiles are not implemented in P2.
- Provider stream events are adapter-normalized now; P3 still needs richer tool activity UI mapping from canonical runtime tool lifecycle events.
- Multi-agent review streaming and generative UI streaming remain P4/P5 work.
