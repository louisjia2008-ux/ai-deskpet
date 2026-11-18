# Character Animation Audit

## Current Real Calling Chain

`ChatView.send` calls `ChatModel.send`, which appends a user message and emits `.userMessageReceived` for animation. `ChatModel.startResponse` creates `PetAgentEvent.userMessage`, then subscribes to `PetAgentRuntimeCoordinator.handle`. Runtime outputs are consumed in `ChatModel.apply`, persisted into the conversation, and now mirrored as semantic animation lifecycle events without changing text generation.

Key references:

- `DeskPet/Sources/DeskPet/UI/ChatView.swift`: composer sends through `chat.send`.
- `DeskPet/Sources/DeskPet/AI/ChatModel.swift:75`: user send entry.
- `DeskPet/Sources/DeskPet/AI/ChatModel.swift:125`: `PetAgentEvent.userMessage`.
- `DeskPet/Sources/DeskPet/AI/ChatModel.swift:169`: `PetAgentRuntimeOutput` handling.
- `DeskPet/Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift`: single runtime coordinator.
- `DeskPet/Sources/DeskPet/AppDelegate.swift:66`: `ChatModel` construction.
- `DeskPet/Sources/DeskPet/AppDelegate.swift:67`: animation event sink wired to overlay.

## App Entry And Windows

- App entry: `DeskPet/Sources/DeskPet/main.swift`.
- App delegate: `DeskPet/Sources/DeskPet/AppDelegate.swift:30`.
- Overlay window creation: `DeskPet/Sources/DeskPet/Window/OverlayWindowController.swift:51`.
- Transparent borderless window: `DeskPet/Sources/DeskPet/Window/OverlayWindow.swift`.
- Overlay content hit test: `DeskPet/Sources/DeskPet/Window/OverlayContentView.swift`.
- Main window/menu wiring: `DeskPet/Sources/DeskPet/AppDelegate.swift:80` and `StatusItemController`.

## Previous Character Path

The previous main character body was built procedurally in `PetScene` with SpriteKit shape nodes and a `PLACEHOLDER` label. That production path has been replaced by `StaticPNGCharacterRenderer`.

Remaining non-production placeholder mentions are not the production character path:

- Local LLM comments in `AICore/LocalEngine.swift`.
- Sound effects/art-stage comments.

## Current Rendering Technology

- Renderer host: SpriteKit `SKScene` inside `SKView`.
- Formal character: `SKSpriteNode` texture created from the accepted RGBA PNG.
- Window: AppKit borderless transparent `NSWindow`.
- Hit testing: `OverlayContentView.hitTest` delegates to renderer alpha hit mask through `content.petHitTestProvider`.

## Drag, Click, Mouse Passthrough, Window Position

- Window default click behavior: `OverlayWindow.ignoresMouseEvents = true`.
- Interaction mode: `OverlayWindowController.applyPassthrough`.
- Drag start/move/end: `OverlayWindowController.overlayMouseDown`, `overlayMouseDragged`, `overlayMouseUp`.
- Window spans desktop union; pet position is global feet point converted to scene-local coordinates.
- Hit testing no longer uses only the full PNG rectangle. It checks cached alpha in `StaticPNGCharacterRenderer.hitTestLocal`.

## Animation State And Variables

New renderer-side types:

- `CharacterAnimationState`
- `CharacterAnimationEmotion`
- `CharacterAnimationIntent`
- `CharacterAnimationStateMachine`
- `CharacterAnimationMixer`
- `CharacterAnimationConfig`

Channels are composed in `CharacterAnimationMixer`: breathing, idle, drag, reaction, speaking, and sleep offsets/scales/rotation are calculated independently and written as one final pose to the sprite.

## Agent Runtime Events And Outputs

Existing runtime output includes:

- `taskStarted`
- `providerMetadata`
- `responseStarted`
- `responseDelta`
- `responseCompleted`
- `presentation`
- `waitingForApproval`
- `failed`
- `cancelled`

`ChatModel` now maps these to `PetAgentAnimationEvent` and the overlay maps them to `CharacterAnimationIntent`.

## Voice / TTS / Audio

- Voice service exists at `DeskPet/Sources/DeskPet/Voice/VoiceService.swift`.
- System TTS fallback exists through `SystemTTSProvider`.
- No audio RMS/viseme mouth signal is currently exposed to the renderer.
- Speaking animation is therefore explicitly text-driven fallback, not true lip-sync.

## Live2D / Cubism

No formal exported `.model3.json`, `.moc3`, motion, expression, or physics files were found in the external Live2D project during read-only audit. The external pipeline has manifests and audits under `psd_plan`, but current audit status is blocked by missing layer pixels.

## Formal Asset Bundle Status

- Production resource path: `DeskPet/Resources/Characters/Default/character_anchor_rgba_v3.png`.
- Runtime config path: `DeskPet/Resources/CharacterAnimation/default_character_animation.json`.
- App bundling script now copies `Resources` subdirectories into `Contents/Resources`.

## Reusable Components

- `PetStateMachine` for desktop movement and drag lifecycle.
- `OverlayWindowController` for window/screen coordinate boundaries.
- `PetAgentRuntimeCoordinator` for single runtime event source.
- `VoiceService` for future RMS/TTS integration.
- Existing SpriteKit overlay layers for bubbles, small companion visuals, and relationship/nest UI.

## Changed Files

- `DeskPet/Sources/DeskPet/Render/CharacterAnimationTypes.swift`
- `DeskPet/Sources/DeskPet/Render/CharacterAnimationStateMachine.swift`
- `DeskPet/Sources/DeskPet/Render/CharacterAnimationConfigLoader.swift`
- `DeskPet/Sources/DeskPet/Render/StaticPNGCharacterRenderer.swift`
- `DeskPet/Sources/DeskPet/Render/PetRenderer.swift`
- `DeskPet/Sources/DeskPet/Render/PetScene.swift`
- `DeskPet/Sources/DeskPet/Window/OverlayContentView.swift`
- `DeskPet/Sources/DeskPet/Window/OverlayWindowController.swift`
- `DeskPet/Sources/DeskPet/AI/ChatModel.swift`
- `DeskPet/Sources/DeskPet/AppDelegate.swift`
- `DeskPet/scripts/build_app.sh`
- `DeskPet/Resources/Info.plist`
- `DeskPet/Resources/CharacterAnimation/default_character_animation.json`
- `DeskPet/Resources/Characters/Default/character_anchor_rgba_v3.png`
- `DeskPet/Tests/DeskPetTests/CharacterAnimationTests.swift`

## Risks

- GUI visual validation was not performed in this pass; status remains READY_FOR_HUMAN_VISUAL_REVIEW for visual acceptance.
- Accessory overlay coordinates were preserved from the old small SpriteKit character and may need art pass alignment over the new full PNG.
- Speaking motion is text-driven fallback until TTS/audio RMS is exposed.
- Idle still ticks through the existing behavior timer; future optimization should pause/lower updates when hidden or fully idle.

## Phase Gates

- Phase 0 Audit: READY.
- Phase 1 Static PNG production asset: READY by checksum and tests.
- Phase 2 Static PNG animation framework: PARTIALLY_READY; implemented core state machine, channels, reduce motion scaling, drag/click/speaking fallback; GUI acceptance pending.
- Phase 3 Agent lifecycle mapping: READY by code/tests.
- Phase 4 Reduce Motion/performance: PARTIALLY_READY; reduce motion is read and applied, but no CPU measurement or GUI idle profiling yet.
- Phase 5 Expression overlay pipeline: BLOCKED_BY_MISSING_ASSET.
- Phase 6 Live2D asset production: BLOCKED_BY_MISSING_LAYER_PIXELS.
- Phase 7 Live2D rigging: BLOCKED_BY_CUBISM_EDITOR and missing accepted PSD.
- Phase 8 Live2D runtime: BLOCKED_BY_SDK and missing formal model.
