# Multi-Agent Governance P4

P4 introduces multi-agent roles through the existing runtime, not a second planner.

## Current Planning Path

- `DecisionEngine` validates structured decisions.
- `RuntimeRequestPreparer` can force deterministic tool routing for narrow requests such as date/time.
- `AgentLoopController` executes a bounded model/tool loop.
- `TaskPlanParser`, `TaskPlanValidator`, and `TaskPlanExecutor` support explicit plans and approval snapshots.
- `AgentTaskScheduler` handles queue/resource/retry metadata.

## Implemented P4 Control Plane

- `TaskGovernor` classifies plan risk from the validated tool manifests and assigns required roles.
- `DeterministicPlanCritic` checks hard constraints before execution, including required tools, forbidden tools, required response text, write confirmation, and step budgets.
- `DeterministicPlanVerifier` verifies completion from execution evidence after synthesis and can repair one overclaimed final response into an evidence-honest partial result.
- `AgentEvidenceRecord` records task id, source, status, timestamp, detail, and SHA-256 content hash for verifier input.
- `AgentLoopController` now runs `validator -> governor -> critic -> executor -> synthesizer -> verifier` for explicit plans while keeping the existing bounded loop and `TaskPlanExecutor`.
- Plan verification activity is emitted through the existing `AgentTaskActivityStore` path as `verificationStarted`, `verificationSucceeded`, or `verificationFailed`.

## Target Roles

- Control Plane: owns task/run ids, event sequence, cancellation, and state machine.
- Planner: proposes plan steps and tool candidates.
- Executor: executes one approved step at a time through ToolRegistry.
- Verifier: checks tool observations, side effects, citations, UI artifacts, and completion criteria.
- Critic: may request replanning or downgrade confidence, but cannot grant permissions.
- Recovery Agent: proposes retry/rollback/resume after deterministic failure classification.

All roles publish canonical events. No role executes tools or writes memory directly.

## Governance Rules

- Model output is untrusted.
- Planner output is a proposal only.
- Verifier output is evidence, not permission.
- Critic output cannot override policy.
- Every side effect passes Trust Kernel.
- Every tool call has a task id, run id, tool call id, arguments hash, approval status, and terminal event.
- Multi-agent delegation must be bounded by iteration, time, token, and tool-call limits.

## Reuse Boundary

`AgentLoopController` already had bounded iterations, repeated-call guards, timeout handling, cancellation checks, parser repair, and terminal state mapping. P4 generalized those mechanisms instead of replacing them.

`TaskPlanValidator.singleToolFallback` remains useful for safe single-tool normalization; richer planning events should keep using the canonical event path rather than a second planner stack.

## P4 Gate Evidence

```text
P4 focused: Executed 5 tests, with 0 failures (0 unexpected)
P4 regression band: Executed 161 tests, with 2 tests skipped and 0 failures (0 unexpected)
P4 full SwiftPM gate: Executed 703 tests, with 2 tests skipped and 0 failures (0 unexpected)
xcodegen generate: PASS
xcodebuild -list -project DeskPet.xcodeproj: PASS, with sandbox/CoreSimulator warnings
git diff --check: PASS
```

## Deferred

P4 does not introduce autonomous recursive agents. Recovery agent behavior is still deterministic and bounded; broader recovery, replay, and conformance hardening belongs to P7.
