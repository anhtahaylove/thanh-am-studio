"""python tokfuzz_compare.py <tokfuzz_in.jsonl> <tokfuzz_golden.jsonl> <rust_out.jsonl> <report.json>"""
import collections
import json
import sys
import unicodedata

load = lambda p: [json.loads(x) for x in open(p, encoding='utf-8')]
inp, gold, rust = (load(p) for p in sys.argv[1:4])
assert len(inp) == len(gold) == len(rust)
tot, bad = collections.Counter(), collections.defaultdict(list)
for a, g, r in zip(inp, gold, rust):
    tot[a['kind']] += 1
    if g.get('ids') != r.get('ids'):
        bad[a['kind']].append({'i': a['i'], 'text': a['text'], 'py': g.get('ids'), 'rust': r.get('ids') or r.get('err')})
n = len(inp)
nb = sum(len(v) for v in bad.values())
print(f'items {n}; identical {n - nb} ({100 * (n - nb) / n:.4f}%); mismatches {nb}')
for k in sorted(tot):
    print(f'  {k:12s} {tot[k] - len(bad[k])}/{tot[k]}')


def ranges(cps):
    out, s, p = [], None, None
    for c in sorted(cps):
        if s is None:
            s = p = c
        elif c == p + 1:
            p = c
        else:
            out.append((s, p)); s = p = c
    if s is not None:
        out.append((s, p))
    return out


for kind in ('cp', 'cp-ctx', 'cp-run', 'cp-run-end', 'cp-run-nl'):
    cps = [ord(b['text']) if kind == 'cp' else None for b in bad.get(kind, [])]
    if kind == 'cp':
        cats = collections.Counter(unicodedata.category(chr(c)) for c in cps)
        print(f'{kind}: {len(cps)} code points differ; categories {dict(cats)}')
        print('  ranges:', ', '.join(f'U+{a:04X}' + (f'-U+{b:04X}' if b != a else '') for a, b in ranges(cps))[:1500])
json.dump({k: v[:400] for k, v in bad.items()}, open(sys.argv[4], 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print({k: len(v) for k, v in bad.items()})
