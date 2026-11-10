# Thanh Âm Studio status

## Implemented and freshly verified

- Rust: SQLite projects, revision-locked saves, content-addressed media imports, interrupted/cancelled/retryable jobs, TTS take preservation and worker boundary tests.
- UI: six screens, Vietnamese TTS segment editor, dictionary normalization, transcript editing/split/merge, TXT/SRT/VTT export, voice consent, model/job views, theme switch, responsive browser preview.
- Worker: protocol validation, model manifest/digest verification, CPU VieNeu/faster-whisper adapters, FFmpeg probe/render, atomic outputs, and private-runtime setup.
- Research: static REA + Craft Anything M0 artifacts and evidence-linked design implications in `docs/research.md`; raw evidence remains under the workspace `work/research/evidence` directory, outside this repository.

## Commands run on 2026-11-10

- `npm test -- --run`: 12 tests passed.
- `npm run build`: Vite/TypeScript build passed.
- `npm run test:e2e`: 3 Playwright tests passed, including 1440/1280/960/640 viewport overflow checks.
- `python -m unittest discover -s worker/tests -v`: 8 tests passed, including real FFmpeg render validation.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests`: 8 Rust tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `npm run tauri build -- --ci`: passed; NSIS installer created at `src-tauri/target/release/bundle/nsis/Thanh Âm Studio_0.1.0_x64-setup.exe` (2.81 MiB).

## Runtime caveat

The committed checks cover the worker protocol and FFmpeg path. The worker branch also measured a real CPU TTS/STT smoke with the private Python 3.11 environment; the public repository does not include that environment or model cache. Before calling this a release candidate, repeat that smoke from a clean Windows machine after `scripts/setup-runtime.ps1`, download each selected model, and listen to a fixed Vietnamese corpus while measuring RTF, WER/CER, RAM and disk use.
