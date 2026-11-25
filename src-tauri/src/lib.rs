pub mod store;
pub mod runtime;
pub mod pack;
pub mod engine;
pub mod docx;
pub mod update;
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,atomic::Ordering}};
use tauri::{Manager,State};
use store::{Store,Result};
use runtime::Runtime;
pub struct AppState {store:Arc<Store>,runtime:Arc<Runtime>}

// `(async)` runs a command on Tauri's thread pool: a plain sync command runs on the main thread, which also drives the window.
#[tauri::command(async)] fn list_projects(s:State<AppState>)->Result<Vec<Value>>{s.store.list_projects()}
#[tauri::command(async)] fn create_project(name:String,s:State<AppState>)->Result<Value>{s.store.create_project(&name)}
#[tauri::command(async)] fn load_project(id:String,s:State<AppState>)->Result<Value>{s.store.load_project(&id)}
#[tauri::command(async)] fn save_project(project:Value,s:State<AppState>)->Result<Value>{s.store.save_project(project)}
#[tauri::command(async)] fn delete_project(id:String,s:State<AppState>)->Result<()>{s.store.delete_project(&id)}
#[tauri::command(async)] fn list_project_versions(project_id:String,s:State<AppState>)->Result<Vec<Value>>{s.store.list_versions(&project_id)}
#[tauri::command(async)] fn restore_project_version(project_id:String,version_id:String,revision:i64,s:State<AppState>)->Result<Value>{s.store.restore_version(&project_id,&version_id,revision)}
#[tauri::command(async)] fn get_settings(s:State<AppState>)->Result<Value>{s.store.settings()}
#[tauri::command(async)] fn save_settings(settings:Value,s:State<AppState>)->Result<Value>{s.store.save_settings(settings)}
#[tauri::command(async)] fn list_jobs(s:State<AppState>)->Result<Vec<Value>>{s.store.list_jobs()}
#[tauri::command(async)] fn enqueue_job(kind:String,project_id:Option<String>,payload:Value,s:State<AppState>)->Result<Value>{
 if kind=="tts" {let pid=project_id.as_deref().ok_or("PROJECT_REQUIRED")?;let p=s.store.load_project(pid)?;if !p["segments"].as_array().ok_or("INVALID_SEGMENTS")?.iter().any(|seg|seg["id"]==payload["segment_id"]){return Err("SEGMENT_NOT_FOUND".into())}}
 s.store.enqueue(&kind,project_id.as_deref(),payload)
}
#[tauri::command(async)] fn cancel_job(id:String,s:State<AppState>)->Result<Value>{s.store.cancel(&id)}
#[tauri::command(async)] fn retry_job(id:String,s:State<AppState>)->Result<Value>{s.store.retry(&id)}
#[tauri::command(async)] fn runtime_status(s:State<AppState>)->Value{let mut v=s.runtime.status();v["fallback_count"]=json!(engine::fallback_count(&s.store.root));v}
/// One UTF-8 text file with the settings, both worker logs, the startup error log and the version-write error log, for a bug report.
#[tauri::command(async)] fn export_diagnostics(path:String,s:State<AppState>)->Result<()>{let p=Path::new(&path);if !p.is_absolute()||p.extension().and_then(|e|e.to_str()).unwrap_or("").to_lowercase()!="txt"{return Err("UNSUPPORTED_TEXT".into())}std::fs::write(p,s.store.diagnostics()?.as_bytes()).map_err(|e|e.to_string())}
#[tauri::command(async)] fn get_asset(id:String,s:State<AppState>)->Result<Value>{s.store.asset(&id)}
#[tauri::command] async fn import_asset(path:String,s:State<'_,AppState>)->Result<Value>{let store=s.store.clone();tauri::async_runtime::spawn_blocking(move||store.import_asset(Path::new(&path))).await.map_err(|e|e.to_string())?}
#[tauri::command] async fn read_text_file(path:String)->Result<String>{tauri::async_runtime::spawn_blocking(move||read_text(path)).await.map_err(|e|e.to_string())?}
fn read_text(path:String)->Result<String>{let p=Path::new(&path);let ext=p.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();if !["txt","srt","vtt","csv","docx"].contains(&ext.as_str()){return Err("UNSUPPORTED_TEXT".into())}if std::fs::metadata(p).map_err(|e|e.to_string())?.len()>if ext=="docx"{100_000_000}else{docx::MAX_TEXT as u64}{return Err("TEXT_FILE_TOO_LARGE".into())}if ext=="docx"{return docx::docx_text(&std::fs::read(p).map_err(|e|e.to_string())?)}std::fs::read_to_string(p).map(|s|s.trim_start_matches('\u{feff}').to_owned()).map_err(|e|format!("UTF8_REQUIRED: {e}"))}
/// Explorer with a saved file selected; nothing is run. Paths cannot contain `"`, so quoting is safe.
pub fn reveal_command(p:&Path)->std::process::Command{let mut c=std::process::Command::new(std::env::var_os("SystemRoot").map(|r|PathBuf::from(r).join("explorer.exe")).unwrap_or_else(||"explorer.exe".into()));#[cfg(windows)]{use std::os::windows::process::CommandExt;c.raw_arg(format!("/select,\"{}\"",p.display()));}c}
#[tauri::command] fn reveal_path(path:String)->Result<()>{let p=Path::new(&path);if !p.is_absolute()||!p.is_file(){return Err("NOT_FOUND".into())}reveal_command(p).spawn().map(|_|()).map_err(|e|e.to_string())}
#[tauri::command(async)] fn export_text(path:String,content:String)->Result<()>{let p=Path::new(&path);if !["txt","srt","vtt","csv"].contains(&p.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase().as_str()){return Err("UNSUPPORTED_TEXT".into())}std::fs::write(p,content.as_bytes()).map_err(|e|e.to_string())}
#[tauri::command] async fn export_asset(asset_id:String,path:String,s:State<'_,AppState>)->Result<()>{let a=s.store.asset(&asset_id)?;let from=PathBuf::from(a["path"].as_str().ok_or("ASSET_PATH")?);let to=PathBuf::from(path);if from.extension().map(|v|v.to_ascii_lowercase())!=to.extension().map(|v|v.to_ascii_lowercase()){return Err("FORMAT_MISMATCH: Chọn đúng định dạng đã render.".into())}if from==to{return Ok(())}tauri::async_runtime::spawn_blocking(move||std::fs::copy(from,to).map(|_|()).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?}
/// Copies `from` to `to` unless `to` already exists; `Ok(false)` means it was left alone. A failed copy removes the partial `to`, so a retry does not see it as existing.
pub fn copy_new(from:&Path,to:&Path)->std::io::Result<bool>{write_new(&mut std::fs::File::open(from)?,to)}
/// Writes everything `src` yields to `to` unless `to` already exists (`Ok(false)`); a read error removes the partial `to`.
pub fn write_new(src:&mut impl std::io::Read,to:&Path)->std::io::Result<bool>{let mut out=match std::fs::OpenOptions::new().write(true).create_new(true).open(to){Ok(f)=>f,Err(e)if e.kind()==std::io::ErrorKind::AlreadyExists=>return Ok(false),Err(e)=>return Err(e)};if let Err(e)=std::io::copy(src,&mut out){drop(out);let _=std::fs::remove_file(to);return Err(e)}Ok(true)}
#[tauri::command] async fn export_asset_new(asset_id:String,path:String,s:State<'_,AppState>)->Result<bool>{let a=s.store.asset(&asset_id)?;let from=PathBuf::from(a["path"].as_str().ok_or("ASSET_PATH")?);let to=PathBuf::from(path);if from.extension().map(|v|v.to_ascii_lowercase())!=to.extension().map(|v|v.to_ascii_lowercase()){return Err("FORMAT_MISMATCH: Chọn đúng định dạng đã render.".into())}tauri::async_runtime::spawn_blocking(move||copy_new(&from,&to).map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?}
#[tauri::command(async)] fn list_voices(s:State<AppState>)->Result<Vec<Value>>{let mut voices=s.store.list_voices()?;let f=s.runtime.worker().parent().unwrap().join("voices.json");if let Ok(data)=std::fs::read_to_string(f){if let Ok(v)=serde_json::from_str::<Value>(&data){let values=v.as_array().or_else(||v["voices"].as_array());if let Some(arr)=values {for v in arr{let id=v["id"].as_str().or(v["voice_id"].as_str()).unwrap_or("");if id.is_empty(){continue}if !voices.iter().any(|x|x["id"]==id){voices.push(json!({"id":id,"name":v["name"].as_str().unwrap_or(id),"kind":"preset","reference_asset_id":null,"consent":true,"engine_voice_id":id}));}}}}}Ok(voices)}
#[tauri::command(async)] fn save_voice(voice:Value,s:State<AppState>)->Result<Value>{s.store.save_voice(voice)}
pub fn model_description(engine:&str)->&'static str{match engine{"tts"=>"TTS tiếng Việt • CPU ONNX • local","separation"=>"Tách giọng nói khỏi nhạc nền • CPU PyTorch • local","runtime"=>"Python và PyTorch để tách nhạc nền • tải một lần • local",_=>"Nhận dạng giọng nói • CPU INT8 • local"}}
#[tauri::command(async)] fn list_models(s:State<AppState>)->Vec<Value>{let models_json=s.runtime.worker().parent().unwrap().join("models.json");let registry=std::fs::read_to_string(&models_json).ok().and_then(|v|serde_json::from_str::<Value>(&v).ok()).unwrap_or(Value::Null);let entries=registry["models"].as_array().cloned().unwrap_or_default();runtime::MODELS.iter().map(|(id,name,engine,license)|{let marker=s.store.root.join("models").join(id).join("installed.json");let revision=entries.iter().find(|m|m["id"]==*id).and_then(|m|m["revision"].as_str()).unwrap_or("manifest-pinned");json!({"id":id,"name":name,"engine":engine,"kind":entries.iter().find(|m|m["id"]==*id).and_then(|m|m["kind"].as_str()).unwrap_or("model"),"installed":if *id==pack::PACK_ID{pack::installed(&s.store.root,&models_json)}else{marker.is_file()},"revision":revision,"license":license,"description":model_description(engine)})}).collect()}
#[tauri::command] fn download_model(id:String,license_accepted:Option<bool>,s:State<AppState>)->Result<Value>{if !runtime::MODELS.iter().any(|m|m.0==id){return Err("INVALID_MODEL".into())}for j in s.store.list_jobs()?{if j["kind"]=="model_download"&&j["payload"]["model_id"]==id&&["queued","running"].contains(&j["status"].as_str().unwrap_or("")){return Ok(j)}}s.store.enqueue("model_download",None,pack::download_payload(&s.store.root,&s.runtime.worker().with_file_name("models.json"),&id,license_accepted==Some(true))?)}

/// For the start only: a panic (Tauri turns a failed setup into one) is appended to `<dir>/startup-errors.log`, and one on the thread
/// that made the hook is also shown by `notify`, as the windowed build has no console.
pub fn startup_hook(dir:PathBuf,notify:impl Fn(&str)+Send+Sync+'static)->Box<dyn Fn(&std::panic::PanicHookInfo)+Send+Sync>{let main=std::thread::current().id();Box::new(move|i|{
 // The user gets the error without Tauri's English wrapper (tauri 2.12 app.rs/error.rs); the log keeps it.
 use std::io::Write;let log=dir.join(engine::STARTUP_LOG);let err=i.payload_as_str().unwrap_or("panic").trim_start_matches("Failed to setup app: error encountered during setup hook: ").trim_end_matches('.');
 let line=format!("{} {} {}\n",chrono::Local::now().to_rfc3339(),env!("CARGO_PKG_VERSION"),i.to_string().replace('\n'," "));
 let saved=std::fs::create_dir_all(&dir).and_then(|_|std::fs::OpenOptions::new().create(true).append(true).open(&log)).and_then(|mut f|f.write_all(line.as_bytes()));
 if std::thread::current().id()!=main{return}
 notify(&match saved{Ok(())=>format!("Thanh Âm Studio không khởi động được: {err}.\n\nChi tiết đã ghi vào {}.",log.display()),Err(e)=>format!("Thanh Âm Studio không khởi động được: {err}.\n\nKhông ghi được nhật ký vào {}: {e}.",log.display())});
})}
#[cfg(windows)] fn message_box(text:&str){use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW,MB_ICONERROR,MB_OK,MB_SETFOREGROUND};let w=|s:&str|s.encode_utf16().chain([0]).collect::<Vec<u16>>();unsafe{MessageBoxW(std::ptr::null_mut(),w(text).as_ptr(),w("Thanh Âm Studio").as_ptr(),MB_OK|MB_ICONERROR|MB_SETFOREGROUND);}}
#[cfg(not(windows))] fn message_box(_:&str){}

pub fn run() {
 let ctx=tauri::generate_context!();
 // Until RunEvent::Ready; the default hook runs first so a debug build still prints the panic.
 let (default,hook)=(std::panic::take_hook(),startup_hook(std::env::var_os("LOCALAPPDATA").filter(|v|!v.is_empty()).map_or_else(std::env::temp_dir,PathBuf::from).join(&ctx.config().identifier),message_box));
 std::panic::set_hook(Box::new(move|i|{default(i);hook(i)}));
 // First, so a second launch exits in plugin init, before `.setup` opens the store (which would mark the first instance's running jobs interrupted).
 // No `unwrap`: a forwarded launch can arrive before `.setup` has built the window.
 let app=tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(w)=app.get_webview_window("main"){let _=w.unminimize();let _=w.show();let _=w.set_focus();}})).plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_updater::Builder::new().build()).manage(update::Updates::default()).setup(|app|{
  let root=app.path().app_local_data_dir()?;
  let resource=app.path().resource_dir()?;
  let source=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
  let store=Arc::new(Store::open(&root).map_err(std::io::Error::other)?);
  let runtime=Arc::new(Runtime::new(resource,source));
  app.manage(AppState{store:store.clone(),runtime:runtime.clone()});
  // Tauri's default WebView2 flags, plus an opt-in localhost DevTools port for the packaged acceptance harness
  // (some WebView2 runtimes ignore WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).
  let mut args="--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string();
  if let Some(port)=std::env::var("THANHAM_E2E_CDP_PORT").ok().and_then(|p|p.parse::<u16>().ok()){args+=&format!(" --remote-debugging-port={port}");}
  tauri::WebviewWindowBuilder::from_config(app.handle(),&app.config().app.windows[0])?.additional_browser_args(&args).build()?;
  // Jobs start once the window is up, so none runs unseen behind a failed start's error box.
  runtime.start(store);Ok(())
 }).invoke_handler(tauri::generate_handler![list_projects,create_project,load_project,save_project,delete_project,list_project_versions,restore_project_version,get_settings,save_settings,list_jobs,enqueue_job,cancel_job,retry_job,runtime_status,export_diagnostics,read_text_file,import_asset,get_asset,list_models,download_model,export_text,export_asset,export_asset_new,list_voices,save_voice,reveal_path,update::update_check,update::update_download,update::update_install,update::update_last_install]).build(ctx).expect("Khởi tạo Thanh Âm Studio");
 app.run(|handle,event|match event{tauri::RunEvent::Ready=>drop(std::panic::take_hook()),tauri::RunEvent::Exit=>{handle.state::<AppState>().runtime.shutdown.store(true,Ordering::Relaxed);std::thread::sleep(std::time::Duration::from_millis(250));},_=>{}});
}
