# CPU worker

Run `python worker/main.py`; send one UTF-8 JSON request, newline terminated, on stdin. One process handles one job. Stdout is JSONL protocol 1; third-party logging is redirected to stderr. The parent owns queue persistence, cancellation (terminate only this process) and partial file cleanup after a hard termination.

## Runtime

Use `scripts/setup-runtime.ps1` with uv available. It installs a private portable Python 3.11.18 and the locked CPU inference closure; it does not change system Python. `runtime/python/python.exe` is the packaged interpreter location. Models are NOT embedded. FFmpeg + FFprobe are needed for probe/render; set `THANHAM_FFMPEG` and `THANHAM_FFPROBE` in development or pass `ffmpeg_path`. Review exact codec build licensing before redistribution.

`requirements-cpu.lock` intentionally installs with `--no-deps`: all inference dependencies are enumerated while upstream Gradio web UI dependencies are omitted. VieNeu code is pinned to commit `22dd2ef2a89bba24a77da6dbc84c75f7f4fda05b`. Dependency licenses still need collection for a public installer; a runnable private environment alone is not release certification.

## Models

`models.json` pins each repository revision and every required file digest (LFS SHA-256 or Git blob SHA-1 for small files), sizes and license. Download is resumable through Hugging Face's content cache. Each file is verified before atomic placement; `installed.json` is written only after all checks. Every inference verifies the model manifest again. `voices.json` contains public preset names/metadata only, from the pinned upstream Apache-2.0 asset; embeddings remain in the installed upstream package.

Model IDs: `vieneu-v3`, `whisper-small`, `whisper-turbo`. Pass `models/<id>` as `model_path`. VieNeu uses ONNX FP32, CPU, a single batch and no GPU dependencies. HF offline flags are set before engine imports. The pinned wrapper does not forward its codec directory, so a narrow constructor-scoped resolver maps only the known codec repository to our verified local codec folder. It is restored immediately after initialization. Unexpected model requests fail rather than fetching an unpinned model.

Fresh reference cloning is supported via `reference_path`; consent and asset access checks belong to the desktop boundary. Do not copy user voice references into source control.

## Audio recipe

Trim uses an exclusive end in milliseconds; null end means source duration. Fades clamp to trimmed duration. Gain range -60..24 dB. Gap is appended after each clip, including the final one, matching TTS subtitle recipe timing. Render streams each clip to 48 kHz mono PCM temporary chunks, then concatenates; this avoids a 500-input FFmpeg command and does not load all PCM in Python. Optional normalization targets -16 LUFS, -1.5 dBTP. Output WAV PCM24 or MP3 192 kb/s is finalized atomically. No input file is overwritten.

## Verification

`python -m unittest discover -s worker/tests -v` runs protocol, validation, checksum, missing-model and real FFmpeg render tests. Engine synthesis requires downloaded models and private dependencies; ordinary tests do not substitute fake successful audio. See `SMOKE.md` for measured runtime status.
