"""Rust crates in the Python wheels of a site-packages folder, from the CycloneDX SBOM maturin puts in each *.dist-info, with their
licence texts from crates.io. Shared by scripts/third_party.py (the installer's runtime) and scripts/build_pack.py (the separation pack)."""
import hashlib, io, json, os, pathlib, re, sys, tarfile, urllib.request

LICENSE_FILE = re.compile(r'^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)', re.I)
# Licence files, relative to the crate, of the C libraries that crates linked into the Python wheels vendor below their root.
VENDORED_LICENSES = {
    'onig_sys': ['oniguruma/AUTHORS', 'oniguruma/COPYING'],  # Oniguruma
    # AWS-LC 5.7.0, whose LICENSE is the crate's root one (it also gives s2n-bignum's and Jitter Entropy's notices, whose own files
    # the crate leaves out), and its fiat-crypto part
    'aws-lc-sys': ['aws-lc/third_party/fiat/LICENSE'],
}
CRATE_CACHE = pathlib.Path(os.environ.get('RUNNER_TEMP') or os.environ['LOCALAPPDATA']) / 'thanham-crate-cache'

def crate_licences(name, version):
    """The crate's root licence files and its VENDORED_LICENSES, from its .crate on crates.io checked against the SHA-256 in the
    crates.io index, cached outside the repository and read in memory, never extracted."""
    want = VENDORED_LICENSES.get(name, [])
    index = {1: '1', 2: '2', 3: f'3/{name[0]}'}.get(len(name), f'{name[:2]}/{name[2:4]}')
    entries = map(json.loads, urllib.request.urlopen(f'https://index.crates.io/{index}/{name}'.lower(), timeout=60).read().splitlines())
    cksum = next((e['cksum'] for e in entries if e['vers'] == version), None)
    if not cksum: sys.exit(f'{name} {version}: the crates.io index has no checksum for this version')
    cached = CRATE_CACHE / f'{name}-{version}.crate'
    data = cached.read_bytes() if cached.is_file() else b''
    if hashlib.sha256(data).hexdigest() != cksum:  # not cached yet, or a damaged copy that the download replaces
        data = urllib.request.urlopen(f'https://static.crates.io/crates/{name}/{name}-{version}.crate', timeout=300).read()
        if hashlib.sha256(data).hexdigest() != cksum: sys.exit(f'{name}-{version}.crate from crates.io: not the SHA-256 in the crates.io index')
        CRATE_CACHE.mkdir(exist_ok=True); cached.with_suffix('.part').write_bytes(data); cached.with_suffix('.part').replace(cached)
    found, prefix = {}, f'{name}-{version}/'
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for m in tar:
            if not m.name.startswith(prefix) or '..' in m.name.split('/'): sys.exit(f'{name}-{version}.crate: member {m.name!r} is outside {prefix}')
            rel = m.name[len(prefix):]
            if m.isfile() and (rel in want or ('/' not in rel and LICENSE_FILE.match(rel))): found[rel] = tar.extractfile(m).read()
    if missing := [p for p in want if p not in found]: sys.exit(f'{name} {version} has no {missing}: update VENDORED_LICENSES')
    try: return [io.TextIOWrapper(io.BytesIO(found[rel]), encoding='utf-8').read() for rel in sorted(set(found) - set(want)) + want]
    except UnicodeDecodeError as e: sys.exit(f'{name} {version}: a licence file is not UTF-8 text ({e})')

def crates_in_wheels(site, listed=()):
    """{(name, version): (licence, wheels)}, sorted, of the crates in the dependency trees of site's wheels, less the listed ones.
    Build-only crates are scope "excluded" and path crates are each package's own code."""
    found = {}
    for sbom in sorted(pathlib.Path(site).glob('*.dist-info/sboms/*.json')):
        for c in json.loads(sbom.read_text(encoding='utf-8')).get('components', []):
            purl = c.get('purl') or ''
            if c.get('scope') == 'excluded' or not purl.startswith('pkg:cargo/') or 'download_url=file' in purl: continue
            # names and versions build URLs and cache paths; a git or other-registry crate has a qualified purl
            if purl != f"pkg:cargo/{c['name']}@{c['version']}" or not re.fullmatch(r'[A-Za-z0-9_-]+', c['name']) or not re.fullmatch(r'[A-Za-z0-9.+-]+', c['version']):
                sys.exit(f'{sbom}: {purl} is not a plain crates.io crate')
            if (c['name'], c['version']) in listed: continue
            lic = ' '.join(((c.get('licenses') or [{}])[0].get('expression') or '').split()) or None
            lic = {'onig_sys': 'MIT AND BSD-2-Clause'}.get(c['name'], lic)  # the SBOM gives the crate's MIT; it bundles Oniguruma (BSD-2-Clause)
            found.setdefault((c['name'], c['version']), (lic, set()))[1].add(sbom.parent.parent.stem.replace('-', ' '))
    return dict(sorted(found.items()))

def crate_note(name, version, wheels):
    return f"In the Rust dependency tree of these Python wheels of the runtime: {', '.join(sorted(wheels))}\nSource: https://crates.io/crates/{name}/{version}\n\n"
