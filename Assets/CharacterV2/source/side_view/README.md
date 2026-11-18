# CharacterV2 Canonical Side-View Source

This directory is the only accepted intake slot for the future CharacterV2 side-view source used to rebuild real walk animation.

## Expected Future Files

- `canonical_side_view_facing_right.png`
- `canonical_side_view_facing_right.accepted.md`
- `canonical_side_view_facing_right.inspect.json`

## Tracking Rules

- The PNG may remain untracked when binary assets are ignored.
- The accepted markdown and inspect JSON should be visible to git and tracked for auditability.
- Final walk generation must not proceed unless `canonical_side_view_facing_right.accepted.md` exists and explicitly says `HUMAN_ACCEPTED=true`.
- A generated or candidate PNG is not accepted by presence alone.

## Production Gate

Final walk generation must refuse to run unless all checks pass:

- Source PNG exists.
- Matching `.accepted.md` exists.
- `.accepted.md` contains `HUMAN_ACCEPTED=true`.
- `.inspect.json` exists.
- `.inspect.json` confirms alpha is present.
- `.inspect.json` confirms transparent margin checks passed.
- The source SHA-256 in `.accepted.md` matches the actual PNG.

Until those conditions are met, the correct status is:

`FINAL_STATUS=BLOCKED_BY_MISSING_APPROVED_SIDE_VIEW`
