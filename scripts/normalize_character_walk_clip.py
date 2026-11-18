#!/usr/bin/env python3
import argparse
import hashlib
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops


ALPHA_THRESHOLD = 16
EXPECTED_FRAMES = 16
EDGE_MARGIN_PX = 8
HEIGHT_SPREAD_LIMIT_PX = 1
BASELINE_SPREAD_LIMIT_PX = 2
ROOT_X_SPREAD_LIMIT_PX = 3
SIDE_VIEW_SOURCE = Path("Assets/CharacterV2/source/side_view/canonical_side_view_facing_right.png")
SIDE_VIEW_ACCEPTED_MD = Path("Assets/CharacterV2/source/side_view/canonical_side_view_facing_right.accepted.md")
SIDE_VIEW_INSPECT_JSON = Path("Assets/CharacterV2/source/side_view/canonical_side_view_facing_right.inspect.json")


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    return 1


def blocked_missing_side_view(message):
    print("FINAL_STATUS=BLOCKED_BY_MISSING_APPROVED_SIDE_VIEW")
    return fail(message)


def ensure_dir(path):
    path.mkdir(parents=True, exist_ok=True)


def open_rgba(path):
    image = Image.open(path)
    return image.convert("RGBA")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def accepted_markdown_value(text, key):
    key_lower = key.lower()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" in stripped:
            name, value = stripped.split(":", 1)
        elif "=" in stripped:
            name, value = stripped.split("=", 1)
        else:
            continue
        if name.strip().lower() == key_lower:
            return value.strip()
    return None


def validate_side_view_precondition(root, source_path, accepted_path, inspect_path):
    source = (root / source_path).resolve() if not Path(source_path).is_absolute() else Path(source_path)
    accepted = (root / accepted_path).resolve() if not Path(accepted_path).is_absolute() else Path(accepted_path)
    inspect_json = (root / inspect_path).resolve() if not Path(inspect_path).is_absolute() else Path(inspect_path)

    if not source.exists():
        return f"approved side-view source PNG is missing: {source}"
    if not accepted.exists():
        return f"side-view acceptance file is missing: {accepted}"
    if not inspect_json.exists():
        return f"side-view inspect JSON is missing: {inspect_json}"

    text = accepted.read_text(encoding="utf-8")
    accepted_flag = accepted_markdown_value(text, "HUMAN_ACCEPTED")
    if accepted_flag != "true":
        return f"side-view source is not human accepted: HUMAN_ACCEPTED={accepted_flag or '<missing>'}"

    declared_sha = (
        accepted_markdown_value(text, "source_sha256")
        or accepted_markdown_value(text, "source SHA-256")
        or accepted_markdown_value(text, "source_sha-256")
    )
    if not declared_sha:
        return "side-view acceptance file is missing source SHA-256"
    actual_sha = sha256_file(source)
    if declared_sha.lower() != actual_sha:
        return "side-view source SHA-256 does not match acceptance file"

    try:
        inspect_report = json.loads(inspect_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return f"side-view inspect JSON is unreadable: {error}"
    source_report = inspect_report.get("source", {})
    if not source_report.get("alpha_present", source_report.get("has_rgba_alpha", False)):
        return "side-view inspect JSON does not confirm alpha is present"
    if not source_report.get("margin_check_passed", False):
        return "side-view inspect JSON does not confirm transparent margin checks passed"
    if source_report.get("errors"):
        return "side-view inspect JSON contains blocking errors"
    return None


def alpha_mask(image):
    return image.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")


def metric_for_image(image, path, index):
    mask = alpha_mask(image)
    bbox = mask.getbbox()
    if bbox is None:
        return {
            "frame_index": index,
            "path": str(path),
            "canvas_width": image.width,
            "canvas_height": image.height,
            "empty_alpha": True,
        }
    left, top, right, bottom = bbox
    alpha_histogram = image.getchannel("A").histogram()
    alpha_area = sum(alpha_histogram[ALPHA_THRESHOLD + 1 :])
    return {
        "frame_index": index,
        "path": str(path),
        "canvas_width": image.width,
        "canvas_height": image.height,
        "bbox_left": left,
        "bbox_top": top,
        "bbox_right": right,
        "bbox_bottom": bottom,
        "visible_width": right - left,
        "visible_height": bottom - top,
        "foot_baseline_y": bottom - 1,
        "root_x": (left + right) / 2,
        "alpha_area": alpha_area,
        "empty_alpha": False,
        "edge_margin_min": min(left, top, image.width - right, image.height - bottom),
    }


def load_source_frames(source):
    source = Path(source)
    if source.is_dir():
        paths = sorted(path for path in source.iterdir() if path.suffix.lower() == ".png")
        return [(path, open_rgba(path)) for path in paths]
    image = open_rgba(source)
    width, height = image.size
    candidates = [(4, 4), (8, 2), (16, 1), (1, 16), (2, 8)]
    for columns, rows in candidates:
        if width % columns == 0 and height % rows == 0 and columns * rows == EXPECTED_FRAMES:
            frame_width = width // columns
            frame_height = height // rows
            frames = []
            for index in range(EXPECTED_FRAMES):
                x = (index % columns) * frame_width
                y = (index // columns) * frame_height
                frames.append((source, image.crop((x, y, x + frame_width, y + frame_height))))
            return frames
    raise ValueError(f"cannot infer 16-frame grid from sheet size {width}x{height}: {source}")


def normalized_frames(source_frames, target_canvas, target_height, baseline_y, root_x):
    normalized = []
    trace_frames = []
    for index, (path, image) in enumerate(source_frames):
        source_metric = metric_for_image(image, path, index)
        if source_metric.get("empty_alpha"):
            raise ValueError(f"frame {index} has missing/corrupted alpha")
        bbox = (
            source_metric["bbox_left"],
            source_metric["bbox_top"],
            source_metric["bbox_right"],
            source_metric["bbox_bottom"],
        )
        trimmed = image.crop(bbox)
        scale = target_height / max(source_metric["visible_height"], 1)
        size = (
            max(1, int(round(trimmed.width * scale))),
            max(1, int(round(trimmed.height * scale))),
        )
        resized = trimmed.resize(size, Image.Resampling.LANCZOS)
        canvas = composite_normalized(resized, target_canvas, target_height, baseline_y, root_x)
        output_metric = metric_for_image(canvas, path, index)
        normalized.append(canvas)
        trace_frames.append({"source": source_metric, "normalized": output_metric})
    return normalized, trace_frames


def composite_normalized(trimmed, target_canvas, target_height, baseline_y, root_x):
    current = trimmed
    for _attempt in range(3):
        metric = metric_for_image(current, "normalized_trimmed.png", 0)
        if metric.get("empty_alpha"):
            raise ValueError("trimmed frame has missing/corrupted alpha")
        if metric["visible_height"] != target_height:
            bbox = (
                metric["bbox_left"],
                metric["bbox_top"],
                metric["bbox_right"],
                metric["bbox_bottom"],
            )
            cropped = current.crop(bbox)
            scale = target_height / max(metric["visible_height"], 1)
            current = cropped.resize(
                (
                    max(1, int(round(cropped.width * scale))),
                    max(1, int(round(cropped.height * scale))),
                ),
                Image.Resampling.LANCZOS,
            )
            continue
        break

    metric = metric_for_image(current, "normalized_trimmed.png", 0)
    bbox = (
        metric["bbox_left"],
        metric["bbox_top"],
        metric["bbox_right"],
        metric["bbox_bottom"],
    )
    cropped = current.crop(bbox)
    canvas = Image.new("RGBA", target_canvas, (0, 0, 0, 0))
    x = int(round(root_x - cropped.width / 2))
    y = int(round(baseline_y - cropped.height + 1))
    canvas.alpha_composite(cropped, (x, y))
    return canvas


def validate_normalized(metrics):
    failures = []
    if len(metrics) != EXPECTED_FRAMES:
        failures.append(f"frame count != {EXPECTED_FRAMES}")
    if any(metric.get("empty_alpha") for metric in metrics):
        failures.append("alpha is missing or corrupted")
    sizes = {(m["canvas_width"], m["canvas_height"]) for m in metrics}
    if len(sizes) != 1:
        failures.append("canvas size is not constant")
    if any(m.get("edge_margin_min", 0) < EDGE_MARGIN_PX for m in metrics if not m.get("empty_alpha")):
        failures.append(f"non-transparent pixels within {EDGE_MARGIN_PX}px of canvas edge")
    heights = [m["visible_height"] for m in metrics if not m.get("empty_alpha")]
    baselines = [m["foot_baseline_y"] for m in metrics if not m.get("empty_alpha")]
    roots = [m["root_x"] for m in metrics if not m.get("empty_alpha")]
    if heights and max(heights) - min(heights) > HEIGHT_SPREAD_LIMIT_PX:
        failures.append("bbox height variation after normalization > 1 px")
    if baselines and max(baselines) - min(baselines) > BASELINE_SPREAD_LIMIT_PX:
        failures.append("foot baseline variation > 2 px")
    if roots and max(roots) - min(roots) > ROOT_X_SPREAD_LIMIT_PX:
        failures.append("root pivot variation > 3 px")
    return failures


def consecutive_diff_ratios(frames):
    ratios = []
    for index in range(len(frames)):
        first = frames[index]
        second = frames[(index + 1) % len(frames)]
        diff = ImageChops.difference(first, second).convert("L")
        ratios.append(sum(diff.tobytes()) / max(1, diff.width * diff.height * 255))
    return ratios


def write_outputs(frames, output_dir, clip_id):
    ensure_dir(output_dir)
    paths = []
    for index, image in enumerate(frames):
        path = output_dir / f"{clip_id}_{index:02d}.png"
        image.save(path)
        paths.append(path)
    return paths


def main():
    parser = argparse.ArgumentParser(description="Normalize a 16-frame CharacterV2 walk clip into a stable canvas.")
    parser.add_argument("--source", required=True, help="Source PNG sheet or directory of PNG frames.")
    parser.add_argument("--output", required=True, help="Output directory for normalized PNG frames.")
    parser.add_argument("--clip-id", required=True, choices=["walk_left", "walk_right"])
    parser.add_argument("--canvas-width", type=int, default=384)
    parser.add_argument("--canvas-height", type=int, default=512)
    parser.add_argument("--target-height", type=int, default=464)
    parser.add_argument("--baseline-y", type=int, default=488)
    parser.add_argument("--root-x", type=int, default=192)
    parser.add_argument("--trace-dir", default="Assets/CharacterV2/review")
    parser.add_argument("--side-view-source", default=str(SIDE_VIEW_SOURCE))
    parser.add_argument("--side-view-accepted-md", default=str(SIDE_VIEW_ACCEPTED_MD))
    parser.add_argument("--side-view-inspect-json", default=str(SIDE_VIEW_INSPECT_JSON))
    parser.add_argument(
        "--debug-allow-unaccepted-source",
        action="store_true",
        help="Bypass the human-accepted side-view source gate for local diagnostics only.",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    if not args.debug_allow_unaccepted_source:
        precondition_error = validate_side_view_precondition(
            root,
            Path(args.side_view_source),
            Path(args.side_view_accepted_md),
            Path(args.side_view_inspect_json),
        )
        if precondition_error:
            return blocked_missing_side_view(precondition_error)

    source_frames = load_source_frames(args.source)
    if len(source_frames) != EXPECTED_FRAMES:
        return fail(f"frame count != {EXPECTED_FRAMES}: {len(source_frames)}")

    frames, trace_frames = normalized_frames(
        source_frames,
        (args.canvas_width, args.canvas_height),
        args.target_height,
        args.baseline_y,
        args.root_x,
    )
    metrics = [metric_for_image(image, f"{args.clip_id}_{index:02d}.png", index) for index, image in enumerate(frames)]
    failures = validate_normalized(metrics)
    diffs = consecutive_diff_ratios(frames)
    median = statistics.median(diffs) if diffs else 0
    if median > 0 and max(diffs) > median * 2.5:
        failures.append("max consecutive diff > 2.5x median consecutive diff")
    if any(value == 0 for value in diffs):
        failures.append("duplicate consecutive frame without hold marker")

    trace = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "clip_id": args.clip_id,
        "source": str(Path(args.source).resolve()),
        "output": str(Path(args.output).resolve()),
        "normalization": {
            "canvas": [args.canvas_width, args.canvas_height],
            "target_height": args.target_height,
            "baseline_y": args.baseline_y,
            "root_x": args.root_x,
        },
        "frame_count": len(frames),
        "frames": trace_frames,
        "normalized_metrics": metrics,
        "consecutive_diff_ratios": diffs,
        "failures": failures,
        "status": "FAILED" if failures else "PASSED",
    }
    trace_dir = root / args.trace_dir
    ensure_dir(trace_dir)
    trace_path = trace_dir / f"walk_normalization_trace_{args.clip_id}.json"
    trace_path.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if failures:
        for item in failures:
            print(f"FAIL: {item}", file=sys.stderr)
        print(f"Wrote trace: {trace_path}")
        return 1

    output_paths = write_outputs(frames, Path(args.output), args.clip_id)
    print(f"Wrote {len(output_paths)} frames to {args.output}")
    print(f"Wrote trace: {trace_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
