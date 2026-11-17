//! Failed ORT calls surface ORT's own code and message; precondition failures are typed too.

mod common;

use common::*;
use ortffi::{Env, Error, ErrorCode, Session, SessionOptions, WORKER_ERROR};
use std::path::{Path, PathBuf};

fn ort_error<T>(result: Result<T, Error>) -> (ErrorCode, String) {
    match result {
        Err(e @ Error::Ort(_)) => {
            assert_eq!(e.worker_code(), WORKER_ERROR);
            let Error::Ort(o) = e else { unreachable!() };
            let shown = o.to_string();
            assert!(shown.contains(&o.message) && shown.contains(&format!("{:?}", o.code)), "{shown}");
            (o.code, o.message)
        }
        Err(e) => panic!("expected an ORT error, got {e}"),
        Ok(_) => panic!("expected an error"),
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("ortffi-errors");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn open(env: &Env, path: &Path) -> Result<Session, Error> {
    Session::from_file(env, path, &SessionOptions::new(env).unwrap())
}

/// The three Silero inputs for `frames` rows of 576 samples (all zeros).
struct SileroInputs {
    frames: Vec<f32>,
    state: Vec<f32>,
    rows: i64,
}

impl SileroInputs {
    fn new(rows: usize, fill: f32) -> Self {
        Self { frames: vec![fill; rows * 576], state: vec![0.0; 128], rows: rows as i64 }
    }

    fn run(&self, env: &Env, session: &Session, outputs: &[&str]) -> Vec<ortffi::Value<'static>> {
        session
            .run(
                &[
                    ("input", &env.tensor(&self.frames, &[self.rows, 576]).unwrap()),
                    ("h", &env.tensor(&self.state, &[1, 1, 128]).unwrap()),
                    ("c", &env.tensor(&self.state, &[1, 1, 128]).unwrap()),
                ],
                outputs,
            )
            .unwrap()
    }
}

#[test]
fn a_missing_model_is_no_such_file() {
    let env = env();
    let (code, message) = ort_error(open(&env, &scratch("absent.onnx")));
    assert_eq!(code, ErrorCode::NoSuchFile, "{message}");
    assert!(message.contains("absent.onnx"), "{message}");
}

#[test]
fn a_malformed_model_is_invalid_protobuf() {
    let env = env();
    let garbage = scratch("garbage.onnx");
    std::fs::write(&garbage, b"definitely not a protobuf model \xff\xfe\x00\x01").unwrap();
    let (code, message) = ort_error(open(&env, &garbage));
    assert_eq!(code, ErrorCode::InvalidProtobuf, "{message}");

    let bytes = std::fs::read(silero_model()).unwrap();
    let truncated = scratch("truncated.onnx");
    std::fs::write(&truncated, &bytes[..bytes.len() / 3]).unwrap();
    let (code, message) = ort_error(open(&env, &truncated));
    assert_eq!(code, ErrorCode::InvalidProtobuf, "{message}");
}

#[test]
fn a_non_ascii_model_path_loads() {
    let env = env();
    let dir = scratch("thư mục âm thanh");
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("silero ví dụ.onnx");
    std::fs::copy(silero_model(), &copy).unwrap();
    assert_eq!(open(&env, &copy).unwrap().inputs().len(), 3);
}

#[test]
fn run_rejects_bad_inputs_with_invalid_argument() {
    let env = env();
    let session = silero_session(&env);
    let good = SileroInputs::new(1, 0.0);
    assert_eq!(good.run(&env, &session, &["speech_probs"])[0].info().unwrap().shape.len(), 1);

    let input = env.tensor(&good.frames, &[1, 576]).unwrap();
    let h = env.tensor(&good.state, &[1, 1, 128]).unwrap();
    let c = env.tensor(&good.state, &[1, 1, 128]).unwrap();
    let ok_inputs = [("input", &input), ("h", &h), ("c", &c)];

    let cases: Vec<(&str, Result<Vec<_>, Error>)> = vec![
        ("unknown input name", session.run(&[("sound", &input), ("h", &h), ("c", &c)], &["speech_probs"])),
        ("unknown output name", session.run(&ok_inputs, &["nope"])),
    ];
    for (what, result) in cases {
        let (code, message) = ort_error(result);
        assert_eq!(code, ErrorCode::InvalidArgument, "{what}: {message}");
    }

    // ORT 1.31.1 does not validate presence up front: a missing input fails inside the first
    // kernel that reads it, with code ORT_FAIL (Python adds its own check before calling ORT).
    let (code, message) = ort_error(session.run(&[("h", &h), ("c", &c)], &["speech_probs"]));
    assert_eq!(code, ErrorCode::Fail, "missing input: {message}");
    assert!(message.contains("Missing Input: input"), "{message}");

    let ints = vec![0i32; 576];
    let wrong_type = env.tensor(&ints, &[1, 576]).unwrap();
    let (code, message) = ort_error(session.run(&[("input", &wrong_type), ("h", &h), ("c", &c)], &["speech_probs"]));
    assert_eq!(code, ErrorCode::InvalidArgument, "wrong element type: {message}");

    let wrong_shape = env.tensor(&good.frames, &[576]).unwrap();
    let (code, message) = ort_error(session.run(&[("input", &wrong_shape), ("h", &h), ("c", &c)], &["speech_probs"]));
    assert_eq!(code, ErrorCode::InvalidArgument, "wrong rank: {message}");

    // the session is still usable after every failure
    good.run(&env, &session, &["speech_probs", "hn", "cn"]);
}

#[test]
fn tensor_preconditions_are_checked_before_ort_is_called() {
    let env = env();
    let data = [1f32, 2.0, 3.0, 4.0];
    for shape in [&[3][..], &[2, 3], &[-4], &[i64::MAX, 2], &[]] {
        let (code, message) = ort_error(env.tensor(&data, shape).map(|_| ()));
        assert_eq!(code, ErrorCode::InvalidArgument, "{shape:?}: {message}");
    }
    assert!(env.tensor(&data, &[2, 2]).is_ok());
    assert!(env.tensor::<f32>(&[], &[0]).is_ok());
    // a scalar tensor has an empty shape and one element
    assert!(env.tensor(&[1f32], &[]).is_ok());
}

#[test]
fn reading_an_output_as_the_wrong_type_is_an_error() {
    let env = env();
    let session = silero_session(&env);
    let out = SileroInputs::new(1, 0.01).run(&env, &session, &["hn"]);
    assert_eq!(out[0].as_slice::<f32>().unwrap().len(), 128);
    assert_eq!(ort_error(out[0].as_slice::<i64>().map(|_| ())).0, ErrorCode::InvalidArgument);
    assert_eq!(out[0].to_vec::<f32>().unwrap().len(), 128);
}

#[test]
fn names_with_interior_nul_are_refused() {
    let env = env();
    let session = silero_session(&env);
    let frames = vec![0f32; 576];
    let input = env.tensor(&frames, &[1, 576]).unwrap();
    assert_eq!(
        ort_error(session.run(&[("in\0put", &input)], &["speech_probs"]).map(|_| ())).0,
        ErrorCode::InvalidArgument
    );
    assert_eq!(ort_error(session.run(&[("input", &input)], &["a\0b"]).map(|_| ())).0, ErrorCode::InvalidArgument);
    let mut options = SessionOptions::new(&env).unwrap();
    assert_eq!(ort_error(options.config_entry("k\0", "v").map(|_| ())).0, ErrorCode::InvalidArgument);
}

#[test]
fn every_session_option_is_accepted() {
    use ortffi::{ExecutionMode, GraphOptimizationLevel as G};
    let env = env();
    for level in [G::DisableAll, G::Basic, G::Extended, G::Layout, G::All] {
        for mode in [ExecutionMode::Sequential, ExecutionMode::Parallel] {
            let mut o = SessionOptions::new(&env).unwrap();
            o.graph_optimization_level(level).unwrap().execution_mode(mode).unwrap();
            o.intra_op_threads(2).unwrap().inter_op_threads(2).unwrap().cpu_mem_arena(true).unwrap();
            o.log_severity_level(3).unwrap().config_entry("session.intra_op.allow_spinning", "0").unwrap();
            let session = Session::from_file(&env, &silero_model(), &o).unwrap();
            assert_eq!(session.outputs().len(), 3);
        }
    }
}

#[test]
fn a_session_outlives_the_env_value_it_was_made_from() {
    let session = {
        let env = env();
        silero_session(&env)
        // `env` is dropped here; the session keeps the runtime and environment alive.
    };
    let env2 = Env::load(&ort_dll(), "second").unwrap();
    let out = SileroInputs::new(1, 0.0).run(&env2, &session, &["speech_probs"]);
    assert_eq!(out.len(), 1);
}

#[test]
fn a_session_runs_from_several_threads_at_once() {
    let env = env();
    let session = std::sync::Arc::new(silero_session(&env));
    let handles: Vec<_> = (0..4)
        .map(|t| {
            let (session, env) = (session.clone(), env.clone());
            std::thread::spawn(move || {
                let inputs = SileroInputs::new(8, 0.001 * (t + 1) as f32);
                (0..50)
                    .map(|_| inputs.run(&env, &session, &["speech_probs"])[0].to_vec::<f32>().unwrap())
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    for h in handles {
        let runs = h.join().unwrap();
        assert!(runs.windows(2).all(|w| w[0] == w[1]), "same input, same output");
    }
}
