//! `tts` for preset voices: `tts()` in `worker/main.py` (checks, pause marks, speed, raw reading, WAV files, per-item events) over the
//! ported VieNeu engine. Cloned voices and take checks stay on the Python worker: a request that asks for either is refused with
//! `WORKER_ERROR` before any event, so the desktop reruns it there.

mod audio;
mod blas;
mod engine;
mod exp;
mod front;
mod head;
mod mt19937;
mod np;
mod npy;
mod pyuni;
mod sort;
mod text;

use crate::download::verify_model;
use crate::error::{Result, WorkerError};
use crate::media::{executable, spawn_capture};
use crate::paths::contained_path;
use crate::pyfmt::{float_repr, tail_chars, truthy};
use crate::render::number;
use engine::{Draws, Engine, Paths, Voice, PRESET_TEMPERATURE};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// numpy's OpenBLAS, which the engine head loads from the private Python runtime.
const OPENBLAS_DLL: &str = "libscipy_openblas64_-63c857e738469261263c764a36be9436.dll";

/// The private Python runtime's `site-packages`: next to `THANHAM_PYTHON` when set, else `runtime\python` beside the `worker` folder.
fn site_packages() -> PathBuf {
    let python = std::env::var_os("THANHAM_PYTHON").filter(|p| !p.is_empty()).map(PathBuf::from).unwrap_or_else(|| {
        let exe = std::env::current_exe().unwrap_or_default();
        exe.parent().and_then(Path::parent).unwrap_or(Path::new(".")).join("runtime").join("python").join("python.exe")
    });
    python.parent().unwrap_or(Path::new(".")).join("Lib").join("site-packages")
}

/// `item.get(key)` is truthy.
fn asks(item: &Value, key: &str) -> bool {
    item.get(key).is_some_and(truthy)
}

/// `stretch(audio, speed, ffmpeg)`: FFmpeg `atempo` over raw float32 samples.
fn stretch(audio: &[f32], speed: &Value, ffmpeg: &str) -> Result<Vec<f32>> {
    // f'atempo={speed}': an int prints without a decimal point
    let tempo = speed.as_i64().map_or_else(|| float_repr(speed.as_f64().unwrap_or(1.0)), |n| n.to_string());
    let args: Vec<String> =
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", "48000", "-ac", "1"]
            .into_iter()
            .chain(["-i", "pipe:0", "-af", &format!("atempo={tempo}"), "-f", "f32le", "pipe:1"])
            .map(str::to_string)
            .collect();
    let input: Vec<u8> = audio.iter().flat_map(|x| x.to_le_bytes()).collect();
    let out = spawn_capture(&args, Some(&input))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = tail_chars(&stderr, 2500);
        return Err(WorkerError::new(
            "AUDIO_PROCESS_FAILED",
            if tail.is_empty() { "Speed change failed." } else { tail },
        ));
    }
    Ok(out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

fn silence(n: i64) -> Vec<f32> {
    vec![0.0; n.max(0) as usize]
}

fn total(parts: &[Vec<f32>]) -> i64 {
    parts.iter().map(Vec::len).sum::<usize>() as i64
}

/// `synth(item)`: one take, or the error to report for it.
fn synth(engine: &Engine, draws: &mut Draws, item: &Value, output_dir: &Path) -> Result<Value> {
    let name = match item.get("output_name") {
        Some(v) if !truthy(v) => uuid::Uuid::new_v4().to_string() + ".wav",
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(WorkerError::py("TypeError", "expected str, bytes or os.PathLike object")),
        None => uuid::Uuid::new_v4().to_string() + ".wav",
    };
    if Path::new(&name).extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() != Some("wav") {
        return Err(WorkerError::new("INVALID_PATH", "TTS output must be a WAV file."));
    }
    let final_path = contained_path(output_dir, &name)?;
    if final_path.exists() {
        return Err(WorkerError::new("OUTPUT_EXISTS", "A take already exists at that output name."));
    }
    let (parts, trailing) = text::split_pauses(item["text"].as_str().unwrap_or_default())?;
    let speed_value = item.get("speed").cloned().unwrap_or(json!(1));
    let speed = number(Some(&speed_value), "speed", 0.5, 2.0)?;
    let ffmpeg =
        if speed != 1.0 { Some(executable("ffmpeg", item.get("ffmpeg_path").and_then(Value::as_str))?) } else { None };
    let voice: &Voice = engine.voice(item.get("voice_id").filter(|v| truthy(v)))?;
    let (mut pieces, mut unstretched): (Vec<Vec<f32>>, Vec<Vec<f32>>) = (Vec::new(), Vec::new());
    let mut call = 0;
    for (chunk, before) in &parts {
        pieces.push(silence(audio::py_round(before * 48000.0)));
        let reading = engine.infer(chunk, voice, PRESET_TEMPERATURE, draws, &name, &mut call)?;
        if let Some(ff) = &ffmpeg {
            unstretched.push(silence(audio::py_round(total(&pieces) as f64 * speed) - total(&unstretched)));
            pieces.push(stretch(&reading, &speed_value, ff)?);
            unstretched.push(reading);
        } else {
            pieces.push(reading);
        }
    }
    let mut samples = pieces.concat();
    samples.extend(silence(audio::py_round(trailing * 48000.0)));
    let peak = samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    if samples.is_empty() || !samples.iter().all(|x| x.is_finite()) || f64::from(peak) < 1e-7 {
        return Err(WorkerError::new("INVALID_AUDIO", "Engine returned empty, silent or non-finite audio."));
    }
    let peak = f64::from(peak);
    let save = |path: &Path, data: &[f32]| {
        audio::save_wav(path, &audio::limit_peak(data, peak)).map_err(|e| WorkerError::py("OSError", e))
    };
    let stem = final_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let raw_path = final_path.with_file_name(format!("{stem}.raw.wav"));
    if ffmpeg.is_some() {
        let mut raw = unstretched.concat();
        raw.extend(silence(audio::py_round(samples.len() as f64 * speed) - total(&unstretched)));
        save(&raw_path, &raw)?;
    }
    save(&final_path, &samples)?;
    // Pause marks at the very start or end are wanted silence, so that edge stays.
    let (start_ms, end_ms) = audio::speech_edges(&samples, parts[0].1 > 0.0, trailing > 0.0);
    let mut result = json!({"path": final_path.to_string_lossy(), "duration_ms": audio::py_round(samples.len() as f64 / 48.0),
        "sample_rate": 48000, "speech_start_ms": start_ms, "speech_end_ms": end_ms});
    if ffmpeg.is_some() {
        result["raw_path"] = json!(raw_path.to_string_lossy());
        result["speed"] = speed_value;
    }
    Ok(result)
}

/// `tts(payload, output_dir, progress, emit_item)`: one item, or `payload["items"]` with one engine load, each reported through
/// `emit_item(index, "result" | "error", value)`.
pub fn tts(
    payload: &Map<String, Value>,
    output_dir: &Path,
    progress: &dyn Fn(f64, &str),
    emit_item: &dyn Fn(usize, &str, Value),
) -> Result<Value> {
    let batch = payload.contains_key("items");
    let single = [Value::Object(payload.clone())];
    let listed = if batch { payload["items"].as_array().map(Vec::as_slice) } else { Some(&single[..]) };
    if listed.unwrap_or_default().iter().any(|i| asks(i, "reference_path") || asks(i, "check_model_path")) {
        return Err(WorkerError::new("WORKER_ERROR", "Cloned voices and take checks run on the Python worker."));
    }
    let model_dir = match payload.get("model_path") {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(WorkerError::py("TypeError", "expected str, bytes or os.PathLike object")),
    };
    let model_dir = PathBuf::from(model_dir);
    verify_model(&model_dir, "vieneu-v3")?;
    let items = match listed {
        Some(items) if (1..=1000).contains(&items.len()) => items,
        _ => return Err(WorkerError::new("INVALID_REQUEST", "items must list 1..1000 segments.")),
    };
    for item in items {
        // `item.get('text', '') if isinstance(item, dict) else None`, which must be a str
        let text = item.as_object().and_then(|o| o.get("text").map_or(Some(""), Value::as_str));
        text::check_text(text)?;
    }
    progress(0.05, "Loading local VieNeu CPU model");
    let sp = site_packages();
    let engine = Engine::load(&Paths {
        ort_dll: crate::health::ort_dll_path(),
        openblas_dll: sp.join("numpy.libs").join(OPENBLAS_DLL),
        model_dir: model_dir.clone(),
        sea_g2p_bin: sp.join("sea_g2p").join("sea_g2p.bin"),
        voices_json: sp.join("vieneu").join("assets").join("voices_v3_turbo.json"),
    })?;
    std::fs::create_dir_all(output_dir).map_err(|e| WorkerError::py("OSError", e))?;
    let mut draws = Draws::from_env();
    if !batch {
        progress(0.3, "Synthesizing speech");
        return synth(&engine, &mut draws, &items[0], output_dir);
    }
    for (i, item) in items.iter().enumerate() {
        progress(0.1 + 0.9 * i as f64 / items.len() as f64, &format!("Synthesizing {}/{}", i + 1, items.len()));
        match synth(&engine, &mut draws, item, output_dir) {
            Ok(result) => emit_item(i, "result", result),
            Err(e) => emit_item(i, "error", json!({"code": e.code, "message": e.message})),
        }
    }
    Ok(json!({"count": items.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `parity/tts_cases.py` records for one line, from the port.
    fn record(text: &str, front: &front::Front) -> Value {
        let read = |chunk: &str| {
            let phonemes = front.phonemes(chunk);
            let ids = front.ids(&phonemes).unwrap();
            json!([phonemes, ids])
        };
        let mut rec = json!({"text": text, "check": null});
        if let Err(e) = text::check_text(Some(text)) {
            rec["check"] = json!({"code": e.code, "message": e.message});
            return rec;
        }
        match text::split_pauses(text) {
            Err(e) => rec["pauses"] = json!({"code": e.code, "message": e.message}),
            Ok((parts, trailing)) => {
                rec["parts"] = json!(parts);
                rec["trailing"] = json!(trailing);
                let chunks: Vec<Value> = parts
                    .iter()
                    .map(|(part, _)| {
                        let (chunks, gaps) = text::chunks_with_gaps(part, front.normalizer());
                        let readings: Vec<Value> = chunks.iter().map(|c| read(c)).collect();
                        json!({"chunks": chunks, "gaps": gaps, "readings": readings})
                    })
                    .collect();
                rec["chunks"] = json!(chunks);
            }
        }
        if pyuni::len(text) <= 600 {
            rec["line"] = read(text);
        }
        rec
    }

    /// Rows L and P1: the port against the v1.0.16 worker's own output for every corpus line (`parity/tts_cases.py`). Runs when
    /// `THANHAM_TTS_CASES` names that file; `THANHAM_TTS_MODEL` is the vieneu-v3 folder and `THANHAM_PYTHON` the runtime's python.exe.
    #[test]
    fn recorded_cases_match_python() {
        let Some(cases) = std::env::var_os("THANHAM_TTS_CASES") else { return };
        let model = PathBuf::from(std::env::var_os("THANHAM_TTS_MODEL").expect("THANHAM_TTS_MODEL"));
        let sp = site_packages();
        let onnx = model.join("backbone").join("onnx_update");
        let front = front::Front::load(&sp.join("sea_g2p").join("sea_g2p.bin"), &onnx.join("tokenizer.json")).unwrap();
        let recorded = std::fs::read_to_string(cases).unwrap();
        let mut lines = recorded.lines();
        let head: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let voices = std::fs::read(sp.join("vieneu").join("assets").join("voices_v3_turbo.json")).unwrap();
        let (described, default_voice) = engine::describe_voices(&serde_json::from_slice(&voices).unwrap());
        assert_eq!(json!({"voices": described, "default_voice": default_voice}), head, "preset voices");
        let (mut total, mut differ) = (0, 0);
        for line in lines {
            let want: Value = serde_json::from_str(line).unwrap();
            let got = record(want["text"].as_str().unwrap(), &front);
            total += 1;
            if got != want {
                differ += 1;
                if differ <= 20 {
                    eprintln!("DIFFERS\n python {want}\n rust   {got}");
                }
            }
        }
        eprintln!("rows L and P1: {total} lines, {differ} differ");
        assert!(total > 0 && differ == 0);
    }
}
