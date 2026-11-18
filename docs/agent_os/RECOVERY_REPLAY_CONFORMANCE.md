# Recovery, Replay, and Conformance P7

P7 closes the deterministic resume boundary without adding a second persistence stack. It builds on the existing `AgentRunEventStore`, `AgentTimelineReplayState`, `AgentTaskProjectionReducer`, provider capability metadata, and tool governance path.

## Runtime Contracts

- `AgentCheckpoint` records the task/run projection, replay cursor, result document snapshot, last sequence, event count, completed tool calls, completed side-effect operation ids, conversation id, completed/pending step ids, accumulated assistant text, UI revision, evidence ids, verifier state, recovery disposition, and a deterministic phase.
- `AgentCheckpointBuilder` filters a task/run event stream, deduplicates by event id, sorts through the canonical replay order, rebuilds the UI/task projection, and derives the safe recovery phase.
- `AgentCheckpointStore` persists derived checkpoints per task/run with atomic replacement, schema-versioned decode defaults, latest/load/delete/prune operations, and replay-sequence validation at bootstrap.
- `AgentRecoveryPlanner` converts a checkpoint into one of five strategies: replay only, resume tool, resume model synthesis, retry provider stream, or require user review.
- `AgentSideEffectLedger` records operation ids, task/run/tool ids, status, and privacy-safe hashes of arguments/results. Started, succeeded, and outcome-unknown operations are not executed again during replay or resume.
- `AgentSideEffectLedgerStore` persists append-only side-effect transitions before external execution and returns cached success for an already-succeeded idempotency key.
- `ModelConformanceProfile` captures provider/model capability limits, adapter and conformance versions, tool-calling mode, true streaming support, streaming tool arguments, parallel tool calls, structured output, reasoning separation, vision, reliability scores, required request flags, incompatible flags, max autonomous steps, allowed/forbidden model roles, expiry, evidence summary, and verification time.
- `ModelConformanceProfileStore` persists profiles by provider/model/adapter/conformance key and feeds the production router policy on runtime recreation.
- `ModelConformanceGate` produces a `ProviderConformanceReport` before a model is used for a role or transport mode that it has not been proven to support.
- `AgentRecoveryBootstrap` loads persisted events, checkpoint, side-effect ledger, and conformance policy into the existing runtime event stream. Corrupt, ahead, duplicate, or gapped checkpoint evidence falls back to event replay with recovery warning events.

## Phase Mapping

- Terminal projection: replay only, no recovery events, no repeated side effects.
- Tool started without terminal tool result: resume at the tool boundary, while the side-effect ledger still blocks duplicate writes.
- Tool result or observation exists but the model did not finish: resume final synthesis, do not execute the tool again.
- Provider stream started but did not complete: retry the provider stream only when the conformance profile allows true streaming; otherwise resume synthesis from recorded evidence.
- Active state with no deterministic boundary: require user review.

## Idempotency Rules

- Duplicate event ids are applied once to checkpoint and replay state.
- Side effects are keyed by stable operation id, not by model prose.
- `started`, `succeeded`, and `outcomeUnknown` side effects suppress execution on recovery.
- `failed` and `cancelled` side effects may be retried by policy, but still keep the prior hash evidence.
- Tool completion after a side effect does not authorize a second side effect if the model response was interrupted.

## Model Role Limits

The conformance gate treats the model role as an explicit capability:

- responder
- planner
- tool caller
- verifier
- synthesizer

For MiniMax M3, the OpenAI-compatible profile records native or fallback tool support through `ProviderToolCapabilityPolicy`, requires `thinking.type=disabled` and `reasoning_split=true`, and keeps hidden reasoning out of visible response text. Chat-only profiles cannot be used as tool callers, native tool-call providers, or true-streaming providers.

## Tests

`P7RecoveryConformanceTests` covers:

- app restart replay restoring terminal task state and UI result snapshot
- cancellation replay producing no resume or new recovery events
- tool completed but model missing, resuming synthesis without repeating the side effect
- duplicate events and side-effect ledger idempotency
- provider stream interruption recovery based on conformance profile
- model role, native tool-calling, true-streaming, max tool-call, and request-flag restrictions
- cross-instance checkpoint recovery from disk after all runtime/store/router instances are recreated
- crash/recreate idempotency for a real test write tool through `ToolRegistry`
- started side effects becoming `outcomeUnknown` without blind retry
- persisted conformance profiles restricting a rebuilt `ModelRouter`
- corrupt checkpoint fallback to event replay
- checkpoint behind/ahead/duplicate/gap sequence handling
- terminal and cancelled checkpoints refusing unsafe resume
- persisted checkpoint, ledger, and profile files excluding secrets and raw reasoning
- opt-in two-process integration proof: phase A writes events/checkpoint/side-effect/profile/counter to a shared temporary root, then phase B runs in a separate `swift test` process and verifies restored text, pending step, UI revision, durable counter still `1`, and persisted router conformance limits
- DEBUG App process seed/reload integration proof: phase A launches the real `DeskPet.app` executable with an isolated automation data root and writes through the production paths; phase B launches a new App process against the same root and verifies checkpoint replay, UI/activity projection reload, side-effect non-repetition, ProviderStore defaults, persisted model conformance, and `ModelRouter` enforcement

## Known Follow-Up

- Scheduled provider conformance refresh is still future work.
- Recovery UI actions must continue to dispatch through the existing Task Center and trust boundaries.
- The 2026-07-27 XCUITest attempts failed before any product/probe assertions because Xcode timed out while enabling automation mode. The 2026-07-28 DEBUG App process seed/reload harness is the accepted recovery/integration proof for P7, but the local macOS XCUITest runner should still be repaired so visual GUI acceptance can execute again.
