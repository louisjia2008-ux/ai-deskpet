# P9C Activity Protocol

## Principle

P9C does not add an event protocol. Workflow stages emit existing `AgentTaskActivityEvent` values through `PetAgentRuntimeCoordinator.emitActivity`, and tool lifecycle events remain owned by `ToolRegistry`/tool runtime paths.

## User Visible Stage Mapping

- `classifyIntent`: 正在理解你的地点需求
- `buildQuery`: 已识别筛选条件
- `resolveLocation`: 正在确定搜索位置
- `searchCandidates`: 正在搜索附近地点
- `deduplicateCandidates`: 正在合并重复地点
- `estimateDistances`: 正在估算距离和路线
- `enrichCandidates`: 正在补充营业时间和其他信息
- `validateCandidates`: 正在验证最终结果
- `genericVerifier`: 验证完成 / 验证保留限制
- `synthesizeResult`: 正在整理候选结果

## Tool Mapping

`AgentActivityPresentation` now has additive metadata for:

- `approximate_location`
- `local_place_search`
- `route_distance_estimate`
- `webpage_read`
- `structured_place_extraction`

The EventHub user reducer also recognizes Local Discovery tool lifecycle events and workflow stage activity events.

## Privacy

- Activity titles and details pass through existing redaction.
- Raw tool arguments are not displayed.
- Webpage content is treated as untrusted and is not shown as raw model thinking.
- Candidate fields preserve `unknown`, `partial`, and `conflicting` states instead of collapsing to a single verified boolean.

## Terminal Behavior

P9C uses a cancellation barrier:

- Activity before the barrier may remain visible.
- The cancellation terminal event itself is visible.
- Normal user-visible progress, tool completion, verifier completion, and synthesis completion after the barrier are rejected by workflow cancellation checks.
- The workflow writes a cancelled `LocalDiscoveryWorkflowSnapshot` so recovery does not resume cancelled tasks.

Existing terminal events still come from the coordinator/converse path.

## Checkpoint Activity

The workflow emits a redacted checkpoint progress activity after each durable boundary:

- query approved
- location resolved
- initial search completed
- dedup completed
- route item and route batch completed
- enrichment item and enrichment batch completed
- validation completed
- verifier completed
- result synthesized

These labels are not the durable source of truth. The durable source is the versioned snapshot stored inside `AgentCheckpointStore`.

## GUI Smoke Status

The DEBUG App smoke harness launches through AppDelegate, uses `ChatModel.send`, and observes the same `AgentTaskActivityStore` used by Floating Chat and Task Center. Final closeout evidence produced terminal complete and cancel artifacts from independent App processes and isolated data roots.

Complete flow evidence:

- input: `帮我找 San Jose 附近今晚还能练球、关门比较晚的高尔夫练习场。`
- terminal status: `partiallySucceeded`
- workflow stage: `resultSynthesized`
- result status: `partial`
- tools visible in activity: `local_place_search`, `route_distance_estimate`
- checkpoint phase: `terminal`
- no-secret assertion: true

Cancel flow evidence:

- Stop was invoked after the workflow entered `searchCandidates` / `local_place_search`.
- terminal status: `cancelled`
- workflow stage: `cancelled`
- checkpoint phase: `terminal`
- result document: none
- no-secret assertion: true

Known limitation: XCUITest was not claimed in this closeout. The accepted GUI/product evidence is the real App process harness plus screenshots, event traces, checkpoint summaries, and ledger summaries.
