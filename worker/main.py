"""Thanh Am Studio CPU worker. One request per process; stdout is JSONL only."""
from __future__ import annotations

import contextlib
import errno
import gc
import hashlib
import importlib
import io
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
import time
import uuid
import zlib

ROOT = Path(__file__).resolve().parent


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def replace_with_retry(src, dst):
    """os.replace that waits out a file an antivirus scan or indexer holds for a moment (Windows WinError 32 raises PermissionError); about 1.4 s in all, then the last error is raised."""
    for attempt in range(8):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.2)


def validate_request(request):
    if not isinstance(request, dict) or request.get('protocol') != 1:
        raise WorkerError('INVALID_REQUEST', 'Expected protocol version 1.')
    if not isinstance(request.get('id'), str) or not request['id']:
        raise WorkerError('INVALID_REQUEST', 'A request id is required.')
    if not isinstance(request.get('payload'), dict):
        raise WorkerError('INVALID_REQUEST', 'payload must be an object.')
    if request.get('operation') not in {'health', 'probe', 'tts', 'stt', 'render', 'download', 'clone_preview', 'separate'}:
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
# A new take's leading and trailing silence is left out by its segment's trim (non-destructive, editable): speech runs from the
# first to the last sample above max(1e-3, 2 % of peak), plus this margin (cit-voice-studio's _trim_edges uses 40 ms). On 162
# takes, Whisper Small heard the first or last word of short inputs differently more often at 40 ms ("lục" as "lúc", "không" as
# "khùng") than at 80 ms; 80 ms still cuts a median 106 ms (max 384 ms) of trailing silence.
EDGE_MARGIN_S = 0.08
# One unspaced token costs about N^3 in the pinned sea-g2p's normaliser and G2P: phonemizing one token took 0.13 s at 300
# characters, 0.73 s at 600 and 6.5 s at 1,200 (and 16,000 characters ran for minutes). 600 is more than twice a 256-character chunk,
# so no word the chunker can split reaches it; a longer token is refused instead of stalling the batch.
MAX_TOKEN_CHARS = 600


# Any bracket that opens with nghỉ or pause, or with unaccented nghi when bare or followed by a digit, is a pause mark (src/domain.ts PAUSE_MARK); PAUSE_VALUE reads the valid ones, the rest are dropped.
PAUSE_MARK = re.compile(r'\[\s*(?:(?:nghỉ|pause)(?!\w)[^\]]*|nghi\s*(?:\d[^\]]*)?)\]', re.IGNORECASE)
PAUSE_VALUE = re.compile(r'\[\s*(?:nghỉ|nghi|pause)\s*(?:(\d+(?:[.,]\d+)?)\s*(ms|seconds?|sec|s|giây|giay)?\s*)?\]', re.IGNORECASE)


def pause_seconds(mark):
    """Seconds of a pause mark (bare = 1 s, no unit = seconds), or None when it does not parse."""
    if not (m := PAUSE_VALUE.fullmatch(mark)):
        return None
    return 1.0 if m.group(1) is None else float(m.group(1).replace(',', '.')) / (1000 if (m.group(2) or 's').lower() == 'ms' else 1)


def split_pauses(text):
    """'A [nghỉ 0.5s] B' -> ([('A', 0.0), ('B', 0.5)], trailing): each spoken part with the silence before it. Unparsable marks are dropped; a run of marks and the spaces around it become one space (none at the edges or before , . ; : ! ? …)."""
    def drop(run):
        kept = [m.group(0) for m in PAUSE_MARK.finditer(run.group(0)) if pause_seconds(m.group(0)) is not None]
        if kept:
            return ''.join(kept)
        return '' if run.start() == 0 or run.end() == len(text) or text[run.end()] in ',.;:!?…' else ' '
    text = re.sub(rf'\s*(?:{PAUSE_MARK.pattern}\s*)+', drop, text, flags=re.IGNORECASE)
    parts, pause, pos = [], 0.0, 0
    for m in PAUSE_MARK.finditer(text):
        if chunk := text[pos:m.start()].strip():
            parts.append((chunk, pause)); pause = 0.0
        seconds = pause_seconds(m.group(0))
        if not 0.05 <= seconds <= 10:
            raise WorkerError('INVALID_TEXT', 'Khoảng nghỉ phải từ 0,05 đến 10 giây.')
        pause += seconds; pos = m.end()
    if chunk := text[pos:].strip():
        parts.append((chunk, pause)); pause = 0.0
    if not parts:
        raise WorkerError('INVALID_TEXT', 'Đoạn chỉ có khoảng nghỉ, chưa có lời để đọc.')
    return parts, pause


# Non-verbal cues the engine maps to emotion tokens (src/domain.ts CUE_MARK); they reach it unchanged and are not spoken words.
CUE_MARK = re.compile(r'\[\s*(?:chuckle|cười|cuoi|sigh|thở dài|tho dai|clear throat|hắng giọng|hang giong)\s*\]', re.IGNORECASE)


def words(text):
    # <en>…</en> marks English words for the engine (the app's "read English words" switch); the tags are not spoken.
    return re.findall(r'\w+', re.sub(r'</?en>', ' ', CUE_MARK.sub(' ', PAUSE_MARK.sub(' ', text))).lower())


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
            condition_on_previous_text=False, word_timestamps=True)
        segments = list(segments)
        heard = ' '.join(s.text.strip() for s in segments)
        wer, mismatches = compare_words(text, heard)
        # Where each heard word starts in the take; the app times subtitle cues inside the segment from these.
        timed = [{'text': w.word.strip(), 'start_ms': round(w.start * 1000)} for s in segments for w in s.words or []]
        return {'model': 'whisper-small', 'wer': wer, 'heard': heard, 'mismatches': mismatches, 'words': timed}
    except Exception as error:  # noqa: BLE001 - the take is still valid without a check
        return {'model': 'whisper-small', 'error': str(error)[:300]}


def vietnamese_reading(phonemize):
    """The pinned sea-g2p reads a chunk made only of words that are also English ('y', 'in', 'to do') as English, but
    untagged text is Vietnamese: put a Vietnamese-only word after the chunk and cut its phonemes off again."""
    def read(text):
        phonemes, body = phonemize(text), text.rstrip(' .!?,;:')
        if not body or not text.isascii() or any(c in text for c in '<[|') or len(body.split()) > 3:  # accents and tags decide themselves
            return phonemes
        spoken = ' '.join(phonemize(body + ' ơi' + text[len(body):]).split(' ')[:-1])
        return spoken.rstrip(' .!?,;:') + phonemes[len(phonemes.rstrip(' .!?,;:')):]
    return read


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


CLONE_SECONDS = 8.0  # pinned VieNeu clones from the first 8 s of a reference (_MAX_REF_SECONDS)


def clone_window(audio, sr, seconds=CLONE_SECONDS):
    """(start, end) samples of the `seconds` of mono `audio` with the most speech; all of it when not longer.
    Speech is 20 ms frames within 35 dB of the loudest; the start moves to the first word after a pause within a second.
    After candidate_windows in bunyu/VieNeu-TTS apps/voice_lab.py at f276060e (Apache-2.0), best window only; unlike it,
    the clip start counts as a pause and the window is never cut short at the end."""
    import numpy as np
    size, hop = int(seconds * sr), max(1, sr // 50)
    if len(audio) <= size:
        return 0, len(audio)
    count, width = len(audio) // hop, size // hop
    energy = np.sqrt(np.mean(np.square(audio[:count * hop].reshape(count, hop)), axis=1) + 1e-12)
    voiced = 20 * np.log10(energy / float(energy.max())) > -35
    score = np.convolve(voiced.astype(np.float64), np.ones(width), mode='valid')
    at = start = int(np.argmax(score))  # the first best window, so speech from the very start keeps the first seconds
    for f in range(at, min(at + 50, len(score))):
        if voiced[f] and not voiced[max(0, f - 3):f].any():
            start = max(0, f - 2)
            break
    start = min(start * hop, len(audio) - size)  # width * hop falls short of size when hop does not divide it
    return start, start + size


def clone_reference(path):
    """A temporary WAV with the best CLONE_SECONDS of the reference at `path` for the caller to delete, or `path`
    itself when it is not longer or soundfile cannot read it."""
    import soundfile as sf
    try:
        audio, sr = sf.read(path, dtype='float32', always_2d=True)
    except Exception:  # VieNeu reads it with soundfile too and reports the error as before
        return path
    start, end = clone_window(audio.mean(axis=1), sr)
    if end - start >= len(audio):
        return path
    fd, crop = tempfile.mkstemp(prefix='clone-ref-', suffix='.wav')
    os.close(fd)
    try:
        sf.write(crop, audio[start:end], sr, subtype='FLOAT')
    except Exception:  # e.g. a full %TEMP%: clone from the whole sample as before
        with contextlib.suppress(OSError):
            Path(crop).unlink()
        return path
    return crop


def clone_preview(payload, output_dir: Path, progress):
    """The reference as VieNeu enrolls it in a cloned tts(), to listen to: the clone_reference crop, VieNeu's own silence trim,
    its first _MAX_REF_SECONDS and its denoiser, saved as a 44.1 kHz WAV."""
    model_dir = Path(payload.get('model_path', ''))
    verify_model(model_dir, 'vieneu-v3')
    reference = Path(payload.get('reference_path') or '')
    if not reference.is_file():
        raise WorkerError('INPUT_MISSING', 'Reference voice file is missing.')
    offline_mode()
    import soundfile as sf
    from vieneu.v3turbo import V3TurboVieNeuTTS
    from vieneu._v3_turbo_engine.onnx_runtime_lite import _MAX_REF_SECONDS
    from vieneu._v3_turbo_engine.onnx_denoiser import OnnxDenoiser
    output_dir.mkdir(parents=True, exist_ok=True)
    final = contained_path(output_dir, payload.get('output_name') or f'{uuid.uuid4()}.wav')
    partial = final.with_name(final.stem + '.partial.wav')
    progress(0.1, 'Cleaning the voice sample')
    fd, trimmed = tempfile.mkstemp(prefix='clone-trim-', suffix='.wav')
    os.close(fd)
    crop = None
    try:
        crop = clone_reference(str(reference))  # the same call as tts()
        V3TurboVieNeuTTS._preclean_reference_audio(crop, out_path=trimmed)
        wav, sr = sf.read(trimmed, dtype='float32', always_2d=True)  # as the engine's _load_mono reads it
        clean = OnnxDenoiser(str(model_dir / 'backbone' / 'denoiser.onnx')).denoise(wav.mean(axis=1)[:int(_MAX_REF_SECONDS * sr)], sr)
        sf.write(str(partial), clean, 44100, subtype='PCM_24')
        replace_with_retry(partial, final)
    finally:
        partial.unlink(missing_ok=True)
        Path(trimmed).unlink(missing_ok=True)
        if crop not in (None, str(reference)):
            Path(crop).unlink(missing_ok=True)
    return {'path': str(final), 'duration_ms': round(len(clean) / 44.1), 'sample_rate': 44100}


def speech_edges(audio, keep_start=False, keep_end=False):
    """(start_ms, end_ms) of the speech in 48 kHz audio; end_ms is None when it runs to the end. keep_* leaves an edge alone."""
    import numpy as np
    level = np.abs(audio)
    loud = np.flatnonzero(level > max(1e-3, 0.02 * float(level.max())))
    if not loud.size:
        return 0, None
    margin = round(EDGE_MARGIN_S * 48000)
    start = 0 if keep_start else max(0, int(loud[0]) - margin)
    end = len(audio) if keep_end else min(len(audio), int(loud[-1]) + 1 + margin)
    return round(start / 48), None if end >= len(audio) else round(end / 48)


def limit_peak(audio, peak=None):
    """Scale audio down so its peak (or the given one, to scale two files alike) stays under PEAK_CEILING."""
    peak = float(abs(audio).max()) if peak is None else peak
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


def loudness(ffmpeg, inputs, graph):
    """Integrated loudness in LUFS (EBU R128; -inf for silence) of the audio the filtergraph `graph` makes from `inputs`."""
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    result = subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-nostats', *inputs, '-filter_complex', graph + ',loudnorm=print_format=json',
        '-f', 'null', '-'], capture_output=True, text=True, encoding='utf-8', errors='replace', creationflags=flags)
    if result.returncode:
        raise WorkerError('AUDIO_PROCESS_FAILED', result.stderr[-2500:] or 'Loudness measurement failed.')
    log = result.stderr  # loudnorm prints its measurement as the last JSON object
    return float(json.loads(log[log.rindex('{'):log.rindex('}') + 1])['input_i'])


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


EXPORT_CODECS = {'wav': ['-c:a', 'pcm_s24le'], 'mp3': ['-c:a', 'libmp3lame', '-b:a', '192k'],
    'm4a': ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'], 'flac': ['-c:a', 'flac', '-sample_fmt', 's32'],  # s32 = 24-bit FLAC
    'opus': ['-c:a', 'libopus', '-b:a', '128k']}


def render(payload, output_dir: Path, progress):
    clips = payload.get('clips')
    if not isinstance(clips, list) or not 1 <= len(clips) <= 10000:
        raise WorkerError('INVALID_RECIPE', 'Select at least one audio take to export.')
    fmt = payload.get('format', 'wav')
    if fmt not in EXPORT_CODECS:
        raise WorkerError('INVALID_RECIPE', f"Supported export formats: {', '.join(EXPORT_CODECS)}.")
    ffmpeg = executable('ffmpeg', payload.get('ffmpeg_path'))
    # Subtitle timeline: each clip starts at its at_ms (silence fills the wait), sped up by its rate, and the output runs at least
    # to pad_to_ms; the gaps are not used. The places come from the app's dub plan; this only applies them.
    timeline = payload.get('timeline') is True
    pad_to = round(number(payload.get('pad_to_ms', 0), 'pad_to_ms', 0, 86400000) * 48) if timeline else 0
    # The source's background (a separate job's stem) under the dub: both start at sample 0 of the same media.
    background = payload.get('background_path')
    if background and not timeline:
        raise WorkerError('INVALID_BACKGROUND', 'A background is mixed only under the subtitle timeline.')
    if background:
        probe(background, ffmpeg)  # a missing stem fails before the clips are rendered
    written = 0  # samples of the clips rendered so far, at 48 kHz
    output_dir.mkdir(parents=True, exist_ok=True)
    final = output_dir / f'{uuid.uuid4()}.{fmt}'
    partial = final.with_name(final.stem + '.partial.' + fmt)
    try:
        with tempfile.TemporaryDirectory(prefix='render-', dir=output_dir) as td:
            temp = Path(td)
            for i, clip in enumerate(clips):
                info = probe(clip['path'], ffmpeg)
                recipe = clip_recipe(clip, info['duration_ms'])
                rate = number(clip.get('rate', 1), 'rate', 1, 2) if timeline else 1
                # A take read at another speed fits its cue from its reading before the speed change: one stretch, not two.
                source, scale = ((clip['raw_path'], number(clip.get('speed'), 'speed', 0.5, 2))
                    if rate != 1 and clip.get('raw_path') else (clip['path'], 1))
                length = recipe['duration_ms'] / 1000 * scale
                filters = [f"atrim=start={recipe['start_ms']/1000*scale}:duration={length}", 'asetpts=PTS-STARTPTS',
                    'aresample=48000', 'aformat=sample_fmts=flt:channel_layouts=mono', f"volume={recipe['gain_db']}dB"]
                if recipe['fade_in_ms']:
                    filters.append(f"afade=t=in:st=0:d={recipe['fade_in_ms']/1000*scale}")
                if recipe['fade_out_ms']:
                    fade = recipe['fade_out_ms'] / 1000 * scale
                    filters.append(f'afade=t=out:st={max(0,length-fade)}:d={fade}')
                if timeline:
                    wait = max(0, round(number(clip.get('at_ms'), 'at_ms', 0, 86400000) * 48) - written)
                    filters += [f'atempo={rate*scale}'] * (rate * scale != 1) + [f'adelay=delays={wait}S:all=1'] * (wait > 0)
                    if i == len(clips) - 1 and pad_to > written:
                        filters.append(f'apad=whole_len={pad_to - written}')
                elif recipe['gap_ms']:
                    filters.append(f"apad=pad_dur={recipe['gap_ms']/1000}")
                run_process([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
                    '-vn', '-af', ','.join(filters), '-c:a', 'pcm_f32le', str(temp / f'{i:06d}.wav')])
                if timeline:
                    import soundfile as sf
                    written += sf.info(str(temp / f'{i:06d}.wav')).frames
                progress((i + 1) / (len(clips) + 1), f'Rendered {i+1}/{len(clips)} segments')
            listing = temp / 'concat.txt'
            listing.write_text(''.join(f"file '{i:06d}.wav'\n" for i in range(len(clips))), encoding='utf-8')
            inputs = ['-f', 'concat', '-safe', '1', '-i', str(listing)] + (['-i', background] if background else [])
            args = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', *inputs]
            if background:
                # pan, not aformat: aformat's stereo upmix lowers each channel by 3 dB. amix at 0 dB each (normalize=0), as long as
                # the longer input; no loop, stretch or fade.
                mix = ('[0:a]pan=stereo|c0=c0|c1=c0[v];[1:a]aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo[b];'
                    '[v][b]amix=inputs=2:duration=longest:normalize=0')
                # Normalising applies one gain to -16 LUFS measured over the whole mix: loudnorm's single pass is dynamic and would
                # swell the bed between lines (its linear mode turns dynamic when the true-peak target cannot be met).
                lufs = loudness(ffmpeg, inputs, mix) if payload.get('normalize', False) else -16
                gain = -16 - lufs if math.isfinite(lufs) else 0
                # A latency-compensated limiter keeps the sum below full scale without moving the takes.
                args += ['-filter_complex', f'{mix},volume={gain:.3f}dB,alimiter=limit=0.98:level=0:latency=1', '-ar', '48000', '-ac', '2']
            else:
                if payload.get('normalize', False):
                    # asetpts: loudnorm emits 100 ms frames, so M4A and Opus would report a length rounded up to them
                    args += ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,asetpts=N/SR/TB']
                args += ['-ar', '48000', '-ac', '1']
            args += EXPORT_CODECS[fmt]
            run_process(args + [str(partial)])
            info = probe(partial, ffmpeg)
            replace_with_retry(partial, final)
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
    if spec.get('kind') == 'runtime':
        return install_pack(spec, payload, models_dir, progress)
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
            replace_with_retry(fetched, target)
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
    replace_with_retry(temp, marker)
    progress(1, 'Model sẵn sàng')
    return {'model_id': spec['id'], 'path': str(destination), 'revision': spec['revision']}


PACK_PATH_LIMIT = 259  # MAX_PATH - 1: DLL loading has no long-path opt-in
PACK_MANIFEST = 'MANIFEST.sha256'


def parse_pack_manifest(text):
    """`<sha256>  <size>  <path>` per line, as scripts/build_pack.py writes it: a list of (sha256, size, path)."""
    entries = []
    for line in text.splitlines():
        digest, size, rel = line.split('  ', 2)
        entries.append((digest, int(size), rel))
    return entries


def pack_path_check(destination: Path, longest: int):
    if len(str(destination)) + 1 + longest > PACK_PATH_LIMIT:
        raise WorkerError('PACK_PATH_TOO_LONG', 'Đường dẫn thư mục dữ liệu quá dài nên không cài được gói tách nhạc nền.')


def file_sha256(path: Path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verify_pack(destination: Path, manifest_sha256, progress=None):
    """Re-hashes an installed pack against its manifest and reports files that are not in it. On any problem the marker is
    removed, so the app offers the download again, and MODEL_CHECKSUM is raised."""
    manifest = destination / PACK_MANIFEST
    problems = []
    if not manifest.is_file() or file_sha256(manifest) != manifest_sha256:
        problems.append(f'{PACK_MANIFEST} differs from its pin')
    else:
        entries = parse_pack_manifest(manifest.read_text(encoding='utf-8'))
        listed = {rel for _, _, rel in entries} | {PACK_MANIFEST, 'installed.json'}
        for i, (digest, size, rel) in enumerate(entries):
            path = destination / rel
            if not path.is_file():
                problems.append(f'missing: {rel}')
            elif path.stat().st_size != size or file_sha256(path) != digest:
                problems.append(f'changed: {rel}')
            if progress and i % 200 == 0:
                progress(min(0.99, i / len(entries)), 'Đang kiểm tra gói')
        problems += [f'extra: {rel}' for rel in (p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()) if rel not in listed]
    if problems:
        (destination / 'installed.json').unlink(missing_ok=True)
        raise WorkerError('MODEL_CHECKSUM', f'Gói chạy tách nhạc nền bị thay đổi hoặc hỏng ({len(problems)} vấn đề, ví dụ: {problems[0]}). Bấm Tải để cài lại gói.')


def fetch_pack(url, part: Path, size, progress):
    """Downloads url into part, resuming from the bytes already there."""
    import urllib.error
    import urllib.request
    have = part.stat().st_size if part.is_file() else 0
    if have > size:
        part.unlink()
        have = 0
    if have == size:
        return
    request = urllib.request.Request(url, headers={'Range': f'bytes={have}-', 'User-Agent': 'ThanhAmStudio'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if have and response.status != 206:
                have = 0  # the server ignored the range: start over
            with part.open('ab' if have else 'wb') as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    have += len(chunk)
                    progress(min(0.85, 0.85 * have / size), 'Đang tải gói tách nhạc nền')
    except (urllib.error.URLError, OSError) as error:
        raise WorkerError('NETWORK', f'Không tải được gói tách nhạc nền ({type(error).__name__}). Kiểm tra mạng rồi bấm thử lại; phần đã tải được giữ lại.') from error


def install_pack(spec, payload, models_dir: Path, progress):
    """The separation runtime pack (a zip of Python + PyTorch + Demucs): installs it into models/<id>/, or, when that
    revision is already installed, re-verifies it. The marker is written last, so a cut-off install is never ready."""
    import zipfile
    pin = spec['pack']
    destination = contained_path(models_dir, spec['id'])
    marker = destination / 'installed.json'
    record = json.loads(marker.read_text(encoding='utf-8')) if marker.is_file() else {}
    if record.get('model_id') == spec['id'] and record.get('revision') == spec['revision']:
        verify_pack(destination, record.get('manifest_sha256'), progress)
        progress(1, 'Gói sẵn sàng')
        return {'model_id': spec['id'], 'path': str(destination), 'revision': spec['revision'], 'verified': True}
    if not payload.get('license_accepted_at'):
        raise WorkerError('LICENSE_NOT_ACCEPTED', 'Cần đồng ý giấy phép Intel oneMKL trước khi tải gói tách nhạc nền.')
    if not pin.get('size'):
        raise WorkerError('MODEL_NOT_READY', 'Gói chạy tách nhạc nền chưa được phát hành.')
    pack_path_check(destination, pin.get('longest_path', 0))
    staging = contained_path(models_dir, f".download/{spec['id']}")
    staging.mkdir(parents=True, exist_ok=True)
    part = staging / (pin['url'].rsplit('/', 1)[-1] + '.part')
    need = pin['size'] + pin.get('unpacked_size', 0)
    free = shutil.disk_usage(models_dir).free
    if free < need + 256 * 1024 * 1024:
        raise WorkerError('DISK_FULL', f'Không đủ dung lượng: cần khoảng {math.ceil(need / 2**20)} MB trống, còn {free // 2**20} MB.')
    fetch_pack(pin['url'], part, pin['size'], progress)
    progress(0.86, 'Đang kiểm tra gói')
    if part.stat().st_size != pin['size'] or file_sha256(part) != pin['sha256']:
        part.unlink(missing_ok=True)
        raise WorkerError('MODEL_CHECKSUM', 'Gói tải về không khớp mã kiểm tra. Bấm Tải để tải lại.')
    try:
        with zipfile.ZipFile(part) as archive:
            manifest_bytes = archive.read(PACK_MANIFEST)
            if hashlib.sha256(manifest_bytes).hexdigest() != pin['manifest_sha256']:
                raise WorkerError('MODEL_CHECKSUM', f'{PACK_MANIFEST} của gói không khớp mã ghim.')
            entries = parse_pack_manifest(manifest_bytes.decode('utf-8'))
            names = {rel for _, _, rel in entries}
            members = {m.filename for m in archive.infolist()}
            if members != names | {PACK_MANIFEST} or len(members) != len(archive.infolist()):
                raise WorkerError('MODEL_CHECKSUM', 'Gói chứa tệp không có trong danh sách.')
            for rel in names:  # zip-slip: every name stays inside the destination, as a plain relative path
                if '\\' in rel or ':' in rel or rel.startswith('/') or '..' in rel.split('/'):
                    raise WorkerError('INVALID_PATH', 'Tên tệp trong gói không hợp lệ.')
            # Checked on the manifest's own longest path, before anything is extracted.
            pack_path_check(destination, max(len(rel) for rel in names))
            if destination.exists():
                shutil.rmtree(destination)  # an older revision or a cut-off install
            destination.mkdir(parents=True)
            (destination / PACK_MANIFEST).write_bytes(manifest_bytes)
            done = 0
            for digest, size, rel in entries:
                target = contained_path(destination, rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                h = hashlib.sha256()
                with archive.open(rel) as source, target.open('wb') as out:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        h.update(chunk)
                        out.write(chunk)
                if h.hexdigest() != digest or target.stat().st_size != size:
                    raise WorkerError('MODEL_CHECKSUM', f'Tệp trong gói không khớp mã kiểm tra: {rel}')
                done += 1
                if done % 100 == 0:
                    progress(min(0.99, 0.87 + 0.12 * done / len(entries)), 'Đang giải nén gói')
    except zipfile.BadZipFile as error:
        part.unlink(missing_ok=True)
        raise WorkerError('MODEL_CHECKSUM', 'Gói tải về không phải tệp zip hợp lệ. Bấm Tải để tải lại.') from error
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    temp = marker.with_suffix('.partial')
    temp.write_text(json.dumps({'model_id': spec['id'], 'revision': spec['revision'], 'manifest_sha256': pin['manifest_sha256'],
        'license_accepted_at': payload['license_accepted_at']}, indent=2), encoding='utf-8')
    replace_with_retry(temp, marker)
    shutil.rmtree(staging, ignore_errors=True)
    progress(1, 'Gói sẵn sàng')
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
        if any(len(token) > MAX_TOKEN_CHARS for token in text.split()):
            raise WorkerError('INVALID_TEXT', f'Có một chuỗi liền dài hơn {MAX_TOKEN_CHARS} ký tự mà không có dấu cách. Hãy thêm dấu cách để chia nhỏ.')
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
    v3turbo = importlib.import_module('vieneu.v3turbo')
    v3turbo.phonemize_text_with_emotions = vietnamese_reading(v3turbo.phonemize_text_with_emotions)
    seed, draws = os.environ.get('THANHAM_TTS_SEED'), {'name': None, 'call': 0}
    if seed:  # parity hook (N12), the native worker has it too: numpy's draws are re-seeded before every engine call of a take
        engine_infer = engine.engine.infer
        def seeded_infer(*args, **kwargs):
            draws['call'] += 1
            np.random.seed(zlib.crc32(f"{seed}|{draws['name']}|{draws['call']}".encode()))
            return engine_infer(*args, **kwargs)
        engine.engine.infer = seeded_infer
    output_dir.mkdir(parents=True, exist_ok=True)
    crops = {}  # reference path -> what VieNeu clones from, cut once per request

    def synth(item):
        kwargs = voice_kwargs(item)
        name = item.get('output_name') or f'{uuid.uuid4()}.wav'
        draws.update(name=name, call=0)
        if Path(name).suffix.lower() != '.wav':
            raise WorkerError('INVALID_PATH', 'TTS output must be a WAV file.')
        final = contained_path(output_dir, name)
        if final.exists():
            raise WorkerError('OUTPUT_EXISTS', 'A take already exists at that output name.')
        if 'ref_audio' in kwargs:
            if kwargs['ref_audio'] not in crops:
                crops[kwargs['ref_audio']] = clone_reference(kwargs['ref_audio'])
            kwargs['ref_audio'] = crops[kwargs['ref_audio']]
        parts, trailing = split_pauses(item['text'])
        speed = number(item.get('speed', 1), 'speed', 0.5, 2)
        ffmpeg = executable('ffmpeg', item.get('ffmpeg_path')) if speed != 1 else None
        silence = lambda n: np.zeros(max(0, n), dtype=np.float32)
        # With a speed change the take also keeps its reading before it, so fitting the take to a subtitle cue later
        # stretches that once (speed x fit rate) instead of stretching the take a second time. Each part of it starts where
        # its stretched part starts in the take, times the speed: atempo returns a little less than length / speed, so
        # pauses scaled by the speed alone would drift by some 20 ms per part.
        pieces, unstretched = [], []
        for chunk, before in parts:
            pieces.append(silence(round(before * 48000)))
            reading = np.asarray(engine.infer(chunk, **kwargs), dtype=np.float32)
            if ffmpeg:
                unstretched += [silence(round(sum(map(len, pieces)) * speed) - sum(map(len, unstretched))), reading]
            pieces.append(stretch(reading, speed, ffmpeg) if ffmpeg else reading)
        audio = np.concatenate(pieces + [silence(round(trailing * 48000))])
        if audio.size == 0 or not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 1e-7:
            raise WorkerError('INVALID_AUDIO', 'Engine returned empty, silent or non-finite audio.')
        peak = float(np.max(np.abs(audio)))
        def save(path, samples):
            partial = path.with_name(path.stem + '.partial.wav')
            try:
                sf.write(str(partial), limit_peak(samples, peak), 48000, subtype='PCM_24')
                replace_with_retry(partial, path)
            finally:
                partial.unlink(missing_ok=True)
        raw = final.with_name(final.stem + '.raw.wav')
        if ffmpeg:
            save(raw, np.concatenate(unstretched + [silence(round(len(audio) * speed) - sum(map(len, unstretched)))]))
        save(final, audio)
        # Pause marks at the very start or end are wanted silence, so that edge stays.
        start_ms, end_ms = speech_edges(audio, keep_start=parts[0][1] > 0, keep_end=trailing > 0)
        result = {'path': str(final), 'duration_ms': round(len(audio) / 48), 'sample_rate': 48000,
                  'speech_start_ms': start_ms, 'speech_end_ms': end_ms}
        if ffmpeg:
            result.update(raw_path=str(raw), speed=speed)
        if item.get('check_model_path'):
            result['check'] = check_take(final, item['text'], Path(item['check_model_path']))
        return result

    try:
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
    finally:
        for reference, crop in crops.items():
            if crop != reference:
                with contextlib.suppress(OSError):  # a temp file left behind must not fail the take
                    Path(crop).unlink(missing_ok=True)


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
    """faster-whisper 1.2.1's decode_audio(path, sampling_rate=STT_RATE), decoding packet by packet so an invalid frame is
    skipped instead of ending the input: its decode() generator is finished once it has raised (after SYSTRAN/faster-whisper#1717, MIT)."""
    import av
    import numpy as np
    from faster_whisper.audio import _group_frames, _resample_frames

    def frames(packets):
        channels, skipped = None, False
        while True:
            try:
                packet = next(packets, None)
            except av.error.InvalidDataError:  # from the demuxer: the input ends there, unflushed, as in decode_audio
                return
            if packet is None:
                return
            try:
                decoded = packet.decode()
            except (av.error.InvalidDataError, av.error.UndefinedError):  # UndefinedError: e.g. the AAC decoder's ADTS parse codes
                skipped = True
                continue
            except av.error.FFmpegError as error:
                # Past a skipped packet decode_audio had already stopped: another decoder error (e.g. the AAC decoder's EPERM
                # on a second damaged region) ends the input there, unflushed, so no file decodes worse than with it.
                if skipped and not isinstance(error, MemoryError):
                    return
                raise
            for frame in decoded:
                if frame.samples:
                    channels = frame.layout.nb_channels if channels is None else channels
                    # AudioFifo checks the format and rate, not the channel count: with fewer channels than the first frame,
                    # av_audio_fifo_write reads planes the frame does not have (a crash), e.g. a file joined from stereo and mono.
                    if frame.layout.nb_channels < channels:
                        raise ValueError('Frame does not match AudioFifo parameters.')
                yield frame

    resampler = av.audio.resampler.AudioResampler(format='s16', layout='mono', rate=STT_RATE)
    raw_buffer, dtype = io.BytesIO(), None
    try:
        with av.open(str(path), mode='r', metadata_errors='ignore') as container:
            for frame in _resample_frames(_group_frames(frames(container.demux(audio=0)), 500000), resampler):
                array = frame.to_ndarray()
                dtype = array.dtype
                raw_buffer.write(array)
    # FFmpeg errors, no audio stream (IndexError), parts with another rate or fewer channels (the FIFO's ValueError) are about the
    # input: the desktop does not rerun INVALID_MEDIA on Python, which would decode it with the same FFmpeg and fail the same way.
    except (av.error.FFmpegError, IndexError, ValueError) as error:
        code = getattr(error, 'errno', None)
        if code == errno.ENOENT:  # deleted since the job started
            raise WorkerError('INPUT_MISSING', 'Input audio/video is missing.') from error
        # ENOMEM, a file another program holds (EACCES) or a read error (EIO) are the environment: WORKER_ERROR, rerun on Python.
        # EPERM stays INVALID_MEDIA: the AAC decoder returns it for damaged data.
        if isinstance(error, MemoryError) or code in (errno.EACCES, errno.EIO):
            raise
        raise WorkerError('INVALID_MEDIA', f'{type(error).__name__}: {error}') from error
    del resampler
    gc.collect()  # as decode_audio: the resampler's objects are otherwise not freed (SYSTRAN/faster-whisper#390)
    if not raw_buffer.tell():  # e.g. every packet invalid: an empty transcript would pass for a silent recording
        raise WorkerError('INVALID_MEDIA', 'The file has no decodable audio.')
    return np.frombuffer(raw_buffer.getbuffer(), dtype=dtype).astype(np.float32) / 32768.0


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
    speakers, low, high = (payload.get(k) for k in ('num_speakers', 'min_speakers', 'max_speakers'))
    if any(n is not None and (isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 8) for n in (speakers, low, high)):
        raise WorkerError('INVALID_RECIPE', 'Speaker counts must be whole numbers from 1 to 8.')
    if (speakers is not None and (low is not None or high is not None)) or (low is not None and high is not None and low > high):
        raise WorkerError('INVALID_RECIPE', 'num_speakers excludes min_speakers/max_speakers, and min_speakers must not exceed max_speakers.')
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
            # A known count goes in as min = max, so the automatic result is kept when it already has that many speakers: that beat
            # clustering again at the count on AMI (DER 20.94 vs 23.57 %) and ViYT (17.84 vs 18.06 %), VIVOS 21.13 vs 21.00 %.
            if speakers:
                low = high = speakers
            response['segments'] = diarize.split_rows(result, words, diarize.diarize_isolated(audio, model, None, low, high))
        except Exception as error:  # noqa: BLE001 - the transcript is still valid without speakers
            response['diarize_error'] = str(error)[:300]
    return response


SEPARATE_RATE = 44100  # HTDemucs separates 44.1 kHz stereo
# Demucs holds the whole input it is given: memory grew ~3.6 MB per input second (225 s: 1.8 GB working set). One 60 s window
# peaked at 1.24 GB working set and 2.37 GB commit, however long the track.
SEPARATE_WINDOW_S = 60.0
SEPARATE_CROSSFADE_S = 2.0


def crossfade_windows(read, separator, write, size, overlap):
    """Pass the audio read(frames) yields ((n, 2) float32, short only at the end) through separator(chunk, start) in windows of
    `size` frames, each sharing `overlap` frames with the next, and write() the output in order: in the shared frames it fades
    linearly from one window's output to the next. As long as the input; an identity separator gives it back exactly."""
    import numpy as np
    if not 0 < overlap < size:
        raise ValueError('The crossfade must be shorter than the window.')
    ramp = (np.arange(1, overlap + 1, dtype=np.float32) / (overlap + 1))[:, None]
    chunk, start, tail = read(size), 0, None
    while len(chunk):
        out = separator(chunk, start)
        if tail is not None:
            out = np.concatenate([tail + (out[:overlap] - tail) * ramp, out[overlap:]])
        more = read(size - overlap) if len(chunk) == size else chunk[:0]
        if not len(more):
            write(out)
            return
        write(out[:-overlap])
        tail, start, chunk = out[-overlap:], start + size - overlap, np.concatenate([chunk[-overlap:], more])


def background_separator(sources, run, total, progress):
    """separator(chunk, start) for crossfade_windows: the chunk minus its vocals. run(mix, callback) (see demucs_model) gets the
    chunk normalised by the mean and deviation of its mono mix, as Demucs' own separate does; progress follows its segments
    over `total` input frames and never goes back where windows overlap."""
    import numpy as np
    keep, done = [i for i, name in enumerate(sources) if name != 'vocals'], [0.0]
    def separator(chunk, start):
        mix = np.ascontiguousarray(chunk.T)
        mono = mix.mean(axis=0)
        mean, std = float(mono.mean()), float(mono.std()) + 1e-8  # + 1e-8: silence
        def segment(event):
            value = min(0.99, (start + event['segment_offset']) / total)
            if event['state'] == 'end' and value > done[0]:
                done[0] = value
                progress(value, 'Separating')
        stems = run((mix - mean) / std, segment)
        return (stems[keep].sum(axis=0) * std + mean).T  # the window's mean once, not once per kept source
    return separator


def demucs_model(path):
    """(source names, run) for the HTDemucs safetensors at `path`; run(mix, callback) splits a (2, n) float32 mix into
    (sources, 2, n) with Demucs' own 7.8 s segments. shifts=0: one random shift averages nothing and costs repeatability."""
    import torch
    from demucs.apply import apply_model
    from demucs.hf import load_safetensors_model
    from safetensors import safe_open
    torch.set_num_threads(min(8, os.cpu_count() or 4))
    # The sha256 pin is the guard; this only refuses to build another class, or to import the classes a `structure` names.
    with safe_open(str(path), framework='pt') as weights:
        metadata = weights.metadata() or {}
        if metadata.get('klass') != 'demucs.htdemucs.HTDemucs' or 'structure' in metadata:
            raise WorkerError('MODEL_UNKNOWN', 'The separation model is not HTDemucs.')
    model = load_safetensors_model(path).eval()
    def run(mix, callback):
        with torch.inference_mode():
            return apply_model(model, torch.from_numpy(mix)[None], shifts=0, split=True, overlap=0.25, device='cpu',
                callback=callback)[0].numpy()
    return model.sources, run


def memory_status():
    """(available physical memory, available commit) in bytes."""
    import ctypes
    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in
            ('total_phys', 'avail_phys', 'total_page_file', 'avail_page_file', 'total_virtual', 'avail_virtual', 'avail_extended')]
    status = Status(length=ctypes.sizeof(Status))
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError()
    return status.avail_phys, status.avail_page_file


def separate(payload, output_dir: Path, progress):
    """The input's background (every HTDemucs source but the vocals) as a 44.1 kHz stereo 24-bit FLAC. FFmpeg decodes the
    input once into windows of SEPARATE_WINDOW_S, so memory stays flat however long the track is."""
    offline_mode()
    model_dir = Path(payload.get('model_path', ''))
    spec = verify_model(model_dir, 'htdemucs')
    ffmpeg = executable('ffmpeg', payload.get('ffmpeg_path'))
    info = probe(payload.get('input_path', ''), ffmpeg)
    name = payload.get('output_name') or f'{uuid.uuid4()}.flac'
    if Path(name).suffix.lower() != '.flac':
        raise WorkerError('INVALID_PATH', 'Separation output must be a FLAC file.')
    output_dir.mkdir(parents=True, exist_ok=True)
    final = contained_path(output_dir, name)
    partial = final.with_name(final.stem + '.partial.flac')
    phys, commit = memory_status()
    if phys < 1.5 * 2**30 or commit < 2.5 * 2**30:
        raise WorkerError('LOW_MEMORY', f'Không đủ bộ nhớ để tách nhạc nền: cần khoảng 1,5 GB RAM trống và 2,5 GB bộ nhớ ảo trống, '
            f'đang còn {phys / 2**30:.1f} GB và {commit / 2**30:.1f} GB. Đóng bớt ứng dụng rồi thử lại.')
    need = 2 * info['duration_ms'] / 1000 * SEPARATE_RATE * 2 * 3  # 24-bit stereo before FLAC packs it: the job's file and its asset copy
    free = shutil.disk_usage(output_dir).free
    if free < need + 256 * 1024 * 1024:
        raise WorkerError('DISK_FULL', f'Không đủ dung lượng: cần khoảng {math.ceil(need / 2**20)} MB trống, còn {free // 2**20} MB.')
    progress(0.01, 'Loading HTDemucs')
    sources, run = demucs_model(contained_path(model_dir, spec['artifacts'][0]['path']))
    import numpy as np
    import soundfile as sf
    separator = background_separator(sources, run, max(1, info['duration_ms'] * SEPARATE_RATE / 1000), progress)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    # FFmpeg's few error lines go to the worker's stderr (worker.log); a full pipe nobody reads would stall it.
    decoder = subprocess.Popen([ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', info['path'], '-vn', '-ac', '2',
        '-ar', str(SEPARATE_RATE), '-f', 'f32le', 'pipe:1'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, creationflags=flags)
    def read(frames):
        data = decoder.stdout.read(frames * 8)
        return np.frombuffer(data[:len(data) // 8 * 8], dtype=np.float32).reshape(-1, 2)
    try:
        with sf.SoundFile(str(partial), 'w', SEPARATE_RATE, 2, 'PCM_24', format='FLAC') as out:
            # Clipped: a stem can pass full scale where the vocals cancelled the music, and 24-bit FLAC would wrap.
            crossfade_windows(read, separator, lambda audio: out.write(np.clip(audio, -1, 1)),
                round(SEPARATE_WINDOW_S * SEPARATE_RATE), round(SEPARATE_CROSSFADE_S * SEPARATE_RATE))
        if decoder.wait():
            raise WorkerError('AUDIO_PROCESS_FAILED', 'FFmpeg could not decode the input; see worker.log.')
        frames = sf.info(str(partial)).frames
        if not frames:
            raise WorkerError('NO_AUDIO', 'The file has no audio to separate.')
        replace_with_retry(partial, final)
        return {'path': str(final), 'duration_ms': round(frames * 1000 / SEPARATE_RATE), 'sample_rate': SEPARATE_RATE, 'channels': 2}
    finally:
        if decoder.poll() is None:
            decoder.kill()
        decoder.wait()
        decoder.stdout.close()
        partial.unlink(missing_ok=True)


HEALTH_PROFILES = {'base': ['numpy', 'soundfile', 'onnxruntime', 'ctranslate2', 'av', 'vieneu', 'faster_whisper', 'huggingface_hub'],
                   'separation': ['numpy', 'soundfile', 'torch', 'demucs.htdemucs', 'safetensors']}


def health(profile='base'):
    # Import for real: native extensions only fail at load time (e.g. a missing MSVC runtime DLL).
    def loads(name):
        try:
            importlib.import_module(name)
            return True
        except Exception:
            return False
    if profile not in HEALTH_PROFILES:
        raise WorkerError('INVALID_REQUEST', f'Unknown health profile: {profile}')
    # The base runtime ships the engines (TTS, STT, render); the separation pack ships only what separate() imports.
    # Only separate() may load torch: TTS and STT must start and run as they did before it was in the runtime.
    modules = {name: loads(name) for name in HEALTH_PROFILES[profile]}
    torch_imported_by_engines = profile == 'base' and 'torch' in sys.modules
    return {'python': sys.version.split()[0], 'profile': profile, 'modules': modules, 'torch_imported_by_engines': torch_imported_by_engines,
        'ffmpeg': os.environ.get('THANHAM_FFMPEG') or shutil.which('ffmpeg'),
        'ready': all(modules.values()) and not torch_imported_by_engines}


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
            if operation == 'health': result = health(payload.get('profile', 'base'))
            elif operation == 'probe': result = probe(payload['input_path'], payload.get('ffmpeg_path'))
            elif operation == 'render': result = render(payload, output_dir, progress)
            elif operation == 'download': result = download(payload, models_dir, progress)
            elif operation == 'tts': result = tts(payload, output_dir, progress, lambda index, **v: emit('item', index=index, **v))
            elif operation == 'clone_preview': result = clone_preview(payload, output_dir, progress)
            elif operation == 'separate': result = separate(payload, output_dir, progress)
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
