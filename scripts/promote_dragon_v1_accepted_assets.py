#!/usr/bin/env python3
"""Promote visually accepted DragonV1 frame sequences into approved assets."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


ACCEPTED_REVIEW_PACKAGE = Path(
    "/path/to/DeskPet/Assets/DragonV1/review/"
    "dragon_mvp_visual_acceptance_20260628_160147"
)
ACCEPTED_REVIEW_TIMESTAMP = "20260628_160147"
SOURCE_ROOT = Path("/path/to/DeskPet/Assets/DragonV1/candidates/dragon_mvp_image2")

CLIPS = [
    {
        "source": "idle_hover",
        "name": "dragon_idle_hover",
        "state": "idleHover",
        "frame_count": 12,
        "fps": 8,
        "loop": True,
    },
    {
        "source": "fly_left_loop",
        "name": "dragon_fly_left_loop",
        "state": "flyLeft",
        "frame_count": 12,
        "fps": 8,
        "loop": True,
    },
    {
        "source": "fly_right_loop",
        "name": "dragon_fly_right_loop",
        "state": "flyRight",
        "frame_count": 12,
        "fps": 8,
        "loop": True,
    },
    {
        "source": "takeoff",
        "name": "dragon_takeoff",
        "state": "takeoff",
        "frame_count": 8,
        "fps": 8,
        "loop": False,
    },
    {
        "source": "land",
        "name": "dragon_land",
        "state": "land",
        "frame_count": 8,
        "fps": 8,
        "loop": False,
    },
]

CANVAS_SIZE = {"width": 512, "height": 512}
ANCHOR_POINT = {"x": 256, "y": 268}


def expected_frames(count: int) -> list[str]:
    return [f"frame_{index:03d}.png" for index in range(count)]


def copy_clip(source_dir: Path, destination_dir: Path, frame_count: int) -> None:
    destination_dir.mkdir(parents=True, exist_ok=True)
    for frame in expected_frames(frame_count):
        source = source_dir / frame
        destination = destination_dir / frame
        if not source.exists():
            raise FileNotFoundError(f"missing accepted source frame: {source}")
        shutil.copy2(source, destination)


def build_manifest(root: Path) -> dict:
    approved_root = root / "Assets/DragonV1/approved"
    return {
        "schemaVersion": 1,
        "manifestID": f"deskpet_dragon_v1_accepted_{ACCEPTED_REVIEW_TIMESTAMP}",
        "dragonID": "DragonV1",
        "assetStatus": "approved",
        "acceptedReviewPackagePath": str(ACCEPTED_REVIEW_PACKAGE),
        "acceptedReviewTimestamp": ACCEPTED_REVIEW_TIMESTAMP,
        "HUMAN_VISUAL_ACCEPTANCE": "ACCEPTED",
        "runtime": {
            "enabledByDefault": False,
            "featureGate": "DESKPET_ENABLE_DRAGON_V1_ASSETS=1",
        },
        "approvedRoot": str(approved_root),
        "clips": [
            {
                "name": clip["name"],
                "state": clip["state"],
                "relativePath": f"approved/clips/{clip['name']}",
                "frameCount": clip["frame_count"],
                "fps": clip["fps"],
                "loop": clip["loop"],
                "canvasSize": CANVAS_SIZE,
                "anchorPoint": ANCHOR_POINT,
                "frames": expected_frames(clip["frame_count"]),
            }
            for clip in CLIPS
        ],
    }


def write_acceptance_record(path: Path) -> None:
    clip_rows = "\n".join(
        f"| {clip['name']} | {clip['frame_count']} | {clip['fps']} | "
        f"{'yes' if clip['loop'] else 'no'} |"
        for clip in CLIPS
    )
    path.write_text(
        f"""# DragonV1 Approved Acceptance Record

HUMAN_VISUAL_ACCEPTANCE = ACCEPTED

Accepted review package:
`{ACCEPTED_REVIEW_PACKAGE}`

Accepted review timestamp: `{ACCEPTED_REVIEW_TIMESTAMP}`

Approved runtime asset root:
`/path/to/DeskPet/Assets/DragonV1/approved`

## Approved Clips

| Clip | Frames | FPS | Loop |
|---|---:|---:|---|
{clip_rows}

## Scope

- Promoted only accepted DragonV1 PNG frame sequences into `approved/clips/`.
- Did not promote review GIF, MP4, contact sheet, metric, or comparison artifacts.
- Did not modify CharacterV2 approved assets.
- Runtime support remains feature-gated by `DESKPET_ENABLE_DRAGON_V1_ASSETS=1`.
""",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="DeskPet package root")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    approved_root = root / "Assets/DragonV1/approved"
    clips_root = approved_root / "clips"
    manifests_root = approved_root / "manifests"

    if not ACCEPTED_REVIEW_PACKAGE.exists():
        raise FileNotFoundError(f"accepted review package does not exist: {ACCEPTED_REVIEW_PACKAGE}")
    if not SOURCE_ROOT.exists():
        raise FileNotFoundError(f"accepted source frame root does not exist: {SOURCE_ROOT}")

    for clip in CLIPS:
        copy_clip(
            SOURCE_ROOT / clip["source"],
            clips_root / clip["name"],
            clip["frame_count"],
        )

    manifests_root.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest(root)
    (manifests_root / "dragon_v1_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    write_acceptance_record(approved_root / "DRAGON_V1_ACCEPTANCE_RECORD.md")
    (approved_root / "README.md").write_text(
        "DragonV1 approved runtime assets were promoted after human visual acceptance.\n"
        "See DRAGON_V1_ACCEPTANCE_RECORD.md and manifests/dragon_v1_manifest.json.\n",
        encoding="utf-8",
    )

    print(json.dumps({
        "status": "promoted",
        "approved_root": str(approved_root),
        "clip_count": len(CLIPS),
        "frame_count": sum(clip["frame_count"] for clip in CLIPS),
        "manifest": str(manifests_root / "dragon_v1_manifest.json"),
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
