# s5-clone

Spike S5 of the Thanh Am Studio Rust-worker migration: Rust clone conditioning (K-cond) and the `librosa.effects.trim` port (K-B3).
Local branch `spike/s5-clone`; never pushed. Evidence and results: `work\rm\s5-clone\RESULTS.md`.

- `src/`: `window` (clone_window), `trim` (librosa trim), `wav` (libsndfile-compatible read, lrintf quantisation, numpy pairwise sum),
  `resample` (FFmpeg-soxr and `soxr.dll` backends), `denoise` (STFT, ORT through `ortffi`, iSTFT), `fbank` (kaldi-native-fbank 1.23.0
  built from source by `build.rs`), `pf` (numpy 2.4.6's pocketfft C++ from `native/pocketfft_shim.cc`), `cond` (the whole path), `npy`,
  `s5b` (denoiser STFT/iSTFT isolation), `main` (commands `unit`, `resample`, `kb3`, `preview`, `run`, `cond`, `stftiso`).
- `py/`: recorder, variants, thresholds, K-cond evaluation, fixtures, injection generator, `recstft.py` (numpy STFT/iSTFT intermediates),
  `pcm_model_check.py` (libsndfile quantisation model), `e0_agg.py` (per-stage E0 counts of a run). Run with
  `runtime\python\python.exe -I -B <script>`.
- `THIRD_PARTY.md`: pins and hashes of the sources built here.
- `cargo test --release` needs the evidence tree (`S5_EVIDENCE`, `S5_BASELINE` override the defaults).
