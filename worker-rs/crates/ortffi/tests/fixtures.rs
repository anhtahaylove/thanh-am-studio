//! Row F: outputs must be bitwise identical to the Python onnxruntime 1.31.1 recording
//! (`tools/gen_fixtures.py`), with the same session options as the app's Python code.
//!
//! ORT picks its kernels by CPU, so the recording is only bit-exact on a CPU of the family that made it. `ORTFFI_MAX_ABS_DIFF` (CI sets
//! 1e-5) accepts f32 outputs within that absolute difference; unset, the comparison is exact.

mod common;

use common::*;
use ortffi::{Env, Session, Value};
use std::collections::BTreeMap;
use std::path::Path;

/// Replays one recorded run. `override_inputs` replaces recorded inputs by name with live values.
fn replay(
    env: &Env,
    session: &Session,
    dir: &Path,
    run: &str,
    override_inputs: &[(&str, &Value<'_>)],
) -> BTreeMap<String, Value<'static>> {
    let recorded_in = recorded(dir, run, "in");
    let buffers: Vec<(String, Buffer, Vec<i64>)> =
        recorded_in.iter().map(|(n, npy)| (n.clone(), Buffer::from_npy(npy), npy.shape.clone())).collect();
    let tensors: Vec<(&str, Value<'_>)> =
        buffers.iter().map(|(n, b, shape)| (n.as_str(), b.tensor(env, shape))).collect();
    let inputs: Vec<(&str, &Value<'_>)> = tensors
        .iter()
        .map(|(n, v)| (*n, override_inputs.iter().find(|(o, _)| o == n).map_or(v, |(_, live)| live)))
        .collect();

    let expected = recorded(dir, run, "out");
    let names: Vec<&str> = expected.keys().map(String::as_str).collect();
    let outputs = session.run(&inputs, &names).expect("run");
    let mut by_name = BTreeMap::new();
    for ((name, npy), value) in expected.iter().zip(outputs) {
        assert_eq!(value.info().unwrap().shape, npy.shape, "{run}/{name}: shape");
        let got = value_bytes(&value);
        assert!(
            got == npy.bytes || within_tolerance(&got, &npy.bytes, &npy.descr),
            "{run}/{name}: output differs from Python ({} bytes, {})",
            got.len(),
            diff_summary(&got, &npy.bytes, &npy.descr)
        );
        by_name.insert(name.clone(), value);
    }
    by_name
}

/// True when `ORTFFI_MAX_ABS_DIFF` is set and every f32 value is that close to the recording.
fn within_tolerance(got: &[u8], want: &[u8], descr: &str) -> bool {
    let Some(limit) = std::env::var("ORTFFI_MAX_ABS_DIFF").ok().and_then(|v| v.parse::<f32>().ok()) else {
        return false;
    };
    if descr != "<f4" || got.len() != want.len() {
        return false;
    }
    let f = |b: &[u8]| -> Vec<f32> { b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect() };
    f(got).iter().zip(f(want)).all(|(x, y)| (x - y).abs() <= limit)
}

/// For a failure message only: the largest absolute difference when the data is f32.
fn diff_summary(got: &[u8], want: &[u8], descr: &str) -> String {
    if descr != "<f4" || got.len() != want.len() {
        return "not f32 or length differs".into();
    }
    let f = |b: &[u8]| -> Vec<f32> { b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect() };
    let (a, b) = (f(got), f(want));
    let max = a.iter().zip(&b).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
    let n = a.iter().zip(&b).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
    format!("{n} of {} values differ, max abs diff {max:e}", a.len())
}

#[test]
fn silero_vad_batch_matches_python() {
    let env = env();
    let session = silero_session(&env);
    assert_eq!(session.inputs().iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["input", "h", "c"]);
    let dir = fixture_dir("silero_batch");
    replay(&env, &session, &dir, "full", &[]);
    replay(&env, &session, &dir, "noise", &[]);
}

#[test]
fn silero_vad_streaming_chain_matches_python() {
    let env = env();
    let session = silero_session(&env);
    let dir = fixture_dir("silero_chain");
    let first = replay(&env, &session, &dir, "s1", &[]);
    // Feed ORT-owned outputs of run 1 straight back in as the state of run 2.
    replay(&env, &session, &dir, "s2", &[("h", &first["hn"]), ("c", &first["cn"])]);
    // And the same run from the recorded state.
    replay(&env, &session, &dir, "s2", &[]);
}

fn vieneu_session(env: &Env, rel: &str, intra: i32) -> Session {
    Session::from_file(env, &vieneu_dir().join(rel), &vieneu_options(env, intra)).expect("vieneu session")
}

#[test]
fn vieneu_codec_decoder_matches_python() {
    if skip_missing("VieNeu models", &vieneu_dir()) {
        return;
    }
    let env = env();
    let session = vieneu_session(&env, "codec/moss_audio_tokenizer_decode_full.onnx", 8);
    let dir = fixture_dir("vieneu_codec_decode");
    replay(&env, &session, &dir, "l40", &[]);
    replay(&env, &session, &dir, "l7", &[]);
}

#[test]
fn vieneu_decode_step_matches_python() {
    if skip_missing("VieNeu models", &vieneu_dir()) {
        return;
    }
    let env = env();
    let session = vieneu_session(&env, "backbone/onnx_update/vieneu_decode_step.onnx", 8);
    assert_eq!(session.inputs().len(), 26);
    assert_eq!(session.outputs().len(), 25);
    replay(&env, &session, &fixture_dir("vieneu_decode_step"), "p16", &[]);
}

#[test]
fn session_io_description_matches_python() {
    if skip_missing("VieNeu models", &vieneu_dir()) {
        return;
    }
    use ortffi::ElementType::{F32, I32};
    let env = env();
    let codec = vieneu_session(&env, "codec/moss_audio_tokenizer_decode_full.onnx", 1);
    let shape = |i: usize| codec.inputs()[i].tensor.clone().unwrap();
    assert_eq!(codec.inputs()[0].name, "audio_codes");
    assert_eq!((shape(0).element, shape(0).shape), (I32, vec![-1, -1, 16]));
    assert_eq!((shape(1).element, shape(1).shape), (I32, vec![-1]));
    assert_eq!(codec.outputs()[0].name, "audio");
    assert_eq!(codec.outputs()[0].tensor.as_ref().unwrap().element, F32);
}

/// Negative control: the comparison must notice when the input differs a little.
#[test]
fn comparison_detects_a_perturbed_input() {
    let env = env();
    let session = silero_session(&env);
    let dir = fixture_dir("silero_batch");
    let input = recorded(&dir, "full", "in");
    let mut audio = input["input"].f32s();
    audio.iter_mut().for_each(|x| *x += 1e-4);
    let (h, c) = (input["h"].f32s(), input["c"].f32s());
    let out = session
        .run(
            &[
                ("input", &env.tensor(&audio, &input["input"].shape).unwrap()),
                ("h", &env.tensor(&h, &[1, 1, 128]).unwrap()),
                ("c", &env.tensor(&c, &[1, 1, 128]).unwrap()),
            ],
            &["speech_probs"],
        )
        .unwrap();
    assert!(value_bytes(&out[0]) != recorded(&dir, "full", "out")["speech_probs"].bytes);
}

/// The recording used 8 intra-op threads; other thread counts must give the same bytes here.
#[test]
fn vieneu_codec_decoder_is_independent_of_the_thread_count() {
    if skip_missing("VieNeu models", &vieneu_dir()) {
        return;
    }
    let env = env();
    let dir = fixture_dir("vieneu_codec_decode");
    for intra in [1, 2, 3, 16] {
        let session = vieneu_session(&env, "codec/moss_audio_tokenizer_decode_full.onnx", intra);
        replay(&env, &session, &dir, "l40", &[]);
    }
}
