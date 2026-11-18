r"""w_compare.py: row W (download) of the Rust worker against the v1.0.16 Python goldens.

usage:  python w_compare.py --exe <thanham-worker.exe> --models <folder with <id>\<artifact path>> [--groups basic,resume,tls,real] [--only <substring>]
        python w_compare.py --python <python.exe> --main <worker\main.py> --models <folder> ...   (the same rule against the Python worker)

The scenarios are those P0-A recorded twice from the unchanged v1.0.16 worker (35 in golden.json): a fresh download of every model, a run on
an installed folder, repair of a missing and a truncated file, a stale marker, resume by Range requests after repeated connection drops, a drop
followed by HTTP 503, offline by refused connection and by DNS failure, a failure on the second file, HTTP 401/403/404/429/500, a private root
CA through SSL_CERT_FILE only, corrupt bytes, a truncated body, the DISK_FULL pre-check, bad model ids, an environment proxy, and (with the
`real` group) the real endpoint. They run against a local stand-in for Hugging Face (hf_stub.py) serving the verified model files from --models,
so faults can be injected and every request is logged.

Rule (E0, no tolerance): the same exit code, events (distinct progress messages in order), file tree with SHA-256 of every file, leftovers
and server request log; an error text is compared after replacing `(<ExceptionName>)` and digits. A scenario whose model folder is missing from
--models is reported as skipped. THANHAM_HUB_SLEEP_SCALE shortens the Rust client's retry waits (default 0.02 here; the Python reference
waited the full 23 s per exhausted retry)."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
GW = HERE / 'w'
REGISTRY = HERE.parents[1] / 'worker' / 'models.json'
PORT, TLS_PORT, PROXY_PORT = 18081, 18443, 18082
ENDPOINT = f'http://127.0.0.1:{PORT}'
DETAIL = int(os.environ.get('W_DETAIL', '300'))  # characters of a mismatch shown
ARGS = None
BASE = None
ENGINE_DIR = None


class Server:
    def __init__(self, tls=None, port=PORT):
        self.port = port
        cmd = [sys.executable, '-I', '-X', 'utf8', str(HERE / 'hf_stub.py'), str(port), '--models', str(ARGS.models), '--registry', str(REGISTRY)]
        self.proc = subprocess.Popen(cmd + (['--tls', *map(str, tls)] if tls else []), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.proc.stdout.readline()
        self.scheme = 'https' if tls else 'http'

    def ctl(self, rules=None, reset=True):
        req = urllib.request.Request(f'{self.scheme}://127.0.0.1:{self.port}/_ctl', data=json.dumps({'rules': rules or [], 'reset': reset}).encode(), method='POST')
        urllib.request.urlopen(req, context=_ctx(self.scheme)).read()

    def log(self, clear=False):
        out = json.loads(urllib.request.urlopen(f'{self.scheme}://127.0.0.1:{self.port}/_log', context=_ctx(self.scheme)).read())
        if clear:
            urllib.request.urlopen(f'{self.scheme}://127.0.0.1:{self.port}/_ctl/clear', context=_ctx(self.scheme)).read()
        return out

    def stop(self):
        self.proc.terminate()
        self.proc.wait()


def _ctx(scheme):
    import ssl
    if scheme == 'https':
        c = ssl.create_default_context()
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
        return c
    return None


class Proxy:
    """A minimal forward proxy for plain-HTTP GET/HEAD: whatever host the URL names, it fetches from the local stand-in; it logs what it was asked."""
    def __init__(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        log = self.log = []

        class H(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def handle_one(self):
                log.append({'method': self.command, 'target': self.path[:80]})
                url = f'http://127.0.0.1:{PORT}' + ('/' + self.path.split('/', 3)[3] if self.path.startswith('http') else self.path)
                req = urllib.request.Request(url, method=self.command, headers={k: v for k, v in self.headers.items() if k.lower() in ('range', 'accept-encoding')})
                try:
                    r = urllib.request.urlopen(req)
                except urllib.error.HTTPError as e:
                    r = e
                body = b'' if self.command == 'HEAD' else r.read()
                self.send_response(r.status if hasattr(r, 'status') else r.code)
                for k, v in r.headers.items():
                    if k.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                        self.send_header(k, v)
                self.send_header('Content-Length', r.headers.get('Content-Length', str(len(body))) if self.command == 'HEAD' else str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)
            do_GET = do_HEAD = handle_one

        self.server = ThreadingHTTPServer(('127.0.0.1', PROXY_PORT), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


def tree(root):
    out = []
    for f in sorted(Path(root).rglob('*')) if Path(root).exists() else []:
        if f.is_file():
            rel = f.relative_to(root).as_posix()
            if rel.endswith('.metadata'):      # the hub client stores a timestamp in it: only its presence is compared
                out.append({'path': rel, 'size': None, 'sha256': None})
            else:
                out.append({'path': rel, 'size': f.stat().st_size, 'sha256': hashlib.sha256(f.read_bytes()).hexdigest()})
    return out


def engine_in(folder, registry=None):
    """A worker folder for the engine under test: the exe (or the Python files) next to its models.json."""
    folder.mkdir(parents=True, exist_ok=True)
    if ARGS.exe:
        shutil.copy(ARGS.exe, folder / 'thanham-worker.exe')
    else:
        for f in Path(ARGS.main).parent.glob('*.py'):
            shutil.copy(f, folder / f.name)
    if registry is None:
        shutil.copy(REGISTRY, folder / 'models.json')
    else:
        (folder / 'models.json').write_text(json.dumps(registry), encoding='utf-8')
    return folder


def run_download(model_id, models_dir, env_extra=None, worker_dir=None, payload=None):
    env = {**os.environ, 'HF_ENDPOINT': ENDPOINT, 'THANHAM_HUB_SLEEP_SCALE': os.environ.get('THANHAM_HUB_SLEEP_SCALE', '0.02'), **(env_extra or {})}
    for k in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'SSL_CERT_FILE'):
        env.pop(k, None) if k not in (env_extra or {}) else None
    request = {'protocol': 1, 'id': 'w-' + model_id, 'operation': 'download', 'payload': payload if payload is not None else {'model_id': model_id},
               'output_dir': str(models_dir.parent), 'models_dir': str(models_dir)}
    worker_dir = worker_dir or ENGINE_DIR
    cmd = [str(worker_dir / 'thanham-worker.exe')] if ARGS.exe else [ARGS.python, '-I', '-X', 'utf8', str(worker_dir / 'main.py')]
    p = subprocess.run(cmd, input=json.dumps(request, ensure_ascii=False) + '\n', capture_output=True, text=True, encoding='utf-8', env=env)
    events, seen = [], set()
    for line in p.stdout.splitlines():
        e = json.loads(line)
        if e['event'] == 'progress':
            if e['message'] == 'Đang tải model':       # emitted by a timer: whether and where it appears depends on timing
                continue
            if e['message'] not in seen:
                seen.add(e['message'])
                events.append({'event': 'progress', 'message': e['message']})
            continue
        e.pop('id', None)
        events.append(e)
    return {'exit_code': p.returncode, 'events': events, 'stderr_tail': p.stderr[-300:]}


def snapshot(name, run, models_dir, server=None, extra=None):
    left = [p.name for p in (models_dir / '.download', models_dir / '.hf') if p.exists()]
    rec = {'scenario': name, **run, 'tree': tree(models_dir), 'leftovers': left}
    if server is not None:
        # the hub client also asks for one unrelated metadata path (.../agent-harnesses, answered 404): not part of the download contract
        rec['server_log'] = [{k: (v.rsplit('/', 1)[-1] if k == 'path' else v) for k, v in r.items()} for r in server.log(clear=True) if not r['path'].endswith('agent-harnesses')]
    rec.update(extra or {})
    return rec


def fresh(path):
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True)
    return path


def have(*ids):
    return all((Path(ARGS.models) / i).is_dir() for i in ids)


def basic():
    out = {}
    srv = Server()
    try:
        for mid in ('diarization', 'htdemucs', 'whisper-small', 'vieneu-v3', 'whisper-turbo'):
            if not have(mid):
                continue
            srv.ctl()
            srv.log(clear=True)
            d = fresh(BASE / f'fresh-{mid}') / 'models'
            out[f'w01-fresh-{mid}'] = snapshot(f'w01-fresh-{mid}', run_download(mid, d), d, srv)
            if mid == 'diarization':
                out['w02-again-installed-diarization'] = snapshot('w02-again-installed-diarization', run_download(mid, d), d, srv)
                (d / 'diarization' / 'segmentation' / 'LICENSE').unlink()
                tr = d / 'diarization' / 'embedding' / 'model.onnx'
                tr.write_bytes(tr.read_bytes()[:1000])
                out['w03-repair-two-files-diarization'] = snapshot('w03-repair-two-files-diarization', run_download(mid, d), d, srv)
                (d / 'diarization' / 'installed.json').write_text('{"model_id": "diarization", "revision": "old"}', encoding='utf-8')
                out['w04-stale-marker-diarization'] = snapshot('w04-stale-marker-diarization', run_download(mid, d), d, srv)
        if not have('diarization'):
            return out
        d = fresh(BASE / 'offline') / 'models'
        out['w09a-offline-refused'] = snapshot('w09a-offline-refused', run_download('diarization', d, {'HF_ENDPOINT': 'http://127.0.0.1:18099'}), d)
        out['w09b-offline-dns'] = snapshot('w09b-offline-dns', run_download('diarization', d, {'HF_ENDPOINT': 'http://hf-offline.invalid'}), d)
        srv.ctl([{'match': 'model.onnx', 'action': 'status', 'status': 503, 'count': 200}])
        out['w09c-fails-on-second-file'] = snapshot('w09c-fails-on-second-file', run_download('diarization', d), d, srv)
        for label, status in (('404', 404), ('500', 500), ('401', 401), ('403', 403), ('429', 429)):
            d = fresh(BASE / f'http{label}') / 'models'
            srv.ctl([{'match': 'LICENSE', 'action': 'status', 'status': status, 'count': 200}])
            out[f'w10-http-{label}'] = snapshot(f'w10-http-{label}', run_download('diarization', d), d, srv)
        d = fresh(BASE / 'corrupt') / 'models'
        srv.ctl([{'match': 'LICENSE', 'action': 'corrupt', 'count': 1}])
        out['w13-corrupt-same-size'] = snapshot('w13-corrupt-same-size', run_download('diarization', d), d, srv)
        srv.ctl([{'match': 'LICENSE', 'action': 'truncate', 'bytes': 10, 'count': 5}])
        d = fresh(BASE / 'truncated') / 'models'
        out['w14-truncated-body'] = snapshot('w14-truncated-body', run_download('diarization', d), d, srv)
        srv.ctl()
        d = fresh(BASE / 'unknown') / 'models'
        for label, payload in (('unknown-id', {'model_id': 'nope'}), ('no-id', {}), ('traversal-id', {'model_id': '../x'}), ('number-id', {'model_id': 5})):
            out[f'w16-{label}'] = snapshot(f'w16-{label}', run_download('x', d, payload=payload), d)
        prx = Proxy()
        try:
            d = fresh(BASE / 'proxy') / 'models'
            env = {'HF_ENDPOINT': 'http://hf-via-proxy.invalid', 'HTTP_PROXY': f'http://127.0.0.1:{PROXY_PORT}', 'http_proxy': f'http://127.0.0.1:{PROXY_PORT}'}
            out['w17a-env-proxy'] = snapshot('w17a-env-proxy', run_download('diarization', d, env), d, srv, {'proxy_requests': len(prx.log), 'proxy_sample': prx.log[:3]})
            d = fresh(BASE / 'noproxy') / 'models'
            out['w17b-no-proxy-same-host'] = snapshot('w17b-no-proxy-same-host', run_download('diarization', d, {'HF_ENDPOINT': 'http://hf-via-proxy.invalid'}), d)
        finally:
            prx.stop()
    finally:
        srv.stop()
    # S15: DISK_FULL through the worker's own pre-check on a real volume: a registry copy that holds a 2 TiB model
    reg = json.loads(REGISTRY.read_text(encoding='utf-8'))
    big = json.loads(json.dumps([m for m in reg['models'] if m['id'] == 'diarization'][0]))
    big['id'] = 'disk-test'
    big['artifacts'] = [{**big['artifacts'][0], 'size': 2 * 2 ** 40}]
    reg['models'].append(big)
    wd = engine_in(fresh(BASE / 'worker-copy'), reg)
    d = fresh(BASE / 'disk') / 'models'
    out['w15-disk-full-precheck'] = snapshot('w15-disk-full-precheck', run_download('disk-test', d, worker_dir=wd), d, None)
    return out


def resume():
    out = {}
    if not have('whisper-small'):
        return out
    srv = Server()
    try:
        srv.log(clear=True)
        d = fresh(BASE / 'resume') / 'models'
        srv.ctl([{'match': 'model.bin', 'action': 'drop_after', 'bytes': 20_000_000, 'count': 50}])
        first = run_download('whisper-small', d)
        partial = [{'path': p.relative_to(d).as_posix(), 'size': p.stat().st_size} for p in sorted((d / '.download').rglob('*.incomplete'))] if (d / '.download').exists() else []
        out['w08a-resume-first-run-drops'] = snapshot('w08a-resume-first-run-drops', first, d, srv, {'partial_files': partial})
        srv.ctl()
        out['w08b-resume-second-run'] = snapshot('w08b-resume-second-run', run_download('whisper-small', d), d, srv)
        shutil.rmtree(BASE / 'resume', ignore_errors=True)
        d = fresh(BASE / 'resume503') / 'models'
        srv.ctl([{'match': 'model.bin', 'action': 'drop_after', 'bytes': 80_000_000, 'count': 1}, {'match': 'model.bin', 'action': 'status', 'status': 503, 'method': 'GET', 'count': 200}])
        first = run_download('whisper-small', d)
        partial = [{'path': p.relative_to(d).as_posix(), 'size': p.stat().st_size} for p in sorted((d / '.download').rglob('*.incomplete'))] if (d / '.download').exists() else []
        out['w08c-drop-then-503-first-run'] = snapshot('w08c-drop-then-503-first-run', first, d, srv, {'partial_files': partial})
        srv.ctl()
        out['w08d-drop-then-503-second-run'] = snapshot('w08d-drop-then-503-second-run', run_download('whisper-small', d), d, srv)
    finally:
        srv.stop()
    return out


def tls():
    out = {}
    if not have('diarization'):
        return out
    openssl = shutil.which('openssl') or next((str(p) for p in (Path(r'C:\Program Files\Git\usr\bin\openssl.exe'),) if p.is_file()), None)
    if not openssl:
        print('skipped: group tls needs openssl')
        return out
    pki = fresh(BASE / 'pki')
    sh = lambda *a: subprocess.run((openssl, *a), cwd=str(pki), check=True, capture_output=True)
    sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=P0A Test CA')
    (pki / 'san.cnf').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n', encoding='utf-8')
    sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost')
    sh('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '30', '-extfile', 'san.cnf')
    srv = Server(tls=(pki / 'srv.pem', pki / 'srv.key'), port=TLS_PORT)
    try:
        ep = f'https://localhost:{TLS_PORT}'
        d = fresh(BASE / 'tls-untrusted') / 'models'
        out['w11a-https-untrusted-ca'] = snapshot('w11a-https-untrusted-ca', run_download('diarization', d, {'HF_ENDPOINT': ep}), d)
        for var in ('SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'HF_HUB_CA_BUNDLE'):
            d = fresh(BASE / f'tls-{var}') / 'models'
            out[f'w11b-https-custom-ca-via-{var}'] = snapshot(f'w11b-https-custom-ca-via-{var}', run_download('diarization', d, {'HF_ENDPOINT': ep, var: str(pki / 'ca.pem')}), d, srv)
    finally:
        srv.stop()
    return out


def real():
    out = {}
    for mid in ('diarization', 'htdemucs'):
        d = fresh(BASE / f'real-{mid}') / 'models'
        out[f'w12-real-{mid}'] = snapshot(f'w12-real-{mid}', run_download(mid, d, {'HF_ENDPOINT': 'https://huggingface.co'}), d)
    return out


def norm(value):
    """Strings: the run folder -> ${RUN}/, the digits of the free-space message -> N, `\\` -> `/`."""
    base = str(BASE).replace('\\', '/') + '/'

    def fix(v):
        if isinstance(v, str):
            v = v.replace('\\', '/').replace(base, '${RUN}/')
            return re.sub(r'(cần khoảng )\d+( MB trống, còn )\d+', r'\g<1>N\g<2>N', v)
        if isinstance(v, dict):
            return {k: fix(x) for k, x in v.items()}
        if isinstance(v, list):
            return [fix(x) for x in v]
        return v
    return fix(value)


def relaxed(events):
    """An error text compared after replacing `(<ExceptionName>)`."""
    return json.loads(re.sub(r'\([A-Za-z]+(Error|Exception)\)', '(<X>)', json.dumps(events, ensure_ascii=False)))


def compare(want, got):
    problems = []
    got = {**got, 'events': norm(got['events'])}
    # the Python hub client also asks for one unrelated metadata path (.../agent-harnesses): not part of the download contract
    if 'proxy_sample' in want:
        extra = [r for r in want['proxy_sample'] if r['target'].endswith('/api/agent-harnesses')]
        want = {**want, 'proxy_sample': [r for r in want['proxy_sample'] if r not in extra], 'proxy_requests': want['proxy_requests'] - len(extra)}
        got = {**got, 'proxy_sample': got['proxy_sample'][:len(want['proxy_sample'])]}
    for key in ('exit_code', 'tree', 'leftovers', 'server_log', 'partial_files', 'proxy_requests', 'proxy_sample'):
        if key in want and want[key] != got.get(key):
            problems.append(f'{key}: want {json.dumps(want[key])[:DETAIL]}; got {json.dumps(got.get(key))[:DETAIL]}')
    if relaxed(want['events']) != relaxed(got['events']):
        problems.append(f"events: want {json.dumps(want['events'], ensure_ascii=False)[:400]}; got {json.dumps(got['events'], ensure_ascii=False)[:400]}")
    elif want['events'] != got['events']:
        print('   note: an exception name in an error text differs (allowed by the rule)')
    return problems


def main():
    global ARGS, BASE, ENGINE_DIR
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe')
    ap.add_argument('--python')
    ap.add_argument('--main')
    ap.add_argument('--models', required=True)
    ap.add_argument('--groups', default='basic,resume,tls')
    ap.add_argument('--only', default='')
    ARGS = ap.parse_args()
    if not ARGS.exe and not (ARGS.python and ARGS.main):
        ap.error('give --exe, or --python and --main')
    ARGS.exe = str(Path(ARGS.exe).resolve()) if ARGS.exe else None
    ARGS.models = str(Path(ARGS.models).resolve())
    BASE = Path(tempfile.mkdtemp(prefix='wc-')).resolve()
    ENGINE_DIR = engine_in(BASE / 'engine')
    golden = json.loads((GW / 'golden.json').read_text(encoding='utf-8'))['scenarios']
    groups = {'basic': basic, 'resume': resume, 'tls': tls, 'real': real}
    passed, failed, ran = 0, [], set()
    try:
        for name in ARGS.groups.split(','):
            for scenario, rec in groups[name]().items():
                if ARGS.only not in scenario:
                    continue
                ran.add(scenario)
                problems = compare(golden[scenario], rec)
                if problems:
                    failed.append(scenario)
                    print('FAIL', scenario, *problems, sep='\n   ', flush=True)
                    if rec['stderr_tail'].strip():
                        print('   stderr:', rec['stderr_tail'].strip()[:300])
                else:
                    passed += 1
                    print('ok  ', scenario, flush=True)
    finally:
        shutil.rmtree(BASE, ignore_errors=True)
    skipped = sorted(set(golden) - ran)
    print(f'row W: {passed} passed, {len(failed)} failed, {len(skipped)} not run {skipped}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
