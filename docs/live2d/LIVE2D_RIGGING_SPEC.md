# Live2D Rigging Specification

Status: BLOCKED_BY_CUBISM_EDITOR

This is a production specification only. It does not claim rigging is complete.

## Required Inputs

- Accepted layered PSD with no missing required layer pixels.
- Unique layer names.
- Stable canvas coordinates.
- Accepted reconstructed occluded regions.
- Cubism Editor access.

## Parameters

Core:

- `ParamAngleX`: -30 to 30, default 0
- `ParamAngleY`: -30 to 30, default 0
- `ParamAngleZ`: -30 to 30, default 0
- `ParamBodyAngleX`: -10 to 10, default 0
- `ParamBodyAngleY`: -10 to 10, default 0
- `ParamBodyAngleZ`: -10 to 10, default 0
- `ParamBreath`: 0 to 1, default 0

Eyes:

- `ParamEyeLOpen`: 0 to 1, default 1
- `ParamEyeROpen`: 0 to 1, default 1
- `ParamEyeBallX`: -1 to 1, default 0
- `ParamEyeBallY`: -1 to 1, default 0
- `ParamBrowLY`: -1 to 1, default 0
- `ParamBrowRY`: -1 to 1, default 0
- `ParamBrowLAngle`: -1 to 1, default 0
- `ParamBrowRAngle`: -1 to 1, default 0

Mouth:

- `ParamMouthOpenY`: 0 to 1, default 0
- `ParamMouthForm`: -1 to 1, default 0

Hair:

- `HairFrontSwing`: -1 to 1, default 0
- `HairSideSwing`: -1 to 1, default 0
- `HairBackSwing`: -1 to 1, default 0
- `SideTailSwingX`: -1 to 1, default 0
- `SideTailSwingY`: -1 to 1, default 0

Arms/Body:

- `ParamArmL`: -1 to 1, default 0
- `ParamArmR`: -1 to 1, default 0
- `ParamHandL`: -1 to 1, default 0
- `ParamHandR`: -1 to 1, default 0

## Deformer Plan

- Root deformer: whole model placement and scale.
- Body deformer: torso, clothes, arms, legs.
- Head deformer: head rotation and face.
- Hair deformers: back, front, side, side tail.
- Eye deformers: eye whites, iris, pupil, lids, highlights.
- Mouth deformers: mouth base, upper/lower lip, inner, tongue/teeth if accepted.
- Accessory deformers: hair accessory and clothing accessory groups.

## Physics Plan

- Inputs: `ParamAngleX`, `ParamAngleY`, `ParamAngleZ`, `ParamBodyAngleX`, `ParamBreath`.
- Outputs: front hair swing, side hair swing, back hair swing, side tail swing, light accessory sway.
- Constraints: low-amplitude desktop companion motion; avoid large looping animation.

## Motion Set

- `Idle_01`
- `Idle_02`
- `Idle_03`
- `Think_01`
- `Listen_01`
- `Speak_Subtle_01`
- `Happy_01`
- `Happy_02`
- `Sad_01`
- `Annoyed_01`
- `Surprised_01`
- `Wave_01`
- `Sleep_01`
- `Wake_01`
- `Dragged_01`
- `Landing_01`

## Expressions

- `Neutral`
- `Smile`
- `Happy`
- `Curious`
- `Surprised`
- `Sad`
- `Annoyed`
- `Sleepy`
- `Blush`
