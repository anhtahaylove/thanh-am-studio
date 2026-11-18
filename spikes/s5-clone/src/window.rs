//! Port of `worker/main.py` `clone_window`: the 8 s of a mono clip with the most speech, in float32 as numpy computes it.

use crate::wav::pairwise_sum;

/// Seconds cloned from a reference (VieNeu's `_MAX_REF_SECONDS`).
pub const CLONE_SECONDS: f64 = 8.0;

/// `(start, end)` samples of the `CLONE_SECONDS` of `audio` with the most speech; all of it when not longer.
pub fn clone_window(audio: &[f32], sr: u32) -> (usize, usize) {
    let size = (CLONE_SECONDS * f64::from(sr)) as usize;
    let hop = std::cmp::max(1, sr as usize / 50);
    if audio.len() <= size {
        return (0, audio.len());
    }
    let count = audio.len() / hop;
    let width = size / hop;
    let mut energy = Vec::with_capacity(count);
    let mut squares = vec![0.0f32; hop];
    for f in 0..count {
        for (s, &v) in squares.iter_mut().zip(&audio[f * hop..(f + 1) * hop]) {
            *s = v * v;
        }
        // np.mean(...) + 1e-12 then sqrt, all float32
        energy.push(((pairwise_sum(&squares) / hop as f32) + 1e-12f32).sqrt());
    }
    let emax = energy.iter().copied().fold(f32::MIN, f32::max);
    let voiced: Vec<bool> = energy.iter().map(|&e| 20.0f32 * (e / emax).log10() > -35.0f32).collect();
    // np.convolve(voiced, ones(width), "valid") over exactly representable integers, then the first argmax
    let n_scores = count - width + 1;
    let mut score = Vec::with_capacity(n_scores);
    let mut running: i64 = voiced[..width].iter().map(|&v| i64::from(v)).sum();
    score.push(running);
    for i in 1..n_scores {
        running += i64::from(voiced[i + width - 1]) - i64::from(voiced[i - 1]);
        score.push(running);
    }
    let mut at = 0;
    for (i, &s) in score.iter().enumerate() {
        if s > score[at] {
            at = i;
        }
    }
    let mut start = at;
    for f in at..std::cmp::min(at + 50, score.len()) {
        let before = &voiced[f.saturating_sub(3)..f];
        if voiced[f] && !before.iter().any(|&v| v) {
            start = f.saturating_sub(2);
            break;
        }
    }
    let start = std::cmp::min(start * hop, audio.len() - size);
    (start, start + size)
}
