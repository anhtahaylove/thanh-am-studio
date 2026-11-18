//! `tts_op <plan.json> <out_dir> <reference_root>`: the preset `tts` batch operation in Rust, the counterpart of `worker/main.py tts()`.
//!
//! `plan.json` lists items `{id, voice_id, text?, speed?, parts: [{before, chunks, gaps}], trailing}` where `parts`/`chunks`/`gaps` are the
//! pause-mark split and the chunker output (rows L, ported in A4a; the S3 harness records Python's). Everything from the phonemes on is Rust.
//! Env: `THANHAM_TTS_SEED` (seeded draws as P0-A's `gen_tts.py`), `THANHAM_FFMPEG` (speed != 1).
//! Writes `<out_dir>/<id>.wav` and `<out_dir>/_results.jsonl` (one JSON line per item as the worker's item events carry them).

use s3_tts::audio::{self, py_round};
use s3_tts::engine::{Draws, Engine, EngineError, Paths, PRESET_TEMPERATURE};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[link(name = "psapi")]
extern "system" {
    fn GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> isize;
    fn SetPriorityClass(process: isize, class: u32) -> i32;
}

#[repr(C)]
struct Counters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set: usize,
    working_set: usize,
    rest: [usize; 6],
}

fn peak_working_set_mb() -> usize {
    let mut c = Counters { cb: std::mem::size_of::<Counters>() as u32, page_fault_count: 0, peak_working_set: 0, working_set: 0, rest: [0; 6] };
    // SAFETY: `c` is a correctly sized PROCESS_MEMORY_COUNTERS.
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    c.peak_working_set >> 20
}

fn silence(n: i64) -> Vec<f32> {
    vec![0.0f32; n.max(0) as usize]
}

/// `stretch(audio, speed, ffmpeg)`: FFmpeg `atempo` through the CLI, exactly the worker's arguments.
fn stretch(audio: &[f32], speed: f64, ffmpeg: &Path) -> Result<Vec<f32>, EngineError> {
    use std::process::{Command, Stdio};
    let werr = |m: String| EngineError { code: "AUDIO_PROCESS_FAILED", message: m };
    let mut child = Command::new(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-af"])
        .arg(format!("atempo={}", py_float_repr(speed)))
        .args(["-f", "f32le", "pipe:1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| werr(e.to_string()))?;
    let bytes: Vec<u8> = audio.iter().flat_map(|x| x.to_le_bytes()).collect();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&bytes);
    });
    let out = child.wait_with_output().map_err(|e| werr(e.to_string()))?;
    let _ = writer.join();
    if !out.status.success() {
        return Err(werr(String::from_utf8_lossy(&out.stderr).into_owned()));
    }
    Ok(out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

/// Python's `str(float)` for the speeds the app sends (`1.25`, `0.8`, `2.0`): the shortest round-trip form, with `.0` for integers.
fn py_float_repr(x: f64) -> String {
    let s = format!("{x}");
    if s.contains('.') || s.contains('e') {
        s
    } else {
        format!("{s}.0")
    }
}

fn run_item(engine: &Engine, draws: &mut Draws, item: &serde_json::Value, out_dir: &Path) -> Result<serde_json::Value, EngineError> {
    let id = item["id"].as_str().unwrap();
    let name = format!("{id}.wav");
    let final_path = out_dir.join(&name);
    if final_path.exists() {
        return Err(EngineError { code: "OUTPUT_EXISTS", message: "A take already exists at that output name.".into() });
    }
    let voice = engine.voice(item["voice_id"].as_str())?;
    let speed = item["speed"].as_f64().unwrap_or(1.0);
    let ffmpeg: Option<PathBuf> = if speed != 1.0 { Some(std::env::var("THANHAM_FFMPEG").map(PathBuf::from).map_err(|_| EngineError { code: "RUNTIME_MISSING", message: "ffmpeg is missing.".into() })?) } else { None };
    let parts = item["parts"].as_array().unwrap();
    let strs = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect::<Vec<_>>();
    let mut pieces: Vec<Vec<f32>> = Vec::new();
    let mut unstretched: Vec<Vec<f32>> = Vec::new();
    let mut call = 0usize;
    let len_of = |v: &[Vec<f32>]| v.iter().map(Vec::len).sum::<usize>() as i64;
    for part in parts {
        let before = part["before"].as_f64().unwrap();
        pieces.push(silence(py_round(before * 48000.0)));
        let reading = engine.infer_chunks(&strs(&part["chunks"]), &strs(&part["gaps"]), voice, PRESET_TEMPERATURE, draws, &name, &mut call)?;
        if let Some(ff) = &ffmpeg {
            unstretched.push(silence(py_round(len_of(&pieces) as f64 * speed) - len_of(&unstretched)));
            unstretched.push(reading.clone());
            pieces.push(stretch(&reading, speed, ff)?);
        } else {
            pieces.push(reading);
        }
    }
    let trailing = item["trailing"].as_f64().unwrap_or(0.0);
    let mut audio: Vec<f32> = pieces.concat();
    audio.extend(silence(py_round(trailing * 48000.0)));
    let abs_max = audio.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    if audio.is_empty() || !audio.iter().all(|x| x.is_finite()) || f64::from(abs_max) < 1e-7 {
        return Err(EngineError { code: "INVALID_AUDIO", message: "Engine returned empty, silent or non-finite audio.".into() });
    }
    let peak = f64::from(abs_max);
    let io = |e: std::io::Error| EngineError { code: "WORKER_ERROR", message: e.to_string() };
    let raw_path = out_dir.join(format!("{id}.raw.wav"));
    if ffmpeg.is_some() {
        let mut raw: Vec<f32> = unstretched.concat();
        raw.extend(silence(py_round(audio.len() as f64 * speed) - len_of(&unstretched)));
        audio::save_wav(&raw_path, &audio::limit_peak(&raw, peak)).map_err(io)?;
    }
    audio::save_wav(&final_path, &audio::limit_peak(&audio, peak)).map_err(io)?;
    let (start_ms, end_ms) = audio::speech_edges(&audio, parts[0]["before"].as_f64().unwrap() > 0.0, trailing > 0.0);
    let mut result = serde_json::json!({
        "path": final_path.to_string_lossy(), "duration_ms": py_round(audio.len() as f64 / 48.0), "sample_rate": 48000,
        "speech_start_ms": start_ms, "speech_end_ms": end_ms,
    });
    if ffmpeg.is_some() {
        result["raw_path"] = raw_path.to_string_lossy().into();
        result["speed"] = speed.into();
    }
    Ok(result)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // SAFETY: plain Win32 call; BelowNormal as the other agents share the machine during the spike.
    unsafe { SetPriorityClass(GetCurrentProcess(), 0x4000) };
    let args: Vec<String> = std::env::args().collect();
    let (plan, out_dir, root) = (PathBuf::from(&args[1]), PathBuf::from(&args[2]), PathBuf::from(&args[3]));
    let sp = root.join("runtime").join("python").join("Lib").join("site-packages");
    let paths = Paths {
        ort_dll: sp.join("onnxruntime").join("capi").join("onnxruntime.dll"),
        openblas_dll: sp.join("numpy.libs").join("libscipy_openblas64_-63c857e738469261263c764a36be9436.dll"),
        onnx_dir: root.join("models").join("vieneu-v3").join("backbone").join("onnx_update"),
        codec_dir: root.join("models").join("vieneu-v3").join("codec"),
        sea_g2p_bin: sp.join("sea_g2p").join("sea_g2p.bin"),
        voices_json: sp.join("vieneu").join("assets").join("voices_v3_turbo.json"),
    };
    let t0 = Instant::now();
    let engine = Engine::load(&paths)?;
    eprintln!("engine loaded in {:.1}s", t0.elapsed().as_secs_f64());
    std::fs::create_dir_all(&out_dir)?;
    let items: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(&plan)?)?;
    let log_path = out_dir.join("_results.jsonl");
    let done: std::collections::HashSet<String> = std::fs::read_to_string(&log_path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|r| r.get("result").is_some())
        .filter_map(|r| r["id"].as_str().map(str::to_string))
        .collect();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
    let mut draws = Draws::from_env();
    let t_run = Instant::now();
    let mut last = t_run;
    for item in items.iter().filter(|i| !done.contains(i["id"].as_str().unwrap())) {
        let rec = match run_item(&engine, &mut draws, item, &out_dir) {
            Ok(r) => serde_json::json!({"id": item["id"], "item_s": last.elapsed().as_secs_f64(), "result": r}),
            Err(e) => serde_json::json!({"id": item["id"], "item_s": last.elapsed().as_secs_f64(), "error": {"code": e.code, "message": e.message}}),
        };
        last = Instant::now();
        writeln!(log, "{rec}")?;
        eprintln!("{} {:.1}s", item["id"], t_run.elapsed().as_secs_f64());
    }
    writeln!(log, "{}", serde_json::json!({"id": "_process", "peak_working_set_mb": peak_working_set_mb(), "wall_s": t_run.elapsed().as_secs_f64()}))?;
    Ok(())
}
