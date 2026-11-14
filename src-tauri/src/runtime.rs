use crate::store::{Result,Store};
use serde_json::{json,Value};
use std::{fs,io::{BufRead,BufReader,Write},path::{Path,PathBuf},process::{Command,Stdio},sync::{Arc,atomic::{AtomicBool,Ordering}},thread,time::Duration};
#[cfg(windows)] use std::os::windows::process::CommandExt;

pub const MODELS:&[(&str,&str,&str,&str)] = &[("vieneu-v3","VieNeu v3 Turbo","tts","Apache-2.0"),("whisper-small","Whisper Small","stt","MIT"),("whisper-turbo","Whisper Large v3 Turbo","stt","MIT"),("diarization","Phân biệt người nói (pyannote + CAM++)","stt","MIT, Apache-2.0")];
/// Queued TTS jobs share one worker process so the model loads once (~13 s on CPU).
pub const TTS_BATCH:usize=32;
/// Workers join a kill-on-close job object so a crashed or killed app never leaves Python running.
#[cfg(windows)] fn worker_job()->usize{static JOB:std::sync::OnceLock<usize>=std::sync::OnceLock::new();*JOB.get_or_init(||unsafe{use windows_sys::Win32::System::JobObjects::*;let h=CreateJobObjectW(std::ptr::null(),std::ptr::null());let mut info:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;SetInformationJobObject(h,JobObjectExtendedLimitInformation,&info as *const _ as *const _,std::mem::size_of_val(&info) as u32);h as usize})}
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
pub struct Runtime {pub resource:PathBuf,pub source:PathBuf,pub shutdown:AtomicBool}
fn required(v:&Value,k:&str)->Result<String>{v[k].as_str().filter(|x|!x.is_empty()).map(str::to_string).ok_or_else(||format!("INVALID_PAYLOAD: {k}"))}
fn model_path(s:&Store,id:&str)->Result<PathBuf>{if !MODELS.iter().any(|m|m.0==id){return Err("INVALID_MODEL".into())}Ok(s.root.join("models").join(id))}
pub fn prepare_request(s:&Store,j:&Value,ffmpeg:Option<&Path>)->Result<Value>{
 let kind=required(j,"kind")?;let p=&j["payload"];let id=required(j,"id")?;
 let (op,payload)=match kind.as_str(){
  "tts"=>{let text=required(p,"text")?;if text.len()>100_000{return Err("TEXT_TOO_LONG: Chia văn bản thành các đoạn nhỏ.".into())}let mut voice_id=p["voice_id"].as_str().map(str::to_string);let mut reference=p["reference_asset_id"].as_str().map(str::to_string);
   if let Some(id)=&voice_id {if let Some(v)=s.list_voices()?.iter().find(|v|v["id"]==id.as_str()){if v["kind"]=="reference"{if v["consent"]!=true{return Err("VOICE_CONSENT_REQUIRED".into())}reference=v["reference_asset_id"].as_str().map(str::to_string);voice_id=None;}else{voice_id=v["engine_voice_id"].as_str().map(str::to_string);}}}
   let speed=p["speed"].as_f64().unwrap_or(1.0);if !(0.5..=2.0).contains(&speed){return Err("INVALID_SPEED".into())}
   let reference_path=reference.map(|id|s.asset(&id).map(|a|a["path"].clone())).transpose()?;
   ("tts",json!({"text":text,"voice_id":voice_id,"reference_path":reference_path,"model_path":model_path(s,"vieneu-v3")?,"check_model_path":if p["check"]==true{Some(model_path(s,"whisper-small")?)}else{None},"speed":speed,"ffmpeg_path":ffmpeg.map(|p|p.to_string_lossy()),"output_name":format!("{id}.wav")}))},
  "stt"=>{let a=s.asset(&required(p,"asset_id")?)?;let mid=required(p,"model_id")?;if !["whisper-small","whisper-turbo"].contains(&mid.as_str()){return Err("INVALID_MODEL".into())}let lang=p["language"].as_str().unwrap_or("vi");let count=|k:&str|->Result<Option<u64>>{match &p[k]{Value::Null=>Ok(None),v=>match v.as_u64(){Some(n@1..=8)=>Ok(Some(n)),_=>Err("INVALID_SPEAKERS".into())}}};let(speakers,lo,hi)=(count("num_speakers")?,count("min_speakers")?,count("max_speakers")?);if lo.zip(hi).map_or(false,|(a,b)|a>b)||(speakers.is_some()&&(lo.is_some()||hi.is_some())){return Err("INVALID_SPEAKERS".into())}if !["vi","auto"].contains(&lang){return Err("INVALID_LANGUAGE".into())}("stt",json!({"input_path":a["path"],"model_path":model_path(s,&mid)?,"language":lang,"diarize_model_path":if p["diarize"]==true{Some(model_path(s,"diarization")?)}else{None},"num_speakers":if p["diarize"]==true{speakers}else{None},"min_speakers":if p["diarize"]==true{lo}else{None},"max_speakers":if p["diarize"]==true{hi}else{None}}))},
  "model_download"=>{let mid=required(p,"model_id")?;model_path(s,&mid)?;("download",json!({"model_id":mid}))},
  "render"=>{let segs=p["segments"].as_array().ok_or("INVALID_SEGMENTS")?;if segs.is_empty(){return Err("EMPTY_RENDER".into())}let mut clips=Vec::new();for seg in segs{let tid=required(seg,"selected_take_id")?;let take=seg["takes"].as_array().and_then(|ts|ts.iter().find(|t|t["id"]==tid)).ok_or("TAKE_NOT_FOUND")?;let asset=s.asset(&required(take,"asset_id")?)?;clips.push(json!({"path":asset["path"],"trim_start_ms":seg["trim_start_ms"].as_f64().unwrap_or(0.0),"trim_end_ms":seg["trim_end_ms"],"gap_ms":seg["gap_ms"].as_f64().unwrap_or(0.0),"fade_in_ms":seg["fade_in_ms"].as_f64().unwrap_or(0.0),"fade_out_ms":seg["fade_out_ms"].as_f64().unwrap_or(0.0),"gain_db":seg["gain_db"].as_f64().unwrap_or(0.0)}));}let format=p["format"].as_str().unwrap_or("wav");if !["wav","mp3"].contains(&format){return Err("INVALID_FORMAT".into())}("render",json!({"clips":clips,"normalize":p["normalize"].as_bool().unwrap_or(false),"format":format,"ffmpeg_path":ffmpeg.map(|p|p.to_string_lossy())}))},
  _=>return Err("INVALID_JOB_KIND".into())
 };
 Ok(json!({"protocol":1,"id":id,"operation":op,"payload":payload,"output_dir":s.root.join("jobs").join(id),"models_dir":s.root.join("models")}))
}
pub fn transcript_rows(segments:&[Value])->Result<Vec<Value>>{let mut transcript=Vec::new();for seg in segments{let start=seg["start"].as_f64().ok_or("INVALID_TIMESTAMP")?;let end=seg["end"].as_f64().ok_or("INVALID_TIMESTAMP")?;if start<0.0||end<=start{return Err("INVALID_TIMESTAMP".into())}transcript.push(json!({"id":uuid::Uuid::new_v4().to_string(),"start_ms":(start*1000.0).round(),"end_ms":(end*1000.0).round(),"text":seg["text"],"speaker":seg["speaker"].as_u64(),"overlap_speaker":seg["overlap"].as_u64()}));}Ok(transcript)}
pub fn validate_output(output_dir:&Path,path:&Path)->Result<PathBuf>{let root=output_dir.canonicalize().map_err(|e|e.to_string())?;let file=path.canonicalize().map_err(|e|e.to_string())?;if !file.starts_with(root)||!file.is_file(){return Err("INVALID_OUTPUT: Worker returned a path outside its job directory".into())}Ok(file)}
impl Runtime{
 pub fn new(resource:PathBuf,source:PathBuf)->Self{Self{resource,source,shutdown:AtomicBool::new(false)}}
 pub fn worker(&self)->PathBuf{let p=self.resource.join("worker/main.py");if p.exists()||!cfg!(debug_assertions){p}else{self.source.join("worker/main.py")}}
 pub fn python(&self)->Option<PathBuf>{self.resolve("THANHAM_PYTHON",&["runtime/python/python.exe","runtime/python.exe","runtime/.venv/Scripts/python.exe",".venv/Scripts/python.exe"])}
 pub fn ffmpeg(&self)->Option<PathBuf>{self.resolve("THANHAM_FFMPEG",&["runtime/ffmpeg/ffmpeg.exe","runtime/ffmpeg.exe"])}
 fn resolve(&self,env:&str,rels:&[&str])->Option<PathBuf>{// Release builds never look at the source checkout or developer env vars.
  let roots:&[&PathBuf]=if cfg!(debug_assertions){&[&self.resource,&self.source]}else{&[&self.resource]};for root in roots{for rel in rels{let p=root.join(rel);if p.is_file(){return Some(p)}}}if cfg!(debug_assertions){if let Some(p)=std::env::var_os(env).map(PathBuf::from).filter(|p|p.is_file()){return Some(p)}}None}
 pub fn status(&self)->Value{let p=self.python();let f=self.ffmpeg();let w=self.worker().is_file();json!({"python_ready":p.is_some(),"ffmpeg_ready":f.is_some(),"worker_ready":w,"python_path":p,"ffmpeg_path":f,"message":if !w{"Thiếu worker. Kiểm tra bộ cài."}else if p.is_none(){"Chưa có runtime Python riêng. Chạy scripts/setup-runtime.ps1 khi phát triển, hoặc cài gói runtime đầy đủ."}else if f.is_none(){"Thiếu FFmpeg riêng để xuất audio. TTS/STT có thể dùng sau khi tải model."}else{"Runtime đã tìm thấy. Cần tải model trước lần sử dụng đầu tiên."}})}
 pub fn start(self:Arc<Self>,store:Arc<Store>){thread::spawn(move||while !self.shutdown.load(Ordering::Relaxed){match store.claim_next(){Ok(Some(j))=>{let mut jobs=vec![j];if jobs[0]["kind"]=="tts"{jobs.extend(store.claim_queued("tts",TTS_BATCH-1).unwrap_or_default());}if let Err(e)=self.execute(&store,&jobs){if !self.shutdown.load(Ordering::Relaxed){for j in &jobs{let _=store.fail(j["id"].as_str().unwrap_or(""),&e);}}}},Ok(None)=>thread::sleep(Duration::from_millis(300)),Err(_)=>thread::sleep(Duration::from_secs(1))}});}
 fn execute(&self,s:&Store,jobs:&[Value])->Result<()> {
  let _awake=Awake::hold();let j=&jobs[0];let id=required(j,"id")?;let python=self.python().ok_or("RUNTIME_MISSING: Cài runtime Python riêng trước.")?;let mut request=prepare_request(s,j,self.ffmpeg().as_deref())?;
  let is_tts=j["kind"]=="tts";let mut ids:Vec<String>=Vec::new();
  if is_tts{let mut items=Vec::new();for job in jobs{let jid=required(job,"id")?;match prepare_request(s,job,self.ffmpeg().as_deref()){Ok(r)=>{let mut item=r["payload"].clone();item["output_name"]=json!(format!("{jid}.wav"));items.push(item);ids.push(jid);},Err(e)=>{let _=s.fail(&jid,&e);}}}if items.is_empty(){return Ok(())}request["payload"]=json!({"model_path":items[0]["model_path"].clone(),"items":items});}
  let mut pending:std::collections::HashSet<usize>=(0..ids.len()).collect();let out=PathBuf::from(request["output_dir"].as_str().ok_or("INVALID_OUTPUT")?);let _=fs::remove_dir_all(&out);fs::create_dir_all(&out).map_err(|e|e.to_string())?;
  let log=fs::File::create(out.join("worker.log")).map_err(|e|e.to_string())?;
  let mut cmd=Command::new(python);if let Some(f)=self.ffmpeg(){cmd.env("THANHAM_FFMPEG",&f).env("THANHAM_FFPROBE",f.with_file_name("ffprobe.exe"));}cmd.arg("-I").arg("-X").arg("utf8").arg(self.worker()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log)).env("PYTHONUTF8","1").env("PYTHONIOENCODING","utf-8").env("HF_HUB_DISABLE_TELEMETRY","1");
  #[cfg(windows)] cmd.creation_flags(0x08000000);
  let mut child=cmd.spawn().map_err(|e|format!("WORKER_START: {e}"))?;
  #[cfg(windows)] unsafe{use std::os::windows::io::AsRawHandle;windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(worker_job() as _,child.as_raw_handle() as _);}
  let mut input=child.stdin.take().ok_or("WORKER_STDIN")?;if let Err(e)=writeln!(input,"{request}"){let _=child.kill();let _=child.wait();return Err(format!("WORKER_REQUEST: {e}"))}drop(input);
  let stdout=child.stdout.take().ok_or("WORKER_STDOUT")?;let(tx,rx)=std::sync::mpsc::channel();thread::spawn(move||{for line in BufReader::new(stdout).lines(){match line{Ok(s)=>{if tx.send(s).is_err(){break}},Err(_)=>break}}});
  let mut result=None;let mut failure=None;
  loop{
   let all_cancelled=if is_tts{pending.iter().all(|&i|s.job(&ids[i]).map(|x|x["status"]=="cancelled").unwrap_or(true))}else{s.job(&id)?["status"]=="cancelled"};
   if self.shutdown.load(Ordering::Relaxed)||all_cancelled{let _=child.kill();let _=child.wait();return Err("CANCELLED".into())}
   while let Ok(line)=rx.try_recv(){if line.len()>8_000_000{failure=Some("WORKER_PROTOCOL: oversized event".into());continue}if let Ok(e)=serde_json::from_str::<Value>(&line){if e["id"]!=id||e["protocol"]!=1{continue}match e["event"].as_str(){Some("item")=>self.finish_item(s,&ids,&mut pending,&e,&request),Some("progress")=>{let target=if is_tts{pending.iter().min().map(|&i|ids[i].clone())}else{Some(id.clone())};if let Some(t)=target{let _=s.progress(&t,e["progress"].as_f64().unwrap_or(0.0));}},Some("result")=>result=Some(e["result"].clone()),Some("error")=>failure=Some(format!("{}: {}",e["code"].as_str().unwrap_or("WORKER_ERROR"),e["message"].as_str().unwrap_or("Lỗi worker"))),_=>{}}}}
   if let Some(exit)=child.try_wait().map_err(|e|e.to_string())?{for line in rx.iter(){if let Ok(e)=serde_json::from_str::<Value>(&line){if e["id"]==id&&e["protocol"]==1{match e["event"].as_str(){Some("item")=>self.finish_item(s,&ids,&mut pending,&e,&request),Some("result")=>result=Some(e["result"].clone()),Some("error")=>failure=Some(format!("{}: {}",e["code"].as_str().unwrap_or("WORKER_ERROR"),e["message"].as_str().unwrap_or("Lỗi worker"))),_=>{}}}}}if !exit.success()&&failure.is_none(){failure=Some(format!("WORKER_EXIT: {exit}. {}Xem worker.log trong thư mục job.",exit_hint(exit.code())))}break;}
   thread::sleep(Duration::from_millis(100));
  }
  if is_tts{let reason=failure.unwrap_or_else(||"WORKER_PROTOCOL: No result for this segment".into());for i in pending{let _=s.fail(&ids[i],&reason);}return Ok(())}
  if let Some(e)=failure{return Err(e)}let mut result=result.ok_or("WORKER_PROTOCOL: No completed result")?;
  if ["tts","render"].contains(&j["kind"].as_str().unwrap_or("")){let path=validate_output(&out,Path::new(&required(&result,"path")?))?;let a=s.import_asset(&path)?;result["asset_id"]=a["id"].clone();result["path"]=a["path"].clone();}
  if j["kind"]=="stt"{result["transcript"]=json!(transcript_rows(result["segments"].as_array().ok_or("INVALID_TRANSCRIPT_RESULT")?)?);}
  s.finish(&id,result)?;Ok(())
 }
 fn finish_item(&self,s:&Store,ids:&[String],pending:&mut std::collections::HashSet<usize>,e:&Value,request:&Value){
  let Some(i)=e["index"].as_u64().map(|i|i as usize).filter(|i|pending.remove(i)) else {return};let jid=&ids[i];
  let outcome=(||->Result<()>{if !e["error"].is_null(){return Err(format!("{}: {}",e["error"]["code"].as_str().unwrap_or("WORKER_ERROR"),e["error"]["message"].as_str().unwrap_or("Lỗi worker")))}
   let mut result=e["result"].clone();let out=PathBuf::from(request["output_dir"].as_str().ok_or("INVALID_OUTPUT")?);let path=validate_output(&out,Path::new(&required(&result,"path")?))?;let a=s.import_asset(&path)?;result["asset_id"]=a["id"].clone();result["path"]=a["path"].clone();s.finish(jid,result)?;Ok(())})();
  if let Err(err)=outcome{let _=s.fail(jid,&err);}
 }
}
