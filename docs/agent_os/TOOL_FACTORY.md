# Tool Factory P6

The Tool Factory is implemented as an additive, task-scoped lifecycle layer on top of the current ToolRegistry, Capability Kernel, Permission Gate, schema validator, and verifier evidence model.

## Current Tool Platform

Current tool execution is registry-based:

- registered `AgentTool`
- manifest and JSON schema
- per-run `ToolCatalogSnapshot`
- capability and system permission gate
- timeout and cancellation handling
- sanitized observation
- runtime audit

This is the mandatory execution path for promoted tools.

## Implemented Factory Lifecycle

`ToolFactory` tracks each ephemeral proposal through explicit states:

- `capabilityGapDetected`
- `ephemeralToolDesigned`
- `staticValidation`
- `sandboxTesting`
- `adversarialReview`
- `currentTaskExecution`
- `resultVerification`
- `reusableCandidate`
- `promotionReview`
- `reusableTool`
- `rejected`
- `rolledBack`

No ephemeral tool can execute unless static validation passes, sandbox verification passes, and the injected `PermissionGate` grants its declared capability. The default ToolFactory gate denies everything so production callers must wire the real gate explicitly.

## Dynamic Workflows Before Code

P6 implements declarative dynamic workflows before generated code:

- tool sequence
- snapshot-based gap detection
- input schema validation
- Permission Gate checks
- `ToolPlatformExecuting` execution
- output schema validation
- evidence records

This proves composition while preserving `ToolRegistry` as the reusable tool execution boundary.

## Ephemeral Tool Model

P6 intentionally does not expose arbitrary Swift, shell, JavaScript, or Python execution. The first ephemeral runner is `RestrictedEphemeralToolRunner`, a sandbox-shaped interface that supports safe structured data transforms only:

- sort and deduplicate numbers
- sort and deduplicate strings
- sum numbers

The model still carries a manifest, version metadata, source digest, task workspace path, input schema, output schema, timeout, and promotion policy so a future real sandbox runner has the same lifecycle constraints.

## Sandbox Boundary

Static validation rejects:

- duplicate tool ids
- non-`ephemeral.*` ids
- high-risk or unknown risk
- missing Permission Gate capability
- P4, keychain, arbitrary shell, git push, network upload, and network capabilities
- broad/full-disk task workspaces
- source snippets that try to network, read home/volume paths, touch `.git`, alter project source, or self-register

Runtime execution rejects:

- unauthorized path arguments outside the task workspace
- project source or `.git` paths
- timeout
- cancellation
- schema-invalid outputs
- self-registration signals

## Hard Limits

- No arbitrary model-generated Swift, shell, JavaScript, or Python execution in the P6 release flow.
- No hidden install of dependencies.
- No self-modifying app code.
- No persistent tool promotion without user review.
- No workflow execution outside `ToolPlatformExecuting`.
- No ephemeral execution without an injected Permission Gate.

## Promotion And Rollback

A successful current-task execution becomes only a `reusableCandidate`; it does not enter the reusable registry automatically. `promote(toolID:approved:)` requires explicit approval and a verified reusable candidate. `rollback(toolID:)` removes the promoted manifest from the ToolFactory review registry.

## Current Reuse

`P6SkillTests` already captures useful constraints for static checks, versioning, rollback, and capability diffs. Those tests should guide P6 Tool Factory rather than inventing a separate plugin stack.

P6 keeps those tests and adds `P6CapabilityKernelToolFactoryTests` for capability composition, gap detection, cancellation, timeout, unauthorized file rejection, duplicate detection, verification, promotion, and rollback.
