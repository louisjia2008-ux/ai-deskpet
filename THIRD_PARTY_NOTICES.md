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

`electron/minecraft-companion-runtime/` is the production runtime of the project owner's separate repository [louisjia2008-ux/minecraft-companion](https://github.com/louisjia2008-ux/minecraft-companion), extracted at source tree `e8815db4760e394f093fd67c3c03ffe8e74733be` and then changed for DeskPet. It is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`), not under this repository's MIT license; its full text is `electron/minecraft-companion-runtime/LICENSE`. `electron/minecraft-companion-runtime/COMPANION_SOURCE.json` records the source hashes, the file selection and every local change. DeskPet starts this runtime as a separate helper process and talks to it over a JSONL protocol. If you distribute DeskPet builds that include it, the AGPL terms apply to that runtime, including offering its corresponding source.

`minecraft-mod/` contains the DeskPet server-side Fabric Mod, also licensed under **AGPL-3.0-only**. The full text is in `minecraft-mod/LICENSE`. The Mod's dependencies retain their own licenses.

Mineflayer, mineflayer-pathfinder, vec3 and their transitive dependencies retain their own licenses. Their versions are pinned by `electron/minecraft-companion-runtime/package-lock.json`. Their license notices ship in the packaged dependency tree. Minecraft is a Mojang/Microsoft product. DeskPet is an independent integration.

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
