//! The OpenBLAS DLL that numpy 2.4.6 ships (`numpy.libs\libscipy_openblas64_*.dll`), loaded dynamically, and the one routine numpy's
//! `matmul` calls for `vector @ matrix.T` (`matmul.c.src` `@TYPE@_gemv`: `cblas_sgemv(ColMajor, Trans, N, M, 1, A, lda, x, 1, 0, y, 1)`).
//!
//! Loading the same DLL (not a re-implementation) gives the same CPU-specific kernel (DYNAMIC_ARCH picks by CPUID) and the same
//! multi-threading split as Python, so the products are bitwise the same. The DLL is never unloaded.
//!
//! During coexistence the worker loads the very file Python uses (`<runtime>\Lib\site-packages\numpy.libs\libscipy_openblas64_-<hash>.dll`)
//! by full path, after checking its SHA-256 against the pin below. A missing, unreadable or different file is `RUNTIME_MISSING`
//! (the worker's Python-fallback trigger). A copy ships next to the exe only at A5.

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

/// SHA-256 of numpy 2.4.6's `libscipy_openblas64_-63c857e738469261263c764a36be9436.dll` (OpenBLAS 0.3.31.188.0, ILP64, DYNAMIC_ARCH).
pub const PINNED_SHA256: &str = "63c857e738469261263c764a36be9436ebdeaa272e340a828f42047a97131080";
/// The worker error code a missing or mismatched runtime file maps to.
pub const RUNTIME_MISSING: &str = "RUNTIME_MISSING";

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}

const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x100;
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;
const CBLAS_COL_MAJOR: i32 = 102;
const CBLAS_TRANS: i32 = 112;

type Sgemv = unsafe extern "C" fn(i32, i32, i64, i64, f32, *const f32, i64, *const f32, i64, f32, *mut f32, i64);

/// A loaded numpy OpenBLAS (ILP64, `scipy_` prefix).
pub struct OpenBlas {
    sgemv: Sgemv,
}

fn bad(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, msg)
}

impl OpenBlas {
    /// Loads the pinned DLL: the file must exist, hash to [`PINNED_SHA256`], then loads from its own folder (never `PATH` or the
    /// current directory). Every failure carries [`RUNTIME_MISSING`] in its message prefix.
    pub fn load_pinned(dll: &Path) -> io::Result<OpenBlas> {
        use sha2::{Digest, Sha256};
        let bytes =
            std::fs::read(dll).map_err(|e| bad(format!("{RUNTIME_MISSING}: cannot read {}: {e}", dll.display())))?;
        let hex: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if hex != PINNED_SHA256 {
            return Err(bad(format!(
                "{RUNTIME_MISSING}: {} has SHA-256 {hex}, expected {PINNED_SHA256}",
                dll.display()
            )));
        }
        Self::load(dll).map_err(|e| bad(format!("{RUNTIME_MISSING}: {e}")))
    }

    /// Loads the DLL at an absolute path, without the hash check.
    fn load(dll: &Path) -> io::Result<OpenBlas> {
        if !dll.is_absolute() {
            return Err(bad(format!("{} is not an absolute path", dll.display())));
        }
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated wide path; the flags restrict the search to the DLL's folder and System32.
        let module = ortffi::without_error_dialogs(|| unsafe {
            LoadLibraryExW(wide.as_ptr(), 0, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
        });
        if module == 0 {
            return Err(bad(format!("cannot load {}", dll.display())));
        }
        let sym = |name: &str| -> io::Result<*const c_void> {
            let c = format!("{name}\0");
            // SAFETY: `module` is a loaded module and `c` is NUL-terminated.
            let p = unsafe { GetProcAddress(module, c.as_ptr()) };
            if p.is_null() {
                Err(bad(format!("{name} is not exported by {}", dll.display())))
            } else {
                Ok(p)
            }
        };
        // SAFETY: the signatures are those of the exported ILP64 symbols (cblas.h of OpenBLAS 0.3.31 with `-DOPENBLAS_USE64BITINT`).
        unsafe { Ok(OpenBlas { sgemv: std::mem::transmute::<*const c_void, Sgemv>(sym("scipy_cblas_sgemv64_")?) }) }
    }

    /// `out = x @ m.T` where `m` is a row-major `rows x cols` matrix, `x` has `cols` elements and `out` has `rows`
    /// (numpy: `x @ m.T` with a C-contiguous `m`, which `matmul` hands to `cblas_sgemv(ColMajor, Trans, cols, rows, ...)`).
    pub fn vec_mat_t(&self, m: &[f32], rows: usize, cols: usize, x: &[f32], out: &mut [f32]) {
        assert!(m.len() == rows * cols && x.len() == cols && out.len() == rows);
        // SAFETY: the slices have the lengths the call reads and writes (checked above); lda = cols.
        unsafe {
            (self.sgemv)(
                CBLAS_COL_MAJOR,
                CBLAS_TRANS,
                cols as i64,
                rows as i64,
                1.0,
                m.as_ptr(),
                cols as i64,
                x.as_ptr(),
                1,
                0.0,
                out.as_mut_ptr(),
                1,
            );
        }
    }
}
