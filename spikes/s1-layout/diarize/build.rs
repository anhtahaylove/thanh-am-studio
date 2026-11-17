//! Links the import library generated from the wheel's `sherpa-onnx-c-api.dll` exports (recipe/05-sherpa-implib.ps1).
//! `S1_SHERPA_LIB` is the directory holding `sherpa-onnx-c-api.lib`.
fn main() {
    println!("cargo:rerun-if-env-changed=S1_SHERPA_LIB");
    let dir = std::env::var("S1_SHERPA_LIB").expect("S1_SHERPA_LIB: directory with sherpa-onnx-c-api.lib");
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
}
