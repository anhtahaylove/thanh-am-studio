//! The TTS front end: phonemes and token ids for one chunk, as the worker produces them
//! (`SEAPipeline` + `phonemize_text_with_emotions` + `vietnamese_reading` + the engine's `Tokenizer.encode`).
//!
//! Literal port of the S2 spike's `Front` (`spikes/s2-g2p/src/main.rs`, row P1: 30,992/30,992 lines identical to Python), which is a port
//! of `worker/main.py:164` and `vieneu_utils/phonemize_text.py:122`. sea-g2p-rs and tokenizers are pinned as in S2.

use regex::Regex;
use sea_g2p_rs::g2p::G2PEngine;
use sea_g2p_rs::lang::vi::Normalizer;
use sea_g2p_rs::punc::apply_punc_norm;
use std::path::Path;
use tokenizers::Tokenizer;

const STRIP: &[char] = &[' ', '.', '!', '?', ',', ';', ':'];

/// Normaliser, G2P engine and tokenizer.
pub struct Front {
    norm: Normalizer,
    engine: G2PEngine,
    tok: Tokenizer,
    emotion_split: Regex,
}

/// Python `str.isspace()`: Unicode White_Space plus the C0 separators U+001C..U+001F.
fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

fn py_strip(s: &str) -> &str {
    s.trim_matches(py_space)
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

impl Front {
    /// Loads `sea_g2p.bin` and the model's `tokenizer.json`.
    pub fn load(dict: &Path, tokenizer_json: &Path) -> Result<Front, String> {
        let dict_s = dict.to_str().ok_or("dictionary path is not UTF-8")?;
        Ok(Front {
            norm: Normalizer::new("vi", Some(dict_s)),
            engine: G2PEngine::new(dict_s).map_err(|e| format!("dictionary: {e:?}"))?,
            tok: Tokenizer::from_file(tokenizer_json).map_err(|e| format!("tokenizer.json: {e}"))?,
            emotion_split: Regex::new(r"(\[[^\]]+\]|<\|emotion_\d+\|>)").unwrap(),
        })
    }

    /// `SEAPipeline.run(text, punc_norm)`.
    fn pipeline(&self, text: &str, punc_norm: bool) -> String {
        if text.is_empty() {
            return String::new();
        }
        self.engine.phonemize(&self.norm.normalize(text, punc_norm))
    }

    /// `Tokenizer.encode(text, add_special_tokens=False).ids`.
    pub fn ids(&self, text: &str) -> Vec<i64> {
        self.tok.encode(text, false).map(|e| e.get_ids().iter().map(|&i| i64::from(i)).collect()).unwrap_or_default()
    }

    /// `phonemize_text_with_emotions`.
    fn with_emotions(&self, text: &str) -> String {
        if !text.contains('[') && !text.contains("<|emotion_") {
            return self.pipeline(text, true);
        }
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
            } else if ph.chars().next().is_some_and(|c| ".,!?;:…)]}\"'’”".contains(c)) {
                out.push_str(&ph);
            } else {
                out = format!("{out} {ph}");
            }
        }
        apply_punc_norm(&out)
    }

    /// The reading the worker's engine gets for one chunk: `vietnamese_reading(phonemize_text_with_emotions)(text)`.
    pub fn phonemes(&self, text: &str) -> String {
        let phonemes = self.with_emotions(text);
        let body = text.trim_end_matches(STRIP);
        if body.is_empty()
            || !text.is_ascii()
            || text.contains(['<', '[', '|'])
            || body.split(py_space).filter(|w| !w.is_empty()).count() > 3
        {
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
