use thanh_am_studio::update::remove_installer_copies;

fn temp(tag:&str)->std::path::PathBuf{let t=std::env::temp_dir().join(format!("thanh-am cleanup {tag} {}",std::process::id()));let _=std::fs::remove_dir_all(&t);std::fs::create_dir_all(&t).unwrap();t}

#[test]
fn removes_only_this_apps_updater_copies(){
 let t=temp("only");
 let copy=t.join("Thanh Âm Studio-1.0.12-updater-AbC123");std::fs::create_dir_all(&copy).unwrap();std::fs::write(copy.join("Thanh Âm Studio-1.0.12-installer.exe"),b"x").unwrap();
 let other_app=t.join("Other App-1.0.12-updater-AbC123");std::fs::create_dir_all(&other_app).unwrap();
 let unrelated=t.join("Thanh Âm Studio e2e");std::fs::create_dir_all(&unrelated).unwrap();
 let file=t.join("Thanh Âm Studio-1.0.12-updater-note");std::fs::write(&file,b"x").unwrap();
 assert_eq!(remove_installer_copies(&t,"Thanh Âm Studio"),0);
 assert!(!copy.exists());assert!(other_app.exists()&&unrelated.exists()&&file.exists());
 std::fs::remove_dir_all(&t).unwrap();
}

#[cfg(windows)]
#[test]
fn a_copy_in_use_is_left_and_counted_until_it_is_released(){
 use std::os::windows::fs::OpenOptionsExt;
 let t=temp("busy");let copy=t.join("Thanh Âm Studio-1.0.12-updater-XyZ789");std::fs::create_dir_all(&copy).unwrap();
 let exe=copy.join("Thanh Âm Studio-1.0.12-installer.exe");std::fs::write(&exe,b"x").unwrap();
 let held=std::fs::OpenOptions::new().read(true).share_mode(0).open(&exe).unwrap(); // like a running installer
 assert_eq!(remove_installer_copies(&t,"Thanh Âm Studio"),1);assert!(exe.exists());
 drop(held);
 assert_eq!(remove_installer_copies(&t,"Thanh Âm Studio"),0);assert!(!copy.exists());
 std::fs::remove_dir_all(&t).unwrap();
}
