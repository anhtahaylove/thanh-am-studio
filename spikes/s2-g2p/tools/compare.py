"""Stage 3: compare Rust output against the Python recording.

python compare.py <corpus.jsonl> <golden.jsonl> <rust.jsonl> <report.json>
Prints the rate table and writes every mismatch (with its probe flags) to the report.
"""
import collections
import json
import sys

corpus_p, golden_p, rust_p, report_p = sys.argv[1:5]
load = lambda p: [json.loads(x) for x in open(p, encoding='utf-8')]
corpus, golden, rust = load(corpus_p), load(golden_p), load(rust_p)
assert len(corpus) == len(golden) == len(rust), (len(corpus), len(golden), len(rust))

# metric -> (rust field, python field) ; the first two are the P1 criteria
METRICS = {
    'phonemes':            lambda g, r: r.get('g2p') == g.get('g2p'),
    'token_ids':           lambda g, r: r.get('ids_g2p') == g.get('ids_g2p'),
    'norm (stage)':        lambda g, r: r.get('norm') == g.get('norm'),
    'g2p engine alone':    lambda g, r: r.get('g2p_of_pynorm') == g.get('g2p'),
    'tokenizer alone':     lambda g, r: r.get('ids_of_pyg2p') == g.get('ids_g2p'),
    'worker phonemes':     lambda g, r: r.get('worker') == g.get('worker'),
    'worker token_ids':    lambda g, r: r.get('ids_worker') == g.get('ids_worker'),
    'worker tokenizer alone': lambda g, r: r.get('ids_of_pyworker') == g.get('ids_worker'),
}


def group(src):
    k = src.split(':')
    if k[0] in ('edge', 'mut', 'chunk'):
        return k[0]
    return 'real'


tot = collections.Counter()
ok = collections.defaultdict(collections.Counter)
bad = []
errs = collections.Counter()
for c, g, r in zip(corpus, golden, rust):
    assert c['i'] == g['i'] == r['i']
    grp = group(c['src'])
    tot[grp] += 1
    if 'err' in g or 'err' in r:
        errs[grp] += 1
        bad.append({'i': c['i'], 'src': c['src'], 'text': c['text'], 'failed': ['error'], 'py_err': g.get('err'), 'rust_err': r.get('err')})
        continue
    failed = [m for m, f in METRICS.items() if not f(g, r)]
    for m in METRICS:
        ok[grp][m] += m not in failed
    if failed:
        bad.append({'i': c['i'], 'src': c['src'], 'text': c['text'], 'failed': failed,
                    'py': {k: g.get(k) for k in ('norm', 'g2p', 'worker', 'ids_g2p', 'ids_worker')},
                    'rust': {k: r.get(k) for k in ('norm', 'g2p', 'worker', 'ids_g2p', 'ids_worker', 'g2p_of_pynorm', 'ids_of_pyg2p')}})

n = len(corpus)
print(f'lines: {n}; both-side errors/panics: {sum(errs.values())} {dict(errs)}')
header = ['metric'] + sorted(tot) + ['ALL']
print(' | '.join(header))
for m in METRICS:
    cells = [f'{ok[g][m]}/{tot[g]}' for g in sorted(tot)]
    allok = sum(ok[g][m] for g in tot)
    print(' | '.join([m] + cells + [f'{allok}/{n} = {100 * allok / n:.4f}%']))
by_fail = collections.Counter(tuple(b['failed']) for b in bad)
print('\nmismatch signatures (failed metrics -> lines):')
for k, v in by_fail.most_common(20):
    print(f'{v:6d}  {", ".join(k)}')
json.dump({'lines': n, 'bad': bad}, open(report_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
