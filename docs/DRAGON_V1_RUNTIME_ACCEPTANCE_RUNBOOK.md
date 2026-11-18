# DragonV1 Runtime Acceptance Runbook

DragonV1 PNG runtime is disabled by default. It is selected only when the
environment variable `DESKPET_ENABLE_DRAGON_V1_ASSETS=1` is present and the
approved manifest and frames load successfully.

## Launch Without The Flag

1. In Xcode, open the DeskPet scheme.
2. Choose `Product > Scheme > Edit Scheme...`.
3. Select `Run > Arguments`.
4. Remove or uncheck `DESKPET_ENABLE_DRAGON_V1_ASSETS`.
5. Launch the app.
6. Confirm the existing vector dragon fallback appears and character behavior is unchanged.

## Enable In Xcode Scheme

1. Open `Product > Scheme > Edit Scheme...`.
2. Select `Run > Arguments`.
3. Under `Environment Variables`, add:
   - Name: `DESKPET_ENABLE_DRAGON_V1_ASSETS`
   - Value: `1`
   - Enabled: checked
4. Launch the app from Xcode.
5. Confirm DragonV1 PNG renderer is selected in DEBUG diagnostics.

## What To Visually Inspect

- Character size and feet anchor remain unchanged from the fallback run.
- Nest/home placement remains unchanged.
- Window size remains stable when DragonV1 is enabled.
- Dragon appears above/beside the character in the intended z-order without covering critical character details.
- Idle hover does not twitch or drift.
- Fly left and fly right loops do not show visible seam pops.
- Takeoff and land transitions read naturally.
- Long-running desktop presence is comfortable and not distracting.

## Debug Diagnostics

In DEBUG builds, DragonV1 logs one renderer-selection line during load:

- `flagRawValue=<nil> featureFlagEnabled=false manifestLoadResult=disabled selectedRenderer=vectorFallback`: expected when the env flag is absent.
- `flagRawValue=1 featureFlagEnabled=true manifestLoadResult=loaded selectedRenderer=pngDragonV1 clips=...`: expected for accepted runtime verification.
- `featureFlagEnabled=true manifestLoadResult=manifestMissing|manifestInvalid|missingFrames|unreadableFrame selectedRenderer=vectorFallback fallbackReason=...`: safe fallback; inspect the exact reason.

For an app-bundle run, `manifestResolvedPath` should point into:

`DeskPet.app/Contents/Resources/DragonV1/approved/manifests/dragon_v1_manifest.json`

If `manifestResolvedPath=<none>` and `manifestCandidates` only show missing
paths, the app is still falling back before PNG runtime rendering.

Diagnostics should show clip names and frame counts matching:

- `dragon_idle_hover=12`
- `dragon_fly_left_loop=12`
- `dragon_fly_right_loop=12`
- `dragon_takeoff=8`
- `dragon_land=8`

## Revert To Fallback

Disable or remove `DESKPET_ENABLE_DRAGON_V1_ASSETS` from the Xcode scheme and
relaunch. No asset deletion or code change is required.

The app bundle includes only `Assets/DragonV1/approved`; review packages,
candidates, and temporary visual-acceptance artifacts are not runtime inputs.

## Evidence Before Acceptance

- Record whether the run used fallback or PNG DragonV1.
- Save the DEBUG diagnostic line for renderer selection.
- Capture short video evidence for idle hover, fly left, fly right, takeoff, and land.
- Note CPU/memory observations after a longer desktop run.
- Fill `Assets/DragonV1/approved/DRAGON_V1_RUNTIME_ACCEPTANCE_CHECKLIST.md`.
