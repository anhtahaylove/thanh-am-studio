"""Stage 1: record every intermediate of the Python clone-conditioning path for the 20 K-cond references.

    runtime\\python\\python.exe -I -B record.py [name ...]

Writes work\\rm\\s5-clone\\rec\\<ref>\\*.npy and manifest.json (shapes, sha256, scalars). The same run also asserts that the recorded
path is bitwise the real V3TurboVieNeuTTS._enroll_reference result, and that two runs in the same process agree.
"""
import sys
import time

import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
from s5common import REC, digest, load_engine, reference_set, save_json, supplementary_set  # noqa: E402
from s5pipe import run_pipeline  # noqa: E402


def dump(folder, st):
    folder.mkdir(parents=True, exist_ok=True)
    tap = st['tap']
    arrays = {
        'decoded': st['decoded'], 'crop': st['crop'], 'trim_in': st['trim_in'], 'trimmed': st['trimmed'], 'pcm16': st['pcm16'],
        'emb': st['emb'], 'codes': st['codes'],
    }
    names = {0: 'to44k', 1: 'to16k', 2: 'to48k'}
    # soxr calls in order: [denoiser (only when the clean rate is not 44.1 kHz)], speaker (44.1 -> 16 k), codec (44.1 -> 48 k)
    calls = list(tap.soxr)
    kinds = []
    if st['sr_clean'] != 44100:
        kinds.append('to44k')
    kinds += ['to16k', 'to48k']
    assert len(calls) == len(kinds), (len(calls), kinds)
    soxr_meta = {}
    for kind, (in_rate, out_rate, quality, x, y) in zip(kinds, calls):
        arrays[f'soxr_{kind}_in'], arrays[f'soxr_{kind}_out'] = x.astype(np.float32), y.astype(np.float32)
        soxr_meta[kind] = {'in_rate': in_rate, 'out_rate': out_rate, 'quality': quality, 'n_in': int(len(x)), 'n_out': int(len(y))}
    assert len(tap.core) == 1 and len(tap.knf_out) == 1 and len(tap.codec) == 1
    for i, key in enumerate(['mag', 'cos', 'sin', 'sep_mag', 'sep_cos', 'sep_sin']):
        arrays[f'den_{key}'] = tap.core[0][i]
    arrays['knf_in'], arrays['knf_raw'] = tap.knf_in[0], tap.knf_out[0]
    arrays['codec_in'], arrays['codec_raw'] = tap.codec[0][0], tap.codec[0][2]
    # the denoiser output is not returned by prepare_reference: it is the input of the 44.1 -> 16 k and 44.1 -> 48 k calls
    arrays['den_out'] = arrays['soxr_to16k_in']
    assert np.array_equal(arrays['soxr_to16k_in'], arrays['soxr_to48k_in'])
    for key, arr in arrays.items():
        np.save(folder / f'{key}.npy', arr)
    meta = {
        'sr0': st['sr0'], 'channels': int(st['decoded'].shape[1]), 'n_decoded': int(st['decoded'].shape[0]),
        'window': list(st['window']), 'n_crop': int(st['crop'].shape[0]), 'trim_idx': list(st['trim_idx']),
        'n_trimmed': int(len(st['trimmed'])), 'sr_clean': st['sr_clean'], 'soxr': soxr_meta,
        'n_codes': int(st['codes'].shape[0]), 'sha256': {k: digest(v) for k, v in arrays.items()},
        'shapes': {k: list(v.shape) for k, v in arrays.items()},
    }
    save_json(folder / 'manifest.json', meta)
    return meta


def main():
    supp = '--supp' in sys.argv
    refs = supplementary_set() if supp else reference_set()
    wanted = {a for a in sys.argv[1:] if not a.startswith('--')}
    worker, engine = load_engine()
    index = {}
    for ref in refs:
        if wanted and ref.stem not in wanted:
            continue
        t0 = time.time()
        st = run_pipeline(worker, engine, ref, verify=True)
        again = run_pipeline(worker, engine, ref, verify=False)
        assert np.array_equal(again['emb'], st['emb']) and np.array_equal(again['codes'], st['codes']), 'not deterministic'
        meta = dump(REC / ref.stem, st)
        index[ref.stem] = {'path': str(ref), 'window': meta['window'], 'trim': meta['trim_idx'], 'codes': meta['n_codes'],
                           'seconds': round(time.time() - t0, 1)}
        print(ref.stem, index[ref.stem], flush=True)
    if not wanted:
        save_json(REC / ('index-supp.json' if supp else 'index.json'), index)
    print('recorded', len(index))


if __name__ == '__main__':
    main()
