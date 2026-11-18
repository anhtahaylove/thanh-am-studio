r"""tts_trace.py <trace.jsonl>: runs the v1.0.16 Python worker (worker/main.py, its main()) on the request on stdin, unchanged, and records
per engine call what the Rust worker records under THANHAM_TTS_TRACE: the item, the call number, the phonemes, their token ids, the
codes of every decoded generation, a SHA-256 over every audio-head logits vector in order, and a SHA-256 per decoded waveform.

With THANHAM_CLONE_TRACE=<file> it also records every step of reference enrollment (row K-cond), as the Rust worker does under the same
variable: one JSON line per step, arrays as [SHA-256 of their bytes, length] (see clone_taps).

Run with the private runtime: runtime\python\python.exe -I -X utf8 parity\tts_trace.py <trace.jsonl> < request.json
The hooks only observe; numpy's draws come from the worker's own THANHAM_TTS_SEED hook, which calls these wrappers after re-seeding.
"""
import functools
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'worker'))


def clone_taps(worker, path):
    """Wraps the functions of the cloned path (clone_reference, VieNeu's preclean, denoiser, speaker and codec encoders, soxr) so each
    step's output is written to `path` in the order the worker computes it. Steps: decode, decode_format, window, trim_in, trim,
    pcm16_file (the preclean's PCM_16 WAV, bytes), den_wav, soxr_<in>_<out>, den_mag/cos/sin, den_sep_mag/cos/sin, den_out,
    fbank_raw, fbank, embedding, codes."""
    import numpy as np
    import librosa
    import soundfile
    import soxr
    from vieneu._v3_turbo_engine import onnx_denoiser as od
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine
    from vieneu._v3_turbo_engine.speaker import audio_utils, onnx_extractor
    out = open(path, 'a', encoding='utf-8', newline='\n')

    def line(step, value):
        out.write(json.dumps({'step': step, 'value': value}) + '\n')
        out.flush()

    def arr(step, a):
        a = np.ascontiguousarray(a)
        line(step, [hashlib.sha256(a.tobytes()).hexdigest(), int(a.size)])

    def tap(owner, name, before=None, after=None):
        real = getattr(owner, name)
        @functools.wraps(real)
        def wrapped(*args, **kwargs):
            if before:
                before(*args, **kwargs)
            result = real(*args, **kwargs)
            if after:
                after(result, *args, **kwargs)
            return result
        setattr(owner, name, wrapped)

    real_read = soundfile.read
    def clone_reference(real, path):
        def read(*args, **kwargs):  # clone_reference's own read of the reference
            audio, sr = real_read(*args, **kwargs)
            arr('decode', audio)
            line('decode_format', [int(sr), int(audio.shape[1])])
            return audio, sr
        soundfile.read = read
        try:
            return real(path)
        finally:
            soundfile.read = real_read
    worker.clone_reference = functools.partial(clone_reference, worker.clone_reference)
    tap(worker, 'clone_window', after=lambda r, *a, **k: line('window', [int(r[0]), int(r[1])]))
    tap(librosa.effects, 'trim', before=lambda y, **k: arr('trim_in', y), after=lambda r, *a, **k: line('trim', [int(r[1][0]), int(r[1][1])]))
    def written(_, file, data, samplerate, subtype=None, *a, **k):
        if subtype is None:  # the preclean's PCM_16 file; the crop (FLOAT), takes and previews (PCM_24) are compared elsewhere
            data = Path(file).read_bytes()
            line('pcm16_file', [hashlib.sha256(data).hexdigest(), len(data)])
    tap(soundfile, 'write', after=written)
    tap(od.OnnxDenoiser, 'denoise', before=lambda self, wav, sr: arr('den_wav', np.asarray(wav, dtype=np.float32).reshape(-1)),
        after=lambda r, *a, **k: arr('den_out', r))
    tap(soxr, 'resample', after=lambda r, x, in_rate, out_rate, *a, **k: arr(f'soxr_{int(in_rate)}_{int(out_rate)}', np.asarray(r, dtype=np.float32)))
    def core(r, self, mag, cos, sin):
        for name, a in (('den_mag', mag), ('den_cos', cos), ('den_sin', sin)):
            arr(name, a.astype(np.float32))
        for name, a in zip(('den_sep_mag', 'den_sep_cos', 'den_sep_sin'), r):
            arr(name, a)
    tap(od.OnnxDenoiser, '_core', after=core)
    tap(audio_utils, '_kaldi_fbank', after=lambda r, *a, **k: arr('fbank_raw', r))
    tap(onnx_extractor, 'extract_speaker_fbank', after=lambda r, *a, **k: arr('fbank', r))
    tap(onnx_extractor.OnnxSpeakerEncoder, 'embed', after=lambda r, *a, **k: arr('embedding', r))
    tap(OnnxV3LiteEngine, '_encode_ref_wav', after=lambda r, *a, **k: arr('codes', np.asarray(r, dtype=np.int64)))


def main():
    trace = open(sys.argv[1], 'a', encoding='utf-8', newline='\n')
    for k in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
        os.environ[k] = '1'
    import main as worker
    import numpy as np
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine
    ctx = {'item': None, 'call': 0, 'rec': None}

    voice_kwargs = worker.voice_kwargs
    def item_start(item):  # synth() calls it first for every item
        ctx['item'], ctx['call'] = item.get('output_name'), 0
        return voice_kwargs(item)
    worker.voice_kwargs = item_start

    infer, sample, decode = OnnxV3LiteEngine.infer, OnnxV3LiteEngine._sample, OnnxV3LiteEngine._decode_codes
    def traced_infer(self, *args, **kwargs):
        ctx['call'] += 1
        phonemes = kwargs['phonemes']
        rec = ctx['rec'] = {'item': ctx['item'], 'call': ctx['call'], 'phonemes': phonemes,
                            'ids': self.tokenizer.encode(phonemes, add_special_tokens=False).ids, 'gens': [], 'logits': hashlib.sha256(), 'pcm': []}
        wav = infer(self, *args, **kwargs)
        rec['logits'] = rec['logits'].hexdigest()
        trace.write(json.dumps(rec, ensure_ascii=False) + '\n')
        trace.flush()
        return wav
    def traced_sample(self, logits, *args, **kwargs):
        ctx['rec']['logits'].update(np.asarray(logits, dtype=np.float32).tobytes())
        return sample(self, logits, *args, **kwargs)
    def traced_decode(self, codes):
        wav = decode(self, codes)
        ctx['rec']['gens'].append(np.asarray(codes).tolist())
        ctx['rec']['pcm'].append(hashlib.sha256(np.asarray(wav, dtype=np.float32).tobytes()).hexdigest())
        return wav
    OnnxV3LiteEngine.infer, OnnxV3LiteEngine._sample, OnnxV3LiteEngine._decode_codes = traced_infer, traced_sample, traced_decode
    if os.environ.get('THANHAM_CLONE_TRACE'):
        clone_taps(worker, os.environ['THANHAM_CLONE_TRACE'])
    return worker.main()


if __name__ == '__main__':
    sys.exit(main())
