# Character V2 image2 Asset Production

Current status: final Character V2 art has not been generated. This document defines the production contract so image2 outputs can be reviewed consistently.

## What image2 Should Generate

- Character turnaround: front, back, left side, right side, left 3/4, right 3/4.
- Expression sheet: neutral, happy, curious, surprised, sleepy, annoyed, sad.
- Lite rig parts: hair, face, eyes, mouth, torso, arms, hands, skirt, legs, feet.
- Motion keyframes: `walk_left`, `walk_right`, `brisk_walk_left`, `brisk_walk_right`, `run_left`, `run_right`, `start_move_left`, `start_move_right`, `stop_move_left`, `stop_move_right`, plus future `jump`, `sleep`, `wake`.
- Habitat concepts: blue-white magic book soft bed, cloud bed, star platform.

## What image2 Should Not Own Alone

- Final frame-to-frame identity consistency.
- Exact pivot/hitbox numbers.
- Atlas packing.
- Runtime manifest approval.
- Live2D canonical model edits.

Those require manual review and technical cleanup.

## Turnaround Prompt Template

```text
Create a clean desktop chibi character turnaround sheet for a blue-white macOS desktop pet companion.
Character proportions: 3.2 to 3.8 heads tall, slightly larger head, readable hands and feet, simplified hair, clear side ponytail, small asymmetric hair accessory, blue-white outfit.
Views: front, back, left side, right side, left front 3/4, right front 3/4.
Style: polished anime chibi, soft edges, high readability at small desktop size, transparent or plain neutral background, consistent face and costume across all views.
Avoid: full-size illustration proportions, excessive tiny details, changed clothing between views, mirrored accessory mistakes, cropped feet, complex background.
```

## Rig Part Prompt Template

```text
Generate isolated transparent PNG rig parts for the approved blue-white desktop chibi character.
Canvas: consistent transparent RGBA canvas, centered part, no shadow baked into part.
Part list for this batch: {PART_LIST}
Maintain exact character identity, colors, hair accessory, and side ponytail direction from the canonical turnaround.
Use clean edges suitable for SpriteKit/Live2D-style layering.
Avoid: changed face shape, different outfit, merged limbs, inconsistent scale, background color, watermark.
```

Recommended part list:

- `head_back_hair`
- `head_face`
- `front_hair`
- `side_ponytail`
- `hair_accessory`
- `eye_left_open`
- `eye_left_closed`
- `eye_right_open`
- `eye_right_closed`
- `mouth_neutral`
- `mouth_smile`
- `mouth_talk_a`
- `mouth_talk_b`
- `torso`
- `skirt_front`
- `skirt_back`
- `upper_arm_left`
- `upper_arm_right`
- `lower_arm_left`
- `lower_arm_right`
- `hand_left`
- `hand_right`
- `thigh_left`
- `thigh_right`
- `shin_left`
- `shin_right`
- `foot_left`
- `foot_right`

## P6.2 Locomotion Prompt Template

Use this template for every P6.2 locomotion batch. Replace `{CLIP_ID}`, `{DIRECTION}`, `{FRAME_COUNT}`, `{SPEED_TIER}`, and `{POSE_BEATS}` exactly for the task.

```text
Create `{CLIP_ID}` for the approved blue-white macOS desktop chibi character.
Direction: `{DIRECTION}`. Speed tier: `{SPEED_TIER}`. Output exactly `{FRAME_COUNT}` individual transparent PNG frames.
Canvas: consistent transparent RGBA canvas for every frame, same pixel dimensions, same character scale, feet aligned to one shared baseline, enough transparent margin for vertical bounce.
Identity lock: do not change hairstyle, side ponytail placement, hair accessory direction, face, costume, palette, body proportions, or character age. Preserve the exact same character identity from frame to frame.
Scene rules: no environment background, no baked shadow, no floor, no text, no watermark. Runtime will generate the shadow.
Motion rules: include contact, down, passing, and up poses. Keep foot planting readable and avoid sliding feet, floating body, jittering head size, inconsistent canvas, or mirrored accessory mistakes.
Naming: export frames as `{CLIP_ID}_00.png`, `{CLIP_ID}_01.png`, continuing with zero-padded consecutive numbers.
Pose beats for this batch: `{POSE_BEATS}`.
```

## P6.2 Required image2 Tasks

- `walk_right_16`: right-facing 16-frame walk cycle. Pose beats: right foot contact, down, passing, up, left foot contact, down, passing, up, repeated with in-betweens for smooth desktop speed.
- `walk_left_16`: left-facing 16-frame walk cycle. Pose beats: left foot contact, down, passing, up, right foot contact, down, passing, up, independently authored; do not mirror right frames.
- `brisk_walk_right_16`: right-facing 16-frame brisk walk. Pose beats: longer stride, stronger arm swing, slightly faster body bounce, right/left foot contacts at frames 0 and 8.
- `brisk_walk_left_16`: left-facing 16-frame brisk walk. Pose beats: longer stride, stronger arm swing, slightly faster body bounce, left/right foot contacts at frames 0 and 8.
- `run_right_12_or_16`: right-facing 12 or 16-frame run. Pose beats: forward lean, airborne/passing moments, right/left foot contacts at half-cycle, no sliding.
- `run_left_12_or_16`: left-facing 12 or 16-frame run. Pose beats: forward lean, airborne/passing moments, left/right foot contacts at half-cycle, no mirrored accessory error.
- `start_move_right_6_or_8`: right-facing 6 or 8-frame start. Pose beats: idle anticipation, rightward weight shift, first push-off, settle into walk/run posture.
- `start_move_left_6_or_8`: left-facing 6 or 8-frame start. Pose beats: idle anticipation, leftward weight shift, first push-off, settle into walk/run posture.
- `stop_move_right_6_or_8`: right-facing 6 or 8-frame stop. Pose beats: final step, braking weight shift, slight squash, upright settle facing right.
- `stop_move_left_6_or_8`: left-facing 6 or 8-frame stop. Pose beats: final step, braking weight shift, slight squash, upright settle facing left.

Each task must also produce a short pose note file listing contact/down/passing/up frames and which foot contacts the baseline.

## Habitat Prompt Template

```text
Create a small blue-white home anchor for a macOS desktop pet companion.
Concept: blue-white magic book soft bed with cloud-like cushion and tiny star accent.
Use a simple polished chibi-friendly object, transparent RGBA background, soft contact shadow, no text, no busy details.
It should read as a gentle resting platform, not a system icon or house.
Leave enough negative space for hover expansion variants.
Avoid: cheap hut, large scene illustration, dark background, heavy detail, text labels, mismatch with blue-white character palette.
```

## Review Checklist

- The character remains the same person across views and frames.
- Side ponytail and hair accessory direction are correct in left and right motion.
- Hands and feet are readable at desktop size.
- No baked background; PNG has alpha.
- Canvas size is consistent within each approved clip.
- Feet contact the ground plane; no uncontrolled floating.
- Left and right clips are independently authored and not frame-identical.
- Walk/brisk/run cadence visually matches their speed tier.
- Start and stop clips face the same direction as the movement that triggered them.
- Pivot, hitbox, shadow, fps, loop, and events are represented in the manifest.
- Candidate files are not referenced by runtime manifests.
