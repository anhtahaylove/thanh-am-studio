//! The STT glue of the Python worker, ported from spike S4 (`spikes/s4-stt/glue`, row T1a: 110/110 items bitwise against recorded
//! Python runs of the v1.0.16 worker, both models).
//!
//! Ported paths (only those the worker reaches): `worker/main.py` `stt` (window loop and the `IndexError` retry), `stt_windows`,
//! `stt_window`; faster-whisper 1.2.1 `WhisperModel.transcribe` with the worker's options (beam 5, VAD on, no previous-text
//! conditioning, language `vi` or auto, word times on or off), `generate_segments`, `generate_with_fallback`,
//! `_split_segments_by_timestamps`, `add_word_timestamps`, `find_alignment`, `merge_punctuations`, `detect_language`, the feature
//! extractor, `collect_chunks`, `SpeechTimestampsMap` and the tokenizer helpers. Engine calls (and the VAD) go through `WhisperEngine`.
//!
//! Number types matter: faster-whisper mixes Python floats and numpy float64 scalars, and `round(x, 2)` rounds them differently
//! (correctly rounded decimal for float, `rint(x * 100) / 100` for np.float64). `Num` carries that type along the word-time path.

use std::io::Write as _;
use std::path::Path;

use crate::tts::{isa, ucrt_log10f, Isa, OpenBlas};

pub const STT_RATE: usize = 16000;
pub const STT_WINDOW_S: usize = 600;

#[derive(Debug)]
pub enum GlueError {
    /// The `IndexError` faster-whisper 1.2.1 raises on an empty word alignment (the worker retries without word times).
    Index(String),
    Engine(String),
}

impl std::fmt::Display for GlueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GlueError::Index(m) => write!(f, "IndexError: {m}"),
            GlueError::Engine(m) => write!(f, "{m}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Python number semantics
// ---------------------------------------------------------------------------------------------------------------------------

/// A number as faster-whisper holds it on the word-time path: Python int, Python float or numpy float64.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Num {
    Int(i64),
    Py(f64),
    Np(f64),
}

impl Num {
    pub fn v(self) -> f64 {
        match self {
            Num::Int(i) => i as f64,
            Num::Py(x) | Num::Np(x) => x,
        }
    }
    fn like(a: Num, b: Num, x: f64) -> Num {
        match (a, b) {
            (Num::Np(_), _) | (_, Num::Np(_)) => Num::Np(x),
            _ => Num::Py(x),
        }
    }
    fn add(self, o: Num) -> Num {
        match (self, o) {
            (Num::Int(a), Num::Int(b)) => Num::Int(a + b),
            _ => Num::like(self, o, self.v() + o.v()),
        }
    }
    fn sub(self, o: Num) -> Num {
        match (self, o) {
            (Num::Int(a), Num::Int(b)) => Num::Int(a - b),
            _ => Num::like(self, o, self.v() - o.v()),
        }
    }
    /// `x / 2` (true division: an int becomes a float).
    fn half(self) -> Num {
        match self {
            Num::Np(x) => Num::Np(x / 2.0),
            _ => Num::Py(self.v() / 2.0),
        }
    }
    /// `round(x, 2)` for this type.
    fn round2(self) -> Num {
        match self {
            Num::Int(_) => self,
            Num::Py(x) => Num::Py(py_round2(x)),
            Num::Np(x) => Num::Np(np_round2(x)),
        }
    }
}

/// Python `max(a, b)`: keeps `a` unless `b > a`.
fn py_max(a: Num, b: Num) -> Num {
    if b.v() > a.v() {
        b
    } else {
        a
    }
}

/// Python `min(a, b)`: keeps `a` unless `b < a`.
fn py_min(a: Num, b: Num) -> Num {
    if b.v() < a.v() {
        b
    } else {
        a
    }
}

/// CPython `round(x, 2)` for a float: the exact binary value rounded half-even to 2 decimals, then the nearest double.
pub fn py_round2(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let bits = x.abs().to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = (bits & ((1u64 << 52) - 1)) as u128;
    let (mant, e) = if biased == 0 { (frac, -1074) } else { (frac | (1u128 << 52), biased - 1075) };
    if e >= 0 {
        return x; // an integer already
    }
    let s = (-e) as u32;
    let p = mant * 100; // < 2^60
    let n = if s >= 100 {
        0
    } else {
        let q = p >> s;
        let r = p - (q << s);
        let half = 1u128 << (s - 1);
        if r > half || (r == half && q & 1 == 1) {
            q + 1
        } else {
            q
        }
    };
    let y: f64 = format!("{n}e-2").parse().expect("decimal");
    if x < 0.0 {
        -y
    } else {
        y
    }
}

/// numpy `np.round(np.float64(x), 2)`: `rint(x * 100.0) / 100.0`.
pub fn np_round2(x: f64) -> f64 {
    (x * 100.0).round_ties_even() / 100.0
}

/// Python `str.isspace` for one char: Unicode White_Space plus U+001C..U+001F (bidi class B/S).
fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python `str.strip()`.
pub fn py_strip(s: &str) -> &str {
    s.trim_matches(py_space)
}

const PUNCTUATION: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"; // string.punctuation
const PREPEND: &str = "\"'\u{201c}\u{bf}([{-"; // transcribe() default prepend_punctuations
const APPEND: &str = "\"'.\u{3002},\u{ff0c}!\u{ff01}?\u{ff1f}:\u{ff1a}\u{201d})]}\u{3001}"; // append_punctuations
const SENTENCE_END: &str = ".\u{3002}!\u{ff01}?\u{ff1f}";

/// numpy's pairwise float32 summation (`add.reduce` over a contiguous axis); same code as spike S5 (`wav::pairwise_sum`),
/// which S5 checked against numpy fixtures.
pub fn pairwise_sum(a: &[f32]) -> f32 {
    let n = a.len();
    if n < 8 {
        let mut res = 0.0f32;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - (n % 8) {
            for j in 0..8 {
                r[j] += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pairwise_sum(&a[..n2]) + pairwise_sum(&a[n2..])
    }
}

/// `np.median` of float64 values (the mean of the two middle values for an even count).
fn np_median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).expect("no NaN durations"));
    let n = s.len();
    if n % 2 == 1 {
        s[n / 2]
    } else {
        (s[n / 2 - 1] + s[n / 2]) / 2.0
    }
}

/// `len(text.encode()) / len(zlib.compress(text.encode()))` (level 6, zlib format).
pub fn compression_ratio(text: &str) -> f64 {
    let bytes = text.as_bytes();
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(6));
    z.write_all(bytes).expect("in-memory write");
    let out = z.finish().expect("in-memory finish");
    bytes.len() as f64 / out.len() as f64
}

// ---------------------------------------------------------------------------------------------------------------------------
// Worker windowing (worker/main.py stt_windows)
// ---------------------------------------------------------------------------------------------------------------------------

/// Sample offsets that split long audio into <= 600 s pieces, each cut at the quietest 100 ms frame of the last 30 s.
pub fn stt_windows(audio: &[f32]) -> Vec<usize> {
    let (rate, window_s, search_s) = (STT_RATE, STT_WINDOW_S, 30);
    let frame = rate / 10;
    let mut cuts = vec![0usize];
    while audio.len() - cuts[cuts.len() - 1] > window_s * rate {
        let lo = cuts[cuts.len() - 1] + (window_s - search_s) * rate;
        let mut best = (0usize, f32::INFINITY);
        for (i, row) in audio[lo..lo + search_s * rate].chunks_exact(frame).enumerate() {
            let squares: Vec<f32> = row.iter().map(|v| v * v).collect();
            let energy = pairwise_sum(&squares) / frame as f32;
            if energy < best.1 {
                best = (i, energy); // argmin keeps the first minimum
            }
        }
        cuts.push(lo + best.0 * frame + frame / 2);
    }
    cuts.push(audio.len());
    cuts
}

// ---------------------------------------------------------------------------------------------------------------------------
// Feature extractor (faster_whisper/feature_extractor.py), in float32 step for step as numpy 2.4.6 runs it on Windows. A 1-ulp
// difference here (the earlier f64 path) changed ~6% of the words downstream, so every step mirrors numpy's own loop.
// ---------------------------------------------------------------------------------------------------------------------------

extern "C" {
    fn thanham_pf_rfft_f64(input: *const f64, rows: usize, npts: usize, out: *mut f64, fct: f64) -> i32;
}

pub struct FeatureExtractor {
    pub n_mels: usize,
    filters: Vec<f32>, // n_mels x 201: `get_mel_filters(...).astype("float32")`
    window: Vec<f32>,
    blas: OpenBlas,
    /// numpy's complex64 `absolute` loop fuses `ratio * ratio + 1` on its X86_V3/X86_V4 targets, not on the X86_V2 baseline.
    fused: bool,
}

/// `np.abs(stft) ** 2` over interleaved complex64 `spec`: numpy's `simd_cabsolute_f32` (loops_unary_complex.dispatch.c.src), which
/// its `CFLOAT_absolute` runs for strided and contiguous input alike, then `square`. shortcut: numpy's inf/NaN selects are left
/// out, as an FFT of decoded (finite) samples is finite; add them if non-finite input can ever reach here.
#[inline(always)]
fn power<const FUSED: bool>(spec: &[f32], out: &mut [f32]) {
    for (o, c) in out.iter_mut().zip(spec.chunks_exact(2)) {
        let (re, im) = (c[0].abs(), c[1].abs());
        let (larger, smaller) = (re.max(im), im.min(re));
        let ratio = if larger == 0.0 || smaller == f32::INFINITY { 0.0 } else { smaller / larger };
        let a = if FUSED { ratio.mul_add(ratio, 1.0) } else { ratio * ratio + 1.0 }.sqrt() * larger;
        *o = a * a;
    }
}

#[target_feature(enable = "fma")]
fn power_fma(spec: &[f32], out: &mut [f32]) {
    power::<true>(spec, out)
}

const N_FFT: usize = 400;
const HOP: usize = 160;
const N_BINS: usize = N_FFT / 2 + 1;
pub const NB_MAX_FRAMES: usize = 3000;
const FFT_ROWS: usize = 256; // frames per pocketfft call, which bounds the float64 buffers

impl FeatureExtractor {
    /// `blas`: numpy's own OpenBLAS DLL, for `mel_filters @ magnitudes`.
    pub fn new(n_mels: usize, blas: OpenBlas) -> Self {
        let sr = 16000.0f64;
        let val = 1.0 / (N_FFT as f64 * (1.0 / sr)); // np.fft.rfftfreq
        let fftfreqs: Vec<f64> = (0..N_BINS).map(|k| k as f64 * val).collect();
        let (min_mel, max_mel) = (0.0f64, 45.245640471924965f64);
        let num = n_mels + 2;
        let step = (max_mel - min_mel) / (num - 1) as f64; // np.linspace
        let mut mels: Vec<f64> = (0..num).map(|i| i as f64 * step + min_mel).collect();
        mels[num - 1] = max_mel;
        let (f_min, f_sp) = (0.0f64, 200.0 / 3.0);
        let mut freqs: Vec<f64> = mels.iter().map(|m| f_min + f_sp * m).collect();
        let min_log_hz = 1000.0f64;
        let min_log_mel = (min_log_hz - f_min) / f_sp;
        let logstep = 6.4f64.ln() / 27.0;
        for (f, m) in freqs.iter_mut().zip(&mels) {
            if *m >= min_log_mel {
                *f = min_log_hz * (logstep * (m - min_log_mel)).exp();
            }
        }
        let fdiff: Vec<f64> = freqs.windows(2).map(|w| w[1] - w[0]).collect();
        let mut filters = vec![0f32; n_mels * N_BINS];
        for i in 0..n_mels {
            let enorm = 2.0 / (freqs[i + 2] - freqs[i]);
            for k in 0..N_BINS {
                let lower = -(freqs[i] - fftfreqs[k]) / fdiff[i];
                let upper = (freqs[i + 2] - fftfreqs[k]) / fdiff[i + 1];
                let w = 0f64.max(lower.min(upper)) * enorm;
                filters[i * N_BINS + k] = w as f32;
            }
        }
        // np.hanning(401)[:-1].astype(float32): 0.5 + 0.5 * cos(pi * n / 400), n = -400, -398, ...
        let window = (0..N_FFT)
            .map(|k| {
                let n = -(N_FFT as f64) + 2.0 * k as f64;
                (0.5 + 0.5 * (std::f64::consts::PI * n / N_FFT as f64).cos()) as f32
            })
            .collect();
        FeatureExtractor { n_mels, filters, window, blas, fused: isa() != Isa::Baseline }
    }

    /// The log-Mel spectrogram of `waveform` as `[n_mels][frames]` (row-major) and the frame count, bitwise as numpy computes it:
    /// frames x window, pocketfft's `rfft` (in float64, as numpy runs it), `np.abs(stft) ** 2`, `mel_filters @ magnitudes`
    /// through numpy's OpenBLAS with numpy's arguments, ucrtbase `log10f`, then the clip, `max() - 8.0` and `(x + 4.0) / 4.0` in
    /// float32.
    pub fn compute(&self, waveform: &[f32]) -> (Vec<f32>, usize) {
        let mut x = waveform.to_vec();
        x.extend(std::iter::repeat(0f32).take(HOP)); // padding=160
        let len = x.len();
        let pad = N_FFT / 2;
        let reflect = |j: isize| -> f32 {
            // np.pad(mode="reflect"): mirror without repeating the edge sample
            if len == 1 {
                return x[0];
            }
            let period = 2 * (len as isize - 1);
            let mut m = j.rem_euclid(period);
            if m >= len as isize {
                m = period - m;
            }
            x[m as usize]
        };
        let total = len + 2 * pad;
        let y: Vec<f32> = (0..total).map(|i| reflect(i as isize - pad as isize)).collect();
        let frames = 1 + (total - N_FFT) / HOP - 1; // stft[..., :-1]

        // `np.fft.rfft` passes fct as the int 1, so numpy's (legacy) loop resolution picks the float64 loop for the float32 frames
        // and casts its complex128 result into the complex64 output: pocketfft in double, then each part rounded to float32.
        let mut spec = vec![0f32; frames * N_BINS * 2];
        let (mut rows, mut out) = (vec![0f64; FFT_ROWS * N_FFT], vec![0f64; FFT_ROWS * N_BINS * 2]);
        for (chunk, dst) in spec.chunks_mut(FFT_ROWS * N_BINS * 2).enumerate() {
            let n = dst.len() / (N_BINS * 2);
            for (i, row) in rows.chunks_exact_mut(N_FFT).take(n).enumerate() {
                let f = chunk * FFT_ROWS + i;
                for (k, v) in row.iter_mut().enumerate() {
                    *v = (y[f * HOP + k] * self.window[k]) as f64; // the float32 product numpy's frames * window gives
                }
            }
            // SAFETY: `rows` holds n x N_FFT doubles and `out` n x N_BINS interleaved complex, what the shim reads and writes.
            let rc = unsafe { thanham_pf_rfft_f64(rows.as_ptr(), n, N_FFT, out.as_mut_ptr(), 1.0) };
            assert_eq!(rc, 0, "pocketfft rfft");
            dst.iter_mut().zip(&out).for_each(|(d, &v)| *d = v as f32);
        }
        // The stft's transpose and astype keep this frames x bins memory order: `magnitudes` is an F-ordered bins x frames array.
        let mut magnitudes = vec![0f32; frames * N_BINS];
        if self.fused {
            // SAFETY: `fused` is set only on CPUs with numpy's X86_V3 features, FMA3 among them.
            unsafe { power_fma(&spec, &mut magnitudes) }
        } else {
            power::<false>(&spec, &mut magnitudes)
        }
        let mut mel = vec![0f32; self.n_mels * frames];
        if frames == 1 {
            // numpy's matrix @ vector case
            self.blas.vec_mat_t(&self.filters, self.n_mels, N_BINS, &magnitudes, &mut mel);
        } else {
            self.blas.mat_mat_t(&self.filters, self.n_mels, N_BINS, &magnitudes, frames, &mut mel);
        }
        let log10f = ucrt_log10f();
        // a_min, a Python float, cast to float32
        let clip = 1e-10f64 as f32;
        // SAFETY: ucrtbase's `float log10f(float)`.
        mel.iter_mut().for_each(|v| *v = unsafe { log10f(v.max(clip)) });
        let floor = mel.iter().fold(f32::NEG_INFINITY, |m, &v| m.max(v)) - 8.0;
        let out = mel.iter().map(|&v| (v.max(floor) + 4.0) / 4.0).collect();
        (out, frames)
    }
}

/// `pad_or_trim(features[:, start:start + size])` as the `[1, n_mels, 3000]` encoder input.
fn encoder_input(features: &[f32], n_mels: usize, frames: usize, start: usize, size: usize) -> Vec<f32> {
    let mut out = vec![0f32; n_mels * NB_MAX_FRAMES];
    let size = size.min(NB_MAX_FRAMES);
    for m in 0..n_mels {
        let src = &features[m * frames + start..m * frames + start + size];
        out[m * NB_MAX_FRAMES..m * NB_MAX_FRAMES + size].copy_from_slice(src);
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tokenizer (faster_whisper/tokenizer.py) over the model's tokenizer.json
// ---------------------------------------------------------------------------------------------------------------------------

pub struct Tok {
    hf: tokenizers::Tokenizer,
    pub sot: u32,
    pub eot: u32,
    pub transcribe: u32,
    pub translate: u32,
    pub sot_prev: u32,
    pub sot_lm: u32,
    pub no_timestamps: u32,
    pub no_speech: u32,
}

impl Tok {
    pub fn load(model_dir: &Path) -> Result<Self, GlueError> {
        let hf = tokenizers::Tokenizer::from_file(model_dir.join("tokenizer.json"))
            .map_err(|e| GlueError::Engine(format!("tokenizer: {e}")))?;
        let id = |s: &str| hf.token_to_id(s).ok_or_else(|| GlueError::Engine(format!("tokenizer has no {s}")));
        let no_speech = match hf.token_to_id("<|nospeech|>") {
            Some(i) if i != 0 => i,
            _ => id("<|nocaptions|>")?,
        };
        Ok(Tok {
            sot: id("<|startoftranscript|>")?,
            eot: id("<|endoftext|>")?,
            transcribe: id("<|transcribe|>")?,
            translate: id("<|translate|>")?,
            sot_prev: id("<|startofprev|>")?,
            sot_lm: id("<|startoflm|>")?,
            no_timestamps: id("<|notimestamps|>")?,
            no_speech,
            hf,
        })
    }
    pub fn timestamp_begin(&self) -> u32 {
        self.no_timestamps + 1
    }
    pub fn token_to_id(&self, s: &str) -> Option<u32> {
        self.hf.token_to_id(s)
    }
    pub fn encode(&self, text: &str) -> Vec<u32> {
        self.hf.encode(text, false).expect("encode").get_ids().to_vec()
    }
    fn hf_decode(&self, ids: &[u32]) -> String {
        self.hf.decode(ids, true).expect("decode")
    }
    /// `Tokenizer.decode`: text tokens only.
    pub fn decode(&self, tokens: &[u32]) -> String {
        let text: Vec<u32> = tokens.iter().copied().filter(|&t| t < self.eot).collect();
        self.hf_decode(&text)
    }
    /// `non_speech_tokens` (sorted).
    fn non_speech_tokens(&self) -> Vec<u32> {
        let mut symbols: Vec<String> =
            "\"#()*+/:;<=>@[\\]^_`{|}~\u{300c}\u{300d}\u{300e}\u{300f}".chars().map(String::from).collect();
        symbols.extend(
            "<< >> <<< >>> -- --- -( -[ (' (\" (( )) ((( ))) [[ ]] {{ }} \u{266a}\u{266a} \u{266a}\u{266a}\u{266a}"
                .split_whitespace()
                .map(String::from),
        );
        let misc = ['\u{2669}', '\u{266a}', '\u{266b}', '\u{266c}', '\u{266d}', '\u{266e}', '\u{266f}'];
        let mut result = std::collections::BTreeSet::new();
        result.insert(self.encode(" -")[0]);
        result.insert(self.encode(" '")[0]);
        let all: Vec<(String, bool)> =
            symbols.into_iter().map(|s| (s, false)).chain(misc.iter().map(|c| (c.to_string(), true))).collect();
        for (symbol, is_misc) in all {
            for tokens in [self.encode(&symbol), self.encode(&format!(" {symbol}"))] {
                if tokens.len() == 1 || is_misc {
                    result.insert(tokens[0]);
                }
            }
        }
        result.into_iter().collect()
    }
    /// `get_suppressed_tokens(tokenizer, [-1])`.
    pub fn suppressed_tokens(&self) -> Vec<i64> {
        let mut s: std::collections::BTreeSet<u32> = self.non_speech_tokens().into_iter().collect();
        s.extend([self.transcribe, self.translate, self.sot, self.sot_prev, self.sot_lm, self.no_speech]);
        s.into_iter().map(i64::from).collect()
    }
    /// `split_tokens_on_unicode` (no timestamp tokens reach it on the worker's path: the text tokens are below `eot`).
    fn split_on_unicode(&self, tokens: &[u32]) -> Result<(Vec<String>, Vec<Vec<u32>>), GlueError> {
        if tokens.iter().any(|&t| t >= self.timestamp_begin()) {
            return Err(GlueError::Engine("timestamp token in split_to_word_tokens".into()));
        }
        let full: Vec<char> = self.hf_decode(tokens).chars().collect();
        let (mut words, mut word_tokens, mut current) = (Vec::new(), Vec::new(), Vec::new());
        let mut offset = 0usize;
        for &t in tokens {
            current.push(t);
            let decoded = self.hf_decode(&current);
            let chars: Vec<char> = decoded.chars().collect();
            let idx = chars.iter().position(|&c| c == '\u{fffd}').map(|i| i + offset);
            if idx.map_or(true, |i| i < full.len() && full[i] == '\u{fffd}') {
                offset += chars.len();
                words.push(decoded);
                word_tokens.push(std::mem::take(&mut current));
            }
        }
        Ok((words, word_tokens))
    }
    /// `Tokenizer.split_to_word_tokens`: unicode split for the languages written without spaces (auto language can detect them),
    /// else `split_tokens_on_spaces`.
    fn split_to_word_tokens(
        &self,
        tokens: &[u32],
        language_id: u32,
    ) -> Result<(Vec<String>, Vec<Vec<u32>>), GlueError> {
        if ["zh", "ja", "th", "lo", "my", "yue"]
            .iter()
            .any(|l| self.token_to_id(&format!("<|{l}|>")) == Some(language_id))
        {
            return self.split_on_unicode(tokens);
        }
        let (subwords, subword_tokens) = self.split_on_unicode(tokens)?;
        let (mut words, mut word_tokens): (Vec<String>, Vec<Vec<u32>>) = (Vec::new(), Vec::new());
        for (subword, toks) in subwords.into_iter().zip(subword_tokens) {
            let special = toks[0] >= self.eot;
            let with_space = subword.starts_with(' ');
            let punctuation = PUNCTUATION.contains(py_strip(&subword)); // Python `in` on str: substring
            if special || with_space || punctuation || words.is_empty() {
                words.push(subword);
                word_tokens.push(toks);
            } else {
                let last = words.len() - 1;
                words[last].push_str(&subword);
                word_tokens[last].extend(toks);
            }
        }
        Ok((words, word_tokens))
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Engine interface
// ---------------------------------------------------------------------------------------------------------------------------

/// `ctranslate2.models.Whisper.generate` options as faster-whisper builds them.
#[derive(Clone, Debug)]
pub struct GenOptions {
    pub temperature: f64,
    pub beam_size: usize,
    pub patience: f64,
    pub best_of: usize,
    pub length_penalty: f64,
    pub repetition_penalty: f64,
    pub no_repeat_ngram_size: usize,
    pub max_length: usize,
    pub suppress_blank: bool,
    pub suppress_tokens: Vec<i64>,
    pub max_initial_timestamp_index: usize,
}

pub struct GenResult {
    pub sequences_ids: Vec<Vec<u32>>,
    pub scores: Vec<f64>,
    pub no_speech_prob: f64,
}

/// `align`'s (text index, time index) pairs; faster-whisper's word probabilities are not used by the worker.
pub struct AlignResult {
    pub alignments: Vec<(i64, i64)>,
}

/// The engine (CTranslate2 Whisper), the VAD (Silero in production) and optional trace hooks.
pub trait WhisperEngine {
    type Enc;
    /// `features`: `[1, n_mels, 3000]` row-major.
    fn encode(&mut self, features: &[f32], n_mels: usize) -> Result<Self::Enc, GlueError>;
    fn generate(&mut self, enc: &Self::Enc, prompt: &[u32], o: &GenOptions) -> Result<GenResult, GlueError>;
    fn align(
        &mut self,
        enc: &Self::Enc,
        start: &[u32],
        text: &[Vec<u32>],
        num_frames: usize,
        median_filter_width: usize,
    ) -> Result<Vec<AlignResult>, GlueError>;
    fn detect_language(&mut self, enc: &Self::Enc) -> Result<Vec<(String, f64)>, GlueError>;
    /// `get_speech_timestamps(audio, VadOptions())`: (start, end) sample pairs.
    fn speech_timestamps(&mut self, audio: &[f32]) -> Result<Vec<(i64, i64)>, GlueError>;
    fn trace_compression_ratio(&mut self, _text: &str, _ratio: f64) -> Result<(), GlueError> {
        Ok(())
    }
    fn trace_window(&mut self, _start: usize, _end: usize, _lang: Option<&str>, _words: bool) -> Result<(), GlueError> {
        Ok(())
    }
    fn trace_window_result(&mut self, _rows: &[Row], _words: &[Vec<Word>], _lang: &str) -> Result<(), GlueError> {
        Ok(())
    }
    fn trace_index_error(&mut self) -> Result<(), GlueError> {
        Ok(())
    }
    /// A segment as `transcribe`'s generator yields it to `stt_window` (restored to window time), where the worker reports
    /// progress: also for a window that later fails with the `IndexError` and runs again.
    fn trace_segment(&mut self, _end: f64) -> Result<(), GlueError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SttResult {
    pub segments: Vec<Row>,
    pub words: Vec<Vec<Word>>,
    pub language: Option<String>,
    pub words_fallback: bool,
}

#[derive(Clone, Debug)]
struct TWord {
    word: String,
    start: Num,
    end: Num,
}

#[derive(Clone, Debug)]
struct SubSeg {
    seek: i64,
    start: Num,
    end: Num,
    tokens: Vec<u32>,
    words: Vec<TWord>,
}

struct Segment {
    start: Num,
    end: Num,
    text: String,
    words: Option<Vec<TWord>>,
}

struct AlignWord {
    word: String,
    tokens: Vec<u32>,
    start: Num,
    end: Num,
}

// ---------------------------------------------------------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------------------------------------------------------

const TEMPERATURES: [f64; 6] = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];
const TIME_PRECISION: f64 = 0.02;
const FRAMES_PER_SECOND: i64 = 100; // sampling_rate // hop_length
const TOKENS_PER_SECOND: i64 = 50; // sampling_rate // (hop_length * input_stride)
const INPUT_STRIDE: i64 = 2;
const MAX_LENGTH: usize = 448;

pub struct Transcriber {
    pub fe: FeatureExtractor,
    pub tok: Tok,
    suppress: Vec<i64>,
}

/// One window's rows, each row's words (empty without word times) and the language used.
pub type WindowResult = (Vec<Row>, Vec<Vec<Word>>, String);

impl Transcriber {
    /// Loads the tokenizer and the feature size of a CTranslate2 Whisper model folder (`preprocessor_config.json` when present);
    /// `blas` is numpy's OpenBLAS for the feature extractor.
    pub fn load(model_dir: &Path, blas: OpenBlas) -> Result<Self, GlueError> {
        let mut n_mels = 80;
        let pre = model_dir.join("preprocessor_config.json");
        if pre.is_file() {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&pre).map_err(|e| GlueError::Engine(e.to_string()))?)
                    .map_err(|e| GlueError::Engine(e.to_string()))?;
            for (key, want) in [("sampling_rate", 16000), ("hop_length", 160), ("chunk_length", 30), ("n_fft", 400)] {
                if v.get(key).and_then(|x| x.as_i64()).is_some_and(|x| x != want) {
                    return Err(GlueError::Engine(format!("unsupported {key} in preprocessor_config.json")));
                }
            }
            if let Some(f) = v.get("feature_size").and_then(|x| x.as_u64()) {
                n_mels = f as usize;
            }
        }
        let tok = Tok::load(model_dir)?;
        let suppress = tok.suppressed_tokens();
        Ok(Transcriber { fe: FeatureExtractor::new(n_mels, blas), tok, suppress })
    }

    /// worker `stt()`'s window loop: `language` None = auto; `diarizing` turns word times on (with the `IndexError` retry).
    pub fn stt<E: WhisperEngine>(
        &self,
        e: &mut E,
        audio: &[f32],
        language: Option<&str>,
        diarizing: bool,
    ) -> Result<SttResult, GlueError> {
        let cuts = stt_windows(audio);
        let mut lang = language.map(str::to_string);
        let (mut segments, mut words, mut fallback) = (Vec::new(), Vec::new(), false);
        for w in cuts.windows(2) {
            let (start, end) = (w[0], w[1]);
            let offset = start as f64 / STT_RATE as f64;
            e.trace_window(start, end, lang.as_deref(), diarizing)?;
            let (rows, row_words, l) = match self.stt_window(e, &audio[start..end], offset, lang.as_deref(), diarizing)
            {
                Ok(r) => r,
                Err(GlueError::Index(_)) if diarizing => {
                    e.trace_index_error()?;
                    fallback = true;
                    self.stt_window(e, &audio[start..end], offset, lang.as_deref(), false)?
                }
                Err(err) => return Err(err),
            };
            e.trace_window_result(&rows, &row_words, &l)?;
            lang = Some(l);
            segments.extend(rows);
            words.extend(row_words);
        }
        Ok(SttResult { segments, words, language: lang, words_fallback: fallback })
    }

    /// worker `stt_window`.
    pub fn stt_window<E: WhisperEngine>(
        &self,
        e: &mut E,
        audio: &[f32],
        offset: f64,
        lang: Option<&str>,
        with_words: bool,
    ) -> Result<WindowResult, GlueError> {
        let (segments, language) = self.transcribe(e, audio, lang, with_words)?;
        let (mut rows, mut words) = (Vec::new(), Vec::new());
        for s in segments {
            rows.push(Row {
                start: offset + s.start.v(),
                end: offset + s.end.v(),
                text: py_strip(&s.text).to_string(),
            });
            words.push(if with_words {
                s.words
                    .unwrap_or_default()
                    .into_iter()
                    .map(|w| Word { start: offset + w.start.v(), end: offset + w.end.v(), text: w.word })
                    .collect()
            } else {
                Vec::new()
            });
        }
        Ok((rows, words, language))
    }

    /// `WhisperModel.transcribe(audio, language, beam_size=5, vad_filter=True, condition_on_previous_text=False, word_timestamps)`.
    fn transcribe<E: WhisperEngine>(
        &self,
        e: &mut E,
        audio: &[f32],
        language: Option<&str>,
        words: bool,
    ) -> Result<(Vec<Segment>, String), GlueError> {
        let chunks = e.speech_timestamps(audio)?;
        let mut collected = Vec::new();
        for &(s, t) in &chunks {
            collected.extend_from_slice(&audio[s as usize..t as usize]);
        }
        let (features, frames) = self.fe.compute(&collected);
        let language = match language {
            Some(l) => l.to_string(),
            None => self.detect_language(e, &features, frames)?,
        };
        let lang_id = self
            .tok
            .token_to_id(&format!("<|{language}|>"))
            .ok_or_else(|| GlueError::Engine(format!("unknown language {language}")))?;
        let sot_sequence = [self.tok.sot, lang_id, self.tok.transcribe];
        let segments = self.generate_segments(e, &features, frames, &sot_sequence, words, &chunks)?;
        Ok((segments, language))
    }

    /// `detect_language(features=features[..., 0:])` with one 30 s segment and threshold 0.5: the top language either way.
    fn detect_language<E: WhisperEngine>(
        &self,
        e: &mut E,
        features: &[f32],
        frames: usize,
    ) -> Result<String, GlueError> {
        let n = frames.min(NB_MAX_FRAMES);
        let enc = e.encode(&encoder_input(features, self.fe.n_mels, frames, 0, n), self.fe.n_mels)?;
        let probs = e.detect_language(&enc)?;
        let token = &probs.first().ok_or_else(|| GlueError::Engine("detect_language returned nothing".into()))?.0;
        Ok(token.chars().skip(2).take(token.chars().count().saturating_sub(4)).collect())
    }

    fn generate_segments<E: WhisperEngine>(
        &self,
        e: &mut E,
        features: &[f32],
        frames: usize,
        sot_sequence: &[u32],
        words: bool,
        chunks: &[(i64, i64)],
    ) -> Result<Vec<Segment>, GlueError> {
        let content_frames = frames as i64 - 1;
        let clip = (0i64, content_frames); // clip_timestamps "0"
        let mut seek = clip.0;
        let mut done_clip = false;
        let mut encoder_output: Option<E::Enc> = None;
        let mut last_speech_timestamp = Num::Py(0.0);
        let mut out = Vec::new();
        while !done_clip {
            let clip_end = clip.1.min(content_frames);
            if seek < clip.0 {
                seek = clip.0;
            }
            if seek >= clip_end {
                done_clip = true;
                continue;
            }
            let time_offset = seek as f64 * 0.01; // seek * time_per_frame
            let segment_size = (NB_MAX_FRAMES as i64).min(content_frames - seek).min(clip_end - seek);
            let segment_duration = segment_size as f64 * 0.01;
            if seek > 0 || encoder_output.is_none() {
                let input = encoder_input(features, self.fe.n_mels, frames, seek as usize, segment_size as usize);
                encoder_output = Some(e.encode(&input, self.fe.n_mels)?);
            }
            let enc = encoder_output.as_ref().expect("encoded");
            let (result, avg_logprob) = self.generate_with_fallback(e, enc, sot_sequence)?;
            // Python's `not avg_logprob > -1.0`, NaN included.
            if result.no_speech_prob > 0.6 && avg_logprob.partial_cmp(&-1.0) != Some(std::cmp::Ordering::Greater) {
                seek += segment_size; // no voice activity
                continue;
            }
            let tokens = result.sequences_ids.first().cloned().unwrap_or_default();
            let (mut current, new_seek, single_ending) =
                self.split_segments(&tokens, time_offset, segment_size, segment_duration, seek);
            seek = new_seek;
            if words {
                self.add_word_timestamps(
                    e,
                    &mut current,
                    enc,
                    sot_sequence,
                    segment_size as usize,
                    last_speech_timestamp,
                )?;
                if !single_ending {
                    if let Some(lwe) = get_end(&current) {
                        if lwe.v() > time_offset {
                            seek = (lwe.v() * FRAMES_PER_SECOND as f64).round_ties_even() as i64;
                        }
                    }
                }
                if let Some(lwe) = get_end(&current) {
                    last_speech_timestamp = lwe;
                }
            }
            for s in current {
                let text = self.tok.decode(&s.tokens);
                if s.start.v() == s.end.v() || py_strip(&text).is_empty() {
                    continue;
                }
                let mut segment =
                    Segment { start: s.start, end: s.end, text, words: if words { Some(s.words) } else { None } };
                // `if speech_chunks: segments = restore_speech_timestamps(segments, ...)`, a generator: one segment at a time.
                if !chunks.is_empty() {
                    restore_speech_timestamps(std::slice::from_mut(&mut segment), chunks);
                }
                e.trace_segment(segment.end.v())?;
                out.push(segment);
            }
        }
        Ok(out)
    }

    fn generate_with_fallback<E: WhisperEngine>(
        &self,
        e: &mut E,
        enc: &E::Enc,
        prompt: &[u32],
    ) -> Result<(GenResult, f64), GlueError> {
        let max_initial_timestamp_index = (1.0f64 / TIME_PRECISION).round_ties_even() as usize;
        let mut all: Vec<(GenResult, f64, f64)> = Vec::new(); // (result, avg_logprob, compression ratio)
        let mut below_cr: Vec<usize> = Vec::new();
        for &temperature in &TEMPERATURES {
            let o = GenOptions {
                temperature,
                beam_size: if temperature > 0.0 { 1 } else { 5 },
                patience: 1.0,
                best_of: 5,
                length_penalty: 1.0,
                repetition_penalty: 1.0,
                no_repeat_ngram_size: 0,
                max_length: MAX_LENGTH,
                suppress_blank: true,
                suppress_tokens: self.suppress.clone(),
                max_initial_timestamp_index,
            };
            let result = e.generate(enc, prompt, &o)?;
            let tokens = result.sequences_ids.first().map(Vec::as_slice).unwrap_or(&[]);
            let seq_len = tokens.len() as f64;
            let cum_logprob = result.scores.first().copied().unwrap_or(f64::NAN) * seq_len; // seq_len ** length_penalty (1)
            let avg_logprob = cum_logprob / (seq_len + 1.0);
            let text = self.tok.decode(tokens);
            let text = py_strip(&text);
            let cr = compression_ratio(text);
            e.trace_compression_ratio(text, cr)?;
            let mut needs_fallback = false;
            if cr > 2.4 {
                needs_fallback = true; // too repetitive
            } else {
                below_cr.push(all.len());
            }
            if avg_logprob < -1.0 {
                needs_fallback = true;
            }
            if result.no_speech_prob > 0.6 && avg_logprob < -1.0 {
                needs_fallback = false; // silence
            }
            all.push((result, avg_logprob, cr));
            if !needs_fallback {
                let (r, lp, _) = all.pop().expect("pushed");
                return Ok((r, lp));
            }
        }
        // All failed: the highest average log probability (first maximum), among the results below the ratio threshold if any.
        let candidates: Vec<usize> = if below_cr.is_empty() { (0..all.len()).collect() } else { below_cr };
        let mut best = candidates[0];
        for &i in &candidates[1..] {
            if all[i].1 > all[best].1 {
                best = i;
            }
        }
        let (r, lp, _) = all.swap_remove(best);
        Ok((r, lp))
    }

    /// `_split_segments_by_timestamps`: the sub-segments, the new seek and whether the tokens end on a single timestamp.
    fn split_segments(
        &self,
        tokens: &[u32],
        time_offset: f64,
        segment_size: i64,
        segment_duration: f64,
        mut seek: i64,
    ) -> (Vec<SubSeg>, i64, bool) {
        let tb = self.tok.timestamp_begin();
        let pos = |t: u32| t as i64 - tb as i64;
        let n = tokens.len();
        let single_ending = n >= 2 && tokens[n - 2] < tb && tb <= tokens[n - 1];
        let consecutive: Vec<usize> = (1..n).filter(|&i| tokens[i] >= tb && tokens[i - 1] >= tb).collect();
        let mut segs = Vec::new();
        let sub = |start: f64, end: f64, toks: &[u32], seek: i64| SubSeg {
            seek,
            start: Num::Py(start),
            end: Num::Py(end),
            tokens: toks.to_vec(),
            words: Vec::new(),
        };
        if !consecutive.is_empty() {
            let mut slices = consecutive.clone();
            if single_ending {
                slices.push(n);
            }
            let mut last = 0;
            for &cur in &slices {
                let sliced = &tokens[last..cur];
                let start = time_offset + pos(sliced[0]) as f64 * TIME_PRECISION;
                let end = time_offset + pos(sliced[sliced.len() - 1]) as f64 * TIME_PRECISION;
                segs.push(sub(start, end, sliced, seek));
                last = cur;
            }
            if single_ending {
                seek += segment_size;
            } else {
                seek += pos(tokens[last - 1]) * INPUT_STRIDE;
            }
        } else {
            let mut duration = segment_duration;
            if let Some(&t) = tokens.iter().rfind(|&&t| t >= tb) {
                if t != tb {
                    duration = pos(t) as f64 * TIME_PRECISION;
                }
            }
            segs.push(sub(time_offset, time_offset + duration, tokens, seek));
            seek += segment_size;
        }
        (segs, seek, single_ending)
    }

    /// `find_alignment(tokenizer, text_tokens, encoder_output, num_frames)` (median filter width 7).
    fn find_alignment<E: WhisperEngine>(
        &self,
        e: &mut E,
        enc: &E::Enc,
        sot_sequence: &[u32],
        text_tokens: &[Vec<u32>],
        num_frames: usize,
    ) -> Result<Vec<Vec<AlignWord>>, GlueError> {
        if text_tokens.is_empty() {
            return Ok(Vec::new());
        }
        let results = e.align(enc, sot_sequence, text_tokens, num_frames, 7)?;
        let mut out = Vec::new();
        for (result, text_token) in results.iter().zip(text_tokens) {
            let with_eot: Vec<u32> = text_token.iter().copied().chain([self.tok.eot]).collect();
            let (words, word_tokens) = self.tok.split_to_word_tokens(&with_eot, sot_sequence[1])?; // [sot, language, transcribe]
            if word_tokens.len() <= 1 {
                out.push(Vec::new());
                continue;
            }
            // np.pad(np.cumsum([len(t) for t in word_tokens[:-1]]), (1, 0)); it has len(word_tokens) >= 2 entries here
            let mut boundaries = vec![0usize];
            for t in &word_tokens[..word_tokens.len() - 1] {
                boundaries.push(boundaries[boundaries.len() - 1] + t.len());
            }
            let al = &result.alignments;
            if al.is_empty() {
                // np.pad(np.diff([]), (1, 0), constant_values=1) is a 1-entry mask over an empty array
                return Err(GlueError::Index("boolean index did not match indexed array along axis 0; size of axis is 0 but size of corresponding boolean axis is 1".into()));
            }
            let jump_times: Vec<f64> = (0..al.len())
                .filter(|&i| i == 0 || al[i].0 != al[i - 1].0)
                .map(|i| al[i].1 as f64 / TOKENS_PER_SECOND as f64)
                .collect();
            if let Some(&bad) = boundaries.iter().find(|&&b| b >= jump_times.len()) {
                return Err(GlueError::Index(format!(
                    "index {bad} is out of bounds for axis 0 with size {}",
                    jump_times.len()
                )));
            }
            let n = boundaries.len() - 1; // zip() stops at the shortest list: start_times
            out.push(
                (0..n)
                    .map(|k| AlignWord {
                        word: words[k].clone(),
                        tokens: word_tokens[k].clone(),
                        start: Num::Np(jump_times[boundaries[k]]),
                        end: Num::Np(jump_times[boundaries[k + 1]]),
                    })
                    .collect(),
            );
            // shortcut: word probabilities are not computed; they only feed the hallucination checks, which the worker leaves off.
        }
        Ok(out)
    }

    /// `add_word_timestamps([current_segments], ...)` (one decoded window at a time, as `generate_segments` calls it).
    fn add_word_timestamps<E: WhisperEngine>(
        &self,
        e: &mut E,
        cur: &mut [SubSeg],
        enc: &E::Enc,
        sot_sequence: &[u32],
        num_frames: usize,
        mut last_speech_timestamp: Num,
    ) -> Result<(), GlueError> {
        let per_sub: Vec<Vec<u32>> =
            cur.iter().map(|s| s.tokens.iter().copied().filter(|&t| t < self.tok.eot).collect()).collect();
        let text_tokens = vec![per_sub.concat()];
        let mut alignments = self.find_alignment(e, enc, sot_sequence, &text_tokens, num_frames)?;
        let mut medians = Vec::new();
        for alignment in alignments.iter_mut() {
            let durations: Vec<f64> = alignment.iter().map(|w| w.end.v() - w.start.v()).filter(|&d| d != 0.0).collect();
            let median = if durations.is_empty() { 0.0 } else { np_median(&durations) };
            let median_duration = if median < 0.7 { median } else { 0.7 }; // min(0.7, float(median))
            let max_duration = median_duration * 2.0;
            if !durations.is_empty() {
                for i in 1..alignment.len() {
                    if alignment[i].end.v() - alignment[i].start.v() > max_duration {
                        if SENTENCE_END.contains(alignment[i].word.as_str()) {
                            alignment[i].end = alignment[i].start.add(Num::Py(max_duration));
                        } else if SENTENCE_END.contains(alignment[i - 1].word.as_str()) {
                            alignment[i].start = alignment[i].end.sub(Num::Py(max_duration));
                        }
                    }
                }
            }
            merge_punctuations(alignment);
            medians.push((median_duration, max_duration));
        }
        let alignment = &alignments[0];
        let (median_duration, max_duration) = medians[0];
        let time_offset = Num::Py(cur[0].seek as f64 / FRAMES_PER_SECOND as f64);
        let mut word_index = 0;
        for (si, sub) in cur.iter_mut().enumerate() {
            let mut saved = 0;
            let mut words: Vec<TWord> = Vec::new();
            while word_index < alignment.len() && saved < per_sub[si].len() {
                let timing = &alignment[word_index];
                if !timing.word.is_empty() {
                    words.push(TWord {
                        word: timing.word.clone(),
                        start: time_offset.add(timing.start).round2(),
                        end: time_offset.add(timing.end).round2(),
                    });
                }
                saved += timing.tokens.len();
                word_index += 1;
            }
            if !words.is_empty() {
                let max_d = Num::Py(max_duration);
                if words[0].end.v() - last_speech_timestamp.v() > median_duration * 4.0
                    && (words[0].end.v() - words[0].start.v() > max_duration
                        || (words.len() > 1 && words[1].end.v() - words[0].start.v() > max_duration * 2.0))
                {
                    if words.len() > 1 && words[1].end.v() - words[1].start.v() > max_duration {
                        let boundary = py_max(words[1].end.half(), words[1].end.sub(max_d));
                        words[0].end = boundary;
                        words[1].start = boundary;
                    }
                    words[0].start = py_max(Num::Int(0), words[0].end.sub(max_d));
                }
                if sub.start.v() < words[0].end.v() && sub.start.v() - 0.5 > words[0].start.v() {
                    words[0].start = py_max(Num::Int(0), py_min(words[0].end.sub(Num::Py(median_duration)), sub.start));
                } else {
                    sub.start = words[0].start;
                }
                let last = words.len() - 1;
                if sub.end.v() > words[last].start.v() && sub.end.v() + 0.5 < words[last].end.v() {
                    words[last].end = py_max(words[last].start.add(Num::Py(median_duration)), sub.end);
                } else {
                    sub.end = words[last].end;
                }
                last_speech_timestamp = sub.end;
            }
            sub.words = words;
        }
        Ok(())
    }
}

/// `get_end`: the end of the last word of the last segment with words, else the last segment's end.
fn get_end(segments: &[SubSeg]) -> Option<Num> {
    segments
        .iter()
        .rev()
        .flat_map(|s| s.words.iter().rev())
        .next()
        .map(|w| w.end)
        .or_else(|| segments.last().map(|s| s.end))
}

/// `merge_punctuations(alignment, prepend_punctuations, append_punctuations)`.
fn merge_punctuations(a: &mut [AlignWord]) {
    if a.len() >= 2 {
        let (mut i, mut j) = (a.len() as isize - 2, a.len() - 1);
        while i >= 0 {
            let iu = i as usize;
            if a[iu].word.starts_with(' ') && PREPEND.contains(py_strip(&a[iu].word)) {
                let (w, t) = (std::mem::take(&mut a[iu].word), std::mem::take(&mut a[iu].tokens));
                a[j].word = w + &a[j].word;
                a[j].tokens = [t, std::mem::take(&mut a[j].tokens)].concat();
            } else {
                j = iu;
            }
            i -= 1;
        }
    }
    let (mut i, mut j) = (0usize, 1usize);
    while j < a.len() {
        if !a[i].word.ends_with(' ') && APPEND.contains(a[j].word.as_str()) {
            let (w, t) = (std::mem::take(&mut a[j].word), std::mem::take(&mut a[j].tokens));
            a[i].word.push_str(&w);
            a[i].tokens.extend(t);
        } else {
            i = j;
        }
        j += 1;
    }
}

/// `restore_speech_timestamps` with `SpeechTimestampsMap(chunks, 16000)`.
fn restore_speech_timestamps(segments: &mut [Segment], chunks: &[(i64, i64)]) {
    let (mut chunk_end, mut silence_before) = (Vec::new(), Vec::new());
    let (mut previous_end, mut silent) = (0i64, 0i64);
    for &(s, t) in chunks {
        silent += s - previous_end;
        previous_end = t;
        chunk_end.push(t - silent);
        silence_before.push(silent as f64 / STT_RATE as f64);
    }
    let chunk_index = |time: f64, is_end: bool| -> usize {
        let sample = (time * STT_RATE as f64).trunc() as i64; // int(time * sampling_rate)
        if is_end {
            if let Some(i) = chunk_end.iter().position(|&c| c == sample) {
                return i;
            }
        }
        chunk_end.partition_point(|&c| c <= sample).min(chunk_end.len() - 1) // bisect.bisect (right)
    };
    let original = |time: Num, idx: usize| Num::Py(silence_before[idx]).add(time).round2();
    for seg in segments.iter_mut() {
        match seg.words.as_mut().filter(|w| !w.is_empty()) {
            Some(words) => {
                for w in words.iter_mut() {
                    let middle = w.start.add(w.end).half();
                    let idx = chunk_index(middle.v(), false);
                    w.start = original(w.start, idx);
                    w.end = original(w.end, idx);
                }
                seg.start = words[0].start;
                seg.end = words[words.len() - 1].end;
            }
            None => {
                seg.start = original(seg.start, chunk_index(seg.start.v(), false));
                seg.end = original(seg.end, chunk_index(seg.end.v(), true));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `round(x, 2)` and `np.round(np.float64(x), 2)` against the values the 1.0.16 runtime gave (`parity/stt/round_cases.py`).
    #[test]
    fn round2_matches_python_and_numpy() {
        let text =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/parity/stt/round.json")).expect("fixture");
        let v: serde_json::Value = serde_json::from_str(&text).expect("json");
        let cases = v["cases"].as_array().expect("cases");
        assert!(cases.len() > 10_000);
        for c in cases {
            let (x, py, np) = (c[0].as_f64().unwrap(), c[1].as_f64().unwrap(), c[2].as_f64().unwrap());
            assert_eq!(py_round2(x).to_bits(), py.to_bits(), "round({x:?}, 2)");
            assert_eq!(np_round2(x).to_bits(), np.to_bits(), "np.round({x:?}, 2)");
        }
    }

    #[test]
    fn strip_and_windows() {
        assert_eq!(py_strip("\u{1f} a b\u{3000}\n"), "a b");
        // Short audio is one window; a 700 s ramp is cut once, inside the last 30 s before 600 s.
        assert_eq!(stt_windows(&vec![0.1f32; 16000 * 10]), vec![0, 160000]);
        let ramp: Vec<f32> = (0..16000 * 700).map(|i| ((i % 16000) as f32 / 16000.0) - 0.5).collect();
        let cuts = stt_windows(&ramp);
        assert_eq!(cuts.len(), 3);
        assert!(cuts[1] >= 570 * 16000 && cuts[1] < 600 * 16000);
    }
    /// Every decode case with a `mel` record (`decode_cases.py --mel`): the log-Mel spectrogram with 80 and 128 mels, of the whole
    /// case and of its first 100 samples, bitwise against faster-whisper's on this machine (frame count and SHA-256).
    #[test]
    fn mel_matches_python() {
        use sha2::{Digest, Sha256};
        let Some(cases) = std::env::var_os("THANHAM_DECODE_CASES") else {
            eprintln!("THANHAM_DECODE_CASES not set: skipped");
            return;
        };
        let sp = crate::tts::site_packages();
        let blas = || OpenBlas::load_pinned(&sp.join("numpy.libs").join(crate::tts::OPENBLAS_DLL)).unwrap();
        let extractors = [FeatureExtractor::new(80, blas()), FeatureExtractor::new(128, blas())];
        println!(
            "mel: complex absolute {}",
            if extractors[0].fused { "fused (X86_V3/V4)" } else { "unfused (X86_V2)" }
        );
        let (mut same, mut differ) = (0, Vec::new());
        for line in std::fs::read_to_string(cases).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let case: serde_json::Value = serde_json::from_str(line).unwrap();
            let Some(want) = case.get("mel") else { continue };
            let path = case["path"].as_str().unwrap();
            let pcm = crate::stt::decode::decode_audio(&sp, path).unwrap();
            for fe in &extractors {
                for (part, audio) in [("full", &pcm[..]), ("head", &pcm[..pcm.len().min(100)])] {
                    let (features, frames) = fe.compute(audio);
                    let bytes: Vec<u8> = features.iter().flat_map(|v| v.to_le_bytes()).collect();
                    let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                    let w = &want[fe.n_mels.to_string()][part];
                    if w["frames"].as_u64() == Some(frames as u64) && w["sha256"].as_str() == Some(sha.as_str()) {
                        same += 1;
                    } else {
                        differ.push(format!("{path} {} {part}: {frames} frames {sha}, Python {w}", fe.n_mels));
                    }
                }
            }
        }
        println!("mel: {same} identical, {} differ", differ.len());
        assert!(differ.is_empty(), "{differ:#?}");
    }
}
