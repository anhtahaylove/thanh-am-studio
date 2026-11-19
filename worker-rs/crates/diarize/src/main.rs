//! `thanham-diarize.exe`: the child process of `worker/diarize.py`'s `diarize_isolated()` for the native worker, with the same
//! command line as `diarize.py`'s `__main__`:
//!
//! `thanham-diarize <audio.npy> <turns.json> <JSON [model_dir, num_speakers, min_speakers, max_speakers]>`
//!
//! It runs `diarize()`, pyannote segmentation and CAM++ embedding clustering through sherpa-onnx 2.0.1 plus the speaker-count rules
//! around them, on a float32 `.npy` and writes the turns as JSON. A failure prints `Type: message` to stderr and exits 1, as the
//! Python child's traceback does. A native crash kills only this process, which is why diarization runs in one.
//!
//! sherpa-onnx is the Python wheel's own `sherpa-onnx-c-api.dll` (same build as `_sherpa_onnx.pyd`, with sherpa's ONNX Runtime 1.28.2
//! beside it), loaded by full path from the folder `THANHAM_SHERPA_LIB` names, else from this exe's folder.

use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const SAMPLE_RATE: i32 = 16000;
// Cosine-distance cut when the speaker count is unknown (diarize.py CLUSTER_THRESHOLD; the binding takes a float32).
const CLUSTER_THRESHOLD: f32 = 0.65;
const MIN_SPEAKER_SHARE: f64 = 0.03;
const MIN_AUTO_SHARE: f64 = 0.04;
const SHERPA_VERSION: &str = "2.0.1";

/// What the Python child's traceback ends with: `Type: message`.
#[derive(Debug)]
struct Fail(String);

impl Fail {
    fn new(kind: &str, message: impl std::fmt::Display) -> Fail {
        Fail(format!("{kind}: {message}"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Turn {
    start: f64,
    end: f64,
    speaker: i64,
}

// sherpa-onnx 2.0.1 c-api.h, the offline speaker diarization structs.
#[repr(C)]
struct PyannoteCfg {
    model: *const c_char,
    window_shift_ratio: f32,
}
#[repr(C)]
struct SegmentationCfg {
    pyannote: PyannoteCfg,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}
#[repr(C)]
struct EmbeddingCfg {
    model: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}
#[repr(C)]
struct ClusteringCfg {
    num_clusters: i32,
    threshold: f32,
    compute_confidence: i32,
}
#[repr(C)]
struct DiarizationCfg {
    segmentation: SegmentationCfg,
    embedding: EmbeddingCfg,
    clustering: ClusteringCfg,
    min_duration_on: f32,
    min_duration_off: f32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Segment {
    start: f32,
    end: f32,
    speaker: i32,
    confidence: f32,
}

type Handle = *const c_void;

/// The sherpa-onnx C API calls diarization makes.
struct Sherpa {
    create: unsafe extern "C" fn(*const DiarizationCfg) -> Handle,
    destroy: unsafe extern "C" fn(Handle),
    sample_rate: unsafe extern "C" fn(Handle) -> i32,
    process: unsafe extern "C" fn(Handle, *const f32, i32) -> Handle,
    num_segments: unsafe extern "C" fn(Handle) -> i32,
    sort_by_start_time: unsafe extern "C" fn(Handle) -> *const Segment,
    destroy_segments: unsafe extern "C" fn(*const Segment),
    destroy_result: unsafe extern "C" fn(Handle),
}

/// The DLL's own folder, then System32 (`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`): sherpa's onnxruntime.dll
/// comes from beside it, whatever else is on the search path.
const LOAD_FLAGS: u32 = 0x0000_0100 | 0x0000_0800;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(file_name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn GetLastError() -> u32;
}

/// The export `name` of `module` as the function pointer type `F`.
///
/// # Safety
/// `F` must be the export's exact `extern "C"` function pointer type.
unsafe fn export<F: Copy>(module: *mut c_void, dll: &Path, name: &CStr) -> Result<F, Fail> {
    // SAFETY: `module` is a loaded module and `name` is NUL-terminated.
    let p = unsafe { GetProcAddress(module, name.as_ptr()) };
    if p.is_null() {
        return Err(Fail::new("OSError", format!("{} has no export {}", dll.display(), name.to_string_lossy())));
    }
    // SAFETY: the caller names the export's type; a function pointer has the size of a data pointer on Windows x64.
    Ok(unsafe { std::mem::transmute_copy::<*mut c_void, F>(&p) })
}

impl Sherpa {
    /// Loads `sherpa-onnx-c-api.dll` 2.0.1 from `dir` and looks up the diarization calls. The DLL stays loaded until exit.
    fn load(dir: &Path) -> Result<Sherpa, Fail> {
        let dll = std::path::absolute(dir.join("sherpa-onnx-c-api.dll")).map_err(|e| Fail::new("OSError", e))?;
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a NUL-terminated absolute path that outlives the call; the file handle must be null.
        let module = ortffi::without_error_dialogs(|| unsafe {
            LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_FLAGS)
        });
        if module.is_null() {
            // SAFETY: a thread-local error read right after the failed call.
            let code = unsafe { GetLastError() };
            return Err(Fail::new("OSError", format!("cannot load {} (Windows error {code})", dll.display())));
        }
        // SAFETY: each type below is the c-api.h prototype of the export it names.
        unsafe {
            let version: unsafe extern "C" fn() -> *const c_char = export(module, &dll, c"SherpaOnnxGetVersionStr")?;
            let found = CStr::from_ptr(version()).to_string_lossy().into_owned();
            if found != SHERPA_VERSION {
                return Err(Fail::new(
                    "OSError",
                    format!("{} is sherpa-onnx {found}, not {SHERPA_VERSION}", dll.display()),
                ));
            }
            Ok(Sherpa {
                create: export(module, &dll, c"SherpaOnnxCreateOfflineSpeakerDiarization")?,
                destroy: export(module, &dll, c"SherpaOnnxDestroyOfflineSpeakerDiarization")?,
                sample_rate: export(module, &dll, c"SherpaOnnxOfflineSpeakerDiarizationGetSampleRate")?,
                process: export(module, &dll, c"SherpaOnnxOfflineSpeakerDiarizationProcess")?,
                num_segments: export(module, &dll, c"SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments")?,
                sort_by_start_time: export(module, &dll, c"SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime")?,
                destroy_segments: export(module, &dll, c"SherpaOnnxOfflineSpeakerDiarizationDestroySegment")?,
                destroy_result: export(module, &dll, c"SherpaOnnxOfflineSpeakerDiarizationDestroyResult")?,
            })
        }
    }
}

fn model_file(model_dir: &Path, part: &str) -> PathBuf {
    model_dir.join(part).join("model.onnx")
}

fn c_path(path: &Path) -> Result<CString, Fail> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| Fail::new("ValueError", "embedded null character"))
}

/// `_turns`: one sherpa pipeline run (a new pipeline per call, as Python builds one), turns sorted by (start, end) with the
/// speakers numbered by first appearance.
fn turns(sherpa: &Sherpa, audio: &[f32], model_dir: &Path, num_clusters: Option<i64>) -> Result<Vec<Turn>, Fail> {
    let segmentation = c_path(&model_file(model_dir, "segmentation"))?;
    let embedding = c_path(&model_file(model_dir, "embedding"))?;
    let num_clusters = match num_clusters {
        Some(n) if n != 0 => i32::try_from(n).map_err(|_| Fail::new("TypeError", "incompatible function arguments"))?,
        _ => -1, // `num_clusters or -1`
    };
    // The binding's defaults for what diarize.py leaves out: window_shift_ratio 0.1, no confidence, no debug.
    let config = DiarizationCfg {
        segmentation: SegmentationCfg {
            pyannote: PyannoteCfg { model: segmentation.as_ptr(), window_shift_ratio: 0.1 },
            num_threads: 2,
            debug: 0,
            provider: c"cpu".as_ptr(),
        },
        embedding: EmbeddingCfg { model: embedding.as_ptr(), num_threads: 2, debug: 0, provider: c"cpu".as_ptr() },
        clustering: ClusteringCfg { num_clusters, threshold: CLUSTER_THRESHOLD, compute_confidence: 0 },
        min_duration_on: 0.3,
        min_duration_off: 0.5,
    };
    let n = i32::try_from(audio.len()).map_err(|_| Fail::new("ValueError", "too many samples"))?;
    // SAFETY: `config` and the strings it points to outlive the call.
    let sd = unsafe { (sherpa.create)(&config) };
    if sd.is_null() {
        return Err(Fail::new("RuntimeError", "sherpa-onnx could not create the speaker diarization pipeline"));
    }
    // SAFETY: `sd` is a live pipeline, destroyed once below; `audio` holds `n` floats; the result and its segment copy are
    // read within their counts and destroyed once.
    let mut out = unsafe {
        let rate = (sherpa.sample_rate)(sd);
        let result = if rate == SAMPLE_RATE { (sherpa.process)(sd, audio.as_ptr(), n) } else { std::ptr::null() };
        let mut out = Vec::new();
        if !result.is_null() {
            let count = usize::try_from((sherpa.num_segments)(result)).unwrap_or(0);
            let segments = if count > 0 { (sherpa.sort_by_start_time)(result) } else { std::ptr::null() };
            if !segments.is_null() {
                for s in std::slice::from_raw_parts(segments, count) {
                    out.push(Turn { start: f64::from(s.start), end: f64::from(s.end), speaker: i64::from(s.speaker) });
                }
                (sherpa.destroy_segments)(segments);
            }
            (sherpa.destroy_result)(result);
        }
        (sherpa.destroy)(sd);
        if rate != SAMPLE_RATE {
            return Err(Fail::new("RuntimeError", format!("Unexpected diarization sample rate {rate}")));
        }
        if result.is_null() {
            return Err(Fail::new("RuntimeError", "sherpa-onnx speaker diarization returned no result"));
        }
        out
    };
    // `sorted(..., key=lambda t: (t['start'], t['end']))`: stable, Python's float comparisons.
    out.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.end.partial_cmp(&b.end).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(renumber(out))
}

/// Speakers numbered 0.. by first appearance.
fn renumber(turns: Vec<Turn>) -> Vec<Turn> {
    let mut order: Vec<i64> = Vec::new();
    turns
        .into_iter()
        .map(|t| {
            let at = order.iter().position(|&s| s == t.speaker).unwrap_or_else(|| {
                order.push(t.speaker);
                order.len() - 1
            });
            Turn { speaker: at as i64, ..t }
        })
        .collect()
}

/// `speech_seconds`: each speaker's summed turn time, in first-appearance order (a dict in Python).
fn speech_seconds(turns: &[Turn]) -> Vec<(i64, f64)> {
    let mut total: Vec<(i64, f64)> = Vec::new();
    for t in turns {
        let at = total.iter().position(|&(s, _)| s == t.speaker).unwrap_or_else(|| {
            total.push((t.speaker, 0.0));
            total.len() - 1
        });
        total[at].1 = total[at].1 + t.end - t.start; // `total.get(s, 0.0) + end - start`, left to right
    }
    total
}

/// `real_speakers`: how many speakers hold at least `share` of the speech (Python 3.11's `sum`: plain left-to-right adds).
fn real_speakers(turns: &[Turn], share: f64) -> usize {
    let total = speech_seconds(turns);
    let sum = total.iter().fold(0.0, |acc, &(_, v)| acc + v);
    total.iter().filter(|&&(_, v)| v >= share * sum).count()
}

/// `keep_speakers`: the turns of the `count` speakers with the most speech (ties: lower id), renumbered by first appearance.
fn keep_speakers(turns: &[Turn], count: usize) -> Vec<Turn> {
    let mut ranked = speech_seconds(turns);
    ranked.sort_by(|a, b| (-a.1).partial_cmp(&-b.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let kept: Vec<i64> = ranked.iter().take(count).map(|&(s, _)| s).collect();
    renumber(turns.iter().filter(|t| kept.contains(&t.speaker)).copied().collect())
}

fn drop_small_speakers(turns: &[Turn]) -> Vec<Turn> {
    keep_speakers(turns, real_speakers(turns, MIN_AUTO_SHARE).max(1))
}

fn distinct(turns: &[Turn]) -> usize {
    let mut seen: Vec<i64> = turns.iter().map(|t| t.speaker).collect();
    seen.sort_unstable();
    seen.dedup();
    seen.len()
}

/// `_known`: cluster into `n` (asking for up to two more clusters until `n` real speakers appear), keep the `n` who speak most;
/// on a collapse to one speaker, the threshold cut if it holds more.
fn known(
    sherpa: &Sherpa,
    audio: &[f32],
    model_dir: &Path,
    n: i64,
    threshold_cut: Option<&[Turn]>,
) -> Result<Vec<Turn>, Fail> {
    let mut result = Vec::new();
    let mut reached = false;
    for extra in 0..3 {
        result = turns(sherpa, audio, model_dir, Some(n + extra))?;
        if real_speakers(&result, MIN_SPEAKER_SHARE) as i64 >= n {
            reached = true;
            break;
        }
    }
    if !reached && real_speakers(&result, MIN_SPEAKER_SHARE) == 1 {
        let cut = match threshold_cut {
            Some(cut) => cut.to_vec(),
            None => turns(sherpa, audio, model_dir, None)?,
        };
        if real_speakers(&cut, MIN_SPEAKER_SHARE) > 1 {
            result = cut;
        }
    }
    Ok(keep_speakers(&result, usize::try_from(n).unwrap_or(0)))
}

/// `_check`, before sherpa is loaded (Python imports it in `_turns`).
fn check(audio: &[f32], model_dir: &Path, num: Option<i64>, min: Option<i64>, max: Option<i64>) -> Result<(), Fail> {
    if audio.is_empty() || !audio.iter().all(|v| v.is_finite()) {
        return Err(Fail::new("ValueError", "audio_16k must be a non-empty finite mono float array"));
    }
    if [num, min, max].into_iter().flatten().any(|n| n < 1) {
        return Err(Fail::new("ValueError", "speaker counts must be at least 1"));
    }
    if let (Some(low), Some(high)) = (min, max) {
        if low > high {
            return Err(Fail::new("ValueError", "min_speakers must not exceed max_speakers"));
        }
    }
    if num.is_some() && (min.is_some() || max.is_some()) {
        return Err(Fail::new("ValueError", "num_speakers cannot be combined with min_speakers or max_speakers"));
    }
    for part in ["segmentation", "embedding"] {
        let file = model_file(model_dir, part);
        if !file.is_file() {
            return Err(Fail::new("FileNotFoundError", format!("Diarization model file missing: {}", file.display())));
        }
    }
    Ok(())
}

/// `diarize()`: turns `[{start, end, speaker}]` sorted by start, speakers numbered by first appearance.
fn diarize(
    sherpa_dir: &Path,
    audio: &[f32],
    model_dir: &Path,
    num: Option<i64>,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<Vec<Turn>, Fail> {
    check(audio, model_dir, num, min, max)?;
    let sherpa = Sherpa::load(sherpa_dir)?;
    let (mut num, mut threshold_cut) = (num, None);
    if num.is_none() {
        let cut = turns(&sherpa, audio, model_dir, None)?;
        if cut.is_empty() {
            return Ok(cut);
        }
        let found = real_speakers(&cut, MIN_SPEAKER_SHARE).max(1);
        let picked = if found == distinct(&cut) {
            cut.clone()
        } else {
            known(&sherpa, audio, model_dir, found as i64, Some(&cut[..]))?
        };
        let picked = drop_small_speakers(&picked);
        let count = distinct(&picked) as i64;
        let mut n = count.max(min.filter(|&m| m != 0).unwrap_or(1)); // `max(count, min_speakers or 1)`
        if let Some(high) = max.filter(|&m| m != 0) {
            n = n.min(high);
        }
        if n == count {
            return Ok(picked);
        }
        (num, threshold_cut) = (Some(n), Some(cut));
    }
    known(&sherpa, audio, model_dir, num.unwrap_or(1), threshold_cut.as_deref())
}

/// A 1-D little-endian float32 array as `np.save` writes it.
fn read_npy(path: &Path) -> Result<Vec<f32>, Fail> {
    let bytes = std::fs::read(path).map_err(|e| Fail::new("OSError", e))?;
    let bad = || Fail::new("ValueError", format!("{} is not a 1-D float32 .npy array", path.display()));
    if bytes.len() < 12 || &bytes[..6] != b"\x93NUMPY" {
        return Err(bad());
    }
    let (len, start) = match bytes[6] {
        1 => (usize::from(u16::from_le_bytes([bytes[8], bytes[9]])), 10),
        2 | 3 => (u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize, 12),
        _ => return Err(bad()),
    };
    let header = bytes.get(start..start + len).and_then(|h| std::str::from_utf8(h).ok()).ok_or_else(bad)?;
    let shape = header.split("'shape': (").nth(1).and_then(|s| s.split(')').next()).ok_or_else(bad)?;
    let n: usize = shape.strip_suffix(',').and_then(|s| s.trim().parse().ok()).ok_or_else(bad)?;
    if !header.contains("'descr': '<f4'") || !header.contains("'fortran_order': False") {
        return Err(bad());
    }
    let data = &bytes[start + len..];
    if data.len() != n * 4 {
        return Err(bad());
    }
    Ok(data.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

/// `json.loads(argv[3])`: `[model_dir, num_speakers, min_speakers, max_speakers]`, the counts optional.
fn parse_spec(spec: &str) -> Result<(PathBuf, [Option<i64>; 3]), Fail> {
    let bad = || Fail::new("ValueError", format!("bad diarization arguments: {spec}"));
    let value: Value = serde_json::from_str(spec).map_err(|_| bad())?;
    let items = value.as_array().filter(|a| (1..=4).contains(&a.len())).ok_or_else(bad)?;
    let model = items[0].as_str().ok_or_else(bad)?;
    let mut counts = [None; 3];
    for (slot, item) in counts.iter_mut().zip(&items[1..]) {
        *slot = match item {
            Value::Null => None,
            other => Some(other.as_i64().ok_or_else(bad)?),
        };
    }
    Ok((PathBuf::from(model), counts))
}

fn run(args: &[OsString]) -> Result<(), Fail> {
    let (Some(audio), Some(turns_path), Some(spec)) = (args.get(1), args.get(2), args.get(3)) else {
        return Err(Fail::new("IndexError", "list index out of range"));
    };
    let audio = read_npy(Path::new(audio))?;
    let (model_dir, [num, min, max]) = parse_spec(&spec.to_string_lossy())?;
    let sherpa_dir =
        std::env::var_os("THANHAM_SHERPA_LIB").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| {
            std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_default()
        });
    let turns = diarize(&sherpa_dir, &audio, &model_dir, num, min, max)?;
    let out: Vec<Value> = turns.iter().map(|t| json!({"start": t.start, "end": t.end, "speaker": t.speaker})).collect();
    std::fs::write(turns_path, Value::Array(out).to_string()).map_err(|e| Fail::new("OSError", e))
}

fn main() {
    // Test hook, as diarize.py's: die with this exit code, as a native crash does.
    let crash = std::env::var("THANHAM_DIARIZE_CRASH").ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    if crash != 0 {
        std::process::exit(crash as u32 as i32);
    }
    let args: Vec<OsString> = std::env::args_os().collect();
    if let Err(Fail(message)) = run(&args) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(v: &Value) -> Turn {
        Turn {
            start: v["start"].as_f64().unwrap(),
            end: v["end"].as_f64().unwrap(),
            speaker: v["speaker"].as_i64().unwrap(),
        }
    }

    fn turns_of(v: &Value) -> Vec<Turn> {
        v.as_array().unwrap().iter().map(turn).collect()
    }

    /// The speaker-count rules against diarize.py on parity/stt/diarize.json (`diarize_cases.py`), bit for bit.
    #[test]
    fn counts_match_python() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../parity/stt/diarize.json");
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = cases["counts"].as_array().unwrap();
        for (i, case) in cases.iter().enumerate() {
            let ts = turns_of(&case["turns"]);
            assert_eq!(real_speakers(&ts, MIN_SPEAKER_SHARE) as u64, case["real"].as_u64().unwrap(), "case {i} real");
            assert_eq!(
                real_speakers(&ts, MIN_AUTO_SHARE) as u64,
                case["real_auto"].as_u64().unwrap(),
                "case {i} real_auto"
            );
            let k = case["k"].as_u64().unwrap() as usize;
            assert_eq!(keep_speakers(&ts, k), turns_of(&case["keep"]), "case {i} keep");
            assert_eq!(drop_small_speakers(&ts), turns_of(&case["drop"]), "case {i} drop");
        }
        assert_eq!(cases.len(), 300);
    }

    #[test]
    fn npy_and_arguments() {
        let dir = std::env::temp_dir().join(format!("thanham-diarize-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // np.save(path, np.array([0.5, -1.0, 3.25], dtype=np.float32)), byte for byte.
        let mut header = "{'descr': '<f4', 'fortran_order': False, 'shape': (3,), }".to_string();
        header.push_str(&" ".repeat((64 - (10 + header.len() + 1) % 64) % 64));
        header.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend_from_slice(&(header.len() as u16).to_le_bytes());
        bytes.extend_from_slice(header.as_bytes());
        for v in [0.5f32, -1.0, 3.25] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let path = dir.join("audio.npy");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(read_npy(&path).unwrap(), vec![0.5, -1.0, 3.25]);
        std::fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
        assert!(read_npy(&path).is_err());
        std::fs::remove_dir_all(&dir).unwrap();

        let (model, counts) = parse_spec(r#"["C:\\m\\diarization", null, 2, 3]"#).unwrap();
        assert_eq!((model, counts), (PathBuf::from(r"C:\m\diarization"), [None, Some(2), Some(3)]));
        assert_eq!(parse_spec(r#"["m"]"#).unwrap().1, [None, None, None]);
        assert!(parse_spec(r#"["m", 2.5]"#).is_err());
        assert_eq!(
            check(&[0.1, f32::NAN], Path::new("m"), None, None, None).unwrap_err().0.as_str(),
            "ValueError: audio_16k must be a non-empty finite mono float array"
        );
        assert_eq!(
            check(&[0.1], Path::new("m"), None, Some(3), Some(2)).unwrap_err().0.as_str(),
            "ValueError: min_speakers must not exceed max_speakers"
        );
    }

    /// The wheel's sherpa-onnx loads and is 2.0.1: `THANHAM_SHERPA_LIB` names its `sherpa_onnx\lib` folder (skipped when unset).
    #[test]
    fn loads_the_wheels_sherpa() {
        let Some(dir) = std::env::var_os("THANHAM_SHERPA_LIB") else {
            eprintln!("THANHAM_SHERPA_LIB not set: skipped");
            return;
        };
        Sherpa::load(Path::new(&dir)).unwrap();
        assert!(Sherpa::load(Path::new("no-such-folder")).is_err());
    }
}
