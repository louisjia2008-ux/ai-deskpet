# Pet Agent Runtime

`PetAgentRuntimeCoordinator` is the single top-level runtime entry for DeskPet agent behavior.
App code sends normalized events into the coordinator and consumes `PetAgentRuntimeOutput`.

## Runtime Boundary

Formal app flow:

```text
ChatView / QuickChatPanel
 -> ChatModel
 -> PetAgentEvent.userMessage(UserMessageEvent)
 -> PetAgentRuntimeCoordinator.handle
 -> AppAgentContextBuilder
 -> DecisionEngine
 -> StructuredDecisionProviding
 -> validated AgentDecision
 -> LegacyConversationProvider or AgentPlanner / CapabilityBroker
 -> PetAgentRuntimeOutput
 -> ChatModel persistence and CharacterPresentation callback
```

The UI does not call `InProcessPetBrainRuntime`, `StructuredDecisionProviding`, `ConversationGenerating`,
`CapabilityGate`, `ToolExecuting`, or `AgentTaskCoordinator` directly.

## Event Shape

`UserMessageEvent` carries stable IDs for dedupe and persistence:

- `eventID`
- `conversationID`
- `messageID`
- `text`
- `conversationClass`
- `retryOfMessageID`
- `regeneratedFromMessageID`
- `metadata`

`UserMessageMetadata` currently carries `useScreen` and `source`. It intentionally contains no
SwiftUI view state, database entity, or model-provider type.

## Output Shape

`PetAgentRuntimeOutput` is the only stream subscribed to by app chat code:

- `taskStarted`
- `responseStarted`
- `responseDelta`
- `responseCompleted`
- `presentation`
- `waitingForApproval`
- `failed`
- `cancelled`

The stable assistant `messageID` starts at `responseStarted` and is reused by all deltas and the
terminal event.

## Durable Ledger

The coordinator writes task lifecycle events through `AgentTaskLedgerPersisting`. The formal app
injects `JSONAgentTaskLedgerStore`; tests can inject an in-memory store. Ledger writes are append-only
and sequence checked. If an initial task ledger write fails, the runtime emits `failed` and does not
claim success.

## Provider Capability

`LegacyConversationProvider` is currently `nonStreaming`. It may emit `responseDelta`, but the delta
contains the full provider response. This is intentionally recorded as non-streaming in runtime output
and ledger metadata.

## Structured Decisions

`DecisionEngine` consumes `StructuredDecisionResult` and preserves the source as
`modelStructured`, `ruleBasedFallback`, or `deterministicFallback`. A `proposePlan` decision is only a
proposal. `AgentPlanner` converts it into runtime steps, and `CapabilityBroker` remains the only
permission boundary before `ToolExecuting`.

`askClarification`, `decline`, and `noAction` never execute tools. Parse or validation failures are
converted to deterministic safe responses.

## Retry/Regenerate

Retry and regenerate are app-level commands that still enter the same coordinator via
`PetAgentEvent.userMessage`. Retry reuses the original user message and links the new attempt to the
failed/cancelled/interrupted assistant message. Regenerate reuses the original user message and links
the new assistant response to the completed assistant message it replaces semantically.
