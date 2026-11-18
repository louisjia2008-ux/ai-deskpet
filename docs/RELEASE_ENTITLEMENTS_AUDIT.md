# Release Entitlements Audit

P9G Release entitlement file: `Resources/Release.entitlements`

Current entitlement set: empty dictionary.

## Result

No Release entitlement is currently required by P9G.

Not included:

- `com.apple.security.app-sandbox`
- `com.apple.security.network.client`
- `com.apple.security.network.server`
- `com.apple.security.files.user-selected.read-only`
- `com.apple.security.files.user-selected.read-write`
- `com.apple.security.personal-information.location`
- `com.apple.security.automation.apple-events`
- `com.apple.security.device.audio-input`
- `com.apple.security.device.camera`
- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`
- `com.apple.security.get-task-allow`

## Rationale

P9G did not add new external actions. It did not add Accessibility, Apple Events, UI scripting, microphone, camera, JIT, unsigned executable memory, or disabled library validation requirements. The phone UI visibility gap must not be solved by adding broad automation or accessibility entitlements.

If future features require an entitlement, the change must document:

- Specific code need
- Test evidence
- Risk
- Whether Release truly requires it
- Whether an architecture change can remove it later

## Verification

`scripts/verify_p9g_release_settings.py` checks that the Release entitlement file exists, is a plist dictionary, remains empty, and does not include debug, automation, camera, microphone, JIT, unsigned-memory, or disabled-library-validation privileges.
