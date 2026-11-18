"""Does the reference FFmpeg CLI (aresample=resampler=soxr) reproduce python-soxr? Lengths, lag, bit identity, SNR.

    runtime\\python\\python.exe -I -B check_ffmpeg_soxr.py <rec-dir>
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soxr

FFMPEG = r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\runtime\ffmpeg\ffmpeg.exe'


def ffmpeg_resample(x, in_rate, out_rate, opts):
    cmd = [FFMPEG, '-v', 'error', '-nostdin', '-f', 'f32le', '-ar', str(in_rate), '-ac', '1', '-i', 'pipe:0',
           '-af', f'aresample={out_rate}:resampler=soxr:{opts}', '-f', 'f32le', '-ar', str(out_rate), '-ac', '1', 'pipe:1']
    out = subprocess.run(cmd, input=np.ascontiguousarray(x, dtype='<f4').tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype='<f4')


def main():
    rec = Path(sys.argv[1])
    configs = {'precision=20': 'precision=20', 'precision=20,dither=none': 'precision=20:dither_method=0',
               'precision=20,cheby=0,flags': 'precision=20:cheby=0', 'precision=28(VHQ)': 'precision=28'}
    cases = []
    for d in sorted(rec.iterdir())[:3]:
        if (d / 'manifest.json').is_file():
            for kind, m in json.loads((d / 'manifest.json').read_text())['soxr'].items():
                cases.append((np.load(d / f'soxr_{kind}_in.npy'), m['in_rate'], m['out_rate'], f'{d.name}:{kind}'))
    for label, opts in configs.items():
        print('==', label)
        for x, i, o, name in cases:
            quality = 'VHQ' if '28' in opts else 'HQ'
            ref = soxr.resample(x, i, o, quality=quality).astype(np.float32)
            try:
                got = ffmpeg_resample(x, i, o, opts)
            except subprocess.CalledProcessError as error:
                print(name, 'ffmpeg failed', error.stderr[:200])
                continue
            n = min(len(ref), len(got))
            diff = ref[:n] - got[:n]
            lag_best = min(range(-3, 4), key=lambda k: float(np.max(np.abs(ref[max(0, k):n + min(0, k)] - got[max(0, -k):n - max(0, k)]))))
            snr = 10 * np.log10(float(np.sum(ref[:n].astype(np.float64) ** 2)) / max(float(np.sum(diff.astype(np.float64) ** 2)), 1e-30))
            print(f'{name:12s} len py {len(ref)} ff {len(got)} d={len(got) - len(ref):+d} maxabs {np.max(np.abs(diff)):.3e} '
                  f'bit-identical {n == len(ref) == len(got) and np.array_equal(ref.view(np.uint32), got.view(np.uint32))} bestlag {lag_best} snr {snr:.1f} dB')


if __name__ == '__main__':
    main()
