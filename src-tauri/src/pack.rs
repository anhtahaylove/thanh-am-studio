//! The separation runtime pack: Python + PyTorch + Demucs, downloaded into `models/separation-runtime/` instead of
//! shipping in the installer. `MANIFEST.sha256` lists every file as `<sha256>  <size>  <path>`; the worker hashes the
//! tree when it installs or re-verifies the pack, and every separation job checks that each listed file exists with its size.
use crate::store::Result;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,path::{Path,PathBuf}};

pub const PACK_ID:&str="separation-runtime";
pub const NOT_READY:&str="MODEL_NOT_READY: Chưa có gói chạy tách nhạc nền. Kết nối mạng rồi bấm Tải.";
const MANIFEST:&str="MANIFEST.sha256";

pub fn dir(root:&Path)->PathBuf{root.join("models").join(PACK_ID)}
/// The revision `models.json` pins for the pack, from the file next to the worker.
pub fn pinned_revision(models_json:&Path)->Option<String>{let v:Value=serde_json::from_str(&fs::read_to_string(models_json).ok()?).ok()?;v["models"].as_array()?.iter().find(|m|m["id"]==PACK_ID)?["revision"].as_str().map(str::to_string)}
fn record(root:&Path)->Option<Value>{serde_json::from_str(&fs::read_to_string(dir(root).join("installed.json")).ok()?).ok()}
/// The marker names the pinned revision: a pack of an older revision counts as not installed.
pub fn installed(root:&Path,models_json:&Path)->bool{let (Some(r),Some(rev))=(record(root),pinned_revision(models_json)) else {return false};r["model_id"]==PACK_ID&&r["revision"]==rev.as_str()}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn damaged(detail:&str)->String{format!("MODEL_CHECKSUM: Gói chạy tách nhạc nền thiếu tệp hoặc bị cắt ngắn ({detail}). Bấm Tải trong Model & cài đặt để cài lại gói.")}
/// The pack's `python.exe` when the pack is installed at the pinned revision, its manifest is the pinned one and every
/// manifest file exists with its size. Hashing the tree is the worker's job ("Kiểm tra lại gói"): it takes minutes.
pub fn ready_python(root:&Path,models_json:&Path)->Result<PathBuf>{
 if !installed(root,models_json){return Err(NOT_READY.into())}
 let d=dir(root);let marker=record(root).ok_or(NOT_READY)?;
 let manifest=fs::read(d.join(MANIFEST)).map_err(|_|damaged(MANIFEST))?;
 if marker["manifest_sha256"].as_str()!=Some(hex(&Sha256::digest(&manifest)).as_str()){return Err(damaged(MANIFEST))}
 for line in String::from_utf8_lossy(&manifest).lines(){
  let mut f=line.splitn(3,"  ");let (Some(_),Some(size),Some(rel))=(f.next(),f.next(),f.next()) else {return Err(damaged(MANIFEST))};
  if rel.split('/').any(|p|p.is_empty()||p==".."){return Err(damaged(rel))}
  match fs::metadata(d.join(rel)){Ok(m)if m.is_file()&&Some(m.len())==size.parse::<u64>().ok()=>{},_=>return Err(damaged(rel))}
 }
 let python=d.join("python.exe");if !python.is_file(){return Err(damaged("python.exe"))}Ok(python)
}
/// The `model_download` payload. Installing the pack needs the user's consent to the oneMKL licence; re-verifying an
/// installed pack does not.
pub fn download_payload(root:&Path,models_json:&Path,id:&str,license_accepted:bool)->Result<Value>{
 if id!=PACK_ID||installed(root,models_json){return Ok(json!({"model_id":id}))}
 if !license_accepted{return Err("LICENSE_NOT_ACCEPTED: Cần đồng ý giấy phép Intel oneMKL trước khi tải gói tách nhạc nền.".into())}
 Ok(json!({"model_id":id,"license_accepted_at":chrono::Utc::now().to_rfc3339()}))
}
