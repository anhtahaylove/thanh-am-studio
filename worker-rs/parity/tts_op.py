r"""tts_op.py: rows P-op, P3, P4 and P5. The seeded Python worker and the seeded Rust worker run the same preset `tts` request on this
machine, and everything must be identical: exit code, every event (paths compared by file name), the bytes of every WAV and raw WAV,
the files left in the output folder, and per engine call the phonemes, token ids (P1), audio-head logits (P3), codes (P4) and decoded
PCM (P5).

usage: python -I tts_op.py --python <runtime python.exe> --exe <staged thanham-worker.exe> --model <vieneu-v3 folder>
                           --ffmpeg <ffmpeg.exe> --items <items.json> --out <dir> [--seed 20261121] [--rounds 1]

Both workers get THANHAM_TTS_SEED (the N12 hook) and run at BelowNormal priority. With --rounds N the pair runs N times, interleaved
(Python first), and each process's wall time and peak working set go to <out>/ram.csv; every round is compared. Exits 1 on a difference.
"""
import argparse
import ctypes
import ctypes.wintypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BELOW_NORMAL = 0x4000


class Counters(ctypes.Structure):
    _fields_ = [('cb', ctypes.wintypes.DWORD), ('PageFaultCount', ctypes.wintypes.DWORD)] + [
        (n, ctypes.c_size_t) for n in ('PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage',
                                       'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]


def run(argv, request, env, out_dir):
    """One worker process: (exit code, event lines, wall seconds, peak working set MB)."""
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    t0 = time.perf_counter()
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(out_dir.with_suffix('.log'), 'wb'),
                         env=env, creationflags=BELOW_NORMAL | subprocess.CREATE_NO_WINDOW)
    stdout, _ = p.communicate((json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'))
    wall = time.perf_counter() - t0
    c = Counters(cb=ctypes.sizeof(Counters))
    ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.wintypes.HANDLE(int(p._handle)), ctypes.byref(c), c.cb)
    return p.returncode, [ln for ln in stdout.decode('utf-8').split('\n') if ln.strip()], wall, c.PeakWorkingSetSize / 2**20


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def events(lines, out_dir):
    """Parsed events with result paths reduced to file names (each worker writes in its own folder)."""
    parsed = []
    for line in lines:
        e = json.loads(line)
        for key in ('path', 'raw_path'):
            r = e.get('result')
            if isinstance(r, dict) and isinstance(r.get(key), str):
                if Path(r[key]).parent == out_dir:
                    r[key] = Path(r[key]).name
        parsed.append(e)
    return parsed


def traces(path):
    out = {}
    if not Path(path).is_file():  # the worker died before its first engine call
        return out
    for line in filter(str.strip, Path(path).read_text(encoding='utf-8').split('\n')):  # JSON lines may hold U+2028
        rec = json.loads(line)
        out[(rec['item'], rec['call'])] = rec
    return out


def compare(py, rs, py_dir, rs_dir, py_trace, rs_trace):
    """Differences between the two runs, as readable lines, and the per-row counts."""
    diffs, rows = [], {}
    if py[0] != rs[0]:
        diffs.append(f'exit code: python {py[0]}, rust {rs[0]}')
    pe, re_ = events(py[1], py_dir), events(rs[1], rs_dir)
    for i in range(max(len(pe), len(re_))):
        a, b = (pe[i] if i < len(pe) else None), (re_[i] if i < len(re_) else None)
        if a != b:
            diffs.append(f'event {i}: python {json.dumps(a, ensure_ascii=False)}\n          rust   {json.dumps(b, ensure_ascii=False)}')
    files_py = sorted(p.name for p in py_dir.iterdir())
    files_rs = sorted(p.name for p in rs_dir.iterdir())
    if files_py != files_rs:
        diffs.append(f'files: python {files_py}, rust {files_rs}')
    wavs = [n for n in files_py if n in files_rs]
    same_wavs = [n for n in wavs if sha(py_dir / n) == sha(rs_dir / n)]
    diffs += [f'bytes differ: {n}' for n in wavs if n not in same_wavs]
    items = [e for e in pe if e.get('event') == 'item']
    rows['P-op'] = {'items': len(items), 'results': sum('result' in e for e in items), 'errors': sum('error' in e for e in items),
                    'files': len(wavs), 'files_identical': len(same_wavs), 'events': len(pe), 'events_identical': len(pe) == len(re_) and pe == re_}
    pt, rt = traces(py_trace), traces(rs_trace)
    if set(pt) != set(rt):
        diffs.append(f'engine calls: only python {sorted(set(pt) - set(rt))[:5]}, only rust {sorted(set(rt) - set(pt))[:5]}')
    stages = {'P1': ('phonemes', 'ids'), 'P3': ('logits',), 'P4': ('gens',), 'P5': ('pcm',)}
    counts = {row: 0 for row in stages}
    common = sorted(set(pt) & set(rt))
    for key in common:
        for row, fields in stages.items():
            if all(pt[key][f] == rt[key][f] for f in fields):
                counts[row] += 1
            else:
                diffs.append(f'{row} differs at item {key[0]} call {key[1]}: ' + ', '.join(f for f in fields if pt[key][f] != rt[key][f]))
    gens = sum(len(pt[k]['gens']) for k in common)
    frames = sum(len(g) for k in common for g in pt[k]['gens'])
    rows['engine'] = {'calls': len(common), 'generations': gens, 'frames': frames, **{f'{row}_identical_calls': n for row, n in counts.items()}}
    return diffs, rows


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    for a in ('--python', '--exe', '--model', '--ffmpeg', '--items', '--out'):
        ap.add_argument(a, required=True)
    ap.add_argument('--seed', default='20261121')
    ap.add_argument('--rounds', type=int, default=1)
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    items = json.loads(Path(args.items).read_text(encoding='utf-8'))
    payload_items = [{'output_name': f"{i['id']}.wav", **{k: v for k, v in i.items() if k != 'id'}} for i in items]
    audio_s = 0.0
    env = {**os.environ, 'THANHAM_TTS_SEED': args.seed, 'THANHAM_FFMPEG': str(Path(args.ffmpeg).resolve()),
           'THANHAM_PYTHON': str(Path(args.python).resolve()), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
    failed = False
    with open(out / 'ram.csv', 'a', encoding='utf-8', newline='\n') as ram:
        if ram.tell() == 0:
            ram.write('round,engine,exit,wall_s,peak_ws_mb,audio_s\n')
        for r in range(1, args.rounds + 1):
            runs = {}
            for engine in ('python', 'rust'):
                folder = out / f'{engine}{r}'
                trace = out / f'{engine}{r}.trace.jsonl'
                trace.unlink(missing_ok=True)
                request = {'protocol': 1, 'id': f'pop-{r}', 'operation': 'tts', 'output_dir': str(folder),
                           'payload': {'model_path': str(Path(args.model).resolve()), 'items': payload_items}}
                if engine == 'python':
                    argv, e = [args.python, '-I', '-X', 'utf8', str(HERE / 'tts_trace.py'), str(trace)], env
                else:
                    argv, e = [args.exe], {**env, 'THANHAM_TTS_TRACE': str(trace)}
                runs[engine] = run(argv, request, e, folder)
                code, lines, wall, peak = runs[engine]
                if engine == 'python':
                    audio_s = sum(e['result']['duration_ms'] for e in map(json.loads, lines) if e.get('event') == 'item' and 'result' in e) / 1000
                ram.write(f'{r},{engine},{code},{wall:.1f},{peak:.0f},{audio_s:.1f}\n')
                ram.flush()
                print(f'round {r} {engine}: exit {code}, {wall:.1f} s, peak working set {peak:.0f} MB', flush=True)
            diffs, rows = compare(runs['python'], runs['rust'], out / f'python{r}', out / f'rust{r}', out / f'python{r}.trace.jsonl', out / f'rust{r}.trace.jsonl')
            rows['audio_s'] = round(audio_s, 1)
            rows['rtf'] = {e: round(runs[e][2] / audio_s, 3) if audio_s else None for e in runs}
            print(json.dumps(rows, ensure_ascii=False, indent=1))
            for d in diffs[:40]:
                print('DIFF', d)
            if diffs:
                print(f'round {r}: {len(diffs)} differences')
                failed = True
            (out / f'summary{r}.json').write_text(json.dumps({'rows': rows, 'differences': diffs}, ensure_ascii=False, indent=1), encoding='utf-8')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
