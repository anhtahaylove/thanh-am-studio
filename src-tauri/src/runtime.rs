use crate::{engine::{self,Engine},store::{Result,Store}};
use serde_json::{json,Value};
use std::{fs,io::{BufRead,BufReader,Write},path::{Path,PathBuf},process::{Command,Stdio},sync::{Arc,atomic::{AtomicBool,Ordering}},thread,time::Duration};
#[cfg(windows)] use std::os::windows::process::CommandExt;

pub const MODELS:&[(&str,&str,&str,&str)] = &[("vieneu-v3","VieNeu v3 Turbo","tts","Apache-2.0"),("whisper-small","Whisper Small","stt","MIT"),("whisper-turbo","Whisper Large v3 Turbo","stt","MIT"),("diarization","Phân biệt người nói (pyannote + CAM++)","stt","MIT, Apache-2.0"),("htdemucs","Tách giọng và nhạc nền (HTDemucs)","separation","Mã MIT; trọng số chưa rõ giấy phép (huấn luyện trên MusDB-HQ, chỉ cho nghiên cứu, và 800 bài hát chưa công bố)")];
/// Queued TTS jobs share one worker process so the model loads once (~13 s on CPU).
pub const TTS_BATCH:usize=32;
/// Workers join a kill-on-close job object so a crashed or killed app never leaves Python running.
#[cfg(windows)] fn worker_job()->usize{static JOB:std::sync::OnceLock<usize>=std::sync::OnceLock::new();*JOB.get_or_init(||unsafe{use windows_sys::Win32::System::JobObjects::*;let h=CreateJobObjectW(std::ptr::null(),std::ptr::null());let mut info:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;SetInformationJobObject(h,JobObjectExtendedLimitInformation,&info as *const _ as *const _,std::mem::size_of_val(&info) as u32);h as usize})}
/// A job object of its own per worker, nested in the global one: ending or cancelling a worker takes down everything it started.
struct Job(usize);
#[cfg(windows)] impl Job{
 fn new()->Self{unsafe{use windows_sys::Win32::System::JobObjects::*;let h=CreateJobObjectW(std::ptr::null(),std::ptr::null());let mut info:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;SetInformationJobObject(h,JobObjectExtendedLimitInformation,&info as *const _ as *const _,std::mem::size_of_val(&info) as u32);Job(h as usize)}}
 /// The global job first, then this one: a process can join a job nested inside the one it is already in, not the other way round.
 fn adopt(&self,c:&std::process::Child){unsafe{use std::os::windows::io::AsRawHandle;use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;AssignProcessToJobObject(worker_job() as _,c.as_raw_handle() as _);AssignProcessToJobObject(self.0 as _,c.as_raw_handle() as _);}}
 fn kill(&self){unsafe{windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 as _,1);}}
}
#[cfg(windows)] impl Drop for Job{fn drop(&mut self){unsafe{windows_sys::Win32::Foundation::CloseHandle(self.0 as _);}}}
#[cfg(not(windows))] impl Job{fn new()->Self{Job(0)}fn adopt(&self,_:&std::process::Child){}fn kill(&self){}}
/// Keeps Windows from sleeping (the screen may still turn off) while a worker runs. The request belongs to the
/// calling thread, and the queue runs every worker on its one thread.
pub struct Awake;
impl Awake{pub fn hold()->Self{#[cfg(windows)] unsafe{use windows_sys::Win32::System::Power::*;SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED);}Awake}}
impl Drop for Awake{fn drop(&mut self){#[cfg(windows)] unsafe{use windows_sys::Win32::System::Power::*;SetThreadExecutionState(ES_CONTINUOUS);}}}
/// A plain-language cause for the Windows crash codes a worker most often dies with.
pub fn exit_hint(code:Option<i32>)->&'static str{match code.map(|c|c as u32){
 Some(0xC000001D)=>"CPU của máy có thể thiếu tập lệnh mà engine cần (ví dụ AVX); hay gặp trên CPU đời cũ. ",
 Some(0xC0000017)|Some(0xC00000FD)=>"Máy hết bộ nhớ. Đóng bớt ứng dụng rồi thử lại. ",
 Some(0xC0000005)|Some(0xC0000409)=>"Engine dừng đột ngột. Thử lại; nếu lặp lại, hãy gửi kèm worker.log khi báo lỗi. ",
 _=>""}}
pub struct Runtime {pub resource:PathBuf,pub source:PathBuf,pub shutdown:AtomicBool,rust_ops:&'static [&'static str]}
fn required(v:&Value,k:&str)->Result<String>{v[k].as_str().filter(|x|!x.is_empty()).map(str::to_string).ok_or_else(||format!("INVALID_PAYLOAD: {k}"))}
fn model_path(s:&Store,id:&str)->Result<PathBuf>{if !MODELS.iter().any(|m|m.0==id){return Err("INVALID_MODEL".into())}Ok(s.root.join("models").join(id))}
/// Imports a TTS or render output (and a take's reading before its speed change) as assets.
fn import_output(s:&Store,out:&Path,result:&mut Value)->Result<()>{let path=validate_output(out,Path::new(&required(result,"path")?))?;let a=s.import_asset(&path)?;result["asset_id"]=a["id"].clone();result["path"]=a["path"].clone();if let Some(raw)=result.as_object_mut().and_then(|o|o.remove("raw_path")){/* the take works without it (fitted with a second stretch) */if let Some(a)=raw.as_str().and_then(|r|validate_output(out,Path::new(r)).ok()).and_then(|r|s.import_asset(&r).ok()){result["raw_asset_id"]=a["id"].clone();}}Ok(())}
pub fn prepare_request(s:&Store,j:&Value,ffmpeg:Option<&Path>)->Result<Value>{
 let kind=required(j,"kind")?;let p=&j["payload"];let id=required(j,"id")?;
 let (op,payload)=match kind.as_str(){
  "tts"=>{let text=required(p,"text")?;if text.len()>100_000{return Err("TEXT_TOO_LONG: Chia văn bản thành các đoạn nhỏ.".into())}let mut voice_id=p["voice_id"].as_str().map(str::to_string);let mut reference=p["reference_asset_id"].as_str().map(str::to_string);
   if let Some(id)=&voice_id {if let Some(v)=s.list_voices()?.iter().find(|v|v["id"]==id.as_str()){if v["kind"]=="reference"{if v["consent"]!=true{return Err("VOICE_CONSENT_REQUIRED".into())}reference=v["reference_asset_id"].as_str().map(str::to_string);voice_id=None;}else{voice_id=v["engine_voice_id"].as_str().map(str::to_string);}}}
   let speed=p["speed"].as_f64().unwrap_or(1.0);if !(0.5..=2.0).contains(&speed){return Err("INVALID_SPEED".into())}
   let reference_path=reference.map(|id|s.asset(&id).map(|a|a["path"].clone())).transpose()?;
   ("tts",json!({"text":text,"voice_id":voice_id,"reference_path":reference_path,"model_path":model_path(s,"vieneu-v3")?,"check_model_path":if p["check"]==true{Some(model_path(s,"whisper-small")?)}else{None},"speed":speed,"ffmpeg_path":ffmpeg.map(|p|p.to_string_lossy()),"output_name":format!("{id}.wav")}))},
  "stt"=>{let a=s.asset(&required(p,"asset_id")?)?;let mid=required(p,"model_id")?;if !["whisper-small","whisper-turbo"].contains(&mid.as_str()){return Err("INVALID_MODEL".into())}let lang=p["language"].as_str().unwrap_or("vi");let count=|k:&str|->Result<Option<u64>>{match &p[k]{Value::Null=>Ok(None),v=>match v.as_u64(){Some(n@1..=8)=>Ok(Some(n)),_=>Err("INVALID_SPEAKERS".into())}}};let(speakers,lo,hi)=(count("num_speakers")?,count("min_speakers")?,count("max_speakers")?);if lo.zip(hi).map_or(false,|(a,b)|a>b)||(speakers.is_some()&&(lo.is_some()||hi.is_some())){return Err("INVALID_SPEAKERS".into())}if !["vi","auto"].contains(&lang){return Err("INVALID_LANGUAGE".into())}("stt",json!({"input_path":a["path"],"model_path":model_path(s,&mid)?,"language":lang,"diarize_model_path":if p["diarize"]==true{Some(model_path(s,"diarization")?)}else{None},"num_speakers":if p["diarize"]==true{speakers}else{None},"min_speakers":if p["diarize"]==true{lo}else{None},"max_speakers":if p["diarize"]==true{hi}else{None}}))},
  "separate"=>{let a=s.asset(&required(p,"asset_id")?)?;("separate",json!({"input_path":a["path"],"model_path":model_path(s,"htdemucs")?,"ffmpeg_path":ffmpeg.map(|p|p.to_string_lossy()),"output_name":format!("{id}.flac")}))},
  "model_download"=>{let mid=required(p,"model_id")?;model_path(s,&mid)?;("download",json!({"model_id":mid}))},
  "clone_preview"=>{let a=s.asset(&required(p,"asset_id")?)?;("clone_preview",json!({"reference_path":a["path"],"model_path":model_path(s,"vieneu-v3")?,"output_name":format!("{id}.wav")}))},
  "render"=>{let segs=p["segments"].as_array().ok_or("INVALID_SEGMENTS")?;if segs.is_empty(){return Err("EMPTY_RENDER".into())}let timeline=p["timeline"]==true;let ms=|v:&Value|v.as_f64().filter(|x|x.is_finite()&&(0.0..=86_400_000.0).contains(x)).ok_or_else(||"INVALID_TIMELINE".to_string());let mut clips=Vec::new();for seg in segs{let tid=required(seg,"selected_take_id")?;let take=seg["takes"].as_array().and_then(|ts|ts.iter().find(|t|t["id"]==tid)).ok_or("TAKE_NOT_FOUND")?;let asset=s.asset(&required(take,"asset_id")?)?;clips.push(json!({"path":asset["path"],"trim_start_ms":seg["trim_start_ms"].as_f64().unwrap_or(0.0),"trim_end_ms":seg["trim_end_ms"],"gap_ms":seg["gap_ms"].as_f64().unwrap_or(0.0),"fade_in_ms":seg["fade_in_ms"].as_f64().unwrap_or(0.0),"fade_out_ms":seg["fade_out_ms"].as_f64().unwrap_or(0.0),"gain_db":seg["gain_db"].as_f64().unwrap_or(0.0)}));if timeline{let clip=clips.last_mut().unwrap();clip["at_ms"]=json!(ms(&seg["dub_at_ms"])?);clip["rate"]=json!(seg["dub_rate"].as_f64().filter(|r|(1.0..=2.0).contains(r)).ok_or("INVALID_TIMELINE")?);/* a take read at another speed fits its cue from the reading before the speed change; an older take without it is stretched again */if let (Some(raw),Some(speed))=(take["raw_asset_id"].as_str(),take["speed"].as_f64().filter(|v|(0.5..=2.0).contains(v))){if let Some(r)=s.asset(raw).ok().filter(|r|r["path"].as_str().is_some_and(|p|Path::new(p).is_file())){clip["raw_path"]=r["path"].clone();clip["speed"]=json!(speed);}}}}let format=p["format"].as_str().unwrap_or("wav");if !["wav","mp3","m4a","flac","opus"].contains(&format){return Err("INVALID_FORMAT".into())}("render",json!({"clips":clips,"normalize":p["normalize"].as_bool().unwrap_or(false),"format":format,"ffmpeg_path":ffmpeg.map(|p|p.to_string_lossy()),"timeline":timeline,"pad_to_ms":if timeline{Some(ms(&p["pad_to_ms"])?)}else{None},"background_path":match &p["background_asset_id"]{Value::Null=>Value::Null,v=>s.asset(v.as_str().filter(|_|timeline).ok_or("INVALID_BACKGROUND")?).map_err(|_|"INVALID_BACKGROUND")?["path"].clone()}}))},
  _=>return Err("INVALID_JOB_KIND".into())
 };
 Ok(json!({"protocol":1,"id":id,"operation":op,"payload":payload,"output_dir":s.root.join("jobs").join(id),"models_dir":s.root.join("models")}))
}
pub fn transcript_rows(segments:&[Value])->Result<Vec<Value>>{let mut transcript=Vec::new();for seg in segments{let start=seg["start"].as_f64().ok_or("INVALID_TIMESTAMP")?;let end=seg["end"].as_f64().ok_or("INVALID_TIMESTAMP")?;if start<0.0||end<=start{return Err("INVALID_TIMESTAMP".into())}transcript.push(json!({"id":uuid::Uuid::new_v4().to_string(),"start_ms":(start*1000.0).round(),"end_ms":(end*1000.0).round(),"text":seg["text"],"speaker":seg["speaker"].as_u64(),"overlap_speaker":seg["overlap"].as_u64()}));}Ok(transcript)}
/// After a separation ends in any state its job folder keeps only worker.log: the stem was imported as an asset, or is a cancelled or failed partial.
pub fn remove_stems(dir:&Path){for e in fs::read_dir(dir).into_iter().flatten().flatten(){if e.path().extension().is_some_and(|x|x.eq_ignore_ascii_case("flac")){let _=fs::remove_file(e.path());}}}
pub fn validate_output(output_dir:&Path,path:&Path)->Result<PathBuf>{let root=output_dir.canonicalize().map_err(|e|e.to_string())?;let file=path.canonicalize().map_err(|e|e.to_string())?;if !file.starts_with(root)||!file.is_file(){return Err("INVALID_OUTPUT: Worker returned a path outside its job directory".into())}Ok(file)}
impl Runtime{
 pub fn new(resource:PathBuf,source:PathBuf)->Self{Self{resource,source,shutdown:AtomicBool::new(false),rust_ops:engine::RUST_OPS}}
 /// Routes these operations to the native worker instead of the release's `RUST_OPS` (tests, and the gate's A/B runs).
 pub fn with_rust_ops(mut self,ops:&'static [&'static str])->Self{self.rust_ops=ops;self}
 pub fn worker(&self)->PathBuf{let p=self.resource.join("worker/main.py");if p.exists()||!cfg!(debug_assertions){p}else{self.source.join("worker/main.py")}}
 pub fn python(&self)->Option<PathBuf>{self.resolve("THANHAM_PYTHON",&["runtime/python/python.exe","runtime/python.exe","runtime/.venv/Scripts/python.exe",".venv/Scripts/python.exe"])}
 pub fn native_worker(&self)->Option<PathBuf>{self.resolve("THANHAM_NATIVE_WORKER",&["worker/thanham-worker.exe"])}
 pub fn ffmpeg(&self)->Option<PathBuf>{self.resolve("THANHAM_FFMPEG",&["runtime/ffmpeg/ffmpeg.exe","runtime/ffmpeg.exe"])}
 fn resolve(&self,env:&str,rels:&[&str])->Option<PathBuf>{// Release builds never look at the source checkout or developer env vars.
  let roots:&[&PathBuf]=if cfg!(debug_assertions){&[&self.resource,&self.source]}else{&[&self.resource]};for root in roots{for rel in rels{let p=root.join(rel);if p.is_file(){return Some(p)}}}if cfg!(debug_assertions){if let Some(p)=std::env::var_os(env).map(PathBuf::from).filter(|p|p.is_file()){return Some(p)}}None}
 pub fn status(&self)->Value{let p=self.python();let f=self.ffmpeg();let w=self.worker().is_file();let n=self.native_worker();json!({"python_ready":p.is_some(),"ffmpeg_ready":f.is_some(),"worker_ready":w,"native_worker_ready":n.is_some(),"python_path":p,"ffmpeg_path":f,"native_worker_path":n,"message":if !w{"Thiếu worker. Kiểm tra bộ cài."}else if p.is_none(){"Chưa có runtime Python riêng. Chạy scripts/setup-runtime.ps1 khi phát triển, hoặc cài gói runtime đầy đủ."}else if f.is_none(){"Thiếu FFmpeg riêng để xuất audio. TTS/STT có thể dùng sau khi tải model."}else{"Runtime đã tìm thấy. Cần tải model trước lần sử dụng đầu tiên."}})}
 pub fn start(self:Arc<Self>,store:Arc<Store>){thread::spawn(move||while !self.shutdown.load(Ordering::Relaxed){match store.claim_next(){Ok(Some(j))=>{let mut jobs=vec![j];if jobs[0]["kind"]=="tts"{jobs.extend(store.claim_queued("tts",TTS_BATCH-1).unwrap_or_default());}if let Err(e)=self.execute(&store,&jobs){if !self.shutdown.load(Ordering::Relaxed){for j in &jobs{let _=store.fail(j["id"].as_str().unwrap_or(""),&e);}}}if let ("separate",Some(id))=(jobs[0]["kind"].as_str().unwrap_or(""),jobs[0]["id"].as_str()){remove_stems(&store.root.join("jobs").join(id));}},Ok(None)=>thread::sleep(Duration::from_millis(300)),Err(_)=>thread::sleep(Duration::from_secs(1))}});}
 /// Runs claimed jobs (one job, or a batch of TTS jobs) on the worker their operation routes to, and reruns what a failing native worker
 /// could not finish on Python, once.
 pub fn execute(&self,s:&Store,jobs:&[Value])->Result<()> {
  let _awake=Awake::hold();let j=&jobs[0];let id=required(j,"id")?;let mut request=prepare_request(s,j,self.ffmpeg().as_deref())?;
  let is_tts=j["kind"]=="tts";let mut ids:Vec<String>=Vec::new();
  if is_tts{let mut items=Vec::new();for job in jobs{let jid=required(job,"id")?;match prepare_request(s,job,self.ffmpeg().as_deref()){Ok(r)=>{let mut item=r["payload"].clone();item["output_name"]=json!(format!("{jid}.wav"));items.push(item);ids.push(jid);},Err(e)=>{let _=s.fail(&jid,&e);}}}if items.is_empty(){return Ok(())}request["payload"]=json!({"model_path":items[0]["model_path"].clone(),"items":items});}
  let out=PathBuf::from(request["output_dir"].as_str().ok_or("INVALID_OUTPUT")?);let _=fs::remove_dir_all(&out);fs::create_dir_all(&out).map_err(|e|e.to_string())?;
  let op=request["operation"].as_str().unwrap_or("").to_string();let engine=self.engine_for(s,&op);
  let mut run=self.attempt(s,engine,false,&request,&out,&ids)?;
  let Some((code,exit))=(engine==Engine::Rust).then(||fallback_reason(&run,&request,is_tts)).flatten() else{
   if engine==Engine::Rust{if let (Some(code),true)=(run.exit,run.result.is_some()){if code!=0{engine::log_fallback(&s.root,&op,"EXIT_AFTER_RESULT",Some(code),"exit_after_result",request["payload"]["reference_path"].is_string());}}}
   return self.conclude(s,j,&id,&out,engine,false,is_tts,&ids,run);
  };
  // Rerun once, with only what the native worker did not finish: its job folder is emptied (finished outputs were already imported).
  engine::log_fallback(&s.root,&op,&code,exit,"rerun",request["payload"]["reference_path"].is_string()||request["payload"]["items"].as_array().is_some_and(|a|a.iter().any(|i|i["reference_path"].is_string())));
  for e in fs::read_dir(&out).into_iter().flatten().flatten(){if e.file_name()!="worker.log"{let p=e.path();let _=if p.is_dir(){fs::remove_dir_all(p)}else{fs::remove_file(p)};}}
  if let Ok(mut log)=fs::OpenOptions::new().append(true).open(out.join("worker.log")){let _=writeln!(log,"\n--- {code} (exit {exit:?}): rerun on Python ---");}
  let mut again=request.clone();let mut sub_ids=ids.clone();
  if is_tts{let mut left:Vec<usize>=run.pending.iter().copied().collect();left.sort();sub_ids=left.iter().map(|&i|ids[i].clone()).collect();let items=request["payload"]["items"].as_array().cloned().unwrap_or_default();again["payload"]["items"]=json!(left.iter().map(|&i|items[i].clone()).collect::<Vec<_>>());}
  run=match self.attempt(s,Engine::Python,true,&again,&out,&sub_ids){Ok(r)=>r,Err(e) if is_tts&&e!="CANCELLED"=>{for i in &run.pending{let _=s.fail(&ids[*i],&e);}return Ok(())},Err(e)=>return Err(e)};
  self.conclude(s,j,&id,&out,Engine::Python,true,is_tts,&sub_ids,run)
 }
 /// The end of a job: a TTS batch fails the items nobody reported; any other job imports its output and finishes.
 #[allow(clippy::too_many_arguments)]
 fn conclude(&self,s:&Store,j:&Value,id:&str,out:&Path,engine:Engine,fell_back:bool,is_tts:bool,ids:&[String],run:Attempt)->Result<()>{
  if is_tts{let reason=run.failure.unwrap_or_else(||"WORKER_PROTOCOL: No result for this segment".into());for i in run.pending{let _=s.fail(&ids[i],&reason);}return Ok(())}
  if let Some(e)=run.failure{return Err(e)}let mut result=run.result.ok_or("WORKER_PROTOCOL: No completed result")?;
  result["engine"]=json!(engine.name());result["fallback"]=json!(fell_back);
  if ["tts","render","clone_preview","separate"].contains(&j["kind"].as_str().unwrap_or("")){import_output(s,out,&mut result)?;}
  if j["kind"]=="stt"{result["transcript"]=json!(transcript_rows(result["segments"].as_array().ok_or("INVALID_TRANSCRIPT_RESULT")?)?);}
  s.finish(id,result)?;Ok(())
 }
 /// The engine an operation runs on: the native worker when the release routes it there, it is installed and the user has not chosen Python.
 fn engine_for(&self,s:&Store,op:&str)->Engine{
  let user_python=s.settings().is_ok_and(|x|x["worker_engines"][op]=="python");
  if self.rust_ops.contains(&op)&&!user_python&&self.native_worker().is_some(){Engine::Rust}else{Engine::Python}
 }
 /// One worker process for one request: its events are applied to the queue as they arrive; the outcome says how it ended.
 fn attempt(&self,s:&Store,engine:Engine,fell_back:bool,request:&Value,out:&Path,ids:&[String])->Result<Attempt>{
  let id=request["id"].as_str().ok_or("INVALID_REQUEST")?.to_string();let is_tts=!ids.is_empty();
  let mut run=Attempt{pending:(0..ids.len()).collect(),..Attempt::default()};
  let log=fs::OpenOptions::new().create(true).append(true).open(out.join("worker.log")).map_err(|e|e.to_string())?;
  let mut cmd=match engine{
   Engine::Python=>{let mut c=Command::new(self.python().ok_or("RUNTIME_MISSING: Cài runtime Python riêng trước.")?);c.arg("-I").arg("-X").arg("utf8").arg(self.worker()).env("PYTHONUTF8","1").env("PYTHONIOENCODING","utf-8");c},
   Engine::Rust=>Command::new(self.native_worker().ok_or("RUNTIME_MISSING: Thiếu bộ xử lý gốc.")?)};
  if let Some(f)=self.ffmpeg(){cmd.env("THANHAM_FFMPEG",&f).env("THANHAM_FFPROBE",f.with_file_name("ffprobe.exe"));}cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log)).env("HF_HUB_DISABLE_TELEMETRY","1");
  #[cfg(windows)] cmd.creation_flags(0x08000000);
  let mut child=cmd.spawn().map_err(|e|format!("WORKER_START: {e}"))?;
  let job=Job::new();job.adopt(&child);
  let mut input=child.stdin.take().ok_or("WORKER_STDIN")?;if let Err(e)=writeln!(input,"{request}"){job.kill();let _=child.kill();let _=child.wait();return Err(format!("WORKER_REQUEST: {e}"))}drop(input);
  let stdout=child.stdout.take().ok_or("WORKER_STDOUT")?;let(tx,rx)=std::sync::mpsc::channel();thread::spawn(move||{for line in BufReader::new(stdout).lines(){match line{Ok(s)=>{if tx.send(s).is_err(){break}},Err(_)=>break}}});
  loop{
   let all_cancelled=if is_tts{run.pending.iter().all(|&i|s.job(&ids[i]).map(|x|x["status"]=="cancelled").unwrap_or(true))}else{s.job(&id)?["status"]=="cancelled"};
   if self.shutdown.load(Ordering::Relaxed)||all_cancelled{job.kill();let _=child.kill();let _=child.wait();return Err("CANCELLED".into())}
   while let Ok(line)=rx.try_recv(){if line.len()>8_000_000{run.failure=Some("WORKER_PROTOCOL: oversized event".into());continue}if let Ok(e)=serde_json::from_str::<Value>(&line){if e["id"]!=id.as_str()||e["protocol"]!=1{continue}self.on_event(s,engine,fell_back,&mut run,&e,&id,ids,request,true)}}
   if let Some(exit)=child.try_wait().map_err(|e|e.to_string())?{
    job.kill(); // anything the worker started and left running dies with it, and no stray handle keeps its output open
    for line in rx.iter(){if let Ok(e)=serde_json::from_str::<Value>(&line){if e["id"]==id.as_str()&&e["protocol"]==1{self.on_event(s,engine,fell_back,&mut run,&e,&id,ids,request,false)}}}
    run.exit=exit.code();
    // The native worker's `result` is final whatever its exit code; Python's crash after a result still fails the job.
    if !exit.success()&&run.failure.is_none()&&(engine==Engine::Python||run.result.is_none()){run.failure=Some(format!("WORKER_EXIT: {exit}. {}Xem worker.log trong thư mục job.",exit_hint(exit.code())))}
    return Ok(run)}
   thread::sleep(Duration::from_millis(100));
  }
 }
 #[allow(clippy::too_many_arguments)]
 fn on_event(&self,s:&Store,engine:Engine,fell_back:bool,run:&mut Attempt,e:&Value,id:&str,ids:&[String],request:&Value,live:bool){
  match e["event"].as_str(){
   Some("item")=>self.finish_item(s,engine,fell_back,run,ids,e,request),
   Some("progress") if live=>{let target=if !ids.is_empty(){run.pending.iter().min().map(|&i|ids[i].clone())}else{Some(id.to_string())};if let Some(t)=target{let _=s.progress(&t,e["progress"].as_f64().unwrap_or(0.0));}},
   Some("result")=>run.result=Some(e["result"].clone()),
   Some("error")=>{let code=e["code"].as_str().unwrap_or("WORKER_ERROR");run.code=Some(code.to_string());run.failure=Some(format!("{}: {}",code,e["message"].as_str().unwrap_or("Lỗi worker")))},
   _=>{}}
 }
 fn finish_item(&self,s:&Store,engine:Engine,fell_back:bool,run:&mut Attempt,ids:&[String],e:&Value,request:&Value){
  let Some(i)=e["index"].as_u64().map(|i|i as usize).filter(|i|run.pending.contains(i)&&!run.deferred.contains(i)) else {return};
  // The native worker's engine failure on one item is not the item's verdict: it reruns on Python.
  if engine==Engine::Rust&&e["error"]["code"].as_str().is_some_and(engine::eligible_code){run.deferred.push(i);run.item_code=e["error"]["code"].as_str().map(str::to_string);return}
  run.pending.remove(&i);let jid=&ids[i];
  let outcome=(||->Result<()>{if !e["error"].is_null(){return Err(format!("{}: {}",e["error"]["code"].as_str().unwrap_or("WORKER_ERROR"),e["error"]["message"].as_str().unwrap_or("Lỗi worker")))}
   let mut result=e["result"].clone();result["engine"]=json!(engine.name());result["fallback"]=json!(fell_back);let out=PathBuf::from(request["output_dir"].as_str().ok_or("INVALID_OUTPUT")?);import_output(s,&out,&mut result)?;s.finish(jid,result)?;Ok(())})();
  if let Err(err)=outcome{let _=s.fail(jid,&err);}
 }
}
/// How one worker process ended and what it reported.
#[derive(Default)]
struct Attempt{result:Option<Value>,failure:Option<String>,code:Option<String>,exit:Option<i32>,pending:std::collections::HashSet<usize>,deferred:Vec<usize>,item_code:Option<String>}
/// Why the native worker's run must be repeated on Python (code, exit code), or None when its outcome stands.
fn fallback_reason(run:&Attempt,request:&Value,is_tts:bool)->Option<(String,Option<i32>)>{
 // An error about the input ends the run for good; an engine failure on an item reruns that item whatever else happened.
 let verdict=run.code.as_deref().is_some_and(|c|!engine::eligible_code(c));
 if is_tts&&!run.deferred.is_empty()&&!verdict{return Some((run.item_code.clone().unwrap_or_default(),run.exit))}
 if let Some(r)=&run.result{
  // Diarization that failed as a process (not a model check) while speakers were asked for: the whole transcription reruns.
  let diarize=request["operation"]=="stt"&&request["payload"]["diarize_model_path"].is_string()&&r["diarize_error_code"]=="DIARIZE_PROCESS";
  return diarize.then(||("DIARIZE_PROCESS".into(),run.exit))}
 match &run.code{Some(c)=>engine::eligible_code(c).then(||(c.clone(),run.exit)),None=>engine::eligible_exit(run.exit).then(||("WORKER_EXIT".into(),run.exit))}
}
