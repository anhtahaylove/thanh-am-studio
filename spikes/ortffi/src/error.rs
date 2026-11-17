//! Error types. Plain data: no `unsafe`, no ORT calls.

use std::fmt;
use std::path::PathBuf;

/// Error code the worker reports when the ONNX Runtime cannot be loaded or has the wrong ABI.
pub const RUNTIME_MISSING: &str = "RUNTIME_MISSING";
/// Error code the worker reports for any other failure of an ORT call.
pub const WORKER_ERROR: &str = "WORKER_ERROR";

/// `OrtErrorCode` from `onnxruntime_error_code.h`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    /// `ORT_FAIL`
    Fail,
    /// `ORT_INVALID_ARGUMENT`
    InvalidArgument,
    /// `ORT_NO_SUCHFILE`
    NoSuchFile,
    /// `ORT_NO_MODEL`
    NoModel,
    /// `ORT_ENGINE_ERROR`
    EngineError,
    /// `ORT_RUNTIME_EXCEPTION`
    RuntimeException,
    /// `ORT_INVALID_PROTOBUF`
    InvalidProtobuf,
    /// `ORT_MODEL_LOADED`
    ModelLoaded,
    /// `ORT_NOT_IMPLEMENTED`
    NotImplemented,
    /// `ORT_INVALID_GRAPH`
    InvalidGraph,
    /// `ORT_EP_FAIL`
    EpFail,
    /// `ORT_MODEL_LOAD_CANCELED`
    ModelLoadCanceled,
    /// `ORT_MODEL_REQUIRES_COMPILATION`
    ModelRequiresCompilation,
    /// `ORT_NOT_FOUND`
    NotFound,
    /// `ORT_DEVICE_RESET`
    DeviceReset,
    /// A value outside the table above, or an error raised by this crate before ORT was called.
    Other(i32),
}

impl ErrorCode {
    pub(crate) fn from_raw(code: i32) -> Self {
        match code {
            1 => Self::Fail,
            2 => Self::InvalidArgument,
            3 => Self::NoSuchFile,
            4 => Self::NoModel,
            5 => Self::EngineError,
            6 => Self::RuntimeException,
            7 => Self::InvalidProtobuf,
            8 => Self::ModelLoaded,
            9 => Self::NotImplemented,
            10 => Self::InvalidGraph,
            11 => Self::EpFail,
            12 => Self::ModelLoadCanceled,
            13 => Self::ModelRequiresCompilation,
            14 => Self::NotFound,
            15 => Self::DeviceReset,
            other => Self::Other(other),
        }
    }
}

/// A failed ORT call (or a precondition this crate checks before calling): ORT's code and message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrtError {
    /// ORT's error code.
    pub code: ErrorCode,
    /// ORT's message, lossily decoded from UTF-8.
    pub message: String,
}

impl OrtError {
    pub(crate) fn invalid_argument(message: impl Into<String>) -> Self {
        Self { code: ErrorCode::InvalidArgument, message: message.into() }
    }

    /// The worker error code for this failure.
    pub fn worker_code(&self) -> &'static str {
        WORKER_ERROR
    }
}

impl fmt::Display for OrtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "onnxruntime error {:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for OrtError {}

/// The runtime DLL could not be used. Every variant maps to [`RUNTIME_MISSING`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadError {
    /// The path is not absolute. The loader never searches the system.
    NotAbsolute(PathBuf),
    /// `LoadLibraryExW` failed (missing file, not a PE file, missing dependency, ...).
    LoadFailed {
        /// The DLL path.
        path: PathBuf,
        /// `GetLastError()` after the failed call.
        os_error: u32,
    },
    /// The DLL has no `OrtGetApiBase` export, so it is not an ONNX Runtime.
    MissingExport(PathBuf),
    /// `OrtGetApiBase` returned null, or the version string was null or not UTF-8.
    BadApiBase(PathBuf),
    /// The DLL reports another release than the pinned one.
    VersionMismatch {
        /// The DLL path.
        path: PathBuf,
        /// What `GetVersionString` returned.
        found: String,
        /// The pinned release.
        expected: &'static str,
    },
    /// `GetApi(31)` returned null: the DLL is older than API version 31.
    ApiUnavailable {
        /// The DLL path.
        path: PathBuf,
        /// The requested API version.
        api_version: u32,
    },
}

impl LoadError {
    /// The worker error code for this failure: always [`RUNTIME_MISSING`].
    pub fn worker_code(&self) -> &'static str {
        RUNTIME_MISSING
    }
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute(p) => write!(f, "runtime path is not absolute: {}", p.display()),
            Self::LoadFailed { path, os_error } => {
                write!(f, "cannot load {} (Windows error {os_error})", path.display())
            }
            Self::MissingExport(p) => write!(f, "{} has no OrtGetApiBase export", p.display()),
            Self::BadApiBase(p) => write!(f, "{} returned an unusable OrtApiBase", p.display()),
            Self::VersionMismatch { path, found, expected } => {
                write!(f, "{} is onnxruntime {found}, expected {expected}", path.display())
            }
            Self::ApiUnavailable { path, api_version } => {
                write!(f, "{} does not provide C API version {api_version}", path.display())
            }
        }
    }
}

impl std::error::Error for LoadError {}

/// Anything the safe layer can fail with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The runtime could not be loaded ([`RUNTIME_MISSING`]).
    Load(LoadError),
    /// An ORT call failed ([`WORKER_ERROR`]).
    Ort(OrtError),
}

impl Error {
    /// The worker error code: `RUNTIME_MISSING` for load failures, `WORKER_ERROR` otherwise.
    pub fn worker_code(&self) -> &'static str {
        match self {
            Self::Load(e) => e.worker_code(),
            Self::Ort(e) => e.worker_code(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Load(e) => e.fmt(f),
            Self::Ort(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

impl From<LoadError> for Error {
    fn from(e: LoadError) -> Self {
        Self::Load(e)
    }
}

impl From<OrtError> for Error {
    fn from(e: OrtError) -> Self {
        Self::Ort(e)
    }
}
