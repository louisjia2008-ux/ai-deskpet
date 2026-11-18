# P18.5 — Cancellation Surface Inventory

Scope: `DeskPet/Sources/DeskPet/`, `DeskPet/Sources/PetAgentRuntime/`,
`DeskPet/Sources/AICore/`. Request/task-scoped asynchronous cancellation
boundaries only (lifecycle/teardown was audited in P18.2 and is not
re-inventoried here).

Status legend: `SAFE` · `DEFECT` · `PARTIAL` · `NEEDS_PROOF` ·
`NOT_CANCELLABLE_BY_DESIGN`.

## A. Continuation bridges (`withChecked*/withUnsafe*Continuation`)

| ID | File:Line | Purpose | Exactly-once mechanism | Cancel behavior | Late result | Status |
|----|-----------|---------|------------------------|-----------------|-------------|--------|
| CB-1 | PetAgentRuntimeCoordinator.swift:616/624 | plan approval (conversationID-keyed) w/ timeout | actor + `pendingPlanApprovals.removeValue` gate | timeout Task resumes `.timedOut` once; drop resumes `.declined` | removeValue drops stale | SAFE |
| CB-2 | PetAgentRuntimeCoordinator.swift:1131 | local-discovery planner factory deadline race | `LocalDiscoveryPlannerFactoryDeadlineGate` (NSLock `claim()`) + `defer` cancels both tasks | timeout winner cancels factoryTask | gate rejects loser | SAFE (bounded ≤10s orphan on parent-cancel; local factory, not provider quota) |
| CB-3 | TaskSupervisor.swift:85 | durable plan approval w/ 50ms-poll timeout | `pendingApprovals.removeValue` gate (INV-CONT-04) | timeout/resume/drop all `removeValue`-gated | dropped | SAFE |
| CB-4 | LocalDiscoveryWorkflow.swift:1574 | planner deadline race | `LocalDiscoveryPlannerDeadlineGate` (NSLock) + `defer` cancels both | timeout winner cancels operationTask | gate rejects loser | SAFE (same bounded-orphan caveat as CB-2) |
| CB-5 | LLMService.swift:41 | local `DeskPetLLM` helper request/response w/ 8s timeout | @MainActor + `pending.removeValue(id)` gate | no cancel propagation; bounded by 8s timeout; helper keeps computing | removeValue drops stale | PARTIAL — NOT_CANCELLABLE (local subprocess, no cloud quota); not the live chat path (ChatModel routes via `runtime`, not `services.llm`) |
| CB-6 | ToolRunnerService.swift:30 | sandboxed tool subprocess request w/ timeout | @MainActor + `pending.removeValue(id)` gate | no cancel propagation; bounded by timeout | removeValue drops stale | PARTIAL — NOT_CANCELLABLE (local subprocess); low severity |
| CB-7 | KeychainSecretStore.swift:132 | keychain lookup w/ timeout via 2× `Task.detached` | `KeychainLookupRace` actor `didResume` flag | sync `SecItemCopyMatching` not cancellable; bounded by timeout | actor gate drops loser | SAFE / NOT_CANCELLABLE_BY_DESIGN (sync leaf) |
| CB-8 | ScreenReader.swift:47 | Vision OCR request | single `cont` resume in success/catch | bounded; no cancel | single-shot | SAFE |
| CB-9 | RemindersBridge.swift:29 | EventKit fetch | single `cont.resume` | bounded EventKit call | single-shot | SAFE |
| CB-10 | ToolExecutors.swift:245 | EventKit reminder titles | single `c.resume` | bounded | single-shot | SAFE |
| CB-11 | SystemPlaceHandoffDispatcher.swift:48 | NSWorkspace open URL (@MainActor) | single resume | side-effecting (opens URL); no mid-flight cancel | single-shot | SAFE (side-effecting; see §Tools) |
| CB-12 | LocalDiscoveryAgentTools.swift:481/572/726 | CLLocation / webpage read | `withTaskCancellationHandler` + `continuation?.resume` | **explicit cancel handler** resumes `CancellationError()` | nils continuation | SAFE (best-in-class pattern) |

## B. Provider / streaming

| ID | File:Line | Purpose | Cancel propagation | Underlying I/O cancelled? | Status |
|----|-----------|---------|--------------------|--------------------------|--------|
| PR-1 | ProviderClientFactory.swift:445 (OpenAI-compat `streamChat`) | SSE token stream | `AsyncThrowingStream` + `onTermination { task.cancel() }`; catches `is CancellationError` → yields `cancellationAcknowledged`, finishes | YES — cancels `http.streamLines`/URLSession bytes task | SAFE |
| PR-2 | ProviderClientFactory.swift:643 (Ollama `streamChat`) | local stream | same pattern | YES | SAFE |
| PR-3 | ProviderClientFactory.swift:390/601 (`sendChat` non-stream) | one-shot completion | `try await http.data(for:)` throws `CancellationError` on task cancel; Ollama rethrows explicitly | YES (URLSession cancel) | SAFE |
| PR-4 | AIServices.swift:236/297 (`selectedProvider*Response`) | picks provider + calls `sendChat` | generic `catch` **formerly masked `CancellationError` → `.unknown`** | — | **DEFECT F2 (fixed)** — see §Findings |
| PR-5 | ModelRouter.swift | provider/model selection | pure selection; no retry/fallback loop, no catch | N/A | SAFE — **no fallback-on-cancel possible** |

## C. Live agent-loop decision provider

| ID | File:Line | Cancel propagation | Status |
|----|-----------|--------------------|--------|
| DP-1 | ProviderAgentLoopAdapters.swift:334/405/454 (`decide*`) | `try await client.sendChat/streamChat` propagate throws; explicit `throw CancellationError()` at 294/463 | SAFE |
| DP-2 | RuntimeAdapters.swift:136 `LegacyConversationProvider.generate` | `Task.isCancelled` guard after await (line 150); `onTermination { task.cancel() }` | SAFE |
| DP-3 | RuntimeAdapters.swift:176 `LegacyConversationProvider.typedGenerate` | `Task.isCancelled` guard (186); **catch formerly surfaced cancel as `.typedError`** | **DEFECT F2b (fixed)** |

## D. AsyncStream producers (`onTermination`)

| ID | File:Line | onTermination action | Status |
|----|-----------|----------------------|--------|
| AS-1 | PetAgentRuntimeCoordinator.swift:748 `handle(_:)` | `task.cancel()` + on consumer-cancel `cancel(conversationID:)` | SAFE |
| AS-2..7 | ProviderClientFactory:507/691, ModelCatalogService:85, TaskPlanExecutor:233, AutomationAgentLoopDecisionProvider:119, RuntimeAdapters:166/212 | `task.cancel()` | SAFE |
| AS-8 | AgentEventModels.swift:715, RuntimeEventBus.swift:68 | unregister subscriber (owner-held bus) | SAFE (lifecycle, P18.2) |
| AS-9 | RuntimeRetryScheduler.swift:156 | wakeup-change stream teardown | SAFE |

## E. Scheduler / retry / timeout / durable

| ID | Area | Finding | Status |
|----|------|---------|--------|
| SC-1 | PetAgentRuntimeCoordinator `converse()` pre-chunk guard (1273) | checks `isCancelled(conversationID) ‖ Task.isCancelled ‖ isAttemptTerminalized` → emits `.cancelled` | SAFE |
| SC-2 | PetAgentRuntimeCoordinator `converse()` **catch** (1306) | guard formerly only `isAttemptTerminalized` → a thrown cancel could be recorded `.failed`/`.waitingForRetry` | **DEFECT F1 (fixed)** |
| SC-3 | AgentRetryPolicy.shouldRetry (AgentRetryPolicyLlmFailure.swift:36) | `.unknown` AND `.cancelled` → **non-retryable** (returns false) | SAFE — cancel never retryable by policy |
| SC-4 | RuntimeRetryScheduler.driveDueWork (102) | deadline-driven notification only; eligibility decided in `resumeExecution` | SAFE |
| SC-5 | resumeExecution (2279) | `guard record.status == .running` (2312) → cancelled durable task never resumed | SAFE — no restart resurrection (§23) |
| SC-6 | Retry backoff | `nextRetryAt` + wakeup, **not** a `try? Task.sleep` retry loop → no swallowed-cancel-then-retry | SAFE |

## F. Timeout races

All three timeout implementations (CB-2, CB-4, and the coordinator planner)
use a `claim()`/gate for exactly-once resume and a `defer` that cancels BOTH
the operation task and the timeout task; the timeout winner additionally
cancels the operation task. No orphaned losing branch beyond the bounded
window. `KeychainSecretStore`/`LLMService`/`ToolRunnerService` use a
timeout that resumes the continuation but cannot interrupt the underlying
sync/subprocess work (bounded, non-quota). SAFE / NOT_CANCELLABLE_BY_DESIGN.

## G. Nested / detached Task

- `Task.detached` × 2 — both in `KeychainSecretStore.withTimeout` (CB-7),
  gated by `KeychainLookupRace` actor. Justified (need detachment from the
  MainActor-isolated caller for a blocking sync keychain call). SAFE.
- Unstructured `Task { }` inside async functions (CB-2/CB-4 race arms,
  coordinator `handle` producer, approval timeout tasks) — each is owned by
  a gate/`defer` that cancels it; none perform unbounded request-scoped
  provider work detached from the parent's terminal contract.

## Summary counts

| Surface | Sites | SAFE | DEFECT | PARTIAL | NEEDS_PROOF |
|---------|-------|------|--------|---------|-------------|
| Continuation | 12 | 10 | 0 | 2 (local subprocess, non-quota) | 0 |
| Nested Task | ~8 | 8 | 0 | 0 | 0 |
| Task.detached | 2 | 2 | 0 | 0 | 0 |
| Provider request | 5 | 4 | 1→fixed | 0 | 0 |
| Streaming | 4 | 4 | 0 | 0 | 0 |
| Scheduler | 6 | 5 | 1→fixed | 0 | 0 |
| Retry/backoff | — | SAFE | 0 | 0 | 0 |
| Timeout | 3+3 | all | 0 | 0 | 0 |
| Tool | see §Tools | — | 0 | 0 | 0 |
| AsyncStream | 9 | 9 | 0 | 0 | 0 |
| Durable task | resumeExecution | SAFE | 0 | 0 | 0 |
| UI generation | ChatModel | SAFE | 0 | 0 | 0 |

## Findings (fixed this round)

- **F1 (Sev 6, durable/observability mislabel)** — `converse()` catch guarded
  only `isAttemptTerminalized`; broadened to the full pre-chunk predicate set
  (`CancellationError | Task.isCancelled | isCancelled(conversationID) |
  isAttemptTerminalized`) so a cancellation surfacing as a throw is always
  terminalized `.cancelled`, never `.failed`/`.waitingForRetry`.
- **F2 (Sev 5, latent, defanged)** — `AIServices.classify` mapped
  `CancellationError` → nil → `.unknown`. Now maps to `.cancelled`
  (non-retryable, truthful). Central fix covers `selectedProviderTypedResponse`
  and `LegacyConversationProvider.typedGenerate`.
- **F2b** — `LegacyConversationProvider.typedGenerate` catch now drops
  cancellation instead of emitting a `.typedError` failure chunk.

## Adjacent (not fixed — see P18_5_FOLLOWUP_FINDINGS.md)

- `PetAgentRuntimeCoordinator.swift` `error as? LlmFailure` — pre-existing
  always-fails cast (LlmFailure is not an `Error`); dead branch.
- `LLMService`/`ToolRunnerService` lack cancel propagation (bounded, local,
  non-quota) — acceptable by design; documented.
