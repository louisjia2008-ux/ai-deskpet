# Generative UI Schema P5

Native Generative UI now has a snapshot/patch protocol, native SwiftUI renderer coverage, and deterministic interaction events. It still avoids HTML, JavaScript, WebView, dynamic Swift, and arbitrary layout code.

## Current Schema

`AgentResultDocument` contains:

- schema version
- stable id
- task id
- run id
- title
- summary
- status
- generated and updated timestamps
- optional freshness
- sections
- sources
- actions
- metadata

Supported components:

- text
- status
- progress
- keyValue
- list
- choiceList
- table
- comparisonList
- cardGrid
- comparisonCards
- timeline
- form
- confirmation
- map data model
- chart data model
- artifact
- sourceList
- actionRow
- errorRecovery
- emptyState

## Current Validation

`AgentResultValidator` checks:

- schema version
- duplicate ids
- component count
- payload size
- text/table/source/action limits
- source URL scheme
- action references
- registered tool id
- argument schema compatibility
- approval requirement for external-write tools
- progress finite/total bounds
- choice selected/action references
- form/confirmation action references
- map coordinate bounds
- chart finite value bounds
- patch payload cannot blank a result

Invalid documents degrade to text and do not fail the task.

## Snapshot/Patch

- `AgentResultDocument.revision` identifies the current UI snapshot revision.
- `AgentResultPatch` carries `documentID`, `taskID`, `runID`, `baseRevision`, `revision`, operations, and timestamp.
- `AgentResultPatchReducer` rejects document/task mismatches, stale or out-of-order revisions, invalid component payloads, and patches that would remove every section.
- Valid patches can upsert/remove sections, update status/summary/freshness/metadata, resolve a choice, and collapse a section.
- `AgentEventKind.resultSnapshot` and `AgentEventKind.resultPatch` map into canonical `AgentStreamEventKind.resultSnapshot/resultPatch`; old `resultProduced` events still replay as snapshots unless explicitly marked as patches.

## Interaction

- `AgentResultInteractionEvent` carries `taskID`, `runID`, `documentID`, `componentID`, `actionID`, sanitized payload, and timestamp.
- `AgentResultView` renders choice lists as native SwiftUI controls and emits interaction events through its callback.
- `TaskCenterView` forwards result actions and choices to `CompanionAgentRuntimeModel.handleResultInteraction`; SwiftUI views do not directly run tools.
- Choice interactions create a deterministic resolved/collapsed patch such as `已选择：Chengdu House`.
- Post-terminal UI patches are allowed only for `resultPatch` / `uiInteractionResolved` and do not change the terminal task state.

## Current Renderer

`AgentResultView` renders only fixed SwiftUI components. It does not use HTML, JavaScript, WebView, dynamic Swift, or arbitrary layout code.

Task Center owns placement. Runtime, ToolRegistry, PermissionGate, and ActionDispatcher own side effects.

## P5 Gate Evidence

```text
P5 focused: Executed 5 tests, with 0 failures (0 unexpected)
P5 regression band: Executed 124 tests, with 2 tests skipped and 0 failures (0 unexpected)
P5 full SwiftPM gate: Executed 708 tests, with 2 tests skipped and 0 failures (0 unexpected)
xcodegen generate: PASS
xcodebuild -list -project DeskPet.xcodeproj: PASS, with sandbox/CoreSimulator warnings
git diff --check: PASS
```

The complete choice-flow test is fixture-based, as required by the phase text: skeleton snapshot, candidate patch, user choice interaction, resolved/collapsed patch, and replay consistency.

## Gaps

- Artifact export is deferred.
- Floating Chat shows concise activity, not full result UI.
- Real local place-search/web vertical is not wired in P5 because the existing release tool catalog does not expose that capability.
