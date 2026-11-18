"""S5b: record every numeric intermediate of the denoiser's STFT / iSTFT with the reference runtime's numpy.

    runtime\\python\\python.exe -I -B recstft.py [<ref> ...]

Input: rec\\<ref>\\soxr_to44k_out.npy (the 44.1 kHz signal the installed denoiser starts from) and the recorded ORT outputs.
Output: rec-stft\\<ref>\\*.npy, all C-contiguous float32/float64 (complex arrays are stored as a trailing axis of 2: re, im).
Each stage is checked bitwise against the recording made by record.py (den_mag, den_cos, den_sin, den_out), so the replica of the
installed code is proven equal before anything is compared with Rust.
"""
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
from s5common import REC, S5, reference_set  # noqa: E402

OUT = S5 / 'rec-stft'


def riv(z):
    return np.ascontiguousarray(z).view(z.real.dtype).reshape(z.shape + (2,))


def main():
    from vieneu._v3_turbo_engine import onnx_denoiser as od

    refs = sys.argv[1:] or [r.stem for r in reference_set()]
    n_fft, hop, win = od.N_FFT, od.HOP, od._WIN
    feats = {}
    try:
        from numpy._core._multiarray_umath import __cpu_features__ as f
        feats = {k: bool(v) for k, v in f.items() if v}
    except Exception:  # noqa: BLE001
        pass
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'numpy-info.json').write_text(json.dumps({'numpy': np.__version__, 'cpu_features_enabled': sorted(feats)}, indent=1))
    report = {}
    for ref in refs:
        d = REC / ref
        o = OUT / ref
        o.mkdir(parents=True, exist_ok=True)
        wav = np.load(d / 'soxr_to44k_out.npy').astype(np.float32).reshape(-1)
        length = len(wav)
        abs_max = max(float(np.abs(wav).max()), 1e-7)
        w = np.pad(wav / abs_max, (0, 441))
        x = od._normalize(w)
        pad = n_fft // 2
        xp = np.pad(x, (pad, pad), mode='reflect')
        n = 1 + (len(xp) - n_fft) // hop
        idx = np.arange(n_fft)[None, :] + hop * np.arange(n)[:, None]
        frames_w = xp[idx] * win[None, :]
        spec = np.fft.rfft(frames_w, n=n_fft, axis=1).T[:, :-1]
        t = spec.shape[1]
        mag, phi = np.abs(spec), np.angle(spec)
        cs, sn = np.cos(phi), np.sin(phi)
        ok = {}
        for k, a in (('den_mag', mag), ('den_cos', cs), ('den_sin', sn)):
            rec = np.load(d / f'{k}.npy')
            ok[k] = bool(np.array_equal(rec.reshape(a.shape), a.astype(np.float32)))
        sep = [np.load(d / f'den_sep_{k}.npy').astype(np.float32).reshape(mag.shape) for k in ('mag', 'cos', 'sin')]
        spec2 = sep[0] * (sep[1] + 1j * sep[2])
        assert spec2.dtype == np.complex64, spec2.dtype
        spec2c = np.concatenate([spec2, spec2[:, -1:]], axis=1)
        irf = np.fft.irfft(spec2c, n=n_fft, axis=0)
        assert irf.dtype == np.float32, irf.dtype
        fw = irf * win[:, None]
        tt = spec2c.shape[1]
        siglen = n_fft + hop * (tt - 1)
        acc, wsum = np.zeros(siglen), np.zeros(siglen)
        w2 = win ** 2
        for i in range(tt):
            s = i * hop
            acc[s:s + n_fft] += fw[:, i]
            wsum[s:s + n_fft] += w2
        res = (acc / np.maximum(wsum, 1e-11))[pad:siglen - pad]
        if len(res) < len(x):
            res = np.pad(res, (0, len(x) - len(res)))
        res = res[:len(x)]
        out = (res[:length] * abs_max).astype(np.float32)
        ok['den_out'] = bool(np.array_equal(np.load(d / 'den_out.npy').reshape(-1), out))
        for name, a in (('x', x), ('frames_w', frames_w[:t]), ('spec', riv(np.ascontiguousarray(spec))), ('mag', mag),
                        ('phi', phi), ('cos64', cs), ('sin64', sn), ('spec2c', riv(spec2c)), ('irfft32', np.ascontiguousarray(irf.T)),
                        ('acc', acc), ('wsum', wsum), ('res', res), ('out', out)):
            np.save(o / f'{name}.npy', np.ascontiguousarray(a))
        report[ref] = {'frames': int(t), 'replica_equals_recording': ok, 'abs_max': abs_max}
        print(ref, ok, flush=True)
    (OUT / 'report.json').write_text(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
