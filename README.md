# Thanh Âm Studio

Windows local-first Vietnamese text-to-speech and speech-to-text studio. Write or import a
script (TXT, Word, SRT/VTT), assign voices per speaker, generate and compare takes, trim/fade/gain,
export WAV/MP3 (one file per chapter, or with each take at its subtitle time); or transcribe
audio/video, edit the transcript and export TXT/SRT/VTT. Everything runs
on the CPU of your machine; nothing is sent to a cloud service. Original source is Apache-2.0.

## Install

Download the installer from the GitHub release page and run it (per-user install, no
administrator rights). It includes its own Python runtime and FFmpeg, so nothing else is
needed. On first start open **Model & cài đặt** and download the models you need (VieNeu v3
Turbo for TTS ≈ 640 MB, Whisper Small ≈ 490 MB or Whisper Large v3 Turbo ≈ 1.6 GB for STT).
After that the app works offline. Installers are not code-signed yet, so SmartScreen may warn
(see [Code signing policy](#code-signing-policy)).

## Models and preset voices

Models are downloaded from their original publishers and keep their licences (VieNeu v3 Turbo and
the MOSS audio tokenizer: Apache-2.0; faster-whisper conversions: MIT; pyannote segmentation-3.0:
MIT; 3D-Speaker CAM++: Apache-2.0). The preset voices come with the VieNeu model. Its model card
at the revision the app pins
([pnnbao-ump/VieNeu-TTS-v3-Turbo@61b85e3](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo/blob/61b85e3d937fbbacb387714180e8182823512523/README.md),
"Usage Rights & Licensing FAQ") states that Apache-2.0 also covers the preset voices, that audio made
with them may be used commercially, and that the speakers consented; the training data is not
disclosed. Two upstream issues asking the maintainer to confirm this are still open
([pnnbao97/VieNeu-TTS#222](https://github.com/pnnbao97/VieNeu-TTS/issues/222),
[#218](https://github.com/pnnbao97/VieNeu-TTS/issues/218)). Clone only voices you have permission to use.

## Troubleshooting

- **"Windows protected your PC" (SmartScreen).** The installer is not code-signed yet. Check its
  SHA-256 against `SHA256SUMS.txt` on the release page first, then choose **More info** and **Run anyway**.
- **Smart App Control blocks the installer.** Smart App Control has no per-app exception for unsigned
  programs, so the app cannot be installed while it is on. Signed releases are planned
  (see [Code signing policy](#code-signing-policy)).
- **A model download stops.** Start it again on the models page; it resumes where it stopped and
  checks every file against its pinned digest. A `NETWORK` error means the download host was not
  reachable (a proxy or firewall); `DISK_FULL` means the drive that holds the app's data is out of space.
- **A job fails with `WORKER_EXIT`.** The job folder holds `worker.log`; attach it when you report
  the problem. The message names the likely cause for common crash codes (for example a CPU without
  an instruction set the engine needs, or running out of memory). TTS needs about 2.2 GB of RAM on
  top of the app; 8 GB in total is the tested minimum.

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
