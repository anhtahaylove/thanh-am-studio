# Thanh Âm Studio

Windows local-first Vietnamese TTS/STT studio. Original source is Apache-2.0.

## Current milestone

The repository contains the first desktop slice: Tauri 2/Rust persistence and job boundary, React/Tauri UI, Python JSON-lines worker, pinned model registry, CPU VieNeu/faster-whisper adapters, FFmpeg edit recipes, and static REA/Craft Anything research. The installer is a small desktop shell; model weights and the private Python 3.11 runtime are downloaded/installed separately so the public repository does not contain large model files.

## Development

```powershell
npm install
npm test
npm run build
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --tests
python -m unittest discover -s worker/tests -v
npm run tauri build -- --ci
```

For local CPU inference, run `scripts/setup-runtime.ps1` from an elevated development shell only when you intend to install the private project runtime. It does not modify system Python. Download a model from the **Model & cài đặt** screen after the app starts; model revisions and file digests are in `worker/models.json`.

## Boundaries

- Browser preview deliberately does not pretend to run TTS/STT. Use the desktop build for native file access and workers.
- The v1 scope is TTS/STT, batch jobs, transcript editing and a compact audio edit recipe. DAW/VST3, cloud services, microphone capture and video dubbing are later milestones.
- Never commit user voice references, generated audio, models, credentials, extracted proprietary code or private REA/Craft evidence. See `docs/research.md` and `docs/CONTRACT.md`.
