use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub struct Store { db: Mutex<Connection>, pub root: PathBuf }
fn now() -> String { Utc::now().to_rfc3339() }
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn parse(s: String) -> Result<Value> { serde_json::from_str(&s).map_err(err) }
fn ident(v: &Value, key: &str) -> Result<String> { v[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| format!("INVALID_FIELD: {key}")) }

impl Store {
 pub fn open(root: &Path) -> Result<Self> {
  fs::create_dir_all(root.join("assets")).map_err(err)?;
  fs::create_dir_all(root.join("models")).map_err(err)?;
  fs::create_dir_all(root.join("jobs")).map_err(err)?;
  let db = Connection::open(root.join("studio.sqlite3")).map_err(err)?;
  db.busy_timeout(std::time::Duration::from_secs(5)).map_err(err)?;
  db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS voices(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
   PRAGMA user_version=1;").map_err(err)?;
  let s = Self{db:Mutex::new(db),root:root.to_owned()};
  for mut j in s.list_jobs()? { if j["status"] == "running" { j["status"]=json!("interrupted"); j["error"]=json!("Phiên trước dừng giữa chừng. Chọn thử lại."); s.write_job(&j)?; } }
  Ok(s)
 }
 pub fn create_project(&self, name: &str) -> Result<Value> {
  if name.trim().is_empty() || name.len()>512 { return Err("INVALID_NAME".into()) }
  let p=json!({"id":Uuid::new_v4().to_string(),"name":name.trim(),"revision":0,"updated_at":now(),"segments":[],"transcript":[],"dictionary":{},"source_asset_id":null});
  self.db.lock().map_err(err)?.execute("INSERT INTO projects VALUES(?1,?2,0,?3,?4)",params![p["id"].as_str(),p["name"].as_str(),p["updated_at"].as_str(),p.to_string()]).map_err(err)?;
  Ok(p)
 }
 pub fn load_project(&self,id:&str)->Result<Value>{ let db=self.db.lock().map_err(err)?; let data:String=db.query_row("SELECT data FROM projects WHERE id=?1",[id],|r|r.get(0)).map_err(|_|"PROJECT_NOT_FOUND".to_string())?; parse(data) }
 pub fn list_projects(&self)->Result<Vec<Value>>{ let db=self.db.lock().map_err(err)?; let mut q=db.prepare("SELECT id,name,revision,updated_at FROM projects ORDER BY updated_at DESC").map_err(err)?; let r=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"updated_at":r.get::<_,String>(3)?}))).map_err(err)?; r.collect::<std::result::Result<Vec<_>,_>>().map_err(err) }
 pub fn save_project(&self,mut p:Value)->Result<Value>{
  let id=ident(&p,"id")?; let name=ident(&p,"name")?;
  let revision=p["revision"].as_i64().ok_or("INVALID_REVISION")?;
  if name.len()>512 {return Err("INVALID_NAME".into())}
  let segments=p["segments"].as_array().ok_or("INVALID_SEGMENTS")?;
  let mut ids=std::collections::HashSet::new();
  for s in segments {
   if !ids.insert(ident(s,"id")?) {return Err("INVALID_SEGMENT: duplicate id".into())}
   for k in ["gap_ms","trim_start_ms","fade_in_ms","fade_out_ms"] { if !s[k].is_null() && s[k].as_f64().filter(|x| x.is_finite() && *x>=0.0 && *x<=3_600_000.0).is_none(){return Err(format!("INVALID_SEGMENT: {k}"))} }
   if let Some(g)=s["gain_db"].as_f64(){if !(-60.0..=24.0).contains(&g){return Err("INVALID_SEGMENT: gain_db".into())}}
   if let Some(end)=s["trim_end_ms"].as_f64(){if end<=s["trim_start_ms"].as_f64().unwrap_or(0.0){return Err("INVALID_SEGMENT: trim range".into())}}
  }
  for t in p["transcript"].as_array().ok_or("INVALID_TRANSCRIPT")? {let a=t["start_ms"].as_f64().ok_or("INVALID_TIMESTAMP")?;let b=t["end_ms"].as_f64().ok_or("INVALID_TIMESTAMP")?;if a<0.0||b<=a{return Err("INVALID_TIMESTAMP".into())}}
  p["revision"]=json!(revision+1);p["updated_at"]=json!(now());
  let db=self.db.lock().map_err(err)?;
  // Takes are append-only and written by finished TTS jobs; keep any the client has not seen yet.
  if let Some(d)=db.query_row("SELECT data FROM projects WHERE id=?1",[&id],|r|r.get::<_,String>(0)).optional().map_err(err)? {
   let stored=parse(d)?;
   for seg in p["segments"].as_array_mut().into_iter().flatten() {
    let Some(old)=stored["segments"].as_array().and_then(|ss|ss.iter().find(|s|s["id"]==seg["id"])) else {continue};
    if !seg["takes"].is_array(){seg["takes"]=json!([])}
    for t in old["takes"].as_array().into_iter().flatten() { let takes=seg["takes"].as_array_mut().unwrap(); if !takes.iter().any(|x|x["id"]==t["id"]){takes.push(t.clone())} }
    // A take the server selected comes with the trim it set from the take's speech edges.
    if seg["selected_take_id"].is_null()&&!old["selected_take_id"].is_null(){for k in ["selected_take_id","trim_start_ms","trim_end_ms"]{seg[k]=old[k].clone()}}
   }
  }
  let n=db.execute("UPDATE projects SET name=?1,revision=?2,updated_at=?3,data=?4 WHERE id=?5 AND revision=?6",params![name,revision+1,p["updated_at"].as_str(),p.to_string(),id,revision]).map_err(err)?;
  if n!=1{return Err("REVISION_CONFLICT: Dự án đã thay đổi. Hãy tải lại trước khi lưu.".into())} Ok(p)
 }
 pub fn delete_project(&self,id:&str)->Result<()> { let db=self.db.lock().map_err(err)?; let n:i64=db.query_row("SELECT count(*) FROM jobs WHERE project_id=?1 AND status IN ('queued','running')",[id],|r|r.get(0)).map_err(err)?;if n>0{return Err("PROJECT_BUSY: Hủy công việc trước khi xóa.".into())}db.execute("DELETE FROM projects WHERE id=?1",[id]).map_err(err)?;Ok(()) }
 pub fn enqueue(&self,kind:&str,project:Option<&str>,payload:Value)->Result<Value>{
  if !["tts","stt","render","model_download"].contains(&kind){return Err("INVALID_JOB_KIND".into())}
  if let Some(id)=project {self.load_project(id)?;}
  let j=json!({"id":Uuid::new_v4().to_string(),"kind":kind,"project_id":project,"payload":payload,"status":"queued","progress":0.0,"error":null,"result":null,"created_at":now(),"updated_at":now()});
  self.db.lock().map_err(err)?.execute("INSERT INTO jobs VALUES(?1,?2,?3,'queued',?4,?5)",params![j["id"].as_str(),kind,project,j["created_at"].as_str(),j.to_string()]).map_err(err)?;Ok(j)
 }
 fn write_job(&self,j:&Value)->Result<()> {self.db.lock().map_err(err)?.execute("UPDATE jobs SET status=?1,data=?2 WHERE id=?3",params![j["status"].as_str(),j.to_string(),j["id"].as_str()]).map_err(err)?;Ok(())}
 pub fn list_jobs(&self)->Result<Vec<Value>>{let db=self.db.lock().map_err(err)?;let mut q=db.prepare("SELECT data FROM jobs ORDER BY created_at DESC").map_err(err)?;let rows=q.query_map([],|r|r.get::<_,String>(0)).map_err(err)?;rows.map(|r|parse(r.map_err(err)?)).collect()}
 pub fn job(&self,id:&str)->Result<Value>{let s=self.db.lock().map_err(err)?.query_row("SELECT data FROM jobs WHERE id=?1",[id],|r|r.get::<_,String>(0)).map_err(|_|"JOB_NOT_FOUND".to_string())?;parse(s)}
 pub fn claim_next(&self)->Result<Option<Value>>{let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let d:Option<String>=tx.query_row("SELECT data FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1",[],|r|r.get(0)).optional().map_err(err)?;let Some(d)=d else{return Ok(None)};let mut j=parse(d)?;j["status"]=json!("running");j["updated_at"]=json!(now());tx.execute("UPDATE jobs SET status='running',data=?1 WHERE id=?2",params![j.to_string(),j["id"].as_str()]).map_err(err)?;tx.commit().map_err(err)?;Ok(Some(j))}
 pub fn claim_queued(&self,kind:&str,limit:usize)->Result<Vec<Value>>{let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let rows:Vec<String>={let mut q=tx.prepare("SELECT data FROM jobs WHERE status='queued' AND kind=?1 ORDER BY created_at LIMIT ?2").map_err(err)?;let r=q.query_map(params![kind,limit as i64],|r|r.get::<_,String>(0)).map_err(err)?;r.collect::<std::result::Result<_,_>>().map_err(err)?};let mut out=Vec::new();for d in rows{let mut j=parse(d)?;j["status"]=json!("running");j["updated_at"]=json!(now());tx.execute("UPDATE jobs SET status='running',data=?1 WHERE id=?2",params![j.to_string(),j["id"].as_str()]).map_err(err)?;out.push(j);}tx.commit().map_err(err)?;Ok(out)}
 pub fn cancel(&self,id:&str)->Result<Value>{self.transition(id,"cancelled",None)}
 pub fn retry(&self,id:&str)->Result<Value>{let j=self.job(id)?;if !["failed","cancelled","interrupted"].contains(&j["status"].as_str().unwrap_or("")){return Err("INVALID_JOB_STATE".into())} self.transition(id,"queued",None)}
 fn transition(&self,id:&str,status:&str,error:Option<&str>)->Result<Value>{let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let d:String=tx.query_row("SELECT data FROM jobs WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;let mut j=parse(d)?;if j["status"]=="succeeded" {return Err("INVALID_JOB_STATE".into())}j["status"]=json!(status);j["updated_at"]=json!(now());j["error"]=json!(error);if status=="queued"{j["progress"]=json!(0);j["result"]=Value::Null;}tx.execute("UPDATE jobs SET status=?1,data=?2 WHERE id=?3",params![status,j.to_string(),id]).map_err(err)?;tx.commit().map_err(err)?;Ok(j)}
 pub fn progress(&self,id:&str,value:f64)->Result<()> {let mut j=self.job(id)?;if j["status"]=="running" {j["progress"]=json!(value.clamp(0.0,1.0));self.db.lock().map_err(err)?.execute("UPDATE jobs SET data=?1 WHERE id=?2 AND status='running'",params![j.to_string(),id]).map_err(err)?;}Ok(())}
 pub fn fail(&self,id:&str,message:&str)->Result<()> {if self.job(id)?["status"]!="cancelled"{self.transition(id,"failed",Some(message))?;}Ok(())}
 pub fn finish(&self,id:&str,result:Value)->Result<Value>{
  let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let d:String=tx.query_row("SELECT data FROM jobs WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;let mut j=parse(d)?;if j["status"]!="running"{return Err("INVALID_JOB_STATE".into())}
  if j["kind"]=="tts" {if let Some(pid)=j["project_id"].as_str(){let d:String=tx.query_row("SELECT data FROM projects WHERE id=?1",[pid],|r|r.get(0)).map_err(err)?;let mut p=parse(d)?;if let Some(s)=p["segments"].as_array_mut().and_then(|ss|ss.iter_mut().find(|s|s["id"]==j["payload"]["segment_id"])) {let mut take=result.clone();take["id"]=json!(Uuid::new_v4().to_string());take["created_at"]=json!(now());if s["selected_take_id"].is_null(){s["selected_take_id"]=take["id"].clone();s["trim_start_ms"]=json!(take["speech_start_ms"].as_f64().unwrap_or(0.0));s["trim_end_ms"]=take["speech_end_ms"].clone();}if !s["takes"].is_array(){s["takes"]=json!([])}s["takes"].as_array_mut().unwrap().push(take);tx.execute("UPDATE projects SET data=?1 WHERE id=?2",params![p.to_string(),pid]).map_err(err)?;}}}
  j["status"]=json!("succeeded");j["progress"]=json!(1);j["result"]=result;j["updated_at"]=json!(now());tx.execute("UPDATE jobs SET status='succeeded',data=?1 WHERE id=?2",params![j.to_string(),id]).map_err(err)?;tx.commit().map_err(err)?;Ok(j)
 }
 pub fn import_asset(&self,path:&Path)->Result<Value>{
  let ext=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();if !["wav","mp3","flac","ogg","opus","m4a","aac","mp4","mov","mkv","webm","wma","aiff"].contains(&ext.as_str()){return Err("UNSUPPORTED_MEDIA".into())}
  let mut input=fs::File::open(path).map_err(err)?;let tmp=self.root.join("assets").join(format!("{}.part",Uuid::new_v4()));let mut out=fs::File::create(&tmp).map_err(err)?;let mut hash=Sha256::new();let mut buf=[0u8;65536];loop{let n=input.read(&mut buf).map_err(err)?;if n==0{break}hash.update(&buf[..n]);out.write_all(&buf[..n]).map_err(err)?;}out.sync_all().map_err(err)?;drop(out);let id=format!("{:x}",hash.finalize());let dest=self.root.join("assets").join(format!("{id}.{ext}"));if dest.exists(){fs::remove_file(tmp).map_err(err)?}else{fs::rename(tmp,&dest).map_err(err)?}
  let a=json!({"id":id,"path":dest.to_string_lossy(),"name":path.file_name().unwrap_or_default().to_string_lossy(),"duration_ms":null,"sample_rate":null});self.db.lock().map_err(err)?.execute("INSERT OR IGNORE INTO assets VALUES(?1,?2)",params![id,a.to_string()]).map_err(err)?;self.asset(&id)
 }
 pub fn asset(&self,id:&str)->Result<Value>{let d=self.db.lock().map_err(err)?.query_row("SELECT data FROM assets WHERE id=?1",[id],|r|r.get::<_,String>(0)).map_err(|_|"ASSET_NOT_FOUND".to_string())?;parse(d)}
 pub fn list_voices(&self)->Result<Vec<Value>>{let db=self.db.lock().map_err(err)?;let mut q=db.prepare("SELECT data FROM voices ORDER BY id").map_err(err)?;let r=q.query_map([],|r|r.get::<_,String>(0)).map_err(err)?;r.map(|v|parse(v.map_err(err)?)).collect()}
 pub fn save_voice(&self,mut v:Value)->Result<Value>{if v["id"].as_str().unwrap_or("").is_empty(){v["id"]=json!(Uuid::new_v4().to_string())}ident(&v,"name")?;if v["kind"]=="reference"{if v["consent"]!=true{return Err("VOICE_CONSENT_REQUIRED".into())}self.asset(&ident(&v,"reference_asset_id")?)?;}else if v["kind"]!="preset"{return Err("INVALID_VOICE_KIND".into())}self.db.lock().map_err(err)?.execute("INSERT INTO voices VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![v["id"].as_str(),v.to_string()]).map_err(err)?;Ok(v)}
 pub fn settings(&self)->Result<Value>{let d=self.db.lock().map_err(err)?.query_row("SELECT data FROM settings WHERE key='app'",[],|r|r.get::<_,String>(0)).optional().map_err(err)?;d.map_or(Ok(json!({"dictionary":{}})),parse)}
 pub fn save_settings(&self,v:Value)->Result<Value>{
  let d=v["dictionary"].as_object().ok_or("INVALID_SETTINGS: dictionary")?;
  if d.len()>5000||d.iter().any(|(k,x)|k.is_empty()||k.len()>512||x.as_str().is_none_or(|x|x.len()>512)){return Err("INVALID_SETTINGS: dictionary".into())}
  let s=json!({"dictionary":d});
  self.db.lock().map_err(err)?.execute("INSERT INTO settings VALUES('app',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[s.to_string()]).map_err(err)?;Ok(s)
 }
}
