// Compiles numpy 2.4.6's own x86-simd-sort (the `numpy/_core/src/npysort/x86-simd-sort` submodule shipped in the sdist, pinned by SHA-256 in
// THIRD_PARTY.md) exactly as numpy builds `x86_simd_argsort.dispatch.cpp`: once with /arch:AVX2 (numpy's `X86_V3` target) and once with
// /arch:AVX512 (`X86_V4`), and exposes `argsort` / `argselect` for float32 through two extern "C" shims per target. Nothing is downloaded
// at build time; the sources come from `S3_THIRD_PARTY` (default: work/rm/s3-tts/third_party).
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(std::env::var("S3_THIRD_PARTY").unwrap_or_else(|_| {
        r"C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\s3-tts\third_party".to_string()
    }));
    let npysort =
        root.join("numpy-sdist").join("src").join("numpy-2.4.6").join("numpy").join("_core").join("src").join("npysort");
    println!("cargo:rerun-if-env-changed=S3_THIRD_PARTY");
    println!("cargo:rerun-if-changed=native/xss_v3.cpp");
    println!("cargo:rerun-if-changed=native/xss_v4.cpp");
    for (file, arch) in [("native/xss_v3.cpp", "/arch:AVX2"), ("native/xss_v4.cpp", "/arch:AVX512")] {
        let mut b = cc::Build::new();
        b.cpp(true).std("c++17").opt_level(2).include(&npysort).flag(arch).file(file);
        b.compile(&format!("xss_{}", &file[11..13]));
    }
}
