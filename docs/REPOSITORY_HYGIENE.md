# Repository Hygiene Policy

This repository intentionally keeps the reproducible source/build surface small while preserving all original local evidence in the protected source snapshot used for the GitHub migration.

## Versioned content

- Swift application and helper source
- Swift tests and UI-test source
- `Package.swift`, `project.yml`, and the generated Xcode project
- required application resources and the prebuilt static Live2D runtime
- Live2D TypeScript source, lockfile, tests, and build script
- approved character assets, source art, references, manifests, and production scripts
- architecture, security, release, and acceptance documentation
- third-party provenance and license notes

## Local-only content

The following content is preserved outside Git because it is generated, machine-specific, redundant, rejected, or unsuitable for a public source repository:

- SwiftPM/Xcode build products and caches
- Node/Python dependency and cache directories
- local logs, temporary output, environment files, credentials, signing material, and machine-local pointers
- `review/` runtime evidence, which includes repeated full patches, build logs, desktop screenshots, app artifacts, duplicated source snapshots, and local paths
- character pipeline `review`, `candidate`, `backup`, `hatch_run`, and general QA intermediates
- generated image-inspection JSON containing machine-local paths

Two non-production artifact sets remain versioned because the automated suite
uses them as deterministic regression fixtures: the former DragonV1 rejected
snapshot and `Assets/LumiScholar/qa/import_report.json`. They are not packaged
as approved production art.

The public repository does not use Git LFS because the selected tracked worktree is about 60 MiB and its largest file is below 3 MiB. Reconsider LFS or a release-asset/download workflow before adding large model archives, generated media, or binary datasets.

## Secret handling

Provider credentials belong in the app's Keychain-backed runtime flow. Never commit real API keys, OAuth tokens, bearer tokens, passwords, private keys, certificates, provisioning profiles, `.env` files, user data, or private model archives. Test fixtures should construct token-shaped data at runtime so the repository does not contain literals that resemble live credentials.

## Evidence boundary

Automated tests, local builds, static snapshots, and app-owned logs are useful evidence, but they do not prove physical GUI interaction, TCC permission success, stable signing, notarization, provider availability, multi-display behavior, or release readiness. Documentation must preserve those states as pending until the corresponding acceptance has actually been run.
