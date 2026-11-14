use std::io::{Cursor, Read};
use thanh_am_studio::{copy_new, write_new};

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

#[test]
fn a_failed_copy_leaves_no_file_so_a_retry_is_not_skipped() {
    let dir = tempfile::tempdir().unwrap();
    // A directory cannot be read as a file: opening fails on Windows, reading fails after the destination exists on Unix.
    let (bad, to) = (dir.path().join("folder"), dir.path().join("001-P1.wav"));
    std::fs::create_dir(&bad).unwrap();
    assert!(copy_new(&bad, &to).is_err());
    assert!(!to.exists());
    let good = dir.path().join("a.wav");
    std::fs::write(&good, b"audio").unwrap();
    assert!(copy_new(&good, &to).unwrap());
}

/// Yields some bytes, then fails, like a source that dies midway through the copy.
struct Dies(bool);
impl Read for Dies {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.0 { return Err(std::io::Error::other("disk gone")) }
        self.0 = true;
        buf[..4].copy_from_slice(b"half");
        Ok(4)
    }
}

#[test]
fn a_read_error_midway_removes_the_partial_file_so_a_retry_writes_it() {
    let dir = tempfile::tempdir().unwrap();
    let to = dir.path().join("001-P1.wav");
    assert!(write_new(&mut Dies(false), &to).is_err());
    assert!(!to.exists());
    assert!(write_new(&mut Cursor::new(b"audio"), &to).unwrap());
    assert_eq!(std::fs::read(&to).unwrap(), b"audio");
}
