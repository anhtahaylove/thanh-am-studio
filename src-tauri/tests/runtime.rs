use thanh_am_studio::{store::Store,runtime::{prepare_request,transcript_rows,validate_output}};
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
#[test]
fn stt_speaker_range_is_validated_and_passed_only_when_diarizing(){
 let t=tempfile::tempdir().unwrap();let s=Store::open(t.path()).unwrap();
 let p=t.path().join("input.wav");std::fs::write(&p,b"RIFF0000WAVE").unwrap();let a=s.import_asset(&p).unwrap();
 let job=|extra:serde_json::Value|{let mut v=json!({"asset_id":a["id"],"model_id":"whisper-small"});for(k,x) in extra.as_object().unwrap(){v[k]=x.clone();}s.enqueue("stt",None,v).unwrap()};
 let pay=prepare_request(&s,&job(json!({"diarize":true,"min_speakers":2,"max_speakers":4})),None).unwrap()["payload"].clone();
 assert_eq!((&pay["min_speakers"],&pay["max_speakers"],&pay["num_speakers"]),(&json!(2),&json!(4),&json!(null)));
 let pay=prepare_request(&s,&job(json!({"diarize":true,"min_speakers":3})),None).unwrap()["payload"].clone();
 assert_eq!((&pay["min_speakers"],&pay["max_speakers"]),(&json!(3),&json!(null)));
 let pay=prepare_request(&s,&job(json!({"diarize":true,"min_speakers":3,"max_speakers":3})),None).unwrap()["payload"].clone();
 assert_eq!((&pay["min_speakers"],&pay["max_speakers"]),(&json!(3),&json!(3)));
 let pay=prepare_request(&s,&job(json!({"min_speakers":2,"max_speakers":4})),None).unwrap()["payload"].clone();
 assert!(pay["min_speakers"].is_null()&&pay["max_speakers"].is_null());
 for bad in [json!({"min_speakers":0}),json!({"max_speakers":9}),json!({"min_speakers":2.5}),json!({"max_speakers":"3"}),json!({"min_speakers":4,"max_speakers":3}),
  json!({"num_speakers":2,"min_speakers":1}),json!({"num_speakers":2,"max_speakers":3})]{
  let mut v=json!({"diarize":true});for(k,x) in bad.as_object().unwrap(){v[k]=x.clone();}
  assert_eq!(prepare_request(&s,&job(v),None).unwrap_err(),"INVALID_SPEAKERS","{bad}");}
}
#[test]
fn transcript_rows_carry_the_speaker_and_the_overlapping_speaker(){
 let rows=transcript_rows(&[json!({"start":0.0,"end":1.5,"text":"a","speaker":1,"overlap":0}),json!({"start":1.5,"end":2.0,"text":"b","speaker":0}),json!({"start":2.0,"end":3.0,"text":"c"})]).unwrap();
 assert_eq!((&rows[0]["speaker"],&rows[0]["overlap_speaker"],&rows[0]["end_ms"]),(&json!(1),&json!(0),&json!(1500.0)));
 assert_eq!((&rows[1]["speaker"],&rows[1]["overlap_speaker"]),(&json!(0),&json!(null)));
 assert_eq!((&rows[2]["speaker"],&rows[2]["overlap_speaker"]),(&json!(null),&json!(null)));
 assert_eq!(transcript_rows(&[json!({"start":1.0,"end":1.0,"text":"x"})]).unwrap_err(),"INVALID_TIMESTAMP");
}
#[test]
fn worker_crash_codes_get_a_plain_cause(){
 use thanh_am_studio::runtime::exit_hint;
 assert!(exit_hint(Some(0xC000001Du32 as i32)).contains("AVX"));
 assert!(exit_hint(Some(0xC0000017u32 as i32)).contains("hết bộ nhớ"));
 assert!(exit_hint(Some(0xC0000005u32 as i32)).contains("worker.log"));
 assert_eq!(exit_hint(Some(1)),"");assert_eq!(exit_hint(None),"");
}
#[cfg(windows)]
#[test]
fn worker_keeps_the_machine_awake_until_it_ends(){
 use windows_sys::Win32::System::Power::*;
 let awake=thanh_am_studio::runtime::Awake::hold();
 // SetThreadExecutionState returns the state it replaces.
 assert_ne!(unsafe{SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)}&ES_SYSTEM_REQUIRED,0);
 drop(awake);
 assert_eq!(unsafe{SetThreadExecutionState(ES_CONTINUOUS)}&ES_SYSTEM_REQUIRED,0);
}
