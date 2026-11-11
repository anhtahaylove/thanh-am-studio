# CPU worker

Run `python -I -X utf8 worker/main.py`; send one UTF-8 JSON request, newline terminated, on stdin. One process handles one request; a `tts` request may carry `items` so the engine loads once for a batch of segments (each item reports its own `item` event). Stdout is JSONL protocol 1; third-party logging is redirected to stderr. The parent owns queue persistence, cancellation (terminate only this process) and partial file cleanup after a hard termination.

## Runtime

Use `scripts/setup-runtime.ps1` with uv available (no administrator rights). It builds `runtime/python` (private portable Python 3.11.18 plus the locked CPU inference closure, test suites pruned) and `runtime/ffmpeg` (pinned BtbN LGPL shared FFmpeg build, SHA-256 checked, with its license and source pointer). The installer bundles both; it never uses system Python, PATH or developer env vars in release builds. Models are NOT embedded. The desktop sets `THANHAM_FFMPEG`/`THANHAM_FFPROBE` to the bundled binaries.

`requirements-cpu.lock` intentionally installs with `--no-deps`: all inference dependencies are enumerated while upstream Gradio web UI dependencies are omitted. VieNeu code is pinned to commit `22dd2ef2a89bba24a77da6dbc84c75f7f4fda05b`. Dependency licenses still need collection for a public installer; a runnable private environment alone is not release certification.

## Models

`models.json` pins each repository revision and every required file digest (LFS SHA-256 or Git blob SHA-1 for small files), sizes and license. Downloads stream over plain HTTP (Xet disabled) into `models/.download/<id>` and resume from the partial file after a kill or network error; disk space is checked first, progress is reported by bytes, network failures return `NETWORK`, and HF caches stay inside the models folder and are removed afterwards (no second copy). Each file is verified before atomic placement; `installed.json` is written only after all checks. Every inference verifies the model manifest again. `voices.json` contains public preset names/metadata only, from the pinned upstream Apache-2.0 asset; embeddings remain in the installed upstream package.

Model IDs: `vieneu-v3`, `whisper-small`, `whisper-turbo`. Pass `models/<id>` as `model_path`. VieNeu uses ONNX FP32, CPU, a single batch and no GPU dependencies. HF offline flags are set before engine imports. The pinned wrapper does not forward its codec directory, so a narrow constructor-scoped resolver maps only the known codec repository to our verified local codec folder. It is restored immediately after initialization. Unexpected model requests fail rather than fetching an unpinned model.

Fresh reference cloning is supported via `reference_path`; consent and asset access checks belong to the desktop boundary. Do not copy user voice references into source control.

## Audio recipe

Trim uses an exclusive end in milliseconds; null end means source duration. Fades clamp to trimmed duration. Gain range -60..24 dB. Gap is appended after each clip, including the final one, matching TTS subtitle recipe timing. Render streams each clip to 48 kHz mono PCM temporary chunks, then concatenates; this avoids a 500-input FFmpeg command and does not load all PCM in Python. Optional normalization targets -16 LUFS, -1.5 dBTP. Output WAV PCM24 or MP3 192 kb/s is finalized atomically. No input file is overwritten.

## Verification

`python -m unittest discover -s worker/tests -v` runs protocol, validation, checksum, missing-model and real FFmpeg render tests. Engine synthesis requires downloaded models and private dependencies; ordinary tests do not substitute fake successful audio. See `SMOKE.md` for measured runtime status.
