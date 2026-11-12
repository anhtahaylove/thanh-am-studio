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
  the app through a Windows job object; running jobs show a filled progress bar, percent and an estimated time left (batched TTS jobs not yet
  started show as waiting).
- STT: faster-whisper CPU INT8 (long files in 10-minute windows, so memory stays ~1.2 GB), explicit apply of results, transcript edit/add/delete rows, timestamp
  validation, TXT/SRT/VTT export.

## Verification (2026-11-11)

| Gate | Result |
|---|---|
| `npm test` | 26 passed |
| `npm run test:e2e` (browser preview) | 6 passed |
| `cargo test --tests` | 8 store + 3 runtime passed |
| `python -m unittest` (worker) | 12 passed (incl. real FFmpeg render, disk-full refusal, take peak limiter, linear STT progress, STT windowing) |
| GitHub Actions CI (PRs #1–#12 and `main`) | pass |
| Real model download (whisper-small) | kill at 34 % then resume completed; 464 MB on disk (1×); proxy-blocked network → `NETWORK` error |
| Packaged release exe on dev machine (`e2e/desktop/packaged.mjs full`, `reopen`) | all steps PASS |
| **Clean Windows Sandbox** (Windows 11 26100, no Python/FFmpeg/uv on PATH, 8 GB) | installer 94–100 s; download both models via UI; TTS; preview playback; new take keeps old; restart and reopen project; **network adapters disabled**: TTS, render + save WAV via native dialog to a Unicode path, STT on it + apply, SRT export — all PASS (local builds and the CI-built v0.1.0 installer, see below) |
| **Whisper Turbo + MP3** (clean Sandbox, first CI-built v0.1.0 installer, `packaged.mjs turbo`, network on) | install 111 s; Whisper Large v3 Turbo downloaded via the models page in 47 s and listed as installed; project rendered as MP3 and saved via the native dialog: 161,900 bytes, ffprobe `codec_name=mp3`, 48 kHz, 192 kb/s, 6.68 s; Turbo STT on that MP3 49.6 s including model load, transcript identical to the fixture; applied — PASS |
| 500-segment gate | see below |

Clean-machine runs found and fixed two release blockers that the dev machine hid: the Python runtime
needed the MSVC C++ runtime (`onnxruntime` import failed), and the dev-machine-only WebView2 debug
flag. Measured on the dev CPU (i5-13400F, CPU only): model load ≈7 s per batch, ≈2.2 s per short
sentence, STT of 6 s audio ≈8 s including model load.

### 500-segment gate (packaged release exe on the dev machine, i5-13400F, CPU only)

`e2e/desktop/gate.mjs` on a release build with the take peak limiter (PR #5), synthetic original Vietnamese
script, 500 segments of ~35-45 syllables:

| Check | Result |
|---|---|
| Generation via UI "Tạo giọng tất cả" | 500/500 segments with a selected take, 0 failed jobs |
| Cancel 3 queued jobs, then hard-kill the app mid-batch (`taskkill /F /T`) | 0 orphan Python workers; restart 0.56 s; on restart 40 done, 10 `interrupted`, 415 queued, 32 running, 3 cancelled, no data lost; retries completed |
| Audio length | **67.9 min synthesized** (segments average 8.2 s); render with gaps 70.5 min |
| TTS throughput | 58.7 min wall for 67.9 min of audio (RTF 0.86 including the crash/restart) |
| Full render + normalize | 192 s; duration exactly equals takes + gaps (4,227,040 ms) |
| STT round trip (whisper-small, CPU INT8) on the full render | 84.6 min (RTF 1.20; other CPU-heavy checks ran on the same machine during this step); WER 9.2 %, CER 4.5 % against the script |
| Peak RAM (largest single process) | 3,433 MB: the STT worker (whisper-small builds the log-mel spectrogram of the whole file at once, see "STT memory on long files" below) |
| Reopen the 500-segment project after restart | 0.67 s |
| Clipping (signal analysis) | all 500 takes and the 20-file listening pack: 0 samples at or above 0.999 of full scale, highest peak -0.18 dBFS (the limiter ceiling), highest 4x-oversampled true peak -0.08 dBTP; full render peak -1.48 dBFS |

Repeat run on an idle machine (release build with the progress bar fix, per-phase memory sampled
every 5-10 s into `ram.csv`): 500/500 segments, 68.1 min synthesized, TTS RTF 0.86, render 132 s
(duration exact), STT 40.2 min (RTF 0.57), WER 9.2 %, CER 4.6 %, reopen 0.60 s, `ok`.

| Phase | Largest Python worker | Notes |
|---|---|---|
| TTS | 2,179 MB | 17 worker processes (one per batch of up to 32 segments), each peaking at 1,985-2,179 MB: ~1.8 GB after model load, then slow growth within the batch, released when the worker exits; one worker at a time |
| Render | 20 MB | FFmpeg does the work |
| STT (whisper-small) | 1,327 MB sampled | 650-750 MB while transcribing; the 10 s sampling missed a short spike to ~3.7-4.4 GB at the start (see below) |
| App process | 42 MB | WebView2 processes not counted |

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

Clean 8 GB Windows Sandbox, same 500-segment gate on the downloaded v0.1.0 installer built at `a202153`
(`sandbox-run.ps1 -Gate 500`): `ok`, 68.1 min synthesized, TTS RTF 1.02 (including crash/restart, 0
orphan workers), render 162 s (duration exact), STT 32.8 min (RTF 0.46), WER 9.7 %, CER 4.8 %, reopen
0.76 s. Largest Python worker: TTS 2,221 MB, render 20 MB, STT 3,662 MB (one sample ~50 s after the
STT job started, 725 MB 14 s later); app 41 MB. Queue screenshots: 31 batched TTS rows shown as
"Chờ trong lô" with an empty bar, the running row at 18 %, STT at 20 % and 60 % with filled bars.

#### STT memory on long files

Measured on the 70.6-minute render from that run with the bundled runtime (faster-whisper 1.2.1,
whisper-small, CPU INT8): decoding to 16 kHz peaks at 698 MB, Silero VAD at 1,037 MB, and the log-mel
spectrogram of the whole file at 3,832 MB, so sequential transcription needs memory proportional to
the file length. Same file, same scoring script, same model:

| Mode | Peak working set | Time | WER |
|---|---|---|---|
| Sequential, whole file (before) | 4,399 MB | 2,133 s | 9.69 % |
| faster-whisper `BatchedInferencePipeline` (rejected) | 2,109 MB | 996 s | 22.6 % |
| 10-minute windows cut at the quietest 100 ms of the last 30 s (now) | 1,231 MB | 2,185 s | 9.81 % |

Through the UI of the installed app (clean Sandbox, installer built at `c276e6e`, `packaged.mjs longstt`,
same file as a 64 kb/s MP3): 1,820 s, largest worker sample 898 MB (every 5 s), 1,140 transcript rows,
timestamps in order up to 70.6 min, WER 9.72 %.

#### High-DPI layout (clean Sandbox, v0.1.0 installers at `a202153` and `c276e6e`, `packaged.mjs dpi`)

Each of the six main pages was opened with the WebView emulating the CSS viewport and device scale
that Windows scaling produces (CDP `Emulation.setDeviceMetricsOverride`, not a real display-scaling
change): 1080p at 150 % (1280x680, x1.5), the 1024x720 minimum window at 125 %, 4K at 200 %
(1920x1040, x2) and a 1366x768 laptop at 125 % (1093x574, below the minimum height). 24/24 page views on each installer:
no horizontal page scroll, no control outside the window, no clipped text; only the sidebar tagline
wraps to two lines at the narrow sizes.

#### Reference-voice cloning (clean Sandbox, v0.1.0 installer at `a202153`, `packaged.mjs clone`; repeated at `c276e6e`: WER 7.3 %)

The reference clip is the app's own output with the female preset "Trúc Ly" (7.3 s), so no
third-party voice rights are involved; the engine default voice is male. Registering it in the voice
library works through the UI (the save button stays disabled until the consent box is ticked), and
five new sentences were generated with it and with the default voice:

| Check | Result |
|---|---|
| Jobs | all 5 carried the reference asset |
| Intelligibility (whisper-small) | WER 8.5 % over the 5 cloned sentences |
| Median F0 | reference 264.5 Hz, cloned 271.2 Hz (267-296), default voice 158.4 Hz |
| Clipping | 0 samples at or above 0.999; highest peak -0.73 dBFS |

Similarity to a real person's voice was not judged; that needs a consented recording and a listener.

### v0.1.0 draft release (built by `.github/workflows/release.yml` from tag `v0.1.0` at `c276e6e`)

The tag was moved before publication, first from `305ce75` to `05a2135` (take peak limiter, PR #5;
queue progress label, PR #6), then to `a202153` (visible progress bar, waiting-in-batch label, linear
STT progress, PR #9), then to `c276e6e` (STT in 10-minute windows, PR #11); each earlier draft was
deleted unpublished.

| Check | Result |
|---|---|
| Release workflow | npm test, private runtime build, SBOM/notices, `cargo test`, `tauri build`, checksums, draft pre-release: success |
| Assets | `ThanhAmStudio_0.1.0_x64-setup.exe` (204,411,158 bytes), `SHA256SUMS.txt`, `sbom.cdx.json`, `THIRD-PARTY-NOTICES.txt` |
| Installer SHA-256 | `5f6b2939c84f73b7b954e86e081b2b28e67b6d9dbd9337b16872d38dd2fca0d2`; `sha256sum -c SHA256SUMS.txt` OK for all files after download |
| Clean Windows Sandbox on that exact downloaded installer | install 102 s, 815 MB; phases `full` (model download via UI, TTS, preview, new take, render + WAV save to a Unicode path, STT + apply, SRT), `reopen`, `turbo` (Whisper Turbo download, MP3 render + save, ffprobe mp3 48 kHz 192 kb/s, Turbo STT on it, transcript matches the fixture apart from letter case), `offline` (network adapters disabled: TTS) and `export` (still offline: render, WAV, STT, SRT): 26 PASS, 0 FAIL |
| Extra phases on the same installer | `full`, `clone`, `dpi`, `longstt` (see above): 23 PASS, 0 FAIL |
The draft is not published. Publishing waits for the human listening pass below.

## Not verified / known gaps

- Listening quality has not been judged by a human; the clipping checks above are signal analysis.
  The listening pack (first 20 sentences as separate files in script order, plus the full render) is
  produced by the gate for an A/B pass. STT round-trip shows audible-risk words (e.g. "giọng" heard
  as "dọng"); these are flagged for listening, not treated as proof of mispronunciation.
- Two Sandbox runs failed a save step in a later phase (`turbo` MP3 or `export` WAV). Cause: the
  harness clicked the first "save audio" button while the queue list (refreshed every 2.5 s) still
  showed an earlier render, whose format the app correctly refused to save under the other
  extension. The harness now clicks the button of the exact render job; the next run passed all phases.
- TTS needs ~2.2 GB for its worker process on top of the app and WebView2 (measured on the dev
  machine and on the clean 8 GB Sandbox).
- High DPI was checked by viewport and scale emulation, not by changing Windows display scaling.
- Voice cloning was checked against a reference made from an app preset; similarity to a real voice
  needs a human listener.
- Installers are unsigned (SmartScreen warning). CUDA is not enabled.
- Preview does not apply loudness normalization; export does when "Chuẩn hóa" is on.
