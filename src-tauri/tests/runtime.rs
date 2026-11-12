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
#[test]
fn tts_take_check_uses_the_app_whisper_model_only_when_asked(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let on=s.enqueue("tts",None,json!({"text":"Xin chào","check":true,"check_model_path":"C:/elsewhere"})).unwrap();
 let r=prepare_request(&s,&on,None).unwrap();assert_eq!(r["payload"]["check_model_path"],json!(t.path().join("models").join("whisper-small")));
 let off=s.enqueue("tts",None,json!({"text":"Xin chào","check_model_path":"C:/elsewhere"})).unwrap();
 assert!(prepare_request(&s,&off,None).unwrap()["payload"]["check_model_path"].is_null());
}
#[test]
fn stt_diarization_uses_the_app_model_only_when_asked(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let p=t.path().join("input.wav");std::fs::write(&p,b"RIFF0000WAVE").unwrap();let a=s.import_asset(&p).unwrap();
 let on=s.enqueue("stt",None,json!({"asset_id":a["id"],"model_id":"whisper-small","diarize":true,"diarize_model_path":"C:/x"})).unwrap();
 assert_eq!(prepare_request(&s,&on,None).unwrap()["payload"]["diarize_model_path"],json!(t.path().join("models").join("diarization")));
 let off=s.enqueue("stt",None,json!({"asset_id":a["id"],"model_id":"whisper-small","diarize_model_path":"C:/x"})).unwrap();
 assert!(prepare_request(&s,&off,None).unwrap()["payload"]["diarize_model_path"].is_null());
}
#[test]
fn stt_speaker_count_is_bounded_and_needs_diarization(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let p=t.path().join("input.wav");std::fs::write(&p,b"RIFF0000WAVE").unwrap();let a=s.import_asset(&p).unwrap();
 let job=|extra:serde_json::Value|{let mut v=json!({"asset_id":a["id"],"model_id":"whisper-small"});for(k,x) in extra.as_object().unwrap(){v[k]=x.clone();}s.enqueue("stt",None,v).unwrap()};
 assert_eq!(prepare_request(&s,&job(json!({"diarize":true,"num_speakers":2})),None).unwrap()["payload"]["num_speakers"],json!(2));
 assert!(prepare_request(&s,&job(json!({"diarize":true})),None).unwrap()["payload"]["num_speakers"].is_null());
 assert!(prepare_request(&s,&job(json!({"num_speakers":2})),None).unwrap()["payload"]["num_speakers"].is_null());
 for bad in [json!(0),json!(9),json!(2.5),json!("2")]{assert_eq!(prepare_request(&s,&job(json!({"diarize":true,"num_speakers":bad})),None).unwrap_err(),"INVALID_SPEAKERS");}
}
