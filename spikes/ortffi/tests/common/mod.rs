//! Shared helpers: runtime and model locations, a minimal `.npy` reader.
//!
//! Locations default to the repo layout this spike lives in and can be overridden:
//! `ORTFFI_DLL` (onnxruntime.dll 1.31.1), `ORTFFI_RUNTIME` (the repo's `runtime\python`),
//! `ORTFFI_VIENEU` (the `vieneu-v3` model folder).
#![allow(dead_code)]

use ortffi::{Env, Session, SessionOptions, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn outputs_dir() -> PathBuf {
    // crate = <outputs>/wt/rust-ortffi/spikes/ortffi
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().expect("outputs dir")
}

fn env_path(var: &str, default: impl FnOnce() -> PathBuf) -> PathBuf {
    let path = std::env::var_os(var).map(PathBuf::from).unwrap_or_else(default);
    assert!(path.exists(), "{} not found (set {var}): {}", path.display(), var);
    path
}

pub fn runtime_dir() -> PathBuf {
    env_path("ORTFFI_RUNTIME", || outputs_dir().join("thanh-am-studio/runtime/python"))
}

pub fn ort_dll() -> PathBuf {
    env_path("ORTFFI_DLL", || runtime_dir().join("Lib/site-packages/onnxruntime/capi/onnxruntime.dll"))
}

/// sherpa-onnx ships ONNX Runtime 1.28.2: a real DLL of the wrong version.
pub fn sherpa_dll() -> PathBuf {
    env_path("ORTFFI_SHERPA_DLL", || runtime_dir().join("Lib/site-packages/sherpa_onnx/lib/onnxruntime.dll"))
}

pub fn silero_model() -> PathBuf {
    env_path("ORTFFI_SILERO", || runtime_dir().join("Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx"))
}

pub fn vieneu_dir() -> PathBuf {
    env_path("ORTFFI_VIENEU", || outputs_dir().join("../work/tts-gap-guard/models/vieneu-v3"))
}

pub fn fixture_dir(case: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(case)
}

pub fn env() -> Env {
    Env::load(&ort_dll(), "ortffi-tests").expect("load onnxruntime 1.31.1")
}

/// What faster_whisper's `SileroVADModel` sets.
pub fn silero_options(env: &Env) -> SessionOptions {
    let mut o = SessionOptions::new(env).unwrap();
    o.inter_op_threads(1)
        .unwrap()
        .intra_op_threads(1)
        .unwrap()
        .cpu_mem_arena(false)
        .unwrap()
        .log_severity_level(4)
        .unwrap();
    o
}

/// What vieneu's `onnx_runtime_lite.py` sets for every session.
pub fn vieneu_options(env: &Env, intra: i32) -> SessionOptions {
    use ortffi::GraphOptimizationLevel::All;
    let mut o = SessionOptions::new(env).unwrap();
    o.graph_optimization_level(All).unwrap().inter_op_threads(1).unwrap();
    o.config_entry("session.intra_op.allow_spinning", "0").unwrap().intra_op_threads(intra).unwrap();
    o
}

pub fn silero_session(env: &Env) -> Session {
    Session::from_file(env, &silero_model(), &silero_options(env)).expect("silero session")
}

// ----- .npy ------------------------------------------------------------------------------------

pub struct Npy {
    pub descr: String,
    pub shape: Vec<i64>,
    pub bytes: Vec<u8>,
}

pub fn read_npy(path: &Path) -> Npy {
    let raw = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(&raw[..6], b"\x93NUMPY", "{}", path.display());
    let (header_len, start) = match raw[6] {
        1 => (u16::from_le_bytes([raw[8], raw[9]]) as usize, 10),
        _ => (u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize, 12),
    };
    let header = std::str::from_utf8(&raw[start..start + header_len]).unwrap();
    assert!(header.contains("'fortran_order': False"), "{header}");
    let descr = header.split("'descr': '").nth(1).unwrap().split('\'').next().unwrap().to_owned();
    let shape_text = header.split("'shape': (").nth(1).unwrap().split(')').next().unwrap();
    let shape = shape_text.split(',').filter(|s| !s.trim().is_empty()).map(|s| s.trim().parse().unwrap()).collect();
    Npy { descr, shape, bytes: raw[start + header_len..].to_vec() }
}

impl Npy {
    pub fn f32s(&self) -> Vec<f32> {
        assert_eq!(self.descr, "<f4");
        self.bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
    }
    pub fn i32s(&self) -> Vec<i32> {
        assert_eq!(self.descr, "<i4");
        self.bytes.chunks_exact(4).map(|b| i32::from_le_bytes(b.try_into().unwrap())).collect()
    }
    pub fn i64s(&self) -> Vec<i64> {
        assert_eq!(self.descr, "<i8");
        self.bytes.chunks_exact(8).map(|b| i64::from_le_bytes(b.try_into().unwrap())).collect()
    }
}

/// Owned typed buffer of one recorded input, so a `Value` can borrow it.
pub enum Buffer {
    F32(Vec<f32>),
    I32(Vec<i32>),
    I64(Vec<i64>),
}

impl Buffer {
    pub fn from_npy(npy: &Npy) -> Buffer {
        match npy.descr.as_str() {
            "<f4" => Buffer::F32(npy.f32s()),
            "<i4" => Buffer::I32(npy.i32s()),
            "<i8" => Buffer::I64(npy.i64s()),
            other => panic!("unsupported dtype {other}"),
        }
    }

    pub fn tensor<'a>(&'a self, env: &Env, shape: &[i64]) -> Value<'a> {
        match self {
            Buffer::F32(v) => env.tensor(v, shape),
            Buffer::I32(v) => env.tensor(v, shape),
            Buffer::I64(v) => env.tensor(v, shape),
        }
        .expect("tensor")
    }
}

/// The raw little-endian bytes of an output tensor, whatever its element type.
pub fn value_bytes(v: &Value<'_>) -> Vec<u8> {
    use ortffi::ElementType::*;
    match v.element_type().unwrap() {
        F32 => v.as_slice::<f32>().unwrap().iter().flat_map(|x| x.to_le_bytes()).collect(),
        I32 => v.as_slice::<i32>().unwrap().iter().flat_map(|x| x.to_le_bytes()).collect(),
        I64 => v.as_slice::<i64>().unwrap().iter().flat_map(|x| x.to_le_bytes()).collect(),
        other => panic!("unsupported output type {other:?}"),
    }
}

/// Files `<run>.in.<name>.npy` / `<run>.out.<name>.npy` of one recorded run, by tensor name.
pub fn recorded(dir: &Path, run: &str, kind: &str) -> BTreeMap<String, Npy> {
    let prefix = format!("{run}.{kind}.");
    let mut found = BTreeMap::new();
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let file = entry.unwrap().file_name().to_string_lossy().into_owned();
        if let Some(name) = file.strip_prefix(&prefix).and_then(|n| n.strip_suffix(".npy")) {
            found.insert(name.to_owned(), read_npy(&dir.join(&file)));
        }
    }
    assert!(!found.is_empty(), "no {kind} files for run {run} in {}", dir.display());
    found
}
