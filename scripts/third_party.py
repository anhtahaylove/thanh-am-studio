"""Generate the release SBOM (CycloneDX 1.5 JSON) and THIRD-PARTY-NOTICES.txt.

usage: python scripts/third_party.py <out_dir>
Inventories what the installer ships: Rust crates linked into the app and the native worker, npm packages bundled
into the UI, the private Python runtime packages (with the Rust crates in their wheels) and the FFmpeg build. Run after
scripts/setup-runtime.ps1 and npm install; the wheels' crates are fetched from crates.io.
"""
import json, pathlib, re, subprocess, sys
from email.parser import HeaderParser
from wheel_crates import LICENSE_FILE, cdx_licences, crate_dir_licences, crate_licence, crate_licences, crate_note, crates_in_wheels, mpl_source

ROOT = pathlib.Path(__file__).resolve().parents[1]
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
components, notices = [], []
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
    # vendors CTranslate2 4.8.5, built into the native worker's STT engine with these third-party parts
    'ct2rs-sys': ['scripts/licenses/ctranslate2-LICENSE.txt', 'scripts/licenses/cpu_features-LICENSE.txt', 'scripts/licenses/spdlog-LICENSE.txt',
                  'scripts/licenses/ctranslate2-third-party-headers.txt'],
    'flatbuffers': ['scripts/licenses/flatbuffers-LICENSE.txt'],
    'onnxruntime': ['runtime/python/Lib/site-packages/onnxruntime/LICENSE', 'runtime/python/Lib/site-packages/onnxruntime/ThirdPartyNotices.txt'],
    'sherpa-onnx-core': ['scripts/licenses/sherpa-onnx-LICENSE.txt'],
    'tokenizers': ['scripts/licenses/tokenizers-LICENSE.txt'],
    # in tokenizers' dependency tree (via the defmt-macros proc-macro); texts from its repository at the commit in the crate's .cargo_vcs_info.json
    'defmt-parser': ['scripts/licenses/defmt-LICENSE-APACHE.txt', 'scripts/licenses/defmt-LICENSE-MIT.txt'],
}
no_text = []

def add(kind, name, version, license_, purl, files, note=''):
    components.append({'type': 'library', 'name': name, 'version': version, 'purl': purl,
                       'licenses': cdx_licences(license_), 'properties': [{'name': 'ecosystem', 'value': kind}]})
    texts = []
    for f in files or [ROOT / p for p in NO_LICENSE_FILE.get(name, [])]:
        try: text = f if isinstance(f, str) else f.read_text(encoding='utf-8')
        except OSError: continue
        except UnicodeDecodeError as e: sys.exit(f'{f}: not UTF-8 text ({e})')
        if '\0' in text: sys.exit(f'{f}: contains NUL bytes, not a licence text')
        texts.append(text.strip())
    if not texts: no_text.append(f'{name} {version} ({kind})')
    notices.append(f"{'=' * 78}\n{name} {version} ({kind}) — {license_ or 'NOASSERTION'}\n{'=' * 78}\n" + note + '\n\n'.join(texts))

# Rust: normal (non-dev, non-build) dependencies reachable from the app crate and from the native worker (worker-rs, built with
# its STT engine, feature ct2), each once. The worker's own path crates (ortffi, thanham-diarize) are this project's code.
crates = set()
for crate_dir, features in (('src-tauri', []), ('worker-rs', ['--features', 'ct2'])):
    meta = json.loads(subprocess.check_output(['cargo', 'metadata', '--format-version', '1', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc',
                                               *features], cwd=ROOT / crate_dir))
    pkgs = {p['id']: p for p in meta['packages']}
    nodes = {n['id']: n for n in meta['resolve']['nodes']}

    def built(pid, dep):
        """metadata's resolve also keeps an optional dependency that only a weak feature (`dep?/feature`) names, which the build
        leaves out (ct2rs-sys's openblas-src); an optional one is built when an enabled feature turns it on."""
        specs = [s for s in pkgs[pid]['dependencies'] if s['name'] == dep]
        if not specs or any(not s['optional'] for s in specs): return True
        on = nodes[pid]['features']
        return dep in on or any(v == f'dep:{dep}' or v.startswith(f'{dep}/') for f in on for v in pkgs[pid]['features'].get(f, []))

    seen, stack = set(), [meta['resolve']['root']]
    while stack:
        pid = stack.pop()
        if pid in seen: continue
        seen.add(pid)
        for d in nodes[pid]['deps']:
            if any(k['kind'] in (None, 'normal') for k in d['dep_kinds']) and built(pid, pkgs[d['pkg']]['name']): stack.append(d['pkg'])
    for pid in sorted(seen - {meta['resolve']['root']}, key=lambda i: (pkgs[i]['name'], pkgs[i]['version'], i)):  # a set: same-name crates need the tie-break
        p = pkgs[pid]; d = pathlib.Path(p['manifest_path']).parent
        if p['source'] is None or (p['name'], p['version']) in crates: continue
        crates.add((p['name'], p['version']))
        lic = p.get('license') or {'sea-g2p-rs': 'Apache-2.0'}.get(p['name'])  # metadata omits it; verified from its LICENSE file
        lic = crate_licence(p['name'], lic)
        add('cargo', p['name'], p['version'], lic, f"pkg:cargo/{p['name']}@{p['version']}", crate_dir_licences(p['name'], d),
            mpl_source(p['name'], p['version'], lic, p['source']))
# C++ headers compiled into the native worker, as numpy 2.4.6 vendors them (worker-rs/third_party/x86-simd-sort/PROVENANCE.txt).
add('vendored', 'x86-simd-sort', 'numpy-2.4.6', 'BSD-3-Clause', 'pkg:github/intel/x86-simd-sort', [ROOT / 'worker-rs/third_party/x86-simd-sort/LICENSE.md'])
# The cloned-voice path's FFTs and fbank, compiled into the native worker (each folder's PROVENANCE.txt).
add('vendored', 'pocketfft', 'numpy-2.4.6', 'BSD-3-Clause', 'pkg:github/mreineck/pocketfft@33ae5dc94c9cdc7f1c78346504a85de87cadaa12', [ROOT / 'worker-rs/third_party/pocketfft/LICENSE.md'])
add('vendored', 'kaldi-native-fbank', '1.23.0', 'Apache-2.0', 'pkg:github/csukuangfj/kaldi-native-fbank@v1.23.0', [ROOT / 'worker-rs/third_party/kaldi-native-fbank/LICENSE'])
add('vendored', 'kissfft', 'febd4caeed32e33ad8b2e0bb5ea77542c40f18ec', 'BSD-3-Clause', 'pkg:github/mborgerding/kissfft@febd4caeed32e33ad8b2e0bb5ea77542c40f18ec', [ROOT / 'worker-rs/third_party/kissfft/COPYING', ROOT / 'worker-rs/third_party/kissfft/LICENSES/BSD-3-Clause'])
# The STT engine linked statically into the native worker (worker-rs/engine/build-engine.ps1; CTranslate2 itself is ct2rs-sys
# above). The worker imports the OpenMP shim and LLVM's libomp.dll, copies of the runtime's ones (listed below) placed beside it.
add('native', 'oneDNN (linked into thanham-worker.exe)', '3.1.1', 'Apache-2.0', 'pkg:github/oneapi-src/oneDNN@v3.1.1',
    [ROOT / 'scripts/licenses/onednn-3.1.1-LICENSE.txt', ROOT / 'scripts/licenses/onednn-3.1.1-THIRD-PARTY-PROGRAMS.txt'])
add('native', 'Intel oneMKL (linked into thanham-worker.exe)', '2025.3.0', 'LicenseRef-Intel-Simplified-Software-License', 'pkg:pypi/mkl-static@2025.3.0',
    [ROOT / 'scripts/licenses/intel-simplified-software-license.txt', ROOT / 'scripts/licenses/onemkl-2025.3.0-third-party-programs.txt'])

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
# Rust crates in the dependency trees of those packages' extension modules (scripts/wheel_crates.py), less the crates listed above.
for (name, version), (lic, wheels) in crates_in_wheels(site, crates).items():
    add('cargo', name, version, lic, f'pkg:cargo/{name}@{version}', crate_licences(name, version), crate_note(name, version, wheels))
# esaxx-rs 0.1.10 is listed above from the native worker, which builds it without its "cpp" feature; the tokenizers wheel builds that
# default feature, which compiles these C++ headers, whose notices are only in their comments.
if not (site / 'tokenizers-0.23.3.dist-info').is_dir(): sys.exit('tokenizers-0.23.3 is no longer installed: check its esaxx-rs entry below')
add('vendored', 'esaxx and sais-lite (C++ in esaxx-rs 0.1.10, compiled into the tokenizers wheel)', 'esaxx-rs-0.1.10', 'MIT', 'pkg:cargo/esaxx-rs@0.1.10#src',
    [ROOT / 'scripts/licenses/esaxx-MIT.txt'])
add('runtime', 'CPython', '3.11.18', 'PSF-2.0', 'pkg:generic/cpython@3.11.18', [ROOT / 'runtime' / 'python' / 'LICENSE.txt'])
add('runtime', 'Microsoft Visual C++ Redistributable CRT (app-local DLLs next to python.exe; msvcp140 in numpy.libs and llvmlite.libs)', '14.x', 'LicenseRef-Microsoft-VC-Redist', 'pkg:generic/msvc-crt@14', [ROOT / 'scripts' / 'licenses' / 'msvc-crt-NOTE.txt'])
# setup-runtime.ps1 replaces Intel's OpenMP runtime in ctranslate2 with LLVM's, from the pinned conda-forge
# package whose licence text is vendored in scripts/licenses/. oneMKL is linked into the binary and its dist-info
# carries no Intel text; it comes from the dist-info of the mkl 2026.2.1 wheel. torch (with its own oneMKL and
# OpenMP) is not in the installer: it ships in the separation pack, whose notices scripts/build_pack.py writes.
licenses = ROOT / 'scripts' / 'licenses'
add('runtime', 'LLVM OpenMP runtime (libomp.dll in ctranslate2 and beside the native worker)', '23.1.5', 'Apache-2.0 WITH LLVM-exception',
    'pkg:conda/llvm-openmp@23.1.5?build=h49e36cd_0&channel=conda-forge&subdir=win-64', [licenses / 'llvm-openmp-LICENSE.txt'])
add('runtime', 'Intel oneMKL (linked into ctranslate2)', 'build 20251007 (ctranslate2)', 'LicenseRef-Intel-Simplified-Software-License', 'pkg:generic/intel-onemkl@2026.2',
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
    # LGPLv3 is a set of additional permissions on the GPLv3, so both texts ship.
    ('avcodec avdevice avfilter avformat avutil swresample swscale',
     'FFmpeg (PyAV build in av.libs; its x264 and x265 encoder libraries are replaced by the stubs listed below)', '8.1.2',
     'LGPL-3.0-or-later', 'pkg:generic/ffmpeg@8.1.2', ['ffmpeg-COPYING.LGPLv3.txt', 'ffmpeg-COPYING.GPLv3.txt', 'pyav-ffmpeg-SOURCE.txt']),
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
listed = {d for row in av_libs for d in row[0].split()} | {'libscipy_openblas', 'libscipy_openblas64_', 'msvcp140', 'libx264', 'libx265'}
if dlls != listed: sys.exit(f'site-packages/*.libs changed: unlisted {sorted(dlls - listed)}, no longer present {sorted(listed - dlls)}')
for _, name, version, license_, purl, files in av_libs:
    add('runtime', name, version, license_, purl, [licenses / f for f in files])
# These notices describe the runtime setup-runtime.ps1 builds: this project's stand-ins instead of Intel's OpenMP runtime
# and the x264/x265 encoders, and no cuDNN. Stop on a runtime that still has the originals (the stand-ins are < 64 KB).
stale = [f for f in [*site.rglob('libiomp5md.dll'), *site.glob('av.libs/libx26[45]-*.dll')] if f.stat().st_size > 256 * 1024]
stale += [*site.rglob('libiompstubs5md.dll'), *site.rglob('cudnn64_*.dll')]
if stale: sys.exit('runtime not built by the current scripts/setup-runtime.ps1: ' + ', '.join(str(f.relative_to(site)) for f in stale))
app_version = json.loads((ROOT / 'package.json').read_text())['version']
add('runtime', 'Thanh Âm Studio stand-in DLLs, part of this project: the OpenMP shim libiomp5md.dll in ctranslate2 and beside the native worker '
    '(scripts/openmp-shim) and the libx264 and libx265 stubs in av.libs, which contain no x264 or x265 code (scripts/encoder-stubs)',
    app_version, 'Apache-2.0', f'pkg:github/huuhungn/thanh-am-studio@{app_version}', [ROOT / 'LICENSE'])
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
       'metadata': {'component': {'type': 'application', 'name': 'Thanh Âm Studio', 'version': app_version, 'licenses': [{'expression': 'Apache-2.0'}]}},
       'components': components}
(out / 'sbom.cdx.json').write_text(json.dumps(bom, ensure_ascii=False, indent=1), encoding='utf-8')
(out / 'THIRD-PARTY-NOTICES.txt').write_text(
    'Thanh Âm Studio bundles the following third-party components. Models and voices are downloaded by the user\n'
    'from their pinned upstream repositories and keep their own licenses (see worker/models.json).\n\n' + '\n\n'.join(notices), encoding='utf-8')
named = [(c['name'], c['version'], c['licenses'][0].get('expression') or c['licenses'][0]['license']['name']) for c in components]
flag = [f'{name} {version} [{lic}]' for name, version, lic in named if re.search(r'GPL|NOASSERTION|AGPL|SSPL|proprietary|unknown', lic, re.I)]
print(f"{len(components)} components; review: " + '; '.join(flag))
