//! The exit and terminal-event contract at the process level: exactly one terminal event, `result` then exit 0, `error` then exit 1,
//! nothing after it, whatever the request.

use serde_json::Value;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn run(input: &[u8]) -> (i32, Vec<Value>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_thanham-worker"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let mut text = String::new();
    child.stdout.take().unwrap().read_to_string(&mut text).unwrap();
    let code = child.wait().unwrap().code().unwrap();
    (code, text.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
}

fn terminal(events: &[Value]) -> usize {
    events.iter().filter(|e| e["event"] == "result" || e["event"] == "error").count()
}

#[test]
fn a_result_is_the_last_event_and_exit_is_zero() {
    let (code, events) = run(b"{\"protocol\":1,\"id\":\"h\",\"operation\":\"health\",\"payload\":{}}\n");
    assert_eq!(code, 0);
    assert_eq!((terminal(&events), events.last().unwrap()["event"].as_str()), (1, Some("result")));
    assert_eq!(events.last().unwrap()["result"]["engine"], "rust");
}

#[test]
fn an_error_is_the_last_event_and_exit_is_one() {
    for input in
        [&b""[..], b"not json\n", b"[]\n", b"{\"protocol\":1,\"id\":\"x\",\"operation\":\"nope\",\"payload\":{}}\n"]
    {
        let (code, events) = run(input);
        assert_eq!(code, 1, "{input:?}");
        assert_eq!((terminal(&events), events.last().unwrap()["event"].as_str()), (1, Some("error")), "{input:?}");
    }
}

#[test]
fn an_operation_not_yet_ported_ends_with_a_worker_error_never_a_hang() {
    let (code, events) = run(b"{\"protocol\":1,\"id\":\"s\",\"operation\":\"stt\",\"payload\":{}}\n");
    assert_eq!(code, 1);
    assert_eq!(events.last().unwrap()["code"], "WORKER_ERROR");
}
