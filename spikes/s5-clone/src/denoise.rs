//! Port of VieNeu's `OnnxDenoiser.denoise` (vieneu/_v3_turbo_engine/onnx_denoiser.py): resample to 44.1 kHz, peak-normalise,
//! STFT (n_fft 1680, hop 420, periodic Hann, reflect padding), the `denoiser.onnx` core through `ortffi`, iSTFT.
//!
//! Bitwise equal to numpy 2.4.6 (S5b): the FFTs are numpy's own pocketfft C++ (`crate::pf`), `abs` is numpy's SIMD complex
//! absolute (not `hypot`), `atan2`/`cos`/`sin` are the C runtime's, as numpy's float64 loops call them.
//!
//! Types follow numpy: audio in float32, the STFT window and spectrum in float64 (so `mag`, `cos`, `sin` are f64 values cast to
//! float32 for ORT), the ORT outputs and the iSTFT input in float32 (numpy 2 computes `irfft` of complex64 in float32), the
//! overlap-add in float64.

use std::path::Path;
use std::sync::Arc;

use crate::pf;
use crate::resample::{Quality, Resampler};
use ortffi::{Env, GraphOptimizationLevel, Session, SessionOptions};

/// STFT size.
pub const N_FFT: usize = 1680;
/// STFT hop.
pub const HOP: usize = 420;
const WAV_RATE: u32 = 44100;

/// Precision of the inverse FFT inside the iSTFT. numpy 2 uses float32 for complex64 input; numpy 1 used float64.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Irfft {
    /// float32 (what the reference runtime does).
    F32,
    /// float64.
    F64,
}

/// Everything the denoiser computes, for stage-by-stage comparison with the recorder.
pub struct Denoised {
    /// Final float32 output at 44.1 kHz.
    pub out: Vec<f32>,
    /// Input resampled to 44.1 kHz (equal to the input when it was already 44.1 kHz).
    pub resampled: Vec<f32>,
    /// ORT inputs `mag`, `cos`, `sin` as float32, shape `(841, frames)` row-major.
    pub core_in: [Vec<f32>; 3],
    /// ORT outputs `sep_mag`, `sep_cos`, `sep_sin`, same shape.
    pub core_out: [Vec<f32>; 3],
    /// Number of STFT frames given to ORT.
    pub frames: usize,
}

/// The ONNX denoiser.
pub struct Denoiser {
    env: Env,
    session: Session,
    window: Arc<Vec<f64>>,
}

/// `0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)`.
pub fn hann_periodic() -> Vec<f64> {
    (0..N_FFT).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()).collect()
}

/// Whether numpy's runtime dispatch picks a target with fused multiply-add for `np.abs(complex128)`: its `loops_unary_complex`
/// dispatch targets are X86_V4, X86_V3 and X86_V2, and only V2 lacks FMA3. V3 means AVX, AVX2, FMA3, F16C, BMI1/2, LZCNT, MOVBE.
pub fn numpy_abs_is_fused() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c")
            && std::arch::is_x86_feature_detected!("bmi1")
            && std::arch::is_x86_feature_detected!("bmi2")
            && std::arch::is_x86_feature_detected!("lzcnt")
            && std::arch::is_x86_feature_detected!("movbe")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

/// numpy's SIMD `np.abs` of a complex128 value (`simd_cabsolute_f64`): `larger * sqrt(1 + (smaller / larger)^2)`, with a fused
/// multiply-add when numpy's dispatched target has one. Finite inputs only (the denoiser's spectra always are).
pub fn np_cabs(re: f64, im: f64, fused: bool) -> f64 {
    let (re, im) = (re.abs(), im.abs());
    let (larger, smaller) = (re.max(im), re.min(im));
    let ratio = if larger == 0.0 { 0.0 } else { smaller / larger };
    let s = if fused { ratio.mul_add(ratio, 1.0) } else { ratio * ratio + 1.0 };
    s.sqrt() * larger
}

/// `sep_mag * (sep_cos + 1j * sep_sin)` for float32 operands, step by step as numpy evaluates it in complex64 (each operand is
/// promoted to `x + 0j`), so that signed zeros come out the same.
pub fn np_complex_product(m: f32, c: f32, s: f32) -> (f32, f32) {
    let (t_re, t_im) = (0.0f32 * s - 1.0 * 0.0, 0.0f32 * 0.0 + 1.0 * s); // 1j * s
    let (u_re, u_im) = (c + t_re, 0.0f32 + t_im); // c + (1j * s)
    (m * u_re - 0.0 * u_im, m * u_im + 0.0 * u_re) // m * u
}

impl Denoiser {
    /// Loads `denoiser.onnx` with the session options VieNeu uses for its auxiliary sessions (`intra_threads > 0`), or with ORT's
    /// defaults (`intra_threads <= 0`).
    pub fn new(env: &Env, onnx: &Path, intra_threads: i32) -> Result<Denoiser, ortffi::Error> {
        let mut options = SessionOptions::new(env)?;
        if intra_threads > 0 {
            options.graph_optimization_level(GraphOptimizationLevel::All)?;
            options.inter_op_threads(1)?;
            options.config_entry("session.intra_op.allow_spinning", "0")?;
            options.intra_op_threads(intra_threads)?;
        } // else: ORT's default session, as `OnnxDenoiser(path)` creates it in the worker's clone_preview
        let session = Session::from_file(env, onnx, &options)?;
        Ok(Denoiser { env: env.clone(), session, window: Arc::new(hann_periodic()) })
    }

    /// The numpy-equivalent Hann window (for the fixture comparison).
    pub fn window(&self) -> &[f64] {
        &self.window
    }

    /// `OnnxDenoiser.denoise(wav, sr)`.
    pub fn denoise(
        &self,
        wav: &[f32],
        sr: u32,
        resampler: &dyn Resampler,
        quality: Quality,
        irfft: Irfft,
    ) -> Result<Denoised, Box<dyn std::error::Error>> {
        let resampled = if sr == WAV_RATE { wav.to_vec() } else { resampler.resample(wav, sr, WAV_RATE, quality)? };
        let length = resampled.len();
        let peak = resampled.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
        let abs_max = f64::from(peak).max(1e-7); // a python float: float32 in `wav / abs_max`, float64 in `o * abs_max`
        let mut w: Vec<f32> = resampled.iter().map(|&v| v / abs_max as f32).collect();
        w.extend(std::iter::repeat(0.0).take(441));

        // _forward: _normalize, STFT
        let peak2 = w.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
        let divisor = peak2 + 1e-7f32;
        let x: Vec<f32> = w.iter().map(|&v| v / divisor).collect();
        let (mag, cos, sin, frames) = self.stft(&x);
        let [sep_mag, sep_cos, sep_sin] = self.core(&mag, &cos, &sin, frames)?;

        let o = self.istft(&sep_mag, &sep_cos, &sep_sin, frames, x.len(), irfft);
        let out: Vec<f32> = o[..length].iter().map(|&v| (v * abs_max) as f32).collect();
        Ok(Denoised { out, resampled, core_in: [mag, cos, sin], core_out: [sep_mag, sep_cos, sep_sin], frames })
    }

    /// The `denoiser.onnx` core on `(841, frames)` float32 tensors: returns `sep_mag`, `sep_cos`, `sep_sin`.
    pub fn core(&self, mag: &[f32], cos: &[f32], sin: &[f32], frames: usize) -> Result<[Vec<f32>; 3], ortffi::Error> {
        let shape = [1, (N_FFT / 2 + 1) as i64, frames as i64];
        let v_mag = self.env.tensor(mag, &shape)?;
        let v_cos = self.env.tensor(cos, &shape)?;
        let v_sin = self.env.tensor(sin, &shape)?;
        let names: Vec<String> = self.session.outputs().iter().map(|o| o.name.clone()).collect();
        let names_ref: Vec<&str> = names.iter().map(String::as_str).collect();
        let outs = self.session.run(&[("mag", &v_mag), ("cos", &v_cos), ("sin", &v_sin)], &names_ref)?;
        Ok([outs[0].to_vec::<f32>()?, outs[1].to_vec::<f32>()?, outs[2].to_vec::<f32>()?])
    }

    /// `_stft` plus `abs`, `angle`, `cos`, `sin`, cast to float32 as `_core` does. Returns `(mag, cos, sin, frames)`.
    fn stft(&self, x: &[f32]) -> (Vec<f32>, Vec<f32>, Vec<f32>, usize) {
        let pad = N_FFT / 2;
        let n = x.len();
        // np.pad(mode="reflect"): mirror without repeating the edge sample
        let mut xp = Vec::with_capacity(n + 2 * pad);
        xp.extend((1..=pad).rev().map(|i| x[i]));
        xp.extend_from_slice(x);
        xp.extend((1..=pad).map(|i| x[n - 1 - i]));
        let n_frames = 1 + (xp.len() - N_FFT) / HOP;
        let frames = n_frames - 1; // last frame dropped (numpy transforms it too, but rows are independent)
        let bins = N_FFT / 2 + 1;
        let mut windowed = vec![0.0f64; frames * N_FFT];
        for t in 0..frames {
            for i in 0..N_FFT {
                windowed[t * N_FFT + i] = f64::from(xp[t * HOP + i]) * self.window[i];
            }
        }
        let spec = pf::rfft_f64(&windowed, frames, N_FFT);
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

    /// `_istft(sep_mag * (sep_cos + 1j * sep_sin), out_len)`.
    fn istft(
        &self,
        sep_mag: &[f32],
        sep_cos: &[f32],
        sep_sin: &[f32],
        frames: usize,
        out_len: usize,
        irfft: Irfft,
    ) -> Vec<f64> {
        let bins = N_FFT / 2 + 1;
        let t_total = frames + 1; // the last frame is replicated
        let siglen = N_FFT + HOP * (t_total - 1);
        let mut out = vec![0.0f64; siglen];
        let mut wsum = vec![0.0f64; siglen];
        let w2: Vec<f64> = self.window.iter().map(|w| w * w).collect();
        let mut spec32 = vec![0.0f32; t_total * bins * 2];
        for i in 0..t_total {
            let src = std::cmp::min(i, frames - 1);
            for k in 0..bins {
                let (m, c, s) = (sep_mag[k * frames + src], sep_cos[k * frames + src], sep_sin[k * frames + src]);
                let (re, im) = np_complex_product(m, c, s);
                spec32[(i * bins + k) * 2] = re;
                spec32[(i * bins + k) * 2 + 1] = im;
            }
        }
        let time: Vec<f64> = match irfft {
            Irfft::F32 => pf::irfft_f32(&spec32, t_total, bins, N_FFT).into_iter().map(f64::from).collect(),
            Irfft::F64 => {
                let spec64: Vec<f64> = spec32.iter().map(|&v| f64::from(v)).collect();
                pf::irfft_f64(&spec64, t_total, bins, N_FFT)
            }
        };
        for i in 0..t_total {
            let s = i * HOP;
            for j in 0..N_FFT {
                out[s + j] += time[i * N_FFT + j] * self.window[j];
                wsum[s + j] += w2[j];
            }
        }
        let pad = N_FFT / 2;
        let mut res: Vec<f64> = (pad..siglen - pad).map(|j| out[j] / wsum[j].max(1e-11)).collect();
        if res.len() < out_len {
            res.resize(out_len, 0.0);
        }
        res.truncate(out_len);
        res
    }
}
