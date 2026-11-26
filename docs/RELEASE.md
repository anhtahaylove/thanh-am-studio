# Release process

The installer ships the app, the worker, a private CPython 3.11.18 runtime with the locked CPU
inference closure (`worker/requirements-base.lock`; no PyTorch or Demucs) and a
pinned LGPL FFmpeg build. Models are not shipped; users download them in **Model & cài đặt** (pinned
revisions and digests in `worker/models.json`). Background separation runs on a separate **runtime pack**
(Python + PyTorch 2.15.0+cpu + Demucs 4.1.0, `worker/requirements-separation.lock`) that the app downloads on
demand from this repository's `pack-separation-v<N>` prerelease (see "Separation runtime pack" below).

## Reproducible build (Windows x64)

Requirements: Node 22+, Rust stable (MSVC; Visual Studio Build Tools also provide the redistributable CRT the runtime ships app-locally), uv, git. No administrator rights.

```powershell
npm ci
./scripts/setup-runtime.ps1          # runtime/python + runtime/ffmpeg (FFmpeg SHA-256 pinned); -Profile base is the default
python scripts/third_party.py release # release/sbom.cdx.json + release/THIRD-PARTY-NOTICES.txt (bundled into the installer; needs crates.io access)
npm run tauri build -- --ci
```

makensis cannot open paths longer than 260 characters. If the checkout path is long, build
from a short drive: `subst T: <repo>; cd T:\; npm run tauri build -- --ci; subst T: /d`.
Do not run `src-tauri/target/release/thanh-am-studio.exe` while bundling (the bundler patches it).

After its worker health check the base profile compiles every `.py` (timestamp mode) and writes
`runtime/python/pyc-sha256.txt`, the SHA-256 of every shipped `.pyc`: NSIS restores each file's build-time write
time on install and on update, so the shipped headers stay valid, and the Sandbox `full` phase checks after its
jobs that none changed (new `.pyc` files are information only).

`.github/workflows/release.yml` does the same on a `v*` tag, attaches the installer,
`SHA256SUMS.txt`, the SBOM and notices to a **draft pre-release**. Publishing the draft is a
manual decision after the acceptance gates below pass on that exact tag. Users verify a download
with `sha256sum -c SHA256SUMS.txt` (or compare `Get-FileHash <file>` with the listed hash).
Before tagging, run the workflow once as a dry run on the release commit (`gh workflow run release.yml --ref main`):
it builds and checks everything and uploads the files as a workflow artifact instead of creating a release, so a
workflow error cannot burn a version tag (tags are never moved; `v1.0.17` was burned by such an error).

## Separation runtime pack

Background separation needs PyTorch and Demucs (about 450 MB installed), so they are not in the installer: the
app downloads a pack, `separation-runtime` in **Model & cài đặt**, once. Its pin (url, size, SHA-256, manifest
SHA-256) is in `worker/models.json`; `release.yml` stops when the pin is still the placeholder or the asset's size
differs.

- **Build and check**: `.github/workflows/pack.yml`. A pull request that touches the pack's inputs, or a manual run,
  builds and checks the pack and uploads a workflow artifact only. `scripts/setup-runtime.ps1 -Profile separation`
  builds the runtime (the OpenMP shim and its import check, the app-local CRT); `scripts/build_pack.py` compiles
  every `.py` to unchecked-hash bytecode (PEP 552) and asserts the header flag on every `.pyc`, moves every
  `*.dist-info/licenses` tree verbatim into the pack's `THIRD-PARTY-NOTICES.txt` (a byte check fails the build) and
  lists there the Rust crates in the wheels, with their licence texts from crates.io (`scripts/wheel_crates.py`), checks
  the path budget (9 + 40 + 64 + the longest path, 134 today, must be at most 259; the next torch bump may need the
  shorter model id `sep`), runs the pack's own health check, writes `MANIFEST.sha256` (`<sha256>  <size>  <path>`) and
  a reproducible zip plus `separation-runtime-v<N>.pin.json`. The workflow then runs a separation on the pack with
  `-B` and compares the tree with the manifest.
- **Publish** (the owner's decision, one pack per torch or Demucs change): push the tag
  `pack-separation-v<N>`. The workflow creates a **prerelease** (never latest: the updater reads `releases/latest`)
  with the zip, the pin file, the manifest and the notices, and fails if `releases/latest/download/latest.json`
  changed. Then `python scripts/pin_pack.py <pin file>` writes the pin into `worker/models.json` (the entry's
  `revision` must already be `separation-v<N>`), reviewed in a normal PR. Releases no longer include a VirusTotal
  upload (owner decision 2026-11-23).
- **Install**: the worker downloads the zip (resumable), checks size and SHA-256, the manifest against its pin and
  the folder plus the longest path against 259 characters (`PACK_PATH_TOO_LONG`), extracts straight into
  `models/separation-runtime/` hashing every file, and writes `installed.json` (with `license_accepted_at`: the
  dialog shows the oneMKL licence) last. A separation job runs on the pack's python with `-B -I -X utf8`; at job
  start the app checks that every manifest file exists with its size. **Kiểm tra lại gói** re-hashes the tree and
  reports files that are not in the manifest (`MODEL_CHECKSUM`). A new revision replaces the old tree.
- **Installer**: its hook deletes `torch`, `demucs`, `julius`, `einops`, `safetensors` and their `*.dist-info` from an
  older installation when it updates over it.

## Guarded paths and approvals

The required `guard` check (`.github/guard.sh`, run by `.github/workflows/ci.yml` on the `pull_request` merge ref) fails a pull request that changes a guarded path unless the coordinator has recorded that exact content after review. It is a tripwire against unreviewed audio-path edits, not a security boundary: every agent pushes as the same admin identity. The workflow runs the base branch's `guard.sh` (the merge ref's copy only for the very first PR that introduced it), so a pull request cannot weaken the script that judges it. A pull request that edits `ci.yml` itself can still change the step, which is why the coordinator reads every `.github` diff.

- **Guarded**: `worker/**`, `worker-rs/**`, `src-tauri/src/{engine,store,pack,docx,update,lib}.rs` and `.github/**`. The payload fixture `e2e/fixtures/payloads-1.0.21.json` (and any case variant of its path) may not be touched at all; no approval unlocks it. Under `.github/guard-approvals/` only the pull request's own `<PR>.txt` may change. A guarded path that is a symlink or a submodule, or a changed path containing a newline, always fails.
- **Approval file** `.github/guard-approvals/<PR>.txt` (the coordinator writes it, never an executor): first line `reviewed <sha>` with the full 40-hex SHA of the head that was reviewed, then one line per changed guarded path, `<path> <blob>` (`git rev-parse HEAD:<path>`) or `<path> deleted`.
- **Commit rule**: the approval is the last commit of the pull request, has exactly one parent, and changes only that file (added or modified). `reviewed` must equal that parent, so every re-approval rewrites the first line. Any later commit, merge commit or "Update branch" fails the guard again; rebase instead and approve again. Blobs are read from the merge ref, so approve right after rebasing onto the current `origin/main`.
- **Writing an approval** (in the rebased, reviewed worktree; it stops if `origin/main` is not an ancestor of the head):

```bash
PR=<N>; f=.github/guard-approvals/$PR.txt
git fetch origin && git merge-base --is-ancestor origin/main HEAD || { echo "rebase onto origin/main first"; exit 1; }
mkdir -p .github/guard-approvals
{ echo "reviewed $(git rev-parse HEAD)"
  git -c core.quotepath=false diff -z --name-only --no-renames origin/main...HEAD |
    grep -zEi '^((worker|worker-rs|\.github)(/|$)|src-tauri/src/(engine|store|pack|docx|update|lib)\.rs$)' | grep -zEv '^\.github/guard-approvals/' |
    while IFS= read -r -d '' p; do echo "$p $(git rev-parse --verify -q "HEAD:$p" || echo deleted)"; done; } > "$f"
git add "$f" && git commit -m "Approve the reviewed guarded blobs of #$PR."
```

- **Before merging EVERY pull request** (guarded or not, even when the guard log says "No guarded paths changed"): `git diff --name-only origin/main...<head> -- .github` is empty or only that PR's own approval file, and any other change is read in full.
- **Merging a guarded pull request**, one at a time: rebase onto `origin/main` (no merge commits), review the delta, approval commit, CI green on that exact head, `git merge-base --is-ancestor origin/main <head>`, the `.github` check above, then `gh pr merge <N> --merge --match-head-commit <head>`. If `main` moves, start again. Other merges wait during a guarded pull request's final CI (about 15 minutes).
- **Merging a non-guarded pull request**: CI green on the exact head, `git merge-tree --write-tree` clean against the current `main`, the `.github` check above, `gh pr merge <N> --merge --match-head-commit <head>`, then watch the post-merge CI on `main`.
- **Audit** (the coordinator, at fixed times and before a release tag): `git log --first-parent --format='%h %s' <base>..origin/main` shows only `Merge pull request #...` commits, each had a green `guard` on its exact head, and `git diff --name-only <merge>^1 <merge> -- .github` of each merge was read (this catches an admin push or an `--admin` merge).

## Acceptance gates (on the installer built from the tagged revision)

1. Unit/integration: `npm test`, `npm run test:e2e`, `cargo test --manifest-path src-tauri/Cargo.toml --tests`,
   `python -m unittest discover -s worker/tests`. A release that changes the `vieneu` pin, `clone_window` or the
   denoiser also runs `test_clone_preview_matches_what_synthesis_enrolls` locally (CI has no model) with
   `THANHAM_VIENEU_MODELS` set to an installed `vieneu-v3` folder, then updates `VIENEU_VERIFIED`.
2. Packaged desktop flow on a clean Windows Sandbox (no Python/FFmpeg on PATH): copy the installer
   to a folder, adjust and open a `.wsb` that maps the repo, `C:\Program Files\nodejs`, the installer folder and
   a writable output folder, with `e2e/desktop/sandbox-run.ps1` as the logon command. It installs
   silently, then runs `e2e/desktop/packaged.mjs` phases `full` (model download via UI, TTS,
   preview, new take, render + save dialog, STT + apply, SRT export, then the same export steps as `export`: M4A/FLAC/Opus renders checked with ffprobe and STT of the M4A), `reopen`, `turbo` (Whisper
   Turbo download, MP3 export, Turbo STT), `offline` (network adapters disabled) and `export`
   (render, save dialog to a Unicode path, STT, SRT, M4A/FLAC/Opus export checked with ffprobe, STT of the M4A, still offline). `-Only full,clone,dpi` runs chosen
   phases instead (`clone`: cleaned-sample preview of a reference padded with 6 s of tone bursts, reference voice with consent and cloned takes; `dpi`: layout at high-DPI
   viewports, then at 1024x720 CSS px (x1.25) the editor in focus mode and the six pages in the high-contrast theme, both put back afterwards; `longstt`: STT of `long.mp3` next to the installer, scored against `long.txt`; `ux`: drag and drop of a script and of `THANHAM_UX_AUDIO` (in the Sandbox: `dialogue.wav` next to the installer), then transcript follow-along during playback; `features`: pause mark, per-segment speed and Whisper self-check on a new take, waveform playback progress, diarization model download, speaker-labelled STT with a known speaker count, a row relabelled by hand and saved, turned into a script, then, in this order, V1 (a project saved as S1 then S2 is opened in the UI, "Lịch sử phiên bản" restores S1 from its "Khôi phục" row), V3 (an STT of `dialogue-x2.wav`, next to `dialogue.wav`, that runs at least 40 s and ends while the window is minimised: Playwright's focus emulation would keep `document.hasFocus()` true, so the CDP client is detached while the window is minimised and the job runs, the app's toast history is polled for a new toast, then the window is restored with `nvda.ps1 -Focus`, the client reconnects and reads the page's fetch watch for `request_user_attention` and `notify`; the latency is logged) and V2 (a second launch during a second STT exits with code 0 within 15 s, the first instance still answers, one `thanh-am-studio.exe` remains and the job succeeds); `nvda`: the NVDA screen-reader check, after the other phases and only
   inside the Sandbox: `nvda.ps1` downloads the pinned NVDA from NV Access, checks its SHA-256 and signer and runs a portable
   copy with the silent synth, browse mode off on page load and an IO log that `nvdalog.mjs` reads (`node nvdalog.mjs --self-test`
   checks the parser). It seeds a project "NVDA kiểm tra" and checks what NVDA says for the skip link, the segment toolbar, a
   blocked Ctrl+Enter, the details panel and Esc, the native drop-down closed with Esc, "Đã tạo xong", transcript
   follow-along, Ctrl+P (no print UI, the quick-open dialog), S9 (Ctrl+Shift+F as OS input announces "Đã bật chế độ tập trung"; focus mode is put back off) and S10 (the "Lịch sử phiên bản" dialog is announced and Esc returns focus to its button). Page keys go over CDP, Ctrl+P and the drop-down keys
   are OS input. Each step logs PASS/FAIL without stopping the phase and writes `nvda-speech.jsonl`. With
   `THANHAM_NVDA_BASELINE=1` it runs against 1.0.22, a release without these fixes, and ABORTs on any other version (never
   set it in a gate run): an expected failure logs `NOTE expected-fail-1.0.22`, an unexpected pass logs FAIL, and S7b
   checks that a page-level `preventDefault` leaves the print detector silent. `nvda.ps1 -Install`/`-Start` and
   `textscale.mjs` refuse to run outside Windows Sandbox), `hc` (the last phase, Sandbox only: it saves the current Windows theme, applies
   `hcblack.theme` from `C:\Windows\Resources\Ease of Access Themes` (else the first theme there), waits up to 60 s for
   `(forced-colors: active)`, checks that a waveform bar is drawn in `CanvasText` and that Tab shows an outline, then puts the saved
   theme back, waits for `(forced-colors: none)`, closes Settings and refocuses the app; with no usable contrast theme it logs
   `NOTE hc-theme-unavailable`, the only NOTE a gate run may carry), and
   `-Gate 500` runs the long-project gate inside the Sandbox.
   `update` serves the release's own `latest.json` and installer (both next to the installer) from a local
   feed: a cut-off package must be refused, the signed one must install itself and reopen the app with its
   projects, and the installer copy the updater leaves in `%TEMP%` must be gone after the next start (and
   `torch`, `demucs`, `julius`, `einops` and `safetensors` with their dist-info must be gone from an earlier release). Since 1.0.24 the earlier release first saves a project (three Vietnamese segments with speakers, a
   chapter and gaps, one selected take made of `dialogue.wav`, two transcript rows, a dictionary entry, speaker slots; S0), and right after the
   relaunch, by invoke and before any navigation, the run checks: N1 `load_project` equals S0; N2 `list_project_versions` is `[]`; N3 opening the
   project in the UI writes nothing in 5 s; N4 the first edit keeps S0 as one `auto` version (its revision and `state_at` are S0's);
   N5 `restore_project_version` gives S0 back (segments, transcript, dictionary, speaker slots, takes at least those of S0, the current name,
   revision + 1); N6 two versions, the newest `before_restore` with the edited state's `state_at`; N7 the build has the notification command and the Start-menu shortcut's
   `System.AppUserModel.ID` is `studio.thanham.desktop`. With the four checks of 1.0.23 that is 11 PASS.
   `update-seeded` runs after it in the same Sandbox when `-Seed <folder>` copied
   `vieneu-v3`, `whisper-small`, `diarization` and `htdemucs` (map the folder, for example as `C:\seed`) into
   the data folder before the first install: TTS, speaker-labelled STT and the models must work with no
   `model_download` job and no changed model file, a separation must first say the pack is missing, then
   download it through the consent dialog, then separate, and the pack tree must equal its manifest.
   `-From <previous installer> -Only update,update-seeded -Seed <folder>` is the release run.
   The `dub` phase installs the pack through the UI and re-checks it after its separations, and `full` asserts that
   the installer's runtime has no torch and that no shipped `.pyc` changed.

   Which Sandbox runs a release needs (owner decision 2026-11-16; one Sandbox holds 8 GB of RAM and the
   full set takes 1-1.5 h):
   - Every release: a Sandbox of its own with `-Only update -From C:\installer\from\<previous release installer>`
     (about 10 minutes, no model download; the runner refuses `-From` with any other phase). The previous release is installed first and updates itself
     to this one through the local feed, as installed copies will. Each release reaches every installed
     copy through the updater, and a release with a broken updater cannot replace itself.
   - Changes to the worker, export, TTS/STT or the Rust job code: add `full` and the phase that covers
     the change (`features`, `dub`, `scripts`, `ux`, `clone`).
   - New Python, FFmpeg, Tauri or NSIS versions, or a changed installer configuration: the full set in
     three Sandboxes (`-Only full,features,dub,scripts,ux,update`; the default runner; `-Only full,clone,dpi`).

   **Gate runs (1.0.24 and later).** Two Sandboxes: r1 `-Only update -From C:\installer\from` with `dialogue.wav` (4 GB, 30 minutes; 11 PASS), r2 `-Only full,features,ux,dpi,nvda,hc` (6 GB, 60 minutes; no FAIL or ABORT, the only allowed NOTE is
   `hc-theme-unavailable`; the PASS lines are the earlier ones plus 10: the 8 new checks V1, V3, V2, two in `dpi`, S9, S10 and `hc`, and the `launch` and `runtime bundled`
   lines the `hc` phase writes like every phase; an `hc` FAIL is also logged as ABORT and counts once). `dialogue-x2.wav` is made with `ffmpeg -stream_loop 1 -i dialogue.wav -c copy dialogue-x2.wav`. A product FAIL stops
   the release: the tag is burned and the fix ships as the next version, never a re-tag.

   **Harness-defect rerun rule.** A FAIL whose evidence (the log and the `DOM` line every failing step writes) shows that the harness is wrong and the
   product right, confirmed by an independent verifier, is fixed by a harness-fix pull request on `main`. Only that run is then repeated on the same
   draft, with `e2e/desktop` taken from the fix's merge (`git archive <fix-merge> e2e/desktop`), recording the tag SHA and the harness SHA. The release is
   published only if the rerun has no FAIL. The defect and the rerun go into `docs/STATUS.md`.

   **Slot and time rules for Sandbox runs.** Sandbox runs go through the coordinator's wrapper `outputs\wt\.slots\slot-run.ps1 -Slot sandbox -MaxMinutes <N>`
   (outside the repository), never directly. It exits with code 75 and does not start when the run could not end before 21:45, or when it is before
   07:00; no Sandbox starts after 20:30. It waits for the room (4 GB: 4,500 MB available and 6 GB headroom; 6 GB: 3,500 MB and 8 GB) and for the
   other slots, and takes the exclusive lock only once the room is there. The run script sets its own limit when each run starts, the smaller of its
   timeout and the minutes left until 21:40. From 21:45 to 07:00 nothing heavy runs on the machine.

   Afterwards, delete older installer copies. `vmmemWindowsSandbox` can keep about 2.4 GB of RAM for a
   while after the Sandbox closes (on 2026-11-16 it let go of it later without a restart).
3. Long project: `node e2e/desktop/gate.mjs <installed exe> <out> 500` (500 segments, cancel,
   hard crash mid-batch, restart/retry, full render, STT round trip WER/CER, per-phase RAM in
   `ram.csv`, queue screenshots).
4. Human listening pass on the fixed corpus (A/B: same sentences, same order, keep per-sentence
   files and the joined render). Metrics never replace listening.

## Signing and licenses

Installers are **not Authenticode-signed** (SignPath Foundation declined the application, see
[SIGNING.md](SIGNING.md)); Windows SmartScreen will warn. Update packages are signed with the
project's updater key by the release workflow. Record the signing status in the release notes. Third-party components and their licenses are listed in the generated
SBOM/notices; FFmpeg and python-soxr are LGPL and ship as separate replaceable files with their
license and source pointer (`runtime/ffmpeg/SOURCE.txt`). The PyAV wheel bundles a second FFmpeg
build with its codec libraries in `av.libs`. `scripts/setup-runtime.ps1` replaces its GPL x264 and x265
encoder DLLs with the project's stubs (`scripts/encoder-stubs`: same file names, no encoder code; the app
only decodes), so that build is listed under LGPL-3.0-or-later. The notices list each library with its
license text and the build's sources (`scripts/licenses/`, `pyav-ffmpeg-SOURCE.txt`), and
`scripts/third_party.py` stops when a `*.libs` folder holds a DLL it does not list, or when the runtime
still holds a binary that setup-runtime replaces or removes. soundfile's
`libsndfile_x64.dll` (LGPL) links FLAC, Ogg, Vorbis, Opus, mpg123 and LAME in statically; each is listed,
with the build's sources in `scripts/licenses/libsndfile-SOURCE.txt`. The script also stops when a component
has no license text; packages that ship none get theirs from `NO_LICENSE_FILE` in the script. Its last line
names the GPL and LGPL components for review: python-soxr, both FFmpeg builds, LAME (twice),
GNU libiconv, the GCC runtime, libsndfile and mpg123 are expected. Models (VieNeu v3 Turbo and the MOSS
audio tokenizer: Apache-2.0; faster-whisper conversions: MIT) are downloaded by the user, not
redistributed. The optional HTDemucs weights (code MIT; the weights' license is unclear upstream:
trained on MusDB-HQ, which is for research only, plus 800 unpublished songs) are also a user-started download; say so in the
release notes.

The only Intel binary in the runtime is Intel oneMKL (linked into ctranslate2 in the installer and into torch
in the separation pack, whose download dialog shows the licence; Intel
Simplified Software License, text in `scripts/licenses/` from the `mkl` 2026.2.1 wheel). Its terms forbid
reverse engineering and modifying it, so the installer shows `src-tauri/installer-license.txt` as an
"I agree" page (silent `/S` installs and the updater's passive install skip it) and installs
`LICENSE.txt` and `THIRD-PARTY-NOTICES.txt`. Since 1.0.16, `scripts/setup-runtime.ps1` replaces the Intel
OpenMP runtime that the torch and ctranslate2 wheels ship (Intel End User License Agreement for Developer
Tools) with the LLVM OpenMP runtime 23.1.5 (conda-forge `llvm-openmp`, pinned by SHA-256; Apache-2.0 WITH
LLVM-exception), loaded through the project's `libiomp5md.dll` shim (`scripts/openmp-shim`), which adds the
five MSVC vcomp entry points both packages import. The build fails if a binary imports a symbol the shim
lacks or an Intel OpenMP binary remains. setup-runtime also deletes ctranslate2's unused NVIDIA cuDNN DLL,
and an installer hook (`src-tauri/installer-hooks.nsh`) deletes `libiompstubs5md.dll` and `cudnn64_9.dll`,
which an update over 1.0.15 would otherwise leave behind. Before publishing, check the tagged build's
notices: `Select-String 'Intel Simplified Software License','LLVM-exception' release/THIRD-PARTY-NOTICES.txt`
finds both, and `Select-String 'for Developer Tools' release/THIRD-PARTY-NOTICES.txt` finds nothing. On
2026-11-17 the owner chose to say in the README and in every release's notes that releases are made for
friends and family and provided as is, without warranty (Apache-2.0 sections 7 and 8), and to ship
1.0.16 with the Intel OpenMP runtime replaced, so the installer no longer redistributes a binary under
the Intel EULA.
