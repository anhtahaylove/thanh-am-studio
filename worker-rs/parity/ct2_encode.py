"""The Python wheel's Whisper encoder output for spike S1's deterministic input, the reference of the Rust test
`ct2::tests::encode_matches_the_wheel` (feature `ct2`). Run with the private runtime's python.exe on the same machine.

usage: python -I ct2_encode.py <whisper model folder> <out .f32>"""
import hashlib
import json
import os
import sys

import ctranslate2
import numpy as np

model_dir, out = sys.argv[1], sys.argv[2]
threads = min(8, os.cpu_count() or 4)  # the worker's cpu_threads (main.py stt)
model = ctranslate2.models.Whisper(model_dir, device='cpu', compute_type='int8', intra_threads=threads)
i = np.arange(model.n_mels * 3000, dtype=np.uint64)
k = (((i * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)) >> np.uint64(12) & np.uint64(0xFFF)).astype(np.int32) - 2048
features = (k.astype(np.float64) / 1024.0).astype(np.float32).reshape(1, model.n_mels, 3000)
raw = np.array(model.encode(ctranslate2.StorageView.from_array(features), to_cpu=True), dtype=np.float32).tobytes()
with open(out, 'wb') as f:
    f.write(raw)
print(json.dumps({'ctranslate2': ctranslate2.__version__, 'threads': threads, 'floats': len(raw) // 4,
                  'sha256': hashlib.sha256(raw).hexdigest()}))
