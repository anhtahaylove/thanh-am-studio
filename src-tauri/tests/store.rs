use thanh_am_studio::store::Store;
use serde_json::json;

#[test]
fn project_roundtrip_uses_revision_lock_and_preserves_unicode() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let mut p = store.create_project("Tiếng Việt – bài thử").unwrap();
    let stale = p.clone();
    p["dictionary"] = json!({"TP.HCM":"Thành phố Hồ Chí Minh"});
    let saved = store.save_project(p).unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(store.load_project(saved["id"].as_str().unwrap()).unwrap(), saved);
    assert!(store.save_project(stale).unwrap_err().starts_with("REVISION_CONFLICT"));
}

#[test]
fn reopened_store_marks_running_jobs_interrupted_not_successful() {
    let tmp = tempfile::tempdir().unwrap();
    let id;
    {
        let s = Store::open(tmp.path()).unwrap();
        let p = s.create_project("Test").unwrap();
        let job = s.enqueue("tts", Some(p["id"].as_str().unwrap()), json!({"text":"Xin chào"})).unwrap();
        id = job["id"].as_str().unwrap().to_owned();
        assert!(s.claim_next().unwrap().is_some());
    }
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!(s.job(&id).unwrap()["status"], "interrupted");
    assert_eq!(s.retry(&id).unwrap()["status"], "queued");
}

#[test]
fn cancelled_job_is_not_claimed_and_cannot_be_completed() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let j = s.enqueue("render", None, json!({})).unwrap();
    let id = j["id"].as_str().unwrap();
    s.cancel(id).unwrap();
    assert!(s.claim_next().unwrap().is_none());
    assert!(s.finish(id, json!({"path":"fake.wav"})).is_err());
    assert_eq!(s.job(id).unwrap()["status"], "cancelled");
}

#[test]
fn import_is_content_addressed_and_rejects_non_media() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let source = tmp.path().join("nguồn.wav");
    std::fs::write(&source, b"RIFF1234WAVE").unwrap();
    let a = s.import_asset(&source).unwrap();
    let b = s.import_asset(&source).unwrap();
    assert_eq!(a["id"], b["id"]);
    assert_eq!(std::fs::read(source).unwrap(), b"RIFF1234WAVE");
    let bad = tmp.path().join("config.env");
    std::fs::write(&bad, b"secret").unwrap();
    assert!(s.import_asset(&bad).unwrap_err().starts_with("UNSUPPORTED_MEDIA"));
}

#[test]
fn project_validation_rejects_negative_gaps_before_database_write() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Test").unwrap();
    p["segments"] = json!([{"id":"one","text":"a","gap_ms":-4,"takes":[]}]);
    assert!(s.save_project(p).unwrap_err().starts_with("INVALID_SEGMENT"));
}
