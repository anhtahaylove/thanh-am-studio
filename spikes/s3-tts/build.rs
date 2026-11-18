// Compiles numpy 2.4.6's own x86-simd-sort (the `numpy/_core/src/npysort/x86-simd-sort` submodule shipped in the sdist) as numpy builds
// `x86_simd_argsort.dispatch.cpp` for its `X86_V3` target (/arch:AVX2) and exposes float32 `argsort` / `argselect` through extern "C" shims.
// Nothing is downloaded at build time; the sources come from `S3_THIRD_PARTY` (default: work/rm/s3-tts/third_party).
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(std::env::var("S3_THIRD_PARTY").unwrap_or_else(|_| {
        r"C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\s3-tts\third_party".to_string()
    }));
    let npysort =
        root.join("numpy-sdist").join("src").join("numpy-2.4.6").join("numpy").join("_core").join("src").join("npysort");
    println!("cargo:rerun-if-env-changed=S3_THIRD_PARTY");
    println!("cargo:rerun-if-changed=native/xss_v3.cpp");
    cc::Build::new().cpp(true).std("c++17").opt_level(2).include(&npysort).flag("/arch:AVX2").file("native/xss_v3.cpp").compile("xss_v3");
}
