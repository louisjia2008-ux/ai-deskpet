#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw


EXPECTED_SPRITE_VERSION = 2
EXPECTED_COLUMNS = 8
EXPECTED_ROWS = 11
CELL_WIDTH = 192
CELL_HEIGHT = 208
EXPECTED_SIZE = (EXPECTED_COLUMNS * CELL_WIDTH, EXPECTED_ROWS * CELL_HEIGHT)
ALPHA_THRESHOLD = 8


@dataclass(frozen=True)
class RowSpec:
    row: int
    source_name: str
    clip_id: str
    state: str
    category: str
    fps: float
    loop: bool
    direction: str | None = None
    speed_tier: str | None = None


PRIMARY_ROWS = [
    RowSpec(0, "idle", "idle", "idle", "idle", 5, True),
    RowSpec(1, "running-right", "move_right", "walkRight", "locomotion", 10, True, "right", "walk"),
    RowSpec(2, "running-left", "move_left", "walkLeft", "locomotion", 10, True, "left", "walk"),
    RowSpec(3, "waving", "greet", "greet", "agent_semantic", 7, False),
    RowSpec(4, "jumping", "jump", "jump", "agent_semantic", 9, False),
    RowSpec(5, "failed", "task_failed", "taskFailed", "agent_semantic", 6, False),
    RowSpec(6, "waiting", "task_waiting", "taskWaiting", "agent_semantic", 4, True),
    RowSpec(7, "running", "task_running", "taskRunning", "agent_semantic", 6, True),
    RowSpec(8, "review", "task_review", "taskReview", "agent_semantic", 4, True),
]

LOOK_ANGLES = [
    "000",
    "022_5",
    "045",
    "067_5",
    "090",
    "112_5",
    "135",
    "157_5",
    "180",
    "202_5",
    "225",
    "247_5",
    "270",
    "292_5",
    "315",
    "337_5",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    return image.convert("RGBA").getchannel("A").point(
        lambda value: 255 if value > ALPHA_THRESHOLD else 0
    ).getbbox()


def alpha_count(image: Image.Image) -> int:
    alpha = image.convert("RGBA").getchannel("A")
    histogram = alpha.histogram()
    return sum(histogram[ALPHA_THRESHOLD + 1:])


def is_blank(image: Image.Image) -> bool:
    return alpha_bbox(image) is None


def cell_bbox(row: int, column: int) -> tuple[int, int, int, int]:
    left = column * CELL_WIDTH
    top = row * CELL_HEIGHT
    return (left, top, left + CELL_WIDTH, top + CELL_HEIGHT)


def frame_id(index: int) -> str:
    return f"frame_{index:03d}"


def normalized_hitbox(metrics: list[dict[str, Any]]) -> dict[str, float]:
    boxes = [metric["alpha_bbox"] for metric in metrics if metric["alpha_bbox"] is not None]
    if not boxes:
        return {"x": 0.25, "y": 0.08, "width": 0.5, "height": 0.8}
    left = min(box[0] for box in boxes)
    top = min(box[1] for box in boxes)
    right = max(box[2] for box in boxes)
    bottom = max(box[3] for box in boxes)
    return {
        "x": round(left / CELL_WIDTH, 4),
        "y": round((CELL_HEIGHT - bottom) / CELL_HEIGHT, 4),
        "width": round((right - left) / CELL_WIDTH, 4),
        "height": round((bottom - top) / CELL_HEIGHT, 4),
    }


def metric_for_frame(path: Path, image: Image.Image, source_row: int, source_column: int) -> dict[str, Any]:
    bbox = alpha_bbox(image)
    count = alpha_count(image)
    metric: dict[str, Any] = {
        "path": str(path),
        "source_row": source_row,
        "source_column": source_column,
        "canvas": [image.width, image.height],
        "mode": image.mode,
        "alpha_pixel_count": count,
        "alpha_bbox": list(bbox) if bbox else None,
        "visible_width": 0,
        "visible_height": 0,
        "foot_bottom_y": None,
        "center_x": None,
    }
    if bbox:
        left, top, right, bottom = bbox
        metric.update(
            {
                "visible_width": right - left,
                "visible_height": bottom - top,
                "foot_bottom_y": bottom - 1,
                "center_x": round((left + right) / 2, 3),
            }
        )
    return metric


def summarize_metrics(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    values = {
        "visible_height": [m["visible_height"] for m in metrics if m["visible_height"]],
        "foot_bottom_y": [m["foot_bottom_y"] for m in metrics if m["foot_bottom_y"] is not None],
        "center_x": [m["center_x"] for m in metrics if m["center_x"] is not None],
        "alpha_pixel_count": [m["alpha_pixel_count"] for m in metrics],
    }
    summary: dict[str, Any] = {
        "frame_count": len(metrics),
        "canvas": [CELL_WIDTH, CELL_HEIGHT],
    }
    for key, data in values.items():
        if data:
            summary[f"{key}_min"] = min(data)
            summary[f"{key}_max"] = max(data)
            summary[f"{key}_range"] = max(data) - min(data)
    return summary


def export_row(sheet: Image.Image, spec: RowSpec, clips_root: Path) -> dict[str, Any]:
    clip_dir = clips_root / spec.clip_id
    clean_dir(clip_dir)
    frames: list[str] = []
    metrics: list[dict[str, Any]] = []
    skipped: list[dict[str, int]] = []

    for column in range(EXPECTED_COLUMNS):
        cell = sheet.crop(cell_bbox(spec.row, column)).convert("RGBA")
        if is_blank(cell):
            skipped.append({"row": spec.row, "column": column})
            continue
        name = frame_id(len(frames))
        out = clip_dir / f"{name}.png"
        cell.save(out, format="PNG", optimize=False, compress_level=9)
        frames.append(name)
        metrics.append(metric_for_frame(out, cell, spec.row, column))

    return {
        "source_row": spec.row,
        "source_name": spec.source_name,
        "clip_id": spec.clip_id,
        "frames": frames,
        "exported_files": [f"{name}.png" for name in frames],
        "skipped_blank_cells": skipped,
        "metrics": metrics,
        "summary": summarize_metrics(metrics),
    }


def export_look_poses(sheet: Image.Image, clips_root: Path) -> tuple[list[dict[str, Any]], list[dict[str, int]]]:
    exported: list[dict[str, Any]] = []
    skipped: list[dict[str, int]] = []
    for index, angle in enumerate(LOOK_ANGLES):
        row = 9 if index < EXPECTED_COLUMNS else 10
        column = index % EXPECTED_COLUMNS
        clip_id = f"look_{angle}"
        clip_dir = clips_root / clip_id
        clean_dir(clip_dir)
        cell = sheet.crop(cell_bbox(row, column)).convert("RGBA")
        if is_blank(cell):
            skipped.append({"row": row, "column": column, "angle": angle})
            continue
        out = clip_dir / "frame_000.png"
        cell.save(out, format="PNG", optimize=False, compress_level=9)
        metrics = [metric_for_frame(out, cell, row, column)]
        exported.append(
            {
                "source_row": row,
                "source_column": column,
                "angle": angle.replace("_", "."),
                "clip_id": clip_id,
                "frames": ["frame_000"],
                "exported_files": ["frame_000.png"],
                "metrics": metrics,
                "summary": summarize_metrics(metrics),
            }
        )
    return exported, skipped


def clip_definition(
    clip_id: str,
    state: str,
    category: str,
    fps: float,
    loop: bool,
    frames: list[str],
    metrics: list[dict[str, Any]],
    *,
    direction: str | None = None,
    speed_tier: str | None = None,
    placeholder: bool = False,
    asset_status: str = "approved",
    fallback: dict[str, str] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": clip_id,
        "state": state,
        "category": category,
        "fps": fps,
        "baseFps": fps,
        "minFps": fps,
        "maxFps": fps,
        "loop": loop,
        "placeholder": placeholder,
        "assetStatus": asset_status,
        "required": True,
        "minFrameCount": 1,
        "targetFrameCount": len(frames),
        "frames": frames,
        "pivot": {"x": 0.5, "y": 0.08},
        "hitbox": normalized_hitbox(metrics),
        "shadow": {"width": 0.64, "height": 0.09, "alpha": 0.24},
        "events": [],
        "footContacts": [],
        "fallback": fallback,
    }
    if direction:
        data["direction"] = direction
    if speed_tier:
        data["speedTier"] = speed_tier
    if speed_tier in {"walk", "briskWalk", "run"}:
        data["speedRange"] = {"min": 35, "max": 150}
        data["minFps"] = max(1, round(fps * 0.8, 3))
        data["maxFps"] = round(fps * 1.25, 3)
    if clip_id == "task_failed" and frames:
        data["events"] = [{"frame": len(frames) - 1, "type": "hold_final_briefly"}]
    if notes:
        data["notes"] = notes
    return data


def placeholder_alias(
    clip_id: str,
    state: str,
    fallback_id: str,
    *,
    category: str,
    direction: str | None = None,
    speed_tier: str | None = None,
    fps: float = 10,
    loop: bool = False,
    mode: str = "TEMP_LOCOMOTION_ALIAS_FALLBACK",
    notes: str,
) -> dict[str, Any]:
    metrics = [
        {
            "alpha_bbox": [48, 24, 144, 198],
            "visible_height": 174,
            "foot_bottom_y": 197,
            "center_x": 96,
            "alpha_pixel_count": 1,
        }
    ]
    return clip_definition(
        clip_id,
        state,
        category,
        fps,
        loop,
        ["frame_000"],
        metrics,
        direction=direction,
        speed_tier=speed_tier,
        placeholder=True,
        asset_status="placeholder",
        fallback={"clipID": fallback_id, "mode": mode, "notes": notes},
        notes=notes,
    )


def build_manifest(
    pet: dict[str, Any],
    pet_hash: str,
    sheet_hash: str,
    row_reports: list[dict[str, Any]],
    look_reports: list[dict[str, Any]],
) -> dict[str, Any]:
    by_id = {report["clip_id"]: report for report in row_reports}
    clips: list[dict[str, Any]] = []

    for spec in PRIMARY_ROWS:
        report = by_id[spec.clip_id]
        clips.append(
            clip_definition(
                spec.clip_id,
                spec.state,
                spec.category,
                spec.fps,
                spec.loop,
                report["frames"],
                report["metrics"],
                direction=spec.direction,
                speed_tier=spec.speed_tier,
                notes=f"Imported from Codex Pet row {spec.row} ({spec.source_name}) with full {CELL_WIDTH}x{CELL_HEIGHT} canvas frames.",
            )
        )

    clips.extend(
        [
            placeholder_alias(
                "blink",
                "blink",
                "idle",
                category="idle",
                fps=12,
                mode="TEMP_IDLE_QUALITY_FALLBACK",
                notes="Lumi Scholar source sheet has no explicit blink row; runtime keeps procedural blink over idle fallback.",
            ),
            placeholder_alias(
                "idle_look_around",
                "idleLookAround",
                "look_000",
                category="look",
                fps=8,
                mode="TEMP_IDLE_QUALITY_FALLBACK",
                notes="Ambient look uses explicit look poses; default idle-look fallback points at look_000.",
            ),
            placeholder_alias(
                "start_move",
                "startMoving",
                "move_right",
                category="locomotion_transition",
                fps=10,
                notes="No authored directionless start clip exists; renderer crossfades into movement and aliases to move_right.",
            ),
            placeholder_alias(
                "stop_move",
                "stopMoving",
                "idle",
                category="locomotion_transition",
                fps=10,
                mode="TEMP_IDLE_QUALITY_FALLBACK",
                notes="No authored directionless stop clip exists; renderer crossfades back to idle.",
            ),
            placeholder_alias(
                "start_move_right",
                "startMovingRight",
                "move_right",
                category="locomotion_transition",
                direction="right",
                speed_tier="walk",
                fps=10,
                notes="No authored start_move_right frames; renderer crossfades idle to move_right without reversing run frames.",
            ),
            placeholder_alias(
                "start_move_left",
                "startMovingLeft",
                "move_left",
                category="locomotion_transition",
                direction="left",
                speed_tier="walk",
                fps=10,
                notes="No authored start_move_left frames; renderer crossfades idle to move_left without reversing run frames.",
            ),
            placeholder_alias(
                "stop_move_right",
                "stopMovingRight",
                "move_right",
                category="locomotion_transition",
                direction="right",
                fps=10,
                notes="No authored stop_move_right frames; renderer crossfades move_right to idle without reversing run frames.",
            ),
            placeholder_alias(
                "stop_move_left",
                "stopMovingLeft",
                "move_left",
                category="locomotion_transition",
                direction="left",
                fps=10,
                notes="No authored stop_move_left frames; renderer crossfades move_left to idle without reversing run frames.",
            ),
            placeholder_alias(
                "turn_left_to_front",
                "turnLeftToFront",
                "idle",
                category="locomotion_transition",
                direction="left",
                fps=8,
                mode="TEMP_IDLE_QUALITY_FALLBACK",
                notes="No authored turn-left-to-front frames; safe fallback returns to idle.",
            ),
            placeholder_alias(
                "move_right_brisk",
                "briskWalkRight",
                "move_right",
                category="locomotion",
                direction="right",
                speed_tier="briskWalk",
                fps=12,
                loop=True,
                notes="Brisk right movement aliases to the authored move_right loop.",
            ),
            placeholder_alias(
                "move_left_brisk",
                "briskWalkLeft",
                "move_left",
                category="locomotion",
                direction="left",
                speed_tier="briskWalk",
                fps=12,
                loop=True,
                notes="Brisk left movement aliases to the authored move_left loop.",
            ),
            placeholder_alias(
                "move_right_fast",
                "runRight",
                "move_right",
                category="locomotion",
                direction="right",
                speed_tier="run",
                fps=13,
                loop=True,
                notes="Fast right movement aliases to the authored move_right loop; distinct from task_running.",
            ),
            placeholder_alias(
                "move_left_fast",
                "runLeft",
                "move_left",
                category="locomotion",
                direction="left",
                speed_tier="run",
                fps=13,
                loop=True,
                notes="Fast left movement aliases to the authored move_left loop; distinct from task_running.",
            ),
        ]
    )

    for report in look_reports:
        clips.append(
            clip_definition(
                report["clip_id"],
                report["clip_id"],
                "look",
                1,
                False,
                report["frames"],
                report["metrics"],
                notes=f"Single-frame look pose at {report['angle']} degrees; no automatic loop.",
            )
        )

    return {
        "schemaVersion": 2,
        "manifestID": "deskpet_lumi_scholar_codex_pet_v2",
        "character": {
            "id": pet["id"],
            "displayName": pet["displayName"],
            "canonicalScale": f"codex_pet_sprite_v{pet['spriteVersionNumber']}_{CELL_WIDTH}x{CELL_HEIGHT}_full_canvas",
            "asymmetricFeatures": ["pink_bow", "book_charm", "pocket_watch_badge"],
            "runtimeFallback": "CharacterV2/manifests/character_v2_manifest.json",
        },
        "canvas": {
            "spriteWidth": CELL_WIDTH,
            "spriteHeight": CELL_HEIGHT,
            "columns": EXPECTED_COLUMNS,
            "rows": EXPECTED_ROWS,
            "anchor": {"x": 0.5, "y": 0.0},
            "baseline": "bottom_of_full_canvas",
        },
        "provenance": {
            "source": "Codex Pet Skill",
            "sourcePetJSON": "Assets/LumiScholar/source/pet.json",
            "sourceSpritesheet": "Assets/LumiScholar/source/spritesheet.webp",
            "petJSONSHA256": pet_hash,
            "spritesheetSHA256": sheet_hash,
            "spritesheetPathFromPetJSON": pet.get("spritesheetPath"),
            "spriteVersionNumber": pet.get("spriteVersionNumber"),
        },
        "pipeline": {
            "candidatePath": "DeskPet/Assets/LumiScholar/source",
            "reviewPath": "DeskPet/Assets/LumiScholar/review",
            "approvedPath": "DeskPet/Assets/LumiScholar/approved",
            "ruleSummary": [
                "source Codex Pet assets are copied before import and never modified in place",
                "runtime uses full-cell transparent PNG frames converted from the original WebP spritesheet",
                "contact sheets are review-only and are never referenced by runtime manifests",
                "Lumi Scholar is the preferred character; CharacterV2 remains the safe fallback",
            ],
        },
        "clips": clips,
        "lookDirections": [
            {"angleDegrees": float(angle.replace("_", ".")), "clipID": f"look_{angle}"}
            for angle in LOOK_ANGLES
        ],
        "habitat": {
            "id": "lumi_scholar_no_habitat",
            "placeholder": True,
            "style": "none",
            "anchor": {"x": 0.5, "y": 0.0},
            "hitbox": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            "resources": [],
            "notes": "Lumi Scholar import is character-only; existing DeskPet habitat behavior is unchanged.",
        },
    }


def make_checker(size: tuple[int, int], block: int = 16) -> Image.Image:
    image = Image.new("RGBA", size, (242, 246, 250, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], block):
        for x in range(0, size[0], block):
            if ((x // block) + (y // block)) % 2:
                draw.rectangle([x, y, x + block - 1, y + block - 1], fill=(218, 226, 235, 255))
    return image


def composite_for_preview(frame: Image.Image, scale: int = 2) -> Image.Image:
    bg = make_checker(frame.size)
    bg.alpha_composite(frame.convert("RGBA"))
    if scale != 1:
        bg = bg.resize((bg.width * scale, bg.height * scale), Image.Resampling.NEAREST)
    return bg.convert("P", palette=Image.Palette.ADAPTIVE)


def build_gif(clip_dir: Path, output: Path, fps: float) -> None:
    paths = sorted(clip_dir.glob("frame_*.png"))
    if not paths:
        return
    frames = [composite_for_preview(Image.open(path).convert("RGBA")) for path in paths]
    duration_ms = max(20, int(round(1000 / fps)))
    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=duration_ms,
        loop=0,
        disposal=2,
    )


def build_transition_gif(first: Path, second: Path, output: Path, duration_ms: int) -> None:
    a = Image.open(first).convert("RGBA")
    b = Image.open(second).convert("RGBA")
    frames = []
    steps = 6
    for index in range(steps):
        t = index / (steps - 1)
        blended = Image.blend(a, b, t)
        frames.append(composite_for_preview(blended))
    frames[0].save(
        output,
        save_all=True,
        append_images=frames[1:],
        duration=max(20, math.ceil(duration_ms / steps)),
        loop=0,
        disposal=2,
    )


def build_look_contact_sheet(clips_root: Path, output: Path) -> None:
    cell_w = CELL_WIDTH * 2
    cell_h = CELL_HEIGHT * 2
    label_h = 28
    sheet = Image.new("RGBA", (cell_w * 4, (cell_h + label_h) * 4), (255, 255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for index, angle in enumerate(LOOK_ANGLES):
        clip_id = f"look_{angle}"
        frame = Image.open(clips_root / clip_id / "frame_000.png").convert("RGBA")
        preview = make_checker(frame.size)
        preview.alpha_composite(frame)
        preview = preview.resize((cell_w, cell_h), Image.Resampling.NEAREST)
        x = (index % 4) * cell_w
        y = (index // 4) * (cell_h + label_h)
        sheet.alpha_composite(preview, (x, y))
        draw.text((x + 8, y + cell_h + 6), f"{clip_id} ({angle.replace('_', '.')})", fill=(20, 28, 36, 255))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", optimize=False, compress_level=9)


def build_review_package(root: Path, clips_root: Path, manifest_path: Path, import_report: Path) -> Path:
    review_dir = root / "Assets/LumiScholar/review/lumi_scholar_runtime_review"
    clean_dir(review_dir)
    for clip_id, fps in [
        ("idle", 5),
        ("move_left", 10),
        ("move_right", 10),
        ("greet", 7),
        ("jump", 9),
        ("task_waiting", 4),
        ("task_running", 6),
        ("task_review", 4),
        ("task_failed", 6),
    ]:
        build_gif(clips_root / clip_id, review_dir / f"{clip_id}.gif", fps)
    build_look_contact_sheet(clips_root, review_dir / "look_direction_contact_sheet.png")
    build_transition_gif(
        clips_root / "idle/frame_000.png",
        clips_root / "move_right/frame_000.png",
        review_dir / "transition_idle_to_move.gif",
        100,
    )
    build_transition_gif(
        clips_root / "move_right/frame_000.png",
        clips_root / "idle/frame_000.png",
        review_dir / "transition_move_to_idle.gif",
        120,
    )
    shutil.copy2(manifest_path, review_dir / "manifest_dump.json")
    shutil.copy2(import_report, review_dir / "import_report.json")
    return review_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import a Codex Pet spritesheet into DeskPet Character V2 assets.")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    parser.add_argument("--pet-json", default=Path("Assets/LumiScholar/source/pet.json"), type=Path)
    parser.add_argument("--spritesheet", default=None, type=Path)
    parser.add_argument("--review-package", action="store_true", help="Build review-only GIF/contact-sheet outputs.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    pet_json = args.pet_json if args.pet_json.is_absolute() else root / args.pet_json
    pet = json.loads(pet_json.read_text(encoding="utf-8"))

    if pet.get("spriteVersionNumber") != EXPECTED_SPRITE_VERSION:
        raise ValueError(f"spriteVersionNumber must be {EXPECTED_SPRITE_VERSION}")
    if pet.get("id") != "lumi-scholar":
        raise ValueError("this importer is scoped to lumi-scholar")

    spritesheet = args.spritesheet
    if spritesheet is None:
        spritesheet = pet_json.parent / pet["spritesheetPath"]
    elif not spritesheet.is_absolute():
        spritesheet = root / spritesheet

    sheet = Image.open(spritesheet).convert("RGBA")
    if sheet.size != EXPECTED_SIZE:
        raise ValueError(f"spritesheet size {sheet.size} != {EXPECTED_SIZE}")

    clips_root = root / "Assets/LumiScholar/approved/clips"
    clips_root.mkdir(parents=True, exist_ok=True)
    for spec in PRIMARY_ROWS:
        clean_dir(clips_root / spec.clip_id)
    for angle in LOOK_ANGLES:
        clean_dir(clips_root / f"look_{angle}")

    row_reports = [export_row(sheet, spec, clips_root) for spec in PRIMARY_ROWS]
    look_reports, skipped_looks = export_look_poses(sheet, clips_root)
    pet_hash = sha256(pet_json)
    sheet_hash = sha256(spritesheet)

    approved_root = root / "Assets/LumiScholar/approved"
    approved_root.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest(pet, pet_hash, sheet_hash, row_reports, look_reports)
    manifest_path = clips_root / "lumi_scholar_manifest.json"
    manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    manifest_path.write_text(manifest_json, encoding="utf-8")
    stable_manifest_path = approved_root / "lumi_scholar_manifest.json"
    stable_manifest_path.write_text(manifest_json, encoding="utf-8")

    qa_root = root / "Assets/LumiScholar/qa"
    qa_root.mkdir(parents=True, exist_ok=True)
    report_path = qa_root / "import_report.json"
    all_metrics = [metric for report in row_reports for metric in report["metrics"]]
    all_metrics.extend(metric for report in look_reports for metric in report["metrics"])
    report = {
        "status": "PASSED",
        "source_hashes": {
            "pet_json_sha256": pet_hash,
            "spritesheet_webp_sha256": sheet_hash,
        },
        "pet_metadata": pet,
        "image_dimensions": list(sheet.size),
        "grid": {"columns": EXPECTED_COLUMNS, "rows": EXPECTED_ROWS},
        "cell_dimensions": [CELL_WIDTH, CELL_HEIGHT],
        "row_frame_counts": {report["clip_id"]: len(report["frames"]) for report in row_reports},
        "look_pose_count": len(look_reports),
        "exported_files": {
            report["clip_id"]: report["exported_files"] for report in row_reports
        }
        | {report["clip_id"]: report["exported_files"] for report in look_reports},
        "skipped_blank_cells": [
            cell for report in row_reports for cell in report["skipped_blank_cells"]
        ]
        + skipped_looks,
        "alpha_validation": {
            "all_exported_frames_have_visible_alpha": all(metric["alpha_pixel_count"] > 0 for metric in all_metrics),
            "exported_frame_count": len(all_metrics),
            "empty_grid_cells_excluded": len(skipped_looks)
            + sum(len(report["skipped_blank_cells"]) for report in row_reports),
        },
        "bounding_box_statistics": {
            report["clip_id"]: report["summary"] for report in row_reports + look_reports
        },
        "manifest_path": str(manifest_path),
        "stable_manifest_path": str(stable_manifest_path),
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    review_dir = None
    if args.review_package:
        review_dir = build_review_package(root, clips_root, manifest_path, report_path)

    print(json.dumps({
        "status": "PASSED",
        "manifest": str(manifest_path),
        "stable_manifest": str(stable_manifest_path),
        "import_report": str(report_path),
        "review_dir": str(review_dir) if review_dir else None,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
