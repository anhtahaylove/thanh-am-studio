"""S4 T1e helpers (run with the reference runtime, -I).
  t1e.py list <rec dir> <model> <out dir> <list.tsv> [first]   encode inputs of the T1e items (mode w) -> s4-encode list
                                                                (`first`: only the first encode of mix-0000, the SDE subset)
  t1e.py compare <list.tsv> <reference dir>                    byte-compare each output with the file of the same name under the
                                                                reference dir (default: the recorded Python outputs)
  t1e.py pyencode <model dir> <threads> <list.tsv>              the Python wheel's encode on the same list (SDE reference)"""
import ctypes
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

T1E = [f'mix-{i:04d}' for i in range(5)] + [f'viyt-{i:03d}' for i in range(5)]


def items(rec, model):
    for corpus in ('vivos-mix', 'viyt'):
        f = Path(rec) / corpus / model / 'w' / 'events.jsonl'
        for line in f.read_text(encoding='utf-8').splitlines() if f.exists() else []:
            r = json.loads(line)
            if r['id'] in T1E:
                yield corpus, r


def cmd_list(rec, model, out_dir, list_file, first=None):
    rows = []
    for corpus, r in items(rec, model):
        if first and r['id'] != 'mix-0000':
            continue
        for e in r['events']:
            if e['k'] == 'encode':
                feat = Path(rec) / corpus / model / 'w' / 'feat' / f'{r["id"]}.f32'
                out = Path(out_dir) / r['id'] / f'{e["n"]}.f32'
                out.parent.mkdir(parents=True, exist_ok=True)
                rows.append((str(feat), str(e['off']), str(out), corpus, e['out_sha']))
                if first:
                    break
    Path(list_file).write_text(''.join('\t'.join(r[:3]) + '\n' for r in rows), encoding='utf-8')
    Path(list_file + '.meta').write_text(''.join('\t'.join(r) + '\n' for r in rows), encoding='utf-8')
    print(f'{len(rows)} encode calls from {len({Path(r[2]).parent.name for r in rows})} items')


def cmd_compare(list_file, ref_dir=None):
    total = equal = 0
    worst = 0.0
    for row in Path(list_file + '.meta').read_text(encoding='utf-8').splitlines():
        feat, off, out, corpus, out_sha = row.split('\t')
        out = Path(out)
        item, n = out.parent.name, out.stem
        if ref_dir:
            ref = Path(ref_dir) / item / f'{n}.f32'
        else:  # the recorded Python output next to the features: rec/<corpus>/<model>/w/enc/<item>/<n>.f32
            ref = Path(feat).parent.parent / 'enc' / item / f'{n}.f32'
        a, b = np.fromfile(out, dtype=np.float32), np.fromfile(ref, dtype=np.float32)
        total += 1
        same = a.shape == b.shape and a.tobytes() == b.tobytes()
        equal += same
        diff = float(np.max(np.abs(a.astype(np.float64) - b.astype(np.float64)))) if a.shape == b.shape else float('inf')
        worst = max(worst, diff)
        ulp = int(np.max(np.abs(a.view(np.int32).astype(np.int64) - b.view(np.int32).astype(np.int64)))) if a.shape == b.shape else -1
        print(json.dumps({'item': item, 'n': int(n), 'bitwise': same, 'max_abs': diff, 'max_ulp': ulp, 'n_diff': int(np.sum(a != b)) if a.shape == b.shape else None,
                          'sha_rust': hashlib.sha256(a.tobytes()).hexdigest()[:16], 'sha_ref': hashlib.sha256(b.tobytes()).hexdigest()[:16],
                          'recorded_sha_matches_ref': (out_sha == hashlib.sha256(b.tobytes()).hexdigest()) if not ref_dir else None}))
    print(json.dumps({'summary': list_file, 'calls': total, 'bitwise_equal': equal, 'max_abs': worst}))


def no_ecoqos_and_mask():
    """Opts this process out of power throttling (EcoQoS, F-S4-3); returns its affinity mask at model load (F-S4-1, pinned by the caller)."""
    k32 = ctypes.windll.kernel32
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    h = ctypes.c_void_p(k32.GetCurrentProcess())
    k32.SetProcessInformation(h, 4, (ctypes.c_ulong * 3)(1, 1, 0), 12)  # ProcessPowerThrottling: EXECUTION_SPEED never throttled
    mask, system = ctypes.c_size_t(), ctypes.c_size_t()
    k32.GetProcessAffinityMask(h, ctypes.byref(mask), ctypes.byref(system))
    return f'{mask.value:04X}'


def cmd_pyencode(model_dir, threads, list_file):
    import ctranslate2
    load_mask = no_ecoqos_and_mask()
    m = ctranslate2.models.Whisper(model_dir, device='cpu', compute_type='int8', intra_threads=int(threads))
    print(json.dumps({'ct2': ctranslate2.__version__, 'n_mels': m.n_mels, 'threads': int(threads), 'load_affinity': load_mask}), flush=True)
    for row in Path(list_file).read_text(encoding='utf-8').splitlines():
        feat, off, out = row.split('\t')
        x = np.fromfile(feat, dtype=np.float32, count=m.n_mels * 3000, offset=int(off)).reshape(1, m.n_mels, 3000)
        y = np.array(m.encode(ctranslate2.StorageView.from_array(np.ascontiguousarray(x)), to_cpu=False), dtype=np.float32, copy=True)
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(y.tobytes())
        print(json.dumps({'out': out, 'elements': int(y.size), 'sha256': hashlib.sha256(y.tobytes()).hexdigest()}), flush=True)


if __name__ == '__main__':
    {'list': cmd_list, 'compare': cmd_compare, 'pyencode': cmd_pyencode}[sys.argv[1]](*sys.argv[2:])
