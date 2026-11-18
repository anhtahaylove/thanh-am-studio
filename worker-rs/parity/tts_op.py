r"""tts_op.py: rows P-op, P3, P4, P5 and K-cond. The seeded Python worker and the seeded Rust worker run the same `tts` request on this
machine, and everything must be identical: exit code, every event (paths compared by file name), the bytes of every WAV and raw WAV,
the files left in the output folder, per engine call the phonemes, token ids (P1), audio-head logits (P3), codes (P4) and decoded
PCM (P5), and for cloned voices every step of reference enrollment (K-cond, THANHAM_CLONE_TRACE).

usage: python -I tts_op.py --python <runtime python.exe> --exe <staged thanham-worker.exe> --model <vieneu-v3 folder>
                           --ffmpeg <ffmpeg.exe> --items <items.json> --out <dir> [--seed 20261121] [--rounds 1] [--no-trace]
                           [--refs <folder> [--previews]]

An item with "reference": "<file>" is a cloned voice: its reference_path is <folder>/<file> (clone_refs.py makes the folder). With
--previews, each round also runs `clone_preview` in both workers on every reference listed in <folder>/refs.json and compares the
events, the preview's bytes and the enrollment steps.

Both workers get THANHAM_TTS_SEED (the N12 hook) and run at BelowNormal priority, opted out of Windows power throttling (EcoQoS, which
otherwise parks BelowNormal processes on the E-cores of a hybrid CPU); they inherit this script's affinity, so pin it to one core type
(`start /affinity FFF`). With --rounds N the pair runs N times, interleaved (Python first), and each process's wall time, peak working
set and CPU time, the machine's available memory and CPU % just before and after it, and the cores other processes used meanwhile go to
<out>/ram.csv; every round is compared. --no-trace (for the RTF and RAM accept) runs worker/main.py as the desktop does and the Rust
worker without THANHAM_TTS_TRACE, so the per-call rows are skipped and only events and files are compared. Exits 1 on a difference.
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


class MemoryStatus(ctypes.Structure):
    _fields_ = [('dwLength', ctypes.wintypes.DWORD), ('dwMemoryLoad', ctypes.wintypes.DWORD)] + [
        (n, ctypes.c_ulonglong) for n in ('TotalPhys', 'AvailPhys', 'TotalPageFile', 'AvailPageFile', 'TotalVirtual', 'AvailVirtual',
                                          'AvailExtendedVirtual')]


def available_mb():
    m = MemoryStatus(dwLength=ctypes.sizeof(MemoryStatus))
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.AvailPhys / 2**20


def busy_seconds():
    """CPU seconds all processors have spent outside the idle process (kernel time includes idle time)."""
    idle, kernel, user = ctypes.c_ulonglong(), ctypes.c_ulonglong(), ctypes.c_ulonglong()
    ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
    return (kernel.value + user.value - idle.value) / 1e7


def cpu_percent():
    """Machine CPU % over the next second."""
    b0, t0 = busy_seconds(), time.perf_counter()
    time.sleep(1)
    return (busy_seconds() - b0) / (time.perf_counter() - t0) / os.cpu_count() * 100


def run(argv, request, env, out_dir):
    """One worker process: (exit code, event lines, wall seconds, peak working set MB, machine load)."""
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    load = {'avail_mb_start': available_mb(), 'cpu_pct_start': cpu_percent()}
    b0, t0 = busy_seconds(), time.perf_counter()
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(out_dir.with_suffix('.log'), 'wb'),
                         env=env, creationflags=BELOW_NORMAL | subprocess.CREATE_NO_WINDOW)
    handle = ctypes.wintypes.HANDLE(int(p._handle))
    # ProcessPowerThrottling (4): {Version 1, ControlMask EXECUTION_SPEED, StateMask 0} = never throttle; set before the model loads
    assert ctypes.windll.kernel32.SetProcessInformation(handle, 4, (ctypes.c_uint32 * 3)(1, 1, 0), 12), 'EcoQoS opt-out failed'
    stdout, _ = p.communicate((json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'))
    wall, busy = time.perf_counter() - t0, busy_seconds() - b0
    c = Counters(cb=ctypes.sizeof(Counters))
    ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(c), c.cb)
    times = [ctypes.c_ulonglong() for _ in range(4)]
    ctypes.windll.kernel32.GetProcessTimes(handle, *map(ctypes.byref, times))
    load['worker_cpu_s'] = (times[2].value + times[3].value) / 1e7
    load['others_cores'] = (busy - load['worker_cpu_s']) / wall
    load.update(avail_mb_end=available_mb(), cpu_pct_end=cpu_percent())
    return p.returncode, [ln for ln in stdout.decode('utf-8').split('\n') if ln.strip()], wall, c.PeakWorkingSetSize / 2**20, load


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


def clone_steps(py_path, rs_path, counts, diffs, label):
    """Row K-cond: the enrollment steps of both workers, line by line (a 'decode' line starts each reference)."""
    load = lambda p: [json.loads(ln) for ln in Path(p).read_text(encoding='utf-8').split('\n') if ln.strip()] if Path(p).is_file() else []
    pl, rl = load(py_path), load(rs_path)
    if [x['step'] for x in pl] != [x['step'] for x in rl]:
        diffs.append(f'{label}: enrollment steps differ: python {[x["step"] for x in pl][:40]}, rust {[x["step"] for x in rl][:40]}')
    refs, bad = 0, set()
    for a, b in zip(pl, rl):
        refs += a['step'] == 'decode'
        c = counts.setdefault('soxr' if a['step'].startswith('soxr_') else a['step'], [0, 0])
        c[1] += 1
        if a == b:
            c[0] += 1
        else:
            diffs.append(f'{label}: {a["step"]} differs: python {a["value"]}, rust {b["value"]}')
            bad.add(refs)
    if len(pl) != len(rl):
        bad.add(refs)
    return refs, refs - len(bad - {0})


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
    steps = {}
    refs, same = clone_steps(Path(str(py_trace).replace('.trace.', '.clone.')), Path(str(rs_trace).replace('.trace.', '.clone.')), steps, diffs, 'tts')
    if refs:
        rows['K-cond'] = {'references': refs, 'identical': same, 'steps': {k: f'{a}/{b}' for k, (a, b) in steps.items()}}
    return diffs, rows


def previews(args, refs, out, r, env):
    """clone_preview in both workers on every reference of <refs>/refs.json: (differences, rows)."""
    diffs, steps, rows = [], {}, {'references': 0, 'identical': 0, 'results': 0}
    for name in json.loads((refs / 'refs.json').read_text(encoding='utf-8')):
        stem = name.replace('.', '_')  # r1.wav and r1.flac are two references
        runs = {}
        for engine in ('python', 'rust'):
            folder = out / f'preview-{engine}{r}' / stem
            ctrace = out / f'preview-{engine}{r}' / f'{stem}.clone.jsonl'
            folder.parent.mkdir(parents=True, exist_ok=True)
            ctrace.unlink(missing_ok=True)
            request = {'protocol': 1, 'id': f'preview-{r}-{stem}', 'operation': 'clone_preview', 'output_dir': str(folder),
                       'payload': {'model_path': str(Path(args.model).resolve()), 'reference_path': str(refs / name), 'output_name': f'{stem}.wav'}}
            e = {**env, 'THANHAM_CLONE_TRACE': str(ctrace)}
            argv = [args.python, '-I', '-X', 'utf8', str(HERE / 'tts_trace.py'), str(out / 'preview-unused.jsonl')] if engine == 'python' else [args.exe]
            runs[engine] = run(argv, request, e, folder)
        (pc, pl, *_), (rc, rl, *_) = runs['python'], runs['rust']
        pd, rd = out / f'preview-python{r}' / stem, out / f'preview-rust{r}' / stem
        before = len(diffs)
        if pc != rc:
            diffs.append(f'preview {name}: exit code: python {pc}, rust {rc}')
        if events(pl, pd) != events(rl, rd):
            diffs.append(f'preview {name}: events: python {pl}, rust {rl}')
        fp, fr = sorted(p.name for p in pd.iterdir()), sorted(p.name for p in rd.iterdir())
        if fp != fr:
            diffs.append(f'preview {name}: files: python {fp}, rust {fr}')
        diffs += [f'preview {name}: bytes differ: {n}' for n in fp if n in fr and sha(pd / n) != sha(rd / n)]
        clone_steps(out / f'preview-python{r}' / f'{stem}.clone.jsonl', ctrace, steps, diffs, f'preview {name}')
        rows['references'] += 1
        rows['results'] += any(json.loads(ln).get('event') == 'result' for ln in pl)
        rows['identical'] += len(diffs) == before
        print(f'preview {name}: {"identical" if len(diffs) == before else "DIFFERS"}', flush=True)
    rows['steps'] = {k: f'{a}/{b}' for k, (a, b) in steps.items()}
    return diffs, rows


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    for a in ('--python', '--exe', '--model', '--ffmpeg', '--items', '--out'):
        ap.add_argument(a, required=True)
    ap.add_argument('--seed', default='20261121')
    ap.add_argument('--rounds', type=int, default=1)
    ap.add_argument('--no-trace', action='store_true')
    ap.add_argument('--refs')
    ap.add_argument('--previews', action='store_true')
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    refs = Path(args.refs).resolve() if args.refs else None
    items = json.loads(Path(args.items).read_text(encoding='utf-8'))
    payload_items = [{'output_name': f"{i['id']}.wav", **{k: v for k, v in i.items() if k not in ('id', 'reference')},
                      **({'reference_path': str(refs / i['reference'])} if 'reference' in i else {})} for i in items]
    audio_s = 0.0
    env = {**os.environ, 'THANHAM_TTS_SEED': args.seed, 'THANHAM_FFMPEG': str(Path(args.ffmpeg).resolve()),
           'THANHAM_PYTHON': str(Path(args.python).resolve()), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
    failed = False
    with open(out / 'ram.csv', 'a', encoding='utf-8', newline='\n') as ram:
        if ram.tell() == 0:
            ram.write('round,engine,exit,wall_s,peak_ws_mb,audio_s,worker_cpu_s,others_cores,avail_mb_start,cpu_pct_start,avail_mb_end,'
                      'cpu_pct_end\n')
        for r in range(1, args.rounds + 1):
            runs = {}
            for engine in ('python', 'rust'):
                folder = out / f'{engine}{r}'
                trace = out / f'{engine}{r}.trace.jsonl'
                ctrace = out / f'{engine}{r}.clone.jsonl'
                trace.unlink(missing_ok=True)
                ctrace.unlink(missing_ok=True)
                request = {'protocol': 1, 'id': f'pop-{r}', 'operation': 'tts', 'output_dir': str(folder),
                           'payload': {'model_path': str(Path(args.model).resolve()), 'items': payload_items}}
                cenv = {'THANHAM_CLONE_TRACE': str(ctrace)} if refs and not args.no_trace else {}
                if engine == 'python':  # the desktop's command line, or the tracing wrapper around the same main()
                    script = [str(HERE.parents[1] / 'worker' / 'main.py')] if args.no_trace else [str(HERE / 'tts_trace.py'), str(trace)]
                    argv, e = [args.python, '-I', '-X', 'utf8', *script], {**env, **cenv}
                else:
                    argv, e = [args.exe], env if args.no_trace else {**env, 'THANHAM_TTS_TRACE': str(trace), **cenv}
                runs[engine] = run(argv, request, e, folder)
                code, lines, wall, peak, load = runs[engine]
                if engine == 'python':
                    audio_s = sum(e['result']['duration_ms'] for e in map(json.loads, lines) if e.get('event') == 'item' and 'result' in e) / 1000
                ram.write(f'{r},{engine},{code},{wall:.1f},{peak:.0f},{audio_s:.1f},{load["worker_cpu_s"]:.1f},{load["others_cores"]:.2f},'
                          f'{load["avail_mb_start"]:.0f},{load["cpu_pct_start"]:.0f},{load["avail_mb_end"]:.0f},{load["cpu_pct_end"]:.0f}\n')
                ram.flush()
                print(f'round {r} {engine}: exit {code}, {wall:.1f} s, peak working set {peak:.0f} MB, load {json.dumps(load)}', flush=True)
            diffs, rows = compare(runs['python'], runs['rust'], out / f'python{r}', out / f'rust{r}', out / f'python{r}.trace.jsonl', out / f'rust{r}.trace.jsonl')
            rows['audio_s'] = round(audio_s, 1)
            rows['rtf'] = {e: round(runs[e][2] / audio_s, 3) if audio_s else None for e in runs}
            if args.previews:
                more, rows['clone_preview'] = previews(args, refs, out, r, env)
                diffs += more
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
