# Character V2 Asset System

This directory is the controlled asset pipeline for the DeskPet Character Visual System.
It is intentionally separate from legacy concept folders and any canonical Live2D assets.

## Flow

1. `source/` stores canonical references, prompt inputs, and layered rig requests.
2. `candidates/` stores raw image2 outputs. Nothing here is runtime-approved.
3. `review/` stores contact sheets, QA notes, and rejected/selected comparisons.
4. `approved/` stores runtime-eligible transparent PNGs and clip folders.
5. `atlases/` stores future packed textures.
6. `manifests/` stores schema and runtime metadata.

## Canonical Rules

- Desktop SD/chibi-friendly proportions: 3.2 to 3.8 heads tall.
- Keep blue-white identity, hair accessory, and side ponytail readable at desktop scale.
- Left and right motion assets are independent; do not mirror asymmetrical details.
- Approved PNGs must be transparent RGBA, consistently sized inside each clip, and named by clip/frame.
- Manifest metadata must define pivot, hitbox, fps, loop, shadow, and frame events before runtime use.

Current status: runtime links are in place, but final Character V2 image assets are not generated yet.
