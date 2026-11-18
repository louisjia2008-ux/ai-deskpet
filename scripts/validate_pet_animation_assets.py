#!/usr/bin/env python3
"""Validate DeskPet approved animation frames for runtime stability.

This script is read-only. It reports canvas size, alpha bbox, bbox drift, and
estimated foot baseline consistency for the approved idle/walk runtime inputs.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image


EXPECTED_WALK_FRAMES = 16
MAX_BASELINE_DRIFT = 3
MAX_BBOX_HEIGHT_DRIFT = 6


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.convert("RGBA").getchannel("A")
    return alpha.getbbox()


def frame_metric(path: Path, index: int) -> dict[str, Any]:
    image = Image.open(path).convert("RGBA")
    bbox = alpha_bbox(image)
    metric: dict[str, Any] = {
        "frame_index": index,
        "path": str(path),
        "image_size": [image.width, image.height],
        "alpha_bbox": list(bbox) if bbox else None,
        "bbox_height": 0,
        "foot_baseline_estimate": None,
    }
    if bbox:
        metric["bbox_height"] = bbox[3] - bbox[1]
        metric["foot_baseline_estimate"] = bbox[3]
    return metric


def validate_clip(clip_dir: Path, expected_count: int) -> dict[str, Any]:
    paths = sorted(clip_dir.glob("*.png"))
    metrics = [frame_metric(path, index) for index, path in enumerate(paths)]
    sizes = sorted({tuple(metric["image_size"]) for metric in metrics})
    baselines = [
        metric["foot_baseline_estimate"]
        for metric in metrics
        if metric["foot_baseline_estimate"] is not None
    ]
    heights = [metric["bbox_height"] for metric in metrics if metric["bbox_height"]]
    failures: list[str] = []

    if len(paths) != expected_count:
        failures.append(f"frame count {len(paths)} != {expected_count}")
    if len(sizes) > 1:
        failures.append(f"inconsistent image size: {sizes}")
    if len(baselines) != len(paths):
        failures.append("one or more frames have empty alpha")

    baseline_drift = max(baselines) - min(baselines) if baselines else 0
    height_drift = max(heights) - min(heights) if heights else 0
    if baseline_drift > MAX_BASELINE_DRIFT:
        failures.append(f"foot baseline drift {baseline_drift}px > {MAX_BASELINE_DRIFT}px")
    if height_drift > MAX_BBOX_HEIGHT_DRIFT:
        failures.append(f"bbox height drift {height_drift}px > {MAX_BBOX_HEIGHT_DRIFT}px")

    return {
        "clip": clip_dir.name,
        "path": str(clip_dir),
        "frame_count": len(paths),
        "expected_frame_count": expected_count,
        "image_sizes": [list(size) for size in sizes],
        "baseline_drift": baseline_drift,
        "bbox_height_drift": height_drift,
        "frames": metrics,
        "passed": not failures,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate approved DeskPet animation assets.")
    parser.add_argument("--root", default=".", help="DeskPet package root.")
    parser.add_argument("--output", help="Optional JSON report path.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    approved = root / "Assets" / "CharacterV2" / "approved" / "clips"
    clips = {
        "walk_left": EXPECTED_WALK_FRAMES,
        "walk_right": EXPECTED_WALK_FRAMES,
    }
    report = {
        "approved_clips_root": str(approved),
        "max_baseline_drift": MAX_BASELINE_DRIFT,
        "max_bbox_height_drift": MAX_BBOX_HEIGHT_DRIFT,
        "clips": [],
    }

    for clip_id, expected_count in clips.items():
        clip_dir = approved / clip_id
        report["clips"].append(validate_clip(clip_dir, expected_count))

    report["passed"] = all(clip["passed"] for clip in report["clips"])
    data = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(data + "\n", encoding="utf-8")
    print(data)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
