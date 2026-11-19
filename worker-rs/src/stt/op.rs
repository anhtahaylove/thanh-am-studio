//! The `stt` operation of `worker/main.py` (feature `ct2`): validation, the model, `load_audio`, the window loop of the glue with
//! the CTranslate2 engine and the Silero VAD, and the progress `stt_window` reports. A job that asks for speakers
//! (`diarize_model_path`) stays on the Python worker until diarization is ported.

use super::decode::decode_audio;
use super::glue::{AlignResult, GenOptions, GenResult, GlueError, Transcriber, WhisperEngine, STT_RATE};
use super::vad::Vad;
use crate::ct2::{Encoded, Whisper};
use crate::download::verify_model;
use crate::error::{Result, WorkerError};
use crate::pyfmt::truthy;
use crate::tts::{cpu_count, py_path, site_packages, OpenBlas, OPENBLAS_DLL};
use serde_json::{json, Map, Value};
use std::path::Path;

/// The engine and the VAD behind the glue, and the progress of `stt_window`.
struct Engine<'a> {
    whisper: Whisper,
    vad: Vad,
    progress: &'a dyn Fn(f64, &str),
    offset: f64,
    duration: f64,
}

impl WhisperEngine for Engine<'_> {
    type Enc = Encoded;

    fn encode(&mut self, features: &[f32], n_mels: usize) -> std::result::Result<Encoded, GlueError> {
        self.whisper.encode(features, n_mels).map_err(GlueError::Engine)
    }

    fn generate(&mut self, enc: &Encoded, prompt: &[u32], o: &GenOptions) -> std::result::Result<GenResult, GlueError> {
        self.whisper.generate(enc, prompt, o).map_err(GlueError::Engine)
    }

    fn align(
        &mut self,
        enc: &Encoded,
        start: &[u32],
        text: &[Vec<u32>],
        num_frames: usize,
        median_filter_width: usize,
    ) -> std::result::Result<Vec<AlignResult>, GlueError> {
        self.whisper.align(enc, start, text, num_frames, median_filter_width).map_err(GlueError::Engine)
    }

    fn detect_language(&mut self, enc: &Encoded) -> std::result::Result<Vec<(String, f64)>, GlueError> {
        self.whisper.detect_language(enc).map_err(GlueError::Engine)
    }

    fn speech_timestamps(&mut self, audio: &[f32]) -> std::result::Result<Vec<(i64, i64)>, GlueError> {
        self.vad.speech_timestamps(audio).map_err(|e| GlueError::Engine(e.message))
    }

    fn trace_window(
        &mut self,
        start: usize,
        _end: usize,
        _lang: Option<&str>,
        _words: bool,
    ) -> std::result::Result<(), GlueError> {
        self.offset = start as f64 / STT_RATE as f64; // `start / STT_RATE`
        Ok(())
    }

    #[allow(clippy::manual_clamp)] // Python's max(0.05, min(0.99, x)), which never returns NaN; clamp would
    fn trace_segment(&mut self, end: f64) -> std::result::Result<(), GlueError> {
        (self.progress)(f64::max(0.05, f64::min(0.99, (self.offset + end) / self.duration)), "Transcribing");
        Ok(())
    }
}

/// `Path(payload.get(key, ''))` as a string (the desktop sends strings).
fn path_arg<'a>(payload: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    match payload.get(key) {
        None => Ok(""),
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(WorkerError::py("TypeError", "expected str, bytes or os.PathLike object")),
    }
}

/// `stt(payload, progress)` without diarization: `{"segments": [{start, end, text}], "language": ...}`.
pub fn stt(payload: &Map<String, Value>, progress: &dyn Fn(f64, &str)) -> Result<Value> {
    if payload.get("diarize_model_path").is_some_and(truthy) {
        return Err(WorkerError::new("WORKER_ERROR", "Speaker separation runs on the Python worker."));
    }
    let count = |key: &str| payload.get(key).filter(|v| !v.is_null());
    let (speakers, low, high) = (count("num_speakers"), count("min_speakers"), count("max_speakers"));
    // `isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 8`: JSON true/false and 2.0 are not ints.
    if [speakers, low, high].into_iter().any(|n| n.is_some_and(|v| !v.as_i64().is_some_and(|i| (1..=8).contains(&i)))) {
        return Err(WorkerError::new("INVALID_RECIPE", "Speaker counts must be whole numbers from 1 to 8."));
    }
    let int = |n: Option<&Value>| n.and_then(Value::as_i64);
    if (speakers.is_some() && (low.is_some() || high.is_some()))
        || (low.is_some() && high.is_some() && int(low) > int(high))
    {
        return Err(WorkerError::new(
            "INVALID_RECIPE",
            "num_speakers excludes min_speakers/max_speakers, and min_speakers must not exceed max_speakers.",
        ));
    }
    let model_dir = path_arg(payload, "model_path")?;
    let spec = verify_model(Path::new(model_dir), None)?;
    if spec.get("engine").and_then(Value::as_str) != Some("faster-whisper") {
        return Err(WorkerError::new("MODEL_UNKNOWN", "Select a Whisper model for transcription."));
    }
    let source = path_arg(payload, "input_path")?;
    if !Path::new(source).is_file() {
        return Err(WorkerError::new("INPUT_MISSING", "Input audio/video is missing."));
    }
    let language = match payload.get("language") {
        None => "vi",
        Some(Value::String(s)) if s == "vi" || s == "auto" => s.as_str(),
        Some(Value::Array(_)) => return Err(WorkerError::py("TypeError", "unhashable type: 'list'")),
        Some(Value::Object(_)) => return Err(WorkerError::py("TypeError", "unhashable type: 'dict'")),
        Some(_) => return Err(WorkerError::new("INVALID_REQUEST", "language must be vi or auto.")),
    };
    progress(0.05, "Loading local Whisper CPU model");
    let model_dir = py_path(model_dir);
    let whisper = Whisper::load(&model_dir, cpu_count().min(8)).map_err(|m| WorkerError::new("WORKER_ERROR", m))?;
    let sp = site_packages();
    let blas = OpenBlas::load_pinned(&sp.join("numpy.libs").join(OPENBLAS_DLL))
        .map_err(|e| WorkerError::new("RUNTIME_MISSING", e.to_string()))?;
    let transcriber =
        Transcriber::load(Path::new(&model_dir), blas).map_err(|e| WorkerError::new("WORKER_ERROR", e.to_string()))?;
    let audio = decode_audio(&sp, &py_path(source))?;
    let duration = f64::max(audio.len() as f64 / STT_RATE as f64, 0.01);
    let vad = Vad::load(&sp)?;
    let mut engine = Engine { whisper, vad, progress, offset: 0.0, duration };
    let lang = if language == "auto" { None } else { Some(language) };
    let result = transcriber.stt(&mut engine, &audio, lang, false).map_err(|e| match e {
        GlueError::Index(m) => WorkerError::py("IndexError", m),
        GlueError::Engine(m) => WorkerError::new("WORKER_ERROR", m),
    })?;
    let segments: Vec<Value> =
        result.segments.iter().map(|r| json!({"start": r.start, "end": r.end, "text": r.text})).collect();
    Ok(json!({"segments": segments, "language": result.language}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::glue::{Row, Word};
    use sha2::{Digest, Sha256};

    fn rows_json(rows: &[Row]) -> Value {
        Value::Array(rows.iter().map(|r| json!({"start": r.start, "end": r.end, "text": r.text})).collect())
    }

    fn words_json(words: &[Vec<Word>]) -> Value {
        Value::Array(
            words
                .iter()
                .map(|ws| {
                    Value::Array(ws.iter().map(|w| json!({"start": w.start, "end": w.end, "text": w.text})).collect())
                })
                .collect(),
        )
    }

    /// JSON equality with numbers compared as f64 bit patterns.
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64().map(f64::to_bits) == y.as_f64().map(f64::to_bits),
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    /// Each `encode` input against the recorded one (`feat\<id>.f32` at each `encode` event's byte offset): `max_diff` is the
    /// largest |Rust log-mel - recorded| seen. With `substitute` (the T1a diagnostic `THANHAM_T1A_FEATURES=recorded`) the engine
    /// gets the recorded input instead, which isolates the glue and the engine from the log-mel.
    struct RecordedFeatures<'a, 'e> {
        engine: &'a mut Engine<'e>,
        feat: Vec<f32>,
        offsets: Vec<usize>,
        calls: usize,
        max_diff: f32,
        substitute: bool,
    }

    impl WhisperEngine for RecordedFeatures<'_, '_> {
        type Enc = Encoded;

        fn encode(&mut self, features: &[f32], n_mels: usize) -> std::result::Result<Encoded, GlueError> {
            let Some(&off) = self.offsets.get(self.calls) else {
                if self.substitute {
                    return Err(GlueError::Engine(format!("encode call {} was not recorded", self.calls)));
                }
                return self.engine.encode(features, n_mels); // the run already left the recorded call sequence
            };
            self.calls += 1;
            let recorded = &self.feat[off..off + features.len()];
            self.max_diff = features.iter().zip(recorded).fold(self.max_diff, |m, (a, b)| m.max((a - b).abs()));
            self.engine.encode(if self.substitute { recorded } else { features }, n_mels)
        }

        fn generate(
            &mut self,
            enc: &Encoded,
            prompt: &[u32],
            o: &GenOptions,
        ) -> std::result::Result<GenResult, GlueError> {
            self.engine.generate(enc, prompt, o)
        }

        fn align(
            &mut self,
            enc: &Encoded,
            start: &[u32],
            text: &[Vec<u32>],
            num_frames: usize,
            median_filter_width: usize,
        ) -> std::result::Result<Vec<AlignResult>, GlueError> {
            self.engine.align(enc, start, text, num_frames, median_filter_width)
        }

        fn detect_language(&mut self, enc: &Encoded) -> std::result::Result<Vec<(String, f64)>, GlueError> {
            self.engine.detect_language(enc)
        }

        fn speech_timestamps(&mut self, audio: &[f32]) -> std::result::Result<Vec<(i64, i64)>, GlueError> {
            self.engine.speech_timestamps(audio)
        }
    }

    /// Row T1a under the real engine: spike S4's recorded items (`rec\<corpus>\<model>\<mode>\events.jsonl`, the item PCM in
    /// `rec\pcm`) through the glue with this CTranslate2 engine and the Silero VAD, each result (segments, words, language, retry)
    /// against the Python worker's, bitwise. Items whose Python run sampled (a fallback temperature above 0) are unseeded on both
    /// sides and reported apart (row T1b). `THANHAM_T1A_REC` (the rec folder), `THANHAM_T1A_JOBS` (`corpus model mode` per line,
    /// modes w, p or a), `THANHAM_MODELS` (holding whisper-small and whisper-turbo), `THANHAM_T1A_OUT` (per-item JSON lines).
    #[test]
    #[ignore = "local T1a runs on recorded items"]
    fn t1a_real_engine() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k}"));
        let (rec, models) =
            (std::path::PathBuf::from(var("THANHAM_T1A_REC")), std::path::PathBuf::from(var("THANHAM_MODELS")));
        let mut out = std::fs::File::create(var("THANHAM_T1A_OUT")).unwrap();
        let recorded_features = std::env::var("THANHAM_T1A_FEATURES").is_ok_and(|v| v == "recorded");
        let sp = site_packages();
        let (mut deterministic, mut pass, mut sampled, mut sampled_same, mut features_exact) = (0, 0, 0, 0, 0);
        println!("engine {}", crate::ct2::info());
        for job in var("THANHAM_T1A_JOBS").lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let [corpus, model, mode] = job.split_whitespace().collect::<Vec<_>>()[..] else {
                panic!("bad job: {job}")
            };
            let (lang0, words) = (if mode == "a" { None } else { Some("vi") }, mode != "p");
            let model_dir = models.join(format!("whisper-{model}"));
            let blas = OpenBlas::load_pinned(&sp.join("numpy.libs").join(OPENBLAS_DLL)).unwrap();
            let transcriber = Transcriber::load(&model_dir, blas).unwrap();
            let mut engine = Engine {
                whisper: Whisper::load(model_dir.to_str().unwrap(), cpu_count().min(8)).unwrap(),
                vad: Vad::load(&sp).unwrap(),
                progress: &|_, _| {},
                offset: 0.0,
                duration: 1.0,
            };
            let events = std::fs::read_to_string(rec.join(corpus).join(model).join(mode).join("events.jsonl")).unwrap();
            for line in events.lines().filter(|l| !l.trim().is_empty()) {
                let item: Value = serde_json::from_str(line).unwrap();
                let id = item["id"].as_str().unwrap();
                let bytes = std::fs::read(rec.join("pcm").join(corpus).join(format!("{id}.f32"))).unwrap();
                let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!(item["pcm_sha"].as_str(), Some(sha.as_str()), "{corpus}/{id}: stored PCM");
                let pcm: Vec<f32> =
                    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                let python = json!({"segments": item["segments"], "words": item["words"], "language": item["language"],
                    "words_fallback": item["words_fallback"]});
                let feat =
                    std::fs::read(rec.join(corpus).join(model).join(mode).join("feat").join(format!("{id}.f32")))
                        .unwrap()
                        .chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect();
                let offsets = item["events"].as_array().unwrap().iter().filter(|e| e["k"] == "encode");
                let offsets = offsets.map(|e| e["off"].as_u64().unwrap() as usize / 4).collect();
                let mut fed = RecordedFeatures {
                    engine: &mut engine,
                    feat,
                    offsets,
                    calls: 0,
                    max_diff: 0.0,
                    substitute: recorded_features,
                };
                let result = transcriber.stt(&mut fed, &pcm, lang0, words);
                let max_diff = fed.max_diff;
                let rust = match result {
                    Ok(r) => {
                        json!({"segments": rows_json(&r.segments), "words": words_json(&r.words), "language": r.language,
                        "words_fallback": r.words_fallback})
                    }
                    Err(e) => json!({"error": e.to_string()}),
                };
                let ok = same(&rust, &python);
                let sampling =
                    item["events"].as_array().unwrap().iter().any(|e| {
                        e["k"] == "generate" && e["kw"]["sampling_temperature"].as_f64().is_some_and(|t| t > 0.0)
                    });
                if sampling {
                    sampled += 1;
                    sampled_same += usize::from(ok);
                } else {
                    deterministic += 1;
                    pass += usize::from(ok);
                    features_exact += usize::from(max_diff == 0.0);
                }
                use std::io::Write as _;
                writeln!(
                    out,
                    "{}",
                    json!({"job": job, "id": id, "same": ok, "sampled": sampling, "max_feature_diff": max_diff, "rust": rust,
                        "python": python})
                )
                .unwrap();
                println!("{job} {id}: {}", if ok { "same" } else { "DIFFERS" });
            }
        }
        println!("T1a real engine: {pass}/{deterministic} deterministic items identical; sampled items {sampled_same}/{sampled}");
        println!("T1a features: {features_exact}/{deterministic} deterministic items bitwise equal to the recorded encoder inputs");
        assert!(deterministic > 0);
        assert_eq!(pass, deterministic);
        assert_eq!(features_exact, deterministic);
    }
}
