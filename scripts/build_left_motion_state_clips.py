#!/usr/bin/env python3
import argparse
import json
import math
import statistics
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps


ALPHA_THRESHOLD = 16
CANVAS = (384, 512)
TARGET_HEIGHT = 464
BASELINE_Y = 488
ROOT_X = 192
FPS = 10
EDGE_MARGIN_PX = 8
HEIGHT_DRIFT_LIMIT = 0.02
BASELINE_DRIFT_LIMIT_PX = 1
ROOT_X_DRIFT_LIMIT_PX = 1

CLIP_FRAME_COUNTS = {
    "idle_front": 6,
    "turn_front_to_left": 6,
    "walk_left_loop": 16,
    "walk_left_to_stop": 6,
    "turn_left_to_front": 6,
    "idle_left": 6,
}


def ensure_dir(path):
    path.mkdir(parents=True, exist_ok=True)


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def alpha_bbox(image):
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    return mask.getbbox()


def crop_alpha(image):
    bbox = alpha_bbox(image)
    if bbox is None:
        raise ValueError("empty alpha")
    return image.crop(bbox), bbox


def normalize_to_canvas(image, target_height=TARGET_HEIGHT, root_x=ROOT_X, baseline_y=BASELINE_Y):
    rgba = image.convert("RGBA")
    crop, bbox = crop_alpha(rgba)
    visible_height = bbox[3] - bbox[1]
    scale = target_height / max(1, visible_height)
    resized = crop.resize(
        (
            max(1, int(round(crop.width * scale))),
            max(1, int(round(crop.height * scale))),
        ),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    x = int(round(root_x - resized.width / 2))
    y = int(round(baseline_y - resized.height + 1))
    canvas.alpha_composite(resized, (x, y))
    return canvas


def scale_about_baseline(image, scale_x=1.0, scale_y=1.0, opacity=1.0, x_shift=0):
    crop, bbox = crop_alpha(image.convert("RGBA"))
    height = bbox[3] - bbox[1]
    scale = TARGET_HEIGHT / max(1, height)
    target_w = max(1, int(round(crop.width * scale * scale_x)))
    target_h = max(1, int(round(crop.height * scale * scale_y)))
    resized = crop.resize((target_w, target_h), Image.Resampling.LANCZOS)
    if opacity < 1:
        alpha = resized.getchannel("A").point(lambda value: int(round(value * max(0, min(1, opacity)))))
        resized.putalpha(alpha)
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    x = int(round(ROOT_X + x_shift - resized.width / 2))
    y = int(round(BASELINE_Y - resized.height + 1))
    canvas.alpha_composite(resized, (x, y))
    return canvas


def premultiplied_blend(first, second, ratio):
    ratio = max(0, min(1, ratio))
    return Image.blend(first.convert("RGBA"), second.convert("RGBA"), ratio)


def composite_turn(front, side, ratio, reverse=False):
    if reverse:
        if ratio <= 0:
            return side.copy()
        if ratio >= 1:
            return front.copy()
        source_a = side
        source_b = front
    else:
        if ratio <= 0:
            return front.copy()
        if ratio >= 1:
            return side.copy()
        source_a = front
        source_b = side
    if ratio < 0.5:
        local = ratio / 0.5
        return scale_about_baseline(
            source_a,
            scale_x=max(0.34, 1.0 - 0.58 * local),
            scale_y=1.0 - 0.006 * math.sin(math.pi * ratio),
            opacity=1.0,
            x_shift=-3 * local if not reverse else 3 * local,
        )
    local = (ratio - 0.5) / 0.5
    return scale_about_baseline(
        source_b,
        scale_x=0.42 + 0.58 * local,
        scale_y=1.0,
        opacity=1.0,
        x_shift=3 * (1.0 - local) if not reverse else -3 * (1.0 - local),
    )


def breathing_frames(base, count):
    values = [0.0, 0.45, 0.9, 0.45, 0.0, -0.25]
    frames = []
    for index in range(count):
        phase = values[index % len(values)]
        frames.append(
            scale_about_baseline(
                base,
                scale_x=1.0 - 0.004 * phase,
                scale_y=1.0 + 0.006 * phase,
                opacity=1.0,
            )
        )
    return frames


def load_walk_left_frames(root):
    directory = root / "Assets/CharacterV2/approved/clips/walk_left"
    paths = sorted(directory.glob("frame_*.png"))
    if len(paths) != 16:
        raise ValueError(f"expected 16 approved walk_left frames in {directory}, found {len(paths)}")
    return [Image.open(path).convert("RGBA") for path in paths]


def make_clips(root, identity_reference):
    front = normalize_to_canvas(Image.open(identity_reference).convert("RGBA"))
    walk = [normalize_to_canvas(frame) for frame in load_walk_left_frames(root)]
    left_stand = walk[8]

    idle_front = breathing_frames(front, CLIP_FRAME_COUNTS["idle_front"])
    idle_left = breathing_frames(left_stand, CLIP_FRAME_COUNTS["idle_left"])
    turn_front_to_left = [
        composite_turn(front, walk[0], ratio)
        for ratio in (0.0, 0.18, 0.38, 0.62, 0.84, 1.0)
    ]
    walk_left_loop = walk
    walk_left_to_stop = [
        walk[15],
        walk[0],
        walk[2],
        walk[4],
        walk[6],
        left_stand,
    ]
    turn_left_to_front = [
        composite_turn(front, left_stand, ratio, reverse=True)
        for ratio in (0.0, 0.18, 0.38, 0.62, 0.84, 1.0)
    ]

    return {
        "idle_front": idle_front,
        "turn_front_to_left": turn_front_to_left,
        "walk_left_loop": walk_left_loop,
        "walk_left_to_stop": walk_left_to_stop,
        "turn_left_to_front": turn_left_to_front,
        "idle_left": idle_left,
    }


def frame_metric(image, path, index):
    bbox = alpha_bbox(image)
    record = {
        "frame_index": index,
        "path": str(path),
        "mode": image.mode,
        "canvas": list(image.size),
        "empty_alpha": bbox is None,
    }
    if bbox is None:
        return record
    left, top, right, bottom = bbox
    alpha = image.getchannel("A")
    area = sum(alpha.histogram()[ALPHA_THRESHOLD + 1 :])
    record.update(
        {
            "bbox": [left, top, right, bottom],
            "visible_width": right - left,
            "visible_height": bottom - top,
            "baseline_y": bottom - 1,
            "root_x": (left + right) / 2,
            "edge_margin_min": min(left, top, image.width - right, image.height - bottom),
            "alpha_area": area,
        }
    )
    return record


def diff_ratio(first, second):
    first_rgba = first.convert("RGBA")
    second_rgba = second.convert("RGBA")
    first_mask = first_rgba.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="L")
    second_mask = second_rgba.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="L")
    union = ImageChops.lighter(first_mask, second_mask)
    union_hist = union.histogram()
    area = sum(count for value, count in enumerate(union_hist) if value > 0)
    if area <= 0:
        return 0
    diff = ImageChops.difference(first_rgba, second_rgba).convert("L")
    masked = ImageChops.multiply(diff, union)
    return sum(masked.histogram()[value] * value for value in range(256)) / max(1, area * 255)


def validate_clip(name, frames, paths, loop=False):
    failures = []
    warnings = []
    expected_count = CLIP_FRAME_COUNTS[name]
    if len(frames) != expected_count:
        failures.append(f"frame count {len(frames)} != {expected_count}")
    expected_names = [f"frame_{index:03d}.png" for index in range(expected_count)]
    actual_names = [path.name for path in paths]
    if actual_names != expected_names:
        failures.append("frame names are not sequential")
    metrics = [frame_metric(frame, paths[index], index) for index, frame in enumerate(frames)]
    if any(metric["mode"] != "RGBA" for metric in metrics):
        failures.append("one or more frames are not RGBA")
    if any(metric["canvas"] != list(CANVAS) for metric in metrics):
        failures.append("one or more frames have wrong canvas size")
    if any(metric["empty_alpha"] for metric in metrics):
        failures.append("one or more frames have empty alpha")
    visible = [metric for metric in metrics if not metric["empty_alpha"]]
    heights = [metric["visible_height"] for metric in visible]
    baselines = [metric["baseline_y"] for metric in visible]
    roots = [metric["root_x"] for metric in visible]
    if visible and min(metric["edge_margin_min"] for metric in visible) < EDGE_MARGIN_PX:
        failures.append(f"non-transparent pixels are within {EDGE_MARGIN_PX}px of an edge")
    if heights:
        height_drift = (max(heights) - min(heights)) / max(1, statistics.mean(heights))
        if height_drift > HEIGHT_DRIFT_LIMIT:
            failures.append(f"height drift {height_drift:.4f} > {HEIGHT_DRIFT_LIMIT:.4f}")
    if baselines and max(baselines) - min(baselines) > BASELINE_DRIFT_LIMIT_PX:
        failures.append("baseline drift exceeds 1px")
    if roots and max(roots) - min(roots) > ROOT_X_DRIFT_LIMIT_PX:
        warnings.append("root x drift warning; transition silhouettes may widen during turn")
    diffs = [diff_ratio(frames[index], frames[(index + 1) % len(frames)]) for index in range(len(frames))]
    return {
        "status": "PASSED" if not failures else "FAILED",
        "failures": failures,
        "warnings": warnings,
        "loop": loop,
        "summary": {
            "frame_count": len(frames),
            "canvas": list(CANVAS),
            "height_min": min(heights) if heights else None,
            "height_max": max(heights) if heights else None,
            "height_drift_ratio": ((max(heights) - min(heights)) / max(1, statistics.mean(heights))) if heights else None,
            "baseline_min": min(baselines) if baselines else None,
            "baseline_max": max(baselines) if baselines else None,
            "root_x_min": min(roots) if roots else None,
            "root_x_max": max(roots) if roots else None,
            "edge_margin_min": min(metric["edge_margin_min"] for metric in visible) if visible else None,
            "median_consecutive_diff": statistics.median(diffs) if diffs else None,
            "max_consecutive_diff": max(diffs) if diffs else None,
            "loop_seam_diff": diffs[-1] if loop and diffs else None,
        },
        "frames": metrics,
        "consecutive_diff_ratios": diffs,
    }


def checkerboard(size, block=16):
    image = Image.new("RGB", size, (236, 236, 236))
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], block):
        for x in range(0, size[0], block):
            if (x // block + y // block) % 2:
                draw.rectangle((x, y, x + block - 1, y + block - 1), fill=(214, 214, 214))
    return image


def preview_frame(frame, scale=0.42, label=None):
    size = (int(round(frame.width * scale)), int(round(frame.height * scale)))
    bg = checkerboard(size)
    small = frame.resize(size, Image.Resampling.LANCZOS)
    bg.paste(small, (0, 0), small.getchannel("A"))
    if label is not None:
        draw = ImageDraw.Draw(bg)
        draw.rectangle((2, size[1] - 16, 70, size[1] - 2), fill=(255, 255, 255))
        draw.text((5, size[1] - 14), label, fill=(0, 0, 0), font=ImageFont.load_default())
    return bg


def write_contact_sheet(name, frames, path):
    columns = 4
    thumbs = [preview_frame(frame, label=f"{index:03d}") for index, frame in enumerate(frames)]
    thumb_w, thumb_h = thumbs[0].size
    rows = math.ceil(len(thumbs) / columns)
    sheet = Image.new("RGB", (thumb_w * columns, thumb_h * rows), (245, 245, 245))
    for index, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((index % columns) * thumb_w, (index // columns) * thumb_h))
    ensure_dir(path.parent)
    sheet.save(path)


def write_state_machine_overview(clips, path):
    sequence = [
        ("idle_front", (0, 3, 5)),
        ("turn_front_to_left", (0, 2, 5)),
        ("walk_left_loop", (0, 4, 8, 12, 15)),
        ("walk_left_to_stop", (0, 2, 5)),
        ("turn_left_to_front", (0, 2, 5)),
        ("idle_front", (0, 3, 5)),
    ]
    scale = 0.32
    cell_w = int(round(CANVAS[0] * scale))
    cell_h = int(round(CANVAS[1] * scale))
    label_h = 22
    gap = 10
    columns = max(len(indices) for _name, indices in sequence)
    panel_w = columns * cell_w
    width = len(sequence) * panel_w + (len(sequence) - 1) * gap
    height = label_h + cell_h
    overview = Image.new("RGB", (width, height), (245, 245, 245))
    draw = ImageDraw.Draw(overview)
    font = ImageFont.load_default()
    x = 0
    for clip_name, indices in sequence:
        draw.rectangle((x, 0, x + panel_w - 1, label_h - 1), fill=(255, 255, 255))
        draw.text((x + 4, 6), clip_name, fill=(0, 0, 0), font=font)
        for column, frame_index in enumerate(indices):
            thumb = preview_frame(clips[clip_name][frame_index], scale=scale, label=f"{frame_index:03d}")
            overview.paste(thumb, (x + column * cell_w, label_h))
        x += panel_w + gap
    ensure_dir(path.parent)
    overview.save(path)


def write_preview_gif(frames, path, fps=FPS):
    preview_frames = [preview_frame(frame, scale=0.58) for frame in frames]
    duration = int(round(1000 / fps))
    ensure_dir(path.parent)
    preview_frames[0].save(path, save_all=True, append_images=preview_frames[1:], duration=duration, loop=0)


def write_alignment_overlay(clips, path):
    overlay = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    colors = [(59, 130, 246), (16, 185, 129), (239, 68, 68), (168, 85, 247), (245, 158, 11)]
    index = 0
    for frames in clips.values():
        for frame in frames:
            alpha = frame.getchannel("A").point(lambda value: min(32, value // 7), mode="L")
            tint = Image.new("RGBA", CANVAS, (*colors[index % len(colors)], 0))
            tint.putalpha(alpha)
            overlay.alpha_composite(tint)
            index += 1
    draw = ImageDraw.Draw(overlay)
    draw.line((0, BASELINE_Y, CANVAS[0], BASELINE_Y), fill=(255, 0, 0, 190), width=1)
    draw.line((ROOT_X, 0, ROOT_X, CANVAS[1]), fill=(0, 120, 255, 190), width=1)
    ensure_dir(path.parent)
    overlay.save(path)


def save_frames(frames, directory):
    ensure_dir(directory)
    paths = []
    for index, frame in enumerate(frames):
        path = directory / f"frame_{index:03d}.png"
        frame.save(path)
        paths.append(path)
    return paths


def write_candidate_manifest_patch(path):
    clips = []
    for name, count in CLIP_FRAME_COUNTS.items():
        clips.append(
            {
                "id": name,
                "stateCandidate": name,
                "fps": FPS,
                "loop": name in {"idle_front", "walk_left_loop", "idle_left"},
                "frameCount": count,
                "frames": [f"frame_{index:03d}" for index in range(count)],
                "runtimeMappingCandidate": {
                    "idle_front": "idle",
                    "turn_front_to_left": "startMovingLeft",
                    "walk_left_loop": "walkLeft",
                    "walk_left_to_stop": "stopMovingLeft",
                    "turn_left_to_front": "requires new transition state or stop-to-idle transition hook",
                    "idle_left": "optional facing-left idle",
                }[name],
            }
        )
    payload = {
        "status": "CANDIDATE_ONLY_NOT_APPROVED",
        "notes": "Do not merge into approved manifest until human visual acceptance.",
        "clips": clips,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_report(path, payload):
    validation = payload["validation"]
    lines = [
        "# Left Motion Image2 Candidate Build Report",
        "",
        f"generated_at: {payload['generated_at']}",
        f"final_status: {payload['final_status']}",
        "",
        "## Inputs",
        "",
        f"- canonical identity reference: {payload['inputs']['identity_reference']}",
        f"- motion reference: {payload['inputs']['motion_reference']}",
        f"- image2_refinement: {payload['image2']['status']}",
        f"- image2_parameters: {payload['image2']['parameters']}",
        "",
        "## Technical Specs",
        "",
        f"- canvas: {payload['technical_specs']['canvas']}",
        f"- fps: {payload['technical_specs']['fps']}",
        f"- baseline_y: {payload['technical_specs']['baseline_y']}",
        f"- root_x: {payload['technical_specs']['root_x']}",
        f"- visual_height: {payload['technical_specs']['visual_height']}",
        "",
        "## Clip Validation",
        "",
    ]
    for clip_id, result in validation.items():
        summary = result["summary"]
        lines.extend(
            [
                f"### {clip_id}",
                f"- status: {result['status']}",
                f"- frames: {summary['frame_count']}",
                f"- height: {summary['height_min']}..{summary['height_max']}, drift={summary['height_drift_ratio']}",
                f"- baseline: {summary['baseline_min']}..{summary['baseline_max']}",
                f"- root_x: {summary['root_x_min']}..{summary['root_x_max']}",
                f"- edge_margin_min: {summary['edge_margin_min']}",
                f"- loop_seam_diff: {summary['loop_seam_diff']}",
                f"- failures: {result['failures']}",
                f"- warnings: {result['warnings']}",
                "",
            ]
        )
    lines.extend(
        [
            "## Transition Seams",
            "",
        ]
    )
    for name, value in payload["transition_seams"].items():
        lines.append(f"- {name}: {value}")
    lines.extend(
        [
            "",
            "## Runtime Integration",
            "",
            "- status: NOT_INTEGRATED_APPROVAL_REQUIRED",
            "- Current runtime can already represent startMovingLeft -> walkLeft -> stopMovingLeft.",
            "- turn_left_to_front needs a dedicated transition hook before approved runtime integration.",
            "- Sprite frames remain in-place; desktop movement stays owned by the window/pet position controller.",
            "",
            "## Human Visual Acceptance Checklist",
            "",
            "- Confirm front idle identity is the same character.",
            "- Confirm turn_front_to_left reads as a natural turn, not a crossfade artifact.",
            "- Confirm walk_left_loop is acceptable as an in-place loop.",
            "- Confirm walk_left_to_stop settles naturally.",
            "- Confirm turn_left_to_front returns to front without identity drift.",
            "- Confirm no frame has visible background dirt, cropped feet, or severe edge artifacts.",
        ]
    )
    ensure_dir(path.parent)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(args):
    root = Path(__file__).resolve().parents[1]
    identity_reference = root / args.identity_reference
    if not identity_reference.exists():
        return fail(f"missing identity reference: {identity_reference}")

    candidate_root = root / "Assets/CharacterV2/candidates/left_motion_image2"
    review_root = root / "Assets/CharacterV2/review/left_motion_image2_build"
    clips = make_clips(root, identity_reference)

    validation = {}
    output_paths = {}
    for clip_id, frames in clips.items():
        frame_paths = save_frames(frames, candidate_root / clip_id)
        output_paths[clip_id] = [str(path) for path in frame_paths]
        write_contact_sheet(clip_id, frames, review_root / f"{clip_id}_contact_sheet.png")
        write_preview_gif(frames, review_root / f"{clip_id}_preview.gif")
        validation[clip_id] = validate_clip(
            clip_id,
            frames,
            frame_paths,
            loop=clip_id in {"idle_front", "walk_left_loop", "idle_left"},
        )

    write_alignment_overlay(clips, review_root / "alignment_overlay.png")
    write_state_machine_overview(clips, review_root / "state_machine_overview.png")
    write_candidate_manifest_patch(review_root / "left_motion_candidate_manifest_patch.json")

    transition_seams = {
        "idle_front_to_turn_front_to_left": diff_ratio(clips["idle_front"][-1], clips["turn_front_to_left"][0]),
        "turn_front_to_left_to_walk_left_loop": diff_ratio(clips["turn_front_to_left"][-1], clips["walk_left_loop"][0]),
        "walk_left_loop_to_walk_left_to_stop": diff_ratio(clips["walk_left_loop"][-1], clips["walk_left_to_stop"][0]),
        "walk_left_to_stop_to_turn_left_to_front": diff_ratio(clips["walk_left_to_stop"][-1], clips["turn_left_to_front"][0]),
        "turn_left_to_front_to_idle_front": diff_ratio(clips["turn_left_to_front"][-1], clips["idle_front"][0]),
    }
    all_passed = all(result["status"] == "PASSED" for result in validation.values())
    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "final_status": "READY_FOR_HUMAN_VISUAL_ACCEPTANCE" if all_passed else "PARTIALLY_READY",
        "inputs": {
            "identity_reference": str(identity_reference),
            "motion_reference": str(root / "Assets/CharacterV2/approved/clips/walk_left"),
        },
        "image2": {
            "status": "skipped_no_configured_image2_pipeline",
            "parameters": {
                "denoise_strength": None,
                "cfg": None,
                "steps": None,
                "seed": None,
            },
            "note": "Built as a deterministic candidate from canonical identity and approved walk_left frames.",
        },
        "technical_specs": {
            "canvas": list(CANVAS),
            "fps": FPS,
            "baseline_y": BASELINE_Y,
            "root_x": ROOT_X,
            "visual_height": TARGET_HEIGHT,
            "frame_counts": CLIP_FRAME_COUNTS,
        },
        "outputs": {
            "candidate_root": str(candidate_root),
            "review_root": str(review_root),
            "frames": output_paths,
        },
        "validation": validation,
        "transition_seams": transition_seams,
    }
    metrics_path = review_root / "metrics.json"
    metrics_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_report(review_root / "LEFT_MOTION_IMAGE2_BUILD_REPORT.md", payload)
    print(f"FINAL_STATUS={payload['final_status']}")
    print(f"Wrote candidates: {candidate_root}")
    print(f"Wrote review: {review_root}")
    return 0 if all_passed else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build left-motion state animation candidate clips for CharacterV2.")
    parser.add_argument(
        "--identity-reference",
        default="Resources/Characters/Default/character_anchor_rgba_v3.png",
    )
    args = parser.parse_args(argv)
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
