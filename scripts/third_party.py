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
# Packages that ship no licence file where the walks below look: texts from the package folder, or vendored from the
# upstream tag or commit of the packaged version (scripts/licenses/). Paths are relative to ROOT.
NO_LICENSE_FILE = {
    'alloc-stdlib': ['scripts/licenses/alloc-stdlib-LICENSE.txt'],
    'selectors': ['scripts/licenses/selectors-MPL-2.0.txt'],
    'webview2-com': ['scripts/licenses/webview2-com-LICENSE.txt'],
    'webview2-com-macros': ['scripts/licenses/webview2-com-macros-LICENSE.txt'],
    # also ships Microsoft's WebView2 loader, which the app links statically
    'webview2-com-sys': ['scripts/licenses/webview2-com-LICENSE.txt', 'scripts/licenses/webview2-sdk-LICENSE.txt'],
    'ctranslate2': ['scripts/licenses/ctranslate2-LICENSE.txt'],
    'flatbuffers': ['scripts/licenses/flatbuffers-LICENSE.txt'],
    'onnxruntime': ['runtime/python/Lib/site-packages/onnxruntime/LICENSE', 'runtime/python/Lib/site-packages/onnxruntime/ThirdPartyNotices.txt'],
    'sherpa-onnx-core': ['scripts/licenses/sherpa-onnx-LICENSE.txt'],
    'tokenizers': ['scripts/licenses/tokenizers-LICENSE.txt'],
}
no_text = []

def add(kind, name, version, license_, purl, files):
    components.append({'type': 'library', 'name': name, 'version': version, 'purl': purl,
                       'licenses': [{'expression': license_ or 'NOASSERTION'}], 'properties': [{'name': 'ecosystem', 'value': kind}]})
    texts = []
    for f in files or [ROOT / p for p in NO_LICENSE_FILE.get(name, [])]:
        try: text = f.read_text(encoding='utf-8')
        except OSError: continue
        except UnicodeDecodeError as e: sys.exit(f'{f}: not UTF-8 text ({e})')
        if '\0' in text: sys.exit(f'{f}: contains NUL bytes, not a licence text')
        texts.append(text.strip())
    if not texts: no_text.append(f'{name} {version} ({kind})')
    notices.append(f"{'=' * 78}\n{name} {version} ({kind}) — {license_ or 'NOASSERTION'}\n{'=' * 78}\n" + '\n\n'.join(texts))

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
    lic = lic or {'llvmlite': 'BSD-2-Clause'}.get(m['Name'])  # metadata omits it; verified from its LICENSE file
    lic = {'sherpa-onnx': 'Apache-2.0'}.get(m['Name'], lic)  # metadata has prose ("Apache licensed, as found in the LICENSE file"), not an SPDX id
    files = [f for f in sorted(info.rglob('*')) if f.is_file() and LICENSE_FILE.match(f.name) and f.suffix not in ('.py', '.pyc')]  # av ships AUTHORS.py and its __pycache__
    add('pypi', m['Name'], m['Version'], lic, f"pkg:pypi/{m['Name'].lower()}@{m['Version']}", files)
add('runtime', 'CPython', '3.11.18', 'PSF-2.0', 'pkg:generic/cpython@3.11.18', [ROOT / 'runtime' / 'python' / 'LICENSE.txt'])
add('runtime', 'Microsoft Visual C++ Redistributable CRT (app-local DLLs next to python.exe; msvcp140 in numpy.libs and llvmlite.libs)', '14.x', 'LicenseRef-Microsoft-VC-Redist', 'pkg:generic/msvc-crt@14', [ROOT / 'scripts' / 'licenses' / 'msvc-crt-NOTE.txt'])
# Intel binaries inside the torch and ctranslate2 wheels, whose dist-info carries no Intel text; the texts come from the
# dist-info of the mkl 2026.2.1 and intel-openmp 2026.2.0 wheels (scripts/licenses/).
licenses = ROOT / 'scripts' / 'licenses'
add('runtime', 'Intel OpenMP runtime (libiomp5md.dll in torch and ctranslate2)', '20260828 (torch), 20250910 (ctranslate2)', 'LicenseRef-Intel-EULA-Developer-Tools',
    'pkg:generic/intel-openmp@2026.2.0', [licenses / 'intel-openmp-runtime.txt'])
add('runtime', 'Intel oneMKL (linked into torch and ctranslate2)', 'build 20260915 (torch), build 20251007 (ctranslate2)', 'LicenseRef-Intel-Simplified-Software-License', 'pkg:generic/intel-onemkl@2026.2',
    [licenses / 'intel-simplified-software-license.txt'])
ff = ROOT / 'runtime' / 'ffmpeg'
add('runtime', 'FFmpeg (BtbN LGPL shared build)', '9.0.2', 'LGPL-2.1-or-later', 'pkg:generic/ffmpeg@9.0.2', [ff / 'LICENSE.txt', ff / 'SOURCE.txt'])
# DLLs that delvewheel copied into <package>.libs. numpy's and scipy's licence files cover their OpenBLAS (with LAPACK
# and the GCC runtime) and msvcp140 is the Visual C++ runtime above; the av.libs ones are listed here, with versions
# and texts from the sources of PyAV's FFmpeg build (scripts/licenses/pyav-ffmpeg-SOURCE.txt). Any other DLL stops
# the script, so a runtime update cannot ship an unlisted library.
for pin in ('av-18.1.0', 'soundfile-0.14.0', 'sherpa_onnx_core-2.0.1'):
    if not (site / f'{pin}.dist-info').is_dir(): sys.exit(f'{pin} is no longer installed: update its bundled-library components below')
av_libs = [  # (DLL names without soname and delvewheel hash, component, version, licence, purl, files in scripts/licenses)
    ('avcodec avdevice avfilter avformat avutil swresample swscale', 'FFmpeg (PyAV build in av.libs)', '8.1.2', 'GPL-3.0-or-later',
     'pkg:generic/ffmpeg@8.1.2', ['ffmpeg-COPYING.LGPLv3.txt', 'ffmpeg-COPYING.GPLv3.txt', 'pyav-ffmpeg-SOURCE.txt']),
    ('libx264', 'x264 (libx264 in av.libs)', '0.165 (commit b35605a)', 'GPL-2.0-or-later',
     'pkg:generic/x264@b35605ace3ddf7c1a5d67a2eb553f034aef41d55', ['x264-COPYING.txt']),
    ('libx265', 'x265 (libx265 in av.libs)', '4.2', 'GPL-2.0-or-later', 'pkg:generic/x265@4.2', ['x265-COPYING.txt']),
    ('libmp3lame', 'LAME (libmp3lame in av.libs)', '3.100', 'LGPL-2.0-or-later', 'pkg:generic/lame@3.100', ['lame-COPYING.txt']),
    ('libopencore-amrnb libopencore-amrwb', 'opencore-amr (libopencore-amrnb, libopencore-amrwb in av.libs)', '0.1.6', 'Apache-2.0',
     'pkg:generic/opencore-amr@0.1.6', ['opencore-amr-LICENSE.txt', 'opencore-amr-NOTICE.txt']),
    ('libopus', 'Opus (libopus in av.libs)', '1.6.1', 'BSD-3-Clause', 'pkg:generic/opus@1.6.1', ['opus-COPYING.txt']),
    ('libdav1d', 'dav1d (libdav1d in av.libs)', '1.5.3', 'BSD-2-Clause', 'pkg:generic/dav1d@1.5.3', ['dav1d-COPYING.txt']),
    ('libSvtAv1Enc', 'SVT-AV1 (libSvtAv1Enc in av.libs)', '4.1.0', 'BSD-3-Clause-Clear', 'pkg:generic/svt-av1@4.1.0',
     ['svt-av1-LICENSE.txt', 'svt-av1-PATENTS.txt']),
    ('libvpx', 'libvpx (in av.libs)', '1.16.0', 'BSD-3-Clause', 'pkg:generic/libvpx@1.16.0', ['libvpx-LICENSE.txt', 'libvpx-PATENTS.txt']),
    ('libwebp libwebpmux libsharpyuv', 'libwebp (libwebp, libwebpmux, libsharpyuv in av.libs)', '1.6.0', 'BSD-3-Clause',
     'pkg:generic/libwebp@1.6.0', ['libwebp-COPYING.txt', 'libwebp-PATENTS.txt']),
    ('libvpl', 'Intel VPL dispatcher (libvpl in av.libs)', '2.16.0', 'MIT', 'pkg:generic/libvpl@2.16.0', ['libvpl-LICENSE.txt']),
    ('zlib1', 'zlib (zlib1 in av.libs)', '1.3.2', 'Zlib', 'pkg:generic/zlib@1.3.2', ['zlib-LICENSE.txt']),
    ('libiconv', 'GNU libiconv (libiconv in av.libs)', '1.19', 'LGPL-2.1-or-later', 'pkg:generic/libiconv@1.19', ['libiconv-COPYING.LIB.txt']),
    ('libgcc_s_seh libstdc++', 'GCC runtime libraries (libgcc_s_seh, libstdc++ in av.libs)', '16.1.0',
     'GPL-3.0-or-later WITH GCC-exception-3.1', 'pkg:generic/gcc@16.1.0', ['gcc-COPYING3.txt', 'gcc-COPYING.RUNTIME.txt']),
    ('libwinpthread', 'mingw-w64 winpthreads (libwinpthread in av.libs)', '14.0.0+git (MSYS2 build, as bundled in av 18.1.0)',
     'MIT AND BSD-3-Clause', 'pkg:generic/mingw-w64-winpthreads@14.0.0', ['winpthreads-COPYING.txt']),
]
dlls = {re.sub(r'(-\d+)?-[0-9a-f]{32}$', '', f.stem) for f in site.glob('*.libs/*.dll')}
listed = {d for row in av_libs for d in row[0].split()} | {'libscipy_openblas', 'libscipy_openblas64_', 'msvcp140'}
if dlls != listed: sys.exit(f'site-packages/*.libs changed: unlisted {sorted(dlls - listed)}, no longer present {sorted(listed - dlls)}')
for _, name, version, license_, purl, files in av_libs:
    add('runtime', name, version, license_, purl, [licenses / f for f in files])
# soundfile's libsndfile_x64.dll links its codec libraries in statically (scripts/licenses/libsndfile-SOURCE.txt).
for name, version, license_, purl, files in [
    ('libsndfile (_soundfile_data/libsndfile_x64.dll in soundfile)', '1.2.2', 'LGPL-2.1-or-later', 'pkg:generic/libsndfile@1.2.2',
     ['libsndfile-COPYING.txt', 'libsndfile-SOURCE.txt']),
    ('FLAC (libFLAC, linked into libsndfile_x64.dll)', '1.4.3', 'BSD-3-Clause', 'pkg:generic/flac@1.4.3', ['flac-COPYING.Xiph.txt']),
    ('libvorbis (linked into libsndfile_x64.dll)', '1.3.7', 'BSD-3-Clause', 'pkg:generic/libvorbis@1.3.7', ['libvorbis-COPYING.txt']),
    ('libogg (linked into libsndfile_x64.dll)', '1.3.5 (vcpkg port version; not recorded in the DLL)', 'BSD-3-Clause',
     'pkg:generic/libogg@1.3.5', ['libogg-COPYING.txt']),
    ('Opus (libopus, linked into libsndfile_x64.dll)', '1.5.2', 'BSD-3-Clause', 'pkg:generic/opus@1.5.2', ['opus-1.5.2-COPYING.txt']),
    ('mpg123 (libmpg123, linked into libsndfile_x64.dll)', '1.32.9 (vcpkg port version; not recorded in the DLL)', 'LGPL-2.1-or-later',
     'pkg:generic/mpg123@1.32.9', ['mpg123-COPYING.txt']),
    ('LAME (libmp3lame, linked into libsndfile_x64.dll)', '3.100', 'LGPL-2.0-or-later', 'pkg:generic/lame@3.100', ['lame-COPYING.txt']),
]:
    add('runtime', name, version, license_, purl, [licenses / f for f in files])
# sherpa-onnx-core installs its own ONNX Runtime; the 1.31.1 package's LICENSE is identical to 1.28.2's and its
# ThirdPartyNotices.txt holds every section of 1.28.2's.
add('runtime', 'ONNX Runtime (onnxruntime.dll in sherpa_onnx/lib and Scripts, from sherpa-onnx-core)', '1.28.2', 'MIT', 'pkg:generic/onnxruntime@1.28.2',
    [site / 'onnxruntime' / 'LICENSE', site / 'onnxruntime' / 'ThirdPartyNotices.txt'])

if no_text: sys.exit('no licence text for: ' + '; '.join(no_text) + ' (add it to NO_LICENSE_FILE)')
bom = {'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'version': 1,
       'metadata': {'component': {'type': 'application', 'name': 'Thanh Âm Studio', 'version': json.loads((ROOT / 'package.json').read_text())['version'], 'licenses': [{'expression': 'Apache-2.0'}]}},
       'components': components}
(out / 'sbom.cdx.json').write_text(json.dumps(bom, ensure_ascii=False, indent=1), encoding='utf-8')
(out / 'THIRD-PARTY-NOTICES.txt').write_text(
    'Thanh Âm Studio bundles the following third-party components. Models and voices are downloaded by the user\n'
    'from their pinned upstream repositories and keep their own licenses (see worker/models.json).\n\n' + '\n\n'.join(notices), encoding='utf-8')
flag = [c for c in components if re.search(r'GPL|NOASSERTION|AGPL|SSPL|proprietary|unknown', c['licenses'][0]['expression'], re.I)]
print(f"{len(components)} components; review: " + '; '.join(f"{c['name']} {c['version']} [{c['licenses'][0]['expression']}]" for c in flag))
