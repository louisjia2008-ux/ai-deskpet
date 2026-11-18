# CharacterV2 Side-View Source Acceptance

source_path: Assets/CharacterV2/source/side_view/canonical_side_view_facing_right.png
source_sha256: f77d7dfcb15dc8af5e5db311fe6643e5463f11b2e7e68211f6b7a989c4284f21
inspect_json_path: Assets/CharacterV2/source/side_view/canonical_side_view_facing_right.inspect.json
reviewer: user-human-review
review_date: 2026-06-22
accepted_scope: SIDE_VIEW_SOURCE_ONLY
HUMAN_ACCEPTED=true

## Notes

- HUMAN_ACCEPTED=true applies only to the canonical side-view source.
- Walk animation is still not accepted.
- Facing-right side-view source accepted for walk-cycle candidate generation.
- The bbox aspect ratio warning is acknowledged and accepted because a side-view source is naturally narrower than the front-view canonical.
- The original generated side-view candidate was rejected for fully opaque alpha and visible green chroma-key background pixels.
- A non-destructive alpha cutout candidate was generated for human review:
  `Assets/CharacterV2/source/side_view/canonical_side_view_facing_right_alpha_candidate.png`
- Final walk animation must still pass animation preview review and strict validator before it can be approved.

## Required Visual Checks

- same outfit
- same hair identity
- same head/body ratio
- same color palette
- transparent alpha
- full body
- feet visible
- no crop
- enough margin
- neutral side pose
