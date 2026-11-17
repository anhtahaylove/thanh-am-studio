//! Spike S1 skeleton: `thanham-worker.exe health`.
//!
//! One process that must run on a clean machine with only the shipped files next to it. It
//! 1. loads ONNX Runtime 1.31.1 through `ortffi` and runs the Silero VAD model once,
//! 2. runs one Whisper-small encode on the matched CTranslate2 engine (static MKL + oneDNN 3.1.1 + shim iomp),
//! 3. loads sea-g2p-rs and `tokenizers` (fancy-regex) once.
//!
//! usage: thanham-worker health [--ort <onnxruntime.dll>] [--whisper <dir>] [--silero <onnx>]
//!                              [--g2p-bin <sea_g2p.bin>] [--tokenizer <tokenizer.json>]
//!                              [--encode-out <file>] [--threads <n>] [--skip <ort,ct2,g2p>]
//! Every result is one JSON line on stdout; the exit code is 0 only if every requested step passed.

use std::ffi::{c_char, c_int, c_void};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use ct2rs_sys::{ComputeType, Config, Device, StorageView, Whisper};
use sha2::{Digest, Sha256};

// Forces the linker to keep the MKL libraries (ct2rs-sys references this crate the same way).
extern crate intel_onemkl_prebuild;

extern "C" {
    fn thanham_sv_copy_f32(sv: *const c_void, dst: *mut f32, cap: usize) -> usize;
    fn MKL_Get_Version_String(buffer: *mut c_char, len: c_int);
}

fn mkl_version() -> String {
    let mut buf = vec![0 as c_char; 512];
    // SAFETY: `buf` is 512 writable bytes and MKL writes a NUL-terminated string of at most `len` bytes.
    unsafe { MKL_Get_Version_String(buf.as_mut_ptr(), buf.len() as c_int) };
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Deterministic Whisper features `[1, n_mels, 3000]`: values `k/1024` with `k` in `-2048..2048` (exact in f32),
/// so the Python wheel can rebuild them bit for bit with numpy.
fn features(n: usize) -> Vec<f32> {
    (0..n as u64)
        .map(|i| {
            let h = (i.wrapping_mul(2_654_435_761)) & 0xFFFF_FFFF;
            let k = ((h >> 12) & 0xFFF) as i32 - 2048;
            k as f32 / 1024.0
        })
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

struct Args {
    ort: PathBuf,
    whisper: Option<PathBuf>,
    silero: Option<PathBuf>,
    g2p_bin: Option<PathBuf>,
    tokenizer: Option<PathBuf>,
    encode_out: Option<PathBuf>,
    threads: usize,
    skip: Vec<String>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let mut a = Args {
        ort: exe_dir.join("onnxruntime.dll"),
        whisper: None,
        silero: None,
        g2p_bin: None,
        tokenizer: None,
        encode_out: None,
        threads: 8,
        skip: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--ort" => a.ort = PathBuf::from(value()?),
            "--whisper" => a.whisper = Some(PathBuf::from(value()?)),
            "--silero" => a.silero = Some(PathBuf::from(value()?)),
            "--g2p-bin" => a.g2p_bin = Some(PathBuf::from(value()?)),
            "--tokenizer" => a.tokenizer = Some(PathBuf::from(value()?)),
            "--encode-out" => a.encode_out = Some(PathBuf::from(value()?)),
            "--threads" => a.threads = value()?.parse().map_err(|e| format!("--threads: {e}"))?,
            "--skip" => a.skip = value()?.split(',').map(str::to_string).collect(),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

fn step_ort(a: &Args) -> Result<String, String> {
    let env = ortffi::Env::load(&a.ort, "thanham-s1").map_err(|e| format!("{} {e}", e.worker_code()))?;
    let mut out = format!("\"version\":{}", json_str(env.version()));
    if let Some(model) = &a.silero {
        let mut opts = ortffi::SessionOptions::new(&env).map_err(|e| e.to_string())?;
        opts.intra_op_threads(1).and_then(|o| o.inter_op_threads(1)).map_err(|e| e.to_string())?;
        let session = ortffi::Session::from_file(&env, model, &opts).map_err(|e| e.to_string())?;
        let frames = 4usize;
        let audio = features(frames * 576);
        let (h, c) = (vec![0f32; 128], vec![0f32; 128]);
        let input = env.tensor(&audio, &[frames as i64, 576]).map_err(|e| e.to_string())?;
        let (hv, cv) = (env.tensor(&h, &[1, 1, 128]).map_err(|e| e.to_string())?, env.tensor(&c, &[1, 1, 128]).map_err(|e| e.to_string())?);
        let res = session.run(&[("input", &input), ("h", &hv), ("c", &cv)], &["speech_probs"]).map_err(|e| e.to_string())?;
        let probs = res[0].to_vec::<f32>().map_err(|e| e.to_string())?;
        let _ = write!(out, ",\"silero_probs_sha256\":{}", json_str(&sha256_hex(&probs.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<_>>())));
        let _ = write!(out, ",\"silero_n\":{}", probs.len());
    }
    Ok(out)
}

fn step_ct2(a: &Args) -> Result<String, String> {
    let dir = a.whisper.as_ref().ok_or("--whisper is required for the ct2 step")?;
    let t0 = Instant::now();
    let config = Config {
        device: Device::CPU,
        compute_type: ComputeType::INT8,
        num_threads_per_replica: a.threads,
        ..Config::default()
    };
    let whisper = Whisper::new(dir, config).map_err(|e| format!("load: {e}"))?;
    let load_ms = t0.elapsed().as_millis();
    let n_mels = whisper.n_mels();
    let mut feats = features(n_mels * 3000);
    let sv = StorageView::new(&[1, n_mels, 3000], &mut feats, Device::CPU).map_err(|e| format!("features: {e}"))?;
    let t1 = Instant::now();
    let enc = whisper.encode(&sv, true).map_err(|e| format!("encode: {e}"))?;
    let enc_ms = t1.elapsed().as_millis();
    let ptr = &*enc as *const _ as *const c_void;
    // SAFETY: `ptr` is the live ctranslate2::StorageView owned by `enc`; a null destination only asks for the element count.
    let n = unsafe { thanham_sv_copy_f32(ptr, std::ptr::null_mut(), 0) };
    let mut data = vec![0f32; n];
    // SAFETY: `data` holds exactly `n` writable floats.
    let copied = unsafe { thanham_sv_copy_f32(ptr, data.as_mut_ptr(), data.len()) };
    if copied != n {
        return Err("encoder output copy failed".into());
    }
    let raw: Vec<u8> = data.iter().flat_map(|f| f.to_le_bytes()).collect();
    if let Some(path) = &a.encode_out {
        std::fs::write(path, &raw).map_err(|e| format!("encode-out: {e}"))?;
    }
    Ok(format!(
        "\"mkl\":{},\"n_mels\":{n_mels},\"threads\":{},\"load_ms\":{load_ms},\"encode_ms\":{enc_ms},\"encoder_elements\":{n},\"encoder_sha256\":{},\"first\":[{}]",
        json_str(&mkl_version()),
        a.threads,
        json_str(&sha256_hex(&raw)),
        data.iter().take(4).map(|f| format!("{f:e}")).collect::<Vec<_>>().join(",")
    ))
}

fn step_g2p(a: &Args) -> Result<String, String> {
    let bin = a.g2p_bin.as_ref().ok_or("--g2p-bin is required for the g2p step")?;
    let dict = bin.to_str().ok_or("non-UTF-8 dictionary path")?;
    let norm = sea_g2p_rs::lang::vi::Normalizer::new("vi", Some(dict));
    let engine = sea_g2p_rs::g2p::G2PEngine::new(dict).map_err(|e| format!("dictionary: {e}"))?;
    let phonemes = engine.phonemize(&norm.normalize("Xin chào, đây là Thanh Âm.", true));
    let mut out = format!("\"phonemes\":{}", json_str(&phonemes));
    if let Some(tok) = &a.tokenizer {
        let tok = tokenizers::Tokenizer::from_file(tok).map_err(|e| format!("tokenizer: {e}"))?;
        let ids = tok.encode(phonemes.as_str(), false).map_err(|e| format!("encode: {e}"))?;
        let _ = write!(out, ",\"token_count\":{},\"token_ids_head\":{:?}", ids.get_ids().len(), &ids.get_ids()[..ids.get_ids().len().min(8)]);
    }
    Ok(out)
}

fn health(args: &[String]) -> ExitCode {
    let a = match parse(args) {
        Ok(a) => a,
        Err(e) => {
            println!("{{\"event\":\"error\",\"code\":\"WORKER_ERROR\",\"message\":{}}}", json_str(&e));
            return ExitCode::from(2);
        }
    };
    let mut ok = true;
    for (name, step) in [("ort", step_ort as fn(&Args) -> Result<String, String>), ("ct2", step_ct2), ("g2p", step_g2p)] {
        if a.skip.iter().any(|s| s == name) {
            continue;
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| step(&a))).unwrap_or_else(|_| Err("panic".into()));
        match r {
            Ok(body) => println!("{{\"step\":\"{name}\",\"ok\":true,{body}}}"),
            Err(e) => {
                ok = false;
                println!("{{\"step\":\"{name}\",\"ok\":false,\"error\":{}}}", json_str(&e));
            }
        }
    }
    println!("{{\"event\":\"health\",\"ok\":{ok}}}");
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("health") => health(&args[1..]),
        _ => {
            eprintln!("usage: thanham-worker health [options]");
            ExitCode::from(2)
        }
    }
}
