# Companion Console P0-P3 Audit

Date: 2026-06-23
Scope: DeskPet macOS app window/overlay geometry, Companion Console, AI provider/model center, and runtime routing.

## App Entry, Window, Overlay

- App entry is `Sources/DeskPet/main.swift` plus `AppDelegate`. `AppDelegate.applicationDidFinishLaunching` creates `PetState`, `ScreenManager`, `OverlayWindowController`, `MainWindowController`, `AgentRuntimeContainer`, and `PetAgentRuntimeCoordinator`.
- Main console window is owned by `MainWindowController`, hosted with `NSHostingController`, and can be switched between mini/compact/expanded modes.
- Desktop pet overlay is owned by `OverlayWindowController`. It creates one borderless `OverlayWindow`, one `OverlayContentView`, one `SKView`, and one `PetScene`.
- `OverlayWindow` is transparent, `.statusBar` level, `.canJoinAllSpaces`, `.stationary`, `.fullScreenAuxiliary`, `.ignoresCycle`, and defaults to `ignoresMouseEvents = true`.
- Current overlay frame is initialized to `screens.desktopUnion`, so the overlay content view spans all displays. This is click-through in work-first mode, but the window size itself is not tied to the pet visual bounds.
- Current initial placement uses `NSScreen.main?.visibleFrame`, but feet start at `vf.minY` with no Dock padding.
- Current drag and screen-change clamp call `ScreenGeometry.clamp(..., into: screens.screenFrames)`, which uses full screen frames, not visible frames. This can place feet under Dock/menu-bar reserved space.
- `ScreenManager.screenSurfaces()` already uses `screen.visibleFrame`, but `screenFrames` and `desktopUnion` still use full frames.
- Current renderer canonical footprint is `160 x 240 pt` from `CharacterAnimationConfig.default`. That makes the visible character substantially taller than the requested 120-150 pt acceptance band.
- There is no dedicated `PetScaleController`; raw logical canvas height currently drives runtime visual size.
- `OverlayContentView.hitTest` is alpha-aware through `scene.hitTestCharacter`, and `interactionEnabled` is false unless passthrough mode permits interaction. This part is reusable.
- Root cause: oversize and edge crowding come from full-height canonical footprint, full-screen overlay frame, full-frame clamp, and missing visible-frame bottom padding.

## Companion Console

- Current shell is `AppShellView` with five sections: Today, Focus, Companion, Memory, Settings.
- Existing productized surfaces include design system files under `Sources/DeskPet/DesignSystem/` and P5.1 pages: `TodayView`, `FocusBoardView`, `RelationshipView`, `MemoryView`, `SettingsView`, `DataView`.
- Current settings page is intentionally mostly explanatory: privacy rows are `HStack` + `StatusPill` and are not real `Button`, `Toggle`, or `Picker` controls.
- Existing console has no top-level AI section, no model page, no provider page, and no tool-permission page.
- SwiftUI decorative overlays in the design system are mostly strokes on card/control backgrounds. They do not intentionally add blocking `Color.clear` layers. This should be preserved by adding `.allowsHitTesting(false)` where new decorative overlays are added.
- Root cause: screenshots read as non-clickable because Settings privacy rows are status text, not controls, and AI configuration is absent from the navigation model.

## AI, Agent, Provider

- Existing native runtime is `PetAgentRuntimeCoordinator`, owned by `AgentRuntimeContainer`. App chat already routes through `ChatModel -> PetAgentRuntimeCoordinator.handle(...)`; UI does not directly call `LLMService`.
- Existing permission architecture is reusable: `CapabilityBroker`, `CapabilityGate`, `PermissionGate`, `CapabilityPermissionGate`, `DefaultSystemAuthorizationPolicy`, `InMemoryPermissionStore`, `InMemorySystemAuthorizationStore`, and `ToolRegistry`.
- Existing memory architecture is reusable: `MemoryItem`, `MemoryPolicy`, `MemoryModel`, `MemoryStore`, and `JSONMemoryRepository`.
- Existing AI model routing is old M3 local/cloud routing only: `AICore.ModelRouter.route(prompt:)` and `destination(for:cloudAuthorized:)`.
- `AIServices` currently chooses local helper or cloud placeholder and feeds `LegacyConversationProvider`.
- `CloudProvider` performs no network I/O and is only a placeholder.
- There is no `ProviderConfig`, `ModelDescriptor`, `ModelRoleDefaults`, `ProviderStore`, `ModelCatalogService`, `KeychainSecretStore`, or Provider UI.
- There is no real provider connection test path and no Keychain-backed API key storage.
- Root cause: P2 gaps are missing configuration/secret separation, provider catalog/client abstractions, and UI for provider/model roles.

## Tests and Build Entrypoints

- SwiftPM package entry is `Package.swift`.
- Products/targets are `AICore`, `PetBrainCore`, `PetAgentRuntime`, `DeskPetLLM`, `DeskPetToolRunner`, `DeskPet`, and `DeskPetTests`.
- Existing tests include geometry (`PerchSolverTests`), AI/router tests (`M3AITests`), memory tests, runtime tests, P5 permission/runtime tests, P5.1 navigation/design/page tests, and character animation tests.
- `scripts/build_app.sh` exists and previous memory indicates it supports extra SwiftPM flags for isolated cache builds.
- `scripts/run.sh` exists for app run flow.
- Current worktree is dirty with many unrelated root-level and prior DeskPet changes. This round will not stage, commit, reset, clean, restore, checkout, or stash.

## Existing Reusable Architecture

- Reuse `OverlayContentView` alpha hit testing and passthrough modes.
- Reuse `PetScene` and `StaticPNGCharacterRenderer`; do not change approved character art or walk frames.
- Reuse `ScreenManager` and `ScreenGeometry` by extending them to visible-frame-aware clamp and scaled visual geometry.
- Reuse P5.1 design system instead of creating a separate visual language.
- Reuse `AgentRuntimeContainer`, `PetAgentRuntimeCoordinator`, `CapabilityPermissionGate`, `ToolRegistry`, and `MemoryPolicy`.
- Extend `AICore.ModelRouter` for model roles while preserving existing local/cloud prompt routing tests.

## Missing Gaps to Fill This Round

- Pet scale controller with point-based canonical visual height.
- Visible-frame screen geometry service with Dock/menu-bar padding and multi-screen fallback.
- Overlay frame sizing based on scaled visual bounds rather than full desktop union.
- Interactive privacy/permission settings controls with status and actions.
- AI navigation entries: model center, providers, tool permissions, privacy, appearance/animation, advanced/debug.
- Provider config store that never stores API keys.
- Keychain secret store plus in-memory secret store for tests.
- Model catalog service with mockable HTTP.
- Provider connection test error classification.
- Runtime-facing model role router and user-facing runtime status.
- Implementation and validation docs.

## Files This Round Will Modify or Add

- `docs/COMPANION_CONSOLE_P0_P3_AUDIT.md`
- `docs/COMPANION_CONSOLE_P0_P3_IMPLEMENTATION.md`
- `docs/COMPANION_CONSOLE_P0_P3_VALIDATION.md`
- `Sources/DeskPet/Window/OverlayWindowController.swift`
- `Sources/DeskPet/Platform/ScreenManager.swift`
- `Sources/DeskPet/Platform/Surface.swift`
- New window/geometry helpers under `Sources/DeskPet/Window/`
- `Sources/DeskPet/Sync/PreferencesModel.swift`
- `Sources/DeskPet/UI/AppShellView.swift`
- `Sources/DeskPet/UI/TodayView.swift`
- `Sources/DeskPet/UI/FocusBoardView.swift`
- `Sources/DeskPet/UI/RelationshipView.swift`
- `Sources/DeskPet/UI/SettingsView.swift`
- New UI pages under `Sources/DeskPet/UI/`
- Existing design system files if needed for missing controls/chips.
- `Sources/AICore/ModelRouter.swift`
- New provider/model runtime files under `Sources/AICore/` and `Sources/DeskPet/AI/`
- `Sources/DeskPet/Runtime/AgentRuntimeContainer.swift` if runtime status needs to be surfaced.
- Focused tests under `Tests/DeskPetTests/`

## Files Explicitly Out of Scope

- `~/.openclaw`, OpenClaw configuration, credentials, sessions, and tokens.
- Live2D project files and Live2D runtime assets.
- Concept assets and approved character art.
- Approved walk frames and animation art generation.
- Real API keys, real tokens, credentials, or fixtures containing secrets.
- Git index/refs: no stage, commit, push, reset, clean, restore, checkout, stash.
