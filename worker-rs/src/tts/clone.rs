//! Cloned voices: `clone_window`, `clone_reference` and `clone_preview` of `worker/main.py`, and VieNeu's enrollment of a reference
//! (`V3TurboVieNeuTTS._enroll_reference`: `_preclean_reference_audio`, then `OnnxV3LiteEngine.prepare_reference`: the 8 s cap,
//! `OnnxDenoiser.denoise`, the speaker embedding and the codec reference codes). Ported from spikes S5/S5b, where every step was
//! bitwise equal to the Python recorder on 20 references and the preview on 31/31.
//!
//! What makes each step E0 (S5 section 7.4):
//! * reference audio is read and written by the runtime's own libsndfile ([`super::sndfile`]);
//! * the three soxr resamples are FFmpeg's `aresample=resampler=soxr:precision=20` (python-soxr 1.1.0's HQ; bit-identical on every
//!   recorded call), with the FFmpeg build's `swresample` DLL pinned;
//! * the denoiser's FFTs are numpy's own pocketfft (`native/pocketfft_shim.cc`), `np.abs` of complex128 is numpy's SIMD formula with
//!   its FMA dispatch, and `atan2`/`cos`/`sin` are the dynamic C runtime's, which numpy calls too;
//! * the fbank is kaldi-native-fbank 1.23.0 (`native/knf_shim.cc`);
//! * the ONNX sessions get the engine's options (the speaker encoder is not thread-count invariant), and the preview's denoiser
//!   ORT's defaults, as `OnnxDenoiser(path)` gets them in Python.
//!
//! A case the port does not mirror (a clip too short for the denoiser's reflect padding or for one fbank frame) is `WORKER_ERROR`,
//! which the desktop reruns on the Python worker.

use super::np::{pairwise_sum, sum};
use super::sndfile::{Audio, SndFile, Subtype};
use crate::error::{Result, WorkerError};
use crate::media::{executable, spawn_capture};
use crate::paths::{contained_path, replace_with_retry};
use crate::pyfmt::tail_chars;
use ortffi::{ElementType, Env, Session, SessionOptions};
use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Seconds of a reference that VieNeu clones from (`CLONE_SECONDS`, `_MAX_REF_SECONDS`).
const CLONE_SECONDS: f64 = 8.0;
const N_FFT: usize = 1680;
const HOP: usize = 420;
const WAV_RATE: u32 = 44100;
const FBANK_RATE: u32 = 16000;
const N_MELS: usize = 80;
const SPEAKER_MAX_SECONDS: f64 = 30.0;
const CODEC_RATE: u32 = 48000;
const CODEC_FRAME: usize = 3840;
/// The runtime's libsndfile, beside python-soundfile.
const SNDFILE_DLL: &str = "libsndfile_x64.dll";
/// SHA-256 of the FFmpeg build's `swresample-7.dll` (BtbN autobuild-2026-11-10-12-39, `setup-runtime.ps1`), which holds the libsoxr
/// that was checked bit for bit against python-soxr.
const SWRESAMPLE_SHA256: &str = "eacddd70febf920546b177b1c7daf64f728cabe998e37a477ebee0dd96c23d7b";

fn worker_error(message: &str) -> WorkerError {
    WorkerError::new("WORKER_ERROR", message)
}

/// `THANHAM_CLONE_TRACE=<file>`: one JSON line per conditioning step (row K-cond), the same lines `parity/tts_trace.py` writes from
/// the Python worker: arrays as `[sha256 of their bytes, length]`, positions as integers.
pub struct Trace(Option<PathBuf>);

impl Trace {
    pub fn from_env() -> Trace {
        Trace(std::env::var_os("THANHAM_CLONE_TRACE").filter(|s| !s.is_empty()).map(PathBuf::from))
    }

    fn line(&self, step: &str, value: impl FnOnce() -> Json) {
        if let Some(path) = &self.0 {
            let line = json!({"step": step, "value": value()});
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{line}");
            }
        }
    }

    fn bytes(&self, step: &str, data: &[u8], len: usize) {
        self.line(step, || json!([Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect::<String>(), len]));
    }

    fn f32(&self, step: &str, data: &[f32]) {
        if self.0.is_some() {
            self.bytes(step, &data.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(), data.len());
        }
    }

    fn ints(&self, step: &str, values: &[i64]) {
        self.line(step, || json!(values));
    }
}

/// `frames.mean(axis=1)` of interleaved float32 frames (numpy's sum starts from +0.0, which decides the sign of a zero mean).
fn mean_channels(samples: &[f32], channels: usize) -> Vec<f32> {
    samples.chunks_exact(channels).map(|c| sum(c) / channels as f32).collect()
}

/// `clone_window(audio, sr)`: `(start, end)` samples of the `CLONE_SECONDS` of mono `audio` with the most speech; all of it when not
/// longer. Float32 as numpy computes it.
fn clone_window(audio: &[f32], sr: u32) -> (usize, usize) {
    let size = (CLONE_SECONDS * f64::from(sr)) as usize;
    let hop = std::cmp::max(1, sr as usize / 50);
    if audio.len() <= size {
        return (0, audio.len());
    }
    let (count, width) = (audio.len() / hop, size / hop);
    let mut squares = vec![0.0f32; hop];
    let energy: Vec<f32> = (0..count)
        .map(|f| {
            for (s, &v) in squares.iter_mut().zip(&audio[f * hop..(f + 1) * hop]) {
                *s = v * v;
            }
            (pairwise_sum(&squares) / hop as f32 + 1e-12f32).sqrt()
        })
        .collect();
    let emax = energy.iter().copied().fold(f32::MIN, f32::max);
    let voiced: Vec<bool> = energy.iter().map(|&e| 20.0f32 * (e / emax).log10() > -35.0f32).collect();
    // np.convolve(voiced, ones(width), 'valid') over exact small integers, then the first argmax
    let mut score = Vec::with_capacity(count - width + 1);
    let mut running: i64 = voiced[..width].iter().map(|&v| i64::from(v)).sum();
    score.push(running);
    for i in 1..count - width + 1 {
        running += i64::from(voiced[i + width - 1]) - i64::from(voiced[i - 1]);
        score.push(running);
    }
    let at = (0..score.len()).fold(0, |best, i| if score[i] > score[best] { i } else { best });
    let mut start = at;
    for f in at..std::cmp::min(at + 50, score.len()) {
        if voiced[f] && !voiced[f.saturating_sub(3)..f].iter().any(|&v| v) {
            start = f.saturating_sub(2);
            break;
        }
    }
    let start = std::cmp::min(start * hop, audio.len() - size);
    (start, start + size)
}

/// `librosa.effects.trim(y, top_db=30)` (librosa 0.11) as bounds: frame RMS (2048 / 512, centred with zero padding), dB against the
/// loudest frame, the first and last frame above -30 dB. Float32 in numpy's order.
fn trim(y: &[f32]) -> (usize, usize) {
    const FRAME: usize = 2048;
    const STEP: usize = 512;
    let mut padded = vec![0.0f32; y.len() + FRAME];
    padded[FRAME / 2..FRAME / 2 + y.len()].copy_from_slice(y);
    let mut squares = vec![0.0f32; FRAME];
    let rms: Vec<f32> = (0..1 + (padded.len() - FRAME) / STEP)
        .map(|t| {
            for (s, &v) in squares.iter_mut().zip(&padded[t * STEP..t * STEP + FRAME]) {
                *s = v * v;
            }
            (pairwise_sum(&squares) / FRAME as f32).sqrt()
        })
        .collect();
    // amplitude_to_db(rms, ref=np.max, top_db=None) = 10 log10(max(amin, rms^2)) - 10 log10(max(amin, ref^2)), amin = 1e-10
    let reference = rms.iter().copied().fold(f32::MIN, |a, b| if b > a { b } else { a });
    let ref_db = 10.0f32 * 1e-10f32.max(reference * reference).log10();
    let loud: Vec<usize> =
        (0..rms.len()).filter(|&i| 10.0f32 * 1e-10f32.max(rms[i] * rms[i]).log10() - ref_db > -30.0).collect();
    match (loud.first(), loud.last()) {
        (Some(&first), Some(&last)) => (first * STEP, std::cmp::min(y.len(), (last + 1) * STEP)),
        _ => (0, 0),
    }
}

/// Python's `str(Path(path))` for the paths the desktop sends (separators only).
// shortcut: no `..`/`.`/doubled-separator folding, which desktop paths never need; port pathlib's parsing if other callers appear.
pub fn py_path(path: &str) -> String {
    path.replace('/', "\\")
}

/// What `clone_reference(path)` hands VieNeu: the decoded reference and the window it clones from, or the read error, which VieNeu's
/// own read of the file raises again at enrollment (Python passes the path on unchanged).
pub struct Crop(Result<(Audio, usize, usize)>);

/// Reference I/O and the resampler: the runtime's libsndfile and FFmpeg's soxr.
pub struct Io {
    snd: SndFile,
    ffmpeg: String,
}

impl Io {
    /// The runtime's libsndfile (`site_packages\_soundfile_data`) and the FFmpeg `ffmpeg_path` names (else `THANHAM_FFMPEG`), whose
    /// `swresample` DLL must match its pin.
    pub fn load(site_packages: &Path, ffmpeg_path: Option<&str>) -> Result<Io> {
        let snd = SndFile::load_pinned(&site_packages.join("_soundfile_data").join(SNDFILE_DLL))?;
        let ffmpeg = executable("ffmpeg", ffmpeg_path)?;
        let swr = Path::new(&ffmpeg).with_file_name("swresample-7.dll");
        let hex: String = std::fs::read(&swr)
            .map(|b| Sha256::digest(b).iter().map(|b| format!("{b:02x}")).collect())
            .unwrap_or_default();
        if hex != SWRESAMPLE_SHA256 {
            return Err(WorkerError::new(
                "RUNTIME_MISSING",
                format!("{} is not the pinned FFmpeg build (SHA-256 {hex}).", swr.display()),
            ));
        }
        Ok(Io { snd, ffmpeg })
    }

    /// `soxr.resample(x, in_rate, out_rate)` (python-soxr HQ) through FFmpeg's soxr.
    fn resample(&self, x: &[f32], in_rate: u32, out_rate: u32, trace: &Trace) -> Result<Vec<f32>> {
        let args: Vec<String> = [
            self.ffmpeg.as_str(),
            "-nostdin",
            "-v",
            "error",
            "-f",
            "f32le",
            "-ar",
            &in_rate.to_string(),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-af",
            &format!("aresample={out_rate}:resampler=soxr:precision=20"),
            "-f",
            "f32le",
            "-ar",
            &out_rate.to_string(),
            "-ac",
            "1",
            "pipe:1",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let input: Vec<u8> = x.iter().flat_map(|v| v.to_le_bytes()).collect();
        let out = spawn_capture(&args, Some(&input))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(worker_error(&format!("Resampling failed: {}", tail_chars(&stderr, 2500))));
        }
        let y: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        trace.f32(&format!("soxr_{in_rate}_{out_rate}"), &y);
        Ok(y)
    }

    /// `clone_reference(path)`, `path` as `str(Path(...))` gives it.
    pub fn crop(&self, path: &str, trace: &Trace) -> Crop {
        Crop(self.snd.read(path).map(|audio| {
            trace.f32("decode", &audio.samples);
            trace.ints("decode_format", &[i64::from(audio.rate), audio.channels as i64]);
            let (start, end) = clone_window(&mean_channels(&audio.samples, audio.channels), audio.rate);
            trace.ints("window", &[start as i64, end as i64]);
            (audio, start, end)
        }))
    }

    /// `_preclean_reference_audio` of what `clone_reference` returned (channel mean, trim, a PCM_16 WAV), then `_load_mono` of that
    /// file: the mono clip VieNeu goes on with, and its rate.
    fn cleaned(&self, crop: &Crop, trace: &Trace) -> Result<(Vec<f32>, u32)> {
        let (audio, start, end) = crop.0.as_ref().map(|(a, s, e)| (a, *s, *e)).map_err(Clone::clone)?;
        let (rate, channels) = (audio.rate, audio.channels);
        // The crop is a FLOAT WAV in Python, which reads back exactly; read with always_2d=False, a mono clip is not averaged.
        let frames = audio.samples.len() / channels;
        let crop =
            if end - start >= frames { &audio.samples[..] } else { &audio.samples[start * channels..end * channels] };
        let mono = if channels > 1 { mean_channels(crop, channels) } else { crop.to_vec() };
        trace.f32("trim_in", &mono);
        let (t0, t1) = trim(&mono);
        trace.ints("trim", &[t0 as i64, t1 as i64]);
        let file = std::env::temp_dir().join(format!("clone-trim-{}.wav", uuid::Uuid::new_v4()));
        let file_str = file.to_string_lossy().into_owned();
        let back = (|| {
            self.snd.write(&file_str, &mono[t0..t1], rate, Subtype::Pcm16)?;
            if trace.0.is_some() {
                let bytes = std::fs::read(&file).map_err(|e| WorkerError::py("OSError", e))?;
                trace.bytes("pcm16_file", &bytes, bytes.len());
            }
            self.snd.read(&file_str)
        })();
        let _ = std::fs::remove_file(&file);
        let back = back?;
        Ok((mean_channels(&back.samples, back.channels), back.rate))
    }
}

/// `sum += x` per column, then `/ rows`: `features.mean(axis=0)` of a `(rows, n)` float32 matrix, subtracted from every row.
fn mean_norm(features: &mut [f32], n: usize) {
    let rows = features.len() / n;
    let mut mean = vec![0.0f32; n];
    for row in features.chunks_exact(n) {
        for (m, v) in mean.iter_mut().zip(row) {
            *m += v;
        }
    }
    for m in &mut mean {
        *m /= rows as f32;
    }
    for row in features.chunks_exact_mut(n) {
        for (v, m) in row.iter_mut().zip(&mean) {
            *v -= m;
        }
    }
}

extern "C" {
    fn thanham_knf_fbank(wav: *const f32, n: i32, sample_rate: i32, n_mels: i32, out: *mut f32, max_frames: i32)
        -> i32;
    fn thanham_pf_rfft_f64(input: *const f64, rows: usize, npts: usize, out: *mut f64, fct: f64) -> i32;
    fn thanham_pf_irfft_f32(input: *const f32, rows: usize, nin: usize, nout: usize, out: *mut f32, fct: f32) -> i32;
}

/// `_kaldi_fbank(wav, 16000, 80, 0.0)`: the raw `(frames, 80)` features.
fn kaldi_fbank(wav: &[f32]) -> Result<Vec<f32>> {
    let max_frames = wav.len() / 160 + 4;
    let mut out = vec![0.0f32; max_frames * N_MELS];
    // SAFETY: `wav` holds `wav.len()` floats and `out` `max_frames * N_MELS`; the shim writes at most that many.
    let frames = unsafe {
        thanham_knf_fbank(
            wav.as_ptr(),
            wav.len() as i32,
            FBANK_RATE as i32,
            N_MELS as i32,
            out.as_mut_ptr(),
            max_frames as i32,
        )
    };
    if frames <= 0 {
        return Err(worker_error("The reference is too short for one fbank frame."));
    }
    out.truncate(frames as usize * N_MELS);
    Ok(out)
}

/// numpy's dispatch for `np.abs(complex128)` lands on a target with fused multiply-add: X86_V3 or V4 (AVX2, FMA3, F16C, BMI1/2,
/// LZCNT, MOVBE); the X86_V2 baseline has none.
fn numpy_abs_is_fused() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
        && std::arch::is_x86_feature_detected!("fma")
        && std::arch::is_x86_feature_detected!("f16c")
        && std::arch::is_x86_feature_detected!("bmi1")
        && std::arch::is_x86_feature_detected!("bmi2")
        && std::arch::is_x86_feature_detected!("lzcnt")
        && std::arch::is_x86_feature_detected!("movbe")
}

/// numpy's SIMD `np.abs` of a finite complex128 (`simd_cabsolute_f64`): `larger * sqrt(1 + (smaller / larger)^2)`, the multiply-add
/// fused when numpy's target has FMA.
fn np_cabs(re: f64, im: f64, fused: bool) -> f64 {
    let (re, im) = (re.abs(), im.abs());
    let (larger, smaller) = (re.max(im), re.min(im));
    let ratio = if larger == 0.0 { 0.0 } else { smaller / larger };
    let s = if fused { ratio.mul_add(ratio, 1.0) } else { ratio * ratio + 1.0 };
    s.sqrt() * larger
}

/// `sep_mag * (sep_cos + 1j * sep_sin)` in complex64 as numpy evaluates it (each operand promoted to `x + 0j`), signed zeros included.
fn np_complex_product(m: f32, c: f32, s: f32) -> (f32, f32) {
    let (t_re, t_im) = (0.0f32 * s - 1.0 * 0.0, 0.0f32 * 0.0 + 1.0 * s);
    let (u_re, u_im) = (c + t_re, 0.0f32 + t_im);
    (m * u_re - 0.0 * u_im, m * u_im + 0.0 * u_re)
}

#[cfg(test)]
thread_local! {
    /// Every denoiser output on this thread, as the Python test captures `OnnxDenoiser.denoise`.
    pub static DENOISED: std::cell::RefCell<Vec<Vec<f32>>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// `OnnxDenoiser` (`vieneu/_v3_turbo_engine/onnx_denoiser.py`).
pub struct Denoiser {
    env: Env,
    session: Session,
    outputs: Vec<String>,
    /// `_WIN`: `0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)`.
    window: Vec<f64>,
}

impl Denoiser {
    /// `OnnxDenoiser(path, sess_options)`.
    pub fn new(env: &Env, onnx: &Path, options: &SessionOptions) -> Result<Denoiser> {
        let session = Session::from_file(env, onnx, options)?;
        let outputs = session.outputs().iter().map(|o| o.name.clone()).collect();
        let window =
            (0..N_FFT).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()).collect();
        Ok(Denoiser { env: env.clone(), session, outputs, window })
    }

    /// `denoise(wav, sr)`: float32 mono at 44.1 kHz.
    fn denoise(&self, io: &Io, wav: &[f32], sr: u32, trace: &Trace) -> Result<Vec<f32>> {
        trace.f32("den_wav", wav);
        let wav = if sr == WAV_RATE { wav.to_vec() } else { io.resample(wav, sr, WAV_RATE, trace)? };
        let length = wav.len();
        if length == 0 {
            return Err(worker_error("The cleaned reference is empty."));
        }
        // abs_max is a Python float: float32 in `wav / abs_max`, float64 in `o * abs_max`
        let abs_max = f64::from(wav.iter().fold(0.0f32, |m, &v| m.max(v.abs()))).max(1e-7);
        let mut w: Vec<f32> = wav.iter().map(|&v| v / abs_max as f32).collect();
        w.extend(std::iter::repeat(0.0).take(441));
        // _forward: _normalize, _stft, abs/angle/cos/sin, _core, _istft
        let divisor = w.iter().fold(0.0f32, |m, &v| m.max(v.abs())) + 1e-7f32;
        let x: Vec<f32> = w.iter().map(|&v| v / divisor).collect();
        if x.len() <= N_FFT / 2 {
            return Err(worker_error("The cleaned reference is too short for the denoiser."));
        }
        let (mag, cos, sin, frames) = self.stft(&x);
        trace.f32("den_mag", &mag);
        trace.f32("den_cos", &cos);
        trace.f32("den_sin", &sin);
        let shape = [1, (N_FFT / 2 + 1) as i64, frames as i64];
        let (v_mag, v_cos, v_sin) =
            (self.env.tensor(&mag, &shape)?, self.env.tensor(&cos, &shape)?, self.env.tensor(&sin, &shape)?);
        let names: Vec<&str> = self.outputs.iter().map(String::as_str).collect();
        let outs = self.session.run(&[("mag", &v_mag), ("cos", &v_cos), ("sin", &v_sin)], &names)?;
        let (sep_mag, sep_cos, sep_sin) =
            (outs[0].to_vec::<f32>()?, outs[1].to_vec::<f32>()?, outs[2].to_vec::<f32>()?);
        trace.f32("den_sep_mag", &sep_mag);
        trace.f32("den_sep_cos", &sep_cos);
        trace.f32("den_sep_sin", &sep_sin);
        let o = self.istft(&sep_mag, &sep_cos, &sep_sin, frames, x.len())?;
        let out: Vec<f32> = o[..length].iter().map(|&v| (v * abs_max) as f32).collect();
        trace.f32("den_out", &out);
        #[cfg(test)]
        DENOISED.with_borrow_mut(|d| d.push(out.clone()));
        Ok(out)
    }

    /// `_stft(x)` (reflect padding, periodic Hann, float64 rfft, last frame dropped), then `np.abs`, `np.angle`, `np.cos`, `np.sin`,
    /// cast to float32 for `_core`: `(mag, cos, sin)` as `(841, frames)` row-major, and `frames`.
    fn stft(&self, x: &[f32]) -> (Vec<f32>, Vec<f32>, Vec<f32>, usize) {
        let (pad, n) = (N_FFT / 2, x.len());
        let mut xp = Vec::with_capacity(n + 2 * pad);
        xp.extend((1..=pad).rev().map(|i| x[i]));
        xp.extend_from_slice(x);
        xp.extend((1..=pad).map(|i| x[n - 1 - i]));
        let frames = (xp.len() - N_FFT) / HOP; // 1 + (len - N_FFT) // HOP frames, the last one dropped
        let bins = N_FFT / 2 + 1;
        let mut windowed = vec![0.0f64; frames * N_FFT];
        for t in 0..frames {
            for i in 0..N_FFT {
                windowed[t * N_FFT + i] = f64::from(xp[t * HOP + i]) * self.window[i];
            }
        }
        let mut spec = vec![0.0f64; frames * bins * 2];
        // SAFETY: `windowed` holds `frames * N_FFT` doubles and `spec` `frames * bins` complex values.
        let rc = unsafe { thanham_pf_rfft_f64(windowed.as_ptr(), frames, N_FFT, spec.as_mut_ptr(), 1.0) };
        assert_eq!(rc, 0, "pocketfft rfft failed");
        let fused = numpy_abs_is_fused();
        let (mut mag, mut cos, mut sin) =
            (vec![0f32; bins * frames], vec![0f32; bins * frames], vec![0f32; bins * frames]);
        for t in 0..frames {
            for k in 0..bins {
                let (re, im) = (spec[(t * bins + k) * 2], spec[(t * bins + k) * 2 + 1]);
                let phi = im.atan2(re);
                mag[k * frames + t] = np_cabs(re, im, fused) as f32;
                cos[k * frames + t] = phi.cos() as f32;
                sin[k * frames + t] = phi.sin() as f32;
            }
        }
        (mag, cos, sin, frames)
    }

    /// `_istft(sep_mag * (sep_cos + 1j * sep_sin), out_len)`: the last frame repeated, float32 irfft (numpy 2 for complex64), the
    /// window, float64 overlap-add and window-sum normalisation.
    fn istft(
        &self,
        sep_mag: &[f32],
        sep_cos: &[f32],
        sep_sin: &[f32],
        frames: usize,
        out_len: usize,
    ) -> Result<Vec<f64>> {
        let bins = N_FFT / 2 + 1;
        let t_total = frames + 1;
        let siglen = N_FFT + HOP * (t_total - 1);
        let mut spec = vec![0.0f32; t_total * bins * 2];
        for i in 0..t_total {
            let src = std::cmp::min(i, frames - 1);
            for k in 0..bins {
                let (re, im) =
                    np_complex_product(sep_mag[k * frames + src], sep_cos[k * frames + src], sep_sin[k * frames + src]);
                spec[(i * bins + k) * 2] = re;
                spec[(i * bins + k) * 2 + 1] = im;
            }
        }
        let mut time = vec![0.0f32; t_total * N_FFT];
        let fct = (1.0f64 / N_FFT as f64) as f32;
        // SAFETY: `spec` holds `t_total * bins` complex values and `time` `t_total * N_FFT` floats.
        let rc = unsafe { thanham_pf_irfft_f32(spec.as_ptr(), t_total, bins, N_FFT, time.as_mut_ptr(), fct) };
        if rc != 0 {
            return Err(worker_error("pocketfft irfft failed"));
        }
        let (mut out, mut wsum) = (vec![0.0f64; siglen], vec![0.0f64; siglen]);
        let w2: Vec<f64> = self.window.iter().map(|w| w * w).collect();
        for i in 0..t_total {
            for j in 0..N_FFT {
                out[i * HOP + j] += f64::from(time[i * N_FFT + j]) * self.window[j];
                wsum[i * HOP + j] += w2[j];
            }
        }
        let pad = N_FFT / 2;
        let mut res: Vec<f64> = (pad..siglen - pad).map(|j| out[j] / wsum[j].max(1e-11)).collect();
        res.resize(out_len, 0.0);
        Ok(res)
    }
}

/// The sessions enrollment needs besides the engine's: the denoiser, the speaker and codec encoders, all with the engine's session
/// options (`self._so` in Python).
pub struct Enroller {
    env: Env,
    denoiser: Denoiser,
    speaker: Session,
    codec: Session,
}

impl Enroller {
    /// Loads the three sessions from the model folder (`backbone\denoiser.onnx`, `backbone\speaker_encoder.onnx`,
    /// `codec\moss_audio_tokenizer_encode.onnx`).
    pub fn load(env: &Env, options: &SessionOptions, model_dir: &Path) -> Result<Enroller> {
        let backbone = model_dir.join("backbone");
        Ok(Enroller {
            denoiser: Denoiser::new(env, &backbone.join("denoiser.onnx"), options)?,
            speaker: Session::from_file(env, &backbone.join("speaker_encoder.onnx"), options)?,
            codec: Session::from_file(env, &model_dir.join("codec").join("moss_audio_tokenizer_encode.onnx"), options)?,
            env: env.clone(),
        })
    }

    /// `_enroll_reference(<the crop>, denoise=True, use_ref_codes=True)`: the 192-d speaker embedding and the reference codes
    /// `(T, 16)` row-major.
    pub fn enroll(&self, io: &Io, crop: &Crop, trace: &Trace) -> Result<(Vec<f32>, Vec<i64>)> {
        let (mut wav, sr) = io.cleaned(crop, trace)?;
        wav.truncate((CLONE_SECONDS * f64::from(sr)) as usize);
        let clean = self.denoiser.denoise(io, &wav, sr, trace)?;
        // OnnxSpeakerEncoder.embed: 30 s cap, extract_speaker_fbank (16 kHz, 80 bins, mean norm), the encoder
        let capped = &clean[..clean.len().min((f64::from(WAV_RATE) * SPEAKER_MAX_SECONDS) as usize)];
        let at16 = io.resample(capped, WAV_RATE, FBANK_RATE, trace)?;
        let mut fbank = kaldi_fbank(&at16)?;
        trace.f32("fbank_raw", &fbank);
        mean_norm(&mut fbank, N_MELS);
        trace.f32("fbank", &fbank);
        let input = self.env.tensor(&fbank, &[1, (fbank.len() / N_MELS) as i64, N_MELS as i64])?;
        let (input_name, name) = (self.speaker.inputs()[0].name.clone(), self.speaker.outputs()[0].name.clone());
        let emb = self.speaker.run(&[(&input_name, &input)], &[&name])?[0].to_vec::<f32>()?;
        trace.f32("embedding", &emb);
        // _encode_ref_wav: 48 kHz, zero-padded to whole codec frames, the same signal on two channels, cut to n_padded / 3840 frames
        let mut wav48 = io.resample(&clean, WAV_RATE, CODEC_RATE, trace)?;
        if wav48.len() % CODEC_FRAME != 0 {
            wav48.resize(wav48.len() + CODEC_FRAME - wav48.len() % CODEC_FRAME, 0.0);
        }
        let n_frames = wav48.len() / CODEC_FRAME;
        let stereo = [wav48.as_slice(), wav48.as_slice()].concat();
        let lengths = [wav48.len() as i32];
        let (wave, lens) = (self.env.tensor(&stereo, &[1, 2, wav48.len() as i64])?, self.env.tensor(&lengths, &[1])?);
        let name = self.codec.outputs()[0].name.clone();
        let out = self.codec.run(&[("waveform", &wave), ("input_lengths", &lens)], &[&name])?;
        let info = out[0].info()?;
        let flat: Vec<i64> = match info.element {
            ElementType::I64 => out[0].to_vec::<i64>()?,
            ElementType::I32 => out[0].to_vec::<i32>()?.into_iter().map(i64::from).collect(),
            other => return Err(worker_error(&format!("Unexpected codec output type {other:?}."))),
        };
        let n_vq = info.shape.last().copied().unwrap_or(1).max(1) as usize;
        let codes = flat[..n_frames.min(flat.len() / n_vq) * n_vq].to_vec();
        trace.line("codes", || {
            let bytes: Vec<u8> = codes.iter().flat_map(|c| c.to_le_bytes()).collect();
            json!([Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>(), codes.len()])
        });
        Ok((emb, codes))
    }
}

/// `clone_preview(payload, output_dir, progress)`: the reference as a cloned `tts` enrolls it (the `clone_reference` crop, VieNeu's
/// silence trim, its first 8 s and its denoiser), saved as a 44.1 kHz PCM_24 WAV.
pub fn clone_preview(
    payload: &Map<String, Json>,
    output_dir: &Path,
    progress: &dyn Fn(f64, &str),
    site_packages: &Path,
) -> Result<Json> {
    let type_error = || WorkerError::py("TypeError", "expected str, bytes or os.PathLike object");
    // `x or default` for a str value; another truthy value is not a path
    let text_or = |key: &str, default: String| match payload.get(key) {
        Some(Json::String(s)) if !s.is_empty() => Ok(s.clone()),
        Some(v) if crate::pyfmt::truthy(v) => Err(type_error()),
        _ => Ok(default),
    };
    let model_dir = match payload.get("model_path") {
        None => PathBuf::new(),
        Some(Json::String(s)) => PathBuf::from(s),
        Some(_) => return Err(type_error()),
    };
    crate::download::verify_model(&model_dir, Some("vieneu-v3"))?;
    let reference = text_or("reference_path", String::new())?;
    if reference.is_empty() || !Path::new(&reference).is_file() {
        return Err(WorkerError::new("INPUT_MISSING", "Reference voice file is missing."));
    }
    // Python imports soundfile and onnxruntime here
    let io = Io::load(site_packages, None)?;
    let env = Env::load(&crate::health::ort_dll_path(), "thanham-clone")?;
    std::fs::create_dir_all(output_dir).map_err(|e| WorkerError::py("OSError", e))?;
    let final_path = contained_path(output_dir, &text_or("output_name", format!("{}.wav", uuid::Uuid::new_v4()))?)?;
    let stem = final_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let partial = final_path.with_file_name(format!("{stem}.partial.wav"));
    progress(0.1, "Cleaning the voice sample");
    let trace = Trace::from_env();
    let result = (|| -> Result<usize> {
        let (mut wav, sr) = io.cleaned(&io.crop(&py_path(&reference), &trace), &trace)?;
        wav.truncate((CLONE_SECONDS * f64::from(sr)) as usize);
        // OnnxDenoiser(path): ORT's default session options
        let denoiser =
            Denoiser::new(&env, &model_dir.join("backbone").join("denoiser.onnx"), &SessionOptions::new(&env)?)?;
        let clean = denoiser.denoise(&io, &wav, sr, &trace)?;
        io.snd.write(&partial.to_string_lossy(), &clean, WAV_RATE, Subtype::Pcm24)?;
        replace_with_retry(&partial, &final_path).map_err(|e| WorkerError::py("OSError", e))?;
        Ok(clean.len())
    })();
    let _ = std::fs::remove_file(&partial);
    let samples = result?;
    Ok(json!({"path": final_path.to_string_lossy(), "duration_ms": (samples as f64 / 44.1).round_ties_even() as i64,
        "sample_rate": WAV_RATE}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complex_abs_follows_numpy() {
        // |3 + 4i| = 5 either way; a ratio whose square is inexact shows the fused and unfused roundings apart
        assert_eq!(np_cabs(3.0, -4.0, true), 5.0);
        assert_eq!(np_cabs(0.0, 0.0, false), 0.0);
        let (a, b) = (np_cabs(1.0, 0.1, true), np_cabs(1.0, 0.1, false));
        assert!((a - b).abs() <= f64::EPSILON * 2.0);
    }

    #[test]
    fn window_keeps_short_clips_whole_and_finds_speech() {
        assert_eq!(clone_window(&vec![0.1f32; 16000 * 8], 16000), (0, 128000));
        // 4 s of silence, then 10 s of a tone: the window starts 2 frames (40 ms) before the speech
        let mut audio = vec![0.0f32; 16000 * 4];
        audio.extend((0..16000 * 10).map(|i| (i as f32 * 0.05).sin() * 0.5));
        assert_eq!(clone_window(&audio, 16000), (64000 - 640, 64000 - 640 + 128000));
    }

    #[test]
    fn trim_drops_silent_edges() {
        let mut y = vec![0.0f32; 10000];
        y.extend(vec![0.5f32; 10000]);
        y.extend(vec![0.0f32; 10000]);
        let (t0, t1) = trim(&y);
        assert!((1..=10000).contains(&t0) && (20000..30000).contains(&t1), "{t0} {t1}");
        assert_eq!(t0 % 512, 0);
    }
}
