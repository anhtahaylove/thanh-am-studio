// Builds kaldi-native-fbank 1.23.0 (Apache-2.0) and its pinned kissfft (BSD-3-Clause) from the source trees prepared under
// `S5_THIRD_PARTY` (default: work/rm/s5-clone/third_party). The archives are pinned by SHA-256 in THIRD_PARTY.md; nothing is
// downloaded at build time.
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(std::env::var("S5_THIRD_PARTY").unwrap_or_else(|_| {
        r"C:\Users\User\Documents\Codex\2026-11-10\c-program-files-j2team-tts-j2team-2\work\rm\s5-clone\third_party"
            .to_string()
    }));
    let knf = root.join("knf").join("kaldi-native-fbank-018d7bc92c3d4ac1a44c8c0e5c7d5c8e489ca509");
    let kiss = root.join("kissfft").join("kissfft-febd4caeed32e33ad8b2e0bb5ea77542c40f18ec");
    println!("cargo:rerun-if-env-changed=S5_THIRD_PARTY");
    println!("cargo:rerun-if-changed=native/knf_shim.cc");

    let mut c = cc::Build::new();
    c.file(kiss.join("kiss_fft.c")).file(kiss.join("kiss_fftr.c")).include(&kiss).opt_level(2);
    c.compile("kissfft");

    let csrc = knf.join("kaldi-native-fbank").join("csrc");
    let mut cpp = cc::Build::new();
    cpp.cpp(true).std("c++17").opt_level(2).include(&knf).include(&kiss).define("NOMINMAX", None);
    for f in [
        "feature-fbank.cc",
        "feature-mfcc.cc",
        "feature-raw-audio-samples.cc",
        "whisper-feature.cc",
        "feature-functions.cc",
        "feature-window.cc",
        "mel-computations.cc",
        "online-feature.cc",
        "rfft.cc",
        "kaldi-math.cc",
    ] {
        cpp.file(csrc.join(f));
    }
    cpp.file("native/knf_shim.cc");
    cpp.compile("knf_fbank");
}
