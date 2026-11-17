"""Tokenizer-only stress: where the regex backend (onig in the Python wheel, fancy-regex in Rust) could differ.

runtime\\python\\python.exe -I -X utf8 tokfuzz_record.py <tokenizer.json> <corpus.jsonl> <golden.jsonl> <out_dir>
Writes tokfuzz_in.jsonl ({"i", "kind", "text"}) and tokfuzz_golden.jsonl ({"i", "ids"}) with
Tokenizer.encode(text, add_special_tokens=False).ids, the call the VieNeu engine makes.
Inputs: (a) every raw corpus text, (b) Python's phoneme strings with one exotic code point injected,
(c) every BMP code point plus a sample of astral ones, alone and inside phoneme-like context.
"""
import json
import os
import random
import sys
import unicodedata

from tokenizers import Tokenizer

tok_path, corpus_p, golden_p, out = sys.argv[1:5]
tok = Tokenizer.from_file(tok_path)
rng = random.Random(20261118)
corpus = [json.loads(x) for x in open(corpus_p, encoding='utf-8')]
golden = [json.loads(x) for x in open(golden_p, encoding='utf-8')]

items = [('raw', c['text']) for c in corpus]
phon = [g['g2p'] for g in golden if g.get('g2p') and len(g['g2p']) < 600]
exotic = [chr(c) for c in range(0x80, 0x3000) if unicodedata.category(chr(c))[0] in 'LNZMC' or chr(c).isspace()]
for p in rng.sample(phon, min(len(phon), 4000)):
    pos = rng.randrange(len(p) + 1)
    items.append(('inject', p[:pos] + rng.choice(exotic) + p[pos:]))
cps = [c for c in range(0x110000) if not 0xD800 <= c <= 0xDFFF and (c < 0x20000 or c % 97 == 0)]
ctx = 'ˈɛn {} ˈɛm.'
for c in cps:
    ch = chr(c)
    items.append(('cp', ch))
    items.append(('cp-ctx', ctx.format(ch)))
    if unicodedata.category(ch) in ('Nd', 'Nl', 'No', 'Zs', 'Zl', 'Zp', 'Cc', 'Cf') or ch.isspace():
        items.append(('cp-run', f'ab{ch}{ch}cd {ch}'))
        items.append(('cp-run-end', f'ab {ch}'))
        items.append(('cp-run-nl', f'ab{ch}\n{ch}cd'))
for s in ("it's", "IT'S", "we'RE", "they've", "I'm", "you'LL", "he'd", "'s", "x's's", "ſ's", "K's", "İ's", "ǅ's", "'ſ", "don't", "O'Neil"):
    items.append(('apos', s))
    items.append(('apos-ctx', 'ˈɛn ' + s + ' ˈɛm.'))

os.makedirs(out, exist_ok=True)
with open(os.path.join(out, 'tokfuzz_in.jsonl'), 'w', encoding='utf-8', newline='\n') as fi, \
        open(os.path.join(out, 'tokfuzz_golden.jsonl'), 'w', encoding='utf-8', newline='\n') as fg:
    for i, (kind, text) in enumerate(items):
        fi.write(json.dumps({'i': i, 'kind': kind, 'text': text}, ensure_ascii=False) + '\n')
        fg.write(json.dumps({'i': i, 'ids': tok.encode(text, add_special_tokens=False).ids}) + '\n')
print(len(items), 'items')
