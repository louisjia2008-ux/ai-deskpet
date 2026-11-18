# Character Animation Architecture

## Implemented Runtime Shape

```text
PetAgentRuntimeCoordinator
  -> PetAgentRuntimeOutput
  -> ChatModel.onAnimationEvent
  -> OverlayWindowController.handleAgentAnimationEvent
  -> AgentAnimationEventMapper
  -> CharacterAnimationIntent
  -> CharacterAnimationStateMachine
  -> StaticPNGCharacterRenderer
  -> SpriteKit transparent overlay
```

## Boundaries

- Agent/runtime layer emits lifecycle and semantic emotion only.
- The model never names files, motions, textures, or renderer resources.
- `PetBrainCore.AnimationIntent` remains a semantic presentation intent.
- `CharacterAnimationIntent` is renderer-side and not exposed to the LLM.
- Renderer failures log explicit requested resource and searched paths.

## Renderer Contract

`PetRenderer` now supports:

- feet placement
- activity application
- semantic animation intent
- speaking level
- look target
- per-frame update
- alpha-aware hit testing
- visibility
- shutdown

## Static PNG Renderer

`StaticPNGCharacterRenderer` loads `character_anchor_rgba_v3.png`, builds a cached alpha hit mask, anchors the sprite at the feet, and composes final transform from independent channels:

- breathing
- idle sway/micro movement
- drag tilt
- reaction squash/jump/shake
- speaking fallback
- sleepy sink

It does not stack unbounded SpriteKit actions for the character pose.

## Configuration

Runtime config is centralized in:

- `DeskPet/Resources/CharacterAnimation/default_character_animation.json`

The loader caches config once and falls back to `CharacterAnimationConfig.default` only if the JSON cannot be found or decoded.

## Fallback Policy

- Live2D is not wired because no formal model exists.
- Static PNG is the production renderer for this phase.
- If the static PNG cannot load, renderer state becomes `.unavailable` and logs the exact searched paths. It does not silently return to the old shape placeholder.

## Future Live2D Slot

`Live2DCharacterRenderer` should conform to the same `PetRenderer` semantics and consume the same `CharacterAnimationIntent` map. It must only be enabled after a valid `.model3.json`, textures, motions, expressions, and physics exist.
