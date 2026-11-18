//! The float32 numpy/librosa/libsndfile conventions the port depends on, checked bit for bit against fixtures produced by the
//! reference runtime (`py/gen_fixtures.py`) and against the K-B3 goldens. Paths default to this machine's evidence tree and can be
//! overridden with `S5_EVIDENCE` (the `s5-clone` folder) and `S5_BASELINE` (the `baseline-1.0.16` folder).

use std::path::PathBuf;

use s5_clone::npy::Npy;
use s5_clone::{trim, wav};
use sha2::{Digest, Sha256};

fn work() -> PathBuf {
    PathBuf::from(r"C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work")
}

fn evidence() -> PathBuf {
    std::env::var_os("S5_EVIDENCE").map(PathBuf::from).unwrap_or_else(|| work().join("rm").join("s5-clone"))
}

fn baseline() -> PathBuf {
    std::env::var_os("S5_BASELINE").map(PathBuf::from).unwrap_or_else(|| work().join("rm").join("baseline-1.0.16"))
}

fn f32s(path: PathBuf) -> Vec<f32> {
    Npy::read(&path).unwrap().f32s().unwrap()
}

fn same_bits(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

#[test]
fn pairwise_mean_of_squares_matches_numpy() {
    for hop in [320usize, 882, 960] {
        let input = f32s(evidence().join("fixtures/rms").join(format!("mean_in_{hop}.npy")));
        let want = f32s(evidence().join("fixtures/rms").join(format!("mean_out_{hop}.npy")));
        let got: Vec<f32> = input
            .chunks_exact(hop)
            .map(|row| wav::pairwise_sum(&row.iter().map(|v| v * v).collect::<Vec<_>>()) / hop as f32)
            .collect();
        assert!(same_bits(&got, &want), "hop {hop}");
    }
}

#[test]
fn rms_and_db_match_librosa() {
    for n in [40000usize, 16000 * 3 + 123, 3000] {
        let y = f32s(evidence().join("fixtures/rms").join(format!("y_{n}.npy")));
        let rms = trim::rms(&y);
        assert!(same_bits(&rms, &f32s(evidence().join("fixtures/rms").join(format!("rms_{n}.npy")))), "rms {n}");
        assert!(
            same_bits(&trim::amplitude_to_db(&rms), &f32s(evidence().join("fixtures/rms").join(format!("db_{n}.npy")))),
            "db {n}"
        );
    }
}

#[test]
fn pcm_quantisation_matches_soundfile() {
    let x = f32s(evidence().join("fixtures/pcm/x.npy"));
    let want16 = Npy::read(&evidence().join("fixtures/pcm/pcm16_bytes.npy")).unwrap();
    let want24 = Npy::read(&evidence().join("fixtures/pcm/pcm24_bytes.npy")).unwrap();
    let got16: Vec<u8> = x.iter().flat_map(|&v| wav::quantize_i16(v).to_le_bytes()).collect();
    let got24: Vec<u8> = x.iter().flat_map(|&v| wav::quantize_i24(v).to_le_bytes()[..3].to_vec()).collect();
    assert_eq!(got16, want16.u8s().unwrap());
    assert_eq!(got24, want24.u8s().unwrap());
}

fn find_ref(name: &str) -> Option<PathBuf> {
    let w = work();
    [
        w.join("lane-a-tts/refs").join(name),
        w.join("voice-clone-check").join(name),
        w.join("cue-timing/audio").join(name),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

#[test]
fn trim_reproduces_every_k_b3_golden() {
    let golden: serde_json::Value =
        serde_json::from_slice(&std::fs::read(baseline().join("goldens/k-b3/run1/trim.json")).unwrap()).unwrap();
    let mut cases = 0;
    for (key, want) in golden.as_object().unwrap() {
        let mono: Vec<f32> = if let Some(name) = key.strip_prefix("ref:") {
            let w = wav::read(&find_ref(name).unwrap_or_else(|| panic!("{name} not found"))).unwrap();
            wav::mean_channels(&w.samples, w.channels)
        } else if let Some(name) = key.strip_prefix("syn:") {
            f32s(evidence().join("fixtures/trim_syn").join(format!("{name}.npy")))
        } else {
            continue;
        };
        let (s, e) = trim::trim(&mono, 30.0);
        let mut h = Sha256::new();
        for v in &mono[s..e] {
            h.update(v.to_le_bytes());
        }
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(want["start"], s, "{key} start");
        assert_eq!(want["end"], e, "{key} end");
        assert_eq!(want["samples_in"], mono.len(), "{key} samples_in");
        assert_eq!(want["sha256_out_f32"], digest, "{key} sha256");
        cases += 1;
    }
    assert_eq!(cases, 59);
}

/// S5b: every denoiser STFT/iSTFT sub-step is bitwise equal to numpy 2.4.6 when given numpy's own intermediates
/// (recorded by `py/recstft.py`, reference 000-N).
#[test]
fn denoiser_stft_steps_are_bitwise_numpy() {
    let report =
        s5_clone::s5b::iso(&evidence().join("rec-stft").join("000-N"), &evidence().join("rec").join("000-N")).unwrap();
    for step in [
        "frames_window",
        "fft_pocketfft_numpy",
        "abs_numpy_formula_fma",
        "atan2",
        "cos",
        "sin",
        "ort_in_mag_from_numpy_spec",
        "ort_in_cos_from_numpy_phi",
        "ort_in_sin_from_numpy_phi",
        "complex_product",
        "ifft_pocketfft_numpy_f32",
        "overlap_add",
        "window_sum",
        "normalise",
        "final_scale",
    ] {
        let n_diff = report[step]["n_diff"].as_u64().unwrap();
        assert_eq!(n_diff, 0, "{step}: {n_diff} values differ from numpy");
    }
}
