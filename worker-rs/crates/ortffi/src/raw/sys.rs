//! Opaque ORT types, enum values and the `OrtApiBase` table. Values are copied from
//! `third_party/onnxruntime_c_api.h` (v1.31.1) and `onnxruntime_error_code.h`.

#![allow(missing_docs, non_snake_case)]

use std::ffi::c_char;
use std::marker::{PhantomData, PhantomPinned};

macro_rules! opaque {
    ($($name:ident),* $(,)?) => {$(
        #[repr(C)]
        pub struct $name {
            _data: [u8; 0],
            _marker: PhantomData<(*mut u8, PhantomPinned)>,
        }
    )*};
}

opaque!(
    OrtEnv,
    OrtStatus,
    OrtMemoryInfo,
    OrtSession,
    OrtValue,
    OrtRunOptions,
    OrtTypeInfo,
    OrtTensorTypeAndShapeInfo,
    OrtSessionOptions,
    OrtAllocator,
);

/// The ORT C API version this crate is written against (`ORT_API_VERSION`).
pub const ORT_API_VERSION: u32 = 31;
/// The ORT release this crate is pinned to.
pub const ORT_VERSION: &str = "1.31.1";

/// `struct OrtApiBase`: the only table reachable without knowing the API version.
#[repr(C)]
pub struct OrtApiBase {
    pub GetApi: unsafe extern "system" fn(version: u32) -> *const super::table::OrtApi,
    pub GetVersionString: unsafe extern "system" fn() -> *const c_char,
}

// OrtLoggingLevel
pub const ORT_LOGGING_LEVEL_WARNING: i32 = 2;

// ONNXTensorElementDataType
pub const ELEM_UNDEFINED: i32 = 0;
pub const ELEM_FLOAT: i32 = 1;
pub const ELEM_UINT8: i32 = 2;
pub const ELEM_INT8: i32 = 3;
pub const ELEM_UINT16: i32 = 4;
pub const ELEM_INT16: i32 = 5;
pub const ELEM_INT32: i32 = 6;
pub const ELEM_INT64: i32 = 7;
pub const ELEM_STRING: i32 = 8;
pub const ELEM_BOOL: i32 = 9;
pub const ELEM_FLOAT16: i32 = 10;
pub const ELEM_DOUBLE: i32 = 11;
pub const ELEM_UINT32: i32 = 12;
pub const ELEM_UINT64: i32 = 13;

// OrtAllocatorType / OrtMemType
pub const ORT_ARENA_ALLOCATOR: i32 = 1;
pub const ORT_MEM_TYPE_DEFAULT: i32 = 0;

// GraphOptimizationLevel
pub const ORT_DISABLE_ALL: i32 = 0;
pub const ORT_ENABLE_BASIC: i32 = 1;
pub const ORT_ENABLE_EXTENDED: i32 = 2;
pub const ORT_ENABLE_LAYOUT: i32 = 3;
pub const ORT_ENABLE_ALL: i32 = 99;

// ExecutionMode
pub const ORT_SEQUENTIAL: i32 = 0;
pub const ORT_PARALLEL: i32 = 1;
