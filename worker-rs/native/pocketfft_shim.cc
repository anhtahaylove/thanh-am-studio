// numpy 2.4.6's real FFTs on the pocketfft header numpy vendors (third_party/pocketfft, mreineck/pocketfft 33ae5dc9): the rows loops
// of numpy's `rfft_impl` and `irfft_loop` (numpy/fft/_pocketfft_umath.cpp) on its non-vectorised path, which is the path of numpy's
// Windows wheel (under MSVC pocketfft defines POCKETFFT_NO_VECTORS itself). Spike S5b: bitwise equal to numpy on 56 M values.
#define POCKETFFT_NO_MULTITHREADING
#include <cstddef>
#include <cstdint>
#include <vector>

#include "pocketfft_hdronly.h"

namespace {

// copy_input: copy min(nin, n) elements and zero the rest.
template <typename T>
void copy_input(const T *in, size_t nin, T *out, size_t n) {
  size_t m = nin < n ? nin : n;
  for (size_t i = 0; i < m; i++) out[i] = in[i];
  for (size_t i = m; i < n; i++) out[i] = T(0);
}

// numpy rfft: `rows` contiguous rows of `npts` reals -> `rows` rows of npts/2+1 complex (interleaved re, im), scale `fct`.
template <typename T>
void rfft_rows(const T *in, size_t rows, size_t npts, T *out, T fct) {
  size_t nout = npts / 2 + 1;
  auto plan = pocketfft::detail::get_plan<pocketfft::detail::pocketfft_r<T>>(npts);
  for (size_t r = 0; r < rows; r++) {
    T *op = out + r * nout * 2;
    copy_input(in + r * npts, npts, op + 1, nout * 2 - 1);
    plan->exec(op + 1, fct, pocketfft::FORWARD);
    op[0] = op[1];  // R0 sits in the I0 slot after the in-place half-complex transform: I0->R0, I0=0
    op[1] = T(0);
  }
}

// numpy irfft: `rows` rows of nin complex (interleaved) -> `rows` rows of `nout` reals, scale `fct`.
template <typename T>
void irfft_rows(const T *in, size_t rows, size_t nin, size_t nout, T *out, T fct) {
  auto plan = pocketfft::detail::get_plan<pocketfft::detail::pocketfft_r<T>>(nout);
  for (size_t r = 0; r < rows; r++) {
    const T *ip = in + r * nin * 2;
    T *op = out + r * nout;
    op[0] = ip[0];
    if (nout > 1) {
      copy_input(ip + 2, (nin - 1) * 2, op + 1, ((nout - 1) / 2) * 2);
      if (nout % 2 == 0) op[nout - 1] = (nout / 2 >= nin) ? T(0) : ip[(nout / 2) * 2];
    }
    plan->exec(op, fct, pocketfft::BACKWARD);
  }
}

}  // namespace

extern "C" {

int32_t thanham_pf_rfft_f64(const double *in, size_t rows, size_t npts, double *out, double fct) {
  try {
    rfft_rows<double>(in, rows, npts, out, fct);
    return 0;
  } catch (...) {
    return 1;
  }
}

int32_t thanham_pf_irfft_f32(const float *in, size_t rows, size_t nin, size_t nout, float *out, float fct) {
  try {
    irfft_rows<float>(in, rows, nin, nout, out, fct);
    return 0;
  } catch (...) {
    return 1;
  }
}

}
