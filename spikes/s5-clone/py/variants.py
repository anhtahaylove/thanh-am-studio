"""Stage 2: run the equally valid Python variants of the clone-conditioning path on the 20 references.

    runtime\\python\\python.exe -I -B variants.py <variant> [<variant> ...]

Variants (single factor each, against the recorded baseline in work\\rm\\s5-clone\\rec):
  vhq         python-soxr quality VHQ instead of HQ for every resample call
  irfft64     the denoiser's iSTFT computes irfft in float64 (numpy < 2 behaviour) instead of float32
  ffmpegread  every soundfile.read goes through the FFmpeg CLI (f32le, native rate and channels)
  threads1    the denoiser, speaker-encoder and codec-encoder ORT sessions with 1 intra-op thread instead of 8
Report-only (not equally valid or combined; never used for the minima):
  mq          python-soxr quality MQ (below HQ)
  combo       vhq + irfft64 + ffmpegread together
Output: work\\rm\\s5-clone\\variants\\<variant>\\<ref>.npz (emb, codes, resample lengths, denoiser output) and a metrics line.
"""
import sys
import time

import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
from s5common import S5, REC, ffmpeg_read, load_engine, patched, rebuild_conditioning_sessions, reference_set  # noqa: E402
from s5pipe import run_pipeline  # noqa: E402

OUT = S5 / 'variants'
SPECS = {
    'vhq': dict(soxr_quality='VHQ'),
    'irfft64': dict(irfft64=True),
    'ffmpegread': dict(read='ffmpeg'),
    'threads1': dict(threads=1),
    'mq': dict(soxr_quality='MQ'),
    'combo': dict(soxr_quality='VHQ', irfft64=True, read='ffmpeg'),
}


def metrics(st, ref_dir):
    emb0, codes0 = np.load(ref_dir / 'emb.npy'), np.load(ref_dir / 'codes.npy')
    emb = st['emb']
    cos = float(np.dot(emb.astype(np.float64), emb0.astype(np.float64)) / (np.linalg.norm(emb) * np.linalg.norm(emb0)))
    n = min(len(codes0), len(st['codes']))
    frames = float(np.sum(np.all(codes0[:n] == st['codes'][:n], axis=1)) / max(len(codes0), len(st['codes'])))
    tokens = float(np.sum(codes0[:n] == st['codes'][:n]) / (max(len(codes0), len(st['codes'])) * codes0.shape[1]))
    return cos, frames, tokens


def main():
    import soundfile as sf
    names = sys.argv[1:]
    refs = reference_set()
    worker, engine = load_engine()
    for variant in names:
        spec = SPECS[variant]
        folder = OUT / variant
        folder.mkdir(parents=True, exist_ok=True)
        if spec.get('threads'):
            rebuild_conditioning_sessions(engine, spec['threads'])
        for ref in refs:
            t0 = time.time()
            kwargs = {k: v for k, v in spec.items() if k in ('soxr_quality', 'irfft64')}
            if spec.get('read') == 'ffmpeg':
                with patched(sf, 'read', ffmpeg_read):
                    st = run_pipeline(worker, engine, ref, verify=False, **kwargs)
            else:
                st = run_pipeline(worker, engine, ref, verify=False, **kwargs)
            tap = st['tap']
            lens = np.array([len(c[4]) for c in tap.soxr], dtype=np.int64)
            np.savez(folder / f'{ref.stem}.npz', emb=st['emb'], codes=st['codes'], resample_lengths=lens,
                     den_out=tap.soxr[-2][3].astype(np.float32), window=np.array(st['window']), trim=np.array(st['trim_idx']))
            cos, frames, tokens = metrics(st, REC / ref.stem)
            print(f'{variant} {ref.stem}: cos {cos:.12f} frames {frames:.4f} tokens {tokens:.5f} T {len(st["codes"])} ({time.time() - t0:.0f}s)', flush=True)
        if spec.get('threads'):
            rebuild_conditioning_sessions(engine, 8)


if __name__ == '__main__':
    main()
