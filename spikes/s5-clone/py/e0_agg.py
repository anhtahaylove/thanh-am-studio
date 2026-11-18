import json, sys
tag = sys.argv[1]
s = json.load(open(f'out/{tag}/summary.json'))
agg = {}
for r in s.values():
    for k, v in r['stages'].items():
        b = v.get('bitwise', v.get('equal'))
        if b is not None:
            agg.setdefault('stage:' + k, []).append(b)
    for k, v in r['teacher_forced'].items():
        b = v.get('bitwise')
        if b is not None:
            agg.setdefault('forced:' + k, []).append(b)
    agg.setdefault('embedding_bitwise', []).append(r['embedding_bitwise'])
    agg.setdefault('codes_all_equal', []).append(r['codes_frame_identity'] == 1.0 and r['codes_token_identity'] == 1.0 and r['codes_frames_rust'] == r['codes_frames_python'])
    agg.setdefault('window_equal', []).append(r.get('window_equal'))
    agg.setdefault('trim_equal', []).append(r.get('trim_equal'))
print(tag, len(s), 'refs')
for k, v in sorted(agg.items()):
    print(f'  {k:28s} {sum(1 for x in v if x is True)}/{len(v)}')
