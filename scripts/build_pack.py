"""Turn the runtime that `scripts/setup-runtime.ps1 -Profile separation` built into the downloadable separation pack.

usage: python scripts/build_pack.py <runtime-separation\\python> <out_dir> --tag pack-separation-v<N> [--repo owner/name]
       python scripts/build_pack.py --verify <pack tree> [--manifest-sha256 <hex>]

The source is copied to <out_dir>/separation-runtime and processed there; the source is never changed. Output:
  separation-runtime/            the pack tree (what the app extracts into models/separation-runtime/)
  separation-runtime-v<N>.zip    the release asset
  separation-runtime-v<N>.pin.json   url, size, unpacked_size, sha256, manifest_sha256, files and longest_path for worker/models.json (scripts/pin_pack.py)

MANIFEST.sha256 lists every file but itself, one line each: `<sha256>  <size>  <path>` (path relative to the pack root, `/`).
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, zipfile
from pathlib import Path
from wheel_crates import crate_licences, crate_note, crates_in_wheels

SCRIPTS = Path(__file__).resolve().parent
MANIFEST, NOTICES = 'MANIFEST.sha256', 'THIRD-PARTY-NOTICES.txt'
# DLL loading has no long-path opt-in: root prefix (`C:\Users\`) + profile folder (`<user>.<COMPUTERNAME>` with a clash
# suffix) + `\AppData\Local\studio.thanham.desktop\models\separation-runtime\` + the longest path must fit in MAX_PATH - 1.
ROOT_PREFIX, PROFILE_FOLDER, DATA_SUFFIX, PATH_LIMIT = 9, 40, 64, 259
REQUIRED = ['python.exe', 'python311.dll', 'vcruntime140.dll', 'msvcp140.dll', 'Lib/site-packages/torch/lib/libiomp5md.dll',
            'Lib/site-packages/torch/lib/libomp.dll', 'Lib/site-packages/demucs/htdemucs.py']
# Sections the notices must carry besides the moved licence trees.
REQUIRED_NOTICES = ['torch', 'demucs', 'Intel oneMKL', 'LLVM OpenMP', 'Thanh Âm Studio stand-in']
PYC_UNCHECKED_HASH = 1


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def files(tree):
    """Every file under tree as (relative path with `/`, absolute path), sorted bytewise by relative path."""
    found = [(p.relative_to(tree).as_posix(), p) for p in Path(tree).rglob('*') if p.is_file()]
    return sorted(found, key=lambda item: item[0].encode('utf-8'))


def longest_path(tree):
    return max(len(rel) for rel, _ in files(tree))


def check_budget(tree):
    longest = longest_path(tree)
    total = ROOT_PREFIX + PROFILE_FOLDER + DATA_SUFFIX + longest
    if total > PATH_LIMIT:
        sys.exit(f'path budget: {ROOT_PREFIX} + {PROFILE_FOLDER} + {DATA_SUFFIX} + {longest} = {total} > {PATH_LIMIT}. '
                 'Shorten the pack (the next torch bump needs the model id `sep`).')
    return longest


def compile_tree(tree):
    """Unchecked-hash bytecode for every .py (PEP 552): Python neither checks the source nor rewrites the file."""
    lib = Path(tree) / 'Lib'
    # py312_intrinsics.py is a SyntaxError under 3.11.
    run = subprocess.run([str(Path(tree) / 'python.exe'), '-I', '-m', 'compileall', '-q', '-f', '-j', '0',
                          '--invalidation-mode', 'unchecked-hash', '-x', 'py312_intrinsics', str(lib)])
    if run.returncode != 0:
        sys.exit(f'compileall failed with exit code {run.returncode}')
    wrong = [rel for rel, p in files(tree) if rel.endswith('.pyc') and int.from_bytes(p.read_bytes()[4:8], 'little') != PYC_UNCHECKED_HASH]
    if wrong:
        sys.exit(f'{len(wrong)} .pyc files are not unchecked-hash, first: {wrong[0]}')


def move_licences(tree):
    """Moves every *.dist-info/licenses tree into THIRD-PARTY-NOTICES.txt, verbatim, and drops the trees. Each dropped
    file's bytes must appear in the notices, else the build fails. The texts still ship with the pack. The notices also
    list the Rust crates in the wheels."""
    tree = Path(tree)
    trees = sorted(tree.rglob('*.dist-info/licenses'))
    moved, parts = [], []
    for licences in trees:
        for rel, path in files(licences):
            data = path.read_bytes()
            try:
                data.decode('utf-8')
            except UnicodeDecodeError as error:
                sys.exit(f'{path}: not UTF-8 text ({error})')
            moved.append(data)
            head = path.relative_to(tree).as_posix()
            parts.append(f"{'=' * 78}\n{head}\n{'=' * 78}\n".encode('utf-8') + data + b'\n\n')
    # The Rust crates in the wheels' dependency trees (scripts/wheel_crates.py), with their licence texts from crates.io.
    for (name, version), (licence, wheels) in crates_in_wheels(tree / 'Lib' / 'site-packages').items():
        texts = [text.strip() for text in crate_licences(name, version)]
        if not texts:
            sys.exit(f'{name} {version} (in {", ".join(sorted(wheels))}): its crate ships no licence file')
        parts.append(f"{'=' * 78}\n{name} {version} (cargo) — {licence or 'NOASSERTION'}\n{'=' * 78}\n".encode('utf-8')
                     + (crate_note(name, version, wheels) + '\n\n'.join(texts)).encode('utf-8') + b'\n\n')
    extras = [('LLVM OpenMP runtime (libomp.dll in torch/lib), Apache-2.0 WITH LLVM-exception', 'llvm-openmp-LICENSE.txt'),
              ('Intel oneMKL (linked into torch), Intel Simplified Software License', 'intel-simplified-software-license.txt'),
              ('Microsoft Visual C++ Redistributable CRT (app-local DLLs next to python.exe)', 'msvc-crt-NOTE.txt')]
    sections = [(title, (SCRIPTS / 'licenses' / name).read_bytes()) for title, name in extras]
    sections.append(('Thanh Âm Studio stand-in DLLs, part of this project: the OpenMP shim libiomp5md.dll in torch/lib (scripts/openmp-shim), '
                     'Apache-2.0', (SCRIPTS.parent / 'LICENSE').read_bytes()))
    members = []
    for info in sorted(tree.glob('Lib/site-packages/*.dist-info')):
        text = (info / 'METADATA').read_text(encoding='utf-8', errors='replace')
        name = re.search(r'^Name: (.+)$', text, re.M).group(1).strip()
        version = re.search(r'^Version: (.+)$', text, re.M).group(1).strip()
        members.append(f'{name} {version}')
    header = ('Thanh Âm Studio separation pack: Python 3.11 (PSF-2.0, LICENSE.txt in this folder), PyTorch, Demucs and their\n'
              'dependencies. Licence texts that ship inside the packages stay in their folders; the ones that were in\n'
              '*.dist-info/licenses are collected below, verbatim.\n\nPackages: ' + ', '.join(members) + '\n\n').encode('utf-8')
    body = header + b''.join(f"{'=' * 78}\n{title}\n{'=' * 78}\n".encode('utf-8') + data + b'\n\n' for title, data in sections) + b''.join(parts)
    (tree / NOTICES).write_bytes(body)
    missing = [data for data in moved if data not in body]
    if missing:
        sys.exit(f'{len(missing)} licence files are not in {NOTICES}')
    for licences in trees:
        shutil.rmtree(licences)
    text = body.decode('utf-8')
    absent = [needle for needle in REQUIRED_NOTICES if needle not in text]
    if absent:
        sys.exit(f'{NOTICES} lacks: {", ".join(absent)}')
    return len(moved)


def write_manifest(tree):
    lines = [f'{sha256(path)}  {path.stat().st_size}  {rel}\n' for rel, path in files(tree) if rel != MANIFEST]
    (Path(tree) / MANIFEST).write_text(''.join(lines), encoding='utf-8', newline='\n')
    return len(lines)


def verify_tree(tree, manifest_sha256=None):
    """Problems with a pack tree against its manifest: a changed, missing or extra file. The marker is not part of the pack."""
    tree = Path(tree)
    manifest = tree / MANIFEST
    if not manifest.is_file():
        return [f'{MANIFEST} is missing']
    problems = []
    if manifest_sha256 and sha256(manifest) != manifest_sha256:
        problems.append(f'{MANIFEST} differs from its pin')
    listed = set()
    for line in manifest.read_text(encoding='utf-8').splitlines():
        digest, size, rel = line.split('  ', 2)
        listed.add(rel)
        path = tree / rel
        if not path.is_file():
            problems.append(f'missing: {rel}')
        elif path.stat().st_size != int(size) or sha256(path) != digest:
            problems.append(f'changed: {rel}')
    problems += [f'extra: {rel}' for rel, _ in files(tree) if rel not in listed and rel not in (MANIFEST, 'installed.json')]
    return problems


def zip_tree(tree, target):
    # Fixed timestamps and order: the same tree gives the same zip.
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in [MANIFEST] + [rel for rel, _ in files(tree) if rel != MANIFEST]:
            info = zipfile.ZipInfo(rel, (2020, 1, 1, 0, 0, 0))
            info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o644 << 16
            with open(Path(tree) / rel, 'rb') as f, z.open(info, 'w') as out:
                shutil.copyfileobj(f, out, 1024 * 1024)


def pack_health(tree):
    """The pack's own python imports what separate() needs, and `-B` leaves no new file behind."""
    worker = SCRIPTS.parent / 'worker' / 'main.py'
    request = json.dumps({'protocol': 1, 'id': 'pack', 'operation': 'health', 'payload': {'profile': 'separation'}})
    run = subprocess.run([str(Path(tree) / 'python.exe'), '-B', '-I', '-X', 'utf8', str(worker)], input=request, text=True, capture_output=True)
    events = [json.loads(line) for line in run.stdout.splitlines() if line.startswith('{')]
    if run.returncode != 0 or not events or not events[-1].get('result', {}).get('ready'):
        sys.exit(f'pack health is not ready: {run.stdout} {run.stderr}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', nargs='?')
    parser.add_argument('out', nargs='?')
    parser.add_argument('--tag')
    parser.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY', 'anhtahaylove/thanh-am-studio'))
    parser.add_argument('--verify')
    parser.add_argument('--manifest-sha256')
    args = parser.parse_args()
    if args.verify:
        problems = verify_tree(args.verify, args.manifest_sha256)
        print('\n'.join(problems[:50]) or 'pack tree equals its manifest')
        return 1 if problems else 0
    match = re.fullmatch(r'pack-separation-v(\d+)', args.tag or '')
    if not (args.source and args.out and match):
        parser.error('source, out and --tag pack-separation-v<N> are required')
    number = match.group(1)
    out = Path(args.out)
    tree = out / 'separation-runtime'
    if tree.exists():
        shutil.rmtree(tree)
    out.mkdir(parents=True, exist_ok=True)
    shutil.copytree(args.source, tree, symlinks=True)
    for rel in REQUIRED:
        if not (tree / rel).is_file():
            sys.exit(f'pack lacks {rel}')
    for stale in [*tree.rglob('libiompstubs5md.dll'), *tree.rglob('cudnn64_*.dll')]:
        sys.exit(f'pack carries {stale}')
    for shim in tree.rglob('libiomp5md.dll'):
        if shim.stat().st_size > 256 * 1024:
            sys.exit(f'{shim} is not the OpenMP shim')
    compile_tree(tree)
    moved = move_licences(tree)
    longest = check_budget(tree)
    pack_health(tree)
    count = write_manifest(tree)
    problems = verify_tree(tree)
    if problems:
        sys.exit('pack tree changed while it was checked, first: ' + problems[0])
    asset = out / f'separation-runtime-v{number}.zip'
    zip_tree(tree, asset)
    pin = {'revision': f'separation-v{number}', 'url': f'https://github.com/{args.repo}/releases/download/{args.tag}/{asset.name}',
           'size': asset.stat().st_size, 'unpacked_size': sum(path.stat().st_size for _, path in files(tree)), 'sha256': sha256(asset), 'manifest_sha256': sha256(tree / MANIFEST),
           'files': count + 1, 'longest_path': longest}
    (out / f'separation-runtime-v{number}.pin.json').write_text(json.dumps(pin, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({**pin, 'licence_files_moved': moved}, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
