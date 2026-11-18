//! The VieNeu v3 Turbo numpy head: x-vector anchor, per-channel audio logits, the text (end-of-speech) logits and the sampler, mirroring
//! `vieneu/_v3_turbo_engine/onnx_runtime_lite.py` (`_speaker_anchor`:225, `_sample`:252, `_acoustic_frame`:327) operation by operation.

use super::blas::OpenBlas;
use super::mt19937::Mt19937;
use super::npy::{npz_member, Npy};
use super::{np, sort};
use std::collections::VecDeque;
use std::io;
use std::path::Path;

/// Audio codebooks.
pub const N_VQ: usize = 16;
/// Codes per codebook (the audio pad id 1024 is outside the logits).
pub const AUDIO_VOCAB: usize = 1024;
/// Hidden size.
pub const HIDDEN: usize = 768;
/// x-vector size.
pub const XVEC: usize = 192;

/// The tied embeddings, heads and x-vector projection from `vieneu_v3_heads.npz`.
pub struct Weights {
    /// `(text_vocab, 768)` row-major.
    pub text_emb: Vec<f32>,
    /// `(16, 1024, 768)` row-major.
    pub audio_emb: Vec<f32>,
    xvec_w: Vec<f32>,
    xvec_b: Vec<f32>,
    xvec_ln_w: Vec<f32>,
    xvec_ln_b: Vec<f32>,
    xvec_ln_eps: f32,
    /// Number of text-vocabulary rows.
    pub text_vocab: usize,
}

impl Weights {
    /// Reads the heads archive.
    pub fn load(npz: &Path) -> io::Result<Weights> {
        let raw = std::fs::read(npz)?;
        let get = |name: &str| -> io::Result<Npy> { npz_member(&raw, name) };
        let text = get("text_emb")?;
        let audio = get("audio_emb")?;
        if audio.shape != [N_VQ, AUDIO_VOCAB, HIDDEN] || text.shape.len() != 2 || text.shape[1] != HIDDEN {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected head shapes"));
        }
        let eps = get("xvec_ln_eps")?.f32s()?;
        Ok(Weights {
            text_vocab: text.shape[0],
            text_emb: text.f32s()?,
            audio_emb: audio.f32s()?,
            xvec_w: get("xvec_w")?.f32s()?,
            xvec_b: get("xvec_b")?.f32s()?,
            xvec_ln_w: get("xvec_ln_w")?.f32s()?,
            xvec_ln_b: get("xvec_ln_b")?.f32s()?,
            xvec_ln_eps: eps[0],
        })
    }

    /// `_speaker_anchor`: the 192-d x-vector to the (768,) anchor.
    pub fn speaker_anchor(&self, blas: &OpenBlas, emb: &[f32]) -> Vec<f32> {
        assert_eq!(emb.len(), XVEC);
        let mut p0 = vec![0.0f32; HIDDEN];
        blas.vec_mat_t(&self.xvec_w, HIDDEN, XVEC, emb, &mut p0);
        let v: Vec<f32> = p0.iter().zip(&self.xvec_b).map(|(a, b)| a + b).collect();
        let denom = (np::var(&v) + self.xvec_ln_eps).sqrt();
        let normed: Vec<f32> = v.iter().map(|&x| (x - np::mean(&v)) / denom).collect();
        let scaled: Vec<f32> = normed.iter().zip(&self.xvec_ln_w).map(|(a, b)| a * b).collect();
        scaled.iter().zip(&self.xvec_ln_b).map(|(a, b)| a + b).collect()
    }

    /// `slot0 @ text_emb.T`.
    pub fn text_logits(&self, blas: &OpenBlas, slot0: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0f32; self.text_vocab];
        blas.vec_mat_t(&self.text_emb, self.text_vocab, HIDDEN, slot0, &mut out);
        out
    }

    /// `vec @ audio_emb[ch].T`.
    pub fn audio_logits(&self, blas: &OpenBlas, ch: usize, vec: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0f32; AUDIO_VOCAB];
        let base = ch * AUDIO_VOCAB * HIDDEN;
        blas.vec_mat_t(&self.audio_emb[base..base + AUDIO_VOCAB * HIDDEN], AUDIO_VOCAB, HIDDEN, vec, &mut out);
        out
    }
}

/// `RepetitionHistory`'s per-codebook sliding window (`rep_history.py`): codes seen in the last `window` frames.
pub struct ChannelWindow {
    counts: Vec<u16>,
    order: VecDeque<u16>,
    window: usize,
}

impl ChannelWindow {
    /// A window of `window` frames (`window <= 0` would be unbounded in Python; the engine always passes 64).
    pub fn new(window: usize) -> ChannelWindow {
        ChannelWindow { counts: vec![0; AUDIO_VOCAB], order: VecDeque::new(), window }
    }

    /// `add(code)`.
    pub fn add(&mut self, code: usize) {
        self.counts[code] += 1;
        self.order.push_back(code as u16);
        if self.order.len() > self.window {
            let old = self.order.pop_front().unwrap() as usize;
            self.counts[old] -= 1;
        }
    }

    fn members(&self) -> impl Iterator<Item = usize> + '_ {
        self.counts.iter().enumerate().filter(|(_, &c)| c > 0).map(|(i, _)| i)
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

/// Sampling parameters of one engine call.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Temperature (0 = greedy).
    pub temperature: f64,
    /// Top-k.
    pub top_k: usize,
    /// Top-p.
    pub top_p: f64,
    /// Repetition penalty.
    pub rep_pen: f64,
}

/// `_sample(logits, temperature, top_k, top_p, rep_pen, prev)` on the legacy global RNG.
pub fn sample(logits: &[f32], p: &Params, prev: &ChannelWindow, rng: &mut Mt19937) -> usize {
    let mut logits = logits.to_vec();
    // math.isclose(rep_pen, 1.0): rel_tol 1e-9, abs_tol 0
    if (p.rep_pen - 1.0).abs() > 1e-9 * p.rep_pen.abs().max(1.0) && !prev.is_empty() {
        let rep = p.rep_pen as f32;
        let idx: Vec<usize> = prev.members().collect();
        let sel: Vec<f32> = idx.iter().map(|&i| logits[i]).collect();
        for (&i, &s) in idx.iter().zip(&sel) {
            logits[i] = if s < 0.0 { s * rep } else { s / rep };
        }
    }
    if p.temperature.is_nan() || p.temperature <= 0.0 {
        return np::argmax(&logits);
    }
    let t = p.temperature as f32;
    for l in logits.iter_mut() {
        *l /= t;
    }
    let v = logits.len();
    let cand: Vec<i64> = if p.top_k > 0 && p.top_k < v {
        // numpy partitions the array in place; whatever the call leaves in `logits` is what Python reads afterwards.
        sort::argpartition(&mut logits, v - p.top_k)[v - p.top_k..].to_vec()
    } else {
        (0..v as i64).collect()
    };
    let mut cs: Vec<f32> = cand.iter().map(|&i| logits[i as usize]).collect();
    let order = sort::argsort(&mut cs);
    let ordered: Vec<f32> = order.iter().rev().map(|&o| cs[o as usize]).collect();
    let cand: Vec<i64> = order.iter().rev().map(|&o| cand[o as usize]).collect();
    let mut probs = np::softmax(&ordered);
    if p.top_p > 0.0 && p.top_p < 1.0 {
        let cum = np::cumsum(&probs);
        let tp = p.top_p as f32;
        for (i, x) in probs.iter_mut().enumerate() {
            let keep = (cum[i] - *x) < tp;
            *x *= if keep { 1.0 } else { 0.0 };
        }
        let s = np::sum(&probs);
        for x in probs.iter_mut() {
            *x /= s;
        }
    }
    cand[rng.choice(&probs)] as usize
}
