# s5-clone

Spike S5 of the Thanh Am Studio Rust-worker migration: Rust clone conditioning (K-cond) and the `librosa.effects.trim` port (K-B3).
Local branch `spike/s5-clone`; never pushed. Evidence and results: `work\rm\s5-clone\RESULTS.md`.

- `src/`: `window` (clone_window), `trim` (librosa trim), `wav` (libsndfile-compatible read, floor quantisation, numpy pairwise sum),
  `resample` (FFmpeg-soxr and `soxr.dll` backends), `denoise` (STFT, ORT through `ortffi`, iSTFT), `fbank` (kaldi-native-fbank 1.23.0
  built from source by `build.rs`), `cond` (the whole path), `npy`, `main` (commands `unit`, `resample`, `kb3`, `preview`, `run`, `cond`).
- `py/`: recorder, variants, thresholds, K-cond evaluation, fixtures, injection generator. Run with
  `runtime\python\python.exe -I -B <script>`.
- `THIRD_PARTY.md`: pins and hashes of the sources built here.
- `cargo test --release` needs the evidence tree (`S5_EVIDENCE`, `S5_BASELINE` override the defaults).
