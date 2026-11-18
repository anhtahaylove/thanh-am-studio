//! Resampling that reproduces python-soxr 1.1.0 (`soxr.resample`, libsoxr 0.1.3-14-ga66f3ee).
//!
//! * [`FfmpegSoxr`] (primary in the plan): the FFmpeg CLI with `aresample=resampler=soxr:precision=20`.
//! * [`SoxrDll`] (fallback in the plan): a `soxr.dll` built from the `dofuuz/soxr` commit python-soxr pins, driven through the
//!   same `soxr_create` / `soxr_process` sequence as python-soxr's `csoxr_divide_proc`.

use std::ffi::{c_char, c_double, c_int, c_uint, c_ulong, c_void, CStr, OsStr};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Resampler failure.
#[derive(Debug)]
pub struct ResampleError(pub String);

impl std::fmt::Display for ResampleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "resample: {}", self.0)
    }
}

impl std::error::Error for ResampleError {}

/// soxr quality recipes (`soxr.h`): MQ 2, HQ 4, VHQ 6.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    /// SOXR_MQ.
    Mq,
    /// SOXR_HQ, python-soxr's default.
    Hq,
    /// SOXR_VHQ.
    Vhq,
}

impl Quality {
    fn recipe(self) -> c_ulong {
        match self {
            Quality::Mq => 2,
            Quality::Hq => 4,
            Quality::Vhq => 6,
        }
    }

    fn ffmpeg_precision(self) -> u32 {
        match self {
            Quality::Mq => 16,
            Quality::Hq => 20,
            Quality::Vhq => 28,
        }
    }
}

/// A mono float32 resampler.
pub trait Resampler {
    /// Resamples `x` from `in_rate` to `out_rate`.
    fn resample(&self, x: &[f32], in_rate: u32, out_rate: u32, quality: Quality) -> Result<Vec<f32>, ResampleError>;
    /// Short name for reports.
    fn name(&self) -> &'static str;
}

/// FFmpeg CLI backend.
pub struct FfmpegSoxr {
    /// Path of `ffmpeg.exe`.
    pub ffmpeg: PathBuf,
}

impl Resampler for FfmpegSoxr {
    fn name(&self) -> &'static str {
        "ffmpeg-soxr"
    }

    fn resample(&self, x: &[f32], in_rate: u32, out_rate: u32, quality: Quality) -> Result<Vec<f32>, ResampleError> {
        let filter = format!("aresample={out_rate}:resampler=soxr:precision={}", quality.ffmpeg_precision());
        let mut child = Command::new(&self.ffmpeg)
            .args(["-v", "error", "-nostdin", "-f", "f32le", "-ar"])
            .arg(in_rate.to_string())
            .args(["-ac", "1", "-i", "pipe:0", "-af"])
            .arg(&filter)
            .args(["-f", "f32le", "-ar"])
            .arg(out_rate.to_string())
            .args(["-ac", "1", "pipe:1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| ResampleError(format!("cannot start ffmpeg: {e}")))?;
        let mut stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let bytes: Vec<u8> = x.iter().flat_map(|v| v.to_le_bytes()).collect();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        });
        let err_reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).map_err(|e| ResampleError(e.to_string()))?;
        let _ = writer.join();
        let message = err_reader.join().unwrap_or_default();
        let status = child.wait().map_err(|e| ResampleError(e.to_string()))?;
        if !status.success() {
            return Err(ResampleError(format!("ffmpeg exited with {status}: {}", message.trim())));
        }
        Ok(out.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct IoSpec {
    itype: c_int,
    otype: c_int,
    scale: c_double,
    e: *mut c_void,
    flags: c_ulong,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct QualitySpec {
    precision: c_double,
    phase_response: c_double,
    passband_end: c_double,
    stopband_begin: c_double,
    e: *mut c_void,
    flags: c_ulong,
}

type IoSpecFn = unsafe extern "C" fn(c_int, c_int) -> IoSpec;
type QualitySpecFn = unsafe extern "C" fn(c_ulong, c_ulong) -> QualitySpec;
type CreateFn = unsafe extern "C" fn(
    c_double,
    c_double,
    c_uint,
    *mut *const c_char,
    *const IoSpec,
    *const QualitySpec,
    *const c_void,
) -> *mut c_void;
type ProcessFn = unsafe extern "C" fn(
    *mut c_void,
    *const c_void,
    usize,
    *mut usize,
    *mut c_void,
    usize,
    *mut usize,
) -> *const c_char;
type DeleteFn = unsafe extern "C" fn(*mut c_void);
type VersionFn = unsafe extern "C" fn() -> *const c_char;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}

const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

/// `soxr.dll` loaded by absolute path (no PATH or working-directory search).
pub struct SoxrDll {
    io_spec: IoSpecFn,
    quality_spec: QualitySpecFn,
    create: CreateFn,
    process: ProcessFn,
    delete: DeleteFn,
    version: VersionFn,
}

impl SoxrDll {
    /// Loads `dll` and resolves the entry points.
    pub fn load(dll: &Path) -> Result<SoxrDll, ResampleError> {
        let wide: Vec<u16> = OsStr::new(dll).encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is NUL terminated and outlives the call; the flags forbid PATH and cwd lookups.
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if module.is_null() {
            return Err(ResampleError(format!("cannot load {}", dll.display())));
        }
        let sym = |name: &'static [u8]| -> Result<*mut c_void, ResampleError> {
            // SAFETY: `module` is a live module handle and `name` is NUL terminated.
            let p = unsafe { GetProcAddress(module, name.as_ptr()) };
            if p.is_null() {
                Err(ResampleError(format!("missing export {}", String::from_utf8_lossy(&name[..name.len() - 1]))))
            } else {
                Ok(p)
            }
        };
        // SAFETY: each symbol is a libsoxr export whose C signature matches the declared function type.
        unsafe {
            Ok(SoxrDll {
                io_spec: std::mem::transmute::<*mut c_void, IoSpecFn>(sym(b"soxr_io_spec\0")?),
                quality_spec: std::mem::transmute::<*mut c_void, QualitySpecFn>(sym(b"soxr_quality_spec\0")?),
                create: std::mem::transmute::<*mut c_void, CreateFn>(sym(b"soxr_create\0")?),
                process: std::mem::transmute::<*mut c_void, ProcessFn>(sym(b"soxr_process\0")?),
                delete: std::mem::transmute::<*mut c_void, DeleteFn>(sym(b"soxr_delete\0")?),
                version: std::mem::transmute::<*mut c_void, VersionFn>(sym(b"soxr_version\0")?),
            })
        }
    }

    /// libsoxr's version string.
    pub fn version(&self) -> String {
        // SAFETY: `soxr_version` returns a pointer to a static NUL terminated string.
        unsafe { CStr::from_ptr((self.version)()) }.to_string_lossy().into_owned()
    }
}

impl Resampler for SoxrDll {
    fn name(&self) -> &'static str {
        "soxr-dll"
    }

    fn resample(&self, x: &[f32], in_rate: u32, out_rate: u32, quality: Quality) -> Result<Vec<f32>, ResampleError> {
        let (in_r, out_r) = (f64::from(in_rate), f64::from(out_rate));
        // SAFETY: the io/quality specs are plain values; `soxr_create` copies them. `err` is written by libsoxr.
        let handle = unsafe {
            let io = (self.io_spec)(0, 0); // SOXR_FLOAT32_I both ways
            let q = (self.quality_spec)(quality.recipe(), 0);
            let mut err: *const c_char = std::ptr::null();
            let h = (self.create)(in_r, out_r, 1, &mut err, &io, &q, std::ptr::null());
            if !err.is_null() {
                return Err(ResampleError(CStr::from_ptr(err).to_string_lossy().into_owned()));
            }
            h
        };
        // python-soxr csoxr_divide_proc: olen = ilen * out/in + 1, chunks of max(1000, 48000 * in/out) input frames.
        let ilen = x.len();
        let olen = (ilen as f64 * out_r / in_r) as usize + 1;
        let div_len = f64::max(1000.0, 48000.0 * in_r / out_r) as usize;
        let mut y = vec![0.0f32; olen];
        let mut out_pos = 0usize;
        let mut result = Ok(());
        let mut idx = 0usize;
        while idx < ilen {
            let n = std::cmp::min(div_len, ilen - idx);
            let mut odone = 0usize;
            // SAFETY: `x[idx..idx + n]` and `y[out_pos..olen]` are valid for the lengths passed; libsoxr writes `odone` frames.
            let err = unsafe {
                (self.process)(
                    handle,
                    x[idx..].as_ptr().cast(),
                    n,
                    std::ptr::null_mut(),
                    y[out_pos..].as_mut_ptr().cast(),
                    olen - out_pos,
                    &mut odone,
                )
            };
            if !err.is_null() {
                // SAFETY: libsoxr returns a static NUL terminated message.
                result = Err(ResampleError(unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned()));
                break;
            }
            out_pos += odone;
            idx += div_len;
        }
        if result.is_ok() {
            let mut odone = 0usize;
            // SAFETY: flush call: null input, `y[out_pos..olen]` valid for `olen - out_pos` frames.
            let err = unsafe {
                (self.process)(
                    handle,
                    std::ptr::null(),
                    0,
                    std::ptr::null_mut(),
                    y[out_pos..].as_mut_ptr().cast(),
                    olen - out_pos,
                    &mut odone,
                )
            };
            if err.is_null() {
                out_pos += odone;
            } else {
                // SAFETY: as above.
                result = Err(ResampleError(unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned()));
            }
        }
        // SAFETY: `handle` came from `soxr_create` and is deleted exactly once.
        unsafe { (self.delete)(handle) };
        result?;
        y.truncate(out_pos);
        Ok(y)
    }
}
