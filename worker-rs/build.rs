// Compiles numpy 2.4.6's own x86-simd-sort (vendored unmodified in third_party/x86-simd-sort, see its PROVENANCE.txt) as numpy builds
// `x86_simd_argsort.dispatch.cpp` for its `X86_V3` target (/arch:AVX2), behind the C ABI of native/xss_v3.cpp. The TTS head's
// argpartition and argsort use it on x86-64-v3 and v4 CPUs (numpy's wheel sorts as AVX2 on both; tts/sort.rs).
fn main() {
    println!("cargo:rerun-if-changed=native/xss_v3.cpp");
    println!("cargo:rerun-if-changed=third_party/x86-simd-sort/src");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .include("third_party")
        .flag("/arch:AVX2")
        .file("native/xss_v3.cpp")
        .compile("xss_v3");
}
