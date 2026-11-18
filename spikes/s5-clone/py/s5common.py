"""Shared helpers for the S5 clone-conditioning recorder and variant runner.

Run only with the reference runtime and isolation:
    runtime\\python\\python.exe -I -B script.py
The scripts never write below runtime\\ (-B: no bytecode) and import the v1.0.16 worker unchanged from the
detached baseline worktree (as the P0-core scripts do).
"""
import contextlib
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

EV = Path(r'C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\baseline-1.0.16')
sys.path.insert(0, str(EV / 'scripts'))
from rmcommon import FFMPEG, MODELS, WORK, load_worker, setup_env, sha256  # noqa: E402

S5 = WORK / 'rm' / 's5-clone'
REC = S5 / 'rec'
MODEL_DIR = MODELS / 'vieneu-v3'
REFS_DIR = WORK / 'lane-a-tts' / 'refs'


def reference_set():
    """The 20 K-cond references. 15 = speakers 000, 002, 003, 069, 070 x conditions B (10 s brown noise before the speech),
    N (continuous speech) and P (pauses); 3 = condition H of 000, 002, 003; 1 = 028-H (11 s, the shortest above 8 s);
    1 = voice-clone-check/reference.wav (48 kHz, PCM_24, 7.28 s: the only one not at 16 kHz and not longer than 8 s)."""
    refs = [REFS_DIR / f'{s}-{c}.wav' for s in ('000', '002', '003', '069', '070') for c in 'BNP']
    refs += [REFS_DIR / f'{s}-H.wav' for s in ('000', '002', '003', '028')]
    refs.append(WORK / 'voice-clone-check' / 'reference.wav')
    assert len(refs) == 20 and all(r.is_file() for r in refs)
    return refs


def supplementary_set():
    """Five derived references (ffmpeg from refs above) for paths the 20 do not cover: a 44.1 kHz source (no denoiser resample),
    22.05 kHz, 48 kHz stereo PCM_24 with a delayed, attenuated right channel (channel mean in window, trim and crop), MP3 and FLAC.
    Report-only: they never enter the K-cond bounds or pass rule."""
    return [S5 / 'supp' / n for n in ('s-44k-mono.wav', 's-22k-mono.wav', 's-48k-stereo-24.wav', 's-mp3.mp3', 's-flac.flac')]


def digest(a):
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()


def load_engine(threads=None):
    """The VieNeu engine constructed exactly as worker.tts() does (worker/main.py:570-591)."""
    setup_env()
    worker = load_worker()
    worker.offline_mode()
    from vieneu import Vieneu
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine
    original = OnnxV3LiteEngine._fetch

    def local_fetch(repo, files, subfolder):
        if repo != 'OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX':
            raise RuntimeError('unexpected model request')
        return MODEL_DIR / 'codec'

    try:
        OnnxV3LiteEngine._fetch = staticmethod(local_fetch)
        engine = Vieneu(backend='onnx', device='cpu', precision='fp32',
                        backbone_repo=str(MODEL_DIR / 'backbone'), onnx_dir=str(MODEL_DIR / 'backbone' / 'onnx_update'),
                        max_batch_size=1, max_streams=1, threads=threads or min(8, os.cpu_count() or 4))
    finally:
        OnnxV3LiteEngine._fetch = staticmethod(original)
    return worker, engine


def rebuild_conditioning_sessions(engine, threads):
    """Replace the denoiser, speaker-encoder and codec-encoder sessions by ones with `threads` intra-op threads
    (all other options as in OnnxV3LiteEngine.__init__). Used only for the thread-count variant."""
    import onnxruntime as ort
    from vieneu._v3_turbo_engine.speaker import OnnxSpeakerEncoder
    eng = engine.engine
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.inter_op_num_threads = 1
    so.add_session_config_entry('session.intra_op.allow_spinning', '0')
    so.intra_op_num_threads = threads
    eng._so = so
    eng.denoiser.sess = ort.InferenceSession(str(MODEL_DIR / 'backbone' / 'denoiser.onnx'), so, providers=['CPUExecutionProvider'])
    eng.speaker_encoder = None
    eng._sess_codec_enc = None
    eng._ensure_speaker_encoder()


def ffmpeg_read(path, dtype='float32', always_2d=False, **_ignored):
    """Drop-in for soundfile.read through the FFmpeg CLI: native rate and channels, f32le (the 'FFmpeg reading of WAV' variant)."""
    import soundfile as sf
    info = sf.info(str(path))
    cmd = [str(FFMPEG), '-v', 'error', '-nostdin', '-i', str(path), '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    data = np.frombuffer(raw, dtype='<f4').reshape(-1, info.channels).copy()
    if not always_2d and info.channels == 1:
        data = data[:, 0]
    return data, info.samplerate


@contextlib.contextmanager
def patched(obj, name, value):
    old = getattr(obj, name)
    setattr(obj, name, value)
    try:
        yield
    finally:
        setattr(obj, name, old)


def save_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=1, sort_keys=True), encoding='utf-8')
