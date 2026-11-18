r"""gen_tts_inject.py <items.json> <out_dir> --seed N --cond <dir>   (reference runtime, python -I -B)

The P0-A generator (`baseline-1.0.16\p0a\scripts\gen_tts.py`, read at run time and used unchanged) with one patch: VieNeu's
`V3TurboVieNeuTTS._enroll_reference` returns the Rust conditioning `(speaker_emb, ref_codes)` instead of computing it. <dir> holds
`<reference stem>\emb.npy` and `codes.npy` written by `s5-clone cond --wav <reference> --out <dir>`. The patch keys on the blake2b of
the file the engine is handed (the `clone_reference` crop or the original), which this script precomputes from each item's
`reference_path`; a reference without Rust conditioning raises (never falls back to Python silently).
Everything else (engine, seeds, thread settings, worker `tts()` batch path, outputs, `_results.jsonl`) is P0-A's.
"""
import sys
from pathlib import Path

GEN = Path(r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\p0a\scripts\gen_tts.py')
ANCHOR = "    ctx = {'item': '', 'n': 0, 'babble': 0}\n"
PATCH = '''
    import hashlib
    from vieneu.v3turbo import V3TurboVieNeuTTS
    cond_dir = Path(sys.argv[sys.argv.index('--cond') + 1])
    table = {}
    for item in json.loads(items_path.read_text(encoding='utf-8')):
        ref = item.get('reference_path')
        if not ref:
            continue
        crop = m.clone_reference(ref)
        key = hashlib.blake2b(Path(crop).read_bytes(), digest_size=16).hexdigest()
        if crop != ref:
            Path(crop).unlink(missing_ok=True)
        folder = cond_dir / Path(ref).stem
        table[key] = (np.load(folder / 'emb.npy').astype(np.float32), np.load(folder / 'codes.npy').astype(np.int64))
    print(f'Rust conditioning for {len(table)} reference(s)', flush=True)

    def rust_enroll(self, ref_audio, denoise, use_ref_codes):
        key = hashlib.blake2b(Path(ref_audio).read_bytes(), digest_size=16).hexdigest()
        if key not in table or not (denoise and use_ref_codes):
            raise RuntimeError('no Rust conditioning for this reference (injection run never falls back to Python)')
        return table[key]
    V3TurboVieNeuTTS._enroll_reference = rust_enroll

'''


def main():
    source = GEN.read_text(encoding='utf-8')
    assert ANCHOR in source, 'gen_tts.py changed: the injection anchor is gone'
    source = source.replace(ANCHOR, PATCH + ANCHOR, 1)
    namespace = {'__name__': '__main__', '__file__': str(GEN)}
    exec(compile(source, str(GEN), 'exec'), namespace)


if __name__ == '__main__':
    main()
