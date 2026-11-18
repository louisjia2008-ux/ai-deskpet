"""DeskPet speech worker: clones the owner's reference voice with Qwen3-TTS and streams PCM.

Started by the app with the owner's chosen runtime folder as the working directory:
  .venv/  Python with mlx-audio   hf/  model cache (offline)   voice/reference.wav + reference.txt

stdin, one JSON object per line:  {"id": "...", "text": "..."}  or  {"cancel": "..."}
stdout, one JSON object per line: {"ready": true}, {"id", "pcm", "rate"}, {"id", "done": true}, {"id", "error"}
"""

import base64
import json
import os
import queue
import sys
import threading

MODEL = sys.argv[1]
# Libraries may print; only this handle carries the protocol.
_out = os.fdopen(os.dup(1), 'w', buffering=1, encoding='utf-8')
os.dup2(2, 1)


def send(message):
    _out.write(json.dumps(message, ensure_ascii=False) + '\n')
    _out.flush()


jobs = queue.Queue()
cancelled = set()


def read_requests():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message.get('cancel'), str):
            cancelled.add(message['cancel'])
        elif isinstance(message.get('id'), str) and isinstance(message.get('text'), str):
            jobs.put(message)
    jobs.put(None)


def main():
    import mlx.core as mx
    import numpy as np
    from mlx_audio.audio_io import read
    from mlx_audio.tts.utils import load_model

    model = load_model(MODEL)
    reference, rate = read(os.path.join('voice', 'reference.wav'))
    reference = np.asarray(reference, dtype=np.float32)
    if reference.ndim > 1:
        reference = reference.mean(axis=1)
    if rate != model.sample_rate:
        raise SystemExit('reference.wav must be %d Hz' % model.sample_rate)
    with open(os.path.join('voice', 'reference.txt'), encoding='utf-8') as handle:
        reference_text = handle.read().strip()
    reference = mx.array(reference)

    threading.Thread(target=read_requests, daemon=True).start()
    send({'ready': True})
    while True:
        job = jobs.get()
        if job is None:
            return
        ident = job['id']
        try:
            for result in model.generate(text=job['text'], ref_audio=reference, ref_text=reference_text, lang_code='auto',
                                         stream=True, streaming_interval=0.32):
                if ident in cancelled:
                    break
                pcm = (np.clip(np.array(result.audio), -1, 1) * 32767).astype('<i2').tobytes()
                send({'id': ident, 'pcm': base64.b64encode(pcm).decode('ascii'), 'rate': result.sample_rate})
            send({'id': ident, 'done': True})
        except Exception as error:  # One bad line must not end the worker.
            send({'id': ident, 'error': type(error).__name__})
        cancelled.discard(ident)


if __name__ == '__main__':
    main()
