//! STT audio decode: `load_audio` of `worker/main.py` (faster-whisper's `decode_audio(path, 16000)`, packet by packet), run by
//! `native/pyav_decode.c` on the FFmpeg 8.1.2 DLLs of the private runtime's PyAV 18.1.0 (`site-packages\av.libs`): the very files
//! Python decodes with, loaded by full path after a SHA-256 check of each (decision O.2), so the samples are bitwise Python's
//! (row D at E0). A missing or different DLL is `RUNTIME_MISSING`, which the desktop answers by running the job on Python.
//! The DLLs stay loaded for the life of the process.

use crate::error::{Result, WorkerError};
use crate::pyfmt::str_repr;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::OnceLock;

/// The PyAV 18.1.0 wheel's FFmpeg libraries that run the decode, with their SHA-256 (delvewheel names; the other `av.libs` DLLs
/// load as their dependencies, from the same folder).
const AV_LIBS: [(&str, &str); 5] = [
    (
        "avutil-60-cc1777f859dcfd98b8019bdf459e774e.dll",
        "ff4aae43357698825fa5392764d3b680e36c1846b75677bdbf313d8c141ece6d",
    ),
    (
        "swresample-6-0158536d5c4197d7d623445553ce9472.dll",
        "44b6c43045b783970832cd5cac9b3a7250a79476ca34cf90c98f02428749c8b0",
    ),
    (
        "avcodec-62-984de33114b7fa384296817dec999c9d.dll",
        "777704d8914bb99e5d78f3a0e7424031b5376621f2e7c60e83b84e77fcc7e2d7",
    ),
    (
        "avformat-62-b6d6bb16ff0b7753371e2d0b285c9dc0.dll",
        "a3494c5304c387518e0d5136ed9bf5e5fc1a3b227ce3f380357149ee09717ff2",
    ),
    (
        "avfilter-11-aef80fc767dc77e0319469b5bdcdf998.dll",
        "26e5bd7b01ad8874db7842c03f4ee0fa1466f1192f2f245c1cdccc8acb81ebd2",
    ),
];

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}

const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x100;
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;

/// `thanham_av_error` of native/pyav_decode.c.
#[repr(C)]
struct AvError {
    kind: c_int,
    code: c_int,
    place: [c_char; 256],
    strerror: [c_char; 64],
}

extern "C" {
    fn thanham_av_bind(
        sym: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
        ctx: *mut c_void,
    ) -> *const c_char;
    fn thanham_av_decode_audio(path: *const c_char, out: *mut *mut i16, len: *mut i64, err: *mut AvError) -> c_int;
    fn thanham_av_free(samples: *mut i16);
}

/// `sym` for thanham_av_bind: the export of that name from the first loaded module that has it.
unsafe extern "C" fn lookup(ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    // SAFETY: `ctx` is the `[isize; 5]` of module handles that `load` passes, alive for the call.
    let modules = unsafe { &*(ctx as *const [isize; 5]) };
    modules
        .iter()
        // SAFETY: each handle is a loaded module and `name` a NUL-terminated export name.
        .map(|&m| unsafe { GetProcAddress(m, name.cast()) })
        .find(|p| !p.is_null())
        .map_or(std::ptr::null_mut(), |p| p as *mut c_void)
}

/// Loads and binds the pinned DLLs once per process; the outcome (or why it failed) is kept.
fn load(site_packages: &Path) -> Result<()> {
    static LOADED: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            use sha2::{Digest, Sha256};
            let dir = site_packages.join("av.libs");
            let mut modules = [0isize; 5];
            for (slot, (name, pin)) in modules.iter_mut().zip(AV_LIBS) {
                let dll = dir.join(name);
                let bytes = std::fs::read(&dll).map_err(|e| format!("cannot read {}: {e}", dll.display()))?;
                let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                if hex != pin || !dll.is_absolute() {
                    return Err(format!("{} has SHA-256 {hex}, expected {pin}", dll.display()));
                }
                let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                // SAFETY: a NUL-terminated wide path; the flags resolve its dependencies only from its folder and System32.
                *slot = ortffi::without_error_dialogs(|| unsafe {
                    LoadLibraryExW(wide.as_ptr(), 0, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
                });
                if *slot == 0 {
                    return Err(format!("cannot load {}: {}", dll.display(), std::io::Error::last_os_error()));
                }
            }
            // SAFETY: `lookup` reads `modules` only during this call; the modules are never unloaded.
            let missing = unsafe { thanham_av_bind(lookup, modules.as_mut_ptr().cast()) };
            if missing.is_null() {
                Ok(())
            } else {
                // SAFETY: a static NUL-terminated name from native/pyav_decode.c.
                let name = unsafe { CStr::from_ptr(missing) };
                Err(format!("{} is not exported by the FFmpeg DLLs", name.to_string_lossy()))
            }
        })
        .clone()
        .map_err(|m| WorkerError::new("RUNTIME_MISSING", m))
}

fn c_text(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// PyAV's exception class for an FFmpeg error code (av/error.py: its FFmpeg error table, then Python's errno classes).
fn error_class(code: c_int) -> &'static str {
    let tag = |s: &[u8; 4]| -(i32::from(s[0]) | i32::from(s[1]) << 8 | i32::from(s[2]) << 16 | i32::from(s[3]) << 24);
    match code {
        c if c == tag(b"INDA") => "InvalidDataError",
        c if c == tag(b"EOF ") => "EOFError",
        c if c == tag(&[0xF8, b'D', b'E', b'C']) => "DecoderNotFoundError",
        c if c == tag(&[0xF8, b'D', b'E', b'M']) => "DemuxerNotFoundError",
        c if c == tag(&[0xF8, b'F', b'I', b'L']) => "FilterNotFoundError",
        c if c == tag(&[0xF8, b'O', b'P', b'T']) => "OptionNotFoundError",
        c if c == tag(&[0xF8, b'P', b'R', b'O']) => "ProtocolNotFoundError",
        c if c == tag(b"BUG!") => "BugError",
        c if c == tag(b"BUFS") => "BufferTooSmallError",
        c if c == tag(b"EXIT") => "ExitError",
        c if c == tag(b"EXT ") => "ExternalError",
        c if c == tag(b"PAWE") => "PatchWelcomeError",
        c if c == tag(b"UNKN") => "UnknownError",
        -2 => "FileNotFoundError",
        -1 | -13 => "PermissionError",
        -12 => "MemoryError",
        -22 => "ArgumentError",
        -11 => "BlockingIOError",
        c if (-200..0).contains(&c) => "OSError",
        _ => "UndefinedError",
    }
}

/// `load_audio`'s error about the input: `INVALID_MEDIA` with Python's `{type}: {str(exception)}`.
fn invalid_media(kind: &str, text: impl std::fmt::Display) -> WorkerError {
    WorkerError::new("INVALID_MEDIA", format!("{kind}: {text}"))
}

/// The worker's error for what `thanham_av_decode_audio` reported, as `load_audio` raises it: `INVALID_MEDIA` for the input,
/// `INPUT_MISSING` for a file deleted meanwhile, and `WORKER_ERROR` for memory, the environment and internal errors.
fn decode_error(err: &AvError) -> WorkerError {
    let place = c_text(&err.place);
    match err.kind {
        1 => {
            let (errno, text) = (-err.code, c_text(&err.strerror));
            let at = if place.is_empty() { String::new() } else { format!(": {}", str_repr(&place)) };
            let message = if err.code == -22 {
                format!("{text}{at} returned {errno}")
            } else {
                format!("[Errno {errno}] {text}{at}")
            };
            match err.code {
                -2 => WorkerError::new("INPUT_MISSING", "Input audio/video is missing."), // deleted since the job started
                // ENOMEM, a file another program holds (EACCES) or a read error (EIO) are the environment: WORKER_ERROR, rerun on
                // Python. EPERM stays INVALID_MEDIA: the AAC decoder returns it for damaged data.
                -12 | -13 | -5 => WorkerError::py(error_class(err.code), message),
                code => invalid_media(error_class(code), message),
            }
        }
        2 => invalid_media("IndexError", "tuple index out of range"),
        3 => invalid_media("ValueError", "Frame does not match AudioFifo parameters."),
        4 => invalid_media("ValueError", "Frame does not match AudioResampler setup."),
        5 => WorkerError::py("MemoryError", ""),
        _ => WorkerError::py("RuntimeError", place),
    }
}

/// The decoded 16 kHz mono signed 16-bit samples.
fn decode_s16(site_packages: &Path, path: &str) -> Result<Vec<i16>> {
    load(site_packages)?;
    let c_path = CString::new(path).map_err(|_| invalid_media("ValueError", "embedded null byte"))?;
    let (mut out, mut len) = (std::ptr::null_mut(), 0i64);
    let mut err = AvError { kind: 0, code: 0, place: [0; 256], strerror: [0; 64] };
    // SAFETY: the library is bound (load), the path is NUL-terminated and the out-pointers are valid for writes.
    if unsafe { thanham_av_decode_audio(c_path.as_ptr(), &mut out, &mut len, &mut err) } != 0 {
        return Err(decode_error(&err));
    }
    let samples = if out.is_null() {
        Vec::new()
    } else {
        // SAFETY: on success `out` holds `len` samples that the caller frees once, with thanham_av_free.
        let copy = unsafe { std::slice::from_raw_parts(out, len as usize) }.to_vec();
        // SAFETY: as above.
        unsafe { thanham_av_free(out) };
        copy
    };
    if samples.is_empty() {
        // e.g. every packet invalid: an empty transcript would pass for a silent recording
        return Err(WorkerError::new("INVALID_MEDIA", "The file has no decodable audio."));
    }
    Ok(samples)
}

/// `load_audio(path)`: float32 samples, `s16 / 32768`.
pub fn decode_audio(site_packages: &Path, path: &str) -> Result<Vec<f32>> {
    Ok(decode_s16(site_packages, path)?.into_iter().map(|s| f32::from(s) / 32768.0).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::os::windows::fs::OpenOptionsExt;

    /// Row D at E0: every case of `THANHAM_DECODE_CASES` (written by `parity/decode_cases.py` from the worker's `load_audio` on this
    /// machine) decodes to the same samples, or fails with the same code and message. `THANHAM_PYTHON` names the runtime's python.exe.
    #[test]
    fn decode_matches_pyav() {
        let Some(cases) = std::env::var_os("THANHAM_DECODE_CASES") else {
            eprintln!("THANHAM_DECODE_CASES not set: skipped");
            return;
        };
        let sp = Path::new(&std::env::var_os("THANHAM_PYTHON").expect("THANHAM_PYTHON"))
            .parent()
            .unwrap()
            .join("Lib\\site-packages");
        let text = std::fs::read_to_string(cases).unwrap();
        let (mut same, mut differ) = (0, Vec::new());
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let case: Value = serde_json::from_str(line).unwrap();
            let path = case["path"].as_str().unwrap();
            // "lock": decode_cases.py decoded it while a no-share handle held it, as a recorder or scanner that keeps it open
            let _lock = case["lock"]
                .as_bool()
                .unwrap_or(false)
                .then(|| std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap());
            let got = match decode_s16(&sp, path) {
                Ok(s) => {
                    let bytes: Vec<u8> = s.iter().flat_map(|v| v.to_le_bytes()).collect();
                    serde_json::json!({"n": s.len(), "sha256": Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()})
                }
                Err(e) => serde_json::json!({"code": e.code, "error": e.message}),
            };
            let want = &case["expected"];
            if &got == want {
                same += 1;
            } else {
                differ.push(format!("{path}: Rust {got} Python {want}"));
            }
        }
        println!("row D: {same} identical, {} differ", differ.len());
        assert!(differ.is_empty(), "{}", differ.join("\n"));
        assert!(same > 0);
    }
}
