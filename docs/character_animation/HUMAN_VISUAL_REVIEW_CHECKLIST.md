# Human Visual Review Checklist

Status: PARTIALLY_READY_FOR_HUMAN_VISUAL_REVIEW

Run the app, then verify:

- Default character is `character_anchor_rgba_v3.png`, not the old SpriteKit shape character.
- Full body is visible with no crop.
- No white, black, or rectangular background.
- Alpha edge has no obvious halo on light and dark desktop backgrounds.
- Feet stay visually planted during breathing.
- Idle motion is subtle and not mechanical.
- Option-interact hit testing only catches opaque character pixels, not transparent corners.
- Click reaction does not stack uncontrollably.
- Drag tilts the character and release lands without window coordinate drift.
- Thinking and speaking do not fight with drag.
- Generation failure returns to idle.
- Reduce Motion lowers movement while preserving minimal feedback.
- Retina display is sharp.
- Multi-display movement does not jump.
- Idle CPU usage is acceptable.
- Closing/hiding the pet leaves no visible animation artifact.

## P6.2 Directional Locomotion Review

- Right slow/normal movement plays `walk_right`.
- Left slow/normal movement plays `walk_left`, not a mirrored or re-flipped right-walk visual.
- Right faster movement selects `brisk_walk_right` or `run_right`; current fallback diagnostics must disclose when legacy walk frames are used.
- Left faster movement selects `brisk_walk_left` or `run_left`; current fallback diagnostics must disclose when legacy walk frames are used.
- Right start selects `start_move_right`; current fallback diagnostics must disclose the temporary legacy directionless fallback.
- Left start selects `start_move_left`; current fallback diagnostics must disclose the temporary legacy directionless fallback.
- Right stop selects `stop_move_right`; current fallback diagnostics must disclose the temporary legacy directionless fallback.
- Left stop selects `stop_move_left`; current fallback diagnostics must disclose the temporary legacy directionless fallback.
- Rapid direction changes, including right-to-left and left-to-right while walking/running, do not freeze on the old direction.
- Rapid direction changes use a stop-then-start transition until dedicated turn/pivot clips exist.
- Foot baseline remains stable across all loaded frames.
- No obvious sliding feet at the default wander speed.
- No obvious sliding feet during faster recall movement.
- No frame flicker or one-frame scale jumps when changing speed tier.
- Animation frequency increases naturally as speed moves from walk to brisk/run.
- Left/right asymmetry is preserved; side ponytail and hair accessory do not jump sides unexpectedly.
- Fallback logs explicitly name the missing placeholder clip and fallback mode.

Record reviewer, date, screenshots, and pass/fail notes before marking visual acceptance READY.
