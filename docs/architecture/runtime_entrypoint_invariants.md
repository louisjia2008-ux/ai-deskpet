# Runtime Entrypoint Invariants

These invariants protect the single-runtime architecture.

## Required

- User chat, quick chat, task-like requests, and approval-waiting requests enter through
  `PetAgentRuntimeCoordinator`.
- App UI subscribes to `PetAgentRuntimeOutput`, not model streams.
- `DecisionSource.ruleBasedStub` identifies temporary keyword routing.
- `ConversationGenerating` is a bottom provider only. It generates text and returns chunks; it does
  not write chat history, task ledger, long-term memory, or tool state.
- `CapabilityGate` is evaluated before every tool execution.
- `GateOutcome.askUser` is fail closed until a real approval UI exists.
- Cancellation is idempotent and terminal: after `cancelled`, the same assistant message cannot also
  complete.

## Forbidden

- UI code must not call `InProcessPetBrainRuntime`.
- UI code must not call `ReasoningModelProvider`, `ConversationGenerating`, `ToolExecuting`, or
  `AgentTaskCoordinator`.
- A model or decision provider must not execute tools.
- `askUser` must not be converted to implicit grant.
- Release/default app flow must not contain a legacy direct-chat feature flag.
- OpenClaw or Hermes gateway code must not be reintroduced into runtime wiring.

## Diagnostics

Runtime diagnostics should identify event, conversation, message, task, attempt, entry point,
decision source, decision kind, provider, capability requests, tool execution count, terminal state,
cancel reason, and latency. Diagnostics must not record full prompts, tokens, private memory text,
or raw sensitive context.
