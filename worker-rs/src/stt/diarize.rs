//! The speaker half of `stt` (worker/main.py with `diarize_model_path`, and the parent side of worker/diarize.py): the decoded audio
//! goes to `thanham-diarize.exe` through a temporary folder as `diarize_isolated()` hands it to its child, and `split_rows()` gives
//! each transcript row the speaker of its words.

use super::glue::{py_strip, Row, Word};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// A run of words shorter than this joins a neighbour run (diarize.py MIN_RUN_S).
const MIN_RUN_S: f64 = 0.6;
/// A row is marked as talked over from this share of its time (diarize.py OVERLAP_SHARE).
const OVERLAP_SHARE: f64 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Turn {
    pub start: f64,
    pub end: f64,
    pub speaker: i64,
}

/// A transcript row with its speaker, and `overlap` (the other speaker's id) when talked over.
#[derive(Clone, Debug, PartialEq)]
pub struct SpeakerRow {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub speaker: i64,
    pub overlap: Option<i64>,
}

impl SpeakerRow {
    /// `{**row, 'speaker': ...}` and `row['overlap']`, keys in Python's order.
    pub fn json(&self) -> Value {
        let mut row = json!({"start": self.start, "end": self.end, "text": self.text, "speaker": self.speaker});
        if let Some(other) = self.overlap {
            row["overlap"] = json!(other);
        }
        row
    }
}

/// How diarization failed: `Process` is a failure of the child process (`diarize_error_code = DIARIZE_PROCESS`), `Other` an error
/// Python raises before it starts. Both carry `str(error)`.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Process(String),
    Other(String),
}

/// Python's `max(a, b)` and `min(a, b)` on floats: the first argument unless the second is strictly greater (smaller).
fn py_max(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

fn py_min(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

fn tuple_order(a: &(f64, f64), b: &(f64, f64)) -> std::cmp::Ordering {
    let eq = std::cmp::Ordering::Equal;
    a.0.partial_cmp(&b.0).unwrap_or(eq).then(a.1.partial_cmp(&b.1).unwrap_or(eq))
}

/// `assign_speakers` for one span: the speaker of largest time overlap (ties: lower id), else of the nearest turn, else 0.
fn assign_speaker(start: f64, end: f64, turns: &[Turn]) -> i64 {
    let mut overlap: Vec<(i64, f64)> = Vec::new();
    for t in turns {
        let shared = py_min(end, t.end) - py_max(start, t.start);
        if shared > 0.0 {
            match overlap.iter_mut().find(|(s, _)| *s == t.speaker) {
                Some(entry) => entry.1 += shared,
                None => overlap.push((t.speaker, shared)),
            }
        }
    }
    if let Some(&first) = overlap.first() {
        // `max(overlap, key=lambda s: (overlap[s], -s))`
        overlap.iter().skip(1).fold(first, |b, &(s, v)| if v > b.1 || (v == b.1 && s < b.0) { (s, v) } else { b }).0
    } else if let Some(first) = turns.first() {
        // `min(turns, key=gap)`: the first turn with the smallest gap
        let gap = |t: &Turn| py_max(t.start - end, start - t.end);
        turns.iter().skip(1).fold(first, |b, t| if gap(t) < gap(b) { t } else { b }).speaker
    } else {
        0
    }
}

/// `other_cover`: the speaker other than `speaker` whose turns cover most of the span, and that share; `(None, 0.0)` if none.
fn other_cover(start: f64, end: f64, turns: &[Turn], speaker: i64) -> (Option<i64>, f64) {
    let mut spans: Vec<(i64, Vec<(f64, f64)>)> = Vec::new();
    for t in turns {
        let (s, e) = (py_max(start, t.start), py_min(end, t.end));
        if t.speaker != speaker && e > s {
            match spans.iter_mut().find(|(k, _)| *k == t.speaker) {
                Some(entry) => entry.1.push((s, e)),
                None => spans.push((t.speaker, vec![(s, e)])),
            }
        }
    }
    spans.sort_by_key(|(k, _)| *k);
    let (mut best, mut share) = (None, 0.0);
    for (other, mut list) in spans {
        list.sort_by(tuple_order); // the turns of one speaker may overlap each other
        let (mut covered, mut edge) = (0.0, start);
        for (s, e) in list {
            covered += py_max(0.0, e - py_max(s, edge));
            edge = py_max(edge, e);
        }
        if covered / (end - start) > share {
            (best, share) = (Some(other), covered / (end - start));
        }
    }
    (best, share)
}

/// `_join_runs`: consecutive (speaker, words) pairs of the same speaker joined into runs.
fn join_runs<'a>(pairs: impl IntoIterator<Item = (i64, Vec<&'a Word>)>) -> Vec<(i64, Vec<&'a Word>)> {
    let mut runs: Vec<(i64, Vec<&Word>)> = Vec::new();
    for (speaker, words) in pairs {
        match runs.last_mut() {
            Some(last) if last.0 == speaker => last.1.extend(words),
            _ => runs.push((speaker, words)),
        }
    }
    runs
}

/// `split_rows`: each row gets a speaker and splits where its words change speaker; a run of words shorter than MIN_RUN_S joins its
/// longer neighbour run. A row without words, or with a single run, keeps its start, end and text.
pub fn split_rows(rows: &[Row], words: &[Vec<Word>], turns: &[Turn]) -> Vec<SpeakerRow> {
    let mut out = Vec::new();
    for (row, row_words) in rows.iter().zip(words) {
        let whole =
            |speaker| SpeakerRow { start: row.start, end: row.end, text: row.text.clone(), speaker, overlap: None };
        if row_words.is_empty() {
            out.push(whole(assign_speaker(row.start, row.end, turns)));
            continue;
        }
        let mut runs = join_runs(row_words.iter().map(|w| (assign_speaker(w.start, w.end, turns), vec![w])));
        while runs.len() > 1 {
            let span: Vec<f64> = runs.iter().map(|(_, run)| run[run.len() - 1].end - run[0].start).collect();
            let i = (1..span.len()).fold(0, |m, k| if span[k] < span[m] { k } else { m });
            if span[i] >= MIN_RUN_S {
                break;
            }
            let j = if i == runs.len() - 1 || (i > 0 && span[i - 1] >= span[i + 1]) { i - 1 } else { i + 1 };
            runs[i].0 = runs[j].0;
            runs = join_runs(runs);
        }
        if runs.len() == 1 {
            out.push(whole(runs[0].0));
        } else {
            for (speaker, run) in runs {
                let text: String = run.iter().map(|w| w.text.as_str()).collect();
                out.push(SpeakerRow {
                    start: run[0].start,
                    end: run[run.len() - 1].end,
                    text: py_strip(&text).to_string(),
                    speaker,
                    overlap: None,
                });
            }
        }
    }
    for row in &mut out {
        let (other, share) = other_cover(row.start, row.end, turns, row.speaker);
        if share >= OVERLAP_SHARE {
            row.overlap = other;
        }
    }
    out
}

/// `np.save` of a 1-D float32 array (format 1.0, header padded to 64 bytes).
fn write_npy(path: &Path, audio: &[f32]) -> std::io::Result<()> {
    let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': ({},), }}", audio.len());
    header.push_str(&" ".repeat((64 - (10 + header.len() + 1) % 64) % 64));
    header.push('\n');
    let mut bytes = Vec::with_capacity(10 + header.len() + 4 * audio.len());
    bytes.extend_from_slice(b"\x93NUMPY\x01\x00");
    bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
    bytes.extend_from_slice(header.as_bytes());
    for v in audio {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, bytes)
}

/// `thanham-diarize.exe` ships next to the worker exe.
pub fn diarize_exe() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or(Path::new(".")).join("thanham-diarize.exe")
}

/// `diarize_isolated(audio, model_dir, None, min_speakers, max_speakers)`: the turns `exe` finds, run with sherpa-onnx from
/// `sherpa_lib` (the wheel's `sherpa_onnx\lib`). `model_dir` is `str(Path(...))`.
pub fn diarize_isolated(
    exe: &Path,
    sherpa_lib: &Path,
    audio: &[f32],
    model_dir: &str,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<Vec<Turn>, Failure> {
    // `_check`; the speaker counts were checked by stt already.
    if audio.is_empty() || !audio.iter().all(|v| v.is_finite()) {
        return Err(Failure::Other("audio_16k must be a non-empty finite mono float array".into()));
    }
    for part in ["segmentation", "embedding"] {
        let file = Path::new(model_dir).join(part).join("model.onnx");
        if !file.is_file() {
            return Err(Failure::Other(format!("Diarization model file missing: {}", file.display())));
        }
    }
    let tmp = std::env::temp_dir().join(format!("thanham-diarize-{}", uuid::Uuid::new_v4().simple()));
    let result = run_child(exe, sherpa_lib, audio, model_dir, min, max, &tmp);
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn run_child(
    exe: &Path,
    sherpa_lib: &Path,
    audio: &[f32],
    model_dir: &str,
    min: Option<i64>,
    max: Option<i64>,
    tmp: &Path,
) -> Result<Vec<Turn>, Failure> {
    let process = |e: std::io::Error| Failure::Process(e.to_string());
    std::fs::create_dir(tmp).map_err(|e| Failure::Other(e.to_string()))?;
    let (audio_path, turns_path) = (tmp.join("audio.npy"), tmp.join("turns.json"));
    write_npy(&audio_path, audio).map_err(|e| Failure::Other(e.to_string()))?;
    let mut child = std::process::Command::new(exe);
    child
        .arg(&audio_path)
        .arg(&turns_path)
        .arg(json!([model_dir, null, min, max]).to_string())
        .env("THANHAM_SHERPA_LIB", sherpa_lib)
        .stdin(std::process::Stdio::null()); // the worker's stdin is the protocol
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut child, crate::media::CREATE_NO_WINDOW);
    let run = child.output().map_err(process)?;
    let code = run.status.code().unwrap_or(-1) as u32;
    if code != 0 {
        let stderr = String::from_utf8_lossy(&run.stderr);
        let chars: Vec<char> = py_strip(&stderr).chars().collect();
        let tail: String = chars[chars.len().saturating_sub(300)..].iter().collect();
        return Err(Failure::Process(format!(
            "Diarization process failed with exit code {code} (0x{code:08X}): {tail}"
        )));
    }
    let unusable =
        |e: String| Failure::Process(format!("Diarization process returned no usable turns (exit code 0): {e}"));
    let text = std::fs::read_to_string(&turns_path).map_err(|e| unusable(e.to_string()))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| unusable(e.to_string()))?;
    let items = value.as_array().ok_or_else(|| unusable("not a list".into()))?;
    items
        .iter()
        .map(|t| match (t["start"].as_f64(), t["end"].as_f64(), t["speaker"].as_i64()) {
            (Some(start), Some(end), Some(speaker)) => Ok(Turn { start, end, speaker }),
            _ => Err(unusable(format!("bad turn {t}"))),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns_of(v: &Value) -> Vec<Turn> {
        let f = |t: &Value, k: &str| t[k].as_f64().unwrap();
        v.as_array()
            .unwrap()
            .iter()
            .map(|t| Turn { start: f(t, "start"), end: f(t, "end"), speaker: t["speaker"].as_i64().unwrap() })
            .collect()
    }

    /// assign_speakers and split_rows against diarize.py on parity/stt/diarize.json (`diarize_cases.py`), bit for bit.
    #[test]
    fn split_rows_matches_python() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("parity/stt/diarize.json");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = cases["split"].as_array().unwrap();
        let f = |v: &Value, k: &str| v[k].as_f64().unwrap();
        let s = |v: &Value| v["text"].as_str().unwrap().to_string();
        for (i, case) in cases.iter().enumerate() {
            let turns = turns_of(&case["turns"]);
            let rows: Vec<Row> = case["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| Row { start: f(r, "start"), end: f(r, "end"), text: s(r) })
                .collect();
            let words: Vec<Vec<Word>> = case["words"]
                .as_array()
                .unwrap()
                .iter()
                .map(|ws| {
                    ws.as_array()
                        .unwrap()
                        .iter()
                        .map(|w| Word { start: f(w, "start"), end: f(w, "end"), text: s(w) })
                        .collect()
                })
                .collect();
            let assign: Vec<i64> = rows.iter().map(|r| assign_speaker(r.start, r.end, &turns)).collect();
            let want: Vec<i64> = case["assign"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
            assert_eq!(assign, want, "case {i} assign");
            let got: Vec<Value> = split_rows(&rows, &words, &turns).iter().map(SpeakerRow::json).collect();
            assert_eq!(Value::Array(got), case["split"], "case {i} split");
        }
        assert_eq!(cases.len(), 120);
    }

    /// The parent's side of a failing child: the codes and messages diarize_isolated() gives. Needs thanham-diarize.exe next to the
    /// test's target folder (`cargo test --workspace` builds it); skipped otherwise.
    #[test]
    fn child_failures() {
        let exe = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("thanham-diarize.exe");
        let dir = std::env::temp_dir().join(format!("thanham-diarize-model-{}", std::process::id()));
        for part in ["segmentation", "embedding"] {
            std::fs::create_dir_all(dir.join(part)).unwrap();
            std::fs::write(dir.join(part).join("model.onnx"), b"").unwrap();
        }
        let model = dir.to_string_lossy().into_owned();
        let audio = [0.1f32; 160];
        assert_eq!(
            diarize_isolated(&exe, &dir, &[], &model, None, None),
            Err(Failure::Other("audio_16k must be a non-empty finite mono float array".into()))
        );
        assert!(matches!(
            diarize_isolated(&dir.join("missing.exe"), &dir, &audio, &model, None, None),
            Err(Failure::Process(_))
        ));
        if exe.is_file() {
            // No sherpa-onnx in `dir`: the child exits 1 after its own checks, with its error on stderr.
            let Err(Failure::Process(message)) = diarize_isolated(&exe, &dir, &audio, &model, Some(2), Some(2)) else {
                panic!("expected a process failure")
            };
            assert!(
                message.starts_with("Diarization process failed with exit code 1 (0x00000001): OSError: cannot load "),
                "{message}"
            );
        } else {
            eprintln!("{} not built: child run skipped", exe.display());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
