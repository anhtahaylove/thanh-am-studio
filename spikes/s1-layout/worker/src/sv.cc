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
