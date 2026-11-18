# ADR: Structured Agent Decision

## Status

Accepted for P4.4.

## Context

The previous runtime used a simplified keyword path:

```text
ReasoningModelAdapter -> AssistantCapabilityMap -> respond / plan
```

That path was useful for early seams, but it made it too easy for keyword matching to be mistaken for
a production model decision.

## Decision

DeskPet now uses a structured decision boundary. Model output is first decoded as
`UntrustedAgentDecisionEnvelope`, validated, and only then converted into the domain `AgentDecision`.
The domain cases are `respond`, `proposePlan`, `askClarification`, `decline`, and `noAction`.

Keyword matching may remain only as an explicit `ruleBasedFallback`, with diagnostics preserving that
source.

`AgentPlanProposal` is not executable. `AgentPlanner` may normalize it into an `AgentPlan`, but every
side effect still requires `CapabilityBroker` and a granted token before `ToolExecuting` can run.

## Consequences

- malformed or malicious model output fails closed
- unknown capabilities never execute
- `toolsAllowed=false` prevents model plans from becoming runtime work
- model-provided approval or grant fields are rejected
- current conversation provider remains `nonStreaming`
- OpenClaw and Hermes remain research references only; the runtime does not depend on them
