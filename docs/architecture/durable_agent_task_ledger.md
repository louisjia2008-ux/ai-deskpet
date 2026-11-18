# Durable Agent Task Ledger

P4.3 Completion adds a durable runtime ledger boundary for main conversation tasks.

## Protocol

`AgentTaskLedgerPersisting` is defined in `PetAgentRuntime` so the coordinator depends on a protocol,
not a database or file implementation.

It supports:

- append-only event writes
- events by `taskID`
- active task snapshots
- operation ID idempotency checks

The app implementation is `JSONAgentTaskLedgerStore`, which writes to Application Support:

```text
DeskPet/agent_task_ledger.json
```

The test implementation is in-memory.

## Stored Data

The ledger stores:

- `taskID`
- `attemptID`
- `conversationID`
- `userMessageID`
- `assistantMessageID`
- `retryOfTaskID`
- `regeneratedFromMessageID`
- task state
- event kind
- monotonic sequence
- operation ID
- decision source
- provider streaming capability
- failure/cancel reason
- last accepted output sequence
- timestamps

It does not store full prompts, model tokens, capability secrets, credentials or raw private memory.

## Recovery

At app startup, `PetAgentRuntimeCoordinator.reconcileAfterRestart()` loads non-terminal snapshots:

- `awaitingPermission` remains waiting and fail-closed.
- Running/preparing/recovering generation is marked `interruptedByRestart` with failed state.
- Completed/cancelled/failed tasks are not re-executed.

The chat message store separately marks pending assistant messages as `interrupted`, making Retry
available without pretending generation can resume across process restart.
