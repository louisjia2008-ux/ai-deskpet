# Agent Plan Validation

`AgentPlanProposal` is not an executable plan. It is a validated intent proposal that can only become
runtime work through local normalization:

```text
AgentPlanProposal
 -> AgentPlanner
 -> AgentPlan
 -> CapabilityGate
 -> CapabilityBroker
 -> granted CapabilityToken
 -> ToolExecuting
```

`AgentPlanner` converts each proposal step into an `AgentPlanStep`; it does not execute tools and it
does not approve capabilities. `PetAgentRuntimeCoordinator` enforces broker-before-executor ordering.

## Validation Rules

The validator rejects:

- malformed JSON
- unsupported `schemaVersion`
- `kind` and payload mismatch
- unknown top-level or payload fields
- oversized strings
- excessive plan steps
- duplicate step IDs
- empty or unknown capability IDs
- capabilities absent from the current `CapabilityCatalogSnapshot`
- model-provided `approved`, `grant`, `trusted`, `token`, or `executable` fields
- dangerous argument keys or values such as command/path fields and shell-like payloads

Validation failure produces `deterministicFallback`, zero grants, and zero tool executions.
