"""Probe: the recorder must not change Python's results. Runs P0-core's stt_run.py path (mode w) on the given items with a plain
WhisperModel (no recorder) and compares segments, words and language with the recorder's events.jsonl.
usage: python -I probe_plain.py <rec dir> <corpus> <model> <id,id,...>"""
import ctypes
import json
import sys
from pathlib import Path

ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
sys.path.insert(0, r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\scripts')
from rmcommon import EV, MODELS, THREADS, load_worker, setup_env  # noqa: E402

rec, corpus, model_name, ids = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(',')
setup_env()
worker = load_worker()
from faster_whisper import WhisperModel  # noqa: E402

recorded = {json.loads(line)['id']: json.loads(line) for line in (Path(rec) / corpus / model_name / 'w' / 'events.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()}
model = WhisperModel(str(MODELS / f'whisper-{model_name}'), device='cpu', compute_type='int8', cpu_threads=THREADS, local_files_only=True)
paths = {it['id']: it['path'] for it in json.loads((EV / 'corpora' / f'{corpus}.json').read_text(encoding='utf-8'))['items']} if corpus != 'viyt' else \
    {f'viyt-{f.stem}': str(f) for f in (EV.parent.parent / 'diarization-natural' / 'extract').glob('*.wav')}
for i in ids:
    audio = worker.load_audio(paths[i])
    duration = max(len(audio) / worker.STT_RATE, 0.01)
    rows, words, lang, fallback = [], [], None, False
    cuts = worker.stt_windows(audio)
    for start, end in zip(cuts, cuts[1:]):
        try:
            r, w, lang = worker.stt_window(model, audio[start:end], start / worker.STT_RATE, 'vi', True, duration, lambda *a: None)
        except IndexError:
            r, w, lang = worker.stt_window(model, audio[start:end], start / worker.STT_RATE, 'vi', False, duration, lambda *a: None)
            fallback = True
        rows += r
        words += w
    want = recorded[i]
    same = rows == want['segments'] and words == want['words'] and lang == want['language'] and fallback == want['words_fallback']
    print(json.dumps({'id': i, 'model': model_name, 'identical_to_recorder_run': same}), flush=True)
