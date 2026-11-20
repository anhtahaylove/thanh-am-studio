use serde_json::json;
use sha2::{Digest,Sha256};
use std::{fs,path::Path};
use thanh_am_studio::pack::{download_payload,installed,pinned_revision,ready_python,NOT_READY,PACK_ID};

fn hex(b:&[u8])->String{b.iter().map(|x|format!("{x:02x}")).collect()}
fn registry(dir:&Path,revision:&str)->std::path::PathBuf{let p=dir.join("models.json");fs::write(&p,json!({"schema":1,"models":[{"id":"htdemucs","revision":"x"},{"id":PACK_ID,"kind":"runtime","revision":revision}]}).to_string()).unwrap();p}
/// An installed pack under `root/models/separation-runtime`: python.exe, one nested file, a manifest and the marker.
fn install(root:&Path,revision:&str)->String{
 let d=root.join("models").join(PACK_ID);fs::create_dir_all(d.join("Lib/site-packages")).unwrap();
 fs::write(d.join("python.exe"),b"MZ").unwrap();fs::write(d.join("Lib/site-packages/torch.py"),b"x = 1\n").unwrap();
 let manifest=format!("{}  2  python.exe\n{}  6  Lib/site-packages/torch.py\n",hex(&Sha256::digest(b"MZ")),hex(&Sha256::digest(b"x = 1\n")));
 fs::write(d.join("MANIFEST.sha256"),&manifest).unwrap();
 let pin=hex(&Sha256::digest(manifest.as_bytes()));
 fs::write(d.join("installed.json"),json!({"model_id":PACK_ID,"revision":revision,"manifest_sha256":pin}).to_string()).unwrap();pin
}
#[test]
fn the_pack_is_ready_when_the_marker_the_manifest_and_every_file_agree(){
 let t=tempfile::tempdir().unwrap();let models=registry(t.path(),"separation-v1");
 assert_eq!(pinned_revision(&models).as_deref(),Some("separation-v1"));
 assert_eq!(ready_python(t.path(),&models).unwrap_err(),NOT_READY);assert!(!installed(t.path(),&models));
 install(t.path(),"separation-v1");
 assert!(installed(t.path(),&models));
 assert_eq!(ready_python(t.path(),&models).unwrap(),t.path().join("models").join(PACK_ID).join("python.exe"));
}
#[test]
fn a_pack_of_another_revision_counts_as_not_installed(){
 let t=tempfile::tempdir().unwrap();install(t.path(),"separation-v1");
 let newer=registry(t.path(),"separation-v2");
 assert!(!installed(t.path(),&newer));assert_eq!(ready_python(t.path(),&newer).unwrap_err(),NOT_READY);
 assert!(!installed(t.path(),&t.path().join("missing.json")));
}
#[test]
fn a_truncated_or_missing_file_is_refused_at_job_start_with_model_checksum(){
 let t=tempfile::tempdir().unwrap();let models=registry(t.path(),"separation-v1");install(t.path(),"separation-v1");
 let d=t.path().join("models").join(PACK_ID);
 fs::write(d.join("Lib/site-packages/torch.py"),b"x = ").unwrap(); // cut short
 let e=ready_python(t.path(),&models).unwrap_err();assert!(e.starts_with("MODEL_CHECKSUM"),"{e}");assert!(e.contains("Lib/site-packages/torch.py"));
 fs::remove_file(d.join("Lib/site-packages/torch.py")).unwrap();
 assert!(ready_python(t.path(),&models).unwrap_err().starts_with("MODEL_CHECKSUM"));
 // The cheap check behind `list_models` still says installed; only the job start walks the files.
 assert!(installed(t.path(),&models));
}
#[test]
fn a_manifest_that_is_not_the_pinned_one_is_refused(){
 let t=tempfile::tempdir().unwrap();let models=registry(t.path(),"separation-v1");install(t.path(),"separation-v1");
 let d=t.path().join("models").join(PACK_ID);
 let mut m=fs::read_to_string(d.join("MANIFEST.sha256")).unwrap();m.push_str(&format!("{}  0  ../outside.txt\n",hex(&Sha256::digest(b""))));
 fs::write(d.join("MANIFEST.sha256"),m).unwrap();
 assert!(ready_python(t.path(),&models).unwrap_err().starts_with("MODEL_CHECKSUM"));
 // Even a manifest the marker pins is not allowed to leave the pack folder.
 let pin=hex(&Sha256::digest(fs::read(d.join("MANIFEST.sha256")).unwrap()));
 fs::write(d.join("installed.json"),json!({"model_id":PACK_ID,"revision":"separation-v1","manifest_sha256":pin}).to_string()).unwrap();
 assert!(ready_python(t.path(),&models).unwrap_err().contains("../outside.txt"));
}
#[test]
fn installing_the_pack_needs_the_licence_but_checking_an_installed_pack_does_not(){
 let t=tempfile::tempdir().unwrap();let models=registry(t.path(),"separation-v1");
 assert!(download_payload(t.path(),&models,PACK_ID,false).unwrap_err().starts_with("LICENSE_NOT_ACCEPTED"));
 let accepted=download_payload(t.path(),&models,PACK_ID,true).unwrap();
 assert_eq!(accepted["model_id"],PACK_ID);assert!(chrono::DateTime::parse_from_rfc3339(accepted["license_accepted_at"].as_str().unwrap()).is_ok());
 assert_eq!(download_payload(t.path(),&models,"htdemucs",false).unwrap(),json!({"model_id":"htdemucs"})); // other models never ask
 install(t.path(),"separation-v1");
 assert_eq!(download_payload(t.path(),&models,PACK_ID,false).unwrap(),json!({"model_id":PACK_ID}));
}
#[test]
fn the_pack_is_a_registered_model_and_its_consent_reaches_the_worker(){
 use thanh_am_studio::{runtime::{prepare_request,MODELS},store::Store};
 assert!(MODELS.iter().any(|m|m.0==PACK_ID&&m.2=="runtime"));
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let j=s.enqueue("model_download",None,json!({"model_id":PACK_ID,"license_accepted_at":"2026-11-18T00:00:00+00:00"})).unwrap();
 let r=prepare_request(&s,&j,None).unwrap();
 assert_eq!((&r["operation"],&r["payload"]["model_id"],&r["payload"]["license_accepted_at"]),(&json!("download"),&json!(PACK_ID),&json!("2026-11-18T00:00:00+00:00")));
 let plain=s.enqueue("model_download",None,json!({"model_id":"htdemucs"})).unwrap();
 assert!(prepare_request(&s,&plain,None).unwrap()["payload"]["license_accepted_at"].is_null());
 assert_eq!(thanh_am_studio::model_description("runtime"),"Python và PyTorch để tách nhạc nền • tải một lần • local");
}
#[test]
fn a_separation_job_without_the_pack_is_refused_with_the_offline_message(){
 // The job runs on the pack's python, never on the installer's: without the pack it fails before any process starts.
 let t=tempfile::tempdir().unwrap();
 let e=ready_python(t.path(),&t.path().join("models.json")).unwrap_err();
 assert_eq!(e,"MODEL_NOT_READY: Chưa có gói chạy tách nhạc nền. Kết nối mạng rồi bấm Tải.");
}
