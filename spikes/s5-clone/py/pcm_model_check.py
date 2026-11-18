import io, numpy as np, soundfile as sf
rng = np.random.default_rng(7)
parts = [rng.standard_normal(300000) * a for a in (1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1, 0.5)]
parts.append(np.array([0.0, -0.0, 1.0, -1.0, 1.5, -1.5, 0.99999994, -0.99999994, 2**-24, -2**-24, 2**-25, 0.5 / 32768, 1.5 / 32768, -0.5 / 32768, -1.5 / 32768, 0.5 / 8388608, 1.5 / 8388608, -0.5 / 8388608, -2.5/8388608]))
x = np.concatenate(parts).astype(np.float32)
def model(x, bits):
    v = x.astype(np.float32) * np.float32(2.0 ** 31)
    r = np.where(v >= np.float32(2.0 ** 31), 0x7FFFFFFF, np.where(v <= np.float32(-(2.0 ** 31)), -(2 ** 31), np.rint(v.astype(np.float64)))).astype(np.int64)
    return r >> (32 - bits)
def floor_model(x, bits):
    s = 2.0 ** (bits - 1)
    return np.clip(np.floor(x.astype(np.float64) * s), -s, s - 1).astype(np.int64)
for sub, bits in (('PCM_16', 16), ('PCM_24', 24)):
    b = io.BytesIO(); sf.write(b, x, 44100, subtype=sub, format='WAV'); b.seek(0)
    got = sf.read(b, dtype='int32')[0].astype(np.int64) >> (32 - bits)
    print(sub, 'n', len(x), 'lrint>>shift model mismatches', int((got != model(x, bits)).sum()), '| floor model mismatches', int((got != floor_model(x, bits)).sum()))
