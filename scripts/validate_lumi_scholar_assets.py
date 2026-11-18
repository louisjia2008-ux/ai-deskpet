#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops


EXPECTED_SIZE = (1536, 2288)
EXPECTED_GRID = (8, 11)
EXPECTED_CELL = (192, 208)
ALPHA_THRESHOLD = 8
LOOK_IDS = [
    "look_000",
    "look_022_5",
    "look_045",
    "look_067_5",
    "look_090",
    "look_112_5",
    "look_135",
    "look_157_5",
    "look_180",
    "look_202_5",
    "look_225",
    "look_247_5",
    "look_270",
    "look_292_5",
    "look_315",
    "look_337_5",
]
REQUIRED_CLIP_IDS = {
    "idle",
    "move_right",
    "move_left",
    "greet",
    "jump",
    "task_failed",
    "task_waiting",
    "task_running",
    "task_review",
}
CORE_STATES = {
    "idle",
    "blink",
    "idleLookAround",
    "startMoving",
    "stopMoving",
    "startMovingLeft",
    "startMovingRight",
    "stopMovingLeft",
    "stopMovingRight",
    "turnLeftToFront",
    "walkLeft",
    "walkRight",
    "briskWalkLeft",
    "briskWalkRight",
    "runLeft",
    "runRight",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    return image.convert("RGBA").getchannel("A").point(
        lambda value: 255 if value > ALPHA_THRESHOLD else 0
    ).getbbox()


def alpha_count(image: Image.Image) -> int:
    histogram = image.convert("RGBA").getchannel("A").histogram()
    return sum(histogram[ALPHA_THRESHOLD + 1:])


def diff_ratio(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a.convert("RGBA"), b.convert("RGBA")).convert("L")
    histogram = diff.histogram()
    weighted = sum(index * count for index, count in enumerate(histogram))
    return weighted / max(1, diff.width * diff.height * 255)


def frame_metric(path: Path) -> dict[str, Any]:
    image = Image.open(path).convert("RGBA")
    bbox = alpha_bbox(image)
    metric: dict[str, Any] = {
        "path": str(path),
        "mode": image.mode,
        "canvas": [image.width, image.height],
        "alpha_pixel_count": alpha_count(image),
        "alpha_bbox": list(bbox) if bbox else None,
        "visible_width": 0,
        "visible_height": 0,
        "foot_bottom_y": None,
        "center_x": None,
    }
    if bbox:
        left, top, right, bottom = bbox
        metric["visible_width"] = right - left
        metric["visible_height"] = bottom - top
        metric["foot_bottom_y"] = bottom - 1
        metric["center_x"] = round((left + right) / 2, 3)
    return metric


def summarize(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "frame_count": len(metrics),
        "canvas": metrics[0]["canvas"] if metrics else None,
    }
    for key in ["visible_height", "foot_bottom_y", "center_x", "alpha_pixel_count"]:
        values = [metric[key] for metric in metrics if metric[key] is not None]
        if values:
            summary[f"{key}_min"] = min(values)
            summary[f"{key}_max"] = max(values)
            summary[f"{key}_range"] = max(values) - min(values)
    return summary


def edge_alpha_counts(image: Image.Image) -> dict[str, int]:
    alpha = image.convert("RGBA").getchannel("A")
    width, height = alpha.size
    return {
        "top": sum(1 for value in [alpha.getpixel((x, 0)) for x in range(width)] if value > ALPHA_THRESHOLD),
        "bottom": sum(1 for value in [alpha.getpixel((x, height - 1)) for x in range(width)] if value > ALPHA_THRESHOLD),
        "left": sum(1 for value in [alpha.getpixel((0, y)) for y in range(height)] if value > ALPHA_THRESHOLD),
        "right": sum(1 for value in [alpha.getpixel((width - 1, y)) for y in range(height)] if value > ALPHA_THRESHOLD),
    }


def detect_pollution(path: Path) -> list[str]:
    failures: list[str] = []
    image = Image.open(path).convert("RGBA")
    if image.size != EXPECTED_CELL:
        failures.append("canvas is not the full 192x208 cell")
        return failures
    counts = edge_alpha_counts(image)
    if any(value > 0 for value in counts.values()):
        failures.append(f"visible pixels touch canvas edge: {counts}")

    alpha = image.getchannel("A")
    corners = [
        alpha.crop((0, 0, 16, 16)),
        alpha.crop((image.width - 16, 0, image.width, 16)),
        alpha.crop((0, image.height - 16, 16, image.height)),
        alpha.crop((image.width - 16, image.height - 16, image.width, image.height)),
    ]
    corner_visible = sum(sum(tile.histogram()[ALPHA_THRESHOLD + 1:]) for tile in corners)
    if corner_visible > 0:
        failures.append("opaque corner pixels suggest checkerboard/background contamination")

    dark_opaque = 0
    opaque = 0
    pixels = image.load()
    for y in range(24):
        for x in range(image.width):
            red, green, blue, alpha_value = pixels[x, y]
            if alpha_value > 220:
                opaque += 1
                if red < 40 and green < 40 and blue < 40:
                    dark_opaque += 1
    if opaque > image.width * 8 and dark_opaque / max(1, opaque) > 0.75:
        failures.append("dark opaque title/header band detected")

    red_green_border = 0
    border_points: list[tuple[int, int]] = []
    for x in range(image.width):
        border_points.append((x, 0))
        border_points.append((x, 1))
        border_points.append((x, image.height - 2))
        border_points.append((x, image.height - 1))
    for y in range(image.height):
        border_points.append((0, y))
        border_points.append((1, y))
        border_points.append((image.width - 2, y))
        border_points.append((image.width - 1, y))
    for x, y in border_points:
        red, green, blue, alpha_value = pixels[x, y]
        if alpha_value > 180 and ((red > 180 and green < 80 and blue < 80) or (green > 180 and red < 80 and blue < 80)):
            red_green_border += 1
    if red_green_border > 8:
        failures.append("red/green review border detected")

    return failures


def resolve_frame(root: Path, clip: dict[str, Any], frame_id: str) -> Path:
    return root / "Assets/LumiScholar/approved/clips" / clip["id"] / f"{frame_id}.png"


def validate_bundle(bundle_root: Path) -> dict[str, Any]:
    manifest = bundle_root / "LumiScholar/approved/clips/lumi_scholar_manifest.json"
    character_v2 = bundle_root / "CharacterV2/manifests/character_v2_manifest.json"
    return {
        "bundle_root": str(bundle_root),
        "checked": bundle_root.exists(),
        "lumi_manifest_exists": manifest.exists(),
        "character_v2_manifest_exists": character_v2.exists(),
        "passed": bundle_root.exists() and manifest.exists() and character_v2.exists(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Lumi Scholar imported runtime assets.")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    parser.add_argument("--bundle-root", type=Path)
    parser.add_argument("--output", default=Path("Assets/LumiScholar/qa/validation_report.json"), type=Path)
    args = parser.parse_args()

    root = args.root.resolve()
    source = root / "Assets/LumiScholar/source"
    stable_manifest_path = root / "Assets/LumiScholar/approved/lumi_scholar_manifest.json"
    manifest_path = root / "Assets/LumiScholar/approved/clips/lumi_scholar_manifest.json"
    import_report_path = root / "Assets/LumiScholar/qa/import_report.json"

    failures: list[str] = []
    warnings: list[str] = []
    if not stable_manifest_path.exists():
        failures.append("stable approved manifest is missing")
    elif stable_manifest_path.read_text(encoding="utf-8") != manifest_path.read_text(encoding="utf-8"):
        failures.append("stable approved manifest differs from runtime manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    import_report = json.loads(import_report_path.read_text(encoding="utf-8")) if import_report_path.exists() else {}

    pet_json = source / "pet.json"
    spritesheet = source / "spritesheet.webp"
    sheet = Image.open(spritesheet).convert("RGBA")
    if sheet.size != EXPECTED_SIZE:
        failures.append(f"source WebP dimensions {sheet.size} != {EXPECTED_SIZE}")
    if manifest.get("canvas", {}).get("spriteWidth") != EXPECTED_CELL[0] or manifest.get("canvas", {}).get("spriteHeight") != EXPECTED_CELL[1]:
        failures.append("manifest canvas does not match 192x208")
    if manifest.get("canvas", {}).get("columns") != EXPECTED_GRID[0] or manifest.get("canvas", {}).get("rows") != EXPECTED_GRID[1]:
        failures.append("manifest grid does not match 8x11")

    provenance = manifest.get("provenance", {})
    source_hashes = {
        "pet_json_sha256": sha256(pet_json),
        "spritesheet_webp_sha256": sha256(spritesheet),
    }
    if provenance.get("petJSONSHA256") != source_hashes["pet_json_sha256"]:
        failures.append("manifest pet JSON hash does not match copied source")
    if provenance.get("spritesheetSHA256") != source_hashes["spritesheet_webp_sha256"]:
        failures.append("manifest spritesheet hash does not match copied source")

    clips = manifest.get("clips", [])
    clip_ids = [clip.get("id") for clip in clips]
    states = [clip.get("state") for clip in clips]
    if len(clip_ids) != len(set(clip_ids)):
        failures.append("clip ids are not unique")
    if len(states) != len(set(states)):
        failures.append("state names are not unique")
    missing_required = sorted(REQUIRED_CLIP_IDS - set(clip_ids))
    if missing_required:
        failures.append(f"missing required Lumi clips: {missing_required}")
    missing_core_states = sorted(CORE_STATES - set(states))
    if missing_core_states:
        failures.append(f"missing Character V2 compatible states: {missing_core_states}")
    if "move_right" == "task_running" or manifest.get("clips", [])[0].get("id") == "running":
        failures.append("movement and task running names are ambiguous")
    if "move_right" not in clip_ids or "task_running" not in clip_ids:
        failures.append("move_right/task_running clips missing")

    by_id = {clip["id"]: clip for clip in clips if "id" in clip}
    metrics_by_clip: dict[str, Any] = {}
    for clip in clips:
        clip_id = clip["id"]
        fallback = clip.get("fallback")
        if fallback and fallback.get("clipID") not in by_id:
            failures.append(f"{clip_id}: fallback target missing: {fallback.get('clipID')}")
        if clip.get("placeholder"):
            continue
        frame_metrics: list[dict[str, Any]] = []
        for frame_id in clip.get("frames", []):
            path = resolve_frame(root, clip, frame_id)
            if not path.exists():
                failures.append(f"{clip_id}: missing frame {path}")
                continue
            image = Image.open(path)
            if image.mode != "RGBA":
                failures.append(f"{clip_id}: {path.name} is {image.mode}, expected RGBA")
            if image.size != EXPECTED_CELL:
                failures.append(f"{clip_id}: {path.name} has canvas {image.size}, expected {EXPECTED_CELL}")
            pollution = detect_pollution(path)
            failures.extend(f"{clip_id}/{path.name}: {item}" for item in pollution)
            metric = frame_metric(path)
            if metric["alpha_pixel_count"] <= 0:
                failures.append(f"{clip_id}: {path.name} is empty")
            frame_metrics.append(metric)
        metrics_by_clip[clip_id] = {
            "summary": summarize(frame_metrics),
            "frames": frame_metrics,
        }
        if len({tuple(metric["canvas"]) for metric in frame_metrics}) > 1:
            failures.append(f"{clip_id}: inconsistent frame canvas sizes")
        if len(frame_metrics) > 1:
            images = [Image.open(resolve_frame(root, clip, frame_id)).convert("RGBA") for frame_id in clip.get("frames", [])]
            diffs = [diff_ratio(images[index], images[(index + 1) % len(images)]) for index in range(len(images))]
            metrics_by_clip[clip_id]["consecutive_diff_ratios"] = diffs

    look_from_manifest = [item.get("clipID") for item in manifest.get("lookDirections", [])]
    if look_from_manifest != LOOK_IDS:
        failures.append("lookDirections do not contain the expected 16 ordered poses")
    for clip_id in LOOK_IDS:
        clip = by_id.get(clip_id)
        if not clip:
            failures.append(f"missing look clip {clip_id}")
            continue
        if clip.get("loop"):
            failures.append(f"{clip_id}: look pose must not loop")
        if clip.get("frames") != ["frame_000"]:
            failures.append(f"{clip_id}: look pose must contain exactly frame_000")

    skipped = import_report.get("skipped_blank_cells", [])
    exported_count = import_report.get("alpha_validation", {}).get("exported_frame_count")
    if exported_count is not None and exported_count + len(skipped) != EXPECTED_GRID[0] * EXPECTED_GRID[1]:
        failures.append("empty grid cells were not accounted for deterministically")
    if not skipped:
        warnings.append("no skipped blank cells recorded")

    runtime_references = json.dumps({
        "clips": clips,
        "lookDirections": manifest.get("lookDirections", []),
    })
    forbidden_runtime_terms = ["contact_sheet", "lumi_scholar_runtime_review", ".gif", ".webp", "review/"]
    for term in forbidden_runtime_terms:
        if term in runtime_references:
            failures.append(f"runtime manifest references review/source artifact: {term}")

    bundle_report = None
    if args.bundle_root:
        bundle_root = args.bundle_root if args.bundle_root.is_absolute() else root / args.bundle_root
        bundle_report = validate_bundle(bundle_root)
        if not bundle_report["passed"]:
            failures.append("bundle resources are incomplete")

    report = {
        "status": "PASSED" if not failures else "FAILED",
        "source_hashes": source_hashes,
        "source_webp": {
            "path": str(spritesheet),
            "dimensions": list(sheet.size),
            "grid": list(EXPECTED_GRID),
            "cell": list(EXPECTED_CELL),
        },
        "manifest": {
            "stable_path": str(stable_manifest_path),
            "path": str(manifest_path),
            "character_id": manifest.get("character", {}).get("id"),
            "display_name": manifest.get("character", {}).get("displayName"),
            "clip_count": len(clips),
            "state_count": len(set(states)),
            "look_pose_count": len(look_from_manifest),
            "move_right_and_task_running_are_distinct": by_id.get("move_right", {}).get("state") != by_id.get("task_running", {}).get("state"),
        },
        "empty_grid_cells": skipped,
        "metrics_by_clip": metrics_by_clip,
        "bundle": bundle_report,
        "warnings": warnings,
        "failures": failures,
    }

    output = args.output if args.output.is_absolute() else root / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "report": str(output), "failure_count": len(failures)}, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
