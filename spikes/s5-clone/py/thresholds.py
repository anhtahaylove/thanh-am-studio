"""Stage 2b: compute the K-cond A/A bounds from the Python variants and write THRESHOLDS-S5.md and thresholds-s5.json.

    runtime\\python\\python.exe -I -B thresholds.py

Reads rec\\<ref>\\{emb,codes}.npy + manifest.json (baseline) and variants\\<variant>\\<ref>.npz. Never reads anything from out\\ (Rust).
"""
import json
import sys
import time

import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
from s5common import REC, S5, reference_set, save_json  # noqa: E402

VALID = ['vhq', 'irfft64', 'ffmpegread', 'threads1']      # equally valid variants: their minima are the bounds
REPORT_ONLY = ['mq', 'combo']                               # not used for the bounds
SITES = ['to44k', 'to16k', 'to48k']


def cosine(a, b):
    a, b = a.astype(np.float64), b.astype(np.float64)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def code_stats(c0, c1):
    n = min(len(c0), len(c1))
    frames = float(np.sum(np.all(c0[:n] == c1[:n], axis=1)) / max(len(c0), len(c1)))
    tokens = float(np.sum(c0[:n] == c1[:n]) / (max(len(c0), len(c1)) * c0.shape[1]))
    return frames, tokens


def snr_db(ref, test):
    n = min(len(ref), len(test))
    err = float(np.sum((ref[:n].astype(np.float64) - test[:n].astype(np.float64)) ** 2))
    return 200.0 if err == 0 else 10 * np.log10(float(np.sum(ref[:n].astype(np.float64) ** 2)) / err)


def collect():
    rows = []
    for ref in reference_set():
        d = REC / ref.stem
        manifest = json.loads((d / 'manifest.json').read_text())
        base = dict(emb=np.load(d / 'emb.npy'), codes=np.load(d / 'codes.npy'), den=np.load(d / 'den_out.npy'),
                    lens=[manifest['soxr'][k]['n_out'] for k in SITES if k in manifest['soxr']], window=manifest['window'], trim=manifest['trim_idx'])
        kinds = [k for k in SITES if k in manifest['soxr']]
        for variant in VALID + REPORT_ONLY:
            f = S5 / 'variants' / variant / f'{ref.stem}.npz'
            if not f.is_file():
                continue
            z = np.load(f)
            frames, tokens = code_stats(base['codes'], z['codes'])
            lens = z['resample_lengths'].tolist()
            # the recorder lists the resample sites in call order: [to44k (not at 44.1 kHz)], to16k, to48k
            order = ([k for k in ['to44k'] if 'to44k' in manifest['soxr']]) + ['to16k', 'to48k']
            dlen = {k: int(lens[i]) - int(manifest['soxr'][k]['n_out']) for i, k in enumerate(order)}
            rows.append(dict(ref=ref.stem, variant=variant, cos=cosine(base['emb'], z['emb']), frames=frames, tokens=tokens,
                             dT=int(len(z['codes']) - len(base['codes'])), dlen=dlen, den_snr=snr_db(base['den'], z['den_out']),
                             window_equal=list(z['window']) == base['window'], trim_equal=list(z['trim']) == base['trim']))
    return rows


def main():
    rows = collect()
    present = sorted({r['variant'] for r in rows})
    valid_rows = [r for r in rows if r['variant'] in VALID]
    if not valid_rows:
        raise SystemExit('no variant results yet')
    refs = [r.stem for r in reference_set()]
    bounds = dict(
        cos_min=min(r['cos'] for r in valid_rows), frames_min=min(r['frames'] for r in valid_rows), tokens_min=min(r['tokens'] for r in valid_rows),
        dlen_max=max(abs(v) for r in valid_rows for v in r['dlen'].values()), dT_max=max(abs(r['dT']) for r in valid_rows),
    )
    per_ref = {ref: dict(cos_min=min(r['cos'] for r in valid_rows if r['ref'] == ref), frames_min=min(r['frames'] for r in valid_rows if r['ref'] == ref),
                         tokens_min=min(r['tokens'] for r in valid_rows if r['ref'] == ref)) for ref in refs if any(r['ref'] == ref for r in valid_rows)}
    complete = {v: sum(1 for r in rows if r['variant'] == v) for v in present}
    out = dict(valid_variants=[v for v in VALID if v in present], report_only=[v for v in REPORT_ONLY if v in present], refs_per_variant=complete,
               bounds=bounds, per_ref=per_ref, rows=rows, written=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    save_json(S5 / 'thresholds-s5.json', out)

    lines = ['# THRESHOLDS-S5: K-cond bounds from the equally valid Python variants', '',
             f'Written {out["written"]} by `spikes\\s5-clone\\py\\thresholds.py` from `variants\\` and `rec\\` only (no Rust output is read).', '',
             '## Pre-registered rule (fixed before the Rust K-cond comparison is run)', '',
             'Metrics, per reference, of one conditioning run against the recorded Python baseline (HQ soxr, soundfile reads, numpy float32 `irfft`, 8 ORT threads):', '',
             '- **cosine** between the two 192-d speaker embeddings (float64);',
             '- **code identity**: fraction of codec frames whose 16 codes are all equal, over `max(T_a, T_b)` frames (a length difference counts as non-identical frames); token identity (per code) is reported;',
             '- **length**: the length of each resampler output (three sites) and `T`.', '',
             '**A/A bounds** = the minimum of cosine and of code identity over the four single-factor variants below x 20 references (corpus-wide), and the largest length deviation. '
             '**K-cond passes for a Rust configuration iff, for every one of the 20 references:**', '',
             '1. its embedding cosine against the baseline is >= the A/A minimum cosine;',
             '2. its code frame identity against the baseline is >= the A/A minimum code identity;',
             '3. every resampled length is within +-1 sample of python-soxr\'s (and `T` is equal).', '',
             'Report-only, not part of the pass rule: the stricter per-reference reading (each reference against the minimum over variants on that reference alone), token identity, '
             'the `mq` and `combo` variants, denoiser output SNR. The K-B3 trim check (E0 against the goldens) is separate and exact.', '',
             '## Variants', '',
             '| Variant | What changes | Used for bounds |', '|---|---|---|',
             '| vhq | python-soxr quality VHQ instead of HQ, all three resample calls | yes |',
             '| irfft64 | the denoiser iSTFT computes `irfft` in float64 (numpy < 2 behaviour) instead of float32 | yes |',
             '| ffmpegread | every `soundfile.read` replaced by an FFmpeg CLI f32le read (native rate, channels) | yes |',
             '| threads1 | denoiser, speaker and codec ORT sessions with 1 intra-op thread instead of 8 | yes |',
             '| mq | python-soxr MQ (below the plan\'s HQ/VHQ) | no (report only) |',
             '| combo | vhq + irfft64 + ffmpegread together | no (report only) |', '']
    lines += ['## A/A bounds (corpus-wide)', '', '| Quantity | Value |', '|---|---|',
              f'| minimum embedding cosine | {bounds["cos_min"]:.15f} (1 - cos = {1 - bounds["cos_min"]:.3e}) |',
              f'| minimum code frame identity | {bounds["frames_min"]:.6f} |', f'| minimum code token identity (report) | {bounds["tokens_min"]:.6f} |',
              f'| largest resampled-length deviation (samples) | {bounds["dlen_max"]} |', f'| largest |T difference| (frames) | {bounds["dT_max"]} |', '']
    lines += ['## Per variant (20 references each)', '', '| Variant | n | cos min | cos median | frame identity min | frame identity median | token identity min | max abs dlen | max abs dT | denoiser SNR min (dB) | window equal | trim equal |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for v in VALID + REPORT_ONLY:
        vr = [r for r in rows if r['variant'] == v]
        if not vr:
            continue
        lines.append(f'| {v} | {len(vr)} | {min(r["cos"] for r in vr):.15f} | {float(np.median([r["cos"] for r in vr])):.15f} | {min(r["frames"] for r in vr):.4f} | '
                     f'{float(np.median([r["frames"] for r in vr])):.4f} | {min(r["tokens"] for r in vr):.5f} | {max(abs(x) for r in vr for x in r["dlen"].values())} | '
                     f'{max(abs(r["dT"]) for r in vr)} | {min(r["den_snr"] for r in vr):.1f} | {sum(r["window_equal"] for r in vr)}/{len(vr)} | {sum(r["trim_equal"] for r in vr)}/{len(vr)} |')
    lines += ['', '## Per reference (minimum over the valid variants present)', '', '| Reference | cos min | frame identity min | token identity min |', '|---|---|---|---|']
    for ref, v in per_ref.items():
        lines.append(f'| {ref} | {v["cos_min"]:.15f} | {v["frames_min"]:.4f} | {v["tokens_min"]:.5f} |')
    lines += ['', f'Variants present when this file was written: {", ".join(present)}; rows per variant: {complete}.', '']
    (S5 / 'THRESHOLDS-S5.md').write_text('\n'.join(lines), encoding='utf-8')
    print('written', S5 / 'THRESHOLDS-S5.md', bounds)


if __name__ == '__main__':
    main()
