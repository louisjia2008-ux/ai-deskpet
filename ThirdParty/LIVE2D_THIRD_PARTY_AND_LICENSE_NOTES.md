# Live2D third-party and license notes

AIRI-derived algorithms: MIT, Copyright (c) 2024-PRESENT Neko Ayaka, license and pinned origin retained in ThirdParty/AIRI_LICENSE.txt and AIRI_NOTICE.md. pixi-live2d-display 0.4.0: MIT package license. PixiJS 6.5.10: MIT. JSZip 3.10.1: (MIT OR GPL-3.0-or-later), using its MIT alternative. Transitive license inventory is generated from installed lockfile packages; no excluded AIRI UI dependencies are needed.

Cubism Core is Live2D proprietary software, NOT MIT. Core/LICENSE.md and top-level SDK LICENSE.md are preserved. The adapter also contains Cubism Framework code under the Live2D Open Software License; its SDK notice is retained separately. Core is acquired from the same official CubismSdkForWeb-5-r.3.zip URL used by AIRI plugin 0.1.7. Local build copies only the Core script, not the entire SDK.

Validation model: Haru, official SDK Samples/Resources/Haru. Source archive https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.3.zip. SDK LICENSE.md specifically lists Haru under the Free Material License and points to model-specific terms at https://docs.live2d.com/cubism-editor-manual/sample-model/. It is used only as a temporary local runtime validation asset under /private/tmp/deskpet-live2d-models; model art is not bundled or committed. No invented model files (the separate invalid metadata fixture is explicitly an error test).

No commercial distribution clearance or additional redistribution right is claimed. Distribution review must apply the actual Core, SDK and model terms to the intended product. Full notices are bundled with the static local validation runtime.
