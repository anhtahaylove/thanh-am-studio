//! The worker's one error type: a protocol code and a message, as `WorkerError` in `worker/main.py`.

use std::fmt;

/// A failure with the code the desktop shows or acts on (`INVALID_RECIPE`, `AUDIO_PROCESS_FAILED`, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerError {
    /// Protocol error code.
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

/// Result alias used across the worker.
pub type Result<T> = std::result::Result<T, WorkerError>;

impl WorkerError {
    /// An error with an explicit code.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    /// What Python reports for an exception that is not a `WorkerError`: `WORKER_ERROR` with `Type: text`.
    pub fn py(kind: &str, text: impl fmt::Display) -> Self {
        Self::new("WORKER_ERROR", format!("{kind}: {text}"))
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkerError {}

impl From<ortffi::Error> for WorkerError {
    fn from(error: ortffi::Error) -> Self {
        Self::new(error.worker_code(), error.to_string())
    }
}
