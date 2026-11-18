# DeskPet Live2D runtime

Vanilla TypeScript / Pixi 6 / Cubism adapter, hosted locally by DeskPet's WKWebView. No Electron, AIRI app, Vue, Node process or development server at runtime.

Build from this directory:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
DESKPET_CUBISM_CORE=/path/to/CubismSdkForWeb-5-r.3/Core/live2dcubismcore.min.js npm run build
```

Obtain the official SDK from https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.3.zip (the same SDK source as pinned AIRI). Read the SDK/Core/sample licenses before distribution. Core and model art are not MIT. Build tooling never silently downloads SDK updates. Output is `../Resources/Live2DRuntime`. The native build fails loudly if static artifacts are missing; then run `../scripts/build_app.sh debug` from this directory. The 120 MB app-size gate may fail for the preexisting PNG asset payload; a **local QA only** invocation can set `DESKPET_BUNDLE_LIMIT_MB=170`. Do not change the shipping limit as part of this migration.

Development integration (Debug only) is inside the real DeskPet process:

```sh
open -n /path/to/DeskPet/build/DeskPet.app --args \
  --automation-profile live2d-local --data-root /private/tmp/deskpet-live2d-profile \
  --live2d-model-root /path/to/local/models --live2d-source Haru/Haru.model3.json \
  --live2d-evidence /path/to/review/run
```

`--live2d-source` also accepts a relative ZIP file. This phase deliberately requires model3 metadata and exactly one settings file in ZIP; it never guesses ambiguous models. Native model data roots are explicit; no user-specific hardcoded path. Production integration should supply the app-managed Application Support/DeskPet/Characters/Live2D directory.

Review artifacts are under `review/live2d_airi_extraction_20260914_010313`. Production canonical character rendering is not switched until every parity/deletion gate is demonstrated. The DEBUG development window is not an automatic error fallback or shipping renderer selector.

For a large VTS export with unrelated gift/UI art, use `python3 ../scripts/import_live2d_model.py /path/source.zip /path/new-model-only.zip` before loading. The original remains unchanged; output creation refuses overwriting. Existing unlisted exp3/motion3 files are discovered by the ZIP loader. Model rights remain governed by the source notices.

Xcode users: regenerate with XcodeGen from project.yml before building so the new Swift sources and folder resource are included. This phase validated the SwiftPM bundle route, not an independent Xcode build.
