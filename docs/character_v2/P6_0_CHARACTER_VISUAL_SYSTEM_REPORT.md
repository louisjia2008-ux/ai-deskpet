# P6.0 Character Visual System and Locomotion MVP

## Audit Summary

The existing app already had useful visual seams:

- `PetStateMachine` owns true desktop position and movement decisions.
- `PetScene` bridges behavior activity into SpriteKit rendering.
- `StaticPNGCharacterRenderer` owns the current static character image, hit mask, breathing, reactions, speaking motion, and visibility.
- `CharacterAnimationStateMachine` accepts semantic animation intents.
- `CharacterAnimationConfigLoader` already uses data-driven JSON for the legacy static PNG config.

The main visual problem was not one broken image. The runtime moved the character feet point while the renderer kept playing idle-style whole-sprite breathing and sway. `PetScene.apply(activity:)` mapped both `wander` and `recalling` to `.idle`, so real walking never existed at the animation layer.

The old home/nest was also a placeholder: a pastel ellipse plus emoji labels. It did not share the character's blue-white visual language and did not read as a designed habitat anchor.

## Root Causes

- Single static PNG presentation cannot express feet contact, start, stop, blink, or look-around without procedural or layered support.
- Movement coordinates and visual locomotion were not synchronized.
- No Character V2 asset approval pipeline existed, so generated assets would have had no stable candidate/review/approved boundary.
- No manifest described clip fps, pivot, hitbox, frame events, or shadow metadata.
- The habitat visual was hard-coded and not part of a future asset system.

## Implemented MVP

- Added Character V2 asset directories under `DeskPet/Assets/CharacterV2/`.
- Added a runtime-readable `character_v2_manifest.json` and schema.
- Added `CharacterVisualSystemLoader` with validation and safe fallback.
- Added animation states for `blink`, `idleLookAround`, `startMoving`, `walkLeft`, `walkRight`, and `stopMoving`.
- Added `CharacterLocomotionController` to map `wander/recalling/idle` into start, walk, and stop visual intents while leaving root motion in `PetStateMachine`.
- Added procedural ground shadow to the static PNG renderer.
- Added random idle blink/look-around procedural placeholders.
- Replaced the emoji nest with a blue-white magic-book/cloud habitat anchor built in SpriteKit.
- Bound configured home position to the habitat anchor while using `visibleFrame` to avoid Dock/menu-bar overlap.
- Added a no-dependency asset validator script.

## Generated Asset Scope

The first Character V2 candidate art was generated on 2026-06-20 and saved under
`DeskPet/Assets/CharacterV2/candidates/`.

Generated candidates include:

- canonical turnaround sheet
- walk-left keyframe sheet
- walk-right keyframe sheet
- start/stop transition sheet
- habitat/home anchor concept
- habitat chroma-key source

The habitat has one runtime-eligible RGBA PNG under
`DeskPet/Assets/CharacterV2/approved/habitat/`.

The walk-left, walk-right, start-move, and stop-move clips now have runtime-eligible RGBA
PNG frames under `DeskPet/Assets/CharacterV2/approved/clips/`.

Idle, blink, and look-around are still procedural/placeholder until transparent frames or
lite-rig eye/head layers are generated.

The MVP proves the runtime contract and visual state path:

- data-driven manifest loads
- locomotion states are selected correctly
- procedural fallback renders life signs and shadow
- habitat anchor is no longer the old hut/emoji placeholder

## Human Visual Review Needed

- Confirm the procedural blue-white habitat direction before generating final PNG.
- Review the generated canonical turnaround.
- Review and clean up the sliced left/right walk keyframes independently.
- Approve pivots, hitboxes, frame events, and shadow settings after real frames exist.
- Decide whether blink/look should become frame clips or lite-rig eye-layer swaps in P6.1.

## P6.1 Recommendation

- Generate canonical turnaround and one expression sheet.
- Generate `idle`, `blink`, `walk_left`, `walk_right`, `start_move`, and `stop_move` candidate sheets.
- Build a review contact-sheet script.
- Replace placeholder manifest frames with approved PNG references.

## P6.2 Recommendation

- Add lite-rig layer renderer for eyes, mouth, hair accessory, ponytail, arms, and legs.
- Add atlas packing after frame dimensions stabilize.
- Add sleep/home interaction menu with return home, sleep, feed, chat, and settings actions.
- Prepare a Live2D bridge that consumes the same semantic animation states.
