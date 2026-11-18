//! `download`: verify what is installed, fetch the rest into a staging folder, move it into place, write the marker.
//! The checks, messages and codes are those of `download()` and `verify_file()` in `worker/main.py` (row W).

use crate::error::{Result, WorkerError};
use crate::hub::Hub;
use crate::paths::{contained_path, replace_with_retry};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

/// The registry the Python worker reads from `worker/models.json`: the copy next to this exe.
fn registry_path() -> PathBuf {
    std::env::current_exe().unwrap_or_default().with_file_name("models.json")
}

/// `model_spec`: the registry entry for `model_id`.
pub fn model_spec(model_id: Option<&Value>) -> Result<Value> {
    let text = std::fs::read_to_string(registry_path()).map_err(|e| WorkerError::py("FileNotFoundError", e))?;
    let registry: Value = serde_json::from_str(&text).map_err(|e| WorkerError::py("JSONDecodeError", e))?;
    let models =
        registry.get("models").and_then(Value::as_array).ok_or_else(|| WorkerError::py("KeyError", "'models'"))?;
    models
        .iter()
        .find(|m| m.get("id").is_some_and(|id| Some(id) == model_id))
        .cloned()
        .ok_or_else(|| WorkerError::new("MODEL_UNKNOWN", "Unknown model id."))
}

/// `verify_file`: size, then SHA-256 (or the git blob SHA-1) of the file against its registry entry.
pub fn verify_file(path: &Path, entry: &Value) -> Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let size = entry["size"].as_u64().unwrap_or(u64::MAX);
    let meta = path.metadata().ok().filter(|m| m.is_file());
    if meta.as_ref().map(|m| m.len()) != Some(size) {
        return Err(WorkerError::new("MODEL_CHECKSUM", format!("Model size mismatch: {name}")));
    }
    let sha256 = entry.get("sha256").and_then(Value::as_str);
    let mut file = std::fs::File::open(path).map_err(|e| WorkerError::py("OSError", e))?;
    let mut buffer = vec![0u8; 4 * MIB as usize];
    let hex = if sha256.is_some() {
        let mut hash = Sha256::new();
        stream(&mut file, &mut buffer, |b| hash.update(b))?;
        format!("{:x}", hash.finalize())
    } else {
        let mut hash = Sha1::new();
        hash.update(format!("blob {size}\0").as_bytes());
        stream(&mut file, &mut buffer, |b| hash.update(b))?;
        format!("{:x}", hash.finalize())
    };
    let want = sha256.or_else(|| entry.get("git_blob_sha1").and_then(Value::as_str));
    if want != Some(hex.as_str()) {
        return Err(WorkerError::new("MODEL_CHECKSUM", format!("Model checksum mismatch: {name}")));
    }
    Ok(())
}

fn stream(file: &mut std::fs::File, buffer: &mut [u8], mut each: impl FnMut(&[u8])) -> Result<()> {
    loop {
        match file.read(buffer) {
            Ok(0) => return Ok(()),
            Ok(n) => each(&buffer[..n]),
            Err(e) => return Err(WorkerError::py("OSError", e)),
        }
    }
}

/// Free bytes on the volume holding `path` (`shutil.disk_usage(path).free`).
#[cfg(windows)]
fn free_space(path: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; `free` is a valid out pointer; the other two are optional (null).
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(free)
    }
}

#[cfg(not(windows))]
fn free_space(_path: &Path) -> std::io::Result<u64> {
    Ok(u64::MAX)
}

fn total_size(root: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| match e.metadata() {
                Ok(m) if m.is_dir() => walk(&e.path()),
                Ok(m) => m.len(),
                Err(_) => 0,
            })
            .sum()
    }
    walk(root)
}

fn artifact_str<'a>(item: &'a Value, key: &str) -> Result<&'a str> {
    item.get(key).and_then(Value::as_str).ok_or_else(|| WorkerError::py("KeyError", format!("'{key}'")))
}

/// Shared progress reporter: 0..1 and a message.
pub type Progress = Arc<dyn Fn(f64, &str) + Send + Sync>;

/// Downloads a model's artifacts and writes `installed.json`; `progress` receives 0..1 and a message.
pub fn download(payload: &Map<String, Value>, models_dir: &Path, progress: Progress) -> Result<Value> {
    let spec = model_spec(payload.get("model_id"))?;
    let id = artifact_str(&spec, "id")?.to_string();
    let destination = contained_path(models_dir, &id)?;
    std::fs::create_dir_all(&destination).map_err(|e| WorkerError::py("OSError", e))?;
    let _ = std::fs::remove_file(destination.join("installed.json"));
    // A registry entry that is not a list of Hugging Face artifacts (the separation pack) is for the Python worker.
    let files = spec
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| WorkerError::py("NotImplementedError", "this registry entry is not a list of artifacts"))?;
    let total: u64 = files.iter().map(|f| f["size"].as_u64().unwrap_or(0)).sum();
    let mut missing: Vec<&Value> = Vec::new();
    for item in files {
        let checked = contained_path(&destination, artifact_str(item, "path")?).and_then(|p| verify_file(&p, item));
        match checked {
            Ok(()) => {}
            Err(_) => missing.push(item), // a `WorkerError` of any code only means: fetch it again
        }
    }
    // Downloads land in a per-model staging folder, then move into place: no second copy.
    let staging = contained_path(models_dir, &format!(".download/{id}"))?;
    let need: u64 = missing.iter().map(|f| f["size"].as_u64().unwrap_or(0)).sum();
    let free = free_space(models_dir).map_err(|e| WorkerError::py("OSError", e))?;
    if !missing.is_empty() && free < need + 256 * MIB {
        return Err(WorkerError::new(
            "DISK_FULL",
            format!("Không đủ dung lượng: cần khoảng {} MB trống, còn {} MB.", need.div_ceil(MIB), free / MIB),
        ));
    }
    let mut done = total - need;
    let stop = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (stop, progress, staging, base) = (stop.clone(), progress.clone(), staging.clone(), done);
        std::thread::spawn(move || {
            // once a second: what the staging folder holds so far
            while !stop.load(Ordering::Relaxed) {
                for _ in 0..10 {
                    std::thread::sleep(Duration::from_millis(100));
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                }
                let ratio = (base + total_size(&staging)) as f64 / total as f64;
                progress(ratio.min(0.99), "Đang tải model");
            }
        })
    };
    let outcome = fetch_missing(&missing, &destination, &staging, total, &mut done, &*progress);
    stop.store(true, Ordering::Relaxed);
    let _ = watcher.join();
    outcome?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(models_dir.join(".hf"));
    let revision = artifact_str(&spec, "revision")?;
    let marker = destination.join("installed.json");
    let partial = marker.with_extension("partial");
    // Python writes the marker as text on Windows, so its line breaks are CRLF (92 bytes for the diarization marker).
    let record = serde_json::to_string_pretty(&json!({"model_id": id, "revision": revision}))
        .expect("json")
        .replace('\n', "\r\n");
    std::fs::write(&partial, record).map_err(|e| WorkerError::py("OSError", e))?;
    replace_with_retry(&partial, &marker).map_err(|e| WorkerError::py("OSError", e))?;
    progress(1.0, "Model sẵn sàng");
    Ok(json!({"model_id": id, "path": destination.to_string_lossy(), "revision": revision}))
}

fn fetch_missing(
    missing: &[&Value],
    destination: &Path,
    staging: &Path,
    total: u64,
    done: &mut u64,
    progress: &dyn Fn(f64, &str),
) -> Result<()> {
    if missing.is_empty() {
        return Ok(());
    }
    let hub = Hub::new().map_err(|e| WorkerError::py(e.class, e.detail))?;
    for item in missing {
        let target = contained_path(destination, artifact_str(item, "path")?)?;
        let filename = artifact_str(item, "filename")?;
        let fetched = hub
            .download(artifact_str(item, "repo")?, filename, artifact_str(item, "revision")?, staging)
            .map_err(|e| {
                WorkerError::new(
                    "NETWORK",
                    format!(
                        "Không tải được {filename} ({}). Kiểm tra mạng rồi bấm thử lại; phần đã tải được giữ lại.",
                        e.class
                    ),
                )
            })?;
        if let Err(error) = verify_file(&fetched, item) {
            let _ = std::fs::remove_file(&fetched);
            return Err(error);
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| WorkerError::py("OSError", e))?;
        }
        replace_with_retry(&fetched, &target).map_err(|e| WorkerError::py("OSError", e))?;
        *done += item["size"].as_u64().unwrap_or(0);
        progress((*done as f64 / total as f64).min(0.99), &format!("Đã kiểm tra {filename}"));
    }
    Ok(())
}
