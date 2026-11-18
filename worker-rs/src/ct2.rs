//! The statically linked STT engine (feature `ct2`): CTranslate2 4.8.5 built to match the Python wheel's engine
//! (`engine/build-engine.ps1`), and what `health` reports about it.

use serde_json::{json, Value};
use std::ffi::{c_char, c_int};

// Keeps the MKL libraries in the link (ct2rs-sys references the crate the same way).
extern crate intel_onemkl_prebuild as _;

extern "C" {
    fn thanham_ct2_gemm_int8(dst: *mut c_char, cap: usize) -> usize;
    fn MKL_Get_Version_String(buffer: *mut c_char, len: c_int);
}

fn c_string(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// The CPU vendor string of CPUID leaf 0 (CTranslate2 takes MKL only on "GenuineIntel", as the wheel does).
fn cpu_vendor() -> String {
    let r = std::arch::x86_64::__cpuid(0);
    let bytes: Vec<u8> = [r.ebx, r.edx, r.ecx].iter().flat_map(|v| v.to_le_bytes()).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `health`'s `stt_engine`: the CPU vendor, the int8 GEMM backend CTranslate2 chose (`MKL` on GenuineIntel, else `DNNL`, as with
/// the wheel), `CT2_USE_MKL` as the process sees it, and the linked MKL build.
pub fn info() -> Value {
    let mut name = [0 as c_char; 32];
    let mut mkl = [0 as c_char; 512];
    // SAFETY: both buffers are writable for their full length; the callees write NUL-terminated strings that fit.
    unsafe {
        thanham_ct2_gemm_int8(name.as_mut_ptr(), name.len());
        MKL_Get_Version_String(mkl.as_mut_ptr(), mkl.len() as c_int);
    }
    json!({
        "ctranslate2": "4.8.5",
        "cpu_vendor": cpu_vendor(),
        "gemm_int8": c_string(&name),
        "ct2_use_mkl": std::env::var("CT2_USE_MKL").ok(),
        "mkl": c_string(&mkl),
    })
}

#[cfg(test)]
mod tests {
    use ct2rs_sys::{ComputeType, Config, Device, StorageView, Whisper};
    use std::ffi::c_void;

    extern "C" {
        fn thanham_sv_copy_f32(sv: *const c_void, dst: *mut f32, cap: usize) -> usize;
    }

    /// Deterministic encoder input `[1, n_mels, 3000]` (spike S1's): `k / 1024` for `k` in `-2048..2048`, exact in float32.
    fn features(n: usize) -> Vec<f32> {
        (0..n as u64)
            .map(|i| {
                let h = i.wrapping_mul(2_654_435_761) & 0xFFFF_FFFF;
                let k = ((h >> 12) & 0xFFF) as i32 - 2048;
                (f64::from(k) / 1024.0) as f32
            })
            .collect()
    }

    /// The engine's encoder output equals the Python wheel's bitwise on this machine: `THANHAM_CT2_MODEL` is a Whisper model
    /// folder and `THANHAM_CT2_REFERENCE` the wheel's output for the same input (`parity/ct2_encode.py`), both int8 and with the
    /// worker's thread count. Skipped when they are not set.
    #[test]
    fn encode_matches_the_wheel() {
        let (Some(model), Some(reference)) =
            (std::env::var_os("THANHAM_CT2_MODEL"), std::env::var_os("THANHAM_CT2_REFERENCE"))
        else {
            eprintln!("THANHAM_CT2_MODEL / THANHAM_CT2_REFERENCE not set: skipped");
            return;
        };
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
        let config = Config {
            device: Device::CPU,
            compute_type: ComputeType::INT8,
            num_threads_per_replica: threads,
            ..Config::default()
        };
        let whisper = Whisper::new(model.to_str().unwrap(), config).unwrap();
        let n_mels = whisper.n_mels();
        let mut feats = features(n_mels * 3000);
        let sv = StorageView::new(&[1, n_mels, 3000], &mut feats, Device::CPU).unwrap();
        let enc = whisper.encode(&sv, false).unwrap();
        let ptr = &*enc as *const _ as *const c_void;
        // SAFETY: `ptr` is the live ctranslate2::StorageView owned by `enc`; a null destination only asks for the count.
        let count = unsafe { thanham_sv_copy_f32(ptr, std::ptr::null_mut(), 0) };
        let mut out = vec![0f32; count];
        // SAFETY: `out` holds exactly `count` writable floats.
        assert_eq!(unsafe { thanham_sv_copy_f32(ptr, out.as_mut_ptr(), count) }, count);
        let got: Vec<u8> = out.iter().flat_map(|v| v.to_le_bytes()).collect();
        let want = std::fs::read(reference).unwrap();
        let differing = got.chunks(4).zip(want.chunks(4)).filter(|(a, b)| a != b).count();
        println!("encoder: {count} floats, {differing} differ from the wheel; engine {}", super::info());
        assert_eq!(got.len(), want.len());
        assert_eq!(differing, 0);
    }
}
