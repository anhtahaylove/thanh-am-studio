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
fn tts_take_landing_during_edit_is_kept_and_edit_saves() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Test").unwrap();
    p["segments"] = json!([{"id":"one","text":"Xin chào","takes":[],"selected_take_id":null}]);
    let mut p = s.save_project(p).unwrap();
    let pid = p["id"].as_str().unwrap().to_owned();
    s.enqueue("tts", Some(&pid), json!({"segment_id":"one","text":"Xin chào"})).unwrap();
    let job = s.claim_next().unwrap().unwrap();
    s.finish(job["id"].as_str().unwrap(), json!({"asset_id":"a1","path":"x.wav","duration_ms":10,"sample_rate":48000})).unwrap();
    // UI still holds the pre-take copy and the user keeps editing.
    p["segments"][0]["text"] = json!("Xin chào bạn");
    let saved = s.save_project(p).unwrap();
    assert_eq!(saved["segments"][0]["text"], "Xin chào bạn");
    let takes = saved["segments"][0]["takes"].as_array().unwrap();
    assert_eq!(takes.len(), 1);
    assert_eq!(saved["segments"][0]["selected_take_id"], takes[0]["id"]);
    assert_eq!(s.load_project(&pid).unwrap(), saved);
}

#[test]
fn first_take_trims_its_segment_to_the_speech_and_an_edit_keeps_that_trim() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Test").unwrap();
    p["segments"] = json!([{"id":"one","text":"Xin chào","takes":[],"selected_take_id":null,"trim_start_ms":0,"trim_end_ms":null}]);
    let mut p = s.save_project(p).unwrap();
    let pid = p["id"].as_str().unwrap().to_owned();
    for (start, end) in [(120, json!(1480)), (40, json!(null))] {
        s.enqueue("tts", Some(&pid), json!({"segment_id":"one","text":"Xin chào"})).unwrap();
        let job = s.claim_next().unwrap().unwrap();
        s.finish(job["id"].as_str().unwrap(), json!({"asset_id":"a1","path":"x.wav","duration_ms":1600,"sample_rate":48000,"speech_start_ms":start,"speech_end_ms":end})).unwrap();
    }
    p["segments"][0]["text"] = json!("Xin chào bạn"); // the UI never saw either take
    let saved = s.save_project(p).unwrap();
    let seg = &saved["segments"][0];
    assert_eq!(seg["takes"].as_array().unwrap().len(), 2);
    assert_eq!(seg["selected_take_id"], seg["takes"][0]["id"]); // the second take does not change the selection or its trim
    assert_eq!((seg["trim_start_ms"].as_f64(), seg["trim_end_ms"].as_f64()), (Some(120.0), Some(1480.0)));
    assert_eq!(seg["text"], "Xin chào bạn");
}

#[test]
fn claim_queued_batches_only_queued_jobs_of_one_kind() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let a = s.enqueue("tts", None, json!({})).unwrap();
    s.enqueue("render", None, json!({})).unwrap();
    let c = s.enqueue("tts", None, json!({})).unwrap();
    s.cancel(c["id"].as_str().unwrap()).unwrap();
    s.enqueue("tts", None, json!({})).unwrap();
    let got = s.claim_queued("tts", 10).unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(got[0]["id"], a["id"]);
    assert!(got.iter().all(|j| s.job(j["id"].as_str().unwrap()).unwrap()["status"] == "running"));
    assert!(s.claim_queued("tts", 10).unwrap().is_empty());
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

#[test]
fn app_settings_default_roundtrip_and_validation() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!(s.settings().unwrap(), json!({"dictionary":{}}));
    let saved = s.save_settings(json!({"dictionary":{"TP.HCM":"Thành phố Hồ Chí Minh"},"ignored":1})).unwrap();
    assert_eq!(saved, json!({"dictionary":{"TP.HCM":"Thành phố Hồ Chí Minh"}}));
    drop(s);
    assert_eq!(Store::open(tmp.path()).unwrap().settings().unwrap(), saved);
    let s = Store::open(tmp.path()).unwrap();
    for bad in [json!({}), json!({"dictionary":[]}), json!({"dictionary":{"a":1}}), json!({"dictionary":{"":"x"}})] { assert!(s.save_settings(bad).unwrap_err().starts_with("INVALID_SETTINGS")); }
    let many: serde_json::Map<String, serde_json::Value> = (0..5001).map(|i| (format!("k{i}"), json!("v"))).collect();
    assert!(s.save_settings(json!({"dictionary":many})).unwrap_err().starts_with("INVALID_SETTINGS"));
    assert_eq!(s.settings().unwrap(), saved);
}
