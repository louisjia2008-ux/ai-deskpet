# Capability Kernel P6

The Capability Kernel describes what the agent can do and how capabilities map to tools, providers, UI, and permissions.

## Current Capability Model

- `RiskLevel`: P0 through P4.
- `Capability`: id, domain, risk, summary, examples, dependencies, data access.
- `CapabilityCatalog`: current catalog for time, system, frontmost app, files, screen, calendar, reminders, app launching, schedule, network, shell, git, mail, browser, delete, accessibility, keychain, contacts.
- `ToolManifest`: tool id, display name, description, risk, input schema, output schema, availability.
- `ToolCatalogSnapshot`: per-run snapshot exported to provider adapters.

## Current Release Tools

`ToolPlatformAssembly.releaseTools` currently exposes:

- `get_current_datetime`
- `system_profile`
- `frontmost_application`
- `today_calendar_events`

These are the correct P0/P1 tools to preserve while expanding the kernel.

## Implemented Capability Descriptor

P6 adds `Sources/PetAgentRuntime/CapabilityKernel.swift` as an additive kernel layer over the existing `CapabilityCatalog`, `ToolManifest`, and `ToolCatalogSnapshot`.

`CapabilityDescriptor` now normalizes:

- stable id
- version
- input schema
- output schema when known
- permission requirements
- side-effect level
- privacy class
- cancellation support
- progress support
- timeout seconds
- reliability metadata
- source tool id when the descriptor comes from a tool manifest

The descriptor is intentionally derived from the existing registry/catalog contracts rather than maintained as an independent source of truth.

## Capability Graph

`CapabilityKernel.graph(from:workflows:)` builds a deterministic graph with:

- `capability:*` nodes from `CapabilityCatalogSnapshot.capabilities`
- `tool:*` nodes from `ToolCatalogSnapshot`
- `workflow:*` nodes from composed workflows
- `requires`, `provides`, and `precedes` edges

This graph is a read model only. It does not execute tools, mint grants, or register anything.

## Gap Detection

`CapabilityKernel.detectGaps(requiredIDs:in:policy:)` classifies required capabilities/tools as:

- available
- disabled tool
- missing tool
- permanently denied by distribution tier
- unknown capability

P6 tests verify that an App Store policy reports `network.fetch` as permanently denied and an unknown restaurant-style capability as unknown rather than faking a connector.

## Dynamic Workflow Composition

`DynamicWorkflowComposer` creates declarative workflows only when every required tool/capability is present in the current snapshot. `DynamicWorkflowExecutor` then runs the composed steps through:

```text
DynamicWorkflow
 -> ToolCatalogSnapshot lookup
 -> input schema validation
 -> PermissionGate evaluation
 -> ToolPlatformExecuting
 -> output schema validation
 -> AgentEvidenceRecord
```

This proves composition without adding a second ToolRegistry. P6 fixture tests use two safe tools and assert the real execution path calls both the Permission Gate and Tool Platform.

## Provider Exposure

Provider tool schemas must come only from `ToolCatalogSnapshot`. A provider cannot invent tools. If provider tool calling is unsupported, JSON fallback instructions can be generated from the same snapshot.

## Remaining Gaps

- Browser/computer-use capabilities are future work and must not bypass ToolRegistry.
- Location, payments, purchases, destructive writes, and arbitrary shell need separate high-risk policies before exposure.
- Workflow argument templating is intentionally minimal in P6; richer data binding should stay declarative and schema-checked before any script runner is expanded.
