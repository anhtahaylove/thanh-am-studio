//! Row W logic against an in-process Hugging Face stand-in: no network, no real models. The full 35-scenario comparison with the
//! Python goldens is `parity/w_compare.py`; these tests keep the behaviour that matters under plain `cargo test`.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";

#[derive(Clone)]
enum Fault {
    DropAfter(usize),
    HeadStatus(u16),
    Truncate(usize),
    Corrupt,
}

struct Rule {
    needle: &'static str,
    fault: Fault,
    count: usize,
}

#[derive(Clone, Default)]
struct Stub {
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    rules: Arc<Mutex<Vec<Rule>>>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Stub {
    fn start(files: &[(&str, Vec<u8>)]) -> (Stub, u16) {
        let stub = Stub::default();
        for (name, data) in files {
            stub.files.lock().unwrap().insert(format!("/r/t1/resolve/{REVISION}/{name}"), data.clone());
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = stub.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let shared = shared.clone();
                std::thread::spawn(move || shared.handle(stream));
            }
        });
        (stub, port)
    }

    fn fault(&self, path: &str, head: bool) -> Option<Fault> {
        let mut rules = self.rules.lock().unwrap();
        let rule = rules
            .iter_mut()
            .find(|r| path.contains(r.needle) && r.count > 0 && (matches!(r.fault, Fault::HeadStatus(_)) == head))?;
        rule.count -= 1;
        Some(rule.fault.clone())
    }

    fn handle(&self, stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let (method, path) = {
            let mut parts = line.split_whitespace();
            (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string())
        };
        let mut range = None;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header.trim().is_empty() {
                break;
            }
            if let Some(v) = header.to_lowercase().strip_prefix("range: bytes=") {
                range = v.trim().trim_end_matches('-').parse::<usize>().ok();
            }
        }
        let mut out = stream;
        let name = path.rsplit('/').next().unwrap_or("").to_string();
        let Some(data) = self.files.lock().unwrap().get(&path).cloned() else {
            self.log.lock().unwrap().push(format!("{method} {name} 404"));
            let _ = out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        };
        let head = method == "HEAD";
        let fault = self.fault(&path, head);
        if let Some(Fault::HeadStatus(status)) = fault {
            self.log.lock().unwrap().push(format!("{method} {name} {status}"));
            let _ = out
                .write_all(format!("HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
            return;
        }
        let mut body = data.clone();
        if let Some(Fault::Truncate(n)) = fault {
            body.truncate(n);
        }
        if let Some(Fault::Corrupt) = fault {
            body[0] ^= 0xFF;
        }
        let etag = format!("{:x}", Sha256::digest(&data));
        let common =
            format!("ETag: \"{etag}\"\r\nX-Repo-Commit: {REVISION}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n");
        if head {
            self.log.lock().unwrap().push(format!("HEAD {name} 200"));
            let _ =
                out.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{common}\r\n", body.len()).as_bytes());
            return;
        }
        let start = range.unwrap_or(0);
        let send = &body[start.min(body.len())..];
        let limit = if let Some(Fault::DropAfter(n)) = fault { n.min(send.len()) } else { send.len() };
        let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
        self.log
            .lock()
            .unwrap()
            .push(format!("GET {name} range={} sent={limit}", range.map_or("-".into(), |r| r.to_string())));
        let _ =
            out.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{common}\r\n", send.len()).as_bytes());
        let _ = out.write_all(&send[..limit]);
        let _ = out.flush();
        let _ = out.shutdown(Shutdown::Both);
    }

    fn rule(&self, needle: &'static str, fault: Fault, count: usize) {
        self.rules.lock().unwrap().push(Rule { needle, fault, count });
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

/// A worker folder as shipped: the exe next to a registry of one model of the given files.
struct Setup {
    dir: tempfile::TempDir,
    models: PathBuf,
}

fn setup(files: &[(&str, &[u8])], size_override: Option<u64>) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let artifacts: Vec<Value> = files
        .iter()
        .map(|(name, data)| {
            json!({"path": format!("sub/{name}"), "repo": "r/t1", "revision": REVISION, "filename": name,
                   "size": size_override.unwrap_or(data.len() as u64), "sha256": format!("{:x}", Sha256::digest(data))})
        })
        .collect();
    let registry = json!({"schema": 1, "models": [{"id": "t1", "revision": REVISION, "artifacts": artifacts}]});
    std::fs::write(dir.path().join("models.json"), registry.to_string()).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_thanham-worker"), dir.path().join("thanham-worker.exe")).unwrap();
    let models = dir.path().join("models");
    Setup { dir, models }
}

fn run(s: &Setup, port: u16, model: &str) -> (i32, Vec<Value>) {
    let request = json!({"protocol": 1, "id": "w1", "operation": "download", "payload": {"model_id": model}, "output_dir": s.dir.path(), "models_dir": s.models});
    let mut child = Command::new(s.dir.path().join("thanham-worker.exe"))
        .env("HF_ENDPOINT", format!("http://127.0.0.1:{port}"))
        .env("THANHAM_HUB_SLEEP_SCALE", "0")
        .env_remove("HTTP_PROXY")
        .env_remove("http_proxy")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
    let mut text = String::new();
    child.stdout.take().unwrap().read_to_string(&mut text).unwrap();
    let code = child.wait().unwrap().code().unwrap();
    (code, text.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
}

fn last(events: &[Value]) -> &Value {
    events.last().unwrap()
}

fn files_under(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    walk(root, root, &mut out);
    out.sort();
    out
}

fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

#[test]
fn a_fresh_download_verifies_moves_and_writes_the_marker() {
    let (one, two) = (bytes(1000, 1), bytes(2000, 2));
    let (stub, port) = Stub::start(&[("one.bin", one.clone()), ("two.bin", two.clone())]);
    let s = setup(&[("one.bin", &one), ("two.bin", &two)], None);
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 0, "{events:?}");
    // The byte-progress watcher may add "Đang tải model" lines depending on timing; the file checks and the end are fixed.
    let messages: Vec<&str> = events
        .iter()
        .filter(|e| e["event"] == "progress")
        .map(|e| e["message"].as_str().unwrap())
        .filter(|m| !m.starts_with("Đang tải"))
        .collect();
    assert_eq!(messages, ["Đã kiểm tra one.bin", "Đã kiểm tra two.bin", "Model sẵn sàng"]);
    assert_eq!(last(&events)["result"]["revision"], REVISION);
    assert_eq!(std::fs::read(s.models.join("t1/sub/one.bin")).unwrap(), one);
    let marker = std::fs::read_to_string(s.models.join("t1/installed.json")).unwrap();
    assert_eq!(marker, format!("{{\r\n  \"model_id\": \"t1\",\r\n  \"revision\": \"{REVISION}\"\r\n}}"));
    assert_eq!(files_under(&s.models), ["t1/installed.json", "t1/sub/one.bin", "t1/sub/two.bin"]);
    assert!(s.models.join(".download").is_dir(), "the empty .download folder stays, as in Python");
    assert_eq!(
        stub.log(),
        ["HEAD one.bin 200", "GET one.bin range=- sent=1000", "HEAD two.bin 200", "GET two.bin range=- sent=2000"]
    );
    // an installed model is verified and nothing is requested
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 0);
    assert_eq!(stub.log().len(), 4);
    assert_eq!(events.iter().filter(|e| e["event"] == "progress").count(), 1);
}

#[test]
fn a_dropped_connection_resumes_at_a_whole_chunk() {
    let data = bytes(25 * 1024 * 1024, 3);
    let (stub, port) = Stub::start(&[("big.bin", data.clone())]);
    stub.rule("big.bin", Fault::DropAfter(15_000_000), 1);
    let s = setup(&[("big.bin", &data)], None);
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 0, "{events:?}");
    assert_eq!(
        stub.log(),
        ["HEAD big.bin 200", "GET big.bin range=- sent=15000000", "GET big.bin range=10485760 sent=15728640"],
        "the 5 MB past the first 10 MiB chunk is lost with the connection, so the Range starts at 10485760"
    );
    assert_eq!(std::fs::read(s.models.join("t1/sub/big.bin")).unwrap(), data);
}

#[test]
fn a_503_on_the_metadata_is_retried_six_more_times_then_not_found_locally() {
    let data = bytes(100, 4);
    let (stub, port) = Stub::start(&[("a.bin", data.clone())]);
    stub.rule("a.bin", Fault::HeadStatus(503), 100);
    let s = setup(&[("a.bin", &data)], None);
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 1);
    assert_eq!(stub.log().len(), 7, "one try, then the backoff of 5 retries plus the first");
    assert_eq!(last(&events)["code"], "NETWORK");
    assert!(last(&events)["message"].as_str().unwrap().contains("(LocalEntryNotFoundError)"));
    assert!(!s.models.join("t1/installed.json").exists());
}

#[test]
fn a_401_is_reported_at_once_as_an_http_error() {
    let data = bytes(100, 5);
    let (stub, port) = Stub::start(&[("a.bin", data.clone())]);
    stub.rule("a.bin", Fault::HeadStatus(401), 100);
    let s = setup(&[("a.bin", &data)], None);
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 1);
    assert_eq!(stub.log(), ["HEAD a.bin 401"]);
    assert!(last(&events)["message"].as_str().unwrap().contains("(HfHubHTTPError)"));
}

#[test]
fn a_short_body_fails_the_size_check_and_leaves_no_partial_file() {
    let data = bytes(1000, 6);
    let (stub, port) = Stub::start(&[("a.bin", data.clone())]);
    stub.rule("a.bin", Fault::Truncate(10), 5);
    let s = setup(&[("a.bin", &data)], None);
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 1);
    assert!(last(&events)["message"].as_str().unwrap().contains("(OSError)"));
    assert_eq!(stub.log().len(), 2);
    assert!(
        files_under(&s.models).iter().all(|f| !f.ends_with(".incomplete") && !f.starts_with("t1/")),
        "{:?}",
        files_under(&s.models)
    );
}

#[test]
fn a_corrupt_body_of_the_right_size_is_a_checksum_error_and_is_removed() {
    let data = bytes(1000, 7);
    let (stub, port) = Stub::start(&[("a.bin", data.clone())]);
    stub.rule("a.bin", Fault::Corrupt, 1);
    let s = setup(&[("a.bin", &data)], None);
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 1);
    assert_eq!(
        (last(&events)["code"].as_str(), last(&events)["message"].as_str()),
        (Some("MODEL_CHECKSUM"), Some("Model checksum mismatch: a.bin"))
    );
    assert!(!files_under(&s.models).iter().any(|f| f == "t1/sub/a.bin" || f == ".download/t1/a.bin"));
}

#[test]
fn not_enough_disk_is_refused_before_any_request() {
    let data = bytes(100, 8);
    let (stub, port) = Stub::start(&[("a.bin", data.clone())]);
    let s = setup(&[("a.bin", &data)], Some(2 * 1024 * 1024 * 1024 * 1024));
    let (code, events) = run(&s, port, "t1");
    assert_eq!(code, 1);
    assert_eq!(last(&events)["code"], "DISK_FULL");
    assert!(last(&events)["message"]
        .as_str()
        .unwrap()
        .starts_with("Không đủ dung lượng: cần khoảng 2097152 MB trống, còn "));
    assert!(stub.log().is_empty());
}

#[test]
fn an_unknown_model_id_is_model_unknown() {
    let s = setup(&[], None);
    let (code, events) = run(&s, 9, "nope");
    assert_eq!(
        (code, last(&events)["code"].as_str(), last(&events)["message"].as_str()),
        (1, Some("MODEL_UNKNOWN"), Some("Unknown model id."))
    );
}
