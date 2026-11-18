#!/usr/bin/env python3
import argparse
import json
import struct
import sys
from pathlib import Path

from PIL import Image, ImageChops


REQUIRED_CLIPS = {
    "idle",
    "blink",
    "idle_look_around",
    "start_move",
    "stop_move",
    "start_move_left",
    "start_move_right",
    "stop_move_left",
    "stop_move_right",
    "turn_left_to_front",
    "walk_left",
    "walk_right",
    "brisk_walk_left",
    "brisk_walk_right",
    "run_left",
    "run_right",
}

OPPOSITE_DIRECTION = {
    "left": "right",
    "right": "left",
}

ALLOWED_DIRECTIONLESS_FALLBACK_MODES = {
    "TEMP_LEGACY_DIRECTIONLESS_FALLBACK",
    "TEMP_IDLE_QUALITY_FALLBACK",
}

WALK_FRAME_COUNT = 16
WALK_EDGE_MARGIN_PX = 8
WALK_BASELINE_SPREAD_LIMIT_PX = 1
WALK_HEIGHT_DRIFT_RATIO_LIMIT = 0.02
WALK_ROOT_X_SPREAD_LIMIT_PX = 1
WALK_DIFF_SPIKE_MULTIPLIER = 2.5
WALK_MIRROR_BBOX_LIMIT_PX = 2
WALK_MIRROR_ALPHA_AREA_LIMIT = 0.03
ALPHA_THRESHOLD = 16
LEFT_MOTION_EXPECTED = {
    "idle_front": 6,
    "turn_front_to_left": 6,
    "walk_left_loop": 16,
    "walk_left_to_stop": 6,
    "turn_left_to_front": 6,
    "idle_left": 6,
}
LEFT_MOTION_LOOP_CLIPS = {"idle_front", "walk_left_loop", "idle_left"}
LEFT_MOTION_TURN_CLIPS = {"turn_front_to_left", "turn_left_to_front"}
APPROVED_DIRECTIONAL_TRANSITION_CLIPS = {
    "start_move_left",
    "start_move_right",
    "stop_move_left",
    "stop_move_right",
}


def fail(message):
    print(f"FAIL: {message}")
    return 1


def final_blocked(message):
    print("FINAL_STATUS=BLOCKED_BY_MISSING_REAL_WALK_ASSETS")
    print(f"FAIL: {message}")
    return 1


def read_png_info(path):
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("not a PNG")
    offset = 8
    width = height = color_type = None
    has_trns = False
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk_type = data[offset + 4:offset + 8]
        chunk_data = data[offset + 8:offset + 8 + length]
        offset += 12 + length
        if chunk_type == b"IHDR":
            width, height, _bit_depth, color_type = struct.unpack(">IIBB", chunk_data[:10])
        elif chunk_type == b"tRNS":
            has_trns = True
        elif chunk_type == b"IEND":
            break
    if width is None or height is None or color_type is None:
        raise ValueError("missing IHDR")
    has_alpha = color_type in (4, 6) or has_trns
    return width, height, has_alpha


def valid_unit_point(point):
    return 0 <= point.get("x", -1) <= 1 and 0 <= point.get("y", -1) <= 1


def valid_unit_rect(rect):
    x = rect.get("x", -1)
    y = rect.get("y", -1)
    width = rect.get("width", 0)
    height = rect.get("height", 0)
    return x >= 0 and y >= 0 and width > 0 and height > 0 and x + width <= 1 and y + height <= 1


def fps_is_valid(clip):
    fps = clip.get("fps", 0)
    base = clip.get("baseFps", fps)
    min_fps = clip.get("minFps", base)
    max_fps = clip.get("maxFps", base)
    return fps > 0 and min_fps > 0 and base > 0 and max_fps > 0 and min_fps <= base <= max_fps


def event_frames_are_valid(clip):
    frame_count = len(clip.get("frames", []))
    for event in clip.get("events", []):
        frame = event.get("frame", -1)
        if frame < 0 or frame >= frame_count:
            return False
    for contact in clip.get("footContacts", []):
        frame = contact.get("frame", -1)
        if frame < 0 or frame >= frame_count:
            return False
    return True


def clip_png_paths(root, clip):
    clip_dir = root / "Assets/CharacterV2/approved/clips" / clip["id"]
    return [clip_dir / f"{frame_id}.png" for frame_id in clip["frames"]]


def clip_bytes(root, clip):
    paths = clip_png_paths(root, clip)
    if not all(path.exists() for path in paths):
        return None
    return [path.read_bytes() for path in paths]


def alpha_metric(path):
    image = Image.open(path).convert("RGBA")
    alpha = image.getchannel("A")
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("empty alpha")
    left, top, right, bottom = bbox
    alpha_area = sum(1 for value in alpha.getdata() if value > ALPHA_THRESHOLD)
    return {
        "path": path,
        "image": image,
        "canvas": image.size,
        "bbox": bbox,
        "visible_width": right - left,
        "visible_height": bottom - top,
        "baseline_y": bottom - 1,
        "root_x": (left + right) / 2,
        "edge_margin_min": min(left, top, image.width - right, image.height - bottom),
        "alpha_area": alpha_area,
    }


def visual_diff_ratio(first, second):
    diff = ImageChops.difference(first.convert("RGBA"), second.convert("RGBA")).convert("L")
    return sum(diff.getdata()) / max(1, diff.width * diff.height * 255)


def median(values):
    ordered = sorted(values)
    if not ordered:
        return 0
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def expected_walk_frame_ids():
    return [f"frame_{index:03d}" for index in range(WALK_FRAME_COUNT)]


def summarize_walk_metrics(metrics, diffs):
    heights = [metric["visible_height"] for metric in metrics]
    baselines = [metric["baseline_y"] for metric in metrics]
    roots = [metric["root_x"] for metric in metrics]
    areas = [metric["alpha_area"] for metric in metrics]
    mean_height = sum(heights) / max(1, len(heights))
    area_deltas = [
        abs(areas[index] - areas[(index + 1) % len(areas)]) / max(1, sum(areas) / len(areas))
        for index in range(len(areas))
    ]
    return {
        "frame_count": len(metrics),
        "canvas": list(metrics[0]["canvas"]) if metrics else None,
        "height_min": min(heights) if heights else None,
        "height_max": max(heights) if heights else None,
        "height_drift_ratio": ((max(heights) - min(heights)) / max(1, mean_height)) if heights else None,
        "baseline_min": min(baselines) if baselines else None,
        "baseline_max": max(baselines) if baselines else None,
        "baseline_spread": (max(baselines) - min(baselines)) if baselines else None,
        "root_x_min": min(roots) if roots else None,
        "root_x_max": max(roots) if roots else None,
        "root_x_spread": (max(roots) - min(roots)) if roots else None,
        "edge_margin_min": min(metric["edge_margin_min"] for metric in metrics) if metrics else None,
        "alpha_area_min": min(areas) if areas else None,
        "alpha_area_max": max(areas) if areas else None,
        "median_consecutive_diff": median(diffs) if diffs else None,
        "max_consecutive_diff": max(diffs) if diffs else None,
        "loop_seam_diff": diffs[-1] if diffs else None,
        "median_area_delta": median(area_deltas) if area_deltas else None,
        "max_area_delta": max(area_deltas) if area_deltas else None,
    }


def collect_enabled_walk_clip_report(root, clip):
    paths = clip_png_paths(root, clip)
    metrics = [alpha_metric(path) for path in paths]
    diffs = [
        visual_diff_ratio(metrics[index]["image"], metrics[(index + 1) % len(metrics)]["image"])
        for index in range(len(metrics))
    ]
    return {
        "clip_id": clip["id"],
        "frame_ids": clip.get("frames", []),
        "paths": [str(path) for path in paths],
        "summary": summarize_walk_metrics(metrics, diffs),
        "frames": [
            {
                key: value
                for key, value in metric.items()
                if key not in {"image", "path"}
            }
            | {"path": str(metric["path"])}
            for metric in metrics
        ],
        "consecutive_diff_ratios": diffs,
    }


def validate_left_motion_candidate(root, candidate_dir):
    candidate_dir = Path(candidate_dir)
    if not candidate_dir.is_absolute():
        candidate_dir = root / candidate_dir
    payload = {
        "status": "PASSED",
        "candidate_dir": str(candidate_dir),
        "thresholds": {
            "height_drift_ratio_limit": WALK_HEIGHT_DRIFT_RATIO_LIMIT,
            "baseline_spread_limit_px": WALK_BASELINE_SPREAD_LIMIT_PX,
            "root_x_spread_limit_px": WALK_ROOT_X_SPREAD_LIMIT_PX,
            "edge_margin_px": WALK_EDGE_MARGIN_PX,
        },
        "clips": {},
        "transition_seams": {},
    }
    errors = []
    loaded_images = {}
    for clip_id, expected_count in LEFT_MOTION_EXPECTED.items():
        clip_dir = candidate_dir / clip_id
        paths = sorted(clip_dir.glob("frame_*.png"))
        clip_errors = []
        clip_warnings = []
        expected_names = [f"frame_{index:03d}.png" for index in range(expected_count)]
        actual_names = [path.name for path in paths]
        if actual_names != expected_names:
            clip_errors.append(f"{clip_id}: frame names/count do not match expected sequence")
        images = []
        metrics = []
        if len(paths) == expected_count:
            for index, path in enumerate(paths):
                image = Image.open(path)
                if image.mode != "RGBA":
                    clip_errors.append(f"{clip_id}: {path.name} is {image.mode}, expected RGBA")
                rgba = image.convert("RGBA")
                images.append(rgba)
                try:
                    metric = alpha_metric(path)
                except Exception as error:
                    clip_errors.append(f"{clip_id}: {path.name} alpha metric failed: {error}")
                    continue
                metrics.append(metric)
        loaded_images[clip_id] = images
        if metrics:
            canvases = {metric["canvas"] for metric in metrics}
            if len(canvases) != 1:
                clip_errors.append(f"{clip_id}: frames have inconsistent canvas dimensions")
            if any(metric["edge_margin_min"] < WALK_EDGE_MARGIN_PX for metric in metrics):
                clip_errors.append(f"{clip_id}: non-transparent pixels too close to canvas edge")
            heights = [metric["visible_height"] for metric in metrics]
            baselines = [metric["baseline_y"] for metric in metrics]
            roots = [metric["root_x"] for metric in metrics]
            height_drift = (max(heights) - min(heights)) / max(1, sum(heights) / len(heights))
            if height_drift > WALK_HEIGHT_DRIFT_RATIO_LIMIT:
                clip_errors.append(f"{clip_id}: height drift exceeds {WALK_HEIGHT_DRIFT_RATIO_LIMIT * 100:.1f}%")
            if max(baselines) - min(baselines) > WALK_BASELINE_SPREAD_LIMIT_PX:
                clip_errors.append(f"{clip_id}: baseline drift exceeds {WALK_BASELINE_SPREAD_LIMIT_PX}px")
            root_spread = max(roots) - min(roots)
            if root_spread > WALK_ROOT_X_SPREAD_LIMIT_PX:
                message = f"{clip_id}: root x spread {root_spread:.2f}px exceeds {WALK_ROOT_X_SPREAD_LIMIT_PX}px"
                if clip_id in LEFT_MOTION_TURN_CLIPS:
                    clip_warnings.append(message)
                else:
                    clip_errors.append(message)
            diffs = [
                visual_diff_ratio(metrics[index]["image"], metrics[(index + 1) % len(metrics)]["image"])
                for index in range(len(metrics))
            ]
            payload["clips"][clip_id] = {
                "status": "PASSED" if not clip_errors else "FAILED",
                "failures": clip_errors,
                "warnings": clip_warnings,
                "summary": summarize_walk_metrics(metrics, diffs),
                "loop": clip_id in LEFT_MOTION_LOOP_CLIPS,
                "loop_seam_diff": diffs[-1] if clip_id in LEFT_MOTION_LOOP_CLIPS and diffs else None,
                "frames": [
                    {
                        key: value
                        for key, value in metric.items()
                        if key not in {"image", "path"}
                    }
                    | {"path": str(metric["path"])}
                    for metric in metrics
                ],
            }
        else:
            payload["clips"][clip_id] = {
                "status": "FAILED",
                "failures": clip_errors or [f"{clip_id}: no readable frames"],
                "warnings": clip_warnings,
            }
        errors.extend(clip_errors)

    sequence = [
        ("idle_front_to_turn_front_to_left", "idle_front", -1, "turn_front_to_left", 0),
        ("turn_front_to_left_to_walk_left_loop", "turn_front_to_left", -1, "walk_left_loop", 0),
        ("walk_left_loop_to_walk_left_to_stop", "walk_left_loop", -1, "walk_left_to_stop", 0),
        ("walk_left_to_stop_to_turn_left_to_front", "walk_left_to_stop", -1, "turn_left_to_front", 0),
        ("turn_left_to_front_to_idle_front", "turn_left_to_front", -1, "idle_front", 0),
    ]
    for seam_id, first_clip, first_index, second_clip, second_index in sequence:
        first = loaded_images.get(first_clip, [])
        second = loaded_images.get(second_clip, [])
        if first and second:
            payload["transition_seams"][seam_id] = visual_diff_ratio(first[first_index], second[second_index])
    if errors:
        payload["status"] = "FAILED"
    return payload, errors


def validate_enabled_walk_clip(root, clip):
    if clip.get("placeholder", False):
        return None
    clip_id = clip["id"]
    if clip_id not in {"walk_left", "walk_right"}:
        return None
    if len(clip.get("frames", [])) != WALK_FRAME_COUNT:
        return f"{clip_id}: walk clip must have exactly {WALK_FRAME_COUNT} frames"
    if clip.get("frames", []) != expected_walk_frame_ids():
        return f"{clip_id}: walk frame ids must be sequential frame_000 ... frame_015"
    paths = clip_png_paths(root, clip)
    if not all(path.exists() for path in paths):
        missing = [str(path) for path in paths if not path.exists()]
        return f"{clip_id}: missing walk frames: {', '.join(missing)}"
    for path in paths:
        if Image.open(path).mode != "RGBA":
            return f"{clip_id}: {path.name} must be RGBA"
    try:
        metrics = [alpha_metric(path) for path in paths]
    except Exception as error:
        return f"{clip_id}: invalid alpha in walk frames: {error}"
    canvases = {metric["canvas"] for metric in metrics}
    if len(canvases) != 1:
        return f"{clip_id}: walk frames must have identical canvas dimensions"
    if any(metric["edge_margin_min"] < WALK_EDGE_MARGIN_PX for metric in metrics):
        return f"{clip_id}: non-transparent pixels within {WALK_EDGE_MARGIN_PX}px of canvas edge"
    heights = [metric["visible_height"] for metric in metrics]
    baselines = [metric["baseline_y"] for metric in metrics]
    roots = [metric["root_x"] for metric in metrics]
    mean_height = sum(heights) / max(1, len(heights))
    height_drift_ratio = (max(heights) - min(heights)) / max(1, mean_height)
    if height_drift_ratio > WALK_HEIGHT_DRIFT_RATIO_LIMIT:
        return f"{clip_id}: bbox height drift exceeds {WALK_HEIGHT_DRIFT_RATIO_LIMIT * 100:.1f}%"
    if max(baselines) - min(baselines) > WALK_BASELINE_SPREAD_LIMIT_PX:
        return f"{clip_id}: foot baseline spread exceeds {WALK_BASELINE_SPREAD_LIMIT_PX}px"
    if max(roots) - min(roots) > WALK_ROOT_X_SPREAD_LIMIT_PX:
        return f"{clip_id}: root/pivot x spread exceeds {WALK_ROOT_X_SPREAD_LIMIT_PX}px"
    diffs = [
        visual_diff_ratio(metrics[index]["image"], metrics[(index + 1) % len(metrics)]["image"])
        for index in range(len(metrics))
    ]
    med = median(diffs)
    if med > 0 and max(diffs) > med * WALK_DIFF_SPIKE_MULTIPLIER:
        return f"{clip_id}: max consecutive diff exceeds {WALK_DIFF_SPIKE_MULTIPLIER}x median"
    if any(value == 0 for value in diffs):
        return f"{clip_id}: accidental duplicate consecutive frames without explicit hold marker"
    return None


def validate_walk_mirror_compatibility(root, left, right):
    if left.get("placeholder", False) or right.get("placeholder", False):
        return None
    left_metrics = [alpha_metric(path) for path in clip_png_paths(root, left)]
    right_metrics = [alpha_metric(path) for path in clip_png_paths(root, right)]
    for index, (left_metric, right_metric) in enumerate(zip(left_metrics, right_metrics)):
        if abs(left_metric["visible_width"] - right_metric["visible_width"]) > WALK_MIRROR_BBOX_LIMIT_PX:
            return f"walk_left/walk_right: frame {index} bbox width differs by more than {WALK_MIRROR_BBOX_LIMIT_PX}px"
        if abs(left_metric["visible_height"] - right_metric["visible_height"]) > WALK_MIRROR_BBOX_LIMIT_PX:
            return f"walk_left/walk_right: frame {index} bbox height differs by more than {WALK_MIRROR_BBOX_LIMIT_PX}px"
        area_delta = abs(left_metric["alpha_area"] - right_metric["alpha_area"]) / max(left_metric["alpha_area"], 1)
        if area_delta > WALK_MIRROR_ALPHA_AREA_LIMIT:
            return f"walk_left/walk_right: frame {index} alpha area differs by more than {WALK_MIRROR_ALPHA_AREA_LIMIT * 100:.0f}%"
    return None


def is_temp_idle_quality_fallback(clip):
    fallback = clip.get("fallback") or {}
    return (
        clip.get("placeholder", False)
        and fallback.get("clipID") == "idle"
        and fallback.get("mode") == "TEMP_IDLE_QUALITY_FALLBACK"
    )


def walk_runtime_not_ready(clips):
    return any(is_temp_idle_quality_fallback(clips[clip_id]) for clip_id in ("walk_left", "walk_right"))


def validate_dev_safe_walk_state(clips):
    for clip_id in ("walk_left", "walk_right"):
        clip = clips[clip_id]
        if clip.get("placeholder", False) and not is_temp_idle_quality_fallback(clip):
            return f"{clip_id}: placeholder walk clip must explicitly use TEMP_IDLE_QUALITY_FALLBACK"
    return None


def strict_real_walk_errors(root, clips):
    errors = []
    approved_root = root / "Assets/CharacterV2/approved/clips"
    for clip_id in ("walk_left", "walk_right"):
        clip = clips[clip_id]
        clip_dir = approved_root / clip_id
        fallback = clip.get("fallback") or {}
        if is_temp_idle_quality_fallback(clip) or fallback.get("mode") == "TEMP_IDLE_QUALITY_FALLBACK":
            errors.append(f"{clip_id}: runtime manifest points to TEMP_IDLE_QUALITY_FALLBACK")
        if clip.get("placeholder", False):
            errors.append(f"{clip_id}: real walk is not enabled in manifest")
        if not clip_dir.exists():
            errors.append(f"{clip_id}: approved/clips/{clip_id} does not exist")
            continue
        pngs = sorted(path for path in clip_dir.iterdir() if path.suffix.lower() == ".png")
        if len(pngs) != WALK_FRAME_COUNT:
            errors.append(f"{clip_id}: approved directory has {len(pngs)} PNG frames, expected {WALK_FRAME_COUNT}")
        if len(clip.get("frames", [])) != WALK_FRAME_COUNT:
            errors.append(f"{clip_id}: manifest defines {len(clip.get('frames', []))} frames, expected {WALK_FRAME_COUNT}")
        error = validate_enabled_walk_clip(root, clip)
        if error:
            errors.append(error)
    mirror_error = validate_walk_mirror_compatibility(root, clips["walk_left"], clips["walk_right"])
    if mirror_error:
        errors.append(mirror_error)
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description="Validate Character V2 manifest and asset contracts.")
    parser.add_argument(
        "--require-real-walk",
        action="store_true",
        help="Fail unless approved walk_left/walk_right contain real 16-frame walk assets.",
    )
    parser.add_argument(
        "--metrics-out",
        help="Optional path for Character V2 walk validation metrics JSON.",
    )
    parser.add_argument(
        "--left-motion-candidate-dir",
        help="Optional candidate root containing idle_front/turn/walk/stop left-motion state clips.",
    )
    parser.add_argument(
        "--left-motion-metrics-out",
        help="Optional path for left-motion candidate validation metrics JSON.",
    )
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parents[1]
    manifest_path = root / "Assets/CharacterV2/manifests/character_v2_manifest.json"
    if not manifest_path.exists():
        return fail(f"missing manifest: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion", 0) < 2:
        return fail("schemaVersion must be 2 or newer for P6.2 locomotion")

    clips = manifest.get("clips", [])
    clip_ids = [clip.get("id") for clip in clips]
    missing = sorted(REQUIRED_CLIPS - set(clip_ids))
    if missing:
        return fail(f"missing required clips: {', '.join(missing)}")
    if len(clip_ids) != len(set(clip_ids)):
        return fail("duplicate clip ids")

    by_id = {clip["id"]: clip for clip in clips}

    for clip in clips:
        clip_id = clip.get("id", "<unknown>")
        frames = clip.get("frames", [])
        asset_status = clip.get("assetStatus")
        placeholder = clip.get("placeholder", False)

        if asset_status not in {"approved", "legacy", "placeholder"}:
            return fail(f"{clip_id}: invalid assetStatus")
        if asset_status == "approved" and placeholder:
            return fail(f"{clip_id}: approved clip cannot be placeholder")
        if asset_status == "placeholder" and not placeholder:
            return fail(f"{clip_id}: placeholder assetStatus must set placeholder=true")
        if asset_status == "approved" and clip.get("fallback") is not None:
            return fail(f"{clip_id}: approved clip cannot use fallback")
        if clip_id in {"walk_left", "walk_right"} and len(frames) != WALK_FRAME_COUNT:
            return fail(f"{clip_id}: walk clip must define exactly {WALK_FRAME_COUNT} frames")
        if not fps_is_valid(clip):
            return fail(f"{clip_id}: invalid fps/minFps/baseFps/maxFps")
        if not frames:
            return fail(f"{clip_id}: frames cannot be empty")
        if len(frames) < clip.get("minFrameCount", 1):
            return fail(f"{clip_id}: frame count below minFrameCount")
        if not valid_unit_point(clip.get("pivot", {})):
            return fail(f"{clip_id}: invalid pivot")
        if not valid_unit_rect(clip.get("hitbox", {})):
            return fail(f"{clip_id}: invalid hitbox")
        if not event_frames_are_valid(clip):
            return fail(f"{clip_id}: event or footContact frame out of range")

        speed_range = clip.get("speedRange")
        if speed_range and speed_range.get("max", 0) <= speed_range.get("min", -1):
            return fail(f"{clip_id}: invalid speedRange")

        fallback = clip.get("fallback")
        if fallback:
            fallback_id = fallback.get("clipID")
            fallback_clip = by_id.get(fallback_id)
            if fallback_clip is None:
                return fail(f"{clip_id}: fallback clip missing: {fallback_id}")
            direction = clip.get("direction")
            fallback_direction = fallback_clip.get("direction")
            if direction and fallback_direction == OPPOSITE_DIRECTION[direction]:
                return fail(f"{clip_id}: fallback points to opposite direction {fallback_id}")
            if direction and fallback_direction is None and fallback.get("mode") not in ALLOWED_DIRECTIONLESS_FALLBACK_MODES:
                return fail(f"{clip_id}: directionless fallback must be explicitly temporary legacy")
        if clip_id in APPROVED_DIRECTIONAL_TRANSITION_CLIPS:
            if clip.get("assetStatus") != "approved":
                return fail(f"{clip_id}: directional transition must be approved")
            if clip.get("placeholder"):
                return fail(f"{clip_id}: directional transition must not be placeholder")
            if fallback:
                return fail(f"{clip_id}: directional transition must not use fallback")

    error = validate_dev_safe_walk_state(by_id)
    if error:
        return fail(error)

    for left_id, right_id in [
        ("walk_left", "walk_right"),
        ("brisk_walk_left", "brisk_walk_right"),
        ("run_left", "run_right"),
        ("start_move_left", "start_move_right"),
        ("stop_move_left", "stop_move_right"),
    ]:
        left = by_id[left_id]
        right = by_id[right_id]
        left_frames = left.get("frames")
        right_frames = right.get("frames")
        generic_numbered_frames = (
            left_frames == right_frames
            and all(isinstance(frame, str) and frame.startswith("frame_") for frame in left_frames)
        )
        if left_frames == right_frames and not generic_numbered_frames:
            return fail(f"{left_id} and {right_id} must use independent frame ids")
        left_bytes = clip_bytes(root, left)
        right_bytes = clip_bytes(root, right)
        if left_bytes is not None and right_bytes is not None and left_bytes == right_bytes:
            return fail(f"{left_id} and {right_id} PNG files are identical")

    if args.require_real_walk:
        errors = strict_real_walk_errors(root, by_id)
        if errors:
            for item in errors:
                print(f"STRICT_REAL_WALK_ERROR: {item}")
            return final_blocked("real approved walk assets are missing or invalid")
    else:
        for clip_id in ("walk_left", "walk_right"):
            error = validate_enabled_walk_clip(root, by_id[clip_id])
            if error:
                return fail(error)
        error = validate_walk_mirror_compatibility(root, by_id["walk_left"], by_id["walk_right"])
        if error:
            return fail(error)

    habitat = manifest.get("habitat", {})
    if not valid_unit_point(habitat.get("anchor", {})) or not valid_unit_rect(habitat.get("hitbox", {})):
        return fail("invalid habitat anchor or hitbox")
    if not habitat.get("placeholder", True):
        resources = habitat.get("resources", [])
        if not resources:
            return fail("non-placeholder habitat must list at least one resource")
        for resource in resources:
            png = root / "Assets/CharacterV2" / resource
            if not png.exists():
                return fail(f"habitat: missing resource {png}")
            _width, _height, has_alpha = read_png_info(png)
            if not has_alpha:
                return fail(f"habitat: {png.name} has no alpha channel")

    approved_root = root / "Assets/CharacterV2/approved/clips"
    for clip in clips:
        if clip.get("placeholder", False):
            continue
        clip_dir = approved_root / clip["id"]
        if not clip_dir.exists():
            return fail(f"{clip['id']}: missing approved clip directory")
        expected_size = None
        for frame_id in clip["frames"]:
            png = clip_dir / f"{frame_id}.png"
            if not png.exists():
                return fail(f"{clip['id']}: missing frame {png}")
            width, height, has_alpha = read_png_info(png)
            if not has_alpha:
                return fail(f"{clip['id']}: {png.name} has no alpha channel")
            if expected_size is None:
                expected_size = (width, height)
            elif expected_size != (width, height):
                return fail(f"{clip['id']}: inconsistent PNG dimensions")

    if walk_runtime_not_ready(by_id):
        print("WALK_ANIMATION_NOT_READY: using idle fallback, not real walk.")
        print("OK: Character V2 dev-safe manifest and fallback contract are valid")
    else:
        print("OK: Character V2 manifest and real walk asset contract are valid")
    if args.metrics_out:
        metrics_path = Path(args.metrics_out)
        if not metrics_path.is_absolute():
            metrics_path = root / metrics_path
        metrics_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "status": "PASSED",
            "thresholds": {
                "frame_count": WALK_FRAME_COUNT,
                "edge_margin_px": WALK_EDGE_MARGIN_PX,
                "height_drift_ratio_limit": WALK_HEIGHT_DRIFT_RATIO_LIMIT,
                "baseline_spread_limit_px": WALK_BASELINE_SPREAD_LIMIT_PX,
                "root_x_spread_limit_px": WALK_ROOT_X_SPREAD_LIMIT_PX,
                "diff_spike_multiplier": WALK_DIFF_SPIKE_MULTIPLIER,
            },
            "walk_right": collect_enabled_walk_clip_report(root, by_id["walk_right"]),
            "walk_left": collect_enabled_walk_clip_report(root, by_id["walk_left"]),
        }
        metrics_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote metrics: {metrics_path}")
    if args.left_motion_candidate_dir:
        candidate_payload, candidate_errors = validate_left_motion_candidate(root, args.left_motion_candidate_dir)
        candidate_metrics_out = args.left_motion_metrics_out
        if candidate_metrics_out:
            candidate_metrics_path = Path(candidate_metrics_out)
        else:
            candidate_metrics_path = Path(args.left_motion_candidate_dir) / "candidate_validation_metrics.json"
        if not candidate_metrics_path.is_absolute():
            candidate_metrics_path = root / candidate_metrics_path
        candidate_metrics_path.parent.mkdir(parents=True, exist_ok=True)
        candidate_metrics_path.write_text(json.dumps(candidate_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote left-motion candidate metrics: {candidate_metrics_path}")
        if candidate_errors:
            for item in candidate_errors:
                print(f"LEFT_MOTION_CANDIDATE_ERROR: {item}")
            return fail("left-motion candidate validation failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
