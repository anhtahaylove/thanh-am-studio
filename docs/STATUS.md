# Thanh Âm Studio status

Last updated 2026-11-12. Evidence below was observed, not inferred; anything not listed is unverified.

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
- Added for v0.1.1: drag and drop of scripts and audio onto the window; transcript find and replace
  (one undo step) and a row highlight that follows playback; system dark theme by default; pause
  marks inside a segment (the Vietnamese word for pause plus a duration, 0.05-10 s, inserted at the cursor
  by a button); a per-segment reading speed (0.85-1.2x, FFmpeg `atempo`, pitch kept, pauses keep
  their length); an optional Whisper Small self-check of each new take that flags likely misreadings
  (differences that are only a merged initial or final, e.g. ch/tr, s/x, -n/-ng, are not flagged);
  playback progress and the trimmed range on the take waveform; optional speaker diarization for STT
  (pyannote segmentation-3.0 + 3D-Speaker CAM++ through sherpa-onnx, pinned like the other models)
  with a one-click conversion of a speaker-labelled transcript into a multi-voice script; preset
  voices sample at temperature 0.5 (below).
- Added for v0.1.2: an optional known speaker count (2-5 in the UI, validated as a whole number 1-8 in
  Rust and in the worker) passed to the diarization clustering, and a per-row speaker menu to relabel
  transcript rows by hand (saved, undoable, used by the script conversion).

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

### v0.1.0 release (built by `.github/workflows/release.yml` from tag `v0.1.0` at `c276e6e`)

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

Published as a pre-release on 2026-11-12 at the owner's decision, assets unchanged; the installer
downloaded anonymously after publication still passes `sha256sum -c`.

### v0.1.1 candidate (dev machine, local release build of `release/v0.1.1`)

| Check | Result |
|---|---|
| `npm test` / `npm run test:e2e` | 32 passed / 8 passed |
| `cargo test --tests` | 8 store + 6 runtime passed |
| `python -m unittest` (worker) | 28 passed, 2 skipped (FFmpeg on PATH) |
| Packaged exe, empty app data, phases `full`, `features`, `ux` | 21 PASS, 0 FAIL: models downloaded via UI; pause mark + 1.1x speed + self-check on a new take (badge shown, Whisper heard the take); 39/100 waveform bars marked played after 1.5 s; diarization model downloaded via UI; 60 s two-speaker dialogue transcribed into 21 rows labelled with 2 speakers, 21 speaker chips, turned into script segments; script and audio drag and drop; follow-along moved from row 1 to row 21 |

The `features` phase found a release blocker the unit tests missed: `worker/diarize.py` was not in
the installer's resources, so diarization failed in the packaged app (the transcript was still
applied, with the error shown). It is now bundled, and a worker test fails if any worker module is
left out of the resources.

### v0.1.1 release (built by `.github/workflows/release.yml` from tag `v0.1.1` at `9ce785f`)

| Check | Result |
|---|---|
| Release workflow | success; draft pre-release with installer, `SHA256SUMS.txt`, SBOM, notices |
| Installer SHA-256 | `540d66916fde19adc0fe0a9a0a6ef0b30ee3a0332ee28911c79678c14b861679`; `sha256sum -c` OK after download, and again after an anonymous download once published |
| Clean Sandbox run 1 on that exact installer | install 98 s, 864 MB; `full`, `reopen`, `turbo`, `offline` (network adapters disabled), `export`: 26 PASS, 0 FAIL |
| Clean Sandbox run 2 on that exact installer | install 99 s; `full`, `features`, `ux`, `clone` (clone WER 6.1 %), `dpi` (4/4 sizes clean): 30 PASS, 0 FAIL |

The first build of the tag (at `41b642d`) passed run 1 but failed `dpi` at 1024x720 @1.25,
1093x574 @1.25 and 1280x680 @1.5: a long self-check badge squeezed the role-name input to 45 px
("Người dẫn" needs 52 px). Fixed in PR #24 (input minimum 72 px, take count kept on one line); the
unpublished draft was deleted and the tag moved to `9ce785f` before both runs above. Published as a
pre-release on 2026-11-12.

Upgrade from 0.1.0 (clean Sandbox, both published installers, checksums verified): v0.1.0
installed, `full` phase run (2 models, a project with takes, 225 app-data files, 1,090 MB); v0.1.1
installed over it into the same folder (exe version 0.1.1); all 225 files still present; `reopen`
(the 0.1.0 project with its takes) and `features` (on that project, with the models downloaded by
0.1.0) passed: 16 PASS, 0 FAIL.

Diarization on real read speech (VIVOS test split, 19 speakers, CC BY-NC-SA 4.0, evaluation only and
kept outside the repo): 24 dialogues of 61-101 s (12 two-speaker, 12 three-speaker; 4 of each
same-gender), each also with 20 dB white or babble noise, 1-3 utterances per turn, gaps 0.2-0.8 s.
Frame DER (10 ms, no collar; the reference pads trimmed utterances, so about 10 % of DER is a floor of
the method) / files with the right speaker count / transcript rows with the right speaker:

| Threshold | 2 speakers clean | 2 speakers noisy | 3 speakers clean | 3 speakers noisy |
|---|---|---|---|---|
| 0.6 | 18.1 % / 58 % / 89.3 % | 24.6 % / 33 % / 83.1 % | 24.8 % / 58 % / 83.8 % | 29.7 % / 42 % / 81.3 % |
| **0.65 (shipped)** | 17.5 % / 67 % / 90.2 % | 24.0 % / 50 % / 84.5 % | 27.1 % / 58 % / 81.6 % | 27.9 % / 67 % / 82.9 % |
| 0.7 | 16.2 % / 75 % / 92.6 % | 22.2 % / 67 % / 86.5 % | 29.4 % / 50 % / 79.0 % | 30.1 % / 67 % / 81.2 % |
| 0.8 | 15.8 % / 92 % / 93.2 % | 19.2 % / 75 % / 89.8 % | 31.1 % / 50 % / 77.6 % | 33.4 % / 42 % / 77.3 % |

0.65 stays: pooled DER is flat from 0.6 to 0.8 (24.1-24.9 %), higher values merge three speakers
and same-gender pairs, lower values over-split (0.5: 37 of 48 files). Real speech is much harder
than the synthetic TTS mixes (DER 0-10.5 %): at 0.65, 16 of 48 files had an extra speaker and 3 a
missing one. Giving the true speaker count helps two speakers (DER 15.8 % clean) but not three
(32.5 %, mostly confusion), so the three-speaker limit is the embedding/segmentation, not the
threshold. Two male voices are the hardest case. Runtime about 0.1x real time on the dev CPU.
Evidence: `work\diarization-vivos`.

Temperature for preset voices (20 sentences x 3 takes per setting, same text and voice, word error rate):

| Setting | Whisper large-v3 | Whisper large-v3 turbo | wav2vec2 CTC | Mean take | F0 spread |
|---|---|---|---|---|---|
| 0.8 (engine default) | 1.01 % | 1.41 % | 4.40 % | 8.20 s | 3.70 semitones |
| 0.5 (v0.1.1) | 0.75 % | 1.01 % | 3.92 % | 8.20 s | 3.74 semitones |

The self-check uses Whisper Small, which itself mishears some words: in these runs it flagged the
brand name ("Âm" heard as "Ngâm") on some takes, and the STT round trip of the same project heard it
both ways. Flags are hints to listen, not proof of a misreading.

### v0.1.2 release (built by `.github/workflows/release.yml` from tag `v0.1.2` at `a76bae2`)

| Check | Result |
|---|---|
| Tests | `npm test` 33, `npm run test:e2e` 8, `cargo test --tests` 8 + 7, worker 29 (2 skipped); CI green on PR #27 head `2ebdde2` |
| Packaged exe on the dev machine (empty app data) | `full`, `features`, `dpi`: all PASS |
| Installer SHA-256 | `472944f9b779f1edfe137b53f1bfdda0c0e8be47774782d84c6c05c7084425e8`; `sha256sum -c` OK after download and after an anonymous download once published |
| Clean Sandbox run 1 on that exact installer | `full`, `reopen`, `turbo`, `offline` (network adapters disabled), `export`: 26 PASS, 0 FAIL |
| Clean Sandbox run 2 on that exact installer | `full`, `features` (2 speakers asked and found in a 60 s dialogue, a row relabelled and found saved through `load_project`, script built), `ux`, `clone` (WER 8.5 %), `dpi` (4/4 sizes clean): 30 PASS, 0 FAIL |

Published as a pre-release on 2026-11-12 (17:25 UTC). The known-count benefit comes from the VIVOS
measurement above (with the count given, two-speaker DER 15.8 % clean and no over-splitting by
construction); three speakers stay hard (32.5 % with the count given).

### v0.1.3 candidate: natural conversation and the known speaker count (2026-11-13)

Diarization on natural conversation: ViYT-Diar test split
([dataset](https://huggingface.co/datasets/tuanduy1612/ViYT-Diar); its card says Apache-2.0, the
audio comes from public YouTube vlogs, podcasts and interviews, so it is used for local evaluation
only and kept outside the repo). 100 hand-labelled clips of 53-86 s (1.74 h); 97 have two speakers,
3 have one speaker but labels for only 4-20 s of 62 s, so they are left out. Only 0.7 % of speech
overlaps, so overlapped speech is still barely tested. Frame DER (10 ms), pooled over the 97 clips
(sum of errors / sum of reference speech), overlap scored, without collar / with the standard 0.25 s
collar; median per clip in brackets:

| Setting | Right speaker count | DER, no collar | DER, 0.25 s collar |
|---|---|---|---|
| auto, 0.5 | 44 % | 21.3 % | 9.8 % (4.0) |
| auto, 0.6 | 45 % | 19.7 % | 8.5 % (3.9) |
| **auto, 0.65 (shipped)** | 48 % | 19.1 % | 8.0 % (3.0) |
| auto, 0.7 | 47 % | 19.3 % | 8.4 % (3.5) |
| auto, 0.8 | 52 % | 19.8 % | 8.8 % (2.9) |
| count given, v0.1.2 | 82 % | 22.3 % | 11.5 % (3.6) |
| count given, fixed | 99 % | 18.9 % | 8.0 % (2.1) |

0.65 stays the best automatic setting; automatic counting mostly adds a speaker (43 of 97 clips
got three or more). Most no-collar error is false alarm (11.4 %) where hand labels split pauses
finer than the 0.5 s gap the app merges. Runtime 0.1-0.4x real time depending on machine load.

Bug found and fixed: with the count given, v0.1.2 returned **one** speaker for 17 of the 97 clips
(deterministic). Complete-linkage clustering cut at k clusters gave one cluster to an outlier
embedding that ended with no speech of its own (checked on clip 022: with 2 clusters the second
cluster has 0 s even with the duration filters off). `diarize()` now asks for up to two more
clusters until k speakers appear and keeps the k with the most speech. One clip still gives one
speaker; two clips dominated by one voice got worse (DER 6.5 to 28.1 % and 32.4 to 45.6 %), 15 got
better. On the VIVOS mixes above, with the count given, mean DER changed from 15.8 to 14.8 % (2
speakers clean), 16.6 to 17.2 % (2 noisy), 32.5 to 25.1 % (3 clean) and 34.2 to 28.3 % (3 noisy):
the same bug was hurting three speakers. A retry runs the model again, so those files take up to
three times longer. Evidence: `work\diarization-natural` (`results\report2_fix.txt`,
`results\oracle_fix.json`) and `work\diarization-vivos\results\oracle_fix.json`.

### v0.1.3 release (built by `.github/workflows/release.yml` from tag `v0.1.3` at `2eab5f3`)

| Check | Result |
|---|---|
| Tests | `npm test` 33, `cargo test --tests` 8 + 7, worker 33 (2 skipped; 15/15 in `test_diarize.py` with the real model); CI green on PR #30 head `ef0a4eb` |
| Installer SHA-256 | `9961a4787ee78c14875d87053c1dfe4646be9e24102f0aa138d7f1b9ee7911cb`; `sha256sum -c` OK after download and after an anonymous download once published |
| Clean Sandbox run 1 on that exact installer | `full`, `reopen`, `turbo`, `offline` (network adapters disabled; huggingface.co unreachable), `export`: 26 PASS, 0 FAIL |
| Clean Sandbox run 2 on that exact installer | `full`, `features` (2 speakers asked and found in a 60 s dialogue, a row relabelled and found saved through `load_project`, script built), `ux`, `clone` (WER 4.9 %), `dpi` (4/4 sizes clean): 30 PASS, 0 FAIL |

Published as a pre-release on 2026-11-12 (20:36 UTC). The v0.1.2 release notes now point to 0.1.3
for the speaker count fix. Evidence: `work\release-v0.1.3-sandbox`.

### Long meetings and outlier clusters (2026-11-13)

Diarization on natural meetings with three or four speakers and real overlap: the AMI Meeting
Corpus test set (CC-BY 4.0; English; the 16 meetings of the pyannote "AMI-diarization-setup" split,
`only_words` labels, Mix-Headset audio, 9.06 h, 14-50 min each; 15 meetings with 4 speakers, 1 with
3). 27.0 % of reference speech is overlapped. Same scoring as above (10 ms frames, overlap scored,
pooled over meetings).

Bug found: on these long recordings the 0.65 threshold alone gave **41-138 speakers** per meeting
(default "auto" setting), and with the count given 13 of 16 meetings spent a speaker on a cluster
holding 0.3-6.4 % of the speech while two real people shared one label (ES2004a: one label held
69 % of the speech, its busiest real speaker 42 %).
Both come from complete-linkage clustering keeping outlier embeddings apart. Fix: a speaker now
needs at least 3 % of the speech (`MIN_SPEAKER_SHARE`). In auto mode, when smaller clusters exist,
the audio is clustered again into the speakers that are left; with the count given, the retry for
more clusters now also runs when fewer than k speakers reach 3 %.

| Set | Setting | 0.1.3 | Fixed |
|---|---|---|---|
| AMI, 16 meetings | auto: DER no collar / 0.25 s collar | 49.3 % / 41.1 %, 41-138 speakers | 22.2 % / 14.8 %, 4-9 speakers (right in 2) |
| AMI | count given | 28.6 % / 22.8 % | 23.6 % / 17.2 % |
| ViYT-Diar, 97 two-speaker clips | auto | 19.1 % / 8.0 %, right count 47 | 18.4 % / 7.6 %, right count 59 |
| ViYT-Diar | count given | 18.9 % / 8.0 % | 18.2 % / 7.3 % |
| VIVOS mixes, mean DER no collar (0.25 s collar) | count given, 2 clean / 2 noisy / 3 clean / 3 noisy | 14.8 / 17.2 / 25.1 / 28.3 % (7.5 / 9.3 / 17.4 / 20.0 %) | 14.8 / 17.2 / 25.1 / 26.9 % (7.5 / 9.3 / 17.4 / 18.7 %) |

A 3 % minimum was the only value tried (3, 5, 8, 10 %) that improved every set: 5-10 % did slightly
better on AMI with the count given (22.7-21.9 % no collar) but worse on ViYT (19.4 %), and 8-10 % in
auto mode under-counted (1-3 speakers for some meetings). Auto mode still over-counts long meetings
(4-9 found for 3-4 real speakers), so giving the count stays the better choice. Cost: each extra
clustering runs the model again; on the AMI meetings auto mode ran it 4 times per meeting on
average (3x the time) and the count-given mode 1.9 times (1.65x the time). Real-time factor per run 0.17-0.23 under
parallel load on the i5-13400F; peak 1.15 GB per process with the count given, 3.2 GB in auto mode
before the fix. Evidence: `work\diarization-ami` (`results\report.txt`, `results\variants_report.txt`)
and `work\diarization-share` (ViYT-Diar and VIVOS with the same cache of runs).

### v0.1.4 release (built by `.github/workflows/release.yml` from tag `v0.1.4` at `b2511ad`)

| Check | Result |
|---|---|
| Tests | worker 36 (2 skipped; 18/18 in `test_diarize.py` with the real model); CI green on PR #32 head `e30f908` and PR #33 head `64ad50f` |
| Installer SHA-256 | `b757f42e90ef1f357dbcf3e650f8764157048a60503a726a1045d8998f8830b1`; `sha256sum -c` OK after download and after an anonymous download once published |
| Clean Sandbox run 1 on that exact installer | `full`, `reopen`, `turbo`, `offline` (network adapters disabled), `export`: 26 PASS, 0 FAIL |
| Clean Sandbox run 2 on that exact installer | `full`, `features` (2 speakers asked and found in a 60 s dialogue, a row relabelled and found saved, script built), `ux`, `clone` (WER 3.7 %), `dpi` (4/4 sizes clean): 30 PASS, 0 FAIL |

The first start of run 2 wrote no log: the Sandbox from run 1 was still shutting down. It was
started again after all Sandbox processes had exited. Published as a pre-release on 2026-11-13; the
v0.1.3 release notes now point to 0.1.4. Evidence: `work\release-v0.1.4-sandbox`.

A later check of the v0.1.4 notes against this page and the raw evidence found no wrong numbers
but five wording or basis slips, corrected in the published notes on 2026-11-13: meetings are 14-50
min (not 15-50); 0.1.3's retry never ran on AMI (the outlier took a slot without triggering it);
picking the count took 1.65x the time (1.9x is the number of model runs); two of the three new
tests fail on 0.1.3's code; the three-speaker VIVOS figure is 17-19 % with the 0.25 s collar used
everywhere else in the notes (25-27 % without).

### v1.0.0 release (built by `.github/workflows/release.yml` from tag `v1.0.0` at `65fccce`)

The first stable release: the same code as v0.1.4 with the version set to 1.0.0. Human listening
was replaced by the machine listening below at the owner's decision (see known gaps).

| Check | Result |
|---|---|
| Tests | CI green on PR #35 head `68014fa` |
| Installer SHA-256 | `58e963c6f0cc13811debfa78fb3f7e2cdae1ff928add54f5edc706e6b1f6648f`; `sha256sum -c` OK after download and after an anonymous download through `/releases/latest/download/` once published |
| Clean Sandbox run 1 on that exact installer | `full`, `reopen`, `turbo`, `offline` (network adapters disabled), `export`: 26 PASS, 0 FAIL |
| Clean Sandbox run 2 on that exact installer | `full`, `features` (2 speakers asked and found in a 60 s dialogue, a row relabelled and found saved, script built), `ux`, `clone` (WER 6.1 %), `dpi` (4/4 sizes clean): 30 PASS, 0 FAIL |

As with v0.1.4, the first start of run 2 wrote no log within 2 minutes and was started again.
Published on 2026-11-13 as the latest release, not a pre-release, unsigned. Evidence:
`work\release-v1.0.0-sandbox`.

## Not verified / known gaps

- Listening quality has not been judged by a human; the clipping checks above are signal analysis.
  On 2026-11-13 the owner accepted the machine listening below in place of a human listening pass.
  The listening pack (first 20 sentences as separate files in script order, plus the full render) is
  produced by the gate for an A/B pass. STT round-trip shows audible-risk words (e.g. "giọng" heard
  as "dọng"); these are flagged for listening, not treated as proof of mispronunciation.
- Machine listening (2026-11-12) with three local judges that do not share a decoder: Whisper large-v3,
  Whisper large-v3 turbo and a wav2vec2 CTC model without a language model. On the 20-file pack, all
  three hear "chợ Bến Thành" as "chợ biến thành" in sentence 10. Regenerating sentences 09, 10 and 15
  five times each through the worker: "tiết kiệm" was right in 9/10, 9/10 and 10/10 takes (the pack
  miss was one unlucky take), but "chợ Bến Thành" was right in only 2/5 takes for every judge.
  Dictionary respellings did not fix it reliably ("Bến-Thành" 1-3/5; lowercase "bến thành" 3-4/5 but
  sometimes heard as "đến"). The engine varies per take, so regenerating the take is the workaround.
  Repeated for v0.1.2 behaviour (2026-11-13; preset voice at temperature 0.5; a fresh 20-sentence
  pack plus 3 new takes of each of 17 doubtful sentences): word error rate on the pack 0.66 % / 0.79 % /
  3.43 % (large-v3 / turbo / wav2vec2) against 2.51 % / 0.92 % / 5.15 % for the v0.1.0 pack (11 of the 19
  large-v3 errors there are a hallucinated sign-off). "chợ" and "tiết kiệm" no longer miss; still
  misheard by both Whisper judges in 2-5 of 7 takes: "chiếu" as "chiều" (three sentences), "Bến" as
  "biến", "kỹ" as "ký". wav2vec2 alone keeps hearing ch/tr and s/x swaps, which sound alike in
  northern speech. Evidence and a listening order: `work\listening-v0.1.2\REPORT.md`.
  Naturalness and prosody are not covered by these judges. A local UTMOS22 naturalness estimate was
  tried and is not usable for Vietnamese here: 20 human read-speech clips (InfoRe corpus) scored 1.70
  on average against 3.02 for the 20 pack takes and 2.93 for the 45 regenerated takes; the human
  clips have a higher noise floor (-56 vs -69 dB), which the English-trained predictor penalizes.
- Two Sandbox runs failed a save step in a later phase (`turbo` MP3 or `export` WAV). Cause: the
  harness clicked the first "save audio" button while the queue list (refreshed every 2.5 s) still
  showed an earlier render, whose format the app correctly refused to save under the other
  extension. The harness now clicks the button of the exact render job; the next run passed all phases.
- TTS needs ~2.2 GB for its worker process on top of the app and WebView2 (measured on the dev
  machine and on the clean 8 GB Sandbox).
- High DPI was checked by viewport and scale emulation, not by changing Windows display scaling.
- Voice cloning was checked against a reference made from an app preset; similarity to a real voice
  needs a human listener.
- Diarization was measured on natural Vietnamese two-speaker conversation (ViYT-Diar) and on English
  meetings with 3-4 speakers and 27 % overlap (AMI), not on Vietnamese conversation with three or more
  speakers. Overlapping speech gets one speaker per row (about 9-10 % of AMI speech is missed).
- The 0.5 temperature was measured on a preset voice only; cloned voices keep the engine's default.
  Reading speed was checked for length and pitch on a test tone and end to end on one take, not by listening.
- Installers are unsigned (SmartScreen warning); the SignPath Foundation application is prepared in
  [SIGNING.md](SIGNING.md) and waits on the owner. CUDA is not enabled.
- Preview does not apply loudness normalization; export does when "Chuẩn hóa" is on.
