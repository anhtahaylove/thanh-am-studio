// Reads a ctranslate2::StorageView out of ct2rs-sys (which only exposes shape and a Debug string).
#include <cstddef>
#include <ctranslate2/storage_view.h>

extern "C" std::size_t thanham_sv_copy_f32(const void* sv, float* dst, std::size_t cap) {
  const auto* s = static_cast<const ctranslate2::StorageView*>(sv);
  if (s->dtype() == ctranslate2::DataType::FLOAT32) {
    const std::size_t n = static_cast<std::size_t>(s->size());
    if (dst && n <= cap) { const float* p = s->data<float>(); for (std::size_t i = 0; i < n; ++i) dst[i] = p[i]; }
    return n;
  }
  const ctranslate2::StorageView f = s->to_float32();
  const std::size_t n = static_cast<std::size_t>(f.size());
  if (dst && n <= cap) { const float* p = f.data<float>(); for (std::size_t i = 0; i < n; ++i) dst[i] = p[i]; }
  return n;
}

// CTranslate2 caches `mayiuse_mkl()` (= "CT2_USE_MKL" env, else "CPU is GenuineIntel") the first time anything asks. In this static
// executable something asks during C++ static initialization, before cpu_features' `info` is filled, so the cached answer is false and
// CT2 silently runs on oneDNN instead of MKL (S1 finding: the encoder then differs from the wheel; with MKL it is bitwise equal).
// A CRT initializer in .CRT$XCT runs before every .CRT$XCU (C++ dynamic initializer) and makes the choice first, with the wheel's
// own rule (GenuineIntel only; AMD keeps the oneDNN path). An explicit user setting of CT2_USE_MKL is left alone.
#include <intrin.h>
#include <stdlib.h>
#include <string.h>
#pragma section(".CRT$XCT", read)
extern "C" void __cdecl thanham_early_ct2_env() {
  int r[4];
  __cpuid(r, 0);
  char vendor[13];
  memcpy(vendor, &r[1], 4); memcpy(vendor + 4, &r[3], 4); memcpy(vendor + 8, &r[2], 4); vendor[12] = 0;
  if (strcmp(vendor, "GenuineIntel") != 0) return;
  char* v = nullptr; size_t n = 0;
  if (_dupenv_s(&v, &n, "CT2_USE_MKL") != 0 || v == nullptr) _putenv_s("CT2_USE_MKL", "1");
  free(v);
}
extern "C" __declspec(allocate(".CRT$XCT")) void (__cdecl* thanham_early_ct2_env_p)() = thanham_early_ct2_env;
#pragma comment(linker, "/include:thanham_early_ct2_env_p")
