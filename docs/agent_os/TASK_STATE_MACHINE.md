# Task State Machine

This document tracks the canonical task/run state machine from P0 audit through the current P8 implementation.

## P1 Implementation Status

`Sources/PetAgentRuntime/AgentStreamEvent.swift` now defines `AgentRunState` and `AgentTaskProjectionReducer`.

The reducer:

- deduplicates events by id.
- sorts same-source events by sequence and cross-source events by timestamp.
- maps legacy and canonical event kinds into one run state.
- rejects post-terminal events for the same run.
- carries conversation, user-message, assistant-message, current-step, terminal-summary, failure-category, and result-document metadata.

`AgentTaskActivityStore` publishes `canonicalTasks` beside the legacy `tasks` projection so current UI can continue to render safely while P1-P3 migrate Chat, Floating Chat, and Task Center onto the canonical snapshot.

## Current State Sources

- `PetBrainCore.AgentTaskState`: durable task lifecycle with approval, queued, running, recovery, partial success, rollback.
- `PetAgentRuntime.AgentTaskStatus`: activity projection status for Task Center and chat cards.
- `AgentLoopState`: bounded loop execution phase.
- `AgentTaskSchedulerStatus`: scheduler/queue/resource state.

These are all useful, but they overlap. The current migration keeps specialized internal states and exposes a single canonical run state to UI and replay.

## Target Canonical States

- `created`
- `queued`
- `preparing`
- `understanding`
- `planning`
- `awaitingApproval`
- `awaitingPermission`
- `awaitingUserInput`
- `running`
- `streaming`
- `executingTool`
- `verifying`
- `recovering`
- `succeeded`
- `partiallySucceeded`
- `failed`
- `cancelled`
- `interrupted`

Terminal states:

- `succeeded`
- `partiallySucceeded`
- `failed`
- `cancelled`
- `interrupted`

## Legal Transition Skeleton

```text
created -> queued -> preparing
preparing -> understanding -> planning
planning -> awaitingApproval -> running
planning -> awaitingPermission -> running
planning -> running
running -> streaming
running -> executingTool -> running
running -> verifying -> running
running -> verifying -> succeeded
running -> verifying -> partiallySucceeded
running -> verifying -> failed
running -> failed
running -> cancelled
running -> interrupted
recovering -> running
recovering -> failed
```

Any active state can move to `cancelled` through user cancellation. Any active state can move to `failed` when deterministic runtime handling fails. Terminal states cannot move to another terminal state in the same run.

## Current Mapping

- `AgentLoopState.preparing` -> `preparing`
- `AgentLoopState.requestingModel` -> `understanding` or `streaming`
- `AgentLoopState.awaitingToolApproval` -> `awaitingApproval`
- `AgentLoopState.executingTool` -> `executingTool`
- `AgentLoopState.toolObserved` -> `running`
- `AgentLoopState.feedingObservation` -> `understanding`
- `AgentLoopState.finishing` -> `verifying`
- `AgentLoopState.completed` -> terminal state from loop result
- `AgentLoopState.cancelled` -> `cancelled`
- `AgentLoopState.failed` -> `failed`

`AgentTaskSchedulerStatus` remains queue/resource metadata and must not override runtime terminal truth.

## P3 Verification Mapping

- `verificationStarted` maps to the canonical `verifierStarted` stream event and moves the run to `verifying`.
- `verificationSucceeded` maps to `verifierCompleted`; the run remains active until final synthesis and terminal completion.
- `verificationFailed` maps to `verifierFailed`; it records validation failure evidence, and the subsequent `taskFailed` event moves the run to `failed`.
- For `get_current_datetime`, verification is deterministic and checks the actual tool observation, not model prose.
- Scheduler and runtime can emit events for the same task/run, but their sequence counters are independent. Reducers must compare sequence only within the same source and use timestamps for cross-source replay so scheduler terminal events cannot overtake runtime verification.

## P1 Reducer Target

The canonical reducer is the intended producer for:

- active run card state
- chat activity bubble state
- Task Center row state
- replay state
- action availability, including stop/retry/approve

The reducer must consume canonical events only. Compatibility adapters can convert legacy events at the boundary.

## Invariants

- A terminal run never becomes active again.
- A new retry/regenerate attempt is a new run linked to the prior message/run.
- Scheduler-triggered runs cannot silently grant permissions.
- Activity status must come from runtime events, not from provider prose.
- UI does not display raw task ids or run ids outside developer diagnostics.
