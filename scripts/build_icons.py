"""Render the app icon sources and write src-tauri/icons/icon.png and icon.ico.

usage: python scripts/build_icons.py   (after `npm ci`)

Each SVG in src-tauri/icons/source is rendered at its own size by `npx tauri icon <svg> -p <size>` (resvg):
app-icon-<size>.svg are the hand-hinted small sizes, app-icon.svg gives the larger ones and the 1024 px icon.png.
icon.ico holds every size as the rendered 32-bit PNG, smallest first.
"""
import struct, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / 'src-tauri' / 'icons'
MASTER_SIZES = [64, 96, 128, 256]
PNG = b'\x89PNG\r\n\x1a\n'


def render(svg, sizes, out):
    args = [a for s in sizes for a in ('-p', str(s))]
    subprocess.run(['npx', 'tauri', 'icon', str(svg), '-o', str(out), *args], cwd=ROOT, check=True, capture_output=True, shell=sys.platform == 'win32')
    return {s: (out / f'{s}x{s}.png').read_bytes() for s in sizes}


def main():
    pngs = {}
    with tempfile.TemporaryDirectory() as tmp:
        for svg in (ICONS / 'source').glob('app-icon-*.svg'):
            size = int(svg.stem.rsplit('-', 1)[1])
            pngs.update(render(svg, [size], Path(tmp) / svg.stem))
        master = render(ICONS / 'source' / 'app-icon.svg', MASTER_SIZES + [1024], Path(tmp) / 'master')
    assert not set(pngs) & set(MASTER_SIZES), 'a hinted source repeats a size rendered from app-icon.svg'
    (ICONS / 'icon.png').write_bytes(master.pop(1024))
    pngs.update(master)
    sizes = sorted(pngs)
    for s in sizes:  # IHDR: width, height, 8-bit RGBA (colour type 6)
        assert pngs[s][:8] == PNG and struct.unpack_from('>IIBB', pngs[s], 16) == (s, s, 8, 6), s
    # ICONDIR, one ICONDIRENTRY per size (1 plane, 32 bpp; 0 stands for 256), then the PNG files.
    head, offset = struct.pack('<HHH', 0, 1, len(sizes)), 6 + 16 * len(sizes)
    for s in sizes:
        head += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(pngs[s]), offset)
        offset += len(pngs[s])
    (ICONS / 'icon.ico').write_bytes(head + b''.join(pngs[s] for s in sizes))
    print('icon.ico:', ' '.join(map(str, sizes)), 'px; icon.png: 1024 px')


if __name__ == '__main__':
    main()
