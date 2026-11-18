r"""clone_refs.py: makes the reference clips for the cloned-voice rows (P-op, K-cond) on the machine that runs them, so no voice
recording is kept in the repository. The Python worker reads three preset takes (seeded), and FFmpeg turns them into references that
cover what enrollment branches on: sample rates (8 to 96 kHz, 44.1 kHz skipping the denoiser's resample), a clip of 8 s or less (no
crop), a noisy lead-in and a pause (the window moves), stereo, PCM_16/24/32 and float WAV, and every importer format of
src-tauri/src/store.rs that soundfile reads (FLAC, OGG, Opus, MP3, AIFF), plus M4A, which it does not.

usage: python -I clone_refs.py --python <runtime python.exe> --model <vieneu-v3 folder> --ffmpeg <ffmpeg.exe> --out <dir>
Writes <dir>/*.wav|flac|... and <dir>/refs.json (the file names, in order).
"""
import argparse
import json
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
TAKES = {
    'a': ('Trúc Ly', 'Buổi sáng hôm ấy trời trong xanh, gió nhẹ thổi qua hàng cây ven đường. Cô giáo mở cửa lớp học, mỉm cười chào các em '
                     'học sinh đang ríu rít trò chuyện. Ai cũng háo hức chờ đợi bài học mới về những vùng đất xa xôi.'),
    'b': ('Hải Đăng', 'Thưa quý vị, chương trình hôm nay xin giới thiệu một câu chuyện cảm động về tình làng nghĩa xóm. Những người hàng xóm '
                      'đã cùng nhau dựng lại ngôi nhà sau cơn bão, không ai quản ngại vất vả hay mưa nắng.'),
    'c': (None, 'Mỗi khi mùa thu về, phố phường Hà Nội lại khoác lên mình một vẻ đẹp dịu dàng. Hương hoa sữa thoang thoảng trong '
                'những con ngõ nhỏ, và người ta thong thả dạo bước bên hồ, ngắm nhìn mặt nước lăn tăn gợn sóng.'),
}
PCM16 = ['-c:a', 'pcm_s16le']
# name: (take, input options, filter, output options); the filter's output is [o] when it has one
REFS = {
    'a16_noise.wav': ('a', ['-f', 'lavfi', '-t', '5', '-i', 'anoisesrc=color=brown:amplitude=0.05:sample_rate=48000:seed=7'],
                      '[1][0]concat=n=2:v=0:a=1[o]', ['-ar', '16000', *PCM16]),
    'b16_pause.wav': ('b', ['-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=r=48000:cl=mono'],
                      '[0]atrim=0:4,asetpts=N/SR/TB[x];[0]atrim=4,asetpts=N/SR/TB[y];[x][1][y]concat=n=3:v=0:a=1[o]', ['-ar', '16000', *PCM16]),
    'c22.wav': ('c', [], None, ['-ar', '22050', *PCM16]),
    'a24.wav': ('a', [], None, ['-ar', '24000', *PCM16]),
    'b44.wav': ('b', [], None, ['-ar', '44100', *PCM16]),
    'c48_stereo.wav': ('c', [], '[0]asplit[l][r];[r]adelay=7,volume=0.6[q];[l][q]join=inputs=2:channel_layout=stereo[o]', ['-c:a', 'pcm_s24le']),
    'a8.wav': ('a', [], None, ['-ar', '8000', *PCM16]),
    'b11.wav': ('b', [], None, ['-ar', '11025', *PCM16]),
    'c32.wav': ('c', [], None, ['-ar', '32000', *PCM16]),
    'a96.wav': ('a', [], None, ['-ar', '96000', '-c:a', 'pcm_s24le']),
    'b_short.wav': ('b', [], None, ['-t', '5', '-ar', '16000', *PCM16]),
    'a_float.wav': ('a', [], None, ['-ar', '16000', '-c:a', 'pcm_f32le']),
    'b_s32.wav': ('b', [], None, ['-ar', '16000', '-c:a', 'pcm_s32le']),
    'a16.flac': ('a', [], None, ['-ar', '16000', '-c:a', 'flac']),
    'a16.ogg': ('a', [], None, ['-ar', '16000', '-c:a', 'libvorbis']),
    'a48.opus': ('a', [], None, ['-c:a', 'libopus', '-b:a', '48k']),
    'a16.mp3': ('a', [], None, ['-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k']),
    'b44_stereo.mp3': ('b', [], None, ['-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k']),
    'a16.aiff': ('a', [], None, ['-ar', '16000', '-c:a', 'pcm_s16be']),
    'a16.m4a': ('a', [], None, ['-ar', '16000', '-c:a', 'aac']),
}


def main():
    ap = argparse.ArgumentParser()
    for a in ('--python', '--model', '--ffmpeg', '--out'):
        ap.add_argument(a, required=True)
    args = ap.parse_args()
    out = Path(args.out).resolve()
    takes = out / 'takes'
    takes.mkdir(parents=True, exist_ok=True)
    items = [{'text': text, 'output_name': f'{k}.wav', **({'voice_id': voice} if voice else {})} for k, (voice, text) in TAKES.items()]
    request = {'protocol': 1, 'id': 'clone-refs', 'operation': 'tts', 'output_dir': str(takes),
               'payload': {'model_path': str(Path(args.model).resolve()), 'items': items}}
    env = {**os.environ, 'THANHAM_TTS_SEED': '7', 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
    done = subprocess.run([args.python, '-I', '-X', 'utf8', str(HERE.parents[1] / 'worker' / 'main.py')], env=env,
                          input=(json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'), capture_output=True, check=True)
    results = [json.loads(ln) for ln in done.stdout.decode('utf-8').split('\n') if ln.strip()]
    if sum('result' in e for e in results if e.get('event') == 'item') != len(items):
        raise SystemExit(f'takes failed: {results}')
    for name, (take, inputs, graph, options) in REFS.items():
        argv = [args.ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', str(takes / f'{take}.wav'), *inputs]
        argv += ['-filter_complex', graph, '-map', '[o]'] if graph else ['-map', '0:a']
        subprocess.run([*argv, *options, str(out / name)], check=True)
    (out / 'refs.json').write_text(json.dumps(list(REFS), indent=1), encoding='utf-8')
    for name in REFS:
        print(f'{name}: {(out / name).stat().st_size} bytes')


if __name__ == '__main__':
    main()
