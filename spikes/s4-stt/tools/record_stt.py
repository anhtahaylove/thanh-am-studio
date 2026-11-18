"""Dev-only S4 recorder (T1a/T1e): runs the unchanged v1.0.16 worker STT path and records every CTranslate2 Whisper call.

usage: runtime\\python\\python.exe -I record_stt.py <jobs.txt>
  jobs.txt: one job per line, `<corpus> <small|turbo> <w|p|a> [id,id,...]` (corpora as in P0-core's stt_run.py; `#` comments).
  modes: w = language vi + word times, p = vi without word times, a = auto language + word times (THRESHOLDS-S4.md);
  a trailing `i` (wi, pi) records with fault injection (see Recorder).

Path per item, as in P0-core's stt_run.py and the worker's stt(): load_audio -> stt_windows -> stt_window (beam 5, VAD on, no
previous-text conditioning) with stt()'s IndexError retry without word times. The recorder wraps the ctranslate2.models.Whisper object
that faster-whisper holds (encode, generate, align, detect_language) and faster-whisper's own get_speech_timestamps and
get_compression_ratio; it changes no argument and no result.

Output under work\\rm\\s4-stt\\rec\\<corpus>\\<model>\\<mode>\\: events.jsonl (one line per finished item: its events in call order),
feat\\<id>.f32 (every encode input, float32, concatenated in call order), enc\\<id>\\<n>.f32 (encode outputs, T1e items in mode w only).
The PCM of each item goes once to rec\\pcm\\<corpus>\\<id>.f32. Resumable: finished items are skipped."""
import ctypes
import hashlib
import json
import sys
import time
from pathlib import Path

K32 = ctypes.windll.kernel32
K32.GetCurrentProcess.restype = ctypes.c_void_p
SELF = ctypes.c_void_p(K32.GetCurrentProcess())
K32.SetPriorityClass(SELF, 0x4000)  # BELOW_NORMAL: shared machine
# Decision O.10 / finding F-S4-1: pin the core type before any model load (i5-13400F: LP 0-11 are the P-cores) and log it; and opt out
# of power throttling, which parks hidden BelowNormal processes on the E-cores (F-S4-3).
P_CORES = 0x0FFF
assert K32.SetProcessAffinityMask(SELF, ctypes.c_size_t(P_CORES)), 'SetProcessAffinityMask failed'
K32.SetProcessInformation(SELF, 4, (ctypes.c_ulong * 3)(1, 1, 0), 12)


class MemoryStatus(ctypes.Structure):
    _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in
               ('total', 'avail', 'total_page', 'avail_page', 'total_virtual', 'avail_virtual', 'avail_ext')]


def wait_for_ram(gb=3):
    """Shared machine rule: start each heavy job only with at least `gb` GB of physical memory available."""
    s = MemoryStatus(length=ctypes.sizeof(MemoryStatus))
    while K32.GlobalMemoryStatusEx(ctypes.byref(s)) and s.avail < gb * 2**30:
        print(f'waiting for RAM: {s.avail / 2**30:.1f} GB available', flush=True)
        time.sleep(60)


def affinity():
    mask, system = ctypes.c_size_t(), ctypes.c_size_t()
    K32.GetProcessAffinityMask(SELF, ctypes.byref(mask), ctypes.byref(system))
    return f'{mask.value:04X}'

import numpy as np

sys.path.insert(0, r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16\scripts')
from rmcommon import EV, MODELS, THREADS, load_worker, setup_env  # noqa: E402  (P0-core's helpers, read-only)

S4 = Path(r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\s4-stt')
T1E = {f'mix-{i:04d}' for i in range(5)} | {f'viyt-{i:03d}' for i in range(5)}


def sha(b):
    return hashlib.sha256(b).hexdigest()


class Result:
    """Stand-in for a CTranslate2 result object (only the attributes faster-whisper reads)."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


class Recorder:
    """Proxy for ctranslate2.models.Whisper: forwards everything, logs the four engine calls.
    inject=True (modes ending in `i`, glue-only test): perturbs engine outputs so the unchanged Python glue takes its rare branches.
    By encode index n: n % 4 == 1 scales the temperature-0 scores by 10 (one fallback), == 2 scales every decode's scores by 10
    (all temperatures fail, best-of selection), == 3 also sets no_speech_prob 0.95 (no-speech skip); the 2nd align call of each window
    returns empty alignments (faster-whisper's IndexError, the worker's retry without word times)."""

    def __init__(self, inner, inject=False):
        self.inner = inner
        self.inject = inject
        self.n_align = 0
        self.events = []
        self.feat = None  # open file for this item's encode inputs
        self.enc_dir = None  # where to keep encode outputs (T1e items) or None
        self.live = {}  # id(encoder output) -> (encode index, object); strong refs so ids are not reused within a window
        self.n_encode = 0

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def handle(self, enc):
        return self.live[id(enc)][0]

    def encode(self, features, to_cpu=False):
        x = np.array(features, dtype=np.float32, copy=True)
        raw = x.tobytes()
        off = self.feat.tell()
        self.feat.write(raw)
        out = self.inner.encode(features, to_cpu=to_cpu)
        y = np.array(out, dtype=np.float32, copy=True)
        n = self.n_encode
        self.n_encode += 1
        if self.enc_dir is not None:
            self.enc_dir.mkdir(parents=True, exist_ok=True)
            (self.enc_dir / f'{n}.f32').write_bytes(y.tobytes())
        self.live[id(out)] = (n, out)
        self.events.append({'k': 'encode', 'n': n, 'to_cpu': to_cpu, 'shape': list(x.shape), 'off': off, 'sha': sha(raw),
                            'out_shape': list(y.shape), 'out_sha': sha(y.tobytes())})
        return out

    def generate(self, encoder_output, prompts, **kw):
        res = self.inner.generate(encoder_output, prompts, **kw)
        n = self.handle(encoder_output)
        if self.inject and n % 4 and (n % 4 > 1 or kw.get('sampling_temperature', 0) == 0):
            res = [Result(sequences_ids=r.sequences_ids, sequences=r.sequences, scores=[s * 10 for s in r.scores],
                          no_speech_prob=0.95 if n % 4 == 3 else r.no_speech_prob) for r in res]
        self.events.append({'k': 'generate', 'enc': self.handle(encoder_output), 'prompts': [list(p) for p in prompts],
                            'kw': {k: (list(v) if isinstance(v, tuple) else v) for k, v in kw.items()},
                            'out': [{'seq': [list(s) for s in r.sequences_ids], 'scores': list(r.scores), 'nsp': r.no_speech_prob} for r in res]})
        return res

    def align(self, encoder_output, start_sequence, text_tokens, num_frames, **kw):
        res = self.inner.align(encoder_output, start_sequence, text_tokens, num_frames, **kw)
        self.n_align += 1
        if self.inject and self.n_align == 2:
            res = [Result(alignments=[], text_token_probs=list(r.text_token_probs)) for r in res]
        self.events.append({'k': 'align', 'enc': self.handle(encoder_output), 'start': list(start_sequence),
                            'text': [list(t) for t in text_tokens], 'num_frames': num_frames, 'kw': kw,
                            'out': [{'al': [list(p) for p in r.alignments], 'probs': list(r.text_token_probs)} for r in res]})
        return res

    def detect_language(self, encoder_output, **kw):
        res = self.inner.detect_language(encoder_output, **kw)
        self.events.append({'k': 'detect', 'enc': self.handle(encoder_output), 'kw': kw, 'out': [[list(p) for p in r] for r in res]})
        return res


def manifest(corpus):
    if corpus == 'edge':  # S4's own edge set (tools/make_edge.py)
        return json.loads((S4 / 'edge' / 'edge.json').read_text(encoding='utf-8'))['items']
    if corpus == 'viyt':
        files = sorted((EV.parent.parent / 'diarization-natural' / 'extract').glob('*.wav'))
        return [{'id': f'viyt-{f.stem}', 'path': str(f)} for f in files]
    return json.loads((EV / 'corpora' / f'{corpus}.json').read_text(encoding='utf-8'))['items']


def main():
    setup_env()
    worker = load_worker()
    import faster_whisper.transcribe as fwt
    from faster_whisper import WhisperModel

    rec = None
    gst, gcr = fwt.get_speech_timestamps, fwt.get_compression_ratio

    def speech_timestamps(audio, vad_options=None, **kw):
        out = gst(audio, vad_options, **kw)
        rec.events.append({'k': 'vad', 'n_samples': int(len(audio)), 'pcm_sha': sha(np.ascontiguousarray(audio, dtype=np.float32).tobytes()),
                           'speech': [{'start': int(s['start']), 'end': int(s['end'])} for s in out]})
        return out

    def compression_ratio(text):
        r = gcr(text)
        rec.events.append({'k': 'cr', 'text': text, 'ratio': r})
        return r

    fwt.get_speech_timestamps, fwt.get_compression_ratio = speech_timestamps, compression_ratio

    jobs = [line.split() for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines() if line.strip() and not line.startswith('#')]
    models = {}
    for corpus, model_name, mode, *only in jobs:
        only = set(only[0].split(',')) if only else None
        wait_for_ram()
        if model_name not in models:
            models.clear()  # one model in memory at a time
            m = WhisperModel(str(MODELS / f'whisper-{model_name}'), device='cpu', compute_type='int8', cpu_threads=THREADS, local_files_only=True)
            m.model = Recorder(m.model)
            models[model_name] = m
            print(f'loaded {model_name} with affinity {affinity()} (P-cores {P_CORES:04X})', flush=True)
        model = models[model_name]
        rec = model.model
        out_dir = S4 / 'rec' / corpus / model_name / mode
        (out_dir / 'feat').mkdir(parents=True, exist_ok=True)
        events_file = out_dir / 'events.jsonl'
        done = {json.loads(line)['id'] for line in events_file.read_text(encoding='utf-8').splitlines() if line.strip()} if events_file.exists() else set()
        lang0, with_words = (None if mode[0] == 'a' else 'vi'), mode[0] in ('w', 'a')
        rec.inject = mode.endswith('i')
        t_job = time.time()
        for it in manifest(corpus):
            if (only and it['id'] not in only) or it['id'] in done:
                continue
            t0 = time.time()
            audio = worker.load_audio(it['path'])
            pcm = np.ascontiguousarray(audio, dtype=np.float32).tobytes()
            pcm_path = S4 / 'rec' / 'pcm' / corpus / f'{it["id"]}.f32'
            pcm_path.parent.mkdir(parents=True, exist_ok=True)
            if pcm_path.exists():
                if sha(pcm_path.read_bytes()) != sha(pcm):
                    raise SystemExit(f'{it["id"]}: decode differs from the stored PCM')
            else:
                pcm_path.write_bytes(pcm)
            rec.events, rec.n_encode = [], 0
            rec.enc_dir = out_dir / 'enc' / it['id'] if (mode == 'w' and it['id'] in T1E) else None
            duration = max(len(audio) / worker.STT_RATE, 0.01)
            lang, rows, words, fallback = lang0, [], [], False
            with open(out_dir / 'feat' / f'{it["id"]}.f32', 'wb') as rec.feat:
                cuts = worker.stt_windows(audio)
                for start, end in zip(cuts, cuts[1:]):
                    rec.live.clear()
                    rec.n_align = 0
                    rec.events.append({'k': 'window', 'start': int(start), 'end': int(end), 'lang': lang, 'words': with_words})
                    try:
                        r, w, lang = worker.stt_window(model, audio[start:end], start / worker.STT_RATE, lang, with_words, duration, lambda *a: None)
                    except IndexError as error:  # stt(): the empty word alignment of faster-whisper 1.2.1; redo the window without word times
                        if not with_words:
                            raise
                        rec.events.append({'k': 'index_error', 'message': str(error)})
                        rec.live.clear()
                        r, w, lang = worker.stt_window(model, audio[start:end], start / worker.STT_RATE, lang, False, duration, lambda *a: None)
                        fallback = True
                    rec.events.append({'k': 'window_result', 'rows': r, 'words': w, 'lang': lang})
                    rows += r
                    words += w
            rec.live.clear()
            record = {'id': it['id'], 'n_samples': len(audio), 'pcm_sha': sha(pcm), 'audio_seconds': round(duration, 3),
                      'wall_seconds': round(time.time() - t0, 2), 'language': lang, 'words_fallback': fallback, 'segments': rows, 'words': words,
                      'events': rec.events}
            with events_file.open('a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
            print(f'{corpus} {model_name} {mode} {it["id"]} audio {duration:.0f}s wall {time.time() - t0:.1f}s events {len(rec.events)}', flush=True)
        print(f'done {corpus} {model_name} {mode} in {time.time() - t_job:.0f}s', flush=True)


if __name__ == '__main__':
    main()
