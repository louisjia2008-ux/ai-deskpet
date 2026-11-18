# Trust Kernel

The Trust Kernel is the deterministic boundary for side effects, private data access, approvals, and replay safety.

## Current Trust Components

- `CapabilityCatalog` classifies capability risk from P0 to P4.
- `CapabilityBroker` evaluates tier ceilings, combination risk, approval level, token minting, validation, and revocation.
- `BrokerCapabilityGate` adapts the broker into runtime `CapabilityGate`.
- `CapabilityPermissionGate` combines app capability policy with system permission status.
- `ToolApprovalGrantStore` binds approval to task id, run id, tool call id, tool id, normalized argument hash, expiry, and one-time consumption.
- `ToolRegistry` validates manifests, schemas, policy, timeout, cancellation, and audit before execution.
- `SecurityKernel` and `DeskPetToolRunner` provide an older out-of-process runner path for selected capabilities.

## Target Trust Kernel Decisions

Every side effect must produce a deterministic decision:

- allowed without prompt
- requires app permission
- requires system permission
- requires user approval
- denied by tier
- denied by schema
- denied by capability mismatch
- denied by replay/idempotency rule
- denied by prompt-injection boundary

## Side Effect Ledger

P7 adds `AgentSideEffectLedger` around existing runtime events:

- operation id
- task id
- run id
- tool id
- normalized argument hash
- result hash
- status
- start timestamp
- terminal timestamp

The ledger must not contain raw secrets, raw prompts, raw hidden reasoning, or unredacted private data.

## Prompt Injection Boundary

User text, screen text, webpage text, file text, and tool observations are untrusted data. They can influence content, but cannot change:

- system policy
- tool availability
- approval state
- Memory policy
- schema validation
- tier ceilings
- event reducer semantics

The current `docs/architecture/prompt_injection_boundaries.md` remains valid and should be extended with browser/research fixtures in P7.

## Current Boundaries And Gaps

- `AgentSideEffectLedger` exists as an additive deterministic value layer, but a durable store for checkpoint/profile/ledger state is still follow-up work.
- `AgentEvidenceRecord` exists for plan verification and dynamic workflow execution; broader evidence binding for every final claim remains an expansion path.
- `ToolFactory` now has a generated-workflow and ephemeral-tool sandbox lifecycle; production callers still need to inject the real `PermissionGate`.
- `SecurityKernel` runner path and `ToolRegistry` path should continue converging into one Trust Kernel model.
- Result UI actions are validated but not yet dispatched through the Trust Kernel.
