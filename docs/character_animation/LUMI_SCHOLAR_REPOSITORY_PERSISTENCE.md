# Lumi Scholar Repository Persistence

Status: `LUMI_REPOSITORY_PERSISTENCE_READY`

This note records the repository-persistence boundary for the Lumi Scholar runtime assets. It is not a human visual acceptance result.

## Ignore Root Cause

The Git top level is `/path/to/workspace`; DeskPet lives at `/path/to/DeskPet`.

The parent ignore file `/path/to/workspace/.gitignore` keeps the DeskPet tree narrow:

- line 20: `桌宠/DeskPet/*`
- line 36: `桌宠/DeskPet/Assets/*`

Those rules ignored `project.yml`, `DeskPet.xcodeproj`, and `Assets/LumiScholar/*` before local negation rules were added.

## Local Ignore Policy

The local file `/path/to/DeskPet/.gitignore` intentionally re-includes only the stable files needed to recover Lumi Scholar from Git-discoverable content:

- `project.yml`
- `Assets/LumiScholar/source/pet.json`
- `Assets/LumiScholar/source/spritesheet.webp`
- `Assets/LumiScholar/approved/lumi_scholar_manifest.json`
- `Assets/LumiScholar/approved/clips/lumi_scholar_manifest.json`
- `Assets/LumiScholar/approved/clips/**/*.png`

The following remain intentionally ignored:

- `DeskPet.xcodeproj`
- `Assets/LumiScholar/qa/**`
- `Assets/LumiScholar/review/**`

## Verification Script

Run from `/path/to/DeskPet`:

```bash
python3 scripts/verify_lumi_repository_persistence.py --clean-build --launch
```

The script does not stage, commit, reset, clean, stash, or push. It:

- checks required trackable files with `git check-ignore -v`
- checks intentionally ignored generated/review files with `git check-ignore -v`
- creates a temporary clean copy under `/private/tmp` using only `git ls-files --cached --modified --others --exclude-standard`
- runs `xcodegen generate`
- runs `python3 scripts/import_codex_pet.py`
- runs `python3 scripts/validate_lumi_scholar_assets.py`
- runs a Debug `xcodebuild`
- validates the Debug app bundle resources
- optionally launches the temporary Debug app and probes startup logs for Lumi loading

Latest verified report:

- report: `/path/to/DeskPet/Assets/LumiScholar/qa/repository_persistence_verification.json`
- status: `PASSED`
- failure count: `0`
- clean root: `/private/tmp/deskpet-lumi-persistence.y4urvvuh/桌宠/DeskPet`
- Debug app: `/private/tmp/deskpet-lumi-derived.7fw0zmt6/Build/Products/Debug/DeskPet.app`
- copied file count: `556`

Latest clean recovery steps:

- `xcodegen generate`: passed
- `python3 scripts/import_codex_pet.py`: passed
- `python3 scripts/validate_lumi_scholar_assets.py --output Assets/LumiScholar/qa/repository_persistence_validation_report.json`: passed
- `xcodebuild -project DeskPet.xcodeproj -scheme DeskPet -configuration Debug -derivedDataPath /private/tmp/deskpet-lumi-derived.7fw0zmt6 -destination platform=macOS CODE_SIGNING_ALLOWED=NO -quiet build`: passed
- `python3 scripts/validate_lumi_scholar_assets.py --bundle-root /private/tmp/deskpet-lumi-derived.7fw0zmt6/Build/Products/Debug/DeskPet.app/Contents/Resources --output Assets/LumiScholar/qa/repository_persistence_bundle_validation_report.json`: passed

Latest startup probe:

- log: `/private/tmp/deskpet-lumi-launch.sha6nmqm/startup.log`
- observed `Loaded Lumi Scholar manifest`: true
- observed `Loaded character clip idle`: true

## Visual Review Package

No review images are tracked. The current review-only index is:

`/path/to/DeskPet/Assets/LumiScholar/review/lumi_scholar_runtime_review/visual_review_index.json`

The indexed review root is:

`/path/to/DeskPet/Assets/LumiScholar/review/lumi_scholar_runtime_review`

It currently records:

- `idle.gif`: 384x416, 7 frames, 5 fps, 1.4 s
- `move_left.gif`: 384x416, 8 frames, 10 fps, 0.8 s
- `move_right.gif`: 384x416, 8 frames, 10 fps, 0.8 s
- `transition_idle_to_move.gif`: 384x416, 6 frames, 50 fps, 0.12 s
- `transition_move_to_idle.gif`: 384x416, 6 frames, 50 fps, 0.12 s
- `task_waiting.gif`: 384x416, 6 frames, 4 fps, 1.5 s
- `task_running.gif`: 384x416, 6 frames, 6.25 fps, 0.96 s
- `task_review.gif`: 384x416, 6 frames, 4 fps, 1.5 s
- `task_failed.gif`: 384x416, 8 frames, 6.25 fps, 1.28 s

Runtime overlay screenshots are indexed as 184x184 PNG stills, including idle, move, waiting, running, review, success-to-idle, failed-to-idle, and look debug preview states.

## Remaining Risks

- Human visual acceptance is still pending.
- The review and QA reports are intentionally ignored and must be regenerated or preserved locally when needed.
- The parent ignore policy still causes broad DeskPet subtree filtering; the local `.gitignore` is the persistence boundary for Lumi Scholar.
- Existing non-Lumi untracked CharacterV2 assets may still appear in full `git status --untracked-files=all` because parent rules already white-list CharacterV2 paths.
