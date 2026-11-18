#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/.."
# Existing Minecraft packaging resources are reused unchanged. This local
# workflow does not prepare, update, start or test the Minecraft runtime.
node scripts/build-migration.mjs
./node_modules/.bin/electron-forge package --platform=darwin --arch=arm64
node scripts/audit-package.mjs
node scripts/install-local-macos.mjs "$@"
/usr/bin/open "$HOME/Applications/DeskPet Electron.app"
