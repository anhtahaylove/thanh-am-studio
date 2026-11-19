r"""decode_cases.py: row D (the STT decode) cases, made on the machine that runs them. FFmpeg writes the fixtures (synthetic sound, no
recording in the repository), then faster-whisper's decode_audio, the call load_audio in worker/main.py makes, records what each one
gives: the sample count and the SHA-256 of the int16 samples, or the exception. The Rust test stt::decode::tests::decode_matches_pyav
decodes the same files and must give the same, bitwise.

The fixtures follow P0-core's row D (6 containers x 4 rates x mono/stereo, a two-track MP4, a long file over several 500000-sample
groups) and add what the decode branches on: a 16 kHz mono s16 WAV (the resampler's passthrough), other sample formats (u8, s24,
f32, 5.1), no audio stream, files FFmpeg cannot open, a truncated and a damaged file, a missing file and a non-ASCII name.

With --vad, each decoded case also records faster-whisper's VAD on it (get_speech_timestamps with VadOptions(), as transcribe runs
it): the Silero probabilities' SHA-256 and the speech chunks, for stt::vad::tests::vad_matches_python.

With --mel, each decoded case also records faster-whisper's log-Mel spectrogram (FeatureExtractor with 80 and 128 mels) of the
whole case and of its first 100 samples (one frame: numpy's matrix @ vector path): frame count and the SHA-256 of the float32
values, for stt::glue::tests::mel_matches_python.

usage: python -I decode_cases.py --ffmpeg <ffmpeg.exe> --dir <fixtures dir> --out <cases.jsonl> [--extra <dir> ...] [--vad] [--mel]
Every file of an --extra folder is a case too (for instance the clone references of clone_refs.py, which are speech).
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from faster_whisper.feature_extractor import FeatureExtractor
from faster_whisper.vad import VadOptions, get_speech_timestamps, get_vad_model

CODECS = {'wav': ['-c:a', 'pcm_s16le'], 'mp3': ['-c:a', 'libmp3lame', '-b:a', '128k'], 'm4a': ['-c:a', 'aac', '-b:a', '128k'],
          'mp4': ['-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '128k'], 'opus': ['-c:a', 'libopus', '-b:a', '96k'], 'flac': ['-c:a', 'flac']}
RATES = [8000, 22050, 44100, 48000]
OPUS_RATE = {8000: 8000, 22050: 24000, 44100: 48000, 48000: 48000}  # libopus takes 8/12/16/24/48 kHz only
VIDEO = ['-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10']
# A gliding tone with a slow tremolo and a little seeded noise, different in each channel, so a downmix is not the mono signal.
LEFT = '0.45*sin(2*PI*(180+120*sin(2*PI*0.4*t))*t)*(0.6+0.4*sin(2*PI*3*t))+0.03*(random(1)-0.5)'
RIGHT = '0.35*sin(2*PI*(420+200*sin(2*PI*0.25*t))*t)*(0.5+0.5*sin(2*PI*1.7*t))+0.03*(random(2)-0.5)'


def mel_sig(features):
    return {'frames': int(features.shape[1]), 'sha256': hashlib.sha256(np.ascontiguousarray(features, '<f4').tobytes()).hexdigest()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--extra', action='append', default=[])
    ap.add_argument('--vad', action='store_true')
    ap.add_argument('--mel', action='store_true')
    a = ap.parse_args()
    fix = Path(a.dir).resolve()
    fix.mkdir(parents=True, exist_ok=True)

    def ff(*args):
        subprocess.run([a.ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', *map(str, args)], check=True)

    def source(channels, seconds=12):
        path = fix / f'src-{channels}ch-{seconds}s.wav'
        if not path.exists():
            exprs = LEFT if channels == 1 else f'{LEFT}|{RIGHT}'
            ff('-f', 'lavfi', '-i', f"aevalsrc=exprs='{exprs}':s=48000:d={seconds}", '-c:a', 'pcm_f32le', path)
        return path

    files = []

    def make(name, *args):
        path = fix / name
        if not path.exists():
            ff(*args, path)
        files.append(path)

    for container, codec in CODECS.items():
        for rate in RATES:
            for channels in (1, 2):
                actual = OPUS_RATE[rate] if container == 'opus' else rate
                name = f'{container}-{actual}-{"mono" if channels == 1 else "stereo"}.{container}'
                if fix / name in files:
                    continue
                video = [*VIDEO, '-map', '1:v', '-map', '0:a', '-shortest'] if container == 'mp4' else []
                make(name, '-i', source(channels), *video, '-ar', actual, *codec)
    make('wav-16000-mono.wav', '-i', source(1), '-ar', 16000, '-ac', 1, '-c:a', 'pcm_s16le')
    make('wav-16000-stereo.wav', '-i', source(2), '-ar', 16000, '-c:a', 'pcm_s16le')
    make('wav-11025-u8.wav', '-i', source(1), '-ar', 11025, '-c:a', 'pcm_u8')
    make('wav-96000-s24.wav', '-i', source(2), '-ar', 96000, '-c:a', 'pcm_s24le')
    make('wav-48000-f32.wav', '-i', source(2), '-c:a', 'pcm_f32le')
    make('m4a-48000-5.1.m4a', '-i', source(2), '-af', 'pan=5.1|FL=c0|FR=c1|FC=0.5*c0+0.5*c1|LFE=0.2*c0|BL=0.3*c0|BR=0.3*c1', '-c:a', 'aac', '-b:a', '192k')
    make('mp3-44100-long.mp3', '-i', source(2, 75), '-ar', 44100, '-c:a', 'libmp3lame', '-b:a', '96k')
    make('multitrack.mp4', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=12', '-i', source(1), '-i', source(2), '-map', '0:v', '-map', '1:a',
         '-map', '2:a', '-c:v', 'mpeg4', '-q:v', '8', '-c:a:0', 'aac', '-b:a:0', '96k', '-ar:a:0', 48000, '-c:a:1', 'aac', '-b:a:1', '128k',
         '-ar:a:1', 44100, '-shortest')
    make('video-only.mp4', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=2', '-c:v', 'mpeg4')
    make('tiếng việt có dấu.flac', '-i', source(1), '-ar', 22050, '-c:a', 'flac')
    for name, data in {'empty.wav': b'', 'not-media.mp3': 'Đây không phải âm thanh.\n'.encode() * 50}.items():
        (fix / name).write_bytes(data)
        files.append(fix / name)
    whole = (fix / 'mp3-44100-stereo.mp3').read_bytes()
    (fix / 'truncated.mp3').write_bytes(whole[:len(whole) * 2 // 5])
    whole = (fix / 'm4a-44100-stereo.m4a').read_bytes()
    mid = len(whole) // 2
    (fix / 'damaged.m4a').write_bytes(whole[:mid] + bytes(range(256)) * 8 + whole[mid + 2048:])
    files += [fix / 'truncated.mp3', fix / 'damaged.m4a', fix / 'missing.wav']
    for extra in a.extra:
        files += sorted(p.resolve() for p in Path(extra).iterdir() if p.is_file() and p.suffix != '.json')

    with open(a.out, 'w', encoding='utf-8') as out:
        for path in files:
            try:
                pcm = decode_audio(str(path), sampling_rate=16000)
                i16 = np.round(pcm * 32768).astype('<i2')
                assert np.array_equal(i16.astype(np.float32) / 32768, pcm), f'{path}: decode_audio output is not on the s16 grid'
                expected = {'n': int(len(i16)), 'sha256': hashlib.sha256(i16.tobytes()).hexdigest()}
            except Exception as e:  # the worker reports these as WORKER_ERROR "Type: text"
                expected = {'error': f'{type(e).__name__}: {e}'}
            case = {'path': str(path), 'expected': expected}
            if a.vad and 'n' in expected:
                probs = get_vad_model()(np.pad(pcm, (0, 512 - pcm.shape[0] % 512)))
                case['vad'] = {'windows': int(len(probs)), 'probs_sha256': hashlib.sha256(probs.astype('<f4').tobytes()).hexdigest(),
                               'speeches': [[c['start'], c['end']] for c in get_speech_timestamps(pcm, VadOptions())]}
            if a.mel and 'n' in expected:
                case['mel'] = {str(n): {part: mel_sig(fe(x)) for part, x in (('full', pcm), ('head', pcm[:100]))}
                               for n, fe in ((n, FeatureExtractor(feature_size=n)) for n in (80, 128))}
            out.write(json.dumps(case, ensure_ascii=False) + '\n')
            print(path.name, expected, flush=True)
    print(len(files), 'cases')


if __name__ == '__main__':
    main()
