use thanh_am_studio::copy_new;

#[test]
fn copies_to_a_new_path_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let (from, to) = (dir.path().join("a.wav"), dir.path().join("001-P1.wav"));
    std::fs::write(&from, b"audio").unwrap();
    assert!(copy_new(&from, &to).unwrap());
    assert_eq!(std::fs::read(&to).unwrap(), b"audio");
    std::fs::write(&from, b"other").unwrap();
    assert!(!copy_new(&from, &to).unwrap());
    assert_eq!(std::fs::read(&to).unwrap(), b"audio");
}

#[test]
fn a_missing_source_is_an_error_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let to = dir.path().join("x.wav");
    assert!(copy_new(&dir.path().join("missing.wav"), &to).is_err());
    assert!(!to.exists());
}
