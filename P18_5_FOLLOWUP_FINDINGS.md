# P18.5 — Follow-up Findings (recorded, not fixed)

Adjacent issues observed during the cancellation audit. None are active
severity ≥7 cancellation defects; each is deferred to keep P18.5 minimal.

## Low-risk / deferred

1. **Dead cast `error as? LlmFailure`**
   `PetAgentRuntimeCoordinator.swift` (converse catch, ~line 1342).
   `LlmFailure` is a struct that does not conform to `Error`, so the cast
   always fails (compiler warning, pre-existing — present in baseline
   staged diff). The `?? (error as? LlmFailure)` branch is dead. Harmless
   because `pendingTypedFailure` already carries the typed failure from the
   `.typedError` chunk. → **P18.4 Exact Identity Matching** or a small
   cleanup pass.

2. **`LLMService` / `ToolRunnerService` lack cancel propagation**
   Both subprocess-helper request/response bridges resolve their
   continuation exactly-once (`pending.removeValue(id)`) but do not observe
   `Task` cancellation: a parent cancel waits up to the 8s / configured
   timeout and the helper subprocess keeps computing until it replies. This
   is **local, bounded, and consumes no cloud provider quota**, and neither
   is on ChatModel's live generation path (ChatModel routes through
   `runtime`/provider streaming, not `services.llm`). Acceptable by design;
   documented in the inventory. If ever promoted to a hot path, wrap `send`
   in `withTaskCancellationHandler` and correlate a cancel token to the
   helper protocol.

3. **AIServices non-throwing provider paths**
   `selectedProviderResponse` / `generate` return non-throwing
   `AIResponse?` / `SemanticResponse`, so a cancellation can only be
   dropped by the caller's `Task.isCancelled` guard (present in
   `LegacyConversationProvider.generate`), not propagated as a throw. The
   central `classify` fix now labels a cancellation `.cancelled` wherever a
   failure IS surfaced, but a signature-level `throws` refactor of these two
   methods was intentionally out of scope. → optional hardening.

4. **`@unchecked Sendable` inventory** — several deadline-gate helper
   classes (`LocalDiscoveryPlannerFactoryDeadlineGate`,
   `LocalDiscoveryPlannerDeadlineGate`, `KeychainLookupRace` is a proper
   actor) use `@unchecked Sendable` with an internal `NSLock`. Correct as
   written, but part of the broader → **P18.3 Swift Concurrency Sendable
   Audit**.

## Recommended next phases

- **P18.6 Persistence Failure Observability** — includes the durable-state
  nuance for the narrow "cancel raced attempt registration" window (the
  turn now emits `.cancelled` but may leave a durable record in a
  non-terminal state that restart-reconciliation classifies as interrupted;
  benign, but worth explicit observability).
- **P18.3 Swift Concurrency Sendable Audit** — the 23 `@unchecked Sendable`.
- **P18.4 Exact Identity Matching** — includes the dead `error as? LlmFailure`.
