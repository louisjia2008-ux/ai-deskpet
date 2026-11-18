# P9G Place Action Reliability And Release Hardening

Stage: `P9G_PLACE_ACTION_RELIABILITY_AND_RELEASE_HARDENING`

Target final status with current machine credentials: `P9G_RELEASE_CONFIGURATION_READY_SIGNING_CREDENTIALS_UNAVAILABLE`

P9G does not add new place actions. It hardens P9C-P9F handoff behavior for Release configuration boundaries, diagnostics, default safety, and signing readiness.

## Release Support Matrix

- Open in Maps: supported when destination has a valid coordinate or address, Maps handler preflight succeeds, and dispatcher validation passes.
- Directions: supported when destination is valid, origin policy is explicit, permission requirements are met, Maps handler preflight succeeds, and dispatcher validation passes. Navigation must not start automatically.
- Official Website: supported when classification is official/canonical, URL scheme is `http` or `https`, URL security validation passes, and a browser handler exists.
- Phone Handoff: unavailable in Release because visible handler UI human conformance has not passed.

Phone Release reason:

`humanVisibleHandlerConformanceNotCompleted`

User copy:

`此 Mac 当前未启用电话操作`

Accessibility hint:

`此 Mac 的电话处理程序尚未完成可见性验收。`

## Policy And Dispatch Order

Evaluation order:

1. Security and destination validity
2. Environment handler availability
3. Release support policy
4. User permission
5. Dispatcher submit

Handler registration does not override the Release phone disable. Environment variables, UserDefaults, checkpoints, model outputs, tool results, selection state, and developer mode do not unlock Release phone handoff.

## Reliability Result

P9G adds explicit release support policy types, detailed support reasons, handler availability snapshots, release-aware eligibility, failure semantics, and terminal ledger fields:

- `unsupportedByReleasePolicy`
- `handlerUnavailable`
- `systemOpenFailed`
- `permissionRejected`
- `userCancelled`
- `dispatchInterrupted`
- `handedOff`

The view model records pre-submit, system-accepted, and terminal states. Recovery does not retry external side effects.

## Harness Isolation

P9C, P9D, P9E, P9F app harnesses remain file-level `#if DEBUG`. `AppDelegate` references to these harnesses are DEBUG-only. Release ignores the P9F acceptance environment variable and does not expose acceptance mode through project settings, Info.plist, UserDefaults, checkpoint, URL scheme, model output, or configuration file.

## Release Configuration

Distribution lane: `DIRECT_DEVELOPER_ID_DISTRIBUTION`

Hardened Runtime: enabled for Release.

App Sandbox: disabled for the Developer ID lane. This is intentional and is not a sandboxing claim.

Release entitlements: empty allowlist in `Resources/Release.entitlements`.

Signing: configured for Developer ID Application, but no valid signing identity is available on this machine.

Notarization: not run because signing credentials are unavailable.

## Verification

Focused tests:

- `swift test --filter P9G`
- `swift test --filter P9FSystemPlaceHandoffDispatcherBoundaryTests`
- `swift test --filter P9EPlaceHandoff`

Release verifier:

- `python3 scripts/verify_p9g_release_settings.py`

Release smoke artifact is generated only when `DESKPET_P9G_RELEASE_SMOKE_OUT` points to a temporary artifact path. The smoke does not open real external apps and does not modify real user configuration.

## Non-goals

P9G does not implement booking, ordering, payment, automatic form filling, automatic login, SMS, email, merchant contact, automatic dial menus, FaceTime fallback, third-party communication fallback, automatic navigation start, background place refresh, background price/inventory/open-hours monitoring, model-initiated dispatch, Computer Use, Accessibility UI automation, AppleScript UI scripting, or broad Apple Events permissions.
