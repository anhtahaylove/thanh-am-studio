//! Speaker-encoder front end: `extract_speaker_fbank` of VieNeu (resample to 16 kHz, kaldi-native-fbank 80 bins, mean norm).
//! The Kaldi fbank itself is kaldi-native-fbank 1.23.0 built from source (see `build.rs`) through a one-function C shim.

use crate::resample::{Quality, Resampler};

/// `(16 kHz signal, raw features, mean-normalised features)`.
pub type SpeakerFbank = (Vec<f32>, Vec<f32>, Vec<f32>);

extern "C" {
    fn s5_knf_fbank(
        wav: *const f32,
        n: i32,
        sample_rate: i32,
        n_mels: i32,
        dither: f32,
        out: *mut f32,
        max_frames: i32,
    ) -> i32;
}

/// Raw fbank features, `frames * n_mels`, row-major.
pub fn kaldi_fbank(wav: &[f32], sample_rate: u32, n_mels: usize) -> Result<Vec<f32>, String> {
    let max_frames = wav.len() / 160 + 4;
    let mut out = vec![0.0f32; max_frames * n_mels];
    // SAFETY: `wav` is valid for `wav.len()` floats and `out` for `max_frames * n_mels`; the shim writes at most that many.
    let frames = unsafe {
        s5_knf_fbank(
            wav.as_ptr(),
            wav.len() as i32,
            sample_rate as i32,
            n_mels as i32,
            0.0,
            out.as_mut_ptr(),
            max_frames as i32,
        )
    };
    if frames <= 0 {
        return Err(format!("Audio too short for fbank ({} samples @ {sample_rate} Hz < one 25 ms frame).", wav.len()));
    }
    out.truncate(frames as usize * n_mels);
    Ok(out)
}

/// `features - features.mean(axis=0)` for a `(frames, n_mels)` float32 matrix: numpy adds the rows one after another per column.
pub fn mean_norm(features: &mut [f32], n_mels: usize) {
    let frames = features.len() / n_mels;
    let mut mean = vec![0.0f32; n_mels];
    for row in features.chunks_exact(n_mels) {
        for (m, v) in mean.iter_mut().zip(row) {
            *m += v;
        }
    }
    for m in &mut mean {
        *m /= frames as f32;
    }
    for row in features.chunks_exact_mut(n_mels) {
        for (v, m) in row.iter_mut().zip(&mean) {
            *v -= m;
        }
    }
}

/// `extract_speaker_fbank(waveform, sample_rate=sr)`: mean-normalised `(frames, 80)` features at 16 kHz.
pub fn speaker_fbank(
    wav: &[f32],
    sr: u32,
    resampler: &dyn Resampler,
    quality: Quality,
) -> Result<SpeakerFbank, String> {
    let at16 = if sr == 16000 {
        wav.to_vec()
    } else {
        resampler.resample(wav, sr, 16000, quality).map_err(|e| e.to_string())?
    };
    let raw = kaldi_fbank(&at16, 16000, 80)?;
    let mut normed = raw.clone();
    mean_norm(&mut normed, 80);
    Ok((at16, raw, normed))
}
