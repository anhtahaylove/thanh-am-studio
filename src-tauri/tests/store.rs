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

#[test]
// The client owns `speaker_slots` (UI colour slot per speaker name, docs/CONTRACT.md); the store keeps it as opaque project JSON, so no store code knows it.
fn save_and_load_keep_the_client_speaker_slots() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Màu người nói").unwrap();
    p["segments"] = json!([{"id":"a","text":"Chào","speaker":"Lan","takes":[],"selected_take_id":null},{"id":"b","text":"Ừ","speaker":"Minh","takes":[],"selected_take_id":null}]);
    p["speaker_slots"] = json!({"Lan":0,"Minh":3});
    let saved = s.save_project(p).unwrap();
    assert_eq!(saved["speaker_slots"], json!({"Lan":0,"Minh":3}));
    assert_eq!(s.load_project(saved["id"].as_str().unwrap()).unwrap(), saved);
}

// ---- Project version history (schema v2). A second `rusqlite::Connection` reads and edits the file the store has open. ----

const V1_BATCH: &str = "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
   CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS voices(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
   PRAGMA user_version=1;";

fn db(dir: &std::path::Path) -> rusqlite::Connection { rusqlite::Connection::open(dir.join("studio.sqlite3")).unwrap() }
fn count(dir: &std::path::Path, sql: &str) -> i64 { db(dir).query_row(sql, [], |r| r.get(0)).unwrap() }
fn versions_of(dir: &std::path::Path) -> i64 { count(dir, "SELECT count(*) FROM project_versions") }
/// Makes every stored version old, in write order, so the next save finds the ten-minute throttle over.
fn age_versions(dir: &std::path::Path) {
    db(dir).execute("UPDATE project_versions SET created_at=printf('2020-01-01T%02d:%02d:00.000000000+00:00',rowid/60,rowid%60)", []).unwrap();
}
fn pid(p: &serde_json::Value) -> String { p["id"].as_str().unwrap().to_owned() }
fn seg(id: &str, text: &str) -> serde_json::Value { json!({"id":id,"text":text,"takes":[],"selected_take_id":null}) }
/// A non-empty project at revision 1 (the stored state before this save was empty, so it has no version).
fn project(s: &Store) -> serde_json::Value {
    let mut p = s.create_project("Dự án").unwrap();
    p["segments"] = json!([seg("one", "Xin chào"), seg("two", "Tạm biệt")]);
    s.save_project(p).unwrap()
}
fn edit(s: &Store, mut p: serde_json::Value, text: &str) -> serde_json::Value {
    p["segments"][0]["text"] = json!(text);
    s.save_project(p).unwrap()
}
fn land_take(s: &Store, project_id: &str, segment: &str, asset: &str) {
    s.enqueue("tts", Some(project_id), json!({"segment_id":segment,"text":"x"})).unwrap();
    let job = s.claim_next().unwrap().unwrap();
    s.finish(job["id"].as_str().unwrap(), json!({"asset_id":asset,"path":"x.wav","duration_ms":10,"sample_rate":48000})).unwrap();
}
fn take_ids(p: &serde_json::Value, segment: usize) -> Vec<String> {
    let mut ids: Vec<String> = p["segments"][segment]["takes"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_owned()).collect();
    ids.sort();
    ids
}

#[test]
fn a_1_0_23_database_gains_the_versions_table_and_user_version_2_with_its_project_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let data = r#"{"id":"p1","name":"Cũ","revision":4,"updated_at":"2026-11-20T00:00:00Z","segments":[{"id":"a","text":"Chào","takes":[],"selected_take_id":null}],"transcript":[],"dictionary":{},"source_asset_id":null}"#;
    {
        let old = db(tmp.path());
        old.execute_batch(V1_BATCH).unwrap();
        old.execute("INSERT INTO projects VALUES('p1','Cũ',4,'2026-11-20T00:00:00Z',?1)", [data]).unwrap();
    }
    let s = Store::open(tmp.path()).unwrap();
    let d = db(tmp.path());
    assert_eq!(d.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(count(tmp.path(), "SELECT count(*) FROM sqlite_master WHERE name IN ('project_versions','project_versions_by_project')"), 2);
    assert_eq!(d.query_row("SELECT data FROM projects WHERE id='p1'", [], |r| r.get::<_, String>(0)).unwrap(), data);
    assert_eq!(s.load_project("p1").unwrap()["revision"], 4);
    assert_eq!(s.list_versions("p1").unwrap().len(), 0);
}

#[test]
fn opening_twice_keeps_the_version_schema_and_its_rows() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let s = Store::open(tmp.path()).unwrap();
        let p = project(&s);
        edit(&s, p, "Đã sửa");
    }
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!(db(tmp.path()).query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(versions_of(tmp.path()), 1);
    drop(s);
    assert!(Store::open(tmp.path()).is_ok());
}

#[test]
fn the_first_save_of_a_non_empty_project_keeps_the_stored_state_as_an_auto_version() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let p1 = project(&s);
    assert_eq!(versions_of(tmp.path()), 0, "the stored state of the first save was empty");
    edit(&s, p1.clone(), "Đã sửa");
    let v = s.list_versions(&pid(&p1)).unwrap();
    assert_eq!(v.len(), 1);
    let chars = "Xin chào".chars().count() + "Tạm biệt".chars().count();
    assert_eq!(
        (&v[0]["reason"], &v[0]["revision"], &v[0]["state_at"], &v[0]["segments"], &v[0]["transcript"], &v[0]["chars"]),
        (&json!("auto"), &json!(1), &p1["updated_at"], &json!(2), &json!(0), &json!(chars))
    );
    let (data, bytes): (Vec<u8>, i64) = db(tmp.path()).query_row("SELECT data,bytes FROM project_versions", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(bytes as usize, data.len());
    assert_eq!(v[0]["bytes"], bytes);
    let stored: serde_json::Value = serde_json::from_slice(&miniz_oxide::inflate::decompress_to_vec_with_limit(&data, 1 << 28).unwrap()).unwrap();
    assert_eq!(stored, p1, "the version is the stored JSON as it was before the save");
}

#[test]
fn an_empty_project_never_gets_a_version() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Trống").unwrap();
    for i in 0..3 {
        p["dictionary"] = json!({"k": i.to_string()});
        p = s.save_project(p).unwrap();
        age_versions(tmp.path());
    }
    assert_eq!(versions_of(tmp.path()), 0);
}

#[test]
fn a_second_save_within_ten_minutes_adds_no_version_but_a_stale_or_future_newest_one_does() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let set = |t: chrono::DateTime<chrono::Utc>| db(tmp.path()).execute("UPDATE project_versions SET created_at=?1", [t.to_rfc3339()]).unwrap();
    let mut p = edit(&s, project(&s), "a");
    assert_eq!(versions_of(tmp.path()), 1);
    p = edit(&s, p, "b");
    assert_eq!(versions_of(tmp.path()), 1, "within ten minutes");
    set(chrono::Utc::now() - chrono::Duration::minutes(9));
    p = edit(&s, p, "c");
    assert_eq!(versions_of(tmp.path()), 1, "nine minutes old is still fresh");
    set(chrono::Utc::now() - chrono::Duration::minutes(11));
    p = edit(&s, p, "d");
    assert_eq!(versions_of(tmp.path()), 2, "eleven minutes old is stale");
    set(chrono::Utc::now() + chrono::Duration::hours(1));
    p = edit(&s, p, "e");
    assert_eq!(versions_of(tmp.path()), 3, "a version dated in the future counts as stale");
    edit(&s, p, "f");
    assert_eq!(versions_of(tmp.path()), 3, "the version just written throttles again");
}

#[test]
fn a_revision_conflict_writes_no_version() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let p1 = project(&s);
    let p2 = edit(&s, p1.clone(), "a");
    age_versions(tmp.path());
    assert_eq!(versions_of(tmp.path()), 1);
    let mut stale = p1;
    stale["segments"][0]["text"] = json!("zzz");
    assert!(s.save_project(stale).unwrap_err().starts_with("REVISION_CONFLICT"));
    assert_eq!(versions_of(tmp.path()), 1);
    assert_eq!(s.load_project(&pid(&p2)).unwrap(), p2);
}

#[test]
fn list_versions_is_newest_first_with_the_documented_fields_and_empty_for_an_unknown_project() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = project(&s);
    for _ in 0..2 {
        p = edit(&s, p, "x");
        age_versions(tmp.path());
    }
    edit(&s, p.clone(), "y");
    let v = s.list_versions(&pid(&p)).unwrap();
    assert_eq!(v.iter().map(|x| x["revision"].as_i64().unwrap()).collect::<Vec<_>>(), [3, 2, 1]);
    let mut keys: Vec<&String> = v[0].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["bytes", "chars", "created_at", "id", "project_id", "reason", "revision", "segments", "state_at", "transcript"]);
    assert_eq!(s.list_versions("no-such-project").unwrap(), Vec::<serde_json::Value>::new());
}

#[test]
fn thirty_one_versions_keep_the_newest_thirty() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = project(&s);
    for i in 0..31 {
        p = edit(&s, p, &format!("v{i}"));
        age_versions(tmp.path());
    }
    assert_eq!(versions_of(tmp.path()), 30);
    assert_eq!(count(tmp.path(), "SELECT min(revision) FROM project_versions"), 2, "the oldest went first");
}

#[test]
fn the_byte_cap_drops_the_oldest_versions_but_always_keeps_the_newest() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = project(&s);
    for i in 0..3 {
        p = edit(&s, p, &format!("v{i}"));
        age_versions(tmp.path());
    }
    assert_eq!(versions_of(tmp.path()), 3);
    db(tmp.path()).execute("UPDATE project_versions SET bytes=20*1024*1024", []).unwrap();
    p = edit(&s, p, "next");
    assert_eq!(versions_of(tmp.path()), 2, "the new small version and one 20 MiB one fit in 32 MiB");
    assert_eq!(count(tmp.path(), "SELECT min(revision) FROM project_versions"), 3);
    db(tmp.path()).execute("UPDATE project_versions SET bytes=40*1024*1024", []).unwrap();
    age_versions(tmp.path());
    edit(&s, p, "last");
    assert_eq!(versions_of(tmp.path()), 1, "older versions are dropped, the newest stays");
}

#[test]
fn ten_restores_keep_five_before_restore_versions_and_every_auto_one() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = project(&s);
    let id = pid(&p);
    for i in 0..3 {
        p = edit(&s, p, &format!("v{i}"));
        age_versions(tmp.path());
    }
    let autos: Vec<String> = s.list_versions(&id).unwrap().iter().map(|v| v["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(autos.len(), 3);
    for i in 0..10 {
        p = s.restore_version(&id, &autos[i % 3], p["revision"].as_i64().unwrap()).unwrap();
    }
    assert_eq!(count(tmp.path(), "SELECT count(*) FROM project_versions WHERE reason='before_restore'"), 5);
    assert_eq!(count(tmp.path(), "SELECT count(*) FROM project_versions WHERE reason='auto'"), 3);
    let kept: Vec<String> = s.list_versions(&id).unwrap().iter().filter(|v| v["reason"] == "auto").map(|v| v["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(kept.len(), 3);
    assert!(autos.iter().all(|a| kept.contains(a)));
}

#[test]
fn restore_brings_back_the_content_keeps_the_name_and_unseen_takes_and_records_before_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("A").unwrap();
    let id = pid(&p);
    p["segments"] = json!([{"id":"one","text":"v1","takes":[{"id":"t0","asset_id":"a0"}],"selected_take_id":"t0"},seg("two","hai")]);
    p = s.save_project(p).unwrap();
    p["segments"][0]["text"] = json!("v2");
    p["transcript"] = json!([{"id":"r1","start_ms":0,"end_ms":500,"text":"Chào"}]);
    s.save_project(p).unwrap();
    let version_one = s.list_versions(&id).unwrap().remove(0);
    assert_eq!(version_one["revision"], 1);
    age_versions(tmp.path());
    land_take(&s, &id, "one", "a1");
    p = s.load_project(&id).unwrap();
    p["name"] = json!("B");
    s.save_project(p).unwrap();
    land_take(&s, &id, "one", "a2");
    let current = s.load_project(&id).unwrap();
    assert_eq!((current["revision"].as_i64(), current["name"].as_str()), (Some(3), Some("B")));
    let before_updated_at = current["updated_at"].clone();
    let restored = s.restore_version(&id, version_one["id"].as_str().unwrap(), 3).unwrap();
    assert_eq!(restored["revision"], 4);
    assert_eq!(restored["name"], "B", "the name stays");
    assert_eq!(restored["segments"][0]["text"], "v1");
    assert_eq!(restored["transcript"], json!([]));
    assert_eq!(take_ids(&current, 0).len(), 3);
    assert_eq!(take_ids(&restored, 0), take_ids(&current, 0), "takes the version lacks are kept");
    assert_eq!(s.load_project(&id).unwrap(), restored);
    assert_eq!(db(tmp.path()).query_row("SELECT name FROM projects WHERE id=?1", [&id], |r| r.get::<_, String>(0)).unwrap(), "B");
    let before = s.list_versions(&id).unwrap().into_iter().find(|v| v["reason"] == "before_restore").unwrap();
    assert_eq!((&before["state_at"], &before["revision"]), (&before_updated_at, &json!(3)));
    assert_eq!(before["segments"], 2);
}

#[test]
fn restore_refuses_a_stale_revision_a_busy_project_an_unknown_version_and_another_projects_version() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let a = edit(&s, project(&s), "a2");
    let other = edit(&s, project(&s), "b2");
    let (aid, bid) = (pid(&a), pid(&other));
    let a_version = s.list_versions(&aid).unwrap().remove(0)["id"].as_str().unwrap().to_owned();
    let b_version = s.list_versions(&bid).unwrap().remove(0)["id"].as_str().unwrap().to_owned();
    let rev = a["revision"].as_i64().unwrap();
    let untouched = |s: &Store| (s.load_project(&aid).unwrap(), s.list_versions(&aid).unwrap().len());
    let before = untouched(&s);
    assert!(s.restore_version(&aid, &a_version, rev + 1).unwrap_err().starts_with("REVISION_CONFLICT: Dự án đã thay đổi. Hãy tải lại trước khi lưu."));
    assert!(s.restore_version(&aid, "nope", rev).unwrap_err().starts_with("VERSION_NOT_FOUND: Phiên bản này không còn. Mở lại lịch sử phiên bản."));
    assert!(s.restore_version(&aid, &b_version, rev).unwrap_err().starts_with("VERSION_NOT_FOUND"), "another project's version");
    assert!(s.restore_version("no-such-project", &a_version, rev).unwrap_err().starts_with("PROJECT_NOT_FOUND"));
    let job = s.enqueue("render", Some(&aid), json!({})).unwrap();
    assert!(s.restore_version(&aid, &a_version, rev).unwrap_err().starts_with("PROJECT_BUSY: Dự án đang có công việc chạy hoặc chờ. Chờ xong hoặc hủy rồi khôi phục."));
    assert_eq!(untouched(&s), before, "every refusal leaves the project and its versions alone");
    s.cancel(job["id"].as_str().unwrap()).unwrap();
    assert_eq!(s.restore_version(&aid, &a_version, rev).unwrap()["revision"], rev + 1);
}

#[test]
fn deleting_a_project_deletes_its_versions() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let a = edit(&s, project(&s), "a2");
    let b = edit(&s, project(&s), "b2");
    assert_eq!(versions_of(tmp.path()), 2);
    s.delete_project(&pid(&a)).unwrap();
    assert_eq!(count(tmp.path(), &format!("SELECT count(*) FROM project_versions WHERE project_id='{}'", pid(&a))), 0);
    assert_eq!(count(tmp.path(), &format!("SELECT count(*) FROM project_versions WHERE project_id='{}'", pid(&b))), 1);
}

#[test]
fn a_failing_version_insert_never_fails_the_save_and_is_logged_and_exported() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let p1 = project(&s);
    let other = db(tmp.path());
    other.execute_batch("CREATE TRIGGER no_versions BEFORE INSERT ON project_versions BEGIN SELECT RAISE(ABORT,'boom'); END;").unwrap();
    let p2 = edit(&s, p1.clone(), "vẫn lưu");
    assert_eq!((p2["revision"].as_i64(), p2["segments"][0]["text"].as_str()), (Some(2), Some("vẫn lưu")));
    assert_eq!(s.load_project(&pid(&p1)).unwrap(), p2);
    assert_eq!(versions_of(tmp.path()), 0);
    let log = std::fs::read_to_string(tmp.path().join("version-errors.jsonl")).unwrap();
    assert_eq!(log.lines().count(), 1);
    let line: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(line["project_id"], pid(&p1));
    assert!(line["error"].as_str().unwrap().contains("boom"), "{line}");
    assert!(line["at"].as_str().is_some());
    let text = s.diagnostics().unwrap();
    assert!(text.contains("== version-errors.jsonl ==") && text.contains("boom") && text.contains(&pid(&p1)), "{text}");
    other.execute_batch("DROP TRIGGER no_versions").unwrap();
    edit(&s, p2, "lại");
    assert_eq!(versions_of(tmp.path()), 1, "the next save writes the version again");
    assert_eq!(std::fs::read_to_string(tmp.path().join("version-errors.jsonl")).unwrap().lines().count(), 1);
}

#[test]
fn diagnostics_say_the_version_log_is_empty_when_nothing_failed() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    assert!(s.diagnostics().unwrap().ends_with("== version-errors.jsonl ==\n(empty)\n"));
}

#[test]
fn a_corrupt_version_blob_fails_the_restore_and_leaves_the_project_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let p = edit(&s, project(&s), "sau");
    let id = pid(&p);
    let version = s.list_versions(&id).unwrap().remove(0)["id"].as_str().unwrap().to_owned();
    db(tmp.path()).execute("UPDATE project_versions SET data=?1", [vec![0xffu8; 16]]).unwrap();
    assert!(s.restore_version(&id, &version, 2).unwrap_err().starts_with("VERSION_CORRUPT"));
    assert_eq!(s.load_project(&id).unwrap(), p);
    assert_eq!(versions_of(tmp.path()), 1, "no before_restore row is left behind");
    assert_eq!(s.save_project(p).unwrap()["revision"], 3, "the project still saves");
}

#[test]
fn a_2000_segment_save_costs_little_with_or_without_a_version_write() {
    use std::io::Write;
    let tmp = tempfile::tempdir().unwrap();
    let s = Store::open(tmp.path()).unwrap();
    let mut p = s.create_project("Lớn").unwrap();
    p["segments"] = json!((0..2000).map(|i| seg(&format!("s{i}"), &format!("Đoạn số {i}: Xin chào các bạn, hôm nay trời đẹp lắm, chúng ta cùng đi dạo {}.", i * 7919))).collect::<Vec<_>>());
    p = s.save_project(p).unwrap();
    let time = |s: &Store, p: serde_json::Value| { let t = std::time::Instant::now(); let saved = s.save_project(p).unwrap(); (saved, t.elapsed().as_millis()) };
    let (p, with_version) = time(&s, p);
    let (_, without_version) = time(&s, p.clone());
    let (raw, bytes) = (serde_json::to_vec(&p).unwrap().len() as i64, count(tmp.path(), "SELECT bytes FROM project_versions"));
    // Written to the stderr handle directly so CI shows it for a passing test (U10).
    let _ = writeln!(std::io::stderr(), "U10: 2000 segments json={raw} B deflated={bytes} B ratio={:.3}; save with version {with_version} ms, without {without_version} ms", bytes as f64 / raw as f64);
    assert_eq!(versions_of(tmp.path()), 1);
    assert!(bytes < raw / 2, "{bytes} of {raw}");
    assert!(with_version < 5000 && without_version < 5000, "{with_version} / {without_version} ms");
}

#[test]
fn a_1_0_23_open_batch_still_updates_and_deletes_a_project_and_cascades_its_versions() {
    let tmp = tempfile::tempdir().unwrap();
    let id;
    {
        let s = Store::open(tmp.path()).unwrap();
        let p = edit(&s, project(&s), "sau");
        id = pid(&p);
        assert_eq!(versions_of(tmp.path()), 1);
    }
    // 1.0.23 opens the file with its own batch: it knows nothing of the table, resets user_version to 1 and keeps foreign keys on.
    let old = db(tmp.path());
    old.execute_batch(V1_BATCH).unwrap();
    assert_eq!(old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    let n = old.execute("UPDATE projects SET name=?1,revision=?2,updated_at=?3,data=?4 WHERE id=?5 AND revision=?6", rusqlite::params!["Mới", 3, "2026-11-25T00:00:00Z", "{}", id, 2]).unwrap();
    assert_eq!(n, 1);
    assert_eq!(old.execute("DELETE FROM projects WHERE id=?1", [&id]).unwrap(), 1);
    assert_eq!(old.query_row("SELECT count(*) FROM project_versions", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "the delete cascaded");
    drop(old);
    let s = Store::open(tmp.path()).unwrap();
    assert_eq!(db(tmp.path()).query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 2, "the next 1.0.24 start sets it back");
    assert_eq!(s.list_projects().unwrap().len(), 0);
}
