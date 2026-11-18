//! `health`: can this worker run on this machine? The ORT runtime is loaded for real, because a native library only
//! fails at load time (a missing VC143 CRT DLL, a wrong version).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The ONNX Runtime DLL ships next to the worker exe, with the VC143 CRT DLLs it imports.
pub fn ort_dll_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or(Path::new(".")).join("onnxruntime.dll")
}

/// The health result: engine identity, ORT load outcome, FFmpeg location and `ready`.
pub fn health() -> Value {
    let dll = ort_dll_path();
    let ort = match ortffi::Env::load(&dll, "thanham-health") {
        Ok(_) => {
            json!({"loaded": true, "version": ortffi::ORT_VERSION, "api_version": ortffi::ORT_API_VERSION, "path": dll.to_string_lossy()})
        }
        Err(error) => {
            json!({"loaded": false, "code": ortffi::RUNTIME_MISSING, "error": error.to_string(), "path": dll.to_string_lossy()})
        }
    };
    let ffmpeg = std::env::var("THANHAM_FFMPEG").ok().filter(|s| !s.is_empty());
    let ready = ort["loaded"] == true;
    json!({"engine": "rust", "version": env!("CARGO_PKG_VERSION"), "ort": ort, "ffmpeg": ffmpeg, "ready": ready, "stt_engine": stt_engine()})
}

/// The linked STT engine (`crate::ct2::info`), or null in a build without it.
fn stt_engine() -> Value {
    #[cfg(feature = "ct2")]
    return crate::ct2::info();
    #[cfg(not(feature = "ct2"))]
    Value::Null
}
