//! The text side of `tts()` (row L): the per-item text check with the token cap and `split_pauses` from `worker/main.py`, and VieNeu's
//! chunker `normalize_to_chunks_v3_with_gaps` (`vieneu_utils/phonemize_text.py`, `core_utils.py`), ported statement by statement.
//!
//! Python's `re` patterns keep their shape; their `\s`, `\d`, `\w` and case-insensitive letters become explicit classes built from
//! Python's own tables ([`super::pyuni`]). Lengths and indices count code points, as Python's `str` does.

use super::pyuni::{self, is_space};
use crate::error::{Result, WorkerError};
use regex::Regex;
use sea_g2p_rs::lang::vi::Normalizer;
use sea_g2p_rs::punc::apply_punc_norm;
use std::sync::OnceLock;

/// `MAX_TOKEN_CHARS`: the longest run without whitespace a text may hold.
pub const MAX_TOKEN_CHARS: usize = 600;

/// The per-item check of `tts()`: `text` is `None` when the item has no string `text`.
pub fn check_text(text: Option<&str>) -> Result<()> {
    match text {
        Some(t) if !pyuni::strip(t).is_empty() && pyuni::len(t) <= 100_000 => {}
        _ => {
            return Err(WorkerError::new(
                "INVALID_TEXT",
                "Supply non-empty text, at most 100,000 characters per segment.",
            ))
        }
    }
    if pyuni::split(text.unwrap_or_default()).any(|token| pyuni::len(token) > MAX_TOKEN_CHARS) {
        return Err(WorkerError::new(
            "INVALID_TEXT",
            format!("Có một chuỗi liền dài hơn {MAX_TOKEN_CHARS} ký tự mà không có dấu cách. Hãy thêm dấu cách để chia nhỏ."),
        ));
    }
    Ok(())
}

fn class_body(ranges: impl Iterator<Item = (u32, u32)>) -> String {
    ranges.map(|(a, b)| if a == b { format!("\\x{{{a:x}}}") } else { format!("\\x{{{a:x}}}-\\x{{{b:x}}}") }).collect()
}

/// `\s` as a class body.
fn py_s() -> String {
    class_body(pyuni::space_ranges())
}

/// `\d` as a class body.
fn py_d() -> String {
    class_body(pyuni::decimal_ranges())
}

/// A pattern word matched as `re.IGNORECASE` matches it.
fn folded(word: &str) -> String {
    word.chars().map(|l| format!("[{}]", class_body(pyuni::fold_set(l).iter().map(|&c| (c, c))))).collect()
}

/// `PAUSE_MARK` (`main.py:79`). `(?!\w)[^\]]*\]` is written `(?:[^\]\w][^\]]*)?\]`, which matches the same spans, so the linear-time
/// `regex` crate runs it: a backtracking engine is quadratic on long whitespace runs, and fancy-regex then stops at its backtrack limit.
fn pause_mark_pattern() -> String {
    let (s, d, w) = (py_s(), py_d(), class_body(pyuni::word_ranges()));
    format!(
        r"\[[{s}]*(?:(?:{}|{})(?:[^\]{w}][^\]]*)?|{}[{s}]*(?:[{d}][^\]]*)?)\]",
        folded("nghỉ"),
        folded("pause"),
        folded("nghi")
    )
}

struct Patterns {
    mark: Regex,
    run: Regex,
    value: Regex,
    emotion_split: Regex,
    emotion_token: Regex,
    frame_markup: Regex,
    newline: Regex,
    minor_punct: Regex,
    token_keep_en: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let (s, d, mark) = (py_s(), py_d(), pause_mark_pattern());
        let unit = ["ms", "second", "sec", "s", "giây", "giay"].map(folded);
        Patterns {
            run: Regex::new(&format!("[{s}]*(?:{mark}[{s}]*)+")).unwrap(),
            mark: Regex::new(&mark).unwrap(),
            // PAUSE_VALUE (`main.py:80`), as `fullmatch`.
            value: Regex::new(&format!(
                r"\A\[[{s}]*(?:{}|{}|{})[{s}]*(?:([{d}]+(?:[.,][{d}]+)?)[{s}]*({}|{}{}?|{}|{}|{}|{})?[{s}]*)?\]\z",
                folded("nghỉ"),
                folded("nghi"),
                folded("pause"),
                unit[0],
                unit[1],
                folded("s"),
                unit[2],
                unit[3],
                unit[4],
                unit[5]
            ))
            .unwrap(),
            emotion_split: Regex::new(&format!(r"(\[[^\]]+\]|<\|emotion_[{d}]+\|>)")).unwrap(),
            emotion_token: Regex::new(&format!(r"<\|emotion_[{d}]+\|>")).unwrap(),
            frame_markup: Regex::new(&format!(r"<\|emotion_[{d}]+\|>|</?en>")).unwrap(),
            newline: Regex::new(r"[\r\n]+").unwrap(),
            // `(?<=[,;:\-–—])\s+` as the group of `[,;:\-–—](\s+)`: the punctuation is never whitespace, so the spans are the same.
            minor_punct: Regex::new(&format!(r"[,;:\-–—]([{s}]+)")).unwrap(),
            // `<en>.*?</en>|\S+` with IGNORECASE | DOTALL; `e` and `n` fold only to their ASCII capitals.
            token_keep_en: Regex::new(&format!(r"(?s)<[eE][nN]>.*?</[eE][nN]>|[^{s}]+")).unwrap(),
        }
    })
}

/// `pause_seconds(mark)`: seconds of a pause mark (bare = 1 s, no unit = seconds), or `None` when it does not parse.
fn pause_seconds(mark: &str) -> Option<f64> {
    let m = patterns().value.captures(mark)?;
    let Some(number) = m.get(1) else { return Some(1.0) };
    // float() reads every Unicode decimal digit; the comma is the decimal separator.
    let ascii: String = number
        .as_str()
        .chars()
        .map(|c| if c == ',' { '.' } else { pyuni::decimal(c).map_or(c, |v| char::from(b'0' + v as u8)) })
        .collect();
    let value: f64 = ascii.parse().ok()?;
    let ms = m.get(2).map_or("s".to_string(), |u| u.as_str().to_lowercase()) == "ms";
    Some(if ms { value / 1000.0 } else { value })
}

/// `split_pauses(text)`: each spoken part with the silence before it, and the trailing silence.
pub fn split_pauses(text: &str) -> Result<(Vec<(String, f64)>, f64)> {
    let p = patterns();
    let mut replaced = String::with_capacity(text.len());
    let mut last = 0;
    for run in p.run.find_iter(text) {
        replaced.push_str(&text[last..run.start()]);
        let kept: String = p
            .mark
            .find_iter(run.as_str())
            .filter(|m| pause_seconds(m.as_str()).is_some())
            .map(|m| m.as_str())
            .collect();
        if !kept.is_empty() {
            replaced.push_str(&kept);
        } else if !(run.start() == 0
            || run.end() == text.len()
            || text[run.end()..].starts_with([',', '.', ';', ':', '!', '?', '…']))
        {
            replaced.push(' ');
        }
        last = run.end();
    }
    replaced.push_str(&text[last..]);
    let text = replaced;
    let (mut parts, mut pause, mut pos) = (Vec::new(), 0.0f64, 0);
    for m in p.mark.find_iter(&text) {
        let chunk = pyuni::strip(&text[pos..m.start()]);
        if !chunk.is_empty() {
            parts.push((chunk.to_string(), pause));
            pause = 0.0;
        }
        let Some(seconds) = pause_seconds(m.as_str()) else {
            return Err(WorkerError::py("TypeError", "'<=' not supported between instances of 'float' and 'NoneType'"));
        };
        if !(0.05..=10.0).contains(&seconds) {
            return Err(WorkerError::new("INVALID_TEXT", "Khoảng nghỉ phải từ 0,05 đến 10 giây."));
        }
        pause += seconds;
        pos = m.end();
    }
    let chunk = pyuni::strip(&text[pos..]);
    if !chunk.is_empty() {
        parts.push((chunk.to_string(), pause));
        pause = 0.0;
    }
    if parts.is_empty() {
        return Err(WorkerError::new("INVALID_TEXT", "Đoạn chỉ có khoảng nghỉ, chưa có lời để đọc."));
    }
    Ok((parts, pause))
}

// ---- the VieNeu chunker ----

const OPENERS: &[char] = &['(', '[', '{', '“', '‘', '«', '‹', '「', '『'];
const CLOSERS: &[char] = &[')', ']', '}', '”', '’', '»', '›', '」', '』'];
const SENT_END: &[char] = &['.', '!', '?', '…'];
const CONN_WORDS: &[&str] = &["và", "nhưng", "hoặc", "song", "rồi", "nên", "vì", "nếu", "khi", "để", "do", "bởi"];
const CONN_PAIRS: &[(&str, &str)] = &[
    ("sau", "khi"),
    ("trước", "khi"),
    ("trong", "khi"),
    ("mỗi", "khi"),
    ("đến", "khi"),
    ("tới", "khi"),
    ("cho", "nên"),
    ("cho", "đến"),
    ("bởi", "vì"),
    ("nếu", "như"),
    ("tuy", "nhiên"),
    ("thế", "nhưng"),
    ("vì", "vậy"),
    ("vì", "thế"),
    ("do", "đó"),
    ("sau", "đó"),
];
const CONN_STRIP: &[char] = &['"', '\'', '“', '”', '‘', '’', '(', ')', '[', ']', '«', '»', '…'];
const NUMBER_WORDS: &[&str] = &[
    "không", "một", "mốt", "hai", "ba", "bốn", "tư", "năm", "lăm", "sáu", "bảy", "tám", "chín", "mười", "mươi", "trăm",
    "nghìn", "ngàn", "triệu", "tỷ", "tỉ", "linh", "lẻ", "phẩy", "chấm",
];
const CHUNK_TAIL_SLACK: usize = 15;

fn trailing_close(c: char) -> bool {
    CLOSERS.contains(&c) || ['"', '\'', '’', '”'].contains(&c)
}

/// `_scan_sentences(text, quote_aware)`: `(sentences, balanced)`.
fn scan_sentences(text: &[char], quote_aware: bool) -> (Vec<String>, bool) {
    let n = text.len();
    let (mut sentences, mut start, mut i, mut depth, mut in_quote) = (Vec::new(), 0, 0, 0usize, false);
    while i < n {
        let ch = text[i];
        if quote_aware && ch == '"' {
            in_quote = !in_quote;
        } else if quote_aware && OPENERS.contains(&ch) {
            depth += 1;
        } else if quote_aware && CLOSERS.contains(&ch) {
            depth = depth.saturating_sub(1);
        } else if SENT_END.contains(&ch) && depth == 0 && !in_quote {
            let mut j = i + 1;
            while j < n && SENT_END.contains(&text[j]) {
                j += 1;
            }
            while j < n && trailing_close(text[j]) {
                j += 1;
            }
            if j >= n || is_space(text[j]) {
                sentences.push(text[start..j].iter().collect::<String>());
                start = j;
            }
            i = j;
            continue;
        }
        i += 1;
    }
    if start < n {
        sentences.push(text[start..].iter().collect());
    }
    let kept = sentences.iter().map(|s| pyuni::strip(s)).filter(|s| !s.is_empty()).map(str::to_string).collect();
    (kept, depth == 0 && !in_quote)
}

/// `split_into_sentences(text)`.
fn split_into_sentences(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let (sentences, balanced) = scan_sentences(&chars, true);
    if balanced {
        sentences
    } else {
        scan_sentences(&chars, false).0
    }
}

/// `_emotion_tag_token(tag)`.
pub fn emotion_tag_token(tag: &str) -> Option<String> {
    let t = pyuni::strip(tag);
    if t.starts_with("<|") {
        return Some(t.to_string());
    }
    let chars: Vec<char> = t.chars().collect();
    let inner: String = chars.get(1..chars.len().saturating_sub(1)).unwrap_or_default().iter().collect();
    let k = match pyuni::strip(&inner).to_lowercase().as_str() {
        "chuckle" | "cười" | "cuoi" => 1,
        "sigh" | "thở dài" | "tho dai" => 2,
        "clear throat" | "hắng giọng" | "hang giong" => 3,
        _ => return None,
    };
    Some(format!("<|emotion_{k}|>"))
}

/// `_EMOTION_SPLIT_RE.split(text)`: text and tags alternate, text first and last (the tags at odd indices).
pub fn emotion_split(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut pos = 0;
    for m in patterns().emotion_split.find_iter(text) {
        parts.push(&text[pos..m.start()]);
        parts.push(m.as_str());
        pos = m.end();
    }
    parts.push(&text[pos..]);
    parts
}

/// `_normalize_sentence_keep_cues(sentence, normalizer)`.
fn normalize_sentence_keep_cues(sentence: &str, norm: &Normalizer) -> String {
    if !sentence.contains('[') && !sentence.contains("<|emotion_") {
        return norm.normalize(sentence, false);
    }
    let mut parts = Vec::new();
    for (i, part) in emotion_split(sentence).into_iter().enumerate() {
        if i % 2 == 1 {
            parts.push(emotion_tag_token(part).unwrap_or_else(|| part.to_string()));
        } else if !pyuni::strip(part).is_empty() {
            parts.push(norm.normalize(part, false));
        }
    }
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `_normalized_sentences_by_para(text, keep_cues=keep_cues)`.
fn normalized_sentences_by_para(text: &str, keep_cues: bool, norm: &Normalizer) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for para in patterns().newline.split(text).filter(|p| !pyuni::strip(p).is_empty()) {
        let sentences = split_into_sentences(para);
        if sentences.is_empty() {
            continue;
        }
        out.push(if keep_cues {
            sentences.iter().map(|s| normalize_sentence_keep_cues(s, norm)).collect()
        } else {
            // normalize_batch: the same normalize per sentence (sea-g2p `normalize_all`).
            sentences.iter().map(|s| norm.normalize(s, false)).collect()
        });
    }
    out
}

fn tail_slack(max_chars: usize) -> usize {
    CHUNK_TAIL_SLACK.min(max_chars / 8)
}

/// `_fits(cur_len, add_len, max_chars)`.
fn fits(cur_len: usize, add_len: usize, max_chars: usize) -> bool {
    let total = if cur_len > 0 { cur_len + 1 + add_len } else { add_len };
    let slack = tail_slack(max_chars);
    total <= max_chars || (add_len <= slack && total <= max_chars + slack)
}

/// `_conn_key(token)`.
fn conn_key(token: &str) -> String {
    token.trim_matches(CONN_STRIP).to_lowercase()
}

fn is_conn_pair(a: &str, b: &str) -> bool {
    CONN_PAIRS.iter().any(|&(x, y)| x == a && y == b)
}

/// `_is_number_word(token)`.
fn is_number_word(token: &str) -> bool {
    let key = conn_key(token);
    NUMBER_WORDS.contains(&key.as_str()) || (!key.is_empty() && key.chars().all(pyuni::is_digit))
}

/// `_span_len(words, start, end)`.
fn span_len(lens: &[usize], start: usize, end: usize) -> usize {
    if end <= start {
        0
    } else {
        lens[start..end].iter().sum::<usize>() + (end - start - 1)
    }
}

/// `_balanced_cut(words, start, target, max_chars, min_left)`.
fn balanced_cut(words: &[&str], lens: &[usize], start: usize, target: f64, max_chars: usize, min_left: usize) -> usize {
    let mut best_nat: Option<(f64, usize)> = None;
    let mut best_plain: Option<(f64, usize)> = None;
    let mut end_cap = start + 1;
    for j in start + 1..words.len() {
        let left = span_len(lens, start, j);
        if left > max_chars {
            break;
        }
        end_cap = j;
        let (key, prev) = (conn_key(words[j]), conn_key(words[j - 1]));
        let nxt = if j + 1 < words.len() { conn_key(words[j + 1]) } else { String::new() };
        let d = (left as f64 - target).abs();
        let inside_pair = is_conn_pair(&prev, &key);
        let natural =
            (CONN_WORDS.contains(&key.as_str()) || is_conn_pair(&key, &nxt)) && !CONN_WORDS.contains(&prev.as_str());
        if natural && !inside_pair && left >= min_left && best_nat.map_or(true, |b| d < b.0) {
            best_nat = Some((d, j));
        }
        let plain_ok = !inside_pair && !(is_number_word(words[j - 1]) && is_number_word(words[j]));
        if plain_ok && best_plain.map_or(true, |b| d < b.0) {
            best_plain = Some((d, j));
        }
    }
    if let Some((_, j)) = best_nat.or(best_plain) {
        return j;
    }
    let mut end = end_cap;
    while end > start + 1 && end < words.len() && is_conn_pair(&conn_key(words[end - 1]), &conn_key(words[end])) {
        end -= 1;
    }
    end
}

/// `_split_long_part(part, max_chars)`.
fn split_long_part(part: &str, max_chars: usize) -> Vec<String> {
    let words: Vec<&str> = patterns().token_keep_en.find_iter(part).map(|m| m.as_str()).collect();
    let lens: Vec<usize> = words.iter().map(|w| pyuni::len(w)).collect();
    let min_left = max_chars / 3;
    let mut pieces = Vec::new();
    let mut start = 0;
    while start < words.len() {
        let rest = span_len(&lens, start, words.len());
        if rest <= max_chars {
            pieces.push(words[start..].join(" "));
            break;
        }
        let mut full = start + 1;
        while full < words.len() && span_len(&lens, start, full + 1) <= max_chars {
            full += 1;
        }
        if fits(span_len(&lens, start, full), span_len(&lens, full, words.len()), max_chars) {
            pieces.push(words[start..].join(" "));
            break;
        }
        let n_pieces = rest.div_ceil(max_chars);
        let end = balanced_cut(&words, &lens, start, rest as f64 / n_pieces as f64, max_chars, min_left);
        pieces.push(words[start..end].join(" "));
        start = end;
    }
    pieces
}

/// `RE_MINOR_PUNCT.split(sentence)`.
fn minor_punct_split(sentence: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut pos = 0;
    for c in patterns().minor_punct.captures_iter(sentence) {
        let m = c.get(1).unwrap();
        parts.push(&sentence[pos..m.start()]);
        pos = m.end();
    }
    parts.push(&sentence[pos..]);
    parts
}

/// `pack_sentences_into_chunks(sentences, max_chars)`.
fn pack_sentences_into_chunks(sentences: &[String], max_chars: usize) -> Vec<String> {
    let mut final_chunks: Vec<String> = Vec::new();
    let mut buffer = String::new();
    for sentence in sentences {
        let sentence = pyuni::strip(sentence);
        if sentence.is_empty() {
            continue;
        }
        if pyuni::len(sentence) > max_chars {
            if !buffer.is_empty() {
                final_chunks.push(std::mem::take(&mut buffer));
            }
            for part in minor_punct_split(sentence) {
                let part = pyuni::strip(part);
                if part.is_empty() {
                    continue;
                }
                if fits(pyuni::len(&buffer), pyuni::len(part), max_chars) {
                    buffer = if buffer.is_empty() { part.to_string() } else { format!("{buffer} {part}") };
                } else {
                    if !buffer.is_empty() {
                        final_chunks.push(std::mem::take(&mut buffer));
                    }
                    buffer = part.to_string();
                    if pyuni::len(&buffer) > max_chars {
                        let mut pieces = split_long_part(&buffer, max_chars);
                        buffer = pieces.pop().unwrap_or_default();
                        final_chunks.extend(pieces);
                    }
                }
            }
        } else if !buffer.is_empty() && !fits(pyuni::len(&buffer), pyuni::len(sentence), max_chars) {
            final_chunks.push(std::mem::replace(&mut buffer, sentence.to_string()));
        } else {
            buffer = if buffer.is_empty() { sentence.to_string() } else { format!("{buffer} {sentence}") };
        }
    }
    if !buffer.is_empty() {
        final_chunks.push(buffer);
    }
    final_chunks.iter().map(|c| pyuni::strip(c)).filter(|c| !c.is_empty()).map(str::to_string).collect()
}

/// `_classify_gap(chunk)`.
fn classify_gap(chunk: &str) -> &'static str {
    match pyuni::rstrip(chunk).chars().last() {
        Some('.' | '!' | '?') => "sentence",
        _ => "minor",
    }
}

/// `_FRAME_MARKUP_RE.sub("", s)` (`core_utils.py:97`): without emotion tokens and `<en>`/`</en>` tags.
pub fn strip_frame_markup(s: &str) -> String {
    patterns().frame_markup.replace_all(s, "").into_owned()
}

/// `_effective_len(chunk)`.
fn effective_len(chunk: &str) -> usize {
    pyuni::len(pyuni::strip(&patterns().emotion_token.replace_all(chunk, "")))
}

/// `_merge_short_chunks(chunks, gaps, min_chars)`.
fn merge_short_chunks(
    mut chunks: Vec<String>,
    mut gaps: Vec<&'static str>,
    min_chars: usize,
) -> (Vec<String>, Vec<&'static str>) {
    while chunks.len() > 1 {
        let short: Vec<usize> = (0..chunks.len()).filter(|&i| effective_len(&chunks[i]) < min_chars).collect();
        // min() keeps the first of equal keys
        let Some(&i) = short.iter().min_by_key(|&&k| effective_len(&chunks[k])) else { break };
        // max() over (key, side) keeps the first of equal keys: "R" is listed first
        let mut sides: Vec<((bool, i64), char)> = Vec::new();
        if i < chunks.len() - 1 {
            sides.push(((gaps[i] != "para", -(pyuni::len(&chunks[i + 1]) as i64)), 'R'));
        }
        if i > 0 {
            sides.push(((gaps[i - 1] != "para", -(pyuni::len(&chunks[i - 1]) as i64)), 'L'));
        }
        let side = sides.iter().fold(None::<&((bool, i64), char)>, |best, s| match best {
            Some(b) if b.0 >= s.0 => Some(b),
            _ => Some(s),
        });
        if side.map(|s| s.1) == Some('R') {
            let next = chunks.remove(i + 1);
            chunks[i] = format!("{} {next}", chunks[i]);
            gaps.remove(i);
        } else {
            let this = chunks.remove(i);
            chunks[i - 1] = format!("{} {this}", chunks[i - 1]);
            gaps.remove(i - 1);
        }
    }
    (chunks, gaps)
}

/// `normalize_to_chunks_v3_with_gaps(text, max_chars=256, min_chunk_chars=20)`: the chunks the engine reads and the boundary kind after
/// each (`para`, `sentence`, `minor`).
pub fn chunks_with_gaps(text: &str, norm: &Normalizer) -> (Vec<String>, Vec<&'static str>) {
    if text.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let keep_cues = text.contains('[') || text.contains("<|emotion_");
    let (mut chunks, mut gaps): (Vec<String>, Vec<&'static str>) = (Vec::new(), Vec::new());
    for sentences in normalized_sentences_by_para(text, keep_cues, norm) {
        let para_chunks = pack_sentences_into_chunks(&sentences, 256);
        if para_chunks.is_empty() {
            continue;
        }
        if !chunks.is_empty() {
            gaps.push("para");
        }
        for (j, ch) in para_chunks.into_iter().enumerate() {
            if j > 0 {
                gaps.push("sentence");
            }
            chunks.push(ch);
        }
    }
    let chunks: Vec<String> = chunks.iter().map(|c| apply_punc_norm(c)).collect();
    let gaps = gaps.iter().enumerate().map(|(i, &g)| if g == "para" { g } else { classify_gap(&chunks[i]) }).collect();
    merge_short_chunks(chunks, gaps, 20)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_cap_counts_code_points_between_python_whitespace() {
        assert!(check_text(Some(&"Việt".repeat(150))).is_ok());
        assert_eq!(check_text(Some(&format!("{}x", "Việt".repeat(150)))).unwrap_err().code, "INVALID_TEXT");
        assert!(check_text(Some(&format!("a\u{3000}{}", "b".repeat(600)))).is_ok());
        assert!(check_text(Some(&format!("a\u{1c}{}", "b".repeat(600)))).is_ok());
        for bad in [None, Some(""), Some(" \u{85} ")] {
            assert_eq!(
                check_text(bad).unwrap_err().message,
                "Supply non-empty text, at most 100,000 characters per segment."
            );
        }
    }

    #[test]
    fn pause_marks_as_python_reads_them() {
        let (parts, trailing) = split_pauses("Xin chào. [nghỉ 0,5s] Tạm biệt [NGHỈ 250ms][nghỉ 1 giây]").unwrap();
        assert_eq!(parts, [("Xin chào.".to_string(), 0.0), ("Tạm biệt".to_string(), 0.5)]);
        assert!((trailing - 1.25).abs() < 1e-12);
        assert_eq!(pause_seconds("[nghı 2]"), Some(2.0)); // dotless i folds to i in Python's re
        assert_eq!(pause_seconds("[pauſe \u{663}]"), Some(3.0));
        assert_eq!(pause_seconds("[nghỉ 300mſ]"), Some(300.0)); // 'mſ'.lower() is not 'ms'
        assert_eq!(pause_seconds("[nghỉ 2 secs]"), None);
        // a combining mark is not \w, so this is a mark; it does not parse, so it is dropped
        assert_eq!(split_pauses("A [pause\u{301}] B").unwrap().0, [("A B".to_string(), 0.0)]);
        assert_eq!(split_pauses("Hôm nay [nghỉ abc], trời").unwrap().0, [("Hôm nay, trời".to_string(), 0.0)]);
        assert_eq!(split_pauses("[nghỉ 1s]").unwrap_err().message, "Đoạn chỉ có khoảng nghỉ, chưa có lời để đọc.");
        assert_eq!(split_pauses("A [nghỉ 0] B").unwrap_err().message, "Khoảng nghỉ phải từ 0,05 đến 10 giây.");
    }

    /// Long runs that a backtracking engine retries at every position (CI row P1 found `a` + spaces + `bê`); answers from Python.
    #[test]
    fn long_runs_match_like_python() {
        let spaces = " ".repeat(5000);
        let ws = format!("a{spaces}bê");
        assert_eq!(split_pauses(&ws).unwrap(), (vec![(ws.clone(), 0.0)], 0.0));
        let marked = format!("a{spaces}[nghỉ 1s]{spaces}b");
        assert_eq!(split_pauses(&marked).unwrap(), (vec![("a".to_string(), 0.0), ("b".to_string(), 1.0)], 0.0));
        let open = format!("x [pause{}", " y".repeat(3000));
        assert_eq!(split_pauses(&open).unwrap().0, [(open.clone(), 0.0)]);
        assert_eq!(split_pauses(&format!("a {}b", "[nghi 3x] ".repeat(200))).unwrap().0, [("a b".to_string(), 0.0)]);
        let long = format!("a,{}b;-  c —\td", " ".repeat(4000));
        assert_eq!(minor_punct_split(&long).iter().map(|p| pyuni::len(p)).collect::<Vec<_>>(), [2, 3, 3, 1]);
        assert_eq!(minor_punct_split("a, b;c -  d — e,f"), ["a,", "b;c -", "d —", "e,f"]);
    }

    #[test]
    fn chunker_helpers() {
        assert_eq!(
            split_into_sentences("Có phải \"Rồi sao? Thôi.\", đúng không? Vâng. 3.5 triệu"),
            ["Có phải \"Rồi sao? Thôi.\", đúng không?", "Vâng.", "3.5 triệu"]
        );
        assert_eq!(minor_punct_split("a, b;c -  d"), ["a,", "b;c -", "d"]);
        assert_eq!(classify_gap("xin chào. "), "sentence");
        assert_eq!(effective_len(" <|emotion_1|> ab "), 2);
        assert_eq!(emotion_tag_token("[ Cười ]").as_deref(), Some("<|emotion_1|>"));
        assert!(is_number_word("“hai”") && is_number_word("²") && !is_number_word(""));
    }
}
