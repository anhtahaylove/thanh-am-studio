//! S4 T1a driver: runs the Rust glue on the recorded PCM through a replay `WhisperEngine` that serves the recorded engine outputs and
//! VAD timestamps, checks every call against the recording (order, inputs, features <= 1e-4) and compares the results with Python's.
//!
//! usage: s4-replay <rec root> <corpus> <small|turbo> <w|p|a> <model dir> [--only id,id] [--out results.jsonl]
//! Prints one JSON line per item and a summary line; exit 0 only if every item passed.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use s4_glue::{AlignResult, GenOptions, GenResult, GlueError, Row, SttResult, Transcriber, WhisperEngine, Word};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const FEATURE_TOLERANCE: f64 = 1e-4;

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// JSON equality with numbers compared as f64 bit patterns (Python passes some options as int, e.g. `patience=1`).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64().map(f64::to_bits) == y.as_f64().map(f64::to_bits),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn kw(o: &GenOptions) -> Value {
    let mut m = json!({
        "length_penalty": o.length_penalty, "repetition_penalty": o.repetition_penalty, "no_repeat_ngram_size": o.no_repeat_ngram_size,
        "max_length": o.max_length, "return_scores": true, "return_no_speech_prob": true, "suppress_blank": o.suppress_blank,
        "suppress_tokens": o.suppress_tokens, "max_initial_timestamp_index": o.max_initial_timestamp_index,
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

fn rows_json(rows: &[Row]) -> Value {
    Value::Array(rows.iter().map(|r| json!({"start": r.start, "end": r.end, "text": r.text})).collect())
}

fn words_json(words: &[Vec<Word>]) -> Value {
    Value::Array(words.iter().map(|ws| Value::Array(ws.iter().map(|w| json!({"start": w.start, "end": w.end, "text": w.text})).collect())).collect())
}

fn result_json(r: &SttResult) -> Value {
    json!({"segments": rows_json(&r.segments), "words": words_json(&r.words), "language": r.language, "words_fallback": r.words_fallback})
}

/// First difference between two JSON values (path and both sides), floats compared bitwise.
fn first_diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: length {} (Rust) vs {} (Python)", x.len(), y.len()));
            }
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| first_diff(p, q, &format!("{path}[{i}]")))
        }
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|k| match (x.get(k), y.get(k)) {
                (Some(p), Some(q)) => first_diff(p, q, &format!("{path}.{k}")),
                _ => Some(format!("{path}.{k}: present on one side only")),
            })
        }
        _ if same(a, b) => None,
        _ => Some(format!("{path}: {a} (Rust) vs {b} (Python)")),
    }
}

struct Replay<'a> {
    ev: &'a [Value],
    pos: usize,
    feat: Vec<f32>,
    fails: Vec<String>,
    max_feat_diff: f64,
    calls: [usize; 4],
    cr: (usize, usize, usize), // (count, ratio differs, text differs)
    cr_max_diff: f64,
    cr_min_margin: f64,
}

impl<'a> Replay<'a> {
    fn take(&mut self, kind: &str) -> Result<&'a Value, GlueError> {
        let ev = self.ev.get(self.pos).ok_or_else(|| GlueError::Engine(format!("call sequence: Rust made a {kind} call after the last recorded event")))?;
        if ev["k"] != kind {
            return Err(GlueError::Engine(format!("call sequence: event {} is {} in Python, {kind} in Rust", self.pos, ev["k"])));
        }
        self.pos += 1;
        Ok(ev)
    }
    fn check(&mut self, ok: bool, what: impl FnOnce() -> String) {
        if !ok {
            let at = self.pos - 1;
            self.fails.push(format!("event {at}: {}", what()));
        }
    }
    fn check_enc(&mut self, ev: &Value, enc: usize) {
        let rec = ev["enc"].as_u64();
        self.check(rec == Some(enc as u64), || format!("uses encode #{enc}, Python used {:?}", rec));
    }
}

fn u32s(v: &Value) -> Vec<u32> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default()
}

impl WhisperEngine for Replay<'_> {
    type Enc = usize;

    fn encode(&mut self, features: &[f32], n_mels: usize) -> Result<usize, GlueError> {
        let ev = self.take("encode")?;
        self.calls[0] += 1;
        let shape = json!([1, n_mels, 3000]);
        self.check(same(&ev["shape"], &shape), || format!("encode shape {shape} vs {}", ev["shape"]));
        let off = ev["off"].as_u64().unwrap_or(0) as usize / 4;
        let rec = self.feat.get(off..off + features.len()).ok_or_else(|| GlueError::Engine("recorded features too short".into()))?;
        let diff = features.iter().zip(rec).map(|(a, b)| (*a as f64 - *b as f64).abs()).fold(0.0f64, f64::max);
        self.max_feat_diff = self.max_feat_diff.max(diff);
        self.check(diff <= FEATURE_TOLERANCE, || format!("features max abs diff {diff:e} > {FEATURE_TOLERANCE:e}"));
        Ok(ev["n"].as_u64().unwrap_or(u64::MAX) as usize)
    }

    fn generate(&mut self, enc: &usize, prompt: &[u32], o: &GenOptions) -> Result<GenResult, GlueError> {
        let ev = self.take("generate")?;
        self.calls[1] += 1;
        self.check_enc(ev, *enc);
        let prompts = json!([prompt]);
        self.check(same(&ev["prompts"], &prompts), || format!("prompts {prompts} vs {}", ev["prompts"]));
        let k = kw(o);
        self.check(same(&ev["kw"], &k), || format!("generate options differ: {}", first_diff(&k, &ev["kw"], "kw").unwrap_or_default()));
        let out = &ev["out"][0];
        Ok(GenResult {
            sequences_ids: out["seq"].as_array().map(|a| a.iter().map(u32s).collect()).unwrap_or_default(),
            scores: out["scores"].as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default(),
            no_speech_prob: out["nsp"].as_f64().unwrap_or(f64::NAN),
        })
    }

    fn align(&mut self, enc: &usize, start: &[u32], text: &[Vec<u32>], num_frames: usize, median_filter_width: usize) -> Result<Vec<AlignResult>, GlueError> {
        let ev = self.take("align")?;
        self.calls[2] += 1;
        self.check_enc(ev, *enc);
        let args = json!({"start": start, "text": text, "num_frames": num_frames, "kw": {"median_filter_width": median_filter_width}});
        let rec = json!({"start": ev["start"], "text": ev["text"], "num_frames": ev["num_frames"], "kw": ev["kw"]});
        self.check(same(&rec, &args), || format!("align inputs differ: {}", first_diff(&args, &rec, "align").unwrap_or_default()));
        Ok(ev["out"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|r| AlignResult {
                        alignments: r["al"].as_array().map(|p| p.iter().map(|q| (q[0].as_i64().unwrap_or(0), q[1].as_i64().unwrap_or(0))).collect()).unwrap_or_default(),
                        text_token_probs: r["probs"].as_array().map(|p| p.iter().filter_map(Value::as_f64).collect()).unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn detect_language(&mut self, enc: &usize) -> Result<Vec<(String, f64)>, GlueError> {
        let ev = self.take("detect")?;
        self.calls[3] += 1;
        self.check_enc(ev, *enc);
        self.check(same(&ev["kw"], &json!({})), || format!("detect options {}", ev["kw"]));
        Ok(ev["out"][0].as_array().map(|a| a.iter().map(|p| (p[0].as_str().unwrap_or("").to_string(), p[1].as_f64().unwrap_or(f64::NAN))).collect()).unwrap_or_default())
    }

    fn speech_timestamps(&mut self, audio: &[f32]) -> Result<Vec<(i64, i64)>, GlueError> {
        let ev = self.take("vad")?;
        let sha = hex(&f32_bytes(audio));
        self.check(ev["n_samples"].as_u64() == Some(audio.len() as u64) && ev["pcm_sha"] == sha.as_str(), || format!("window PCM differs ({} samples)", audio.len()));
        Ok(ev["speech"].as_array().map(|a| a.iter().map(|s| (s["start"].as_i64().unwrap_or(0), s["end"].as_i64().unwrap_or(0))).collect()).unwrap_or_default())
    }

    fn trace_compression_ratio(&mut self, text: &str, ratio: f64) -> Result<(), GlueError> {
        let ev = self.take("cr")?;
        self.cr.0 += 1;
        if ev["text"] != text {
            self.cr.2 += 1;
        }
        let py = ev["ratio"].as_f64().unwrap_or(f64::NAN);
        if py.to_bits() != ratio.to_bits() {
            self.cr.1 += 1;
            self.cr_max_diff = self.cr_max_diff.max((py - ratio).abs());
        }
        self.cr_min_margin = self.cr_min_margin.min((py - 2.4).abs()); // distance of Python's ratio from the fallback threshold
        Ok(())
    }

    fn trace_window(&mut self, start: usize, end: usize, lang: Option<&str>, words: bool) -> Result<(), GlueError> {
        let ev = self.take("window")?;
        let mine = json!({"start": start, "end": end, "lang": lang, "words": words});
        let rec = json!({"start": ev["start"], "end": ev["end"], "lang": ev["lang"], "words": ev["words"]});
        self.check(same(&mine, &rec), || format!("window {mine} vs {rec}"));
        Ok(())
    }

    fn trace_window_result(&mut self, rows: &[Row], words: &[Vec<Word>], lang: &str) -> Result<(), GlueError> {
        let ev = self.take("window_result")?;
        let mine = json!({"rows": rows_json(rows), "words": words_json(words), "lang": lang});
        let rec = json!({"rows": ev["rows"], "words": ev["words"], "lang": ev["lang"]});
        self.check(same(&mine, &rec), || format!("window result differs: {}", first_diff(&mine, &rec, "window").unwrap_or_default()));
        Ok(())
    }

    fn trace_index_error(&mut self) -> Result<(), GlueError> {
        self.take("index_error").map(|_| ())
    }
}

fn read_f32(path: &Path) -> std::io::Result<Vec<f32>> {
    Ok(std::fs::read(path)?.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 {
        eprintln!("usage: s4-replay <rec root> <corpus> <small|turbo> <w|p|a> <model dir> [--only id,id] [--out results.jsonl]");
        return ExitCode::from(2);
    }
    let (root, corpus, model, mode, model_dir) = (PathBuf::from(&args[0]), &args[1], &args[2], &args[3], PathBuf::from(&args[4]));
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let only: Option<Vec<String>> = flag("--only").map(|s| s.split(',').map(str::to_string).collect());
    let mut out_file = flag("--out").map(|p| std::fs::File::create(p).expect("create --out"));
    let dir = root.join(corpus).join(model).join(mode);
    let glue = match Transcriber::load(&model_dir) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("model: {e}");
            return ExitCode::from(2);
        }
    };
    let text = std::fs::read_to_string(dir.join("events.jsonl")).expect("events.jsonl");
    let (lang0, diarizing) = (if mode == "a" { None } else { Some("vi") }, mode != "p");
    let (mut n_items, mut n_ok, mut max_feat, mut calls, mut cr) = (0usize, 0usize, 0f64, [0usize; 4], (0usize, 0usize, 0usize));
    let (mut cr_max_diff, mut cr_min_margin) = (0f64, f64::INFINITY);
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let rec: Value = serde_json::from_str(line).expect("event line");
        let id = rec["id"].as_str().unwrap_or("").to_string();
        if only.as_ref().is_some_and(|o| !o.contains(&id)) {
            continue;
        }
        n_items += 1;
        let pcm = read_f32(&root.join("pcm").join(corpus).join(format!("{id}.f32"))).expect("pcm");
        let mut fails = Vec::new();
        if hex(&f32_bytes(&pcm)) != rec["pcm_sha"].as_str().unwrap_or("") {
            fails.push("stored PCM does not match the recorded hash".to_string());
        }
        let events = rec["events"].as_array().cloned().unwrap_or_default();
        let mut rp = Replay {
            ev: &events,
            pos: 0,
            feat: read_f32(&dir.join("feat").join(format!("{id}.f32"))).expect("features"),
            fails: Vec::new(),
            max_feat_diff: 0.0,
            calls: [0; 4],
            cr: (0, 0, 0),
            cr_max_diff: 0.0,
            cr_min_margin: f64::INFINITY,
        };
        let result = glue.stt(&mut rp, &pcm, lang0, diarizing);
        let mut rust = Value::Null;
        match result {
            Ok(r) => {
                if rp.pos != events.len() {
                    fails.push(format!("call sequence: Rust stopped after event {} of {}", rp.pos, events.len()));
                }
                rust = result_json(&r);
                let python = json!({"segments": rec["segments"], "words": rec["words"], "language": rec["language"], "words_fallback": rec["words_fallback"]});
                if let Some(d) = first_diff(&rust, &python, "result") {
                    fails.push(d);
                }
            }
            Err(e) => fails.push(format!("glue error: {e}")),
        }
        fails.extend(rp.fails);
        let ok = fails.is_empty();
        n_ok += ok as usize;
        max_feat = max_feat.max(rp.max_feat_diff);
        for i in 0..4 {
            calls[i] += rp.calls[i];
        }
        cr = (cr.0 + rp.cr.0, cr.1 + rp.cr.1, cr.2 + rp.cr.2);
        cr_max_diff = cr_max_diff.max(rp.cr_max_diff);
        cr_min_margin = cr_min_margin.min(rp.cr_min_margin);
        let line = json!({"id": id, "ok": ok, "fails": fails.iter().take(5).collect::<Vec<_>>(), "n_fails": fails.len(), "max_feat_diff": rp.max_feat_diff,
            "calls": {"encode": rp.calls[0], "generate": rp.calls[1], "align": rp.calls[2], "detect": rp.calls[3]},
            "cr": {"n": rp.cr.0, "ratio_differs": rp.cr.1, "text_differs": rp.cr.2}});
        println!("{line}");
        if let Some(f) = out_file.as_mut() {
            use std::io::Write;
            let _ = writeln!(f, "{}", json!({"id": rec["id"], "ok": ok, "rust": rust}));
        }
    }
    println!(
        "{}",
        json!({"summary": format!("{corpus} {model} {mode}"), "items": n_items, "pass": n_ok, "max_feat_diff": max_feat,
            "calls": {"encode": calls[0], "generate": calls[1], "align": calls[2], "detect": calls[3]},
            "cr": {"n": cr.0, "ratio_differs": cr.1, "text_differs": cr.2, "max_abs_diff": cr_max_diff, "min_py_distance_to_2_4": cr_min_margin}})
    );
    if n_items > 0 && n_ok == n_items {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
