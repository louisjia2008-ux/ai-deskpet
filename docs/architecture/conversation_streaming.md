# Conversation Streaming

`PetAgentRuntimeCoordinator` emits ordered runtime output:

```text
taskStarted
providerMetadata
responseStarted
responseDelta(sequence, text)
responseCompleted
presentation
```

Every delta uses the same assistant `messageID` and a monotonic output sequence. Cancelled or failed
messages do not complete.

## Provider Capability

The current app provider is `LegacyConversationProvider`, backed by `AIServices`. The underlying
`LLMService` returns one full response, so this provider is explicitly:

```text
providerStreamingCapability=nonStreaming
```

It emits one content delta containing the full response, then completion. This is honest
non-streaming behavior, not simulated token streaming. The implementation does not split full text
with timers or character slicing to fake model tokens.

Future providers may report `trueStreaming` only when the model/API itself delivers incremental
chunks.

## Cancellation

Cancellation enters the coordinator by conversation ID. The active assistant message is marked
cancelled, a terminal ledger event is appended, and later deltas are ignored by `ChatModel` unless the
message is still pending.
