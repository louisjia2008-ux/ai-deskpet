# Companion Console P0-P3 Implementation

Date: 2026-06-23

## Scope Completed

### P0 Window / Overlay / Hit-test / Size

- Added point-based pet sizing through `PetScaleController`.
- Default runtime pet visual height is now `132 pt`, clamped between `96 pt` and `160 pt` for idle, with `220 pt` reserved for future interaction modes.
- `PetScene` scales the existing `StaticPNGCharacterRenderer` instead of modifying or regenerating art.
- Added visible-frame-aware feet clamp and overlay-frame calculation in `ScreenGeometry`.
- `ScreenManager` now exposes `visibleScreenFrames`, and screen-bottom surfaces include Dock padding.
- `OverlayWindowController` now lays out a small transparent window around the pet instead of keeping the overlay at full desktop union size.
- Drag, initial placement, and screen-change handling clamp the pet feet against `NSScreen.visibleFrame`.
- Existing alpha-aware `OverlayContentView.hitTest` and passthrough modes were preserved.

### P1 Companion Console

- Expanded navigation into product groups:
  - DeskPet: Today, Companion, Focus, Memory
  - AI: Models, Provider, Tool Permissions
  - System: Privacy & Permissions, Appearance & Animation, Advanced
- Today page now surfaces pet mode, default model, Provider status, permission summary, and quick actions.
- Companion page now includes persistent companion mode, proactive intensity, and interruption controls.
- Focus page keeps the existing timer and adds session goal, encouragement, mute-motion toggles, and interruption count placeholder.
- Privacy page now uses real `Toggle`, `Picker`, and `Button` controls instead of read-only status rows.
- Appearance page adds size slider, animation intensity, Reduce Motion notice, Dock avoidance, and idle breathing/blink controls.
- Advanced page exposes redacted runtime diagnostics and build info, plus a redacted diagnostics export.

### P2 AI Model Center / Provider / Keychain / Model Catalog

- Added core provider models in `AICore`:
  - `ProviderType`
  - `ModelCapability`
  - `ProviderConfig`
  - `ModelDescriptor`
  - `ModelRoleDefaults`
  - `ProviderConnectionStatus`
- Added `SecretStore`, `InMemorySecretStore`, and app-side `KeychainSecretStore`.
- Added `ProviderStore` for JSON-backed provider config. It persists provider config, models, and defaults, but never persists API keys.
- Added `ModelCatalogService` with mockable HTTP:
  - OpenAI-compatible / LM Studio: `GET /v1/models`
  - Ollama: `GET /api/tags`
  - Anthropic: built-in manual suggestions after key presence is satisfied
  - Gemini is listed as unavailable rather than half-implemented
- Added `ProviderClientFactory` and provider client abstractions.
- Added Model Center and Provider Center UI:
  - role defaults
  - provider/model pickers
  - add/edit/delete providers
  - SecureField API key input
  - connection test
  - refresh models
  - manual model fallback

### P3 Agent Runtime Integration

- Existing `ChatModel -> PetAgentRuntimeCoordinator` routing was preserved; UI still does not call provider clients directly.
- Added `CompanionAgentRuntimeModel` as the UI-facing runtime status and command surface.
- Runtime status now exposes:
  - current mode
  - selected model
  - provider status
  - permission summary
  - memory status
  - last redacted/user-facing error
- Extended `AICore.ModelRouter` with role routing for companion/tool/summarizer/vision while preserving the older prompt local/cloud router.
- Role fallback now routes tool/summarizer/vision to companion defaults only when their own role default is missing.
- Missing key, disabled provider, missing provider, and missing model return explicit errors instead of silent fallback.
- Permission UI maps to persisted preferences, and runtime status summarizes those preferences. Existing `CapabilityPermissionGate` remains the enforcement boundary for tools.

## Files Added

- `Sources/AICore/ProviderModels.swift`
- `Sources/AICore/ModelCatalogService.swift`
- `Sources/AICore/ProviderClientFactory.swift`
- `Sources/DeskPet/AI/KeychainSecretStore.swift`
- `Sources/DeskPet/AI/ProviderStore.swift`
- `Sources/DeskPet/AI/CompanionAgentRuntime.swift`
- `Sources/DeskPet/UI/ModelCenterView.swift`
- `Sources/DeskPet/UI/ProviderCenterView.swift`
- `Sources/DeskPet/UI/RuntimeSettingsViews.swift`
- `Sources/DeskPet/Window/PetScaleController.swift`
- `Tests/DeskPetTests/ProviderModelCenterTests.swift`
- `docs/COMPANION_CONSOLE_P0_P3_AUDIT.md`
- `docs/COMPANION_CONSOLE_P0_P3_IMPLEMENTATION.md`
- `docs/COMPANION_CONSOLE_P0_P3_VALIDATION.md`

## Files Modified

- `Sources/AICore/ModelRouter.swift`
- `Sources/DeskPet/AppDelegate.swift`
- `Sources/DeskPet/Platform/ScreenManager.swift`
- `Sources/DeskPet/Platform/Surface.swift`
- `Sources/DeskPet/Render/PetScene.swift`
- `Sources/DeskPet/Sync/PreferencesModel.swift`
- `Sources/DeskPet/UI/AppShellView.swift`
- `Sources/DeskPet/UI/FocusBoardView.swift`
- `Sources/DeskPet/UI/MainViews.swift`
- `Sources/DeskPet/UI/MainWindowController.swift`
- `Sources/DeskPet/UI/RelationshipView.swift`
- `Sources/DeskPet/UI/SettingsView.swift`
- `Sources/DeskPet/UI/TodayView.swift`
- `Sources/DeskPet/Window/OverlayWindowController.swift`
- `Tests/DeskPetTests/PerchSolverTests.swift`
- `Tests/DeskPetTests/P5_1NavigationTests.swift`

## Reused Architecture

- `OverlayContentView` alpha hit testing and passthrough modes.
- `PetScene`, `StaticPNGCharacterRenderer`, and existing Character V2 renderer path.
- P5.1 design system (`CardContainer`, `StatusPill`, `MetricChip`, `PrimaryButtonStyle`, `SecondaryButtonStyle`).
- `AgentRuntimeContainer`, `PetAgentRuntimeCoordinator`, `CapabilityPermissionGate`, `ToolRegistry`, and runtime audit redaction.
- `MemoryPolicy`, `MemoryModel`, and existing memory store.

## Provider / Keychain / ModelRouter Data Flow

1. Provider form writes `ProviderConfig` into `ProviderStore`.
2. If an API key is entered, `ProviderStore` writes it to `KeychainSecretStore` under `provider.<id>.apiKey`.
3. `ProviderConfig.apiKeySecretID` stores only the Keychain lookup id.
4. `ModelCatalogService` reads the secret only when building a test/list-model request.
5. `ModelRouter.route(role:providers:defaults:secretStore:)` validates role defaults and key presence.
6. `CompanionAgentRuntimeModel` exposes the selected model and provider status to UI.

## PermissionGate Data Flow

1. Privacy and tool permission controls persist app-level preferences in `PreferencesModel`.
2. Runtime status summarizes those preferences for UI.
3. Actual tool execution still goes through `CapabilityPermissionGate` and `ToolRegistry`.
4. Disabled or ungranted high-sensitive capabilities remain fail-closed.

## UI Page Structure

- `TodayView`: state overview, current task, quick input, task list.
- `RelationshipView`: companion controls plus relationship state.
- `FocusBoardView`: timer, mode setup, session goal, toggles, session card.
- `MemoryView`: existing memory center.
- `ModelCenterView`: model role defaults and model refresh/test.
- `ProviderCenterView`: provider CRUD, SecureField, Keychain save, connection test.
- `ToolPermissionsView`: high-sensitive tool toggles.
- `SettingsView`: privacy/system permission controls plus data/sync/about.
- `AppearanceAnimationView`: pet size, animation, Reduce Motion, Dock avoidance.
- `AdvancedDebugView`: redacted diagnostics and build info.

## Explicit Non-goals

- No walk animation art regeneration.
- No approved walk frame or approved character art changes.
- No Live2D project changes.
- No OpenClaw reads or writes.
- No real API key, token, or credential fixture.
- No real network-dependent tests.
- No git stage, commit, push, reset, clean, restore, checkout, or stash.
