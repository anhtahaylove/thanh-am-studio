"""Generate the release SBOM (CycloneDX 1.5 JSON) and THIRD-PARTY-NOTICES.txt.

usage: python scripts/third_party.py <out_dir>
Inventories what the installer ships: Rust crates linked into the app, npm packages bundled
into the UI, the private Python runtime packages and the FFmpeg build. Run after
scripts/setup-runtime.ps1 and npm install.
"""
import json, pathlib, re, subprocess, sys
from email.parser import HeaderParser

ROOT = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
components, notices = [], []
LICENSE_FILE = re.compile(r'^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)', re.I)

def add(kind, name, version, license_, purl, files):
    components.append({'type': 'library', 'name': name, 'version': version, 'purl': purl,
                       'licenses': [{'expression': license_ or 'NOASSERTION'}], 'properties': [{'name': 'ecosystem', 'value': kind}]})
    texts = []
    for f in files:
        try: texts.append(f.read_text(encoding='utf-8', errors='replace').strip())
        except OSError: pass
    notices.append(f"{'=' * 78}\n{name} {version} ({kind}) — {license_ or 'NOASSERTION'}\n{'=' * 78}\n" + ('\n\n'.join(texts) or '(no license file shipped by the package; see its source repository)'))

# Rust: normal (non-dev, non-build) dependencies reachable from the app crate.
meta = json.loads(subprocess.check_output(['cargo', 'metadata', '--format-version', '1', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc'],
                                          cwd=ROOT / 'src-tauri'))
pkgs = {p['id']: p for p in meta['packages']}
nodes = {n['id']: n for n in meta['resolve']['nodes']}
seen, stack = set(), [meta['resolve']['root']]
while stack:
    pid = stack.pop()
    if pid in seen: continue
    seen.add(pid)
    for d in nodes[pid]['deps']:
        if any(k['kind'] in (None, 'normal') for k in d['dep_kinds']): stack.append(d['pkg'])
for pid in sorted(seen - {meta['resolve']['root']}, key=lambda i: pkgs[i]['name']):
    p = pkgs[pid]; d = pathlib.Path(p['manifest_path']).parent
    add('cargo', p['name'], p['version'], p.get('license'), f"pkg:cargo/{p['name']}@{p['version']}", [f for f in sorted(d.iterdir()) if LICENSE_FILE.match(f.name) and f.is_file()])

# npm: production dependency tree bundled by Vite.
def walk(tree, acc):
    for name, info in (tree.get('dependencies') or {}).items():
        if (name, info.get('version')) not in acc:
            acc[(name, info.get('version'))] = info; walk(info, acc)
    return acc
tree = json.loads(subprocess.run('npm ls --omit=dev --all --json', shell=True, cwd=ROOT, capture_output=True, text=True).stdout)
for (name, version), _ in sorted(walk(tree, {}).items()):
    d = ROOT / 'node_modules' / name
    pj = json.loads((d / 'package.json').read_text(encoding='utf-8'))
    add('npm', name, version, pj.get('license') if isinstance(pj.get('license'), str) else None, f'pkg:npm/{name}@{version}',
        [f for f in sorted(d.iterdir()) if LICENSE_FILE.match(f.name) and f.is_file()])

# Python runtime packages (license texts also ship inside each *.dist-info).
site = ROOT / 'runtime' / 'python' / 'Lib' / 'site-packages'
for info in sorted(site.glob('*.dist-info')):
    m = HeaderParser().parsestr((info / 'METADATA').read_text(encoding='utf-8', errors='replace'))
    lic = m.get('License-Expression') or next((c.split('::')[-1].strip() for c in m.get_all('Classifier') or [] if c.startswith('License ::')), None) or ((m.get('License') or '').strip().splitlines() or [''])[0][:80] or None
    files = [f for f in sorted(info.rglob('*')) if f.is_file() and LICENSE_FILE.match(f.name)]
    add('pypi', m['Name'], m['Version'], lic, f"pkg:pypi/{m['Name'].lower()}@{m['Version']}", files)
add('runtime', 'CPython', '3.11.18', 'PSF-2.0', 'pkg:generic/cpython@3.11.18', [ROOT / 'runtime' / 'python' / 'LICENSE.txt'])
ff = ROOT / 'runtime' / 'ffmpeg'
add('runtime', 'FFmpeg (BtbN LGPL shared build)', '9.0.2', 'LGPL-2.1-or-later', 'pkg:generic/ffmpeg@9.0.2', [ff / 'LICENSE.txt', ff / 'SOURCE.txt'])

bom = {'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'version': 1,
       'metadata': {'component': {'type': 'application', 'name': 'Thanh Âm Studio', 'version': json.loads((ROOT / 'package.json').read_text())['version'], 'licenses': [{'expression': 'Apache-2.0'}]}},
       'components': components}
(out / 'sbom.cdx.json').write_text(json.dumps(bom, ensure_ascii=False, indent=1), encoding='utf-8')
(out / 'THIRD-PARTY-NOTICES.txt').write_text(
    'Thanh Âm Studio bundles the following third-party components. Models and voices are downloaded by the user\n'
    'from their pinned upstream repositories and keep their own licenses (see worker/models.json).\n\n' + '\n\n'.join(notices), encoding='utf-8')
flag = [c for c in components if re.search(r'GPL|NOASSERTION|AGPL|SSPL|proprietary|unknown', c['licenses'][0]['expression'], re.I)]
print(f"{len(components)} components; review: " + '; '.join(f"{c['name']} {c['version']} [{c['licenses'][0]['expression']}]" for c in flag))
