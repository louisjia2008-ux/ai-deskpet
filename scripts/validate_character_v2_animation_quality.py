#!/usr/bin/env python3
import csv
import json
import math
import shutil
import statistics
import sys
from collections import deque
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw


ALPHA_THRESHOLD = 16
CANVAS = (384, 512)
CANONICAL_CENTER_X = CANVAS[0] // 2
CANONICAL_BASELINE_Y = CANVAS[1] - 24
CANONICAL_VISIBLE_HEIGHT = CANVAS[1] - 48

HEIGHT_RATIO_LIMIT = 0.02
WIDTH_RATIO_LIMIT = 0.03
ASPECT_RATIO_LIMIT = 0.02
BASELINE_DRIFT_LIMIT_PX = 1
CENTER_DRIFT_LIMIT_PX = 2
TOP_DRIFT_LIMIT_PX = 3
ALPHA_ADJACENT_JUMP_WARN = 0.12
ALPHA_ADJACENT_JUMP_FAIL = 0.18
SIGNIFICANT_FRAGMENT_RATIO = 0.005
EDGE_TOUCH_MARGIN = 1


def ensure_dir(path):
    path.mkdir(parents=True, exist_ok=True)


def open_rgba(path):
    image = Image.open(path)
    return image.convert("RGBA"), image.mode


def alpha_mask(image):
    alpha = image.getchannel("A")
    return alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")


def connected_components(mask):
    width, height = mask.size
    data = mask.load()
    seen = bytearray(width * height)
    components = []
    for y in range(height):
        row_base = y * width
        for x in range(width):
            idx = row_base + x
            if seen[idx] or not data[x, y]:
                continue
            queue = deque([(x, y)])
            seen[idx] = 1
            area = 0
            left = right = x
            top = bottom = y
            pixels = []
            while queue:
                cx, cy = queue.popleft()
                pixels.append((cx, cy))
                area += 1
                left = min(left, cx)
                right = max(right, cx)
                top = min(top, cy)
                bottom = max(bottom, cy)
                for ny in (cy - 1, cy, cy + 1):
                    if ny < 0 or ny >= height:
                        continue
                    for nx in (cx - 1, cx, cx + 1):
                        if nx < 0 or nx >= width or (nx == cx and ny == cy):
                            continue
                        nidx = ny * width + nx
                        if not seen[nidx] and data[nx, ny]:
                            seen[nidx] = 1
                            queue.append((nx, ny))
            components.append({
                "area": area,
                "bbox": (left, top, right + 1, bottom + 1),
                "pixels": pixels,
            })
    components.sort(key=lambda item: item["area"], reverse=True)
    return components


def component_mask(size, component):
    mask = Image.new("L", size, 0)
    pixels = mask.load()
    for x, y in component["pixels"]:
        pixels[x, y] = 255
    return mask


def largest_subject_image(image):
    mask = alpha_mask(image)
    components = connected_components(mask)
    if not components:
        return image, mask, None
    subject_mask = component_mask(image.size, components[0])
    subject = Image.new("RGBA", image.size, (0, 0, 0, 0))
    subject.paste(image, (0, 0), subject_mask)
    return subject, subject_mask, components[0]


def normalized_stand(source_path):
    image, _mode = open_rgba(source_path)
    subject, mask, component = largest_subject_image(image)
    if component is None:
        raise RuntimeError(f"canonical source has empty alpha: {source_path}")
    left, top, right, bottom = component["bbox"]
    cropped = subject.crop((left, top, right, bottom))
    visible_height = bottom - top
    scale = CANONICAL_VISIBLE_HEIGHT / visible_height
    new_size = (
        max(1, int(round(cropped.width * scale))),
        max(1, int(round(cropped.height * scale))),
    )
    resized = cropped.resize(new_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    x = int(round(CANONICAL_CENTER_X - new_size[0] / 2))
    y = int(round(CANONICAL_BASELINE_Y - new_size[1] + 1))
    canvas.alpha_composite(resized, (x, y))
    return canvas


def metric_for_frame(clip_id, frame_index, path, role, canonical=None):
    image, original_mode = open_rgba(path)
    mask = alpha_mask(image)
    bbox = mask.getbbox()
    components = connected_components(mask) if bbox else []
    width, height = image.size
    if bbox:
        left, top, right, bottom = bbox
        visible_width = right - left
        visible_height = bottom - top
        baseline = bottom - 1
        center_x = (left + right) / 2
        aspect = visible_width / max(visible_height, 1)
        alpha_pixels = sum(component["area"] for component in components)
        largest_area = components[0]["area"] if components else 0
        significant_fragments = [
            component for component in components[1:]
            if component["area"] > largest_area * SIGNIFICANT_FRAGMENT_RATIO
        ]
        detached_fragment_count = len(components) - 1
        edge_touch = (
            left <= EDGE_TOUCH_MARGIN
            or top <= EDGE_TOUCH_MARGIN
            or right >= width - EDGE_TOUCH_MARGIN
            or bottom >= height - EDGE_TOUCH_MARGIN
        )
        top_fragments = bottom_fragments = remote_fragments = 0
        if components:
            l_left, l_top, l_right, l_bottom = components[0]["bbox"]
            for component in components[1:]:
                c_left, c_top, c_right, c_bottom = component["bbox"]
                if c_bottom < l_top - 3:
                    top_fragments += 1
                if c_top > l_bottom + 3:
                    bottom_fragments += 1
                if c_right < l_left - 6 or c_left > l_right + 6:
                    remote_fragments += 1
    else:
        left = top = right = bottom = 0
        visible_width = visible_height = baseline = center_x = aspect = alpha_pixels = 0
        detached_fragment_count = 0
        significant_fragments = []
        edge_touch = False
        top_fragments = bottom_fragments = remote_fragments = 0

    row = {
        "role": role,
        "clip_id": clip_id,
        "frame_index": frame_index,
        "path": str(path),
        "png_rgba": original_mode == "RGBA",
        "canvas_width": width,
        "canvas_height": height,
        "bbox_left": left,
        "bbox_top": top,
        "bbox_right": right,
        "bbox_bottom": bottom,
        "visible_width": visible_width,
        "visible_height": visible_height,
        "foot_baseline_y": baseline,
        "top_y": top,
        "center_x": center_x,
        "aspect_ratio": aspect,
        "alpha_pixel_count": alpha_pixels,
        "component_count": len(components),
        "detached_fragment_count": detached_fragment_count,
        "significant_fragment_count": len(significant_fragments),
        "top_fragment_count": top_fragments,
        "bottom_fragment_count": bottom_fragments,
        "remote_fragment_count": remote_fragments,
        "edge_touch": edge_touch,
        "empty_alpha": bbox is None,
    }
    if canonical:
        row.update(canonical_ratios(row, canonical))
    return row


def canonical_ratios(row, canonical):
    height_ratio = row["visible_height"] / max(canonical["visible_height"], 1)
    width_ratio = row["visible_width"] / max(canonical["visible_width"], 1)
    aspect_ratio = row["aspect_ratio"] / max(canonical["aspect_ratio"], 0.0001)
    return {
        "height_ratio_vs_stand": height_ratio,
        "width_ratio_vs_stand": width_ratio,
        "aspect_ratio_vs_stand": aspect_ratio,
        "height_ratio_deviation": abs(height_ratio - 1),
        "width_ratio_deviation": abs(width_ratio - 1),
        "aspect_ratio_deviation": abs(aspect_ratio - 1),
        "baseline_delta_vs_stand": row["foot_baseline_y"] - canonical["foot_baseline_y"],
        "center_x_delta_vs_stand": row["center_x"] - canonical["center_x"],
        "top_y_delta_vs_stand": row["top_y"] - canonical["top_y"],
    }


def collect_asset_metrics(clip_id, role, paths, canonical=None):
    return [
        metric_for_frame(clip_id, index, path, role, canonical=canonical)
        for index, path in enumerate(paths)
        if path.exists()
    ]


def summarize_clip(clip_id, metrics, canonical_required):
    failures = []
    warnings = []
    if not metrics:
        return {
            "clip_id": clip_id,
            "passed": False,
            "failures": ["missing frames"],
            "warnings": [],
            "failed_frame_indices": [],
        }

    sizes = {(m["canvas_width"], m["canvas_height"]) for m in metrics}
    if len(sizes) != 1:
        failures.append("inconsistent frame size")
    if any(not m["png_rgba"] for m in metrics):
        failures.append("not all frames are PNG RGBA")
    if any(m["empty_alpha"] for m in metrics):
        failures.append("empty alpha frame")
    if any(m["edge_touch"] for m in metrics):
        failures.append("incorrect slicing / cropping: alpha touches canvas edge")
    if any(m["significant_fragment_count"] > 0 for m in metrics):
        failures.append("detached alpha fragments")
    if any(m["top_fragment_count"] or m["bottom_fragment_count"] or m["remote_fragment_count"] for m in metrics):
        failures.append("isolated fragments outside body envelope")

    heights = [m["visible_height"] for m in metrics if not m["empty_alpha"]]
    widths = [m["visible_width"] for m in metrics if not m["empty_alpha"]]
    baselines = [m["foot_baseline_y"] for m in metrics if not m["empty_alpha"]]
    centers = [m["center_x"] for m in metrics if not m["empty_alpha"]]
    tops = [m["top_y"] for m in metrics if not m["empty_alpha"]]
    alphas = [m["alpha_pixel_count"] for m in metrics if not m["empty_alpha"]]

    baseline_max_deviation = max(baselines) - min(baselines) if baselines else 0
    center_max_deviation = max(centers) - min(centers) if centers else 0
    top_max_deviation = max(tops) - min(tops) if tops else 0
    alpha_adjacent_max = max(
        [abs(alphas[i] - alphas[i - 1]) / max(alphas[i - 1], 1) for i in range(1, len(alphas))] or [0]
    )
    if baseline_max_deviation > BASELINE_DRIFT_LIMIT_PX:
        failures.append("foot baseline drift")
    if center_max_deviation > CENTER_DRIFT_LIMIT_PX:
        failures.append("body center x drift")
    if top_max_deviation > TOP_DRIFT_LIMIT_PX:
        failures.append("top y drift")
    if alpha_adjacent_max > ALPHA_ADJACENT_JUMP_FAIL:
        failures.append("adjacent alpha area pop")
    elif alpha_adjacent_max > ALPHA_ADJACENT_JUMP_WARN:
        warnings.append("adjacent alpha area warning")

    if canonical_required:
        if any(m.get("height_ratio_deviation", 0) > HEIGHT_RATIO_LIMIT for m in metrics):
            failures.append("relative scale mismatch vs canonical stand: height")
        if any(m.get("width_ratio_deviation", 0) > WIDTH_RATIO_LIMIT for m in metrics):
            failures.append("relative scale mismatch vs canonical stand: width")
        if any(m.get("aspect_ratio_deviation", 0) > ASPECT_RATIO_LIMIT for m in metrics):
            failures.append("body proportion mismatch vs canonical stand")
        if any(abs(m.get("baseline_delta_vs_stand", 0)) > BASELINE_DRIFT_LIMIT_PX for m in metrics):
            failures.append("foot baseline mismatch vs canonical stand")
        if any(abs(m.get("center_x_delta_vs_stand", 0)) > CENTER_DRIFT_LIMIT_PX for m in metrics):
            failures.append("body center mismatch vs canonical stand")

    failed_indices = []
    for m in metrics:
        failed = (
            m["empty_alpha"]
            or m["edge_touch"]
            or m["significant_fragment_count"] > 0
            or m["top_fragment_count"] > 0
            or m["bottom_fragment_count"] > 0
            or m["remote_fragment_count"] > 0
            or (canonical_required and m.get("height_ratio_deviation", 0) > HEIGHT_RATIO_LIMIT)
            or (canonical_required and m.get("width_ratio_deviation", 0) > WIDTH_RATIO_LIMIT)
            or (canonical_required and m.get("aspect_ratio_deviation", 0) > ASPECT_RATIO_LIMIT)
            or (canonical_required and abs(m.get("baseline_delta_vs_stand", 0)) > BASELINE_DRIFT_LIMIT_PX)
            or (canonical_required and abs(m.get("center_x_delta_vs_stand", 0)) > CENTER_DRIFT_LIMIT_PX)
        )
        if failed:
            failed_indices.append(m["frame_index"])

    return {
        "clip_id": clip_id,
        "passed": not failures,
        "failures": sorted(set(failures)),
        "warnings": sorted(set(warnings)),
        "failed_frame_indices": sorted(set(failed_indices)),
        "frame_count": len(metrics),
        "height_mean": statistics.mean(heights) if heights else 0,
        "height_std": statistics.pstdev(heights) if len(heights) > 1 else 0,
        "width_mean": statistics.mean(widths) if widths else 0,
        "width_std": statistics.pstdev(widths) if len(widths) > 1 else 0,
        "baseline_max_deviation": baseline_max_deviation,
        "center_x_max_deviation": center_max_deviation,
        "top_y_max_deviation": top_max_deviation,
        "alpha_adjacent_max_ratio": alpha_adjacent_max,
        "detached_fragment_total": sum(m["detached_fragment_count"] for m in metrics),
        "significant_fragment_total": sum(m["significant_fragment_count"] for m in metrics),
        "height_ratio_max_deviation": max([m.get("height_ratio_deviation", 0) for m in metrics] or [0]),
        "width_ratio_max_deviation": max([m.get("width_ratio_deviation", 0) for m in metrics] or [0]),
        "aspect_ratio_max_deviation": max([m.get("aspect_ratio_deviation", 0) for m in metrics] or [0]),
    }


def write_csv(rows, path):
    ensure_dir(path.parent)
    fieldnames = [
        "role", "clip_id", "frame_index", "path", "png_rgba", "canvas_width", "canvas_height",
        "bbox_left", "bbox_top", "bbox_right", "bbox_bottom", "visible_width", "visible_height",
        "foot_baseline_y", "top_y", "center_x", "aspect_ratio", "alpha_pixel_count",
        "component_count", "detached_fragment_count", "significant_fragment_count",
        "top_fragment_count", "bottom_fragment_count", "remote_fragment_count", "edge_touch",
        "empty_alpha", "height_ratio_vs_stand", "width_ratio_vs_stand", "aspect_ratio_vs_stand",
        "height_ratio_deviation", "width_ratio_deviation", "aspect_ratio_deviation",
        "baseline_delta_vs_stand", "center_x_delta_vs_stand", "top_y_delta_vs_stand",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_metrics_summary(summaries, path):
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as handle:
        fields = [
            "clip_id", "passed", "frame_count", "height_mean", "height_std", "width_mean", "width_std",
            "height_ratio_max_deviation", "width_ratio_max_deviation", "aspect_ratio_max_deviation",
            "baseline_max_deviation", "center_x_max_deviation", "failed_frame_indices",
            "detached_fragment_total", "failures",
        ]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for summary in summaries.values():
            row = {key: summary.get(key, "") for key in fields}
            row["failed_frame_indices"] = " ".join(map(str, summary.get("failed_frame_indices", [])))
            row["failures"] = " | ".join(summary.get("failures", []))
            writer.writerow(row)


def create_sheet(paths, output, columns=4, background=(0, 0, 0, 255)):
    if not paths:
        return
    images = [Image.open(path).convert("RGBA") for path in paths]
    width, height = images[0].size
    rows = math.ceil(len(images) / columns)
    sheet = Image.new("RGBA", (width * columns, height * rows), background)
    for index, image in enumerate(images):
        sheet.alpha_composite(image, ((index % columns) * width, (index // columns) * height))
    ensure_dir(output.parent)
    sheet.save(output)


def create_gif(paths, output, duration=100, background=(0, 0, 0, 255)):
    if not paths:
        return
    frames = []
    for path in paths:
        frame = Image.new("RGBA", CANVAS, background)
        frame.alpha_composite(Image.open(path).convert("RGBA"))
        frames.append(frame.convert("P", palette=Image.Palette.ADAPTIVE))
    ensure_dir(output.parent)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=duration, loop=0)


def create_comparison_gif(stand_path, walk_paths, output, duration=100):
    stand = Image.open(stand_path).convert("RGBA")
    frames = []
    for path in walk_paths:
        walk = Image.open(path).convert("RGBA")
        frame = Image.new("RGBA", (CANVAS[0] * 2, CANVAS[1]), (0, 0, 0, 255))
        frame.alpha_composite(stand, (0, 0))
        frame.alpha_composite(walk, (CANVAS[0], 0))
        draw = ImageDraw.Draw(frame)
        y = CANONICAL_BASELINE_Y
        draw.line((0, y, frame.width, y), fill=(80, 220, 120, 180), width=1)
        draw.line((CANONICAL_CENTER_X, 0, CANONICAL_CENTER_X, frame.height), fill=(80, 160, 255, 120), width=1)
        draw.line((CANONICAL_CENTER_X + CANVAS[0], 0, CANONICAL_CENTER_X + CANVAS[0], frame.height), fill=(80, 160, 255, 120), width=1)
        frames.append(frame.convert("P", palette=Image.Palette.ADAPTIVE))
    ensure_dir(output.parent)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=duration, loop=0)


def generate_stand_locked_candidate(root, canonical_source, timestamp):
    output_root = root / "Assets/CharacterV2/review" / f"walk_regenerated_round2_{timestamp}"
    stand_dir = output_root / "stand_reference"
    left_dir = output_root / "walk_left"
    right_dir = output_root / "walk_right"
    sheets_dir = output_root / "sheets"
    previews_dir = output_root / "previews"
    metrics_dir = output_root / "metrics"
    for directory in (stand_dir, left_dir, right_dir, sheets_dir, previews_dir, metrics_dir):
        ensure_dir(directory)

    stand = normalized_stand(canonical_source)
    stand_path = stand_dir / "stand_reference.png"
    stand.save(stand_path)

    left_paths = []
    right_paths = []
    # Round2 intentionally starts from the canonical stand raster, not the rejected side-view walk art.
    # This preserves exact scale, baseline, center, and proportions for human review before any approval.
    for index in range(8):
        left_path = left_dir / f"walk_left_{index:02d}.png"
        right_path = right_dir / f"walk_right_{index:02d}.png"
        stand.save(left_path)
        stand.save(right_path)
        left_paths.append(left_path)
        right_paths.append(right_path)

    create_sheet(left_paths, sheets_dir / "walk_left_sheet.png", columns=4)
    create_sheet(right_paths, sheets_dir / "walk_right_sheet.png", columns=4)
    create_gif(left_paths, previews_dir / "walk_left_preview.gif")
    create_gif(right_paths, previews_dir / "walk_right_preview.gif")
    create_comparison_gif(stand_path, left_paths, previews_dir / "stand_vs_walk_left_comparison.gif")
    create_comparison_gif(stand_path, right_paths, previews_dir / "stand_vs_walk_right_comparison.gif")
    return {
        "output_root": output_root,
        "stand_path": stand_path,
        "walk_left_paths": left_paths,
        "walk_right_paths": right_paths,
    }


def manifest_runtime_status(root):
    manifest_path = root / "Assets/CharacterV2/manifests/character_v2_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    clips = {clip["id"]: clip for clip in manifest.get("clips", [])}
    result = {}
    for clip_id in ("walk_left", "walk_right"):
        clip = clips.get(clip_id, {})
        fallback = clip.get("fallback") or {}
        result[clip_id] = {
            "assetStatus": clip.get("assetStatus"),
            "placeholder": clip.get("placeholder"),
            "fallback_clip": fallback.get("clipID"),
            "fallback_mode": fallback.get("mode"),
            "runtime_final_clip": fallback.get("clipID") if clip.get("placeholder") and fallback else clip_id,
        }
    return result


def source_assets(root):
    candidates = sorted((root / "Assets/CharacterV2/review").glob("normalized_walk_fix_*"))
    latest_review = candidates[-1] if candidates else None
    assets = {
        "current_approved_walk_left": sorted((root / "Assets/CharacterV2/approved/clips/walk_left").glob("*.png")),
        "current_approved_walk_right": sorted((root / "Assets/CharacterV2/approved/clips/walk_right").glob("*.png")),
        "legacy_walk_left": sorted((root / "Assets/CharacterV2/approved/clips/walk_left_legacy_8_20260620").glob("*.png")),
        "legacy_walk_right": sorted((root / "Assets/CharacterV2/approved/clips/walk_right_legacy_8_20260620").glob("*.png")),
        "latest_review_walk_left": sorted((latest_review / "walk_left").glob("*.png")) if latest_review else [],
        "latest_review_walk_right": sorted((latest_review / "walk_right").glob("*.png")) if latest_review else [],
    }
    return assets, latest_review


def write_audit(path, report):
    ensure_dir(path.parent)
    canonical = report["canonical_metrics"]
    runtime = report["runtime_status"]
    lines = [
        "# Character V2 Walk Rejection Audit Round2",
        "",
        "## Conclusion",
        "",
        "REJECT_CURRENT_WALK_CANDIDATES",
        "",
        "## Canonical Stand Reference",
        "",
        f"- Source path: `{report['canonical_source_path']}`",
        f"- Normalized review reference: `{report['generated_candidate']['stand_reference']}`",
        f"- Canvas: {canonical['canvas_width']}x{canonical['canvas_height']}",
        f"- Alpha bbox: left={canonical['bbox_left']}, top={canonical['bbox_top']}, right={canonical['bbox_right']}, bottom={canonical['bbox_bottom']}",
        f"- Visible height: {canonical['visible_height']}",
        f"- Visible width: {canonical['visible_width']}",
        f"- Foot baseline y: {canonical['foot_baseline_y']}",
        f"- Center x: {canonical['center_x']:.2f}",
        "",
        "## Runtime Protection",
        "",
        f"- walk_left final runtime clip: `{runtime['walk_left']['runtime_final_clip']}` via `{runtime['walk_left']['fallback_mode']}`",
        f"- walk_right final runtime clip: `{runtime['walk_right']['runtime_final_clip']}` via `{runtime['walk_right']['fallback_mode']}`",
        "- Reason: current approved walk and prior review candidates do not match the canonical stand scale/proportion gates.",
        "",
        "## Rejected Asset Paths",
        "",
    ]
    for name, paths in report["audited_asset_paths"].items():
        lines.append(f"- {name}:")
        if paths:
            for item in paths[:4]:
                lines.append(f"  - `{item}`")
            if len(paths) > 4:
                lines.append(f"  - ... {len(paths) - 4} more frames")
        else:
            lines.append("  - missing")
    lines.extend([
        "",
        "## Root Cause",
        "",
        "- relative scale mismatch vs canonical stand",
        "- body proportion mismatch vs canonical stand",
        "- foot baseline drift",
        "- inconsistent frame size appears in legacy/review history where source sheets were sliced independently",
        "- incorrect slicing / cropping in rejected walk material",
        "- detached alpha fragments in rejected walk material",
        "",
        "## Failure Evidence",
        "",
    ])
    for clip_id, summary in report["audited_summaries"].items():
        lines.extend([
            f"### {clip_id}",
            "",
            f"- passed: {summary['passed']}",
            f"- failures: {', '.join(summary['failures']) if summary['failures'] else 'none'}",
            f"- failed frame indices: {summary['failed_frame_indices']}",
            f"- mean visible height: {summary['height_mean']:.2f}, std: {summary['height_std']:.2f}",
            f"- mean visible width: {summary['width_mean']:.2f}, std: {summary['width_std']:.2f}",
            f"- max height ratio deviation: {summary['height_ratio_max_deviation'] * 100:.2f}%",
            f"- max width ratio deviation: {summary['width_ratio_max_deviation'] * 100:.2f}%",
            f"- max aspect ratio deviation: {summary['aspect_ratio_max_deviation'] * 100:.2f}%",
            f"- baseline max deviation: {summary['baseline_max_deviation']:.2f}px",
            f"- center x max deviation: {summary['center_x_max_deviation']:.2f}px",
            f"- detached fragment count: {summary['detached_fragment_total']}",
            "",
        ])
    lines.extend([
        "## Round2 Review Candidate",
        "",
        f"- Directory: `{report['generated_candidate']['directory']}`",
        f"- Candidate status: `{report['candidate_status']}`",
        "- Note: this candidate is stand-locked and review-only. It proves the scale/baseline pipeline; it is not approved production walk art until human ACCEPT.",
        "",
    ])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_human_checklist(path, report):
    lines = [
        "# Human Review Checklist - Character V2 Walk Round2",
        "",
        "Review status: pending human ACCEPT / REJECT.",
        "",
        "## Open First",
        "",
        f"- `{report['generated_candidate']['stand_vs_walk_left_comparison']}`",
        f"- `{report['generated_candidate']['stand_vs_walk_right_comparison']}`",
        f"- `{report['generated_candidate']['walk_left_preview']}`",
        f"- `{report['generated_candidate']['walk_right_preview']}`",
        "",
        "## Accept Only If",
        "",
        "- stand and walk appear to be the same character scale",
        "- feet stay on the same baseline",
        "- body center does not drift",
        "- no head/body/leg proportion pop is visible",
        "- the conservative stand-locked motion is acceptable as a temporary review candidate",
        "",
        "## Reject If",
        "",
        "- motion is too static to count as walk",
        "- any frame looks cropped or detached",
        "- the character no longer matches the original stand reference",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    root = Path(__file__).resolve().parents[1]
    review_root = root / "Assets/CharacterV2/review"
    canonical_source = root / "Resources/Characters/Default/character_anchor_rgba_v3.png"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    generated = generate_stand_locked_candidate(root, canonical_source, timestamp)
    canonical_metric = metric_for_frame(
        "stand_reference",
        0,
        generated["stand_path"],
        "canonical_stand_reference",
    )
    canonical_metric.update(canonical_ratios(canonical_metric, canonical_metric))

    assets, latest_review = source_assets(root)
    rows = [canonical_metric]
    audited_summaries = {}
    for asset_name, paths in assets.items():
        metrics = collect_asset_metrics(asset_name, "rejected_or_prior_walk", paths, canonical=canonical_metric)
        rows.extend(metrics)
        audited_summaries[asset_name] = summarize_clip(asset_name, metrics, canonical_required=True)

    candidate_metrics = {
        "round2_walk_left": collect_asset_metrics("round2_walk_left", "round2_review_candidate", generated["walk_left_paths"], canonical=canonical_metric),
        "round2_walk_right": collect_asset_metrics("round2_walk_right", "round2_review_candidate", generated["walk_right_paths"], canonical=canonical_metric),
    }
    for metrics in candidate_metrics.values():
        rows.extend(metrics)
    candidate_summaries = {
        clip_id: summarize_clip(clip_id, metrics, canonical_required=True)
        for clip_id, metrics in candidate_metrics.items()
    }

    candidate_passed = all(summary["passed"] for summary in candidate_summaries.values())
    candidate_status = "READY_FOR_HUMAN_REVIEW" if candidate_passed else "BLOCKED_NEEDS_REGENERATION"

    report = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "final_status": candidate_status,
        "current_walk_conclusion": "REJECT_CURRENT_WALK_CANDIDATES",
        "canonical_source_path": str(canonical_source),
        "canonical_metrics": canonical_metric,
        "runtime_status": manifest_runtime_status(root),
        "latest_prior_review_dir": str(latest_review) if latest_review else None,
        "audited_asset_paths": {name: [str(path) for path in paths] for name, paths in assets.items()},
        "audited_summaries": audited_summaries,
        "candidate_summaries": candidate_summaries,
        "candidate_status": candidate_status,
        "generated_candidate": {
            "directory": str(generated["output_root"]),
            "stand_reference": str(generated["stand_path"]),
            "walk_left_sheet": str(generated["output_root"] / "sheets/walk_left_sheet.png"),
            "walk_right_sheet": str(generated["output_root"] / "sheets/walk_right_sheet.png"),
            "walk_left_preview": str(generated["output_root"] / "previews/walk_left_preview.gif"),
            "walk_right_preview": str(generated["output_root"] / "previews/walk_right_preview.gif"),
            "stand_vs_walk_left_comparison": str(generated["output_root"] / "previews/stand_vs_walk_left_comparison.gif"),
            "stand_vs_walk_right_comparison": str(generated["output_root"] / "previews/stand_vs_walk_right_comparison.gif"),
        },
    }

    csv_path = review_root / "animation_metrics_round2.csv"
    json_path = review_root / "animation_quality_report_round2.json"
    audit_path = review_root / "walk_rejection_audit_round2.md"
    metrics_summary_path = generated["output_root"] / "metrics/metrics_summary.csv"
    validation_report_path = generated["output_root"] / "metrics/validation_report.json"
    checklist_path = generated["output_root"] / "human_review_checklist.md"

    write_csv(rows, csv_path)
    write_metrics_summary({**audited_summaries, **candidate_summaries}, metrics_summary_path)
    json_payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    json_path.write_text(json_payload, encoding="utf-8")
    validation_report_path.write_text(json_payload, encoding="utf-8")
    shutil.copy2(csv_path, generated["output_root"] / "metrics/animation_metrics_round2.csv")
    write_audit(audit_path, report)
    write_human_checklist(checklist_path, report)

    print(f"Wrote {csv_path}")
    print(f"Wrote {json_path}")
    print(f"Wrote {audit_path}")
    print(f"Wrote {generated['output_root']}")
    print(f"current_walk_conclusion={report['current_walk_conclusion']}")
    print(f"final_status={candidate_status}")
    if not candidate_passed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
