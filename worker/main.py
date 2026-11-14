"""Thanh Am Studio CPU worker. One request per process; stdout is JSONL only."""
from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import math
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid

ROOT = Path(__file__).resolve().parent


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def validate_request(request):
    if not isinstance(request, dict) or request.get('protocol') != 1:
        raise WorkerError('INVALID_REQUEST', 'Expected protocol version 1.')
    if not isinstance(request.get('id'), str) or not request['id']:
        raise WorkerError('INVALID_REQUEST', 'A request id is required.')
    if not isinstance(request.get('payload'), dict):
        raise WorkerError('INVALID_REQUEST', 'payload must be an object.')
    if request.get('operation') not in {'health', 'probe', 'tts', 'stt', 'render', 'download'}:
        raise WorkerError('INVALID_REQUEST', 'Unknown operation.')


def contained_path(root: Path, relative: str):
    root = root.resolve()
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        raise WorkerError('INVALID_PATH', 'Path must be inside the output directory.')
    return candidate


def number(value, name, low=0, high=86_400_000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise WorkerError('INVALID_RECIPE', f'{name} is outside the supported range.')
    return float(value)


# Engines can overshoot full scale; PCM conversion would hard-clip those samples.
PEAK_CEILING = 0.98
# Preset voices sample at 0.5 instead of the engine's 0.8: on 20 sentences x 3 takes, word errors fell from
# 1.01 % to 0.75 % (Whisper large-v3), 1.41 % to 1.01 % (turbo) and 4.40 % to 3.92 % (wav2vec2) with the same
# pitch range. Reference-voice cloning keeps the engine default (not measured).
PRESET_TEMPERATURE = 0.5


PAUSE_MARK = re.compile(r'\[\s*nghỉ\s+(\d+(?:[.,]\d+)?)\s*(ms|s|giây)?\s*\]', re.IGNORECASE)


def split_pauses(text):
    """'A [nghỉ 0.5s] B' -> ([('A', 0.0), ('B', 0.5)], trailing): each spoken part with the silence before it."""
    parts, pause, pos = [], 0.0, 0
    for m in PAUSE_MARK.finditer(text):
        if chunk := text[pos:m.start()].strip():
            parts.append((chunk, pause)); pause = 0.0
        seconds = float(m.group(1).replace(',', '.')) / (1000 if (m.group(2) or 's').lower() == 'ms' else 1)
        if not 0.05 <= seconds <= 10:
            raise WorkerError('INVALID_TEXT', 'Khoảng nghỉ phải từ 0,05 đến 10 giây.')
        pause += seconds; pos = m.end()
    if chunk := text[pos:].strip():
        parts.append((chunk, pause)); pause = 0.0
    if not parts:
        raise WorkerError('INVALID_TEXT', 'Đoạn chỉ có khoảng nghỉ, chưa có lời để đọc.')
    return parts, pause


def words(text):
    # <en>…</en> marks English words for the engine (the app's "read English words" switch); the tags are not spoken.
    return re.findall(r'\w+', re.sub(r'</?en>', ' ', PAUSE_MARK.sub(' ', text)).lower())


def compare_words(expected, heard):
    """Word error rate of `heard` against `expected` and the differing word spans."""
    import difflib
    ref, hyp = words(expected), words(heard)
    spans = []
    for op, a, b, c, d in difflib.SequenceMatcher(None, ref, hyp, autojunk=False).get_opcodes():
        if op != 'equal':
            # Whisper often confuses initials/finals that merge in southern speech; such spans are reported as soft.
            soft = b - a == d - c and all(merged(x) == merged(y) for x, y in zip(ref[a:b], hyp[c:d]))
            spans.append({'expected': ' '.join(ref[a:b]), 'heard': ' '.join(hyp[c:d]), 'soft': soft})
    errors = sum(max(len(s['expected'].split()), len(s['heard'].split())) for s in spans if not s['soft'])
    return round(errors / max(len(ref), 1), 3), spans


def merged(word):
    word = re.sub(r'^(tr|ch)', 'ch', re.sub(r'^(gi|d|r)', 'd', re.sub(r'^(x|s)', 's', word)))
    return re.sub(r'(ng|n)$', 'n', re.sub(r'(c|t)$', 't', word))


_CHECKERS = {}


def check_take(path, text, model_dir):
    """Listen back to a take with the installed Whisper model; a failed check never fails the take."""
    try:
        if model_dir not in _CHECKERS:
            verify_model(model_dir, 'whisper-small')
            from faster_whisper import WhisperModel
            _CHECKERS[model_dir] = WhisperModel(str(model_dir), device='cpu', compute_type='int8',
                cpu_threads=min(8, os.cpu_count() or 4), local_files_only=True)
        segments, _ = _CHECKERS[model_dir].transcribe(str(path), language='vi', beam_size=5,
            condition_on_previous_text=False)
        heard = ' '.join(s.text.strip() for s in segments)
        wer, mismatches = compare_words(text, heard)
        return {'model': 'whisper-small', 'wer': wer, 'heard': heard, 'mismatches': mismatches}
    except Exception as error:  # noqa: BLE001 - the take is still valid without a check
        return {'model': 'whisper-small', 'error': str(error)[:300]}


def voice_kwargs(item):
    kwargs = {'batch_size': 1}
    if item.get('reference_path'):
        reference = Path(item['reference_path'])
        if not reference.is_file():
            raise WorkerError('INPUT_MISSING', 'Reference voice file is missing.')
        kwargs['ref_audio'] = str(reference)
        return kwargs
    if item.get('voice_id'):
        kwargs['voice'] = item['voice_id']
    kwargs['temperature'] = PRESET_TEMPERATURE
    return kwargs


def limit_peak(audio):
    peak = float(abs(audio).max())
    return audio * (PEAK_CEILING / peak) if peak > PEAK_CEILING else audio


def clip_recipe(clip, source_duration):
    duration = number(source_duration, 'duration', 0.001)
    start = number(clip.get('trim_start_ms', 0), 'trim_start_ms')
    end = duration if clip.get('trim_end_ms') is None else number(clip['trim_end_ms'], 'trim_end_ms')
    if end > duration + 2 or end <= start:
        raise WorkerError('INVALID_RECIPE', 'Trim end must be after start and inside source duration.')
    length = min(end, duration) - start
    return {'start_ms': start, 'duration_ms': length,
            'fade_in_ms': min(number(clip.get('fade_in_ms', 0), 'fade_in_ms'), length),
            'fade_out_ms': min(number(clip.get('fade_out_ms', 0), 'fade_out_ms'), length),
            'gain_db': number(clip.get('gain_db', 0), 'gain_db', -60, 24),
            'gap_ms': number(clip.get('gap_ms', 0), 'gap_ms', 0, 600000)}


def executable(name, explicit=None):
    configured = explicit or os.environ.get('THANHAM_' + name.upper())
    candidate = configured or shutil.which(name)
    if not candidate or not Path(candidate).is_file():
        raise WorkerError('RUNTIME_MISSING', f'{name} is missing. Install the bundled audio runtime in Settings.')
    return str(Path(candidate).resolve())


def run_process(args):
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', errors='replace', creationflags=flags)
    if result.returncode:
        raise WorkerError('AUDIO_PROCESS_FAILED', result.stderr[-2500:] or 'Audio process failed.')
    return result.stdout


def stretch(audio, speed, ffmpeg):
    """Time-stretch mono 48 kHz float audio without changing pitch (FFmpeg atempo)."""
    import numpy as np
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    result = subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', '48000',
        '-ac', '1', '-i', 'pipe:0', '-af', f'atempo={speed}', '-f', 'f32le', 'pipe:1'],
        input=np.ascontiguousarray(audio, dtype=np.float32).tobytes(), capture_output=True, creationflags=flags)
    if result.returncode:
        raise WorkerError('AUDIO_PROCESS_FAILED', result.stderr.decode('utf-8', 'replace')[-2500:] or 'Speed change failed.')
    return np.frombuffer(result.stdout, dtype=np.float32).copy()


def probe(path, ffmpeg_path=None):
    path = Path(path).resolve()
    if not path.is_file():
        raise WorkerError('INPUT_MISSING', 'The selected media file no longer exists.')
    if ffmpeg_path:
        ffprobe = str(Path(ffmpeg_path).with_name('ffprobe.exe' if os.name == 'nt' else 'ffprobe'))
    else:
        ffprobe = executable('ffprobe')
    result = json.loads(run_process([ffprobe, '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'format=duration:stream=duration,sample_rate,channels', '-of', 'json', str(path)]))
    streams = result.get('streams', [])
    if not streams:
        raise WorkerError('NO_AUDIO', 'The file has no audio stream.')
    stream = streams[0]
    duration = result.get('format', {}).get('duration') or stream.get('duration')
    if duration is None:
        raise WorkerError('INVALID_MEDIA', 'Audio duration is unavailable.')
    return {'path': str(path), 'duration_ms': round(float(duration) * 1000),
            'sample_rate': int(stream['sample_rate']), 'channels': int(stream.get('channels', 1))}


def render(payload, output_dir: Path, progress):
    clips = payload.get('clips')
    if not isinstance(clips, list) or not 1 <= len(clips) <= 10000:
        raise WorkerError('INVALID_RECIPE', 'Select at least one audio take to export.')
    fmt = payload.get('format', 'wav')
    if fmt not in {'wav', 'mp3'}:
        raise WorkerError('INVALID_RECIPE', 'Supported export formats: wav, mp3.')
    ffmpeg = executable('ffmpeg', payload.get('ffmpeg_path'))
    output_dir.mkdir(parents=True, exist_ok=True)
    final = output_dir / f'{uuid.uuid4()}.{fmt}'
    partial = final.with_name(final.stem + '.partial.' + fmt)
    try:
        with tempfile.TemporaryDirectory(prefix='render-', dir=output_dir) as td:
            temp = Path(td)
            for i, clip in enumerate(clips):
                info = probe(clip['path'], ffmpeg)
                recipe = clip_recipe(clip, info['duration_ms'])
                length = recipe['duration_ms'] / 1000
                filters = [f"atrim=start={recipe['start_ms']/1000}:duration={length}", 'asetpts=PTS-STARTPTS',
                    'aresample=48000', 'aformat=sample_fmts=flt:channel_layouts=mono', f"volume={recipe['gain_db']}dB"]
                if recipe['fade_in_ms']:
                    filters.append(f"afade=t=in:st=0:d={recipe['fade_in_ms']/1000}")
                if recipe['fade_out_ms']:
                    fade = recipe['fade_out_ms'] / 1000
                    filters.append(f'afade=t=out:st={max(0,length-fade)}:d={fade}')
                if recipe['gap_ms']:
                    filters.append(f"apad=pad_dur={recipe['gap_ms']/1000}")
                run_process([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', clip['path'],
                    '-vn', '-af', ','.join(filters), '-c:a', 'pcm_f32le', str(temp / f'{i:06d}.wav')])
                progress((i + 1) / (len(clips) + 1), f'Rendered {i+1}/{len(clips)} segments')
            listing = temp / 'concat.txt'
            listing.write_text(''.join(f"file '{i:06d}.wav'\n" for i in range(len(clips))), encoding='utf-8')
            args = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', str(listing)]
            if payload.get('normalize', False):
                args += ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11']
            args += ['-ar', '48000', '-ac', '1']
            args += ['-c:a', 'pcm_s24le'] if fmt == 'wav' else ['-c:a', 'libmp3lame', '-b:a', '192k']
            run_process(args + [str(partial)])
            info = probe(partial, ffmpeg)
            os.replace(partial, final)
            return {**info, 'path': str(final)}
    finally:
        partial.unlink(missing_ok=True)


def registry():
    return json.loads((ROOT / 'models.json').read_text(encoding='utf-8'))['models']


def verify_file(path: Path, entry):
    if not path.is_file() or path.stat().st_size != entry['size']:
        raise WorkerError('MODEL_CHECKSUM', f'Model size mismatch: {path.name}')
    h = hashlib.sha256() if 'sha256' in entry else hashlib.sha1()
    if 'sha256' not in entry:
        h.update(f"blob {entry['size']}\0".encode())
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    if h.hexdigest() != entry.get('sha256', entry.get('git_blob_sha1')):
        raise WorkerError('MODEL_CHECKSUM', f'Model checksum mismatch: {path.name}')


def model_spec(model_id):
    for model in registry():
        if model['id'] == model_id:
            return model
    raise WorkerError('MODEL_UNKNOWN', 'Unknown model id.')


def verify_model(model_dir, expected_id=None):
    model_dir = Path(model_dir)
    marker = model_dir / 'installed.json'
    if not marker.is_file():
        raise WorkerError('MODEL_NOT_READY', 'Download this model in Model & settings first.')
    record = json.loads(marker.read_text(encoding='utf-8'))
    spec = model_spec(expected_id or record.get('model_id'))
    if record.get('model_id') != spec['id'] or record.get('revision') != spec['revision']:
        raise WorkerError('MODEL_CHECKSUM', 'Installed model revision differs from the registry. Download again.')
    for artifact in spec['artifacts']:
        verify_file(contained_path(model_dir, artifact['path']), artifact)
    return spec


def download(payload, models_dir: Path, progress):
    spec = model_spec(payload.get('model_id'))
    destination = contained_path(models_dir, spec['id'])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'installed.json').unlink(missing_ok=True)
    files = spec['artifacts']
    total = sum(item['size'] for item in files)
    missing = []
    for item in files:
        try:
            verify_file(contained_path(destination, item['path']), item)
        except WorkerError:
            missing.append(item)
    # Downloads land in a per-model staging folder (resumable), then move into place: no second copy.
    staging = contained_path(models_dir, f".download/{spec['id']}")
    need = sum(item['size'] for item in missing)
    free = shutil.disk_usage(models_dir).free
    if missing and free < need + 256 * 1024 * 1024:
        raise WorkerError('DISK_FULL', f'Không đủ dung lượng: cần khoảng {math.ceil(need / 2**20)} MB trống, còn {free // 2**20} MB.')
    done = total - need
    stop = threading.Event()
    def watch():
        while not stop.wait(1):
            partial = 0
            with contextlib.suppress(OSError):
                partial = sum(p.stat().st_size for p in staging.rglob('*') if p.is_file())
            progress(min(0.99, (done + partial) / total), 'Đang tải model')
    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    # Keep HF/Xet caches inside the app's model folder, never the user's global cache.
    os.environ['HF_HOME'] = str(models_dir / '.hf')
    # Plain HTTP streams into a resumable .incomplete file, so byte progress and resume are observable.
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    try:
        from huggingface_hub import hf_hub_download
        for item in missing:
            target = contained_path(destination, item['path'])
            try:
                fetched = Path(hf_hub_download(repo_id=item['repo'], filename=item['filename'], revision=item['revision'],
                    local_dir=str(staging)))
            except Exception as error:
                raise WorkerError('NETWORK', f'Không tải được {item["filename"]} ({type(error).__name__}). Kiểm tra mạng rồi bấm thử lại; phần đã tải được giữ lại.') from error
            try:
                verify_file(fetched, item)
            except WorkerError:
                fetched.unlink(missing_ok=True)
                raise
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(fetched, target)
            done += item['size']
            progress(min(0.99, done / total), 'Đã kiểm tra ' + item['filename'])
    finally:
        stop.set()
        watcher.join()
    shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(models_dir / '.hf', ignore_errors=True)
    marker = destination / 'installed.json'
    temp = marker.with_suffix('.partial')
    temp.write_text(json.dumps({'model_id': spec['id'], 'revision': spec['revision']}, indent=2), encoding='utf-8')
    os.replace(temp, marker)
    progress(1, 'Model sẵn sàng')
    return {'model_id': spec['id'], 'path': str(destination), 'revision': spec['revision']}


def offline_mode():
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'


def tts(payload, output_dir: Path, progress, emit_item=None):
    """Synthesize one item, or payload['items'] with one engine load, reporting each via emit_item."""
    model_dir = Path(payload.get('model_path', ''))
    verify_model(model_dir, 'vieneu-v3')
    batch = 'items' in payload
    items = payload['items'] if batch else [payload]
    if not isinstance(items, list) or not 1 <= len(items) <= 1000 or (batch and emit_item is None):
        raise WorkerError('INVALID_REQUEST', 'items must list 1..1000 segments.')
    for item in items:
        text = item.get('text', '') if isinstance(item, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > 100000:
            raise WorkerError('INVALID_TEXT', 'Supply non-empty text, at most 100,000 characters per segment.')
    offline_mode()
    import numpy as np
    import soundfile as sf
    from vieneu import Vieneu
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine
    # Pinned VieNeu does not forward codec_dir. Resolve only its known codec fetch
    # to our verified local directory for this constructor, then restore upstream.
    original_fetch = OnnxV3LiteEngine._fetch
    def local_fetch(repo, files, subfolder):
        if repo != 'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX':
            raise WorkerError('UNPINNED_MODEL', 'Unexpected model request from engine.')
        return model_dir / 'codec'
    progress(0.05, 'Loading local VieNeu CPU model')
    try:
        OnnxV3LiteEngine._fetch = staticmethod(local_fetch)
        engine = Vieneu(backend='onnx', device='cpu', precision='fp32',
            backbone_repo=str(model_dir / 'backbone'), onnx_dir=str(model_dir / 'backbone' / 'onnx_update'),
            max_batch_size=1, max_streams=1, threads=min(8, os.cpu_count() or 4))
    finally:
        OnnxV3LiteEngine._fetch = staticmethod(original_fetch)
    output_dir.mkdir(parents=True, exist_ok=True)

    def synth(item):
        kwargs = voice_kwargs(item)
        name = item.get('output_name') or f'{uuid.uuid4()}.wav'
        if Path(name).suffix.lower() != '.wav':
            raise WorkerError('INVALID_PATH', 'TTS output must be a WAV file.')
        final = contained_path(output_dir, name)
        if final.exists():
            raise WorkerError('OUTPUT_EXISTS', 'A take already exists at that output name.')
        parts, trailing = split_pauses(item['text'])
        speed = number(item.get('speed', 1), 'speed', 0.5, 2)
        ffmpeg = executable('ffmpeg', item.get('ffmpeg_path')) if speed != 1 else None
        spoken = lambda chunk: (lambda a: stretch(a, speed, ffmpeg) if ffmpeg else a)(
            np.asarray(engine.infer(chunk, **kwargs), dtype=np.float32))
        silence = lambda s: np.zeros(round(s * 48000), dtype=np.float32)
        audio = np.concatenate([piece for chunk, before in parts for piece in (silence(before), spoken(chunk))]
            + [silence(trailing)])
        if audio.size == 0 or not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 1e-7:
            raise WorkerError('INVALID_AUDIO', 'Engine returned empty, silent or non-finite audio.')
        partial = final.with_name(final.stem + '.partial.wav')
        try:
            sf.write(str(partial), limit_peak(audio), 48000, subtype='PCM_24')
            os.replace(partial, final)
        finally:
            partial.unlink(missing_ok=True)
        result = {'path': str(final), 'duration_ms': round(len(audio) / 48), 'sample_rate': 48000}
        if item.get('check_model_path'):
            result['check'] = check_take(final, item['text'], Path(item['check_model_path']))
        return result

    if not batch:
        progress(0.3, 'Synthesizing speech')
        return synth(items[0])
    for i, item in enumerate(items):
        progress(0.1 + 0.9 * i / len(items), f'Synthesizing {i+1}/{len(items)}')
        try:
            emit_item(i, result=synth(item))
        except WorkerError as error:
            emit_item(i, error={'code': error.code, 'message': str(error)})
        except Exception as error:  # one bad segment must not lose the rest of the batch
            emit_item(i, error={'code': 'WORKER_ERROR', 'message': f'{type(error).__name__}: {error}'})
    return {'count': len(items)}


STT_RATE = 16000
STT_WINDOW_S = 600  # faster-whisper builds the log-mel spectrogram of its whole input at once (~3.8 GB for 70 min)


def stt_windows(audio, rate=STT_RATE, window_s=STT_WINDOW_S, search_s=30):
    """Sample offsets that split long audio into <= window_s pieces, each cut at the quietest 100 ms
    frame of the last search_s seconds so words are not split."""
    frame, cuts = rate // 10, [0]
    while len(audio) - cuts[-1] > window_s * rate:
        lo = cuts[-1] + (window_s - search_s) * rate
        energy = (audio[lo:lo + search_s * rate].reshape(-1, frame) ** 2).mean(axis=1)
        cuts.append(lo + int(energy.argmin()) * frame + frame // 2)
    return cuts + [len(audio)]


def load_audio(path):
    from faster_whisper.audio import decode_audio
    return decode_audio(str(path), sampling_rate=STT_RATE)


def stt_window(model, audio, offset, lang, with_words, duration, progress):
    """Transcribe one window: its rows, each row's words (empty without word times) and the language used."""
    segments, info = model.transcribe(audio, language=lang,
        beam_size=5, vad_filter=True, condition_on_previous_text=False, word_timestamps=with_words)
    rows, words = [], []
    for segment in segments:
        rows.append({'start': offset + segment.start, 'end': offset + segment.end, 'text': segment.text.strip()})
        words.append([{'start': offset + w.start, 'end': offset + w.end, 'text': w.word} for w in segment.words or []] if with_words else [])
        # Linear in audio time, so the queue's remaining-time estimate is not skewed early on.
        progress(max(0.05, min(0.99, (offset + segment.end) / duration)), 'Transcribing')
    return rows, words, info.language  # an 'auto' detection from the first window applies to the rest


def stt(payload, progress):
    speakers = payload.get('num_speakers')
    if speakers is not None and (isinstance(speakers, bool) or not isinstance(speakers, int) or not 1 <= speakers <= 8):
        raise WorkerError('INVALID_RECIPE', 'num_speakers must be a whole number from 1 to 8.')
    model_dir = Path(payload.get('model_path', ''))
    spec = verify_model(model_dir)
    if spec['engine'] != 'faster-whisper':
        raise WorkerError('MODEL_UNKNOWN', 'Select a Whisper model for transcription.')
    source = Path(payload.get('input_path', ''))
    if not source.is_file():
        raise WorkerError('INPUT_MISSING', 'Input audio/video is missing.')
    language = payload.get('language', 'vi')
    if language not in {'vi', 'auto'}:
        raise WorkerError('INVALID_REQUEST', 'language must be vi or auto.')
    offline_mode()
    from faster_whisper import WhisperModel
    progress(0.05, 'Loading local Whisper CPU model')
    model = WhisperModel(str(model_dir), device='cpu', compute_type='int8',
        cpu_threads=min(8, os.cpu_count() or 4), local_files_only=True)
    audio = load_audio(source)
    duration = max(len(audio) / STT_RATE, 0.01)
    lang, result, words = None if language == 'auto' else language, [], []
    diarizing = bool(payload.get('diarize_model_path'))  # word times let rows split where the speaker changes
    cuts = stt_windows(audio)
    for start, end in zip(cuts, cuts[1:]):
        window = lambda with_words: stt_window(model, audio[start:end], start / STT_RATE, lang, with_words, duration, progress)
        try:
            rows, row_words, lang = window(diarizing)
        except IndexError:
            if not diarizing:
                raise
            # faster-whisper 1.2.1 with CTranslate2 >= 4.8.1 fails on an empty word alignment (a tiny last VAD chunk;
            # fixed upstream in SYSTRAN/faster-whisper#1460, not released): redo the window without word times, so its
            # rows keep one speaker each instead of the whole transcript being lost.
            rows, row_words, lang = window(False)
        result += rows; words += row_words
    response = {'segments': result, 'language': lang}
    if diarizing:
        progress(0.99, 'Separating speakers')
        try:
            model = Path(payload['diarize_model_path'])
            verify_model(model, 'diarization')
            spec = importlib.util.spec_from_file_location('diarize', ROOT / 'diarize.py')  # -I drops the script dir from sys.path
            diarize = importlib.util.module_from_spec(spec); spec.loader.exec_module(diarize)
            response['segments'] = diarize.split_rows(result, words, diarize.diarize(audio, model, speakers))
        except Exception as error:  # noqa: BLE001 - the transcript is still valid without speakers
            response['diarize_error'] = str(error)[:300]
    return response


def health():
    # Import for real: native extensions only fail at load time (e.g. a missing MSVC runtime DLL).
    def loads(name):
        try:
            importlib.import_module(name)
            return True
        except Exception:
            return False
    modules = {name: loads(name) for name in ['numpy', 'soundfile', 'onnxruntime', 'ctranslate2', 'av', 'vieneu', 'faster_whisper', 'huggingface_hub']}
    return {'python': sys.version.split()[0], 'modules': modules,
        'ffmpeg': os.environ.get('THANHAM_FFMPEG') or shutil.which('ffmpeg'),
        'ready': all(modules.values())}


def main():
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    wire = sys.stdout
    request_id = 'unknown'
    lock = threading.Lock()
    def emit(event, **values):
        with lock:
            wire.write(json.dumps({'protocol': 1, 'id': request_id, 'event': event, **values}, ensure_ascii=False, allow_nan=False) + '\n')
            wire.flush()
    def progress(value, message=''):
        emit('progress', progress=max(0, min(1, value)), message=message)
    try:
        raw = sys.stdin.readline(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise WorkerError('INVALID_REQUEST', 'Request exceeds 4 MiB.')
        request = json.loads(raw.lstrip('\ufeff'))  # Windows PowerShell 5 prefixes piped text with a BOM
        if isinstance(request, dict):
            request_id = request.get('id', 'unknown')
        validate_request(request)
        payload = request['payload']
        operation = request['operation']
        output_dir = Path(request.get('output_dir') or tempfile.gettempdir()).resolve()
        models_dir = Path(request.get('models_dir') or tempfile.gettempdir()).resolve()
        # SDK prints belong on stderr, never on our protocol stream.
        with contextlib.redirect_stdout(sys.stderr):
            if operation == 'health': result = health()
            elif operation == 'probe': result = probe(payload['input_path'], payload.get('ffmpeg_path'))
            elif operation == 'render': result = render(payload, output_dir, progress)
            elif operation == 'download': result = download(payload, models_dir, progress)
            elif operation == 'tts': result = tts(payload, output_dir, progress, lambda index, **v: emit('item', index=index, **v))
            else: result = stt(payload, progress)
        emit('result', result=result)
        return 0
    except WorkerError as error:
        emit('error', code=error.code, message=str(error))
    except ImportError as error:
        emit('error', code='RUNTIME_MISSING', message=f'Missing runtime dependency: {error.name}. Install the CPU runtime.')
    except Exception as error:
        emit('error', code='WORKER_ERROR', message=f'{type(error).__name__}: {error}')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
