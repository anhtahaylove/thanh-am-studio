"""Reference encode on the Python CTranslate2 wheel (same features as thanham-worker `health`): int8, intra_threads = argv[3].
usage: python -I py_encode.py <whisper model dir> <out raw f32 file> [threads]  -> one JSON line on stdout"""
import hashlib, json, sys, time
import numpy as np
import ctranslate2

model_dir, out = sys.argv[1], sys.argv[2]
threads = int(sys.argv[3]) if len(sys.argv) > 3 else 8
m = ctranslate2.models.Whisper(model_dir, device="cpu", compute_type="int8", intra_threads=threads)
n_mels = m.n_mels
i = np.arange(n_mels * 3000, dtype=np.uint64)
h = (i * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)
k = ((h >> np.uint64(12)) & np.uint64(0xFFF)).astype(np.int32) - 2048
feats = (k.astype(np.float64) / 1024.0).astype(np.float32).reshape(1, n_mels, 3000)
t = time.time()
enc = m.encode(ctranslate2.StorageView.from_array(feats), to_cpu=True)
ms = int((time.time() - t) * 1000)
arr = np.array(enc, dtype=np.float32, copy=True)
raw = arr.tobytes()
open(out, "wb").write(raw)
print(json.dumps({"ct2": ctranslate2.__version__, "n_mels": n_mels, "threads": threads, "encode_ms": ms,
                  "encoder_elements": int(arr.size), "encoder_sha256": hashlib.sha256(raw).hexdigest(),
                  "first": [float(x) for x in arr.reshape(-1)[:4]]}))
