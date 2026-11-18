"""Stage 4: apply the pre-registered K-cond rule (THRESHOLDS-S5.md) to a Rust run.

    runtime\\python\\python.exe -I -B kcond_eval.py <tag> [<index-name>]

Reads work\\rm\\s5-clone\\thresholds-s5.json (bounds from the Python variants) and out\\<tag>\\summary.json (written by `s5-clone run`),
writes kcond-<tag>.md next to RESULTS.md and prints the verdict line. Pass iff, for every reference: cosine >= the A/A minimum, code frame
identity >= the A/A minimum, all resampled lengths within +-1 sample of python-soxr's and T equal.
"""
import json
import sys

sys.path.insert(0, __file__.rsplit('\\', 1)[0])
from s5common import S5  # noqa: E402


def main():
    tag = sys.argv[1]
    bounds = json.loads((S5 / 'thresholds-s5.json').read_text())
    b, per_ref = bounds['bounds'], bounds['per_ref']
    summary = json.loads((S5 / 'out' / tag / 'summary.json').read_text())
    rows, ok_all, strict_all = [], True, True
    for ref, r in sorted(summary.items()):
        cos, frames, tokens = r['embedding_cosine'], r['codes_frame_identity'], r['codes_token_identity']
        lens = {k: (r['stages'][k]['len_rust'], r['stages'][k]['len_python']) for k in ('resampled_44k', 'to16k', 'to48k') if k in r['stages']}
        dlen = max(abs(a - c) for a, c in lens.values())
        t_equal = r['codes_frames_rust'] == r['codes_frames_python']
        passed = cos >= b['cos_min'] and frames >= b['frames_min'] and dlen <= 1 and t_equal
        pr = per_ref.get(ref)
        strict = None if pr is None else (cos >= pr['cos_min'] and frames >= pr['frames_min'])
        ok_all &= passed
        strict_all &= bool(strict) if strict is not None else True
        rows.append((ref, cos, frames, tokens, dlen, t_equal, passed, strict, r['embedding_bitwise'], r['stages']['den_out']['bitwise']))
    lines = [f'# K-cond evaluation of Rust run `{tag}`', '',
             f'Bounds (THRESHOLDS-S5.md): cosine >= {b["cos_min"]:.15f}, code frame identity >= {b["frames_min"]:.4f}, lengths +-1, T equal.', '',
             '| Reference | cosine | 1 - cosine | frame identity | token identity | max length dev | T equal | pass | per-ref strict | embedding bitwise | denoiser output bitwise |',
             '|---|---|---|---|---|---|---|---|---|---|---|']
    for ref, cos, frames, tokens, dlen, t_equal, passed, strict, emb_bw, den_bw in rows:
        lines.append(f'| {ref} | {cos:.15f} | {1 - cos:.2e} | {frames:.4f} | {tokens:.5f} | {dlen} | {t_equal} | {"PASS" if passed else "FAIL"} | '
                     f'{"-" if strict is None else ("yes" if strict else "no")} | {emb_bw} | {den_bw} |')
    verdict = f'K-cond {"PASS" if ok_all else "FAIL"} for {tag}: {sum(1 for r in rows if r[6])}/{len(rows)} references pass; per-reference strict reading {"holds" if strict_all else "does not hold"}'
    lines += ['', f'**{verdict}**', '']
    (S5 / f'kcond-{tag}.md').write_text('\n'.join(lines), encoding='utf-8')
    print(verdict)


if __name__ == '__main__':
    main()
