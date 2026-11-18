"""Builds the S4 T1a edge set (THRESHOLDS-S4.md): short 16 kHz WAVs that drive glue branches the speech corpora rarely reach
(empty VAD, no-speech skips, temperature fallbacks, tiny VAD chunks). Deterministic. usage: python -I make_edge.py <out dir>"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

WORK = Path(r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work')
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
sr = 16000


def load(path):
    x, rate = sf.read(path, dtype='float32', always_2d=True)
    x = x.mean(axis=1)
    if rate != sr:  # linear resampling is enough for a test input; the worker decodes the written file itself
        t = np.arange(int(len(x) * sr / rate)) * rate / sr
        x = np.interp(t, np.arange(len(x)), x).astype(np.float32)
    return x


take = load(WORK / 'cue-timing' / 'audio' / 'p00-v0.wav')
rng = np.random.default_rng(20261118)
items = {
    'edge-silence': np.zeros(20 * sr, np.float32),
    'edge-noise': (rng.standard_normal(30 * sr) * 0.05).astype(np.float32),
    'edge-music': load(WORK / 'openmp-swap-spike' / 'clips' / 'music0-70s.wav'),
    'edge-loop': np.tile(take, int(np.ceil(28 * sr / len(take))))[:28 * sr],
    'edge-short': np.concatenate([take[:int(0.6 * sr)], np.zeros(10 * sr, np.float32), take[int(1.0 * sr):int(1.3 * sr)]]),
}
manifest = []
for name, x in items.items():
    path = out / f'{name}.wav'
    sf.write(path, np.clip(x, -1, 1), sr, subtype='PCM_16')
    manifest.append({'id': name, 'path': str(path), 'seconds': round(len(x) / sr, 2)})
(out / 'edge.json').write_text(json.dumps({'items': manifest}, indent=1), encoding='utf-8')
print(json.dumps(manifest))
