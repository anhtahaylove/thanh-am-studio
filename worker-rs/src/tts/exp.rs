//! `np.exp` for float32, as numpy 2.4.6's Windows (MSVC) wheel computes it.
//!
//! * CPU with AVX2 and FMA3 (numpy's `X86_V3` and `X86_V4` targets alike: the AVX-512 branch of `loops_exponent_log.dispatch.c.src` is
//!   compiled out under MSVC): numpy's hand-written `simd_exp_FLOAT` (Cody-Waite range reduction, a 5/2 rational polynomial, `scalef`),
//!   ported intrinsic for intrinsic. It is element-wise, so array length and lane position do not matter.
//! * Anything older (baseline `X86_V2`): a scalar loop over `npy_expf`, which is the C runtime's `expf`; here the system
//!   `ucrtbase.dll!expf`, the one numpy's wheel imports.

use std::arch::x86_64::*;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::sync::OnceLock;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
}

/// Which numpy dispatch target this CPU selects for the float32 loops (numpy: `X86_V4`, `X86_V3`, else the `X86_V2` baseline).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Isa {
    /// No AVX2/FMA3: numpy's baseline loops.
    Baseline,
    /// x86-64-v3: AVX2, FMA3, BMI1/2, LZCNT, F16C, MOVBE.
    V3,
    /// x86-64-v4: AVX-512 F, CD, BW, DQ, VL on top of v3.
    V4,
}

/// Detects the numpy dispatch level of this CPU (the same feature sets numpy's `meson_cpu` defines).
pub fn isa() -> Isa {
    let v3 = is_x86_feature_detected!("avx2")
        && is_x86_feature_detected!("fma")
        && is_x86_feature_detected!("bmi1")
        && is_x86_feature_detected!("bmi2")
        && is_x86_feature_detected!("lzcnt")
        && is_x86_feature_detected!("f16c")
        && is_x86_feature_detected!("movbe");
    if !v3 {
        return Isa::Baseline;
    }
    let v4 = is_x86_feature_detected!("avx512f")
        && is_x86_feature_detected!("avx512cd")
        && is_x86_feature_detected!("avx512bw")
        && is_x86_feature_detected!("avx512dq")
        && is_x86_feature_detected!("avx512vl");
    if v4 {
        Isa::V4
    } else {
        Isa::V3
    }
}

fn ucrt_expf() -> unsafe extern "C" fn(f32) -> f32 {
    static F: OnceLock<usize> = OnceLock::new();
    let addr = *F.get_or_init(|| {
        let wide: Vec<u16> = std::ffi::OsStr::new("ucrtbase.dll").encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: LOAD_LIBRARY_SEARCH_SYSTEM32 only; the symbol name is NUL-terminated.
        unsafe {
            let module = ortffi::without_error_dialogs(|| LoadLibraryExW(wide.as_ptr(), 0, 0x800));
            assert!(module != 0, "ucrtbase.dll is missing");
            let p = GetProcAddress(module, c"expf".as_ptr().cast());
            assert!(!p.is_null(), "ucrtbase.dll has no expf");
            p as usize
        }
    });
    // SAFETY: `addr` is the address of `expf(float) -> float`.
    unsafe { std::mem::transmute::<usize, unsafe extern "C" fn(f32) -> f32>(addr) }
}

/// numpy's `fma_scalef_ps`.
#[target_feature(enable = "avx2,fma")]
fn scalef(poly: __m256, quadrant: __m256) -> __m256 {
    let minquadrant = _mm256_set1_ps(-125.0);
    let denormal_mask = _mm256_cmp_ps::<_CMP_LE_OQ>(quadrant, minquadrant);
    if _mm256_movemask_ps(denormal_mask) != 0 {
        let mut quad_diff = _mm256_sub_ps(quadrant, minquadrant);
        quad_diff = _mm256_sub_ps(_mm256_setzero_ps(), quad_diff);
        quad_diff = _mm256_blendv_ps(_mm256_setzero_ps(), quad_diff, denormal_mask);
        let two_power_diff = _mm256_sllv_epi32(_mm256_set1_epi32(1), _mm256_cvtps_epi32(quad_diff));
        let quadrant = _mm256_max_ps(quadrant, minquadrant);
        let exponent = _mm256_slli_epi32::<23>(_mm256_cvtps_epi32(quadrant));
        let poly = _mm256_castsi256_ps(_mm256_add_epi32(_mm256_castps_si256(poly), exponent));
        let denorm_poly = _mm256_div_ps(poly, _mm256_cvtepi32_ps(two_power_diff));
        _mm256_blendv_ps(poly, denorm_poly, denormal_mask)
    } else {
        let exponent = _mm256_slli_epi32::<23>(_mm256_cvtps_epi32(quadrant));
        _mm256_castsi256_ps(_mm256_add_epi32(_mm256_castps_si256(poly), exponent))
    }
}

/// One vector of numpy's `simd_exp_FLOAT` (the lanes that numpy masks out of the store are simply not read back here).
#[allow(clippy::excessive_precision)] // numpy's literals, kept verbatim so they can be checked against its source
#[target_feature(enable = "avx2,fma")]
fn exp8(x: __m256) -> __m256 {
    const XMAX: f32 = 88.72283935546875;
    const XMIN: f32 = -103.97208404541015625;
    let c1 = _mm256_set1_ps(-6.93145752e-1);
    let c2 = _mm256_set1_ps(-1.42860677e-6);
    let p0 = _mm256_set1_ps(9.999999999980870924916e-01);
    let p1 = _mm256_set1_ps(7.257664613233124478488e-01);
    let p2 = _mm256_set1_ps(2.473615434895520810817e-01);
    let p3 = _mm256_set1_ps(5.114512081637298353406e-02);
    let p4 = _mm256_set1_ps(6.757896990527504603057e-03);
    let p5 = _mm256_set1_ps(5.082762527590693718096e-04);
    let q0 = _mm256_set1_ps(1.0);
    let q1 = _mm256_set1_ps(-2.742335390411667452936e-01);
    let q2 = _mm256_set1_ps(2.159509375685829852307e-02);
    let cvt_magic = _mm256_set1_ps(12_582_912.0); // 0x1.8p+23
    let log2e = _mm256_set1_ps(std::f32::consts::LOG2_E);
    let inf = _mm256_set1_ps(f32::INFINITY);
    let zeros = _mm256_setzero_ps();

    let nan_mask = _mm256_cmp_ps::<_CMP_NEQ_UQ>(x, x);
    let x = _mm256_blendv_ps(x, zeros, nan_mask);
    let xmax_mask = _mm256_cmp_ps::<_CMP_GE_OQ>(x, _mm256_set1_ps(XMAX));
    let xmin_mask = _mm256_cmp_ps::<_CMP_LE_OQ>(x, _mm256_set1_ps(XMIN));
    let x = _mm256_blendv_ps(x, zeros, _mm256_or_ps(_mm256_or_ps(nan_mask, xmin_mask), xmax_mask));

    // numpy's source is `mul` then `add`; its MSVC build contracts them into one FMA (measured: they differ only at exact rounding ties,
    // e.g. x = 0x3f851592 = 1.5 ln 2, where the single rounding picks the other quadrant).
    let mut quadrant = _mm256_fmadd_ps(x, log2e, cvt_magic);
    quadrant = _mm256_sub_ps(quadrant, cvt_magic);

    let mut x = _mm256_fmadd_ps(quadrant, c1, x);
    x = _mm256_fmadd_ps(quadrant, c2, x);
    x = _mm256_fmadd_ps(quadrant, zeros, x);

    let mut num = _mm256_fmadd_ps(p5, x, p4);
    num = _mm256_fmadd_ps(num, x, p3);
    num = _mm256_fmadd_ps(num, x, p2);
    num = _mm256_fmadd_ps(num, x, p1);
    num = _mm256_fmadd_ps(num, x, p0);
    let mut den = _mm256_fmadd_ps(q2, x, q1);
    den = _mm256_fmadd_ps(den, x, q0);
    let mut poly = _mm256_div_ps(num, den);

    poly = scalef(poly, quadrant);
    poly = _mm256_blendv_ps(poly, _mm256_set1_ps(f32::NAN), nan_mask);
    poly = _mm256_blendv_ps(poly, inf, xmax_mask);
    _mm256_blendv_ps(poly, zeros, xmin_mask)
}

#[target_feature(enable = "avx2,fma")]
fn exp_avx2(src: &[f32], dst: &mut [f32]) {
    assert_eq!(src.len(), dst.len());
    let mut i = 0;
    while i + 8 <= src.len() {
        // SAFETY: lanes i..i + 8 lie inside both slices.
        unsafe { _mm256_storeu_ps(dst.as_mut_ptr().add(i), exp8(_mm256_loadu_ps(src.as_ptr().add(i)))) };
        i += 8;
    }
    if i < src.len() {
        let mut tmp = [0.0f32; 8];
        tmp[..src.len() - i].copy_from_slice(&src[i..]);
        let mut r = [0.0f32; 8];
        // SAFETY: both arrays hold 8 lanes.
        unsafe { _mm256_storeu_ps(r.as_mut_ptr(), exp8(_mm256_loadu_ps(tmp.as_ptr()))) };
        dst[i..].copy_from_slice(&r[..src.len() - i]);
    }
}

/// `dst = np.exp(src)` for float32 arrays, bitwise as numpy's Windows wheel computes it on this CPU.
pub fn exp_f32(src: &[f32], dst: &mut [f32]) {
    assert_eq!(src.len(), dst.len());
    if isa() >= Isa::V3 {
        // SAFETY: the CPU has AVX2 and FMA3 (checked by `isa`).
        unsafe { exp_avx2(src, dst) }
    } else {
        let expf = ucrt_expf();
        for (d, &s) in dst.iter_mut().zip(src) {
            // SAFETY: plain C runtime math function.
            *d = unsafe { expf(s) };
        }
    }
}
