#!/usr/bin/env python3
import argparse
import json
import math
import shutil
import statistics
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps


ALPHA_THRESHOLD = 16
EXPECTED_FRAMES = 16
DEFAULT_CANVAS = (384, 512)
DEFAULT_TARGET_HEIGHT = 464
DEFAULT_BASELINE_Y = 488
DEFAULT_ROOT_X = 192
DEFAULT_FPS = 10
EDGE_MARGIN_PX = 8
HEIGHT_DRIFT_RATIO_LIMIT = 0.02
BASELINE_DRIFT_LIMIT_PX = 1
ROOT_X_DRIFT_LIMIT_PX = 1
DIFF_SPIKE_MULTIPLIER = 2.5
MIN_LOOP_SOURCE_FRAMES = 24
SEGMENT_DISTANCE_THRESHOLD = 14
REPORT_NAME = "WALK_RIGHT_BUILD_REPORT.md"


def ensure_dir(path):
    path.mkdir(parents=True, exist_ok=True)


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, payload):
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def raw_frame_paths(raw_dir):
    return sorted(path for path in Path(raw_dir).glob("frame_*.png") if path.is_file())


def border_pixels(array, sample=12):
    return np.concatenate(
        [
            array[:sample, :, :].reshape(-1, 3),
            array[-sample:, :, :].reshape(-1, 3),
            array[:, :sample, :].reshape(-1, 3),
            array[:, -sample:, :].reshape(-1, 3),
        ],
        axis=0,
    )


def largest_connected_component(mask):
    height, width = mask.shape
    visited = np.zeros(mask.shape, dtype=bool)
    foreground = np.transpose(np.nonzero(mask))
    best_coords = []

    for y_value, x_value in foreground:
        y = int(y_value)
        x = int(x_value)
        if visited[y, x]:
            continue
        stack = [(y, x)]
        visited[y, x] = True
        coords = []
        while stack:
            cy, cx = stack.pop()
            coords.append((cy, cx))
            for dy in (-1, 0, 1):
                ny = cy + dy
                if ny < 0 or ny >= height:
                    continue
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    nx = cx + dx
                    if nx < 0 or nx >= width:
                        continue
                    if mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        stack.append((ny, nx))
        if len(coords) > len(best_coords):
            best_coords = coords

    component = np.zeros(mask.shape, dtype=bool)
    if best_coords:
        ys, xs = zip(*best_coords)
        component[np.array(ys), np.array(xs)] = True
    return component


def segment_character(path, distance_threshold=SEGMENT_DISTANCE_THRESHOLD):
    rgb = Image.open(path).convert("RGB")
    rgb_array = np.asarray(rgb).astype(np.int16)
    background = np.median(border_pixels(rgb_array), axis=0)
    distance = np.sqrt(((rgb_array - background) ** 2).sum(axis=2))
    raw_mask = distance > distance_threshold
    mask_image = Image.fromarray((raw_mask.astype(np.uint8) * 255), mode="L")
    mask_image = mask_image.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    component = largest_connected_component(np.asarray(mask_image) > 0)
    component_image = Image.fromarray((component.astype(np.uint8) * 255), mode="L")
    alpha = component_image.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.55))
    alpha_array = np.asarray(alpha).astype(np.uint8)
    alpha_array[alpha_array < 4] = 0
    rgba_array = np.dstack([np.asarray(rgb), alpha_array])
    rgba_array[alpha_array == 0, :3] = 0
    image = Image.fromarray(rgba_array, mode="RGBA")
    metric = metric_for_image(image, path, 0)
    return {
        "path": str(path),
        "background_rgb_median": [round(float(value), 3) for value in background],
        "threshold": distance_threshold,
        "raw_mask_pixels": int(raw_mask.sum()),
        "largest_component_pixels": int(component.sum()),
        "segmented": image,
        "metric": metric,
    }


def alpha_bbox(image):
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    return mask.getbbox()


def alpha_area(image):
    histogram = image.getchannel("A").histogram()
    return sum(histogram[ALPHA_THRESHOLD + 1 :])


def metric_for_image(image, path, index):
    rgba = image.convert("RGBA")
    bbox = alpha_bbox(rgba)
    record = {
        "frame_index": index,
        "path": str(path),
        "canvas": [rgba.width, rgba.height],
        "mode": "RGBA",
        "empty_alpha": bbox is None,
    }
    if bbox is None:
        return record
    left, top, right, bottom = bbox
    record.update(
        {
            "bbox": [left, top, right, bottom],
            "visible_width": right - left,
            "visible_height": bottom - top,
            "foot_baseline_y": bottom - 1,
            "root_x": (left + right) / 2,
            "edge_margin_min": min(left, top, rgba.width - right, rgba.height - bottom),
            "alpha_area": alpha_area(rgba),
        }
    )
    return record


def crop_to_alpha(image):
    bbox = alpha_bbox(image)
    if bbox is None:
        raise ValueError("empty alpha")
    return image.crop(bbox), bbox


def normalize_segmented_frame(image, target_canvas, target_height, baseline_y, root_x):
    current = image.convert("RGBA")
    source_metric = metric_for_image(current, "segmented", 0)
    if source_metric.get("empty_alpha"):
        raise ValueError("segmented frame has empty alpha")

    for _attempt in range(4):
        metric = metric_for_image(current, "scaled", 0)
        if metric.get("empty_alpha"):
            raise ValueError("scaled frame has empty alpha")
        crop, _bbox = crop_to_alpha(current)
        if metric["visible_height"] == target_height:
            current = crop
            break
        scale = target_height / max(1, metric["visible_height"])
        current = crop.resize(
            (
                max(1, int(round(crop.width * scale))),
                max(1, int(round(crop.height * scale))),
            ),
            Image.Resampling.LANCZOS,
        )

    final_crop, _bbox = crop_to_alpha(current)
    canvas = Image.new("RGBA", target_canvas, (0, 0, 0, 0))
    x = int(round(root_x - final_crop.width / 2))
    y = int(round(baseline_y - final_crop.height + 1))
    canvas.alpha_composite(final_crop, (x, y))
    return canvas, {
        "source": source_metric,
        "output": metric_for_image(canvas, "normalized", 0),
        "scale": target_height / max(1, source_metric["visible_height"]),
    }


def masked_diff_ratio(first, second):
    first_rgba = first.convert("RGBA")
    second_rgba = second.convert("RGBA")
    first_mask = first_rgba.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="L")
    second_mask = second_rgba.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="L")
    union_mask = ImageChops.lighter(first_mask, second_mask)
    union = np.asarray(union_mask) > 0
    area = int(union.sum())
    if area <= 0:
        return 0.0
    diff = np.asarray(ImageChops.difference(first_rgba, second_rgba).convert("L"))
    return float(diff[union].sum() / max(1, area * 255))


def detect_loop(normalized_frames, min_loop_source_frames=MIN_LOOP_SOURCE_FRAMES):
    count = len(normalized_frames)
    candidates = []
    for start in range(0, max(1, count - min_loop_source_frames)):
        for end in range(start + min_loop_source_frames, count):
            length = end - start
            seam = masked_diff_ratio(normalized_frames[start], normalized_frames[end])
            duration_penalty = abs(length - (count - 1)) * 0.001
            candidates.append(
                {
                    "start": start,
                    "end": end,
                    "length": length,
                    "seam_diff": seam,
                    "score": seam + duration_penalty,
                }
            )
    candidates.sort(key=lambda item: item["score"])
    if not candidates:
        return {
            "mode": "manual_fallback",
            "start": 0,
            "end": count - 1,
            "length": max(0, count - 1),
            "seam_diff": None,
            "score": None,
            "top_candidates": [],
        }

    best = candidates[0]
    mode = "auto_seam_score"
    warnings = []
    if best["seam_diff"] is not None and best["seam_diff"] > 0.12:
        mode = "auto_seam_score_high_seam_warning"
        warnings.append("best available source seam is visually imperfect; human loop review is required")
    return {**best, "mode": mode, "warnings": warnings, "top_candidates": candidates[:10]}


def sample_loop_indices(loop):
    start = loop["start"]
    length = loop["length"]
    if EXPECTED_FRAMES <= 1:
        return [start]
    return [start + int(round((index * length) / (EXPECTED_FRAMES - 1))) for index in range(EXPECTED_FRAMES)]


def validate_clip(frames, frame_paths):
    failures = []
    warnings = []
    metrics = [metric_for_image(image, frame_paths[index], index) for index, image in enumerate(frames)]
    if len(frames) != EXPECTED_FRAMES:
        failures.append(f"frame count != {EXPECTED_FRAMES}")
    expected_names = [f"frame_{index:03d}.png" for index in range(EXPECTED_FRAMES)]
    actual_names = [Path(path).name for path in frame_paths]
    if actual_names != expected_names:
        failures.append("frame names are not sequential frame_000.png ... frame_015.png")
    if any(metric.get("empty_alpha") for metric in metrics):
        failures.append("one or more frames have empty alpha")
    if any(image.mode != "RGBA" for image in frames):
        failures.append("one or more frames are not RGBA")
    canvases = {tuple(metric["canvas"]) for metric in metrics}
    if len(canvases) != 1:
        failures.append("frames do not share the same canvas size")
    if any((not metric.get("empty_alpha")) and metric["edge_margin_min"] < EDGE_MARGIN_PX for metric in metrics):
        failures.append(f"non-transparent pixels are within {EDGE_MARGIN_PX}px of the canvas edge")

    heights = [metric["visible_height"] for metric in metrics if not metric.get("empty_alpha")]
    baselines = [metric["foot_baseline_y"] for metric in metrics if not metric.get("empty_alpha")]
    roots = [metric["root_x"] for metric in metrics if not metric.get("empty_alpha")]
    areas = [metric["alpha_area"] for metric in metrics if not metric.get("empty_alpha")]
    if heights:
        mean_height = statistics.mean(heights)
        height_drift = (max(heights) - min(heights)) / max(1, mean_height)
        if height_drift > HEIGHT_DRIFT_RATIO_LIMIT:
            failures.append(f"visual height drift {height_drift:.4f} exceeds {HEIGHT_DRIFT_RATIO_LIMIT:.4f}")
    if baselines and max(baselines) - min(baselines) > BASELINE_DRIFT_LIMIT_PX:
        failures.append(f"foot baseline drift exceeds {BASELINE_DRIFT_LIMIT_PX}px")
    if roots and max(roots) - min(roots) > ROOT_X_DRIFT_LIMIT_PX:
        failures.append(f"root x drift exceeds {ROOT_X_DRIFT_LIMIT_PX}px")

    diffs = [masked_diff_ratio(frames[index], frames[(index + 1) % len(frames)]) for index in range(len(frames))]
    median_diff = statistics.median(diffs) if diffs else 0
    if median_diff > 0 and max(diffs) > median_diff * DIFF_SPIKE_MULTIPLIER:
        failures.append(f"temporal diff spike exceeds {DIFF_SPIKE_MULTIPLIER}x median")
    if any(value == 0 for value in diffs):
        failures.append("duplicate consecutive frame detected")
    area_deltas = [
        abs(areas[index] - areas[(index + 1) % len(areas)]) / max(1, statistics.mean(areas))
        for index in range(len(areas))
    ] if areas else []
    if area_deltas:
        median_area_delta = statistics.median(area_deltas)
        if median_area_delta > 0 and max(area_deltas) > median_area_delta * DIFF_SPIKE_MULTIPLIER:
            warnings.append("alpha area temporal spike warning")
        if median_area_delta > 0 and max(area_deltas) > median_area_delta * 6 and max(area_deltas) > 0.25:
            failures.append("alpha area temporal spike detected")

    return {
        "status": "PASSED" if not failures else "FAILED",
        "failures": failures,
        "warnings": warnings,
        "frame_metrics": metrics,
        "summary": {
            "height_min": min(heights) if heights else None,
            "height_max": max(heights) if heights else None,
            "height_drift_ratio": ((max(heights) - min(heights)) / max(1, statistics.mean(heights))) if heights else None,
            "baseline_min": min(baselines) if baselines else None,
            "baseline_max": max(baselines) if baselines else None,
            "root_x_min": min(roots) if roots else None,
            "root_x_max": max(roots) if roots else None,
            "edge_margin_min": min(metric["edge_margin_min"] for metric in metrics if not metric.get("empty_alpha"))
            if metrics
            else None,
            "median_consecutive_diff": median_diff,
            "max_consecutive_diff": max(diffs) if diffs else None,
            "loop_seam_diff": diffs[-1] if diffs else None,
            "median_area_delta": statistics.median(area_deltas) if area_deltas else None,
            "max_area_delta": max(area_deltas) if area_deltas else None,
        },
        "consecutive_diff_ratios": diffs,
        "area_delta_ratios": area_deltas,
    }


def checkerboard(size, block=16):
    width, height = size
    image = Image.new("RGB", size, (235, 235, 235))
    draw = ImageDraw.Draw(image)
    for y in range(0, height, block):
        for x in range(0, width, block):
            if ((x // block) + (y // block)) % 2:
                draw.rectangle((x, y, x + block - 1, y + block - 1), fill=(210, 210, 210))
    return image


def composite_preview(frame, scale=0.4, label=None):
    width = max(1, int(round(frame.width * scale)))
    height = max(1, int(round(frame.height * scale)))
    background = checkerboard((width, height))
    resized = frame.resize((width, height), Image.Resampling.LANCZOS)
    background.paste(resized, (0, 0), resized.getchannel("A"))
    if label:
        draw = ImageDraw.Draw(background)
        draw.rectangle((2, height - 16, 62, height - 2), fill=(255, 255, 255))
        draw.text((5, height - 14), label, fill=(0, 0, 0), font=ImageFont.load_default())
    return background


def write_contact_sheet(frames, path):
    thumb_scale = 0.35
    thumbs = [composite_preview(frame, scale=thumb_scale, label=f"{index:03d}") for index, frame in enumerate(frames)]
    thumb_w, thumb_h = thumbs[0].size
    sheet = Image.new("RGB", (thumb_w * 4, thumb_h * 4), (245, 245, 245))
    for index, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((index % 4) * thumb_w, (index // 4) * thumb_h))
    ensure_dir(path.parent)
    sheet.save(path)


def write_alignment_overlay(frames, path, baseline_y, root_x):
    overlay = Image.new("RGBA", frames[0].size, (0, 0, 0, 0))
    palette = [
        (37, 99, 235),
        (5, 150, 105),
        (220, 38, 38),
        (147, 51, 234),
        (217, 119, 6),
        (8, 145, 178),
    ]
    for index, frame in enumerate(frames):
        alpha = frame.getchannel("A").point(lambda value: min(42, value // 5), mode="L")
        color = palette[index % len(palette)]
        tint = Image.new("RGBA", frame.size, (*color, 0))
        tint.putalpha(alpha)
        overlay.alpha_composite(tint)
    draw = ImageDraw.Draw(overlay)
    draw.line((0, baseline_y, overlay.width, baseline_y), fill=(255, 0, 0, 180), width=1)
    draw.line((root_x, 0, root_x, overlay.height), fill=(0, 128, 255, 180), width=1)
    ensure_dir(path.parent)
    overlay.save(path)


def write_preview_gif(frames, path, fps=DEFAULT_FPS):
    preview_frames = [composite_preview(frame, scale=0.6) for frame in frames]
    duration = int(round(1000 / max(1, fps)))
    ensure_dir(path.parent)
    preview_frames[0].save(path, save_all=True, append_images=preview_frames[1:], duration=duration, loop=0)


def load_approved_walk_frames(root, clip_id):
    directory = root / "Assets/CharacterV2/approved/clips" / clip_id
    paths = sorted(directory.glob("frame_*.png"))
    return [Image.open(path).convert("RGBA") for path in paths]


def write_before_after_gif(before_frames, after_frames, path, fps=DEFAULT_FPS):
    frames = []
    for index in range(min(len(before_frames), len(after_frames))):
        before = composite_preview(before_frames[index], scale=0.45, label=f"old {index:03d}")
        after = composite_preview(after_frames[index], scale=0.45, label=f"new {index:03d}")
        combined = Image.new("RGB", (before.width + after.width + 12, max(before.height, after.height)), (245, 245, 245))
        combined.paste(before, (0, 0))
        combined.paste(after, (before.width + 12, 0))
        frames.append(combined)
    if not frames:
        return False
    duration = int(round(1000 / max(1, fps)))
    ensure_dir(path.parent)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=duration, loop=0)
    return True


def save_frames(frames, directory):
    ensure_dir(directory)
    paths = []
    for index, frame in enumerate(frames):
        path = directory / f"frame_{index:03d}.png"
        frame.save(path)
        paths.append(path)
    return paths


def mirror_frames(frames):
    return [ImageOps.mirror(frame) for frame in frames]


def clip_metrics(root, clip_id):
    paths = sorted((root / "Assets/CharacterV2/approved/clips" / clip_id).glob("frame_*.png"))
    frames = [Image.open(path).convert("RGBA") for path in paths]
    return validate_clip(frames, paths) if frames else {"status": "MISSING", "failures": ["no frames"]}


def read_manifest_walk_info(root):
    manifest_path = root / "Assets/CharacterV2/manifests/character_v2_manifest.json"
    manifest = load_json(manifest_path)
    clips = {clip["id"]: clip for clip in manifest.get("clips", [])}
    return manifest, clips


def write_audit(root, audit_dir, metadata, current_metrics):
    manifest, clips = read_manifest_walk_info(root)
    right = clips.get("walk_right", {})
    left = clips.get("walk_left", {})
    right_summary = current_metrics.get("walk_right", {}).get("summary", {})
    left_summary = current_metrics.get("walk_left", {}).get("summary", {})
    lines = [
        "# Walk Right Reference Asset Audit",
        "",
        f"generated_at: {datetime.now().isoformat(timespec='seconds')}",
        "",
        "## Current approved frame dimensions",
        "",
        f"- walk_right: {right_summary.get('height_min')}..{right_summary.get('height_max')} visible height on 384x512 canvas",
        f"- walk_left: {left_summary.get('height_min')}..{left_summary.get('height_max')} visible height on 384x512 canvas",
        f"- source video: {metadata.get('video', {}).get('width')}x{metadata.get('video', {}).get('height')}, fps {metadata.get('video', {}).get('fps')}, frames {metadata.get('video', {}).get('frame_count')}",
        "",
        "## Current clip frame count",
        "",
        f"- walk_right manifest frames: {len(right.get('frames', []))}",
        f"- walk_left manifest frames: {len(left.get('frames', []))}",
        f"- walk fps: {right.get('fps')}",
        "",
        "## Current runtime scale policy",
        "",
        f"- manifest canonicalScale: {manifest.get('character', {}).get('canonicalScale')}",
        "- approved runtime canvas: 384x512",
        "- normalization target: visual height 464 px, foot baseline y 488, root x 192",
        "- runtime movement must come from the window/pet locomotion controller, not encoded per-frame sprite translation",
        "",
        "## Current known acceptance thresholds",
        "",
        f"- frame count: exactly {EXPECTED_FRAMES}",
        "- dimensions: identical RGBA PNG frames",
        f"- edge margin: >= {EDGE_MARGIN_PX}px",
        f"- visual height drift: <= {HEIGHT_DRIFT_RATIO_LIMIT * 100:.1f}% of mean height",
        f"- foot baseline drift: <= {BASELINE_DRIFT_LIMIT_PX}px",
        f"- root x drift: <= {ROOT_X_DRIFT_LIMIT_PX}px",
        f"- temporal diff spike: <= {DIFF_SPIKE_MULTIPLIER}x median",
        "",
        "## walk_left derivation/storage",
        "",
        f"- manifest note: {left.get('notes')}",
        "- current policy for this build: derive walk_left by horizontal mirror of normalized walk_right, then validate both clips.",
    ]
    path = audit_dir / "ANIMATION_ASSET_AUDIT.md"
    ensure_dir(path.parent)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def integrate_approved(root, right_frames, left_frames):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    approved_root = root / "Assets/CharacterV2/approved/clips"
    backup_paths = {}
    for clip_id, frames in (("walk_right", right_frames), ("walk_left", left_frames)):
        current_dir = approved_root / clip_id
        backup_dir = approved_root / f"{clip_id}_legacy_{timestamp}"
        if current_dir.exists():
            shutil.copytree(current_dir, backup_dir)
            backup_paths[clip_id] = str(backup_dir)
        ensure_dir(current_dir)
        save_frames(frames, current_dir)
    return backup_paths


def report_lines(metrics):
    summary = metrics.get("summary", {})
    failures = metrics.get("failures", [])
    warnings = metrics.get("warnings", [])
    lines = [
        f"- status: {metrics.get('status')}",
        f"- height: {summary.get('height_min')}..{summary.get('height_max')}, drift ratio {summary.get('height_drift_ratio')}",
        f"- baseline: {summary.get('baseline_min')}..{summary.get('baseline_max')}",
        f"- root_x: {summary.get('root_x_min')}..{summary.get('root_x_max')}",
        f"- min edge margin: {summary.get('edge_margin_min')}",
        f"- median consecutive diff: {summary.get('median_consecutive_diff')}",
        f"- loop seam diff: {summary.get('loop_seam_diff')}",
    ]
    if failures:
        lines.append(f"- failures: {'; '.join(failures)}")
    if warnings:
        lines.append(f"- warnings: {'; '.join(warnings)}")
    return lines


def write_report(path, payload):
    metadata = payload["source_metadata"]
    loop = payload["loop"]
    validation = payload["validation"]
    integrated = payload.get("runtime_integration", {})
    lines = [
        "# Walk Right Reference Build Report",
        "",
        f"generated_at: {payload['generated_at']}",
        f"final_status: {payload['final_status']}",
        "",
        "## Source video metadata",
        "",
        f"- path: {metadata.get('source_video')}",
        f"- width: {metadata.get('video', {}).get('width')}",
        f"- height: {metadata.get('video', {}).get('height')}",
        f"- fps: {metadata.get('video', {}).get('fps')}",
        f"- frame_count: {metadata.get('video', {}).get('frame_count')}",
        f"- duration_seconds: {metadata.get('video', {}).get('duration_seconds')}",
        "",
        "## Loop selection",
        "",
        f"- mode: {loop.get('mode')}",
        f"- selected loop frame range: {loop.get('start')}..{loop.get('end')}",
        f"- selected 16 source frame indices: {payload['selected_source_indices']}",
        f"- seam diff: {loop.get('seam_diff')}",
        "",
        "## Normalization",
        "",
        f"- target canvas size: {payload['normalization']['target_canvas']}",
        f"- target foot baseline y: {payload['normalization']['baseline_y']}",
        f"- target visual height: {payload['normalization']['target_height']}",
        f"- target root x: {payload['normalization']['root_x']}",
        "- image-to-image regeneration: skipped; no configured image-to-image pipeline was found or used",
        "",
        "## Validation results",
        "",
        "### walk_right",
        *report_lines(validation["walk_right"]),
        "",
        "### walk_left",
        *report_lines(validation["walk_left"]),
        "",
        "## Runtime integration",
        "",
        f"- integrated: {integrated.get('integrated', False)}",
        f"- approved for runtime integration: {payload.get('approved_for_runtime_integration', False)}",
        f"- backups: {integrated.get('backups', {})}",
        "",
        "## Generated outputs",
        "",
        f"- walk_right frames: {payload['outputs']['walk_right_dir']}",
        f"- walk_left frames: {payload['outputs']['walk_left_dir']}",
        f"- contact sheet: {payload['outputs']['contact_sheet']}",
        f"- alignment overlay: {payload['outputs']['alignment_overlay']}",
        f"- preview GIF: {payload['outputs']['preview_gif']}",
        f"- before/after GIF: {payload['outputs']['before_after_gif']}",
        f"- metrics JSON: {payload['outputs']['metrics_json']}",
        "",
        "## Remaining visual risks",
        "",
        "- Human review should confirm identity details: face, hair clip, side ponytail, jacket/skirt trim, boots, and accessories.",
        "- Human review should confirm the step reads as a natural in-place right walk and not as foot sliding.",
        "- Human review should confirm frame 15 transitions cleanly back to frame 0 at runtime speed.",
    ]
    ensure_dir(path.parent)
    path.write_text("\n".join(str(line) for line in lines) + "\n", encoding="utf-8")


def build(args):
    root = Path(__file__).resolve().parents[1]
    raw_dir = root / args.raw_dir
    review_dir = root / args.review_dir
    audit_dir = root / args.audit_dir
    metadata_path = raw_dir / "metadata.json"
    metadata = load_json(metadata_path) if metadata_path.exists() else {}
    paths = raw_frame_paths(raw_dir)
    if len(paths) < EXPECTED_FRAMES:
        return fail(f"expected at least {EXPECTED_FRAMES} raw frames, found {len(paths)} in {raw_dir}")

    target_canvas = (args.canvas_width, args.canvas_height)
    current_metrics = {
        "walk_right": clip_metrics(root, "walk_right"),
        "walk_left": clip_metrics(root, "walk_left"),
    }
    audit_path = write_audit(root, audit_dir, metadata, current_metrics)

    segmented_records = [segment_character(path, args.segment_threshold) for path in paths]
    normalized_all = []
    normalization_trace_all = []
    for record in segmented_records:
        frame, trace = normalize_segmented_frame(
            record["segmented"],
            target_canvas,
            args.target_height,
            args.baseline_y,
            args.root_x,
        )
        normalized_all.append(frame)
        normalization_trace_all.append(trace)

    loop = detect_loop(normalized_all, min_loop_source_frames=args.min_loop_source_frames)
    selected_indices = sample_loop_indices(loop)
    right_frames = [normalized_all[index] for index in selected_indices]
    left_frames = mirror_frames(right_frames)

    right_dir = review_dir / "walk_right"
    left_dir = review_dir / "walk_left"
    right_paths = save_frames(right_frames, right_dir)
    left_paths = save_frames(left_frames, left_dir)

    validation = {
        "walk_right": validate_clip(right_frames, right_paths),
        "walk_left": validate_clip(left_frames, left_paths),
    }
    validation_passed = validation["walk_right"]["status"] == "PASSED" and validation["walk_left"]["status"] == "PASSED"

    contact_sheet = review_dir / "walk_right_contact_sheet.png"
    alignment_overlay = review_dir / "walk_right_alignment_overlay.png"
    preview_gif = review_dir / "walk_right_preview.gif"
    before_after_gif = review_dir / "walk_right_before_after.gif"
    write_contact_sheet(right_frames, contact_sheet)
    write_alignment_overlay(right_frames, alignment_overlay, args.baseline_y, args.root_x)
    write_preview_gif(right_frames, preview_gif, fps=args.fps)
    before_frames = load_approved_walk_frames(root, "walk_right")
    before_after_written = write_before_after_gif(before_frames, right_frames, before_after_gif, fps=args.fps)

    runtime_integration = {
        "integrated": False,
        "backups": {},
        "reason": None,
    }
    if args.integrate_approved:
        if validation_passed:
            runtime_integration["backups"] = integrate_approved(root, right_frames, left_frames)
            runtime_integration["integrated"] = True
        else:
            runtime_integration["reason"] = "validation failed; approved assets were not changed"

    final_status = "TECHNICAL_PASS"
    if not validation_passed:
        final_status = "FAILED_VALIDATION"
    elif runtime_integration["integrated"]:
        final_status = "TECHNICAL_PASS_RUNTIME_INTEGRATED_PENDING_HUMAN_VISUAL_ACCEPTANCE"
    elif args.integrate_approved:
        final_status = "TECHNICAL_PASS_NOT_INTEGRATED"

    output_payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "final_status": final_status,
        "source_metadata": metadata,
        "source_raw_frame_count": len(paths),
        "segmentation": {
            "threshold": args.segment_threshold,
            "frames": [
                {
                    "path": record["path"],
                    "background_rgb_median": record["background_rgb_median"],
                    "raw_mask_pixels": record["raw_mask_pixels"],
                    "largest_component_pixels": record["largest_component_pixels"],
                    "metric": record["metric"],
                }
                for record in segmented_records
            ],
        },
        "loop": loop,
        "selected_source_indices": selected_indices,
        "normalization": {
            "target_canvas": list(target_canvas),
            "target_height": args.target_height,
            "baseline_y": args.baseline_y,
            "root_x": args.root_x,
            "min_loop_source_frames": args.min_loop_source_frames,
            "trace_all_raw_frames": normalization_trace_all,
        },
        "validation": validation,
        "approved_for_runtime_integration": validation_passed,
        "runtime_integration": runtime_integration,
        "outputs": {
            "audit": str(audit_path),
            "walk_right_dir": str(right_dir),
            "walk_left_dir": str(left_dir),
            "contact_sheet": str(contact_sheet),
            "alignment_overlay": str(alignment_overlay),
            "preview_gif": str(preview_gif),
            "before_after_gif": str(before_after_gif) if before_after_written else None,
            "metrics_json": str(review_dir / "metrics.json"),
            "report": str(review_dir / REPORT_NAME),
        },
    }

    metrics_path = review_dir / "metrics.json"
    write_json(metrics_path, output_payload)
    write_report(review_dir / REPORT_NAME, output_payload)
    print(f"FINAL_STATUS={final_status}")
    print(f"Wrote metrics: {metrics_path}")
    print(f"Wrote report: {review_dir / REPORT_NAME}")
    if runtime_integration["integrated"]:
        print(f"Integrated approved clips with backups: {runtime_integration['backups']}")
    return 0 if validation_passed else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a deterministic 16-frame CharacterV2 walk clip from raw reference frames.")
    parser.add_argument("--raw-dir", default="Assets/CharacterV2/candidates/walk_right_reference_raw")
    parser.add_argument("--review-dir", default="Assets/CharacterV2/review/walk_right_reference_build")
    parser.add_argument("--audit-dir", default="Assets/CharacterV2/review/walk_right_reference_audit")
    parser.add_argument("--canvas-width", type=int, default=DEFAULT_CANVAS[0])
    parser.add_argument("--canvas-height", type=int, default=DEFAULT_CANVAS[1])
    parser.add_argument("--target-height", type=int, default=DEFAULT_TARGET_HEIGHT)
    parser.add_argument("--baseline-y", type=int, default=DEFAULT_BASELINE_Y)
    parser.add_argument("--root-x", type=int, default=DEFAULT_ROOT_X)
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    parser.add_argument("--segment-threshold", type=int, default=SEGMENT_DISTANCE_THRESHOLD)
    parser.add_argument("--min-loop-source-frames", type=int, default=MIN_LOOP_SOURCE_FRAMES)
    parser.add_argument("--integrate-approved", action="store_true")
    args = parser.parse_args(argv)
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
