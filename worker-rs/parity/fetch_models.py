r"""fetch_models.py: downloads the registry's models through the Rust worker into a folder, for row W and the engine rows.

usage: python fetch_models.py --exe <thanham-worker.exe> --models <folder> [--skip whisper-turbo,...] [--only id,id]

The worker reads its registry (models.json) next to its exe, so the exe is copied beside the repository's worker\models.json first. Each model
is one `download` request, as the app sends it; an installed folder is only verified. Exits 1 if a download fails."""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REGISTRY = Path(__file__).resolve().parents[2] / 'worker' / 'models.json'


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', required=True)
    ap.add_argument('--models', required=True)
    ap.add_argument('--skip', default='')
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    models = Path(args.models).resolve()
    models.mkdir(parents=True, exist_ok=True)
    skip, only = set(filter(None, args.skip.split(','))), set(filter(None, args.only.split(',')))
    registry = json.loads(REGISTRY.read_text(encoding='utf-8'))
    stage = Path(tempfile.mkdtemp(prefix='fetch-models-'))
    shutil.copy(args.exe, stage / 'thanham-worker.exe')
    shutil.copy(REGISTRY, stage / 'models.json')
    failed = 0
    for model in registry['models']:
        mid = model['id']
        if mid in skip or (only and mid not in only):
            continue
        request = {'protocol': 1, 'id': f'fetch-{mid}', 'operation': 'download', 'payload': {'model_id': mid}, 'output_dir': str(stage), 'models_dir': str(models)}
        p = subprocess.run([str(stage / 'thanham-worker.exe')], input=(json.dumps(request) + '\n').encode(), capture_output=True)
        last = json.loads(p.stdout.decode('utf-8', 'replace').strip().splitlines()[-1]) if p.stdout.strip() else {}
        ok = p.returncode == 0 and last.get('event') == 'result'
        failed += not ok
        print(('ok  ' if ok else 'FAIL'), mid, '' if ok else json.dumps(last, ensure_ascii=False)[:300])
    shutil.rmtree(stage, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
