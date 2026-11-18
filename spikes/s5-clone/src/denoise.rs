//! Port of VieNeu's `OnnxDenoiser.denoise` (vieneu/_v3_turbo_engine/onnx_denoiser.py): resample to 44.1 kHz, peak-normalise,
//! STFT (n_fft 1680, hop 420, periodic Hann, reflect padding), the `denoiser.onnx` core through `ortffi`, iSTFT.
//!
//! Types follow numpy: audio in float32, the STFT window and spectrum in float64 (so `mag`, `cos`, `sin` are f64 values cast to
//! float32 for ORT), the ORT outputs and the iSTFT input in float32 (numpy 2 computes `irfft` of complex64 in float32), the
//! overlap-add in float64.

use std::path::Path;
use std::sync::Arc;

use ortffi::{Env, GraphOptimizationLevel, Session, SessionOptions};
use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

use crate::resample::{Quality, Resampler};

const N_FFT: usize = 1680;
const HOP: usize = 420;
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

fn hann_periodic() -> Vec<f64> {
    (0..N_FFT).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()).collect()
}

impl Denoiser {
    /// Loads `denoiser.onnx` with the session options VieNeu uses for its auxiliary sessions.
    pub fn new(env: &Env, onnx: &Path, intra_threads: i32) -> Result<Denoiser, ortffi::Error> {
        let mut options = SessionOptions::new(env)?;
        options.graph_optimization_level(GraphOptimizationLevel::All)?;
        options.inter_op_threads(1)?;
        options.config_entry("session.intra_op.allow_spinning", "0")?;
        options.intra_op_threads(intra_threads)?;
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
        let abs_max = f64::from(peak).max(1e-7) as f32; // python float, weakly typed into float32 arithmetic
        let mut w: Vec<f32> = resampled.iter().map(|&v| v / abs_max).collect();
        w.extend(std::iter::repeat(0.0).take(441));

        // _forward: _normalize, STFT
        let peak2 = w.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
        let divisor = peak2 + 1e-7f32;
        let x: Vec<f32> = w.iter().map(|&v| v / divisor).collect();
        let (mag, cos, sin, frames) = self.stft(&x);
        let [sep_mag, sep_cos, sep_sin] = self.core(&mag, &cos, &sin, frames)?;

        let o = self.istft(&sep_mag, &sep_cos, &sep_sin, frames, x.len(), irfft);
        let out: Vec<f32> = o[..length].iter().map(|&v| (v * f64::from(abs_max)) as f32).collect();
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
        let frames = n_frames - 1; // last frame dropped
        let bins = N_FFT / 2 + 1;
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(N_FFT);
        let mut input = fft.make_input_vec();
        let mut spectrum = fft.make_output_vec();
        let mut scratch = fft.make_scratch_vec();
        let (mut mag, mut cos, mut sin) =
            (vec![0f32; bins * frames], vec![0f32; bins * frames], vec![0f32; bins * frames]);
        for t in 0..frames {
            for i in 0..N_FFT {
                input[i] = f64::from(xp[t * HOP + i]) * self.window[i];
            }
            fft.process_with_scratch(&mut input, &mut spectrum, &mut scratch).expect("fft sizes");
            for (k, c) in spectrum.iter().enumerate() {
                let phi = c.im.atan2(c.re);
                mag[k * frames + t] = c.re.hypot(c.im) as f32;
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
        let mut planner32 = RealFftPlanner::<f32>::new();
        let mut planner64 = RealFftPlanner::<f64>::new();
        let c2r32 = planner32.plan_fft_inverse(N_FFT);
        let c2r64 = planner64.plan_fft_inverse(N_FFT);
        let siglen = N_FFT + HOP * (t_total - 1);
        let mut out = vec![0.0f64; siglen];
        let mut wsum = vec![0.0f64; siglen];
        let w2: Vec<f64> = self.window.iter().map(|w| w * w).collect();
        let scale32 = (1.0f64 / N_FFT as f64) as f32;
        let scale64 = 1.0f64 / N_FFT as f64;
        let mut spec32 = vec![Complex::new(0.0f32, 0.0); bins];
        let mut spec64 = vec![Complex::new(0.0f64, 0.0); bins];
        let mut time32 = vec![0.0f32; N_FFT];
        let mut time64 = vec![0.0f64; N_FFT];
        for i in 0..t_total {
            let src = std::cmp::min(i, frames - 1);
            for k in 0..bins {
                let (m, c, s) = (sep_mag[k * frames + src], sep_cos[k * frames + src], sep_sin[k * frames + src]);
                // complex64 product (m + 0j) * (c + sj): real m*c - 0*s, imag m*s + 0*c, each rounded to float32
                let (re, im) = (m * c, m * s);
                spec32[k] = Complex::new(re, im);
                spec64[k] = Complex::new(f64::from(re), f64::from(im));
            }
            spec32[0].im = 0.0;
            spec32[bins - 1].im = 0.0;
            spec64[0].im = 0.0;
            spec64[bins - 1].im = 0.0;
            let frame: Vec<f64> = match irfft {
                Irfft::F32 => {
                    c2r32.process(&mut spec32, &mut time32).expect("fft sizes");
                    time32.iter().map(|&v| f64::from(v * scale32)).collect()
                }
                Irfft::F64 => {
                    c2r64.process(&mut spec64, &mut time64).expect("fft sizes");
                    time64.iter().map(|&v| v * scale64).collect()
                }
            };
            let s = i * HOP;
            for j in 0..N_FFT {
                out[s + j] += frame[j] * self.window[j];
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
