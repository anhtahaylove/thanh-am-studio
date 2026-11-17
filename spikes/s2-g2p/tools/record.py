"""Stage 2: record what the Python worker's TTS front end produces for every corpus line.

Run with the repo runtime:
  runtime\\python\\python.exe -I -X utf8 record.py <corpus_raw.jsonl> <tokenizer.json> <worker_main.py> <out_dir>

For each line the recorder stores, exactly as worker/main.py wires it for VieNeu:
  norm     sea_g2p Normalizer(vi).normalize(text, punc_norm=True)          (stage 1 of SEAPipeline.run)
  g2p      SEAPipeline(vi).run(text, punc_norm=True)                        (= vieneu_utils _phonemize_cached; the P1 boundary)
  worker   vietnamese_reading(phonemize_text_with_emotions)(text)          (what _infer_chunks hands the engine)
  ids_g2p  Tokenizer.encode(g2p, add_special_tokens=False).ids
  ids_worker  the same for the worker phonemes
The chunker (normalize_to_chunks_v3_with_gaps) is run on every raw line and its chunks are added as extra corpus lines,
because those chunks are what the front end really receives in production.
Outputs: corpus.jsonl (final, deduplicated), golden.jsonl, meta.json.
"""
import hashlib
import importlib.util
import json
import os
import sys
import time

raw_path, tok_path, worker_path, out_dir = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)

import sea_g2p  # noqa: E402
import tokenizers  # noqa: E402
from sea_g2p import Normalizer, SEAPipeline  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402
from vieneu_utils import phonemize_text as pt  # noqa: E402

spec = importlib.util.spec_from_file_location('worker_main', worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
wrapped = worker.vietnamese_reading(pt.phonemize_text_with_emotions)

tok = Tokenizer.from_file(tok_path)
norm = Normalizer(lang='vi')
pipe = SEAPipeline(lang='vi')

rows, seen = [], set()
for ln in open(raw_path, encoding='utf-8'):
    r = json.loads(ln)
    rows.append(r)
    seen.add(r['text'])
raw_count = len(rows)

t0 = time.time()
chunk_errors = 0
for r in list(rows):
    try:
        chunks, _gaps = pt.normalize_to_chunks_v3_with_gaps(r['text'], max_chars=256)
    except Exception:  # noqa: BLE001
        chunk_errors += 1
        continue
    for c in chunks:
        if c and c not in seen:
            seen.add(c)
            rows.append({'src': 'chunk:' + r['src'].split(':')[0], 'text': c})

corpus_bytes = bytearray()
with open(os.path.join(out_dir, 'corpus.jsonl'), 'w', encoding='utf-8', newline='\n') as f:
    for i, r in enumerate(rows):
        line = json.dumps({'i': i, 'src': r['src'], 'text': r['text']}, ensure_ascii=False) + '\n'
        corpus_bytes += line.encode('utf-8')
        f.write(line)
corpus_sha = hashlib.sha256(corpus_bytes).hexdigest()

errors = 0
with open(os.path.join(out_dir, 'golden.jsonl'), 'w', encoding='utf-8', newline='\n') as f:
    for i, r in enumerate(rows):
        text, out = r['text'], {'i': i}
        try:
            out['norm'] = norm.normalize(text, punc_norm=True)
            out['g2p'] = pipe.run(text, punc_norm=True)
            out['worker'] = wrapped(text)
            out['ids_g2p'] = tok.encode(out['g2p'], add_special_tokens=False).ids
            out['ids_worker'] = tok.encode(out['worker'], add_special_tokens=False).ids
        except Exception as e:  # noqa: BLE001
            errors += 1
            out['err'] = f'{type(e).__name__}: {e}'[:300]
        f.write(json.dumps(out, ensure_ascii=False) + '\n')


def sha256(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def blob_sha1(p):
    d = open(p, 'rb').read()
    return hashlib.sha1(b'blob %d\0' % len(d) + d).hexdigest()


sg = os.path.dirname(sea_g2p.__file__)
meta = {
    'python': sys.version,
    'sea_g2p_files': {n: sha256(os.path.join(sg, n)) for n in ('sea_g2p.bin', 'sea_g2p_rs.pyd', 'g2p.py', 'normalizer.py', 'pipeline.py')},
    'tokenizers_version': tokenizers.__version__,
    'tokenizer_json_sha256': sha256(tok_path),
    'tokenizer_json_git_blob_sha1': blob_sha1(tok_path),
    'worker_main_git_blob_sha1': blob_sha1(worker_path),
    'raw_lines': raw_count,
    'chunk_lines_added': len(rows) - raw_count,
    'chunk_errors': chunk_errors,
    'total_lines': len(rows),
    'record_errors': errors,
    'corpus_sha256': corpus_sha,
    'seconds': round(time.time() - t0, 1),
}
json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'), indent=1)
print(json.dumps(meta, indent=1))
