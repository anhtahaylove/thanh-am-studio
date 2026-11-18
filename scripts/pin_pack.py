"""Writes a published pack's pin into worker/models.json.

usage: python scripts/pin_pack.py <separation-runtime-v<N>.pin.json>
The pin file is a release asset of the pack-separation-v<N> release (scripts/build_pack.py writes it). The entry's
revision and url must already name the same release; the script refuses a pin for another revision.
"""
import json, re, sys
from pathlib import Path

MODELS = Path(__file__).resolve().parents[1] / 'worker' / 'models.json'
FIELDS = ('url', 'size', 'unpacked_size', 'sha256', 'manifest_sha256', 'files', 'longest_path')


def pin(pin_file, models_file=MODELS):
    new = json.loads(Path(pin_file).read_text(encoding='utf-8'))
    text = Path(models_file).read_text(encoding='utf-8')
    registry = json.loads(text)
    entry = next(m for m in registry['models'] if m['id'] == 'separation-runtime')
    if entry['revision'] != new['revision']:
        sys.exit(f"models.json names {entry['revision']}, the pin is for {new['revision']}: change the entry's revision first")
    for field in FIELDS:
        old = json.dumps(entry['pack'][field])
        text, count = re.subn(rf'("pack": \{{[^}}]*?"{field}": ){re.escape(old)}', lambda m: m.group(1) + json.dumps(new[field]), text, count=1, flags=re.S)
        if count != 1:
            sys.exit(f'could not rewrite {field}')
    Path(models_file).write_text(text, encoding='utf-8', newline='')
    json.loads(text)


if __name__ == '__main__':
    pin(sys.argv[1])
