//! Port of `librosa.effects.trim(y, top_db=30)` (librosa 0.11, mono float32 input): the B3 trim port.
//!
//! Frame RMS (frame 2048, hop 512, zero padding of 1024 on both sides), amplitude to dB against the loudest frame, then the
//! first and last frame above `-top_db`. Every operation is float32 in the order numpy performs it.

use crate::wav::pairwise_sum;

const FRAME: usize = 2048;
const HOP: usize = 512;

/// Frame RMS values as `librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]`.
pub fn rms(y: &[f32]) -> Vec<f32> {
    let mut padded = vec![0.0f32; y.len() + FRAME];
    padded[FRAME / 2..FRAME / 2 + y.len()].copy_from_slice(y);
    let frames = 1 + (padded.len() - FRAME) / HOP;
    let mut squares = vec![0.0f32; FRAME];
    (0..frames)
        .map(|t| {
            for (s, &v) in squares.iter_mut().zip(&padded[t * HOP..t * HOP + FRAME]) {
                *s = v * v;
            }
            (pairwise_sum(&squares) / FRAME as f32).sqrt()
        })
        .collect()
}

/// `librosa.amplitude_to_db(rms, ref=np.max, top_db=None)` in float32.
pub fn amplitude_to_db(rms: &[f32]) -> Vec<f32> {
    const AMIN_SQ: f32 = 1e-10;
    let reference = rms.iter().copied().fold(f32::MIN, |a, b| if b > a { b } else { a });
    let ref_power = reference * reference;
    let ref_db = 10.0f32 * AMIN_SQ.max(ref_power).log10();
    rms.iter().map(|&m| 10.0f32 * AMIN_SQ.max(m * m).log10() - ref_db).collect()
}

/// `(start, end)` such that `y[start..end]` is `librosa.effects.trim(y, top_db=30)[0]`.
pub fn trim(y: &[f32], top_db: f32) -> (usize, usize) {
    let db = amplitude_to_db(&rms(y));
    let non_silent: Vec<usize> = db.iter().enumerate().filter(|(_, &d)| d > -top_db).map(|(i, _)| i).collect();
    match (non_silent.first(), non_silent.last()) {
        (Some(&first), Some(&last)) => (first * HOP, std::cmp::min(y.len(), (last + 1) * HOP)),
        _ => (0, 0),
    }
}
