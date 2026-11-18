"""DeskPet listening worker: transcribe one WeChat voice message (SILK v3) with Qwen3-ASR.

Run once per message from the owner's voice folder, offline:
  stdin   the voice message bytes, as WeChat stores them
  argv    the ASR model id, then optional hint words (names she should recognise)
  stdout  one JSON object: {"text": "..."} or {"error": "<code>"}
"""

import io
import base64
import json
import os
import sys

MAX_BYTES = 512 * 1024
RATE = 16_000
MAX_SECONDS = 70

_out = os.fdopen(os.dup(1), 'w', encoding='utf-8')
os.dup2(2, 1)


def finish(message):
    _out.write(json.dumps(message, ensure_ascii=False) + '\n')
    _out.flush()


def main():
    if '--pcm' in sys.argv[2:]:
        return pcm_loop()
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        return finish({'error': 'voice_size_invalid'})
    # WeChat prefixes the standard SILK header with one byte.
    if data.startswith(b'\x02#!SILK_V3'):
        data = data[1:]
    if not data.startswith(b'#!SILK_V3'):
        return finish({'error': 'voice_format_invalid'})
    import numpy as np
    import pysilk

    pcm = io.BytesIO()
    try:
        pysilk.decode(io.BytesIO(data), pcm, RATE)
    except Exception:  # The decoder raises its own error types.
        return finish({'error': 'voice_decode_failed'})
    samples = np.frombuffer(pcm.getvalue(), dtype='<i2').astype(np.float32) / 32768
    if not RATE // 4 <= samples.size <= RATE * MAX_SECONDS:
        return finish({'error': 'voice_length_invalid'})
    from mlx_audio.stt.utils import load

    model = load(sys.argv[1])
    hotwords = [word for word in sys.argv[2:] if word.strip()]
    result = model.generate(samples, language='Chinese', **({'hotwords': hotwords} if hotwords else {}))
    finish({'text': result.text.strip()})


def pcm_loop():
    """Desktop mode: bounded 16 kHz mono int16 JSON frames, one model until stdin closes."""
    import numpy as np
    from mlx_audio.stt.utils import load
    model = load(sys.argv[1])
    finish({'ready': True})
    while True:
        line = sys.stdin.buffer.readline(2_560_256)
        if not line:
            return
        if len(line) >= 2_560_256 or not line.endswith(b'\n'):
            return finish({'error': 'voice_size_invalid'})
        request = {}
        try:
            request = json.loads(line)
            if (not isinstance(request, dict) or set(request) != {'id', 'pcm', 'rate'}
                    or not isinstance(request['id'], str) or len(request['id']) > 64
                    or request['rate'] != RATE or not isinstance(request['pcm'], str)):
                raise ValueError('invalid frame')
            data = base64.b64decode(request['pcm'], validate=True)
            if not 8_000 <= len(data) <= RATE * 60 * 2 or len(data) % 2:
                raise ValueError('invalid length')
            samples = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768
            result = model.generate(samples, language='Chinese')
            finish({'id': request['id'], 'text': result.text.strip()[:8000]})
        except Exception:
            finish({'id': request.get('id') if isinstance(request, dict) else None, 'error': 'voice_transcription_failed'})


if __name__ == '__main__':
    try:
        main()
    except Exception:  # Report a fixed code; never echo audio-derived detail.
        finish({'error': 'voice_transcription_failed'})
