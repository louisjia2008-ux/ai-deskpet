"""Offline tests for the dedicated PulseAudio voice route."""

from io import BytesIO
import json
import os
from pathlib import Path
import stat
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wechat-runtime"))
import wechat_voice_guest as guest


RATE = 24000
PID = 42
SINK = 4
MONITOR = 11
MIC = 12
REMAP_MODULE = 3


def wave_bytes(frames, channels=1, amplitude=100):
    buffer = BytesIO()
    with wave.open(buffer, "wb") as clip:
        clip.setnchannels(channels)
        clip.setsampwidth(2)
        clip.setframerate(RATE)
        clip.writeframes(struct.pack("<h", amplitude) * frames * channels)
    return buffer.getvalue()


def recording(*, pid=PID, source=MIC):
    return {
        "index": 3, "source": source, "owner_module": None, "client": "7",
        "properties": {"application.process.id": str(pid)}, "mute": False, "corked": False,
    }


class VoiceGuestTests(unittest.TestCase):
    def setUp(self):
        audible = {"mute": False, "volume": {"mono": {"value": 65536}}}
        sink = {"name": "deskpet_voice", "driver": "module-null-sink.c", "index": SINK,
                "monitor_source": "deskpet_voice.monitor", **audible}
        monitor = {"name": "deskpet_voice.monitor", "monitor_source": "deskpet_voice",
                   "index": MONITOR, **audible}
        mic = {"name": "deskpet_voice_mic", "driver": "/src/modules/module-remap-source.c",
               "index": MIC, "owner_module": REMAP_MODULE, **audible}
        internal = {"owner_module": str(REMAP_MODULE), "client": None,
                    "source": MONITOR, "mute": False, "index": 0}
        self.devices = {"sinks": [sink], "sources": [monitor, mic],
                        "source-outputs": [internal], "sink-inputs": []}
        self.default_sink = "deskpet_output"
        socket_info = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o600, st_uid=os.getuid())
        self.start_patch(patch.object(guest.Path, "stat", return_value=socket_info))
        self.start_patch(patch.object(guest, "verify_wechat_pid"))
        self.pactl = self.start_patch(patch.object(guest.VoiceRoute, "pactl", side_effect=self.pulse_response))
        self.playback = self.start_patch(patch.object(guest.subprocess, "run"))

    def start_patch(self, patcher):
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def pulse_response(self, *args):
        if args[0] == "--format=json":
            return json.dumps(self.devices[args[2]])
        if args[0] == "move-source-output":
            self.devices["source-outputs"][1]["source"] = MIC
            return ""
        return {"get-default-source": "deskpet_voice_mic",
                "get-default-sink": self.default_sink}[args[0]]

    def test_preflight_ignores_internal_remap_but_rejects_existing_capture(self):
        route = guest.VoiceRoute(guest.PULSE_SERVER)
        route.check_idle()
        self.devices["source-outputs"].append(recording())
        with self.assertRaisesRegex(guest.VoiceInputError, "voice_recording_busy"):
            route.check_idle()
        self.playback.assert_not_called()

    def test_routes_verified_wechat_stream_and_plays_pcm_once(self):
        route = guest.VoiceRoute(guest.PULSE_SERVER)
        self.devices["source-outputs"].append(recording(source=MONITOR))
        samples, rate, duration = guest.read_wav(BytesIO(wave_bytes(RATE * 3 // 2)))
        self.assertEqual(duration, 1.5)
        route.play(PID, samples, rate, duration)
        self.pactl.assert_any_call("move-source-output", "3", "deskpet_voice_mic")
        self.playback.assert_called_once()
        args, kwargs = self.playback.call_args
        self.assertIn("deskpet_voice", args[0])
        self.assertIn("--rate=24000", args[0])
        pad = bytes(2 * round(RATE * guest.PADDING_SECONDS))
        self.assertEqual(kwargs["input"], pad + samples + pad)

    def test_rejects_non_wechat_stream_before_playing(self):
        route = guest.VoiceRoute(guest.PULSE_SERVER)
        self.devices["source-outputs"].append(recording(pid=999))
        with self.assertRaisesRegex(guest.VoiceInputError, "voice_recording_ambiguous"):
            route.play(PID, bytes(20), RATE, 1)
        self.playback.assert_not_called()

    def test_rejects_mixed_audio_on_dedicated_sink(self):
        route = guest.VoiceRoute(guest.PULSE_SERVER)
        self.devices["sink-inputs"].append({"sink": SINK})
        with self.assertRaisesRegex(guest.VoiceInputError, "voice_audio_sink_busy"):
            route.check_idle()
        self.playback.assert_not_called()

    def test_rejects_feedback_or_missing_remap_link(self):
        self.default_sink = "deskpet_voice"
        with self.assertRaisesRegex(guest.VoiceInputError, "voice_audio_route_invalid"):
            guest.VoiceRoute(guest.PULSE_SERVER)
        self.default_sink = "deskpet_output"
        route = guest.VoiceRoute(guest.PULSE_SERVER)
        self.devices["source-outputs"].clear()
        with self.assertRaisesRegex(guest.VoiceInputError, "voice_audio_route_invalid"):
            route.check_idle()

    def test_rejects_silence_stereo_short_and_truncated_wav(self):
        for payload in (wave_bytes(RATE, amplitude=0), wave_bytes(RATE, channels=2),
                        wave_bytes(RATE - 1), wave_bytes(RATE)[:-2], b"garbage"):
            with self.subTest(size=len(payload)), self.assertRaises(guest.VoiceInputError):
                guest.read_wav(BytesIO(payload))


if __name__ == "__main__":
    unittest.main()
