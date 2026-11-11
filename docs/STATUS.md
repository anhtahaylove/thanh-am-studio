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
  the app through a Windows job object.
- STT: faster-whisper CPU INT8, explicit apply of results, transcript edit/add/delete rows, timestamp
  validation, TXT/SRT/VTT export.

## Verification (2026-11-11)

| Gate | Result |
|---|---|
| `npm test` | 24 passed |
| `npm run test:e2e` (browser preview) | 6 passed |
| `cargo test --tests` | 8 store + 3 runtime passed |
| `python -m unittest` (worker) | 9 passed (incl. real FFmpeg render, disk-full refusal) |
| GitHub Actions CI (PRs #1–#3 and `main`) | pass |
| Real model download (whisper-small) | kill at 34 % then resume completed; 464 MB on disk (1×); proxy-blocked network → `NETWORK` error |
| Packaged release exe on dev machine (`e2e/desktop/packaged.mjs full`, `reopen`) | all steps PASS |
| **Clean Windows Sandbox** (Windows 11 26100, no Python/FFmpeg/uv on PATH, 8 GB) | installer 94–100 s; download both models via UI; TTS; preview playback; new take keeps old; restart and reopen project; **network adapters disabled**: TTS, render + save WAV via native dialog to a Unicode path, STT on it + apply, SRT export — all PASS (local builds and the CI-built v0.1.0 installer, see below) |
| 500-segment gate | see below |

Clean-machine runs found and fixed two release blockers that the dev machine hid: the Python runtime
needed the MSVC C++ runtime (`onnxruntime` import failed), and the dev-machine-only WebView2 debug
flag. Measured on the dev CPU (i5-13400F, CPU only): model load ≈7 s per batch, ≈2.2 s per short
sentence, STT of 6 s audio ≈8 s including model load.

### 500-segment gate (packaged release exe on the dev machine, i5-13400F, CPU only)

`e2e/desktop/gate.mjs`, synthetic original Vietnamese script, 500 segments of ~25 syllables:

| Check | Result |
|---|---|
| Generation via UI "Tạo giọng tất cả" | 500/500 segments with a selected take, 0 failed jobs |
| Cancel 3 queued jobs, then hard-kill the app mid-batch (`taskkill /F /T`) | 0 orphan Python workers; on restart 40 done, 24 `interrupted`, 401 queued, 3 cancelled, no data lost; retries completed |
| Audio length | 43.9 min synthesized (segments average 5.3 s, so this run is **below the 60-minute target**); render with gaps 46.4 min |
| TTS throughput | 45.4 min wall for 43.9 min of audio (RTF 1.03 including the crash/restart) |
| Full render + normalize | 93 s; duration exactly equals takes + gaps |
| STT round trip (whisper-small, CPU INT8) on the full render | 30.7 min (RTF 0.66); WER 10.2 %, CER 5.1 % against the script |
| Peak RAM | Python worker 996 MB; app process 42 MB (WebView2 processes not counted) |
| Reopen the 500-segment project after restart | 0.68 s |

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

- Listening quality has not been judged by a human; one listening-pack sentence peaks at full scale (possible clipping). The listening pack (first 20 sentences as
  separate files in script order, plus the full render) is produced by the gate for an A/B pass.
  STT round-trip shows audible-risk words (e.g. "giọng" heard as "dọng"); these are flagged for
  listening, not treated as proof of mispronunciation.
- Whisper Large v3 Turbo download/inference, reference-voice cloning quality, MP3 export and UI at
  high DPI were not exercised end-to-end.
- Installers are unsigned (SmartScreen warning). CUDA is not enabled.
- Preview does not apply loudness normalization; export does when "Chuẩn hóa" is on.
