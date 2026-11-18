//! S5 harness: `unit`, `resample`, `kb3`, `run` (see the module docs of each command below).
//!
//! Every path is passed on the command line or taken from the defaults of this machine's evidence tree.

use std::fs;
use std::path::{Path, PathBuf};

use ortffi::Env;
use s5_clone::cond::Conditioner;
use s5_clone::denoise::Irfft;
use s5_clone::npy::{self, Npy};
use s5_clone::resample::{FfmpegSoxr, Quality, Resampler, SoxrDll};
use s5_clone::{trim, wav};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type BoxError = Box<dyn std::error::Error>;

const ROOT: &str = r"C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work";

fn evidence() -> PathBuf {
    PathBuf::from(ROOT).join("rm").join("s5-clone")
}

fn baseline() -> PathBuf {
    PathBuf::from(ROOT).join("rm").join("baseline-1.0.16")
}

struct Args(Vec<String>);

impl Args {
    fn get(&self, name: &str) -> Option<String> {
        self.0.iter().position(|a| a == name).and_then(|i| self.0.get(i + 1)).cloned()
    }
}

fn load_f32(dir: &Path, name: &str) -> Result<Vec<f32>, BoxError> {
    Ok(Npy::read(&dir.join(format!("{name}.npy")))?.f32s()?)
}

/// Comparison of two float32 arrays: length, number of differing values (as bits), largest absolute difference.
fn cmp_f32(a: &[f32], b: &[f32]) -> Value {
    let n = a.len().min(b.len());
    let mut n_diff = 0usize;
    let mut max_abs = 0.0f64;
    for i in 0..n {
        if a[i].to_bits() != b[i].to_bits() {
            n_diff += 1;
            max_abs = max_abs.max((f64::from(a[i]) - f64::from(b[i])).abs());
        }
    }
    json!({"len_rust": a.len(), "len_python": b.len(), "n_diff": n_diff, "max_abs": max_abs,
           "bitwise": a.len() == b.len() && n_diff == 0})
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        ab += f64::from(*x) * f64::from(*y);
        aa += f64::from(*x) * f64::from(*x);
        bb += f64::from(*y) * f64::from(*y);
    }
    ab / (aa.sqrt() * bb.sqrt())
}

fn make_resampler(args: &Args) -> Result<Box<dyn Resampler>, BoxError> {
    let rt = baseline().join("runtime");
    match args.get("--resampler").as_deref().unwrap_or("ffmpeg") {
        "ffmpeg" => Ok(Box::new(FfmpegSoxr {
            ffmpeg: args.get("--ffmpeg").map(PathBuf::from).unwrap_or_else(|| rt.join("ffmpeg").join("ffmpeg.exe")),
        })),
        "dll" => {
            let dll = args.get("--soxr-dll").map(PathBuf::from).unwrap_or_else(|| {
                evidence()
                    .join("third_party")
                    .join("soxr-dl")
                    .join("build")
                    .join("bin")
                    .join("Release")
                    .join("soxr.dll")
            });
            Ok(Box::new(SoxrDll::load(&dll)?))
        }
        other => Err(format!("unknown resampler {other}").into()),
    }
}

/// ORT intra-op threads (`--threads`, default 8 as in the 1.0.16 engine; 0 = ORT's default session for the denoiser).
fn threads(args: &Args) -> i32 {
    args.get("--threads").and_then(|v| v.parse().ok()).unwrap_or(8)
}

fn ort_env(args: &Args) -> Result<Env, BoxError> {
    let dll = args.get("--ort").map(PathBuf::from).unwrap_or_else(|| {
        baseline()
            .join("runtime")
            .join("python")
            .join("Lib")
            .join("site-packages")
            .join("onnxruntime")
            .join("capi")
            .join("onnxruntime.dll")
    });
    Ok(Env::load(&dll, "s5")?)
}

fn recorded_refs(rec: &Path, index_name: &str) -> Result<Vec<(String, PathBuf)>, BoxError> {
    let index: Value = serde_json::from_slice(&fs::read(rec.join(index_name))?)?;
    let mut refs: Vec<(String, PathBuf)> = index
        .as_object()
        .ok_or("index.json is not an object")?
        .iter()
        .map(|(k, v)| (k.clone(), PathBuf::from(v["path"].as_str().unwrap_or_default())))
        .collect();
    refs.sort();
    Ok(refs)
}

/// `unit`: float32 numpy-compatibility fixtures (pairwise mean, librosa rms and dB, soundfile PCM quantisation).
fn unit(args: &Args) -> Result<(), BoxError> {
    let fx = args.get("--fixtures").map(PathBuf::from).unwrap_or_else(|| evidence().join("fixtures"));
    let mut report = serde_json::Map::new();
    // numpy float32 mean of squares over a contiguous axis
    for hop in [320usize, 882, 960] {
        let input = Npy::read(&fx.join("rms").join(format!("mean_in_{hop}.npy")))?.f32s()?;
        let expected = Npy::read(&fx.join("rms").join(format!("mean_out_{hop}.npy")))?.f32s()?;
        let got: Vec<f32> = input
            .chunks_exact(hop)
            .map(|row| {
                let sq: Vec<f32> = row.iter().map(|v| v * v).collect();
                wav::pairwise_sum(&sq) / hop as f32
            })
            .collect();
        report.insert(format!("mean_f32_hop{hop}"), cmp_f32(&got, &expected));
    }
    for n in [40000usize, 16000 * 3 + 123, 3000] {
        let y = Npy::read(&fx.join("rms").join(format!("y_{n}.npy")))?.f32s()?;
        let rms = trim::rms(&y);
        report.insert(
            format!("rms_{n}"),
            cmp_f32(&rms, &Npy::read(&fx.join("rms").join(format!("rms_{n}.npy")))?.f32s()?),
        );
        let db = trim::amplitude_to_db(&rms);
        report
            .insert(format!("db_{n}"), cmp_f32(&db, &Npy::read(&fx.join("rms").join(format!("db_{n}.npy")))?.f32s()?));
    }
    // soundfile quantisation of PCM_16 and PCM_24
    let x = Npy::read(&fx.join("pcm").join("x.npy"))?.f32s()?;
    {
        let name = "lrintf_2pow31_shift";
        let want16 = Npy::read(&fx.join("pcm").join("pcm16_bytes.npy"))?;
        let got16: Vec<u8> = x.iter().flat_map(|&v| wav::quantize_i16(v).to_le_bytes()).collect();
        let want24 = Npy::read(&fx.join("pcm").join("pcm24_bytes.npy"))?;
        let got24: Vec<u8> = x.iter().flat_map(|&v| wav::quantize_i24(v).to_le_bytes()[..3].to_vec()).collect();
        report.insert(
            name.to_string(),
            json!({"pcm16_equal": got16 == want16.u8s()?, "pcm24_equal": got24 == want24.u8s()?,
                   "pcm16_n_diff": got16.iter().zip(want16.u8s()?).filter(|(a, b)| a != b).count(),
                   "pcm24_n_diff": got24.iter().zip(want24.u8s()?).filter(|(a, b)| a != b).count()}),
        );
    }
    println!("{}", serde_json::to_string_pretty(&Value::Object(report))?);
    Ok(())
}

/// `resample`: both backends against the recorded python-soxr input/output pairs.
fn resample_cmd(args: &Args) -> Result<(), BoxError> {
    let rec = args.get("--rec").map(PathBuf::from).unwrap_or_else(|| evidence().join("rec"));
    let backends: Vec<(&str, Box<dyn Resampler>)> = {
        let mut a = Args(args.0.clone());
        a.0.extend(["--resampler".into(), "ffmpeg".into()]);
        let ff = make_resampler(&a)?;
        let mut b = Args(args.0.clone());
        b.0.extend(["--resampler".into(), "dll".into()]);
        vec![("ffmpeg-soxr", ff), ("soxr-dll", make_resampler(&b)?)]
    };
    let mut out = serde_json::Map::new();
    let (mut total, mut identical) = (std::collections::BTreeMap::new(), std::collections::BTreeMap::new());
    for (name, _) in recorded_refs(&rec, &args.get("--index").unwrap_or_else(|| "index.json".into()))? {
        let manifest: Value = serde_json::from_slice(&fs::read(rec.join(&name).join("manifest.json"))?)?;
        for (kind, m) in manifest["soxr"].as_object().ok_or("no soxr")? {
            let input = load_f32(&rec.join(&name), &format!("soxr_{kind}_in"))?;
            let expected = load_f32(&rec.join(&name), &format!("soxr_{kind}_out"))?;
            let (i, o) = (m["in_rate"].as_u64().unwrap() as u32, m["out_rate"].as_u64().unwrap() as u32);
            for (bname, backend) in &backends {
                let got = backend.resample(&input, i, o, Quality::Hq)?;
                let c = cmp_f32(&got, &expected);
                *total.entry(*bname).or_insert(0) += 1;
                if c["bitwise"] == true {
                    *identical.entry(*bname).or_insert(0) += 1;
                }
                out.insert(format!("{name}:{kind}:{bname}"), c);
            }
        }
    }
    println!("{}", json!({"total": total, "bit_identical": identical}));
    fs::write(evidence().join("resample-report.json"), serde_json::to_string_pretty(&Value::Object(out))?)?;
    Ok(())
}

fn sha256_f32(x: &[f32]) -> String {
    let mut h = Sha256::new();
    for v in x {
        h.update(v.to_le_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn find_ref(name: &str) -> Option<PathBuf> {
    let w = PathBuf::from(ROOT);
    let candidates = [
        w.join("lane-a-tts").join("refs").join(name),
        w.join("voice-clone-check").join(name),
        w.join("cue-timing").join("audio").join(name),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// `kb3`: the trim port against the K-B3 goldens (`trim.json`): start, end, lengths and the sha256 of the float32 output.
fn kb3(args: &Args) -> Result<(), BoxError> {
    let golden = args
        .get("--golden")
        .map(PathBuf::from)
        .unwrap_or_else(|| baseline().join("goldens").join("k-b3").join("run1").join("trim.json"));
    let fx = args.get("--fixtures").map(PathBuf::from).unwrap_or_else(|| evidence().join("fixtures"));
    let g: Value = serde_json::from_slice(&fs::read(&golden)?)?;
    let (mut pass, mut fail, mut failures) = (0, 0, Vec::new());
    let mut cases = serde_json::Map::new();
    for (key, want) in g.as_object().ok_or("golden is not an object")? {
        let mono: Vec<f32> = if let Some(name) = key.strip_prefix("ref:") {
            let path = find_ref(name).ok_or_else(|| format!("reference {name} not found"))?;
            let w = wav::read(&path)?;
            wav::mean_channels(&w.samples, w.channels)
        } else if let Some(name) = key.strip_prefix("syn:") {
            Npy::read(&fx.join("trim_syn").join(format!("{name}.npy")))?.f32s()?
        } else {
            continue;
        };
        let (s, e) = trim::trim(&mono, 30.0);
        let got = json!({"start": s, "end": e, "samples_in": mono.len(), "samples_out": e - s, "sha256_out_f32": sha256_f32(&mono[s..e])});
        let ok = ["start", "end", "samples_in", "samples_out", "sha256_out_f32"].iter().all(|k| got[k] == want[k]);
        if ok {
            pass += 1;
        } else {
            fail += 1;
            failures.push(key.clone());
        }
        cases.insert(key.clone(), json!({"ok": ok, "rust": got, "golden": want}));
    }
    println!("{}", json!({"cases": pass + fail, "pass": pass, "fail": fail, "failures": failures}));
    fs::write(evidence().join("kb3-trim-report.json"), serde_json::to_string_pretty(&Value::Object(cases))?)?;
    Ok(())
}

/// `run`: Rust conditioning end to end (from the WAV file) and teacher-forced per stage, against the recorder's dumps.
fn run(args: &Args) -> Result<(), BoxError> {
    let rec = args.get("--rec").map(PathBuf::from).unwrap_or_else(|| evidence().join("rec"));
    let tag = args.get("--tag").unwrap_or_else(|| "rust".into());
    let out_root = evidence().join("out").join(&tag);
    let resampler = make_resampler(args)?;
    let env = ort_env(args)?;
    let model_dir = baseline().join("models").join("vieneu-v3");
    let mut cond = Conditioner::new(&env, &model_dir, threads(args), resampler.as_ref())?;
    cond.irfft = match args.get("--irfft").as_deref() {
        Some("f64") => Irfft::F64,
        _ => Irfft::F32,
    };
    cond.quality = match args.get("--quality").as_deref() {
        Some("vhq") => Quality::Vhq,
        Some("mq") => Quality::Mq,
        _ => Quality::Hq,
    };
    let only = args.get("--only");
    let mut summary = serde_json::Map::new();
    for (name, path) in recorded_refs(&rec, &args.get("--index").unwrap_or_else(|| "index.json".into()))? {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        let d = rec.join(&name);
        let manifest: Value = serde_json::from_slice(&fs::read(d.join("manifest.json"))?)?;
        let rt = baseline().join("runtime").join("ffmpeg");
        let w = wav::read_any(&path, &rt.join("ffmpeg.exe"), &rt.join("ffprobe.exe"))?;
        let c = cond.condition(&w)?;
        let od = out_root.join(&name);
        npy::write_f32(&od.join("emb.npy"), &[c.emb.len()], &c.emb)?;
        npy::write_i64(&od.join("codes.npy"), &[c.code_frames, c.codes.len() / c.code_frames.max(1)], &c.codes)?;
        npy::write_f32(&od.join("den_out.npy"), &[c.denoised.out.len()], &c.denoised.out)?;

        let py_emb = load_f32(&d, "emb")?;
        let py_codes = Npy::read(&d.join("codes.npy"))?;
        let py_codes_v = py_codes.i64s()?;
        let n_vq = py_codes.shape[1];
        let t_py = py_codes.shape[0];
        let t_rs = c.code_frames;
        let frames_equal = (0..t_py.min(t_rs))
            .filter(|&t| c.codes[t * n_vq..(t + 1) * n_vq] == py_codes_v[t * n_vq..(t + 1) * n_vq])
            .count();
        let tokens_equal = (0..t_py.min(t_rs) * n_vq).filter(|&i| c.codes[i] == py_codes_v[i]).count();
        let py_window =
            (manifest["window"][0].as_u64().unwrap() as usize, manifest["window"][1].as_u64().unwrap() as usize);
        let py_trim =
            (manifest["trim_idx"][0].as_u64().unwrap() as usize, manifest["trim_idx"][1].as_u64().unwrap() as usize);

        // stage-wise end to end (each stage compared with the recorder's value while the Rust chain runs on its own values)
        let mut stages = serde_json::Map::new();
        stages.insert("window".into(), json!({"rust": [c.window.0, c.window.1], "python": [py_window.0, py_window.1], "equal": c.window == py_window}));
        stages.insert(
            "trim".into(),
            json!({"rust": [c.trim.0, c.trim.1], "python": [py_trim.0, py_trim.1], "equal": c.trim == py_trim}),
        );
        stages.insert("pcm16".into(), cmp_f32(&c.pcm16, &load_f32(&d, "pcm16")?));
        stages.insert(
            "resampled_44k".into(),
            cmp_f32(
                &c.denoised.resampled,
                &load_f32(&d, if manifest["sr_clean"] == 44100 { "pcm16" } else { "soxr_to44k_out" })?,
            ),
        );
        for (i, key) in ["mag", "cos", "sin"].iter().enumerate() {
            stages.insert(format!("den_{key}"), cmp_f32(&c.denoised.core_in[i], &load_f32(&d, &format!("den_{key}"))?));
        }
        for (i, key) in ["sep_mag", "sep_cos", "sep_sin"].iter().enumerate() {
            stages
                .insert(format!("den_{key}"), cmp_f32(&c.denoised.core_out[i], &load_f32(&d, &format!("den_{key}"))?));
        }
        stages.insert("den_out".into(), cmp_f32(&c.denoised.out, &load_f32(&d, "den_out")?));
        stages.insert("to16k".into(), cmp_f32(&c.to16k, &load_f32(&d, "soxr_to16k_out")?));
        stages.insert("fbank_raw".into(), cmp_f32(&c.fbank_raw, &load_f32(&d, "knf_raw")?));
        stages.insert("to48k".into(), cmp_f32(&c.to48k, &load_f32(&d, "soxr_to48k_out")?));

        // teacher forced: each stage fed with Python's recorded input
        let mut forced = serde_json::Map::new();
        let py_trim_in = load_f32(&d, "trim_in")?;
        let ft = trim::trim(&py_trim_in, 30.0);
        forced.insert(
            "trim".into(),
            json!({"rust": [ft.0, ft.1], "python": [py_trim.0, py_trim.1], "equal": ft == py_trim}),
        );
        let py_pcm16 = load_f32(&d, "pcm16")?;
        let cap = (8.0 * f64::from(c.sr0)) as usize;
        let fd = cond.denoise(if py_pcm16.len() > cap { &py_pcm16[..cap] } else { &py_pcm16 }, c.sr0)?;
        forced.insert("denoise_out".into(), cmp_f32(&fd.out, &load_f32(&d, "den_out")?));
        // ORT on Python's exact tensors: same model, same inputs, expected bitwise (E0 of the ortffi spike)
        let (py_mag, py_cos, py_sin) = (load_f32(&d, "den_mag")?, load_f32(&d, "den_cos")?, load_f32(&d, "den_sin")?);
        let core = cond.denoiser_core(&py_mag, &py_cos, &py_sin, c.denoised.frames)?;
        for (i, key) in ["sep_mag", "sep_cos", "sep_sin"].iter().enumerate() {
            forced.insert(format!("ort_core_{key}"), cmp_f32(&core[i], &load_f32(&d, &format!("den_{key}"))?));
        }
        let py_den_out = load_f32(&d, "den_out")?;
        let (f16, fraw, fnorm, femb) = cond.speaker_embedding(&py_den_out, 44100)?;
        forced.insert("to16k".into(), cmp_f32(&f16, &load_f32(&d, "soxr_to16k_out")?));
        forced.insert("fbank_raw".into(), cmp_f32(&fraw, &load_f32(&d, "knf_raw")?));
        forced.insert("embedding".into(), cmp_f32(&femb, &py_emb));
        let _ = fnorm;
        let (_, _, fcodes, fframes) = cond.codec_codes(&py_den_out, 44100)?;
        let forced_frames_equal = (0..t_py.min(fframes))
            .filter(|&t| fcodes[t * n_vq..(t + 1) * n_vq] == py_codes_v[t * n_vq..(t + 1) * n_vq])
            .count();
        forced.insert(
            "codes".into(),
            json!({"frames_rust": fframes, "frames_python": t_py, "frames_equal": forced_frames_equal}),
        );

        let r = json!({
            "ref": name, "resampler": resampler.name(), "irfft": format!("{:?}", cond.irfft), "quality": format!("{:?}", cond.quality),
            "embedding_cosine": cosine(&c.emb, &py_emb), "embedding_bitwise": c.emb.iter().map(|v| v.to_bits()).eq(py_emb.iter().map(|v| v.to_bits())),
            "codes_frames_rust": t_rs, "codes_frames_python": t_py, "codes_frame_identity": frames_equal as f64 / t_py.max(t_rs) as f64,
            "codes_token_identity": tokens_equal as f64 / (t_py.max(t_rs) * n_vq) as f64,
            "stages": stages, "teacher_forced": forced,
        });
        fs::write(od.join("report.json"), serde_json::to_string_pretty(&r)?)?;
        println!(
            "{name}: cos {:.9} frames {}/{} (rust {}) window {} trim {} den_out_bitwise {}",
            r["embedding_cosine"].as_f64().unwrap(),
            frames_equal,
            t_py,
            t_rs,
            r["stages"]["window"]["equal"],
            r["stages"]["trim"]["equal"],
            r["stages"]["den_out"]["bitwise"]
        );
        summary.insert(name, r);
    }
    fs::write(out_root.join("summary.json"), serde_json::to_string_pretty(&Value::Object(summary))?)?;
    Ok(())
}

/// `preview`: the `clone_preview` output (crop, trim, 8 s, denoise, PCM_24 at 44.1 kHz) against the K-B3 preview goldens, sample by sample.
fn preview(args: &Args) -> Result<(), BoxError> {
    let golden_dir = baseline().join("goldens").join("k-b3").join("run1");
    let g: Value = serde_json::from_slice(&fs::read(golden_dir.join("preview.json"))?)?;
    let resampler = make_resampler(args)?;
    let env = ort_env(args)?;
    let mut cond =
        Conditioner::new(&env, &baseline().join("models").join("vieneu-v3"), threads(args), resampler.as_ref())?;
    cond.irfft = match args.get("--irfft").as_deref() {
        Some("f64") => Irfft::F64,
        _ => Irfft::F32,
    };
    let mut report = serde_json::Map::new();
    let (mut equal_files, mut total_files) = (0, 0);
    for (name, want) in g.as_object().ok_or("preview.json is not an object")? {
        let path = find_ref(name).ok_or_else(|| format!("reference {name} not found"))?;
        let w = wav::read(&path)?;
        let (_, _, _, _, capped) = cond.clean(&w)?;
        let denoised = cond.denoise(&capped, w.sample_rate)?;
        let ints: Vec<i32> = denoised.out.iter().map(|&x| wav::quantize_i24(x)).collect();
        let golden = wav::read(&golden_dir.join("preview").join(name))?;
        let want_ints: Vec<i32> = golden.samples.iter().map(|&x| (x * 8_388_608.0) as i32).collect();
        let n = ints.len().min(want_ints.len());
        let diff: Vec<i32> = (0..n).map(|i| (ints[i] - want_ints[i]).abs()).collect();
        let n_diff = diff.iter().filter(|&&d| d != 0).count();
        let max_lsb = diff.iter().copied().max().unwrap_or(0);
        let mut h = Sha256::new();
        for v in &ints {
            h.update((v << 8).to_le_bytes());
        }
        let digest: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let identical = ints.len() == want_ints.len() && n_diff == 0;
        total_files += 1;
        if identical {
            equal_files += 1;
        }
        println!(
            "{name}: frames {} vs {}, differing samples {n_diff}, max {max_lsb} LSB, pcm_sha256 equal {}",
            ints.len(),
            want_ints.len(),
            digest == want["pcm_sha256"].as_str().unwrap_or("")
        );
        report.insert(name.clone(), json!({"frames_rust": ints.len(), "frames_golden": want_ints.len(), "n_diff": n_diff, "max_lsb": max_lsb, "identical": identical}));
    }
    println!("{}", json!({"previews": total_files, "identical": equal_files}));
    fs::write(
        evidence().join(format!("preview-report-{}.json", args.get("--tag").unwrap_or_else(|| "rust".into()))),
        serde_json::to_string_pretty(&Value::Object(report))?,
    )?;
    Ok(())
}

/// `cond --wav <file>... --out <dir>`: conditioning of arbitrary WAV references, `<dir>/<stem>/{emb,codes}.npy` (for the injection run).
fn cond_cmd(args: &Args) -> Result<(), BoxError> {
    let out = PathBuf::from(args.get("--out").ok_or("--out <dir> is required")?);
    let resampler = make_resampler(args)?;
    let env = ort_env(args)?;
    let model_dir = baseline().join("models").join("vieneu-v3");
    let cond = Conditioner::new(&env, &model_dir, threads(args), resampler.as_ref())?;
    let wavs: Vec<&String> = args
        .0
        .iter()
        .enumerate()
        .filter(|(i, a)| *i > 0 && args.0[*i - 1] == "--wav" && !a.starts_with("--"))
        .map(|(_, a)| a)
        .collect();
    for path in wavs {
        let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("ref").to_string();
        let c = cond.condition(&wav::read(Path::new(path))?)?;
        let d = out.join(&stem);
        npy::write_f32(&d.join("emb.npy"), &[c.emb.len()], &c.emb)?;
        npy::write_i64(&d.join("codes.npy"), &[c.code_frames, c.codes.len() / c.code_frames.max(1)], &c.codes)?;
        println!("{stem}: {} codec frames", c.code_frames);
    }
    Ok(())
}

fn stftiso(_args: &Args) -> Result<(), BoxError> {
    let dir = evidence().join("rec-stft");
    let mut report = serde_json::Map::new();
    for e in fs::read_dir(&dir)? {
        let e = e?;
        if !e.file_type()?.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        report.insert(name.clone(), s5_clone::s5b::iso(&e.path(), &evidence().join("rec").join(&name))?);
        eprintln!("{name} done");
    }
    let text = serde_json::to_string_pretty(&Value::Object(report))?;
    fs::write(evidence().join("stft-iso-report.json"), text)?;
    Ok(())
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = Args(raw.clone());
    let result = match raw.first().map(String::as_str) {
        Some("unit") => unit(&args),
        Some("resample") => resample_cmd(&args),
        Some("kb3") => kb3(&args),
        Some("run") => run(&args),
        Some("cond") => cond_cmd(&args),
        Some("preview") => preview(&args),
        Some("stftiso") => stftiso(&args),
        _ => Err("usage: s5-clone unit | resample | kb3 | run [--only <ref>] [--resampler ffmpeg|dll] [--irfft f32|f64] [--quality hq|vhq|mq] [--tag <name>]".into()),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
