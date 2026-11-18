//! Path rules of `worker/main.py`: `Path.resolve()`, `contained_path` and `replace_with_retry`.

use crate::error::{Result, WorkerError};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// `Path(p).resolve()`: absolute, `.` and `..` folded, links of the part that exists followed. The rest of the path
/// may not exist (non-strict, like Python). No `\?\` prefix is left on the result.
pub fn resolve(path: &Path) -> PathBuf {
    let absolute =
        if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut folded = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                folded.pop();
            }
            Component::CurDir => {}
            other => folded.push(other.as_os_str()),
        }
    }
    // Canonicalise the longest prefix that exists, then re-append the rest.
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut head = folded.clone();
    loop {
        if let Ok(real) = head.canonicalize() {
            let mut out = strip_verbatim(real);
            out.extend(rest.iter().rev());
            return out;
        }
        match (head.file_name().map(|n| n.to_os_string()), head.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                head = parent;
            }
            _ => return folded,
        }
    }
}

/// Removes the `\\?\` (and `\\?\UNC\`) prefix `canonicalize` adds on Windows.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.len() >= 2 && rest.as_bytes()[1] == b':' => PathBuf::from(rest),
        _ => path,
    }
}

fn lower_components(path: &Path) -> Vec<String> {
    path.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
}

/// `root` and `candidate` are both resolved; true when `candidate` is `root` or below it (case-insensitive, like Windows).
pub fn is_relative_to(candidate: &Path, root: &Path) -> bool {
    let (c, r) = (lower_components(candidate), lower_components(root));
    c.len() >= r.len() && c[..r.len()] == r[..]
}

/// `(root / relative).resolve()`, which must lie strictly inside `root`.
pub fn contained_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let root = resolve(root);
    let candidate = resolve(&root.join(relative));
    if !is_relative_to(&candidate, &root) || candidate == root {
        return Err(WorkerError::new("INVALID_PATH", "Path must be inside the output directory."));
    }
    Ok(candidate)
}

/// `os.replace` that waits out a file an antivirus scan or indexer holds for a moment: 8 attempts 0.2 s apart,
/// then the last error is returned.
pub fn replace_with_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    for attempt in 0..8 {
        match std::fs::rename(src, dst) {
            Err(e) if attempt < 7 && is_busy(&e) => std::thread::sleep(Duration::from_millis(200)),
            other => return other,
        }
    }
    unreachable!("the last attempt returns")
}

fn is_busy(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied || matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contained_path_stays_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let ok = contained_path(dir.path(), "a/b.bin").unwrap();
        assert!(is_relative_to(&ok, &resolve(dir.path())));
        for bad in ["..", "../x", "a/../../x", "", "."] {
            assert_eq!(contained_path(dir.path(), bad).unwrap_err().code, "INVALID_PATH", "{bad}");
        }
    }

    #[test]
    fn resolve_folds_dots_and_keeps_missing_tails() {
        let dir = tempfile::tempdir().unwrap();
        let base = resolve(dir.path());
        assert_eq!(resolve(&dir.path().join("x/../y/./z.txt")), base.join("y").join("z.txt"));
        assert!(!resolve(dir.path()).to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn resolve_strips_the_verbatim_prefix_of_an_existing_folder() {
        let here = resolve(Path::new(env!("CARGO_MANIFEST_DIR")));
        assert!(!here.to_string_lossy().starts_with(r"\\?\"), "{}", here.display());
        assert!(here.is_dir());
    }

    #[test]
    fn replace_overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&a, b"new").unwrap();
        std::fs::write(&b, b"old").unwrap();
        replace_with_retry(&a, &b).unwrap();
        assert_eq!(std::fs::read(&b).unwrap(), b"new");
        assert!(!a.exists());
    }
}
