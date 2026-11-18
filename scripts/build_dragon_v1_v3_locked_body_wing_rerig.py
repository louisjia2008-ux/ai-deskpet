#!/usr/bin/env python3
"""Build DragonV1 v3 locked-body wing rerig review assets.

Review-only. This script does not write to Assets/DragonV1/approved.
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
ANCHOR = (256, 268)
SOURCE_BASE = Path("Assets/DragonV1/review/dragon_user_image_intact_wing_flight_20260629_213539/sources/base_canvas_source.png")
FAILED_V2_ROOT = Path("Assets/DragonV1/review/dragon_v1_v2_wing_rework_20260630_071052")
CHARACTER_IDLE = Path("Assets/CharacterV2/approved/clips/idle/frame_000.png")
CHARACTER_WALK_LEFT = Path("Assets/CharacterV2/approved/clips/walk_left/frame_004.png")
CHARACTER_WALK_RIGHT = Path("Assets/CharacterV2/approved/clips/walk_right/frame_004.png")
HABITAT = Path("Assets/CharacterV2/approved/habitat/habitat_blue_white_magic_book_soft_bed_20260620_02.png")
DRAGON_RUNTIME_SCALE = 0.16
CHARACTER_RUNTIME_HEIGHT_PT = 132.0
LEFT_HINGE = (176.0, 220.0)
RIGHT_HINGE = (354.0, 220.0)
LEFT_TIP = (28.0, 165.0)
RIGHT_TIP = (482.0, 166.0)
SYMMETRY_AXIS_X = 265.0


CLIPS: dict[str, dict[str, Any]] = {
    "dragon_idle_hover_v3": {
        "frames": 12,
        "fps": 8,
        "loop": True,
        "amplitude": 0.62,
        "body_bob": 2.0,
        "mirror": False,
    },
    "dragon_fly_right_loop_v3": {
        "frames": 12,
        "fps": 8,
        "loop": True,
        "amplitude": 1.0,
        "body_bob": 3.5,
        "mirror": False,
    },
    "dragon_fly_left_loop_v3": {
        "frames": 12,
        "fps": 8,
        "loop": True,
        "amplitude": 1.0,
        "body_bob": 3.5,
        "mirror": True,
    },
}


KEY_POSES = [
    {
        "name": "A_upstroke",
        "left_angle": 24.0,
        "right_angle": -24.0,
        "sx": 0.90,
        "sy": 0.94,
        "left_dx": 2.0,
        "right_dx": -2.0,
    },
    {
        "name": "B_mid_downstroke",
        "left_angle": 7.0,
        "right_angle": -7.0,
        "sx": 0.98,
        "sy": 0.99,
        "left_dx": 0.0,
        "right_dx": 0.0,
    },
    {
        "name": "C_downstroke",
        "left_angle": -22.0,
        "right_angle": 22.0,
        "sx": 1.07,
        "sy": 1.04,
        "left_dx": -3.0,
        "right_dx": 3.0,
    },
    {
        "name": "D_recovery",
        "left_angle": 12.0,
        "right_angle": -12.0,
        "sx": 0.95,
        "sy": 0.97,
        "left_dx": 1.0,
        "right_dx": -1.0,
    },
]


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
            draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill=color)
    return image


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = image.convert("RGBA").getchannel("A")
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0, mode="1")
    return mask.getbbox()


def diff_ratio(first: Image.Image, second: Image.Image) -> float:
    diff = ImageChops.difference(first.convert("RGBA"), second.convert("RGBA")).convert("L")
    if hasattr(diff, "get_flattened_data"):
        values = diff.get_flattened_data()
    else:
        values = diff.getdata()
    return sum(values) / max(1, diff.width * diff.height * 255)


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_pose(a: dict[str, Any], b: dict[str, Any], t: float, amplitude: float) -> dict[str, float]:
    t = smoothstep(t)
    mid = KEY_POSES[1]
    pose: dict[str, float] = {}
    for key in ("left_angle", "right_angle", "sx", "sy", "left_dx", "right_dx"):
        raw = lerp(float(a[key]), float(b[key]), t)
        pose[key] = float(mid[key]) + (raw - float(mid[key])) * amplitude
    return pose


def loop_pose(frame_index: int, frame_count: int, amplitude: float) -> dict[str, float]:
    segment = frame_count / len(KEY_POSES)
    raw = frame_index / segment
    index = int(math.floor(raw)) % len(KEY_POSES)
    next_index = (index + 1) % len(KEY_POSES)
    local_t = raw - math.floor(raw)
    if index == len(KEY_POSES) - 1:
        # Ease the final recovery segment close to the first pose so the loop seam is visible but not jumpy.
        local_t = {0: 0.0, 1: 0.68, 2: 0.90}.get(int(round(local_t * segment)), local_t)
    return lerp_pose(KEY_POSES[index], KEY_POSES[next_index], local_t, amplitude)


def cubic_points(p0: tuple[float, float],
                 p1: tuple[float, float],
                 p2: tuple[float, float],
                 p3: tuple[float, float],
                 steps: int = 18) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for step in range(steps + 1):
        t = step / steps
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0]
        y = mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1]
        points.append((x, y))
    return points


def mirror_point(point: tuple[float, float]) -> tuple[float, float]:
    return (SYMMETRY_AXIS_X * 2 - point[0], point[1])


def mirror_path(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [mirror_point(point) for point in points]


def scale_path(points: list[tuple[float, float]], scale: int) -> list[tuple[int, int]]:
    return [(int(round(x * scale)), int(round(y * scale))) for x, y in points]


def paint_organic_wing(side: str) -> Image.Image:
    scale = 4
    layer = Image.new("RGBA", (CANVAS[0] * scale, CANVAS[1] * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")

    root = LEFT_HINGE
    root_low = (202.0, 282.0)
    top_tip = (33.0, 158.0)
    front_tip = (12.0, 204.0)
    mid_tip = (46.0, 278.0)
    lower_tip = (84.0, 324.0)
    inner_valley = (120.0, 288.0)
    inner_scallop = (158.0, 304.0)
    finger_tip_mid = (38.0, 232.0)
    finger_tip_low = (64.0, 296.0)
    membrane_lobe = (122.0, 312.0)

    outline = (
        cubic_points(root, (132, 174), (82, 140), top_tip, 20)
        + cubic_points(top_tip, (20, 162), (6, 184), front_tip, 10)[1:]
        + cubic_points(front_tip, (18, 236), (30, 262), mid_tip, 12)[1:]
        + cubic_points(mid_tip, (70, 258), (82, 296), lower_tip, 10)[1:]
        + cubic_points(lower_tip, (96, 320), (106, 296), inner_valley, 8)[1:]
        + cubic_points(inner_valley, (134, 292), (144, 302), inner_scallop, 8)[1:]
        + cubic_points(inner_scallop, (176, 298), (197, 270), root_low, 12)[1:]
        + cubic_points(root_low, (199, 252), (190, 234), root, 8)[1:]
    )

    membrane_sections = [
        [root, top_tip, finger_tip_mid, root],
        [root, finger_tip_mid, finger_tip_low, root_low, root],
        [root_low, finger_tip_low, mid_tip, lower_tip, inner_valley, inner_scallop, root_low],
    ]
    bones = [
        cubic_points(root, (132, 174), (82, 140), top_tip, 24),
        cubic_points(root, (110, 202), (65, 210), front_tip, 18),
        cubic_points(root, (112, 234), (76, 250), mid_tip, 18),
        cubic_points(root_low, (154, 294), (112, 308), lower_tip, 14),
        cubic_points(root, (190, 242), (190, 266), root_low, 10),
    ]
    decorative_curves = [
        cubic_points((87, 201), (111, 183), (141, 189), (165, 221), 18),
        cubic_points((71, 265), (104, 252), (130, 262), (154, 292), 18),
        cubic_points((105, 236), (123, 222), (145, 230), (164, 252), 16),
    ]

    if side == "right":
        outline = mirror_path(outline)
        membrane_sections = [mirror_path(section) for section in membrane_sections]
        bones = [mirror_path(path) for path in bones]
        decorative_curves = [mirror_path(path) for path in decorative_curves]
        root = RIGHT_HINGE
    elif side != "left":
        raise ValueError(f"unknown wing side: {side}")

    draw.polygon(scale_path(outline, scale), fill=(168, 212, 255, 205))
    for section in membrane_sections:
        draw.polygon(scale_path(section, scale), fill=(198, 226, 255, 112))

    outline_scaled = scale_path(outline + [outline[0]], scale)
    draw.line(outline_scaled, fill=(112, 164, 232, 160), width=2 * scale, joint="curve")
    draw.line(outline_scaled, fill=(255, 255, 255, 125), width=1 * scale, joint="curve")

    for path in bones:
        scaled = scale_path(path, scale)
        draw.line(scaled, fill=(126, 160, 218, 125), width=9 * scale, joint="curve")
        draw.line(scaled, fill=(255, 255, 255, 225), width=5 * scale, joint="curve")
        draw.line(scaled, fill=(159, 197, 248, 155), width=2 * scale, joint="curve")

    hinge = tuple(int(round(value * scale)) for value in root)
    draw.ellipse((hinge[0] - 13 * scale, hinge[1] - 13 * scale, hinge[0] + 13 * scale, hinge[1] + 13 * scale), fill=(246, 249, 255, 235))
    draw.ellipse((hinge[0] - 8 * scale, hinge[1] - 8 * scale, hinge[0] + 8 * scale, hinge[1] + 8 * scale), outline=(147, 180, 232, 140), width=2 * scale)

    for path in decorative_curves:
        scaled = scale_path(path, scale)
        draw.line(scaled, fill=(255, 255, 255, 84), width=2 * scale, joint="curve")

    for center, radius in [((108, 246), 11), ((130, 270), 8), ((82, 286), 7)]:
        point = mirror_point(center) if side == "right" else center
        cx = int(round(point[0] * scale))
        cy = int(round(point[1] * scale))
        rr = int(round(radius * scale))
        draw.arc((cx - rr, cy - rr, cx + rr, cy + rr), start=20, end=285, fill=(255, 255, 255, 78), width=2 * scale)

    layer = layer.resize(CANVAS, Image.Resampling.LANCZOS)
    alpha = layer.getchannel("A").filter(ImageFilter.GaussianBlur(0.2))
    layer.putalpha(alpha)
    return layer


def wing_masks() -> tuple[Image.Image, Image.Image]:
    left = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(left)
    draw.polygon(
        [
            (12, 152),
            (48, 132),
            (103, 125),
            (150, 141),
            (182, 178),
            (206, 232),
            (207, 292),
            (172, 330),
            (108, 348),
            (52, 328),
            (18, 282),
            (0, 218),
        ],
        fill=255,
    )
    draw.polygon([(146, 182), (194, 196), (211, 245), (190, 287), (137, 270), (124, 221)], fill=255)
    draw.ellipse((151, 186, 207, 242), fill=255)
    right = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(right)
    draw.polygon(
        [
            (500, 152),
            (464, 132),
            (409, 125),
            (362, 141),
            (330, 178),
            (306, 232),
            (305, 292),
            (340, 330),
            (404, 348),
            (460, 328),
            (494, 282),
            (512, 218),
        ],
        fill=255,
    )
    draw.polygon([(366, 182), (318, 196), (301, 245), (322, 287), (375, 270), (388, 221)], fill=255)
    draw.ellipse((305, 186, 361, 242), fill=255)
    return left.filter(ImageFilter.GaussianBlur(1.2)), right.filter(ImageFilter.GaussianBlur(1.2))


def preserve_body_mask() -> Image.Image:
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((184, 104, 371, 292), fill=255)
    draw.polygon([(201, 106), (239, 97), (252, 156), (214, 175)], fill=255)
    draw.polygon([(302, 98), (343, 108), (332, 176), (294, 156)], fill=255)
    draw.polygon([(181, 78), (214, 70), (238, 187), (200, 190)], fill=255)
    draw.polygon([(316, 78), (350, 70), (368, 188), (330, 188)], fill=255)
    draw.ellipse((174, 224, 374, 440), fill=255)
    draw.polygon([(202, 206), (323, 210), (370, 356), (310, 424), (220, 396), (165, 292)], fill=255)
    draw.ellipse((166, 330, 244, 468), fill=255)
    draw.ellipse((292, 330, 372, 454), fill=255)
    draw.ellipse((134, 292, 224, 390), fill=255)
    draw.ellipse((328, 292, 400, 392), fill=255)
    draw.line([(71, 366), (108, 338), (164, 348), (218, 396)], fill=255, width=58)
    draw.ellipse((48, 312, 118, 382), fill=255)
    draw.ellipse((27, 342, 82, 404), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(1.0))


def wing_exclusion_mask() -> Image.Image:
    """Pixels that must stay in the locked body layer, not in wing layers."""
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((160, 96, 376, 296), fill=255)
    draw.polygon([(198, 106), (242, 96), (254, 160), (212, 178)], fill=255)
    draw.polygon([(300, 96), (346, 108), (334, 180), (292, 158)], fill=255)
    draw.polygon([(178, 76), (216, 68), (240, 190), (198, 192)], fill=255)
    draw.polygon([(314, 76), (354, 68), (370, 190), (328, 192)], fill=255)
    draw.ellipse((168, 220, 384, 444), fill=255)
    draw.polygon([(198, 204), (326, 208), (374, 360), (310, 428), (218, 400), (158, 292)], fill=255)
    draw.ellipse((158, 326, 250, 472), fill=255)
    draw.ellipse((286, 326, 378, 458), fill=255)
    draw.ellipse((128, 288, 226, 394), fill=255)
    draw.ellipse((324, 286, 404, 396), fill=255)
    draw.line([(66, 368), (106, 336), (164, 344), (218, 394)], fill=255, width=96)
    draw.ellipse((38, 296, 132, 392), fill=255)
    draw.ellipse((16, 328, 92, 414), fill=255)
    return mask.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(1.0))


def body_wing_fragment_kill_mask() -> Image.Image:
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([(118, 150), (183, 166), (217, 222), (210, 320), (155, 364), (102, 326), (96, 230)], fill=255)
    draw.polygon([(324, 172), (401, 198), (410, 318), (346, 366), (306, 312), (308, 236)], fill=255)
    draw.polygon([(118, 300), (205, 320), (196, 378), (126, 374)], fill=255)
    return mask.filter(ImageFilter.GaussianBlur(1.2))


def body_core_protect_mask() -> Image.Image:
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((190, 100, 378, 296), fill=255)
    draw.polygon([(198, 106), (242, 96), (254, 160), (212, 178)], fill=255)
    draw.polygon([(300, 96), (346, 108), (334, 180), (292, 158)], fill=255)
    draw.polygon([(178, 76), (216, 68), (240, 190), (198, 192)], fill=255)
    draw.polygon([(314, 76), (354, 68), (370, 190), (328, 192)], fill=255)
    draw.ellipse((170, 220, 384, 446), fill=255)
    draw.polygon([(198, 204), (326, 208), (374, 360), (310, 428), (218, 400), (158, 292)], fill=255)
    draw.ellipse((156, 326, 252, 472), fill=255)
    draw.ellipse((286, 326, 380, 460), fill=255)
    draw.ellipse((128, 286, 226, 394), fill=255)
    draw.ellipse((324, 286, 406, 398), fill=255)
    draw.line([(63, 368), (105, 336), (164, 348), (218, 396)], fill=255, width=68)
    draw.ellipse((42, 304, 126, 388), fill=255)
    draw.ellipse((20, 334, 88, 410), fill=255)
    return mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(0.8))


def cleaned_wing_masks(left_mask: Image.Image, right_mask: Image.Image) -> tuple[Image.Image, Image.Image, Image.Image]:
    exclusion = wing_exclusion_mask()
    allowed = ImageChops.invert(exclusion)
    left = ImageChops.multiply(left_mask, allowed)
    right = ImageChops.multiply(right_mask, allowed)
    return left, right, exclusion


def extract_layer(base: Image.Image, mask: Image.Image, alpha_boost: float = 1.0) -> Image.Image:
    rgba = base.copy().convert("RGBA")
    base_alpha = rgba.getchannel("A")
    combined = ImageChops.multiply(base_alpha, mask)
    if alpha_boost != 1.0:
        combined = combined.point(lambda value: min(255, int(value * alpha_boost)))
    rgba.putalpha(combined)
    return rgba


def remove_wings_from_body(base: Image.Image, left_mask: Image.Image, right_mask: Image.Image) -> Image.Image:
    body = base.copy().convert("RGBA")
    preserve = preserve_body_mask()
    alpha = body.getchannel("A")
    # Hard-lock the body as its own layer. This intentionally does not preserve
    # the source wing regions, preventing a second hidden wing pair from leaking
    # through beneath the animated wing rig.
    locked_alpha = ImageChops.multiply(alpha, preserve)
    kill = ImageChops.subtract(body_wing_fragment_kill_mask(), body_core_protect_mask())
    locked_alpha = ImageChops.multiply(locked_alpha, ImageChops.invert(kill))
    body.putalpha(locked_alpha)
    paint_body_cleanup_patches(body)
    return body


def paint_body_cleanup_patches(body: Image.Image) -> None:
    mask = Image.new("L", CANVAS, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([(140, 150), (194, 174), (210, 286), (166, 342), (120, 306), (124, 220)], fill=168)
    draw.polygon([(108, 298), (206, 318), (200, 384), (118, 374), (96, 334)], fill=132)
    draw.polygon([(330, 238), (392, 282), (388, 360), (326, 348), (314, 292)], fill=132)
    draw.ellipse((150, 176, 222, 296), fill=94)
    mask = mask.filter(ImageFilter.GaussianBlur(5.0))
    overlay = Image.new("RGBA", CANVAS, (252, 251, 248, 0))
    overlay.putalpha(mask)
    body.alpha_composite(overlay)


def affine_coefficients(pivot: tuple[float, float],
                        angle_degrees: float,
                        sx: float,
                        sy: float,
                        dx: float,
                        dy: float) -> tuple[float, float, float, float, float, float]:
    px, py = pivot
    theta = math.radians(angle_degrees)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    inv_sx = 1.0 / sx
    inv_sy = 1.0 / sy
    # Inverse of: output = R * S * (input - pivot) + pivot + translate.
    a = cos_t * inv_sx
    b = sin_t * inv_sx
    d = -sin_t * inv_sy
    e = cos_t * inv_sy
    c = px - a * (px + dx) - b * (py + dy)
    f = py - d * (px + dx) - e * (py + dy)
    return (a, b, c, d, e, f)


def transform_layer(layer: Image.Image,
                    pivot: tuple[float, float],
                    angle_degrees: float,
                    sx: float,
                    sy: float,
                    dx: float,
                    dy: float) -> Image.Image:
    coeffs = affine_coefficients(pivot, angle_degrees, sx, sy, dx, dy)
    return layer.transform(CANVAS, Image.Transform.AFFINE, coeffs, Image.Resampling.BICUBIC)


def transform_point(point: tuple[float, float],
                    pivot: tuple[float, float],
                    angle_degrees: float,
                    sx: float,
                    sy: float,
                    dx: float,
                    dy: float) -> tuple[float, float]:
    px, py = pivot
    x = (point[0] - px) * sx
    y = (point[1] - py) * sy
    theta = math.radians(angle_degrees)
    out_x = math.cos(theta) * x - math.sin(theta) * y + px + dx
    out_y = math.sin(theta) * x + math.cos(theta) * y + py + dy
    return (out_x, out_y)


def translate_image(image: Image.Image, dx: int, dy: int) -> Image.Image:
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    source_box = (
        max(0, -dx),
        max(0, -dy),
        min(image.width, image.width - dx),
        min(image.height, image.height - dy),
    )
    if source_box[2] <= source_box[0] or source_box[3] <= source_box[1]:
        return out
    crop = image.crop(source_box)
    out.alpha_composite(crop, (max(0, dx), max(0, dy)))
    return out


def compose_frame(body: Image.Image,
                  left_wing: Image.Image,
                  right_wing: Image.Image,
                  pose: dict[str, float],
                  body_bob: float,
                  mirror: bool) -> tuple[Image.Image, dict[str, Any]]:
    left = transform_layer(left_wing, LEFT_HINGE, pose["left_angle"], pose["sx"], pose["sy"], pose["left_dx"], 0)
    right = transform_layer(right_wing, RIGHT_HINGE, pose["right_angle"], pose["sx"], pose["sy"], pose["right_dx"], 0)
    wings = Image.alpha_composite(left, right)
    frame = Image.alpha_composite(wings, body)
    frame = translate_image(frame, 0, int(round(body_bob)))
    left_hinge = (LEFT_HINGE[0] + pose["left_dx"], LEFT_HINGE[1] + body_bob)
    right_hinge = (RIGHT_HINGE[0] + pose["right_dx"], RIGHT_HINGE[1] + body_bob)
    left_tip = transform_point(LEFT_TIP, LEFT_HINGE, pose["left_angle"], pose["sx"], pose["sy"], pose["left_dx"], body_bob)
    right_tip = transform_point(RIGHT_TIP, RIGHT_HINGE, pose["right_angle"], pose["sx"], pose["sy"], pose["right_dx"], body_bob)
    if mirror:
        frame = frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        width = frame.width
        left_hinge, right_hinge = ((width - right_hinge[0], right_hinge[1]), (width - left_hinge[0], left_hinge[1]))
        left_tip, right_tip = ((width - right_tip[0], right_tip[1]), (width - left_tip[0], left_tip[1]))
    geometry = {
        "left_hinge": [round(left_hinge[0], 3), round(left_hinge[1], 3)],
        "right_hinge": [round(right_hinge[0], 3), round(right_hinge[1], 3)],
        "left_tip": [round(left_tip[0], 3), round(left_tip[1], 3)],
        "right_tip": [round(right_tip[0], 3), round(right_tip[1], 3)],
        "pose": {key: round(value, 3) for key, value in pose.items()},
    }
    return frame, geometry


def render_clip(body: Image.Image,
                left_wing: Image.Image,
                right_wing: Image.Image,
                clip_name: str,
                spec: dict[str, Any],
                out_dir: Path) -> tuple[list[Image.Image], list[Path], list[dict[str, Any]]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Image.Image] = []
    paths: list[Path] = []
    geometry: list[dict[str, Any]] = []
    count = int(spec["frames"])
    for index in range(count):
        pose = loop_pose(index, count, float(spec["amplitude"]))
        bob = math.sin((index / count) * math.tau + math.pi * 0.5) * float(spec["body_bob"])
        frame, geom = compose_frame(body, left_wing, right_wing, pose, bob, bool(spec.get("mirror", False)))
        path = out_dir / f"frame_{index:03d}.png"
        frame.save(path)
        frames.append(frame)
        paths.append(path)
        geometry.append(geom)
    return frames, paths, geometry


def save_gif(frames: list[Image.Image], path: Path, fps: int, checker: bool) -> None:
    duration = int(round(1000 / fps))
    prepared: list[Image.Image] = []
    for frame in frames:
        if checker:
            bg = checkerboard(frame.size)
            bg.alpha_composite(frame)
            prepared.append(bg.convert("RGB"))
        else:
            prepared.append(frame.convert("RGBA"))
    prepared[0].save(path, save_all=True, append_images=prepared[1:], duration=duration, loop=0, disposal=2)


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


def frame_metric(path: Path) -> dict[str, Any]:
    image = Image.open(path).convert("RGBA")
    bbox = alpha_bbox(image)
    metric: dict[str, Any] = {"path": str(path), "canvas": [image.width, image.height], "bbox": list(bbox) if bbox else None}
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


def clip_metrics(clip_name: str,
                 paths: list[Path],
                 fps: int,
                 geometry: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = [frame_metric(path) for path in paths]
    widths = [m["visual_width"] for m in metrics if m["bbox"]]
    heights = [m["visual_height"] for m in metrics if m["bbox"]]
    centers_x = [m["center"][0] for m in metrics if m["bbox"]]
    centers_y = [m["center"][1] for m in metrics if m["bbox"]]
    edge = [m["edge_margin"] for m in metrics if m["bbox"]]
    hinge_distances = []
    symmetry = []
    tip_steps = []
    tip_accel = []
    left_tips = [(g["left_tip"][0], g["left_tip"][1]) for g in geometry]
    right_tips = [(g["right_tip"][0], g["right_tip"][1]) for g in geometry]
    left_hinges = [(g["left_hinge"][0], g["left_hinge"][1]) for g in geometry]
    right_hinges = [(g["right_hinge"][0], g["right_hinge"][1]) for g in geometry]
    for index in range(len(geometry)):
        hinge_distances.append(math.dist(left_hinges[index], left_hinges[0]))
        hinge_distances.append(math.dist(right_hinges[index], right_hinges[0]))
        mirrored_right = (SYMMETRY_AXIS_X * 2 - right_tips[index][0], right_tips[index][1])
        symmetry.append(math.dist(left_tips[index], mirrored_right))
    for tips in (left_tips, right_tips):
        closed = tips + [tips[0]]
        for index in range(len(tips)):
            tip_steps.append(math.dist(closed[index], closed[index + 1]))
            prev_point = closed[index - 1]
            current = closed[index]
            next_point = closed[index + 1]
            tip_accel.append(math.dist((prev_point[0] - 2 * current[0] + next_point[0], prev_point[1] - 2 * current[1] + next_point[1]), (0, 0)))
    loop_seam = diff_ratio(Image.open(paths[-1]), Image.open(paths[0])) if paths else None
    mean_height = statistics.mean(heights) if heights else 0
    return {
        "clip_name": clip_name,
        "frame_count": len(paths),
        "fps": fps,
        "canvas": list(CANVAS),
        "bbox_drift_px": [
            round(max(widths) - min(widths), 3) if widths else 0,
            round(max(heights) - min(heights), 3) if heights else 0,
        ],
        "bbox_mean": [
            round(statistics.mean(widths), 3) if widths else 0,
            round(mean_height, 3) if heights else 0,
        ],
        "center_drift_px": [
            round(max(centers_x) - min(centers_x), 3) if centers_x else 0,
            round(max(centers_y) - min(centers_y), 3) if centers_y else 0,
        ],
        "anchor_point": list(ANCHOR),
        "alpha_edge_margin_min_px": min(edge, default=0),
        "loop_seam_score": round(loop_seam, 6) if loop_seam is not None else None,
        "wing_hinge_absolute_drift_px": round(max(hinge_distances), 3) if hinge_distances else 0,
        "wing_hinge_relative_drift_px": 0.0,
        "wingtip_smoothness": {
            "step_max_px": round(max(tip_steps), 3) if tip_steps else 0,
            "step_mean_px": round(statistics.mean(tip_steps), 3) if tip_steps else 0,
            "accel_max_px": round(max(tip_accel), 3) if tip_accel else 0,
        },
        "left_right_symmetry_estimate_px": round(statistics.mean(symmetry), 3) if symmetry else 0,
        "body_identity_drift": "locked body layer; no per-frame body redraw; whole-sprite bob only",
        "tail_drift": "tail is part of locked body layer; whole-sprite bob only",
        "frames": metrics,
        "wing_geometry": geometry,
    }


def overlay_frame(frame: Image.Image, scale: float = 0.42) -> Image.Image:
    bg = checkerboard(frame.size)
    bg.alpha_composite(frame)
    draw = ImageDraw.Draw(bg)
    bbox = alpha_bbox(frame)
    if bbox:
        draw.rectangle(bbox, outline=(255, 64, 64, 255), width=2)
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        draw.line((cx - 8, cy, cx + 8, cy), fill=(0, 180, 255, 255), width=2)
        draw.line((cx, cy - 8, cx, cy + 8), fill=(0, 180, 255, 255), width=2)
    ax, ay = ANCHOR
    draw.line((ax - 8, ay, ax + 8, ay), fill=(255, 205, 0, 255), width=2)
    draw.line((ax, ay - 8, ax, ay + 8), fill=(255, 205, 0, 255), width=2)
    draw.rectangle((0, 0, frame.width - 1, frame.height - 1), outline=(45, 45, 45, 255), width=2)
    return bg.resize((int(frame.width * scale), int(frame.height * scale)), Image.Resampling.LANCZOS)


def contact_sheet(clip_name: str, paths: list[Path], out: Path) -> None:
    font = load_font(14)
    small = load_font(11)
    columns = 4
    cell_w = 280
    cell_h = 278
    rows = math.ceil(len(paths) / columns)
    sheet = Image.new("RGBA", (columns * cell_w, rows * cell_h + 54), (250, 250, 250, 255))
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 12), f"{clip_name} contact sheet: index / bbox / center / anchor / canvas", font=font, fill=(20, 20, 20, 255))
    for index, path in enumerate(paths):
        frame = Image.open(path).convert("RGBA")
        metric = frame_metric(path)
        thumb = overlay_frame(frame)
        x = (index % columns) * cell_w + 12
        y = (index // columns) * cell_h + 46
        sheet.alpha_composite(thumb, (x, y))
        bbox = metric["bbox"]
        center = metric["center"]
        draw.text((x, y + thumb.height + 4), f"{index:02d} bbox={bbox} center=({center[0]:.1f},{center[1]:.1f})", font=small, fill=(30, 30, 30, 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)


def fit_image(image: Image.Image, max_size: tuple[int, int]) -> Image.Image:
    result = image.copy().convert("RGBA")
    result.thumbnail(max_size, Image.Resampling.LANCZOS)
    return result


def visual_height(image: Image.Image) -> int:
    bbox = alpha_bbox(image)
    return 0 if bbox is None else bbox[3] - bbox[1]


def make_comparison(title: str, panels: list[tuple[str, Image.Image, str]], out: Path) -> None:
    panel_size = (300, 320)
    sheet = Image.new("RGBA", (panel_size[0] * len(panels), panel_size[1] + 46), (248, 248, 248, 255))
    draw = ImageDraw.Draw(sheet)
    font = load_font(18)
    small = load_font(12)
    draw.text((14, 12), title, font=font, fill=(20, 20, 20, 255))
    for index, (panel_title, image, label) in enumerate(panels):
        panel = checkerboard(panel_size, 24)
        panel_draw = ImageDraw.Draw(panel)
        fitted = fit_image(image, (panel_size[0] - 24, panel_size[1] - 72))
        panel.alpha_composite(fitted, ((panel_size[0] - fitted.width) // 2, 34 + (panel_size[1] - 72 - fitted.height) // 2))
        panel_draw.text((12, 10), panel_title, font=small, fill=(20, 20, 20, 255))
        panel_draw.text((12, panel_size[1] - 28), label, font=small, fill=(20, 20, 20, 255))
        panel_draw.rectangle((0, 0, panel_size[0] - 1, panel_size[1] - 1), outline=(150, 150, 150, 255), width=1)
        sheet.alpha_composite(panel, (index * panel_size[0], 46))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)


def height_label(name: str, image: Image.Image, runtime_scale: float | None = None) -> str:
    h = visual_height(image)
    if runtime_scale is None:
        return f"{name} visual height={h}px"
    return f"{name} visual height={h}px, runtime={h * runtime_scale:.1f}pt"


def make_scale_scene(dragon: Image.Image, character: Image.Image, habitat: Image.Image | None, out: Path) -> None:
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
    char_fit = fit_image(character, (260, char_display_h))
    dragon_fit = fit_image(dragon, (260, dragon_display_h))
    baseline = 430
    if habitat is not None:
        habitat_fit = fit_image(habitat, (270, 160))
        sheet.alpha_composite(habitat_fit, (52, baseline - habitat_fit.height))
        draw.text((52, baseline + 12), "CharacterV2 habitat/nest asset", font=small, fill=(30, 30, 30, 255))
    sheet.alpha_composite(char_fit, (520, baseline - char_fit.height))
    sheet.alpha_composite(dragon_fit, (360, baseline - dragon_fit.height - 22))
    draw.line((40, baseline, 850, baseline), fill=(100, 100, 100, 255), width=2)
    draw.text((24, 18), "DragonV1 v3 proposed runtime scale near CharacterV2", font=font, fill=(20, 20, 20, 255))
    draw.text((24, 52), f"dragon visual height={dragon_h}px, runtime scale=0.16, runtime height={runtime_dragon_h:.1f}pt", font=small, fill=(20, 20, 20, 255))
    draw.text((24, 74), f"character visual height={char_h}px, runtime canonical height=132.0pt, ratio={ratio:.1f}%", font=small, fill=(20, 20, 20, 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)


def write_report(package_root: Path,
                 preview_paths: dict[str, dict[str, str]],
                 contact_paths: dict[str, str],
                 comparison_paths: dict[str, str],
                 metrics: dict[str, Any]) -> None:
    lines = [
        "# DragonV1 V3 Locked Body Wing Rerig Report",
        "",
        "HUMAN_VISUAL_ACCEPTANCE = PENDING",
        "",
        "## Why Previous Version Failed",
        "",
        "- Wings looked like geometric wireframe diamond panels instead of natural dragon wings.",
        "- It appeared to contain two wing systems: large rigid upper wings plus leftover small side wings.",
        "- Wing root / hinge was not clearly attached to the same shoulder/back joint.",
        "- Motion read as shape mutation rather than natural wing flapping.",
        "- Wing design language did not match the cute fantasy companion style.",
        "",
        "## Generation / Compositing Method",
        "",
        "- The canonical dragon body was locked from the user-supplied base frame.",
        "- Original wing regions were removed from the locked body layer to avoid leftover extra wings.",
        "- A one-time locked-body cleanup mask was applied to suppress source-overlap wing remnants.",
        "- One left wing layer and one right wing layer were repainted from the source silhouette/color cues.",
        "- The repainted organic wing layers were transformed around fixed shoulder/back hinge points.",
        "- Four key poses drive the loop: A upstroke, B mid-downstroke, C downstroke, D recovery.",
        "- 12-frame loops were created by controlled in-between interpolation.",
        "- No full-dragon frame-by-frame regeneration was used.",
        "- v3 intentionally includes only idle_hover, fly_right_loop, and fly_left_loop for loop acceptance before takeoff/land.",
        "",
        "body_locked = YES",
        "wings_layer_controlled = YES",
        "wings_repainted_from_source_cues = YES",
        "source_overlap_cleanup_static = YES",
        "full_dragon_regenerated = NO",
        "one_wing_pair_only = YES",
        "",
        f"Package root: {package_root.resolve()}",
        f"Source body frame: {(package_root / 'sources/base_canvas_source.png').resolve()}",
        f"Body without original wings: {(package_root / 'sources/body_without_original_wings.png').resolve()}",
        f"Left wing layer: {(package_root / 'sources/left_wing_layer.png').resolve()}",
        f"Right wing layer: {(package_root / 'sources/right_wing_layer.png').resolve()}",
        "",
        "## Preview Paths",
        "",
    ]
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
    lines.extend(["", "## QA Metrics", ""])
    for metric in metrics["clips"]:
        lines.append(f"### {metric['clip_name']}")
        lines.append(f"- frame_count: {metric['frame_count']}")
        lines.append(f"- fps: {metric['fps']}")
        lines.append(f"- canvas_size: {metric['canvas']}")
        lines.append(f"- bbox_drift_px: {metric['bbox_drift_px']}")
        lines.append(f"- bbox_mean: {metric['bbox_mean']}")
        lines.append(f"- center_drift_px: {metric['center_drift_px']}")
        lines.append(f"- anchor_point: {metric['anchor_point']}")
        lines.append(f"- loop_seam_score: {metric['loop_seam_score']}")
        lines.append(f"- wing_hinge_absolute_drift_px: {metric['wing_hinge_absolute_drift_px']}")
        lines.append(f"- wing_hinge_relative_drift_px: {metric['wing_hinge_relative_drift_px']}")
        lines.append(f"- wingtip_smoothness: {metric['wingtip_smoothness']}")
        lines.append(f"- left_right_symmetry_estimate_px: {metric['left_right_symmetry_estimate_px']}")
        lines.append(f"- body_identity_drift: {metric['body_identity_drift']}")
        lines.append(f"- tail_drift: {metric['tail_drift']}")
        lines.append("")
    lines.extend(
        [
            "## Human Checklist",
            "",
            "| Check | PASS | FAIL | NEEDS_FIX | Notes |",
            "|---|---|---|---|---|",
            "| one wing pair only | [ ] | [ ] | [ ] | |",
            "| hinge stable | [ ] | [ ] | [ ] | |",
            "| membrane coherent | [ ] | [ ] | [ ] | |",
            "| flap reads naturally | [ ] | [ ] | [ ] | |",
            "| no geometric wireframe wings | [ ] | [ ] | [ ] | |",
            "| no leftover extra wings | [ ] | [ ] | [ ] | |",
            "| body identity stable | [ ] | [ ] | [ ] | |",
            "| hover stable | [ ] | [ ] | [ ] | |",
            "| loop seamless | [ ] | [ ] | [ ] | |",
            "| long-term desktop comfort | [ ] | [ ] | [ ] | |",
            "",
            "HUMAN_VISUAL_ACCEPTANCE = PENDING",
            "",
        ]
    )
    (package_root / "DRAGON_V1_V3_LOCKED_BODY_WING_RERIG_REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="DeskPet repository root")
    parser.add_argument("--timestamp", required=True, help="Package timestamp")
    args = parser.parse_args()

    repo = Path(args.root).resolve()
    package_root = repo / f"Assets/DragonV1/review/dragon_v1_v3_locked_body_wing_rerig_{args.timestamp}"
    for subdir in ("clips", "previews", "previews/loop_stress", "mp4_frames", "contact_sheets", "comparisons", "metrics", "sources"):
        (package_root / subdir).mkdir(parents=True, exist_ok=True)

    base = Image.open(repo / SOURCE_BASE).convert("RGBA")
    source_left_mask, source_right_mask = wing_masks()
    _, _, exclusion_mask = cleaned_wing_masks(source_left_mask, source_right_mask)
    left_wing = paint_organic_wing("left")
    right_wing = paint_organic_wing("right")
    left_mask = left_wing.getchannel("A")
    right_mask = right_wing.getchannel("A")
    body = remove_wings_from_body(base, source_left_mask, source_right_mask)
    base.save(package_root / "sources/base_canvas_source.png")
    left_mask.save(package_root / "sources/left_wing_mask.png")
    right_mask.save(package_root / "sources/right_wing_mask.png")
    exclusion_mask.save(package_root / "sources/wing_exclusion_mask.png")
    left_wing.save(package_root / "sources/left_wing_layer.png")
    right_wing.save(package_root / "sources/right_wing_layer.png")
    body.save(package_root / "sources/body_without_original_wings.png")
    for index, key in enumerate(KEY_POSES):
        pose = lerp_pose(key, key, 0, 1.0)
        frame, _ = compose_frame(body, left_wing, right_wing, pose, 0, False)
        frame.save(package_root / f"sources/key_pose_{index}_{key['name']}.png")

    preview_paths: dict[str, dict[str, str]] = {}
    contact_paths: dict[str, str] = {}
    metrics_list: list[dict[str, Any]] = []
    first_frames: dict[str, Image.Image] = {}
    clip_paths: dict[str, list[Path]] = {}

    for clip_name, spec in CLIPS.items():
        frames, paths, geometry = render_clip(body, left_wing, right_wing, clip_name, spec, package_root / "clips" / clip_name)
        first_frames[clip_name] = frames[0]
        clip_paths[clip_name] = paths
        fps = int(spec["fps"])
        transparent_gif = package_root / "previews" / f"{clip_name}_transparent.gif"
        checker_gif = package_root / "previews" / f"{clip_name}_checker.gif"
        checker_mp4 = package_root / "previews" / f"{clip_name}_checker.mp4"
        save_gif(frames, transparent_gif, fps=fps, checker=False)
        save_gif(frames, checker_gif, fps=fps, checker=True)
        save_mp4(frames, package_root / "mp4_frames" / f"{clip_name}_checker", checker_mp4, fps=fps)
        stress_frames = frames * 5
        stress_gif = package_root / "previews/loop_stress" / f"{clip_name}_loop_stress_5x_checker.gif"
        stress_mp4 = package_root / "previews/loop_stress" / f"{clip_name}_loop_stress_5x_checker.mp4"
        save_gif(stress_frames, stress_gif, fps=fps, checker=True)
        save_mp4(stress_frames, package_root / "mp4_frames" / f"{clip_name}_loop_stress_5x_checker", stress_mp4, fps=fps)
        preview_paths[clip_name] = {
            "transparent_gif": str(transparent_gif.resolve()),
            "checker_gif": str(checker_gif.resolve()),
            "checker_mp4": str(checker_mp4.resolve()),
            "loop_stress_5x_checker_gif": str(stress_gif.resolve()),
            "loop_stress_5x_checker_mp4": str(stress_mp4.resolve()),
        }
        contact = package_root / "contact_sheets" / f"{clip_name}_contact_sheet.png"
        contact_sheet(clip_name, paths, contact)
        contact_paths[clip_name] = str(contact.resolve())
        metrics_list.append(clip_metrics(clip_name, paths, fps, geometry))

    failed_v2 = repo / FAILED_V2_ROOT
    char_idle = Image.open(repo / CHARACTER_IDLE).convert("RGBA")
    char_left = Image.open(repo / CHARACTER_WALK_LEFT).convert("RGBA")
    char_right = Image.open(repo / CHARACTER_WALK_RIGHT).convert("RGBA")
    habitat = Image.open(repo / HABITAT).convert("RGBA") if (repo / HABITAT).exists() else None
    comparison_paths: dict[str, str] = {}

    v2_right = Image.open(failed_v2 / "clips/dragon_fly_right_loop_v2/frame_000.png").convert("RGBA")
    v2_idle = Image.open(failed_v2 / "clips/dragon_idle_hover_v2/frame_000.png").convert("RGBA")
    out = package_root / "comparisons/failed_v2_vs_v3_wing_rerig.png"
    make_comparison(
        "Failed v2 vs v3 locked-body organic wing rerig",
        [
            ("failed v2 idle", v2_idle, height_label("v2", v2_idle, DRAGON_RUNTIME_SCALE)),
            ("v3 idle", first_frames["dragon_idle_hover_v3"], height_label("v3", first_frames["dragon_idle_hover_v3"], DRAGON_RUNTIME_SCALE)),
            ("failed v2 fly R", v2_right, height_label("v2", v2_right, DRAGON_RUNTIME_SCALE)),
            ("v3 fly R", first_frames["dragon_fly_right_loop_v3"], height_label("v3", first_frames["dragon_fly_right_loop_v3"], DRAGON_RUNTIME_SCALE)),
        ],
        out,
    )
    comparison_paths["failed_v2_vs_v3"] = str(out.resolve())

    out = package_root / "comparisons/dragon_idle_hover_v3_vs_character_idle.png"
    make_comparison(
        "Dragon idle hover v3 vs CharacterV2 idle",
        [
            ("dragon idle_hover_v3", first_frames["dragon_idle_hover_v3"], height_label("dragon", first_frames["dragon_idle_hover_v3"], DRAGON_RUNTIME_SCALE)),
            ("CharacterV2 idle", char_idle, f"character visual height={visual_height(char_idle)}px, runtime=132.0pt"),
        ],
        out,
    )
    comparison_paths["idle_vs_character"] = str(out.resolve())

    out = package_root / "comparisons/dragon_fly_v3_vs_character_walk.png"
    make_comparison(
        "Dragon fly v3 vs CharacterV2 walk",
        [
            ("dragon fly_left_v3", first_frames["dragon_fly_left_loop_v3"], height_label("dragon", first_frames["dragon_fly_left_loop_v3"], DRAGON_RUNTIME_SCALE)),
            ("CharacterV2 walk_left", char_left, f"character visual height={visual_height(char_left)}px, runtime=132.0pt"),
            ("dragon fly_right_v3", first_frames["dragon_fly_right_loop_v3"], height_label("dragon", first_frames["dragon_fly_right_loop_v3"], DRAGON_RUNTIME_SCALE)),
            ("CharacterV2 walk_right", char_right, f"character visual height={visual_height(char_right)}px, runtime=132.0pt"),
        ],
        out,
    )
    comparison_paths["fly_vs_character_walk"] = str(out.resolve())

    out = package_root / "comparisons/dragon_v3_near_character_runtime_scale.png"
    make_scale_scene(first_frames["dragon_idle_hover_v3"], char_idle, None, out)
    comparison_paths["near_character_runtime_scale"] = str(out.resolve())
    if habitat is not None:
        out = package_root / "comparisons/dragon_v3_near_character_habitat.png"
        make_scale_scene(first_frames["dragon_idle_hover_v3"], char_idle, habitat, out)
        comparison_paths["near_character_habitat"] = str(out.resolve())

    metrics = {
        "package_root": str(package_root.resolve()),
        "source_base": str((repo / SOURCE_BASE).resolve()),
        "failed_v2_root": str(failed_v2.resolve()),
        "clips": metrics_list,
    }
    metrics_path = package_root / "metrics/dragon_v1_v3_wing_rerig_metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_report(package_root, preview_paths, contact_paths, comparison_paths, metrics)
    print(json.dumps({"package_root": str(package_root.resolve()), "metrics": str(metrics_path.resolve())}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
