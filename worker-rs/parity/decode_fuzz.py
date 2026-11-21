r"""decode_fuzz.py: the STT decode on seeded damaged files, made here from synthetic sound. Each file is decoded in a child process
of its own (a crash is counted) by faster-whisper's decode_audio, which main's worker ran, and by the worker's load_audio. It prints
how many files load_audio decodes worse (an error where decode_audio gave audio, or fewer samples) and how many crash, and writes
load_audio's results as row D cases, so stt::decode::tests::decode_matches_pyav compares the Rust decode on the same files.

--damages 1: 6 formats x 5 kinds of damage (400 or 4096 bytes of 0xff, 400 or 4096 random bytes, 4096 zero bytes) x 8 positions.
--damages 2: 6 formats x 16 seeds, each with one damaged region in the first half of the file and one in the second.

usage: python -I decode_fuzz.py --ffmpeg <ffmpeg.exe> --dir <work dir> --out <cases.jsonl> [--damages 1|2]
then:  THANHAM_DECODE_CASES=<cases.jsonl> THANHAM_PYTHON=<python.exe> cargo test --release stt::decode
"""
import argparse
import hashlib
import json
import random
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2] / 'worker'
SIGNAL = ("aevalsrc=exprs='0.45*sin(2*PI*(180+120*sin(2*PI*0.4*t))*t)|0.35*sin(2*PI*(420+200*sin(2*PI*0.25*t))*t)'"
          ':s=44100:d=12')
FORMATS = {'mp3': ['-c:a', 'libmp3lame', '-b:a', '128k'], 'm4a': ['-c:a', 'aac', '-b:a', '128k'], 'aac': ['-c:a', 'aac', '-b:a', '128k'],
           'opus': ['-c:a', 'libopus', '-b:a', '96k'], 'flac': ['-c:a', 'flac'], 'mp4': ['-c:a', 'aac', '-b:a', '128k']}
VIDEO = ['-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=12', '-map', '1:v', '-map', '0:a', '-c:v', 'mpeg4']
BITEXACT = ['-fflags', '+bitexact', '-flags', '+bitexact']  # the same bytes on every run (Ogg serial numbers, MP4 header)


def child(path, which):
    """One decode, printed as a row D result."""
    import numpy as np
    sys.path.insert(0, str(WORKER))
    from main import WorkerError, load_audio
    if which == 'decode_audio':
        from faster_whisper.audio import decode_audio
        decode = lambda: decode_audio(path, sampling_rate=16000)  # noqa: E731
    else:
        decode = lambda: load_audio(path)  # noqa: E731
    try:
        i16 = np.round(decode() * 32768).astype('<i2')
        result = {'n': int(len(i16)), 'sha256': hashlib.sha256(i16.tobytes()).hexdigest()}
    except WorkerError as e:
        result = {'code': e.code, 'error': str(e)}
    except Exception as e:  # the worker reports these as WORKER_ERROR "Type: text"
        result = {'code': 'WORKER_ERROR', 'error': f'{type(e).__name__}: {e}'}
    print(json.dumps(result))


def damaged(data, ext, damages):
    if damages == 1:
        for kind in ('ff400', 'ff4096', 'rnd400', 'rnd4096', 'zero4096'):
            for seed in range(8):
                rng = random.Random(f'{ext}-{kind}-{seed}')
                size = 4096 if kind.endswith('4096') else 400
                at = rng.randrange(len(data) // 10, len(data) * 9 // 10)
                junk = b'\xff' * size if kind.startswith('ff') else bytes(size) if kind.startswith('zero') else rng.randbytes(size)
                yield f'{ext}-{kind}-{seed}.{ext}', data[:at] + junk + data[at + size:]
    else:
        for seed in range(16):
            rng = random.Random(f'{ext}-{seed}')
            a = rng.randrange(len(data) // 10, len(data) * 4 // 10)
            b = rng.randrange(len(data) * 5 // 10, len(data) * 9 // 10)
            ja = rng.choice([bytes(range(256)) * 2, b'\xff' * 400, rng.randbytes(400)])
            jb = rng.choice([bytes(range(256)) * 16, rng.randbytes(4096), rng.randbytes(1024), b'\xff' * 4096])
            yield f'{ext}-2x-{seed}.{ext}', data[:a] + ja + data[a + len(ja):b] + jb + data[b + len(jb):]


def main():
    if sys.argv[1:2] == ['--child']:
        return child(sys.argv[2], sys.argv[3])
    ap = argparse.ArgumentParser()
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--damages', type=int, choices=(1, 2), default=1)
    a = ap.parse_args()
    work = Path(a.dir).resolve()
    work.mkdir(parents=True, exist_ok=True)
    files = []
    for ext, codec in FORMATS.items():
        source = work / f'source.{ext}'
        subprocess.run([a.ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', SIGNAL,
                        *(VIDEO if ext == 'mp4' else []), *codec, *BITEXACT, str(source)], check=True)
        for name, data in damaged(source.read_bytes(), ext, a.damages):
            (work / name).write_bytes(data)
            files.append(work / name)

    def run(path):
        got = {}
        for which in ('decode_audio', 'load_audio'):
            r = subprocess.run([sys.executable, '-I', __file__, '--child', str(path), which], capture_output=True, text=True,
                               encoding='utf-8')
            got[which] = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else {'crash': r.returncode}
        return path, got

    counts = dict.fromkeys(('worse', 'crash decode_audio', 'crash load_audio', 'identical', 'longer', 'error to audio'), 0)
    with ThreadPoolExecutor(8) as pool, open(a.out, 'w', encoding='utf-8') as out:
        for path, got in pool.map(run, files):
            old, new = got['decode_audio'], got['load_audio']
            counts['crash decode_audio'] += 'crash' in old
            counts['crash load_audio'] += 'crash' in new
            if old.get('n') and ('n' not in new or new['n'] < old['n']):  # no audio from decode_audio is no transcript either
                counts['worse'] += 1
                print('worse:', path.name, old, new, flush=True)
            counts['identical'] += old == new
            counts['longer'] += 'n' in old and 'n' in new and new['n'] > old['n']
            counts['error to audio'] += 'n' not in old and 'n' in new
            if 'crash' not in new:
                out.write(json.dumps({'path': str(path), 'expected': new}, ensure_ascii=False) + '\n')
    print(len(files), 'files,', ', '.join(f'{k} {v}' for k, v in counts.items()))
    return 1 if counts['worse'] or counts['crash load_audio'] else 0


if __name__ == '__main__':
    sys.exit(main())
