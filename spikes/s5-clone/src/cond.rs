//! The Rust clone-conditioning path, step for step as `s5pipe.py` records the Python one:
//! decode, window, crop, trim (+ the PCM_16 round trip of `_preclean_reference_audio`), cap, denoise, speaker embedding,
//! codec codes. Intermediates are returned so every stage can be compared with the recorder.

use std::path::Path;

use ortffi::{ElementType, Env, GraphOptimizationLevel, Session, SessionOptions};

use crate::denoise::{Denoised, Denoiser, Irfft};
use crate::fbank::speaker_fbank;
use crate::resample::{Quality, Resampler};
use crate::wav::{self, Wav};
use crate::{trim, window};

/// Samples per codec frame at 48 kHz (`CODEC_SAMPLES_PER_FRAME`).
pub const CODEC_FRAME: usize = 3840;
/// Codec rate.
pub const CODEC_RATE: u32 = 48000;
/// Seconds of the cleaned clip that conditioning uses (`_MAX_REF_SECONDS`).
pub const MAX_REF_SECONDS: f64 = 8.0;
/// Scale of the libsndfile float to int16 conversion (measured, see `wav::quantize_i16`).
pub const PCM16_WRITE_SCALE: f32 = 32768.0;

type BoxError = Box<dyn std::error::Error>;
/// `(16 kHz signal, raw fbank, normalised fbank, embedding)`.
pub type SpeakerOut = (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>);
/// `(48 kHz signal, stereo codec input, codes, frames)`.
pub type CodecOut = (Vec<f32>, Vec<f32>, Vec<i64>, usize);
/// `(window, crop frames, trim, pcm16, capped)`.
pub type CleanOut = ((usize, usize), usize, (usize, usize), Vec<f32>, Vec<f32>);

/// The three ONNX sessions plus the resampler and the knobs that the K-cond variants exercise.
pub struct Conditioner<'r> {
    env: Env,
    denoiser: Denoiser,
    speaker: Session,
    codec_enc: Session,
    /// Resampler backend.
    pub resampler: &'r dyn Resampler,
    /// soxr quality for every resample call (python-soxr default: HQ).
    pub quality: Quality,
    /// Inverse FFT precision inside the denoiser.
    pub irfft: Irfft,
}

/// Every intermediate of one conditioning run.
pub struct Conditioned {
    /// Source sample rate.
    pub sr0: u32,
    /// Source channel count.
    pub channels: usize,
    /// Window chosen by `clone_window` (on the mono mix).
    pub window: (usize, usize),
    /// Frames of the crop given to the trim stage.
    pub crop_frames: usize,
    /// Trim bounds inside the crop's mono mix.
    pub trim: (usize, usize),
    /// Float32 mono signal after the PCM_16 write and read of `_preclean_reference_audio`.
    pub pcm16: Vec<f32>,
    /// Denoiser run (resampled input, ORT tensors, output).
    pub denoised: Denoised,
    /// Denoiser output resampled to 16 kHz.
    pub to16k: Vec<f32>,
    /// Raw kaldi-native-fbank features (frames, 80).
    pub fbank_raw: Vec<f32>,
    /// Mean-normalised features.
    pub fbank: Vec<f32>,
    /// 192-d speaker embedding.
    pub emb: Vec<f32>,
    /// Denoiser output resampled to 48 kHz.
    pub to48k: Vec<f32>,
    /// Stereo codec input `(2, n_padded)`.
    pub codec_in: Vec<f32>,
    /// Final reference codes `(frames, 16)`.
    pub codes: Vec<i64>,
    /// Number of codec frames kept.
    pub code_frames: usize,
}

impl<'r> Conditioner<'r> {
    /// Creates the sessions from the model folder (`backbone/denoiser.onnx`, `backbone/speaker_encoder.onnx`,
    /// `codec/moss_audio_tokenizer_encode.onnx`) with the options of `OnnxV3LiteEngine.__init__`.
    pub fn new(env: &Env, model_dir: &Path, threads: i32, resampler: &'r dyn Resampler) -> Result<Self, BoxError> {
        let denoiser = Denoiser::new(env, &model_dir.join("backbone").join("denoiser.onnx"), threads)?;
        let session = |path: &Path| -> Result<Session, ortffi::Error> {
            let mut o = SessionOptions::new(env)?;
            o.graph_optimization_level(GraphOptimizationLevel::All)?;
            o.inter_op_threads(1)?;
            o.config_entry("session.intra_op.allow_spinning", "0")?;
            o.intra_op_threads(threads)?;
            Session::from_file(env, path, &o)
        };
        Ok(Conditioner {
            env: env.clone(),
            denoiser,
            speaker: session(&model_dir.join("backbone").join("speaker_encoder.onnx"))?,
            codec_enc: session(&model_dir.join("codec").join("moss_audio_tokenizer_encode.onnx"))?,
            resampler,
            quality: Quality::Hq,
            irfft: Irfft::F32,
        })
    }

    /// Hann window of the denoiser, for the fixture comparison.
    pub fn denoiser_window(&self) -> &[f64] {
        self.denoiser.window()
    }

    /// The denoiser's ORT core alone (teacher-forced test with Python's exact tensors).
    pub fn denoiser_core(
        &self,
        mag: &[f32],
        cos: &[f32],
        sin: &[f32],
        frames: usize,
    ) -> Result<[Vec<f32>; 3], ortffi::Error> {
        self.denoiser.core(mag, cos, sin, frames)
    }

    /// Denoiser stage alone (also used for teacher-forced stage tests).
    pub fn denoise(&self, mono: &[f32], sr: u32) -> Result<Denoised, BoxError> {
        self.denoiser.denoise(mono, sr, self.resampler, self.quality, self.irfft)
    }

    /// Speaker embedding of a mono clip at `sr` (the denoiser output). Returns
    /// `(16 kHz signal, raw fbank, normalised fbank, embedding)`.
    pub fn speaker_embedding(&self, mono: &[f32], sr: u32) -> Result<SpeakerOut, BoxError> {
        let cap = (30.0 * f64::from(sr)) as usize;
        let mono = if mono.len() > cap { &mono[..cap] } else { mono };
        let (at16, raw, normed) = speaker_fbank(mono, sr, self.resampler, self.quality)?;
        let frames = normed.len() / 80;
        let emb = {
            let input = self.env.tensor(&normed, &[1, frames as i64, 80])?;
            let out = self.speaker.run(&[("input", &input)], &["output"])?;
            out[0].to_vec::<f32>()?
        };
        Ok((at16, raw, normed, emb))
    }

    /// Codec reference codes of a mono clip at `sr` (`_encode_ref_wav`). Returns `(48 kHz signal, stereo input, codes, frames)`.
    pub fn codec_codes(&self, mono: &[f32], sr: u32) -> Result<CodecOut, BoxError> {
        let at48 = if sr == CODEC_RATE {
            mono.to_vec()
        } else {
            self.resampler.resample(mono, sr, CODEC_RATE, self.quality)?
        };
        let mut padded = at48.clone();
        if padded.len() % CODEC_FRAME != 0 {
            padded.resize(padded.len() + CODEC_FRAME - padded.len() % CODEC_FRAME, 0.0);
        }
        let n_frames = padded.len() / CODEC_FRAME;
        let mut stereo = padded.clone();
        stereo.extend_from_slice(&padded);
        let lengths = [padded.len() as i32];
        let (info, flat): (ortffi::TensorInfo, Vec<i64>) = {
            let wave = self.env.tensor(&stereo, &[1, 2, padded.len() as i64])?;
            let lens = self.env.tensor(&lengths, &[1])?;
            let out =
                self.codec_enc.run(&[("waveform", &wave), ("input_lengths", &lens)], &[self.codec_output_name()])?;
            let info = out[0].info()?;
            let flat = match info.element {
                ElementType::I64 => out[0].to_vec::<i64>()?,
                ElementType::I32 => out[0].to_vec::<i32>()?.into_iter().map(i64::from).collect(),
                other => return Err(format!("unexpected codec output type {other:?}").into()),
            };
            (info, flat)
        };
        let n_vq = *info.shape.last().ok_or("codec output has no shape")? as usize;
        let t_total = flat.len() / n_vq;
        let keep = n_frames.min(t_total);
        Ok((at48, stereo, flat[..keep * n_vq].to_vec(), keep))
    }

    fn codec_output_name(&self) -> &str {
        &self.codec_enc.outputs()[0].name
    }

    /// Window, crop, trim and the PCM_16 round trip (`clone_reference` + `_preclean_reference_audio`), then the 8 s cap:
    /// returns `(window, crop_frames, trim, pcm16, capped)`.
    pub fn clean(&self, wav: &Wav) -> Result<CleanOut, BoxError> {
        let sr = wav.sample_rate;
        let mono_full = wav::mean_channels(&wav.samples, wav.channels);
        let (start, end) = window::clone_window(&mono_full, sr);
        let frames = wav.samples.len() / wav.channels;
        let crop: &[f32] =
            if end - start >= frames { &wav.samples } else { &wav.samples[start * wav.channels..end * wav.channels] };
        // _preclean_reference_audio: channel mean, trim, PCM_16 write and read back
        let crop_mono = wav::mean_channels(crop, wav.channels);
        let (t0, t1) = trim::trim(&crop_mono, 30.0);
        let trimmed = &crop_mono[t0..t1];
        if trimmed.is_empty() {
            return Err("the trim removed the whole reference".into());
        }
        let pcm16: Vec<f32> =
            trimmed.iter().map(|&x| f32::from(wav::quantize_i16(x, PCM16_WRITE_SCALE)) / 32768.0).collect();
        let cap = (MAX_REF_SECONDS * f64::from(sr)) as usize;
        let capped = if pcm16.len() > cap { pcm16[..cap].to_vec() } else { pcm16.clone() };
        Ok(((start, end), crop.len() / wav.channels, (t0, t1), pcm16, capped))
    }

    /// The whole path from the decoded reference to `(embedding, codes)`.
    pub fn condition(&self, wav: &Wav) -> Result<Conditioned, BoxError> {
        let sr = wav.sample_rate;
        let (window, crop_frames, trim, pcm16, capped) = self.clean(wav)?;
        // prepare_reference: denoise, embedding, codes
        let denoised = self.denoise(&capped, sr)?;
        let (to16k, fbank_raw, fbank, emb) = self.speaker_embedding(&denoised.out, 44100)?;
        let (to48k, codec_in, codes, code_frames) = self.codec_codes(&denoised.out, 44100)?;
        Ok(Conditioned {
            sr0: sr,
            channels: wav.channels,
            window,
            crop_frames,
            trim,
            pcm16,
            denoised,
            to16k,
            fbank_raw,
            fbank,
            emb,
            to48k,
            codec_in,
            codes,
            code_frames,
        })
    }
}
