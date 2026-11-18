#!/usr/bin/env bash
# Build the SwiftPM executable and assemble a runnable DeskPet.app bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${1:-debug}"
if [[ $# -gt 0 ]]; then
  shift
fi
EXTRA_SWIFT_BUILD_ARGS=("$@")
APP="$ROOT/build/DeskPet.app"

# Static open-source Live2D host assets are produced explicitly, never by a
# production dev server. Cubism Core is proprietary and intentionally untracked.
for asset in index.html runtime.js manifest.json; do
  if [[ ! -s "$ROOT/Resources/Live2DRuntime/$asset" ]]; then
    echo "error: missing Live2D $asset; follow Live2DRuntime/README.md to build static resources" >&2
    exit 1
  fi
done

CORE_PATH="$ROOT/Resources/Live2DRuntime/live2dcubismcore.min.js"
CORE_SHA256="944988f1523c9f888afe3611b630121ff503ea6246971d2eeee76f45cbfb8004"
if [[ -e "$CORE_PATH" ]]; then
  ACTUAL_CORE_SHA256="$(shasum -a 256 "$CORE_PATH" | awk '{print $1}')"
  if [[ "$ACTUAL_CORE_SHA256" != "$CORE_SHA256" ]]; then
    echo "error: local Cubism Core does not match the supported SHA-256 allowlist" >&2
    exit 1
  fi
  echo "==> including locally supplied, allowlisted Cubism Core"
else
  echo "==> Cubism Core not present; native Live2D rendering will stay unavailable"
fi

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG" --package-path "$ROOT" ${EXTRA_SWIFT_BUILD_ARGS[@]+"${EXTRA_SWIFT_BUILD_ARGS[@]}"}

BINDIR="$(swift build -c "$CONFIG" --package-path "$ROOT" --show-bin-path ${EXTRA_SWIFT_BUILD_ARGS[@]+"${EXTRA_SWIFT_BUILD_ARGS[@]}"})"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINDIR/DeskPet" "$APP/Contents/MacOS/DeskPet"
cp "$BINDIR/DeskPetLLM" "$APP/Contents/MacOS/DeskPetLLM"             # isolated LLM helper (doc §11.2)
cp "$BINDIR/DeskPetToolRunner" "$APP/Contents/MacOS/DeskPetToolRunner" # isolated tool executor (doc 03 §4)
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
find "$ROOT/Resources" -mindepth 1 -maxdepth 1 ! -name Info.plist -exec cp -R {} "$APP/Contents/Resources/" \;

# CharacterV2 is NOT a production asset (project.yml explicitly excludes it; it is
# ~229M). Only include it when explicitly requested for local visual QA, and never
# bundle dev artifacts (qa/review/source) that leak absolute paths into the app.
if [[ "${DESKPET_INCLUDE_CHARACTER_V2:-0}" == "1" && -d "$ROOT/Assets/CharacterV2" ]]; then
  echo "==> including CharacterV2 (DESKPET_INCLUDE_CHARACTER_V2=1, local QA only)"
  mkdir -p "$APP/Contents/Resources/CharacterV2"
  # Copy approved art only; skip qa/review/source dev trees.
  for sub in approved manifest.json manifest.json5 config.json; do
    [[ -e "$ROOT/Assets/CharacterV2/$sub" ]] && cp -R "$ROOT/Assets/CharacterV2/$sub" "$APP/Contents/Resources/CharacterV2/" || true
  done
elif [[ -d "$ROOT/Assets/CharacterV2" ]]; then
  echo "==> skipping CharacterV2 (not a production asset; set DESKPET_INCLUDE_CHARACTER_V2=1 for local QA)"
fi
if [[ -d "$ROOT/Assets/LumiScholar" ]]; then
  cp -R "$ROOT/Assets/LumiScholar" "$APP/Contents/Resources/LumiScholar"
  # Strip dev-only trees that must never ship (absolute-path QA reports etc.).
  rm -rf "$APP/Contents/Resources/LumiScholar/qa" "$APP/Contents/Resources/LumiScholar/review" "$APP/Contents/Resources/LumiScholar/source" 2>/dev/null || true
fi
if [[ -d "$ROOT/Assets/HatchedGirl" ]]; then
  cp -R "$ROOT/Assets/HatchedGirl" "$APP/Contents/Resources/HatchedGirl"
fi
if [[ -d "$ROOT/Assets/HatchedDragon" ]]; then
  cp -R "$ROOT/Assets/HatchedDragon" "$APP/Contents/Resources/HatchedDragon"
fi
if [[ -d "$ROOT/Assets/DragonV1/approved" ]]; then
  mkdir -p "$APP/Contents/Resources/DragonV1"
  cp -R "$ROOT/Assets/DragonV1/approved" "$APP/Contents/Resources/DragonV1/approved"
fi

REQUIRE_STABLE_SIGNING="${DESKPET_REQUIRE_STABLE_SIGNING:-0}"
SIGN_IDENTITY_INPUT="${DESKPET_CODESIGN_IDENTITY:-}"
SIGN_IDENTITY=""

find_codesign_identity() {
  local requested="${1:-}"
  security find-identity -v -p codesigning 2>/dev/null | awk -v requested="$requested" '
    /"Apple Development:/ {
      hash = $2
      name = $0
      sub(/^[[:space:]]*[0-9]+\)[[:space:]]+[A-Fa-f0-9]+[[:space:]]+"/, "", name)
      sub(/"[[:space:]]*$/, "", name)
      if (requested == "" || requested == hash || requested == name) {
        print name
        exit
      }
    }
  '
}

if command -v security >/dev/null 2>&1; then
  SIGN_IDENTITY="$(find_codesign_identity "$SIGN_IDENTITY_INPUT")"
fi

if [[ -n "$SIGN_IDENTITY_INPUT" && -z "$SIGN_IDENTITY" ]]; then
  echo "error: DESKPET_CODESIGN_IDENTITY was provided but no matching Apple Development identity was found." >&2
  echo "       Pass the exact identity name or SHA-1 hash reported by: security find-identity -v -p codesigning" >&2
  exit 1
fi

sign_nested_code() {
  local identity="$1"
  while IFS= read -r -d '' executable; do
    echo "==> codesigning nested executable ${executable#$APP/}"
    codesign --force --sign "$identity" "$executable"
  done < <(find "$APP/Contents/MacOS" -type f -perm -111 ! -name DeskPet -print0)

  for container in "$APP/Contents/Frameworks" "$APP/Contents/PlugIns" "$APP/Contents/XPCServices" "$APP/Contents/Helpers"; do
    [[ -d "$container" ]] || continue
    while IFS= read -r -d '' nested; do
      echo "==> codesigning nested bundle ${nested#$APP/}"
      codesign --force --sign "$identity" "$nested"
    done < <(find "$container" \( -name "*.framework" -o -name "*.dylib" -o -name "*.xpc" -o -name "*.appex" -o -name "*.app" \) -print0)
  done
}

if [[ -n "$SIGN_IDENTITY" ]]; then
  echo "==> codesigning with $SIGN_IDENTITY"
  sign_nested_code "$SIGN_IDENTITY"
  codesign --force --sign "$SIGN_IDENTITY" "$APP"
else
  if [[ "$REQUIRE_STABLE_SIGNING" == "1" ]]; then
    echo "error: DESKPET_REQUIRE_STABLE_SIGNING=1 but no Apple Development identity was found." >&2
    echo "       Stable signing is required for Keychain / Provider acceptance builds." >&2
    exit 1
  fi
  echo "WARNING: Ad-hoc signed build: Keychain authorization persistence is not guaranteed." >&2
  sign_nested_code "-"
  codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "   (codesign skipped)"
fi

echo "==> built $APP"
# Bundle-size gate: fail loudly if the Resources payload regresses (e.g. a 229M
# CharacterV2 tree accidentally re-enters the production bundle).
BUNDLE_MB=$(du -sm "$APP" | cut -f1)
BUNDLE_LIMIT_MB="${DESKPET_BUNDLE_LIMIT_MB:-120}"
if [[ "$BUNDLE_MB" -gt "$BUNDLE_LIMIT_MB" ]]; then
  echo "error: bundle size ${BUNDLE_MB}M exceeds limit ${BUNDLE_LIMIT_MB}M ($APP)." >&2
  echo "       If this is intentional local QA, raise DESKPET_BUNDLE_LIMIT_MB." >&2
  exit 1
fi
echo "==> bundle size ${BUNDLE_MB}M (limit ${BUNDLE_LIMIT_MB}M)"
