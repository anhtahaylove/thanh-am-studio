"""Rust crates in the Python wheels of a site-packages folder, from the CycloneDX SBOM maturin puts in each *.dist-info, with their
licence texts from crates.io. Shared by scripts/third_party.py (the installer's runtime) and scripts/build_pack.py (the separation pack)."""
import hashlib, io, json, os, pathlib, re, sys, tarfile, urllib.request

LICENSE_FILE = re.compile(r'^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)', re.I)
# Licence files, relative to the crate, of code or data that crates vendor below their root and compile in. They join the crate's root
# licence files, for the app's and the worker's crates as for the wheels' ones.
VENDORED_LICENSES = {
    'onig_sys': ['oniguruma/AUTHORS', 'oniguruma/COPYING'],  # Oniguruma
    # AWS-LC 5.7.0, whose LICENSE is the crate's root one (it also gives s2n-bignum's and Jitter Entropy's notices, whose own files
    # the crate leaves out), and its fiat-crypto part
    'aws-lc-sys': ['aws-lc/third_party/fiat/LICENSE'],
    'ring': ['src/polyfill/once_cell/LICENSE-APACHE', 'src/polyfill/once_cell/LICENSE-MIT', 'third_party/fiat/LICENSE'],  # once_cell's race module, fiat-crypto
    'regex-syntax': ['src/unicode_tables/LICENSE-UNICODE'],  # tables generated from the Unicode Character Database
    'libz-sys': ['src/zlib/LICENSE'],  # zlib, which libz-sys builds from these sources into the native worker
}
# SPDX ids of those texts that the crate's own licence leaves out (ring's and aws-lc-sys's already name theirs)
VENDORED_SPDX = {'onig_sys': 'BSD-2-Clause', 'regex-syntax': 'Unicode-DFS-2016', 'libz-sys': 'Zlib'}
CRATES_IO = ('registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/')

def crate_licence(name, lic):
    """The crate's licence as an SPDX expression, with Cargo's deprecated "/" between licences read as OR, AND the VENDORED_SPDX id
    of the code or data it compiles in."""
    if not lic: return lic
    lic = re.sub(r'\s*/\s*', ' OR ', lic)
    if name not in VENDORED_SPDX: return lic
    return f"{f'({lic})' if ' OR ' in lic else lic} AND {VENDORED_SPDX[name]}"

def cdx_licences(lic):
    """A CycloneDX component's licenses: lic as an SPDX expression when it reads as one (licence ids joined by AND, OR, WITH), else
    as a licence name, such as a PyPI classifier's "MIT License"."""
    lic = lic or 'NOASSERTION'
    words = re.sub(r'[()]', ' ', lic).split()
    if len(words) % 2 and all(re.fullmatch(r'[A-Za-z0-9.+:-]+', w) and (w in ('AND', 'OR', 'WITH')) == (i % 2 == 1) for i, w in enumerate(words)):
        return [{'expression': lic}]
    return [{'license': {'name': lic}}]

def mpl_source(name, version, lic, source):
    """The source pointer MPL-2.0 asks binaries to give: the crates.io page, which is that place only for a crates.io crate."""
    if 'MPL' not in (lic or ''): return ''
    if source not in CRATES_IO: sys.exit(f'{name} {version} is MPL-2.0 and comes from {source}, not crates.io: give its notice a source pointer')
    return f'Source: https://crates.io/crates/{name}/{version}\n\n'

def crate_dir_licences(name, crate_dir):
    """The root licence files of an unpacked crate and its VENDORED_LICENSES."""
    want = VENDORED_LICENSES.get(name, [])
    if missing := [p for p in want if not (crate_dir / p).is_file()]: sys.exit(f'{crate_dir} has no {missing}: update VENDORED_LICENSES')
    return [f for f in sorted(crate_dir.iterdir()) if LICENSE_FILE.match(f.name) and f.is_file()] + [crate_dir / p for p in want]

def crate_licences(name, version):
    """The crate's root licence files and its VENDORED_LICENSES, from its .crate on crates.io checked against the SHA-256 in the
    crates.io index, cached outside the repository and read in memory, never extracted."""
    want = VENDORED_LICENSES.get(name, [])
    index = {1: '1', 2: '2', 3: f'3/{name[0]}'}.get(len(name), f'{name[:2]}/{name[2:4]}')
    entries = map(json.loads, urllib.request.urlopen(f'https://index.crates.io/{index}/{name}'.lower(), timeout=60).read().splitlines())
    cksum = next((e['cksum'] for e in entries if e['vers'] == version), None)
    if not cksum: sys.exit(f'{name} {version}: the crates.io index has no checksum for this version')
    cache = pathlib.Path(os.environ.get('RUNNER_TEMP') or os.environ['LOCALAPPDATA']) / 'thanham-crate-cache'
    cached = cache / f'{name}-{version}.crate'
    data = cached.read_bytes() if cached.is_file() else b''
    if hashlib.sha256(data).hexdigest() != cksum:  # not cached yet, or a damaged copy that the download replaces
        data = urllib.request.urlopen(f'https://static.crates.io/crates/{name}/{name}-{version}.crate', timeout=300).read()
        if hashlib.sha256(data).hexdigest() != cksum: sys.exit(f'{name}-{version}.crate from crates.io: not the SHA-256 in the crates.io index')
        cache.mkdir(exist_ok=True); cached.with_suffix('.part').write_bytes(data); cached.with_suffix('.part').replace(cached)
    found, prefix = {}, f'{name}-{version}/'
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for m in tar:
            if not m.name.startswith(prefix) or '..' in m.name.split('/'): sys.exit(f'{name}-{version}.crate: member {m.name!r} is outside {prefix}')
            rel = m.name[len(prefix):]
            if m.isfile() and (rel in want or ('/' not in rel and LICENSE_FILE.match(rel))): found[rel] = tar.extractfile(m).read()
    if missing := [p for p in want if p not in found]: sys.exit(f'{name} {version} has no {missing}: update VENDORED_LICENSES')
    try: texts = [io.TextIOWrapper(io.BytesIO(found[rel]), encoding='utf-8').read() for rel in sorted(set(found) - set(want)) + want]
    except UnicodeDecodeError as e: sys.exit(f'{name} {version}: a licence file is not UTF-8 text ({e})')
    if any('\0' in text for text in texts): sys.exit(f'{name} {version}: a licence file contains NUL bytes, not a licence text')
    return texts

def crates_in_wheels(site, listed=()):
    """{(name, version): (licence, wheels)}, sorted, of the crates in the dependency trees of site's wheels, less the listed ones.
    Build-only crates are scope "excluded" and path crates are each package's own code."""
    found = {}
    for info in sorted(pathlib.Path(site).glob('*.dist-info')):
        sboms = sorted(info.glob('sboms/*.json'))
        if not sboms:
            if re.search(r'^Generator: maturin', (info / 'WHEEL').read_text(encoding='utf-8', errors='replace') if (info / 'WHEEL').is_file() else '', re.M):
                sys.exit(f'{info.name}: built by maturin but has no sboms/ folder, so its Rust crates cannot be listed')
            continue
        meta = (info / 'METADATA').read_text(encoding='utf-8', errors='replace')
        wheel = ' '.join(re.search(rf'^{key}: *(\S+)', meta, re.M).group(1) for key in ('Name', 'Version'))  # as the pypi entries name it
        for sbom in sboms:
            for c in json.loads(sbom.read_text(encoding='utf-8')).get('components', []):
                purl = c.get('purl') or ''
                if c.get('scope') == 'excluded' or not purl.startswith('pkg:cargo/') or 'download_url=file' in purl: continue
                # names and versions build URLs and cache paths; a git or other-registry crate has a qualified purl
                if purl != f"pkg:cargo/{c['name']}@{c['version']}" or not re.fullmatch(r'[A-Za-z0-9_-]+', c['name']) or not re.fullmatch(r'[A-Za-z0-9.+-]+', c['version']):
                    sys.exit(f'{sbom}: {purl} is not a plain crates.io crate')
                if (c['name'], c['version']) in listed: continue
                lic = ' '.join(((c.get('licenses') or [{}])[0].get('expression') or '').split()) or None
                lic = crate_licence(c['name'], lic)
                found.setdefault((c['name'], c['version']), (lic, set()))[1].add(wheel)
    return dict(sorted(found.items()))

def crate_note(name, version, wheels):
    return f"In the Rust dependency tree of these Python wheels of the runtime: {', '.join(sorted(wheels))}\nSource: https://crates.io/crates/{name}/{version}\n\n"
