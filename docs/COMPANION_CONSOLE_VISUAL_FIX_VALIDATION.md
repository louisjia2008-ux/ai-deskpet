# Companion Console Visual Fix Validation

Date: 2026-06-23

## Scope

This pass is limited to the P0-P3 human visual acceptance failures:

- Companion Console window sizing and layout stability.
- Native text clarity in the console UI.
- Provider / Model / Today / Privacy / Focus page compression.
- Pet character, shadow, and home/nest visual separation.

No Provider / Runtime architecture changes were made. No API keys, sessions, credentials, OpenClaw code, approved character art, or walk frames were modified.

## Commands Run

```sh
git diff --check
```

Result: passed.

```sh
env HOME=/private/tmp/deskpet-visualfix-cache/home \
  CLANG_MODULE_CACHE_PATH=/private/tmp/deskpet-visualfix-cache/clang-module-cache \
  SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/deskpet-visualfix-cache/swiftpm-module-cache \
  XDG_CACHE_HOME=/private/tmp/deskpet-visualfix-cache \
  swift test --disable-sandbox --disable-dependency-cache \
  --disable-build-manifest-caching --manifest-cache local \
  --cache-path /private/tmp/deskpet-visualfix-cache/swiftpm-cache \
  --config-path /private/tmp/deskpet-visualfix-cache/swiftpm-config \
  --security-path /private/tmp/deskpet-visualfix-cache/swiftpm-security \
  --scratch-path /private/tmp/deskpet-visualfix-cache/scratch
```

Result: passed, 289 tests, 0 failures.

```sh
env HOME=/private/tmp/deskpet-visualfix-cache/home \
  CLANG_MODULE_CACHE_PATH=/private/tmp/deskpet-visualfix-cache/clang-module-cache \
  SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/deskpet-visualfix-cache/swiftpm-module-cache \
  XDG_CACHE_HOME=/private/tmp/deskpet-visualfix-cache \
  swift build --disable-sandbox --disable-dependency-cache \
  --disable-build-manifest-caching --manifest-cache local \
  --cache-path /private/tmp/deskpet-visualfix-cache/swiftpm-cache \
  --config-path /private/tmp/deskpet-visualfix-cache/swiftpm-config \
  --security-path /private/tmp/deskpet-visualfix-cache/swiftpm-security \
  --scratch-path /private/tmp/deskpet-visualfix-cache/scratch
```

Result: passed.

```sh
env HOME=/private/tmp/deskpet-visualfix-cache/home \
  CLANG_MODULE_CACHE_PATH=/private/tmp/deskpet-visualfix-cache/clang-module-cache \
  SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/deskpet-visualfix-cache/swiftpm-module-cache \
  XDG_CACHE_HOME=/private/tmp/deskpet-visualfix-cache \
  bash scripts/build_app.sh debug
```

Result: first sandboxed run failed with `sandbox_apply: Operation not permitted`; rerun with elevated sandbox permission passed and produced `build/DeskPet.app`.

```sh
test -f build/DeskPet.app/Contents/Info.plist
test -x build/DeskPet.app/Contents/MacOS/DeskPet
codesign --verify --deep --strict build/DeskPet.app
```

Result: all passed.

## Screens To Inspect

- Console open/default: window content should be about 560x640 pt and user-resizable, with minimum about 520x560 pt.
- Page switching: Today -> Provider -> Model -> Privacy -> Focus -> Today should not resize the NSWindow or narrow the content column.
- Provider: title stays on one line; provider cards keep readable names, URL, status pills, and Edit/Test/Refresh/Delete buttons.
- Today: status overview uses readable metric cards and aligned actions; model and permission labels should not wrap every one or two characters.
- Privacy: each permission row has a stable title/status line, caption text below, and action controls below or aligned without crowding.
- Focus: timer remains centered and readable; controls and session metrics wrap into clean grid rows.
- Desktop pet: shadow may follow the character feet; home/nest should not be visible/following the pet by default.

## Known Limitations

- Home/nest is hidden by default in the pet overlay. A future explicit home/sleep/return-home scene can reintroduce it as an independently anchored object.
- This pass does not change walk animation jitter, walk timing, walk source art, or approved walk frames.
- Quick task and quick chat panels keep their own fixed content sizes; they are separate panels, not the Companion Console.
