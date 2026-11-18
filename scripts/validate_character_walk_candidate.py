#!/usr/bin/env python3
import argparse
import hashlib
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps


ALPHA_THRESHOLD = 16
EXPECTED_FRAMES = 16
EDGE_MARGIN_PX = 8
HEIGHT_SPREAD_LIMIT_PX = 1
BASELINE_SPREAD_LIMIT_PX = 2
ROOT_X_SPREAD_LIMIT_PX = 3
DIFF_SPIKE_MULTIPLIER = 2.5
MIN_MEDIAN_MASKED_DIFF = 0.018
NEAR_DUPLICATE_DIFF = 0.010
UNIQUE_FRAME_DIFF = 0.014
MIN_UNIQUE_FRAMES = 10
MAX_NEAR_DUPLICATE_PAIRS = 4
MIN_LOWER_BODY_MOTION = 0.018
MIN_UPPER_BODY_MOTION = 0.006
MIN_ARM_REGION_MOTION = 0.012
MIN_ARM_CENTROID_SPREAD_PX = 4.0
LOWER_BODY_FRACTION = 0.45
FOOT_REGION_FRACTION = 0.24
ARM_REGION_TOP_FRACTION = 0.28
ARM_REGION_BOTTOM_FRACTION = 0.72
ARM_REGION_SIDE_PAD_FRACTION = 0.08
FOOT_AREA_VARIATION_WARNING = 0.45
CONTACT_CENTER_DRIFT_WARNING_PX = 20
LOWER_DOMINANCE_WARNING_RATIO = 0.82
PIXEL_MOTION_PASS_STATUS = "PIXEL_MOTION_GATES_PASSED"
TECHNICAL_PASS_STATUS = "TECHNICAL_PASS_PENDING_HUMAN_VISUAL_REVIEW"
HUMAN_REVIEW_REQUIRED_STATUS = "HUMAN_VISUAL_REVIEW_REQUIRED"
HUMAN_REVIEW_WARNING = "PIXEL_MOTION_IS_NOT_VISUAL_WALK_APPROVAL: human review is still required."


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def ensure_dir(path):
    path.mkdir(parents=True, exist_ok=True)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def open_rgba(path):
    return Image.open(path).convert("RGBA")


def alpha_bbox(image):
    return image.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1").getbbox()


def alpha_histogram_area(image):
    histogram = image.getchannel("A").histogram()
    return sum(histogram[ALPHA_THRESHOLD + 1 :])


def load_clip(directory, prefix):
    directory = Path(directory)
    paths = sorted(directory.glob(f"{prefix}_*.png"))
    if not paths:
        paths = sorted(directory.glob("frame_*.png"))
    return paths, [open_rgba(path) for path in paths]


def metric_for_image(image, path, index):
    bbox = alpha_bbox(image)
    if bbox is None:
        return {
            "frame_index": index,
            "path": str(path),
            "empty_alpha": True,
        }
    left, top, right, bottom = bbox
    return {
        "frame_index": index,
        "path": str(path),
        "sha256": sha256_file(path),
        "canvas": [image.width, image.height],
        "bbox": [left, top, right, bottom],
        "visible_width": right - left,
        "visible_height": bottom - top,
        "foot_baseline_y": bottom - 1,
        "root_x": (left + right) / 2,
        "edge_margin_min": min(left, top, image.width - right, image.height - bottom),
        "alpha_area": alpha_histogram_area(image),
        "empty_alpha": False,
    }


def union_bbox(metrics):
    boxes = [metric["bbox"] for metric in metrics if not metric.get("empty_alpha")]
    if not boxes:
        return None
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def region_boxes(bbox):
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    split = round(bottom - (bottom - top) * LOWER_BODY_FRACTION)
    foot_top = round(bottom - (bottom - top) * FOOT_REGION_FRACTION)
    return {
        "full": bbox,
        "upper": [left, top, right, split],
        "lower": [left, split, right, bottom],
        "foot": [left, foot_top, right, bottom],
        "arm": [
            round(left + width * ARM_REGION_SIDE_PAD_FRACTION),
            round(top + height * ARM_REGION_TOP_FRACTION),
            round(right - width * ARM_REGION_SIDE_PAD_FRACTION),
            round(top + height * ARM_REGION_BOTTOM_FRACTION),
        ],
    }


def masked_diff(first, second, box):
    first_crop = first.crop(box).convert("RGBA")
    second_crop = second.crop(box).convert("RGBA")
    first_alpha = first_crop.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    second_alpha = second_crop.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    union_mask = ImageChops.lighter(first_alpha.convert("L"), second_alpha.convert("L"))
    mask_area = sum(union_mask.tobytes()) / 255
    if mask_area <= 0:
        return 0.0, union_mask, Image.new("L", first_crop.size, 0)
    diff = ImageChops.difference(first_crop, second_crop).convert("L")
    masked = ImageChops.multiply(diff, union_mask)
    return sum(masked.tobytes()) / max(1, mask_area * 255), union_mask, masked


def unique_frame_count(frames, bbox):
    representatives = []
    for frame in frames:
        if all(masked_diff(frame, representative, bbox)[0] >= UNIQUE_FRAME_DIFF for representative in representatives):
            representatives.append(frame)
    return len(representatives)


def foot_region_stats(frames, foot_box):
    stats = []
    for index, frame in enumerate(frames):
        crop = frame.crop(foot_box)
        bbox = alpha_bbox(crop)
        if bbox is None:
            stats.append({
                "frame": index,
                "empty": True,
                "alpha_area": 0,
                "bbox": None,
                "contact_center_x": None,
            })
            continue
        left, top, right, bottom = bbox
        alpha_area = alpha_histogram_area(crop)
        bottom_band = crop.crop((0, max(0, bottom - 5), crop.width, bottom))
        contact_bbox = alpha_bbox(bottom_band)
        if contact_bbox:
            contact_center_x = (contact_bbox[0] + contact_bbox[2]) / 2
        else:
            contact_center_x = (left + right) / 2
        stats.append({
            "frame": index,
            "empty": False,
            "alpha_area": alpha_area,
            "bbox": [left, top, right, bottom],
            "visible_width": right - left,
            "visible_height": bottom - top,
            "contact_center_x": contact_center_x,
        })
    return stats


def weighted_centroid(image):
    width, height = image.size
    data = image.tobytes()
    total = 0
    weighted_x = 0
    weighted_y = 0
    for offset, value in enumerate(data):
        if not value:
            continue
        x = offset % width
        y = offset // width
        total += value
        weighted_x += x * value
        weighted_y += y * value
    if total <= 0:
        return None
    return [weighted_x / total, weighted_y / total]


def arm_region_observations(motion):
    arm_diffs = motion.get("arm_region_diffs") or []
    centroids = [item for item in motion.get("arm_region_motion_centroids") or [] if item is not None]
    warnings = []
    median_arm = statistics.median(arm_diffs) if arm_diffs else 0
    x_spread = 0
    y_spread = 0
    if centroids:
        xs = [item[0] for item in centroids]
        ys = [item[1] for item in centroids]
        x_spread = max(xs) - min(xs)
        y_spread = max(ys) - min(ys)
    else:
        warnings.append("ARM_COUNTER_SWING_WEAK: no measurable arm-region motion centroid")

    lower = motion.get("lower_body_motion_energy") or 0
    if lower >= MIN_LOWER_BODY_MOTION and median_arm < MIN_ARM_REGION_MOTION:
        warnings.append(
            f"ARM_COUNTER_SWING_WEAK: arm-region motion energy {median_arm:.6f} < {MIN_ARM_REGION_MOTION:.6f}"
        )
    if lower >= MIN_LOWER_BODY_MOTION and x_spread < MIN_ARM_CENTROID_SPREAD_PX:
        warnings.append(
            f"ARM_COUNTER_SWING_WEAK: arm-region centroid x spread {x_spread:.2f}px < {MIN_ARM_CENTROID_SPREAD_PX:.2f}px"
        )

    return {
        "status": "WARN" if warnings else "PASSED",
        "warnings": warnings,
        "arm_region_motion_energy": median_arm,
        "arm_region_centroid_x_spread": x_spread,
        "arm_region_centroid_y_spread": y_spread,
        "arm_region_motion_centroids": centroids,
    }


def anti_warp_observations(frames, motion):
    observations = []
    bbox = motion.get("bbox")
    if not bbox:
        return {
            "status": "NOT_AVAILABLE",
            "warnings": ["missing motion bbox"],
            "foot_region_stats": [],
        }
    boxes = region_boxes(bbox)
    foot_stats = foot_region_stats(frames, boxes["foot"])
    foot_areas = [item["alpha_area"] for item in foot_stats if not item["empty"]]
    contact_centers = [item["contact_center_x"] for item in foot_stats if item["contact_center_x"] is not None]
    area_variation = None
    if foot_areas:
        median_area = statistics.median(foot_areas)
        if median_area > 0:
            area_variation = (max(foot_areas) - min(foot_areas)) / median_area
            if area_variation > FOOT_AREA_VARIATION_WARNING:
                observations.append(
                    f"foot alpha area varies by {area_variation:.2f}x median; check for foot shape stretch or smear"
                )
    else:
        observations.append("foot region has no measurable alpha")

    if contact_centers:
        contact_drift = max(contact_centers) - min(contact_centers)
        if contact_drift > CONTACT_CENTER_DRIFT_WARNING_PX:
            observations.append(
                f"bottom contact center drifts {contact_drift:.1f}px; check planted-foot sliding versus intended swing"
            )
    else:
        contact_drift = None
        observations.append("no measurable bottom contact center")

    lower = motion.get("lower_body_motion_energy") or 0
    upper = motion.get("upper_body_motion_energy") or 0
    total = lower + upper
    lower_ratio = lower / total if total > 0 else 0
    if lower_ratio > LOWER_DOMINANCE_WARNING_RATIO:
        observations.append(
            f"motion is concentrated in lower body ({lower_ratio:.2f}); check that arm/hair/skirt secondary motion is visible"
        )

    return {
        "status": "WARN" if observations else "PASSED",
        "warnings": observations,
        "foot_region_box": boxes["foot"],
        "foot_alpha_area_variation_ratio": area_variation,
        "contact_center_drift_px": contact_drift,
        "lower_body_motion_ratio": lower_ratio,
        "foot_region_stats": foot_stats,
    }


def validate_stability(name, paths, frames):
    failures = []
    if len(paths) != EXPECTED_FRAMES:
        failures.append(f"{name}: frame count {len(paths)} != {EXPECTED_FRAMES}")
    metrics = [metric_for_image(frame, path, index) for index, (path, frame) in enumerate(zip(paths, frames))]
    if any(metric.get("empty_alpha") for metric in metrics):
        failures.append(f"{name}: empty alpha frame")
    canvases = {tuple(metric["canvas"]) for metric in metrics if not metric.get("empty_alpha")}
    if len(canvases) != 1:
        failures.append(f"{name}: canvas size is not constant")
    if any(metric.get("edge_margin_min", 0) < EDGE_MARGIN_PX for metric in metrics if not metric.get("empty_alpha")):
        failures.append(f"{name}: edge margin below {EDGE_MARGIN_PX}px")
    heights = [metric["visible_height"] for metric in metrics if not metric.get("empty_alpha")]
    baselines = [metric["foot_baseline_y"] for metric in metrics if not metric.get("empty_alpha")]
    roots = [metric["root_x"] for metric in metrics if not metric.get("empty_alpha")]
    if heights and max(heights) - min(heights) > HEIGHT_SPREAD_LIMIT_PX:
        failures.append(f"{name}: bbox height spread {max(heights) - min(heights)}px > {HEIGHT_SPREAD_LIMIT_PX}px")
    if baselines and max(baselines) - min(baselines) > BASELINE_SPREAD_LIMIT_PX:
        failures.append(f"{name}: baseline spread {max(baselines) - min(baselines)}px > {BASELINE_SPREAD_LIMIT_PX}px")
    if roots and max(roots) - min(roots) > ROOT_X_SPREAD_LIMIT_PX:
        failures.append(f"{name}: root x spread {max(roots) - min(roots):.2f}px > {ROOT_X_SPREAD_LIMIT_PX}px")
    return failures, metrics


def motion_metrics(frames, metrics):
    bbox = union_bbox(metrics)
    if bbox is None or len(frames) != EXPECTED_FRAMES:
        return {
            "status": "FAILED",
            "failures": ["cannot compute motion metrics without 16 non-empty frames"],
        }
    boxes = region_boxes(bbox)
    full_diffs = []
    lower_diffs = []
    upper_diffs = []
    arm_diffs = []
    arm_centroids = []
    heatmaps = []
    for index in range(EXPECTED_FRAMES):
        first = frames[index]
        second = frames[(index + 1) % EXPECTED_FRAMES]
        full, _mask, full_heat = masked_diff(first, second, boxes["full"])
        lower, _lower_mask, lower_heat = masked_diff(first, second, boxes["lower"])
        upper, _upper_mask, upper_heat = masked_diff(first, second, boxes["upper"])
        arm, _arm_mask, arm_heat = masked_diff(first, second, boxes["arm"])
        full_diffs.append(full)
        lower_diffs.append(lower)
        upper_diffs.append(upper)
        arm_diffs.append(arm)
        arm_centroids.append(weighted_centroid(arm_heat))
        heatmaps.append({
            "full": full_heat,
            "lower": lower_heat,
            "arm": arm_heat,
        })

    median_diff = statistics.median(full_diffs)
    near_duplicate_pairs = sum(1 for value in full_diffs if value < NEAR_DUPLICATE_DIFF)
    unique_count = unique_frame_count(frames, boxes["full"])
    lower_energy = statistics.median(lower_diffs)
    upper_energy = statistics.median(upper_diffs)
    failures = []
    if median_diff < MIN_MEDIAN_MASKED_DIFF:
        failures.append(f"median consecutive diff {median_diff:.6f} < {MIN_MEDIAN_MASKED_DIFF:.6f}")
    if near_duplicate_pairs > MAX_NEAR_DUPLICATE_PAIRS:
        failures.append(f"near duplicate pairs {near_duplicate_pairs} > {MAX_NEAR_DUPLICATE_PAIRS}")
    if unique_count < MIN_UNIQUE_FRAMES:
        failures.append(f"unique frame count {unique_count} < {MIN_UNIQUE_FRAMES}")
    if lower_energy < MIN_LOWER_BODY_MOTION:
        failures.append(f"lower body motion energy {lower_energy:.6f} < {MIN_LOWER_BODY_MOTION:.6f}")
    if upper_energy < MIN_UPPER_BODY_MOTION:
        failures.append(f"upper body secondary motion energy {upper_energy:.6f} < {MIN_UPPER_BODY_MOTION:.6f}")
    if median_diff > 0 and max(full_diffs) > median_diff * DIFF_SPIKE_MULTIPLIER:
        failures.append(f"max consecutive diff {max(full_diffs):.6f} > {DIFF_SPIKE_MULTIPLIER}x median {median_diff:.6f}")

    return {
        "status": PIXEL_MOTION_PASS_STATUS if not failures else "FAILED_STATIC_OR_NEAR_STATIC_WALK_CANDIDATE",
        "failures": failures,
        "bbox": boxes["full"],
        "lower_body_box": boxes["lower"],
        "upper_body_box": boxes["upper"],
        "arm_region_box": boxes["arm"],
        "consecutive_diffs": full_diffs,
        "lower_body_diffs": lower_diffs,
        "upper_body_diffs": upper_diffs,
        "arm_region_diffs": arm_diffs,
        "arm_region_motion_centroids": arm_centroids,
        "arm_region_motion_energy": statistics.median(arm_diffs) if arm_diffs else 0,
        "median_consecutive_diff": median_diff,
        "max_consecutive_diff": max(full_diffs),
        "min_consecutive_diff": min(full_diffs),
        "loop_delta": full_diffs[-1],
        "unique_frame_count": unique_count,
        "near_duplicate_pair_count": near_duplicate_pairs,
        "lower_body_motion_energy": lower_energy,
        "upper_body_motion_energy": upper_energy,
        "static_candidate": bool(failures),
        "heatmaps": heatmaps,
    }


def validate_mirror(right_frames, left_frames):
    failures = []
    if len(right_frames) != EXPECTED_FRAMES or len(left_frames) != EXPECTED_FRAMES:
        return ["cannot validate mirror compatibility without 16 frames on both sides"]
    for index, (right, left) in enumerate(zip(right_frames, left_frames)):
        mirrored = ImageOps.mirror(right)
        if ImageChops.difference(mirrored, left).getbbox() is not None:
            failures.append(f"frame {index}: left is not exact mirror of normalized right")
    return failures


def heatmap_to_rgb(image):
    scaled = image.point(lambda value: min(255, value * 4))
    rgb = Image.new("RGB", image.size, (0, 0, 0))
    rgb.putdata([(value, min(255, value // 2), 0) for value in scaled.tobytes()])
    return rgb


def checker(size, tile=16):
    background = Image.new("RGBA", size, (238, 238, 238, 255))
    draw = ImageDraw.Draw(background)
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle([x, y, x + tile - 1, y + tile - 1], fill=(204, 204, 204, 255))
    return background


def render_diff_sheet(path, frames, motion, label):
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 16)
        small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 12)
    except Exception:
        font = ImageFont.load_default()
        small = ImageFont.load_default()

    thumb_width = 220
    thumb_height = 170
    columns = 4
    rows = 4
    header_height = 110
    sheet = Image.new("RGB", (columns * thumb_width, header_height + rows * thumb_height), (238, 239, 242))
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 12), f"{label} motion diff review", fill=(0, 0, 0), font=font)
    draw.text(
        (12, 42),
        f"pixel_motion_status={motion['status']} median={motion['median_consecutive_diff']:.6f} unique={motion['unique_frame_count']} near_dup={motion['near_duplicate_pair_count']}",
        fill=(0, 90, 20) if motion["status"] == PIXEL_MOTION_PASS_STATUS else (120, 0, 0),
        font=small,
    )
    draw.text((12, 68), HUMAN_REVIEW_WARNING, fill=(120, 0, 0), font=small)

    for index, item in enumerate(motion["heatmaps"]):
        panel = Image.new("RGB", (thumb_width, thumb_height), (250, 250, 250))
        full = heatmap_to_rgb(item["full"])
        lower = heatmap_to_rgb(item["lower"])
        full.thumbnail((thumb_width - 16, (thumb_height - 44) // 2), Image.Resampling.NEAREST)
        lower.thumbnail((thumb_width - 16, (thumb_height - 44) // 2), Image.Resampling.NEAREST)
        panel.paste(full, ((thumb_width - full.width) // 2, 22))
        panel.paste(lower, ((thumb_width - lower.width) // 2, 22 + (thumb_height - 44) // 2))
        panel_draw = ImageDraw.Draw(panel)
        duplicate = motion["consecutive_diffs"][index] < NEAR_DUPLICATE_DIFF
        color = (180, 0, 0) if duplicate else (0, 0, 0)
        panel_draw.text((6, 4), f"{index:02d}->{(index + 1) % EXPECTED_FRAMES:02d} diff={motion['consecutive_diffs'][index]:.4f}", fill=color, font=small)
        x = (index % columns) * thumb_width
        y = header_height + (index // columns) * thumb_height
        sheet.paste(panel, (x, y))
    ensure_dir(path.parent)
    sheet.save(path, quality=95)


def strip_images(report):
    copy = dict(report)
    if "right_motion" in copy:
        copy["right_motion"] = dict(copy["right_motion"])
        copy["right_motion"].pop("heatmaps", None)
    if "left_motion" in copy:
        copy["left_motion"] = dict(copy["left_motion"])
        copy["left_motion"].pop("heatmaps", None)
    return copy


def main():
    parser = argparse.ArgumentParser(description="Validate CharacterV2 walk candidate stability and motion readability.")
    parser.add_argument("--right-dir", "--right", dest="right_dir", required=True)
    parser.add_argument("--left-dir", "--left", dest="left_dir", required=True)
    parser.add_argument("--out", required=True, help="Candidate validation JSON.")
    parser.add_argument("--motion-out", help="Motion metrics JSON. Defaults next to --out.")
    parser.add_argument("--diff-sheet", help="Motion diff contact sheet PNG. Defaults next to --out.")
    args = parser.parse_args()
    out_path = Path(args.out)
    if args.motion_out:
        motion_out_path = Path(args.motion_out)
    elif "candidate_validation" in out_path.name:
        motion_out_path = out_path.with_name(out_path.name.replace("candidate_validation", "motion_metrics"))
    else:
        motion_out_path = out_path.with_name(f"{out_path.stem}_motion_metrics.json")
    if args.diff_sheet:
        diff_sheet_path = Path(args.diff_sheet)
    elif "candidate_validation" in out_path.name:
        diff_sheet_path = out_path.with_name(out_path.name.replace("candidate_validation.json", "motion_diff_contact_sheet.png"))
    else:
        diff_sheet_path = out_path.with_name(f"{out_path.stem}_motion_diff_contact_sheet.png")

    right_paths, right_frames = load_clip(args.right_dir, "walk_right")
    left_paths, left_frames = load_clip(args.left_dir, "walk_left")
    right_failures, right_metrics = validate_stability("walk_right", right_paths, right_frames)
    left_failures, left_metrics = validate_stability("walk_left", left_paths, left_frames)
    right_motion = motion_metrics(right_frames, right_metrics)
    left_motion = motion_metrics(left_frames, left_metrics)
    right_anti_warp = anti_warp_observations(right_frames, right_motion)
    left_anti_warp = anti_warp_observations(left_frames, left_motion)
    right_arm = arm_region_observations(right_motion)
    left_arm = arm_region_observations(left_motion)
    mirror_failures = validate_mirror(right_frames, left_frames)
    failures = []
    failures.extend(right_failures)
    failures.extend(left_failures)
    failures.extend(f"walk_right motion: {item}" for item in right_motion.get("failures", []))
    failures.extend(f"walk_left motion: {item}" for item in left_motion.get("failures", []))
    failures.extend(f"mirror: {item}" for item in mirror_failures)
    pixel_motion_status = PIXEL_MOTION_PASS_STATUS if not failures else "FAILED_STATIC_OR_NEAR_STATIC_WALK_CANDIDATE"
    candidate_validation_status = TECHNICAL_PASS_STATUS if not failures else "FAILED_STATIC_OR_NEAR_STATIC_WALK_CANDIDATE"

    report = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "final_motion_status": pixel_motion_status,
        "pixel_motion_status": pixel_motion_status,
        "candidate_validation_status": candidate_validation_status,
        "human_review_status": HUMAN_REVIEW_REQUIRED_STATUS,
        "human_review_required": True,
        "warnings": [HUMAN_REVIEW_WARNING] + right_arm.get("warnings", []) + left_arm.get("warnings", []),
        "status": "PASSED" if not failures else "FAILED",
        "failures": failures,
        "thresholds": {
            "expected_frames": EXPECTED_FRAMES,
            "edge_margin_px": EDGE_MARGIN_PX,
            "height_spread_px": HEIGHT_SPREAD_LIMIT_PX,
            "baseline_spread_px": BASELINE_SPREAD_LIMIT_PX,
            "root_x_spread_px": ROOT_X_SPREAD_LIMIT_PX,
            "min_median_masked_diff": MIN_MEDIAN_MASKED_DIFF,
            "near_duplicate_diff": NEAR_DUPLICATE_DIFF,
            "unique_frame_diff": UNIQUE_FRAME_DIFF,
            "min_unique_frames": MIN_UNIQUE_FRAMES,
            "max_near_duplicate_pairs": MAX_NEAR_DUPLICATE_PAIRS,
            "min_lower_body_motion": MIN_LOWER_BODY_MOTION,
            "min_upper_body_motion": MIN_UPPER_BODY_MOTION,
            "min_arm_region_motion": MIN_ARM_REGION_MOTION,
            "min_arm_centroid_spread_px": MIN_ARM_CENTROID_SPREAD_PX,
        },
        "walk_right": {
            "status": "PASSED" if not right_failures else "FAILED",
            "failures": right_failures,
            "frame_count": len(right_paths),
            "metrics": right_metrics,
        },
        "walk_left": {
            "status": "PASSED" if not left_failures else "FAILED",
            "failures": left_failures,
            "frame_count": len(left_paths),
            "metrics": left_metrics,
        },
        "right_motion": right_motion,
        "left_motion": left_motion,
        "right_anti_warp_observations": right_anti_warp,
        "left_anti_warp_observations": left_anti_warp,
        "right_arm_region_observations": right_arm,
        "left_arm_region_observations": left_arm,
        "mirror_compatibility": {
            "status": "PASSED" if not mirror_failures else "FAILED",
            "failures": mirror_failures,
        },
    }
    motion_summary = {
        "generated_at": report["generated_at"],
        "final_motion_status": pixel_motion_status,
        "pixel_motion_status": pixel_motion_status,
        "candidate_validation_status": candidate_validation_status,
        "human_review_status": HUMAN_REVIEW_REQUIRED_STATUS,
        "human_review_required": True,
        "warnings": [HUMAN_REVIEW_WARNING] + right_arm.get("warnings", []) + left_arm.get("warnings", []),
        "static_candidate": bool(failures),
        "median_consecutive_diff": right_motion.get("median_consecutive_diff"),
        "max_consecutive_diff": right_motion.get("max_consecutive_diff"),
        "min_consecutive_diff": right_motion.get("min_consecutive_diff"),
        "loop_delta": right_motion.get("loop_delta"),
        "unique_frame_count": right_motion.get("unique_frame_count"),
        "near_duplicate_pair_count": right_motion.get("near_duplicate_pair_count"),
        "lower_body_motion_energy": right_motion.get("lower_body_motion_energy"),
        "upper_body_motion_energy": right_motion.get("upper_body_motion_energy"),
        "right_motion_status": right_motion.get("status"),
        "left_motion_status": left_motion.get("status"),
        "right_anti_warp_status": right_anti_warp.get("status"),
        "left_anti_warp_status": left_anti_warp.get("status"),
        "right_arm_region_status": right_arm.get("status"),
        "left_arm_region_status": left_arm.get("status"),
        "arm_region_motion_energy": right_arm.get("arm_region_motion_energy"),
        "arm_region_centroid_x_spread": right_arm.get("arm_region_centroid_x_spread"),
        "arm_region_centroid_y_spread": right_arm.get("arm_region_centroid_y_spread"),
        "arm_region_warnings": right_arm.get("warnings", []) + left_arm.get("warnings", []),
        "anti_warp_warnings": right_anti_warp.get("warnings", []) + left_anti_warp.get("warnings", []),
        "failures": failures,
    }

    render_diff_sheet(diff_sheet_path, right_frames, right_motion, "walk_right")
    ensure_dir(out_path.parent)
    out_path.write_text(json.dumps(strip_images(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    motion_out_path.write_text(json.dumps(motion_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(motion_summary, ensure_ascii=False, indent=2))
    if not failures:
        print(HUMAN_REVIEW_WARNING)
        return 0
    return fail(pixel_motion_status)


if __name__ == "__main__":
    sys.exit(main())
