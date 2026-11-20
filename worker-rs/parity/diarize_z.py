r"""diarize_z.py: row Z, thanham-diarize.exe against worker/diarize.py's own child process on the same audio and arguments.

usage: runtime\python\python.exe -I worker-rs\parity\diarize_z.py --exe <thanham-diarize.exe> --model <diarization model folder>
           --out <folder> [--limit N] <audio file or folder> ...

Each input is decoded by faster-whisper's decode_audio at 16 kHz (the worker's load_audio() on a file without invalid packets) and
saved once as audio.npy.
Both children then run on it, with the automatic count and with min = max = 2 (what stt sends for a known count of 2): the Python one
(`python -I worker\diarize.py audio.npy turns.json [model, num, min, max]`) and the native one, which loads sherpa-onnx from this
runtime's wheel. Their turns must be JSON-equal. results.jsonl gets one line per run; exits 1 on any difference or failure.
Start it pinned to one core type (O.10), e.g. `start /affinity FFF /wait ...`: the children inherit the affinity."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np

WORKER = Path(__file__).resolve().parents[2] / 'worker'
AUDIO = {'.wav', '.mp3', '.m4a', '.flac', '.ogg', '.mp4'}


def inputs(paths):
    for p in map(Path, paths):
        yield from (sorted(f for f in p.rglob('*') if f.suffix.lower() in AUDIO) if p.is_dir() else [p])


def run(cmd, env=None):
    start = time.perf_counter()
    done = subprocess.run(cmd, capture_output=True, env=env)
    return done, time.perf_counter() - start


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('inputs', nargs='+')
    args = ap.parse_args()
    from faster_whisper.audio import decode_audio
    import sherpa_onnx
    env = {**os.environ, 'THANHAM_SHERPA_LIB': str(Path(sherpa_onnx.__file__).parent / 'lib')}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = list(inputs(args.inputs))[:args.limit or None]
    failed = 0
    with open(out / 'results.jsonl', 'a', encoding='utf-8') as log:
        for n, f in enumerate(files):
            case = out / f'{n:04d}'
            case.mkdir(exist_ok=True)
            audio = case / 'audio.npy'
            np.save(audio, decode_audio(str(f), sampling_rate=16000))
            for counts in ([None, None, None], [None, 2, 2]):
                spec = json.dumps([str(Path(args.model)), *counts])
                tag = 'auto' if counts[1] is None else 'k2'
                py, py_s = run([sys.executable, '-I', str(WORKER / 'diarize.py'), str(audio), str(case / f'py-{tag}.json'), spec])
                rs, rs_s = run([args.exe, str(audio), str(case / f'rs-{tag}.json'), spec], env)
                row = {'file': str(f), 'case': case.name, 'counts': tag, 'py_s': round(py_s, 2), 'rs_s': round(rs_s, 2),
                       'py_exit': py.returncode, 'rs_exit': rs.returncode}
                if py.returncode or rs.returncode:
                    row['stderr'] = (py.stderr or rs.stderr).decode('utf-8', 'replace')[-300:]
                    row['equal'] = False
                else:
                    a = json.loads((case / f'py-{tag}.json').read_text(encoding='utf-8'))
                    b = json.loads((case / f'rs-{tag}.json').read_text(encoding='utf-8'))
                    row.update(equal=a == b, turns=len(a), speakers=len({t['speaker'] for t in a}))
                failed += not row['equal']
                log.write(json.dumps(row) + '\n')
                log.flush()
                print(json.dumps(row), flush=True)
    print(f'row Z: {2 * len(files) - failed}/{2 * len(files)} runs JSON-equal')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
