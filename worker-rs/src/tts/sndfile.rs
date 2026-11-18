//! Reference audio I/O through the runtime's own libsndfile (`_soundfile_data\libsndfile_x64.dll` of python-soundfile 0.14.0), with
//! the calls soundfile makes for `sf.read(path, dtype='float32', always_2d=True)` and `sf.write(path, mono_float32, rate, subtype)`.
//! The same decoder build is what makes reference decoding E0 for every format soundfile reads (MP3 included), and a format it
//! cannot read (M4A) fails here exactly as in Python.
//!
//! During coexistence the DLL is the very file Python loads (`<runtime>\Lib\site-packages\_soundfile_data\`), by full path, after a
//! SHA-256 check against the pin below; a missing or different file is `RUNTIME_MISSING` (decision O.2). The DLL is never unloaded.

use crate::error::{Result, WorkerError};
use crate::pyfmt::str_repr;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

/// SHA-256 of python-soundfile 0.14.0's `libsndfile_x64.dll` (libsndfile 1.2.2).
pub const PINNED_SHA256: &str = "22518c16f9d13eda5ae5adf999c4740d7d16cc2d6b178b36dd4ac2f759a38559";

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}

const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x100;
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;
const SFM_READ: c_int = 0x10;
const SFM_WRITE: c_int = 0x20;
const SFC_SET_CLIPPING: c_int = 0x10C0;
const SF_TRUE: c_int = 1;
const SF_FORMAT_WAV: c_int = 0x01_0000;
const SEEK_SET: c_int = 0;
const SEEK_CUR: c_int = 1;
const SEEK_END: c_int = 2;

/// WAV subtypes the clone path writes.
#[derive(Clone, Copy)]
pub enum Subtype {
    /// `PCM_16`, soundfile's default for `.wav` (`_preclean_reference_audio`).
    Pcm16 = 0x0002,
    /// `PCM_24` (the `clone_preview` file).
    Pcm24 = 0x0003,
}

#[repr(C)]
#[derive(Default)]
struct SfInfo {
    frames: i64,
    samplerate: c_int,
    channels: c_int,
    format: c_int,
    sections: c_int,
    seekable: c_int,
}

type Sndfile = *mut c_void;

/// Decoded audio as `sf.read(..., dtype='float32', always_2d=True)` returns it: frames x channels, interleaved.
pub struct Audio {
    /// Sample rate.
    pub rate: u32,
    /// Channel count.
    pub channels: usize,
    /// Interleaved float32 samples.
    pub samples: Vec<f32>,
}

/// The loaded library.
pub struct SndFile {
    wchar_open: unsafe extern "C" fn(*const u16, c_int, *mut SfInfo) -> Sndfile,
    close: unsafe extern "C" fn(Sndfile) -> c_int,
    command: unsafe extern "C" fn(Sndfile, c_int, *mut c_void, c_int) -> c_int,
    seek: unsafe extern "C" fn(Sndfile, i64, c_int) -> i64,
    readf_float: unsafe extern "C" fn(Sndfile, *mut f32, i64) -> i64,
    writef_float: unsafe extern "C" fn(Sndfile, *const f32, i64) -> i64,
    write_sync: unsafe extern "C" fn(Sndfile),
    format_check: unsafe extern "C" fn(*const SfInfo) -> c_int,
    error: unsafe extern "C" fn(Sndfile) -> c_int,
    error_number: unsafe extern "C" fn(c_int) -> *const c_char,
}

/// An open file, closed on drop if the code did not close it.
struct Open<'a> {
    lib: &'a SndFile,
    file: Sndfile,
    info: SfInfo,
}

impl Drop for Open<'_> {
    fn drop(&mut self) {
        if !self.file.is_null() {
            // SAFETY: `file` is an open handle of this library, closed once.
            unsafe { (self.lib.close)(self.file) };
        }
    }
}

/// soundfile's `str(LibsndfileError(code, prefix))`.
fn sf_error(lib: &SndFile, code: c_int, prefix: &str) -> WorkerError {
    let text = if code == 0 {
        "(Garbled error message from libsndfile)".to_string()
    } else {
        // SAFETY: sf_error_number returns a static NUL-terminated string for any code.
        unsafe { CStr::from_ptr((lib.error_number)(code)) }.to_string_lossy().into_owned()
    };
    WorkerError::py("LibsndfileError", format!("{prefix}{text}"))
}

impl Open<'_> {
    /// `_error_check(self._errorcode)`.
    fn check(&self) -> Result<()> {
        // SAFETY: an open handle.
        match unsafe { (self.lib.error)(self.file) } {
            0 => Ok(()),
            code => Err(sf_error(self.lib, code, "")),
        }
    }

    /// `SoundFile.seek(frames, whence)`.
    fn seek(&self, frames: i64, whence: c_int) -> Result<i64> {
        // SAFETY: an open handle.
        let position = unsafe { (self.lib.seek)(self.file, frames, whence) };
        self.check()?;
        Ok(position)
    }

    fn seekable(&self) -> bool {
        self.info.seekable == SF_TRUE
    }

    /// `SoundFile.close()`: `flush()` (`sf_write_sync`), then `sf_close`.
    fn close(mut self) -> Result<()> {
        let file = std::mem::replace(&mut self.file, std::ptr::null_mut());
        // SAFETY: an open handle, closed once (`drop` sees the null).
        let err = unsafe {
            (self.lib.write_sync)(file);
            (self.lib.close)(file)
        };
        if err != 0 {
            return Err(sf_error(self.lib, err, ""));
        }
        Ok(())
    }
}

impl SndFile {
    /// Loads the pinned DLL by full path (never `PATH` or the current directory); any failure is `RUNTIME_MISSING`.
    pub fn load_pinned(dll: &Path) -> Result<SndFile> {
        use sha2::{Digest, Sha256};
        let missing = |m: String| WorkerError::new("RUNTIME_MISSING", m);
        let bytes = std::fs::read(dll).map_err(|e| missing(format!("cannot read {}: {e}", dll.display())))?;
        let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if hex != PINNED_SHA256 || !dll.is_absolute() {
            return Err(missing(format!("{} has SHA-256 {hex}, expected {PINNED_SHA256}", dll.display())));
        }
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated wide path; the flags restrict the search to the DLL's folder and System32.
        let module = unsafe {
            LoadLibraryExW(wide.as_ptr(), 0, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
        };
        if module == 0 {
            return Err(missing(format!("cannot load {}", dll.display())));
        }
        let sym = |name: &str| -> Result<*const c_void> {
            let c = format!("{name}\0");
            // SAFETY: `module` is loaded and `c` is NUL-terminated.
            let p = unsafe { GetProcAddress(module, c.as_ptr()) };
            if p.is_null() {
                Err(missing(format!("{name} is not exported by {}", dll.display())))
            } else {
                Ok(p)
            }
        };
        // SAFETY: each pointer is the export of that name, whose C signature (sndfile.h, libsndfile 1.2.2) is the field's type.
        unsafe {
            use std::mem::transmute_copy as t;
            Ok(SndFile {
                wchar_open: t(&sym("sf_wchar_open")?),
                close: t(&sym("sf_close")?),
                command: t(&sym("sf_command")?),
                seek: t(&sym("sf_seek")?),
                readf_float: t(&sym("sf_readf_float")?),
                writef_float: t(&sym("sf_writef_float")?),
                write_sync: t(&sym("sf_write_sync")?),
                format_check: t(&sym("sf_format_check")?),
                error: t(&sym("sf_error")?),
                error_number: t(&sym("sf_error_number")?),
            })
        }
    }

    /// `SoundFile(path, mode)`: `sf_wchar_open`, then `SFC_SET_CLIPPING` on.
    fn open(&self, path: &str, mode: c_int, mut info: SfInfo) -> Result<Open<'_>> {
        let wide: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated wide path and a valid SF_INFO.
        let file = unsafe { (self.wchar_open)(wide.as_ptr(), mode, &mut info) };
        if file.is_null() {
            // SAFETY: sf_error(NULL) reads the global error of the failed open.
            let code = unsafe { (self.error)(std::ptr::null_mut()) };
            return Err(sf_error(self, code, &format!("Error opening {}: ", str_repr(path))));
        }
        if mode == SFM_WRITE {
            info.frames = 0;
        }
        // SAFETY: an open handle; SFC_SET_CLIPPING takes no data.
        unsafe { (self.command)(file, SFC_SET_CLIPPING, std::ptr::null_mut(), SF_TRUE) };
        Ok(Open { lib: self, file, info })
    }

    /// `sf.read(path, dtype='float32', always_2d=True)`.
    pub fn read(&self, path: &str) -> Result<Audio> {
        let f = self.open(path, SFM_READ, SfInfo::default())?;
        // _prepare_read: seek to the start; read(): _check_frames (tell), _array_io -> _cdata_io (tell, readf, check, seek)
        if f.seekable() {
            f.seek(0, SEEK_SET)?;
        }
        let frames = if f.seekable() { f.info.frames - f.seek(0, SEEK_CUR)? } else { f.info.frames };
        let channels = f.info.channels.max(1) as usize;
        let mut samples = vec![0.0f32; frames.max(0) as usize * channels];
        let curr = if f.seekable() { f.seek(0, SEEK_CUR)? } else { 0 };
        // SAFETY: `samples` holds `frames * channels` floats.
        let read = unsafe { (self.readf_float)(f.file, samples.as_mut_ptr(), frames) };
        f.check()?;
        if f.seekable() {
            f.seek(curr + read, SEEK_SET)?;
        }
        samples.truncate(read.clamp(0, frames) as usize * channels);
        let (rate, channels) = (f.info.samplerate as u32, f.info.channels as usize);
        f.close()?;
        Ok(Audio { rate, channels, samples })
    }

    /// `sf.write(path, mono, rate, subtype)` for a float32 mono signal and a `.wav` path.
    pub fn write(&self, path: &str, mono: &[f32], rate: u32, subtype: Subtype) -> Result<()> {
        let info = SfInfo {
            samplerate: rate as c_int,
            channels: 1,
            format: SF_FORMAT_WAV | subtype as c_int,
            ..SfInfo::default()
        };
        // SAFETY: a valid SF_INFO.
        if unsafe { (self.format_check)(&info) } == 0 {
            return Err(WorkerError::py("ValueError", "Invalid combination of format, subtype and endian"));
        }
        let mut f = self.open(path, SFM_WRITE, info)?;
        // write(): _array_io -> _cdata_io (tell, writef, check, seek), then _update_frames (tell, seek end, seek back)
        let seekable = f.seekable();
        let curr = if seekable { f.seek(0, SEEK_CUR)? } else { 0 };
        // SAFETY: `mono` holds `mono.len()` frames of one channel.
        let written = unsafe { (self.writef_float)(f.file, mono.as_ptr(), mono.len() as i64) };
        f.check()?;
        if seekable {
            f.seek(curr + written, SEEK_SET)?;
            let here = f.seek(0, SEEK_CUR)?;
            f.info.frames = f.seek(0, SEEK_END)?;
            f.seek(here, SEEK_SET)?;
        }
        f.close()
    }
}
