# Parity harness

The Rust worker must behave like the v1.0.16 Python worker (E0: the same events, exit codes, files and bytes, no tolerance unless a row says
so). Rows X, W, R and F compare the worker with output recorded from the unchanged v1.0.16 worker (the P0-A goldens). The preset TTS rows
make their Python reference on the machine that runs them, from the private runtime, and compare bitwise on that CPU.

| Row | What | Comparator | Golden |
|-----|------|------------|--------|
| X | render and probe: 51 recipes | `x_compare.py` | `x/golden.json`, `x/requests/`, `x/fixtures/` |
| W | download: 35 scenarios against a Hugging Face stand-in with fault injection | `w_compare.py`, `hf_stub.py` | `w/golden.json` |
| R | protocol, validation and error cases (38) | `r_compare.py` | `r/cases.json` (recorded with `--record`) |
| F | ORT FFI against the recorded Silero and VieNeu tensors | `cargo test -p ortffi` | `../crates/ortffi/fixtures/` |
| L, P1 | preset TTS before the engine: the text check (token cap), pause marks, chunks and gaps, the readings and token ids of every chunk, and the preset voices as loaded; 10,000+ lines from `tts_corpus.py` | `tts_cases.py`, then `cargo test --release tts::` | made on the machine |
| P-op, P3-P5 | preset `tts` seeded (`THANHAM_TTS_SEED`) in both workers: events, WAV and raw WAV bytes, and per engine call the logits (P3), codes (P4) and decoded PCM (P5); 148 items in `tts/items.json` | `tts_op.py` (with `tts_trace.py` on the Python side) | made on the machine |
| P-op, K-cond (cloned) | cloned `tts` and `clone_preview` seeded in both workers: the P-op rows above, plus every step of reference enrollment (decode, window, trim, the PCM_16 file, each resample, the denoiser's STFT, ORT and output, fbank, embedding, codes; `THANHAM_CLONE_TRACE`) and the preview's bytes; 25 items in `tts/clone_items.json` over 20 references (rates 8 to 96 kHz, stereo, every importer format soundfile reads, and M4A) | `tts_op.py --refs --previews` | references made on the machine by `clone_refs.py` from preset takes (no recording in the repository) |
| Engine (STT) | the CTranslate2 engine of `engine/build-engine.ps1` linked into the worker (feature `ct2`): the S1 F-a link checks and the backend CTranslate2 chose, then the encoder on S1's deterministic input against the Python wheel, bitwise | `engine/check-link.ps1`; `cargo test --release --features ct2 ct2::` with the output of `ct2_encode.py` | made on the machine |
| D | the STT decode: faster-whisper's `decode_audio` (PyAV 18.1.0 on its own FFmpeg 8.1.2 DLLs) against `stt/decode.rs` on the same DLLs, bitwise: the int16 samples, or the exception's type and text; 6 containers x 4 rates x mono/stereo, the resampler's passthrough, u8/s24/f32/5.1 input, two audio tracks, several 500000-sample groups, no audio stream, unreadable, truncated and damaged files, a missing file, a non-ASCII name, plus the clone references ; with `--vad`, faster-whisper's VAD on every decoded case too (`get_speech_timestamps` with `VadOptions()`: the Silero probabilities bitwise and the speech chunks) | `decode_cases.py --vad`, then `cargo test --release stt::` | made on the machine |
| T4, T5 | `stt` in both workers on the same file and options (language, speakers), interleaved rounds: wall time, peak working set and CPU time per process (`ram.csv`), and the events compared (progress, rows, speakers, language) | `stt_op.py --rounds N` | the machine's audio |

Run them from `worker-rs/`, after `cargo build --release`:

```
python parity/x_compare.py --exe target/release/thanham-worker.exe --ffmpeg <ffmpeg.exe> [--seg <dir of the 500 recorded takes>] [--opus-python <py> --main ../worker/main.py]
python parity/fetch_models.py --exe target/release/thanham-worker.exe --models <folder>
python parity/w_compare.py --exe target/release/thanham-worker.exe --models <folder>
python parity/r_compare.py --exe target/release/thanham-worker.exe
ORTFFI_REQUIRE=1 cargo test -p ortffi        # with ORTFFI_DLL, ORTFFI_SHERPA_DLL, ORTFFI_SILERO and ORTFFI_VIENEU set
<py> -I -X utf8 parity/tts_corpus.py .. corpus.jsonl
<py> -I -X utf8 parity/tts_cases.py --corpus corpus.jsonl --model <models>/vieneu-v3 --out cases.jsonl
THANHAM_TTS_CASES=cases.jsonl THANHAM_TTS_MODEL=<models>/vieneu-v3 THANHAM_PYTHON=<py> cargo test --release tts::
<py> -I parity/tts_op.py --python <py> --exe <staged thanham-worker.exe> --model <models>/vieneu-v3 --ffmpeg <ffmpeg.exe> --items parity/tts/items.json --out <dir> [--rounds N]
<py> -I parity/clone_refs.py --python <py> --model <models>/vieneu-v3 --ffmpeg <ffmpeg.exe> --out <refs>
<py> -I parity/tts_op.py --python <py> --exe <staged thanham-worker.exe> --model <models>/vieneu-v3 --ffmpeg <ffmpeg.exe> --items parity/tts/clone_items.json --refs <refs> --previews --out <dir>
<py> -I parity/stt_op.py --python <py> --exe <staged thanham-worker.exe> --model <models>/whisper-small --input <audio> --out <dir> [--rounds N] [--language auto] [--speakers 2 --diarize-model <folder>]
```

`<py>` is the private runtime's `runtime\python\python.exe` (`scripts/setup-runtime.ps1`). The staged exe is `scripts/stage-worker.ps1`'s folder plus
`worker/models.json`; it reads numpy's OpenBLAS, sea-g2p's dictionary and the VieNeu voices from that runtime (`THANHAM_PYTHON`, else
`..\runtime\python` beside its folder, the installed layout). `--rounds N` interleaves N Python/Rust pairs and writes wall time and peak
working set per process to `ram.csv` (the A4a RTF and RAM accept).

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

- `health` is not a parity row: the Rust result is `{engine, version, ort, ffmpeg, ready, stt_engine}` (`stt_engine` is null unless the exe is
  built with the `ct2` feature) and the Python one lists its modules.
- Row F is bit-exact on a CPU of the family that recorded the tensors (ORT picks kernels by CPU; on GitHub runners the committed VieNeu
  recordings differed in the last digits, max abs diff 2.6e-6). `parity.yml` therefore records the fixtures again on its runner with
  `crates/ortffi/tools/gen_fixtures.py` and the private runtime's onnxruntime, then compares exactly; there is no tolerance.
- The `.opus` encodes of the two x05 recipes differ between machines (most likely libopus picking its code paths by CPU: GitHub runners
  differed from the goldens, while the Python and Rust workers on one runner gave identical PCM), so their decoded PCM matches the goldens
  only on the recording machine. `parity.yml` runs those two recipes with `--opus-python`, which takes the PCM reference from the Python
  worker run on the same runner; everything else in them (exit code, events, file names, ffprobe fields) is still compared with the goldens.
- Row R replaces the text of a Python exception (`KeyError: 'x'`, `JSONDecodeError: ...`) with `<pyexc>`; its wording belongs to Python.
- Row W event comparison ignores the retry waits: `THANHAM_HUB_SLEEP_SCALE` shortens them for the comparison (the release exe waits as the
  Python client does).
