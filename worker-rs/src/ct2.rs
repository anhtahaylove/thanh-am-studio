//! The statically linked STT engine (feature `ct2`): CTranslate2 4.8.5 built to match the Python wheel's engine
//! (`engine/build-engine.ps1`), and what `health` reports about it.

use crate::stt::glue::{AlignResult, GenOptions, GenResult};
use serde_json::{json, Value};
use std::ffi::{c_char, c_int, c_void, CString};

// Keeps the MKL libraries in the link (ct2rs-sys references the crate the same way), and CTranslate2 itself: rustc drops a crate
// nothing names from the link, with its native libraries, and only native/ct2_glue.cc calls into CTranslate2 outside the tests.
extern crate ct2rs_sys as _;
extern crate intel_onemkl_prebuild as _;

extern "C" {
    fn thanham_ct2_gemm_int8(dst: *mut c_char, cap: usize) -> usize;
    fn MKL_Get_Version_String(buffer: *mut c_char, len: c_int);
}

fn c_string(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// The CPU vendor string of CPUID leaf 0 (CTranslate2 takes MKL only on "GenuineIntel", as the wheel does).
fn cpu_vendor() -> String {
    let r = std::arch::x86_64::__cpuid(0);
    let bytes: Vec<u8> = [r.ebx, r.edx, r.ecx].iter().flat_map(|v| v.to_le_bytes()).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `health`'s `stt_engine`: the CPU vendor, the int8 GEMM backend CTranslate2 chose (`MKL` on GenuineIntel, else `DNNL`, as with
/// the wheel), `CT2_USE_MKL` as the process sees it, and the linked MKL build.
pub fn info() -> Value {
    let mut name = [0 as c_char; 32];
    let mut mkl = [0 as c_char; 512];
    // SAFETY: both buffers are writable for their full length; the callees write NUL-terminated strings that fit.
    unsafe {
        thanham_ct2_gemm_int8(name.as_mut_ptr(), name.len());
        MKL_Get_Version_String(mkl.as_mut_ptr(), mkl.len() as c_int);
    }
    json!({
        "ctranslate2": "4.8.5",
        "compiler": env!("THANHAM_CT2_COMPILER"),
        "cpu_vendor": cpu_vendor(),
        "gemm_int8": c_string(&name),
        "ct2_use_mkl": std::env::var("CT2_USE_MKL").ok(),
        "mkl": c_string(&mkl),
    })
}

/// `thanham_ct2_error` of native/ct2_glue.cc: the Python exception class the wheel's binding raises, and its message.
#[repr(C)]
struct Ct2Error {
    kind: [c_char; 32],
    message: [c_char; 1024],
}

impl Ct2Error {
    fn new() -> Self {
        Ct2Error { kind: [0; 32], message: [0; 1024] }
    }

    /// The worker's message for it: Python's `{type}: {str(exception)}`.
    fn text(&self) -> String {
        let text = |buf: &[c_char]| {
            let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        format!("{}: {}", text(&self.kind), text(&self.message))
    }
}

/// `thanham_whisper_options` of native/ct2_glue.cc.
#[repr(C)]
struct Options {
    beam_size: usize,
    patience: f32,
    num_hypotheses: usize,
    length_penalty: f32,
    repetition_penalty: f32,
    no_repeat_ngram_size: usize,
    max_length: usize,
    max_initial_timestamp_index: usize,
    suppress_blank: c_int,
    suppress_tokens: *const c_int,
    suppress_tokens_len: usize,
    sampling_topk: usize,
    sampling_temperature: f32,
}

extern "C" {
    fn thanham_whisper_load(model_dir: *const c_char, threads: usize, error: *mut Ct2Error) -> *mut c_void;
    fn thanham_whisper_free(whisper: *mut c_void);
    fn thanham_whisper_encode(
        whisper: *mut c_void,
        features: *const f32,
        n_mels: usize,
        frames: usize,
        error: *mut Ct2Error,
    ) -> *mut c_void;
    fn thanham_sv_free(sv: *mut c_void);
    fn thanham_whisper_generate(
        whisper: *mut c_void,
        features: *const c_void,
        prompt: *const usize,
        prompt_len: usize,
        options: *const Options,
        no_speech_prob: *mut f32,
        ctx: *mut c_void,
        sequence: unsafe extern "C" fn(*mut c_void, *const usize, usize, f32),
        error: *mut Ct2Error,
    ) -> c_int;
    fn thanham_whisper_align(
        whisper: *mut c_void,
        features: *const c_void,
        start: *const usize,
        start_len: usize,
        tokens: *const usize,
        token_lens: *const usize,
        texts: usize,
        num_frames: usize,
        median_filter_width: usize,
        ctx: *mut c_void,
        alignment: unsafe extern "C" fn(*mut c_void, *const i64, usize),
        error: *mut Ct2Error,
    ) -> c_int;
    fn thanham_whisper_detect_language(
        whisper: *mut c_void,
        features: *const c_void,
        ctx: *mut c_void,
        language: unsafe extern "C" fn(*mut c_void, *const c_char, f32),
        error: *mut Ct2Error,
    ) -> c_int;
}

/// A CTranslate2 Whisper model, loaded as faster-whisper's `WhisperModel(model_dir, device='cpu', compute_type='int8',
/// cpu_threads=threads)` loads it.
pub struct Whisper(*mut c_void);

/// An encoder output (`model.encode(...)`), owned.
pub struct Encoded(*mut c_void);

impl Drop for Whisper {
    fn drop(&mut self) {
        // SAFETY: the pointer came from thanham_whisper_load and is freed once.
        unsafe { thanham_whisper_free(self.0) }
    }
}

impl Drop for Encoded {
    fn drop(&mut self) {
        // SAFETY: the pointer came from thanham_whisper_encode and is freed once.
        unsafe { thanham_sv_free(self.0) }
    }
}

// The engine's result callbacks: each pushes into the Vec its context points to.
unsafe extern "C" fn push_sequence(ctx: *mut c_void, ids: *const usize, n: usize, score: f32) {
    // SAFETY: `ctx` is the `Vec<(Vec<u32>, f64)>` of `generate`, alive and not otherwise borrowed during the call.
    let out = unsafe { &mut *(ctx as *mut Vec<(Vec<u32>, f64)>) };
    // SAFETY: the engine passes `n` readable ids.
    let ids = if n == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(ids, n) } };
    out.push((ids.iter().map(|&i| i as u32).collect(), f64::from(score)));
}

unsafe extern "C" fn push_alignment(ctx: *mut c_void, pairs: *const i64, n: usize) {
    // SAFETY: `ctx` is the `Vec<AlignResult>` of `align`, alive and not otherwise borrowed during the call.
    let out = unsafe { &mut *(ctx as *mut Vec<AlignResult>) };
    // SAFETY: the engine passes `n` pairs as 2n readable values.
    let pairs = if n == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(pairs, 2 * n) } };
    out.push(AlignResult { alignments: pairs.chunks_exact(2).map(|p| (p[0], p[1])).collect() });
}

unsafe extern "C" fn push_language(ctx: *mut c_void, token: *const c_char, probability: f32) {
    // SAFETY: `ctx` is the `Vec<(String, f64)>` of `detect_language`, alive and not otherwise borrowed during the call.
    let out = unsafe { &mut *(ctx as *mut Vec<(String, f64)>) };
    // SAFETY: the engine passes a NUL-terminated token.
    let token = unsafe { std::ffi::CStr::from_ptr(token) }.to_string_lossy().into_owned();
    out.push((token, f64::from(probability)));
}

impl Whisper {
    /// `threads` is the worker's `cpu_threads`. The error is the worker's message (`RuntimeError: ...` and the like).
    pub fn load(model_dir: &str, threads: usize) -> Result<Whisper, String> {
        let path = CString::new(model_dir).map_err(|_| "ValueError: embedded null character".to_string())?;
        let mut error = Ct2Error::new();
        // SAFETY: a NUL-terminated path and a writable error buffer.
        let whisper = unsafe { thanham_whisper_load(path.as_ptr(), threads, &mut error) };
        if whisper.is_null() {
            Err(error.text())
        } else {
            Ok(Whisper(whisper))
        }
    }

    /// `model.encode(features)`: `features` is `[1, n_mels, frames]` row-major.
    pub fn encode(&self, features: &[f32], n_mels: usize) -> Result<Encoded, String> {
        let mut error = Ct2Error::new();
        // SAFETY: `features` holds n_mels * frames floats and outlives the call (the engine only reads it during it).
        let out =
            unsafe { thanham_whisper_encode(self.0, features.as_ptr(), n_mels, features.len() / n_mels, &mut error) };
        if out.is_null() {
            Err(error.text())
        } else {
            Ok(Encoded(out))
        }
    }

    /// `generate_with_fallback`'s `self.model.generate(encoder_output, [prompt], ..., **kwargs)[0]`, with faster-whisper's
    /// kwargs: beam search at temperature 0, else `num_hypotheses=best_of`, `sampling_topk=0` and the temperature.
    pub fn generate(&self, enc: &Encoded, prompt: &[u32], o: &GenOptions) -> Result<GenResult, String> {
        let sampling = o.temperature > 0.0;
        let suppress: Vec<c_int> = o.suppress_tokens.iter().map(|&t| t as c_int).collect();
        let options = Options {
            beam_size: if sampling { 1 } else { o.beam_size },
            patience: if sampling { 1.0 } else { o.patience as f32 },
            num_hypotheses: if sampling { o.best_of } else { 1 },
            length_penalty: o.length_penalty as f32,
            repetition_penalty: o.repetition_penalty as f32,
            no_repeat_ngram_size: o.no_repeat_ngram_size,
            max_length: o.max_length,
            max_initial_timestamp_index: o.max_initial_timestamp_index,
            suppress_blank: c_int::from(o.suppress_blank),
            suppress_tokens: suppress.as_ptr(),
            suppress_tokens_len: suppress.len(),
            sampling_topk: if sampling { 0 } else { 1 },
            sampling_temperature: if sampling { o.temperature as f32 } else { 1.0 },
        };
        let prompt: Vec<usize> = prompt.iter().map(|&t| t as usize).collect();
        let mut sequences: Vec<(Vec<u32>, f64)> = Vec::new();
        let (mut no_speech_prob, mut error) = (0f32, Ct2Error::new());
        // SAFETY: every pointer is valid for the call; push_sequence gets `sequences` as its context.
        let status = unsafe {
            thanham_whisper_generate(
                self.0,
                enc.0,
                prompt.as_ptr(),
                prompt.len(),
                &options,
                &mut no_speech_prob,
                (&mut sequences as *mut Vec<(Vec<u32>, f64)>).cast(),
                push_sequence,
                &mut error,
            )
        };
        if status != 0 {
            return Err(error.text());
        }
        let (sequences_ids, scores) = sequences.into_iter().unzip();
        Ok(GenResult { sequences_ids, scores, no_speech_prob: f64::from(no_speech_prob) })
    }

    /// `model.align(encoder_output, start, text_tokens, num_frames, median_filter_width=...)`.
    pub fn align(
        &self,
        enc: &Encoded,
        start: &[u32],
        text: &[Vec<u32>],
        num_frames: usize,
        median_filter_width: usize,
    ) -> Result<Vec<AlignResult>, String> {
        let start: Vec<usize> = start.iter().map(|&t| t as usize).collect();
        let tokens: Vec<usize> = text.iter().flatten().map(|&t| t as usize).collect();
        let lens: Vec<usize> = text.iter().map(Vec::len).collect();
        let mut out: Vec<AlignResult> = Vec::new();
        let mut error = Ct2Error::new();
        // SAFETY: every pointer is valid for the call; push_alignment gets `out` as its context.
        let status = unsafe {
            thanham_whisper_align(
                self.0,
                enc.0,
                start.as_ptr(),
                start.len(),
                tokens.as_ptr(),
                lens.as_ptr(),
                text.len(),
                num_frames,
                median_filter_width,
                (&mut out as *mut Vec<AlignResult>).cast(),
                push_alignment,
                &mut error,
            )
        };
        if status != 0 {
            return Err(error.text());
        }
        Ok(out)
    }

    /// `model.detect_language(encoder_output)[0]`.
    pub fn detect_language(&self, enc: &Encoded) -> Result<Vec<(String, f64)>, String> {
        let mut out: Vec<(String, f64)> = Vec::new();
        let mut error = Ct2Error::new();
        // SAFETY: every pointer is valid for the call; push_language gets `out` as its context.
        let status = unsafe {
            thanham_whisper_detect_language(
                self.0,
                enc.0,
                (&mut out as *mut Vec<(String, f64)>).cast(),
                push_language,
                &mut error,
            )
        };
        if status != 0 {
            return Err(error.text());
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use ct2rs_sys::{ComputeType, Config, Device, StorageView, Whisper};
    use std::ffi::c_void;

    extern "C" {
        fn thanham_sv_copy_f32(sv: *const c_void, dst: *mut f32, cap: usize) -> usize;
    }

    /// Deterministic encoder input `[1, n_mels, 3000]` (spike S1's): `k / 1024` for `k` in `-2048..2048`, exact in float32.
    fn features(n: usize) -> Vec<f32> {
        (0..n as u64)
            .map(|i| {
                let h = i.wrapping_mul(2_654_435_761) & 0xFFFF_FFFF;
                let k = ((h >> 12) & 0xFFF) as i32 - 2048;
                (f64::from(k) / 1024.0) as f32
            })
            .collect()
    }

    /// The worker's engine settings: int8 on the CPU, `min(8, cpu_count)` threads (main.py `stt`).
    fn load(model: &std::ffi::OsStr) -> Whisper {
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
        let config = Config {
            device: Device::CPU,
            compute_type: ComputeType::INT8,
            num_threads_per_replica: threads,
            ..Config::default()
        };
        Whisper::new(model.to_str().unwrap(), config).unwrap()
    }

    /// `whisper.encode(features)` of a `[1, n_mels, 3000]` input, as float32.
    fn encode(whisper: &Whisper, mut feats: Vec<f32>) -> Vec<f32> {
        let n_mels = whisper.n_mels();
        let sv = StorageView::new(&[1, n_mels, 3000], &mut feats, Device::CPU).unwrap();
        let enc = whisper.encode(&sv, false).unwrap();
        let ptr = &*enc as *const _ as *const c_void;
        // SAFETY: `ptr` is the live ctranslate2::StorageView owned by `enc`; a null destination only asks for the count.
        let count = unsafe { thanham_sv_copy_f32(ptr, std::ptr::null_mut(), 0) };
        let mut out = vec![0f32; count];
        // SAFETY: `out` holds exactly `count` writable floats.
        assert_eq!(unsafe { thanham_sv_copy_f32(ptr, out.as_mut_ptr(), count) }, count);
        out
    }

    /// The engine's encoder output equals the Python wheel's bitwise on this machine: `THANHAM_CT2_MODEL` is a Whisper model
    /// folder and `THANHAM_CT2_REFERENCE` the wheel's output for the same input (`parity/ct2_encode.py`), both int8 and with the
    /// worker's thread count. Skipped when they are not set.
    #[test]
    fn encode_matches_the_wheel() {
        let (Some(model), Some(reference)) =
            (std::env::var_os("THANHAM_CT2_MODEL"), std::env::var_os("THANHAM_CT2_REFERENCE"))
        else {
            eprintln!("THANHAM_CT2_MODEL / THANHAM_CT2_REFERENCE not set: skipped");
            return;
        };
        let whisper = load(&model);
        let n_mels = whisper.n_mels();
        let out = encode(&whisper, features(n_mels * 3000));
        let got: Vec<u8> = out.iter().flat_map(|v| v.to_le_bytes()).collect();
        let want = std::fs::read(reference).unwrap();
        let differing = got.chunks(4).zip(want.chunks(4)).filter(|(a, b)| a != b).count();
        println!("encoder: {} floats, {differing} differ from the wheel; engine {}", out.len(), super::info());
        assert_eq!(got.len(), want.len());
        assert_eq!(differing, 0);
    }

    /// Row T1e, run locally: the encoder on recorded inputs, listed as spike S4's `t1e.py list` writes them
    /// (`<features file>\t<byte offset>\t<out file>` per line), each output written for `t1e.py compare`. Start the test process
    /// pinned to one core type (S4 finding F-S4-1); `THANHAM_CT2_MODEL` and `THANHAM_T1E_LIST`.
    #[test]
    #[ignore = "local T1e runs on recorded inputs"]
    fn encode_list() {
        let (model, list) =
            (std::env::var_os("THANHAM_CT2_MODEL").unwrap(), std::env::var_os("THANHAM_T1E_LIST").unwrap());
        let whisper = load(&model);
        let n = whisper.n_mels() * 3000;
        println!("engine {}", super::info());
        for line in std::fs::read_to_string(list).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let [feat, offset, out] = line.split('\t').collect::<Vec<_>>()[..] else { panic!("bad list line: {line}") };
            let raw = std::fs::read(feat).unwrap();
            let at: usize = offset.parse().unwrap();
            let feats =
                raw[at..at + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            let bytes: Vec<u8> = encode(&whisper, feats).iter().flat_map(|v| v.to_le_bytes()).collect();
            std::fs::write(out, bytes).unwrap();
        }
    }
}
