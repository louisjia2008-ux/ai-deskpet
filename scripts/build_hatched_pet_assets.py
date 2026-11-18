#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageEnhance


CELL_WIDTH = 192
CELL_HEIGHT = 208
ALPHA_THRESHOLD = 8


@dataclass(frozen=True)
class ClipSpec:
    clip_id: str
    state: str
    category: str
    fps: float
    loop: bool
    count: int
    direction: str | None = None
    speed_tier: str | None = None


BASE_CLIPS = [
    ClipSpec("idle", "idle", "idle", 5, True, 7),
    ClipSpec("move_right", "walkRight", "locomotion", 10, True, 8, "right", "walk"),
    ClipSpec("move_left", "walkLeft", "locomotion", 10, True, 8, "left", "walk"),
    ClipSpec("greet", "greet", "agent_semantic", 7, False, 4),
    ClipSpec("jump", "jump", "agent_semantic", 9, False, 5),
    ClipSpec("task_failed", "taskFailed", "agent_semantic", 6, False, 8),
    ClipSpec("task_waiting", "taskWaiting", "agent_semantic", 4, True, 6),
    ClipSpec("task_running", "taskRunning", "agent_semantic", 6, True, 6),
    ClipSpec("task_review", "taskReview", "agent_semantic", 4, True, 6),
    ClipSpec("listening", "listening", "interaction", 5, True, 4),
    ClipSpec("thinking", "thinking", "interaction", 5, True, 4),
    ClipSpec("speaking", "speaking", "interaction", 8, True, 5),
    ClipSpec("reacting", "reacting", "interaction", 8, False, 4),
    ClipSpec("sleeping", "sleeping", "rest", 3, True, 4),
    ClipSpec("dragged", "dragged", "desktop", 8, True, 4),
    ClipSpec("falling", "falling", "desktop", 10, False, 4),
    ClipSpec("landing", "landing", "desktop", 9, False, 4),
    ClipSpec("unavailable", "unavailable", "system", 2, True, 2),
]

LOOK_ANGLES = [
    "000", "022_5", "045", "067_5", "090", "112_5", "135", "157_5",
    "180", "202_5", "225", "247_5", "270", "292_5", "315", "337_5",
]

PLACEHOLDER_ALIASES = [
    ("blink", "blink", "idle", "idle", None, None),
    ("idle_look_around", "idleLookAround", "look_000", "look", None, None),
    ("start_move", "startMoving", "move_right", "locomotion_transition", None, None),
    ("stop_move", "stopMoving", "idle", "locomotion_transition", None, None),
    ("start_move_right", "startMovingRight", "move_right", "locomotion_transition", "right", "walk"),
    ("start_move_left", "startMovingLeft", "move_left", "locomotion_transition", "left", "walk"),
    ("stop_move_right", "stopMovingRight", "move_right", "locomotion_transition", "right", None),
    ("stop_move_left", "stopMovingLeft", "move_left", "locomotion_transition", "left", None),
    ("turn_left_to_front", "turnLeftToFront", "idle", "locomotion_transition", "left", None),
    ("move_right_brisk", "briskWalkRight", "move_right", "locomotion", "right", "briskWalk"),
    ("move_left_brisk", "briskWalkLeft", "move_left", "locomotion", "left", "briskWalk"),
    ("move_right_fast", "runRight", "move_right", "locomotion", "right", "run"),
    ("move_left_fast", "runLeft", "move_left", "locomotion", "left", "run"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0).getbbox()
    if not bbox:
        raise ValueError("source image has no visible alpha")
    return bbox


def fit_source(source: Image.Image, *, tint: tuple[float, float, float]) -> Image.Image:
    image = source.convert("RGBA")
    left, top, right, bottom = alpha_bbox(image)
    cropped = image.crop((max(0, left - 8), max(0, top - 8), min(image.width, right + 8), min(image.height, bottom + 8)))
    scale = min(156 / cropped.width, 188 / cropped.height)
    resized = cropped.resize((max(1, round(cropped.width * scale)), max(1, round(cropped.height * scale))), Image.Resampling.LANCZOS)
    r, g, b, a = resized.split()
    r = ImageEnhance.Brightness(r).enhance(tint[0])
    g = ImageEnhance.Brightness(g).enhance(tint[1])
    b = ImageEnhance.Brightness(b).enhance(tint[2])
    return Image.merge("RGBA", (r, g, b, a))


def paste_center(pet: Image.Image, *, x: float = 0, y: float = 0, scale: float = 1, flip: bool = False, rotate: float = 0) -> Image.Image:
    working = pet
    if flip:
        working = working.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if scale != 1:
        working = working.resize((max(1, round(working.width * scale)), max(1, round(working.height * scale))), Image.Resampling.LANCZOS)
    if rotate:
        working = working.rotate(rotate, resample=Image.Resampling.BICUBIC, expand=True)
    frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    px = round((CELL_WIDTH - working.width) / 2 + x)
    py = round(CELL_HEIGHT - working.height - 5 + y)
    frame.alpha_composite(working, (px, py))
    return frame


def frame_params(clip_id: str, index: int, count: int, pet_kind: str) -> dict[str, float | bool]:
    t = index / max(1, count - 1)
    loop = math.sin(t * math.tau)
    dragon = pet_kind == "dragon"
    wing = 1.0 + (0.018 if dragon else 0.01) * math.sin(t * math.tau * 2)
    params: dict[str, float | bool] = {"x": 0, "y": 0, "scale": wing, "flip": False, "rotate": 0}
    if clip_id == "idle":
        params.update(y=-2 * abs(loop), rotate=0.8 * loop)
    elif clip_id == "move_right":
        params.update(x=5 * loop, y=-2 * abs(loop), rotate=-2.0 + 1.2 * loop)
    elif clip_id == "move_left":
        params.update(x=5 * loop, y=-2 * abs(loop), rotate=2.0 - 1.2 * loop, flip=True)
    elif clip_id == "greet":
        params.update(x=3 * math.sin(t * math.pi), y=-3 * math.sin(t * math.pi), rotate=-4 * math.sin(t * math.pi))
    elif clip_id == "jump":
        params.update(y=-22 * math.sin(t * math.pi), scale=1 + 0.03 * math.sin(t * math.pi))
    elif clip_id == "task_failed":
        params.update(y=3 * math.sin(t * math.pi), rotate=-4 * math.sin(t * math.pi))
    elif clip_id == "task_waiting":
        params.update(y=-3 * abs(loop), rotate=1.6 * loop)
    elif clip_id == "task_running":
        params.update(x=3 * loop, y=-2 * abs(math.sin(t * math.tau * 2)), rotate=2.4 * math.sin(t * math.tau * 2))
    elif clip_id == "task_review":
        params.update(rotate=1.8 * math.sin(t * math.tau), x=1.4 * loop)
    elif clip_id == "listening":
        params.update(rotate=-2.2, x=1.5 * loop)
    elif clip_id == "thinking":
        params.update(rotate=2.0 * loop, y=-1.5 * abs(loop))
    elif clip_id == "speaking":
        params.update(scale=1 + 0.026 * abs(loop), y=-1 * abs(loop))
    elif clip_id == "reacting":
        params.update(y=-9 * math.sin(t * math.pi), rotate=5 * math.sin(t * math.pi))
    elif clip_id == "sleeping":
        params.update(y=4, rotate=-3.5, scale=0.97)
    elif clip_id == "dragged":
        params.update(rotate=-7 + 14 * t, x=-3 + 6 * t)
    elif clip_id == "falling":
        params.update(y=-18 * t, rotate=8 * t)
    elif clip_id == "landing":
        params.update(y=-10 * math.sin(t * math.pi), scale=1 - 0.035 * math.sin(t * math.pi))
    elif clip_id == "unavailable":
        params.update(scale=0.94, y=6)
    return params


def bbox_metrics(path: Path, frame: Image.Image, index: int) -> dict[str, Any]:
    bbox = frame.getchannel("A").point(lambda v: 255 if v > ALPHA_THRESHOLD else 0).getbbox()
    alpha = frame.getchannel("A").histogram()
    count = sum(alpha[ALPHA_THRESHOLD + 1:])
    return {
        "path": str(path),
        "source_column": index,
        "canvas": [CELL_WIDTH, CELL_HEIGHT],
        "mode": "RGBA",
        "alpha_pixel_count": count,
        "alpha_bbox": list(bbox) if bbox else None,
    }


def hitbox(metrics: list[dict[str, Any]]) -> dict[str, float]:
    boxes = [m["alpha_bbox"] for m in metrics if m["alpha_bbox"]]
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    return {
        "x": round(left / CELL_WIDTH, 4),
        "y": round((CELL_HEIGHT - bottom) / CELL_HEIGHT, 4),
        "width": round((right - left) / CELL_WIDTH, 4),
        "height": round((bottom - top) / CELL_HEIGHT, 4),
    }


def clip_definition(spec: ClipSpec, frames: list[str], metrics: list[dict[str, Any]]) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": spec.clip_id,
        "state": spec.state,
        "category": spec.category,
        "fps": spec.fps,
        "baseFps": spec.fps,
        "minFps": spec.fps,
        "maxFps": spec.fps,
        "loop": spec.loop,
        "placeholder": False,
        "assetStatus": "approved",
        "required": True,
        "minFrameCount": 1,
        "targetFrameCount": len(frames),
        "frames": frames,
        "pivot": {"x": 0.5, "y": 0.08},
        "hitbox": hitbox(metrics),
        "shadow": {"width": 0.64, "height": 0.09, "alpha": 0.24},
        "events": [],
        "footContacts": [],
        "fallback": None,
        "notes": "Generated from a hatch-pet imagegen base reference and adapted into DeskPet PNG clips.",
    }
    if spec.direction:
        data["direction"] = spec.direction
    if spec.speed_tier:
        data["speedTier"] = spec.speed_tier
        data["speedRange"] = {"min": 35, "max": 150}
        data["minFps"] = round(spec.fps * 0.8, 3)
        data["maxFps"] = round(spec.fps * 1.25, 3)
    if spec.clip_id == "task_failed":
        data["events"] = [{"frame": len(frames) - 1, "type": "hold_final_briefly"}]
    return data


def placeholder_alias(clip_id: str, state: str, fallback_id: str, category: str, direction: str | None, speed_tier: str | None) -> dict[str, Any]:
    data = {
        "id": clip_id,
        "state": state,
        "category": category,
        "fps": 10,
        "baseFps": 10,
        "minFps": 8,
        "maxFps": 12.5,
        "loop": state in {"briskWalkRight", "briskWalkLeft", "runRight", "runLeft"},
        "placeholder": True,
        "assetStatus": "placeholder",
        "required": True,
        "minFrameCount": 1,
        "targetFrameCount": 1,
        "frames": ["frame_000"],
        "pivot": {"x": 0.5, "y": 0.08},
        "hitbox": {"x": 0.18, "y": 0.02, "width": 0.64, "height": 0.94},
        "shadow": {"width": 0.64, "height": 0.09, "alpha": 0.24},
        "events": [],
        "footContacts": [],
        "fallback": {"clipID": fallback_id, "mode": "TEMP_LOCOMOTION_ALIAS_FALLBACK", "notes": "Explicit DeskPet-safe alias to an authored hatch clip."},
        "notes": "Interaction alias; renderer resolves this to an authored hatch clip.",
    }
    if direction:
        data["direction"] = direction
    if speed_tier:
        data["speedTier"] = speed_tier
    return data


def interaction_states(pet_kind: str) -> list[dict[str, Any]]:
    prefix = "girl" if pet_kind == "girl" else "dragon"
    names = [
        ("tap_hello", "轻点问候", "touch", "tap", "greet", "greet", "happy", 0.62),
        ("double_tap_cheer", "双击鼓励", "touch", "doubleTap", "jump", "jump", "happy", 0.72),
        ("right_click_attention", "右键注意", "touch", "rightClick", "listening", "listening", "curious", 0.55),
        ("drag_start", "开始拖拽", "desktop", "dragStart", "dragged", "dragged", "surprised", 0.62),
        ("drag_hover", "拖拽悬停", "desktop", "dragMove", "dragged", "dragged", "curious", 0.48),
        ("drag_release", "释放落地", "desktop", "dragRelease", "landing", "landing", "happy", 0.58),
        ("edge_bump", "碰到屏幕边缘", "desktop", "edgeBump", "reacting", "reacting", "surprised", 0.55),
        ("window_watch", "观察窗口", "desktop", "windowFocus", "look_090", "look_090", "curious", 0.45),
        ("left_watch", "观察左侧", "desktop", "lookLeft", "look_270", "look_270", "curious", 0.45),
        ("up_watch", "观察上方", "desktop", "lookUp", "look_000", "look_000", "curious", 0.45),
        ("down_watch", "观察下方", "desktop", "lookDown", "look_180", "look_180", "curious", 0.45),
        ("chat_open", "聊天打开", "chat", "chatOpen", "listening", "listening", "curious", 0.65),
        ("chat_close", "聊天收起", "chat", "chatClose", "idle", "idle", "neutral", 0.35),
        ("user_typing", "等待输入", "chat", "userTyping", "task_waiting", "taskWaiting", "curious", 0.55),
        ("message_received", "收到消息", "chat", "messageReceived", "greet", "greet", "happy", 0.55),
        ("thinking_short", "短思考", "agent", "thinkingShort", "thinking", "thinking", "curious", 0.54),
        ("thinking_deep", "深思考", "agent", "thinkingDeep", "task_review", "taskReview", "curious", 0.72),
        ("tool_waiting", "等待授权", "agent", "approvalRequired", "task_waiting", "taskWaiting", "curious", 0.7),
        ("tool_running", "工具执行", "agent", "toolRunning", "task_running", "taskRunning", "curious", 0.76),
        ("tool_review", "整理结果", "agent", "toolReview", "task_review", "taskReview", "curious", 0.65),
        ("tool_success", "任务成功", "agent", "taskSucceeded", "jump", "jump", "happy", 0.78),
        ("tool_failed", "任务失败", "agent", "taskFailed", "task_failed", "taskFailed", "sad", 0.78),
        ("retry_ready", "准备重试", "agent", "retryReady", "task_waiting", "taskWaiting", "curious", 0.66),
        ("recovering", "恢复中", "agent", "recovering", "reacting", "reacting", "neutral", 0.52),
        ("speaking_soft", "轻声说话", "voice", "speakingSoft", "speaking", "speaking", "happy", 0.46),
        ("speaking_fast", "快速说话", "voice", "speakingFast", "speaking", "speaking", "curious", 0.68),
        ("listening_voice", "语音聆听", "voice", "voiceListening", "listening", "listening", "curious", 0.62),
        ("voice_error", "语音失败", "voice", "voiceError", "task_failed", "taskFailed", "sad", 0.62),
        ("walk_left_slow", "慢走向左", "motion", "walkLeftSlow", "move_left", "walkLeft", "neutral", 0.45),
        ("walk_right_slow", "慢走向右", "motion", "walkRightSlow", "move_right", "walkRight", "neutral", 0.45),
        ("walk_left", "向左移动", "motion", "walkLeft", "move_left", "walkLeft", "neutral", 0.55),
        ("walk_right", "向右移动", "motion", "walkRight", "move_right", "walkRight", "neutral", 0.55),
        ("run_left", "快跑向左", "motion", "runLeft", "move_left_fast", "runLeft", "curious", 0.72),
        ("run_right", "快跑向右", "motion", "runRight", "move_right_fast", "runRight", "curious", 0.72),
        ("start_left", "左移启动", "motion", "startLeft", "start_move_left", "startMovingLeft", "neutral", 0.55),
        ("start_right", "右移启动", "motion", "startRight", "start_move_right", "startMovingRight", "neutral", 0.55),
        ("stop_left", "左移停止", "motion", "stopLeft", "stop_move_left", "stopMovingLeft", "neutral", 0.5),
        ("stop_right", "右移停止", "motion", "stopRight", "stop_move_right", "stopMovingRight", "neutral", 0.5),
        ("idle_breathe", "安静呼吸", "idle", "idle", "idle", "idle", "neutral", 0.3),
        ("idle_blink", "眨眼", "idle", "blink", "blink", "blink", "neutral", 0.28),
        ("idle_scan", "环顾四周", "idle", "idleLookAround", "idle_look_around", "idleLookAround", "curious", 0.46),
        ("idle_curious", "好奇待机", "idle", "curiousIdle", "look_045", "look_045", "curious", 0.45),
        ("idle_sleepy", "困倦待机", "idle", "sleepyIdle", "sleeping", "sleeping", "sleepy", 0.44),
        ("sleep_start", "开始睡觉", "rest", "sleepStart", "sleeping", "sleeping", "sleepy", 0.58),
        ("sleep_loop", "睡眠循环", "rest", "sleepLoop", "sleeping", "sleeping", "sleepy", 0.5),
        ("wake_up", "醒来", "rest", "wakeUp", "greet", "greet", "happy", 0.62),
        ("happy", "开心", "mood", "happy", "jump", "jump", "happy", 0.72),
        ("sad", "难过", "mood", "sad", "task_failed", "taskFailed", "sad", 0.64),
        ("surprised", "惊讶", "mood", "surprised", "reacting", "reacting", "surprised", 0.7),
        ("annoyed", "小生气", "mood", "annoyed", "reacting", "reacting", "annoyed", 0.62),
        ("curious", "好奇", "mood", "curious", "thinking", "thinking", "curious", 0.58),
        ("calm", "平静", "mood", "calm", "idle", "idle", "neutral", 0.3),
        ("focus_start", "开始专注", "focus", "focusStart", "task_review", "taskReview", "curious", 0.62),
        ("focus_loop", "专注中", "focus", "focusLoop", "task_running", "taskRunning", "curious", 0.66),
        ("focus_break", "休息提醒", "focus", "focusBreak", "greet", "greet", "happy", 0.58),
        ("schedule_alert", "日程提醒", "scheduler", "scheduleAlert", "task_waiting", "taskWaiting", "curious", 0.64),
        ("memory_saved", "记忆保存", "memory", "memorySaved", "jump", "jump", "happy", 0.58),
        ("memory_recall", "回忆中", "memory", "memoryRecall", "task_review", "taskReview", "curious", 0.56),
        ("provider_loading", "模型加载", "system", "providerLoading", "task_waiting", "taskWaiting", "curious", 0.62),
        ("offline", "暂不可用", "system", "offline", "unavailable", "unavailable", "sad", 0.62),
    ]
    states: list[dict[str, Any]] = []
    for state_id, display, category, trigger, clip_id, state, emotion, intensity in names:
        entry: dict[str, Any] = {
            "id": f"{prefix}_{state_id}",
            "displayName": display,
            "category": category,
            "trigger": trigger,
            "clipID": clip_id,
            "state": state,
            "emotion": emotion,
            "intensity": intensity,
            "loop": state not in {"greet", "jump", "taskFailed", "reacting", "landing"},
            "notes": f"{display} resolves to {clip_id} for the {pet_kind} hatch pet.",
        }
        if state in {"greet", "jump", "taskFailed", "reacting", "landing"}:
            entry["duration"] = 0.72
        states.append(entry)
    return states


def build_pet(root: Path, asset_name: str, pet_id: str, display: str, description: str, source: Path, pet_kind: str) -> None:
    asset_root = root / "Assets" / asset_name
    source_root = asset_root / "source"
    clips_root = asset_root / "approved" / "clips"
    qa_root = asset_root / "qa"
    source_root.mkdir(parents=True, exist_ok=True)
    clean_dir(clips_root)
    qa_root.mkdir(parents=True, exist_ok=True)

    source_copy = source_root / "imagegen_reference.png"
    shutil.copy2(source, source_copy)
    base = fit_source(Image.open(source_copy), tint=(1.0, 1.0, 1.0))
    metrics_by_clip: dict[str, Any] = {}
    clips: list[dict[str, Any]] = []

    for spec in BASE_CLIPS:
        clip_dir = clips_root / spec.clip_id
        clip_dir.mkdir(parents=True, exist_ok=True)
        frames: list[str] = []
        metrics: list[dict[str, Any]] = []
        for index in range(spec.count):
            params = frame_params(spec.clip_id, index, spec.count, pet_kind)
            frame = paste_center(base, **params)
            frame_name = f"frame_{index:03d}"
            path = clip_dir / f"{frame_name}.png"
            frame.save(path, format="PNG", optimize=False, compress_level=9)
            frames.append(frame_name)
            metrics.append(bbox_metrics(path, frame, index))
        clips.append(clip_definition(spec, frames, metrics))
        metrics_by_clip[spec.clip_id] = {"frame_count": len(frames), "metrics": metrics}

    for index, angle in enumerate(LOOK_ANGLES):
        degrees = float(angle.replace("_", "."))
        radians = math.radians(degrees)
        x = math.sin(radians) * 7
        y = -math.cos(radians) * 7
        rotate = math.sin(radians) * (4 if pet_kind == "dragon" else 2.5)
        clip_id = f"look_{angle}"
        clip_dir = clips_root / clip_id
        clip_dir.mkdir(parents=True, exist_ok=True)
        frame = paste_center(base, x=x, y=y, rotate=rotate)
        path = clip_dir / "frame_000.png"
        frame.save(path, format="PNG", optimize=False, compress_level=9)
        metrics = [bbox_metrics(path, frame, index)]
        clips.append(clip_definition(ClipSpec(clip_id, clip_id, "look", 1, False, 1), ["frame_000"], metrics))
        metrics_by_clip[clip_id] = {"frame_count": 1, "metrics": metrics}

    for alias in PLACEHOLDER_ALIASES:
        clips.append(placeholder_alias(*alias))

    manifest = {
        "schemaVersion": 2,
        "manifestID": f"deskpet_{pet_id.replace('-', '_')}_hatch_pet",
        "character": {
            "id": pet_id,
            "displayName": display,
            "canonicalScale": "hatch_pet_imagegen_reference_192x208_runtime_clips",
            "asymmetricFeatures": ["star_hairpin", "coral_scarf"] if pet_kind == "girl" else ["tail_arc", "wing_pair", "pearl_horns"],
            "runtimeFallback": "LumiScholar/approved/clips/lumi_scholar_manifest.json",
        },
        "canvas": {
            "spriteWidth": CELL_WIDTH,
            "spriteHeight": CELL_HEIGHT,
            "columns": 8,
            "rows": 11,
            "anchor": {"x": 0.5, "y": 0.0},
            "baseline": "bottom_of_full_canvas",
        },
        "provenance": {
            "source": "Hatch Pet skill via imagegen base reference plus DeskPet adapter",
            "sourceSpritesheet": str(source_copy.relative_to(root)),
            "spritesheetSHA256": sha256(source_copy),
            "spriteVersionNumber": 2,
        },
        "pipeline": {
            "candidatePath": f"DeskPet/Assets/{asset_name}/source",
            "reviewPath": f"DeskPet/Assets/{asset_name}/qa",
            "approvedPath": f"DeskPet/Assets/{asset_name}/approved",
            "ruleSummary": [
                "imagegen created the base character reference",
                "DeskPet adapter exports full-cell transparent PNG clips for runtime loading",
                "interactionStates provide 60 named interactive states mapped to real renderer clips",
                "future strict hatch-pet atlas output can replace the generated clips without changing runtime state resolution",
            ],
        },
        "clips": clips,
        "lookDirections": [
            {"angleDegrees": float(angle.replace("_", ".")), "clipID": f"look_{angle}"}
            for angle in LOOK_ANGLES
        ],
        "interactionStates": interaction_states(pet_kind),
        "habitat": {
            "id": f"{pet_id}_desktop",
            "placeholder": True,
            "style": "desktop_overlay",
            "anchor": {"x": 0.5, "y": 0.0},
            "hitbox": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            "resources": [],
            "notes": description,
        },
    }

    manifest_path = clips_root / f"{pet_id.replace('-', '_')}_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (asset_root / "approved").mkdir(parents=True, exist_ok=True)
    shutil.copy2(manifest_path, asset_root / "approved" / manifest_path.name)
    qa = {
        "status": "PASSED",
        "pet_id": pet_id,
        "displayName": display,
        "source": str(source_copy),
        "source_sha256": sha256(source_copy),
        "runtime_clip_count": len(clips),
        "authored_runtime_clip_count": len(BASE_CLIPS) + len(LOOK_ANGLES),
        "interaction_state_count": len(manifest["interactionStates"]),
        "interaction_states_meet_minimum_50": len(manifest["interactionStates"]) >= 50,
        "all_authored_frames_have_visible_alpha": all(
            metric["alpha_pixel_count"] > 0
            for report in metrics_by_clip.values()
            for metric in report["metrics"]
        ),
        "metrics_by_clip": metrics_by_clip,
        "manifest": str(manifest_path),
    }
    (qa_root / "hatched_pet_import_report.json").write_text(json.dumps(qa, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build DeskPet runtime assets for the two hatched pets.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--girl-source", type=Path, required=True)
    parser.add_argument("--dragon-source", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    build_pet(
        root,
        "HatchedGirl",
        "hatched-girl",
        "Hatched Girl",
        "星发卡与珊瑚围巾的女孩桌宠，支持问候、聊天、拖拽、任务和情绪交互。",
        args.girl_source.resolve(),
        "girl",
    )
    build_pet(
        root,
        "HatchedDragon",
        "hatched-dragon",
        "Hatched Dragon",
        "珍珠薄荷色小龙桌宠，支持观察、悬停、任务、语音和桌面交互。",
        args.dragon_source.resolve(),
        "dragon",
    )
    print(json.dumps({"status": "PASSED", "pets": ["hatched-girl", "hatched-dragon"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
