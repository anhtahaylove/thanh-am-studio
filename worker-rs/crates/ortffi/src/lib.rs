//! Minimal ONNX Runtime 1.31.1 bindings, loaded dynamically from one DLL path.
//!
//! * [`raw`]: hand-written FFI over `OrtApiBase`/`OrtApi`. All `unsafe` code is in this module.
//! * [`safe`]: RAII wrappers ([`Env`], [`SessionOptions`], [`Session`], [`Value`]) with
//!   `#![forbid(unsafe_code)]`.
//! * [`error`]: [`LoadError`] (maps to `RUNTIME_MISSING`), [`OrtError`] (ORT's code and message).
//!
//! Windows only: the runtime is loaded with `LoadLibraryExW`.

#[cfg(not(windows))]
compile_error!("ortffi supports Windows only");

pub mod error;
pub mod raw;
pub mod safe;

pub use error::{Error, ErrorCode, LoadError, OrtError, RUNTIME_MISSING, WORKER_ERROR};
pub use raw::sys::{ORT_API_VERSION, ORT_VERSION};
pub use raw::{without_error_dialogs, Element, ElementType, TensorInfo};
pub use safe::{Env, ExecutionMode, GraphOptimizationLevel, IoInfo, Session, SessionOptions, Value};
