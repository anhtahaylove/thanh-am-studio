//! In-app updates: check the signed release manifest, download the installer in the background, install on request.
//! The updater plugin verifies every package against the public key in tauri.conf.json before running it. Workers
//! need no stopping first: they sit in a kill-on-close job object, so they end with the app when the installer starts.
use serde_json::{json,Value};
use std::{path::PathBuf,sync::Mutex,time::Duration};
use tauri::{AppHandle,Emitter,Manager,State};
use tauri_plugin_updater::{Update,UpdaterBuilder,UpdaterExt};
use crate::store::Result;

#[derive(Default)]
pub struct Updates {found:Mutex<Option<Update>>,ready:Mutex<Option<(Update,PathBuf)>>}

/// A stalled connection fails instead of keeping the check or download pending all session; no total timeout, the installer is ~200 MB.
fn builder(app:&AppHandle)->UpdaterBuilder{app.updater_builder().configure_client(|c|c.connect_timeout(Duration::from_secs(30)).read_timeout(Duration::from_secs(60)))}
/// Downloaded installers wait here, not in memory, until the app closes; `installing` marks an install in progress.
fn dir(app:&AppHandle)->Result<PathBuf>{Ok(app.path().app_local_data_dir().map_err(|e|e.to_string())?.join("updates"))}
fn summary(u:&Update)->Value{json!({"version":u.version,"notes":u.body,"date":u.date.map(|d|d.unix_timestamp())})}

/// Looks for a newer release. THANHAM_UPDATE_MANIFEST (the packaged acceptance harness) reads a local manifest instead of
/// the release feed and also offers the installed version, so a test can reinstall the same signed build; the signature
/// must still match and name that version. Left set by mistake, it only makes the app offer that same build again.
#[tauri::command]
pub async fn update_check(app:AppHandle,u:State<'_,Updates>)->Result<Value>{
 let found=match std::env::var("THANHAM_UPDATE_MANIFEST"){
  Ok(path)=>{let raw:Value=serde_json::from_str(&std::fs::read_to_string(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
   builder(&app).version_comparator(|current,release|release.version>=current).build().map_err(|e|e.to_string())?.restore_update(raw).map_err(|e|e.to_string())?}
  Err(_)=>builder(&app).build().map_err(|e|e.to_string())?.check().await.map_err(|e|e.to_string())?,
 };
 // Nothing newer: the installer kept for an earlier update (or the one just installed) is no longer needed.
 if found.is_none(){let _=std::fs::remove_dir_all(dir(&app)?);}
 let out=found.as_ref().map(summary).unwrap_or(Value::Null);*u.found.lock().map_err(|e|e.to_string())?=found;Ok(out)
}

/// Downloads (and verifies) the update found by `update_check` to disk, reporting `update-progress` once per percent;
/// an installer kept from an earlier session is reused when it still matches this update's signature.
#[tauri::command]
pub async fn update_download(app:AppHandle,u:State<'_,Updates>)->Result<Value>{
 let update=u.found.lock().map_err(|e|e.to_string())?.clone().ok_or("NO_UPDATE")?;
 let dir=dir(&app)?;let file=dir.join(format!("{}.exe",update.version));
 if !std::fs::read(&file).is_ok_and(|b|update.verify(&b).is_ok()){
  // The plugin installs its TLS provider in check(), which the acceptance manifest (restore_update) skips.
  let _=rustls::crypto::ring::default_provider().install_default();
  let (mut done,mut shown)=(0usize,None);
  let bytes=update.download(|chunk,total|{done+=chunk;let pct=total.map(|t|done as u64*100/t.max(1));if pct!=shown{shown=pct;let _=app.emit("update-progress",json!({"downloaded":done,"total":total}));}},||{}).await.map_err(|e|e.to_string())?;
  let _=std::fs::remove_dir_all(&dir);std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
  let part=file.with_extension("partial");std::fs::write(&part,&bytes).map_err(|e|e.to_string())?;std::fs::rename(&part,&file).map_err(|e|e.to_string())?;
 }
 let out=summary(&update);*u.ready.lock().map_err(|e|e.to_string())?=Some((update,file));Ok(out)
}

/// Runs the downloaded installer (passive, keeps app data) and exits; `restart` reopens the app afterwards. On failure
/// nothing is lost: the app keeps running and the installer stays ready for another try.
#[tauri::command]
pub async fn update_install(app:AppHandle,restart:bool,u:State<'_,Updates>)->Result<()>{
 let (update,file)=u.ready.lock().map_err(|e|e.to_string())?.clone().ok_or("NO_UPDATE")?;
 // A kept installer that is gone (quarantined, cleaned up) is forgotten, so the next check downloads it again.
 let bytes=std::fs::read(&file).map_err(|e|{if let Ok(mut r)=u.ready.lock(){*r=None;}e.to_string()})?;
 let marker=dir(&app)?.join("installing");std::fs::write(&marker,&update.version).map_err(|e|e.to_string())?;
 update.restart_after_install(restart).install(bytes).map_err(|e|{let _=std::fs::remove_file(&marker);e.to_string()})
}

/// The version the last install was meant to bring, once: the installer runs after the app exits, so only the next start can tell.
/// When that install took, its kept installer goes too.
#[tauri::command]
pub fn update_last_install(app:AppHandle)->Result<Option<String>>{let dir=dir(&app)?;let v=std::fs::read_to_string(dir.join("installing")).ok();let _=std::fs::remove_file(dir.join("installing"));if v.as_deref()==Some(app.package_info().version.to_string().as_str()){let _=std::fs::remove_dir_all(&dir);}Ok(v)}
