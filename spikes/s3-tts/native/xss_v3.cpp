// numpy 2.4.6 `x86_simd_argsort.dispatch.cpp` for the X86_V3 target (AVX2), float32 only, behind a C ABI.
#include <cstddef>
#include <cstdint>
#include "x86-simd-sort/src/x86simdsort-static-incl.h"

extern "C" {
// arg must hold 0..n-1 on entry (numpy's `tosort`); hasnan = true as numpy passes it.
void xss_v3_argsort_f32(float *arr, int64_t *arg, int64_t n)
{
    x86simdsortStatic::argsort(arr, reinterpret_cast<size_t *>(arg), static_cast<size_t>(n), true);
}
void xss_v3_argselect_f32(float *arr, int64_t *arg, int64_t kth, int64_t n)
{
    x86simdsortStatic::argselect(arr, reinterpret_cast<size_t *>(arg), static_cast<size_t>(kth), static_cast<size_t>(n), true);
}
}
