//! The TTS front end: phonemes and token ids for one chunk, as the worker produces them (`SEAPipeline` + `phonemize_text_with_emotions`
//! + `vietnamese_reading` + the engine's `Tokenizer.encode`).
//!
//! From spike S2's `Front` (row P1: 30,992/30,992 lines identical to Python), a port of `worker/main.py:164` and
//! `vieneu_utils/phonemize_text.py:122`; sea-g2p-rs and tokenizers are pinned as in S2.

use super::{pyuni, text};
use crate::error::{Result, WorkerError};
use sea_g2p_rs::g2p::G2PEngine;
use sea_g2p_rs::lang::vi::Normalizer;
use sea_g2p_rs::punc::apply_punc_norm;
use std::path::Path;
use tokenizers::Tokenizer;

const STRIP: &[char] = &[' ', '.', '!', '?', ',', ';', ':'];
/// `_ATTACHING_PUNCT`.
const ATTACHING: &str = ".,!?;:…)]}\"'’”";

/// Normaliser, G2P engine and tokenizer.
pub struct Front {
    norm: Normalizer,
    engine: G2PEngine,
    tok: Tokenizer,
}

impl Front {
    /// Loads `sea_g2p.bin` (the normaliser keeps its dictionary in a process global, so it is built first, as Python does) and the
    /// model's `tokenizer.json`.
    pub fn load(dict: &Path, tokenizer_json: &Path) -> Result<Front> {
        let dict_s = dict.to_str().ok_or_else(|| WorkerError::py("ValueError", "dictionary path is not UTF-8"))?;
        if !dict.is_file() {
            return Err(WorkerError::new("RUNTIME_MISSING", format!("{} is missing.", dict.display())));
        }
        Ok(Front {
            norm: Normalizer::new("vi", Some(dict_s)),
            engine: G2PEngine::new(dict_s).map_err(|e| WorkerError::py("RuntimeError", format!("{e:?}")))?,
            tok: Tokenizer::from_file(tokenizer_json).map_err(|e| WorkerError::py("Exception", e))?,
        })
    }

    /// The normaliser (the chunker's first pass uses it too).
    pub fn normalizer(&self) -> &Normalizer {
        &self.norm
    }

    /// `SEAPipeline.run(text, punc_norm)`.
    fn pipeline(&self, text: &str, punc_norm: bool) -> String {
        if text.is_empty() {
            return String::new();
        }
        self.engine.phonemize(&self.norm.normalize(text, punc_norm))
    }

    /// `Tokenizer.encode(text, add_special_tokens=False).ids`.
    pub fn ids(&self, text: &str) -> Result<Vec<i64>> {
        let encoding = self.tok.encode(text, false).map_err(|e| WorkerError::py("Exception", e))?;
        Ok(encoding.get_ids().iter().map(|&i| i64::from(i)).collect())
    }

    /// `phonemize_text_with_emotions`.
    fn with_emotions(&self, text: &str) -> String {
        if !text.contains('[') && !text.contains("<|emotion_") {
            return self.pipeline(text, true);
        }
        let mut out = String::new();
        for (i, part) in text::emotion_split(text).into_iter().enumerate() {
            if i % 2 == 1 {
                if let Some(token) = text::emotion_tag_token(part) {
                    out = if out.is_empty() { token } else { format!("{out} {token}") };
                    continue;
                }
            }
            let ph = if !part.is_empty() && !pyuni::strip(part).is_empty() {
                self.pipeline(part, false)
            } else {
                String::new()
            };
            if ph.is_empty() {
                continue;
            }
            if out.is_empty() {
                out = ph;
            } else if ph.chars().next().is_some_and(|c| ATTACHING.contains(c)) {
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
        if body.is_empty() || !text.is_ascii() || text.contains(['<', '[', '|']) || pyuni::split(body).count() > 3 {
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
