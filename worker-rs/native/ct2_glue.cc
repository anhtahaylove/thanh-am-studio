// C++ glue for the statically linked CTranslate2 engine (feature `ct2`, worker-rs/engine/build-engine.ps1).
#include <intrin.h>
#include <stdlib.h>
#include <string.h>

#include <cstddef>
#include <string>

#include <ctranslate2/storage_view.h>
#include <ctranslate2/types.h>

namespace ctranslate2 {
  namespace cpu {
    // As declared in CTranslate2 4.8.5 src/cpu/backend.h, which the install does not ship.
    enum class GemmBackend { NONE, MKL, DNNL, ACCELERATE, OPENBLAS, RUY };
    std::string gemm_backend_to_str(GemmBackend gemm_backend);
    GemmBackend get_gemm_backend(ComputeType compute_type);
  }
}

// The GEMM backend CTranslate2 uses for int8 (the worker's compute type), as `health` reports it: "MKL" or "DNNL".
extern "C" std::size_t thanham_ct2_gemm_int8(char* dst, std::size_t cap) {
  const std::string name = ctranslate2::cpu::gemm_backend_to_str(ctranslate2::cpu::get_gemm_backend(ctranslate2::ComputeType::INT8));
  if (dst && cap > name.size()) memcpy(dst, name.c_str(), name.size() + 1);
  return name.size();
}

// Copies a ctranslate2::StorageView (ct2rs-sys exposes only its shape) to float32.
extern "C" std::size_t thanham_sv_copy_f32(const void* sv, float* dst, std::size_t cap) {
  const auto* s = static_cast<const ctranslate2::StorageView*>(sv);
  const ctranslate2::StorageView f = s->dtype() == ctranslate2::DataType::FLOAT32 ? *s : s->to_float32();
  const std::size_t n = static_cast<std::size_t>(f.size());
  if (dst && n <= cap) memcpy(dst, f.data<float>(), n * sizeof(float));
  return n;
}

// CTranslate2 caches `mayiuse_mkl()` ("CT2_USE_MKL", else "the CPU is GenuineIntel") the first time anything asks. In this static
// executable something asks during C++ static initialization, before cpu_features has filled its CPU info, so the cached answer
// is false and CT2 silently runs on oneDNN instead of MKL (spike S1: the encoder then differs from the wheel's; with MKL it is
// bitwise equal). A CRT initializer in .CRT$XCT runs before every .CRT$XCU (C++ dynamic initializer) and makes the choice first,
// with the wheel's own rule: GenuineIntel only, so other CPUs keep the oneDNN path as with the wheel. A user's own CT2_USE_MKL
// is left alone.
#pragma section(".CRT$XCT", read)
extern "C" void __cdecl thanham_early_ct2_env() {
  int r[4];
  __cpuid(r, 0);
  char vendor[13];
  memcpy(vendor, &r[1], 4);
  memcpy(vendor + 4, &r[3], 4);
  memcpy(vendor + 8, &r[2], 4);
  vendor[12] = 0;
  if (strcmp(vendor, "GenuineIntel") != 0) return;
  char* v = nullptr;
  size_t n = 0;
  if (_dupenv_s(&v, &n, "CT2_USE_MKL") != 0 || v == nullptr) _putenv_s("CT2_USE_MKL", "1");
  free(v);
}
extern "C" __declspec(allocate(".CRT$XCT")) void(__cdecl* thanham_early_ct2_env_p)() = thanham_early_ct2_env;
#pragma comment(linker, "/include:thanham_early_ct2_env_p")
