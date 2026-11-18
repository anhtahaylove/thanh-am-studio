r"""tts_trace.py <trace.jsonl>: runs the v1.0.16 Python worker (worker/main.py, its main()) on the request on stdin, unchanged, and records
per engine call what the Rust worker records under THANHAM_TTS_TRACE: the item, the call number, the phonemes, their token ids, the
codes of every decoded generation, a SHA-256 over every audio-head logits vector in order, and a SHA-256 per decoded waveform.

Run with the private runtime: runtime\python\python.exe -I -X utf8 parity\tts_trace.py <trace.jsonl> < request.json
The hooks only observe; numpy's draws come from the worker's own THANHAM_TTS_SEED hook, which calls these wrappers after re-seeding.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'worker'))


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
    return worker.main()


if __name__ == '__main__':
    sys.exit(main())
