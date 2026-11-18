#!/usr/bin/env bash
# Build then launch DeskPet.app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="DeskPet"
CONFIG="debug"
if [[ $# -gt 0 && "$1" != --* ]]; then
  CONFIG="$1"
  shift
fi

DRAGON_V1_MODE="${DESKPET_ENABLE_DRAGON_V1_ASSETS:-auto}"
EXTRA_BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dragon-v1)
      DRAGON_V1_MODE="1"
      ;;
    --fallback|--vector-fallback)
      DRAGON_V1_MODE="0"
      ;;
    *)
      EXTRA_BUILD_ARGS+=("$arg")
      ;;
  esac
done

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "==> stopping existing $APP_NAME"
  pkill -x "$APP_NAME" || true
  for _ in {1..30}; do
    if ! pgrep -x "$APP_NAME" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

"$ROOT/scripts/build_app.sh" "$CONFIG" ${EXTRA_BUILD_ARGS[@]+"${EXTRA_BUILD_ARGS[@]}"}

APP="$ROOT/build/DeskPet.app"

if [[ "$DRAGON_V1_MODE" == "auto" ]]; then
  if [[ -f "$APP/Contents/Resources/DragonV1/approved/manifests/dragon_v1_manifest.json" ]]; then
    DRAGON_V1_MODE="1"
  else
    DRAGON_V1_MODE="0"
  fi
fi

mkdir -p "$ROOT/build"

launch_app() {
  local -a command=("$@")
  local status=0
  for attempt in 1 2 3; do
    if "${command[@]}"; then
      sleep 0.8
      if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
        return 0
      fi
      status=1
    else
      status=$?
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "==> launch attempt $attempt failed with status $status; retrying..."
      sleep 0.7
    else
      echo "==> launch attempt $attempt failed with status $status"
      return "$status"
    fi
  done
  return "$status"
}

if [[ "$DRAGON_V1_MODE" == "1" ]]; then
  echo "==> launching with DESKPET_ENABLE_DRAGON_V1_ASSETS=1"
  launch_app open -n --env DESKPET_ENABLE_DRAGON_V1_ASSETS=1 "$APP"
else
  echo "==> launching with DragonV1 disabled; vector fallback expected"
  launch_app open -n --env DESKPET_ENABLE_DRAGON_V1_ASSETS=0 "$APP"
fi

echo "==> launched."
echo "==> A 🪄 icon should appear in the menu bar."
