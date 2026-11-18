//! `thanham-worker.exe`: the native worker. Reads one protocol-v1 request on stdin and writes JSON-lines events on stdout,
//! like `worker/main.py`. A2 serves `health`, `probe`, `render` and `download`; the other operations arrive in later phases
//! and, until then, never reach this exe (the desktop does not route them here).

mod download;
mod error;
mod health;
mod hub;
mod media;
mod paths;
mod protocol;
mod pyfmt;
mod render;

use error::{Result, WorkerError};
use protocol::{exit_now, run, Emitter, Request};
use serde_json::Value;
use std::io::BufReader;
use std::sync::Arc;

fn serve(request: &Request, out: &Arc<Emitter>) -> Result<Value> {
    let payload = &request.payload;
    match request.operation.as_str() {
        "health" => Ok(health::health()),
        "probe" => {
            let input = match payload.get("input_path") {
                Some(Value::String(s)) => s.as_str(),
                Some(_) => {
                    return Err(WorkerError::py("TypeError", "argument should be a str or an os.PathLike object"))
                }
                None => return Err(WorkerError::py("KeyError", "'input_path'")),
            };
            media::probe(input, payload.get("ffmpeg_path").and_then(Value::as_str))
        }
        "render" => {
            let emitter = out.clone();
            render::render(payload, &request.output_dir, &move |value, message| emitter.progress(value, message))
        }
        "download" => {
            let emitter = out.clone();
            download::download(
                payload,
                &request.models_dir,
                Arc::new(move |value, message| emitter.progress(value, message)),
            )
        }
        other => {
            Err(WorkerError::py("NotImplementedError", format!("the Rust worker does not implement '{other}' yet")))
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("health") {
        // `thanham-worker health`: the health result on stdout and the exit code, for the installer checks and the desktop.
        let result = health::health();
        println!("{result}");
        exit_now(if result["ready"] == true { 0 } else { 1 });
    }
    let out = Arc::new(Emitter::new(Box::new(std::io::stdout())));
    let stdin = std::io::stdin();
    let code = run(&mut BufReader::new(stdin.lock()), &out, &serve);
    exit_now(code);
}
