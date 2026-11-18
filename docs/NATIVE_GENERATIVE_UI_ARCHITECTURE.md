# Native Generative UI Architecture

## Source Of Truth

The renderer is `Sources/DeskPet/UI/AgentResultView.swift`. Task Center integration is `Sources/DeskPet/UI/TaskCenterView.swift`.

The renderer consumes `AgentResultDocument` only. It never consumes raw provider JSON and never generates or executes code.

## Data Flow

`AgentResultDocument -> AgentResultValidator -> resultProduced event -> AgentTaskActivityStore projection -> TaskCenterView -> AgentResultView`

Floating Chat continues to receive concise task activity and terminal messages. Full result UI appears in Task Center when `AgentTaskRunActivity.resultDocument` exists.

## Ownership

`AgentResultView` owns visual rendering for safe components. `TaskCenterView` owns placement and task-detail context. Runtime/ToolRegistry/PermissionGate own actions and side effects.

## Lifecycle

Task Center renders the result panel before the safety timeline. Old tasks without results show no result panel. Replayed tasks restore the same panel from the event store.

The DEBUG travel sample is `P6DebugTravelFixture` and is not part of release manifests.

## Failure Handling

If validation fails, no result panel is attached. The user keeps the plain final text. Developer diagnostics can inspect validation issues through provider metadata and tests.

## Migration

No UI migration is required for old tasks. Optional `resultDocument` defaults to nil.

## Security Boundary

The renderer supports fixed SwiftUI component types only. It does not use WebView, HTML, JavaScript, dynamic Swift, arbitrary layout DSL, or automatic URL opening. Links render only from validated http/https source URLs and open only on user click.

Action rows surface intent but do not execute tools directly. In P6, Task Center shows a safe message that actions must go through the Runtime permission channel.

## Accessibility And Localization

The view uses native SwiftUI text, buttons, links, and selection. Task Center labels the result panel for accessibility. UI copy follows the current Chinese-first DeskPet surface and existing design tokens.

## Test Coverage

`P6ResultSchemaTests` validates document safety and fixture structure. `P6ActivityProjectionTests` validates replay attachment. Build verification compiles the SwiftUI renderer and Task Center integration.

## Deferred Work

Full keyboard focus traversal tuning, per-field expand/collapse state, and UI-driven action dispatch through `ActionDispatcher` are deferred. The renderer is ready for those without changing the schema boundary.
