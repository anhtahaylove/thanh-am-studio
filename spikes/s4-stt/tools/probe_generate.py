"""Probe: is the Python wheel's `generate` repeatable? Replays recorded `generate` calls (recorded encoder output and options) N times
in this process and compares the token ids, scores and no-speech probability with the recording.
usage: python -I probe_generate.py <rec dir> <corpus> <model> <mode> <item> <model dir> [repeats]"""
import ctypes
import json
import sys
from pathlib import Path

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
import ctranslate2  # noqa: E402
import numpy as np  # noqa: E402

rec, corpus, model, mode, item, model_dir = sys.argv[1:7]
repeats = int(sys.argv[7]) if len(sys.argv) > 7 else 3
d = Path(rec) / corpus / model / mode
r = next(json.loads(line) for line in (d / 'events.jsonl').read_text(encoding='utf-8').splitlines() if json.loads(line)['id'] == item)
m = ctranslate2.models.Whisper(model_dir, device='cpu', compute_type='int8', intra_threads=8)
shapes = {e['n']: e['out_shape'] for e in r['events'] if e['k'] == 'encode'}
same = differ = 0
for e in r['events']:
    if e['k'] != 'generate':
        continue
    enc = np.fromfile(d / 'enc' / item / f'{e["enc"]}.f32', dtype=np.float32).reshape(shapes[e['enc']])
    sv = ctranslate2.StorageView.from_array(enc)
    kw = {k: (tuple(v) if isinstance(v, list) else v) for k, v in e['kw'].items()}
    want = e['out'][0]
    for _ in range(repeats):
        got = m.generate(sv, e['prompts'], **kw)[0]
        ok = [list(s) for s in got.sequences_ids] == want['seq'] and list(got.scores) == want['scores'] and got.no_speech_prob == want['nsp']
        same += ok
        differ += not ok
        if not ok:
            print(json.dumps({'enc': e['enc'], 'temperature': kw.get('sampling_temperature', 0), 'recorded_len': len(want['seq'][0]), 'got_len': len(got.sequences_ids[0]),
                              'score_recorded': want['scores'][0], 'score_got': got.scores[0]}))
print(json.dumps({'item': item, 'model': model, 'replays': same + differ, 'identical': same, 'different': differ}))
