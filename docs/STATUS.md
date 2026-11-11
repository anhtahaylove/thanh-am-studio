# Thanh Âm Studio status

Last updated 2026-11-11. Evidence below was observed, not inferred; anything not listed is unverified.

## Implemented

- Self-contained NSIS installer (~195 MiB, per-user, no admin): app + worker + private CPython 3.11.18
  runtime with the locked CPU closure + app-local MSVC CRT + pinned BtbN LGPL FFmpeg 9.0.2 + third-party notices.
  Release builds never use the source checkout, PATH or developer env vars.
- Models downloaded in the app: pinned revisions and per-file digests, plain-HTTP resumable download
  with byte progress, disk-space check, `NETWORK`/`DISK_FULL` errors, no duplicate cache copy.
- TTS: script import (sentence-aware), app + project pronunciation dictionaries, speaker-to-voice
  roles, preset or consented reference voices, split/merge, undo/redo, takes are append-only (new take
  never replaces old ones; concurrent saves keep server-written takes), preview and export share the
  trim/fade/gain/gap recipe (export additionally normalizes when enabled).
- Queue: batched TTS (one worker process loads the model once for up to 32 segments; a failing
  segment does not stop the batch), cancel, retry, `interrupted` after restart, workers killed with
  the app through a Windows job object; running jobs show percent and an estimated time left.
- STT: faster-whisper CPU INT8, explicit apply of results, transcript edit/add/delete rows, timestamp
  validation, TXT/SRT/VTT export.

## Verification (2026-11-11)

| Gate | Result |
|---|---|
| `npm test` | 25 passed |
| `npm run test:e2e` (browser preview) | 6 passed |
| `cargo test --tests` | 8 store + 3 runtime passed |
| `python -m unittest` (worker) | 10 passed (incl. real FFmpeg render, disk-full refusal, take peak limiter) |
| GitHub Actions CI (PRs #1–#7 and `main`) | pass |
| Real model download (whisper-small) | kill at 34 % then resume completed; 464 MB on disk (1×); proxy-blocked network → `NETWORK` error |
| Packaged release exe on dev machine (`e2e/desktop/packaged.mjs full`, `reopen`) | all steps PASS |
| **Clean Windows Sandbox** (Windows 11 26100, no Python/FFmpeg/uv on PATH, 8 GB) | installer 94–100 s; download both models via UI; TTS; preview playback; new take keeps old; restart and reopen project; **network adapters disabled**: TTS, render + save WAV via native dialog to a Unicode path, STT on it + apply, SRT export — all PASS (local builds and the CI-built v0.1.0 installer, see below) |
| **Whisper Turbo + MP3** (clean Sandbox, CI-built v0.1.0 installer, `packaged.mjs turbo`, network on) | install 111 s; Whisper Large v3 Turbo downloaded via the models page in 47 s and listed as installed; project rendered as MP3 and saved via the native dialog: 161,900 bytes, ffprobe `codec_name=mp3`, 48 kHz, 192 kb/s, 6.68 s; Turbo STT on that MP3 49.6 s including model load, transcript identical to the fixture; applied — PASS |
| 500-segment gate | see below |

Clean-machine runs found and fixed two release blockers that the dev machine hid: the Python runtime
needed the MSVC C++ runtime (`onnxruntime` import failed), and the dev-machine-only WebView2 debug
flag. Measured on the dev CPU (i5-13400F, CPU only): model load ≈7 s per batch, ≈2.2 s per short
sentence, STT of 6 s audio ≈8 s including model load.

### 500-segment gate (packaged release exe on the dev machine, i5-13400F, CPU only)

`e2e/desktop/gate.mjs` at `2d51875` (includes the take peak limiter), synthetic original Vietnamese
script, 500 segments of ~35-45 syllables:

| Check | Result |
|---|---|
| Generation via UI "Tạo giọng tất cả" | 500/500 segments with a selected take, 0 failed jobs |
| Cancel 3 queued jobs, then hard-kill the app mid-batch (`taskkill /F /T`) | 0 orphan Python workers; restart 0.56 s; on restart 40 done, 10 `interrupted`, 415 queued, 32 running, 3 cancelled, no data lost; retries completed |
| Audio length | **67.9 min synthesized** (segments average 8.2 s); render with gaps 70.5 min |
| TTS throughput | 58.7 min wall for 67.9 min of audio (RTF 0.86 including the crash/restart) |
| Full render + normalize | 192 s; duration exactly equals takes + gaps (4,227,040 ms) |
| STT round trip (whisper-small, CPU INT8) on the full render | 84.6 min (RTF 1.20; other CPU-heavy checks ran on the same machine during this step); WER 9.2 %, CER 4.5 % against the script |
| Peak RAM (largest single process) | Python worker 3,433 MB; app process 82 MB (WebView2 processes not counted) |
| Reopen the 500-segment project after restart | 0.67 s |
| Clipping (signal analysis) | all 500 takes and the 20-file listening pack: 0 samples at or above 0.999 of full scale, highest peak -0.18 dBFS (the limiter ceiling), highest 4x-oversampled true peak -0.08 dBTP; full render peak -1.48 dBFS |

An earlier run (before the limiter, ~25-syllable segments) reached only 43.9 min of audio: TTS RTF
1.03, STT RTF 0.66, WER 10.2 %, CER 5.1 %, peak Python worker 996 MB.

#### Clipping on the v0.1.0 listening pack (sentence 19)

The first pack (`305ce75`) had one clipped take: sentence 19 (PCM 24-bit, 5.0 s) had 2 consecutive
samples pinned at the 24-bit maximum and a true peak of +0.03 dBTP at 3.75 s; every other file peaked
between -0.35 and -3.70 dBFS. The TTS engine can overshoot full scale and the PCM write hard-clipped
it. Since PR #5 each take is scaled down to a 0.98 peak before it is written (whole take, so the
shape is kept); export normalization is unchanged.

WER/CER compare the synthesized script with the STT transcript, so they mix TTS and STT errors.
Typical mismatches are tone/initial confusions ("mùa thu" → "mùa thương", "chăm chú" → "trăm chú");
they are flagged for listening and are not proof of TTS mispronunciation.

### v0.1.0 draft release (built by `.github/workflows/release.yml` from tag `v0.1.0` at `305ce75`)

| Check | Result |
|---|---|
| Release workflow | npm test, private runtime build, SBOM/notices, `cargo test`, `tauri build`, checksums, draft pre-release: success |
| Assets | `ThanhAmStudio_0.1.0_x64-setup.exe` (204,445,415 bytes), `SHA256SUMS.txt`, `sbom.cdx.json`, `THIRD-PARTY-NOTICES.txt` |
| Installer SHA-256 | `37c68efc91027131b01b55e9015d146cddbd9f38f2229c5bd6515b7079501e55`; `sha256sum -c SHA256SUMS.txt` OK for all files after download |
| Clean Windows Sandbox on that exact downloaded installer | install 94 s, 815 MB; phases `full` (model download via UI, TTS, preview, new take, render + WAV save to a Unicode path, STT + apply, SRT), `reopen`, `offline` (network adapters disabled: TTS) and `export` (still offline: render, WAV, STT, SRT): 21 PASS, 0 FAIL |

The draft is not published. Publishing waits for the human listening pass below.

## Not verified / known gaps

- Listening quality has not been judged by a human; the clipping checks above are signal analysis.
  The listening pack (first 20 sentences as separate files in script order, plus the full render) is
  produced by the gate for an A/B pass. STT round-trip shows audible-risk words (e.g. "giọng" heard
  as "dọng"); these are flagged for listening, not treated as proof of mispronunciation.
- The v0.1.0 draft was built from `305ce75`, before the take peak limiter (PR #5); it still writes
  takes that can clip. A new draft is needed before publishing.
- In the Sandbox run that verified Turbo + MP3, the following offline `export` phase failed once: the
  saved WAV was not found 10 s after the save dialog was filled (the same phase passed on the
  previous run). The harness now waits 30 s and lists the folder on failure; not yet re-run.
- Peak Python worker memory rose to 3.4 GB in the 60-minute gate (996 MB with shorter segments); the
  gate does not record whether TTS or STT set it. The 8 GB Sandbox only ran short projects.
- Reference-voice cloning quality and UI at high DPI were not exercised end-to-end.
- Installers are unsigned (SmartScreen warning). CUDA is not enabled.
- Preview does not apply loudness normalization; export does when "Chuẩn hóa" is on.
