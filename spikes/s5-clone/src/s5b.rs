//! S5b isolation: which denoiser STFT / iSTFT sub-step stops being bitwise equal to numpy, given numpy's own intermediates.
//!
//! Every stage here receives the exact input numpy produced for it (recorded by `py/recstft.py` into `rec-stft/<ref>/`), so a
//! mismatch is caused by that stage alone.

use std::error::Error;
use std::path::Path;

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;
use serde_json::{json, Value};

use crate::denoise::{hann_periodic, np_cabs, np_complex_product, HOP, N_FFT};
use crate::npy::Npy;
use crate::pf;

type BoxError = Box<dyn Error>;

fn diff64(a: &[f64], b: &[f64]) -> Value {
    let (mut n, mut max_abs) = (0usize, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        if x.to_bits() != y.to_bits() {
            n += 1;
            max_abs = max_abs.max((x - y).abs());
        }
    }
    json!({"n": a.len().min(b.len()), "n_diff": n, "max_abs": max_abs, "bitwise": a.len() == b.len() && n == 0})
}

fn diff32(a: &[f32], b: &[f32]) -> Value {
    let (mut n, mut max_abs) = (0usize, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        if x.to_bits() != y.to_bits() {
            n += 1;
            max_abs = max_abs.max((f64::from(*x) - f64::from(*y)).abs());
        }
    }
    json!({"n": a.len().min(b.len()), "n_diff": n, "max_abs": max_abs, "bitwise": a.len() == b.len() && n == 0})
}

/// Runs every isolation check for one reference. `dir` is `rec-stft/<ref>`, `rec` is `rec/<ref>`.
pub fn iso(dir: &Path, rec: &Path) -> Result<Value, BoxError> {
    let f64s = |n: &str| -> Result<Vec<f64>, BoxError> { Ok(Npy::read(&dir.join(format!("{n}.npy")))?.f64s()?) };
    let f32s = |n: &str| -> Result<Vec<f32>, BoxError> { Ok(Npy::read(&dir.join(format!("{n}.npy")))?.f32s()?) };
    let bins = N_FFT / 2 + 1;
    let win = hann_periodic();
    let x = f32s("x")?;
    let frames_py = f64s("frames_w")?;
    let frames = frames_py.len() / N_FFT;
    let mut out = serde_json::Map::new();

    // 1. reflect padding, framing and window
    let pad = N_FFT / 2;
    let n = x.len();
    let mut xp: Vec<f32> = (1..=pad).rev().map(|i| x[i]).collect();
    xp.extend_from_slice(&x);
    xp.extend((1..=pad).map(|i| x[n - 1 - i]));
    let mut fw = vec![0.0f64; frames * N_FFT];
    for t in 0..frames {
        for i in 0..N_FFT {
            fw[t * N_FFT + i] = f64::from(xp[t * HOP + i]) * win[i];
        }
    }
    out.insert("frames_window".into(), diff64(&fw, &frames_py));

    // 2. forward FFT of numpy's windowed frames: pocketfft (numpy's) and realfft (contrast)
    let spec_py = f64s("spec")?; // (bins, frames, 2)
    let pf_spec = pf::rfft_f64(&frames_py, frames, N_FFT);
    let mut real_spec = vec![0.0f64; frames * bins * 2];
    {
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(N_FFT);
        let mut input = fft.make_input_vec();
        let mut spectrum = fft.make_output_vec();
        for t in 0..frames {
            input.copy_from_slice(&frames_py[t * N_FFT..(t + 1) * N_FFT]);
            fft.process(&mut input, &mut spectrum).map_err(|e| e.to_string())?;
            for k in 0..bins {
                real_spec[(t * bins + k) * 2] = spectrum[k].re;
                real_spec[(t * bins + k) * 2 + 1] = spectrum[k].im;
            }
        }
    }
    let to_kt = |v: &[f64]| -> Vec<f64> {
        let mut o = vec![0.0f64; bins * frames * 2];
        for t in 0..frames {
            for k in 0..bins {
                for c in 0..2 {
                    o[(k * frames + t) * 2 + c] = v[(t * bins + k) * 2 + c];
                }
            }
        }
        o
    };
    out.insert("fft_pocketfft_numpy".into(), diff64(&to_kt(&pf_spec), &spec_py));
    out.insert("fft_realfft".into(), diff64(&to_kt(&real_spec), &spec_py));

    // 3. libm and spectrum functions, given numpy's spectrum / phase
    let (mag_py, phi_py, cos_py, sin_py) = (f64s("mag")?, f64s("phi")?, f64s("cos64")?, f64s("sin64")?);
    let re = |i: usize| spec_py[i * 2];
    let im = |i: usize| spec_py[i * 2 + 1];
    let m = bins * frames;
    let mag_hypot: Vec<f64> = (0..m).map(|i| re(i).hypot(im(i))).collect();
    let mag_fma: Vec<f64> = (0..m).map(|i| np_cabs(re(i), im(i), true)).collect();
    let mag_split: Vec<f64> = (0..m).map(|i| np_cabs(re(i), im(i), false)).collect();
    out.insert("abs_hypot".into(), diff64(&mag_hypot, &mag_py));
    out.insert("abs_numpy_formula_fma".into(), diff64(&mag_fma, &mag_py));
    out.insert("abs_numpy_formula_split".into(), diff64(&mag_split, &mag_py));
    let phi: Vec<f64> = (0..m).map(|i| im(i).atan2(re(i))).collect();
    out.insert("atan2".into(), diff64(&phi, &phi_py));
    let cos: Vec<f64> = phi_py.iter().map(|p| p.cos()).collect();
    let sin: Vec<f64> = phi_py.iter().map(|p| p.sin()).collect();
    out.insert("cos".into(), diff64(&cos, &cos_py));
    out.insert("sin".into(), diff64(&sin, &sin_py));
    // the f32 values ORT actually receives
    let f = |v: &[f64]| -> Vec<f32> { v.iter().map(|&a| a as f32).collect() };
    let cast_py = (f(&mag_py), f(&cos_py), f(&sin_py));
    let cast_rs = (f(&mag_fma), f(&cos), f(&sin));
    out.insert("ort_in_mag_from_numpy_spec".into(), diff32(&cast_rs.0, &cast_py.0));
    out.insert("ort_in_cos_from_numpy_phi".into(), diff32(&cast_rs.1, &cast_py.1));
    out.insert("ort_in_sin_from_numpy_phi".into(), diff32(&cast_rs.2, &cast_py.2));

    // 4a. the complex product sep_mag * (sep_cos + 1j * sep_sin) in complex64, signed zeros included
    let spec2 = f32s("spec2c")?; // (bins, t, 2)
    let t_total = spec2.len() / (bins * 2);
    let sep = |n: &str| -> Result<Vec<f32>, BoxError> { Ok(Npy::read(&rec.join(format!("den_sep_{n}.npy")))?.f32s()?) };
    let (sm, sc, ss) = (sep("mag")?, sep("cos")?, sep("sin")?);
    let mut prod = vec![0.0f32; bins * t_total * 2];
    for t in 0..t_total {
        let src = t.min(frames - 1);
        for k in 0..bins {
            let (re, im) = np_complex_product(sm[k * frames + src], sc[k * frames + src], ss[k * frames + src]);
            prod[(k * t_total + t) * 2] = re;
            prod[(k * t_total + t) * 2 + 1] = im;
        }
    }
    out.insert("complex_product".into(), diff32(&prod, &spec2));
    let zeros = sm.iter().filter(|&&v| v == 0.0).count();
    out.insert("sep_mag_exact_zeros".into(), json!(zeros));

    // 4b. inverse FFT of numpy's complex64 spectrum
    let mut rows = vec![0.0f32; t_total * bins * 2];
    for t in 0..t_total {
        for k in 0..bins {
            for c in 0..2 {
                rows[(t * bins + k) * 2 + c] = spec2[(k * t_total + t) * 2 + c];
            }
        }
    }
    let irf_py = f32s("irfft32")?; // (t, N_FFT)
    let irf_pf = pf::irfft_f32(&rows, t_total, bins, N_FFT);
    out.insert("ifft_pocketfft_numpy_f32".into(), diff32(&irf_pf, &irf_py));
    let mut irf_real = vec![0.0f32; t_total * N_FFT];
    {
        let mut planner = RealFftPlanner::<f32>::new();
        let c2r = planner.plan_fft_inverse(N_FFT);
        let scale = (1.0f64 / N_FFT as f64) as f32;
        let mut spec = vec![Complex::new(0.0f32, 0.0); bins];
        let mut time = vec![0.0f32; N_FFT];
        for t in 0..t_total {
            for k in 0..bins {
                spec[k] = Complex::new(rows[(t * bins + k) * 2], rows[(t * bins + k) * 2 + 1]);
            }
            spec[0].im = 0.0;
            spec[bins - 1].im = 0.0;
            c2r.process(&mut spec, &mut time).map_err(|e| e.to_string())?;
            for j in 0..N_FFT {
                irf_real[t * N_FFT + j] = time[j] * scale;
            }
        }
    }
    out.insert("ifft_realfft_f32".into(), diff32(&irf_real, &irf_py));

    // 5. window, overlap-add, normalisation and the final scaling, given numpy's irfft output
    let siglen = N_FFT + HOP * (t_total - 1);
    let (mut acc, mut wsum) = (vec![0.0f64; siglen], vec![0.0f64; siglen]);
    let w2: Vec<f64> = win.iter().map(|w| w * w).collect();
    for t in 0..t_total {
        for j in 0..N_FFT {
            acc[t * HOP + j] += f64::from(irf_py[t * N_FFT + j]) * win[j];
            wsum[t * HOP + j] += w2[j];
        }
    }
    out.insert("overlap_add".into(), diff64(&acc, &f64s("acc")?));
    out.insert("window_sum".into(), diff64(&wsum, &f64s("wsum")?));
    let mut res: Vec<f64> = (pad..siglen - pad).map(|j| acc[j] / wsum[j].max(1e-11)).collect();
    res.resize(x.len(), 0.0);
    res.truncate(x.len());
    out.insert("normalise".into(), diff64(&res, &f64s("res")?));
    let wav = Npy::read(&rec.join("soxr_to44k_out.npy"))?.f32s()?;
    let peak = wav.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    let abs_max = f64::from(peak).max(1e-7);
    let fin: Vec<f32> = res[..wav.len()].iter().map(|&v| (v * abs_max) as f32).collect();
    out.insert("final_scale".into(), diff32(&fin, &f32s("out")?));
    Ok(Value::Object(out))
}
