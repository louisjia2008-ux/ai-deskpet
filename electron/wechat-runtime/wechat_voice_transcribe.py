"""Hear the owner's WeChat voice message with the installed DeskPet listening worker."""

import json
from pathlib import Path
import subprocess


MODEL = "mlx-community/Qwen3-ASR-1.7B-8bit"
TIMEOUT_SECONDS = 60
# Leaves room in the 500-character request for the note that the reply will be spoken.
MAX_TEXT = 400


class VoiceTranscriptionError(RuntimeError):
    """A fixed diagnostic that contains no speech or local profile paths."""


def voice_runtime():
    """The owner's enabled voice folder, shared with the desktop voice; None when voice is off."""
    home = Path.home()
    settings_path = home / "Library/Application Support/DeskPet Electron/voice-settings.json"
    try:
        wrapper = json.loads(settings_path.read_text(encoding="utf-8"))
        settings = wrapper["data"]
        if wrapper["schemaVersion"] != 1:
            return None
        if settings["enabled"] is not True:
            return None
        runtime = Path(settings["runtimeDir"])
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError):
        raise VoiceTranscriptionError("无法读取桌宠的本地语音设置。") from None
    return runtime if runtime.is_absolute() else None


def transcribe(audio: bytes, hints=()) -> str:
    """The words of one voice message; empty when nothing intelligible was heard."""
    runtime = voice_runtime()
    home = Path.home()
    worker = home / "Applications/DeskPet Electron.app/Contents/Resources/voice-runtime/asr_worker.py"
    if runtime is None:
        raise VoiceTranscriptionError("本地语音未启用。")
    if (not (runtime / ".venv/bin/python").is_file() or not worker.is_file()
            or not (runtime / "hf/hub" / f"models--{MODEL.replace('/', '--')}").is_dir()):
        raise VoiceTranscriptionError("桌宠的本地听写环境不完整。")
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "HF_HOME": str(runtime / "hf"),
           "HF_HUB_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false"}
    words = [hint for hint in hints if isinstance(hint, str) and 0 < len(hint) <= 40 and not hint.startswith("-")][:8]
    try:
        completed = subprocess.run(
            [str(runtime / ".venv/bin/python"), "-I", "-B", str(worker), MODEL, *words],
            cwd=runtime, env=env, input=audio, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=TIMEOUT_SECONDS, check=False,
        )
        result = json.loads(completed.stdout.decode("utf-8").strip().splitlines()[-1])
    except subprocess.TimeoutExpired:
        raise VoiceTranscriptionError("本地听写超时。") from None
    except (OSError, ValueError, IndexError):
        raise VoiceTranscriptionError("本地听写没有返回结果。") from None
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise VoiceTranscriptionError("本地听写失败。")
    return " ".join(result["text"].split())[:MAX_TEXT]
