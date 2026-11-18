# Creative asset license and provenance

The MIT license in `LICENSE` does **not** apply to character artwork, sprite
frames, reference images, animation frames, video, audio, fonts, models, or
other creative assets.

Unless an asset-specific notice says otherwise, the project-owned creative
assets in this repository are **All Rights Reserved**. They are included so the
DeskPet source can be built and evaluated. No permission is granted to extract,
repackage, sell, train on, or use those assets in another product.

## Retained asset families

| Paths | Recorded origin | Redistribution status |
| --- | --- | --- |
| `Resources/Characters/Default/`, `Assets/CharacterV2/` | Project-specific original character pipeline and generated/processed frames | Project-owned; All Rights Reserved |
| `Assets/HatchedGirl/`, `Assets/HatchedDragon/` | Generated for this project with the Hatch Pet workflow and image generation, then adapted into runtime frames | Project-owned; All Rights Reserved |
| `Assets/LumiScholar/` | Generated for this project with the Codex Pet workflow, then converted into runtime frames | Project-owned; All Rights Reserved |
| `Assets/DragonV1/` | Derived from a project-supplied AI-generated character image and processed into DeskPet assets | Project-owned; All Rights Reserved |
| `Assets/DragonV2/` | Design documentation only | Project-owned documentation; covered by the repository MIT license |

The corresponding manifests retain hashes and pipeline notes where available.
Generated origin does not guarantee that an image is free of third-party
rights; contributors must not add logos, recognizable third-party characters,
or reference material they lack permission to redistribute.

## Material intentionally excluded

- Live2D Cubism Core and other proprietary SDK binaries;
- user-supplied Live2D models and model archives;
- the former “Fluffy Wintery Kitty” development sample, whose source license
  did not permit this repository to publish or ship it;
- rejected review bundles and local acceptance evidence containing machine
  paths;
- unverified third-party motion/reference video;
- imported user data, credentials, screenshots, logs, and runtime state.

If you own rights in an asset and want to propose a different license, add a
path-specific notice in the same change. Do not assume the source-code MIT
license grants rights to any creative asset.
