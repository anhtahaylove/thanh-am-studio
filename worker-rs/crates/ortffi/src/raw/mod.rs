//! The raw layer: every `unsafe` block of the crate lives here.
//!
//! * [`sys`] and [`table`]: the C types and the `OrtApi` function table (generated).
//! * [`loader`](Api::load): `LoadLibraryExW` by absolute path plus the ABI pin check.
//! * This file: [`Api`], whose methods are safe to call because the handle types encode what the
//!   C API requires (owned, non-null, released exactly once, borrowed data outlives its tensor).
//!   Each method maps one C call (or one tight group of calls) to a `Result`.
//!
//! The safe layer (`crate::safe`) builds only on this surface and forbids `unsafe` itself.

mod loader;
pub use loader::without_error_dialogs;
pub mod sys;
#[rustfmt::skip]
pub mod table;

use crate::error::{ErrorCode, OrtError};
use std::ffi::{c_char, c_void, CStr};
use std::marker::PhantomData;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{self, NonNull};
use sys::*;
use table::OrtApi;

/// A loaded, version-checked ONNX Runtime C API table. Copyable: the DLL is never unloaded.
#[derive(Clone, Copy)]
pub struct Api {
    table: &'static OrtApi,
}

// ---------------------------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------------------------

mod private {
    pub trait Sealed {}
}

/// Which ORT object a [`Handle`] owns, and how to release it.
pub trait Kind: private::Sealed {
    /// The opaque C type.
    type Raw;
    /// Releases `ptr`.
    ///
    /// # Safety
    /// `ptr` must be a live object of this kind that nothing uses afterwards.
    #[doc(hidden)]
    unsafe fn release(api: &OrtApi, ptr: *mut Self::Raw);
}

macro_rules! kind {
    ($(#[$doc:meta])* $name:ident, $raw:ty, $release:ident) => {
        $(#[$doc])*
        pub enum $name {}
        impl private::Sealed for $name {}
        impl Kind for $name {
            type Raw = $raw;
            unsafe fn release(api: &OrtApi, ptr: *mut $raw) {
                // SAFETY: the caller guarantees `ptr` is live and unused afterwards.
                unsafe { (api.$release)(ptr) }
            }
        }
    };
}

kind!(/** `OrtEnv`. */ EnvKind, OrtEnv, ReleaseEnv);
kind!(/** `OrtSessionOptions`. */ SessionOptionsKind, OrtSessionOptions, ReleaseSessionOptions);
kind!(/** `OrtSession`. */ SessionKind, OrtSession, ReleaseSession);
kind!(/** `OrtValue`. */ ValueKind, OrtValue, ReleaseValue);
kind!(/** `OrtMemoryInfo`. */ MemoryInfoKind, OrtMemoryInfo, ReleaseMemoryInfo);
kind!(/** `OrtTypeInfo`. */ TypeInfoKind, OrtTypeInfo, ReleaseTypeInfo);
kind!(/** `OrtTensorTypeAndShapeInfo`. */ TensorInfoKind, OrtTensorTypeAndShapeInfo, ReleaseTensorTypeAndShapeInfo);

/// An owned, non-null ORT object, released on drop. `'a` is the lifetime of host memory the
/// object borrows (tensors made by [`Api::create_tensor`]); owned objects are `'static`.
pub struct Handle<'a, K: Kind> {
    ptr: NonNull<K::Raw>,
    api: Api,
    _borrow: PhantomData<(&'a (), K)>,
}

impl<K: Kind> Drop for Handle<'_, K> {
    fn drop(&mut self) {
        // SAFETY: the handle owns `ptr` (it came from the matching ORT create call), and `drop`
        // runs once, so the object is released exactly once and never used afterwards.
        unsafe { K::release(self.api.table, self.ptr.as_ptr()) }
    }
}

// Thread-safety as documented for the ORT C API: `OrtEnv`, `OrtSession` (`Run` may be called
// concurrently) and `OrtMemoryInfo` (immutable) are `Send + Sync`; `OrtSessionOptions` and
// `OrtValue` may move between threads but need external synchronisation for concurrent use, so
// they are `Send` only. Type and shape infos stay `!Send`.
// SAFETY: see above.
unsafe impl Send for Handle<'_, EnvKind> {}
// SAFETY: see above.
unsafe impl Sync for Handle<'_, EnvKind> {}
// SAFETY: see above.
unsafe impl Send for Handle<'_, SessionKind> {}
// SAFETY: see above.
unsafe impl Sync for Handle<'_, SessionKind> {}
// SAFETY: see above.
unsafe impl Send for Handle<'_, MemoryInfoKind> {}
// SAFETY: see above.
unsafe impl Sync for Handle<'_, MemoryInfoKind> {}
// SAFETY: see above.
unsafe impl Send for Handle<'_, SessionOptionsKind> {}
// SAFETY: see above.
unsafe impl Send for Handle<'_, ValueKind> {}

// ---------------------------------------------------------------------------------------------
// Element types
// ---------------------------------------------------------------------------------------------

/// `ONNXTensorElementDataType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElementType {
    /// `UNDEFINED`
    Undefined,
    /// `FLOAT` (f32)
    F32,
    /// `UINT8`
    U8,
    /// `INT8`
    I8,
    /// `UINT16`
    U16,
    /// `INT16`
    I16,
    /// `INT32`
    I32,
    /// `INT64`
    I64,
    /// `STRING`
    String,
    /// `BOOL`
    Bool,
    /// `FLOAT16`
    F16,
    /// `DOUBLE` (f64)
    F64,
    /// `UINT32`
    U32,
    /// `UINT64`
    U64,
    /// Any other `ONNXTensorElementDataType` value.
    Other(i32),
}

impl ElementType {
    fn from_raw(raw: i32) -> Self {
        match raw {
            ELEM_UNDEFINED => Self::Undefined,
            ELEM_FLOAT => Self::F32,
            ELEM_UINT8 => Self::U8,
            ELEM_INT8 => Self::I8,
            ELEM_UINT16 => Self::U16,
            ELEM_INT16 => Self::I16,
            ELEM_INT32 => Self::I32,
            ELEM_INT64 => Self::I64,
            ELEM_STRING => Self::String,
            ELEM_BOOL => Self::Bool,
            ELEM_FLOAT16 => Self::F16,
            ELEM_DOUBLE => Self::F64,
            ELEM_UINT32 => Self::U32,
            ELEM_UINT64 => Self::U64,
            other => Self::Other(other),
        }
    }

    fn to_raw(self) -> i32 {
        match self {
            Self::Undefined => ELEM_UNDEFINED,
            Self::F32 => ELEM_FLOAT,
            Self::U8 => ELEM_UINT8,
            Self::I8 => ELEM_INT8,
            Self::U16 => ELEM_UINT16,
            Self::I16 => ELEM_INT16,
            Self::I32 => ELEM_INT32,
            Self::I64 => ELEM_INT64,
            Self::String => ELEM_STRING,
            Self::Bool => ELEM_BOOL,
            Self::F16 => ELEM_FLOAT16,
            Self::F64 => ELEM_DOUBLE,
            Self::U32 => ELEM_UINT32,
            Self::U64 => ELEM_UINT64,
            Self::Other(raw) => raw,
        }
    }
}

/// A Rust type with the same in-memory layout as one ONNX tensor element type.
///
/// # Safety
/// `Self` must be a plain-old-data type whose bytes are exactly one element of `ELEMENT`
/// (size, alignment and bit patterns), with no padding and no invalid bit patterns.
pub unsafe trait Element: Copy + 'static {
    /// The matching ONNX element type.
    const ELEMENT: ElementType;
}

// SAFETY: IEEE-754 binary32 is ONNX FLOAT.
unsafe impl Element for f32 {
    const ELEMENT: ElementType = ElementType::F32;
}
// SAFETY: two's-complement 64-bit integers are ONNX INT64.
unsafe impl Element for i64 {
    const ELEMENT: ElementType = ElementType::I64;
}
// SAFETY: two's-complement 32-bit integers are ONNX INT32.
unsafe impl Element for i32 {
    const ELEMENT: ElementType = ElementType::I32;
}

/// Element type and shape of a tensor. A dynamic dimension is -1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TensorInfo {
    /// The element type.
    pub element: ElementType,
    /// The dimensions.
    pub shape: Vec<i64>,
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

fn lossy(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: ORT returns NUL-terminated strings; the caller keeps the owner alive during this call.
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

fn element_count(shape: &[i64]) -> Option<usize> {
    shape.iter().try_fold(1usize, |n, &d| n.checked_mul(usize::try_from(d).ok()?))
}

impl Api {
    /// Turns an `OrtStatus*` into a `Result` and releases the status.
    fn check(&self, status: *mut OrtStatus) -> Result<(), OrtError> {
        if status.is_null() {
            return Ok(());
        }
        // SAFETY: `status` is a live non-null status that this function owns and releases below.
        let (code, message) = unsafe {
            let code = (self.table.GetErrorCode)(status);
            let message = lossy((self.table.GetErrorMessage)(status));
            (self.table.ReleaseStatus)(status);
            (code, message)
        };
        Err(OrtError { code: ErrorCode::from_raw(code), message })
    }

    /// Wraps a pointer ORT just handed over; a null here would be an ORT bug, reported as an error.
    fn adopt<'a, K: Kind>(&self, ptr: *mut K::Raw) -> Result<Handle<'a, K>, OrtError> {
        NonNull::new(ptr)
            .map(|ptr| Handle { ptr, api: *self, _borrow: PhantomData })
            .ok_or(OrtError { code: ErrorCode::Fail, message: "ORT returned a null handle".into() })
    }

    /// `CreateEnv` with a warning log level.
    pub fn create_env(&self, logid: &CStr) -> Result<Handle<'static, EnvKind>, OrtError> {
        let mut out = ptr::null_mut();
        // SAFETY: `logid` is NUL-terminated; `out` is a valid out-pointer.
        self.check(unsafe { (self.table.CreateEnv)(ORT_LOGGING_LEVEL_WARNING, logid.as_ptr(), &mut out) })?;
        self.adopt(out)
    }

    /// `CreateSessionOptions`.
    pub fn create_session_options(&self) -> Result<Handle<'static, SessionOptionsKind>, OrtError> {
        let mut out = ptr::null_mut();
        // SAFETY: `out` is a valid out-pointer.
        self.check(unsafe { (self.table.CreateSessionOptions)(&mut out) })?;
        self.adopt(out)
    }

    /// `SetIntraOpNumThreads`.
    pub fn set_intra_op_threads(&self, o: &mut Handle<'_, SessionOptionsKind>, n: i32) -> Result<(), OrtError> {
        // SAFETY: `o` is a live options handle.
        self.check(unsafe { (self.table.SetIntraOpNumThreads)(o.ptr.as_ptr(), n) })
    }

    /// `SetInterOpNumThreads`.
    pub fn set_inter_op_threads(&self, o: &mut Handle<'_, SessionOptionsKind>, n: i32) -> Result<(), OrtError> {
        // SAFETY: `o` is a live options handle.
        self.check(unsafe { (self.table.SetInterOpNumThreads)(o.ptr.as_ptr(), n) })
    }

    /// `SetSessionGraphOptimizationLevel` (`GraphOptimizationLevel` value).
    pub fn set_graph_optimization_level(
        &self,
        o: &mut Handle<'_, SessionOptionsKind>,
        level: i32,
    ) -> Result<(), OrtError> {
        // SAFETY: `o` is a live options handle.
        self.check(unsafe { (self.table.SetSessionGraphOptimizationLevel)(o.ptr.as_ptr(), level) })
    }

    /// `SetSessionExecutionMode` (`ExecutionMode` value).
    pub fn set_execution_mode(&self, o: &mut Handle<'_, SessionOptionsKind>, mode: i32) -> Result<(), OrtError> {
        // SAFETY: `o` is a live options handle.
        self.check(unsafe { (self.table.SetSessionExecutionMode)(o.ptr.as_ptr(), mode) })
    }

    /// `EnableCpuMemArena` / `DisableCpuMemArena`.
    pub fn set_cpu_mem_arena(&self, o: &mut Handle<'_, SessionOptionsKind>, enabled: bool) -> Result<(), OrtError> {
        let f = if enabled { self.table.EnableCpuMemArena } else { self.table.DisableCpuMemArena };
        // SAFETY: `o` is a live options handle.
        self.check(unsafe { f(o.ptr.as_ptr()) })
    }

    /// `SetSessionLogSeverityLevel` (0 verbose .. 4 fatal).
    pub fn set_log_severity_level(&self, o: &mut Handle<'_, SessionOptionsKind>, level: i32) -> Result<(), OrtError> {
        // SAFETY: `o` is a live options handle.
        self.check(unsafe { (self.table.SetSessionLogSeverityLevel)(o.ptr.as_ptr(), level) })
    }

    /// `AddSessionConfigEntry`, e.g. `session.intra_op.allow_spinning` = `0`.
    pub fn add_config_entry(
        &self,
        o: &mut Handle<'_, SessionOptionsKind>,
        key: &CStr,
        value: &CStr,
    ) -> Result<(), OrtError> {
        // SAFETY: `o` is live; both strings are NUL-terminated.
        self.check(unsafe { (self.table.AddSessionConfigEntry)(o.ptr.as_ptr(), key.as_ptr(), value.as_ptr()) })
    }

    /// `CreateSession` from a model file. The path goes to ORT as UTF-16.
    pub fn create_session(
        &self,
        env: &Handle<'_, EnvKind>,
        model: &Path,
        options: &Handle<'_, SessionOptionsKind>,
    ) -> Result<Handle<'static, SessionKind>, OrtError> {
        let wide: Vec<u16> = model.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        if wide[..wide.len() - 1].contains(&0) {
            return Err(OrtError::invalid_argument("model path contains a NUL"));
        }
        let mut out = ptr::null_mut();
        // SAFETY: env and options are live; `wide` is NUL-terminated and outlives the call.
        self.check(unsafe {
            (self.table.CreateSession)(env.ptr.as_ptr(), wide.as_ptr(), options.ptr.as_ptr(), &mut out)
        })?;
        self.adopt(out)
    }

    /// Number of inputs or outputs.
    pub fn session_io_count(&self, s: &Handle<'_, SessionKind>, inputs: bool) -> Result<usize, OrtError> {
        let f = if inputs { self.table.SessionGetInputCount } else { self.table.SessionGetOutputCount };
        let mut n = 0usize;
        // SAFETY: `s` is live; `n` is a valid out-pointer.
        self.check(unsafe { f(s.ptr.as_ptr(), &mut n) })?;
        Ok(n)
    }

    /// Name of input or output `index`, copied out of ORT's allocation (which is freed here).
    pub fn session_io_name(&self, s: &Handle<'_, SessionKind>, index: usize, inputs: bool) -> Result<String, OrtError> {
        let f = if inputs { self.table.SessionGetInputName } else { self.table.SessionGetOutputName };
        let mut allocator = ptr::null_mut();
        // SAFETY: valid out-pointer; the default allocator is process-global and not owned by us.
        self.check(unsafe { (self.table.GetAllocatorWithDefaultOptions)(&mut allocator) })?;
        let mut name: *mut c_char = ptr::null_mut();
        // SAFETY: `s` is live; the allocator is the default one; `name` is a valid out-pointer.
        self.check(unsafe { f(s.ptr.as_ptr(), index, allocator, &mut name) })?;
        let text = lossy(name);
        if !name.is_null() {
            // SAFETY: `name` was allocated by this same allocator and is not used afterwards.
            self.check(unsafe { (self.table.AllocatorFree)(allocator, name.cast::<c_void>()) })?;
        }
        Ok(text)
    }

    /// Element type and shape of input or output `index`; `None` if it is not a tensor.
    pub fn session_io_info(
        &self,
        s: &Handle<'_, SessionKind>,
        index: usize,
        inputs: bool,
    ) -> Result<Option<TensorInfo>, OrtError> {
        let f = if inputs { self.table.SessionGetInputTypeInfo } else { self.table.SessionGetOutputTypeInfo };
        let mut type_info = ptr::null_mut();
        // SAFETY: `s` is live; `type_info` is a valid out-pointer.
        self.check(unsafe { f(s.ptr.as_ptr(), index, &mut type_info) })?;
        let type_info: Handle<'_, TypeInfoKind> = self.adopt(type_info)?;
        let mut tensor = ptr::null();
        // SAFETY: `type_info` is live; `tensor` is a valid out-pointer.
        self.check(unsafe { (self.table.CastTypeInfoToTensorInfo)(type_info.ptr.as_ptr(), &mut tensor) })?;
        if tensor.is_null() {
            return Ok(None);
        }
        // SAFETY: `tensor` is owned by `type_info`, which outlives this call.
        unsafe { self.read_tensor_info(tensor) }.map(Some)
    }

    /// # Safety
    /// `info` must point to a live `OrtTensorTypeAndShapeInfo`.
    unsafe fn read_tensor_info(&self, info: *const OrtTensorTypeAndShapeInfo) -> Result<TensorInfo, OrtError> {
        let mut raw_type = 0i32;
        let mut rank = 0usize;
        // SAFETY: `info` is live (caller); the out-pointers are valid.
        self.check(unsafe { (self.table.GetTensorElementType)(info, &mut raw_type) })?;
        // SAFETY: as above.
        self.check(unsafe { (self.table.GetDimensionsCount)(info, &mut rank) })?;
        let mut shape = vec![0i64; rank];
        // SAFETY: `shape` has room for `rank` values.
        self.check(unsafe { (self.table.GetDimensions)(info, shape.as_mut_ptr(), rank) })?;
        Ok(TensorInfo { element: ElementType::from_raw(raw_type), shape })
    }

    /// `CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault)`.
    pub fn create_cpu_memory_info(&self) -> Result<Handle<'static, MemoryInfoKind>, OrtError> {
        let mut out = ptr::null_mut();
        // SAFETY: `out` is a valid out-pointer.
        self.check(unsafe { (self.table.CreateCpuMemoryInfo)(ORT_ARENA_ALLOCATOR, ORT_MEM_TYPE_DEFAULT, &mut out) })?;
        self.adopt(out)
    }

    /// `CreateTensorWithDataAsOrtValue`: a tensor that reads `data` in place (no copy).
    /// The tensor borrows `data` for `'a`. ORT only reads input tensors.
    pub fn create_tensor<'a, T: Element>(
        &self,
        memory: &Handle<'_, MemoryInfoKind>,
        data: &'a [T],
        shape: &[i64],
    ) -> Result<Handle<'a, ValueKind>, OrtError> {
        if element_count(shape) != Some(data.len()) {
            return Err(OrtError::invalid_argument(format!("shape {shape:?} does not match {} elements", data.len())));
        }
        let mut out = ptr::null_mut();
        // SAFETY: `memory` is live; `data` and `shape` are valid for the lengths passed and, by the
        // `'a` on the returned handle, outlive the tensor. The `*mut` cast is only a C signature
        // artefact: ORT does not write through an input tensor's data.
        self.check(unsafe {
            (self.table.CreateTensorWithDataAsOrtValue)(
                memory.ptr.as_ptr(),
                data.as_ptr().cast_mut().cast::<c_void>(),
                std::mem::size_of_val(data),
                shape.as_ptr(),
                shape.len(),
                T::ELEMENT.to_raw(),
                &mut out,
            )
        })?;
        self.adopt(out)
    }

    /// `Run` with ORT-allocated outputs, one per name in `output_names`.
    pub fn run(
        &self,
        session: &Handle<'_, SessionKind>,
        input_names: &[&CStr],
        inputs: &[&Handle<'_, ValueKind>],
        output_names: &[&CStr],
    ) -> Result<Vec<Handle<'static, ValueKind>>, OrtError> {
        if input_names.len() != inputs.len() {
            return Err(OrtError::invalid_argument("input names and values differ in length"));
        }
        let names_in: Vec<*const c_char> = input_names.iter().map(|n| n.as_ptr()).collect();
        let values_in: Vec<*const OrtValue> = inputs.iter().map(|v| v.ptr.as_ptr().cast_const()).collect();
        let names_out: Vec<*const c_char> = output_names.iter().map(|n| n.as_ptr()).collect();
        let mut values_out: Vec<*mut OrtValue> = vec![ptr::null_mut(); output_names.len()];
        // SAFETY: all pointer arrays have the lengths passed; names are NUL-terminated and values
        // are live for the call; null outputs ask ORT to allocate them.
        let status = unsafe {
            (self.table.Run)(
                session.ptr.as_ptr(),
                ptr::null(),
                names_in.as_ptr(),
                values_in.as_ptr(),
                inputs.len(),
                names_out.as_ptr(),
                output_names.len(),
                values_out.as_mut_ptr(),
            )
        };
        // Adopt whatever ORT returned first so that every non-null output is released on all paths.
        let outputs: Vec<Handle<'static, ValueKind>> =
            values_out.into_iter().filter_map(|p| self.adopt(p).ok()).collect();
        self.check(status)?;
        if outputs.len() != output_names.len() {
            return Err(OrtError { code: ErrorCode::Fail, message: "Run returned a null output".into() });
        }
        Ok(outputs)
    }

    /// Element type and shape of a tensor value.
    pub fn tensor_info(&self, value: &Handle<'_, ValueKind>) -> Result<TensorInfo, OrtError> {
        let mut is_tensor = 0i32;
        // SAFETY: `value` is live; `is_tensor` is a valid out-pointer.
        self.check(unsafe { (self.table.IsTensor)(value.ptr.as_ptr(), &mut is_tensor) })?;
        if is_tensor == 0 {
            return Err(OrtError::invalid_argument("value is not a tensor"));
        }
        let mut info = ptr::null_mut();
        // SAFETY: `value` is a live tensor; `info` is a valid out-pointer.
        self.check(unsafe { (self.table.GetTensorTypeAndShape)(value.ptr.as_ptr(), &mut info) })?;
        let info: Handle<'_, TensorInfoKind> = self.adopt(info)?;
        // SAFETY: `info` is live until the end of this function.
        unsafe { self.read_tensor_info(info.ptr.as_ptr()) }
    }

    /// The tensor's elements as a slice, if its element type is `T`.
    pub fn tensor_data<'v, T: Element>(&self, value: &'v Handle<'_, ValueKind>) -> Result<&'v [T], OrtError> {
        let info = self.tensor_info(value)?;
        if info.element != T::ELEMENT {
            return Err(OrtError::invalid_argument(format!("tensor holds {:?}, not {:?}", info.element, T::ELEMENT)));
        }
        let len = element_count(&info.shape)
            .ok_or_else(|| OrtError::invalid_argument("tensor has a dynamic or overflowing shape"))?;
        if len == 0 {
            return Ok(&[]);
        }
        let mut data = ptr::null_mut();
        // SAFETY: `value` is a live tensor; `data` is a valid out-pointer.
        self.check(unsafe { (self.table.GetTensorMutableData)(value.ptr.as_ptr(), &mut data) })?;
        let data = data.cast::<T>();
        if data.is_null() || data.align_offset(std::mem::align_of::<T>()) != 0 {
            return Err(OrtError { code: ErrorCode::Fail, message: "tensor data is null or misaligned".into() });
        }
        // SAFETY: ORT owns `len` initialised elements of type `T` (checked against the tensor's
        // element type and shape above) at `data`; they live as long as `value`, which `'v` borrows.
        Ok(unsafe { std::slice::from_raw_parts(data, len) })
    }
}
