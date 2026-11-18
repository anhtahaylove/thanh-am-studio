// Compiles numpy 2.4.6's own x86-simd-sort (vendored unmodified in third_party/x86-simd-sort, see its PROVENANCE.txt) as numpy builds
// `x86_simd_argsort.dispatch.cpp` for its `X86_V3` target (/arch:AVX2), behind the C ABI of native/xss_v3.cpp. The TTS head's
// argpartition and argsort use it on x86-64-v3 and v4 CPUs (numpy's wheel sorts as AVX2 on both; tts/sort.rs).
//
// The clone path (tts/clone.rs) adds kaldi-native-fbank 1.23.0 with its pinned kissfft, and numpy 2.4.6's pocketfft header, each
// vendored unmodified with a PROVENANCE.txt and built as spike S5 built them (C/C++17, /O2, no /arch, the dynamic C runtime).
fn main() {
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-changed=third_party");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .include("third_party")
        .flag("/arch:AVX2")
        .file("native/xss_v3.cpp")
        .compile("xss_v3");

    let kiss = "third_party/kissfft";
    cc::Build::new()
        .file(format!("{kiss}/kiss_fft.c"))
        .file(format!("{kiss}/kiss_fftr.c"))
        .include(kiss)
        .opt_level(2)
        .compile("kissfft");
    let knf = "third_party/kaldi-native-fbank";
    let mut fbank = cc::Build::new();
    fbank.cpp(true).std("c++17").opt_level(2).include(knf).include(kiss).define("NOMINMAX", None);
    for f in [
        "feature-fbank",
        "feature-mfcc",
        "feature-raw-audio-samples",
        "whisper-feature",
        "feature-functions",
        "feature-window",
        "mel-computations",
        "online-feature",
        "rfft",
        "kaldi-math",
    ] {
        fbank.file(format!("{knf}/kaldi-native-fbank/csrc/{f}.cc"));
    }
    fbank.file("native/knf_shim.cc").compile("knf_fbank");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .include("third_party/pocketfft")
        .file("native/pocketfft_shim.cc")
        .compile("pocketfft_np");
}
