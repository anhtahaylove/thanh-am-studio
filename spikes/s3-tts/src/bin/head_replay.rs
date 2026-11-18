//! `head_replay <rec_dir> <out_dir> <openblas.dll> <heads.npz> [--xvec x.npy] [--temperature T] [--max-streams N] [--threads N]`
//!
//! Replays the Python recording (`rec_head.py`) through the Rust head and writes the same per-step fingerprints as `head_oracle.py`,
//! so `head_compare.py` can diff them bit for bit.

use s3_tts::blas::OpenBlas;
use s3_tts::exp::isa;
use s3_tts::head::{fingerprint, sample, ChannelWindow, Params, Weights, N_VQ};
use s3_tts::mt19937::Mt19937;
use s3_tts::npy::{self, Npy};
use s3_tts::np;
use std::path::PathBuf;

fn u64_bytes(a: &[u64]) -> Vec<u8> {
    a.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let opt = |name: &str| args.iter().position(|a| a == name).map(|i| args[i + 1].clone());
    let (rec, out) = (PathBuf::from(&args[1]), PathBuf::from(&args[2]));
    let blas = OpenBlas::load_pinned(&PathBuf::from(&args[3]))?;
    let weights = Weights::load(&PathBuf::from(&args[4]))?;
    if let Some(n) = opt("--threads") {
        blas.set_threads(n.parse()?);
    }
    let temp_override: Option<f64> = opt("--temperature").map(|t| t.parse()).transpose()?;
    let max_streams: usize = opt("--max-streams").map(|t| t.parse()).transpose()?.unwrap_or(usize::MAX);
    std::fs::create_dir_all(&out)?;
    eprintln!("isa={:?} openblas core={} threads={}", isa(), blas.corename(), blas.threads());

    if let Some(x) = opt("--xvec") {
        let xs = Npy::read(&PathBuf::from(x))?.f32s()?;
        let anchors: Vec<u64> = xs.chunks_exact(192).flat_map(|e| weights.speaker_anchor(&blas, e).1).collect();
        npy::write(&out.join("anchor.npy"), "<u8", &[anchors.len() / 7, 7], &u64_bytes(&anchors))?;
    }

    let index: serde_json::Value = serde_json::from_slice(&std::fs::read(rec.join("index.json"))?)?;
    let (mut hashes, mut codes, mut pos, mut text, mut tie) = (Vec::<u64>::new(), Vec::<i64>::new(), Vec::<i32>::new(), Vec::<u64>::new(), Vec::<u8>::new());
    for (si, st) in index["streams"].as_array().unwrap().iter().take(max_streams).enumerate() {
        let frames = st["frames"].as_u64().unwrap() as usize;
        if frames == 0 {
            continue;
        }
        let vec = Npy::read(&rec.join(format!("s{si:04}_vec.npy")))?.f32s()?;
        let slot = Npy::read(&rec.join(format!("s{si:04}_slot.npy")))?.f32s()?;
        let prm = &st["params"];
        let params = Params {
            temperature: temp_override.unwrap_or_else(|| prm["temperature"].as_f64().unwrap()),
            top_k: prm["top_k"].as_u64().unwrap() as usize,
            top_p: prm["top_p"].as_f64().unwrap(),
            rep_pen: prm["rep_pen"].as_f64().unwrap(),
        };
        let window = prm["window"].as_u64().unwrap() as usize;
        let starts: Vec<usize> = st["seg_starts"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        let mut rng = Mt19937::seed(st["seed"].as_u64().unwrap() as u32);
        let mut hist: Vec<ChannelWindow> = Vec::new();
        for f in 0..frames {
            if starts.contains(&f) {
                hist = (0..N_VQ).map(|_| ChannelWindow::new(window)).collect();
            }
            for ch in 0..N_VQ {
                let v = &vec[(f * N_VQ + ch) * 768..(f * N_VQ + ch + 1) * 768];
                let logits = weights.audio_logits(&blas, ch, v);
                let (code, tr) = sample(&logits, &params, &hist[ch], &mut rng);
                hist[ch].add(code);
                hashes.extend_from_slice(&tr.steps);
                codes.push(code as i64);
                pos.push(rng.pos() as i32);
                tie.extend_from_slice(&[tr.tie_in_candidates as u8, tr.tie_at_boundary as u8]);
            }
            let tl = weights.text_logits(&blas, &slot[f * 768..(f + 1) * 768]);
            let bytes: Vec<u8> = tl.iter().flat_map(|x| x.to_le_bytes()).collect();
            text.extend_from_slice(&[fingerprint(&bytes), np::argmax(&tl) as u64]);
        }
    }
    npy::write(&out.join("hashes.npy"), "<u8", &[hashes.len() / 7, 7], &u64_bytes(&hashes))?;
    npy::write(&out.join("codes.npy"), "<i8", &[codes.len()], &codes.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())?;
    npy::write(&out.join("pos.npy"), "<i4", &[pos.len()], &pos.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())?;
    npy::write(&out.join("text.npy"), "<u8", &[text.len() / 2, 2], &u64_bytes(&text))?;
    npy::write(&out.join("tie.npy"), "|u1", &[tie.len() / 2, 2], &tie)?;
    eprintln!("done: {} sample calls", codes.len());
    Ok(())
}
