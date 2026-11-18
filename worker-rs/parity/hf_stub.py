r"""hf_stub.py <port> --models <folder> --registry <models.json> [--tls CERT KEY]: a local stand-in for the Hugging Face resolve endpoint, used only for the
row W download parity runs (HF_ENDPOINT=http://127.0.0.1:<port>). Taken from P0-A's hf_server.py, which served the goldens. It serves exactly the files of the
registry (repo, revision, filename) from the verified local model folders (<folder>\\<id>\\<artifact path>), with HEAD, GET and Range, and logs every request.
Fault injection (drop_after, corrupt and truncate act on GET only) through POST /_ctl {"rules": [...], "reset": bool}: each rule {"match": "<substring of the filename>", "action": ..., ...}, applied in order,
decrementing "count" (default 1) per use:
  drop_after  {"bytes": N}   send N body bytes of a GET, then close the connection (a network drop)
  status      {"status": S, "method": "GET"}  answer HEAD and GET (or only the named method) with this HTTP status and a short JSON error body
  corrupt                    flip the first byte of the body (same size): a checksum failure
  truncate    {"bytes": N}   serve only the first N bytes with a consistent Content-Length (a size failure)
GET /_log returns the request log, GET /_ctl/clear empties it."""
import json
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOCK = threading.Lock()
LOG, RULES, FILES = [], [], {}


def build_index(models, registry_path):
    registry = json.loads(Path(registry_path).read_text(encoding='utf-8'))['models']
    for m in registry:
        for a in m.get('artifacts', []):
            if 'repo' in a:
                FILES[f"/{a['repo']}/resolve/{a['revision']}/{a['filename']}"] = (models / m['id'] / a['path'], a)


def take_rule(path, method):
    with LOCK:
        for rule in RULES:
            if rule['match'] in path and rule.get('count', 1) > 0 and (rule['action'] == 'status' and rule.get('method', method) == method or
                                                                       rule['action'] != 'status' and method == 'GET'):
                rule['count'] = rule.get('count', 1) - 1
                return dict(rule)
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def record(self, **kw):
        with LOCK:
            LOG.append({'method': self.command, 'path': self.path, 'range': self.headers.get('Range'), **kw})

    def reply(self, status, body=b'', headers=None):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.handle_request()

    def do_POST(self):
        if self.path == '/_ctl':
            data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            with LOCK:
                if data.get('reset'):
                    RULES.clear()
                RULES.extend(data.get('rules', []))
            return self.reply(200, b'{}')
        self.reply(404)

    def do_GET(self):
        if self.path == '/_log':
            with LOCK:
                return self.reply(200, json.dumps(LOG).encode(), {'Content-Type': 'application/json'})
        if self.path == '/_ctl/clear':
            with LOCK:
                LOG.clear()
            return self.reply(200, b'{}')
        self.handle_request()

    def handle_request(self):
        path = self.path.split('?')[0]
        entry = FILES.get(path)
        if not entry:
            self.record(status=404)
            return self.reply(404, b'{"error":"Entry not found"}', {'Content-Type': 'application/json', 'X-Error-Code': 'EntryNotFound'})
        local, art = entry
        rule = take_rule(path, self.command)
        if rule and rule['action'] == 'status':
            self.record(status=rule['status'], fault='status')
            return self.reply(rule['status'], b'{"error":"injected"}', {'Content-Type': 'application/json'})
        size = local.stat().st_size
        if rule and rule['action'] == 'truncate':
            size = min(size, rule['bytes'])
        headers = {'ETag': '"' + (art.get('sha256') or art['git_blob_sha1']) + '"', 'X-Repo-Commit': art['revision'], 'Accept-Ranges': 'bytes',
                   'Content-Type': 'application/octet-stream'}
        start = 0
        rng = self.headers.get('Range')
        status = 200
        if rng and rng.startswith('bytes=') and self.command == 'GET':
            start = int(rng[6:].split('-')[0])
            status = 206
            headers['Content-Range'] = f'bytes {start}-{size - 1}/{size}'
        length = size - start
        if self.command == 'HEAD':
            self.record(status=200, length=size)
            self.send_response(200)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(size))
            self.end_headers()
            return
        limit = rule['bytes'] if rule and rule['action'] == 'drop_after' else length
        self.record(status=status, **({'fault': 'drop_after', 'sent': limit} if rule and rule['action'] == 'drop_after' else {'sent': length}))
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(length))
        self.end_headers()
        try:
            with local.open('rb') as f:
                f.seek(start)
                left, first = limit, True
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    if first and rule and rule['action'] == 'corrupt':
                        chunk = bytes([chunk[0] ^ 0xFF]) + chunk[1:]
                    first = False
                    self.wfile.write(chunk)
                    left -= len(chunk)
            self.wfile.flush()
            if limit < length:
                self.close_connection = True
                self.connection.close()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port = int(sys.argv[1])
    build_index(Path(sys.argv[sys.argv.index('--models') + 1]), sys.argv[sys.argv.index('--registry') + 1])
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    if '--tls' in sys.argv:
        i = sys.argv.index('--tls')
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(sys.argv[i + 1], sys.argv[i + 2])
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print('listening', port, len(FILES), 'files', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
