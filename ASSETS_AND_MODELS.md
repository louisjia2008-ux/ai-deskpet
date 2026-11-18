# Assets and models policy

The MIT license in `LICENSE` covers only source code and documentation owned by this project. It does not grant rights to Live2D Cubism components, user models, third-party characters, artwork, images, audio, fonts, or trademarks. See `ASSET_LICENSE.md` for the retained project-owned creative assets and their separate All Rights Reserved terms.

## Electron edition

- No Cubism Core is committed to the Electron subtree or bundled in its installers.
- No default Live2D model, PNG fallback, model ZIP, unpacked user model, or user API key is committed or bundled.
- Users must import a supported Core obtained from the official Cubism SDK and a model they are legally allowed to use.
- Imported material stays in the local `DeskPet Electron` application-data directory and must not be copied into bug reports, screenshots, test fixtures, CI artifacts, or pull requests without explicit redistribution permission.

## Existing native edition

The public-ready native source tree does not contain Cubism Core, user models,
or the formerly bundled third-party Fluffy sample. Native Live2D rendering is
optional for local development: a developer may place an allowlisted,
legally-obtained Core in the ignored runtime path after accepting Live2D's
terms. That local file must never be committed.

Retained project-owned character assets are inventoried in
`ASSET_LICENSE.md`. Rejected review snapshots and an unverified reference
video were removed from the public source profile.

## Gate before making the repository public

Before changing repository visibility or creating a public release, perform a separate, explicit review that includes:

1. A history-level secret scan, not only a scan of the current tree.
2. A search for Cubism Core and SDK blobs in the current tree and Git history.
3. An inventory of all characters, images, sounds, fonts, sample data, screenshots, and generated artifacts.
4. Written confirmation of redistribution rights for every non-code asset that remains.
5. Inspection of packaged installers to prove they contain neither imported models nor Cubism Core.
6. Review of the applicable Live2D terms for the intended distribution and commercial model.

The current working tree has passed the current-tree inventory. Repository
visibility must remain private until the separate history rewrite, all-ref
rescan, fresh-clone verification, and owner confirmation are complete.
