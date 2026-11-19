//! Engine routing and fallback against fake workers. This test binary is its own fake: it is copied to `python.exe` and
//! `thanham-worker.exe`, and when it starts under one of those names it plays a worker from the `script.json` beside it
//! (so the file is built with `harness = false` and runs its tests from `main`).
use serde_json::{json,Value};
use std::{fs,io::{BufRead,Write},path::{Path,PathBuf},sync::Arc,thread,time::Duration};
use thanh_am_studio::{engine,runtime::Runtime,store::Store};

// ---- the fake worker -------------------------------------------------------------------------------------------------------------
fn emit(id:&Value,mut e:Value){e["protocol"]=json!(1);e["id"]=id.clone();println!("{e}");let _=std::io::stdout().flush();}
fn fake_worker(exe:&Path){
 let args:Vec<String>=std::env::args().collect();
 if let Some(i)=args.iter().position(|a|a=="--grandchild"){fs::write(&args[i+1],std::process::id().to_string()).unwrap();thread::sleep(Duration::from_secs(600));return}
 let role=if exe.file_stem().unwrap()=="python"{"python"}else{"rust"};
 let mut line=String::new();std::io::stdin().lock().read_line(&mut line).unwrap();let req:Value=serde_json::from_str(&line).unwrap();
 let dir=exe.parent().unwrap();let id=req["id"].clone();let out=PathBuf::from(req["output_dir"].as_str().unwrap());
 let items:Vec<Value>=req["payload"]["items"].as_array().cloned().unwrap_or_default();
 let call=json!({"role":role,"operation":req["operation"],"outputs":items.iter().map(|i|i["output_name"].clone()).collect::<Vec<_>>(),"diarize":req["payload"]["diarize_model_path"].is_string()});
 let mut calls=fs::OpenOptions::new().create(true).append(true).open(dir.join("calls.jsonl")).unwrap();writeln!(calls,"{call}").unwrap();
 let script:Value=serde_json::from_str(&fs::read_to_string(dir.join("script.json")).unwrap()).unwrap();
 for a in script.as_array().unwrap(){
  match a["do"].as_str().unwrap(){
   "progress"=>emit(&id,json!({"event":"progress","progress":a["value"],"message":"working"})),
   "item"=>{let i=a["index"].as_u64().unwrap() as usize;
    if a["error"].is_object(){emit(&id,json!({"event":"item","index":i,"error":a["error"]}))}
    else{let f=out.join(items[i]["output_name"].as_str().unwrap());fs::write(&f,role).unwrap();emit(&id,json!({"event":"item","index":i,"result":{"path":f,"duration_ms":10,"sample_rate":48000}}))}},
   "result"=>emit(&id,json!({"event":"result","result":a["result"]})),
   "error"=>{let mut e=json!({"event":"error","code":a["code"],"message":a["message"]});if a["index"].is_number(){e["index"]=a["index"].clone();}emit(&id,e)},
   "exit"=>{let _=std::io::stdout().flush();std::process::exit(a["code"].as_i64().unwrap() as i32)},
   "grandchild"=>{let pidfile=a["pidfile"].as_str().unwrap();std::process::Command::new(exe).arg("--grandchild").arg(pidfile).spawn().unwrap();while !Path::new(pidfile).exists(){thread::sleep(Duration::from_millis(20))}},
   "sleep"=>thread::sleep(Duration::from_millis(a["ms"].as_u64().unwrap())),
   other=>panic!("unknown action {other}")}}
}

// ---- the harness -----------------------------------------------------------------------------------------------------------------
struct Env{dir:tempfile::TempDir,rt:Arc<Runtime>,store:Store}
fn setup(rust:Value,python:Value)->Env{
 let dir=tempfile::tempdir().unwrap();let res=dir.path().join("res");
 for (sub,exe,script) in [("runtime/python","python.exe",python),("worker","thanham-worker.exe",rust)]{let d=res.join(sub);fs::create_dir_all(&d).unwrap();fs::copy(std::env::current_exe().unwrap(),d.join(exe)).unwrap();fs::write(d.join("script.json"),script.to_string()).unwrap();}
 fs::write(res.join("worker/main.py"),"").unwrap();
 let store=Store::open(&dir.path().join("data")).unwrap();
 let rt=Arc::new(Runtime::new(res.clone(),res).with_rust_ops(&["tts","stt","render","download","clone_preview"]));
 Env{dir,rt,store}
}
impl Env{
 fn log(&self)->Vec<Value>{fs::read_to_string(self.store.root.join("worker-fallbacks.jsonl")).unwrap_or_default().lines().map(|l|serde_json::from_str(l).unwrap()).collect()}
 fn calls(&self,role:&str)->Vec<Value>{let f=self.dir.path().join("res").join(if role=="python"{"runtime/python"}else{"worker"}).join("calls.jsonl");fs::read_to_string(f).unwrap_or_default().lines().map(|l|serde_json::from_str(l).unwrap()).collect()}
 fn download(&self)->(Value,Result<(),String>){let j=self.store.enqueue("model_download",None,json!({"model_id":"whisper-small"})).unwrap();let job=self.store.claim_next().unwrap().unwrap();let r=self.rt.execute(&self.store,&[job]);let id=j["id"].as_str().unwrap();if let Err(e)=&r{self.store.fail(id,e).unwrap()} // the queue loop does this for an Err
  (self.store.job(id).unwrap(),r)}
 fn tts(&self,n:usize)->(Vec<Value>,Result<(),String>){
  let ids:Vec<String>=(0..n).map(|i|self.store.enqueue("tts",None,json!({"text":format!("câu {i}")})).unwrap()["id"].as_str().unwrap().to_string()).collect();
  let first=self.store.claim_next().unwrap().unwrap();let mut jobs=vec![first];jobs.extend(self.store.claim_queued("tts",31).unwrap());
  let r=self.rt.execute(&self.store,&jobs);(ids.iter().map(|i|self.store.job(i).unwrap()).collect(),r)}
 fn stt(&self)->(Value,Result<(),String>){
  let wav=self.dir.path().join("in.wav");fs::write(&wav,b"RIFF0000WAVE").unwrap();let a=self.store.import_asset(&wav).unwrap();
  let j=self.store.enqueue("stt",None,json!({"asset_id":a["id"],"model_id":"whisper-small","language":"vi","diarize":true})).unwrap();
  let job=self.store.claim_next().unwrap().unwrap();let r=self.rt.execute(&self.store,&[job]);(self.store.job(j["id"].as_str().unwrap()).unwrap(),r)}
}
fn ok(v:Value)->Value{json!({"do":"result","result":v})}
fn took(job:&Value)->String{fs::read_to_string(job["result"]["path"].as_str().unwrap()).unwrap()}

// ---- the cases -------------------------------------------------------------------------------------------------------------------
fn every_eligible_exit_code_reruns_on_python_and_is_logged(){
 for code in [0xC0000135u32,0xC0000005,0xC000001D,0xC0000409,0xC00000FD,101]{
  let e=setup(json!([{"do":"exit","code":code as i32}]),json!([ok(json!({"done":1}))]));
  let (job,r)=e.download();r.unwrap();
  assert_eq!((job["status"].as_str(),job["result"]["engine"].as_str(),job["result"]["fallback"].as_bool()),(Some("succeeded"),Some("python"),Some(true)),"exit {code:#x}");
  let log=e.log();assert_eq!(log.len(),1,"exit {code:#x}");assert_eq!((log[0]["operation"].as_str(),log[0]["action"].as_str(),log[0]["exit"].as_i64()),(Some("download"),Some("rerun"),Some(code as i32 as i64)));
  assert_eq!(engine::fallback_count(&e.store.root),1);
 }
}
fn an_out_of_memory_exit_is_not_eligible(){
 let e=setup(json!([{"do":"exit","code":0xC0000017u32 as i32}]),json!([ok(json!({"done":1}))]));
 let (job,r)=e.download();r.unwrap_err();assert_eq!(job["status"],"failed");assert!(job["error"].as_str().unwrap().starts_with("WORKER_EXIT"));
 assert!(e.log().is_empty()&&e.calls("python").is_empty());
}
fn a_crash_after_the_result_keeps_the_job_succeeded_and_is_logged(){
 let e=setup(json!([ok(json!({"done":1})),{"do":"exit","code":0xC0000005u32 as i32}]),json!([ok(json!({"done":2}))]));
 let (job,r)=e.download();r.unwrap();
 assert_eq!((job["status"].as_str(),job["result"]["engine"].as_str(),job["result"]["fallback"].as_bool(),job["result"]["done"].as_i64()),(Some("succeeded"),Some("rust"),Some(false),Some(1)));
 let log=e.log();assert_eq!((log.len(),log[0]["action"].as_str(),log[0]["code"].as_str()),(1,Some("exit_after_result"),Some("EXIT_AFTER_RESULT")));
 assert_eq!(engine::fallback_count(&e.store.root),0);assert!(e.calls("python").is_empty());
}
fn a_panic_on_item_two_of_three_keeps_item_one_and_reruns_the_rest_on_python(){
 let e=setup(json!([{"do":"item","index":0},{"do":"error","code":"RUST_PANIC","message":"boom","index":1},{"do":"exit","code":1}]),
  json!([{"do":"item","index":0},{"do":"item","index":1},ok(json!({"count":2}))]));
 let (jobs,r)=e.tts(3);r.unwrap();
 assert!(jobs.iter().all(|j|j["status"]=="succeeded"),"{jobs:?}");
 assert_eq!((jobs[0]["result"]["engine"].as_str(),jobs[0]["result"]["fallback"].as_bool(),took(&jobs[0]).as_str()),(Some("rust"),Some(false),"rust"));
 for j in &jobs[1..]{assert_eq!((j["result"]["engine"].as_str(),j["result"]["fallback"].as_bool(),took(j).as_str()),(Some("python"),Some(true),"python"));}
 let python=e.calls("python");assert_eq!(python.len(),1);
 assert_eq!(python[0]["outputs"],json!([format!("{}.wav",jobs[1]["id"].as_str().unwrap()),format!("{}.wav",jobs[2]["id"].as_str().unwrap())]));
 let log=e.log();assert_eq!((log.len(),log[0]["code"].as_str(),log[0]["operation"].as_str()),(1,Some("RUST_PANIC"),Some("tts")));
}
fn a_terminal_engine_error_before_the_result_reruns_on_python(){
 for code in ["WORKER_ERROR","RUNTIME_MISSING"]{
  let e=setup(json!([{"do":"error","code":code,"message":"engine"},{"do":"exit","code":1}]),json!([ok(json!({"done":1}))]));
  let (job,r)=e.download();r.unwrap();
  assert_eq!((job["status"].as_str(),job["result"]["engine"].as_str()),(Some("succeeded"),Some("python")),"{code}");
  let log=e.log();assert_eq!((log.len(),log[0]["code"].as_str()),(1,Some(code)));
 }
}
fn an_error_about_the_input_is_final_and_never_reruns(){
 let e=setup(json!([{"do":"error","code":"MODEL_NOT_READY","message":"Tải model trước."},{"do":"exit","code":1}]),json!([ok(json!({"done":1}))]));
 let (job,r)=e.download();r.unwrap_err();
 assert_eq!(job["status"],"failed");assert!(job["error"].as_str().unwrap().starts_with("MODEL_NOT_READY"));assert!(e.log().is_empty()&&e.calls("python").is_empty());
}
fn an_item_error_on_item_two_of_three_reruns_only_that_item_through_the_index_path(){
 let e=setup(json!([{"do":"item","index":0},{"do":"item","index":1,"error":{"code":"WORKER_ERROR","message":"engine"}},{"do":"item","index":2},ok(json!({"count":3}))]),
  json!([{"do":"item","index":0},ok(json!({"count":1}))]));
 let (jobs,r)=e.tts(3);r.unwrap();
 assert!(jobs.iter().all(|j|j["status"]=="succeeded"),"{jobs:?}");
 let engines:Vec<&str>=jobs.iter().map(|j|j["result"]["engine"].as_str().unwrap()).collect();assert_eq!(engines,["rust","python","rust"]);
 assert_eq!(jobs.iter().map(|j|j["result"]["fallback"].as_bool().unwrap()).collect::<Vec<_>>(),[false,true,false]);
 assert_eq!(e.calls("python")[0]["outputs"],json!([format!("{}.wav",jobs[1]["id"].as_str().unwrap())]));
 let log=e.log();assert_eq!((log.len(),log[0]["code"].as_str(),log[0]["action"].as_str()),(1,Some("WORKER_ERROR"),Some("rerun")));
}
fn an_invalid_text_item_does_not_rerun(){
 let e=setup(json!([{"do":"item","index":0},{"do":"item","index":1,"error":{"code":"INVALID_TEXT","message":"Văn bản trống."}},ok(json!({"count":2}))]),json!([{"do":"item","index":0},ok(json!({"count":1}))]));
 let (jobs,r)=e.tts(2);r.unwrap();
 assert_eq!((jobs[0]["status"].as_str(),jobs[1]["status"].as_str()),(Some("succeeded"),Some("failed")));assert!(jobs[1]["error"].as_str().unwrap().starts_with("INVALID_TEXT"));
 assert!(e.log().is_empty()&&e.calls("python").is_empty());
}
fn a_failed_diarization_process_reruns_the_whole_transcription_on_python(){
 let seg=json!([{"start":0.0,"end":1.0,"text":"xin chào"}]);
 let e=setup(json!([ok(json!({"segments":seg,"diarize_error_code":"DIARIZE_PROCESS","diarize_error":"spawn failed"}))]),json!([ok(json!({"segments":seg}))]));
 let (job,r)=e.stt();r.unwrap();
 assert_eq!((job["status"].as_str(),job["result"]["engine"].as_str(),job["result"]["fallback"].as_bool()),(Some("succeeded"),Some("python"),Some(true)));
 assert!(e.calls("python")[0]["diarize"].as_bool().unwrap());let log=e.log();assert_eq!((log.len(),log[0]["code"].as_str()),(1,Some("DIARIZE_PROCESS")));
}
fn a_model_check_failure_keeps_the_transcript_without_speakers(){
 for code in ["MODEL_NOT_READY","MODEL_CHECKSUM"]{
  let seg=json!([{"start":0.0,"end":1.0,"text":"xin chào"}]);
  let e=setup(json!([ok(json!({"segments":seg,"diarize_error_code":code,"diarize_error":"Chưa có model."}))]),json!([ok(json!({"segments":seg}))]));
  let (job,r)=e.stt();r.unwrap();
  assert_eq!((job["status"].as_str(),job["result"]["engine"].as_str(),job["result"]["fallback"].as_bool(),job["result"]["diarize_error"].as_str()),(Some("succeeded"),Some("rust"),Some(false),Some("Chưa có model.")),"{code}");
  assert_eq!(job["result"]["transcript"].as_array().unwrap().len(),1);assert!(e.log().is_empty()&&e.calls("python").is_empty());
 }
}
fn the_user_can_pin_an_operation_to_python_and_the_change_is_logged(){
 let e=setup(json!([ok(json!({"done":"rust"}))]),json!([ok(json!({"done":"python"}))]));
 e.store.save_settings(json!({"dictionary":{},"worker_engines":{"download":"python"}})).unwrap();
 let (job,r)=e.download();r.unwrap();assert_eq!((job["result"]["engine"].as_str(),job["result"]["fallback"].as_bool()),(Some("python"),Some(false)));assert!(e.calls("rust").is_empty());
 let changes=fs::read_to_string(e.store.root.join("worker-engine-changes.jsonl")).unwrap();let c:Value=serde_json::from_str(changes.lines().next().unwrap()).unwrap();
 assert_eq!((c["operation"].as_str(),c["from"].as_str(),c["to"].as_str()),(Some("download"),Some("auto"),Some("python")));
 // a dictionary-only save keeps the choice; an unknown value or operation is refused
 e.store.save_settings(json!({"dictionary":{"a":"b"}})).unwrap();assert_eq!(e.store.settings().unwrap()["worker_engines"]["download"],"python");
 assert!(e.store.save_settings(json!({"dictionary":{},"worker_engines":{"download":"rust"}})).is_err());assert!(e.store.save_settings(json!({"dictionary":{},"worker_engines":{"nope":"auto"}})).is_err());
}
fn the_separation_runtime_download_stays_on_python(){
 let e=setup(json!([ok(json!({"done":"rust"}))]),json!([ok(json!({"done":"python"}))]));
 let j=e.store.enqueue("model_download",None,json!({"model_id":"separation-runtime"})).unwrap();let job=e.store.claim_next().unwrap().unwrap();e.rt.execute(&e.store,&[job]).unwrap();
 let job=e.store.job(j["id"].as_str().unwrap()).unwrap();assert_eq!((job["result"]["engine"].as_str(),job["result"]["fallback"].as_bool()),(Some("python"),Some(false)));assert!(e.calls("rust").is_empty());
}
fn cloned_voices_route_by_reference_format_and_take_checks_stay_on_python(){
 let routed=|kind:&str,ext:&str,payloads:Vec<Value>,engine:&str|{
  let n=if kind=="tts"{payloads.len()}else{0};let mut script:Vec<Value>=(0..n).map(|i|json!({"do":"item","index":i})).collect();script.push(ok(json!({"count":n})));
  let e=setup(json!(script),json!(script));
  let r=e.dir.path().join(format!("ref.{ext}"));fs::write(&r,b"RIFF0000WAVE").unwrap();let a=e.store.import_asset(&r).unwrap();
  let ids:Vec<String>=payloads.iter().map(|p|{let mut p=p.clone();for k in ["reference_asset_id","asset_id"]{if p[k]=="REF"{p[k]=a["id"].clone();}}e.store.enqueue(kind,None,p).unwrap()["id"].as_str().unwrap().to_string()}).collect();
  let first=e.store.claim_next().unwrap().unwrap();let mut jobs=vec![first];jobs.extend(e.store.claim_queued(kind,31).unwrap());
  let _=e.rt.execute(&e.store,&jobs);
  let other=if engine=="rust"{"python"}else{"rust"};
  assert!(e.calls(other).is_empty()&&e.log().is_empty(),"{kind} {ext} {payloads:?}");assert_eq!(e.calls(engine).len(),1,"{kind} {ext} {payloads:?}");
  if kind=="tts"{for id in &ids{let j=e.store.job(id).unwrap();assert_eq!((j["status"].as_str(),j["result"]["engine"].as_str(),j["result"]["fallback"].as_bool()),(Some("succeeded"),Some(engine),Some(false)),"{ext} {payloads:?}");}}
 };
 for ext in ["wav","flac","ogg","opus","mp3","aiff"]{
  routed("tts",ext,vec![json!({"text":"câu","reference_asset_id":"REF"})],"rust");
  routed("clone_preview",ext,vec![json!({"asset_id":"REF"})],"rust");
 }
 for ext in ["m4a","aac","mp4","webm","wma"]{
  routed("tts",ext,vec![json!({"text":"câu một"}),json!({"text":"câu hai","reference_asset_id":"REF"})],"python"); // one such item takes the batch
  routed("clone_preview",ext,vec![json!({"asset_id":"REF"})],"python");
 }
 routed("tts","wav",vec![json!({"text":"câu","reference_asset_id":"REF","check":true})],"python");
 routed("tts","wav",vec![json!({"text":"câu một"}),json!({"text":"câu hai","check":true})],"python"); // one checked item takes the whole batch to Python
}
fn the_release_routes_stt_with_speakers_to_the_native_worker(){
 assert!(engine::RUST_OPS.contains(&"stt"));
 for payload in [json!({"language":"vi"}),json!({"language":"auto","diarize_model_path":"d","num_speakers":2})]{assert!(engine::native_can_run(&json!({"operation":"stt","payload":payload})),"{payload}")}
}
fn status_reports_the_native_worker(){
 let e=setup(json!([]),json!([]));let s=e.rt.status();assert_eq!(s["native_worker_ready"],true);assert!(s["native_worker_path"].as_str().unwrap().ends_with("thanham-worker.exe"));
 let bare=Runtime::new(e.dir.path().join("none"),e.dir.path().join("none"));assert_eq!((bare.status()["native_worker_ready"].as_bool(),bare.status()["native_worker_path"].is_null()),(Some(false),true));
}
fn diagnostics_hold_the_settings_and_both_logs(){
 let e=setup(json!([{"do":"exit","code":101}]),json!([ok(json!({"done":1}))]));e.download().1.unwrap();
 e.store.save_settings(json!({"dictionary":{},"worker_engines":{"render":"python"}})).unwrap();
 let t=engine::diagnostics(&e.store.root,&e.store.settings().unwrap());
 assert!(t.contains("== settings ==")&&t.contains("\"render\": \"python\"")&&t.contains("worker-fallbacks.jsonl")&&t.contains("\"action\":\"rerun\"")&&t.contains("worker-engine-changes.jsonl")&&t.contains("\"to\":\"python\""),"{t}");
}
fn cancelling_a_job_kills_what_its_worker_started(){
 let dir=tempfile::tempdir().unwrap();let pidfile=dir.path().join("grandchild.pid");
 let e=Arc::new(setup(json!([{"do":"grandchild","pidfile":pidfile},{"do":"sleep","ms":60000}]),json!([ok(json!({"done":1}))])));
 let j=e.store.enqueue("model_download",None,json!({"model_id":"whisper-small"})).unwrap();let job=e.store.claim_next().unwrap().unwrap();
 let worker={let e=e.clone();thread::spawn(move||e.rt.execute(&e.store,&[job]))};
 for _ in 0..400{if pidfile.exists()&&!fs::read_to_string(&pidfile).unwrap_or_default().is_empty(){break}thread::sleep(Duration::from_millis(50))}
 let pid=fs::read_to_string(&pidfile).unwrap();assert!(running(&pid),"the grandchild should be alive before the cancel");
 e.store.cancel(j["id"].as_str().unwrap()).unwrap();
 assert_eq!(worker.join().unwrap().unwrap_err(),"CANCELLED");
 for _ in 0..100{if !running(&pid){return}thread::sleep(Duration::from_millis(50))}
 panic!("grandchild {pid} survived the cancel");
}
fn running(pid:&str)->bool{let o=std::process::Command::new("tasklist").args(["/FI",&format!("PID eq {pid}"),"/NH"]).output().unwrap();String::from_utf8_lossy(&o.stdout).contains(pid)}

fn main(){
 let exe=std::env::current_exe().unwrap();
 if matches!(exe.file_stem().and_then(|s|s.to_str()),Some("python"|"thanham-worker")){return fake_worker(&exe)}
 let cases:&[(&str,fn())]=&[
  ("every_eligible_exit_code_reruns_on_python_and_is_logged",every_eligible_exit_code_reruns_on_python_and_is_logged),
  ("an_out_of_memory_exit_is_not_eligible",an_out_of_memory_exit_is_not_eligible),
  ("a_crash_after_the_result_keeps_the_job_succeeded_and_is_logged",a_crash_after_the_result_keeps_the_job_succeeded_and_is_logged),
  ("a_panic_on_item_two_of_three_keeps_item_one_and_reruns_the_rest_on_python",a_panic_on_item_two_of_three_keeps_item_one_and_reruns_the_rest_on_python),
  ("a_terminal_engine_error_before_the_result_reruns_on_python",a_terminal_engine_error_before_the_result_reruns_on_python),
  ("an_error_about_the_input_is_final_and_never_reruns",an_error_about_the_input_is_final_and_never_reruns),
  ("an_item_error_on_item_two_of_three_reruns_only_that_item_through_the_index_path",an_item_error_on_item_two_of_three_reruns_only_that_item_through_the_index_path),
  ("an_invalid_text_item_does_not_rerun",an_invalid_text_item_does_not_rerun),
  ("a_failed_diarization_process_reruns_the_whole_transcription_on_python",a_failed_diarization_process_reruns_the_whole_transcription_on_python),
  ("a_model_check_failure_keeps_the_transcript_without_speakers",a_model_check_failure_keeps_the_transcript_without_speakers),
  ("the_user_can_pin_an_operation_to_python_and_the_change_is_logged",the_user_can_pin_an_operation_to_python_and_the_change_is_logged),
  ("the_separation_runtime_download_stays_on_python",the_separation_runtime_download_stays_on_python),
  ("cloned_voices_route_by_reference_format_and_take_checks_stay_on_python",cloned_voices_route_by_reference_format_and_take_checks_stay_on_python),
  ("the_release_routes_stt_with_speakers_to_the_native_worker",the_release_routes_stt_with_speakers_to_the_native_worker),
  ("status_reports_the_native_worker",status_reports_the_native_worker),
  ("diagnostics_hold_the_settings_and_both_logs",diagnostics_hold_the_settings_and_both_logs),
  ("cancelling_a_job_kills_what_its_worker_started",cancelling_a_job_kills_what_its_worker_started)];
 let filter=std::env::args().skip(1).find(|a|!a.starts_with('-'));let mut failed=0;
 for (name,case) in cases.iter().filter(|(n,_)|filter.as_ref().is_none_or(|f|n.contains(f.as_str()))){
  match std::panic::catch_unwind(case){Ok(())=>println!("test {name} ... ok"),Err(_)=>{failed+=1;println!("test {name} ... FAILED")}}
 }
 println!("test result: {}. {failed} failed",if failed==0{"ok"}else{"FAILED"});
 if failed>0{std::process::exit(1)}
}
