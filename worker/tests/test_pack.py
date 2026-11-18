"""The separation runtime pack: installing it (worker/main.py), pinning it (scripts/pin_pack.py) and its registry entry."""
import hashlib
import http.server
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / 'scripts'))
import main as worker
import build_pack
import pin_pack

LONG = 'Lib/site-packages/package/' + 'n' * 40 + '.txt'


def make_tree(root: Path, extra=None):
    files = {'python.exe': b'MZ', 'Lib/site-packages/torch/__init__.py': b'x = 1\n', LONG: b'long', **(extra or {})}
    for rel, data in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(data)
    return root


def make_pack(tmp: Path, tree: Path, number=1):
    """Manifest and zip of a tree, with the pin worker/models.json would carry."""
    build_pack.write_manifest(tree)
    asset = tmp / f'separation-runtime-v{number}.zip'
    build_pack.zip_tree(tree, asset)
    longest = build_pack.longest_path(tree)
    return {'url': '', 'size': asset.stat().st_size, 'unpacked_size': sum(p.stat().st_size for _, p in build_pack.files(tree)),
            'sha256': build_pack.sha256(asset), 'manifest_sha256': build_pack.sha256(tree / build_pack.MANIFEST), 'files': 1, 'longest_path': longest}, asset


class RangeHandler(http.server.BaseHTTPRequestHandler):
    """Serves one file with Range support and records every Range header it saw."""
    body = b''
    ranges = []

    def do_GET(self):
        start = 0
        header = self.headers.get('Range')
        type(self).ranges.append(header)
        if header:
            start = int(header.split('=')[1].split('-')[0])
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{len(self.body) - 1}/{len(self.body)}')
        else:
            self.send_response(200)
        self.send_header('Content-Length', str(len(self.body) - start))
        self.end_headers()
        self.wfile.write(self.body[start:])

    def log_message(self, *args):
        pass


class PackTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name).resolve()  # the worker resolves its folders: a short 8.3 temp path would otherwise expand
        self.addCleanup(self._tmp.cleanup)

    def serve(self, asset: Path):
        handler = type('Handler', (RangeHandler,), {'body': asset.read_bytes(), 'ranges': []})
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f'http://127.0.0.1:{server.server_port}/{asset.name}', handler

    def spec(self, pin, url, revision='separation-v1'):
        return {'id': 'separation-runtime', 'kind': 'runtime', 'revision': revision, 'artifacts': [], 'pack': {**pin, 'url': url}}

    def install(self, spec, models: Path, accepted='2026-11-18T00:00:00+00:00'):
        payload = {'model_id': 'separation-runtime', **({'license_accepted_at': accepted} if accepted else {})}
        return worker.install_pack(spec, payload, models, lambda *a: None)

    def packed(self, extra=None, number=1):
        tree = make_tree(self.tmp / 'tree', extra)
        pin, asset = make_pack(self.tmp, tree, number)
        url, handler = self.serve(asset)
        return pin, asset, url, handler

    def test_the_worker_reads_the_manifest_the_builder_writes(self):
        tree = make_tree(self.tmp / 'tree')
        build_pack.write_manifest(tree)
        entries = worker.parse_pack_manifest((tree / build_pack.MANIFEST).read_text(encoding='utf-8'))
        self.assertEqual([rel for _, _, rel in entries], [rel for rel, _ in build_pack.files(tree) if rel != build_pack.MANIFEST])
        for digest, size, rel in entries:
            data = (tree / rel).read_bytes()
            self.assertEqual((digest, size), (hashlib.sha256(data).hexdigest(), len(data)))

    def test_pin_pack_writes_the_published_pin_into_the_registry(self):
        registry = self.tmp / 'models.json'
        shutil.copy(ROOT / 'models.json', registry)
        pin = {'revision': 'separation-v1', 'url': 'https://example.invalid/p.zip', 'size': 7, 'unpacked_size': 9, 'sha256': 'a' * 64,
               'manifest_sha256': 'b' * 64, 'files': 3, 'longest_path': 120}
        (self.tmp / 'pin.json').write_text(json.dumps(pin), encoding='utf-8')
        pin_pack.pin(self.tmp / 'pin.json', registry)
        entry = [m for m in json.loads(registry.read_text(encoding='utf-8'))['models'] if m['id'] == 'separation-runtime'][0]
        self.assertEqual(entry['pack'], {k: pin[k] for k in pin_pack.FIELDS})
        (self.tmp / 'pin.json').write_text(json.dumps({**pin, 'revision': 'separation-v2'}), encoding='utf-8')
        with self.assertRaises(SystemExit):
            pin_pack.pin(self.tmp / 'pin.json', registry)

    def test_the_registry_entry_is_a_runtime_pack(self):
        entry = worker.model_spec('separation-runtime')
        self.assertEqual((entry['kind'], entry['revision']), ('runtime', 'separation-v1'))
        self.assertEqual(set(entry['pack']), set(pin_pack.FIELDS))
        self.assertEqual(entry['revision'], 'separation-v' + entry['pack']['url'].split('pack-separation-v')[1].split('/')[0])

    # install_pack

    def test_the_pack_installs_straight_into_its_folder_with_the_marker_last(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        models.mkdir()
        result = self.install(self.spec(pin, url), models)
        destination = models / 'separation-runtime'
        self.assertEqual(result['revision'], 'separation-v1')
        self.assertEqual(build_pack.verify_tree(destination, pin['manifest_sha256']), [])
        marker = json.loads((destination / 'installed.json').read_text(encoding='utf-8'))
        self.assertEqual((marker['model_id'], marker['revision'], marker['manifest_sha256'], marker['license_accepted_at']),
                         ('separation-runtime', 'separation-v1', pin['manifest_sha256'], '2026-11-18T00:00:00+00:00'))
        self.assertFalse((models / '.download' / 'separation-runtime').exists())

    def test_installing_needs_the_licence_to_be_accepted(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        models.mkdir()
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec(pin, url), models, accepted=None)
        self.assertEqual(ctx.exception.code, 'LICENSE_NOT_ACCEPTED')
        self.assertEqual(handler.ranges, [])
        self.assertFalse((models / 'separation-runtime').exists())

    def test_an_unpublished_pin_is_refused_before_any_download(self):
        models = self.tmp / 'models'
        models.mkdir()
        spec = self.spec({'size': 0, 'url': 'http://127.0.0.1:9/x.zip'}, '')
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(spec, models)
        self.assertEqual(ctx.exception.code, 'MODEL_NOT_READY')

    def test_a_cut_off_download_resumes_from_its_part_file(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        part = models / '.download' / 'separation-runtime' / (asset.name + '.part')
        part.parent.mkdir(parents=True)
        part.write_bytes(asset.read_bytes()[:50])
        self.install(self.spec(pin, url), models)
        self.assertEqual(handler.ranges, ['bytes=50-'])
        self.assertEqual(build_pack.verify_tree(models / 'separation-runtime', pin['manifest_sha256']), [])

    def test_a_pack_that_differs_from_its_pin_is_refused_and_left_uninstalled(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        models.mkdir()
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec({**pin, 'sha256': '0' * 64}, url), models)
        self.assertEqual(ctx.exception.code, 'MODEL_CHECKSUM')
        self.assertFalse((models / 'separation-runtime').exists())
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec({**pin, 'manifest_sha256': '0' * 64}, url), models)
        self.assertEqual(ctx.exception.code, 'MODEL_CHECKSUM')
        self.assertFalse((models / 'separation-runtime').exists())

    def test_an_unreachable_server_is_a_network_error_and_keeps_nothing_installed(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        models.mkdir()
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec(pin, 'http://127.0.0.1:9/gone.zip'), models)
        self.assertEqual(ctx.exception.code, 'NETWORK')
        self.assertFalse((models / 'separation-runtime' / 'installed.json').exists())

    def test_a_zip_with_a_path_outside_the_folder_is_refused(self):
        evil = '../evil.txt'
        tree = self.tmp / 'tree'
        make_tree(tree)
        build_pack.write_manifest(tree)
        manifest = (tree / build_pack.MANIFEST).read_text(encoding='utf-8') + f"{hashlib.sha256(b'pwn').hexdigest()}  3  {evil}\n"
        asset = self.tmp / 'evil.zip'
        with zipfile.ZipFile(asset, 'w') as z:
            z.writestr(build_pack.MANIFEST, manifest)
            z.writestr(evil, b'pwn')
            for rel, path in build_pack.files(tree):
                if rel != build_pack.MANIFEST:
                    z.write(path, rel)
        pin = {'size': asset.stat().st_size, 'sha256': build_pack.sha256(asset), 'manifest_sha256': hashlib.sha256(manifest.encode('utf-8')).hexdigest(),
               'longest_path': 0, 'unpacked_size': 0}
        url, _ = self.serve(asset)
        models = self.tmp / 'models'
        models.mkdir()
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec(pin, url), models)
        self.assertEqual(ctx.exception.code, 'INVALID_PATH')
        self.assertFalse((self.tmp / 'evil.txt').exists() or (models / 'evil.txt').exists())
        self.assertFalse((models / 'separation-runtime').exists())

    def test_a_zip_with_a_file_the_manifest_does_not_list_is_refused(self):
        tree = make_tree(self.tmp / 'tree')
        pin, asset = make_pack(self.tmp, tree)
        with zipfile.ZipFile(asset, 'a') as z:
            z.writestr('unlisted.dll', b'x')
        pin = {**pin, 'size': asset.stat().st_size, 'sha256': build_pack.sha256(asset)}
        url, _ = self.serve(asset)
        models = self.tmp / 'models'
        models.mkdir()
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec(pin, url), models)
        self.assertEqual(ctx.exception.code, 'MODEL_CHECKSUM')
        self.assertFalse((models / 'separation-runtime').exists())

    def deep_models(self, room):
        """A models folder whose `separation-runtime` folder leaves `room` characters of the 259 for a path inside it."""
        length = worker.PACK_PATH_LIMIT - room - 1 - len('separation-runtime') - 1
        models = self.tmp / ('m' * (length - len(str(self.tmp)) - 1))
        models.mkdir()
        return models

    def test_a_root_that_is_too_long_for_the_longest_path_is_refused_before_extraction(self):
        pin, asset, url, handler = self.packed()
        longest = pin['longest_path']
        # The pin knows the longest path: refused before the download starts.
        models = self.deep_models(longest - 1)
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec(pin, url), models)
        self.assertEqual((ctx.exception.code, handler.ranges), ('PACK_PATH_TOO_LONG', []))
        self.assertEqual(str(ctx.exception), 'Đường dẫn thư mục dữ liệu quá dài nên không cài được gói tách nhạc nền.')
        # A pin that understates it: the manifest's own longest path refuses it before anything is extracted.
        with self.assertRaises(worker.WorkerError) as ctx:
            self.install(self.spec({**pin, 'longest_path': 0}, url), models)
        self.assertEqual(ctx.exception.code, 'PACK_PATH_TOO_LONG')
        self.assertFalse((models / 'separation-runtime').exists())
        # Exactly at the limit it installs.
        models = self.deep_models(longest)
        self.install(self.spec(pin, url), models)
        self.assertEqual(build_pack.verify_tree(models / 'separation-runtime', pin['manifest_sha256']), [])

    def test_a_new_revision_replaces_the_old_tree(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        old = models / 'separation-runtime'
        old.mkdir(parents=True)
        (old / 'old-only.dll').write_bytes(b'old')
        (old / 'installed.json').write_text(json.dumps({'model_id': 'separation-runtime', 'revision': 'separation-v0'}), encoding='utf-8')
        self.install(self.spec(pin, url, revision='separation-v1'), models)
        self.assertFalse((old / 'old-only.dll').exists())
        self.assertEqual(build_pack.verify_tree(old, pin['manifest_sha256']), [])

    def installed(self):
        pin, asset, url, handler = self.packed()
        models = self.tmp / 'models'
        models.mkdir()
        spec = self.spec(pin, url)
        self.install(spec, models)
        return spec, models, handler

    def test_an_installed_pack_is_verified_again_without_downloading_or_asking_for_the_licence(self):
        spec, models, handler = self.installed()
        before = list(handler.ranges)
        result = worker.install_pack(spec, {'model_id': 'separation-runtime'}, models, lambda *a: None)
        self.assertIs(result['verified'], True)
        self.assertEqual(handler.ranges, before)

    def test_a_tampered_pack_gives_model_checksum_and_is_offered_for_download_again(self):
        spec, models, handler = self.installed()
        destination = models / 'separation-runtime'
        (destination / 'Lib/site-packages/torch/__init__.py').write_bytes(b'x = 2\n')  # same size, other bytes
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.install_pack(spec, {'model_id': 'separation-runtime'}, models, lambda *a: None)
        self.assertEqual(ctx.exception.code, 'MODEL_CHECKSUM')
        self.assertIn('changed: Lib/site-packages/torch/__init__.py', str(ctx.exception))
        self.assertFalse((destination / 'installed.json').exists())

    def test_a_pack_with_a_missing_or_an_extra_file_fails_the_check(self):
        for damage in ('missing', 'extra'):
            with self.subTest(damage=damage):
                self.setUp()
                spec, models, handler = self.installed()
                destination = models / 'separation-runtime'
                if damage == 'missing':
                    (destination / LONG).unlink()
                else:
                    (destination / 'Lib' / '__pycache__').mkdir()
                    (destination / 'Lib' / '__pycache__' / 'new.cpython-311.pyc').write_bytes(b'x')
                with self.assertRaises(worker.WorkerError) as ctx:
                    worker.install_pack(spec, {'model_id': 'separation-runtime'}, models, lambda *a: None)
                self.assertEqual(ctx.exception.code, 'MODEL_CHECKSUM')
                self.assertIn(damage + ':', str(ctx.exception))

    def test_download_dispatches_a_runtime_entry_to_the_pack_installer(self):
        from unittest import mock
        spec = self.spec({'size': 0}, '')
        with mock.patch.object(worker, 'model_spec', return_value=spec), mock.patch.object(worker, 'install_pack', return_value={'ok': 1}) as install:
            self.assertEqual(worker.download({'model_id': 'separation-runtime'}, self.tmp, lambda *a: None), {'ok': 1})
        install.assert_called_once()


if __name__ == '__main__':
    unittest.main()
