"""Which glue paths the recorded items exercise (per corpus/model/mode): windows, empty VAD, temperature fallbacks, word-time retries,
language detection, decodes skipped as no-speech. usage: python -I coverage.py <rec dir>"""
import json
import sys
from pathlib import Path

for f in sorted(Path(sys.argv[1]).glob('*/*/*/events.jsonl')):
    corpus, model, mode = f.parts[-4:-1]
    c = dict(items=0, audio_min=0.0, windows=0, multi_window_items=0, empty_vad=0, encode=0, generate=0, fallback_decodes=0,
             align=0, index_error=0, detect=0, segments=0, words=0)
    for line in f.read_text(encoding='utf-8').splitlines():
        r = json.loads(line)
        ev = r['events']
        c['items'] += 1
        c['audio_min'] += r['audio_seconds'] / 60
        w = sum(e['k'] == 'window' for e in ev)
        c['windows'] += w
        c['multi_window_items'] += w > 1
        c['empty_vad'] += sum(e['k'] == 'vad' and not e['speech'] for e in ev)
        for k in ('encode', 'generate', 'align', 'detect', 'index_error'):
            c[k] += sum(e['k'] == k for e in ev)
        c['fallback_decodes'] += sum(e['k'] == 'generate' and e['kw'].get('sampling_temperature', 0) > 0 for e in ev)
        c['segments'] += len(r['segments'])
        c['words'] += sum(len(x) for x in r['words'])
    c['audio_min'] = round(c['audio_min'], 1)
    print(json.dumps({'job': f'{corpus}/{model}/{mode}', **c}))
