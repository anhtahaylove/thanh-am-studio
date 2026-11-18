//! FFmpeg and ffprobe access: `executable`, `run_process`, `loudness`, `probe` and a WAV frame count.

use crate::error::{Result, WorkerError};
use crate::paths::resolve;
use crate::pyfmt::{round_half_even, tail_chars, truthy, universal_newlines};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `shutil.which`: the current folder first on Windows, then every `PATH` folder, trying the `PATHEXT` suffixes.
fn which(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        dirs.push(PathBuf::from("."));
    }
    dirs.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
    let names: Vec<String> = if cfg!(windows) {
        let exts: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(str::to_lowercase)
            .collect();
        let has_ext = exts.iter().any(|e| !e.is_empty() && name.to_lowercase().ends_with(e.as_str()));
        let suffixed = exts.iter().map(|e| format!("{name}{e}"));
        if has_ext {
            std::iter::once(name.to_string()).chain(suffixed).collect()
        } else {
            suffixed.collect()
        }
    } else {
        vec![name.to_string()]
    };
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// The tool to run: the explicit path, else `THANHAM_<NAME>`, else `PATH`; `RUNTIME_MISSING` when it is not a file.
pub fn executable(name: &str, explicit: Option<&str>) -> Result<String> {
    let configured = explicit
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var(format!("THANHAM_{}", name.to_uppercase())).ok().filter(|s| !s.is_empty()));
    let candidate = configured.map(PathBuf::from).or_else(|| which(name));
    match candidate {
        Some(c) if c.is_file() => Ok(resolve(&c).to_string_lossy().into_owned()),
        _ => Err(WorkerError::new(
            "RUNTIME_MISSING",
            format!("{name} is missing. Install the bundled audio runtime in Settings."),
        )),
    }
}

/// Output of a finished tool, decoded the way Python's `subprocess.run(text=True, errors='replace')` decodes it.
pub struct Finished {
    /// Exit code (`-1` when the process was killed).
    pub code: i32,
    /// Standard output text.
    pub stdout: String,
    /// Standard error text.
    pub stderr: String,
}

fn decode(bytes: &[u8]) -> String {
    universal_newlines(&String::from_utf8_lossy(bytes))
}

/// Runs a tool to completion with no console window, optional stdin bytes, and both output streams captured.
pub fn spawn_capture(args: &[String], stdin: Option<&[u8]>) -> Result<Output> {
    let mut command = Command::new(&args[0]);
    command
        .args(&args[1..])
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|e| WorkerError::py("FileNotFoundError", e))?;
    let feeder = stdin.map(|data| {
        let mut pipe = child.stdin.take().expect("piped stdin");
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = std::io::Write::write_all(&mut pipe, &data);
        })
    });
    let output = child.wait_with_output().map_err(|e| WorkerError::py("OSError", e))?;
    if let Some(feeder) = feeder {
        let _ = feeder.join();
    }
    Ok(output)
}

fn finished(args: &[String]) -> Result<Finished> {
    let out = spawn_capture(args, None)?;
    Ok(Finished { code: out.status.code().unwrap_or(-1), stdout: decode(&out.stdout), stderr: decode(&out.stderr) })
}

fn failure(done: &Finished, fallback: &str) -> WorkerError {
    let tail = tail_chars(&done.stderr, 2500);
    WorkerError::new("AUDIO_PROCESS_FAILED", if tail.is_empty() { fallback } else { tail })
}

/// Runs a tool and returns its standard output; a nonzero exit is `AUDIO_PROCESS_FAILED` with the end of stderr.
pub fn run_process(args: &[String]) -> Result<String> {
    let done = finished(args)?;
    if done.code != 0 {
        return Err(failure(&done, "Audio process failed."));
    }
    Ok(done.stdout)
}

/// Integrated loudness in LUFS (EBU R128; `-inf` for silence) of the audio the filtergraph `graph` makes from `inputs`.
pub fn loudness(ffmpeg: &str, inputs: &[String], graph: &str) -> Result<f64> {
    let mut args: Vec<String> = vec![ffmpeg.into(), "-nostdin".into(), "-hide_banner".into(), "-nostats".into()];
    args.extend(inputs.iter().cloned());
    args.extend([
        "-filter_complex".into(),
        format!("{graph},loudnorm=print_format=json"),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    let done = finished(&args)?;
    if done.code != 0 {
        return Err(failure(&done, "Loudness measurement failed."));
    }
    // loudnorm prints its measurement as the last JSON object
    let log = &done.stderr;
    let (Some(open), Some(close)) = (log.rfind('{'), log.rfind('}')) else {
        return Err(WorkerError::py("ValueError", "substring not found"));
    };
    let parsed: Value = log
        .get(open..=close)
        .and_then(|s| serde_json::from_str(s).ok())
        .ok_or_else(|| WorkerError::py("JSONDecodeError", "Expecting value"))?;
    let input_i = parsed.get("input_i").ok_or_else(|| WorkerError::py("KeyError", "'input_i'"))?;
    as_float(input_i)
}

/// Sample frames in a WAV file (what `soundfile.info(path).frames` reports), read from the RIFF chunk list.
pub fn wav_frames(path: &Path) -> Result<i64> {
    let data = std::fs::read(path).map_err(|e| WorkerError::py("OSError", e))?;
    let bad = || WorkerError::py("LibsndfileError", "not a WAV file");
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(bad());
    }
    let (mut at, mut frame_bytes) = (12usize, 0i64);
    while at + 8 <= data.len() {
        let id = &data[at..at + 4];
        let size = u32::from_le_bytes(data[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = at + 8;
        if id == b"fmt " && body + 16 <= data.len() {
            let channels = u16::from_le_bytes(data[body + 2..body + 4].try_into().unwrap()) as i64;
            let bits = u16::from_le_bytes(data[body + 14..body + 16].try_into().unwrap()) as i64;
            frame_bytes = channels * bits / 8;
        } else if id == b"data" {
            let available = data.len() - body;
            let length = if size == 0xFFFF_FFFF || size > available { available } else { size };
            return if frame_bytes > 0 { Ok(length as i64 / frame_bytes) } else { Err(bad()) };
        }
        at = body + size + (size & 1);
    }
    Err(bad())
}

/// ffprobe of the first audio stream: `{path, duration_ms, sample_rate, channels}`.
pub fn probe(path: &str, ffmpeg_path: Option<&str>) -> Result<Value> {
    let path = resolve(Path::new(path));
    if !path.is_file() {
        return Err(WorkerError::new("INPUT_MISSING", "The selected media file no longer exists."));
    }
    let ffprobe = match ffmpeg_path.filter(|s| !s.is_empty()) {
        Some(ffmpeg) => Path::new(ffmpeg)
            .with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" })
            .to_string_lossy()
            .into_owned(),
        None => executable("ffprobe", None)?,
    };
    let mut args: Vec<String> = [&ffprobe[..], "-v", "error", "-select_streams", "a:0", "-show_entries"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend([
        "format=duration:stream=duration,sample_rate,channels".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ]);
    let result: Value =
        serde_json::from_str(&run_process(&args)?).map_err(|e| WorkerError::py("JSONDecodeError", e))?;
    let streams = result.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(stream) = streams.first() else {
        return Err(WorkerError::new("NO_AUDIO", "The file has no audio stream."));
    };
    let present = |v: Option<&Value>| v.filter(|v| truthy(v)).cloned();
    let Some(duration) = present(result.pointer("/format/duration")).or_else(|| present(stream.get("duration"))) else {
        return Err(WorkerError::new("INVALID_MEDIA", "Audio duration is unavailable."));
    };
    let seconds = as_float(&duration)?;
    let sample_rate = stream.get("sample_rate").ok_or_else(|| WorkerError::py("KeyError", "'sample_rate'"))?;
    let channels = stream.get("channels").map_or(Ok(1), as_int)?;
    Ok(
        json!({"path": path.to_string_lossy(), "duration_ms": round_half_even(seconds * 1000.0), "sample_rate": as_int(sample_rate)?, "channels": channels}),
    )
}

fn as_float(v: &Value) -> Result<f64> {
    match v {
        Value::Number(n) => Ok(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| WorkerError::py("ValueError", format!("could not convert string to float: '{s}'"))),
        other => Err(WorkerError::py(
            "TypeError",
            format!("float() argument must be a string or a real number, not '{other}'"),
        )),
    }
}

fn as_int(v: &Value) -> Result<i64> {
    match v {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .ok_or_else(|| WorkerError::py("OverflowError", "int too large")),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| WorkerError::py("ValueError", format!("invalid literal for int() with base 10: '{s}'"))),
        other => Err(WorkerError::py(
            "TypeError",
            format!("int() argument must be a string or a real number, not '{other}'"),
        )),
    }
}
