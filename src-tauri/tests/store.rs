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
fn first_take_keeps_the_whole_take_when_the_segment_fades_would_not_fit_its_speech() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Test").unwrap();
    p["segments"] = json!([{"id":"one","text":"Ừ","takes":[],"selected_take_id":null,"trim_start_ms":0,"trim_end_ms":null,"fade_in_ms":300,"fade_out_ms":300}]);
    let pid = s.save_project(p).unwrap()["id"].as_str().unwrap().to_owned();
    s.enqueue("tts", Some(&pid), json!({"segment_id":"one","text":"Ừ"})).unwrap();
    let job = s.claim_next().unwrap().unwrap();
    s.finish(job["id"].as_str().unwrap(), json!({"asset_id":"a1","path":"x.wav","duration_ms":900,"sample_rate":48000,"speech_start_ms":100,"speech_end_ms":560})).unwrap();
    let seg = &s.load_project(&pid).unwrap()["segments"][0];
    assert!(!seg["selected_take_id"].is_null());
    assert_eq!((seg["trim_start_ms"].as_f64(), seg["trim_end_ms"].is_null()), (Some(0.0), true)); // 460 ms of speech < 600 ms of fades
}

#[test]
fn a_clone_preview_is_claimed_before_earlier_queued_work_and_the_rest_stays_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let tts = s.enqueue("tts", None, json!({})).unwrap();
    let render = s.enqueue("render", None, json!({})).unwrap();
    let preview = s.enqueue("clone_preview", None, json!({})).unwrap();
    for want in [&preview, &tts, &render] { assert_eq!(s.claim_next().unwrap().unwrap()["id"], want["id"]); }
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

#[test]
fn a_segment_chapter_survives_save_and_load() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let mut p = store.create_project("Chương").unwrap();
    p["segments"] = json!([
        {"id":"s1","text":"Một.","normalized_text":"Một.","takes":[],"selected_take_id":null,"chapter":"P1"},
        {"id":"s2","text":"Hai.","normalized_text":"Hai.","takes":[],"selected_take_id":null,"chapter":null}
    ]);
    let saved = store.save_project(p).unwrap();
    let loaded = store.load_project(saved["id"].as_str().unwrap()).unwrap();
    assert_eq!(loaded["segments"][0]["chapter"], "P1");
    assert!(loaded["segments"][1]["chapter"].is_null());
}

#[test]
fn queued_separations_run_after_other_queued_work() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let separation = s.enqueue("separate", None, json!({"asset_id":"a1"})).unwrap();
    let tts = s.enqueue("tts", None, json!({"text":"Xin chào"})).unwrap();
    let preview = s.enqueue("clone_preview", None, json!({})).unwrap();
    for want in [&preview, &tts, &separation] { assert_eq!(s.claim_next().unwrap().unwrap()["id"], want["id"]); }
    assert!(s.claim_next().unwrap().is_none());
}

#[test]
fn a_separation_cut_off_by_a_crash_leaves_only_its_log() {
    let tmp = tempfile::tempdir().unwrap();
    let id = {
        let s = Store::open(tmp.path()).unwrap();
        let j = s.enqueue("separate", None, json!({"asset_id":"a1"})).unwrap();
        s.claim_next().unwrap().unwrap();
        j["id"].as_str().unwrap().to_owned()
    };
    let dir = tmp.path().join("jobs").join(&id);
    std::fs::create_dir_all(&dir).unwrap();
    for f in ["stem.partial.flac", "worker.log"] { std::fs::write(dir.join(f), b"x").unwrap(); }
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!(s.job(&id).unwrap()["status"], "interrupted");
    assert!(!dir.join("stem.partial.flac").exists() && dir.join("worker.log").exists());
}

#[test]
// Describes the merge result, which the HashMap must keep equal to the old linear search; it passes on main too and does not measure the speed-up.
fn takes_on_the_first_and_last_of_2000_segments_survive_a_save_of_the_pre_take_copy() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Sách nói").unwrap();
    p["segments"] = json!((0..2000).map(|i| json!({"id":format!("s{i}"),"text":"Xin chào","takes":[],"selected_take_id":null})).collect::<Vec<_>>());
    let mut p = s.save_project(p).unwrap();
    let pid = p["id"].as_str().unwrap().to_owned();
    for seg in ["s0", "s1999"] {
        s.enqueue("tts", Some(&pid), json!({"segment_id":seg,"text":"Xin chào"})).unwrap();
        let job = s.claim_next().unwrap().unwrap();
        s.finish(job["id"].as_str().unwrap(), json!({"asset_id":seg,"path":"x.wav","duration_ms":10,"sample_rate":48000})).unwrap();
    }
    p["segments"][1000]["text"] = json!("Đã sửa");
    let saved = s.save_project(p).unwrap();
    let segs = saved["segments"].as_array().unwrap();
    assert_eq!((segs.len(), &segs[1000]["text"]), (2000, &json!("Đã sửa")));
    for (i, seg) in [(0, "s0"), (1999, "s1999")] {
        assert_eq!(segs[i]["takes"].as_array().unwrap().iter().map(|t| t["asset_id"].clone()).collect::<Vec<_>>(), [json!(seg)]);
        assert_eq!(segs[i]["selected_take_id"], segs[i]["takes"][0]["id"]);
    }
    assert!(segs[1..1999].iter().all(|x| x["takes"] == json!([]) && x["selected_take_id"].is_null()));
    assert_eq!(s.load_project(&pid).unwrap(), saved);
}

#[test]
fn a_database_without_the_jobs_index_gains_it_on_open_and_the_claim_query_uses_it() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("studio.sqlite3");
    // The v1.0.20 jobs table (no index) with a job that was running when the app stopped and one that finished.
    rusqlite::Connection::open(&file).unwrap().execute_batch(r#"CREATE TABLE jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
        INSERT INTO jobs VALUES('run','render',NULL,'running','2026-11-20T00:00:00Z','{"id":"run","kind":"render","status":"running"}');
        INSERT INTO jobs VALUES('done','render',NULL,'succeeded','2026-11-20T00:00:01Z','{"id":"done","kind":"render","status":"succeeded"}');"#).unwrap();
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!((&s.job("run").unwrap()["status"], &s.job("done").unwrap()["status"]), (&json!("interrupted"), &json!("succeeded")));
    let db = rusqlite::Connection::open(&file).unwrap();
    let plan: Vec<String> = db.prepare(&format!("EXPLAIN QUERY PLAN {}", thanh_am_studio::store::CLAIM_NEXT)).unwrap()
        .query_map([], |r| r.get(3)).unwrap().collect::<Result<_, _>>().unwrap();
    assert!(plan.iter().any(|d| d.contains("USING INDEX jobs_status (status=?)")), "{plan:?}");
    drop(s);
    assert!(Store::open(tmp.path()).is_ok(), "reopening keeps the index");
}

#[test]
fn deleting_a_project_deletes_its_outputless_and_succeeded_tts_jobs_keeps_other_succeeded_ones_and_refuses_while_one_is_queued() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b, interrupted);
    {
        let s = Store::open(tmp.path()).unwrap();
        a = s.create_project("A").unwrap()["id"].as_str().unwrap().to_owned();
        b = s.create_project("B").unwrap()["id"].as_str().unwrap().to_owned();
        s.enqueue("render", Some(&a), json!({})).unwrap();
        interrupted = s.claim_next().unwrap().unwrap()["id"].as_str().unwrap().to_owned();
    }
    let s = Store::open(tmp.path()).unwrap();
    let job = |kind: &str, p: Option<&str>, payload: serde_json::Value| s.enqueue(kind, p, payload).unwrap()["id"].as_str().unwrap().to_owned();
    let status = |id: &str| s.job(id).map(|j| j["status"].as_str().unwrap().to_owned());
    // Both projects import the same song: assets are content-addressed, so they share one asset id and one separation.
    let song = tmp.path().join("song.mp4");
    std::fs::write(&song, b"media").unwrap();
    let asset = s.import_asset(&song).unwrap()["id"].clone();
    assert_eq!(s.import_asset(&song).unwrap()["id"], asset);
    let mut pb = s.load_project(&b).unwrap();
    pb["source_asset_id"] = asset.clone();
    s.save_project(pb).unwrap();
    let separated = job("separate", Some(&a), json!({"asset_id":asset}));
    s.claim_next().unwrap();
    s.finish(&separated, json!({"asset_id":"stem","path":"stem.flac"})).unwrap();
    let rendered = job("render", Some(&a), json!({}));
    s.claim_next().unwrap();
    s.finish(&rendered, json!({"path":"x.wav"})).unwrap();
    // A succeeded tts job only fed a take of the deleted project; an stt result can still be applied to another project.
    let spoken = job("tts", Some(&a), json!({"segment_id":"s1"}));
    s.claim_next().unwrap();
    s.finish(&spoken, json!({"path":"take.wav"})).unwrap();
    let transcribed = job("stt", Some(&a), json!({}));
    s.claim_next().unwrap();
    s.finish(&transcribed, json!({"transcript":[]})).unwrap();
    let failed = job("render", Some(&a), json!({}));
    s.claim_next().unwrap();
    s.fail(&failed, "x").unwrap();
    let (other, unowned) = (job("render", Some(&b), json!({})), job("render", None, json!({})));
    for id in [&other, &unowned] { s.cancel(id).unwrap(); }
    let kept = tmp.path().join("jobs").join(&rendered);
    std::fs::create_dir_all(&kept).unwrap();
    let busy = job("render", Some(&a), json!({}));
    assert!(s.delete_project(&a).unwrap_err().starts_with("PROJECT_BUSY"));
    s.claim_next().unwrap();
    assert!(s.delete_project(&a).unwrap_err().starts_with("PROJECT_BUSY"), "a running job keeps the project too");
    s.cancel(&busy).unwrap();
    let gone = [(&interrupted, "interrupted"), (&failed, "failed"), (&busy, "cancelled"), (&spoken, "succeeded")];
    for (id, want) in gone { assert_eq!(status(id).unwrap(), want); }
    s.delete_project(&a).unwrap();
    for (id, _) in gone { assert_eq!(status(id).unwrap_err(), "JOB_NOT_FOUND"); }
    // B's keep-background render still finds the stem by asset id, and A's render can still be saved from the queue.
    let jobs = s.list_jobs().unwrap();
    assert!(jobs.iter().any(|j| j["kind"] == "separate" && j["payload"]["asset_id"] == asset && j["status"] == "succeeded"));
    assert!(jobs.iter().any(|j| j["id"] == rendered.as_str() && j["status"] == "succeeded"));
    assert!(jobs.iter().any(|j| j["id"] == transcribed.as_str() && j["status"] == "succeeded"));
    assert_eq!((status(&other).unwrap(), status(&unowned).unwrap()), ("cancelled".into(), "cancelled".into()));
    assert!(s.load_project(&a).is_err() && s.load_project(&b).is_ok() && kept.exists());
}

#[test]
// Describes concurrency safety (the Store was already Mutex-guarded); it passes on main too and does not prove the commands left the main thread.
fn saves_claims_and_job_lists_from_several_threads_at_once_neither_deadlock_nor_lose_a_revision() {
    let tmp = tempfile::tempdir().unwrap();
    let s = std::sync::Arc::new(Store::open(tmp.path()).unwrap());
    let pid = s.create_project("A").unwrap()["id"].as_str().unwrap().to_owned();
    for _ in 0..40 { s.enqueue("render", Some(&pid), json!({})).unwrap(); }
    let (tx, rx) = std::sync::mpsc::channel();
    let (s2, pid2) = (s.clone(), pid.clone());
    std::thread::spawn(move || tx.send(std::thread::scope(|sc| {
        let (s, pid) = (&*s2, &pid2);
        let savers: Vec<_> = (0..4).map(|t| sc.spawn(move || (0..25).map(|i| loop {
            let mut p = s.load_project(pid).unwrap();
            p["name"] = json!(format!("{t}-{i}"));
            match s.save_project(p) { Ok(p) => break p["revision"].as_i64().unwrap(), Err(e) if e.starts_with("REVISION_CONFLICT") => continue, Err(e) => panic!("{e}") }
        }).collect::<Vec<_>>())).collect();
        let lister = sc.spawn(move || for _ in 0..50 { assert_eq!(s.list_jobs().unwrap().len(), 40); });
        let claimer = sc.spawn(move || std::iter::from_fn(|| s.claim_next().unwrap()).count());
        let saves: Vec<i64> = savers.into_iter().flat_map(|h| h.join().unwrap()).collect();
        lister.join().unwrap();
        (saves, claimer.join().unwrap())
    })).unwrap());
    let (mut saves, claimed) = rx.recv_timeout(std::time::Duration::from_secs(120)).expect("the threads finished (no deadlock, no panic)");
    saves.sort();
    assert_eq!(saves, (1..=100).collect::<Vec<_>>(), "every save got its own revision");
    assert_eq!((s.load_project(&pid).unwrap()["revision"].as_i64(), claimed), (Some(100), 40));
    assert!(s.list_jobs().unwrap().iter().all(|j| j["status"] == "running"));
}
