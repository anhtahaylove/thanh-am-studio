r"""r_compare.py: row R (protocol and errors) of the Rust worker against recorded v1.0.16 Python behaviour.

usage:  python r_compare.py --exe <thanham-worker.exe>                              compare the Rust worker with r\cases.json
        python r_compare.py --record --python <python.exe> --main <worker\main.py>   (re)record r\cases.json from the Python worker

Each case is one stdin text (or a generated oversize line) for a worker that has no FFmpeg on its path. The events and the exit code must be
equal after the normalisation of the plan's row R: a Python exception text (`KeyError: 'x'`, `JSONDecodeError: ...`) is replaced by `<pyexc>`,
because its wording belongs to Python. Same event sequence and same codes on 100% of the cases, and the same `WorkerError` message.
Operations that need Python-only engines (tts, stt, separate, clone_preview) and `health` (its result is declared different) are not cases."""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = HERE / 'r' / 'cases.json'
PYEXC = re.compile(r'[A-Za-z]+(?:Error|Exception): .*')


def req(**kw):
    return json.dumps({'protocol': 1, 'id': 'r1', 'operation': 'probe', 'payload': {}, **kw}, ensure_ascii=False)


SPECS = {
    'empty-stdin': {'text': ''},
    'blank-line': {'text': '\n'},
    'not-json': {'text': 'not json\n'},
    'truncated-json': {'text': '{"protocol": 1, "id": "r1"\n'},
    'trailing-garbage': {'text': req() + ' x\n'},
    'bom-then-valid-request': {'text': '\ufeff' + req(operation='nope') + '\n'},
    'invalid-utf8': {'bytes_b64': base64.b64encode(b'{"protocol": 1, "id": "\xff\xfe"}\n').decode()},
    'array': {'text': '[]\n'},
    'null': {'text': 'null\n'},
    'number': {'text': '5\n'},
    'string': {'text': '"x"\n'},
    'empty-object': {'text': '{}\n'},
    'protocol-2': {'text': req(protocol=2) + '\n'},
    'protocol-string': {'text': req(protocol='1') + '\n'},
    'protocol-missing': {'text': json.dumps({'id': 'r1', 'operation': 'probe', 'payload': {}}) + '\n'},
    'id-missing': {'text': json.dumps({'protocol': 1, 'operation': 'probe', 'payload': {}}) + '\n'},
    'id-empty': {'text': req(id='') + '\n'},
    'id-number': {'text': req(id=5) + '\n'},
    'id-null': {'text': req(id=None) + '\n'},
    'payload-missing': {'text': json.dumps({'protocol': 1, 'id': 'r1', 'operation': 'probe'}) + '\n'},
    'payload-array': {'text': req(payload=[]) + '\n'},
    'operation-missing': {'text': json.dumps({'protocol': 1, 'id': 'r1', 'payload': {}}) + '\n'},
    'operation-unknown': {'text': req(operation='nope') + '\n'},
    'operation-number': {'text': req(operation=7) + '\n'},
    'oversize-request': {'generate': 'oversize'},
    'second-line-ignored': {'text': req(operation='nope') + '\n' + req() + '\n'},
    'probe-no-input-path': {'text': req() + '\n'},
    'probe-input-path-number': {'text': req(payload={'input_path': 5}) + '\n'},
    'probe-input-missing': {'text': req(payload={'input_path': 'C:/nope/missing-file.wav'}) + '\n'},
    'render-no-clips': {'text': req(operation='render', payload={}) + '\n'},
    'render-clips-not-a-list': {'text': req(operation='render', payload={'clips': 'x'}) + '\n'},
    'render-empty-clips': {'text': req(operation='render', payload={'clips': []}) + '\n'},
    'render-bad-format': {'text': req(operation='render', payload={'clips': [{}], 'format': 'ogg'}) + '\n'},
    'render-no-ffmpeg': {'text': req(operation='render', payload={'clips': [{'path': 'C:/nope.wav'}]}) + '\n'},
    'render-ffmpeg-path-missing': {'text': req(operation='render', payload={'clips': [{'path': 'C:/nope.wav'}], 'ffmpeg_path': 'C:/nope/ffmpeg.exe'}) + '\n'},
    'download-no-model-id': {'text': req(operation='download', payload={}) + '\n'},
    'download-unknown-model': {'text': req(operation='download', payload={'model_id': 'nope'}) + '\n'},
    'download-traversal-id': {'text': req(operation='download', payload={'model_id': '../x'}) + '\n'},
}


def stdin_bytes(spec):
    if 'generate' in spec:
        return (req(payload={'pad': 'x' * (4 * 1024 * 1024)}) + '\n').encode()
    return base64.b64decode(spec['bytes_b64']) if 'bytes_b64' in spec else spec['text'].encode('utf-8')


def normalise(events):
    return [{k: PYEXC.sub('<pyexc>', v) if isinstance(v, str) else v for k, v in e.items()} for e in events]


def run(cmd, data):
    # no FFmpeg anywhere: the PATH holds only an empty folder, and THANHAM_* are unset
    empty = Path(os.environ.get('TEMP', '.')) / 'r-compare-empty-path'
    empty.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('THANHAM_')}
    env['PATH'] = str(empty)
    p = subprocess.run(cmd, input=data, capture_output=True, env=env, cwd=str(empty))
    events = []
    for line in p.stdout.decode('utf-8', 'replace').split('\n'):
        if line.strip():
            events.append(json.loads(line))
    return {'exit_code': p.returncode, 'events': normalise(events)}


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe')
    ap.add_argument('--python')
    ap.add_argument('--main')
    ap.add_argument('--record', action='store_true')
    args = ap.parse_args()
    if args.record:
        cmd = [args.python, '-I', '-X', 'utf8', args.main]
        cases = {name: run(cmd, stdin_bytes(spec)) for name, spec in SPECS.items()}
        CASES.parent.mkdir(exist_ok=True)
        CASES.write_text(json.dumps({'specs': SPECS, 'cases': cases}, ensure_ascii=False, indent=1), encoding='utf-8')
        print(len(cases), 'cases recorded')
        return
    recorded = json.loads(CASES.read_text(encoding='utf-8'))
    # the Rust worker reads the registry next to its exe, as the shipped layout has it (worker\models.json)
    stage = Path(os.environ.get('TEMP', '.')) / 'r-compare-engine'
    stage.mkdir(exist_ok=True)
    shutil.copy(args.exe, stage / 'thanham-worker.exe')
    shutil.copy(HERE.parents[1] / 'worker' / 'models.json', stage / 'models.json')
    args.exe = str(stage / 'thanham-worker.exe')
    failed = []
    for name, want in recorded['cases'].items():
        got = run([args.exe], stdin_bytes(recorded['specs'][name]))
        if got != want:
            failed.append(name)
            print('FAIL', name, f"\n   want {json.dumps(want, ensure_ascii=False)[:400]}\n   got  {json.dumps(got, ensure_ascii=False)[:400]}")
        else:
            print('ok  ', name)
    print(f'row R: {len(recorded["cases"]) - len(failed)} passed, {len(failed)} failed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
