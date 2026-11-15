use thanh_am_studio::reveal_command;

#[test]
fn reveal_selects_a_file_whose_path_has_spaces_and_diacritics(){
 let dir=std::env::temp_dir().join(format!("thanh-am reveal {}",std::process::id()));std::fs::create_dir_all(&dir).unwrap();
 let file=dir.join("Bản ghi 1.wav");std::fs::write(&file,b"x").unwrap();
 let args:Vec<String>=reveal_command(&file).get_args().map(|a|a.to_string_lossy().into_owned()).collect();
 assert_eq!(args,vec![format!("/select,\"{}\"",file.display())]);
 std::fs::remove_dir_all(&dir).unwrap();
}
