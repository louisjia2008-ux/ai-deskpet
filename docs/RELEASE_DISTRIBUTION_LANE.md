# Release Distribution Lane

Decision: `DIRECT_DEVELOPER_ID_DISTRIBUTION`

P9G does not claim Mac App Store readiness.

## Basis

The current app architecture includes local model/provider integration, helper executables, local agent tools, system URL/MapKit handoff, workspace/file access, local service access, and user-approved external handoff workflows. These are more compatible with direct Developer ID distribution than immediate Mac App Store sandbox distribution.

No audited product document in this pass established Mac App Store as the current target. If a future product decision requires Mac App Store distribution, App Sandbox compatibility becomes a hard release blocker.

## App Sandbox Decision

Decision: App Sandbox remains disabled for the Developer ID lane.

This is not a claim that the app is sandboxed. P9G relies on Hardened Runtime, Developer ID signing configuration, minimal entitlements, explicit permission gates, dispatcher validation, audit logging, and user confirmation.

Compatibility matrix:

- Local Discovery: compatible without sandbox; sandbox feasibility needs focused review for network/location and persisted artifacts.
- MapKit: compatible, but location permission semantics need sandbox-specific validation.
- Browser/URL handoff: compatible without sandbox; sandbox behavior should be separately tested before enabling.
- Phone handoff: disabled in Release until P9F visible UI human acceptance passes.
- Local Ollama / LM Studio: sandbox compatibility unresolved because local network/process conventions vary.
- Provider network: requires outgoing network capability if sandboxed.
- Keychain: possible, but access groups and migration need review.
- File import/export: user-selected file entitlements would be needed if sandboxed.
- Screenshots: not enabled by P9G; sandbox and Screen Recording permissions need separate review.
- Task artifacts: current local filesystem layout needs container migration review.
- Terminal/shell tools: likely incompatible with strict Mac App Store sandbox without architecture changes.
- Computer Use/accessibility: explicitly out of P9G scope and not enabled.
- App-to-app handoff: requires sandbox-specific verification.
- Child process/helper executables: requires sandbox and signing compatibility review.
- Local server/workspace file access: unresolved for Mac App Store sandbox.

Follow-up: create a separate sandbox feasibility program before any Mac App Store lane change.
