#!/usr/bin/env python3
"""Build DragonV1 v2 wing rework review assets.

This is intentionally review-only. It does not write to DragonV1/approved.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import statistics
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont


CANVAS = (512, 512)
ALPHA_THRESHOLD = 16
AXIS_X = 256.0
ANCHOR = (256, 268)
DRAGON_RUNTIME_SCALE = 0.16
CHARACTER_RUNTIME_HEIGHT_PT = 132
REFERENCE_SOURCE = Path(
    "Assets/DragonV1/review/dragon_user_image_intact_wing_flight_20260629_213539/sources/base_canvas_source.png"
)
REJECTED_ROOT_PREFIX = "Assets/DragonV1/rejected/dragon_v1_rejected_wing_motion_"
CHARACTER_IDLE = Path("Assets/CharacterV2/approved/clips/idle/frame_000.png")
CHARACTER_WALK_LEFT = Path("Assets/CharacterV2/approved/clips/walk_left/frame_004.png")
CHARACTER_WALK_RIGHT = Path("Assets/CharacterV2/approved/clips/walk_right/frame_004.png")
HABITAT = Path("Assets/CharacterV2/approved/habitat/habitat_blue_white_magic_book_soft_bed_20260620_02.png")


ClipSpec = dict[str, Any]
Point = tuple[float, float]
Pose = dict[str, Point]


FULL_KEY_POSES: dict[str, Pose] = {
    "A_upstroke": {
        "hinge": (165, 224),
        "root_lower": (187, 262),
        "leading": (58, 108),
        "outer": (24, 168),
        "lower_outer": (92, 255),
        "inner_lower": (165, 288),
    },
    "B_mid_downstroke": {
        "hinge": (165, 224),
        "root_lower": (188, 266),
        "leading": (43, 142),
        "outer": (22, 205),
        "lower_outer": (105, 306),
        "inner_lower": (175, 302),
    },
    "C_downstroke": {
        "hinge": (165, 224),
        "root_lower": (191, 270),
        "leading": (58, 203),
        "outer": (46, 286),
        "lower_outer": (139, 366),
        "inner_lower": (193, 314),
    },
    "D_recovery": {
        "hinge": (165, 224),
        "root_lower": (188, 266),
        "leading": (39, 163),
        "outer": (20, 226),
        "lower_outer": (112, 326),
        "inner_lower": (180, 306),
    },
}

POSE_ORDER = ["A_upstroke", "B_mid_downstroke", "C_downstroke", "D_recovery"]

CLIPS: dict[str, ClipSpec] = {
    "dragon_idle_hover_v2": {
        "frames": 12,
        "fps": 8,
        "loop": True,
        "amplitude": 0.78,
        "bob": 2.0,
        "mirror": False,
        "pose_offset": 0,
    },
    "dragon_fly_left_loop_v2": {
        "frames": 12,
        "fps": 8,
        "loop": True,
        "amplitude": 1.12,
        "bob": 4.0,
        "mirror": True,
        "pose_offset": 0,
    },
    "dragon_fly_right_loop_v2": {
        "frames": 12,
        "fps": 8,
        "loop": True,
        "amplitude": 1.12,
        "bob": 4.0,
        "mirror": False,
        "pose_offset": 0,
    },
    "dragon_takeoff_v2": {
        "frames": 8,
        "fps": 8,
        "loop": False,
        "amplitude": 1.15,
        "bob": 0.0,
        "mirror": False,
        "vertical_path": (12, -8),
        "cycle_frame_count": 12,
        "pose_offset": 1,
    },
    "dragon_land_v2": {
        "frames": 8,
        "fps": 8,
        "loop": False,
        "amplitude": 0.95,
        "bob": 0.0,
        "mirror": False,
        "vertical_path": (-8, 10),
        "cycle_frame_count": 12,
        "pose_offset": 1,
        "reverse_cycle": True,
    },
}


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_point(a: Point, b: Point, t: float) -> Point:
    return (lerp(a[0], b[0], t), lerp(a[1], b[1], t))


def interp_pose(a: Pose, b: Pose, t: float) -> Pose:
    t = smoothstep(t)
    return {key: lerp_point(a[key], b[key], t) for key in a}


def scaled_pose(pose: Pose, amplitude: float) -> Pose:
    center = FULL_KEY_POSES["B_mid_downstroke"]
    scaled: Pose = {}
    for key, point in pose.items():
        base = center[key]
        scaled[key] = (
            base[0] + (point[0] - base[0]) * amplitude,
            base[1] + (point[1] - base[1]) * amplitude,
        )
    scaled["hinge"] = center["hinge"]
    return scaled


def loop_pose(frame_index: int, frame_count: int, amplitude: float, offset: int = 0) -> Pose:
    segment_length = frame_count / len(POSE_ORDER)
    raw = (frame_index + offset) / segment_length
    index = int(math.floor(raw)) % len(POSE_ORDER)
    next_index = (index + 1) % len(POSE_ORDER)
    local_t = raw - math.floor(raw)
    if index == len(POSE_ORDER) - 1:
        local_t = {0: 0.0, 1: 0.62, 2: 0.88}.get(int(round(local_t * segment_length)), local_t)
    pose = interp_pose(FULL_KEY_POSES[POSE_ORDER[index]], FULL_KEY_POSES[POSE_ORDER[next_index]], local_t)
    return scaled_pose(pose, amplitude)


def non_loop_pose(step: int, amplitude: float) -> Pose:
    index = step % len(POSE_ORDER)
    return scaled_pose(FULL_KEY_POSES[POSE_ORDER[index]], amplitude)


def mirror_point(point: Point) -> Point:
    return (AXIS_X * 2.0 - point[0], point[1])


def mirror_pose(pose: Pose) -> Pose:
    return {key: mirror_point(value) for key, value in pose.items()}


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.convert("RGBA").getchannel("A")
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    return mask.getbbox()


def diff_ratio(first: Image.Image, second: Image.Image) -> float:
    diff = ImageChops.difference(first.convert("RGBA"), second.convert("RGBA")).convert("L")
    return sum(diff.getdata()) / max(1, diff.width * diff.height * 255)


def load_font(size: int) -> ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def checkerboard(size: tuple[int, int], cell: int = 32) -> Image.Image:
    image = Image.new("RGBA", size, (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            color = (238, 238, 238, 255) if (x // cell + y // cell) % 2 else (255, 255, 255, 255)
            draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=color)
    return image


def make_preserve_mask() -> Image.Image:
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((166, 104, 374, 292), fill=255)
    draw.ellipse((172, 236, 372, 438), fill=255)
    draw.polygon([(210, 210), (320, 214), (365, 360), (222, 385), (170, 290)], fill=255)
    draw.ellipse((28, 304, 228, 436), fill=255)
    draw.ellipse((36, 318, 116, 390), fill=255)
    draw.ellipse((170, 338, 246, 466), fill=255)
    draw.ellipse((296, 342, 372, 452), fill=255)
    draw.ellipse((330, 300, 394, 388), fill=255)
    draw.ellipse((138, 294, 222, 388), fill=255)
    draw.polygon([(182, 82), (214, 70), (238, 182), (200, 188)], fill=255)
    draw.polygon([(316, 84), (350, 70), (368, 188), (330, 184)], fill=255)
    draw.polygon([(160, 184), (205, 150), (216, 224), (160, 240)], fill=255)
    draw.polygon([(312, 150), (360, 184), (356, 240), (302, 224)], fill=255)
    draw.line([(84, 358), (124, 336), (170, 350), (210, 392)], fill=255, width=78)
    return mask.filter(ImageFilter.GaussianBlur(radius=2))


def make_wing_removal_mask() -> Image.Image:
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([(0, 130), (186, 112), (238, 208), (224, 342), (96, 360), (0, 286)], fill=255)
    draw.polygon([(318, 112), (512, 130), (512, 286), (416, 360), (288, 342), (286, 208)], fill=255)
    return mask


def remove_original_wings(base: Image.Image) -> Image.Image:
    image = base.copy()
    remove_mask = make_wing_removal_mask()
    preserve_mask = make_preserve_mask()
    pixels = image.load()
    remove = remove_mask.load()
    preserve = preserve_mask.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            if remove[x, y] and not preserve[x, y]:
                r, g, b, a = pixels[x, y]
                if a > 0:
                    pixels[x, y] = (r, g, b, 0)
    return image


def scale_points(points: list[Point], scale: int) -> list[Point]:
    return [(x * scale, y * scale) for x, y in points]


def add_wing_texture(draw: ImageDraw.ImageDraw, points: Pose, scale: int, side: str) -> None:
    hinge = points["hinge"]
    leading = points["leading"]
    outer = points["outer"]
    lower = points["lower_outer"]
    inner = points["inner_lower"]
    sign = -1 if side == "left" else 1
    for t in (0.28, 0.5, 0.72):
        a = lerp_point(leading, outer, t)
        b = lerp_point(inner, lower, t)
        mid = lerp_point(a, b, 0.55)
        curve = [a, (mid[0] + sign * 8, mid[1] - 8), b]
        draw.line(scale_points(curve, scale), fill=(246, 252, 255, 170), width=max(1, int(1.2 * scale)), joint="curve")
    swirl_center = lerp_point(hinge, lower, 0.62)
    radius = 15 * scale
    bbox = (
        (swirl_center[0] * scale - radius),
        (swirl_center[1] * scale - radius),
        (swirl_center[0] * scale + radius),
        (swirl_center[1] * scale + radius),
    )
    start = 25 if side == "left" else 205
    draw.arc(bbox, start=start, end=start + 260, fill=(248, 252, 255, 155), width=max(1, int(1.3 * scale)))


def draw_single_wing(layer: Image.Image, pose: Pose, side: str) -> None:
    scale = 4
    high = Image.new("RGBA", (CANVAS[0] * scale, CANVAS[1] * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(high, "RGBA")
    hinge = pose["hinge"]
    root_lower = pose["root_lower"]
    leading = pose["leading"]
    outer = pose["outer"]
    lower_outer = pose["lower_outer"]
    inner_lower = pose["inner_lower"]
    sign = -1 if side == "left" else 1
    scallop_a = (
        lerp(outer[0], lower_outer[0], 0.42) - sign * 7,
        lerp(outer[1], lower_outer[1], 0.42) + 8,
    )
    scallop_b = (
        lerp(lower_outer[0], inner_lower[0], 0.55) - sign * 4,
        lerp(lower_outer[1], inner_lower[1], 0.55) + 10,
    )
    membrane = [hinge, leading, outer, scallop_a, lower_outer, scallop_b, inner_lower, root_lower, hinge]
    scaled = scale_points(membrane, scale)
    fill = (178, 218, 255, 226)
    outline = (120, 170, 224, 245)
    warm_line = (244, 240, 233, 245)
    draw.polygon(scaled, fill=fill)
    draw.line(scaled + [scaled[0]], fill=(255, 255, 255, 215), width=7 * scale, joint="curve")
    draw.line(scaled + [scaled[0]], fill=outline, width=3 * scale, joint="curve")
    for endpoint in (leading, outer, lower_outer, inner_lower):
        line = scale_points([hinge, endpoint], scale)
        draw.line(line, fill=warm_line, width=7 * scale)
        draw.line(line, fill=(138, 182, 229, 230), width=2 * scale)
    draw.line(scale_points([root_lower, inner_lower], scale), fill=warm_line, width=6 * scale)
    draw.line(scale_points([root_lower, inner_lower], scale), fill=(138, 182, 229, 210), width=2 * scale)
    add_wing_texture(draw, pose, scale, side)
    cap = [
        (hinge[0] * scale - 9 * scale, hinge[1] * scale - 9 * scale),
        (hinge[0] * scale + 9 * scale, hinge[1] * scale + 9 * scale),
    ]
    draw.ellipse(cap, fill=(250, 249, 246, 250), outline=(139, 178, 220, 235), width=2 * scale)
    high = high.resize(CANVAS, Image.Resampling.LANCZOS)
    layer.alpha_composite(high)


def draw_wings(pose: Pose) -> Image.Image:
    layer = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    draw_single_wing(layer, pose, "left")
    draw_single_wing(layer, mirror_pose(pose), "right")
    return layer


def translate_image(image: Image.Image, dx: int, dy: int) -> Image.Image:
    width, height = image.size
    left = max(0, -dx)
    top = max(0, -dy)
    right = min(width, width - dx)
    bottom = min(height, height - dy)
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    if right <= left or bottom <= top:
        return out
    crop = image.crop((left, top, right, bottom))
    out.alpha_composite(crop, (max(0, dx), max(0, dy)))
    return out


def compose_frame(body: Image.Image, pose: Pose, global_y: float, mirror: bool) -> Image.Image:
    wings = draw_wings(pose)
    frame = Image.alpha_composite(wings, body)
    frame = translate_image(frame, 0, int(round(global_y)))
    if mirror:
        frame = frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    return frame


def pose_tip_metrics(poses: list[Pose], mirror: bool = False) -> dict[str, float]:
    tips = [mirror_point(pose["outer"]) if mirror else pose["outer"] for pose in poses]
    if len(tips) < 2:
        return {"wingtip_step_max_px": 0.0, "wingtip_accel_max_px": 0.0}
    closed = tips + [tips[0]]
    steps = [math.dist(closed[index], closed[index + 1]) for index in range(len(tips))]
    accel = []
    for index in range(len(tips)):
        prev_point = closed[index - 1]
        current = closed[index]
        next_point = closed[index + 1]
        accel.append(math.dist((prev_point[0] - 2 * current[0] + next_point[0], prev_point[1] - 2 * current[1] + next_point[1]), (0, 0)))
    return {
        "wingtip_step_max_px": round(max(steps), 3),
        "wingtip_step_mean_px": round(statistics.mean(steps), 3),
        "wingtip_accel_max_px": round(max(accel), 3),
    }


def frame_metric(path: Path) -> dict[str, Any]:
    image = Image.open(path).convert("RGBA")
    bbox = alpha_bbox(image)
    metric: dict[str, Any] = {
        "path": str(path),
        "canvas": [image.width, image.height],
        "bbox": list(bbox) if bbox else None,
    }
    if bbox is None:
        metric.update({"visual_width": 0, "visual_height": 0, "center": [0, 0], "edge_margin": 0})
        return metric
    left, top, right, bottom = bbox
    metric.update(
        {
            "visual_width": right - left,
            "visual_height": bottom - top,
            "center": [(left + right) / 2, (top + bottom) / 2],
            "edge_margin": min(left, top, image.width - right, image.height - bottom),
        }
    )
    return metric


def clip_metrics(clip: str, paths: list[Path], fps: int, loop: bool, poses: list[Pose], mirror: bool) -> dict[str, Any]:
    metrics = [frame_metric(path) for path in paths]
    heights = [m["visual_height"] for m in metrics if m["bbox"]]
    widths = [m["visual_width"] for m in metrics if m["bbox"]]
    centers_x = [m["center"][0] for m in metrics if m["bbox"]]
    centers_y = [m["center"][1] for m in metrics if m["bbox"]]
    edges = [m["edge_margin"] for m in metrics if m["bbox"]]
    loop_seam = None
    if loop and paths:
        loop_seam = diff_ratio(Image.open(paths[-1]), Image.open(paths[0]))
    symmetry_errors = []
    for pose in poses:
        mirrored = mirror_pose(pose)
        for key in ("leading", "outer", "lower_outer", "inner_lower"):
            expected = mirror_point(pose[key])
            actual = mirrored[key]
            symmetry_errors.append(math.dist(expected, actual))
    tip = pose_tip_metrics(poses, mirror=mirror)
    mean_height = statistics.mean(heights) if heights else 0
    return {
        "clip_name": clip,
        "frame_count": len(paths),
        "fps": fps,
        "loop": loop,
        "canvas": list(CANVAS),
        "bbox_min": [min(widths, default=0), min(heights, default=0)],
        "bbox_max": [max(widths, default=0), max(heights, default=0)],
        "bbox_mean": [round(statistics.mean(widths), 3) if widths else 0, round(mean_height, 3) if heights else 0],
        "visual_height_drift_px": round(max(heights) - min(heights), 3) if heights else 0,
        "visual_height_drift_ratio": round((max(heights) - min(heights)) / max(1, mean_height), 5) if heights else 0,
        "center_drift_px": [
            round(max(centers_x) - min(centers_x), 3) if centers_x else 0,
            round(max(centers_y) - min(centers_y), 3) if centers_y else 0,
        ],
        "anchor_position": list(ANCHOR),
        "alpha_edge_margin_min_px": min(edges, default=0),
        "loop_seam_score": round(loop_seam, 6) if loop_seam is not None else None,
        "wing_hinge_relative_drift_px": 0.0,
        "wingtip_smoothness": tip,
        "wing_symmetry_error_max_px": round(max(symmetry_errors), 3) if symmetry_errors else 0,
        "body_identity_drift": "body source layer locked; no per-frame body redraw",
        "tail_continuity": "tail source layer locked; no per-frame tail deformation",
        "frames": metrics,
    }


def save_gif(frames: list[Image.Image], path: Path, fps: int, checker: bool = False) -> None:
    duration = int(round(1000 / fps))
    gif_frames: list[Image.Image] = []
    for frame in frames:
        if checker:
            bg = checkerboard(frame.size)
            bg.alpha_composite(frame)
            gif_frames.append(bg.convert("RGB"))
        else:
            gif_frames.append(frame.convert("RGBA"))
    gif_frames[0].save(
        path,
        save_all=True,
        append_images=gif_frames[1:],
        duration=duration,
        loop=0,
        disposal=2,
    )


def save_mp4(frames: list[Image.Image], frames_dir: Path, path: Path, fps: int) -> bool:
    frames_dir.mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(frames):
        bg = checkerboard(frame.size)
        bg.alpha_composite(frame)
        bg.convert("RGB").save(frames_dir / f"frame_{index:03d}.png")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            str(fps),
            "-i",
            str(frames_dir / "frame_%03d.png"),
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )
    return True


def draw_boundary_overlays(frame: Image.Image, scale: float) -> Image.Image:
    bg = checkerboard(frame.size)
    bg.alpha_composite(frame)
    draw = ImageDraw.Draw(bg)
    bbox = alpha_bbox(frame)
    if bbox:
        draw.rectangle(bbox, outline=(255, 64, 64, 255), width=2)
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        draw.line([(cx - 8, cy), (cx + 8, cy)], fill=(0, 196, 255, 255), width=2)
        draw.line([(cx, cy - 8), (cx, cy + 8)], fill=(0, 196, 255, 255), width=2)
    ax, ay = ANCHOR
    draw.line([(ax - 8, ay), (ax + 8, ay)], fill=(255, 208, 0, 255), width=2)
    draw.line([(ax, ay - 8), (ax, ay + 8)], fill=(255, 208, 0, 255), width=2)
    draw.rectangle((0, 0, frame.width - 1, frame.height - 1), outline=(40, 40, 40, 255), width=2)
    return bg.resize((int(frame.width * scale), int(frame.height * scale)), Image.Resampling.LANCZOS)


def contact_sheet(clip: str, frame_paths: list[Path], out: Path) -> None:
    font = load_font(14)
    small = load_font(11)
    scale = 0.42
    thumb_size = (int(CANVAS[0] * scale), int(CANVAS[1] * scale))
    columns = 4
    cell_w = 280
    cell_h = 278
    rows = math.ceil(len(frame_paths) / columns)
    sheet = Image.new("RGBA", (columns * cell_w, rows * cell_h + 54), (250, 250, 250, 255))
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 12), f"{clip} contact sheet: index / bbox / center / anchor / canvas", font=font, fill=(20, 20, 20, 255))
    for index, path in enumerate(frame_paths):
        frame = Image.open(path).convert("RGBA")
        metric = frame_metric(path)
        thumb = draw_boundary_overlays(frame, scale)
        x = (index % columns) * cell_w + 12
        y = (index // columns) * cell_h + 46
        sheet.alpha_composite(thumb, (x, y))
        bbox = metric["bbox"]
        center = metric["center"]
        label = f"{index:02d} bbox={bbox} center=({center[0]:.1f},{center[1]:.1f})"
        draw.text((x, y + thumb_size[1] + 4), label, font=small, fill=(30, 30, 30, 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)


def fit_image(image: Image.Image, max_size: tuple[int, int]) -> Image.Image:
    fitted = image.copy().convert("RGBA")
    fitted.thumbnail(max_size, Image.Resampling.LANCZOS)
    return fitted


def visual_height(image: Image.Image) -> int:
    bbox = alpha_bbox(image)
    return 0 if bbox is None else bbox[3] - bbox[1]


def labeled_panel(title: str, image: Image.Image, size: tuple[int, int], label: str) -> Image.Image:
    panel = checkerboard(size, 24)
    draw = ImageDraw.Draw(panel)
    font = load_font(15)
    small = load_font(12)
    fitted = fit_image(image, (size[0] - 24, size[1] - 70))
    panel.alpha_composite(fitted, ((size[0] - fitted.width) // 2, 34 + (size[1] - 70 - fitted.height) // 2))
    draw.text((12, 10), title, font=font, fill=(20, 20, 20, 255))
    draw.text((12, size[1] - 28), label, font=small, fill=(20, 20, 20, 255))
    draw.rectangle((0, 0, size[0] - 1, size[1] - 1), outline=(160, 160, 160, 255), width=1)
    return panel


def make_comparison_sheet(title: str, panels: list[tuple[str, Image.Image, str]], out: Path) -> None:
    panel_size = (300, 320)
    width = panel_size[0] * len(panels)
    height = panel_size[1] + 46
    sheet = Image.new("RGBA", (width, height), (248, 248, 248, 255))
    draw = ImageDraw.Draw(sheet)
    font = load_font(18)
    draw.text((14, 12), title, font=font, fill=(20, 20, 20, 255))
    for index, (panel_title, image, label) in enumerate(panels):
        sheet.alpha_composite(labeled_panel(panel_title, image, panel_size, label), (index * panel_size[0], 46))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)


def make_scale_scene(dragon: Image.Image, character: Image.Image, out: Path, habitat: Image.Image | None = None) -> None:
    sheet = checkerboard((900, 520), 28)
    draw = ImageDraw.Draw(sheet)
    font = load_font(18)
    small = load_font(13)
    dragon_h = visual_height(dragon)
    char_h = visual_height(character)
    runtime_dragon_h = dragon_h * DRAGON_RUNTIME_SCALE
    ratio = runtime_dragon_h / CHARACTER_RUNTIME_HEIGHT_PT * 100
    char_display_h = 320
    dragon_display_h = max(1, int(char_display_h * ratio / 100))
    char_fitted = fit_image(character, (260, char_display_h))
    dragon_fitted = fit_image(dragon, (260, dragon_display_h))
    baseline = 430
    sheet.alpha_composite(char_fitted, (520, baseline - char_fitted.height))
    sheet.alpha_composite(dragon_fitted, (360, baseline - dragon_fitted.height - 22))
    if habitat:
        habitat_fit = fit_image(habitat, (270, 160))
        sheet.alpha_composite(habitat_fit, (52, baseline - habitat_fit.height))
        draw.text((52, baseline + 12), "CharacterV2 habitat/nest asset", font=small, fill=(30, 30, 30, 255))
    draw.line((40, baseline, 850, baseline), fill=(100, 100, 100, 255), width=2)
    draw.text((24, 18), "DragonV1 v2 proposed runtime scale near CharacterV2", font=font, fill=(20, 20, 20, 255))
    draw.text((24, 52), f"dragon visual height={dragon_h}px, runtime scale=0.16, runtime height={runtime_dragon_h:.1f}pt", font=small, fill=(20, 20, 20, 255))
    draw.text((24, 74), f"character visual height={char_h}px, runtime canonical height={CHARACTER_RUNTIME_HEIGHT_PT}pt, ratio={ratio:.1f}%", font=small, fill=(20, 20, 20, 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)


def render_clip(body: Image.Image, clip: str, spec: ClipSpec, clip_dir: Path) -> tuple[list[Image.Image], list[Pose], list[Path]]:
    clip_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Image.Image] = []
    poses: list[Pose] = []
    paths: list[Path] = []
    count = int(spec["frames"])
    for index in range(count):
        if spec.get("reverse_cycle"):
            cycle_count = int(spec.get("cycle_frame_count", count))
            pose = loop_pose(count - 1 - index, cycle_count, float(spec["amplitude"]), int(spec.get("pose_offset", 0)))
        elif "cycle_frame_count" in spec:
            pose = loop_pose(index, int(spec["cycle_frame_count"]), float(spec["amplitude"]), int(spec.get("pose_offset", 0)))
        elif "pose_sequence" in spec:
            pose = non_loop_pose(spec["pose_sequence"][index], float(spec["amplitude"]))
        else:
            pose = loop_pose(index, count, float(spec["amplitude"]), int(spec.get("pose_offset", 0)))
        if "vertical_path" in spec:
            start, end = spec["vertical_path"]
            global_y = lerp(start, end, index / max(1, count - 1))
        else:
            global_y = math.sin((index / count) * math.tau + math.pi * 0.5) * float(spec.get("bob", 0))
        frame = compose_frame(body, pose, global_y, bool(spec.get("mirror", False)))
        path = clip_dir / f"frame_{index:03d}.png"
        frame.save(path)
        frames.append(frame)
        poses.append(pose)
        paths.append(path)
    return frames, poses, paths


def suspected_risks(metric: dict[str, Any]) -> list[str]:
    risks: list[str] = []
    seam = metric.get("loop_seam_score")
    if seam is not None and seam > 0.04:
        risks.append("metric-only: loop seam diff is elevated")
    if metric.get("alpha_edge_margin_min_px", 0) < 8:
        risks.append("metric-only: alpha edge margin is tight")
    center = metric.get("center_drift_px", [0, 0])
    if center[1] > 12:
        risks.append("metric-only: vertical center drift may read as bobbing")
    wing = metric.get("wingtip_smoothness", {})
    if wing.get("wingtip_accel_max_px", 0) > 90:
        risks.append("metric-only: wingtip acceleration may read as snappy")
    return risks or ["metric-only: no threshold risk detected"]


def write_report(
    root: Path,
    rejected_root: Path,
    preview_paths: dict[str, dict[str, str]],
    contact_paths: dict[str, str],
    comparison_paths: dict[str, str],
    metrics: dict[str, Any],
) -> None:
    lines: list[str] = [
        "# DragonV1 V2 Wing Rework Report",
        "",
        "HUMAN_VISUAL_ACCEPTANCE = PENDING",
        "",
        "## Scope",
        "",
        "This package is review-only. It does not promote v2 assets to approved and does not integrate v2 runtime loading.",
        "",
        "## Rejected V1 Root Cause",
        "",
        "Current approved DragonV1 wing-flapping animation was rejected by human visual review because the wings appeared unnatural, broken, and inconsistent. The likely root cause is per-frame wing deformation that did not preserve a stable hinge and coherent full membrane shape.",
        "",
        f"Rejected approved snapshot path: {rejected_root.resolve()}",
        f"New v2 review package path: {root.resolve()}",
        "",
        "## Method",
        "",
        "- Body identity is preserved from the user-supplied dragon base canvas.",
        "- Original wing regions were masked out of the locked body layer.",
        "- New dragon wing layers were drawn as coherent bat-like membrane wings.",
        "- Four key poses drive the loop: A upstroke, B mid-downstroke, C downstroke, D recovery.",
        "- Twelve-frame loop clips are controlled in-betweens of those four poses.",
        "- Left and right wings use mirrored geometry and flap in the same up/down direction.",
        "- Wing hinge is fixed relative to the body layer; the whole dragon has only small controlled body bob.",
        "",
        "## Clip Frame Paths",
        "",
    ]
    for clip in CLIPS:
        lines.append(f"- {clip}: {root.resolve() / 'clips' / clip}")
    lines.extend(["", "## Preview Paths", ""])
    for clip, paths in preview_paths.items():
        lines.append(f"### {clip}")
        for label, path in paths.items():
            lines.append(f"- {label}: {path}")
        lines.append("")
    lines.extend(["## Contact Sheet Paths", ""])
    for clip, path in contact_paths.items():
        lines.append(f"- {clip}: {path}")
    lines.extend(["", "## Comparison Paths", ""])
    for label, path in comparison_paths.items():
        lines.append(f"- {label}: {path}")
    lines.extend(["", "## Metric Summary", ""])
    for clip_metric in metrics["clips"]:
        lines.append(f"### {clip_metric['clip_name']}")
        lines.append(f"- frame_count: {clip_metric['frame_count']}")
        lines.append(f"- fps: {clip_metric['fps']}")
        lines.append(f"- canvas: {clip_metric['canvas']}")
        lines.append(f"- bbox_min/max/mean: {clip_metric['bbox_min']} / {clip_metric['bbox_max']} / {clip_metric['bbox_mean']}")
        lines.append(f"- visual_height_drift_px: {clip_metric['visual_height_drift_px']}")
        lines.append(f"- center_drift_px: {clip_metric['center_drift_px']}")
        lines.append(f"- anchor_position: {clip_metric['anchor_position']}")
        lines.append(f"- alpha_edge_margin_min_px: {clip_metric['alpha_edge_margin_min_px']}")
        lines.append(f"- loop_seam_score: {clip_metric['loop_seam_score']}")
        lines.append(f"- wing_hinge_relative_drift_px: {clip_metric['wing_hinge_relative_drift_px']}")
        lines.append(f"- wingtip_smoothness: {clip_metric['wingtip_smoothness']}")
        lines.append(f"- wing_symmetry_error_max_px: {clip_metric['wing_symmetry_error_max_px']}")
        lines.append(f"- body_identity_drift: {clip_metric['body_identity_drift']}")
        lines.append(f"- tail_continuity: {clip_metric['tail_continuity']}")
        lines.append(f"- suspected_visual_risks_metric_only: {'; '.join(clip_metric['suspected_visual_risks_metric_only'])}")
        lines.append("")
    lines.extend(
        [
            "## Human Visual Checklist",
            "",
            "| Check | PASS | FAIL | NEEDS_FIX | Notes |",
            "|---|---|---|---|---|",
            "| dragon wing shape reads as dragon wings, not insect wings | [ ] | [ ] | [ ] | |",
            "| both wings flap upward/downward together | [ ] | [ ] | [ ] | |",
            "| wing hinge remains attached to the shoulder | [ ] | [ ] | [ ] | |",
            "| no broken or disconnected wing segments | [ ] | [ ] | [ ] | |",
            "| wing membrane opacity/readability is sufficient | [ ] | [ ] | [ ] | |",
            "| body bob supports flight without twitching | [ ] | [ ] | [ ] | |",
            "| tail continuity is stable | [ ] | [ ] | [ ] | |",
            "| idle hover stability | [ ] | [ ] | [ ] | |",
            "| fly left loop seamlessness | [ ] | [ ] | [ ] | |",
            "| fly right loop seamlessness | [ ] | [ ] | [ ] | |",
            "| takeoff naturalness | [ ] | [ ] | [ ] | |",
            "| land naturalness | [ ] | [ ] | [ ] | |",
            "| identity consistency | [ ] | [ ] | [ ] | |",
            "| long-term desktop comfort | [ ] | [ ] | [ ] | |",
            "",
            "HUMAN_VISUAL_ACCEPTANCE = PENDING",
            "",
        ]
    )
    (root / "DRAGON_V1_V2_WING_REWORK_REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def latest_rejected_root(repo_root: Path) -> Path:
    rejected_parent = repo_root / "Assets/DragonV1/rejected"
    candidates = sorted(rejected_parent.glob("dragon_v1_rejected_wing_motion_*"))
    if not candidates:
        raise FileNotFoundError("No DragonV1 rejected wing-motion snapshot exists")
    return candidates[-1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="DeskPet repository root")
    parser.add_argument("--timestamp", required=True, help="Package timestamp, e.g. 20260630_071052")
    args = parser.parse_args()

    repo_root = Path(args.root).resolve()
    package_root = repo_root / f"Assets/DragonV1/review/dragon_v1_v2_wing_rework_{args.timestamp}"
    rejected_root = latest_rejected_root(repo_root)
    source_path = repo_root / REFERENCE_SOURCE
    base = Image.open(source_path).convert("RGBA")
    package_root.mkdir(parents=True, exist_ok=True)
    for child in ("clips", "previews", "previews/loop_stress", "contact_sheets", "comparisons", "metrics", "sources", "mp4_frames"):
        (package_root / child).mkdir(parents=True, exist_ok=True)

    shutil.copy2(source_path, package_root / "sources/base_canvas_source.png")
    body = remove_original_wings(base)
    body.save(package_root / "sources/body_without_original_wings.png")
    for name in POSE_ORDER:
        pose = scaled_pose(FULL_KEY_POSES[name], 1.12)
        compose_frame(body, pose, 0, False).save(package_root / f"sources/key_pose_{name}.png")

    preview_paths: dict[str, dict[str, str]] = {}
    contact_paths: dict[str, str] = {}
    clip_metric_results: list[dict[str, Any]] = []
    first_frames: dict[str, Image.Image] = {}
    clip_frame_paths: dict[str, list[Path]] = {}

    for clip, spec in CLIPS.items():
        frames, poses, paths = render_clip(body, clip, spec, package_root / "clips" / clip)
        first_frames[clip] = frames[0]
        clip_frame_paths[clip] = paths
        fps = int(spec["fps"])
        transparent_gif = package_root / "previews" / f"{clip}_transparent.gif"
        checker_gif = package_root / "previews" / f"{clip}_checker.gif"
        checker_mp4 = package_root / "previews" / f"{clip}_checker.mp4"
        save_gif(frames, transparent_gif, fps, checker=False)
        save_gif(frames, checker_gif, fps, checker=True)
        save_mp4(frames, package_root / "mp4_frames" / f"{clip}_checker", checker_mp4, fps)
        preview_paths[clip] = {
            "transparent_gif": str(transparent_gif.resolve()),
            "checker_gif": str(checker_gif.resolve()),
            "checker_mp4": str(checker_mp4.resolve()),
        }
        if spec["loop"]:
            stress_frames = frames * 5
            stress_gif = package_root / "previews/loop_stress" / f"{clip}_loop_stress_5x_checker.gif"
            stress_mp4 = package_root / "previews/loop_stress" / f"{clip}_loop_stress_5x_checker.mp4"
            save_gif(stress_frames, stress_gif, fps, checker=True)
            save_mp4(stress_frames, package_root / "mp4_frames" / f"{clip}_loop_stress_5x_checker", stress_mp4, fps)
            preview_paths[clip]["loop_stress_5x_checker_gif"] = str(stress_gif.resolve())
            preview_paths[clip]["loop_stress_5x_checker_mp4"] = str(stress_mp4.resolve())
        contact = package_root / "contact_sheets" / f"{clip}_contact_sheet.png"
        contact_sheet(clip, paths, contact)
        contact_paths[clip] = str(contact.resolve())
        metric = clip_metrics(clip, paths, fps, bool(spec["loop"]), poses, bool(spec.get("mirror", False)))
        metric["suspected_visual_risks_metric_only"] = suspected_risks(metric)
        clip_metric_results.append(metric)

    comparison_paths: dict[str, str] = {}
    rejected_clip_root = rejected_root / "approved_snapshot/clips"
    v1_idle = Image.open(rejected_clip_root / "dragon_idle_hover/frame_000.png").convert("RGBA")
    v1_left = Image.open(rejected_clip_root / "dragon_fly_left_loop/frame_000.png").convert("RGBA")
    v1_right = Image.open(rejected_clip_root / "dragon_fly_right_loop/frame_000.png").convert("RGBA")
    char_idle = Image.open(repo_root / CHARACTER_IDLE).convert("RGBA")
    char_left = Image.open(repo_root / CHARACTER_WALK_LEFT).convert("RGBA")
    char_right = Image.open(repo_root / CHARACTER_WALK_RIGHT).convert("RGBA")
    habitat = Image.open(repo_root / HABITAT).convert("RGBA") if (repo_root / HABITAT).exists() else None

    def height_label(name: str, image: Image.Image, runtime_scale: float | None = None) -> str:
        h = visual_height(image)
        if runtime_scale is None:
            return f"{name} visual height={h}px"
        return f"{name} visual height={h}px, runtime={h * runtime_scale:.1f}pt"

    out = package_root / "comparisons/rejected_v1_vs_v2_wing_rework.png"
    make_comparison_sheet(
        "Rejected V1 vs V2 wing rework",
        [
            ("rejected v1 idle", v1_idle, height_label("v1", v1_idle, DRAGON_RUNTIME_SCALE)),
            ("v2 idle", first_frames["dragon_idle_hover_v2"], height_label("v2", first_frames["dragon_idle_hover_v2"], DRAGON_RUNTIME_SCALE)),
            ("rejected v1 fly R", v1_right, height_label("v1", v1_right, DRAGON_RUNTIME_SCALE)),
            ("v2 fly R", first_frames["dragon_fly_right_loop_v2"], height_label("v2", first_frames["dragon_fly_right_loop_v2"], DRAGON_RUNTIME_SCALE)),
        ],
        out,
    )
    comparison_paths["rejected_v1_vs_v2"] = str(out.resolve())

    out = package_root / "comparisons/dragon_idle_hover_v2_vs_character_idle.png"
    make_comparison_sheet(
        "Dragon idle hover v2 vs CharacterV2 idle",
        [
            ("dragon idle_hover_v2", first_frames["dragon_idle_hover_v2"], height_label("dragon", first_frames["dragon_idle_hover_v2"], DRAGON_RUNTIME_SCALE)),
            ("CharacterV2 idle", char_idle, f"character visual height={visual_height(char_idle)}px, runtime=132.0pt"),
        ],
        out,
    )
    comparison_paths["idle_vs_character"] = str(out.resolve())

    out = package_root / "comparisons/dragon_fly_v2_vs_character_walk.png"
    make_comparison_sheet(
        "Dragon fly v2 vs CharacterV2 walk",
        [
            ("dragon fly_left_v2", first_frames["dragon_fly_left_loop_v2"], height_label("dragon", first_frames["dragon_fly_left_loop_v2"], DRAGON_RUNTIME_SCALE)),
            ("CharacterV2 walk_left", char_left, f"character visual height={visual_height(char_left)}px, runtime=132.0pt"),
            ("dragon fly_right_v2", first_frames["dragon_fly_right_loop_v2"], height_label("dragon", first_frames["dragon_fly_right_loop_v2"], DRAGON_RUNTIME_SCALE)),
            ("CharacterV2 walk_right", char_right, f"character visual height={visual_height(char_right)}px, runtime=132.0pt"),
        ],
        out,
    )
    comparison_paths["fly_vs_character_walk"] = str(out.resolve())

    out = package_root / "comparisons/dragon_v2_near_character_runtime_scale.png"
    make_scale_scene(first_frames["dragon_idle_hover_v2"], char_idle, out, None)
    comparison_paths["near_character_runtime_scale"] = str(out.resolve())

    if habitat is not None:
        out = package_root / "comparisons/dragon_v2_near_character_habitat.png"
        make_scale_scene(first_frames["dragon_idle_hover_v2"], char_idle, out, habitat)
        comparison_paths["near_character_habitat"] = str(out.resolve())

    metrics = {
        "package_root": str(package_root.resolve()),
        "rejected_root": str(rejected_root.resolve()),
        "source_base": str(source_path.resolve()),
        "clips": clip_metric_results,
    }
    metrics_path = package_root / "metrics/dragon_v1_v2_wing_metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_report(package_root, rejected_root, preview_paths, contact_paths, comparison_paths, metrics)
    print(json.dumps({"package_root": str(package_root.resolve()), "metrics": str(metrics_path.resolve())}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
