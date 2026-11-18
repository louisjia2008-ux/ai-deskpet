#!/usr/bin/env python3
"""Validate approved DragonV1 runtime assets and acceptance metadata."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops


EXPECTED_CLIPS = {
    "dragon_idle_hover": {"frames": 12, "fps": 8, "loop": True, "state": "idleHover"},
    "dragon_fly_left_loop": {"frames": 12, "fps": 8, "loop": True, "state": "flyLeft"},
    "dragon_fly_right_loop": {"frames": 12, "fps": 8, "loop": True, "state": "flyRight"},
    "dragon_takeoff": {"frames": 8, "fps": 8, "loop": False, "state": "takeoff"},
    "dragon_land": {"frames": 8, "fps": 8, "loop": False, "state": "land"},
}

EXPECTED_CANVAS = (512, 512)
EXPECTED_ANCHOR = (256, 268)
EXPECTED_ACCEPTANCE = "ACCEPTED"
ALPHA_THRESHOLD = 16
EDGE_MARGIN_MIN = 12
HEIGHT_DRIFT_LIMIT = 0.025
CENTER_X_DRIFT_LIMIT = 2.0
CENTER_Y_DRIFT_LIMIT = 2.0
LOOP_SEAM_LIMIT = 0.035
APPROVED_RELATIVE = Path("Assets/DragonV1/approved")
REJECTED_RELATIVE = Path("Assets/DragonV1/rejected")
RUNTIME_CHECKLIST = "DRAGON_V1_RUNTIME_ACCEPTANCE_CHECKLIST.md"
REJECTION_REASON = (
    "DragonV1 wing animation and repeated wing rework attempts failed human visual review. "
    "Wings appear artificial, panel-like, disconnected, structurally incorrect, and unsuitable for desktop companion quality."
)


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


def frame_names(count: int) -> list[str]:
    return [f"frame_{index:03d}.png" for index in range(count)]


def metric_for_frame(path: Path) -> dict[str, Any]:
    image = Image.open(path)
    rgba = image.convert("RGBA")
    bbox = alpha_bbox(rgba)
    metric: dict[str, Any] = {
        "path": str(path),
        "mode": image.mode,
        "canvas": [rgba.width, rgba.height],
        "rgba": image.mode == "RGBA",
        "alpha_non_empty": bbox is not None,
        "alpha_bbox": list(bbox) if bbox else None,
    }
    if bbox is None:
        return metric

    left, top, right, bottom = bbox
    alpha = rgba.getchannel("A")
    corners = [
        alpha.getpixel((0, 0)),
        alpha.getpixel((rgba.width - 1, 0)),
        alpha.getpixel((0, rgba.height - 1)),
        alpha.getpixel((rgba.width - 1, rgba.height - 1)),
    ]
    metric.update(
        {
            "visible_width": right - left,
            "visible_height": bottom - top,
            "body_center": [(left + right) / 2, (top + bottom) / 2],
            "edge_margin": min(left, top, rgba.width - right, rgba.height - bottom),
            "corner_alpha_max": max(corners),
        }
    )
    return metric


def validate_clip_dir(clip_dir: Path, clip_name: str, spec: dict[str, Any]) -> dict[str, Any]:
    failures: list[str] = []
    expected_names = frame_names(spec["frames"])
    paths = sorted(clip_dir.glob("*.png"))
    names = [path.name for path in paths]

    if not clip_dir.exists():
        failures.append(f"missing approved clip dir: {clip_dir}")
    if names != expected_names:
        failures.append(f"frame names/count mismatch: expected {expected_names}, got {names}")

    frames = [Image.open(path).convert("RGBA") for path in paths]
    metrics = [metric_for_frame(path) for path in paths]
    if any(tuple(metric["canvas"]) != EXPECTED_CANVAS for metric in metrics):
        failures.append("one or more frames have an unexpected canvas size")
    if any(not metric["rgba"] for metric in metrics):
        failures.append("one or more frames are not RGBA PNGs")
    if any(not metric["alpha_non_empty"] for metric in metrics):
        failures.append("one or more frames have empty alpha")

    valid = [metric for metric in metrics if metric.get("alpha_non_empty")]
    heights = [metric["visible_height"] for metric in valid]
    centers_x = [metric["body_center"][0] for metric in valid]
    centers_y = [metric["body_center"][1] for metric in valid]
    edges = [metric["edge_margin"] for metric in valid]
    corner_alpha_max = max([metric.get("corner_alpha_max", 255) for metric in valid], default=255)

    height_drift_ratio = 0.0
    center_x_drift = 0.0
    center_y_drift = 0.0
    edge_margin_min = min(edges) if edges else 0
    loop_seam = None

    if heights:
        mean_height = sum(heights) / len(heights)
        height_drift_ratio = (max(heights) - min(heights)) / max(1, mean_height)
        if height_drift_ratio > HEIGHT_DRIFT_LIMIT:
            failures.append(f"visual height drift {height_drift_ratio:.4f} > {HEIGHT_DRIFT_LIMIT:.4f}")
    if centers_x:
        center_x_drift = max(centers_x) - min(centers_x)
        if center_x_drift > CENTER_X_DRIFT_LIMIT:
            failures.append(f"body center horizontal drift {center_x_drift:.3f}px > {CENTER_X_DRIFT_LIMIT:.3f}px")
    if centers_y:
        center_y_drift = max(centers_y) - min(centers_y)
        if center_y_drift > CENTER_Y_DRIFT_LIMIT:
            failures.append(f"body center vertical drift {center_y_drift:.3f}px > {CENTER_Y_DRIFT_LIMIT:.3f}px")
    if edge_margin_min < EDGE_MARGIN_MIN:
        failures.append(f"edge margin {edge_margin_min}px < {EDGE_MARGIN_MIN}px")
    if corner_alpha_max > 0:
        failures.append(f"transparent corner alpha max {corner_alpha_max} > 0")
    if spec["loop"] and frames:
        loop_seam = diff_ratio(frames[-1], frames[0])
        if loop_seam > LOOP_SEAM_LIMIT:
            failures.append(f"loop seam diff {loop_seam:.4f} > {LOOP_SEAM_LIMIT:.4f}")

    return {
        "clip_name": clip_name,
        "path": str(clip_dir),
        "expected_frame_count": spec["frames"],
        "frame_count": len(paths),
        "fps": spec["fps"],
        "loop": spec["loop"],
        "height_drift_ratio": height_drift_ratio,
        "body_center_horizontal_drift_px": center_x_drift,
        "body_center_vertical_drift_px": center_y_drift,
        "edge_margin_min_px": edge_margin_min,
        "loop_seam_diff_ratio": loop_seam,
        "frames": metrics,
        "passed": not failures,
        "failures": failures,
    }


def validate_manifest(root: Path) -> dict[str, Any]:
    manifest_path = root / APPROVED_RELATIVE / "manifests/dragon_v1_manifest.json"
    failures: list[str] = []
    if not manifest_path.exists():
        return {"path": str(manifest_path), "passed": False, "failures": [f"missing manifest: {manifest_path}"]}
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    clips = {clip.get("name"): clip for clip in data.get("clips", [])}

    if data.get("HUMAN_VISUAL_ACCEPTANCE") != EXPECTED_ACCEPTANCE:
        failures.append(f"HUMAN_VISUAL_ACCEPTANCE is {data.get('HUMAN_VISUAL_ACCEPTANCE')!r}, expected ACCEPTED")
    if data.get("assetStatus") != "approved":
        failures.append(f"assetStatus is {data.get('assetStatus')!r}, expected approved")
    if not data.get("acceptedReviewPackagePath"):
        failures.append("acceptedReviewPackagePath is missing")
    if data.get("acceptedReviewTimestamp") != "20260628_160147":
        failures.append("acceptedReviewTimestamp does not match accepted package timestamp")

    for name, spec in EXPECTED_CLIPS.items():
        clip = clips.get(name)
        if clip is None:
            failures.append(f"manifest missing clip {name}")
            continue
        if clip.get("state") != spec["state"]:
            failures.append(f"{name} state {clip.get('state')!r} != {spec['state']!r}")
        if clip.get("frameCount") != spec["frames"]:
            failures.append(f"{name} frameCount {clip.get('frameCount')!r} != {spec['frames']}")
        if clip.get("fps") != spec["fps"]:
            failures.append(f"{name} fps {clip.get('fps')!r} != {spec['fps']}")
        if clip.get("loop") != spec["loop"]:
            failures.append(f"{name} loop {clip.get('loop')!r} != {spec['loop']!r}")
        if list(clip.get("frames", [])) != frame_names(spec["frames"]):
            failures.append(f"{name} frames do not match approved frame naming")
        canvas = clip.get("canvasSize", {})
        if (canvas.get("width"), canvas.get("height")) != EXPECTED_CANVAS:
            failures.append(f"{name} canvasSize does not match {EXPECTED_CANVAS}")
        anchor = clip.get("anchorPoint", {})
        if (anchor.get("x"), anchor.get("y")) != EXPECTED_ANCHOR:
            failures.append(f"{name} anchorPoint does not match {EXPECTED_ANCHOR}")

    extras = sorted(set(clips) - set(EXPECTED_CLIPS))
    if extras:
        failures.append(f"manifest contains unexpected clips: {extras}")

    return {
        "path": str(manifest_path),
        "accepted_review_package_path": data.get("acceptedReviewPackagePath"),
        "accepted_review_timestamp": data.get("acceptedReviewTimestamp"),
        "human_visual_acceptance": data.get("HUMAN_VISUAL_ACCEPTANCE"),
        "clip_count": len(clips),
        "passed": not failures,
        "failures": failures,
    }


def acceptance_record_report(root: Path) -> dict[str, Any]:
    record_path = root / APPROVED_RELATIVE / "DRAGON_V1_ACCEPTANCE_RECORD.md"
    failures: list[str] = []
    if not record_path.exists():
        failures.append(f"missing acceptance record: {record_path}")
        return {"path": str(record_path), "passed": False, "failures": failures}
    text = record_path.read_text(encoding="utf-8")
    if "HUMAN_VISUAL_ACCEPTANCE = ACCEPTED" not in text:
        failures.append("acceptance record does not mark human acceptance as ACCEPTED")
    for clip in EXPECTED_CLIPS:
        if clip not in text:
            failures.append(f"acceptance record does not mention {clip}")
    return {"path": str(record_path), "passed": not failures, "failures": failures}


def approved_extras_report(root: Path) -> dict[str, Any]:
    approved_root = root / APPROVED_RELATIVE
    allowed_suffixes = {".png", ".json", ".md"}
    media_suffixes = {".gif", ".mp4", ".mov", ".webm"}
    failures: list[str] = []
    if not approved_root.exists():
        failures.append(f"missing approved root: {approved_root}")
        return {"path": str(approved_root), "passed": False, "failures": failures}
    for path in approved_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() in media_suffixes:
            failures.append(f"review preview media must not be in approved: {path}")
        if path.suffix.lower() and path.suffix.lower() not in allowed_suffixes:
            failures.append(f"unexpected approved file type: {path}")
    return {"path": str(approved_root), "passed": not failures, "failures": failures}


def runtime_rejection_report(root: Path) -> dict[str, Any]:
    checklist_path = root / APPROVED_RELATIVE / RUNTIME_CHECKLIST
    failures: list[str] = []
    if not checklist_path.exists():
        failures.append(f"missing runtime acceptance checklist: {checklist_path}")
        return {"path": str(checklist_path), "passed": False, "failures": failures}
    text = checklist_path.read_text(encoding="utf-8")
    if "RUNTIME_HUMAN_ACCEPTANCE = FAILED" not in text:
        failures.append("runtime checklist does not mark RUNTIME_HUMAN_ACCEPTANCE = FAILED")
    if REJECTION_REASON not in text:
        failures.append("runtime checklist does not include the required rejection reason")
    return {
        "path": str(checklist_path),
        "runtime_human_acceptance": "FAILED" if "RUNTIME_HUMAN_ACCEPTANCE = FAILED" in text else "UNKNOWN",
        "passed": not failures,
        "failures": failures,
    }


def rejection_status_report(root: Path) -> dict[str, Any]:
    status_path = root / APPROVED_RELATIVE / "DRAGON_V1_REJECTION_STATUS.json"
    failures: list[str] = []
    if not status_path.exists():
        failures.append(f"missing rejection status: {status_path}")
        return {"path": str(status_path), "passed": False, "failures": failures}
    data = json.loads(status_path.read_text(encoding="utf-8"))
    if data.get("HUMAN_VISUAL_ACCEPTANCE") != "REJECTED":
        failures.append("rejection status does not mark HUMAN_VISUAL_ACCEPTANCE = REJECTED")
    if data.get("runtimeHumanAcceptance") != "FAILED":
        failures.append("rejection status does not mark runtimeHumanAcceptance = FAILED")
    if data.get("fallbackReason") != "dragonV1RejectedOrNoAcceptedManifest":
        failures.append("rejection status fallbackReason must be dragonV1RejectedOrNoAcceptedManifest")
    if data.get("rejectionReason") != REJECTION_REASON:
        failures.append("rejection status does not include the required rejection reason")
    return {"path": str(status_path), "passed": not failures, "failures": failures}


def latest_rejected_snapshot(root: Path) -> Path | None:
    rejected_root = root / REJECTED_RELATIVE
    if not rejected_root.exists():
        return None
    candidates = sorted(rejected_root.glob("dragon_v1_rejected_wing_motion_*"))
    return candidates[-1] if candidates else None


def rejected_snapshot_report(root: Path) -> dict[str, Any]:
    rejected = latest_rejected_snapshot(root)
    failures: list[str] = []
    if rejected is None:
        failures.append(f"missing rejected snapshot under {root / REJECTED_RELATIVE}")
        return {"path": str(root / REJECTED_RELATIVE), "passed": False, "failures": failures}

    snapshot = rejected / "approved_snapshot"
    manifest_path = snapshot / "manifests/dragon_v1_manifest.json"
    record_path = snapshot / "DRAGON_V1_ACCEPTANCE_RECORD.md"
    if not manifest_path.exists():
        failures.append(f"missing rejected snapshot manifest: {manifest_path}")
    if not record_path.exists():
        failures.append(f"missing rejected snapshot acceptance record: {record_path}")
    for name, spec in EXPECTED_CLIPS.items():
        clip_dir = snapshot / "clips" / name
        expected_names = frame_names(spec["frames"])
        names = sorted(path.name for path in clip_dir.glob("*.png"))
        if names != expected_names:
            failures.append(f"rejected snapshot {name} frame names/count mismatch: expected {expected_names}, got {names}")
    return {
        "path": str(rejected),
        "approved_snapshot": str(snapshot),
        "passed": not failures,
        "failures": failures,
    }


def full_visual_rejection_archive_report(root: Path) -> dict[str, Any]:
    rejected_root = root / REJECTED_RELATIVE
    candidates = sorted(rejected_root.glob("dragon_v1_full_visual_reject_*")) if rejected_root.exists() else []
    failures: list[str] = []
    if not candidates:
        failures.append(f"missing full visual rejection archive under {rejected_root}")
        return {"path": str(rejected_root), "passed": False, "failures": failures}
    archive = candidates[-1]
    readme = archive / "README_REJECTED.md"
    if not readme.exists():
        failures.append(f"missing README_REJECTED.md: {readme}")
        return {"path": str(archive), "readme": str(readme), "passed": False, "failures": failures}
    text = readme.read_text(encoding="utf-8")
    for required in (
        "HUMAN_VISUAL_ACCEPTANCE = REJECTED",
        "RUNTIME_HUMAN_ACCEPTANCE = FAILED",
        REJECTION_REASON,
        "DragonV1 should not be loaded by runtime",
    ):
        if required not in text:
            failures.append(f"archive README missing required text: {required}")
    return {"path": str(archive), "readme": str(readme), "passed": not failures, "failures": failures}


def approved_runtime_state_report(root: Path) -> dict[str, Any]:
    approved_root = root / APPROVED_RELATIVE
    manifest_path = approved_root / "manifests/dragon_v1_manifest.json"
    clips_root = approved_root / "clips"
    return {
        "approved_root": str(approved_root),
        "manifest_path": str(manifest_path),
        "clips_root": str(clips_root),
        "manifest_exists": manifest_path.exists(),
        "clips_root_exists": clips_root.exists(),
        "has_loadable_runtime_assets": manifest_path.exists() and clips_root.exists(),
    }


def reference_report(root: Path) -> dict[str, Any]:
    reference_path = root / "Assets/DragonV1/reference/dragon_anchor_rgba.png"
    failures: list[str] = []
    if not reference_path.exists():
        return {"path": str(reference_path), "passed": True, "skipped": True, "failures": []}
    image = Image.open(reference_path)
    if image.mode != "RGBA":
        failures.append(f"reference mode {image.mode} is not RGBA")
    if alpha_bbox(image.convert("RGBA")) is None:
        failures.append("reference alpha is empty")
    return {
        "path": str(reference_path),
        "mode": image.mode,
        "canvas": [image.width, image.height],
        "passed": not failures,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="DeskPet package root.")
    parser.add_argument("--output", help="Optional JSON report path.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    approved_clips_root = root / APPROVED_RELATIVE / "clips"
    approved_state = approved_runtime_state_report(root)

    if not approved_state["manifest_exists"] and not approved_state["clips_root_exists"]:
        report = {
            "status": "PASSED_REJECTED_NO_APPROVED_ASSETS",
            "root": str(root),
            "approved_runtime_state": approved_state,
            "runtime_rejection": runtime_rejection_report(root),
            "rejection_status": rejection_status_report(root),
            "rejected_snapshot": rejected_snapshot_report(root),
            "full_visual_rejection_archive": full_visual_rejection_archive_report(root),
            "approved_extras": approved_extras_report(root),
            "reference": reference_report(root),
            "clips": [],
        }
        report["passed"] = (
            report["runtime_rejection"]["passed"]
            and report["rejection_status"]["passed"]
            and report["rejected_snapshot"]["passed"]
            and report["full_visual_rejection_archive"]["passed"]
            and report["approved_extras"]["passed"]
            and report["reference"]["passed"]
        )
        if not report["passed"]:
            report["status"] = "FAILED"

        data = json.dumps(report, indent=2, sort_keys=True)
        if args.output:
            Path(args.output).write_text(data + "\n", encoding="utf-8")
        print(data)
        return 0 if report["passed"] else 1

    clips = [
        validate_clip_dir(approved_clips_root / name, name, spec)
        for name, spec in EXPECTED_CLIPS.items()
    ]
    report = {
        "status": "PASSED",
        "root": str(root),
        "approved_runtime_state": approved_state,
        "thresholds": {
            "canvas": list(EXPECTED_CANVAS),
            "anchor": list(EXPECTED_ANCHOR),
            "edge_margin_min_px": EDGE_MARGIN_MIN,
            "height_drift_limit": HEIGHT_DRIFT_LIMIT,
            "center_x_drift_limit_px": CENTER_X_DRIFT_LIMIT,
            "center_y_drift_limit_px": CENTER_Y_DRIFT_LIMIT,
            "loop_seam_limit": LOOP_SEAM_LIMIT,
        },
        "manifest": validate_manifest(root),
        "acceptance_record": acceptance_record_report(root),
        "approved_extras": approved_extras_report(root),
        "reference": reference_report(root),
        "clips": clips,
    }
    report["passed"] = (
        report["manifest"]["passed"]
        and report["acceptance_record"]["passed"]
        and report["approved_extras"]["passed"]
        and report["reference"]["passed"]
        and all(clip["passed"] for clip in clips)
    )
    if not report["passed"]:
        report["status"] = "FAILED"

    data = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        Path(args.output).write_text(data + "\n", encoding="utf-8")
    print(data)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
