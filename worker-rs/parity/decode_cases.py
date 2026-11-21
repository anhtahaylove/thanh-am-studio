r"""decode_cases.py: row D (the STT decode) cases, made on the machine that runs them. FFmpeg writes the fixtures (synthetic sound, no
recording in the repository), then load_audio of worker/main.py (faster-whisper's decode_audio, packet by packet) records what each
one gives: the sample count and the SHA-256 of the int16 samples, or the error code and message the worker reports. The Rust test
stt::decode::tests::decode_matches_pyav decodes the same files and must give the same, bitwise. Every case but the DAMAGED ones must
also give exactly what faster-whisper's decode_audio gives.

The fixtures follow P0-core's row D (6 containers x 4 rates x mono/stereo, a two-track MP4, a long file over several 500000-sample
groups) and add what the decode branches on: a 16 kHz mono s16 WAV (the resampler's passthrough), other sample formats (u8, s24,
f32, 5.1, 7.1), more containers and codecs (WMA, AIFF, Matroska and Ogg Vorbis, WebM Opus, MOV AAC, AMR-NB, mu-law, IMA ADPCM),
WAVs of 0 to 10 samples, no audio stream, files FFmpeg cannot open, a truncated and a damaged file, invalid frames
mid-file (an MP3 joined to itself, 400 bytes of 0xff in an MP3, 4096 in an M4A, an M4A damaged twice, an M4A with every packet
invalid), MP3s joined from parts with another rate or channel count, an ADTS header of length 0 (a demuxer error), a missing file,
a file another program holds and a non-ASCII name.

With --vad, each decoded case also records faster-whisper's VAD on it (get_speech_timestamps with VadOptions(), as transcribe runs
it): the Silero probabilities' SHA-256 and the speech chunks, for stt::vad::tests::vad_matches_python.

With --mel, each decoded case also records faster-whisper's log-Mel spectrogram (FeatureExtractor with 80 and 128 mels) of the
whole case and of its first 100 samples (one frame: numpy's matrix @ vector path): frame count and the SHA-256 of the float32
values, for stt::glue::tests::mel_matches_python.

usage: python -I decode_cases.py --ffmpeg <ffmpeg.exe> --dir <fixtures dir> --out <cases.jsonl> [--extra <dir> ...] [--vad] [--mel]
Every file of an --extra folder is a case too (for instance the clone references of clone_refs.py, which are speech).
"""
import argparse
import contextlib
import ctypes
import hashlib
import json
import random
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio
from faster_whisper.feature_extractor import FeatureExtractor
from faster_whisper.vad import VadOptions, get_speech_timestamps, get_vad_model

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'worker'))
from main import WorkerError, load_audio  # noqa: E402

CODECS = {'wav': ['-c:a', 'pcm_s16le'], 'mp3': ['-c:a', 'libmp3lame', '-b:a', '128k'], 'm4a': ['-c:a', 'aac', '-b:a', '128k'],
          'mp4': ['-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '128k'], 'opus': ['-c:a', 'libopus', '-b:a', '96k'], 'flac': ['-c:a', 'flac']}
RATES = [8000, 22050, 44100, 48000]
OPUS_RATE = {8000: 8000, 22050: 24000, 44100: 48000, 48000: 48000}  # libopus takes 8/12/16/24/48 kHz only
VIDEO = ['-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10']
# A gliding tone with a slow tremolo and a little seeded noise, different in each channel, so a downmix is not the mono signal.
LEFT = '0.45*sin(2*PI*(180+120*sin(2*PI*0.4*t))*t)*(0.6+0.4*sin(2*PI*3*t))+0.03*(random(1)-0.5)'
RIGHT = '0.35*sin(2*PI*(420+200*sin(2*PI*0.25*t))*t)*(0.5+0.5*sin(2*PI*1.7*t))+0.03*(random(2)-0.5)'
# Cases that load_audio decodes past an invalid packet on purpose, so they differ from faster-whisper's decode_audio.
DAMAGED = {'damaged.m4a', 'joined.mp3', 'damaged-0xff.mp3', 'm4a-0xff-mid.m4a', 'm4a-two-damages.m4a', 'm4a-all-invalid.m4a',
           'joined-rates.mp3', 'joined-channels.mp3', 'mono+stereo.mp3'}
LOCKED = {'locked.mp3'}  # decoded while a no-share handle holds it; the Rust test holds one too


@contextlib.contextmanager
def locked(path):
    """Holds path with a no-share handle, as a recorder or scanner that keeps the file open."""
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateFileW.restype = ctypes.c_void_p
    handle = kernel32.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)  # GENERIC_READ, no sharing, OPEN_EXISTING
    assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
    try:
        yield
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


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
    make('wav-48000-7.1.wav', '-i', source(2), '-af', 'pan=7.1|FL=c0|FR=c1|FC=0.5*c0+0.5*c1|LFE=0.2*c0|BL=0.3*c0|BR=0.3*c1|SL=0.4*c0|SR=0.4*c1',
         '-c:a', 'pcm_s16le')
    # More of what the importer accepts, so row D backs "an FFmpeg error in one worker is the same in the other" beyond six containers.
    make('wma-44100-stereo.wma', '-i', source(2), '-ar', 44100, '-c:a', 'wmav2', '-b:a', '128k')
    make('aiff-44100-stereo.aiff', '-i', source(2), '-ar', 44100, '-c:a', 'pcm_s16be')
    make('vorbis-48000-stereo.mkv', '-i', source(2), '-c:a', 'libvorbis')
    make('opus-48000-stereo.webm', '-i', source(2), '-c:a', 'libopus')
    make('aac-44100-stereo.mov', '-i', source(2), '-ar', 44100, '-c:a', 'aac')
    make('vorbis-44100-stereo.ogg', '-i', source(2), '-ar', 44100, '-c:a', 'libvorbis')
    make('amr-nb-8000-mono.amr', '-i', source(1), '-ar', 8000, '-ac', 1, '-c:a', 'libopencore_amrnb', '-b:a', '12.2k')
    make('mulaw-8000-mono.wav', '-i', source(1), '-ar', 8000, '-ac', 1, '-c:a', 'pcm_mulaw')
    make('adpcm-ima-48000-stereo.wav', '-i', source(2), '-c:a', 'adpcm_ima_wav')
    make('mp3-44100-long.mp3','-i', source(2, 75), '-ar', 44100, '-c:a', 'libmp3lame', '-b:a', '96k')
    make('multitrack.mp4', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=12', '-i', source(1), '-i', source(2), '-map', '0:v', '-map', '1:a',
         '-map', '2:a', '-c:v', 'mpeg4', '-q:v', '8', '-c:a:0', 'aac', '-b:a:0', '96k', '-ar:a:0', 48000, '-c:a:1', 'aac', '-b:a:1', '128k',
         '-ar:a:1', 44100, '-shortest')
    make('video-only.mp4', '-f', 'lavfi', '-i', 'color=c=gray:s=160x120:r=10:d=2', '-c:v', 'mpeg4')
    make('tiếng việt có dấu.flac', '-i', source(1), '-ar', 22050, '-c:a', 'flac')
    for n in (0, 1, 2, 3, 10):  # valid WAVs with almost no audio: none at 16 kHz is INVALID_MEDIA, where decode_audio gives nothing
        with wave.open(str(fix / f'wav-48000-{n}samples.wav'), 'wb') as w:
            w.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
            w.writeframes(np.full(n, 1000, '<i2').tobytes())
        files.append(fix / f'wav-48000-{n}samples.wav')
    for name, data in {'empty.wav': b'','not-media.mp3': 'Đây không phải âm thanh.\n'.encode() * 50}.items():
        (fix / name).write_bytes(data)
        files.append(fix / name)
    whole = (fix / 'mp3-44100-stereo.mp3').read_bytes()
    (fix / 'truncated.mp3').write_bytes(whole[:len(whole) * 2 // 5])
    whole = (fix / 'm4a-44100-stereo.m4a').read_bytes()
    mid = len(whole) // 2
    (fix / 'damaged.m4a').write_bytes(whole[:mid] + bytes(range(256)) * 8 + whole[mid + 2048:])
    (fix / 'm4a-0xff-mid.m4a').write_bytes(whole[:mid] + b'\xff' * 4096 + whole[mid + 4096:])  # the AAC decoder's UndefinedError
    # Two damaged regions: the first is skipped, the second makes the AAC decoder return EPERM, which ends the input there.
    one, two = len(whole) * 187 // 1000, len(whole) * 59 // 100
    (fix / 'm4a-two-damages.m4a').write_bytes(whole[:one] + bytes(range(256)) * 2 + whole[one + 512:two] +
                                              random.Random(16).randbytes(4096) + whole[two + 4096:])
    at = whole.index(b'mdat')  # the moov box, which lists the packets, stays intact: every packet is 0xff, an UndefinedError
    end = at - 4 + int.from_bytes(whole[at - 4:at], 'big')
    (fix / 'm4a-all-invalid.m4a').write_bytes(whole[:at + 4] + b'\xff' * (end - at - 4) + whole[end:])  # nothing decodes: INVALID_MEDIA
    whole = (fix / 'mp3-44100-stereo.mp3').read_bytes()
    mid = len(whole) // 2
    mono = (fix / 'mp3-44100-mono.mp3').read_bytes()
    (fix / 'joined.mp3').write_bytes(whole + whole)  # the second ID3 tag is an invalid frame
    (fix / 'damaged-0xff.mp3').write_bytes(whole[:mid] + b'\xff' * 400 + whole[mid + 400:])
    (fix / 'joined-rates.mp3').write_bytes(whole + (fix / 'mp3-22050-stereo.mp3').read_bytes())
    (fix / 'joined-channels.mp3').write_bytes(whole + mono)  # fewer channels later: an error
    (fix / 'mono+stereo.mp3').write_bytes(mono + whole)  # more channels later: decoded
    (fix / 'locked.mp3').write_bytes(whole)  # held by another program: PermissionError (EACCES), WORKER_ERROR
    make('adts-44100-stereo.aac', '-i', fix / 'm4a-44100-stereo.m4a', '-c:a', 'copy')
    adts = bytearray((fix / 'adts-44100-stereo.aac').read_bytes())
    starts, pos = [], 0
    while pos + 7 <= len(adts):  # each ADTS header's frame_length: 13 bits from bit 30
        starts.append(pos)
        pos += (adts[pos + 3] & 3) << 11 | adts[pos + 4] << 3 | adts[pos + 5] >> 5
    at = starts[len(starts) // 2]
    adts[at + 3] &= 0xfc
    adts[at + 4] = 0
    adts[at + 5] &= 0x1f
    (fix / 'adts-badlen.aac').write_bytes(adts)  # frame_length 0 mid-file: the demuxer's InvalidDataError ends the input
    files += [fix / n for n in ('truncated.mp3', 'damaged.m4a', 'm4a-0xff-mid.m4a', 'm4a-two-damages.m4a', 'm4a-all-invalid.m4a', 'joined.mp3',
                                'damaged-0xff.mp3', 'joined-rates.mp3', 'joined-channels.mp3', 'mono+stereo.mp3', 'adts-badlen.aac', 'missing.wav',
                                'locked.mp3')]
    for extra in a.extra:
        files += sorted(p.resolve() for p in Path(extra).iterdir() if p.is_file() and p.suffix != '.json')

    with open(a.out, 'w', encoding='utf-8') as out:
        for path in files:
            with locked(path) if path.name in LOCKED else contextlib.nullcontext():
                try:
                    pcm = load_audio(path)
                    i16 = np.round(pcm * 32768).astype('<i2')
                    assert np.array_equal(i16.astype(np.float32) / 32768, pcm), f'{path}: load_audio output is not on the s16 grid'
                    expected = {'n': int(len(i16)), 'sha256': hashlib.sha256(i16.tobytes()).hexdigest()}
                except WorkerError as e:
                    expected = {'code': e.code, 'error': str(e)}
                except Exception as e:  # the worker reports these as WORKER_ERROR "Type: text"
                    expected = {'code': 'WORKER_ERROR', 'error': f'{type(e).__name__}: {e}'}
                if path.name not in DAMAGED:
                    try:
                        reference = decode_audio(str(path), sampling_rate=16000)
                        same = (np.array_equal(reference, pcm) if 'n' in expected else  # no audio is an error in the worker
                                len(reference) == 0 and expected == {'code': 'INVALID_MEDIA', 'error': 'The file has no decodable audio.'})
                    except Exception as e:  # a file deleted meanwhile is INPUT_MISSING in the worker
                        same = expected.get('error') == f'{type(e).__name__}: {e}' or (
                            isinstance(e, FileNotFoundError) and expected.get('code') == 'INPUT_MISSING')
                    assert same, f'{path}: load_audio differs from faster-whisper decode_audio'
            case = {'path': str(path), 'expected': expected, **({'lock': True} if path.name in LOCKED else {})}
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
