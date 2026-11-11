# Release process

The installer ships the app, the worker, a private CPython 3.11.18 runtime with the locked CPU
inference closure and a pinned LGPL FFmpeg build. Models are not shipped; users download them
in **Model & cài đặt** (pinned revisions and digests in `worker/models.json`).

## Reproducible build (Windows x64)

Requirements: Node 22+, Rust stable (MSVC), uv, git. No administrator rights.

```powershell
npm ci
./scripts/setup-runtime.ps1          # runtime/python + runtime/ffmpeg (FFmpeg SHA-256 pinned)
python scripts/third_party.py release # release/sbom.cdx.json + release/THIRD-PARTY-NOTICES.txt
npm run tauri build -- --ci
```

makensis cannot open paths longer than 260 characters. If the checkout path is long, build
from a short drive: `subst T: <repo>; cd T:\; npm run tauri build -- --ci; subst T: /d`.
Do not run `src-tauri/target/release/thanh-am-studio.exe` while bundling (the bundler patches it).

`.github/workflows/release.yml` does the same on a `v*` tag, attaches the installer,
`SHA256SUMS.txt`, the SBOM and notices to a **draft pre-release**. Publishing the draft is a
manual decision after the acceptance gates below pass on that exact tag.

## Acceptance gates (on the installer built from the tagged revision)

1. Unit/integration: `npm test`, `npm run test:e2e`, `cargo test --manifest-path src-tauri/Cargo.toml --tests`,
   `python -m unittest discover -s worker/tests`.
2. Packaged desktop flow on a clean Windows Sandbox (no Python/FFmpeg on PATH): copy the installer
   to a folder, adjust and open a `.wsb` that maps the repo, `C:\Program Files\nodejs`, the installer folder and
   a writable output folder, with `e2e/desktop/sandbox-run.ps1` as the logon command. It installs
   silently, then runs `e2e/desktop/packaged.mjs` phases `full` (model download via UI, TTS,
   preview, new take, render + save dialog, STT + apply, SRT export), `reopen` and `offline`
   (network adapters disabled).
3. Long project: `node e2e/desktop/gate.mjs <installed exe> <out> 500` (500 segments, cancel,
   hard crash mid-batch, restart/retry, full render, STT round trip WER/CER, RAM).
4. Human listening pass on the fixed corpus (A/B: same sentences, same order, keep per-sentence
   files and the joined render). Metrics never replace listening.

## Signing and licenses

Installers are currently **unsigned**; Windows SmartScreen will warn. Record the signing status
in the release notes. Third-party components and their licenses are listed in the generated
SBOM/notices; FFmpeg and python-soxr are LGPL and ship as separate replaceable files with their
license and source pointer (`runtime/ffmpeg/SOURCE.txt`). Models (VieNeu v3 Turbo and the MOSS
audio tokenizer: Apache-2.0; faster-whisper conversions: MIT) are downloaded by the user, not
redistributed.
