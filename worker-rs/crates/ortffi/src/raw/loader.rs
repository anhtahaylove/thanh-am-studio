//! `LoadLibraryExW` of one DLL by absolute path, then the ABI pin check.

use super::sys::{OrtApiBase, ORT_API_VERSION, ORT_VERSION};
use super::Api;
use crate::error::LoadError;
use std::ffi::{c_char, c_void, CStr};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

/// Search the DLL's own directory, then System32 only (no PATH, no current directory).
/// `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`; both need an absolute path.
const LOAD_FLAGS: u32 = 0x0000_0100 | 0x0000_0800;
const ERROR_INVALID_NAME: u32 = 123;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(file_name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    fn GetLastError() -> u32;
}

type GetApiBaseFn = unsafe extern "system" fn() -> *const OrtApiBase;

impl Api {
    /// Loads `dll` (an absolute path) and checks that it is ONNX Runtime 1.31.1 with C API 31.
    ///
    /// The DLL stays loaded for the life of the process: ORT owns thread pools that must not
    /// outlive their code, so there is no unload.
    pub fn load(dll: &Path) -> Result<Api, LoadError> {
        if !dll.is_absolute() {
            return Err(LoadError::NotAbsolute(dll.to_path_buf()));
        }
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let failed = |os_error| LoadError::LoadFailed { path: dll.to_path_buf(), os_error };
        if wide[..wide.len() - 1].contains(&0) {
            return Err(failed(ERROR_INVALID_NAME));
        }
        // SAFETY: `wide` is NUL-terminated and outlives the call; the file handle must be null.
        let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_FLAGS) };
        if module.is_null() {
            // SAFETY: plain thread-local error read right after the failed call.
            return Err(failed(unsafe { GetLastError() }));
        }
        // SAFETY: `module` is a live module handle and the name is a NUL-terminated literal.
        let sym = unsafe { GetProcAddress(module, c"OrtGetApiBase".as_ptr()) };
        if sym.is_null() {
            return Err(LoadError::MissingExport(dll.to_path_buf()));
        }
        // SAFETY: `OrtGetApiBase` is `const OrtApiBase* ORT_API_CALL (void)`, which is `GetApiBaseFn`.
        let get_base: GetApiBaseFn = unsafe { std::mem::transmute::<*mut c_void, GetApiBaseFn>(sym) };
        // SAFETY: the export takes no arguments and returns a pointer to a static table or null.
        let base = unsafe { get_base().as_ref() }.ok_or_else(|| LoadError::BadApiBase(dll.to_path_buf()))?;
        // SAFETY: `GetVersionString` takes no arguments and returns a static NUL-terminated string or null.
        let version_ptr = unsafe { (base.GetVersionString)() };
        if version_ptr.is_null() {
            return Err(LoadError::BadApiBase(dll.to_path_buf()));
        }
        // SAFETY: non-null and NUL-terminated, owned by the (never unloaded) DLL.
        let version =
            unsafe { CStr::from_ptr(version_ptr) }.to_str().map_err(|_| LoadError::BadApiBase(dll.to_path_buf()))?;
        if version != ORT_VERSION {
            return Err(LoadError::VersionMismatch {
                path: dll.to_path_buf(),
                found: version.to_owned(),
                expected: ORT_VERSION,
            });
        }
        // SAFETY: a plain call; ORT returns null for an API version it does not provide.
        let table = unsafe { (base.GetApi)(ORT_API_VERSION).as_ref() };
        match table {
            // SAFETY of the lifetime: the table lives in the DLL, which is never unloaded.
            Some(table) => Ok(Api { table }),
            None => Err(LoadError::ApiUnavailable { path: dll.to_path_buf(), api_version: ORT_API_VERSION }),
        }
    }
}
