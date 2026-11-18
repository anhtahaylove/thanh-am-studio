//! numpy 2.4.6's real FFTs: the pocketfft C++ header numpy vendors, driven like numpy's `rfft` / `irfft` loops
//! (`native/pocketfft_shim.cc`). Rows are independent, so row-wise results equal numpy's for any array layout.

extern "C" {
    fn s5_pf_rfft_f64(input: *const f64, rows: usize, npts: usize, out: *mut f64, fct: f64) -> i32;
    fn s5_pf_irfft_f32(input: *const f32, rows: usize, nin: usize, nout: usize, out: *mut f32, fct: f32) -> i32;
    fn s5_pf_irfft_f64(input: *const f64, rows: usize, nin: usize, nout: usize, out: *mut f64, fct: f64) -> i32;
}

/// `np.fft.rfft(rows, n=npts, axis=1)` on `rows` contiguous rows of `npts` float64: interleaved (re, im), `npts / 2 + 1` per row.
pub fn rfft_f64(input: &[f64], rows: usize, npts: usize) -> Vec<f64> {
    assert_eq!(input.len(), rows * npts);
    let mut out = vec![0.0f64; rows * (npts / 2 + 1) * 2];
    // SAFETY: the buffers have exactly the sizes the shim reads and writes.
    let rc = unsafe { s5_pf_rfft_f64(input.as_ptr(), rows, npts, out.as_mut_ptr(), 1.0) };
    assert_eq!(rc, 0, "pocketfft rfft failed");
    out
}

/// `np.fft.irfft(spec, n=nout, axis=...)` on `rows` rows of `nin` interleaved complex64, with numpy's float32 `1 / n` scale.
pub fn irfft_f32(input: &[f32], rows: usize, nin: usize, nout: usize) -> Vec<f32> {
    assert_eq!(input.len(), rows * nin * 2);
    let mut out = vec![0.0f32; rows * nout];
    let fct = (1.0f64 / nout as f64) as f32;
    // SAFETY: as above.
    let rc = unsafe { s5_pf_irfft_f32(input.as_ptr(), rows, nin, nout, out.as_mut_ptr(), fct) };
    assert_eq!(rc, 0, "pocketfft irfft failed");
    out
}

/// The float64 variant of [`irfft_f32`] (numpy 1 behaviour for complex64 input).
pub fn irfft_f64(input: &[f64], rows: usize, nin: usize, nout: usize) -> Vec<f64> {
    assert_eq!(input.len(), rows * nin * 2);
    let mut out = vec![0.0f64; rows * nout];
    // SAFETY: as above.
    let rc = unsafe { s5_pf_irfft_f64(input.as_ptr(), rows, nin, nout, out.as_mut_ptr(), 1.0 / nout as f64) };
    assert_eq!(rc, 0, "pocketfft irfft failed");
    out
}
