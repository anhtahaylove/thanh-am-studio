"""scripts/build_pack.py: what goes into the separation runtime pack and how its manifest and zip are made."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / 'scripts'))
import build_pack

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
            sbom = json.dumps({'components': components}).encode('utf-8')
            return make_tree(self.tmp / f'tree{len(list(self.tmp.iterdir()))}', {
                'Lib/site-packages/torch-1.dist-info/METADATA': b'Name: torch\nVersion: 1\n',
                'Lib/site-packages/demucs-4.dist-info/METADATA': b'Name: demucs\nVersion: 4\n',
                'Lib/site-packages/safetensors-0.8.0.dist-info/METADATA': b'Name: safetensors\nVersion: 0.8.0\n',
                'Lib/site-packages/safetensors-0.8.0.dist-info/sboms/s.cyclonedx.json': sbom})
        itoa = {'name': 'itoa', 'version': '1.0.18', 'scope': 'required', 'purl': 'pkg:cargo/itoa@1.0.18', 'licenses': [{'expression': 'MIT OR Apache-2.0'}]}
        build_only = {'name': 'cc', 'version': '1.2.56', 'scope': 'excluded', 'purl': 'pkg:cargo/cc@1.2.56'}
        own_code = {'name': 'safetensors', 'version': '0.8.0', 'scope': 'required', 'purl': 'pkg:cargo/safetensors@0.8.0?download_url=file://D:/a'}
        texts = {'itoa': ['itoa licence\n']}
        with mock.patch.object(build_pack, 'crate_licences', lambda name, version: texts.get(name, [])):
            tree = tree_with([itoa, build_only, own_code])
            build_pack.move_licences(tree)
            notices = (tree / build_pack.NOTICES).read_text(encoding='utf-8')
            self.assertIn(f"{'=' * 78}\nitoa 1.0.18 (cargo) — MIT OR Apache-2.0\n{'=' * 78}\n"
                          'In the Rust dependency tree of these Python wheels of the runtime: safetensors 0.8.0\n'
                          'Source: https://crates.io/crates/itoa/1.0.18\n\nitoa licence\n', notices)
            self.assertNotIn('cc 1.2.56', notices)
            self.assertNotIn('safetensors 0.8.0 (cargo)', notices)
            git = {**itoa, 'purl': 'pkg:cargo/itoa@1.0.18?vcs_url=git%2Bhttps://example.invalid/itoa'}
            for components in ([git], [{**itoa, 'name': 'unlicensed', 'purl': 'pkg:cargo/unlicensed@1.0.18'}]):
                with self.assertRaises(SystemExit):
                    build_pack.move_licences(tree_with(components))

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
