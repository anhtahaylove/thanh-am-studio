//! Python/numpy number semantics the glue relies on, checked against values the 1.0.16 runtime produced (tools/gen_fixtures.py).

#[test]
fn round2_matches_python_and_numpy() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/round.json")).expect("fixture");
    let v: serde_json::Value = serde_json::from_str(&text).expect("json");
    let cases = v["cases"].as_array().expect("cases");
    assert!(cases.len() > 10_000);
    for c in cases {
        let (x, py, np) = (c[0].as_f64().unwrap(), c[1].as_f64().unwrap(), c[2].as_f64().unwrap());
        assert_eq!(s4_glue::py_round2(x).to_bits(), py.to_bits(), "round({x:?}, 2)");
        assert_eq!(s4_glue::np_round2(x).to_bits(), np.to_bits(), "np.round({x:?}, 2)");
    }
}

#[test]
fn strip_and_windows() {
    assert_eq!(s4_glue::py_strip("\u{1f} a b\u{3000}\n"), "a b");
    // Short audio is one window; a 700 s ramp is cut once, inside the last 30 s before 600 s.
    assert_eq!(s4_glue::stt_windows(&vec![0.1f32; 16000 * 10]), vec![0, 160000]);
    let ramp: Vec<f32> = (0..16000 * 700).map(|i| ((i % 16000) as f32 / 16000.0) - 0.5).collect();
    let cuts = s4_glue::stt_windows(&ramp);
    assert_eq!(cuts.len(), 3);
    assert!(cuts[1] >= 570 * 16000 && cuts[1] < 600 * 16000);
}
