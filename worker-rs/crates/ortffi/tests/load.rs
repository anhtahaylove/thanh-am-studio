//! Loading and refusing: every way the runtime DLL can be missing or wrong maps to
//! `RUNTIME_MISSING` through a typed error.

mod common;

use common::*;
use ortffi::{Env, Error, LoadError, ORT_API_VERSION, ORT_VERSION, RUNTIME_MISSING};
use std::path::{Path, PathBuf};
use std::process::Command;

fn refused(dll: &Path) -> LoadError {
    match Env::load(dll, "ortffi-load-test") {
        Err(e @ Error::Load(_)) => {
            assert_eq!(e.worker_code(), RUNTIME_MISSING, "{e}");
            assert!(!e.to_string().is_empty());
            let Error::Load(load) = e else { unreachable!() };
            assert_eq!(load.worker_code(), RUNTIME_MISSING);
            load
        }
        Err(e) => panic!("expected a load error, got {e}"),
        Ok(_) => panic!("{} was accepted", dll.display()),
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("ortffi-load");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

#[test]
fn loads_the_pinned_runtime() {
    let env = Env::load(&ort_dll(), "ortffi-load-test").expect("load");
    assert_eq!(env.version(), "1.31.1");
    assert_eq!((ORT_VERSION, ORT_API_VERSION), ("1.31.1", 31));
    // A second load of the same DLL is fine (the module is reference counted by Windows).
    Env::load(&ort_dll(), "again").expect("second load");
}

#[test]
fn missing_file_is_refused() {
    let missing = scratch("does-not-exist/onnxruntime.dll");
    match refused(&missing) {
        LoadError::LoadFailed { os_error, .. } => assert!(matches!(os_error, 2 | 3 | 126), "{os_error}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn relative_path_is_refused_without_searching() {
    assert!(matches!(refused(Path::new("onnxruntime.dll")), LoadError::NotAbsolute(_)));
    assert!(matches!(refused(Path::new(r"capi\onnxruntime.dll")), LoadError::NotAbsolute(_)));
    assert!(matches!(refused(Path::new(r"\Windows\System32\kernel32.dll")), LoadError::NotAbsolute(_)));
}

#[test]
fn a_file_that_is_not_a_dll_is_refused() {
    let fake = scratch("not-a-dll.dll");
    std::fs::write(&fake, b"this is not a PE file").unwrap();
    match refused(&fake) {
        LoadError::LoadFailed { os_error, .. } => assert_eq!(os_error, 193, "ERROR_BAD_EXE_FORMAT"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_dll_without_the_ort_export_is_refused() {
    let kernel32 = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()))
        .join(r"System32\kernel32.dll");
    assert!(matches!(refused(&kernel32), LoadError::MissingExport(_)));
}

#[test]
fn an_older_real_runtime_is_refused() {
    if common::skip_missing("sherpa-onnx onnxruntime.dll", &sherpa_dll()) {
        return;
    }
    // sherpa-onnx bundles onnxruntime 1.28.2.
    match refused(&sherpa_dll()) {
        LoadError::VersionMismatch { found, expected, .. } => {
            assert_eq!((found.as_str(), expected), ("1.28.2", "1.31.1"))
        }
        other => panic!("{other:?}"),
    }
}

/// Builds `tests/support/fake_ort.rs` as a DLL in the given mode.
fn fake_dll(mode: &str) -> PathBuf {
    let out = scratch(&format!("fake_ort_{mode}.dll"));
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake_ort.rs");
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let status = Command::new(rustc)
        .args(["--edition", "2021", "--crate-type", "cdylib", "--cfg"])
        .arg(format!("mode=\"{mode}\""))
        .arg("-o")
        .arg(&out)
        .arg(&source)
        .status()
        .expect("run rustc");
    assert!(status.success(), "rustc failed for mode {mode}");
    out
}

#[test]
fn a_dll_with_the_wrong_version_string_is_refused() {
    match refused(&fake_dll("wrongver")) {
        LoadError::VersionMismatch { found, .. } => assert_eq!(found, "1.30.0"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_dll_without_api_31_is_refused() {
    match refused(&fake_dll("noapi")) {
        LoadError::ApiUnavailable { api_version, .. } => assert_eq!(api_version, 31),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_dll_returning_a_null_api_base_is_refused() {
    assert!(matches!(refused(&fake_dll("nullbase")), LoadError::BadApiBase(_)));
}
