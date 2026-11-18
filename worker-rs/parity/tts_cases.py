r"""tts_cases.py --corpus <corpus.jsonl> --model <vieneu-v3 folder> --out <cases.jsonl>: the Python side of rows L and P1.

Run with the private runtime: runtime\python\python.exe -I -X utf8 parity\tts_cases.py ...

For every corpus line, what the v1.0.16 worker does with it before the engine: the per-item text check of tts() (the real code path:
verify_model and offline_mode are stubbed around it), split_pauses, VieNeu's chunker on every spoken part, and for every chunk the
reading the engine gets (vietnamese_reading over phonemize_text_with_emotions) with its token ids. Lines that pass the check and have at
most 600 characters are also read whole (the front end on its own, as spike S2 measured it). The first line describes the preset voices
as VieNeu loads them (SHA-256 of the float32 embeddings and int64 codes). `cargo test --release tts::` compares the Rust port against
this file when THANHAM_TTS_CASES points at it.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

WORKER = Path(__file__).resolve().parents[2] / 'worker'


class Checked(Exception):
    pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    for k in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'):
        os.environ[k] = '1'
    sys.path.insert(0, str(WORKER))
    import main as worker
    import numpy as np
    from tokenizers import Tokenizer
    from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps, phonemize_text_with_emotions
    from vieneu.v3turbo import strip_encoder_pad_frame
    import vieneu

    tokenizer = Tokenizer.from_file(str(Path(args.model) / 'backbone' / 'onnx_update' / 'tokenizer.json'))
    reading = worker.vietnamese_reading(phonemize_text_with_emotions)

    def read(chunk):
        phonemes = reading(chunk)
        return [phonemes, tokenizer.encode(phonemes, add_special_tokens=False).ids]

    def check(text):
        """The per-item check of tts(), run for real; None when the text passes."""
        def passed():
            raise Checked
        worker.verify_model, worker.offline_mode = (lambda *a, **k: None), passed
        try:
            worker.tts({'model_path': '.', 'text': text}, Path('.'), lambda *a: None)
        except Checked:
            return None
        except worker.WorkerError as e:
            return {'code': e.code, 'message': str(e)}
        raise AssertionError('tts() went past the text check')

    voices = json.loads((Path(vieneu.__file__).parent / 'assets' / 'voices_v3_turbo.json').read_text(encoding='utf-8'))
    described = {name: [hashlib.sha256(np.asarray(v['speaker_emb'], dtype=np.float32).tobytes()).hexdigest(),
                        hashlib.sha256(strip_encoder_pad_frame(np.asarray(v['codes'], dtype=np.int64)).tobytes()).hexdigest()]
                 for name, v in voices['presets'].items()}
    # split('\n'), not splitlines(): a corpus line may hold U+2028 or U+0085, which JSON leaves unescaped
    lines = [json.loads(ln)['text'] for ln in Path(args.corpus).read_text(encoding='utf-8').split('\n') if ln.strip()]
    with open(args.out, 'w', encoding='utf-8', newline='\n') as out:
        out.write(json.dumps({'voices': described, 'default_voice': voices.get('default_voice')}, ensure_ascii=False) + '\n')
        for text in lines:
            rec = {'text': text, 'check': check(text)}
            if rec['check'] is None:
                try:
                    parts, trailing = worker.split_pauses(text)
                except worker.WorkerError as e:
                    rec['pauses'] = {'code': e.code, 'message': str(e)}
                except Exception as e:  # what tts() reports for it
                    rec['pauses'] = {'code': 'WORKER_ERROR', 'message': f'{type(e).__name__}: {e}'}
                else:
                    rec['parts'] = [[chunk, before] for chunk, before in parts]
                    rec['trailing'] = trailing
                    rec['chunks'] = []
                    for chunk, _ in parts:
                        chunks, gaps = normalize_to_chunks_v3_with_gaps(chunk, max_chars=256)
                        rec['chunks'].append({'chunks': chunks, 'gaps': gaps, 'readings': [read(c) for c in chunks]})
                if len(text) <= 600:
                    rec['line'] = read(text)
            out.write(json.dumps(rec, ensure_ascii=False) + '\n')
    print(len(lines), 'lines recorded')


if __name__ == '__main__':
    main()
