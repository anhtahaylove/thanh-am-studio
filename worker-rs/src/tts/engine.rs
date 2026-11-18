//! The VieNeu v3 Turbo ONNX engine for preset voices: `OnnxV3LiteEngine.infer` (`onnx_runtime_lite.py:381`) and the wrapper's
//! `infer` (`vieneu/v3turbo.py:600`: voice, chunker, per-chunk engine calls, join), with ONNX Runtime through `ortffi` and the numpy
//! head from [`super::head`]. From spike S3 (head bitwise on native AVX2, SDE `-snb` and `-skx`; 232/232 WAVs identical).

use super::audio::{self, Babble};
use super::blas::OpenBlas;
use super::front::Front;
use super::head::{sample, ChannelWindow, Params, Weights, AUDIO_VOCAB, HIDDEN, N_VQ};
use super::mt19937::Mt19937;
use super::{np, text};
use crate::error::{Result, WorkerError};
use ortffi::{Env, ExecutionMode, GraphOptimizationLevel, Session, SessionOptions, Value};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Preset sampling temperature of the worker (`PRESET_TEMPERATURE`).
pub const PRESET_TEMPERATURE: f64 = 0.5;
/// Sampling temperature of a cloned voice: the worker passes none, so `V3TurboVieNeuTTS.infer`'s default applies.
pub const CLONED_TEMPERATURE: f64 = 0.8;
const TOP_K: usize = 25;
const TOP_P: f64 = 0.95;
const REP_PEN: f64 = 1.2;
const REP_WINDOW: usize = 64;
const MAX_NEW_FRAMES: usize = 300;

/// Files the engine needs.
pub struct Paths {
    /// `onnxruntime.dll` 1.31.1.
    pub ort_dll: PathBuf,
    /// numpy's OpenBLAS DLL.
    pub openblas_dll: PathBuf,
    /// The installed `vieneu-v3` folder.
    pub model_dir: PathBuf,
    /// `sea_g2p.bin`.
    pub sea_g2p_bin: PathBuf,
    /// `vieneu\assets\voices_v3_turbo.json`.
    pub voices_json: PathBuf,
}

/// A preset voice, or a cloned one.
pub struct Voice {
    speaker_emb: Vec<f32>,
    /// Reference codes `(T, 16)` row-major, encoder pad frame stripped.
    codes: Option<Vec<i64>>,
}

impl Voice {
    /// What `_enroll_reference` returns for a cloned voice: the speaker embedding and the reference codes.
    pub fn cloned(speaker_emb: Vec<f32>, codes: Vec<i64>) -> Voice {
        Voice { speaker_emb, codes: Some(codes) }
    }
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

/// Where the draws come from: the legacy global stream (production, entropy-seeded), or a reseed before every engine call from
/// `THANHAM_TTS_SEED` (the P-op hook both workers carry: `np.random.seed(crc32(f"{seed}|{output_name}|{call}"))`).
pub enum Draws {
    /// One process-wide stream.
    Global(Box<Mt19937>),
    /// Re-seeded before each engine call from this seed string.
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
                Draws::Global(Box::new(Mt19937::seed(h.finish() as u32)))
            }
        }
    }
}

/// `THANHAM_TTS_TRACE=<file>`: one JSON line per engine call (phonemes, token ids, the codes of every decoded generation, a SHA-256 over
/// every audio-head logits vector in order, a SHA-256 per decoded waveform). `parity/tts_trace.py` records the same from Python (rows P1,
/// P3-P5).
struct Trace {
    logits: Sha256,
    gens: Vec<Vec<Vec<i64>>>,
    pcm: Vec<String>,
}

fn hex(d: impl AsRef<[u8]>) -> String {
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn f32_bytes(a: &[f32]) -> Vec<u8> {
    a.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The loaded engine.
pub struct Engine {
    blas: OpenBlas,
    weights: Weights,
    front: Front,
    env: Env,
    /// The engine's session options (`self._so`), which the clone sessions share.
    options: SessionOptions,
    sess_pre: Session,
    sess_dec: Session,
    sess_ac: Session,
    sess_codec: Session,
    names_pre: Vec<String>,
    names_dec: Vec<String>,
    names_ac: Vec<String>,
    names_codec: Vec<String>,
    ids: Ids,
    voices: Vec<(String, Voice)>,
    aliases: Vec<(String, String)>,
    default_voice: Option<String>,
    trace: Option<PathBuf>,
}

/// `os.cpu_count()` on Windows: every active logical processor, whatever the affinity.
fn cpu_count() -> usize {
    #[cfg(windows)]
    {
        // SAFETY: a plain query; ALL_PROCESSOR_GROUPS (0xFFFF) counts every group.
        let n = unsafe { windows_sys::Win32::System::Threading::GetActiveProcessorCount(0xFFFF) };
        if n > 0 {
            return n as usize;
        }
    }
    std::thread::available_parallelism().map_or(4, |n| n.get())
}

/// Python's `repr()` of a list of strings, for the "voice not found" message.
fn py_list_repr(items: &[&str]) -> String {
    let quoted: Vec<String> = items.iter().map(|s| crate::pyfmt::str_repr(s)).collect();
    format!("[{}]", quoted.join(", "))
}

impl Engine {
    /// Loads everything, mirroring `Vieneu(backend='onnx', ..., threads=min(8, cpu_count))` and its session options.
    pub fn load(p: &Paths) -> Result<Engine> {
        let blas =
            OpenBlas::load_pinned(&p.openblas_dll).map_err(|e| WorkerError::new("RUNTIME_MISSING", e.to_string()))?;
        let env = Env::load(&p.ort_dll, "thanham-tts")?;
        let onnx_dir = p.model_dir.join("backbone").join("onnx_update");
        let read_json = |path: &Path| -> Result<Json> {
            let bytes = std::fs::read(path).map_err(|e| WorkerError::py("OSError", e))?;
            serde_json::from_slice(&bytes).map_err(|e| WorkerError::py("JSONDecodeError", e))
        };
        let cfg = read_json(&onnx_dir.join("config.json"))?;
        let gi = |k: &str| cfg[k].as_i64().ok_or_else(|| WorkerError::py("KeyError", format!("'{k}'")));
        let local_heads = cfg["local_num_attention_heads"].as_i64().unwrap_or(8) as usize;
        let ids = Ids {
            audio_pad: gi("audio_pad_token_id")?,
            tps: gi("text_prompt_start_token_id")?,
            tpe: gi("text_prompt_end_token_id")?,
            sgs: gi("speech_generation_start_token_id")?,
            eos_speech: gi("speech_generation_end_token_id")?,
            ref_slot: gi("audio_ref_slot_token_id")?,
            default_style: cfg["default_style_token_id"].as_i64().unwrap_or(16),
            layers: gi("num_hidden_layers")? as usize,
            local_heads,
            local_head_dim: HIDDEN / local_heads,
        };
        let weights =
            Weights::load(&onnx_dir.join("vieneu_v3_heads.npz")).map_err(|e| WorkerError::py("OSError", e))?;
        let front = Front::load(&p.sea_g2p_bin, &onnx_dir.join("tokenizer.json"))?;

        // threads=min(8, cpu_count) from the worker; inter_op 1; allow_spinning 0; ORT_ENABLE_ALL.
        let mut so = SessionOptions::new(&env)?;
        so.graph_optimization_level(GraphOptimizationLevel::All)
            .and_then(|s| s.inter_op_threads(1))
            .and_then(|s| s.config_entry("session.intra_op.allow_spinning", "0"))
            .and_then(|s| s.intra_op_threads(cpu_count().min(8) as i32))
            .and_then(|s| s.execution_mode(ExecutionMode::Sequential))?;
        let open = |path: PathBuf| Session::from_file(&env, &path, &so);
        let sess_pre = open(onnx_dir.join("vieneu_prefill.onnx"))?;
        let sess_dec = open(onnx_dir.join("vieneu_decode_step.onnx"))?;
        let sess_ac = open(onnx_dir.join("vieneu_acoustic_cached.onnx"))?;
        let sess_codec = open(p.model_dir.join("codec").join("moss_audio_tokenizer_decode_full.onnx"))?;
        let names = |s: &Session| s.outputs().iter().map(|o| o.name.clone()).collect::<Vec<_>>();
        // `_load_v3_voices`, then `_load_repo_voices(backbone)`: a voices file shipped with the model adds or overrides presets.
        let (mut voices, mut aliases, mut default_voice) = (Vec::new(), Vec::new(), None);
        load_voices(&read_json(&p.voices_json)?, false, &mut voices, &mut aliases, &mut default_voice);
        let repo = p.model_dir.join("backbone").join("voices_v3_turbo.json");
        if repo.is_file() {
            if let Ok(data) = read_json(&repo) {
                load_voices(&data, true, &mut voices, &mut aliases, &mut default_voice);
            }
        }
        Ok(Engine {
            names_pre: names(&sess_pre),
            names_dec: names(&sess_dec),
            names_ac: names(&sess_ac),
            names_codec: names(&sess_codec),
            blas,
            weights,
            front,
            env,
            options: so,
            sess_pre,
            sess_dec,
            sess_ac,
            sess_codec,
            ids,
            voices,
            aliases,
            default_voice,
            trace: std::env::var_os("THANHAM_TTS_TRACE").filter(|s| !s.is_empty()).map(PathBuf::from),
        })
    }

    /// The ONNX Runtime environment and the engine's session options, for the clone sessions.
    pub fn sessions(&self) -> (&Env, &SessionOptions) {
        (&self.env, &self.options)
    }

    /// `_resolve_ref(voice, None, ...)` for a preset: the named voice (or the preset an alias points to), else the default voice.
    /// `voice` is the item's `voice_id` when truthy: a string is looked up, any other value falls back to the default (a dict is the
    /// one shape Python reads differently, and it reruns there).
    pub fn voice(&self, voice: Option<&Json>) -> Result<&Voice> {
        let find = |n: &str| self.voices.iter().find(|(k, _)| k == n).map(|(_, v)| v);
        match voice {
            Some(Json::String(name)) => {
                let target = if find(name).is_some() {
                    Some(name.as_str())
                } else {
                    self.aliases.iter().rev().find(|(a, _)| a == name).map(|(_, t)| t.as_str())
                };
                target.and_then(find).ok_or_else(|| {
                    let names: Vec<&str> = self.voices.iter().map(|(k, _)| k.as_str()).collect();
                    WorkerError::py(
                        "ValueError",
                        format!("Voice '{name}' not found. Available: {}", py_list_repr(&names)),
                    )
                })
            }
            Some(Json::Object(_)) => {
                Err(WorkerError::new("WORKER_ERROR", "A voice given as an object is read by the Python worker."))
            }
            _ => self.default_voice.as_deref().and_then(find).ok_or_else(|| {
                WorkerError::py("ValueError", "Provide a preset `voice` name or a `ref_audio` to clone.")
            }),
        }
    }

    /// `_speaker_anchor`.
    fn anchor(&self, speaker_emb: &[f32]) -> Result<Vec<f32>> {
        if !speaker_emb.iter().any(|&x| x != 0.0) {
            return Err(WorkerError::py("ValueError", "speaker_emb is all-zero"));
        }
        Ok(self.weights.speaker_anchor(&self.blas, speaker_emb))
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

    /// `_acoustic_frame`: the 16 codes of one frame and the end-of-speech decision.
    fn acoustic_frame(
        &self,
        h: &[f32],
        p: &Params,
        hist: &mut [ChannelWindow],
        rng: &mut Mt19937,
        trace: &mut Option<Trace>,
    ) -> Result<(Vec<i64>, bool)> {
        let ids = &self.ids;
        let txt = &self.weights.text_emb[ids.sgs as usize * HIDDEN..(ids.sgs as usize + 1) * HIDDEN];
        let mut tok = h.to_vec();
        tok.extend_from_slice(txt);
        let pos = [0i64, 1];
        let empty: Vec<f32> = Vec::new();
        let past_shape = [1, ids.local_heads as i64, 0, ids.local_head_dim as i64];
        let tok_v = self.env.tensor(&tok, &[1, 2, HIDDEN as i64])?;
        let pos_v = self.env.tensor(&pos, &[1, 2])?;
        let pk0 = self.env.tensor(&empty, &past_shape)?;
        let pv0 = self.env.tensor(&empty, &past_shape)?;
        let outs: Vec<&str> = self.names_ac.iter().map(String::as_str).collect();
        let mut out = self
            .sess_ac
            .run(&[("token_emb", &tok_v), ("position_ids", &pos_v), ("past_k_0", &pk0), ("past_v_0", &pv0)], &outs)?;
        let hidden: Vec<f32> = out[0].to_vec::<f32>()?;
        let slot0 = hidden[..HIDDEN].to_vec();
        let mut vec = hidden[HIDDEN..2 * HIDDEN].to_vec();
        let mut codes: Vec<i64> = Vec::with_capacity(N_VQ);
        for ch in 0..N_VQ {
            if ch > 0 {
                let last = codes[ch - 1] as usize;
                let base = ((ch - 1) * AUDIO_VOCAB + last) * HIDDEN;
                let emb = self.weights.audio_emb[base..base + HIDDEN].to_vec();
                let pos = [(ch + 1) as i64];
                let emb_v = self.env.tensor(&emb, &[1, 1, HIDDEN as i64])?;
                let pos_v = self.env.tensor(&pos, &[1, 1])?;
                out = self.sess_ac.run(
                    &[("token_emb", &emb_v), ("position_ids", &pos_v), ("past_k_0", &out[1]), ("past_v_0", &out[2])],
                    &outs,
                )?;
                vec = out[0].to_vec::<f32>()?[..HIDDEN].to_vec();
            }
            let logits = self.weights.audio_logits(&self.blas, ch, &vec);
            if let Some(t) = trace.as_mut() {
                t.logits.update(f32_bytes(&logits));
            }
            let code = sample(&logits, p, &hist[ch], rng);
            hist[ch].add(code);
            codes.push(code as i64);
        }
        let text_logits = self.weights.text_logits(&self.blas, &slot0);
        let eos = np::argmax(&text_logits) as i64 == ids.eos_speech;
        Ok((codes, eos))
    }

    /// `_gen_once`: the frames of one generation.
    fn gen_once(
        &self,
        prompt: &[f32],
        anchor: &[f32],
        p: &Params,
        max_frames: usize,
        rng: &mut Mt19937,
        trace: &mut Option<Trace>,
    ) -> Result<Vec<Vec<i64>>> {
        let ids = &self.ids;
        let t_prompt = prompt.len() / HIDDEN;
        let prompt_v = self.env.tensor(prompt, &[1, t_prompt as i64, HIDDEN as i64])?;
        let outs_pre: Vec<&str> = self.names_pre.iter().map(String::as_str).collect();
        let mut pre = self.sess_pre.run(&[("inputs_embeds", &prompt_v)], &outs_pre)?;
        let hid: Vec<f32> = pre[0].to_vec::<f32>()?;
        let mut h = hid[(t_prompt - 1) * HIDDEN..t_prompt * HIDDEN].to_vec();
        // pre[1..1+L] present keys, pre[1+L..1+2L] present values
        let mut past: Vec<Value<'static>> = pre.drain(1..1 + 2 * ids.layers).collect();
        let mut hist: Vec<ChannelWindow> = (0..N_VQ).map(|_| ChannelWindow::new(REP_WINDOW)).collect();
        let mut frames = Vec::new();
        let names_dec: Vec<String> =
            (0..ids.layers).flat_map(|i| [format!("past_k_{i}"), format!("past_v_{i}")]).collect();
        let outs_dec: Vec<&str> = self.names_dec.iter().map(String::as_str).collect();
        for t in 0..max_frames {
            let (codes, eos) = self.acoustic_frame(&h, p, &mut hist, rng, trace)?;
            frames.push(codes.clone());
            if eos {
                break;
            }
            let mut slot = vec![ids.sgs];
            slot.extend_from_slice(&codes);
            let se = self.embed_rows(&slot, anchor);
            let se_v = self.env.tensor(&se, &[1, 1, HIDDEN as i64])?;
            let pos = [(t_prompt + t) as i64];
            let pos_v = self.env.tensor(&pos, &[1, 1])?;
            // keys then values, in the graph's own order (past_k_0.., past_v_0..)
            let mut inputs: Vec<(&str, &Value<'_>)> = vec![("inputs_embeds", &se_v), ("position_ids", &pos_v)];
            for i in 0..ids.layers {
                inputs.push((names_dec[2 * i].as_str(), &past[i]));
                inputs.push((names_dec[2 * i + 1].as_str(), &past[ids.layers + i]));
            }
            let mut out = self.sess_dec.run(&inputs, &outs_dec)?;
            drop(inputs);
            h = out[0].to_vec::<f32>()?[..HIDDEN].to_vec();
            past = out.drain(1..1 + 2 * ids.layers).collect();
        }
        Ok(frames)
    }

    /// `_decode_codes`: the codec decodes `(T, 16)` codes into the mono waveform (`out[0][0].mean(0)`).
    fn decode_codes(&self, frames: &[Vec<i64>], trace: &mut Option<Trace>) -> Result<Vec<f32>> {
        let codes: Vec<i32> = frames.iter().flat_map(|f| f.iter().map(|&c| c as i32)).collect();
        let lens = [frames.len() as i32];
        let c_v = self.env.tensor(&codes, &[1, frames.len() as i64, N_VQ as i64])?;
        let l_v = self.env.tensor(&lens, &[1])?;
        let outs: Vec<&str> = self.names_codec.iter().map(String::as_str).collect();
        let out = self.sess_codec.run(&[("audio_codes", &c_v), ("audio_code_lengths", &l_v)], &outs)?;
        let shape = out[0].info()?.shape;
        let data = out[0].to_vec::<f32>()?;
        // (1, C, N): mean over the channel axis, sequential float32 sum then a float64 divide by C rounded to float32.
        let (c, n) = (shape[1] as usize, shape[2] as usize);
        let wav: Vec<f32> = (0..n)
            .map(|i| {
                let mut s = data[i];
                for ch in 1..c {
                    s += data[ch * n + i];
                }
                ((f64::from(s)) / c as f64) as f32
            })
            .collect();
        if let Some(t) = trace.as_mut() {
            t.gens.push(frames.to_vec());
            t.pcm.push(hex(Sha256::digest(f32_bytes(&wav))));
        }
        Ok(wav)
    }

    /// `OnnxV3LiteEngine.infer(phonemes=..., speaker_emb, ref_codes, temperature, ...)` for one chunk.
    fn infer_phonemes(
        &self,
        phonemes: &str,
        voice: &Voice,
        temperature: f64,
        rng: &mut Mt19937,
        trace: &mut Option<Trace>,
    ) -> Result<(Vec<i64>, Vec<f32>)> {
        let max_frames = MAX_NEW_FRAMES.min(audio::max_expected_frames(phonemes));
        let anchor = self.anchor(&voice.speaker_emb)?;
        let ph_ids = self.front.ids(phonemes)?;
        let rows = self.build_rows(&ph_ids, voice.codes.as_deref());
        let prompt = self.embed_rows(&rows, &anchor);
        let p = Params { temperature, top_k: TOP_K, top_p: TOP_P, rep_pen: REP_PEN };
        let frames = self.gen_once(&prompt, &anchor, &p, max_frames, rng, trace)?;
        if frames.is_empty() {
            return Ok((ph_ids, Vec::new()));
        }
        let mut wav = self.decode_codes(&frames, trace)?;
        let mut best: Babble = audio::babble_suspect(&wav, phonemes, max_frames, frames.len());
        let mut tries = 0;
        while best.0 && tries < audio::BABBLE_MAX_RETRIES {
            let f2 = self.gen_once(&prompt, &anchor, &p, max_frames, rng, trace)?;
            tries += 1;
            if f2.is_empty() {
                continue;
            }
            let w2 = self.decode_codes(&f2, trace)?;
            let cand = audio::babble_suspect(&w2, phonemes, max_frames, f2.len());
            if audio::babble_prefer(cand, best) {
                wav = w2;
                best = cand;
            }
        }
        Ok((ph_ids, wav))
    }

    /// The wrapper's `infer(text, voice=..., temperature=...)`: chunk the text, phonemise every chunk, one engine call per chunk (the
    /// draws re-seeded first under `THANHAM_TTS_SEED`), then join with the boundary pauses. `call` counts the engine calls of the take.
    pub fn infer(
        &self,
        text: &str,
        voice: &Voice,
        temperature: f64,
        draws: &mut Draws,
        output_name: &str,
        call: &mut usize,
    ) -> Result<Vec<f32>> {
        let (chunks, gaps) = text::chunks_with_gaps(text, self.front.normalizer());
        if chunks.is_empty() {
            return Ok(Vec::new());
        }
        let phs: Vec<String> = chunks.iter().map(|c| self.front.phonemes(c)).collect();
        let mut wavs = Vec::new();
        for ph in &phs {
            *call += 1;
            let mut seeded = match draws {
                Draws::Seeded(seed) => Some(Mt19937::seed(crc32(format!("{seed}|{output_name}|{call}").as_bytes()))),
                Draws::Global(_) => None,
            };
            let rng = match (&mut seeded, &mut *draws) {
                (Some(r), _) => r,
                (None, Draws::Global(g)) => &mut **g,
                (None, Draws::Seeded(_)) => unreachable!("a seeded stream is created above"),
            };
            let mut trace =
                self.trace.as_ref().map(|_| Trace { logits: Sha256::new(), gens: Vec::new(), pcm: Vec::new() });
            let (ph_ids, wav) = self.infer_phonemes(ph, voice, temperature, rng, &mut trace)?;
            if let (Some(path), Some(t)) = (&self.trace, trace) {
                let line = serde_json::json!({"item": output_name, "call": *call, "phonemes": ph, "ids": ph_ids, "gens": t.gens,
                    "logits": hex(t.logits.finalize()), "pcm": t.pcm});
                let mut f = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .map_err(|e| WorkerError::py("OSError", e))?;
                writeln!(f, "{line}").map_err(|e| WorkerError::py("OSError", e))?;
            }
            wavs.push(wav);
        }
        Ok(audio::join_audio_chunks(&wavs, &gaps))
    }
}

/// `_load_v3_voices` (`repo = false`) and `_load_repo_voices` (`repo = true`, which skips presets without an embedding and takes the
/// file's default voice only when it names a known preset).
fn load_voices(
    data: &Json,
    repo: bool,
    voices: &mut Vec<(String, Voice)>,
    aliases: &mut Vec<(String, String)>,
    default_voice: &mut Option<String>,
) {
    for (name, v) in data["presets"].as_object().into_iter().flatten() {
        let Some(emb) = v["speaker_emb"].as_array() else { continue };
        let speaker_emb: Vec<f32> = emb.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
        let codes = v["codes"].as_array().map(|rows| {
            let mut rows: Vec<Vec<i64>> = rows
                .iter()
                .map(|r| r.as_array().into_iter().flatten().map(|c| c.as_i64().unwrap_or(0)).collect())
                .collect();
            // strip_encoder_pad_frame: drop a trailing frame whose codebook 0 is 455 when there is more than one frame
            if rows.len() > 1 && rows.last().is_some_and(|r| r.first() == Some(&455)) {
                rows.pop();
            }
            rows.into_iter().flatten().collect::<Vec<i64>>()
        });
        let voice = Voice { speaker_emb, codes };
        match voices.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = voice,
            None => voices.push((name.clone(), voice)),
        }
        for a in v["aliases"].as_array().into_iter().flatten().filter_map(|a| a.as_str()) {
            if !a.is_empty() && a != name {
                aliases.push((a.to_string(), name.clone()));
            }
        }
    }
    let named = data["default_voice"].as_str().map(str::to_string);
    if !repo {
        *default_voice = named;
    } else if let Some(n) = named.filter(|n| voices.iter().any(|(k, _)| k == n)) {
        *default_voice = Some(n);
    }
}

/// Each built-in preset as `_load_v3_voices` reads it: SHA-256 of the float32 embedding and of the int64 codes (row L).
#[cfg(test)]
pub(super) fn describe_voices(data: &Json) -> (serde_json::Map<String, Json>, Option<String>) {
    let (mut voices, mut aliases, mut default_voice) = (Vec::new(), Vec::new(), None);
    load_voices(data, false, &mut voices, &mut aliases, &mut default_voice);
    let described = voices
        .iter()
        .map(|(name, v)| {
            let codes: Vec<u8> = v.codes.iter().flatten().flat_map(|c| c.to_le_bytes()).collect();
            (
                name.clone(),
                serde_json::json!([hex(Sha256::digest(f32_bytes(&v.speaker_emb))), hex(Sha256::digest(codes))]),
            )
        })
        .collect();
    (described, default_voice)
}

#[cfg(test)]
mod tests {
    #[test]
    fn crc32_is_zlib_crc32() {
        assert_eq!(super::crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(super::crc32(b""), 0);
    }
}
