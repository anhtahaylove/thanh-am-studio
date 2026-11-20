"""scripts/build_pack.py: what goes into the separation runtime pack and how its manifest and zip are made."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / 'scripts'))
import build_pack
import wheel_crates

LONG = 'Lib/site-packages/package/' + 'n' * 40 + '.txt'


def make_tree(root: Path, extra=None):
    files = {'python.exe': b'MZ', 'Lib/site-packages/torch/__init__.py': b'x = 1\n', LONG: b'long', **(extra or {})}
    for rel, data in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_bytes(data)
    return root


class BuildPackTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_licence_trees_move_into_the_notices_byte_for_byte(self):
        tree = make_tree(self.tmp / 'tree', {
            'Lib/site-packages/torch-1.dist-info/METADATA': b'Name: torch\nVersion: 1\n',
            'Lib/site-packages/demucs-4.dist-info/METADATA': b'Name: demucs\nVersion: 4\n',
            'Lib/site-packages/torch-1.dist-info/licenses/LICENSE': 'BSD â licence\n'.encode('utf-8'),
            'Lib/site-packages/torch-1.dist-info/licenses/deep/NOTICE': b'notice text\n'})
        moved = build_pack.move_licences(tree)
        self.assertEqual(moved, 2)
        self.assertEqual(list(tree.rglob('licenses')), [])
        notices = (tree / build_pack.NOTICES).read_bytes()
        self.assertIn('BSD â licence\n'.encode('utf-8'), notices)
        self.assertIn(b'notice text\n', notices)
        self.assertIn(b'Lib/site-packages/torch-1.dist-info/licenses/deep/NOTICE', notices)
        for needed in build_pack.REQUIRED_NOTICES:
            self.assertIn(needed.encode('utf-8'), notices)

    def test_the_rust_crates_in_a_wheel_sbom_join_the_notices(self):
        def tree_with(components):
            # a maturin wheel whose dist-info folder name differs from its distribution name, as hf_xet's does
            files = {'Lib/site-packages/torch-1.dist-info/METADATA': b'Name: torch\nVersion: 1\n',
                     'Lib/site-packages/demucs-4.dist-info/METADATA': b'Name: demucs\nVersion: 4\n',
                     'Lib/site-packages/hf_xet-1.8.0.dist-info/METADATA': b'Name: hf-xet\nVersion: 1.8.0\n',
                     'Lib/site-packages/hf_xet-1.8.0.dist-info/WHEEL': b'Wheel-Version: 1.0\nGenerator: maturin (1.16.0)\n'}
            if components is not None:
                files['Lib/site-packages/hf_xet-1.8.0.dist-info/sboms/hf_xet.cyclonedx.json'] = json.dumps({'components': components}).encode('utf-8')
            return make_tree(self.tmp / f'tree{len(list(self.tmp.iterdir()))}', files)
        itoa = {'name': 'itoa', 'version': '1.0.18', 'scope': 'required', 'purl': 'pkg:cargo/itoa@1.0.18', 'licenses': [{'expression': 'MIT OR Apache-2.0'}]}
        build_only = {'name': 'cc', 'version': '1.2.56', 'scope': 'excluded', 'purl': 'pkg:cargo/cc@1.2.56'}
        own_code = {'name': 'hf_xet', 'version': '1.8.0', 'scope': 'required', 'purl': 'pkg:cargo/hf_xet@1.8.0?download_url=file://D:/a'}
        onig = {'name': 'onig_sys', 'version': '69.9.3', 'scope': 'required', 'purl': 'pkg:cargo/onig_sys@69.9.3', 'licenses': [{'expression': 'MIT'}]}
        texts = {'itoa': ['itoa licence\n'], 'onig_sys': ['oniguruma licence\n']}
        with mock.patch.object(build_pack, 'crate_licences', lambda name, version: texts.get(name, [])):
            tree = tree_with([itoa, build_only, own_code, onig])
            build_pack.move_licences(tree)
            notices = (tree / build_pack.NOTICES).read_text(encoding='utf-8')
            self.assertIn('\nonig_sys 69.9.3 (cargo) — MIT AND BSD-2-Clause\n', notices)  # the SBOM's MIT and the Oniguruma it bundles
            self.assertIn(f"{'=' * 78}\nitoa 1.0.18 (cargo) — MIT OR Apache-2.0\n{'=' * 78}\n"
                          'In the Rust dependency tree of these Python wheels of the runtime: hf-xet 1.8.0\n'
                          'Source: https://crates.io/crates/itoa/1.0.18\n\nitoa licence\n', notices)
            self.assertNotIn('cc 1.2.56', notices)
            self.assertNotIn('hf_xet 1.8.0 (cargo)', notices)
            git = {**itoa, 'purl': 'pkg:cargo/itoa@1.0.18?vcs_url=git%2Bhttps://example.invalid/itoa'}
            for components, message in (([git], 'is not a plain crates.io crate'),
                                        ([{**itoa, 'name': 'unlicensed', 'purl': 'pkg:cargo/unlicensed@1.0.18'}], 'its crate ships no licence file'),
                                        (None, 'built by maturin but has no sboms/ folder')):
                with self.assertRaisesRegex(SystemExit, message):
                    build_pack.move_licences(tree_with(components))

    def test_a_crate_licence_is_read_from_the_verified_crate_and_must_be_text(self):
        def crate(licence):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as tar:
                info = tarfile.TarInfo('itoa-1.0.18/LICENSE-MIT')
                info.size = len(licence)
                tar.addfile(info, io.BytesIO(licence))
            return data.getvalue()
        cached = self.tmp / 'thanham-crate-cache' / 'itoa-1.0.18.crate'
        cached.parent.mkdir()
        cached.write_bytes(b'a damaged copy')
        for licence in (b'MIT licence\r\n', b'MIT\0licence\n'):
            data = crate(licence)
            index = json.dumps({'vers': '1.0.18', 'cksum': hashlib.sha256(data).hexdigest()}).encode('utf-8')
            fetch = lambda url, timeout: io.BytesIO(index if url.startswith('https://index.crates.io/') else data)
            # RUNNER_TEMP is read when a crate is fetched, so the cache lands in this test's folder
            with mock.patch.object(wheel_crates.urllib.request, 'urlopen', fetch), mock.patch.dict(os.environ, {'RUNNER_TEMP': str(self.tmp)}):
                if b'\0' in licence:
                    with self.assertRaisesRegex(SystemExit, 'contains NUL bytes'):
                        wheel_crates.crate_licences('itoa', '1.0.18')
                else:
                    self.assertEqual(wheel_crates.crate_licences('itoa', '1.0.18'), ['MIT licence\n'])
                    self.assertEqual(cached.read_bytes(), data)  # the verified download replaced the damaged copy

    def test_a_crate_folder_gives_its_vendored_licences_and_their_spdx_ids(self):
        crate = self.tmp / 'libz-sys-1.1.33'
        (crate / 'src' / 'zlib').mkdir(parents=True)
        (crate / 'LICENSE-MIT').write_bytes(b'MIT licence\n')
        with self.assertRaisesRegex(SystemExit, 'update VENDORED_LICENSES'):
            wheel_crates.crate_dir_licences('libz-sys', crate)
        (crate / 'src' / 'zlib' / 'LICENSE').write_bytes(b'zlib licence\n')
        self.assertEqual(wheel_crates.crate_dir_licences('libz-sys', crate), [crate / 'LICENSE-MIT', crate / 'src/zlib/LICENSE'])
        self.assertEqual(wheel_crates.licence_with_vendored('libz-sys', 'MIT OR Apache-2.0'), '(MIT OR Apache-2.0) AND Zlib')
        self.assertEqual(wheel_crates.licence_with_vendored('onig_sys', 'MIT'), 'MIT AND BSD-2-Clause')
        self.assertEqual(wheel_crates.licence_with_vendored('regex-syntax', 'MIT OR Apache-2.0'), '(MIT OR Apache-2.0) AND Unicode-DFS-2016')
        self.assertEqual(wheel_crates.licence_with_vendored('itoa', 'MIT OR Apache-2.0'), 'MIT OR Apache-2.0')
        self.assertLessEqual(set(wheel_crates.VENDORED_SPDX), set(wheel_crates.VENDORED_LICENSES))

    def test_an_mpl_crate_points_to_its_source_only_from_crates_io(self):
        for index in ('registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'):
            self.assertEqual(wheel_crates.mpl_source('selectors', '0.24.0', 'MPL-2.0', index), 'Source: https://crates.io/crates/selectors/0.24.0\n\n')
        self.assertEqual(wheel_crates.mpl_source('itoa', '1.0.18', 'MIT OR Apache-2.0', 'git+https://example.invalid/itoa'), '')
        with self.assertRaisesRegex(SystemExit, 'not crates.io'):
            wheel_crates.mpl_source('selectors', '0.24.0', 'MPL-2.0', 'git+https://example.invalid/selectors')

    def test_a_licence_file_that_is_not_utf8_stops_the_build(self):
        tree = make_tree(self.tmp / 'tree', {'Lib/site-packages/x-1.dist-info/licenses/LICENSE': b'\xff\xfe'})
        with self.assertRaises(SystemExit):
            build_pack.move_licences(tree)

    def test_the_path_budget_stops_a_pack_with_a_path_that_is_too_long(self):
        ok = make_tree(self.tmp / 'ok', {'a/' + 'b' * 100: b'x'})
        self.assertEqual(build_pack.check_budget(ok), 102)
        # 9 + 40 + 64 + 146 = 259 fits, one more character does not.
        edge = make_tree(self.tmp / 'edge', {'x' * 146: b'x'})
        self.assertEqual(build_pack.check_budget(edge), 146)
        over = make_tree(self.tmp / 'over', {'x' * 147: b'x'})
        with self.assertRaises(SystemExit):
            build_pack.check_budget(over)

    def test_the_manifest_lists_every_file_and_catches_a_change_a_loss_and_an_extra_file(self):
        tree = make_tree(self.tmp / 'tree')
        count = build_pack.write_manifest(tree)
        self.assertEqual(count, 3)
        lines = (tree / build_pack.MANIFEST).read_text(encoding='utf-8').splitlines()
        paths = [line.split('  ', 2)[2] for line in lines]
        self.assertEqual(paths, sorted(paths))
        for line, rel in zip(lines, paths):
            data = (tree / rel).read_bytes()
            self.assertEqual(line, f'{hashlib.sha256(data).hexdigest()}  {len(data)}  {rel}')
        self.assertEqual(build_pack.verify_tree(tree), [])
        (tree / 'python.exe').write_bytes(b'MZ!')
        (tree / LONG).unlink()
        (tree / 'extra.pyc').write_bytes(b'x')
        self.assertEqual(sorted(p.split(':')[0] for p in build_pack.verify_tree(tree)), ['changed', 'extra', 'missing'])
        (tree / 'installed.json').write_text('{}')  # the marker is not part of the pack
        self.assertNotIn('extra: installed.json', build_pack.verify_tree(tree))

    def test_the_zip_is_reproducible_and_starts_with_the_manifest(self):
        tree = make_tree(self.tmp / 'tree')
        build_pack.write_manifest(tree)
        build_pack.zip_tree(tree, self.tmp / 'a.zip')
        build_pack.zip_tree(tree, self.tmp / 'b.zip')
        self.assertEqual(build_pack.sha256(self.tmp / 'a.zip'), build_pack.sha256(self.tmp / 'b.zip'))
        with zipfile.ZipFile(self.tmp / 'a.zip') as z:
            self.assertEqual(z.namelist()[0], build_pack.MANIFEST)


if __name__ == '__main__':
    unittest.main()
