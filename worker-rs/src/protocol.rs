//! Protocol v1: one JSON request on stdin, JSON-lines events on stdout, exactly one terminal event.
//!
//! The request checks, the event shapes and the error codes are those of `main()` in `worker/main.py` (row R).

use crate::error::{Result, WorkerError};
use crate::paths::resolve;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// A request line longer than this many characters is refused.
const MAX_REQUEST_CHARS: usize = 4 * 1024 * 1024;

const OPERATIONS: &[&str] = &["health", "probe", "tts", "stt", "render", "download", "clone_preview", "separate"];

/// Writes events as JSON lines; the request id is known only after the request is read.
pub struct Emitter {
    id: Mutex<Value>,
    wire: Mutex<Box<dyn Write + Send>>,
}

impl Emitter {
    /// An emitter that writes to `wire`.
    pub fn new(wire: Box<dyn Write + Send>) -> Self {
        Self { id: Mutex::new(json!("unknown")), wire: Mutex::new(wire) }
    }

    fn set_id(&self, id: Value) {
        *self.id.lock().unwrap_or_else(|e| e.into_inner()) = id;
    }

    /// One event line: `{"protocol":1,"id":..,"event":..,<fields>}`, flushed.
    pub fn emit(&self, event: &str, fields: Value) {
        let mut line = Map::new();
        line.insert("protocol".into(), json!(1));
        line.insert("id".into(), self.id.lock().unwrap_or_else(|e| e.into_inner()).clone());
        line.insert("event".into(), json!(event));
        if let Value::Object(extra) = fields {
            line.extend(extra);
        }
        let mut wire = self.wire.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(wire, "{}", Value::Object(line));
        let _ = wire.flush();
    }

    /// A progress event, the value clamped to 0..1.
    pub fn progress(&self, value: f64, message: &str) {
        self.emit("progress", json!({"progress": value.clamp(0.0, 1.0), "message": message}));
    }

    /// The terminal error event.
    pub fn error(&self, code: &str, message: &str) {
        self.emit("error", json!({"code": code, "message": message}));
    }
}

/// A validated request.
pub struct Request {
    /// `payload`.
    pub payload: Map<String, Value>,
    /// `operation`.
    pub operation: String,
    /// `output_dir`, resolved (the temp folder when absent).
    pub output_dir: PathBuf,
    /// `models_dir`, resolved (the temp folder when absent).
    pub models_dir: PathBuf,
}

/// Reads the one request line: at most 4 MiB, BOM tolerated (Windows PowerShell 5 prefixes piped text with one).
pub fn read_request(input: &mut dyn BufRead) -> Result<Value> {
    let mut bytes = Vec::new();
    input
        .take(4 * (MAX_REQUEST_CHARS as u64 + 1))
        .read_until(b'\n', &mut bytes)
        .map_err(|e| WorkerError::py("OSError", e))?;
    let text = String::from_utf8(bytes).map_err(|e| WorkerError::py("UnicodeDecodeError", e))?;
    if text.chars().count() > MAX_REQUEST_CHARS {
        return Err(WorkerError::new("INVALID_REQUEST", "Request exceeds 4 MiB."));
    }
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| WorkerError::py("JSONDecodeError", e))
}

/// `validate_request` plus the folder fields; `Err` carries the protocol error to report.
pub fn validate(request: &Value) -> Result<Request> {
    let invalid = |msg: &str| WorkerError::new("INVALID_REQUEST", msg);
    let Some(object) = request.as_object() else {
        return Err(invalid("Expected protocol version 1."));
    };
    // Python: `request.get('protocol') != 1`; True and 1.0 equal 1 there.
    let protocol_one = match object.get("protocol") {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        _ => false,
    };
    if !protocol_one {
        return Err(invalid("Expected protocol version 1."));
    }
    if !object.get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return Err(invalid("A request id is required."));
    }
    let Some(payload) = object.get("payload").and_then(Value::as_object) else {
        return Err(invalid("payload must be an object."));
    };
    let operation = object.get("operation").and_then(Value::as_str).filter(|op| OPERATIONS.contains(op));
    let Some(operation) = operation else {
        return Err(invalid("Unknown operation."));
    };
    let folder = |key: &str| -> Result<PathBuf> {
        match object.get(key) {
            Some(Value::String(s)) if !s.is_empty() => Ok(resolve(std::path::Path::new(s))),
            None | Some(Value::Null) | Some(Value::String(_)) | Some(Value::Bool(false)) => {
                Ok(resolve(&std::env::temp_dir()))
            }
            Some(_) => Err(WorkerError::py("TypeError", "argument should be a str or an os.PathLike object")),
        }
    };
    Ok(Request {
        payload: payload.clone(),
        operation: operation.into(),
        output_dir: folder("output_dir")?,
        models_dir: folder("models_dir")?,
    })
}

/// Reads and serves one request. Returns the process exit code: 0 after `result`, 1 after `error`.
///
/// `serve` runs the operation. A panic inside it is the terminal event `error {RUST_PANIC}`, never a `result`.
pub fn run(
    input: &mut dyn BufRead,
    out: &Arc<Emitter>,
    serve: &dyn Fn(&Request, &Arc<Emitter>) -> Result<Value>,
) -> i32 {
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Value> {
        let request = read_request(input)?;
        if let Some(id) = request.as_object().map(|o| o.get("id").cloned().unwrap_or_else(|| json!("unknown"))) {
            out.set_id(id);
        }
        let request = validate(&request)?;
        serve(&request, out)
    }));
    match outcome {
        Ok(Ok(result)) => {
            out.emit("result", json!({"result": result}));
            0
        }
        Ok(Err(error)) => {
            out.error(&error.code, &error.message);
            1
        }
        Err(panic) => {
            let text =
                panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned());
            out.error("RUST_PANIC", &text.unwrap_or_else(|| "The worker panicked.".into()));
            1
        }
    }
}

/// Ends the process after the terminal event is flushed. `TerminateProcess` skips the C runtime's exit handlers, so a
/// native library's thread pool cannot hold the exit up.
pub fn exit_now(code: i32) -> ! {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        // SAFETY: the pseudo-handle of the current process is always valid, and nothing runs after this call.
        unsafe { TerminateProcess(GetCurrentProcess(), code as u32) };
    }
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::Arc;

    /// A writer the test can read back after the emitter took ownership of a clone.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn serve(line: &str, op: &dyn Fn(&Request, &Arc<Emitter>) -> Result<Value>) -> (i32, Vec<Value>) {
        let sink = Sink::default();
        let out = Arc::new(Emitter::new(Box::new(sink.clone())));
        let code = run(&mut Cursor::new(line.as_bytes().to_vec()), &out, op);
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        (code, text.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
    }

    fn ok_op(_: &Request, _: &Arc<Emitter>) -> Result<Value> {
        Ok(json!({"done": true}))
    }

    const REQUEST: &str = r#"{"protocol":1,"id":"j1","operation":"health","payload":{}}"#;

    #[test]
    fn a_result_ends_with_exit_zero_and_keeps_the_key_order() {
        let (code, events) = serve(&format!("{REQUEST}\n"), &ok_op);
        assert_eq!(code, 0);
        assert_eq!(events, vec![json!({"protocol": 1, "id": "j1", "event": "result", "result": {"done": true}})]);
        assert_eq!(events[0].as_object().unwrap().keys().collect::<Vec<_>>(), ["protocol", "id", "event", "result"]);
    }

    #[test]
    fn an_error_is_the_one_terminal_event_with_exit_one() {
        let (code, events) = serve(&format!("{REQUEST}\n"), &|_, _| Err(WorkerError::new("INVALID_RECIPE", "no")));
        assert_eq!(code, 1);
        assert_eq!(
            events,
            vec![json!({"protocol": 1, "id": "j1", "event": "error", "code": "INVALID_RECIPE", "message": "no"})]
        );
    }

    #[test]
    fn a_panic_is_rust_panic_and_never_a_result() {
        let (code, events) = serve(&format!("{REQUEST}\n"), &|_, out| {
            out.progress(0.5, "half");
            panic!("boom")
        });
        assert_eq!(code, 1);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "progress");
        assert_eq!(
            (events[1]["event"].as_str(), events[1]["code"].as_str(), events[1]["message"].as_str()),
            (Some("error"), Some("RUST_PANIC"), Some("boom"))
        );
    }

    #[test]
    fn progress_is_clamped_to_zero_one() {
        let (_, events) = serve(&format!("{REQUEST}\n"), &|_, out| {
            out.progress(-3.0, "a");
            out.progress(7.0, "b");
            Ok(json!(null))
        });
        assert_eq!((events[0]["progress"].as_f64(), events[1]["progress"].as_f64()), (Some(0.0), Some(1.0)));
    }

    #[test]
    fn the_request_is_checked_in_the_order_of_the_python_worker() {
        let cases = [
            ("\n", "WORKER_ERROR", "JSONDecodeError"),
            ("[]\n", "INVALID_REQUEST", "Expected protocol version 1."),
            (r#"{"protocol":2}"#, "INVALID_REQUEST", "Expected protocol version 1."),
            (r#"{"protocol":1,"id":""}"#, "INVALID_REQUEST", "A request id is required."),
            (r#"{"protocol":1,"id":"a","payload":[]}"#, "INVALID_REQUEST", "payload must be an object."),
            (r#"{"protocol":1,"id":"a","payload":{},"operation":"nope"}"#, "INVALID_REQUEST", "Unknown operation."),
        ];
        for (line, code, message) in cases {
            let (exit, events) = serve(line, &ok_op);
            assert_eq!(exit, 1, "{line}");
            assert_eq!(events[0]["code"], code, "{line}");
            assert!(events[0]["message"].as_str().unwrap().starts_with(message), "{line}: {}", events[0]["message"]);
        }
    }

    #[test]
    fn a_bom_is_skipped_and_the_id_is_echoed_as_given() {
        let (code, events) =
            serve("\u{feff}{\"protocol\":1,\"id\":\"é\",\"operation\":\"health\",\"payload\":{}}\n", &ok_op);
        assert_eq!((code, events[0]["id"].as_str()), (0, Some("é")));
        let (_, events) = serve(r#"{"protocol":1,"id":5,"operation":"nope","payload":{}}"#, &ok_op);
        assert_eq!(events[0]["id"], 5);
    }

    #[test]
    fn a_request_over_4_mib_is_refused() {
        let big =
            format!("{{\"protocol\":1,\"id\":\"a\",\"payload\":{{\"x\":\"{}\"}}}}\n", "x".repeat(MAX_REQUEST_CHARS));
        let (code, events) = serve(&big, &ok_op);
        assert_eq!(
            (code, events[0]["code"].as_str(), events[0]["message"].as_str()),
            (1, Some("INVALID_REQUEST"), Some("Request exceeds 4 MiB."))
        );
    }
}
