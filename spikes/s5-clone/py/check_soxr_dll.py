"""Does the soxr.dll built from dofuuz/soxr a66f3ee reproduce python-soxr 1.1.0 bit for bit?
Replicates python-soxr's csoxr_divide_proc (soxr_ext.cpp, tag v1.1.0) through ctypes and compares with soxr.resample.

    runtime\\python\\python.exe -I -B check_soxr_dll.py <soxr.dll> [rec-dir]
"""
import ctypes as C
import sys
from pathlib import Path

import numpy as np
import soxr

QUALITY = {'MQ': 2, 'HQ': 4, 'VHQ': 6}


class IoSpec(C.Structure):
    _fields_ = [('itype', C.c_int), ('otype', C.c_int), ('scale', C.c_double), ('e', C.c_void_p), ('flags', C.c_ulong)]


class QualitySpec(C.Structure):
    _fields_ = [('precision', C.c_double), ('phase_response', C.c_double), ('passband_end', C.c_double),
                ('stopband_begin', C.c_double), ('e', C.c_void_p), ('flags', C.c_ulong)]


def load(dll):
    lib = C.WinDLL(str(dll))
    lib.soxr_version.restype = C.c_char_p
    lib.soxr_io_spec.argtypes, lib.soxr_io_spec.restype = [C.c_int, C.c_int], IoSpec
    lib.soxr_quality_spec.argtypes, lib.soxr_quality_spec.restype = [C.c_ulong, C.c_ulong], QualitySpec
    lib.soxr_create.argtypes = [C.c_double, C.c_double, C.c_uint, C.POINTER(C.c_char_p), C.POINTER(IoSpec),
                                C.POINTER(QualitySpec), C.c_void_p]
    lib.soxr_create.restype = C.c_void_p
    lib.soxr_process.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_size_t), C.c_void_p, C.c_size_t,
                                 C.POINTER(C.c_size_t)]
    lib.soxr_process.restype = C.c_char_p
    lib.soxr_delete.argtypes = [C.c_void_p]
    return lib


def resample_dll(lib, x, in_rate, out_rate, quality='HQ'):
    x = np.ascontiguousarray(x, dtype=np.float32)
    io = lib.soxr_io_spec(0, 0)  # SOXR_FLOAT32_I
    q = lib.soxr_quality_spec(QUALITY[quality], 0)
    err = C.c_char_p()
    h = lib.soxr_create(float(in_rate), float(out_rate), 1, C.byref(err), C.byref(io), C.byref(q), None)
    assert not err.value, err.value
    ilen = len(x)
    olen = int(ilen * float(out_rate) / float(in_rate)) + 1
    div_len = int(max(1000.0, 48000 * float(in_rate) / float(out_rate)))
    y = np.zeros(olen, np.float32)
    pos = 0
    odone = C.c_size_t()
    for idx in range(0, ilen, div_len):
        n = min(div_len, ilen - idx)
        e = lib.soxr_process(h, x[idx:].ctypes.data, n, None, y[pos:].ctypes.data, olen - pos, C.byref(odone))
        assert not e, e
        pos += odone.value
    e = lib.soxr_process(h, None, 0, None, y[pos:].ctypes.data, olen - pos, C.byref(odone))
    assert not e, e
    pos += odone.value
    lib.soxr_delete(h)
    return y[:pos].copy()


def main():
    lib = load(sys.argv[1])
    print('dll version:', lib.soxr_version().decode(), '| python-soxr libsoxr:', soxr.__libsoxr_version__)
    rng = np.random.default_rng(20261118)
    cases = []
    for in_rate, out_rate in [(16000, 44100), (44100, 16000), (44100, 48000), (48000, 44100)]:
        for n in (1, 2, 7, 100, 999, 1000, 4410, 48000, 128000 * in_rate // 16000 // 2, 355217):
            cases.append((rng.standard_normal(n).astype(np.float32) * 0.1, in_rate, out_rate, f'rand-{n}'))
    if len(sys.argv) > 2:
        for d in sorted(Path(sys.argv[2]).iterdir()):
            if (d / 'manifest.json').is_file():
                import json
                meta = json.loads((d / 'manifest.json').read_text())['soxr']
                for kind, m in meta.items():
                    cases.append((np.load(d / f'soxr_{kind}_in.npy'), m['in_rate'], m['out_rate'], f'{d.name}:{kind}'))
    bad = total = 0
    for x, i, o, name in cases:
        for quality in ('HQ', 'VHQ', 'MQ'):
            ref = soxr.resample(x, i, o, quality=quality).astype(np.float32)
            got = resample_dll(lib, x, i, o, quality)
            total += 1
            same = ref.shape == got.shape and np.array_equal(ref.view(np.uint32), got.view(np.uint32))
            if not same:
                bad += 1
                print('DIFF', name, i, o, quality, ref.shape, got.shape,
                      float(np.max(np.abs(ref[:min(len(ref), len(got))] - got[:min(len(ref), len(got))]))) if len(got) else None)
    print(f'{total - bad}/{total} bit-identical to python-soxr ({len(cases)} signals x 3 qualities)')


if __name__ == '__main__':
    main()
