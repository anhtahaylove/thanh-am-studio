//! S2 spike: the pure-Rust TTS front end (sea-g2p-rs + tokenizers) over the recorded corpus.
//!
//! usage: s2-g2p <sea_g2p.bin> <tokenizer.json> <corpus.jsonl> <golden.jsonl> <out.jsonl>
//!
//! Per line it emits what the Rust path produces, plus two isolation probes fed with the Python recording:
//!   g2p_of_pynorm   engine.phonemize(Python's normalised text)      (G2P engine alone)
//!   ids_of_pyg2p    tokenizer.encode(Python's phonemes)             (tokenizer alone)
//!   ids_of_pyworker tokenizer.encode(Python's worker phonemes)
//! The cue and `vietnamese_reading` wrappers below are a literal port of worker/main.py and vieneu_utils
//! (row L logic); they exist only so P1 can also be measured at the level the engine really receives.

use regex::Regex;
use sea_g2p_rs::g2p::G2PEngine;
use sea_g2p_rs::lang::vi::Normalizer;
use sea_g2p_rs::punc::apply_punc_norm;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tokenizers::Tokenizer;

const STRIP: &[char] = &[' ', '.', '!', '?', ',', ';', ':'];

struct Front {
    norm: Normalizer,
    engine: G2PEngine,
    tok: Tokenizer,
    emotion_split: Regex,
}

/// Python str.isspace(): Unicode White_Space plus the C0 separators U+001C..U+001F.
fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

fn py_strip(s: &str) -> &str {
    s.trim_matches(py_space)
}

impl Front {
    /// SEAPipeline.run(text, punc_norm): normalise, then G2P (G2P itself without punc_norm).
    fn pipeline(&self, text: &str, punc_norm: bool) -> String {
        if text.is_empty() {
            return String::new();
        }
        self.engine.phonemize(&self.norm.normalize(text, punc_norm))
    }

    fn ids(&self, text: &str) -> Vec<u32> {
        self.tok.encode(text, false).map(|e| e.get_ids().to_vec()).unwrap_or_default()
    }

    /// vieneu_utils.phonemize_text.phonemize_text_with_emotions
    fn with_emotions(&self, text: &str) -> String {
        if !text.contains('[') && !text.contains("<|emotion_") {
            return self.pipeline(text, true);
        }
        // re.split with one capture group: text, tag, text, tag, ..., text (empties kept)
        let mut parts: Vec<(&str, bool)> = Vec::new();
        let mut pos = 0;
        for m in self.emotion_split.find_iter(text) {
            parts.push((&text[pos..m.start()], false));
            parts.push((m.as_str(), true));
            pos = m.end();
        }
        parts.push((&text[pos..], false));
        let mut out = String::new();
        for (part, is_tag) in parts {
            if is_tag {
                if let Some(token) = emotion_token(part) {
                    out = if out.is_empty() { token } else { format!("{out} {token}") };
                    continue;
                }
            }
            let ph = if !part.is_empty() && !py_strip(part).is_empty() { self.pipeline(part, false) } else { String::new() };
            if ph.is_empty() {
                continue;
            }
            if out.is_empty() {
                out = ph;
            } else if ph.chars().next().map_or(false, |c| ".,!?;:…)]}\"'’”".contains(c)) {
                out.push_str(&ph);
            } else {
                out = format!("{out} {ph}");
            }
        }
        apply_punc_norm(&out)
    }

    /// worker/main.py vietnamese_reading(phonemize_text_with_emotions)
    fn worker(&self, text: &str) -> String {
        let phonemes = self.with_emotions(text);
        let body = text.trim_end_matches(STRIP);
        if body.is_empty() || !text.is_ascii() || text.contains(['<', '[', '|']) || body.split(py_space).filter(|w| !w.is_empty()).count() > 3 {
            return phonemes;
        }
        let probe = self.with_emotions(&format!("{body} ơi{}", &text[body.len()..]));
        let mut words: Vec<&str> = probe.split(' ').collect();
        words.pop();
        let spoken = words.join(" ");
        let kept = phonemes.trim_end_matches(STRIP).len();
        format!("{}{}", spoken.trim_end_matches(STRIP), &phonemes[kept..])
    }
}

fn emotion_token(tag: &str) -> Option<String> {
    let t = py_strip(tag);
    if t.starts_with("<|") {
        return Some(t.to_string());
    }
    let inner: Vec<char> = t.chars().collect();
    let inner: String = inner[1..inner.len() - 1].iter().collect();
    let k = match py_strip(&inner).to_lowercase().as_str() {
        "chuckle" | "cười" | "cuoi" => 1,
        "sigh" | "thở dài" | "tho dai" => 2,
        "clear throat" | "hắng giọng" | "hang giong" => 3,
        _ => return None,
    };
    Some(format!("<|emotion_{k}|>"))
}

fn run() {
    let a: Vec<String> = std::env::args().collect();
    let dict = &a[1];
    let front = Front {
        norm: Normalizer::new("vi", Some(dict)),
        engine: G2PEngine::new(dict).expect("dictionary"),
        tok: Tokenizer::from_file(&a[2]).expect("tokenizer.json"),
        emotion_split: Regex::new(r"(\[[^\]]+\]|<\|emotion_\d+\|>)").unwrap(),
    };
    let corpus = BufReader::new(std::fs::File::open(&a[3]).unwrap());
    let golden = BufReader::new(std::fs::File::open(&a[4]).unwrap());
    let mut out = BufWriter::new(std::fs::File::create(&a[5]).unwrap());
    std::panic::set_hook(Box::new(|_| {}));
    for (c, g) in corpus.lines().zip(golden.lines()) {
        let c: Value = serde_json::from_str(&c.unwrap()).unwrap();
        let g: Value = serde_json::from_str(&g.unwrap()).unwrap();
        let text = c["text"].as_str().unwrap();
        let gs = |k: &str| g[k].as_str().map(str::to_string);
        let row = catch_unwind(AssertUnwindSafe(|| {
            let norm = front.norm.normalize(text, true);
            let g2p = front.engine.phonemize(&norm);
            let worker = front.worker(text);
            json!({
                "i": c["i"], "norm": norm, "ids_g2p": front.ids(&g2p), "g2p": g2p,
                "ids_worker": front.ids(&worker), "worker": worker,
                "g2p_of_pynorm": gs("norm").map(|n| front.engine.phonemize(&n)),
                "ids_of_pyg2p": gs("g2p").map(|p| front.ids(&p)),
                "ids_of_pyworker": gs("worker").map(|p| front.ids(&p)),
            })
        }))
        .unwrap_or_else(|e| {
            let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            json!({"i": c["i"], "err": format!("panic: {msg}")})
        });
        writeln!(out, "{row}").unwrap();
    }
}

fn main() {
    // Long corpus lines recurse deeply inside regex passes: run on a big stack.
    std::thread::Builder::new().stack_size(256 << 20).spawn(run).unwrap().join().unwrap();
}
