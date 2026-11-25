use chrono::Utc;
use miniz_oxide::{deflate::compress_to_vec,inflate::decompress_to_vec_with_limit};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub struct Store { db: Mutex<Connection>, pub root: PathBuf }
/// The runtime runs it every 300 ms while idle; the `jobs_status` index keeps it off a scan of every job.
pub const CLAIM_NEXT:&str="SELECT data FROM jobs WHERE status='queued' ORDER BY kind<>'clone_preview',kind='separate',created_at LIMIT 1";
fn now() -> String { Utc::now().to_rfc3339() }
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn parse(s: String) -> Result<Value> { serde_json::from_str(&s).map_err(err) }
fn ident(v: &Value, key: &str) -> Result<String> { v[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| format!("INVALID_FIELD: {key}")) }
const CONFLICT:&str="REVISION_CONFLICT: Dự án đã thay đổi. Hãy tải lại trước khi lưu.";
const CORRUPT:&str="VERSION_CORRUPT: Phiên bản này không đọc được.";
const VERSION_ERRORS:&str="version-errors.jsonl";
const VERSION_GAP_SECS:i64=600;
const KEEP_VERSIONS:i64=30;
const KEEP_BEFORE_RESTORE:i64=5;
const MAX_VERSION_BYTES:i64=32*1024*1024;
const MAX_INFLATED:usize=256*1024*1024;
/// The rules a project must meet to be stored: what a client save and a restored version both pass.
fn check(p:&Value)->Result<()>{
 ident(p,"id")?; let name=ident(p,"name")?;
 p["revision"].as_i64().ok_or("INVALID_REVISION")?;
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
 Ok(())
}
/// Takes are append-only and written by finished TTS jobs; keep any the client (or a restored version) has not seen yet.
fn keep_takes(p:&mut Value,stored:&Value){
 let olds:std::collections::HashMap<&str,&Value>=stored["segments"].as_array().into_iter().flatten().filter_map(|s|Some((s["id"].as_str()?,s))).collect();
 for seg in p["segments"].as_array_mut().into_iter().flatten() {
  let Some(old)=seg["id"].as_str().and_then(|id|olds.get(id).copied()) else {continue};
  if !seg["takes"].is_array(){seg["takes"]=json!([])}
  for t in old["takes"].as_array().into_iter().flatten() { let takes=seg["takes"].as_array_mut().unwrap(); if !takes.iter().any(|x|x["id"]==t["id"]){takes.push(t.clone())} }
  // A take the server selected comes with the trim it set from the take's speech edges.
  if seg["selected_take_id"].is_null()&&!old["selected_take_id"].is_null(){for k in ["selected_take_id","trim_start_ms","trim_end_ms"]{seg[k]=old[k].clone()}}
 }
}
fn blank(p:&Value)->bool{["segments","transcript"].iter().all(|k|p[k].as_array().is_none_or(|a|a.is_empty()))}
/// True when the newest automatic version (by write order) is older than ten minutes, absent or dated in the future.
fn version_due(c:&Connection,pid:&str)->Result<bool>{
 let t:Option<String>=c.query_row("SELECT created_at FROM project_versions WHERE project_id=?1 AND reason='auto' ORDER BY rowid DESC LIMIT 1",[pid],|r|r.get(0)).optional().map_err(err)?;
 let age=t.and_then(|t|chrono::DateTime::parse_from_rfc3339(&t).ok()).map(|t|(Utc::now()-t.with_timezone(&Utc)).num_seconds());
 Ok(age.is_none_or(|a|!(0..=VERSION_GAP_SECS).contains(&a)))
}
/// Stores `p` deflated as a version of the project (`state_at` is when `p` was last edited), then applies the retention rules.
fn insert_version(c:&Connection,pid:&str,revision:i64,state_at:&str,reason:&str,p:&Value)->Result<()>{
 let count=|k:&str|p[k].as_array().map_or(0,|a|a.len() as i64);
 let chars:i64=p["segments"].as_array().into_iter().flatten().map(|s|s["text"].as_str().map_or(0,|t|t.chars().count() as i64)).sum();
 let data=compress_to_vec(p.to_string().as_bytes(),6);
 c.execute("INSERT INTO project_versions(id,project_id,revision,state_at,created_at,reason,segments,transcript,chars,bytes,data) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
  params![Uuid::new_v4().to_string(),pid,revision,state_at,now(),reason,count("segments"),count("transcript"),chars,data.len() as i64,data]).map_err(err)?;
 prune(c,pid)
}
/// At most 5 `before_restore` rows (so restores cannot push out the automatic history), then 30 rows, then 32 MiB, always keeping the newest.
fn prune(c:&Connection,pid:&str)->Result<()>{
 c.execute("DELETE FROM project_versions WHERE project_id=?1 AND reason='before_restore' AND id NOT IN (SELECT id FROM project_versions WHERE project_id=?1 AND reason='before_restore' ORDER BY created_at DESC,rowid DESC LIMIT ?2)",params![pid,KEEP_BEFORE_RESTORE]).map_err(err)?;
 c.execute("DELETE FROM project_versions WHERE project_id=?1 AND id NOT IN (SELECT id FROM project_versions WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT ?2)",params![pid,KEEP_VERSIONS]).map_err(err)?;
 let sizes:Vec<(String,i64)>={let mut q=c.prepare("SELECT id,bytes FROM project_versions WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC").map_err(err)?;let r=q.query_map([pid],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).map_err(err)?;r.collect::<std::result::Result<_,_>>().map_err(err)?};
 let mut sum=0;
 for (i,(id,bytes)) in sizes.iter().enumerate(){sum+=*bytes;if i>0&&sum>MAX_VERSION_BYTES{c.execute("DELETE FROM project_versions WHERE id=?1",[id]).map_err(err)?;}}
 Ok(())
}

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
   CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
   CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS voices(id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS project_versions(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, state_at TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL,
    segments INTEGER NOT NULL, transcript INTEGER NOT NULL, chars INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL);
   CREATE INDEX IF NOT EXISTS project_versions_by_project ON project_versions(project_id, created_at);
   PRAGMA user_version=2;").map_err(err)?;
  let s = Self{db:Mutex::new(db),root:root.to_owned()};
  let running:Vec<String>={let db=s.db.lock().map_err(err)?;let mut q=db.prepare("SELECT data FROM jobs WHERE status='running'").map_err(err)?;let r=q.query_map([],|r|r.get(0)).map_err(err)?;r.collect::<std::result::Result<_,_>>().map_err(err)?};
  for d in running { let mut j=parse(d)?; j["status"]=json!("interrupted"); j["error"]=json!("Phiên trước dừng giữa chừng. Chọn thử lại."); s.write_job(&j)?;
   // A separation cut off by a crash leaves its partial stem; it restarts from zero anyway.
   if let ("separate",Some(id))=(j["kind"].as_str().unwrap_or(""),j["id"].as_str()){crate::runtime::remove_stems(&root.join("jobs").join(id));} }
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
  check(&p)?;
  let id=ident(&p,"id")?; let name=ident(&p,"name")?;
  let revision=p["revision"].as_i64().ok_or("INVALID_REVISION")?;
  p["revision"]=json!(revision+1);p["updated_at"]=json!(now());
  let mut db=self.db.lock().map_err(err)?;
  let mut tx=db.transaction().map_err(err)?;
  let row:Option<(i64,String,String)>=tx.query_row("SELECT revision,updated_at,data FROM projects WHERE id=?1",[&id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional().map_err(err)?;
  let Some((stored_rev,stored_at,d))=row.filter(|r|r.0==revision) else {return Err(CONFLICT.into())};
  let stored=parse(d)?;
  keep_takes(&mut p,&stored);
  // The version is a bonus: its failure rolls back to the savepoint, is logged, and never fails the save.
  if !blank(&stored) {
   let r=tx.savepoint().map_err(err).and_then(|sp|{if version_due(&sp,&id)?{insert_version(&sp,&id,stored_rev,&stored_at,"auto",&stored)?}sp.commit().map_err(err)});
   if let Err(e)=r {self.log_version_error(&id,&e)}
  }
  let n=tx.execute("UPDATE projects SET name=?1,revision=?2,updated_at=?3,data=?4 WHERE id=?5 AND revision=?6",params![name,revision+1,p["updated_at"].as_str(),p.to_string(),id,revision]).map_err(err)?;
  if n!=1{return Err(CONFLICT.into())}
  tx.commit().map_err(err)?;Ok(p)
 }
 pub fn list_versions(&self,project_id:&str)->Result<Vec<Value>>{let db=self.db.lock().map_err(err)?;let mut q=db.prepare("SELECT id,project_id,revision,state_at,created_at,reason,segments,transcript,chars,bytes FROM project_versions WHERE project_id=?1 ORDER BY created_at DESC,rowid DESC").map_err(err)?;let r=q.query_map([project_id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"project_id":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"state_at":r.get::<_,String>(3)?,"created_at":r.get::<_,String>(4)?,"reason":r.get::<_,String>(5)?,"segments":r.get::<_,i64>(6)?,"transcript":r.get::<_,i64>(7)?,"chars":r.get::<_,i64>(8)?,"bytes":r.get::<_,i64>(9)?}))).map_err(err)?;r.collect::<std::result::Result<Vec<_>,_>>().map_err(err)}
 /// Makes a stored version the current state in one transaction. The state it replaces is kept as a `before_restore` version, the current
 /// name stays, and takes the version lacks are kept. Refused on a stale revision or while the project has queued or running jobs.
 pub fn restore_version(&self,project_id:&str,version_id:&str,revision:i64)->Result<Value>{
  let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;
  let (rev,name,at,d)=tx.query_row("SELECT revision,name,updated_at,data FROM projects WHERE id=?1",[project_id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional().map_err(err)?.ok_or("PROJECT_NOT_FOUND")?;
  if rev!=revision {return Err(CONFLICT.into())}
  let busy:i64=tx.query_row("SELECT count(*) FROM jobs WHERE project_id=?1 AND status IN ('queued','running')",[project_id],|r|r.get(0)).map_err(err)?;
  if busy>0 {return Err("PROJECT_BUSY: Dự án đang có công việc chạy hoặc chờ. Chờ xong hoặc hủy rồi khôi phục.".into())}
  let blob:Vec<u8>=tx.query_row("SELECT data FROM project_versions WHERE id=?1 AND project_id=?2",[version_id,project_id],|r|r.get(0)).optional().map_err(err)?.ok_or("VERSION_NOT_FOUND: Phiên bản này không còn. Mở lại lịch sử phiên bản.")?;
  let current=parse(d)?;
  insert_version(&tx,project_id,rev,&at,"before_restore",&current)?;
  let mut p:Value=serde_json::from_slice(&decompress_to_vec_with_limit(&blob,MAX_INFLATED).map_err(|_|CORRUPT.to_string())?).map_err(|_|CORRUPT.to_string())?;
  p["id"]=json!(project_id);p["name"]=json!(name);
  keep_takes(&mut p,&current);
  p["revision"]=json!(rev+1);p["updated_at"]=json!(now());
  check(&p)?;
  let n=tx.execute("UPDATE projects SET name=?1,revision=?2,updated_at=?3,data=?4 WHERE id=?5 AND revision=?6",params![name,rev+1,p["updated_at"].as_str(),p.to_string(),project_id,rev]).map_err(err)?;
  if n!=1 {return Err(CONFLICT.into())}
  tx.commit().map_err(err)?;Ok(p)
 }
 fn log_version_error(&self,pid:&str,e:&str){if let Ok(mut f)=fs::OpenOptions::new().create(true).append(true).open(self.root.join(VERSION_ERRORS)){let _=writeln!(f,"{}",json!({"at":now(),"project_id":pid,"error":e}));}}
 /// The text of `export_diagnostics`: the worker diagnostics plus the log of failed version writes.
 pub fn diagnostics(&self)->Result<String>{
  let log=fs::read_to_string(self.root.join(VERSION_ERRORS)).ok().filter(|t|!t.trim().is_empty()).unwrap_or_else(||"(empty)\n".into());
  Ok(format!("{}\n== {VERSION_ERRORS} ==\n{log}",crate::engine::diagnostics(&self.root,&self.settings()?)))
 }
 /// Refused while the project has queued or running jobs. Its failed, cancelled and interrupted jobs (no output) go with it,
 /// and so do its succeeded tts jobs (each only fed a take of this project). Other succeeded ones stay: other projects find
 /// separation stems by asset id, renders are saved from the queue, and a transcript can be applied to another project.
 pub fn delete_project(&self,id:&str)->Result<()> { let mut db=self.db.lock().map_err(err)?; let tx=db.transaction().map_err(err)?; let n:i64=tx.query_row("SELECT count(*) FROM jobs WHERE project_id=?1 AND status IN ('queued','running')",[id],|r|r.get(0)).map_err(err)?;if n>0{return Err("PROJECT_BUSY: Hủy công việc trước khi xóa.".into())}tx.execute("DELETE FROM jobs WHERE project_id=?1 AND (status IN ('failed','cancelled','interrupted') OR (status='succeeded' AND kind='tts'))",[id]).map_err(err)?;tx.execute("DELETE FROM projects WHERE id=?1",[id]).map_err(err)?;tx.commit().map_err(err) }
 pub fn enqueue(&self,kind:&str,project:Option<&str>,payload:Value)->Result<Value>{
  if !["tts","stt","render","model_download","clone_preview","separate"].contains(&kind){return Err("INVALID_JOB_KIND".into())}
  let j=json!({"id":Uuid::new_v4().to_string(),"kind":kind,"project_id":project,"payload":payload,"status":"queued","progress":0.0,"error":null,"result":null,"created_at":now(),"updated_at":now()});
  // One lock for the check and the insert, so a concurrent delete_project cannot fall between them.
  let db=self.db.lock().map_err(err)?;
  if let Some(id)=project {db.query_row("SELECT 1 FROM projects WHERE id=?1",[id],|_|Ok(())).map_err(|_|"PROJECT_NOT_FOUND".to_string())?;}
  db.execute("INSERT INTO jobs VALUES(?1,?2,?3,'queued',?4,?5)",params![j["id"].as_str(),kind,project,j["created_at"].as_str(),j.to_string()]).map_err(err)?;Ok(j)
 }
 fn write_job(&self,j:&Value)->Result<()> {self.db.lock().map_err(err)?.execute("UPDATE jobs SET status=?1,data=?2 WHERE id=?3",params![j["status"].as_str(),j.to_string(),j["id"].as_str()]).map_err(err)?;Ok(())}
 pub fn list_jobs(&self)->Result<Vec<Value>>{let db=self.db.lock().map_err(err)?;let mut q=db.prepare("SELECT data FROM jobs ORDER BY created_at DESC").map_err(err)?;let rows=q.query_map([],|r|r.get::<_,String>(0)).map_err(err)?;rows.map(|r|parse(r.map_err(err)?)).collect()}
 pub fn job(&self,id:&str)->Result<Value>{let s=self.db.lock().map_err(err)?.query_row("SELECT data FROM jobs WHERE id=?1",[id],|r|r.get::<_,String>(0)).map_err(|_|"JOB_NOT_FOUND".to_string())?;parse(s)}
 pub fn claim_next(&self)->Result<Option<Value>>{let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let d:Option<String>=tx.query_row(CLAIM_NEXT,[],|r|r.get(0)).optional().map_err(err)?;let Some(d)=d else{return Ok(None)};let mut j=parse(d)?;j["status"]=json!("running");j["updated_at"]=json!(now());tx.execute("UPDATE jobs SET status='running',data=?1 WHERE id=?2",params![j.to_string(),j["id"].as_str()]).map_err(err)?;tx.commit().map_err(err)?;Ok(Some(j))}
 pub fn claim_queued(&self,kind:&str,limit:usize)->Result<Vec<Value>>{let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let rows:Vec<String>={let mut q=tx.prepare("SELECT data FROM jobs WHERE status='queued' AND kind=?1 ORDER BY created_at LIMIT ?2").map_err(err)?;let r=q.query_map(params![kind,limit as i64],|r|r.get::<_,String>(0)).map_err(err)?;r.collect::<std::result::Result<_,_>>().map_err(err)?};let mut out=Vec::new();for d in rows{let mut j=parse(d)?;j["status"]=json!("running");j["updated_at"]=json!(now());tx.execute("UPDATE jobs SET status='running',data=?1 WHERE id=?2",params![j.to_string(),j["id"].as_str()]).map_err(err)?;out.push(j);}tx.commit().map_err(err)?;Ok(out)}
 pub fn cancel(&self,id:&str)->Result<Value>{self.transition(id,"cancelled",None)}
 pub fn retry(&self,id:&str)->Result<Value>{let j=self.job(id)?;if !["failed","cancelled","interrupted"].contains(&j["status"].as_str().unwrap_or("")){return Err("INVALID_JOB_STATE".into())} self.transition(id,"queued",None)}
 fn transition(&self,id:&str,status:&str,error:Option<&str>)->Result<Value>{let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let d:String=tx.query_row("SELECT data FROM jobs WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;let mut j=parse(d)?;if j["status"]=="succeeded" {return Err("INVALID_JOB_STATE".into())}j["status"]=json!(status);j["updated_at"]=json!(now());j["error"]=json!(error);if status=="queued"{j["progress"]=json!(0);j["result"]=Value::Null;}tx.execute("UPDATE jobs SET status=?1,data=?2 WHERE id=?3",params![status,j.to_string(),id]).map_err(err)?;tx.commit().map_err(err)?;Ok(j)}
 pub fn progress(&self,id:&str,value:f64)->Result<()> {let mut j=self.job(id)?;if j["status"]=="running" {j["progress"]=json!(value.clamp(0.0,1.0));self.db.lock().map_err(err)?.execute("UPDATE jobs SET data=?1 WHERE id=?2 AND status='running'",params![j.to_string(),id]).map_err(err)?;}Ok(())}
 pub fn fail(&self,id:&str,message:&str)->Result<()> {if self.job(id)?["status"]!="cancelled"{self.transition(id,"failed",Some(message))?;}Ok(())}
 pub fn finish(&self,id:&str,result:Value)->Result<Value>{
  let mut db=self.db.lock().map_err(err)?;let tx=db.transaction().map_err(err)?;let d:String=tx.query_row("SELECT data FROM jobs WHERE id=?1",[id],|r|r.get(0)).map_err(err)?;let mut j=parse(d)?;if j["status"]!="running"{return Err("INVALID_JOB_STATE".into())}
  if j["kind"]=="tts" {if let Some(pid)=j["project_id"].as_str(){let d:String=tx.query_row("SELECT data FROM projects WHERE id=?1",[pid],|r|r.get(0)).map_err(err)?;let mut p=parse(d)?;if let Some(s)=p["segments"].as_array_mut().and_then(|ss|ss.iter_mut().find(|s|s["id"]==j["payload"]["segment_id"])) {let mut take=result.clone();take["id"]=json!(Uuid::new_v4().to_string());take["created_at"]=json!(now());if s["selected_take_id"].is_null(){s["selected_take_id"]=take["id"].clone();let start=take["speech_start_ms"].as_f64().unwrap_or(0.0);let end=take["speech_end_ms"].as_f64();let fades=s["fade_in_ms"].as_f64().unwrap_or(0.0)+s["fade_out_ms"].as_f64().unwrap_or(0.0);/* fades set before the take must still fit inside the trim */if end.or(take["duration_ms"].as_f64()).unwrap_or(0.0)-start>=fades{s["trim_start_ms"]=json!(start);s["trim_end_ms"]=json!(end);}else{s["trim_start_ms"]=json!(0.0);s["trim_end_ms"]=json!(null);}}if !s["takes"].is_array(){s["takes"]=json!([])}s["takes"].as_array_mut().unwrap().push(take);tx.execute("UPDATE projects SET data=?1 WHERE id=?2",params![p.to_string(),pid]).map_err(err)?;}}}
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
  // worker_engines is optional in the request and kept when absent, so a dictionary save never resets the engine choice.
  let old=self.settings()?;let engines=match v.get("worker_engines"){None=>old["worker_engines"].clone(),Some(e)=>{
   let m=e.as_object().filter(|m|m.iter().all(|(k,x)|crate::engine::OPS.contains(&k.as_str())&&matches!(x.as_str(),Some("auto"|"python")))).ok_or("INVALID_SETTINGS: worker_engines")?;
   for op in crate::engine::OPS{let (from,to)=(old["worker_engines"][op].as_str().unwrap_or("auto"),m.get(*op).and_then(Value::as_str).unwrap_or("auto"));if from!=to{crate::engine::log_change(&self.root,op,from,to);}}
   e.clone()}};
  let mut s=json!({"dictionary":d});if !engines.is_null(){s["worker_engines"]=engines;}
  self.db.lock().map_err(err)?.execute("INSERT INTO settings VALUES('app',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[s.to_string()]).map_err(err)?;Ok(s)
 }
}
