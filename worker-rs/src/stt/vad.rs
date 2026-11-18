//! The VAD of faster-whisper 1.2.1 (`vad.py`) as `transcribe(..., vad_filter=True)` runs it: `get_speech_timestamps(audio,
//! VadOptions())` over its Silero v6 model, through the runtime's ONNX Runtime with `SileroVADModel`'s session options (row F checks
//! that this FFI gives Python's ORT outputs bitwise). The model is the runtime's own asset, checked against its SHA-256; a missing or
//! different file is `RUNTIME_MISSING`.

use crate::error::{Result, WorkerError};
use ortffi::{Env, Session, SessionOptions, Value};
use std::path::Path;

/// SHA-256 of faster-whisper 1.2.1's `assets/silero_vad_v6.onnx`.
const SILERO_SHA256: &str = "4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2";
const WINDOW: usize = 512;
const CONTEXT: usize = 64;
const BATCH: usize = 10000;

/// `get_vad_model()`: one session per process.
pub struct Vad {
    env: Env,
    session: Session,
}

impl Vad {
    /// `SileroVADModel(path)`: inter and intra op threads 1, no CPU memory arena, log severity 4.
    pub fn load(site_packages: &Path) -> Result<Vad> {
        use sha2::{Digest, Sha256};
        let model = site_packages.join("faster_whisper").join("assets").join("silero_vad_v6.onnx");
        let missing = |m: String| WorkerError::new("RUNTIME_MISSING", m);
        let bytes = std::fs::read(&model).map_err(|e| missing(format!("cannot read {}: {e}", model.display())))?;
        let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if hex != SILERO_SHA256 {
            return Err(missing(format!("{} has SHA-256 {hex}, expected {SILERO_SHA256}", model.display())));
        }
        let env = Env::load(&crate::health::ort_dll_path(), "thanham-stt")?;
        let mut options = SessionOptions::new(&env)?;
        options.inter_op_threads(1)?.intra_op_threads(1)?.cpu_mem_arena(false)?.log_severity_level(4)?;
        let session = Session::from_file(&env, &model, &options)?;
        Ok(Vad { env, session })
    }

    /// `model(np.pad(audio, (0, 512 - len % 512)))`: the speech probability of every 512-sample window, each run with the 64
    /// samples before it, in batches of 10000 windows that carry the LSTM state.
    fn probabilities(&self, audio: &[f32]) -> Result<Vec<f32>> {
        let windows = audio.len() / WINDOW + 1;
        let mut padded = vec![0f32; windows * WINDOW];
        padded[..audio.len()].copy_from_slice(audio);
        // `context = batched_audio[..., -64:]; context[-1] = 0` writes through the view: the last window loses its last 64 samples.
        let end = padded.len();
        padded[end - CONTEXT..].fill(0.0);
        let row = CONTEXT + WINDOW;
        let mut rows = vec![0f32; windows * row];
        for i in 0..windows {
            if i > 0 {
                rows[i * row..i * row + CONTEXT].copy_from_slice(&padded[i * WINDOW - CONTEXT..i * WINDOW]);
            }
            rows[i * row + CONTEXT..(i + 1) * row].copy_from_slice(&padded[i * WINDOW..(i + 1) * WINDOW]);
        }
        let zeros = [0f32; 128];
        let mut h: Value<'_> = self.env.tensor(&zeros, &[1, 1, 128])?;
        let mut c: Value<'_> = self.env.tensor(&zeros, &[1, 1, 128])?;
        let mut probs = Vec::with_capacity(windows);
        for start in (0..windows).step_by(BATCH) {
            let n = (windows - start).min(BATCH);
            let input = self.env.tensor(&rows[start * row..(start + n) * row], &[n as i64, row as i64])?;
            let mut out =
                self.session.run(&[("input", &input), ("h", &h), ("c", &c)], &["speech_probs", "hn", "cn"])?;
            probs.extend_from_slice(out[0].as_slice::<f32>()?);
            c = out.pop().expect("cn");
            h = out.pop().expect("hn");
        }
        Ok(probs)
    }

    /// `get_speech_timestamps(audio, VadOptions())`: (start, end) sample pairs of the speech chunks.
    pub fn speech_timestamps(&self, audio: &[f32]) -> Result<Vec<(i64, i64)>> {
        Ok(speech_chunks(&self.probabilities(audio)?, audio.len() as i64))
    }
}

/// The chunking of `get_speech_timestamps` with `VadOptions()`: threshold 0.5, neg_threshold `max(0.5 - 0.15, 0.01)`, no minimum
/// speech length, 2000 ms minimum silence, 400 ms padding. numpy compares the float32 probabilities with the thresholds in float32.
/// `max_speech_duration_s` is infinite, so the split-at-maximum branch (and its prev_end / next_start bookkeeping) never runs.
fn speech_chunks(probs: &[f32], audio_len: i64) -> Vec<(i64, i64)> {
    let threshold = 0.5f32;
    let neg_threshold = (0.5f64 - 0.15).max(0.01) as f32;
    let (min_silence, pad) = (32000.0f64, 6400.0f64);
    let mut speeches: Vec<(i64, i64)> = Vec::new();
    let mut start: Option<i64> = None;
    let mut temp_end = 0i64;
    for (i, &p) in probs.iter().enumerate() {
        let at = (WINDOW * i) as i64;
        if p >= threshold && temp_end != 0 {
            temp_end = 0;
        }
        let Some(s) = start else {
            if p >= threshold {
                start = Some(at);
            }
            continue;
        };
        if p < neg_threshold {
            if temp_end == 0 {
                temp_end = at;
            }
            if ((at - temp_end) as f64) < min_silence {
                continue;
            }
            if (temp_end - s) as f64 > 0.0 {
                speeches.push((s, temp_end));
            }
            start = None;
            temp_end = 0;
        }
    }
    if let Some(s) = start {
        if (audio_len - s) as f64 > 0.0 {
            speeches.push((s, audio_len));
        }
    }
    let last = speeches.len().saturating_sub(1);
    for i in 0..speeches.len() {
        if i == 0 {
            speeches[0].0 = (speeches[0].0 as f64 - pad).max(0.0) as i64;
        }
        if i != last {
            let silence = speeches[i + 1].0 - speeches[i].1;
            if (silence as f64) < 2.0 * pad {
                speeches[i].1 += silence.div_euclid(2);
                speeches[i + 1].0 = (speeches[i + 1].0 - silence.div_euclid(2)).max(0);
            } else {
                speeches[i].1 = ((speeches[i].1 as f64 + pad).min(audio_len as f64)) as i64;
                speeches[i + 1].0 = ((speeches[i + 1].0 as f64 - pad).max(0.0)) as i64;
            }
        } else {
            speeches[i].1 = ((speeches[i].1 as f64 + pad).min(audio_len as f64)) as i64;
        }
    }
    speeches
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value as Json};
    use sha2::{Digest, Sha256};

    #[test]
    fn chunking_follows_get_speech_timestamps() {
        // 2 s of silence (< 2000 ms of silence keeps one chunk), then speech to the end; padding clamps at 0 and at the length.
        let p = |v: &[(usize, f32)]| v.iter().flat_map(|&(n, x)| std::iter::repeat_n(x, n)).collect::<Vec<f32>>();
        assert_eq!(speech_chunks(&p(&[(3, 0.9), (10, 0.1), (5, 0.9)]), 9000), vec![(0, 9000)]);
        // A silence of 63 windows (32256 samples >= 32000) ends the chunk at its first quiet window.
        let probs = p(&[(2, 0.1), (4, 0.9), (64, 0.1), (4, 0.9), (2, 0.1)]);
        assert_eq!(speech_chunks(&probs, 76 * 512), vec![(0, 3072 + 6400), (35840 - 6400, 76 * 512)]);
        // A probability equal to float32(0.35) is not below neg_threshold (float32 comparison).
        assert_eq!(speech_chunks(&p(&[(1, 0.9), (70, 0.35)]), 71 * 512), vec![(0, 71 * 512)]);
        assert!(speech_chunks(&[0.1; 10], 5120).is_empty());
    }

    /// Every decode case with a `vad` record (`decode_cases.py --vad`): the probabilities bitwise (their SHA-256) and the chunks equal.
    #[test]
    fn vad_matches_python() {
        let Some(cases) = std::env::var_os("THANHAM_DECODE_CASES") else {
            eprintln!("THANHAM_DECODE_CASES not set: skipped");
            return;
        };
        let sp = Path::new(&std::env::var_os("THANHAM_PYTHON").expect("THANHAM_PYTHON"))
            .parent()
            .unwrap()
            .join("Lib\\site-packages");
        // The worker reads onnxruntime.dll beside its exe, as scripts/stage-worker.ps1 lays it out.
        let here = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        std::fs::copy(sp.join("onnxruntime").join("capi").join("onnxruntime.dll"), here.join("onnxruntime.dll"))
            .unwrap();
        let vad = Vad::load(&sp).unwrap();
        let (mut same, mut differ) = (0, Vec::new());
        for line in std::fs::read_to_string(cases).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let case: Json = serde_json::from_str(line).unwrap();
            let Some(want) = case.get("vad") else { continue };
            let path = case["path"].as_str().unwrap();
            let audio = crate::stt::decode::decode_audio(&sp, path).unwrap();
            let probs = vad.probabilities(&audio).unwrap();
            let bytes: Vec<u8> = probs.iter().flat_map(|v| v.to_le_bytes()).collect();
            let chunks: Vec<[i64; 2]> =
                speech_chunks(&probs, audio.len() as i64).into_iter().map(|(s, e)| [s, e]).collect();
            let got = json!({"windows": probs.len(), "probs_sha256": Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>(), "speeches": chunks});
            if &got == want {
                same += 1;
            } else {
                differ.push(format!("{path}: Rust {got} Python {want}"));
            }
        }
        println!("VAD: {same} identical, {} differ", differ.len());
        assert!(differ.is_empty(), "{}", differ.join("\n"));
        assert!(same > 0);
    }
}
