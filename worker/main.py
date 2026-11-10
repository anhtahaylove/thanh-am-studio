"""Thanh Am Studio CPU worker. One request per process; stdout is JSONL only."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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
    from huggingface_hub import hf_hub_download
    destination = contained_path(models_dir, spec['id'])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'installed.json').unlink(missing_ok=True)
    files = spec['artifacts']
    for i, item in enumerate(files):
        target = contained_path(destination, item['path'])
        try:
            verify_file(target, item)
        except WorkerError:
            cached = Path(hf_hub_download(repo_id=item['repo'], filename=item['filename'], revision=item['revision'],
                cache_dir=str(models_dir / '.download-cache')))
            verify_file(cached, item)
            target.parent.mkdir(parents=True, exist_ok=True)
            staging = target.with_name(target.name + '.partial')
            shutil.copyfile(cached, staging)
            os.replace(staging, target)
        progress((i + 1) / len(files), f"Verified {i+1}/{len(files)} model files")
    marker = destination / 'installed.json'
    temp = marker.with_suffix('.partial')
    temp.write_text(json.dumps({'model_id': spec['id'], 'revision': spec['revision']}, indent=2), encoding='utf-8')
    os.replace(temp, marker)
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
        kwargs = {'batch_size': 1}
        if item.get('reference_path'):
            reference = Path(item['reference_path'])
            if not reference.is_file():
                raise WorkerError('INPUT_MISSING', 'Reference voice file is missing.')
            kwargs['ref_audio'] = str(reference)
        elif item.get('voice_id'):
            kwargs['voice'] = item['voice_id']
        name = item.get('output_name') or f'{uuid.uuid4()}.wav'
        if Path(name).suffix.lower() != '.wav':
            raise WorkerError('INVALID_PATH', 'TTS output must be a WAV file.')
        final = contained_path(output_dir, name)
        if final.exists():
            raise WorkerError('OUTPUT_EXISTS', 'A take already exists at that output name.')
        audio = np.asarray(engine.infer(item['text'], **kwargs), dtype=np.float32)
        if audio.size == 0 or not np.isfinite(audio).all() or float(np.max(np.abs(audio))) < 1e-7:
            raise WorkerError('INVALID_AUDIO', 'Engine returned empty, silent or non-finite audio.')
        partial = final.with_name(final.stem + '.partial.wav')
        try:
            sf.write(str(partial), audio, 48000, subtype='PCM_24')
            os.replace(partial, final)
        finally:
            partial.unlink(missing_ok=True)
        return {'path': str(final), 'duration_ms': round(len(audio) / 48), 'sample_rate': 48000}

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


def stt(payload, progress):
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
    segments, info = model.transcribe(str(source), language=None if language == 'auto' else language,
        beam_size=5, vad_filter=True, condition_on_previous_text=False)
    result = []
    for segment in segments:
        result.append({'start': segment.start, 'end': segment.end, 'text': segment.text.strip()})
        progress(min(0.99, 0.1 + 0.89 * segment.end / max(info.duration, 0.01)), 'Transcribing')
    return {'segments': result, 'language': info.language}


def health():
    modules = {name: importlib.util.find_spec(name) is not None for name in ['numpy', 'soundfile', 'vieneu', 'faster_whisper', 'huggingface_hub']}
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
    def emit(event, **values):
        wire.write(json.dumps({'protocol': 1, 'id': request_id, 'event': event, **values}, ensure_ascii=False, allow_nan=False) + '\n')
        wire.flush()
    def progress(value, message=''):
        emit('progress', progress=max(0, min(1, value)), message=message)
    try:
        raw = sys.stdin.readline(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise WorkerError('INVALID_REQUEST', 'Request exceeds 4 MiB.')
        request = json.loads(raw)
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
