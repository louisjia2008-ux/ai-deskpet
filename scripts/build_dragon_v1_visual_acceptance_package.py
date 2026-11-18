#!/usr/bin/env python3
"""Build a human visual acceptance package for DragonV1 review assets.

This script is review-only. It reads DragonV1 candidates and CharacterV2
approved reference frames, then writes a timestamped package under
Assets/DragonV1/review. It never writes DragonV1 approved assets.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFont


FPS = 8
ALPHA_THRESHOLD = 16
DRAGON_ANCHOR = (256, 268)
PROPOSED_RUNTIME_RATIO = 0.35


@dataclass(frozen=True)
class ClipSpec:
    key: str
    clip_id: str
    frames: int
    loop: bool


CLIPS = [
    ClipSpec("idle_hover", "dragon_idle_hover", 12, True),
    ClipSpec("fly_left_loop", "dragon_fly_left_loop", 12, True),
    ClipSpec("fly_right_loop", "dragon_fly_right_loop", 12, True),
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


def diff_ratio(first: Image.Image, second: Image.Image) -> float:
    diff = ImageChops.difference(first.convert("RGBA"), second.convert("RGBA")).convert("L")
    return sum(pixels(diff)) / max(1, diff.width * diff.height * 255)


def checkerboard(size: tuple[int, int], cell: int = 16) -> Image.Image:
    image = Image.new("RGBA", size, (248, 250, 252, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(224, 231, 235, 255))
    return image


def composite_on_checker(frame: Image.Image) -> Image.Image:
    base = checkerboard(frame.size)
    base.alpha_composite(frame.convert("RGBA"))
    return base.convert("RGB")


def load_clip_frames(root: Path, clip: ClipSpec) -> list[Image.Image]:
    clip_dir = root / "Assets/DragonV1/candidates/dragon_mvp_image2" / clip.key
    frames: list[Image.Image] = []
    for index in range(clip.frames):
        path = clip_dir / f"frame_{index:03d}.png"
        if not path.exists():
            raise FileNotFoundError(f"missing DragonV1 frame: {path}")
        frames.append(Image.open(path).convert("RGBA"))
    return frames


def metric_for_frame(frame: Image.Image, index: int) -> dict[str, Any]:
    bbox = alpha_bbox(frame)
    payload: dict[str, Any] = {
        "frame_index": index,
        "canvas": [frame.width, frame.height],
        "alpha_bbox": list(bbox) if bbox else None,
        "alpha_non_empty": bbox is not None,
    }
    if bbox is None:
        return payload
    left, top, right, bottom = bbox
    center = ((left + right) / 2, (top + bottom) / 2)
    payload.update(
        {
            "bbox_width": right - left,
            "bbox_height": bottom - top,
            "center": [round(center[0], 3), round(center[1], 3)],
            "anchor_delta": [
                round(center[0] - DRAGON_ANCHOR[0], 3),
                round(center[1] - DRAGON_ANCHOR[1], 3),
            ],
            "alpha_edge_margin": min(left, top, frame.width - right, frame.height - bottom),
        }
    )
    return payload


def summarize_clip(clip: ClipSpec, frames: list[Image.Image]) -> dict[str, Any]:
    frame_metrics = [metric_for_frame(frame, index) for index, frame in enumerate(frames)]
    valid = [metric for metric in frame_metrics if metric["alpha_non_empty"]]
    widths = [metric["bbox_width"] for metric in valid]
    heights = [metric["bbox_height"] for metric in valid]
    centers_x = [metric["center"][0] for metric in valid]
    centers_y = [metric["center"][1] for metric in valid]
    margins = [metric["alpha_edge_margin"] for metric in valid]
    seam = diff_ratio(frames[-1], frames[0]) if clip.loop and frames else None
    suspected_risks: list[str] = []
    height_drift = ((max(heights) - min(heights)) / max(1, mean(heights))) if heights else 0
    center_drift = {
        "x": max(centers_x) - min(centers_x) if centers_x else 0,
        "y": max(centers_y) - min(centers_y) if centers_y else 0,
    }
    if seam is not None and seam > 0.03:
        suspected_risks.append("METRIC_ONLY: loop seam score is elevated; check for visible hitch.")
    if center_drift["x"] > 1.5 or center_drift["y"] > 1.5:
        suspected_risks.append("METRIC_ONLY: center drift may read as micro-wobble.")
    if height_drift > 0.02:
        suspected_risks.append("METRIC_ONLY: visual height drift may read as scale pulsing.")
    if margins and min(margins) < 12:
        suspected_risks.append("METRIC_ONLY: edge margin is tight; check for cropping.")
    if not suspected_risks:
        suspected_risks.append("METRIC_ONLY: no metric-threshold risk flagged; human review still required.")

    return {
        "clip_name": clip.clip_id,
        "clip_key": clip.key,
        "frame_count": len(frames),
        "fps": FPS,
        "canvas_size": list(frames[0].size) if frames else None,
        "bbox": {
            "width_min": min(widths) if widths else None,
            "width_max": max(widths) if widths else None,
            "width_mean": round(mean(widths), 3) if widths else None,
            "height_min": min(heights) if heights else None,
            "height_max": max(heights) if heights else None,
            "height_mean": round(mean(heights), 3) if heights else None,
        },
        "visual_height_drift": round(height_drift, 6),
        "center_drift": {
            "x_px": round(center_drift["x"], 3),
            "y_px": round(center_drift["y"], 3),
        },
        "anchor_position": list(DRAGON_ANCHOR),
        "alpha_edge_margin": {
            "min_px": min(margins) if margins else None,
            "max_px": max(margins) if margins else None,
            "mean_px": round(mean(margins), 3) if margins else None,
        },
        "loop_seam_score": round(seam, 6) if seam is not None else None,
        "suspected_visual_risks_metric_only": suspected_risks,
        "frames": frame_metrics,
    }


def save_transparent_gif(frames: list[Image.Image], path: Path, repeats: int = 1) -> None:
    sequence = frames * repeats
    path.parent.mkdir(parents=True, exist_ok=True)
    sequence[0].save(
        path,
        save_all=True,
        append_images=sequence[1:],
        duration=round(1000 / FPS),
        loop=0,
        disposal=2,
        transparency=0,
    )


def save_checker_gif(frames: list[Image.Image], path: Path, repeats: int = 1) -> None:
    sequence = [composite_on_checker(frame) for frame in frames * repeats]
    path.parent.mkdir(parents=True, exist_ok=True)
    sequence[0].save(
        path,
        save_all=True,
        append_images=sequence[1:],
        duration=round(1000 / FPS),
        loop=0,
        disposal=2,
    )


def save_checker_mp4(frames: list[Image.Image], path: Path, work_dir: Path, repeats: int = 1) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return False
    frame_dir = work_dir / path.stem
    frame_dir.mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(frames * repeats):
        composite_on_checker(frame).save(frame_dir / f"frame_{index:03d}.png")
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        str(FPS),
        "-i",
        str(frame_dir / "frame_%03d.png"),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(path),
    ]
    subprocess.run(command, check=True)
    return True


def draw_fit(
    canvas: Image.Image,
    image: Image.Image,
    rect: tuple[int, int, int, int],
    *,
    bbox: tuple[int, int, int, int] | None = None,
    anchor: tuple[int, int] | None = None,
) -> tuple[float, int, int]:
    x, y, w, h = rect
    working = image.convert("RGBA")
    scale = min(w / working.width, h / working.height)
    size = (round(working.width * scale), round(working.height * scale))
    fitted = working.resize(size, Image.Resampling.LANCZOS)
    px = x + (w - size[0]) // 2
    py = y + (h - size[1]) // 2
    canvas.alpha_composite(fitted, (px, py))

    draw = ImageDraw.Draw(canvas)
    draw.rectangle([px, py, px + size[0], py + size[1]], outline=(44, 62, 80, 170), width=1)
    if bbox:
        bx0, by0, bx1, by1 = bbox
        box = [
            px + round(bx0 * scale),
            py + round(by0 * scale),
            px + round(bx1 * scale),
            py + round(by1 * scale),
        ]
        draw.rectangle(box, outline=(241, 94, 129, 220), width=2)
    if anchor:
        ax = px + round(anchor[0] * scale)
        ay = py + round(anchor[1] * scale)
        draw.line([ax - 6, ay, ax + 6, ay], fill=(0, 174, 239, 240), width=2)
        draw.line([ax, ay - 6, ax, ay + 6], fill=(0, 174, 239, 240), width=2)
    return scale, px, py


def draw_label(draw: ImageDraw.ImageDraw, pos: tuple[int, int], text: str, font: ImageFont.ImageFont) -> None:
    x, y = pos
    bbox = draw.multiline_textbbox((x, y), text, font=font, spacing=3)
    draw.rectangle([bbox[0] - 5, bbox[1] - 4, bbox[2] + 5, bbox[3] + 4], fill=(255, 255, 255, 235))
    draw.multiline_text((x, y), text, fill=(20, 31, 44, 255), font=font, spacing=3)


def save_contact_sheet(clip: ClipSpec, frames: list[Image.Image], metrics: dict[str, Any], path: Path) -> None:
    columns = 4
    cell_w = 310
    cell_h = 320
    rows = math.ceil(len(frames) / columns)
    sheet = Image.new("RGBA", (columns * cell_w, rows * cell_h), (245, 247, 250, 255))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, frame in enumerate(frames):
        col = index % columns
        row = index // columns
        origin_x = col * cell_w
        origin_y = row * cell_h
        panel = checkerboard((240, 240))
        fitted = frame.copy()
        fitted.thumbnail((220, 220), Image.Resampling.LANCZOS)
        px = (240 - fitted.width) // 2
        py = (240 - fitted.height) // 2
        panel.alpha_composite(fitted, (px, py))

        frame_metric = metrics["frames"][index]
        bbox = alpha_bbox(frame)
        scale_x = fitted.width / frame.width
        scale_y = fitted.height / frame.height
        panel_draw = ImageDraw.Draw(panel)
        panel_draw.rectangle([0, 0, 239, 239], outline=(44, 62, 80, 180), width=1)
        if bbox:
            box = [
                px + round(bbox[0] * scale_x),
                py + round(bbox[1] * scale_y),
                px + round(bbox[2] * scale_x),
                py + round(bbox[3] * scale_y),
            ]
            panel_draw.rectangle(box, outline=(241, 94, 129, 230), width=2)
        anchor_x = px + round(DRAGON_ANCHOR[0] * scale_x)
        anchor_y = py + round(DRAGON_ANCHOR[1] * scale_y)
        panel_draw.line([anchor_x - 6, anchor_y, anchor_x + 6, anchor_y], fill=(0, 174, 239, 255), width=2)
        panel_draw.line([anchor_x, anchor_y - 6, anchor_x, anchor_y + 6], fill=(0, 174, 239, 255), width=2)

        sheet.alpha_composite(panel, (origin_x + 35, origin_y + 8))
        text = (
            f"frame_{index:03d}\n"
            f"canvas {frame.width}x{frame.height}\n"
            f"bbox {frame_metric['alpha_bbox']}\n"
            f"center {frame_metric.get('center')}\n"
            f"anchor {DRAGON_ANCHOR}"
        )
        draw.multiline_text((origin_x + 12, origin_y + 254), text, fill=(20, 31, 44, 255), font=font, spacing=3)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(path)


def scaled_to_height(image: Image.Image, target_height: int) -> Image.Image:
    bbox = alpha_bbox(image)
    if bbox is None:
        return image.copy()
    visual_height = bbox[3] - bbox[1]
    scale = target_height / visual_height
    return image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)


def visual_height(image: Image.Image) -> int:
    bbox = alpha_bbox(image)
    return 0 if bbox is None else bbox[3] - bbox[1]


def paste_trimmed(canvas: Image.Image, image: Image.Image, xy: tuple[int, int]) -> tuple[int, int, int, int] | None:
    bbox = alpha_bbox(image)
    if bbox is None:
        return None
    trimmed = image.crop(bbox)
    canvas.alpha_composite(trimmed, xy)
    x, y = xy
    return (x, y, x + trimmed.width, y + trimmed.height)


def comparison_panel(
    title: str,
    items: list[tuple[str, Image.Image]],
    path: Path,
    *,
    scale_to_same_height: bool = False,
) -> None:
    font = ImageFont.load_default()
    display_items = items
    if scale_to_same_height:
        heights = [visual_height(image) for _, image in items if visual_height(image) > 0]
        target = min(heights) if heights else 220
        display_items = [(label, scaled_to_height(image, target)) for label, image in items]
    width = max(720, len(display_items) * 330)
    height = 420
    canvas = Image.new("RGBA", (width, height), (245, 247, 250, 255))
    draw = ImageDraw.Draw(canvas)
    draw.text((18, 16), title, fill=(20, 31, 44, 255), font=font)
    for index, (label, image) in enumerate(display_items):
        x = 24 + index * 320
        y = 52
        panel = checkerboard((280, 260))
        working = image.copy()
        working.thumbnail((250, 230), Image.Resampling.LANCZOS)
        px = (280 - working.width) // 2
        py = (260 - working.height) // 2
        panel.alpha_composite(working, (px, py))
        bbox = alpha_bbox(working)
        panel_draw = ImageDraw.Draw(panel)
        panel_draw.rectangle([0, 0, 279, 259], outline=(44, 62, 80, 170), width=1)
        if bbox:
            panel_draw.rectangle(bbox, outline=(241, 94, 129, 230), width=2)
        canvas.alpha_composite(panel, (x, y))
        draw_label(
            draw,
            (x, y + 272),
            f"{label}\nvisual height: {visual_height(image)} px",
            font,
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(path)


def proposed_runtime_scale_sheet(
    character: Image.Image,
    dragon: Image.Image,
    path: Path,
    *,
    habitat: Image.Image | None = None,
) -> dict[str, Any]:
    font = ImageFont.load_default()
    character_height = visual_height(character)
    dragon_target_height = round(character_height * PROPOSED_RUNTIME_RATIO)
    dragon_scaled = scaled_to_height(dragon, dragon_target_height)
    dragon_height = visual_height(dragon_scaled)
    ratio = dragon_height / max(1, character_height)

    canvas = Image.new("RGBA", (980, 620), (245, 247, 250, 255))
    draw = ImageDraw.Draw(canvas)
    draw.text((24, 18), "DragonV1 proposed runtime scale near CharacterV2", fill=(20, 31, 44, 255), font=font)
    area = checkerboard((560, 500))
    char_bbox = paste_trimmed(area, character, (205, 20))
    dragon_bbox = paste_trimmed(area, dragon_scaled, (116, 210))
    area_draw = ImageDraw.Draw(area)
    if char_bbox:
        area_draw.rectangle(char_bbox, outline=(46, 125, 50, 230), width=2)
    if dragon_bbox:
        area_draw.rectangle(dragon_bbox, outline=(241, 94, 129, 230), width=2)
    canvas.alpha_composite(area, (24, 58))
    draw_label(
        draw,
        (610, 86),
        (
            f"Character visual height: {character_height}px\n"
            f"Dragon visual height: {dragon_height}px\n"
            f"Ratio: {ratio * 100:.1f}%\n"
            f"Proposed runtime ratio: {PROPOSED_RUNTIME_RATIO * 100:.1f}%\n"
            "Placement: companion beside character, no frame-internal travel"
        ),
        font,
    )
    if habitat is not None:
        habitat_panel = checkerboard((330, 230))
        habitat_work = habitat.copy()
        habitat_work.thumbnail((310, 210), Image.Resampling.LANCZOS)
        habitat_panel.alpha_composite(habitat_work, ((330 - habitat_work.width) // 2, (230 - habitat_work.height) // 2))
        dragon_nest = scaled_to_height(dragon, round(habitat_work.height * 0.24))
        paste_trimmed(habitat_panel, dragon_nest, (44, 92))
        canvas.alpha_composite(habitat_panel, (610, 250))
        draw_label(
            draw,
            (610, 492),
            "Nest/home comparison uses CharacterV2 approved habitat asset\nDragon placed at small companion scale",
            font,
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(path)
    return {
        "character_visual_height_px": character_height,
        "dragon_visual_height_px": dragon_height,
        "ratio_percent": round(ratio * 100, 3),
        "proposed_runtime_ratio_percent": PROPOSED_RUNTIME_RATIO * 100,
    }


def habitat_sheet(habitat: Image.Image, dragon: Image.Image, path: Path) -> dict[str, Any]:
    font = ImageFont.load_default()
    habitat_work = habitat.copy()
    habitat_work.thumbnail((900, 500), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (980, 620), (245, 247, 250, 255))
    draw = ImageDraw.Draw(canvas)
    draw.text((24, 18), "DragonV1 near CharacterV2 nest/home habitat", fill=(20, 31, 44, 255), font=font)
    panel = checkerboard((920, 500))
    panel.alpha_composite(habitat_work, ((920 - habitat_work.width) // 2, (500 - habitat_work.height) // 2))
    target_height = round(habitat_work.height * 0.24)
    dragon_scaled = scaled_to_height(dragon, target_height)
    dragon_box = paste_trimmed(panel, dragon_scaled, (98, 280))
    if dragon_box:
        ImageDraw.Draw(panel).rectangle(dragon_box, outline=(241, 94, 129, 230), width=2)
    canvas.alpha_composite(panel, (30, 56))
    draw_label(
        draw,
        (36, 568),
        f"Dragon visual height: {visual_height(dragon_scaled)} px; habitat display height: {habitat_work.height} px; ratio: {visual_height(dragon_scaled) / max(1, habitat_work.height) * 100:.1f}%",
        font,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(path)
    return {
        "dragon_visual_height_px": visual_height(dragon_scaled),
        "habitat_display_height_px": habitat_work.height,
        "ratio_percent": round(visual_height(dragon_scaled) / max(1, habitat_work.height) * 100, 3),
    }


def write_metrics_markdown(metrics: dict[str, Any], path: Path) -> None:
    lines = ["# DragonV1 Visual Metrics Report", ""]
    lines.append("All visual-risk notes below are metric-only and are not human judgment.")
    lines.append("")
    for clip in metrics["clips"]:
        lines.extend(
            [
                f"## {clip['clip_name']}",
                "",
                f"- Frames: {clip['frame_count']}",
                f"- FPS: {clip['fps']}",
                f"- Canvas: {clip['canvas_size']}",
                f"- BBox width min/max/mean: {clip['bbox']['width_min']} / {clip['bbox']['width_max']} / {clip['bbox']['width_mean']}",
                f"- BBox height min/max/mean: {clip['bbox']['height_min']} / {clip['bbox']['height_max']} / {clip['bbox']['height_mean']}",
                f"- Visual height drift: {clip['visual_height_drift']}",
                f"- Center drift: x={clip['center_drift']['x_px']} px, y={clip['center_drift']['y_px']} px",
                f"- Anchor position: {clip['anchor_position']}",
                f"- Alpha edge margin min/max/mean: {clip['alpha_edge_margin']['min_px']} / {clip['alpha_edge_margin']['max_px']} / {clip['alpha_edge_margin']['mean_px']}",
                f"- Loop seam score: {clip['loop_seam_score']}",
                "- Suspected visual risks:",
            ]
        )
        for risk in clip["suspected_visual_risks_metric_only"]:
            lines.append(f"  - {risk}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_acceptance_report(
    output_dir: Path,
    source_paths: dict[str, str],
    previews: dict[str, dict[str, str | None]],
    comparisons: dict[str, str],
    metrics: dict[str, Any],
) -> None:
    lines = [
        "# DragonV1 Human Visual Acceptance Report",
        "",
        "HUMAN_VISUAL_ACCEPTANCE = PENDING",
        "",
        "## Source Assets",
        "",
    ]
    for key, value in source_paths.items():
        lines.append(f"- {key}: `{value}`")
    lines.extend(["", "## Preview Paths", ""])
    for clip_id, paths in previews.items():
        lines.append(f"### {clip_id}")
        for label, value in paths.items():
            lines.append(f"- {label}: `{value}`")
        lines.append("")
    lines.extend(["## Side-By-Side Comparison Paths", ""])
    for label, path in comparisons.items():
        lines.append(f"- {label}: `{path}`")
    lines.extend(["", "## Metrics", ""])
    lines.append(f"- JSON: `{output_dir / 'visual_metrics_report.json'}`")
    lines.append(f"- Markdown: `{output_dir / 'VISUAL_METRICS_REPORT.md'}`")
    for clip in metrics["clips"]:
        lines.append(
            f"- {clip['clip_name']}: frames={clip['frame_count']}, height_drift={clip['visual_height_drift']}, "
            f"center_drift=({clip['center_drift']['x_px']}px, {clip['center_drift']['y_px']}px), "
            f"edge_min={clip['alpha_edge_margin']['min_px']}px, seam={clip['loop_seam_score']}"
        )
    lines.extend(
        [
            "",
            "## Human Checklist",
            "",
            "| Item | PASS | FAIL | NEEDS_FIX | Notes |",
            "|---|---|---|---|---|",
            "| world/style fit | [ ] | [ ] | [ ] | |",
            "| size relative to character | [ ] | [ ] | [ ] | |",
            "| wing motion naturalness | [ ] | [ ] | [ ] | |",
            "| tail continuity | [ ] | [ ] | [ ] | |",
            "| hover stability | [ ] | [ ] | [ ] | |",
            "| fly loop seamlessness | [ ] | [ ] | [ ] | |",
            "| takeoff naturalness | [ ] | [ ] | [ ] | |",
            "| land naturalness | [ ] | [ ] | [ ] | |",
            "| identity consistency | [ ] | [ ] | [ ] | |",
            "| long-term desktop comfort | [ ] | [ ] | [ ] | |",
            "",
            "## Guardrails",
            "",
            "- DragonV1 approved clips were not modified by this package.",
            "- Runtime FSM, loader, renderer, and manifest integration were not changed.",
            "- CharacterV2 approved assets were read only for comparison.",
            "",
            "HUMAN_VISUAL_ACCEPTANCE = PENDING",
            "",
        ]
    )
    (output_dir / "DRAGON_VISUAL_ACCEPTANCE_REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def build_package(root: Path, timestamp: str) -> Path:
    output_dir = root / "Assets/DragonV1/review" / f"dragon_mvp_visual_acceptance_{timestamp}"
    if output_dir.exists():
        raise FileExistsError(f"review package already exists: {output_dir}")
    output_dir.mkdir(parents=True)
    for child in ["previews", "contact_sheets", "stress_previews", "comparisons", "mp4_frames"]:
        (output_dir / child).mkdir(parents=True, exist_ok=True)

    metrics: dict[str, Any] = {
        "status": "VISUAL_ACCEPTANCE_PACKAGE_READY",
        "human_visual_acceptance": "PENDING",
        "fps": FPS,
        "dragon_anchor": list(DRAGON_ANCHOR),
        "clips": [],
        "comparison_metrics": {},
    }
    previews: dict[str, dict[str, str | None]] = {}

    for clip in CLIPS:
        frames = load_clip_frames(root, clip)
        clip_metrics = summarize_clip(clip, frames)
        metrics["clips"].append(clip_metrics)
        transparent_gif = output_dir / "previews" / f"{clip.key}_transparent_preview.gif"
        checker_gif = output_dir / "previews" / f"{clip.key}_checker_preview.gif"
        mp4 = output_dir / "previews" / f"{clip.key}_checker_preview.mp4"
        contact = output_dir / "contact_sheets" / f"{clip.key}_contact_sheet_annotated.png"
        save_transparent_gif(frames, transparent_gif)
        save_checker_gif(frames, checker_gif)
        mp4_ok = save_checker_mp4(frames, mp4, output_dir / "mp4_frames")
        save_contact_sheet(clip, frames, clip_metrics, contact)
        paths: dict[str, str | None] = {
            "transparent_gif": str(transparent_gif),
            "checker_gif": str(checker_gif),
            "checker_mp4": str(mp4) if mp4_ok else None,
            "contact_sheet": str(contact),
        }
        if clip.loop:
            stress = output_dir / "stress_previews" / f"{clip.key}_loop_stress_5x_checker.gif"
            save_checker_gif(frames, stress, repeats=5)
            paths["loop_stress_5x_checker_gif"] = str(stress)
        previews[clip.clip_id] = paths

    dragon_idle = load_clip_frames(root, CLIPS[0])[0]
    dragon_left = load_clip_frames(root, CLIPS[1])[0]
    dragon_right = load_clip_frames(root, CLIPS[2])[0]
    character_idle_path = root / "Assets/CharacterV2/approved/clips/idle/frame_000.png"
    character_walk_left_path = root / "Assets/CharacterV2/approved/clips/walk_left/frame_004.png"
    character_walk_right_path = root / "Assets/CharacterV2/approved/clips/walk_right/frame_004.png"
    habitat_path = root / "Assets/CharacterV2/approved/habitat/habitat_blue_white_magic_book_soft_bed_20260620_02.png"
    character_idle = Image.open(character_idle_path).convert("RGBA")
    character_walk_left = Image.open(character_walk_left_path).convert("RGBA")
    character_walk_right = Image.open(character_walk_right_path).convert("RGBA")

    comparisons: dict[str, str] = {}
    idle_compare = output_dir / "comparisons/dragon_idle_hover_vs_character_idle.png"
    comparison_panel(
        "Dragon idle_hover next to CharacterV2 approved idle frame",
        [
            ("dragon_idle_hover frame_000", dragon_idle),
            ("CharacterV2 idle frame_000", character_idle),
        ],
        idle_compare,
    )
    comparisons["idle_hover_vs_character_idle"] = str(idle_compare)

    fly_compare = output_dir / "comparisons/dragon_fly_vs_character_walk.png"
    comparison_panel(
        "Dragon fly_left/fly_right next to CharacterV2 walk frames",
        [
            ("dragon_fly_left frame_000", dragon_left),
            ("CharacterV2 walk_left frame_004", character_walk_left),
            ("dragon_fly_right frame_000", dragon_right),
            ("CharacterV2 walk_right frame_004", character_walk_right),
        ],
        fly_compare,
    )
    comparisons["fly_left_right_vs_character_walk"] = str(fly_compare)

    habitat = Image.open(habitat_path).convert("RGBA") if habitat_path.exists() else None
    runtime_scale = output_dir / "comparisons/dragon_near_character_proposed_runtime_scale.png"
    metrics["comparison_metrics"]["proposed_runtime_scale"] = proposed_runtime_scale_sheet(
        character_idle,
        dragon_idle,
        runtime_scale,
        habitat=habitat,
    )
    comparisons["dragon_near_character_proposed_runtime_scale"] = str(runtime_scale)

    if habitat is not None:
        habitat_compare = output_dir / "comparisons/dragon_near_character_habitat.png"
        metrics["comparison_metrics"]["dragon_near_character_habitat"] = habitat_sheet(habitat, dragon_idle, habitat_compare)
        comparisons["dragon_near_character_habitat"] = str(habitat_compare)

    metrics_path = output_dir / "visual_metrics_report.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_metrics_markdown(metrics, output_dir / "VISUAL_METRICS_REPORT.md")
    source_paths = {
        "dragon_reference_status": str(root / "Assets/DragonV1/reference/REFERENCE_STATUS.md"),
        "dragon_candidates_root": str(root / "Assets/DragonV1/candidates/dragon_mvp_image2"),
        "character_idle_frame": str(character_idle_path),
        "character_walk_left_frame": str(character_walk_left_path),
        "character_walk_right_frame": str(character_walk_right_path),
        "character_habitat_asset": str(habitat_path) if habitat_path.exists() else "not found",
    }
    write_acceptance_report(output_dir, source_paths, previews, comparisons, metrics)
    return output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="Build DragonV1 human visual acceptance review package.")
    parser.add_argument("--root", default=".", help="DeskPet package root.")
    parser.add_argument("--timestamp", help="Timestamp suffix. Defaults to local YYYYMMDD_HHMMSS.")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    timestamp = args.timestamp or datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = build_package(root, timestamp)
    print(json.dumps({"status": "VISUAL_ACCEPTANCE_PACKAGE_READY", "path": str(output_dir)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
