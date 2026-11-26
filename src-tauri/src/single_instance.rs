//! A second launch checks the running instance before tauri-plugin-single-instance forwards to it.
//! The plugin (2.5.5, windows.rs) finds the first instance by its mutex `{id}-sim` and its hidden window `{id}-sic`/`{id}-siw`,
//! then waits up to 10 s in `SendMessageTimeoutW(SMTO_NORMAL)` and exits silently, also when the window never appears (1 s).
//! This probe uses the same names, so a hung or half-gone first instance gets a message box instead of nothing.
use windows_sys::Win32::{
 Foundation::{CloseHandle,HWND},
 System::Threading::{OpenMutexW,SYNCHRONIZATION_SYNCHRONIZE},
 UI::WindowsAndMessaging::{FindWindowW,SendMessageTimeoutW,SMTO_ABORTIFHUNG,WM_NULL},
};

#[derive(Debug,PartialEq,Eq)]
pub enum Running {
 /// No mutex: this is the first instance.
 No,
 /// The window took the message in time: the plugin forwards the launch as before.
 Answering,
 /// The mutex is held but the window is gone or did not answer in time.
 Unresponsive,
}

const MESSAGE:&str="Thanh Âm Studio đang chạy nhưng không phản hồi. Hãy đợi một chút rồi mở lại, hoặc đóng nó trong Task Manager.";

fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain([0]).collect()}

/// The first instance publishes its mutex before it creates the window, so the window gets the plugin's 40 x 25 ms to appear.
pub fn probe(id:&str,timeout_ms:u32)->Running{unsafe{
 let mutex=OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE,0,wide(&format!("{id}-sim")).as_ptr());
 if mutex.is_null(){return Running::No}
 CloseHandle(mutex);
 let (class,name)=(wide(&format!("{id}-sic")),wide(&format!("{id}-siw")));
 let mut hwnd:HWND=std::ptr::null_mut();
 for _ in 0..40{hwnd=FindWindowW(class.as_ptr(),name.as_ptr());if !hwnd.is_null(){break}std::thread::sleep(std::time::Duration::from_millis(25));}
 if hwnd.is_null(){return Running::Unresponsive}
 // ABORTIFHUNG returns at once for a thread that has not pumped messages for about 5 s.
 if SendMessageTimeoutW(hwnd,WM_NULL,0,0,SMTO_ABORTIFHUNG,timeout_ms,std::ptr::null_mut())==0{Running::Unresponsive}else{Running::Answering}
}}

/// Before the plugin's init: shows the box and exits when the running instance does not answer within 2 s.
/// shortcut: a first instance that is still starting and has not pumped messages for 2 s also gets the box, when the second launch is that early.
pub fn exit_if_unresponsive(id:&str){if probe(id,2000)==Running::Unresponsive{crate::message_box(MESSAGE);std::process::exit(0)}}
