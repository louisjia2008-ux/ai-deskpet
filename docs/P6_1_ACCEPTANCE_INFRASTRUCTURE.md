# P6.1 Acceptance Infrastructure

Date: 2026-07-16

## Status

P6.1 repairs the acceptance infrastructure that blocked the P6 Computer Use run:

- Ollama provider chat now uses the same real Agent path as product chat and no longer classifies protocol/content failures as generic connection failures.
- Automation profiles use explicit per-profile data roots instead of `HOME` side effects.
- Main-window, floating-chat, store, scheduler, task-ledger, activity, provider, and diagnostics paths are injected from `DeskPetAppEnvironment`.
- Automation profiles use an in-memory secret store and a marker-protected profile root.
- The exact P6 Flow 1 prompt was rerun through the signed app bundle in an isolated profile and reached `terminal=completed`.

Final infrastructure status: `READY_FOR_P6_COMPUTER_USE_RERUN`.

## Provider Recovery

Root cause:

- The previous acceptance tested Ollama availability with `/api/tags`, but real Agent chat used `/api/chat`.
- The selected qwen thinking model could return hidden `thinking` with empty visible `message.content`.
- The app treated empty visible content as `invalidResponse`, which surfaced as `providerUnavailable` / `connection failed`.

Repair:

- Ollama chat requests send `think: false`.
- Ollama responses decode visible `content`, hidden `thinking`, and native `tool_calls`.
- Empty visible content is accepted only when valid tool calls exist.
- Thinking-only content maps to `provider response unsupported`, not a network failure.
- Transport, HTTP, decode, and unsupported-response failures now have separate safe diagnostics.

Primary files:

- `Sources/AICore/ProviderClientFactory.swift`
- `Sources/DeskPet/PetBrain/AIServices.swift`
- `Tests/DeskPetTests/P31ProviderAdapterAcceptanceTests.swift`
- `Tests/DeskPetTests/CompanionChatViewModelTests.swift`

## Automation Profile Isolation

Automation launch shape:

```sh
DeskPet --automation-profile <profile-id> --data-root <absolute-data-root>
```

Rules:

- `profile-id` must match `[A-Za-z0-9_-]{1,64}`.
- `data-root` must be under an allowed temporary/review location.
- The normal user home, `/`, and regular Application Support locations are rejected.
- A `.deskpet-automation-profile` marker is written before cleanup-capable paths are considered safe.
- Automation mode uses `InMemorySecretStore`; no Keychain service/account/entitlement was changed.

Injected profile paths:

- `ApplicationSupport/conversations.json`
- `ApplicationSupport/memories.json`
- `ApplicationSupport/tasks.json`
- `ApplicationSupport/relationship.json`
- `ApplicationSupport/preferences.json`
- `ApplicationSupport/providers.json`
- `ApplicationSupport/scheduled_tasks.json`
- `ApplicationSupport/agent_task_ledger.json`
- `ApplicationSupport/agent_task_activity.jsonl`
- `ApplicationSupport/AgentRunEvents/`
- `ApplicationSupport/diagnostics_export.json`
- `Caches/`
- `TemporaryOutput/`
- `ui_state.json`

Primary files:

- `Sources/DeskPet/App/AppEnvironment.swift`
- `Sources/DeskPet/AppDelegate.swift`
- `Sources/DeskPet/AI/ProviderStore.swift`
- `Sources/DeskPet/Security/ToolRunnerService.swift`
- `Sources/DeskPet/UI/MainWindowController.swift`
- `Sources/DeskPet/UI/MainViews.swift`
- `Sources/DeskPet/UI/AppShellView.swift`
- `Sources/DeskPet/UI/TodayView.swift`
- `Sources/DeskPet/UI/ModelCenterView.swift`
- `Sources/DeskPet/UI/RuntimeSettingsViews.swift`
- `Sources/DeskPet/FloatingChat/FloatingChatPanelController.swift`
- `Tests/DeskPetTests/P61AcceptanceInfrastructureTests.swift`

## Memory V2 Runtime Boundary

The MemoryPolicyEngine strategy was not changed.

The P6.1 runtime path adds explicit user-authored memory candidate extraction after a successful final response. It only extracts explicit long-term cues such as `以后`, `默认`, `从现在开始`, `请记住`, `记住`, and `一定`, rejects secrets and transient date/time prompts, and preserves the existing memory policy decision boundary.

Primary files:

- `Sources/AICore/Memory.swift`
- `Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift`
- `Tests/DeskPetTests/P6MemoryV2Tests.swift`

## Selftest Synchronization

The app now stores the runtime bootstrap task and selftest hooks await it before sending runtime messages. This removes a false `interruptedByRestart` ledger event caused by selftest input racing lifecycle recovery.

Primary file:

- `Sources/DeskPet/AppDelegate.swift`

## Validation Matrix

Passed:

- `swift test --filter P31ProviderAdapterAcceptanceTests` - 61 tests, 0 failures.
- `swift test --filter P61AcceptanceInfrastructureTests` - 4 tests, 0 failures.
- `swift test --filter P6` - 39 tests, 0 failures.
- `swift test` - 674 tests, 0 failures.
- `swift build`
- `swift build -c release`
- `scripts/build_app.sh debug`
- `codesign --verify --deep --strict build/DeskPet.app`
- Signed app exact Flow 1 selftest with `p61_flow1c` - `provider=nonStreaming`, `delta=true`, `terminal=completed`.

Evidence:

- `review/p6_1_acceptance_infrastructure_recovery_20260716_000001/data/p61_flow1c/ApplicationSupport/memories.json`
- `review/p6_1_acceptance_infrastructure_recovery_20260716_000001/data/p61_flow1c/ApplicationSupport/providers.json`
- `review/p6_1_acceptance_infrastructure_recovery_20260716_000001/data/p61_flow1c/ApplicationSupport/agent_task_ledger.json`
- `review/p6_1_acceptance_infrastructure_recovery_20260716_000001/screenshots/p61_gui_final.png`

## GUI Automation Note

The app can launch under an isolated automation profile and expose the expected GUI state. A screenshot confirms the main window, automation banner, and `Automation Ollama / qwen3.5:0.8b` provider-ready state.

Direct GUI typing/clicking could not be completed from the current host automation tools:

- AppleScript/System Events returned Apple Events authorization error `-1743`.
- The attempted Sky Computer Use native pipe was unavailable.
- The dynamically available XcodeBuildMCP UI tools target iOS Simulator UI automation, not this macOS native app window.

This is an external automation-control blocker, not a provider or data-isolation blocker.

## Non-Goals Preserved

- No P7 work.
- No signing, entitlement, Keychain service, or Keychain account changes.
- No `MemoryPolicyEngine` strategy change.
- No stage, commit, reset, checkout, stash, or cleanup operation.
