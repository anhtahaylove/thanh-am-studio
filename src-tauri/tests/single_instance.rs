//! The running instance is faked in-process with the plugin's names: mutex `{id}-sim`, window class `{id}-sic`, window title `{id}-siw`.
#![cfg(windows)]
use std::{sync::mpsc,thread};
use thanh_am_studio::single_instance::{probe,Running};
use windows_sys::Win32::{
 Foundation::{CloseHandle,HWND},
 System::Threading::CreateMutexW,
 UI::WindowsAndMessaging::{CreateWindowExW,DefWindowProcW,DestroyWindow,DispatchMessageW,PeekMessageW,RegisterClassExW,MSG,PM_REMOVE,WNDCLASSEXW,WS_OVERLAPPED},
};

fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain([0]).collect()}

/// A fake first instance on its own thread. `window`: also create the window; `pump`: then run a message loop (else the thread blocks until dropped, like a hung UI thread).
struct Fake{stop:Option<mpsc::Sender<()>>,thread:Option<thread::JoinHandle<()>>}
impl Fake{
 fn start(id:&str,window:bool,pump:bool)->Fake{
  let (stop,wait)=mpsc::channel::<()>();let (ready_tx,ready)=mpsc::channel::<()>();let id=id.to_string();
  let thread=thread::spawn(move||unsafe{
   let mutex=CreateMutexW(std::ptr::null(),1,wide(&format!("{id}-sim")).as_ptr());assert!(!mutex.is_null());
   let (class,name)=(wide(&format!("{id}-sic")),wide(&format!("{id}-siw")));let mut hwnd:HWND=std::ptr::null_mut();
   if window{
    let mut c:WNDCLASSEXW=std::mem::zeroed();c.cbSize=std::mem::size_of::<WNDCLASSEXW>() as u32;c.lpfnWndProc=Some(DefWindowProcW);c.lpszClassName=class.as_ptr();
    assert!(RegisterClassExW(&c)!=0);
    hwnd=CreateWindowExW(0,class.as_ptr(),name.as_ptr(),WS_OVERLAPPED,0,0,0,0,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null());assert!(!hwnd.is_null());
   }
   ready_tx.send(()).unwrap();
   if pump{let mut m:MSG=std::mem::zeroed();while !matches!(wait.try_recv(),Err(mpsc::TryRecvError::Disconnected)){while PeekMessageW(&mut m,std::ptr::null_mut(),0,0,PM_REMOVE)!=0{DispatchMessageW(&m);}thread::sleep(std::time::Duration::from_millis(10));}}else{let _=wait.recv();}
   if !hwnd.is_null(){DestroyWindow(hwnd);}
   CloseHandle(mutex);
  });
  ready.recv().unwrap();
  Fake{stop:Some(stop),thread:Some(thread)}
 }
}
impl Drop for Fake{fn drop(&mut self){drop(self.stop.take());if let Some(t)=self.thread.take(){let _=t.join();}}}

fn id(name:&str)->String{format!("test.thanham.{}.{name}",std::process::id())}

#[test]
fn no_mutex_is_a_first_instance(){assert_eq!(probe(&id("none"),300),Running::No)}

#[test]
fn a_window_that_pumps_messages_answers(){let id=id("answers");let _first=Fake::start(&id,true,true);assert_eq!(probe(&id,300),Running::Answering)}

#[test]
fn a_window_that_does_not_pump_messages_is_unresponsive(){
 let id=id("hung");let _first=Fake::start(&id,true,false);
 let t=std::time::Instant::now();assert_eq!(probe(&id,300),Running::Unresponsive);assert!(t.elapsed()<std::time::Duration::from_secs(5),"{:?}",t.elapsed());
}

#[test]
fn a_held_mutex_without_a_window_is_unresponsive(){let id=id("nowindow");let _first=Fake::start(&id,false,false);assert_eq!(probe(&id,300),Running::Unresponsive)}

#[test]
fn a_released_mutex_is_a_first_instance_again(){let id=id("gone");drop(Fake::start(&id,true,false));assert_eq!(probe(&id,300),Running::No)}
