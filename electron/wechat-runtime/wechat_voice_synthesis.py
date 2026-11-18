"""Render a bounded WAV with the installed DeskPet speech worker."""

import base64
import io
import json
from pathlib import Path
import re
import selectors
import subprocess
import time
import uuid
import wave


MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
TIMEOUT_SECONDS = 90
MAX_VOICE_SECONDS = 30
MAX_RECORD_BYTES = 1024 * 1024


class VoiceSynthesisError(RuntimeError):
    """A fixed diagnostic that contains no speech or local profile paths."""


_EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")


def speakable(text):
    """What of a reply can be said aloud: no code, links, markdown or emoji (as on the desktop)."""
    text = re.sub(r"```.*?(?:```|$)", " ", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+", "", text, flags=re.M)
    text = _EMOJI.sub("", re.sub(r"[*_~|#>]+", "", text))
    return "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip())


def _read_records(output, deadline):
    pending = b""
    with selectors.DefaultSelector() as selector:
        selector.register(output, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise VoiceSynthesisError("本地语音模型生成超时。")
            data = output.read1(65536)
            if not data:
                if pending:
                    raise VoiceSynthesisError("本地语音模型返回了不完整的数据。")
                return
            *lines, pending = (pending + data).split(b"\n")
            if len(pending) > MAX_RECORD_BYTES:
                raise VoiceSynthesisError("本地语音模型返回的数据过大。")
            for line in lines:
                if len(line) > MAX_RECORD_BYTES:
                    raise VoiceSynthesisError("本地语音模型返回的数据过大。")
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise VoiceSynthesisError("本地语音模型返回了无效的数据。")
                yield record


def _render(home, runtime, worker_script, text):
    request_id = uuid.uuid4().hex
    request = json.dumps({"id": request_id, "text": text}, ensure_ascii=False).encode("utf-8")
    deadline = time.monotonic() + TIMEOUT_SECONDS
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "HF_HOME": str(runtime / "hf"),
        "HF_HUB_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
    }
    with subprocess.Popen(
        [str(runtime / ".venv/bin/python"), "-I", "-B", str(worker_script), MODEL],
        cwd=runtime, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as child:
        try:
            child.stdin.write(request + b"\n")
            child.stdin.close()
            pcm = bytearray()
            rate = 0
            complete = False
            for record in _read_records(child.stdout, deadline):
                if record.get("id") != request_id:
                    continue
                if "error" in record:
                    raise VoiceSynthesisError("本地语音模型生成失败。")
                if record.get("done") is True:
                    complete = True
                    break
                chunk_rate, encoded = record.get("rate"), record.get("pcm")
                if type(chunk_rate) is not int or not 8000 <= chunk_rate <= 48000 or not isinstance(encoded, str):
                    raise VoiceSynthesisError("本地语音模型返回了无效的采样格式。")
                if rate and rate != chunk_rate:
                    raise VoiceSynthesisError("本地语音模型的采样率发生了变化。")
                rate = chunk_rate
                chunk = base64.b64decode(encoded, validate=True)
                if len(chunk) % 2:
                    raise VoiceSynthesisError("本地语音模型返回了不完整的采样。")
                if len(pcm) + len(chunk) > rate * 2 * MAX_VOICE_SECONDS:
                    raise VoiceSynthesisError("生成的语音超过 30 秒。")
                pcm.extend(chunk)
            if child.wait(timeout=max(0, deadline - time.monotonic())) != 0 or not complete:
                raise VoiceSynthesisError("本地语音模型未完成生成。")
        finally:
            if child.poll() is None:
                child.kill()
    if not rate or len(pcm) < rate * 2:
        raise VoiceSynthesisError("生成的语音不足一秒。")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)
    return output.getvalue()


def synthesize_wav(text: str) -> bytes:
    """Use the enabled local voice from the daily profile, with no playback on the Mac."""
    text = speakable(text)
    if not 1 <= len(text) <= 400:
        raise VoiceSynthesisError("语音内容需为 1 至 400 个字符。")
    home = Path.home()
    settings_path = home / "Library/Application Support/DeskPet Electron/voice-settings.json"
    worker = home / "Applications/DeskPet Electron.app/Contents/Resources/voice-runtime/tts_worker.py"
    try:
        wrapper = json.loads(settings_path.read_text(encoding="utf-8"))
        settings = wrapper["data"]
        if wrapper["schemaVersion"] != 1 or settings["enabled"] is not True:
            raise VoiceSynthesisError("请先在桌宠设置中启用本地语音。")
        runtime = Path(settings["runtimeDir"])
    except (OSError, ValueError, KeyError, TypeError):
        raise VoiceSynthesisError("无法读取桌宠的本地语音设置。") from None
    if not runtime.is_absolute() or not (runtime / ".venv/bin/python").is_file() or not worker.is_file():
        raise VoiceSynthesisError("桌宠的本地语音环境不完整。")
    try:
        return _render(home, runtime, worker, text)
    except subprocess.TimeoutExpired:
        raise VoiceSynthesisError("本地语音模型生成超时。") from None
    except (OSError, ValueError):
        raise VoiceSynthesisError("无法生成有效的本地语音。") from None
