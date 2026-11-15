//! In-app updates: check the signed release manifest, download the installer in the background, install on request.
//! The updater plugin verifies every package against the public key in tauri.conf.json before running it.
use serde_json::{json,Value};
use std::sync::{Mutex,atomic::Ordering};
use tauri::{AppHandle,Emitter,Manager,State};
use tauri_plugin_updater::{Update,UpdaterBuilder,UpdaterExt};
use crate::{AppState,store::Result};

#[derive(Default)]
pub struct Updates {found:Mutex<Option<Update>>,ready:Mutex<Option<(Update,Vec<u8>)>>}

/// The installer replaces the worker files, so the runtime stops as on a normal exit just before the app ends for it.
fn builder(app:&AppHandle)->UpdaterBuilder{let rt=app.state::<AppState>().runtime.clone();app.updater_builder().on_before_exit(move||{rt.shutdown.store(true,Ordering::Relaxed);std::thread::sleep(std::time::Duration::from_millis(250));})}

fn summary(u:&Update)->Value{json!({"version":u.version,"notes":u.body,"date":u.date.map(|d|d.unix_timestamp())})}

/// Looks for a newer release. THANHAM_UPDATE_MANIFEST (the packaged acceptance harness) reads a local manifest instead of
/// the release feed and also offers the installed version, so a test can reinstall the same signed build; the signature
/// must still match and name that version.
#[tauri::command]
pub async fn update_check(app:AppHandle,u:State<'_,Updates>)->Result<Value>{
 let found=match std::env::var("THANHAM_UPDATE_MANIFEST"){
  Ok(path)=>{let raw:Value=serde_json::from_str(&std::fs::read_to_string(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
   builder(&app).version_comparator(|current,release|release.version>=current).build().map_err(|e|e.to_string())?.restore_update(raw).map_err(|e|e.to_string())?}
  Err(_)=>builder(&app).build().map_err(|e|e.to_string())?.check().await.map_err(|e|e.to_string())?,
 };
 let out=found.as_ref().map(summary).unwrap_or(Value::Null);*u.found.lock().map_err(|e|e.to_string())?=found;Ok(out)
}

/// Downloads the update found by `update_check`, reporting `update-progress` events; the bytes stay in memory until installed.
#[tauri::command]
pub async fn update_download(app:AppHandle,u:State<'_,Updates>)->Result<Value>{
 let update=u.found.lock().map_err(|e|e.to_string())?.clone().ok_or("NO_UPDATE")?;
 let mut done=0usize;
 let bytes=update.download(|chunk,total|{done+=chunk;let _=app.emit("update-progress",json!({"downloaded":done,"total":total}));},||{}).await.map_err(|e|e.to_string())?;
 update.verify(&bytes).map_err(|e|e.to_string())?;
 let out=summary(&update);*u.ready.lock().map_err(|e|e.to_string())?=Some((update,bytes));Ok(out)
}

/// Runs the downloaded installer (passive, keeps app data) and exits; `restart` reopens the app afterwards.
#[tauri::command]
pub fn update_install(restart:bool,u:State<'_,Updates>)->Result<()>{
 let (update,bytes)=u.ready.lock().map_err(|e|e.to_string())?.take().ok_or("NO_UPDATE")?;
 update.restart_after_install(restart).install(bytes).map_err(|e|e.to_string())
}
