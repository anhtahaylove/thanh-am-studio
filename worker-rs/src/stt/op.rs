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

    /// SHA-256 of float32 values as little-endian bytes (the recorder's `sha(x.tobytes())`).
    fn sha_f32(v: &[f32]) -> String {
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// faster-whisper's `generate` kwargs as the recorder logged them (spike S4's replay).
    fn kw(o: &GenOptions) -> Value {
        let mut m = json!({
            "length_penalty": o.length_penalty, "repetition_penalty": o.repetition_penalty,
            "no_repeat_ngram_size": o.no_repeat_ngram_size, "max_length": o.max_length, "return_scores": true,
            "return_no_speech_prob": true, "suppress_blank": o.suppress_blank, "suppress_tokens": o.suppress_tokens,
            "max_initial_timestamp_index": o.max_initial_timestamp_index,
        });
        if o.temperature > 0.0 {
            m["beam_size"] = json!(1);
            m["num_hypotheses"] = json!(o.best_of);
            m["sampling_topk"] = json!(0);
            m["sampling_temperature"] = json!(o.temperature);
        } else {
            m["beam_size"] = json!(o.beam_size);
            m["patience"] = json!(o.patience);
        }
        m
    }

    /// One item's recorded call sequence (spike S4's `events`) checked call by call against what the glue asks of the real
    /// engine: kind, inputs and outputs of every encode (input against `feat\<id>.f32` at its byte offset, `max_diff` the largest
    /// |difference|; output by SHA-256), generate, align, detect_language and VAD call, and every compression ratio and window
    /// trace. `diffs` lists what differed; after a call of another kind the sequence is lost and the rest runs unchecked. With
    /// `substitute` (the T1a diagnostic `THANHAM_T1A_FEATURES=recorded`) the engine gets the recorded encoder input instead,
    /// which isolates the glue and the engine from the log-mel.
    struct Recorded<'a, 'e> {
        engine: &'a mut Engine<'e>,
        events: &'a [Value],
        pos: usize,
        lost: bool,
        feat: Vec<f32>,
        encodes: usize,
        max_diff: f32,
        substitute: bool,
        diffs: Vec<String>,
    }

    impl<'a> Recorded<'a, '_> {
        /// The next recorded event if it is a `kind` call; otherwise the sequence is lost.
        fn next(&mut self, kind: &str) -> Option<&'a Value> {
            if self.lost {
                return None;
            }
            match self.events.get(self.pos) {
                Some(ev) if ev["k"] == kind => {
                    self.pos += 1;
                    Some(ev)
                }
                other => {
                    let python = other.map_or("nothing", |e| e["k"].as_str().unwrap_or("?"));
                    self.diffs.push(format!("call {}: Rust makes {kind}, Python made {python}", self.pos));
                    self.lost = true;
                    None
                }
            }
        }

        fn check(&mut self, what: &str, rust: Value, python: Value) {
            if !same(&rust, &python) {
                let text: String = format!("{rust} vs {python}").chars().take(400).collect();
                self.diffs.push(format!("call {} {what}: {text}", self.pos - 1));
            }
        }
    }

    impl WhisperEngine for Recorded<'_, '_> {
        type Enc = (usize, Encoded);

        fn encode(&mut self, features: &[f32], n_mels: usize) -> std::result::Result<(usize, Encoded), GlueError> {
            let n = self.encodes;
            self.encodes += 1;
            let Some(ev) = self.next("encode") else {
                if self.substitute {
                    return Err(GlueError::Engine(format!("encode call {n} was not recorded")));
                }
                return Ok((n, self.engine.encode(features, n_mels)?));
            };
            let off = ev["off"].as_u64().unwrap() as usize / 4;
            let recorded = self.feat.get(off..off + features.len());
            self.max_diff = match recorded {
                Some(r) => features.iter().zip(r).fold(self.max_diff, |m, (a, b)| m.max((a - b).abs())),
                None => f32::INFINITY,
            };
            let input = if self.substitute { recorded.unwrap_or(features) } else { features };
            let enc = self.engine.encode(input, n_mels)?;
            let rust =
                json!({"n": n, "shape": [1, n_mels, features.len() / n_mels], "out_sha": sha_f32(&enc.floats())});
            self.check("encode", rust, json!({"n": ev["n"], "shape": ev["shape"], "out_sha": ev["out_sha"]}));
            Ok((n, enc))
        }

        fn generate(
            &mut self,
            enc: &(usize, Encoded),
            prompt: &[u32],
            o: &GenOptions,
        ) -> std::result::Result<GenResult, GlueError> {
            let out = self.engine.generate(&enc.1, prompt, o)?;
            if let Some(ev) = self.next("generate") {
                let rust = json!({"enc": enc.0, "prompts": [prompt], "kw": kw(o),
                    "out": [{"seq": out.sequences_ids, "scores": out.scores, "nsp": out.no_speech_prob}]});
                self.check(
                    "generate",
                    rust,
                    json!({"enc": ev["enc"], "prompts": ev["prompts"], "kw": ev["kw"], "out": ev["out"]}),
                );
            }
            Ok(out)
        }

        fn align(
            &mut self,
            enc: &(usize, Encoded),
            start: &[u32],
            text: &[Vec<u32>],
            num_frames: usize,
            median_filter_width: usize,
        ) -> std::result::Result<Vec<AlignResult>, GlueError> {
            let out = self.engine.align(&enc.1, start, text, num_frames, median_filter_width)?;
            if let Some(ev) = self.next("align") {
                // The worker drops faster-whisper's word probabilities, so the engine wrapper does not return them.
                let al: Vec<Value> = out.iter().map(|r| json!({"al": r.alignments})).collect();
                let python: Vec<Value> = ev["out"].as_array().unwrap().iter().map(|r| json!({"al": r["al"]})).collect();
                let rust = json!({"enc": enc.0, "start": start, "text": text, "num_frames": num_frames,
                    "kw": {"median_filter_width": median_filter_width}, "out": al});
                let python = json!({"enc": ev["enc"], "start": ev["start"], "text": ev["text"], "num_frames": ev["num_frames"],
                    "kw": ev["kw"], "out": python});
                self.check("align", rust, python);
            }
            Ok(out)
        }

        fn detect_language(&mut self, enc: &(usize, Encoded)) -> std::result::Result<Vec<(String, f64)>, GlueError> {
            let out = self.engine.detect_language(&enc.1)?;
            if let Some(ev) = self.next("detect") {
                let rust = json!({"enc": enc.0, "kw": {}, "out": [out]});
                self.check("detect", rust, json!({"enc": ev["enc"], "kw": ev["kw"], "out": ev["out"]}));
            }
            Ok(out)
        }

        fn speech_timestamps(&mut self, audio: &[f32]) -> std::result::Result<Vec<(i64, i64)>, GlueError> {
            let out = self.engine.speech_timestamps(audio)?;
            if let Some(ev) = self.next("vad") {
                let speech: Vec<Value> = out.iter().map(|&(start, end)| json!({"start": start, "end": end})).collect();
                let rust = json!({"n_samples": audio.len(), "pcm_sha": sha_f32(audio), "speech": speech});
                self.check(
                    "vad",
                    rust,
                    json!({"n_samples": ev["n_samples"], "pcm_sha": ev["pcm_sha"], "speech": ev["speech"]}),
                );
            }
            Ok(out)
        }

        fn trace_compression_ratio(&mut self, text: &str, ratio: f64) -> std::result::Result<(), GlueError> {
            if let Some(ev) = self.next("cr") {
                self.check(
                    "cr",
                    json!({"text": text, "ratio": ratio}),
                    json!({"text": ev["text"], "ratio": ev["ratio"]}),
                );
            }
            Ok(())
        }

        fn trace_window(
            &mut self,
            start: usize,
            end: usize,
            lang: Option<&str>,
            words: bool,
        ) -> std::result::Result<(), GlueError> {
            if let Some(ev) = self.next("window") {
                let rust = json!({"start": start, "end": end, "lang": lang, "words": words});
                self.check(
                    "window",
                    rust,
                    json!({"start": ev["start"], "end": ev["end"], "lang": ev["lang"], "words": ev["words"]}),
                );
            }
            Ok(())
        }

        fn trace_window_result(
            &mut self,
            rows: &[Row],
            words: &[Vec<Word>],
            lang: &str,
        ) -> std::result::Result<(), GlueError> {
            if let Some(ev) = self.next("window_result") {
                let rust = json!({"rows": rows_json(rows), "words": words_json(words), "lang": lang});
                self.check(
                    "window_result",
                    rust,
                    json!({"rows": ev["rows"], "words": ev["words"], "lang": ev["lang"]}),
                );
            }
            Ok(())
        }

        fn trace_index_error(&mut self) -> std::result::Result<(), GlueError> {
            self.next("index_error");
            Ok(())
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
        let (mut deterministic, mut pass, mut sampled, mut sampled_same, mut features_exact, mut checked) =
            (0, 0, 0, 0, 0, 0);
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
                let mut fed = Recorded {
                    engine: &mut engine,
                    events: item["events"].as_array().unwrap(),
                    pos: 0,
                    lost: false,
                    feat,
                    encodes: 0,
                    max_diff: 0.0,
                    substitute: recorded_features,
                    diffs: Vec::new(),
                };
                let result = transcriber.stt(&mut fed, &pcm, lang0, words);
                if !fed.lost && fed.pos < fed.events.len() {
                    fed.diffs.push(format!("Rust made {} of the {} recorded calls", fed.pos, fed.events.len()));
                }
                let (max_diff, calls, diffs) = (fed.max_diff, fed.pos, fed.diffs);
                let rust = match result {
                    Ok(r) => {
                        json!({"segments": rows_json(&r.segments), "words": words_json(&r.words), "language": r.language,
                        "words_fallback": r.words_fallback})
                    }
                    Err(e) => json!({"error": e.to_string()}),
                };
                let ok = same(&rust, &python) && diffs.is_empty();
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
                    checked += calls;
                }
                use std::io::Write as _;
                writeln!(
                    out,
                    "{}",
                    json!({"job": job, "id": id, "same": ok, "sampled": sampling, "max_feature_diff": max_diff, "calls": calls,
                        "call_diffs": diffs, "rust": rust, "python": python})
                )
                .unwrap();
                println!("{job} {id}: {}", if ok { "same" } else { "DIFFERS" });
            }
        }
        println!("T1a real engine: {pass}/{deterministic} deterministic items identical; sampled items {sampled_same}/{sampled}");
        println!("T1a features: {features_exact}/{deterministic} deterministic items bitwise equal to the recorded encoder inputs");
        println!("T1a calls: {checked} recorded calls of the deterministic items checked (kind, inputs, outputs)");
        assert!(deterministic > 0);
        assert_eq!(pass, deterministic);
        assert_eq!(features_exact, deterministic);
    }
}
