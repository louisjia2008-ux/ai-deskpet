#!/usr/bin/env python3
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image


ALPHA_THRESHOLD = 16
REAL_ALPHA_MAX_TRANSPARENT = 5
MIN_ALPHA_ZERO_RATIO = 0.05
MIN_TRANSPARENT_MARGIN_PX = 8
HEIGHT_RATIO_WARNING = 0.18
WIDTH_RATIO_WARNING = 0.45
ASPECT_RATIO_WARNING = 0.30
GREEN_MIN = 150
GREEN_CHANNEL_DELTA = 70


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def ensure_dir(path):
    path.mkdir(parents=True, exist_ok=True)


def color_to_hex(color):
    return "#{:02x}{:02x}{:02x}".format(*color[:3])


def is_chroma_green(color):
    red, green, blue = color[:3]
    return (
        green >= GREEN_MIN
        and green - red >= GREEN_CHANNEL_DELTA
        and green - blue >= GREEN_CHANNEL_DELTA
    )


def corner_samples(image, sample_size=12):
    width, height = image.size
    boxes = {
        "top_left": (0, 0, sample_size, sample_size),
        "top_right": (max(0, width - sample_size), 0, width, sample_size),
        "bottom_left": (0, max(0, height - sample_size), sample_size, height),
        "bottom_right": (max(0, width - sample_size), max(0, height - sample_size), width, height),
    }
    samples = {}
    for name, box in boxes.items():
        crop = image.crop(box).convert("RGB")
        raw = crop.tobytes()
        pixels = [raw[index : index + 3] for index in range(0, len(raw), 3)]
        average = tuple(round(sum(pixel[index] for pixel in pixels) / max(1, len(pixels))) for index in range(3))
        samples[name] = {
            "rgb": list(average),
            "hex": color_to_hex(average),
            "is_chroma_green": is_chroma_green(average),
        }
    return samples


def green_screen_ratio(image):
    rgb = image.convert("RGB")
    total = rgb.width * rgb.height
    raw = rgb.tobytes()
    green_pixels = sum(1 for index in range(0, len(raw), 3) if is_chroma_green(raw[index : index + 3]))
    return green_pixels / max(1, total)


def inspect_png(path):
    record = {
        "path": str(path),
        "exists": path.exists(),
        "readable": False,
        "mode": None,
        "has_alpha_channel": False,
        "has_rgba_alpha": False,
        "alpha_present": False,
        "alpha_min": None,
        "alpha_max": None,
        "alpha_zero_ratio": None,
        "alpha_transparent_pixel_count": None,
        "alpha_opaque_pixel_count": None,
        "has_real_transparency": False,
        "green_screen_pixel_ratio": None,
        "corner_colors": None,
        "likely_chroma_key_background": False,
        "canvas_width": None,
        "canvas_height": None,
        "bbox": None,
        "visible_width": None,
        "visible_height": None,
        "foot_baseline_y": None,
        "alpha_area": None,
        "transparent_margin": None,
        "margin_check_passed": False,
        "touches_edge": None,
        "warnings": [],
        "errors": [],
    }
    if not path.exists():
        record["errors"].append("file does not exist")
        return record
    try:
        image = Image.open(path)
        record["readable"] = True
        record["mode"] = image.mode
        rgba = image.convert("RGBA")
    except Exception as error:
        record["errors"].append(f"PNG unreadable: {error}")
        return record

    record["canvas_width"], record["canvas_height"] = rgba.size
    alpha = rgba.getchannel("A")
    alpha_histogram = alpha.histogram()
    total_pixels = rgba.width * rgba.height
    alpha_min = next((index for index, count in enumerate(alpha_histogram) if count), None)
    alpha_max = next((index for index in range(255, -1, -1) if alpha_histogram[index]), None)
    zero_count = alpha_histogram[0]
    transparent_count = sum(alpha_histogram[: REAL_ALPHA_MAX_TRANSPARENT + 1])
    opaque_count = alpha_histogram[255]
    has_alpha_channel = "A" in image.getbands() or image.mode == "RGBA" or "transparency" in image.info
    alpha_zero_ratio = zero_count / max(1, total_pixels)
    has_real_transparency = (
        has_alpha_channel
        and alpha_min is not None
        and alpha_min <= REAL_ALPHA_MAX_TRANSPARENT
        and alpha_zero_ratio > MIN_ALPHA_ZERO_RATIO
    )
    corners = corner_samples(rgba)
    record.update({
        "has_alpha_channel": has_alpha_channel,
        "has_rgba_alpha": has_alpha_channel,
        "alpha_present": has_real_transparency,
        "alpha_min": alpha_min,
        "alpha_max": alpha_max,
        "alpha_zero_ratio": alpha_zero_ratio,
        "alpha_transparent_pixel_count": transparent_count,
        "alpha_opaque_pixel_count": opaque_count,
        "has_real_transparency": has_real_transparency,
        "green_screen_pixel_ratio": green_screen_ratio(rgba),
        "corner_colors": corners,
    })
    corners_are_green = all(sample["is_chroma_green"] for sample in corners.values())
    record["likely_chroma_key_background"] = corners_are_green and not has_real_transparency
    if not has_alpha_channel:
        record["errors"].append("alpha channel is missing")
    elif not has_real_transparency:
        if alpha_min == 255 and alpha_max == 255:
            record["errors"].append("alpha channel exists but is fully opaque")
        else:
            record["errors"].append("real transparent alpha requirement failed")
    if record["likely_chroma_key_background"]:
        record["warnings"].append("likely chroma-key green background is real image pixels")

    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    bbox = mask.getbbox()
    if bbox is None:
        record["errors"].append("non-transparent bbox is empty")
        return record

    left, top, right, bottom = bbox
    margins = {
        "left": left,
        "top": top,
        "right": rgba.width - right,
        "bottom": rgba.height - bottom,
    }
    record.update({
        "bbox": [left, top, right, bottom],
        "visible_width": right - left,
        "visible_height": bottom - top,
        "foot_baseline_y": bottom - 1,
        "alpha_area": sum(alpha_histogram[ALPHA_THRESHOLD + 1 :]),
        "transparent_margin": margins,
        "touches_edge": any(value == 0 for value in margins.values()),
        "margin_check_passed": all(value >= MIN_TRANSPARENT_MARGIN_PX for value in margins.values()),
    })
    if record["touches_edge"]:
        record["errors"].append("non-transparent pixels touch canvas edge")
    if any(value < MIN_TRANSPARENT_MARGIN_PX for value in margins.values()):
        record["warnings"].append(f"transparent margin is less than {MIN_TRANSPARENT_MARGIN_PX}px on at least one side")
    return record


def add_canonical_ratio_warnings(source, canonical):
    if source["errors"] or canonical["errors"]:
        return
    source_aspect = source["visible_width"] / max(source["visible_height"], 1)
    canonical_aspect = canonical["visible_width"] / max(canonical["visible_height"], 1)
    height_ratio = source["visible_height"] / max(canonical["visible_height"], 1)
    width_ratio = source["visible_width"] / max(canonical["visible_width"], 1)
    aspect_ratio = source_aspect / max(canonical_aspect, 0.0001)
    source["canonical_comparison"] = {
        "height_ratio": height_ratio,
        "width_ratio": width_ratio,
        "aspect_ratio": aspect_ratio,
        "height_ratio_deviation": abs(height_ratio - 1),
        "width_ratio_deviation": abs(width_ratio - 1),
        "aspect_ratio_deviation": abs(aspect_ratio - 1),
    }
    if abs(height_ratio - 1) > HEIGHT_RATIO_WARNING:
        source["warnings"].append("bbox height differs substantially from canonical")
    if abs(width_ratio - 1) > WIDTH_RATIO_WARNING:
        source["warnings"].append("bbox width differs substantially from canonical")
    if abs(aspect_ratio - 1) > ASPECT_RATIO_WARNING:
        source["warnings"].append("bbox aspect ratio differs substantially from canonical")


def main():
    parser = argparse.ArgumentParser(description="Inspect a proposed CharacterV2 canonical side-view source PNG.")
    parser.add_argument("--source", required=True, help="Candidate side-view PNG.")
    parser.add_argument("--canonical", required=True, help="Canonical front/idle PNG for ratio comparison.")
    parser.add_argument("--out", required=True, help="Output JSON report path.")
    args = parser.parse_args()

    source_path = Path(args.source)
    canonical_path = Path(args.canonical)
    source = inspect_png(source_path)
    canonical = inspect_png(canonical_path)
    add_canonical_ratio_warnings(source, canonical)

    report = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "status": (
            "REJECTED_NEEDS_TRANSPARENT_ALPHA"
            if not source.get("has_real_transparency")
            else "FAILED_BASIC_INTAKE"
            if source["errors"]
            else "READY_FOR_HUMAN_REVIEW"
        ),
        "source": source,
        "canonical": canonical,
        "human_review_required": [
            "same outfit as canonical RGBA",
            "same side ponytail and hair accessory identity",
            "same head/body ratio",
            "same color palette",
            "same face style",
            "same line/rendering style",
            "neutral side standing pose suitable for walk-cycle generation",
        ],
    }
    out = Path(args.out)
    ensure_dir(out.parent)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    if source["errors"]:
        for item in source["errors"]:
            print(f"FAIL: {item}", file=sys.stderr)
        print(report["status"])
        return 1
    for item in source["warnings"]:
        print(f"WARNING: {item}")
    print("OK: side-view source passed basic technical intake; human art review is still required")
    return 0


if __name__ == "__main__":
    sys.exit(main())
