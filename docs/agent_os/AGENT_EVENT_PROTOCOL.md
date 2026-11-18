# Agent Event Protocol

This document tracks the event protocol from the P0 audit through the current P8 state. The current implementation defines a canonical `AgentStreamEvent` while preserving the existing event store and UI projections.

## P1 Implementation Status

`Sources/PetAgentRuntime/AgentStreamEvent.swift` now defines the additive canonical protocol:

- `AgentStreamEvent` carries target identifiers for task, run, conversation, user message, assistant message, agent, parent event, sequence, source, visibility, kind, and redacted payload.
- `AgentStreamEventKind` normalizes task, model, tool, provider, user-input, result, UI, recovery, warning, and diagnostic events.
- adapters lift existing `AgentEventEnvelope` and legacy `AgentTaskActivityEvent` rows into canonical events without replacing `AgentEventHub` or `AgentRunEventStore`.
- conversion back to `AgentEventEnvelope` preserves replay compatibility for current JSONL stores and preserves `parentEventID`.
- P3 adds first-class verification envelope kinds and stream verifier events for deterministic tool-result checks.
- P8 adds first-class `AgentEventEnvelope.parentEventID` so grouped parallel tool relationships survive stream/envelope round-trip and replay.

P1 intentionally remains additive. Existing runtime outputs and legacy activity events still feed current UI while canonical projections are made available beside them.

## Current Sources

- `PetAgentRuntimeOutput` is emitted by `PetAgentRuntimeCoordinator.handle`.
- `AgentTaskActivityEvent` is a legacy activity event consumed by chat and Task Center.
- `AgentEventEnvelope` is the newer event envelope used by `AgentEventHub`, replay, redaction, and run event persistence.
- `RuntimeEventEnvelope` in `RuntimeEventBus` carries lifecycle, action, tool, permission, and audit events for lower-level runtime components.

## Current Envelope

`AgentEventEnvelope` now has:

- schema version
- event id
- task id
- run id
- sequence
- timestamp
- source
- visibility
- parent event id
- kind
- payload

The following target fields remain lifted into canonical stream events from payload/adapter metadata rather than stored as first-class envelope columns:

- conversation id
- user message id
- assistant message id
- agent id
- run attempt id
- target protocol names for understanding, planning, verifying, UI snapshot, UI patch, checkpoint, and recovery events

Some of these values exist inside legacy payloads today. The compatibility rule is to lift them into canonical stream events without breaking old JSONL replay.

## Target Event Families

- `task.*`: created, queued, started, resumed, checkpointed, completed, failed, cancelled, interrupted.
- `agent.*`: selected, delegated, verifierStarted, verifierCompleted, criticStarted, criticCompleted.
- `verifier.*`: started, completed, failed.
- `model.*`: requestStarted, delta, reasoningDeltaHidden, toolCallDelta, responseCompleted, conformanceFailed.
- `tool.*`: callProposed, approvalRequired, started, progress, observation, completed, failed, cancelled.
- `permission.*`: requested, granted, denied, expired, consumed.
- `ui.*`: activityDelta, resultSnapshot, resultPatch, interactionRequested, interactionResolved.
- `memory.*`: candidateProposed, candidateAccepted, candidateRejected, retrievalUsed.
- `recovery.*`: replayStarted, replayCompleted, rollbackStarted, rollbackCompleted.

## Visibility

Existing `AgentEventVisibility` is reusable:

- `user`: safe activity visible in chat or Task Center.
- `developer`: technical details shown only in expanded diagnostics.
- `diagnostic`: redacted replay/export data.
- `hidden`: never rendered to ordinary UI.

Raw chain-of-thought, raw reasoning, hidden provider thinking, API keys, full prompts, raw tool arguments containing secrets, and raw tool logs must never be emitted as `user` or `developer` text.

## Reducer Rules

The implementation keeps event append as the source of truth and derives UI state through reducers:

- event id dedupe is mandatory.
- sequence is monotonic per run and source.
- sequence is source-local; reducers compare sequence only within the same event source and use timestamps for cross-source scheduler/runtime replay.
- terminal events close the run.
- verifier failure is not a terminal event by itself; the subsequent task terminal event anchors the run result.
- post-terminal events are ignored or converted to diagnostic warnings.
- cancellation is terminal and idempotent.
- failed initial ledger writes produce `failed` and cannot be followed by success.
- old `AgentTaskActivityEvent` rows convert to canonical envelopes during replay.

## Redaction

`AgentEventRedactor` remains the right extension point. P1-P2 added or exercised streaming-specific redaction for:

- split `<think>` or `<thinking>` tags
- `reasoning_content`
- provider hidden thinking fields
- Authorization and Cookie headers
- local paths
- email-like identifiers
- raw tool arguments for non-user-visible events

## Migration

Do not replace `AgentEventHub` or `AgentRunEventStore`. Canonical event construction and projection adapters sit around them. Old JSONL lines remain loadable; new fields are additive.
