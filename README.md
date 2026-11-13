# Thanh Âm Studio

Windows local-first Vietnamese text-to-speech and speech-to-text studio. Write or import a
script (TXT/SRT), assign voices per speaker, generate and compare takes, trim/fade/gain, export
WAV/MP3; or transcribe audio/video, edit the transcript and export TXT/SRT/VTT. Everything runs
on the CPU of your machine; nothing is sent to a cloud service. Original source is Apache-2.0.

## Install

Download the installer from the GitHub release page and run it (per-user install, no
administrator rights). It includes its own Python runtime and FFmpeg, so nothing else is
needed. On first start open **Model & cài đặt** and download the models you need (VieNeu v3
Turbo for TTS ≈ 640 MB, Whisper Small ≈ 490 MB or Whisper Large v3 Turbo ≈ 1.6 GB for STT).
After that the app works offline. Installers are not code-signed yet, so SmartScreen may warn
(see [Code signing policy](#code-signing-policy)).

## Development

```powershell
npm install
npm test
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --tests
python -m unittest discover -s worker/tests -v
./scripts/setup-runtime.ps1       # private runtime the installer bundles (no admin, no system changes)
npm run tauri dev
```

Building and verifying a release: [docs/RELEASE.md](docs/RELEASE.md). Cross-layer contract:
[docs/CONTRACT.md](docs/CONTRACT.md). Current verification status: [docs/STATUS.md](docs/STATUS.md).

## Code signing policy

Installers are not signed yet. The project is applying for free code signing for open source
projects; once accepted, releases will carry:
Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Only the installer is signed: the file users download and Windows checks, built by
  [the release workflow](.github/workflows/release.yml) from this repository. The files it installs
  (the app executable and bundled third-party files such as the Python runtime, FFmpeg and
  libraries) are not signed again and keep their upstream signatures or none.
- Committers and reviewers: [@anhtahaylove](https://github.com/anhtahaylove) (maintainer). Changes
  from anyone else are reviewed before merge.
- Approvers: [@anhtahaylove](https://github.com/anhtahaylove). Every release is approved for
  signing by hand after the checks in [docs/RELEASE.md](docs/RELEASE.md) pass on the exact build.

## Privacy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. The only network access is the
model download you start on the models page: the app then fetches pinned model files from
Hugging Face ([privacy policy](https://huggingface.co/privacy)). Text, audio, projects and voice
references stay on your machine.

## Scope

v1 is TTS/STT, batch jobs, transcript editing and a compact audio edit recipe on CPU.
DAW/multitrack, VST3, MIDI, microphone recording, fine-tuning, cloud providers, an HTTP/MCP
server and video dubbing are out of scope. Never commit user voice references, generated audio,
models, credentials or third-party reverse-engineering evidence.
