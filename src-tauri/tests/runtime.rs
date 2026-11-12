use thanh_am_studio::{store::Store,runtime::{prepare_request,validate_output}};
use serde_json::json;
#[test]
fn stt_resolves_asset_id_and_never_trusts_payload_path(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let p=t.path().join("input.wav");std::fs::write(&p,b"RIFF0000WAVE").unwrap();let a=s.import_asset(&p).unwrap();
 let j=s.enqueue("stt",None,json!({"asset_id":a["id"],"input_path":"C:/secret","model_id":"whisper-small","language":"vi"})).unwrap();
 let r=prepare_request(&s,&j,None).unwrap();assert_eq!(r["payload"]["input_path"],a["path"]);
 assert_eq!(r["protocol"],1);assert_eq!(r["operation"],"stt");
}
#[test]
fn model_id_is_allowlisted(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let j=s.enqueue("model_download",None,json!({"model_id":"../../secrets"})).unwrap();
 assert!(prepare_request(&s,&j,None).unwrap_err().starts_with("INVALID_MODEL"));
}
#[test]
fn worker_result_outside_job_dir_is_rejected(){
 let t=tempfile::tempdir().unwrap();let out=t.path().join("job");std::fs::create_dir(&out).unwrap();let file=t.path().join("other.wav");std::fs::write(&file,b"audio").unwrap();
 assert!(validate_output(&out,&file).unwrap_err().starts_with("INVALID_OUTPUT"));
 let good=out.join("audio.wav");std::fs::write(&good,b"audio").unwrap();assert!(validate_output(&out,&good).is_ok());
}
#[test]
fn tts_speed_is_bounded_and_forwarded(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let ok=s.enqueue("tts",None,json!({"text":"Xin chào","speed":1.1})).unwrap();
 assert_eq!(prepare_request(&s,&ok,None).unwrap()["payload"]["speed"],json!(1.1));
 let plain=s.enqueue("tts",None,json!({"text":"Xin chào"})).unwrap();
 assert_eq!(prepare_request(&s,&plain,None).unwrap()["payload"]["speed"],json!(1.0));
 for bad in [json!(0.1),json!(3.0)]{let j=s.enqueue("tts",None,json!({"text":"Xin chào","speed":bad})).unwrap();assert_eq!(prepare_request(&s,&j,None).unwrap_err(),"INVALID_SPEED");}
}
