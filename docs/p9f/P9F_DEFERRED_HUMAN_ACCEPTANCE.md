# P9F Deferred Human Acceptance

Frozen status: `P9F_IMPLEMENTED_HUMAN_ACCEPTANCE_DEFERRED`

Blocking detail: `P9F_PHONE_HANDLER_UI_NOT_OBSERVED`

P9F is not complete. P9F no longer blocks P9G engineering work, but its deferred human acceptance items must not be rewritten as passed.

## Why This Is Deferred

The phone handoff engineering path found a registered system handler and the system accepted the open request in the acceptance run. A running application was returned and no phone call was placed. However, no visible phone handling UI was observed, so the human-visible conformance condition did not pass.

System acceptance is not the same as external operation completion. It is also not the same as human acceptance.

## Deferred Human Items

- Phone handler visible UI human PASS
- Website address bar human PASS
- Map human signature
- Directions human signature
- Denied scenario human signature
- Recovery human signature

## Current Automated Evidence

- Phone handler preflight found `com.apple.mobilephone`
- System open accepted in the P9F acceptance run
- Running application returned
- Phone call was not placed
- Map, directions, and website runtime handoff evidence exists
- Recovery did not redispatch
- Dispatcher boundary defense-in-depth completed
- P9F focused tests passed during P9F closeout
- P9E, P9D, and P9C regressions passed during P9F closeout
- Full SwiftPM passed during P9F closeout
- Debug and unsigned Release compilation passed during P9F closeout
- No-secret scan and `git diff --check -- .` passed during P9F closeout

The Release evidence above used unsigned verification boundaries where applicable. It is not production signing, Gatekeeper, or notarization proof.

## Release Policy

Release phone action is disabled by default:

`unavailable(reason: humanVisibleHandlerConformanceNotCompleted)`

User copy:

`此 Mac 当前未启用电话操作`

Accessibility hint:

`此 Mac 的电话处理程序尚未完成可见性验收。`

Developer diagnostics:

- `handler registered: true`
- `system open accepted in acceptance run: true`
- `visible UI conformance: not passed`
- `release support: disabled`

This must not be described as "no phone app installed", because handler registration was observed.

## Conditions To Re-enable Release Phone Action

All of these must be true:

- Handler registered
- System open accepted
- Visible handler UI human observed
- No real call placed during test
- Recovery no reexecution
- Human acceptance record signed

No environment variable, UserDefaults key, URL scheme, model output, tool result, checkpoint, developer mode, or user-editable configuration may upgrade this status to PASS or enable Release phone handoff.
