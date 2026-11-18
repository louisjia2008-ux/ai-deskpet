# Agent Result Schema

## Source Of Truth

Structured results are defined in `Sources/PetAgentRuntime/AgentResultDocument.swift`.

The runtime model is `AgentResultDocument`. The validator is `AgentResultValidator`. The optional decision supplement parser is `StructuredDecisionSupplementParser`.

## Data Flow

Provider output can include optional `resultDocument`. `RawStructuredDecisionProvider` parses it after the main `AgentDecision` validates. The result document is validated against the current `ToolCatalogSnapshot`.

Valid documents are carried through `AgentLoopDecisionResult` and `AgentLoopRunResult`, emitted as a `resultProduced` event, attached to `AgentTaskRunActivity`, persisted by the existing activity/run event stores, and rendered in Task Center.

Invalid documents are locally dropped. The main final response remains usable as text.

## Ownership

The model may propose a result document but does not own rendering, actions, or persistence. The runtime validates, the existing activity ledger carries it, and SwiftUI renders only the validated model.

## Lifecycle

A result has stable `id`, `taskID`, `runID`, title, summary, status, generated time, last updated time, optional freshness, sections, sources, actions, and metadata.

First-version components are:

- `text`
- `status`
- `keyValue`
- `list`
- `table`
- `comparisonCards`
- `timeline`
- `sourceList`
- `actionRow`
- `errorRecovery`

Unsupported components fail decoding or validation and fall back to text.

## Failure Handling

`AgentResultValidator` checks schema version, duplicate IDs, component count, payload size, text/table/source/action limits, http/https source URLs, action references, registered tool IDs, argument schema compatibility, and approval requirements for external-write tools.

Invalid result documents do not fail the task. `AgentResultValidator.fallbackText` preserves a user-facing summary.

## Migration

Old tasks have no `resultDocument` and continue to replay as activity-only tasks. New event payload case `result` is optional and does not change existing activity JSONL lines.

## Security Boundary

The schema forbids arbitrary HTML, JavaScript, Swift, dynamically compiled SwiftUI, WebView mini apps, and script execution. Source URLs are display-only and must be http/https. Renderer actions are not executed directly by UI.

Action binding requires a registered tool in `ToolCatalogSnapshot` and schema-valid arguments. External-write or higher risk actions must require approval.

## Test Coverage

`Tests/DeskPetTests/P6ResultSchemaTests.swift` covers valid decode/validation, unknown components, unsupported schema version, table limits, duplicate IDs, URL scheme rejection, unregistered tool action rejection, argument mismatch, external-write approval, invalid fallback, supplement parser local degradation, DEBUG travel fixture validation, and production manifest exclusion.

`P6ActivityProjectionTests` covers result attachment through activity reducer and replay envelope.

## Deferred Work

Partial result updates are represented by stable IDs but do not yet merge multiple versions. Real artifact export and user-triggered action dispatch from result rows are deferred.
