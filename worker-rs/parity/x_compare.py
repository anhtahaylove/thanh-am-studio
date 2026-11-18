r"""x_compare.py: row X (render, probe) of the Rust worker against the v1.0.16 Python goldens.

usage:  python x_compare.py --exe <thanham-worker.exe> --ffmpeg <ffmpeg.exe> [--ffprobe <ffprobe.exe>] [--only <substring>] [--skip <substring>]
                            [--seg <folder>] [--opus-python <python.exe> --main <worker/main.py>]
        python x_compare.py --python <python.exe> --main <worker/main.py> ...   (the same rule against the Python worker: a harness self-check)

Every request in requests\ runs through the engine as production does (one request on stdin, protocol 1), and the result is
compared with golden.json, which was recorded twice from the unchanged v1.0.16 worker (E0, no tolerance):
  - the exit code and the events (progress events by message only), after the normalisation of the recorder
    (the uuid of an output name, the ${OUT} and ${FIX} paths, only the first line of an FFmpeg error text);
  - the files left in the output folder: same names, the SHA-256 of the decoded float PCM, the ffprobe fields, and, where both
    recordings agreed, the SHA-256 and size of the file itself (Opus bytes differ between two runs, so Opus is compared by
    PCM and ffprobe fields). libopus picks its code paths by CPU, so the golden Opus PCM holds only on the recording machine: with
    --opus-python, the decoded PCM of each .opus output is compared with the Python worker's, run on this machine on the same recipe.
The three 500-segment recipes need the 500 real TTS takes (fixtures\seg, 182 MB, not in the repository): pass --seg <folder>
(checked against seg.sha256); without it they are reported as skipped, and the local gate runs them.
Exit code 0 when every compared recipe matches."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent / 'x'
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def normalise(text, out_dir, fix_dir):
    for src, token in ((str(out_dir), '${OUT}'), (str(fix_dir), '${FIX}')):
        text = text.replace(src, token).replace(src.replace('\\', '/'), token).replace(src.replace('\\', '\\\\'), token)
    text = text.replace('\\\\', '/').replace('\\', '/')
    return UUID.sub('<uuid>', text)


def decode_sha(ffmpeg, path):
    p = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-i', str(path), '-f', 'f32le', 'pipe:1'], capture_output=True)
    return hashlib.sha256(p.stdout).hexdigest() if p.returncode == 0 else 'decode-failed:' + p.stderr.decode('utf-8', 'replace')[:80]


def probe_fields(ffprobe, path):
    p = subprocess.run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], capture_output=True, text=True, encoding='utf-8')
    if p.returncode:
        return {'error': p.stderr[:120]}
    d = json.loads(p.stdout)
    keep = ('codec_name', 'sample_rate', 'channels', 'channel_layout', 'bits_per_raw_sample', 'sample_fmt', 'bit_rate', 'duration', 'duration_ts', 'start_time', 'nb_frames', 'tags')
    return {'streams': [{k: s.get(k) for k in keep} for s in d.get('streams', [])],
            'format': {k: d['format'].get(k) for k in ('format_name', 'duration', 'bit_rate', 'size', 'tags', 'nb_streams')}}


def run_recipe(args, name, request_path, fix_dir, cmd=None):
    work = Path(tempfile.mkdtemp(prefix='xc-')).resolve()  # the long name: a runner's TEMP may be an 8.3 short path the worker never prints
    try:
        text = request_path.read_text(encoding='utf-8').replace('${FIX}', str(fix_dir).replace('\\', '\\\\')).replace('${OUT}', str(work).replace('\\', '\\\\'))
        request = json.dumps(json.loads(text), ensure_ascii=False)
        env = {**__import__('os').environ, 'THANHAM_FFMPEG': args.ffmpeg, 'THANHAM_FFPROBE': args.ffprobe}
        cmd = cmd or ([args.exe] if args.exe else [args.python, '-I', '-X', 'utf8', args.main])
        p = subprocess.run(cmd, input=request + '\n', capture_output=True, text=True, encoding='utf-8', env=env)
        events = []
        for line in p.stdout.splitlines():
            e = json.loads(line)
            if e['event'] == 'progress':
                events.append({'event': 'progress', 'message': e['message']})
                continue
            events.append(json.loads(normalise(json.dumps(e, ensure_ascii=False), work, fix_dir)))
            events[-1].pop('id', None)
        files = []
        for f in sorted(work.rglob('*')):
            if f.is_file():
                files.append({'name': normalise(str(f.relative_to(work)), work, fix_dir), 'size': f.stat().st_size, 'bytes_sha256': hashlib.sha256(f.read_bytes()).hexdigest(),
                              'pcm_sha256': decode_sha(args.ffmpeg, f), 'probe': probe_fields(args.ffprobe, f)})
        return {'exit_code': p.returncode, 'events': events, 'files': files, 'stderr': p.stderr.strip()}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def first_line_of_errors(events):
    """The recorder kept FFmpeg's whole error text; only its first line is compared (the rest is build-specific)."""
    return [{**e, 'message': e['message'].split('\n', 1)[0]} if e.get('event') == 'error' and isinstance(e.get('message'), str) else e for e in events]


def compare(golden, got, opus_pcm=None):
    """`opus_pcm`: the decoded PCM SHA-256 of each .opus file as the Python worker wrote it on this machine, in place of the golden's."""
    problems = []
    if golden['exit_code'] != got['exit_code']:
        problems.append(f"exit code {got['exit_code']} != {golden['exit_code']}")
    if first_line_of_errors(golden['events']) != first_line_of_errors(got['events']):
        want, have = golden['events'], got['events']
        at = next((i for i, (a, b) in enumerate(zip(first_line_of_errors(want), first_line_of_errors(have))) if a != b), min(len(want), len(have)))
        problems.append(f'events differ at #{at}: want {want[at] if at < len(want) else None}; got {have[at] if at < len(have) else None}')
    if len(golden['files']) != len(got['files']):
        problems.append(f"{len(got['files'])} output files, want {len(golden['files'])}: {[f['name'] for f in got['files']]}")
    else:
        for want, have, same in zip(golden['files'], got['files'], golden['stable']['files']):
            if want['name'] != have['name']:
                problems.append(f"file name {have['name']} != {want['name']}")
            if (opus_pcm or {}).get(want['name'], want['pcm_sha256']) != have['pcm_sha256']:
                problems.append(f"{want['name']}: decoded PCM differs")
            if want['probe'] != have['probe']:
                problems.append(f"{want['name']}: ffprobe fields differ: want {want['probe']}; got {have['probe']}")
            if same['bytes'] and (want['bytes_sha256'] != have['bytes_sha256'] or want['size'] != have['size']):
                problems.append(f"{want['name']}: file bytes differ (size {have['size']}, want {want['size']})")
    return problems


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe')
    ap.add_argument('--python')
    ap.add_argument('--main')
    ap.add_argument('--ffmpeg', required=True)
    ap.add_argument('--ffprobe')
    ap.add_argument('--only', default='')
    ap.add_argument('--seg')
    ap.add_argument('--skip', default='')
    ap.add_argument('--opus-python', help="the private runtime's python.exe: the Opus PCM reference is the Python worker (--main) on this machine")
    args = ap.parse_args()
    if not args.exe and not (args.python and args.main):
        ap.error('give --exe, or --python and --main')
    if args.opus_python and not args.main:
        ap.error('--opus-python needs --main')
    args.ffmpeg = str(Path(args.ffmpeg).resolve())
    args.ffprobe = str(Path(args.ffprobe).resolve()) if args.ffprobe else str(Path(args.ffmpeg).with_name('ffprobe.exe'))
    golden = json.loads((HERE / 'golden.json').read_text(encoding='utf-8'))['recipes']
    fix_dir = HERE / 'fixtures'
    seg_dir = Path(args.seg) if args.seg else None
    tmp_fix = None
    if seg_dir:
        manifest = (HERE / 'seg.sha256').read_text(encoding='utf-8').split()
        for digest, name in zip(manifest[0::2], manifest[1::2]):
            if hashlib.sha256((seg_dir / name).read_bytes()).hexdigest() != digest:
                sys.exit(f'seg take {name} does not match seg.sha256')
        # the recipes name ${FIX}/seg/...: a scratch fixtures folder that holds both
        tmp_fix = Path(tempfile.mkdtemp(prefix='xc-fix-')).resolve()
        shutil.copytree(fix_dir, tmp_fix, dirs_exist_ok=True)
        shutil.copytree(seg_dir, tmp_fix / 'seg')
        fix_dir = tmp_fix
    failed, skipped, passed = [], [], 0
    try:
        for request_path in sorted((HERE / 'requests').glob('*.json')):
            name = request_path.stem
            if args.only not in name or (args.skip and args.skip in name):
                continue
            if name.startswith('x09-500') and not seg_dir:
                skipped.append(name)
                continue
            got = run_recipe(args, name, request_path, fix_dir)
            opus_pcm = None
            if args.opus_python and any(f['name'].endswith('.opus') for f in golden[name]['files']):
                ref = run_recipe(args, name, request_path, fix_dir, [args.opus_python, '-I', '-X', 'utf8', args.main])
                opus_pcm = {f['name']: f['pcm_sha256'] for f in ref['files'] if f['name'].endswith('.opus')}
            problems = compare(golden[name], got, opus_pcm)
            if problems:
                failed.append(name)
                print('FAIL', name, *problems, sep='\n   ', flush=True)
                if got['stderr']:
                    print('   stderr:', got['stderr'][:300])
            else:
                passed += 1
                print('ok  ', name, flush=True)
    finally:
        if tmp_fix:
            shutil.rmtree(tmp_fix, ignore_errors=True)
    print(f'row X: {passed} passed, {len(failed)} failed, {len(skipped)} skipped {skipped}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
