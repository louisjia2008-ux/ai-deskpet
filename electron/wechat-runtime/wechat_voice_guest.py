"""Feed a short PCM WAV to the dedicated guest WeChat recording device."""

import argparse
from io import BytesIO
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import wave


WECHAT = "/opt/wechat/wechat"
PULSE_SERVER = "unix:/run/deskpet-wechat-audio/native"
VOICE_SINK = "deskpet_voice"
VOICE_SOURCE = "deskpet_voice_mic"
MAX_SECONDS = 30
MAX_WAV_BYTES = 48_000 * 2 * MAX_SECONDS + 4096
CAPTURE_TIMEOUT = 5
PADDING_SECONDS = 0.20


class VoiceInputError(RuntimeError):
    """The message is a short diagnostic code for the Mac caller."""


def verify_wechat_pid(pid):
    process = Path("/proc") / str(pid)
    try:
        matches = (pid > 0 and process.stat().st_uid == os.getuid()
                   and os.readlink(process / "exe") == WECHAT)
    except OSError as error:
        raise VoiceInputError("wechat_process_changed") from error
    if not matches:
        raise VoiceInputError("wechat_process_changed")


def read_wav(reader):
    data = reader.read(MAX_WAV_BYTES + 1)
    if len(data) > MAX_WAV_BYTES:
        raise VoiceInputError("voice_audio_too_large")
    try:
        with wave.open(BytesIO(data), "rb") as clip:
            rate = clip.getframerate()
            frames = clip.getnframes()
            if (clip.getnchannels() != 1 or clip.getsampwidth() != 2
                    or not 8000 <= rate <= 48000 or not rate <= frames <= rate * MAX_SECONDS):
                raise VoiceInputError("voice_audio_format_invalid")
            samples = clip.readframes(frames)
    except (wave.Error, EOFError) as error:
        raise VoiceInputError("voice_audio_format_invalid") from error
    if len(samples) != 2 * frames or not any(samples):
        raise VoiceInputError("voice_audio_format_invalid")
    return samples, rate, frames / rate


def audible(device):
    return (device["mute"] is False and bool(device["volume"])
            and all(channel["value"] > 0 for channel in device["volume"].values()))


class VoiceRoute:
    def __init__(self, server):
        self.server = server
        if not server.startswith("unix:/"):
            raise VoiceInputError("voice_audio_socket_invalid")
        info = Path(server.removeprefix("unix:")).stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise VoiceInputError("voice_audio_socket_invalid")
        sink = self.device(self.streams("sinks"), VOICE_SINK)
        sources = self.streams("sources")
        mic = self.device(sources, VOICE_SOURCE)
        monitor = self.device(sources, VOICE_SINK + ".monitor")
        if (Path(sink["driver"]).name != "module-null-sink.c"
                or Path(mic["driver"]).name != "module-remap-source.c"
                or sink["monitor_source"] != monitor["name"]
                or monitor["monitor_source"] != VOICE_SINK
                or not audible(sink) or not audible(mic) or not audible(monitor)
                or self.pactl("get-default-source").strip() != VOICE_SOURCE
                or self.pactl("get-default-sink").strip() == VOICE_SINK):
            raise VoiceInputError("voice_audio_route_invalid")
        self.sink = sink["index"]
        self.mic = mic["index"]
        self.monitor = monitor["index"]
        self.remap_module = str(mic["owner_module"])

    def pactl(self, *args):
        return subprocess.run(
            ["/usr/bin/pactl", "--server", self.server, *args],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, text=True, timeout=2, check=True,
        ).stdout

    def streams(self, kind):
        result = json.loads(self.pactl("--format=json", "list", kind))
        if not isinstance(result, list):
            raise VoiceInputError("voice_audio_response_invalid")
        return result

    @staticmethod
    def device(devices, name):
        matches = [device for device in devices if device["name"] == name]
        if len(matches) != 1:
            raise VoiceInputError("voice_audio_device_missing")
        return matches[0]

    def capture_streams(self):
        streams = self.streams("source-outputs")
        # The module-remap-source link is itself a PulseAudio capture stream.
        remaps = [
            stream for stream in streams
            if str(stream["owner_module"]) == self.remap_module and stream["client"] is None
        ]
        if (len(remaps) != 1 or remaps[0]["source"] != self.monitor
                or remaps[0]["mute"] is not False):
            raise VoiceInputError("voice_audio_route_invalid")
        return [stream for stream in streams if stream["index"] != remaps[0]["index"]]

    def check_sink_idle(self):
        if any(stream["sink"] == self.sink for stream in self.streams("sink-inputs")):
            raise VoiceInputError("voice_audio_sink_busy")

    def check_idle(self):
        if self.capture_streams():
            raise VoiceInputError("voice_recording_busy")
        self.check_sink_idle()

    def wechat_stream(self, pid):
        candidates = self.capture_streams()
        if not candidates:
            return None
        if (len(candidates) != 1
                or candidates[0]["properties"].get("application.process.id") != str(pid)):
            raise VoiceInputError("voice_recording_ambiguous")
        verify_wechat_pid(pid)
        return candidates[0]

    def wait_for_recording(self, pid):
        deadline = time.monotonic() + CAPTURE_TIMEOUT
        while time.monotonic() < deadline:
            stream = self.wechat_stream(pid)
            if stream is not None and stream["corked"] is False:
                if stream["mute"] is not False:
                    raise VoiceInputError("voice_recording_muted")
                if stream["source"] != self.mic:
                    self.pactl("move-source-output", str(stream["index"]), VOICE_SOURCE)
                return stream["index"]
            time.sleep(0.10)
        raise VoiceInputError("voice_recording_unavailable")

    def verify_recording(self, pid, index):
        stream = self.wechat_stream(pid)
        if (stream is None or stream["index"] != index or stream["source"] != self.mic
                or stream["corked"] is not False or stream["mute"] is not False):
            raise VoiceInputError("voice_recording_changed")

    def play(self, pid, samples, rate, duration):
        self.check_sink_idle()
        index = self.wait_for_recording(pid)
        self.verify_recording(pid, index)
        padding = bytes(2 * round(rate * PADDING_SECONDS))
        subprocess.run(
            ["/usr/bin/pacat", "--server", self.server, "--device", VOICE_SINK,
             "--playback", "--raw", "--format=s16le", f"--rate={rate}",
             "--channels=1", "--channel-map=mono", "--latency-msec=100"],
            input=padding + samples + padding,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=duration + 4, check=True,
        )
        self.verify_recording(pid, index)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "play"))
    parser.add_argument("--wechat-pid", required=True, type=int)
    parser.add_argument("--server", default=PULSE_SERVER)
    args = parser.parse_args()
    try:
        verify_wechat_pid(args.wechat_pid)
        route = VoiceRoute(args.server)
        if args.action == "check":
            route.check_idle()
            result = {"ok": True}
        else:
            samples, rate, duration = read_wav(sys.stdin.buffer)
            route.play(args.wechat_pid, samples, rate, duration)
            result = {"ok": True, "duration": duration}
    except VoiceInputError as error:
        result = {"ok": False, "error": str(error)}
    except (OSError, subprocess.SubprocessError):
        result = {"ok": False, "error": "voice_audio_unavailable"}
    except (KeyError, ValueError, TypeError):
        result = {"ok": False, "error": "voice_audio_response_invalid"}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
