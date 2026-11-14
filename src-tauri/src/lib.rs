pub mod store;
pub mod runtime;
pub mod docx;
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,atomic::Ordering}};
use tauri::{Manager,State};
use store::{Store,Result};
use runtime::Runtime;
pub struct AppState {store:Arc<Store>,runtime:Arc<Runtime>}

#[tauri::command] fn list_projects(s:State<AppState>)->Result<Vec<Value>>{s.store.list_projects()}
#[tauri::command] fn create_project(name:String,s:State<AppState>)->Result<Value>{s.store.create_project(&name)}
#[tauri::command] fn load_project(id:String,s:State<AppState>)->Result<Value>{s.store.load_project(&id)}
#[tauri::command] fn save_project(project:Value,s:State<AppState>)->Result<Value>{s.store.save_project(project)}
#[tauri::command] fn delete_project(id:String,s:State<AppState>)->Result<()>{s.store.delete_project(&id)}
#[tauri::command] fn get_settings(s:State<AppState>)->Result<Value>{s.store.settings()}
#[tauri::command] fn save_settings(settings:Value,s:State<AppState>)->Result<Value>{s.store.save_settings(settings)}
#[tauri::command] fn list_jobs(s:State<AppState>)->Result<Vec<Value>>{s.store.list_jobs()}
#[tauri::command] fn enqueue_job(kind:String,project_id:Option<String>,payload:Value,s:State<AppState>)->Result<Value>{
 if kind=="tts" {let pid=project_id.as_deref().ok_or("PROJECT_REQUIRED")?;let p=s.store.load_project(pid)?;if !p["segments"].as_array().ok_or("INVALID_SEGMENTS")?.iter().any(|seg|seg["id"]==payload["segment_id"]){return Err("SEGMENT_NOT_FOUND".into())}}
 s.store.enqueue(&kind,project_id.as_deref(),payload)
}
#[tauri::command] fn cancel_job(id:String,s:State<AppState>)->Result<Value>{s.store.cancel(&id)}
#[tauri::command] fn retry_job(id:String,s:State<AppState>)->Result<Value>{s.store.retry(&id)}
#[tauri::command] fn runtime_status(s:State<AppState>)->Value{s.runtime.status()}
#[tauri::command] fn get_asset(id:String,s:State<AppState>)->Result<Value>{s.store.asset(&id)}
#[tauri::command] async fn import_asset(path:String,s:State<'_,AppState>)->Result<Value>{let store=s.store.clone();tauri::async_runtime::spawn_blocking(move||store.import_asset(Path::new(&path))).await.map_err(|e|e.to_string())?}
#[tauri::command] async fn read_text_file(path:String)->Result<String>{tauri::async_runtime::spawn_blocking(move||read_text(path)).await.map_err(|e|e.to_string())?}
fn read_text(path:String)->Result<String>{let p=Path::new(&path);let ext=p.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();if !["txt","srt","vtt","csv","docx"].contains(&ext.as_str()){return Err("UNSUPPORTED_TEXT".into())}if std::fs::metadata(p).map_err(|e|e.to_string())?.len()>if ext=="docx"{100_000_000}else{docx::MAX_TEXT as u64}{return Err("TEXT_FILE_TOO_LARGE".into())}if ext=="docx"{return docx::docx_text(&std::fs::read(p).map_err(|e|e.to_string())?)}std::fs::read_to_string(p).map(|s|s.trim_start_matches('\u{feff}').to_owned()).map_err(|e|format!("UTF8_REQUIRED: {e}"))}
#[tauri::command] fn export_text(path:String,content:String)->Result<()>{let p=Path::new(&path);if !["txt","srt","vtt","csv"].contains(&p.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase().as_str()){return Err("UNSUPPORTED_TEXT".into())}std::fs::write(p,content.as_bytes()).map_err(|e|e.to_string())}
#[tauri::command] async fn export_asset(asset_id:String,path:String,s:State<'_,AppState>)->Result<()>{let a=s.store.asset(&asset_id)?;let from=PathBuf::from(a["path"].as_str().ok_or("ASSET_PATH")?);let to=PathBuf::from(path);if from.extension().map(|v|v.to_ascii_lowercase())!=to.extension().map(|v|v.to_ascii_lowercase()){return Err("FORMAT_MISMATCH: Chọn đúng định dạng đã render.".into())}if from==to{return Ok(())}tauri::async_runtime::spawn_blocking(move||std::fs::copy(from,to).map(|_|()).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?}
/// Copies `from` to `to` unless `to` already exists; `Ok(false)` means it was left alone. A failed copy removes the partial `to`, so a retry does not see it as existing.
pub fn copy_new(from:&Path,to:&Path)->std::io::Result<bool>{write_new(&mut std::fs::File::open(from)?,to)}
/// Writes everything `src` yields to `to` unless `to` already exists (`Ok(false)`); a read error removes the partial `to`.
pub fn write_new(src:&mut impl std::io::Read,to:&Path)->std::io::Result<bool>{let mut out=match std::fs::OpenOptions::new().write(true).create_new(true).open(to){Ok(f)=>f,Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>return Ok(false),Err(e)=>return Err(e)};if let Err(e)=std::io::copy(src,&mut out){drop(out);let _=std::fs::remove_file(to);return Err(e)}Ok(true)}
#[tauri::command] async fn export_asset_new(asset_id:String,path:String,s:State<'_,AppState>)->Result<bool>{let a=s.store.asset(&asset_id)?;let from=PathBuf::from(a["path"].as_str().ok_or("ASSET_PATH")?);let to=PathBuf::from(path);if from.extension().map(|v|v.to_ascii_lowercase())!=to.extension().map(|v|v.to_ascii_lowercase()){return Err("FORMAT_MISMATCH: Chọn đúng định dạng đã render.".into())}tauri::async_runtime::spawn_blocking(move||copy_new(&from,&to).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?}
#[tauri::command] fn list_voices(s:State<AppState>)->Result<Vec<Value>>{let mut voices=s.store.list_voices()?;let f=s.runtime.worker().parent().unwrap().join("voices.json");if let Ok(data)=std::fs::read_to_string(f){if let Ok(v)=serde_json::from_str::<Value>(&data){let values=v.as_array().or_else(||v["voices"].as_array());if let Some(arr)=values {for v in arr{let id=v["id"].as_str().or(v["voice_id"].as_str()).unwrap_or("");if id.is_empty(){continue}if !voices.iter().any(|x|x["id"]==id){voices.push(json!({"id":id,"name":v["name"].as_str().unwrap_or(id),"kind":"preset","reference_asset_id":null,"consent":true,"engine_voice_id":id}));}}}}}Ok(voices)}
#[tauri::command] fn save_voice(voice:Value,s:State<AppState>)->Result<Value>{s.store.save_voice(voice)}
#[tauri::command] fn list_models(s:State<AppState>)->Vec<Value>{let registry=std::fs::read_to_string(s.runtime.worker().parent().unwrap().join("models.json")).ok().and_then(|v|serde_json::from_str::<Value>(&v).ok()).unwrap_or(Value::Null);let entries=registry["models"].as_array().cloned().unwrap_or_default();runtime::MODELS.iter().map(|(id,name,engine,license)|{let marker=s.store.root.join("models").join(id).join("installed.json");let revision=entries.iter().find(|m|m["id"]==*id).and_then(|m|m["revision"].as_str()).unwrap_or("manifest-pinned");json!({"id":id,"name":name,"engine":engine,"installed":marker.is_file(),"revision":revision,"license":license,"description":if *engine=="tts"{"TTS tiếng Việt • CPU ONNX • local"}else{"Nhận dạng giọng nói • CPU INT8 • local"}})}).collect()}
#[tauri::command] fn download_model(id:String,s:State<AppState>)->Result<Value>{if !runtime::MODELS.iter().any(|m|m.0==id){return Err("INVALID_MODEL".into())}for j in s.store.list_jobs()?{if j["kind"]=="model_download"&&j["payload"]["model_id"]==id&&["queued","running"].contains(&j["status"].as_str().unwrap_or("")){return Ok(j)}}s.store.enqueue("model_download",None,json!({"model_id":id}))}

pub fn run() {
 let app=tauri::Builder::default().plugin(tauri_plugin_dialog::init()).setup(|app|{
  let root=app.path().app_local_data_dir()?;
  let resource=app.path().resource_dir()?;
  let source=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
  let store=Arc::new(Store::open(&root).map_err(std::io::Error::other)?);
  let runtime=Arc::new(Runtime::new(resource,source));
  app.manage(AppState{store:store.clone(),runtime:runtime.clone()});runtime.start(store);
  // Tauri's default WebView2 flags, plus an opt-in localhost DevTools port for the packaged acceptance harness
  // (some WebView2 runtimes ignore WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).
  let mut args="--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string();
  if let Some(port)=std::env::var("THANHAM_E2E_CDP_PORT").ok().and_then(|p|p.parse::<u16>().ok()){args+=&format!(" --remote-debugging-port={port}");}
  tauri::WebviewWindowBuilder::from_config(app.handle(),&app.config().app.windows[0])?.additional_browser_args(&args).build()?;Ok(())
 }).invoke_handler(tauri::generate_handler![list_projects,create_project,load_project,save_project,delete_project,get_settings,save_settings,list_jobs,enqueue_job,cancel_job,retry_job,runtime_status,read_text_file,import_asset,get_asset,list_models,download_model,export_text,export_asset,export_asset_new,list_voices,save_voice]).build(tauri::generate_context!()).expect("Khởi tạo Thanh Âm Studio");
 app.run(|handle,event|if let tauri::RunEvent::Exit=event {handle.state::<AppState>().runtime.shutdown.store(true,Ordering::Relaxed);std::thread::sleep(std::time::Duration::from_millis(250));});
}
