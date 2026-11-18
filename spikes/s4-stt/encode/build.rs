//! Link glue for the matched CTranslate2 engine (plan §3 steps 6-8).
//! The recipe's lib directory comes from `S1_LIB` (ct2rs-sys additionally reads `LIBRARY_PATH`), the CT2 headers from `S1_CT2_INCLUDE`.
use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=S1_LIB");
    println!("cargo:rerun-if-env-changed=S1_CT2_INCLUDE");
    println!("cargo:rerun-if-changed=src/sv.cc");
    let lib = env::var("S1_LIB").expect("S1_LIB: the recipe's lib directory");
    println!("cargo:rustc-link-search=native={lib}");
    // Step 6: oneDNN 3.1.1 from the recipe. ct2rs-sys's own `dnnl` feature would build a 2026 oneDNN (F37) and is not used.
    println!("cargo:rustc-link-lib=static=dnnl");
    // Step 8: CT2 adds this only to its own EXE/DLL links (F43); we link a static library, and /openmp objects
    // (oneDNN, CT2) carry /DEFAULTLIB:vcomp. The OpenMP ABI must come from the shim's libiomp5md.dll instead.
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:vcomp");
    // Keep the linker's library-search trace so the evidence shows which libiomp5md.lib / iomp5.lib was used.
    if env::var("S1_VERBOSE_LIB").is_ok() {
        println!("cargo:rustc-link-arg=/VERBOSE:LIB");
    }
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .flag_if_supported("/EHsc")
        .include(env::var("S1_CT2_INCLUDE").expect("S1_CT2_INCLUDE: CT2 headers"))
        .file("src/sv.cc")
        .compile("thanham_sv");
}
