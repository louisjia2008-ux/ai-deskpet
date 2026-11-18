#!/usr/bin/env bash
# Local QA only; existing production renderer remains pending the deletion gates.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_ROOT="${1:?Usage: run_live2d_acceptance.sh MODEL_DIRECTORY RELATIVE_MODEL_SOURCE EVIDENCE_DIRECTORY}"
MODEL_SOURCE="${2:?missing model source}"
EVIDENCE="${3:?missing evidence directory}"
# Explicit local-QA size override; does not change build_app.sh's shipping gate.
DESKPET_BUNDLE_LIMIT_MB=170 "$ROOT/scripts/build_app.sh" debug
mkdir -p "$EVIDENCE"
/usr/bin/open -n --stdout "$EVIDENCE/stdout.log" --stderr "$EVIDENCE/stderr.log" "$ROOT/build/DeskPet.app" --args \
  --automation-profile live2d-acceptance --data-root /private/tmp/deskpet-live2d-acceptance-profile \
  --live2d-model-root "$MODEL_ROOT" --live2d-source "$MODEL_SOURCE" --live2d-evidence "$EVIDENCE"
