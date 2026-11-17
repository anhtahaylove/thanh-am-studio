"""Deviation between two raw float32 encoder dumps: python -I compare_enc.py a.bin b.bin -> one JSON line."""
import hashlib, json, sys
import numpy as np
a = np.fromfile(sys.argv[1], dtype=np.float32)
b = np.fromfile(sys.argv[2], dtype=np.float32)
if a.shape != b.shape:
    print(json.dumps({"same_shape": False, "a": a.size, "b": b.size})); sys.exit(1)
d = np.abs(a.astype(np.float64) - b.astype(np.float64))
ulp = np.abs(a.view(np.int32).astype(np.int64) - b.view(np.int32).astype(np.int64))
print(json.dumps({"same_shape": True, "n": int(a.size), "bitwise_equal": bool(np.array_equal(a.view(np.uint32), b.view(np.uint32))),
                  "differing": int((a.view(np.uint32) != b.view(np.uint32)).sum()), "max_abs": float(d.max()), "max_ulp": int(ulp.max()),
                  "sha_a": hashlib.sha256(a.tobytes()).hexdigest()[:16], "sha_b": hashlib.sha256(b.tobytes()).hexdigest()[:16]}))
