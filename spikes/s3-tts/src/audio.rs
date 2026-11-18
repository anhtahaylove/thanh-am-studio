//! The audio-side numpy logic around the engine: frame cap, babble guard, chunk joining (`vieneu_utils/core_utils.py`), `speech_edges`,
//! `limit_peak` and the PCM_24 WAV writer (`worker/main.py`), each operation-for-operation as numpy 2.4.6 evaluates it.

use crate::np;
use std::io;
use std::path::Path;

/// Sample rate of the engine's output.
pub const SR: usize = 48_000;
/// `PEAK_CEILING`.
pub const PEAK_CEILING: f64 = 0.98;
/// `10 ** (-45.0 / 20)` (Python float); compared against float32 data, so numpy casts it to float32.
const EDGE_THRESH: f64 = 0.005623413251903491;
/// `10 ** (-18.0 / 20)`.
const BURST_RATIO: f64 = 0.12589254117941673;
/// Maximum babble retries (`BABBLE_MAX_RETRIES`).
pub const BABBLE_MAX_RETRIES: usize = 2;

const IPA_VOWELS: &str = "aeiouyæɐɑɒɔəɘɛɜɤɯɵøœʉʊʌɪɨɚɝᵻᵿ";

/// `_FRAME_MARKUP_RE.sub("", s)`: removes `<|emotion_N|>`, `<en>` and `</en>`.
fn strip_markup(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let rest: String = b[i..b.len().min(i + 40)].iter().collect();
        if rest.starts_with("<|emotion_") {
            let digits = rest["<|emotion_".len()..].chars().take_while(char::is_ascii_digit).count();
            if digits > 0 && rest["<|emotion_".len() + digits..].starts_with("|>") {
                i += "<|emotion_".len() + digits + 2;
                continue;
            }
        }
        if rest.starts_with("<en>") {
            i += 4;
            continue;
        }
        if rest.starts_with("</en>") {
            i += 5;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn is_cue_only(ph: &str) -> bool {
    ph.contains("<|emotion_") && !strip_markup(ph).chars().any(char::is_alphabetic)
}

/// `syllable_count`.
pub fn syllable_count(phonemes: &str) -> usize {
    let stripped = strip_markup(phonemes);
    let mut total = 0;
    for tok in stripped.split(py_space) {
        if tok.is_empty() {
            continue;
        }
        let (mut groups, mut in_v, mut consonant_seen) = (0usize, false, true);
        for ch in tok.chars() {
            if IPA_VOWELS.contains(ch) {
                if !in_v && consonant_seen {
                    groups += 1;
                }
                in_v = true;
                consonant_seen = false;
            } else if "ːˈˌ".contains(ch) || ch.is_ascii_digit() {
                if "ˈˌ".contains(ch) && groups > 0 {
                    in_v = false;
                    consonant_seen = true;
                } else {
                    in_v = false;
                }
            } else {
                in_v = false;
                consonant_seen = true;
            }
        }
        if tok.chars().any(char::is_alphabetic) {
            total += groups.max(1);
        }
    }
    total
}

fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// `max_expected_frames`.
pub fn max_expected_frames(phonemes: &str) -> usize {
    let eff_len = strip_markup(phonemes).chars().count();
    // _FRAME_CAP_SLACK + int(np.ceil(MAX_FRAMES_PER_PHONE * eff_len)); 2.0 * n is exact.
    let mut cap = 24 + 2 * eff_len;
    if is_cue_only(phonemes) {
        return cap.min(13);
    }
    if !phonemes.contains("<|emotion_") {
        let syl = syllable_count(phonemes).max(1);
        if syl <= 4 && eff_len <= 24 * syl {
            cap = cap.min(13 + 5 * (syl - 1));
        }
    }
    cap
}

/// `count_speech_bursts(wav, sr=48000)`.
pub fn count_speech_bursts(wav: &[f32]) -> usize {
    let hop = ((SR as f64 * 0.010) as usize).max(1);
    let n = wav.len() / hop;
    if n == 0 {
        return 0;
    }
    let env: Vec<f32> = (0..n)
        .map(|r| {
            let sq: Vec<f32> = wav[r * hop..(r + 1) * hop].iter().map(|&x| x * x).collect();
            np::mean(&sq).sqrt()
        })
        .collect();
    let peak = f64::from(np::max(&env));
    if peak <= 1e-6 {
        return 0;
    }
    let thr = (peak * BURST_RATIO) as f32;
    let (min_gap, min_len) = (6i64, 3i64);
    let mut bursts: Vec<(i64, i64)> = Vec::new();
    let (mut start, mut last_on): (Option<i64>, i64) = (None, 0);
    for (i, &e) in env.iter().enumerate() {
        if e > thr {
            let i = i as i64;
            match start {
                None => start = Some(i),
                Some(s) if i - last_on > min_gap => {
                    bursts.push((s, last_on));
                    start = Some(i);
                }
                _ => {}
            }
            last_on = i;
        }
    }
    if let Some(s) = start {
        bursts.push((s, last_on));
    }
    bursts.iter().filter(|(a, b)| b - a + 1 >= min_len).count()
}

/// `(suspect, syllables, bursts, n_frames)` of `babble_suspect`.
pub type Babble = (bool, usize, usize, usize);

/// `babble_suspect(wav, 48000, phonemes, cap_frames, n_frames)`.
pub fn babble_suspect(wav: &[f32], phonemes: &str, cap_frames: usize, n_frames: usize) -> Babble {
    if is_cue_only(phonemes) {
        return (n_frames + 1 >= cap_frames, 0, 0, n_frames);
    }
    let syl = syllable_count(phonemes);
    if syl == 0 || syl > 3 || phonemes.contains("<|emotion_") {
        return (false, syl, 0, 0);
    }
    let bursts = count_speech_bursts(wav);
    let hit_cap = syl <= 2 && n_frames + 1 >= cap_frames;
    (bursts > syl || hit_cap, syl, bursts, n_frames)
}

/// `babble_prefer(new, old)`.
pub fn babble_prefer(new: Babble, old: Babble) -> bool {
    let ((n_bad, _, n_b, n_len), (o_bad, _, o_b, o_len)) = (new, old);
    if n_bad != o_bad {
        return !n_bad;
    }
    n_b < o_b || (n_b == o_b && n_len < o_len)
}

/// `edge_silence(wav, sr)`: `(lead, tail)` samples of silence.
pub fn edge_silence(wav: &[f32]) -> (usize, usize) {
    let n_samp = wav.len();
    let win = ((0.01f64 * SR as f64) as usize).max(1);
    let n_win = n_samp / win;
    if n_win == 0 {
        return (n_samp, 0);
    }
    let thr = EDGE_THRESH as f32;
    let env: Vec<f32> = (0..n_win)
        .map(|r| {
            let a: Vec<f32> = wav[r * win..(r + 1) * win].iter().map(|x| x.abs()).collect();
            np::mean(&a)
        })
        .collect();
    let above: Vec<usize> = env.iter().enumerate().filter(|(_, &e)| e > thr).map(|(i, _)| i).collect();
    match (above.first(), above.last()) {
        (Some(&f), Some(&l)) => (f * win, n_samp - (l + 1) * win),
        _ => (n_samp, 0),
    }
}

/// `pause_pad_samples(prev, next, sr, pause_s)`.
pub fn pause_pad_samples(prev: &[f32], next: &[f32], pause_s: f64) -> usize {
    let (lead_prev, mut tail) = edge_silence(prev);
    if lead_prev == prev.len() {
        tail = prev.len();
    }
    let (lead, _) = edge_silence(next);
    ((pause_s * SR as f64) as i64 - tail as i64 - lead as i64).max(0) as usize
}

/// `gaps_to_silence` for one gap kind.
pub fn gap_silence(gap: &str) -> f64 {
    match gap {
        "para" => 0.70,
        "minor" => 0.30,
        _ => 0.50,
    }
}

/// `join_audio_chunks(chunks, 48000, silence_ps=gaps_to_silence(gaps))`.
pub fn join_audio_chunks(chunks: &[Vec<f32>], gaps: &[String]) -> Vec<f32> {
    let Some(first) = chunks.first() else { return Vec::new() };
    let mut out = first.clone();
    for i in 1..chunks.len() {
        let pause_s = gaps.get(i - 1).map_or(0.0, |g| gap_silence(g));
        let pad = pause_pad_samples(&chunks[i - 1], &chunks[i], pause_s);
        out.extend(std::iter::repeat(0.0f32).take(pad));
        out.extend_from_slice(&chunks[i]);
    }
    out
}

/// Python `round(x)` (half to even) for a finite float.
pub fn py_round(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// `speech_edges(audio, keep_start, keep_end)`: `(start_ms, end_ms)`; `end_ms` is `None` when speech runs to the end.
pub fn speech_edges(audio: &[f32], keep_start: bool, keep_end: bool) -> (i64, Option<i64>) {
    let level: Vec<f32> = audio.iter().map(|x| x.abs()).collect();
    let peak = f64::from(np::max(&level));
    let thr = (1e-3f64.max(0.02 * peak)) as f32;
    let loud: Vec<usize> = level.iter().enumerate().filter(|(_, &l)| l > thr).map(|(i, _)| i).collect();
    let (Some(&first), Some(&last)) = (loud.first(), loud.last()) else { return (0, None) };
    let margin = py_round(0.08f64 * SR as f64) as usize;
    let len = audio.len();
    let start = if keep_start { 0 } else { first.saturating_sub(margin) };
    let end = if keep_end { len } else { len.min(last + 1 + margin) };
    (py_round(start as f64 / 48.0), if end >= len { None } else { Some(py_round(end as f64 / 48.0)) })
}

/// `limit_peak(audio, peak)`: scale down so the peak stays under `PEAK_CEILING`.
pub fn limit_peak(audio: &[f32], peak: f64) -> Vec<f32> {
    if peak > PEAK_CEILING {
        let scale = (PEAK_CEILING / peak) as f32;
        audio.iter().map(|x| x * scale).collect()
    } else {
        audio.to_vec()
    }
}

/// float32 to PCM_24 as libsndfile 1.2.2 (python-soundfile 0.14.0) writes it: `lrintf(x * 2^31)` clipped to int32, then `>> 8`.
/// Measured against soundfile on 200,013 samples (`scripts/sf_probe.py`): 100% identical.
pub fn to_i24(x: f32) -> i32 {
    let s = x * 2_147_483_648.0f32;
    let v: i32 = if s >= 2_147_483_648.0 {
        i32::MAX
    } else if s <= -2_147_483_648.0 {
        i32::MIN
    } else {
        s.round_ties_even() as i32
    };
    v >> 8
}

/// The bytes of a mono 48 kHz PCM_24 WAV file as libsndfile writes it (44-byte header, a pad byte after an odd data length).
pub fn wav_pcm24(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 3;
    let pad = data_len % 2;
    let mut out = Vec::with_capacity(44 + data_len + pad);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len + pad) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(SR as u32).to_le_bytes());
    out.extend_from_slice(&((SR * 3) as u32).to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for &s in samples {
        out.extend_from_slice(&to_i24(s).to_le_bytes()[..3]);
    }
    out.extend(std::iter::repeat(0u8).take(pad));
    out
}

/// `save(path, samples)`: writes `<stem>.partial.wav`, then renames it over `path`, as the worker does.
pub fn save_wav(path: &Path, samples: &[f32]) -> io::Result<()> {
    let partial = path.with_file_name(format!("{}.partial.wav", path.file_stem().unwrap().to_string_lossy()));
    let result = std::fs::write(&partial, wav_pcm24(samples)).and_then(|()| std::fs::rename(&partial, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}
