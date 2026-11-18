//! Worker engines: which operations run on the native worker, when a failure falls back to Python, and the two JSONL logs.
use serde_json::{json,Value};
use std::{fs,io::Write,path::Path};

/// Operations routed to `thanham-worker.exe`. An operation of an unreleased bundle is absent, so main stays releasable;
/// `worker_engines` in the settings can still send a listed operation back to Python.
pub const RUST_OPS:&[&str]=&[];
/// The operations a job can run, and so the keys `worker_engines` accepts.
pub const OPS:&[&str]=&["tts","stt","render","download","clone_preview","separate"];
/// Exit codes before any `result` or `error` that mean the native worker itself broke: DLL not found, access violation,
/// illegal instruction, stack buffer overrun, stack overflow, and a Rust panic abort.
const FALLBACK_EXITS:[u32;6]=[0xC0000135,0xC0000005,0xC000001D,0xC0000409,0xC00000FD,101];
const FALLBACKS:&str="worker-fallbacks.jsonl";
const CHANGES:&str="worker-engine-changes.jsonl";

#[derive(Clone,Copy,PartialEq,Eq,Debug)]
pub enum Engine{Python,Rust}
impl Engine{pub fn name(self)->&'static str{match self{Engine::Python=>"python",Engine::Rust=>"rust"}}}

/// Error codes of the native worker that mean "its engine failed", not "your input is wrong".
pub fn eligible_code(code:&str)->bool{matches!(code,"RUST_PANIC"|"WORKER_ERROR"|"RUNTIME_MISSING")}
pub fn eligible_exit(code:Option<i32>)->bool{code.is_some_and(|c|FALLBACK_EXITS.contains(&(c as u32)))}

fn cpu()->String{
 let brand=std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default();
 #[cfg(target_arch="x86_64")] let isa=format!("avx={} avx2={} avx512f={}",is_x86_feature_detected!("avx"),is_x86_feature_detected!("avx2"),is_x86_feature_detected!("avx512f"));
 #[cfg(not(target_arch="x86_64"))] let isa=String::new();
 format!("{brand}; {isa}")
}
fn append(root:&Path,file:&str,line:Value){if let Ok(mut f)=fs::OpenOptions::new().create(true).append(true).open(root.join(file)){let _=writeln!(f,"{line}");}}
fn stamp(mut v:Value)->Value{v["time"]=json!(chrono::Utc::now().to_rfc3339());v["version"]=json!(env!("CARGO_PKG_VERSION"));v}

/// One line per eligible event: `action` is `rerun` (the operation or its remaining items ran again on Python) or
/// `exit_after_result` (the worker crashed after its result, which stays final).
pub fn log_fallback(root:&Path,op:&str,code:&str,exit:Option<i32>,action:&str,cloned:bool){
 append(root,FALLBACKS,stamp(json!({"operation":op,"code":code,"exit":exit,"action":action,"cpu":cpu(),"cloned":cloned})));
}
pub fn log_change(root:&Path,op:&str,from:&str,to:&str){append(root,CHANGES,stamp(json!({"operation":op,"from":from,"to":to})));}
pub fn fallback_count(root:&Path)->usize{
 fs::read_to_string(root.join(FALLBACKS)).map_or(0,|t|t.lines().filter_map(|l|serde_json::from_str::<Value>(l).ok()).filter(|v|v["action"]=="rerun").count())
}
/// The text of `export_diagnostics`: settings and both logs, for a bug report.
pub fn diagnostics(root:&Path,settings:&Value)->String{
 let log=|f:&str|fs::read_to_string(root.join(f)).ok().filter(|t|!t.trim().is_empty()).unwrap_or_else(||"(empty)\n".into());
 format!("Thanh Âm Studio {} diagnostics, {}\ncpu: {}\n\n== settings ==\n{}\n\n== {FALLBACKS} ==\n{}\n== {CHANGES} ==\n{}",
  env!("CARGO_PKG_VERSION"),chrono::Utc::now().to_rfc3339(),cpu(),serde_json::to_string_pretty(settings).unwrap_or_default(),log(FALLBACKS),log(CHANGES))
}
