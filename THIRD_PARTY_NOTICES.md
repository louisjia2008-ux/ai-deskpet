# Third-party notices

This file records important provenance and redistribution boundaries. It is not a replacement for the complete notices that ship with individual dependencies.

## AIRI-derived Live2D runtime ideas

Parts of the Live2D stage behavior were informed by `moeru-ai/airi`, pinned for this project at revision `00c6867b7fd8064938de1805814578db8273dafe`, particularly `packages/stage-ui-live2d`.

- Copyright: 2024-PRESENT Neko Ayaka
- License: MIT
- Existing repository notices: `ThirdParty/AIRI_LICENSE.txt` and `ThirdParty/AIRI_NOTICE.md`

The AIRI license notice must remain with substantial copied or derived portions.

## Electron and JavaScript dependencies

The Electron edition uses Electron, React, PixiJS, pixi-live2d-display, JSZip, Zod, i18next, Electron Forge, and their transitive dependencies. Each package remains under its own license. `electron/package-lock.json` is the authoritative version inventory for an Electron build; installed package license metadata must be reviewed before a public distribution.

## Minecraft companion runtime

`electron/minecraft-runtime/vendor/` is migrated from the user's `live2d-mc-companion` project. Its file-level source inventory and actual copied-file digests are recorded in `electron/minecraft-runtime/PROVENANCE.json`; the source working tree included local changes. This migration does not include that project's Cubism SDK, models, user configuration, credentials, or chat history. Source provenance does not relicense any third-party material.

Mineflayer, mineflayer-pathfinder, vec3 and their transitive dependencies retain their own licenses. `electron/minecraft-runtime/package-lock.json` pins this independent dependency graph. Their installed license notices are included with the packaged runtime. Minecraft is a Mojang/Microsoft product; this companion is an independent client integration.

## Live2D Cubism

Live2D Cubism Core and other Cubism SDK components are proprietary third-party software governed by Live2D's terms. They are not covered by this repository's MIT license.

The Electron edition does not commit or package `live2dcubismcore.min.js`. A user must obtain the official Cubism SDK, accept its license, and import a Core build whose exact SHA-256 is accepted by the application. The current allowlisted digest is documented in the Electron source and README.

The current source tree does not contain Cubism Core. The native runtime can
optionally load a locally supplied, allowlisted Core from an ignored path after
the developer accepts Live2D's terms. Older private Git history contained a
Core blob; repository visibility remains blocked until that blob is removed
from every reachable remote ref and a fresh-clone history scan confirms it is
gone.

## Models and other assets

Live2D models, artwork, images, sounds, fonts, and other creative assets keep
their original licenses. A user's imported model is never added to the
repository or an Electron installer. See `ASSETS_AND_MODELS.md` and
`ASSET_LICENSE.md` for the repository policy.
