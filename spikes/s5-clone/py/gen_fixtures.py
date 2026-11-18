"""Fixtures for the Rust unit tests, produced by the reference runtime (never hand-written):
  fixtures/rms/        librosa.feature.rms of a seeded signal (the trim's first step) and numpy float32 pairwise-mean cases
  fixtures/pcm/        soundfile PCM_16 / PCM_24 quantisation of seeded floats incl. ties and out-of-range values
  fixtures/trim_syn/   the seeded synthetic K-B3 inputs, checked against the goldens' sha256 (so they are the golden inputs)

    runtime\\python\\python.exe -I -B gen_fixtures.py
"""
import hashlib
import io
import json
import sys

import numpy as np

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
from s5common import EV, S5, save_json  # noqa: E402

OUT = S5 / 'fixtures'


def synthetic():
    """Verbatim from baseline-1.0.16/scripts/kb3_goldens.py (rng seed 20261118)."""
    rng = np.random.default_rng(20261118)
    cases = {}
    cases['silence-1s'] = np.zeros(16000, np.float32)
    cases['empty-0'] = np.zeros(0, np.float32)
    cases['one-sample'] = np.array([0.5], np.float32)
    cases['short-100'] = (rng.standard_normal(100) * 0.1).astype(np.float32)
    cases['short-2047'] = (rng.standard_normal(2047) * 0.1).astype(np.float32)
    cases['short-2048'] = (rng.standard_normal(2048) * 0.1).astype(np.float32)
    cases['dc-offset'] = (np.full(24000, 0.3, np.float32) + rng.standard_normal(24000).astype(np.float32) * 0.001)
    cases['clipped-noise'] = np.clip(rng.standard_normal(32000) * 2, -1, 1).astype(np.float32)
    cases['quiet-1e-6'] = (rng.standard_normal(32000) * 1e-6).astype(np.float32)
    cases['half-scale-ramp'] = np.linspace(-0.5, 0.5, 20000, dtype=np.float32)
    for sr_n, name in [(16000, '16k'), (24000, '24k'), (44100, '44k')]:
        for k in range(6):
            n = int(sr_n * rng.uniform(1.0, 6.0))
            x = np.zeros(n, np.float32)
            a, b = sorted(rng.integers(0, n, 2))
            b = max(b, a + 300)
            x[a:b] = (rng.standard_normal(min(b, n) - a) * rng.uniform(0.01, 0.5)).astype(np.float32)
            x += (rng.standard_normal(n) * 10 ** rng.uniform(-5, -2.5)).astype(np.float32)
            cases[f'burst-{name}-{k}'] = x
    return cases


def trim_record(wav):
    import librosa
    trimmed, index = librosa.effects.trim(wav, top_db=30)
    return {'start': int(index[0]), 'end': int(index[1]), 'samples_in': int(len(wav)), 'samples_out': int(len(trimmed)),
            'sha256_out_f32': hashlib.sha256(np.ascontiguousarray(trimmed, dtype=np.float32).tobytes()).hexdigest()}


def riff_data(raw):
    pos = 12
    while pos + 8 <= len(raw):
        tag, size = raw[pos:pos + 4], int.from_bytes(raw[pos + 4:pos + 8], 'little')
        if tag == b'data':
            return raw[pos + 8:pos + 8 + size]
        pos += 8 + size + (size & 1)
    raise ValueError('no data chunk')


def main():
    import librosa
    import soundfile as sf
    (OUT / 'rms').mkdir(parents=True, exist_ok=True)
    (OUT / 'pcm').mkdir(parents=True, exist_ok=True)
    (OUT / 'trim_syn').mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(7)
    # numpy float32 mean over a contiguous axis, hop sizes used by clone_window (320 = 16 kHz, 882 = 44.1 kHz, 960 = 48 kHz)
    for hop in (320, 882, 960):
        a = (rng.standard_normal((400, hop)) * rng.uniform(0.001, 0.5, (400, 1))).astype(np.float32)
        np.save(OUT / 'rms' / f'mean_in_{hop}.npy', a)
        np.save(OUT / 'rms' / f'mean_out_{hop}.npy', np.mean(np.square(a), axis=1))
    for n, scale in ((40000, 0.1), (16000 * 3 + 123, 0.003), (3000, 0.5)):
        y = (rng.standard_normal(n) * scale * np.abs(np.sin(np.linspace(0, 7, n)))).astype(np.float32)
        np.save(OUT / 'rms' / f'y_{n}.npy', y)
        np.save(OUT / 'rms' / f'rms_{n}.npy', librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0])
        db = librosa.amplitude_to_db(librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0], ref=np.max, top_db=None)
        np.save(OUT / 'rms' / f'db_{n}.npy', db)

    # soundfile quantisation. Values: ties around +-k.5 LSB, edges, out of range, plus normal noise and tiny amplitudes
    base = [0.0, 1.0, -1.0, 1.0000001, -1.0000001, 1.5, -1.5, 0.99997, 0.999985, 0.9999847, -0.99997, 32767 / 32768, -32768 / 32768,
            0.5 / 32768, -0.5 / 32768, 1.5 / 32768, -1.5 / 32768, 2.5 / 32768, 0.5 / 8388608, 1.5 / 8388608, 2.5 / 8388608]
    ties = [(k + 0.5) / 32768 for k in range(-20, 20)] + [(k + 0.5) / 8388608 for k in range(-20, 20)]
    # tiny amplitudes (|x| < 2^-8) are where libsndfile's lrintf(x * 2^31) rounding before the shift differs from floor(x * scale)
    rng_small = np.random.default_rng(11)
    small = [(rng_small.standard_normal(60000) * a).astype(np.float32) for a in (1e-6, 1e-5, 1e-4, 1e-3, 1e-2)]
    x = np.concatenate([np.array(base + ties, np.float32), (rng.standard_normal(5000) * 0.3).astype(np.float32),
                        rng.uniform(-1.2, 1.2, 3000).astype(np.float32)] + small)
    np.save(OUT / 'pcm' / 'x.npy', x)
    for subtype, name in (('PCM_16', 'pcm16'), ('PCM_24', 'pcm24')):
        buf = io.BytesIO()
        sf.write(buf, x, 48000, format='WAV', subtype=subtype)
        raw = buf.getvalue()
        width = 2 if subtype == 'PCM_16' else 3
        data = riff_data(raw)
        np.save(OUT / 'pcm' / f'{name}_bytes.npy', np.frombuffer(data, np.uint8))
        assert len(data) == width * len(x)
    # the default subtype of a .wav written without subtype (preclean) is PCM_16
    buf = io.BytesIO()
    sf.write(buf, x, 48000, format='WAV')
    data = riff_data(buf.getvalue())
    assert np.array_equal(np.frombuffer(data, np.uint8), np.load(OUT / 'pcm' / 'pcm16_bytes.npy')), 'default subtype is not PCM_16'

    golden = json.loads((EV / 'goldens' / 'k-b3' / 'run1' / 'trim.json').read_text())
    checked = 0
    for name, wav in synthetic().items():
        record = trim_record(wav)
        assert record == golden[f'syn:{name}'], f'regenerated synthetic input {name} differs from the golden'
        np.save(OUT / 'trim_syn' / f'{name}.npy', wav)
        checked += 1
    save_json(OUT / 'MANIFEST.json', {'trim_syn_regenerated_and_equal_to_golden': checked, 'librosa': librosa.__version__,
                                      'numpy': np.__version__, 'soundfile': sf.__version__, 'libsndfile': sf.__libsndfile_version__})
    print('fixtures written to', OUT, '| synthetic trim inputs equal to the goldens:', checked)


if __name__ == '__main__':
    main()
