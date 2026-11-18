# Parity harness

The Rust worker must behave like the v1.0.16 Python worker (E0: the same events, exit codes, files and bytes, no tolerance unless a row says
so). Each row compares the worker with output recorded from the unchanged v1.0.16 worker (the P0-A goldens).

| Row | What | Comparator | Golden |
|-----|------|------------|--------|
| X | render and probe: 51 recipes | `x_compare.py` | `x/golden.json`, `x/requests/`, `x/fixtures/` |
| W | download: 35 scenarios against a Hugging Face stand-in with fault injection | `w_compare.py`, `hf_stub.py` | `w/golden.json` |
| R | protocol, validation and error cases (38) | `r_compare.py` | `r/cases.json` (recorded with `--record`) |
| F | ORT FFI against the recorded Silero and VieNeu tensors | `cargo test -p ortffi` | `../crates/ortffi/fixtures/` |

Run them from `worker-rs/`, after `cargo build --release`:

```
python parity/x_compare.py --exe target/release/thanham-worker.exe --ffmpeg <ffmpeg.exe> [--seg <dir of the 500 recorded takes>]
python parity/fetch_models.py --exe target/release/thanham-worker.exe --models <folder>
python parity/w_compare.py --exe target/release/thanham-worker.exe --models <folder>
python parity/r_compare.py --exe target/release/thanham-worker.exe
ORTFFI_REQUIRE=1 cargo test -p ortffi        # with ORTFFI_DLL, ORTFFI_SHERPA_DLL, ORTFFI_SILERO and ORTFFI_VIENEU set
```

## Golden placement (decision)

- Kept in the repository, under `worker-rs/parity/`: every golden file, the recipes and requests, and the 22 small fixtures of row X (4.5 MB),
  plus the ORT tensors of row F (3.7 MB, with `PROVENANCE.txt`). A PR that changes the worker then runs the same comparison anyone can reproduce.
- Not in the repository: the 500 recorded segment takes of the x09-500 recipes (only `x/seg.sha256`, their SHA-256 list, is kept; pass the folder
  with `--seg`, CI skips those recipes and the release gate runs them) and the 1.1 GB of model files (`fetch_models.py` downloads them through the
  Rust worker, and `parity.yml` caches them under a key made from `worker/models.json`).
- Goldens were recorded with the FFmpeg build pinned in `scripts/setup-runtime.ps1`; `parity.yml` fetches that same build, so a different
  FFmpeg is a golden change, not a worker change.
- A golden is only re-recorded from the Python worker of a released version, never from the Rust worker.

## Declared differences

- `health` is not a parity row: the Rust result is `{engine, version, ort, ffmpeg, ready}` and the Python one lists its modules.
- Row F is bit-exact on a CPU of the family that recorded the tensors (ORT picks kernels by CPU). On a GitHub runner the VieNeu outputs differed in the last
  digits on one runner and matched on another (max abs diff 2.6e-6), so `parity.yml` sets `ORTFFI_MAX_ABS_DIFF=1e-5`; unset, the test is exact.
- The `.opus` encodes of the two x05 recipes differed on a GitHub runner while every other recipe matched. The likely cause is libopus choosing SIMD paths by CPU (not
  proven: the Python worker was not run on that runner). `x_compare.py` is exact on the machine that recorded the goldens (and the release gate runs it there); `parity.yml` passes `--opus-by-cpu`, which skips only the PCM hash of `.opus` outputs and keeps
  the exit code, events, file names, ffprobe fields and the decode check.
- Row R replaces the text of a Python exception (`KeyError: 'x'`, `JSONDecodeError: ...`) with `<pyexc>`; its wording belongs to Python.
- Row W event comparison ignores the retry waits: `THANHAM_HUB_SLEEP_SCALE` shortens them for the comparison (the release exe waits as the
  Python client does).
