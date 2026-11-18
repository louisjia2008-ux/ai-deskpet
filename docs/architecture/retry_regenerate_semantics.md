# Retry And Regenerate Semantics

## Retry

Retry is for failed, cancelled or interrupted assistant attempts.

Rules:

- The original user message is reused and not duplicated.
- A new runtime event enters `PetAgentRuntimeCoordinator`.
- The new attempt gets a new `taskID`, `attemptID` and assistant message ID.
- The new assistant message stores `retryOfMessageID`.
- The runtime event carries `retryOfTaskID` when the failed assistant had one.
- The old ledger history remains append-only.

## Regenerate

Regenerate is for a completed assistant message.

Rules:

- The original user message is reused and not duplicated.
- The previous assistant message is preserved.
- A new assistant message is created.
- The new assistant message stores `regeneratedFromMessageID`.
- Any active response is cancelled before the new attempt starts.
- Only one active response attempt is allowed by `ChatModel.busy`.

## UI

The current UI adds minimal inline actions:

- failed/cancelled/interrupted assistant message: `重试`
- completed assistant message: `重新生成`
- pending assistant message: `生成中`
- interrupted assistant message: `已中断`

No broad visual redesign is included in this phase.
