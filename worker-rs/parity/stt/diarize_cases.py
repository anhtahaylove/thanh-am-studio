"""Writes diarize.json: worker/diarize.py's pure speaker rules on random inputs, for the Rust ports to match exactly.

`counts`: turns -> real_speakers (both shares), keep_speakers, drop_small_speakers (thanham-diarize).
`split`: rows, words, turns -> assign_speakers on the rows, split_rows (the native worker's stt).

usage: runtime\\python\\python.exe -I worker-rs\\parity\\stt\\diarize_cases.py worker-rs\\parity\\stt\\diarize.json
"""
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'worker'))
import diarize  # noqa: E402

rng = random.Random(20261118)


def turns(n, speakers, span):
    """Random turns sorted by (start, end), some overlapping, with times at sherpa's float32 resolution."""
    out = []
    for _ in range(n):
        start = rng.uniform(0, span)
        out.append({'start': float(f'{start:.6f}'), 'end': float(f'{start + rng.uniform(0.05, 6):.6f}'), 'speaker': rng.randrange(speakers)})
    return sorted(out, key=lambda t: (t['start'], t['end']))


def rows_and_words(span):
    rows, words, at = [], [], rng.uniform(0, 2)
    while at < span:
        end = at + rng.uniform(0.3, 8)
        with_words = rng.random() < 0.8
        row_words, t = [], at
        while with_words and t < end:
            w_end = min(end, t + rng.uniform(0.02, 0.9))
            row_words.append({'start': t, 'end': w_end, 'text': rng.choice([' xin', ' chào', ' các', ' bạn', ' một', ' hai', '  ba', ' ừ　'])})
            t = w_end + rng.choice([0, 0, rng.uniform(0, 0.3)])
        rows.append({'start': at, 'end': end, 'text': ''.join(w['text'] for w in row_words).strip() or 'x'})
        words.append(row_words)
        at = end + rng.uniform(0, 1.5)
    return rows, words


counts = []
for _ in range(300):
    ts = turns(rng.randrange(0, 40), rng.randrange(1, 9), rng.choice([5, 60, 900]))
    k = rng.randrange(1, 9)
    counts.append({'turns': ts, 'k': k, 'real': diarize.real_speakers(ts), 'real_auto': diarize.real_speakers(ts, diarize.MIN_AUTO_SHARE),
                   'keep': diarize.keep_speakers(ts, k), 'drop': diarize.drop_small_speakers(ts)})

split = []
for _ in range(120):
    span = rng.choice([10, 30, 90])
    rows, words = rows_and_words(span)
    ts = turns(rng.randrange(0, 60), rng.randrange(1, 6), span)
    split.append({'rows': rows, 'words': words, 'turns': ts, 'assign': diarize.assign_speakers(rows, ts),
                  'split': diarize.split_rows(rows, words, ts)})

Path(sys.argv[1]).write_text(json.dumps({'counts': counts, 'split': split}), encoding='utf-8')
print(f"{len(counts)} counts cases, {len(split)} split cases, {sum(len(c['split']) - len(c['rows']) for c in split)} rows added by splits, "
      f"{sum(1 for c in split for r in c['split'] if 'overlap' in r)} with overlap")
