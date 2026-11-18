# Agent OS Acceptance Plan

This plan is serial. A phase may start only after the previous phase gate passes.

## P0 Gate

- Read the pasted task contract.
- Audit current runtime, streaming, activity, tool, provider, UI, persistence, memory, and security paths.
- Create `docs/agent_os/*`.
- Run `xcodegen generate`.
- Run `xcodebuild -list -project DeskPet.xcodeproj`.
- Record current baseline test result.
- Run `git diff --check`.

## P1 Gate

- Canonical event protocol implemented additively.
- Unified task state reducer implemented.
- Chat, Floating Chat, and Task Center read from the same reducer output.
- Legacy activity replay remains compatible.
- Focused reducer/event tests pass.

## P2 Gate

- `ProviderDelta` implemented.
- Stateful hidden-thinking parser tested with split tags.
- Tool call argument accumulator tested.
- Cancellation barrier tested.
- Stream coalescer tested.
- Real local/cloud streaming either passes or is recorded as blocked by credentials/service availability.

## P3 Gate

- Tool activity protocol implemented.
- Activity comes from runtime/tool events, not model prose.
- All current release tools emit start/progress/observation/terminal events.
- Task Center replay matches live activity.

## P4 Gate

- Multi-agent governance roles emit canonical events.
- Verifier cannot grant permissions.
- Side effects remain serial and governed.
- Bounded loop limits are preserved.

## P5 Gate

- Result snapshot/patch protocol implemented.
- Safe native renderer handles snapshots and patches.
- UI interactions dispatch through Runtime and Trust Kernel.
- Replay restores the same result state.

## P6 Gate

- Capability descriptor model implemented.
- Tool Factory lifecycle documented and enforced.
- Generated or workflow tools cannot execute without static checks and user review.

## P7 Gate

- Checkpoint, replay, resume, idempotency, side-effect ledger, model conformance profiles, and provider conformance reports are implemented.
- App restart replay, cancellation replay, tool-complete/model-missing recovery, duplicate event handling, provider stream interruption recovery, UI snapshot restoration, and conformance role limits are tested.
- Replay produces the same UI and terminal state.
- Completed write side effects are not repeated.
- Model capability and role limits are enforced by the runtime conformance gate.

## P8 GUI Acceptance

Flow coverage should include:

1. Ordinary streaming chat: no tool, visible text streams progressively, hidden thinking is not exposed, Stop produces the correct terminal state.
2. Real datetime tool: activity shows the real tool, tool detail is expandable, result is correct, and history replay is correct.
3. Tool failure: a real failure reason is shown, retry is possible, and the task is not incorrectly completed.
4. Verifier rejection: unsupported executor claims are rejected, rechecking is visible, and the repaired terminal state is evidence-honest.
5. Allow once permission: the current task can use the approved action and the next task asks again.
6. Deny permission: the tool does not execute, the agent does not bypass denial, and a degraded result is surfaced.
7. Dynamic choice UI: candidates stream, a candidate click returns to runtime, the UI collapses/resolves, and the agent continues.
8. Cancel task tree: cancellation during model streaming, tool execution, or verification prevents later visible events.
9. Tool Factory: capability gap, task-scoped ephemeral tool, sandbox test, verification, and no automatic promotion.
10. Restart/replay: checkpoint restores visible state and does not duplicate side effects.
11. Parallel read-only tools: sequence and parent relationships are preserved, and independent tool details remain expandable.
12. Old task isolation: a new conversation does not show an old live card, old terminal state is not active, and live state clears.

XCUITest data isolation:

- Do not reuse a fixed `/tmp/DeskPetAutomation` root.
- Use a test-unique temporary directory, app container, or launch argument rooted under `FileManager.default.temporaryDirectory`.
- Create, clean up, and report data-root errors explicitly.
- Do not bypass the sandbox by falling back to the normal user data root.

If a flow cannot run, report the exact blocker. Do not mark it as pass.
