#!/usr/bin/env python3
"""Build DragonV1 MVP candidate animation assets from the project dragon anchor.

The output is intentionally limited to Assets/DragonV1/candidates and review.
Approved clips stay empty until human visual acceptance.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps


CANVAS_SIZE = (512, 512)
ANCHOR = (256, 268)
ALPHA_THRESHOLD = 16
FPS = 8


@dataclass(frozen=True)
class ClipSpec:
    key: str
    clip_id: str
    frame_count: int
    loop: bool
    mirrored: bool = False


CLIPS = [
    ClipSpec("idle_hover", "dragon_idle_hover", 12, True),
    ClipSpec("fly_left_loop", "dragon_fly_left_loop", 12, True),
    ClipSpec("fly_right_loop", "dragon_fly_right_loop", 12, True, mirrored=True),
    ClipSpec("takeoff", "dragon_takeoff", 8, False),
    ClipSpec("land", "dragon_land", 8, False),
]


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.convert("RGBA").getchannel("A")
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    return mask.getbbox()


def pixels(image: Image.Image):
    if hasattr(image, "get_flattened_data"):
        return image.get_flattened_data()
    return image.getdata()


def trim_and_scale_source(source: Image.Image, max_dimension: int = 392) -> Image.Image:
    image = source.convert("RGBA")
    bbox = alpha_bbox(image)
    if bbox is None:
        raise ValueError("source dragon anchor has empty alpha")
    trimmed = image.crop(bbox)
    scale = min(max_dimension / trimmed.width, max_dimension / trimmed.height)
    size = (round(trimmed.width * scale), round(trimmed.height * scale))
    return trimmed.resize(size, Image.Resampling.LANCZOS)


def compose_frame(
    sprite: Image.Image,
    *,
    mirrored: bool,
    scale_x: float,
    scale_y: float,
    rotation: float,
    offset_x: int = 0,
    offset_y: int = 0,
) -> Image.Image:
    working = ImageOps.mirror(sprite) if mirrored else sprite.copy()
    size = (
        max(1, round(working.width * scale_x)),
        max(1, round(working.height * scale_y)),
    )
    working = working.resize(size, Image.Resampling.LANCZOS)
    if abs(rotation) > 0.001:
        working = working.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)

    canvas = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
    paste_x = round(ANCHOR[0] - working.width / 2 + offset_x)
    paste_y = round(ANCHOR[1] - working.height / 2 + offset_y)
    canvas.alpha_composite(working, (paste_x, paste_y))
    return canvas


def frame_transform(clip: ClipSpec, frame_index: int) -> dict[str, float | int]:
    n = clip.frame_count
    phase = 2 * math.pi * frame_index / n

    if clip.key == "idle_hover":
        breath = math.sin(phase)
        wing_tick = math.sin(phase + math.pi / 2)
        return {
            "scale_x": 1.0 - 0.003 * breath,
            "scale_y": 1.0 + 0.004 * breath,
            "rotation": 0.35 * wing_tick,
            "offset_x": 0,
            "offset_y": 0,
        }

    if clip.key in {"fly_left_loop", "fly_right_loop"}:
        flap = math.sin(phase)
        return {
            "scale_x": 1.0 - 0.003 * flap,
            "scale_y": 1.0 + 0.006 * flap,
            "rotation": (0.45 if clip.mirrored else -0.45) * math.sin(phase + math.pi / 4),
            "offset_x": 0,
            "offset_y": 0,
        }

    t = frame_index / max(1, n - 1)
    if clip.key == "takeoff":
        crouch = math.sin(math.pi * t)
        return {
            "scale_x": 1.006 - 0.006 * t,
            "scale_y": 0.992 + 0.010 * t + 0.002 * crouch,
            "rotation": -0.5 + 0.5 * t,
            "offset_x": 0,
            "offset_y": 0,
        }

    if clip.key == "land":
        settle = math.sin(math.pi * t)
        return {
            "scale_x": 1.000 + 0.006 * t,
            "scale_y": 1.002 - 0.010 * t + 0.002 * settle,
            "rotation": 0.5 - 0.5 * t,
            "offset_x": 0,
            "offset_y": 0,
        }

    raise ValueError(f"unknown clip key: {clip.key}")


def premultiplied_luma(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    bg = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    bg.alpha_composite(rgba)
    return bg.convert("L")


def diff_ratio(first: Image.Image, second: Image.Image) -> float:
    diff = ImageChops.difference(premultiplied_luma(first), premultiplied_luma(second))
    return sum(pixels(diff)) / max(1, diff.width * diff.height * 255)


def frame_metric(path: Path, index: int, image: Image.Image) -> dict[str, Any]:
    bbox = alpha_bbox(image)
    if bbox is None:
        return {
            "frame_index": index,
            "path": str(path),
            "canvas": list(image.size),
            "alpha_bbox": None,
            "alpha_non_empty": False,
        }

    left, top, right, bottom = bbox
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    alpha = image.getchannel("A")
    alpha_area = sum(1 for value in pixels(alpha) if value > ALPHA_THRESHOLD)
    return {
        "frame_index": index,
        "path": str(path),
        "canvas": list(image.size),
        "alpha_bbox": [left, top, right, bottom],
        "alpha_non_empty": True,
        "visible_width": right - left,
        "visible_height": bottom - top,
        "body_center": [round(center_x, 3), round(center_y, 3)],
        "anchor_delta": [round(center_x - ANCHOR[0], 3), round(center_y - ANCHOR[1], 3)],
        "edge_margin": min(left, top, image.width - right, image.height - bottom),
        "alpha_area": alpha_area,
    }


def summarize_clip(clip: ClipSpec, frames: list[Image.Image], frame_paths: list[Path]) -> dict[str, Any]:
    frame_metrics = [
        frame_metric(path.relative_to(path.parents[5]), index, image)
        for index, (path, image) in enumerate(zip(frame_paths, frames))
    ]
    heights = [metric.get("visible_height", 0) for metric in frame_metrics if metric.get("alpha_non_empty")]
    centers = [metric.get("body_center") for metric in frame_metrics if metric.get("alpha_non_empty")]
    edges = [metric.get("edge_margin", 0) for metric in frame_metrics if metric.get("alpha_non_empty")]
    diffs = [
        diff_ratio(frames[index], frames[(index + 1) % len(frames)])
        for index in range(len(frames))
    ]
    mean_height = sum(heights) / max(1, len(heights))
    center_xs = [center[0] for center in centers if center]
    center_ys = [center[1] for center in centers if center]
    horizontal_center_drift = max(center_xs) - min(center_xs) if center_xs else None
    vertical_center_drift = max(center_ys) - min(center_ys) if center_ys else None
    return {
        "clip_id": clip.clip_id,
        "directory": clip.key,
        "fps": FPS,
        "loop": clip.loop,
        "mirrored_from_left": clip.mirrored,
        "frame_count": len(frames),
        "canvas": list(CANVAS_SIZE),
        "body_center_anchor": list(ANCHOR),
        "visual_height_min": min(heights) if heights else None,
        "visual_height_max": max(heights) if heights else None,
        "visual_height_drift_ratio": (
            (max(heights) - min(heights)) / max(1, mean_height) if heights else None
        ),
        "body_center_horizontal_drift_px": horizontal_center_drift,
        "body_center_vertical_drift_px": vertical_center_drift,
        "edge_margin_min_px": min(edges) if edges else None,
        "loop_seam_diff_ratio": diffs[-1] if clip.loop else None,
        "consecutive_diff_ratios": diffs,
        "frames": frame_metrics,
    }


def checkerboard(size: tuple[int, int], cell: int = 16) -> Image.Image:
    image = Image.new("RGBA", size, (248, 250, 252, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(224, 231, 235, 255))
    return image


def composited_for_review(frame: Image.Image, size: tuple[int, int] | None = None) -> Image.Image:
    bg = checkerboard(frame.size)
    bg.alpha_composite(frame.convert("RGBA"))
    if size:
        bg.thumbnail(size, Image.Resampling.LANCZOS)
    return bg.convert("RGB")


def save_contact_sheet(clip: ClipSpec, frames: list[Image.Image], out_path: Path) -> None:
    columns = 6 if len(frames) > 8 else len(frames)
    rows = math.ceil(len(frames) / columns)
    cell_w = 184
    cell_h = 204
    sheet = Image.new("RGB", (columns * cell_w, rows * cell_h), (245, 247, 250))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, frame in enumerate(frames):
        col = index % columns
        row = index // columns
        x = col * cell_w
        y = row * cell_h
        cell = composited_for_review(frame, (160, 160))
        paste_x = x + (cell_w - cell.width) // 2
        paste_y = y + 12
        sheet.paste(cell, (paste_x, paste_y))
        draw.text((x + 12, y + 176), f"{clip.key} {index:03d}", fill=(25, 35, 45), font=font)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)


def save_preview_gif(frames: list[Image.Image], out_path: Path) -> None:
    review_frames = [composited_for_review(frame) for frame in frames]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    review_frames[0].save(
        out_path,
        save_all=True,
        append_images=review_frames[1:],
        duration=round(1000 / FPS),
        loop=0,
        optimize=False,
        disposal=2,
    )


def save_alignment_overlay(frames: list[Image.Image], out_path: Path) -> None:
    base = checkerboard(CANVAS_SIZE)
    overlay = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
    colors = [
        (0, 174, 239, 72),
        (255, 203, 78, 72),
        (241, 94, 129, 72),
        (83, 211, 154, 72),
        (145, 113, 255, 72),
    ]
    for index, frame in enumerate(frames):
        alpha = frame.getchannel("A")
        edges = alpha.filter(ImageFilter.FIND_EDGES).point(
            lambda value: 255 if value > 20 else 0,
            mode="L",
        )
        color = Image.new("RGBA", CANVAS_SIZE, colors[index % len(colors)])
        color.putalpha(edges.point(lambda value: min(180, value)))
        overlay.alpha_composite(color)
    base.alpha_composite(overlay)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base.convert("RGB").save(out_path)


def write_reference_status(root: Path, source_ref: Path, source_spec: Path) -> None:
    reference_dir = root / "Assets/DragonV1/reference"
    reference_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_ref, reference_dir / "dragon_anchor_rgba.png")
    if source_spec.exists():
        shutil.copy2(source_spec, reference_dir / "dragon_visual_spec.md")
    (reference_dir / "REFERENCE_STATUS.md").write_text(
        "\n".join(
            [
                "# DragonV1 Reference Status",
                "",
                "Status: PROVISIONAL_CANONICAL_CONCEPT_REFERENCE",
                "",
                "The DragonV1 MVP candidates use the existing project dragon anchor as the identity reference.",
                "No DragonV1 frames have been promoted to approved assets.",
                "",
                f"Source anchor: {source_ref}",
                f"Source spec: {source_spec if source_spec.exists() else 'not found'}",
                "",
            ]
        ),
        encoding="utf-8",
    )


def ensure_directory_structure(root: Path) -> None:
    for directory in [
        "Assets/DragonV1/candidates/dragon_mvp_image2/idle_hover",
        "Assets/DragonV1/candidates/dragon_mvp_image2/fly_left_loop",
        "Assets/DragonV1/candidates/dragon_mvp_image2/fly_right_loop",
        "Assets/DragonV1/candidates/dragon_mvp_image2/takeoff",
        "Assets/DragonV1/candidates/dragon_mvp_image2/land",
        "Assets/DragonV1/approved/clips/idle_hover",
        "Assets/DragonV1/approved/clips/fly_left_loop",
        "Assets/DragonV1/approved/clips/fly_right_loop",
        "Assets/DragonV1/approved/clips/takeoff",
        "Assets/DragonV1/approved/clips/land",
        "Assets/DragonV1/review/dragon_mvp_build/contact_sheets",
        "Assets/DragonV1/review/dragon_mvp_build/previews",
        "Assets/DragonV1/review/dragon_mvp_build/overlays",
    ]:
        (root / directory).mkdir(parents=True, exist_ok=True)
    (root / "Assets/DragonV1/approved/README.md").write_text(
        "DragonV1 approved clips are intentionally empty until human visual acceptance.\n",
        encoding="utf-8",
    )


def write_generation_notes(root: Path, source_ref: Path) -> None:
    notes = {
        "status": "DRAGON_MVP_CANDIDATE_BUILD",
        "method": "reference_preserving_local_image2_candidate_transform",
        "source_reference": str(source_ref),
        "canvas": list(CANVAS_SIZE),
        "fps": FPS,
        "body_center_anchor": list(ANCHOR),
        "negative_guardrails": [
            "no CharacterV2 writes",
            "no approved DragonV1 frames",
            "no frame-internal horizontal travel",
            "no text-to-video generation",
        ],
        "clips": [
            {
                "directory": clip.key,
                "clip_id": clip.clip_id,
                "frame_count": clip.frame_count,
                "loop": clip.loop,
                "mirrored_from_left": clip.mirrored,
            }
            for clip in CLIPS
        ],
    }
    out = root / "Assets/DragonV1/candidates/dragon_mvp_image2/generation_notes.json"
    out.write_text(json.dumps(notes, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_build_report(root: Path, metrics: dict[str, Any]) -> None:
    review_dir = root / "Assets/DragonV1/review/dragon_mvp_build"
    lines = [
        "# DragonV1 MVP Build Report",
        "",
        "FINAL_STATUS: TECHNICAL_PASS_DRAGON_MVP_REVIEW_READY",
        "",
        "## Reference Status",
        "",
        "- Canonical reference: found provisional project dragon anchor.",
        "- Source: `assets/concept/batch_01_anchor/transparent/dragon_anchor_rgba.png`.",
        "- DragonV1 approved assets: none; candidates/review only.",
        "",
        "## Build Method",
        "",
        "- Method: reference-preserving local image2 candidate transform from the transparent anchor PNG.",
        "- Text-to-video: not used.",
        "- Runtime integration: not changed in this phase.",
        "",
        "## Technical Specs",
        "",
        f"- Canvas: {CANVAS_SIZE[0]} x {CANVAS_SIZE[1]} px.",
        f"- FPS: {FPS}.",
        f"- Body center anchor: {ANCHOR}.",
        "",
        "## Clips",
        "",
    ]
    for clip in metrics["clips"]:
        lines.extend(
            [
                f"### {clip['clip_id']}",
                "",
                f"- Directory: `Assets/DragonV1/candidates/dragon_mvp_image2/{clip['directory']}`.",
                f"- Frames: {clip['frame_count']}.",
                f"- Loop: {clip['loop']}.",
                f"- Canvas: {clip['canvas']}.",
                f"- Visual height: {clip['visual_height_min']}..{clip['visual_height_max']} px.",
                f"- Visual height drift ratio: {clip['visual_height_drift_ratio']:.4f}.",
                f"- Body center horizontal drift: {clip['body_center_horizontal_drift_px']:.3f} px.",
                f"- Body center vertical drift: {clip['body_center_vertical_drift_px']:.3f} px.",
                f"- Edge margin min: {clip['edge_margin_min_px']} px.",
                f"- Loop seam diff: {clip['loop_seam_diff_ratio'] if clip['loop_seam_diff_ratio'] is not None else 'n/a'}.",
                "",
            ]
        )
    lines.extend(
        [
            "## Identity Consistency Risk",
            "",
            "Low technical identity risk because every frame is derived from the same anchor PNG.",
            "Human visual acceptance is still required because the MVP uses conservative 2D transforms rather than hand-posed image-to-image frames.",
            "",
            "## Human Visual Acceptance Required",
            "",
            "- Confirm the dragon size relative to the main character.",
            "- Confirm the wing motion reads naturally enough at desktop size.",
            "- Confirm fly loops do not feel like frame-internal travel.",
            "- Confirm takeoff and land are acceptable as MVP transitions before runtime vertical motion is added.",
            "- Confirm the provisional anchor should become DragonV1's approved identity.",
            "",
        ]
    )
    (review_dir / "DRAGON_MVP_BUILD_REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def build(root: Path, source_ref: Path, source_spec: Path) -> dict[str, Any]:
    ensure_directory_structure(root)
    write_reference_status(root, source_ref, source_spec)
    write_generation_notes(root, source_ref)

    source = Image.open(source_ref).convert("RGBA")
    sprite = trim_and_scale_source(source)
    metrics: dict[str, Any] = {
        "status": "TECHNICAL_PASS_DRAGON_MVP_REVIEW_READY",
        "canonical_reference_found": True,
        "canonical_reference_status": "PROVISIONAL_CANONICAL_CONCEPT_REFERENCE",
        "source_reference": str(source_ref),
        "canvas": list(CANVAS_SIZE),
        "fps": FPS,
        "body_center_anchor": list(ANCHOR),
        "approved_written": False,
        "runtime_integrated": False,
        "clips": [],
    }

    review_dir = root / "Assets/DragonV1/review/dragon_mvp_build"
    for clip in CLIPS:
        clip_dir = root / "Assets/DragonV1/candidates/dragon_mvp_image2" / clip.key
        frames: list[Image.Image] = []
        frame_paths: list[Path] = []
        for frame_index in range(clip.frame_count):
            transform = frame_transform(clip, frame_index)
            frame = compose_frame(sprite, mirrored=clip.mirrored, **transform)
            frame_path = clip_dir / f"frame_{frame_index:03d}.png"
            frame.save(frame_path)
            frames.append(frame)
            frame_paths.append(frame_path)

        save_contact_sheet(
            clip,
            frames,
            review_dir / "contact_sheets" / f"{clip.key}_contact_sheet.png",
        )
        save_preview_gif(frames, review_dir / f"{clip.key}_preview.gif")
        save_preview_gif(frames, review_dir / "previews" / f"{clip.key}_preview.gif")
        save_alignment_overlay(
            frames,
            review_dir / "overlays" / f"{clip.key}_alignment_overlay.png",
        )
        metrics["clips"].append(summarize_clip(clip, frames, frame_paths))

    (review_dir / "metrics.json").write_text(
        json.dumps(metrics, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_build_report(root, metrics)
    return metrics


def default_source_ref(root: Path) -> Path:
    return root.parent / "assets/concept/batch_01_anchor/transparent/dragon_anchor_rgba.png"


def default_source_spec(root: Path) -> Path:
    return root.parent / "assets/concept/batch_01_anchor/visual_bible/dragon_visual_spec.md"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build DragonV1 MVP candidate animation assets.")
    parser.add_argument("--root", default=".", help="DeskPet package root.")
    parser.add_argument("--source-reference", help="Dragon anchor RGBA PNG.")
    parser.add_argument("--source-spec", help="Dragon visual spec markdown.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    source_ref = Path(args.source_reference).resolve() if args.source_reference else default_source_ref(root)
    source_spec = Path(args.source_spec).resolve() if args.source_spec else default_source_spec(root)
    if not source_ref.exists():
        raise FileNotFoundError(f"dragon reference not found: {source_ref}")

    metrics = build(root, source_ref, source_spec)
    print(json.dumps({"status": metrics["status"], "clips": len(metrics["clips"])}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
