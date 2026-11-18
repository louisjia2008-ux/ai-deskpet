# Companion Product Loop Root-Cause Audit

Date: 2026-06-23

## Summary

The app has many console surfaces, but the primary companion loop is not mounted as the default product surface. The existing chat pipeline is partially real (`ChatModel -> PetAgentRuntimeCoordinator`) but the runtime conversation backend still falls back to the isolated helper `LLMService` instead of routing selected provider/model traffic through `ModelRouter -> ProviderClient -> Ollama`.

## Sidebar and Pages

- Current sidebar/page definitions live in `Sources/DeskPet/UI/AppShellView.swift`.
- `AppSection` currently starts at `today`; the persisted default is `@AppStorage("deskpet.section")` with `AppSection.today.rawValue`.
- `pageBody` maps `.companion` to `RelationshipView`, so the "companion" page is relationship/settings content, not a first-class chat interface.
- A legacy `ChatView` exists at `Sources/DeskPet/UI/ChatView.swift`, backed by `Sources/DeskPet/AI/ChatModel.swift`, but it is not mounted in the main `AppShellView`.
- There is no `CompanionChatView` or `CompanionChatViewModel` in the current source tree.

## Provider, Model, Router, Runtime State

- `ProviderStore` lives in `Sources/DeskPet/AI/ProviderStore.swift`.
- Provider model refresh is delegated to `ModelCatalogService` in `Sources/AICore/ModelCatalogService.swift`.
- Role routing is implemented by `ModelRouter` in `Sources/AICore/ModelRouter.swift`.
- `PetAgentRuntimeCoordinator` lives in `Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift`.
- Main app dependency wiring happens in `Sources/DeskPet/AppDelegate.swift`, which creates:
  - `ProviderStore`
  - `AIServices`
  - `LegacyConversationProvider`
  - `AgentRuntimeContainer`
  - `ChatModel`
  - `CompanionAgentRuntimeModel`

## Readiness Split

Root cause: the Provider page and the rest of the console do not use one canonical readiness model.

- Provider page reads `providers.statuses[provider.id]?.label`.
- Today/Model/header paths call `runtime.runtimeStatus()`, which rebuilds status from `providers.defaults.companionModelProviderID` and `providers.statuses`.
- `ProviderStore.testConnection` updates `statuses` but does not persist the health result.
- `ProviderStore.refreshModels` persists fetched models, but only sets `provider.defaultModelID`; it does not consistently set `defaults.companionModelProviderID` / `defaults.companionModelID`.
- `ModelRouter` reports missing provider/model as generic `未配置模型` / `模型未配置`, so a connected Ollama provider with no selected role default appears the same as no provider.
- Ollama correctly does not require an API key at the `ProviderType.requiresAPIKey` level, but the UI/runtime readiness text still collapses local-provider readiness into generic "not configured" states.

## Chat Send Path

Current partial path:

`ChatView -> ChatModel -> PetAgentRuntimeCoordinator`

The coordinator then uses `LegacyConversationProvider`, which calls:

`LegacyConversationProvider -> AIServices -> LLMService`

This skips the selected `ProviderStore` model and does not use `ProviderClientFactory` for chat execution. `ProviderClientFactory` currently returns placeholder text for Ollama rather than making a real `/api/chat` request.

## Desktop Overlay and Nest

- Desktop overlay setup is in `Sources/DeskPet/Window/OverlayWindowController.swift`.
- It owns one `OverlayWindow`, one `OverlayContentView`, one `SKView`, and one `PetScene`.
- `PetScene` contains a `nest` node, created in `buildNest()`.
- `OverlayWindowController.configureNest(enabled:)` computes `nestGlobal` and `state.home`, then calls `scene.configureNest(enabled:at:visible:false)`.
- Therefore the nest is currently hidden by default.
- The nest is also modeled inside the same `PetScene` as the character. Since the pet overlay window is relaid out around `state.position`, a visible nest in this scene would be tied to the character overlay window geometry and may be clipped or move with the pet window.

## Walk and Idle Animation

- Static PNG runtime is `Sources/DeskPet/Render/StaticPNGCharacterRenderer.swift`.
- Manifest loading and validation are in `CharacterVisualSystemLoader`.
- Clip metadata comes from `Assets/CharacterV2/manifests/character_v2_manifest.json`.
- `CharacterLocomotionController` selects walk/start/stop states from `PetActivity`, facing, and sampled speed.
- `StaticPNGCharacterRenderer.updateSpriteTexture` changes `sprite.texture` and currently uses each frame's intrinsic aspect ratio to set `sprite.size`.

Likely animation instability sources:

- Frame images can have different intrinsic canvas sizes or alpha bounds, and runtime size is currently derived from each frame image.
- Frame advancement uses elapsed wall time but is embedded inside the renderer rather than a small deterministic player object.
- Locomotion state changes immediately around speed thresholds, so sampled speed jitter can flap idle/walk transitions.
- Walk pose mixer adds vertical lift on top of frame animation, which can amplify foot-baseline drift from the asset frames.
- Start/stop placeholder clips fall back to legacy directionless clips, so transitions can visually mismatch the approved 16-frame walk clips.

## Fix Direction

- Add a canonical `ModelReadinessState` and drive Provider, Model, Today, Chat, header, and runtime availability from it.
- Persist provider health after connection tests and ensure fetched Ollama models can become the companion default.
- Route runtime conversation generation through `ModelRouter -> ProviderClientFactory -> selected LLMClient`.
- Mount `CompanionChatView` as the default page.
- Move the nest into an independent overlay controller and keep it anchored/clamped separately from the pet.
- Use fixed logical canvas sizing, deterministic clip playback, and locomotion hysteresis; validate approved animation assets with a script.
