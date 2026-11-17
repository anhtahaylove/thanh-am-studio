# Thanh Âm Studio

Windows local-first Vietnamese text-to-speech and speech-to-text studio. Write or import a
script (TXT, Word, SRT/VTT), assign voices per speaker, generate and compare takes, trim/fade/gain,
export WAV/MP3/M4A/FLAC/Opus (one file per chapter, or with each take at its subtitle time, optionally over the
source video's own background with its voices removed); or transcribe
audio/video, edit the transcript and export TXT/SRT/VTT. Everything runs
on the CPU of your machine; nothing is sent to a cloud service. Original source is Apache-2.0.

## Install

Download the installer from the GitHub release page and run it (per-user install, no
administrator rights). It includes its own Python runtime and FFmpeg, so nothing else is
needed. On first start open **Model & cài đặt** and download the models you need (VieNeu v3
Turbo for TTS ≈ 640 MB, Whisper Small ≈ 490 MB or Whisper Large v3 Turbo ≈ 1.6 GB for STT).
After that the app works offline. Installers are not code-signed, so SmartScreen may warn
(see [Code signing policy](#code-signing-policy)).

From 1.0.11 the app updates itself: it checks GitHub for a newer release, downloads it in the
background, verifies its signature and installs it when you close the window (projects, takes and
models are kept). **Model & cài đặt → Cập nhật** turns this off or checks on request. Versions
1.0.10 and older have no updater, so install 1.0.11 from the release page once.

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

The optional **Tách giọng và nhạc nền (HTDemucs)** model (≈ 84 MB, not bundled; downloaded only when
you start it on the models page) separates a recording's background from its voices with PyTorch,
which the installer includes. Its code is MIT, but the licence of its weights is unclear upstream:
they were trained on MusDB-HQ, whose data is for research only, plus 800 unpublished songs
([adefossez/HTDemucs@cbc8a9b](https://huggingface.co/adefossez/HTDemucs/tree/cbc8a9b1a87023b7fd74e7b3412e6321c0eab003)).
Check that this fits your use before you download it.

## Troubleshooting

- **"Windows protected your PC" (SmartScreen).** The installer is not code-signed. Check its
  SHA-256 against `SHA256SUMS.txt` on the release page first, then choose **More info** and **Run anyway**.
- **Smart App Control blocks the installer.** Smart App Control has no per-app exception for unsigned
  programs, so the app cannot be installed while it is on, and no signed installer is planned
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

## Licences and warranty

Releases are built for the maintainer's friends and family and published here because the source is
open. The app is provided as is, without warranty or liability of any kind (Apache-2.0, sections 7
and 8); use it at your own risk.

The installer includes third-party binaries under their own terms, listed in
`THIRD-PARTY-NOTICES.txt` (installed next to the app and attached to each release). Two come from
Intel: the Intel OpenMP runtime (`libiomp5md.dll`, inside the bundled PyTorch and CTranslate2) under
the Intel End User License Agreement for Developer Tools, and Intel oneMKL (linked into PyTorch and
CTranslate2) under the Intel Simplified Software License. The installer's licence page summarises them: you may
not reverse engineer, decompile, disassemble or modify these Intel components, and Intel's warranty
disclaimers and limitations of liability apply to you. Read the full terms before you install.
Updates and silent installs (`/S`) do not show the page again; the same terms apply to what they
install.

## Code signing policy

Installers are not Authenticode-signed, so SmartScreen warns before the first install and Smart App
Control, when it is on, blocks it. SignPath Foundation declined the project's application for free
open source code signing on 2026-11-13, because the project does not yet have the public visibility
the program asks for. A paid certificate is not planned for an app shared with friends and family.

What is signed or checkable:

- Each update package is signed with the project's own update key (minisign, through the Tauri
  updater). From 1.0.11 on, the app installs an update only when its signature matches the public
  key built into the app and names the version the update claims to be.
- Every release page lists the SHA-256 of its files in `SHA256SUMS.txt`.
- Releases are built by [the release workflow](.github/workflows/release.yml) from this repository
  and published by [@anhtahaylove](https://github.com/anhtahaylove) (maintainer) after the checks in
  [docs/RELEASE.md](docs/RELEASE.md) pass on the exact build.

## Privacy

Text, audio, projects and voice references stay on your machine. The app makes two kinds of
network requests, and neither carries your content:

- **Model downloads** you start on the models page fetch pinned model files from Hugging Face
  ([privacy policy](https://huggingface.co/privacy)).
- **Update checks**, on by default: about 3 seconds after start and every 12 hours the app reads
  `latest.json` of the newest GitHub release and, when it names a newer version, downloads that
  release's signed installer from GitHub
  ([privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
  GitHub sees what any download shows (IP address and the updater's user agent). Turn the
  checks off in **Model & cài đặt → Cập nhật**; **Kiểm tra ngay** there still checks once on
  request.

## Scope

v1 is TTS/STT, batch jobs, transcript editing and a compact audio edit recipe on CPU.
DAW/multitrack, VST3, MIDI, microphone recording, fine-tuning, cloud providers, an HTTP/MCP
server and video dubbing are out of scope. Never commit user voice references, generated audio,
models, credentials or third-party reverse-engineering evidence.
