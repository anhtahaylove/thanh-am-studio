//! S4 T1e: Whisper `encode` on the S1 matched CTranslate2 engine, fed with recorded encoder inputs.
//!
//! usage: s4-encode <whisper dir> <threads> <list.tsv>
//!   list.tsv lines: `<features file>\t<byte offset>\t<out file>` (features: float32 [1, n_mels, 3000] at that offset).
//! Prints one JSON line with the engine facts, then one per entry with the output's SHA-256; exit 0 only if every entry was written.

use std::ffi::{c_char, c_int, c_void};
use std::fmt::Write as _;
use std::io::{Read, Seek, SeekFrom};
use std::process::ExitCode;
use std::time::Instant;

use ct2rs_sys::{ComputeType, Config, Device, StorageView, Whisper};
use sha2::{Digest, Sha256};

// Forces the linker to keep the MKL libraries (ct2rs-sys references this crate the same way).
extern crate intel_onemkl_prebuild;

extern "C" {
    fn thanham_sv_copy_f32(sv: *const c_void, dst: *mut f32, cap: usize) -> usize;
    fn MKL_Get_Version_String(buffer: *mut c_char, len: c_int);
}

extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn SetProcessAffinityMask(process: *mut c_void, mask: usize) -> i32;
    fn GetProcessAffinityMask(process: *mut c_void, process_mask: *mut usize, system_mask: *mut usize) -> i32;
    fn SetProcessInformation(process: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32;
}

/// Opts this process out of power throttling (EcoQoS, S4 finding F-S4-3) and returns its affinity mask at model load (F-S4-1:
/// the core type at load decides the numbers; runs are pinned with `start /affinity`).
fn no_ecoqos_and_mask() -> usize {
    // PROCESS_POWER_THROTTLING_STATE { Version 1, ControlMask EXECUTION_SPEED, StateMask 0 }; class 4 = ProcessPowerThrottling.
    let state: [u32; 3] = [1, 1, 0];
    let (mut mask, mut system) = (0usize, 0usize);
    // SAFETY: plain Win32 calls on the current process pseudo-handle with correctly sized buffers.
    unsafe {
        SetProcessInformation(GetCurrentProcess(), 4, state.as_ptr().cast(), 12);
        GetProcessAffinityMask(GetCurrentProcess(), &mut mask, &mut system);
    }
    mask
}

fn mkl_version() -> String {
    let mut buf = vec![0 as c_char; 512];
    // SAFETY: `buf` is 512 writable bytes and MKL writes a NUL-terminated string of at most `len` bytes.
    unsafe { MKL_Get_Version_String(buf.as_mut_ptr(), buf.len() as c_int) };
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn run(args: &[String]) -> Result<(), String> {
    let [dir, threads, list] = args else { return Err("usage: s4-encode <whisper dir> <threads> <list.tsv>".into()) };
    let threads: usize = threads.parse().map_err(|e| format!("threads: {e}"))?;
    let config = Config { device: Device::CPU, compute_type: ComputeType::INT8, num_threads_per_replica: threads, ..Config::default() };
    let load_mask = no_ecoqos_and_mask();
    let t0 = Instant::now();
    let whisper = Whisper::new(dir, config).map_err(|e| format!("load: {e}"))?;
    let n_mels = whisper.n_mels();
    // Probe (S4 hybrid-CPU finding): S4_AFFINITY_AFTER_LOAD=<hex mask> moves the process to those logical CPUs after the load.
    if let Some(mask) = std::env::var("S4_AFFINITY_AFTER_LOAD").ok().and_then(|v| usize::from_str_radix(&v, 16).ok()) {
        // SAFETY: plain Win32 calls on the current process handle (a pseudo-handle that needs no closing).
        if unsafe { SetProcessAffinityMask(GetCurrentProcess(), mask) } == 0 {
            return Err("SetProcessAffinityMask failed".into());
        }
    }
    println!(
        "{{\"mkl\":{:?},\"n_mels\":{n_mels},\"threads\":{threads},\"load_ms\":{},\"load_affinity\":\"{load_mask:04X}\"}}",
        mkl_version(),
        t0.elapsed().as_millis()
    );
    let entries = std::fs::read_to_string(list).map_err(|e| format!("{list}: {e}"))?;
    for line in entries.lines().filter(|l| !l.trim().is_empty()) {
        let parts: Vec<&str> = line.split('\t').collect();
        let [feat, off, out] = parts[..] else { return Err(format!("bad list line: {line}")) };
        let n = n_mels * 3000;
        let mut raw = vec![0u8; n * 4];
        let mut f = std::fs::File::open(feat).map_err(|e| format!("{feat}: {e}"))?;
        f.seek(SeekFrom::Start(off.parse().map_err(|e| format!("offset: {e}"))?)).map_err(|e| e.to_string())?;
        f.read_exact(&mut raw).map_err(|e| format!("{feat}: {e}"))?;
        // CT2 wraps this buffer without copying. Probe (S4 finding): S4_ALIGN_OFFSET=<bytes> places it at that offset from a
        // 64-byte boundary; unset keeps the allocator's address.
        let values: Vec<f32> = raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let mut backing = vec![0f32; n + 32];
        let start = match std::env::var("S4_ALIGN_OFFSET").ok().and_then(|v| v.parse::<usize>().ok()) {
            Some(off) => ((64 - backing.as_ptr() as usize % 64) % 64 + off) / 4,
            None => 0,
        };
        let feats = &mut backing[start..start + n];
        feats.copy_from_slice(&values);
        let addr = feats.as_ptr() as usize;
        let sv = StorageView::new(&[1, n_mels, 3000], feats, Device::CPU).map_err(|e| format!("features: {e}"))?;
        let t1 = Instant::now();
        let enc = whisper.encode(&sv, false).map_err(|e| format!("encode: {e}"))?;
        let ms = t1.elapsed().as_millis();
        let ptr = &*enc as *const _ as *const c_void;
        // SAFETY: `ptr` is the live ctranslate2::StorageView owned by `enc`; a null destination only asks for the element count.
        let count = unsafe { thanham_sv_copy_f32(ptr, std::ptr::null_mut(), 0) };
        let mut data = vec![0f32; count];
        // SAFETY: `data` holds exactly `count` writable floats.
        if unsafe { thanham_sv_copy_f32(ptr, data.as_mut_ptr(), data.len()) } != count {
            return Err("encoder output copy failed".into());
        }
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(out, &bytes).map_err(|e| format!("{out}: {e}"))?;
        println!("{{\"out\":{out:?},\"elements\":{count},\"encode_ms\":{ms},\"input_addr_mod64\":{},\"sha256\":\"{}\"}}", addr % 64, hex(&bytes));
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            println!("{{\"error\":{e:?}}}");
            ExitCode::from(1)
        }
    }
}
