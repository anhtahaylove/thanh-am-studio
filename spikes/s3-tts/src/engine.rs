//! The VieNeu v3 Turbo ONNX engine for preset voices: `OnnxV3LiteEngine.infer` (`onnx_runtime_lite.py:381`) and the wrapper's per-chunk
//! loop and join (`vieneu/v3turbo.py:542,600`), with ONNX Runtime through `ortffi` and the numpy head from [`crate::head`].

use crate::audio::{self, Babble};
use crate::blas::OpenBlas;
use crate::front::Front;
use crate::head::{sample, ChannelWindow, Params, Weights, AUDIO_VOCAB, HIDDEN, N_VQ};
use crate::mt19937::Mt19937;
use crate::np;
use ortffi::{Env, ExecutionMode, GraphOptimizationLevel, Session, SessionOptions, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Preset sampling temperature of the worker (`PRESET_TEMPERATURE`).
pub const PRESET_TEMPERATURE: f64 = 0.5;
const TOP_K: usize = 25;
const TOP_P: f64 = 0.95;
const REP_PEN: f64 = 1.2;
const REP_WINDOW: usize = 64;
const MAX_NEW_FRAMES: usize = 300;

/// Error with a worker code.
#[derive(Debug)]
pub struct EngineError {
    /// `WorkerError` code (`RUNTIME_MISSING`, `WORKER_ERROR`, `INVALID_AUDIO`...).
    pub code: &'static str,
    /// Message.
    pub message: String,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

fn werr<E: std::fmt::Display>(code: &'static str) -> impl FnOnce(E) -> EngineError {
    move |e| EngineError { code, message: e.to_string() }
}

type Res<T> = Result<T, EngineError>;

/// Files the engine needs (paths in the installed model folders).
pub struct Paths {
    /// `onnxruntime.dll` 1.31.1.
    pub ort_dll: PathBuf,
    /// numpy's OpenBLAS DLL.
    pub openblas_dll: PathBuf,
    /// `...\vieneu-v3\backbone\onnx_update`.
    pub onnx_dir: PathBuf,
    /// `...\vieneu-v3\codec`.
    pub codec_dir: PathBuf,
    /// `sea_g2p.bin`.
    pub sea_g2p_bin: PathBuf,
    /// `vieneu\assets\voices_v3_turbo.json`.
    pub voices_json: PathBuf,
}

/// A preset voice.
pub struct Voice {
    /// 192-d speaker embedding.
    pub speaker_emb: Vec<f32>,
    /// Reference codes `(T, 16)` row-major, encoder pad frame stripped.
    pub codes: Option<Vec<i64>>,
}

struct Ids {
    audio_pad: i64,
    tps: i64,
    tpe: i64,
    sgs: i64,
    eos_speech: i64,
    ref_slot: i64,
    default_style: i64,
    layers: usize,
    local_heads: usize,
    local_head_dim: usize,
}

/// The loaded engine.
pub struct Engine {
    blas: OpenBlas,
    weights: Weights,
    front: Front,
    env: Env,
    sess_pre: Session,
    sess_dec: Session,
    sess_ac: Session,
    sess_codec: Session,
    ids: Ids,
    voices: HashMap<String, Voice>,
    aliases: HashMap<String, String>,
    default_voice: Option<String>,
    names_pre: Vec<String>,
    names_dec: Vec<String>,
    names_ac: Vec<String>,
    names_codec: Vec<String>,
}

/// Where the draws come from: the legacy global stream (production, entropy-seeded) or a reseed before every engine call
/// (`THANHAM_TTS_SEED`, the P-op/P0-A harness hook: `np.random.seed(crc32(seed|output_name|call))`).
pub enum Draws {
    /// One process-wide stream.
    Global(Mt19937),
    /// Re-seeded before each chunk call from this decimal seed string.
    Seeded(String),
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

impl Draws {
    /// From `THANHAM_TTS_SEED` when set, else a stream seeded from OS entropy (what numpy does at its first use).
    pub fn from_env() -> Draws {
        match std::env::var("THANHAM_TTS_SEED") {
            Ok(s) if !s.is_empty() => Draws::Seeded(s),
            _ => {
                use std::hash::{BuildHasher, Hasher};
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                h.write_u8(0);
                Draws::Global(Mt19937::seed(h.finish() as u32))
            }
        }
    }

    fn rng_for_call(&mut self, output_name: &str, call: usize) -> Option<Mt19937> {
        match self {
            Draws::Global(_) => None,
            Draws::Seeded(seed) => Some(Mt19937::seed(crc32(format!("{seed}|{output_name}|{call}").as_bytes()))),
        }
    }
}

impl Engine {
    /// Loads everything, mirroring `Vieneu(backend='onnx', ..., threads=min(8, cpu_count))` and its session options.
    pub fn load(p: &Paths) -> Res<Engine> {
        let blas = OpenBlas::load_pinned(&p.openblas_dll).map_err(werr("RUNTIME_MISSING"))?;
        let env = Env::load(&p.ort_dll, "s3-tts").map_err(|e| EngineError { code: e.worker_code(), message: e.to_string() })?;
        let cfg: serde_json::Value = serde_json::from_slice(&std::fs::read(p.onnx_dir.join("config.json")).map_err(werr("WORKER_ERROR"))?)
            .map_err(werr("WORKER_ERROR"))?;
        let gi = |k: &str| cfg[k].as_i64().ok_or_else(|| EngineError { code: "WORKER_ERROR", message: format!("config.json: {k}") });
        let ids = Ids {
            audio_pad: gi("audio_pad_token_id")?,
            tps: gi("text_prompt_start_token_id")?,
            tpe: gi("text_prompt_end_token_id")?,
            sgs: gi("speech_generation_start_token_id")?,
            eos_speech: gi("speech_generation_end_token_id")?,
            ref_slot: gi("audio_ref_slot_token_id")?,
            default_style: cfg["default_style_token_id"].as_i64().unwrap_or(16),
            layers: gi("num_hidden_layers")? as usize,
            local_heads: cfg["local_num_attention_heads"].as_i64().unwrap_or(8) as usize,
            local_head_dim: HIDDEN / cfg["local_num_attention_heads"].as_i64().unwrap_or(8) as usize,
        };
        let weights = Weights::load(&p.onnx_dir.join("vieneu_v3_heads.npz")).map_err(werr("WORKER_ERROR"))?;
        let front = Front::load(&p.sea_g2p_bin, &p.onnx_dir.join("tokenizer.json")).map_err(|m| EngineError { code: "WORKER_ERROR", message: m })?;

        // threads=min(8, cpu_count) is passed by the worker; inter_op 1; allow_spinning 0; ORT_ENABLE_ALL.
        let cpus = std::thread::available_parallelism().map_or(4, |n| n.get());
        let mut so = SessionOptions::new(&env).map_err(werr("WORKER_ERROR"))?;
        so.graph_optimization_level(GraphOptimizationLevel::All)
            .and_then(|s| s.inter_op_threads(1))
            .and_then(|s| s.config_entry("session.intra_op.allow_spinning", "0"))
            .and_then(|s| s.intra_op_threads(cpus.min(8) as i32))
            .and_then(|s| s.execution_mode(ExecutionMode::Sequential))
            .map_err(werr("WORKER_ERROR"))?;
        let open = |path: PathBuf| Session::from_file(&env, &path, &so).map_err(werr("WORKER_ERROR"));
        let sess_pre = open(p.onnx_dir.join("vieneu_prefill.onnx"))?;
        let sess_dec = open(p.onnx_dir.join("vieneu_decode_step.onnx"))?;
        let sess_ac = open(p.onnx_dir.join("vieneu_acoustic_cached.onnx"))?;
        let sess_codec = open(p.codec_dir.join("moss_audio_tokenizer_decode_full.onnx"))?;
        let names = |s: &Session| s.outputs().iter().map(|o| o.name.clone()).collect::<Vec<_>>();
        let (voices, aliases, default_voice) = load_voices(&p.voices_json)?;
        Ok(Engine {
            names_pre: names(&sess_pre),
            names_dec: names(&sess_dec),
            names_ac: names(&sess_ac),
            names_codec: names(&sess_codec),
            blas,
            weights,
            front,
            env,
            sess_pre,
            sess_dec,
            sess_ac,
            sess_codec,
            ids,
            voices,
            aliases,
            default_voice,
        })
    }

    /// The front end (phonemes and token ids).
    pub fn front(&self) -> &Front {
        &self.front
    }

    /// `resolve_voice_name`, falling back to the default voice for `None`.
    pub fn voice(&self, name: Option<&str>) -> Res<&Voice> {
        let want = name.map(str::to_string).or_else(|| self.default_voice.clone());
        let key = want.as_deref().and_then(|n| {
            if self.voices.contains_key(n) {
                Some(n.to_string())
            } else {
                self.aliases.get(n).filter(|t| self.voices.contains_key(*t)).cloned()
            }
        });
        key.and_then(|k| self.voices.get(&k)).ok_or_else(|| EngineError {
            code: "WORKER_ERROR",
            message: format!("ValueError: Voice '{}' not found.", want.unwrap_or_default()),
        })
    }

    /// `_speaker_anchor`.
    fn anchor(&self, speaker_emb: &[f32]) -> Res<Vec<f32>> {
        if !speaker_emb.iter().any(|&x| x != 0.0) {
            return Err(EngineError { code: "WORKER_ERROR", message: "ValueError: speaker_emb is all-zero".into() });
        }
        Ok(self.weights.speaker_anchor(&self.blas, speaker_emb).0)
    }

    /// `_embed_rows(rows, anchor)` for `rows` of `n_vq + 1` ids each, flattened row-major.
    fn embed_rows(&self, rows: &[i64], anchor: &[f32]) -> Vec<f32> {
        let t = rows.len() / (N_VQ + 1);
        let mut out = vec![0.0f32; t * HIDDEN];
        for r in 0..t {
            let row = &rows[r * (N_VQ + 1)..(r + 1) * (N_VQ + 1)];
            let dst = &mut out[r * HIDDEN..(r + 1) * HIDDEN];
            dst.copy_from_slice(&self.weights.text_emb[row[0] as usize * HIDDEN..(row[0] as usize + 1) * HIDDEN]);
            for ch in 0..N_VQ {
                let id = row[ch + 1];
                let valid = if id != self.ids.audio_pad { 1.0f32 } else { 0.0 };
                let safe = if id != self.ids.audio_pad { id as usize } else { 0 };
                let base = (ch * AUDIO_VOCAB + safe) * HIDDEN;
                for (d, e) in dst.iter_mut().zip(&self.weights.audio_emb[base..base + HIDDEN]) {
                    *d += e * valid;
                }
            }
            for (d, a) in dst.iter_mut().zip(anchor) {
                *d += a;
            }
        }
        out
    }

    /// `_build_rows`.
    fn build_rows(&self, phoneme_ids: &[i64], ref_codes: Option<&[i64]>) -> Vec<i64> {
        let mut text_ids = vec![self.ids.default_style, self.ids.tps];
        text_ids.extend_from_slice(phoneme_ids);
        text_ids.push(self.ids.tpe);
        let mut rows = Vec::new();
        for &id in &text_ids {
            rows.push(id);
            rows.extend(std::iter::repeat(self.ids.audio_pad).take(N_VQ));
        }
        if let Some(rc) = ref_codes {
            for frame in rc.chunks_exact(N_VQ) {
                rows.push(self.ids.ref_slot);
                rows.extend_from_slice(frame);
            }
        }
        rows
    }

    fn ort<T>(&self, r: Result<T, ortffi::Error>) -> Res<T> {
        r.map_err(|e| EngineError { code: e.worker_code(), message: e.to_string() })
    }

    /// `_acoustic_frame`: the 16 codes of one frame and the end-of-speech decision.
    fn acoustic_frame(&self, h: &[f32], p: &Params, hist: &mut [ChannelWindow], rng: &mut Mt19937) -> Res<(Vec<i64>, bool)> {
        let ids = &self.ids;
        let txt = &self.weights.text_emb[ids.sgs as usize * HIDDEN..(ids.sgs as usize + 1) * HIDDEN];
        let mut tok = h.to_vec();
        tok.extend_from_slice(txt);
        let pos = [0i64, 1];
        let empty: Vec<f32> = Vec::new();
        let past_shape = [1, ids.local_heads as i64, 0, ids.local_head_dim as i64];
        let tok_v = self.ort(self.env.tensor(&tok, &[1, 2, HIDDEN as i64]))?;
        let pos_v = self.ort(self.env.tensor(&pos, &[1, 2]))?;
        let pk0 = self.ort(self.env.tensor(&empty, &past_shape))?;
        let pv0 = self.ort(self.env.tensor(&empty, &past_shape))?;
        let outs: Vec<&str> = self.names_ac.iter().map(String::as_str).collect();
        let mut out = self.ort(self.sess_ac.run(
            &[("token_emb", &tok_v), ("position_ids", &pos_v), ("past_k_0", &pk0), ("past_v_0", &pv0)],
            &outs,
        ))?;
        let hidden: Vec<f32> = self.ort(out[0].to_vec::<f32>())?;
        let slot0 = hidden[..HIDDEN].to_vec();
        let mut vec = hidden[HIDDEN..2 * HIDDEN].to_vec();
        let mut codes: Vec<i64> = Vec::with_capacity(N_VQ);
        for ch in 0..N_VQ {
            if ch > 0 {
                let last = codes[ch - 1] as usize;
                let base = ((ch - 1) * AUDIO_VOCAB + last) * HIDDEN;
                let emb = self.weights.audio_emb[base..base + HIDDEN].to_vec();
                let pos = [(ch + 1) as i64];
                let emb_v = self.ort(self.env.tensor(&emb, &[1, 1, HIDDEN as i64]))?;
                let pos_v = self.ort(self.env.tensor(&pos, &[1, 1]))?;
                let next = self.ort(self.sess_ac.run(
                    &[("token_emb", &emb_v), ("position_ids", &pos_v), ("past_k_0", &out[1]), ("past_v_0", &out[2])],
                    &outs,
                ))?;
                out = next;
                vec = self.ort(out[0].to_vec::<f32>())?[..HIDDEN].to_vec();
            }
            let logits = self.weights.audio_logits(&self.blas, ch, &vec);
            let (code, _) = sample(&logits, p, &hist[ch], rng);
            hist[ch].add(code);
            codes.push(code as i64);
        }
        let text_logits = self.weights.text_logits(&self.blas, &slot0);
        let eos = np::argmax(&text_logits) as i64 == ids.eos_speech;
        Ok((codes, eos))
    }

    /// `_gen_once`: the frames of one generation.
    fn gen_once(&self, prompt: &[f32], anchor: &[f32], p: &Params, max_frames: usize, rng: &mut Mt19937) -> Res<Vec<Vec<i64>>> {
        let ids = &self.ids;
        let t_prompt = prompt.len() / HIDDEN;
        let prompt_v = self.ort(self.env.tensor(prompt, &[1, t_prompt as i64, HIDDEN as i64]))?;
        let outs_pre: Vec<&str> = self.names_pre.iter().map(String::as_str).collect();
        let mut pre = self.ort(self.sess_pre.run(&[("inputs_embeds", &prompt_v)], &outs_pre))?;
        let hid: Vec<f32> = self.ort(pre[0].to_vec::<f32>())?;
        let mut h = hid[(t_prompt - 1) * HIDDEN..t_prompt * HIDDEN].to_vec();
        // pre[1..1+L] present keys, pre[1+L..1+2L] present values
        let mut past: Vec<Value<'static>> = pre.drain(1..1 + 2 * ids.layers).collect();
        let mut hist: Vec<ChannelWindow> = (0..N_VQ).map(|_| ChannelWindow::new(REP_WINDOW)).collect();
        let mut frames = Vec::new();
        let names_dec: Vec<String> = (0..ids.layers).flat_map(|i| [format!("past_k_{i}"), format!("past_v_{i}")]).collect();
        let outs_dec: Vec<&str> = self.names_dec.iter().map(String::as_str).collect();
        for t in 0..max_frames {
            let (codes, eos) = self.acoustic_frame(&h, p, &mut hist, rng)?;
            frames.push(codes.clone());
            if eos {
                break;
            }
            let mut slot = vec![ids.sgs];
            slot.extend_from_slice(&codes);
            let se = self.embed_rows(&slot, anchor);
            let se_v = self.ort(self.env.tensor(&se, &[1, 1, HIDDEN as i64]))?;
            let pos = [(t_prompt + t) as i64];
            let pos_v = self.ort(self.env.tensor(&pos, &[1, 1]))?;
            // keys then values, in the graph's own order (past_k_0.., past_v_0..)
            let mut inputs: Vec<(&str, &Value<'_>)> = vec![("inputs_embeds", &se_v), ("position_ids", &pos_v)];
            for i in 0..ids.layers {
                inputs.push((names_dec[2 * i].as_str(), &past[i]));
                inputs.push((names_dec[2 * i + 1].as_str(), &past[ids.layers + i]));
            }
            let mut out = self.ort(self.sess_dec.run(&inputs, &outs_dec))?;
            drop(inputs);
            let o0: Vec<f32> = self.ort(out[0].to_vec::<f32>())?;
            h = o0[..HIDDEN].to_vec();
            past = out.drain(1..1 + 2 * ids.layers).collect();
        }
        Ok(frames)
    }

    /// `_decode_codes`: the codec decodes `(T, 16)` codes into the mono waveform (`out[0][0].mean(0)`).
    fn decode_codes(&self, frames: &[Vec<i64>]) -> Res<Vec<f32>> {
        let codes: Vec<i32> = frames.iter().flat_map(|f| f.iter().map(|&c| c as i32)).collect();
        let lens = [frames.len() as i32];
        let c_v = self.ort(self.env.tensor(&codes, &[1, frames.len() as i64, N_VQ as i64]))?;
        let l_v = self.ort(self.env.tensor(&lens, &[1]))?;
        let outs: Vec<&str> = self.names_codec.iter().map(String::as_str).collect();
        let out = self.ort(self.sess_codec.run(&[("audio_codes", &c_v), ("audio_code_lengths", &l_v)], &outs))?;
        let shape = self.ort(out[0].info())?.shape;
        let data = self.ort(out[0].to_vec::<f32>())?;
        // (1, C, N): mean over the channel axis, sequential float32 sum then a float64 divide by C rounded to float32.
        let (c, n) = (shape[1] as usize, shape[2] as usize);
        Ok((0..n)
            .map(|i| {
                let mut s = data[i];
                for ch in 1..c {
                    s += data[ch * n + i];
                }
                ((f64::from(s)) / c as f64) as f32
            })
            .collect())
    }

    /// `OnnxV3LiteEngine.infer(phonemes=..., speaker_emb, ref_codes, temperature, ...)` for one chunk.
    pub fn infer_phonemes(&self, phonemes: &str, voice: &Voice, anchor: &[f32], temperature: f64, rng: &mut Mt19937) -> Res<Vec<f32>> {
        let max_frames = MAX_NEW_FRAMES.min(audio::max_expected_frames(phonemes));
        let ph_ids = self.front.ids(phonemes);
        let rows = self.build_rows(&ph_ids, voice.codes.as_deref());
        let prompt = self.embed_rows(&rows, anchor);
        let p = Params { temperature, top_k: TOP_K, top_p: TOP_P, rep_pen: REP_PEN };
        let frames = self.gen_once(&prompt, anchor, &p, max_frames, rng)?;
        if frames.is_empty() {
            return Ok(Vec::new());
        }
        let mut wav = self.decode_codes(&frames)?;
        let mut best: Babble = audio::babble_suspect(&wav, phonemes, max_frames, frames.len());
        let mut tries = 0;
        while best.0 && tries < audio::BABBLE_MAX_RETRIES {
            let f2 = self.gen_once(&prompt, anchor, &p, max_frames, rng)?;
            tries += 1;
            if f2.is_empty() {
                continue;
            }
            let w2 = self.decode_codes(&f2)?;
            let cand = audio::babble_suspect(&w2, phonemes, max_frames, f2.len());
            if audio::babble_prefer(cand, best) {
                wav = w2;
                best = cand;
            }
        }
        Ok(wav)
    }

    /// The wrapper's `infer(chunk_text...)` over already-chunked text: phonemise every chunk, run the engine, join with the gap pauses.
    /// `chunks`/`gaps` come from `normalize_to_chunks_v3_with_gaps` (row L, ported in A4a; the S3 harness feeds Python's).
    pub fn infer_chunks(
        &self,
        chunks: &[String],
        gaps: &[String],
        voice: &Voice,
        temperature: f64,
        draws: &mut Draws,
        output_name: &str,
        call_counter: &mut usize,
    ) -> Res<Vec<f32>> {
        if chunks.is_empty() {
            return Ok(Vec::new());
        }
        let anchor = self.anchor(&voice.speaker_emb)?;
        let phs: Vec<String> = chunks.iter().map(|c| self.front.phonemes(c)).collect();
        let mut wavs = Vec::new();
        for ph in &phs {
            *call_counter += 1;
            let mut seeded = draws.rng_for_call(output_name, *call_counter);
            let rng = match (&mut seeded, &mut *draws) {
                (Some(r), _) => r,
                (None, Draws::Global(g)) => g,
                (None, Draws::Seeded(_)) => unreachable!(),
            };
            wavs.push(self.infer_phonemes(ph, voice, &anchor, temperature, rng)?);
        }
        Ok(audio::join_audio_chunks(&wavs, gaps))
    }
}

type VoiceTables = (HashMap<String, Voice>, HashMap<String, String>, Option<String>);

/// `_load_v3_voices` (the built-in presets).
fn load_voices(path: &Path) -> Res<VoiceTables> {
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(path).map_err(werr("WORKER_ERROR"))?).map_err(werr("WORKER_ERROR"))?;
    let (mut voices, mut aliases) = (HashMap::new(), HashMap::new());
    for (name, v) in data["presets"].as_object().into_iter().flatten() {
        let Some(emb) = v["speaker_emb"].as_array() else { continue };
        let speaker_emb: Vec<f32> = emb.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
        let codes = v["codes"].as_array().map(|rows| {
            let mut rows: Vec<Vec<i64>> =
                rows.iter().map(|r| r.as_array().unwrap().iter().map(|c| c.as_i64().unwrap()).collect()).collect();
            // strip_encoder_pad_frame: drop a trailing frame whose codebook 0 is 455 when there is more than one frame
            if rows.len() > 1 && rows.last().is_some_and(|r| r[0] == 455) {
                rows.pop();
            }
            rows.into_iter().flatten().collect::<Vec<i64>>()
        });
        for a in v["aliases"].as_array().into_iter().flatten().filter_map(|a| a.as_str()) {
            if a != name {
                aliases.insert(a.to_string(), name.clone());
            }
        }
        voices.insert(name.clone(), Voice { speaker_emb, codes });
    }
    Ok((voices, aliases, data["default_voice"].as_str().map(str::to_string)))
}
