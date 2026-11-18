# P4-B Task Planner Acceptance

Status: requires user device acceptance.

This document is the signed-app manual acceptance checklist for P4-B. It must be run on a real DeskPet app build. Automated tests do not count as human/device acceptance.

## TEST 1 - Single Tool Does Not Show Plan

Input:

```text
请告诉我当前本地时间。
```

Expected:

- The app uses the existing bounded single-tool loop.
- `get_current_datetime` runs once.
- No multi-step plan card is shown.
- The final reply appears as one assistant message.

## TEST 2 - P0 Multi-Step Plan

Input:

```text
请告诉我当前时间、macOS 版本和当前使用的应用。
```

Expected:

- A compact plan card appears with three safe steps.
- No approval button is required.
- Steps execute serially: current time, system info, frontmost application.
- The final answer appears as one assistant message.
- The plan card does not show ToolID, raw arguments, call ID, raw observations, or planner JSON.

## TEST 3 - P1 Approval

Input:

```text
结合当前时间和今天的日历，告诉我接下来还有哪些安排。
```

Expected:

- The plan card appears before execution.
- The card shows time plus calendar steps.
- The card labels that calendar read-only private data is involved.
- Calendar is not accessed before clicking `执行计划`.
- After approval, steps execute serially and a single final answer appears.

## TEST 4 - Decline Plan

In TEST 3, click `取消`.

Expected:

- No plan step executes.
- No Calendar system permission request appears.
- The plan clears or enters cancelled state.
- The next chat message works normally.

## TEST 5 - Partial Failure

Close or deny Calendar permission, then run a time plus calendar request.

Expected:

- The time step succeeds.
- The calendar step is marked denied.
- The final answer uses the time result and says calendar could not be read.
- The app does not repeatedly request Calendar permission.

## TEST 6 - Cancel During Plan

Start a three-step plan and click stop/cancel while it is running.

Expected:

- The current task cancels.
- Later steps do not execute.
- Late tool results do not update the plan or insert a final reply.
- The spinner disappears.

## TEST 7 - Two Entrypoints

Start a plan from Floating Chat, then open the control-panel chat page.

Expected:

- Both entrypoints show the same plan, step statuses, and approval state.
- Approval from either surface affects the same active plan.
- Tools are not executed twice.
- The final reply is not duplicated.

## TEST 8 - Provider Switch During Plan

Start a plan, then switch Provider while it is running.

Expected:

- A single plan does not mix Provider snapshots.
- The current plan either continues with its starting snapshot or cancels clearly.
- The next turn uses the new Provider.

## TEST 9 - Privacy

Confirm the plan card and final chat do not display:

- ToolID
- raw arguments
- raw tool result
- Calendar internal ID
- Calendar notes, URL, attendees, or raw EventKit fields
- reasoning or thinking text
- Planner JSON
- call ID

## Automation Baseline

The automated P4-B coverage is in:

```text
Tests/DeskPetTests/P4BTaskPlannerTests.swift
```

The automation uses fake providers, fake tools, fake approval, fake system authorization, in-memory ledger data, deterministic clocks, and temporary SwiftPM caches. It must not call a real Provider, EventKit, Keychain, network, shell, browser, or user files.
