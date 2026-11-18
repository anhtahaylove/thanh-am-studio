// A stand-in for onnxruntime.dll, compiled by tests/load.rs with `--cfg mode="..."`.
// It exports `OrtGetApiBase` like ORT does but misbehaves in one way per mode.
use std::ffi::c_char;

#[repr(C)]
pub struct Base {
    get_api: unsafe extern "system" fn(u32) -> *const u8,
    get_version_string: unsafe extern "system" fn() -> *const c_char,
}

unsafe extern "system" fn get_api(_version: u32) -> *const u8 {
    std::ptr::null()
}

#[cfg(mode = "wrongver")]
unsafe extern "system" fn get_version_string() -> *const c_char {
    c"1.30.0".as_ptr()
}

#[cfg(not(mode = "wrongver"))]
unsafe extern "system" fn get_version_string() -> *const c_char {
    c"1.31.1".as_ptr()
}

static BASE: Base = Base { get_api, get_version_string };

#[no_mangle]
pub extern "system" fn OrtGetApiBase() -> *const Base {
    if cfg!(mode = "nullbase") {
        std::ptr::null()
    } else {
        &BASE
    }
}
