# ADR: Single Agent Runtime

## Status

Accepted for P4.3.

## Decision

`PetAgentRuntimeCoordinator` is the only top-level runtime for formal DeskPet app behavior. Main
conversation, quick chat, capability plans, approval waits, cancellation, and proactive runtime
decisions must converge on this coordinator boundary.

`ConversationGenerating` is a lower-level text generation provider. The current app implementation is
`LegacyConversationProvider`, which wraps existing `AIServices` behavior while removing it from the
top-level runtime role.

`InProcessPetBrainRuntime` is retained as legacy/reference code and for existing PetBrainCore tests,
but the app no longer wires it into `ChatModel` or self-test runtime entrypoints.

## Consequences

- UI does not call models or the legacy runtime directly.
- Chat message lifecycle is driven by runtime output.
- Chat task lifecycle is durably recorded through `AgentTaskLedgerPersisting`.
- Tool intent cannot bypass the broker because the coordinator calls `CapabilityGate` before
  `ToolExecuting`.
- `askUser` fails closed and emits a waiting-for-approval presentation when the approval UI is not
  available.
- Active chat cancellation is owned by the coordinator plus `ChatModel` pending-message finalization.
- Restart recovery is deterministic: active generation becomes interrupted/recoverable, waiting for
  approval remains fail-closed, and terminal tasks are not re-executed.

## Non-Goals

P4.3 does not complete the future structured model decision engine. Rule-based routing remains marked
as `DecisionSource.ruleBasedStub` and should be replaced in a later phase by `modelStructured`.

P4.3 Completion does not claim true token streaming for the legacy provider. It explicitly reports
`providerStreamingCapability=nonStreaming` until a lower-level model/API supplies real incremental
chunks.

OpenClaw and Hermes remain research references only. They are not runtime dependencies and are not
connected by this architecture.
