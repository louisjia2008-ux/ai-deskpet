# DeskPet

The Electron console includes **Minecraft companion play** with the Core engine. Connect a bot to a Java Edition server, or run a managed local server with the DeskPet survey-wand Mod. See the [Minecraft guide](electron/docs/MINECRAFT_COMPANION.md).

[English](README.md) | [简体中文](README.zh-CN.md)

DeskPet is a local-first AI desktop companion with two parallel implementations:

- `Sources/` is the existing native macOS application built with Swift, SwiftUI, AppKit, SpriteKit, WebKit, and a Live2D runtime.
- `electron/` is the cross-platform core edition built with Electron, React, strict TypeScript, PixiJS, and Live2D. It does not replace or modify the native edition.

The Electron edition provides one Live2D companion, a transparent desktop overlay, tray integration, a Companion Console, chat, AI providers, tasks and focus, memories, relationship state, schedules, an auditable permission-gated agent runtime, and English/Simplified Chinese UI. It uses the separate application ID `com.deskpet.companion.electron` and the separate data directory `DeskPet Electron`, so both editions can be installed together.

## Status and support matrix

| Capability | macOS | Windows | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| Electron build and package target | Supported | Supported | Supported | Supported |
| Transparent companion overlay | Supported | Supported | Supported by Electron/X11 | Degraded; compositor-dependent |
| Exact placement and always-on-top | Supported | Supported | Supported | Degraded; compositor may ignore requests |
| Precise transparent click-through | Supported | Supported | Best effort | Degraded; per-pixel forwarding is not guaranteed |
| Tray, notifications, auto-launch | Supported | Supported | Desktop-environment dependent | Desktop-environment dependent |
| Global shortcut | `Option+Space` by default | `Ctrl+Alt+P` by default | `Ctrl+Alt+P` by default | Portal authorization or desktop-specific behavior may apply |
| Native Swift data migration | Supported through the macOS helper | Unavailable | Unavailable | Unavailable |

The application reports each platform capability as `available`, `degraded`, or `unavailable`, with a reason. An Electron API being present is not treated as proof that the desktop environment honors it. DeskPet never changes a user's Wayland/X11 startup configuration automatically.

Current real-desktop evidence is intentionally narrow:

| Acceptance surface | Result |
|---|---|
| macOS console and transparent overlay first launch, local protocol, missing-Core/model state | PASS on the development Mac |
| macOS rendering with an imported legal Core and model, drag, model hit testing, click-through, motion, multi-display, sleep/wake, fullscreen, DPI/Retina, tray/hotkey soak | NOT OBSERVED in this Electron change |
| Windows real desktop | NOT OBSERVED |
| Linux X11 real desktop | NOT OBSERVED |
| Linux Wayland real desktop | NOT OBSERVED; capability logic is automated, not a substitute for observation |

Compilation, E2E smoke tests, or screenshots must not be interpreted as real-desktop Live2D acceptance on an unobserved platform.

## Requirements

### Electron edition

- Node.js 22 or newer and npm 10 or newer
- macOS, Windows, or Linux supported by the pinned Electron release
- On macOS, Swift 6/Xcode command-line tools are needed to build the migration helper
- A legally obtained `live2dcubismcore.min.js` from the official [Live2D Cubism SDK for Web](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/)
- A Live2D model ZIP that you are permitted to use

No provider credential is needed for compilation or the fixture-based default test suite. Network provider features require a user-supplied key or a local provider.

### Native macOS edition

- macOS 14 or newer
- Swift 6 and current Xcode command-line tools
- XcodeGen only when regenerating `DeskPet.xcodeproj` from `project.yml`
- Optional: a legally obtained, allowlisted Cubism Core placed locally at
  `Resources/Live2DRuntime/live2dcubismcore.min.js`. This ignored proprietary
  file is needed only for native Live2D rendering and must never be committed.

## Develop and test the Electron edition

```bash
cd electron
npm ci
npm start
```

The main verification commands are:

```bash
npm run lint
npm run typecheck
npm test
npm run test:security
npm run build
npm run test:e2e
npm run audit:package
```

`npm run build` creates an unpacked application under `electron/out/`. Run it before E2E so the production webpack bundles exist. `npm run make` creates the current platform's unsigned preview installer. The GitHub Actions matrix builds:

- a macOS ZIP;
- a Windows x64 Squirrel `Setup.exe`;
- a Linux x64 `.deb`;
- coverage, Playwright reports, and sanitized fixture-only failure evidence.

CI uploads artifacts but does not create a GitHub Release. These packages are unsigned previews: Apple notarization and Windows Authenticode are separate release gates. Operating systems may warn or refuse normal launch until appropriate signing is added.

## First launch: Cubism Core and model

The Electron edition intentionally contains no Cubism Core, default model, PNG fallback character, or developer model.

1. Download the official Cubism SDK for Web yourself and accept its applicable terms.
2. In Companion setup, select `live2dcubismcore.min.js`. DeskPet accepts only the exact filename, bounded file size, and an allowlisted SHA-256. The first allowlisted Core hash is `944988f1523c9f888afe3611b630121ff503ea6246971d2eeee76f45cbfb8004`.
3. Select a model ZIP you have the right to use. It must contain exactly one parseable `model3.json` and its referenced resources.
4. DeskPet validates archive paths, duplicates, symlinks, extensions, entry counts, individual sizes, expanded size, and resource references. Files are extracted into managed staging.
5. The active model setting is committed only after the sandboxed renderer reports a successful model load. Cancellation or failure removes staging and preserves the previous model.

Validated files are copied into the application's managed data directory and served only through the restricted local `deskpet://managed` protocol. Arbitrary user paths and network pages cannot execute the Core.

## Companion Console and agent boundaries

The Console includes Today, Chat, Companion, Focus/Tasks, Memory, Schedules, Task Center, Providers, Tool Permissions, Privacy, Migration, Appearance, and Diagnostics surfaces.

Electron process responsibilities are deliberately separated:

- the main process owns windows, tray, shortcuts, persistence, schedules, permissions, and the canonical runtime;
- preload exposes only the typed `window.deskpet` domain API;
- React renderers cannot access Node.js, the file system, generic IPC, or arbitrary navigation;
- a utility process performs Provider network requests outside the renderer; the canonical main-process runtime validates and dispatches approved tools;
- every tool call carries task/run identity, a capability ID, and schema-validated arguments before any side effect is considered.

Every BrowserWindow uses context isolation and the Chromium sandbox with Node integration disabled. IPC validates channel, API version, exact payload schema, payload size, local origin, sender WebContents, and window role. A strict CSP, navigation denial, and new-window denial are applied to both renderers.

The first-edition tools are current time, bounded system overview, application timer, local notification, confined workspace file read/write, and HTTPS page reading with DNS/IP, redirect, content-type, size, and timeout restrictions. Side effects are permission-gated and recorded with idempotency keys. Missed side-effect schedules are marked `missed` after restart and are not silently replayed.

## AI provider support

| Provider | Electron status | Protocol |
|---|---|---|
| OpenAI | Supported | OpenAI-compatible chat/models/streaming |
| OpenAI-compatible endpoint | Supported | Configured base URL |
| MiniMax | Supported through its OpenAI-compatible endpoint | OpenAI-compatible |
| GLM / Zhipu | Supported through its OpenAI-compatible endpoint | OpenAI-compatible |
| DeepSeek | Supported | OpenAI-compatible |
| Ollama | Supported | Local OpenAI-compatible endpoint |
| LM Studio | Supported | Local OpenAI-compatible endpoint |
| Anthropic | Not implemented or advertised | — |
| Gemini | Not implemented or advertised | — |
| Arbitrary custom HTTP | Not implemented or advertised | — |

Streaming text, cancellation, retry/error mapping, model listing, and declared tool calls are implemented. Default CI uses a local fixture server and no real credential. Live OpenAI validation for this change is `NOT_RUN_NO_CREDENTIAL` because no key was created or supplied.

### Choosing models, measured

`electron/evals` holds quality evals for the three model-driven memory and persona features (see
[`electron/evals/README.md`](electron/evals/README.md)). A comparison run on 2026-11-25 (OpenAI, 3 runs per case, judge
fixed to `gpt-6.2-sol`, persona cases against a real character sheet):

| Model | Auto memory | Nightly tidy-up | Persona | List price per 1M tokens (in / out) |
|---|---|---|---|---|
| `gpt-6-luna` | 99.2% | 99.4% | 95.5% | $0.1 / $0.5 |
| `gpt-6.1-terra` | 99.7% | 96.6% (one invalid plan) | 97.9% | $1 / $5 |
| `gpt-6.2-sol` | 99.5% | 99.6% | 98.5% | about $2 / $10 |
| `gpt-6-astra` | 99.0% | 100% | 97.3% | $10 / $50 |

The background memory tasks score about the same on every model, so a small model is enough for them at a fraction of
the cost; chat in character is where a larger model shows. **Memory → Model for background memory** picks
the model those tasks use with the provider you chat with (default: same as chat). Diary and recent-summary have no
evals yet, so they keep following chat. The judge shares a family with `gpt-6.2-sol`, which may favour its style in the
persona column.

## Native macOS data migration

On macOS, Settings → Migration can import selected data from `~/Library/Application Support/DeskPet` into an empty Electron profile.

- Preview is user initiated and lists categories, counts, warnings, and a source digest.
- The Swift helper reads native plaintext or `DPET1` AES-GCM stores using the existing `ai.deskpet.vaultkey` Keychain item. It never creates or changes that key.
- The source is read-only. The Electron target directory is backed up before import, and the source digest is checked again before commit.
- Normal/project conversations, memories, tasks, relationship/appearance settings, schedules, supported provider configurations, and a ZIP-backed current model selection can be selected.
- Temporary/private conversations, active agent continuations, grants, the side-effect ledger, diagnostics, logs, caches, and test state are excluded.
- Provider API keys require an additional checkbox and a second confirmation. Keys travel through a dedicated private child-process pipe and are immediately encrypted with Electron `safeStorage`; they are never written to a plaintext temporary file or returned to a renderer.
- If Keychain access is denied, provider configuration can still import while the key remains marked missing.
- The import writes a digest-bearing completion marker and will not merge repeatedly. Cancellation before commit leaves the source untouched and allows a later retry.

An extracted native model directory cannot be converted into a trusted ZIP implicitly; the user is asked to re-import a legal original ZIP. A ZIP selected by the native configuration still goes through the same hostile-archive validation and renderer acknowledgment as a normal Electron import.

## Local data, privacy, and security

Electron data locations follow Electron's per-user configuration conventions:

- macOS: `~/Library/Application Support/DeskPet Electron`
- Windows: `%APPDATA%\DeskPet Electron`
- Linux: `~/.config/DeskPet Electron` in the usual XDG configuration

Domain data uses a versioned AES-256-GCM envelope, atomic temporary-file-plus-rename writes, schema validation, and corruption quarantine. A random vault key and Provider API keys are protected with Electron `safeStorage`. On Linux, the `basic_text` backend is rejected: encrypted data and keys fail closed until GNOME Keyring, KWallet, or another acceptable secret service is installed and unlocked.

Workspace tools are confined to DeskPet Electron's workspace directory. Provider keys, model contents, user data, and diagnostic secrets are never included in repository fixtures or CI artifacts.

## Native macOS development

The original app remains available and independently maintainable:

```bash
swift test
bash scripts/build_app.sh debug
bash scripts/run.sh debug
```

`scripts/build_app.sh` builds without Cubism Core and reports native Live2D as
unavailable. If the ignored local Core file is present, the build verifies its
SHA-256 against the allowlist before copying it. The static/project-owned
character renderer remains available without Core.

The native production tool catalog currently leaves general-purpose webpage
reading and the legacy ToolRunner `network.fetch`/`network.search` capabilities
unavailable. Hostname-only filtering cannot pin the address ultimately used by
URLSession, so these entry points fail closed until an address-pinned transport
is implemented. This does not disable the Electron edition's separately bounded
HTTPS reader.

`scripts/run.sh` stops an already-running native process named `DeskPet`; use it only when that behavior is intended. Signing, TCC prompts, Keychain access, screen/desktop behavior, and notarization remain gates separate from compilation.

## Repository layout

```text
electron/         Electron/React cross-platform edition and macOS migration helper
Sources/          native Swift/macOS application and runtime modules
Tests/            native Swift test sources
Live2DRuntime/    native edition's existing TypeScript/WebKit Live2D runtime
Resources/        native application resources
ThirdParty/       existing third-party provenance and Live2D notices
.github/          cross-platform Electron preview CI
```

## Licensing and redistribution

The top-level [MIT license](LICENSE) applies only to source code and
documentation owned by this project. It does not relicense Live2D Cubism Core,
Cubism SDK components, user models, character art, images, audio, fonts, or any
third-party work. Retained project-owned creative assets are separately All
Rights Reserved. Read [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[ASSETS_AND_MODELS.md](ASSETS_AND_MODELS.md), and
[ASSET_LICENSE.md](ASSET_LICENSE.md) before redistribution.

The [Minecraft Companion Core runtime](electron/minecraft-companion-runtime/) and the [DeskPet Minecraft server Mod](minecraft-mod/) are licensed under **AGPL-3.0-only**. The Core runtime is derived from [louisjia2008-ux/minecraft-companion](https://github.com/louisjia2008-ux/minecraft-companion). Source provenance and redistribution terms are recorded in the [third-party notices](THIRD_PARTY_NOTICES.md).

The AIRI-derived Live2D algorithms retain the pinned origin `moeru-ai/airi@00c6867b7fd8064938de1805814578db8273dafe`, copyright notice, and MIT text under `ThirdParty/`.

Neither edition's tracked source nor generated Electron installers contain
Cubism Core or user models. A former third-party demo character, rejected
machine-local review evidence, and an unverified reference video were removed
from the public source profile. Older private Git commits still require an
authorized history rewrite and all-ref rescan before repository visibility can
change. Public source availability does not by itself satisfy Live2D's
application publication, signing, notarization, or commercial-distribution
requirements.
