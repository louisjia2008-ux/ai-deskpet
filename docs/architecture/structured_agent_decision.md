# Structured Agent Decision

DeskPet treats model decisions as untrusted proposals. The formal path is:

```text
AgentContext
 -> StructuredDecisionProviding
 -> UntrustedAgentDecisionEnvelope
 -> StructuredDecisionValidator
 -> validated AgentDecision
 -> PetAgentRuntimeCoordinator
```

`AgentDecision` is versioned by schema `1` and has five safe domain cases:

- `respond(ConversationResponseDecision)`
- `proposePlan(AgentPlanProposal)`
- `askClarification(ClarificationDecision)`
- `decline(DeclineDecision)`
- `noAction(NoActionDecision)`

The model may not execute tools, mint grants, write the task ledger, write memory, invent capability
IDs, provide shell commands, or bypass `CapabilityBroker`.

## Decision Sources

`DecisionSource` is explicit:

- `modelStructured`: structured model output passed local validation.
- `ruleBasedFallback`: deterministic keyword/semantic fallback, never presented as model output.
- `deterministicFallback`: parse or validation failure, provider failure, or fail-closed safety.

The current app-side `ReasoningModelAdapter` is a temporary `ruleBasedFallback`. It filters semantic
traps such as negated reminders, already-set reminders, explanation requests, quotes, and hypothetical
requests before it can produce a plan proposal.

## Conversation Generation

Structured decision and conversation generation are separate. `LegacyConversationProvider` remains a
conversation provider and still reports `providerStreamingCapability=nonStreaming`; this phase does
not implement true token streaming.
