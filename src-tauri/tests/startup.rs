//! Its own binary: a panic hook is global to the process.
use std::sync::Mutex;
use thanh_am_studio::{startup_hook,store::Store};
static SHOWN:Mutex<Vec<String>>=Mutex::new(Vec::new());

#[test]
fn a_failed_store_open_is_logged_and_shown(){
 let dir=tempfile::tempdir().unwrap();let root=dir.path().join("data");std::fs::create_dir_all(root.join("studio.sqlite3")).unwrap();
 let e=Store::open(&root).err().expect("a directory is not a database");
 let blocked=dir.path().join("blocked");std::fs::write(&blocked,b"").unwrap();
 // Two failed starts append to one log; the last log directory sits under a file, so it cannot be written.
 for logs in [dir.path().join("logs"),dir.path().join("logs"),blocked.join("logs")]{
  std::panic::set_hook(startup_hook(logs,|m|SHOWN.lock().unwrap().push(m.into())));
  // What Tauri 2.12 does with an error from the setup closure.
  assert!(std::panic::catch_unwind(||panic!("Failed to setup app: error encountered during setup hook: {e}")).is_err());
  drop(std::panic::take_hook());
 }
 // A panic on another thread is logged but shows nothing.
 std::panic::set_hook(startup_hook(dir.path().join("logs"),|m|SHOWN.lock().unwrap().push(m.into())));
 assert!(std::thread::spawn(||panic!("job thread")).join().is_err());
 drop(std::panic::take_hook());
 let log_path=dir.path().join("logs").join("startup-errors.log");let log=std::fs::read_to_string(&log_path).unwrap();
 let lines:Vec<&str>=log.lines().collect();assert_eq!(lines.len(),3,"{log}");
 for (n,line) in lines.iter().enumerate(){let (stamp,rest)=line.split_once(' ').unwrap();assert!(chrono::DateTime::parse_from_rfc3339(stamp).is_ok(),"{stamp}");
  let msg=if n<2{format!("Failed to setup app: error encountered during setup hook: {e}")}else{"job thread".into()};
  assert!(rest.starts_with(env!("CARGO_PKG_VERSION"))&&rest.contains("startup.rs")&&rest.ends_with(&msg),"{rest}");}
 let shown=SHOWN.lock().unwrap();
 assert_eq!(shown[0],format!("Thanh Âm Studio không khởi động được: {e}.\n\nChi tiết đã ghi vào {}.",log_path.display()));
 assert_eq!(shown[1],shown[0]);
 assert!(shown[2].starts_with(&format!("Thanh Âm Studio không khởi động được: {e}.\n\nKhông ghi được nhật ký vào {}",blocked.join("logs").join("startup-errors.log").display())),"{}",shown[2]);
 assert_eq!(shown.len(),3);
}
