use crate::store::{Result,Store};
use serde_json::{json,Value};
use std::{fs,io::{BufRead,BufReader,Write},path::{Path,PathBuf},process::{Command,Stdio},sync::{Arc,atomic::{AtomicBool,Ordering}},thread,time::Duration};
#[cfg(windows)] use std::os::windows::process::CommandExt;

pub const MODELS:&[(&str,&str,&str,&str)] = &[("vieneu-v3","VieNeu v3 Turbo","tts","Apache-2.0"),("whisper-small","Whisper Small","stt","MIT"),("whisper-turbo","Whisper Large v3 Turbo","stt","MIT")];
pub struct Runtime {pub resource:PathBuf,pub source:PathBuf,pub shutdown:AtomicBool}
fn required(v:&Value,k:&str)->Result<String>{v[k].as_str().filter(|x|!x.is_empty()).map(str::to_string).ok_or_else(||format!("INVALID_PAYLOAD: {k}"))}
fn model_path(s:&Store,id:&str)->Result<PathBuf>{if !MODELS.iter().any(|m|m.0==id){return Err("INVALID_MODEL".into())}Ok(s.root.join("models").join(id))}
pub fn prepare_request(s:&Store,j:&Value,ffmpeg:Option<&Path>)->Result<Value>{
 let kind=required(j,"kind")?;let p=&j["payload"];let id=required(j,"id")?;
 let (op,payload)=match kind.as_str(){
  "tts"=>{let text=required(p,"text")?;if text.len()>100_000{return Err("TEXT_TOO_LONG: Chia văn bản thành các đoạn nhỏ.".into())}let mut voice_id=p["voice_id"].as_str().map(str::to_string);let mut reference=p["reference_asset_id"].as_str().map(str::to_string);
   if let Some(id)=&voice_id {if let Some(v)=s.list_voices()?.iter().find(|v|v["id"]==id.as_str()){if v["kind"]=="reference"{if v["consent"]!=true{return Err("VOICE_CONSENT_REQUIRED".into())}reference=v["reference_asset_id"].as_str().map(str::to_string);voice_id=None;}else{voice_id=v["engine_voice_id"].as_str().map(str::to_string);}}}
   let reference_path=reference.map(|id|s.asset(&id).map(|a|a["path"].clone())).transpose()?;
   ("tts",json!({"text":text,"voice_id":voice_id,"reference_path":reference_path,"model_path":model_path(s,"vieneu-v3")?,"output_name":format!("{id}.wav")}))},
  "stt"=>{let a=s.asset(&required(p,"asset_id")?)?;let mid=required(p,"model_id")?;if !["whisper-small","whisper-turbo"].contains(&mid.as_str()){return Err("INVALID_MODEL".into())}let lang=p["language"].as_str().unwrap_or("vi");if !["vi","auto"].contains(&lang){return Err("INVALID_LANGUAGE".into())}("stt",json!({"input_path":a["path"],"model_path":model_path(s,&mid)?,"language":lang}))},
  "model_download"=>{let mid=required(p,"model_id")?;model_path(s,&mid)?;("download",json!({"model_id":mid}))},
  "render"=>{let segs=p["segments"].as_array().ok_or("INVALID_SEGMENTS")?;if segs.is_empty(){return Err("EMPTY_RENDER".into())}let mut clips=Vec::new();for seg in segs{let tid=required(seg,"selected_take_id")?;let take=seg["takes"].as_array().and_then(|ts|ts.iter().find(|t|t["id"]==tid)).ok_or("TAKE_NOT_FOUND")?;let asset=s.asset(&required(take,"asset_id")?)?;clips.push(json!({"path":asset["path"],"trim_start_ms":seg["trim_start_ms"].as_f64().unwrap_or(0.0),"trim_end_ms":seg["trim_end_ms"],"gap_ms":seg["gap_ms"].as_f64().unwrap_or(0.0),"fade_in_ms":seg["fade_in_ms"].as_f64().unwrap_or(0.0),"fade_out_ms":seg["fade_out_ms"].as_f64().unwrap_or(0.0),"gain_db":seg["gain_db"].as_f64().unwrap_or(0.0)}));}let format=p["format"].as_str().unwrap_or("wav");if !["wav","mp3"].contains(&format){return Err("INVALID_FORMAT".into())}("render",json!({"clips":clips,"normalize":p["normalize"].as_bool().unwrap_or(false),"format":format,"ffmpeg_path":ffmpeg.map(|p|p.to_string_lossy())}))},
  _=>return Err("INVALID_JOB_KIND".into())
 };
 Ok(json!({"protocol":1,"id":id,"operation":op,"payload":payload,"output_dir":s.root.join("jobs").join(id),"models_dir":s.root.join("models")}))
}
pub fn validate_output(output_dir:&Path,path:&Path)->Result<PathBuf>{let root=output_dir.canonicalize().map_err(|e|e.to_string())?;let file=path.canonicalize().map_err(|e|e.to_string())?;if !file.starts_with(root)||!file.is_file(){return Err("INVALID_OUTPUT: Worker returned a path outside its job directory".into())}Ok(file)}
impl Runtime{
 pub fn new(resource:PathBuf,source:PathBuf)->Self{Self{resource,source,shutdown:AtomicBool::new(false)}}
 pub fn worker(&self)->PathBuf{let p=self.resource.join("worker/main.py");if p.exists(){p}else{self.source.join("worker/main.py")}}
 pub fn python(&self)->Option<PathBuf>{self.resolve("THANHAM_PYTHON",&["runtime/python/python.exe","runtime/python.exe","runtime/.venv/Scripts/python.exe",".venv/Scripts/python.exe"])}
 pub fn ffmpeg(&self)->Option<PathBuf>{self.resolve("THANHAM_FFMPEG",&["runtime/ffmpeg/ffmpeg.exe","runtime/ffmpeg.exe"])}
 fn resolve(&self,env:&str,rels:&[&str])->Option<PathBuf>{for root in [&self.resource,&self.source]{for rel in rels{let p=root.join(rel);if p.is_file(){return Some(p)}}}if cfg!(debug_assertions){if let Some(p)=std::env::var_os(env).map(PathBuf::from).filter(|p|p.is_file()){return Some(p)}}None}
 pub fn status(&self)->Value{let p=self.python();let f=self.ffmpeg();let w=self.worker().is_file();json!({"python_ready":p.is_some(),"ffmpeg_ready":f.is_some(),"worker_ready":w,"python_path":p,"ffmpeg_path":f,"message":if !w{"Thiếu worker. Kiểm tra bộ cài."}else if p.is_none(){"Chưa có runtime Python riêng. Chạy scripts/setup-runtime.ps1 khi phát triển, hoặc cài gói runtime đầy đủ."}else if f.is_none(){"Thiếu FFmpeg riêng để xuất audio. TTS/STT có thể dùng sau khi tải model."}else{"Runtime đã tìm thấy. Cần tải model trước lần sử dụng đầu tiên."}})}
 pub fn start(self:Arc<Self>,store:Arc<Store>){thread::spawn(move||while !self.shutdown.load(Ordering::Relaxed){match store.claim_next(){Ok(Some(j))=>{let id=j["id"].as_str().unwrap().to_string();if let Err(e)=self.execute(&store,&j){let _=store.fail(&id,&e);}},Ok(None)=>thread::sleep(Duration::from_millis(300)),Err(_)=>thread::sleep(Duration::from_secs(1))}});}
 fn execute(&self,s:&Store,j:&Value)->Result<()> {
  let id=required(j,"id")?;let python=self.python().ok_or("RUNTIME_MISSING: Cài runtime Python riêng trước.")?;let request=prepare_request(s,j,self.ffmpeg().as_deref())?;let out=PathBuf::from(request["output_dir"].as_str().ok_or("INVALID_OUTPUT")?);fs::create_dir_all(&out).map_err(|e|e.to_string())?;
  let log=fs::File::create(out.join("worker.log")).map_err(|e|e.to_string())?;
  let mut cmd=Command::new(python);cmd.arg(self.worker()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::from(log)).env("PYTHONUTF8","1").env("PYTHONIOENCODING","utf-8").env("HF_HUB_DISABLE_TELEMETRY","1");
  #[cfg(windows)] cmd.creation_flags(0x08000000);
  let mut child=cmd.spawn().map_err(|e|format!("WORKER_START: {e}"))?;
  let mut input=child.stdin.take().ok_or("WORKER_STDIN")?;if let Err(e)=writeln!(input,"{request}"){let _=child.kill();let _=child.wait();return Err(format!("WORKER_REQUEST: {e}"))}drop(input);
  let stdout=child.stdout.take().ok_or("WORKER_STDOUT")?;let(tx,rx)=std::sync::mpsc::channel();thread::spawn(move||{for line in BufReader::new(stdout).lines(){match line{Ok(s)=>{if tx.send(s).is_err(){break}},Err(_)=>break}}});
  let mut result=None;let mut failure=None;
  loop{
   if self.shutdown.load(Ordering::Relaxed)||s.job(&id)?["status"]=="cancelled"{let _=child.kill();let _=child.wait();return Err("CANCELLED".into())}
   while let Ok(line)=rx.try_recv(){if line.len()>8_000_000{failure=Some("WORKER_PROTOCOL: oversized event".into());continue}if let Ok(e)=serde_json::from_str::<Value>(&line){if e["id"]!=id||e["protocol"]!=1{continue}match e["event"].as_str(){Some("progress")=>{let _=s.progress(&id,e["progress"].as_f64().unwrap_or(0.0));},Some("result")=>result=Some(e["result"].clone()),Some("error")=>failure=Some(format!("{}: {}",e["code"].as_str().unwrap_or("WORKER_ERROR"),e["message"].as_str().unwrap_or("Lỗi worker"))),_=>{}}}}
   if let Some(exit)=child.try_wait().map_err(|e|e.to_string())?{for line in rx.iter(){if let Ok(e)=serde_json::from_str::<Value>(&line){if e["id"]==id&&e["protocol"]==1{match e["event"].as_str(){Some("result")=>result=Some(e["result"].clone()),Some("error")=>failure=Some(format!("{}: {}",e["code"].as_str().unwrap_or("WORKER_ERROR"),e["message"].as_str().unwrap_or("Lỗi worker"))),_=>{}}}}}if !exit.success()&&failure.is_none(){failure=Some(format!("WORKER_EXIT: {exit}. Xem worker.log trong thư mục job."))}break;}
   thread::sleep(Duration::from_millis(100));
  }
  if let Some(e)=failure{return Err(e)}let mut result=result.ok_or("WORKER_PROTOCOL: No completed result")?;
  if ["tts","render"].contains(&j["kind"].as_str().unwrap_or("")){let path=validate_output(&out,Path::new(&required(&result,"path")?))?;let a=s.import_asset(&path)?;result["asset_id"]=a["id"].clone();result["path"]=a["path"].clone();}
  if j["kind"]=="stt"{let segments=result["segments"].as_array().ok_or("INVALID_TRANSCRIPT_RESULT")?;let mut transcript=Vec::new();for seg in segments{let start=seg["start"].as_f64().ok_or("INVALID_TIMESTAMP")?;let end=seg["end"].as_f64().ok_or("INVALID_TIMESTAMP")?;if start<0.0||end<=start{return Err("INVALID_TIMESTAMP".into())}transcript.push(json!({"id":uuid::Uuid::new_v4().to_string(),"start_ms":(start*1000.0).round(),"end_ms":(end*1000.0).round(),"text":seg["text"]}));}result["transcript"]=json!(transcript);}
  s.finish(&id,result)?;Ok(())
 }
}
