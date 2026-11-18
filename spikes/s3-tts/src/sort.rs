//! `np.argsort` and `np.argpartition` for float32 vectors, with numpy 2.4.6's own dispatch:
//!
//! * x86-64-v3 and v4 CPUs: numpy's x86-simd-sort (`ArgQSort` / `ArgQSelect`) compiled from numpy's sources with `/arch:AVX2` (`build.rs`).
//!   numpy's Windows wheel dispatches `X86_V4` too, but measured under Intel SDE `-skx` its argsort/argpartition orders equal the AVX2 ones on
//!   2,000 tie-heavy vectors while an `/arch:AVX512` build of the same sources does not (1,450 of 2,000 candidate sets match), so v4 uses
//!   the AVX2 variant;
//! * anything older: numpy's generic `aquicksort_` and `aintroselect_` (`npysort/quicksort.cpp`, `selection.cpp`), ported below.
//!
//! The order of equal elements and the identity of the elements kept at a tie differ between these implementations, which is why each
//! path is the one numpy itself takes on the same CPU.

use crate::exp::{isa, Isa};

extern "C" {
    fn xss_v3_argsort_f32(arr: *mut f32, arg: *mut i64, n: i64);
    fn xss_v3_argselect_f32(arr: *mut f32, arg: *mut i64, kth: i64, n: i64);
}

/// numpy's float `Tag::less`: NaNs sort to the end.
#[inline]
fn less(a: f32, b: f32) -> bool {
    a < b || (b != b && a == a)
}

/// `np.argsort(a)` (default kind, ascending). `a` is the buffer numpy would sort in; the SIMD path may reorder it.
pub fn argsort(a: &mut [f32]) -> Vec<i64> {
    let n = a.len();
    let mut arg: Vec<i64> = (0..n as i64).collect();
    if n < 2 {
        return arg;
    }
    match isa() {
        // SAFETY: `a` and `arg` hold `n` elements; `arg` is the identity permutation on entry as numpy's `tosort` is.
        Isa::V4 | Isa::V3 => unsafe { xss_v3_argsort_f32(a.as_mut_ptr(), arg.as_mut_ptr(), n as i64) },
        Isa::Baseline => aquicksort(a, &mut arg),
    }
    arg
}

/// `np.argpartition(a, kth)`: the full index array after introselect (numpy's order, not just the first `kth + 1`).
pub fn argpartition(a: &mut [f32], kth: usize) -> Vec<i64> {
    let n = a.len();
    let mut arg: Vec<i64> = (0..n as i64).collect();
    match isa() {
        // SAFETY: as above; `kth < n`.
        Isa::V4 | Isa::V3 => unsafe { xss_v3_argselect_f32(a.as_mut_ptr(), arg.as_mut_ptr(), kth as i64, n as i64) },
        Isa::Baseline => {
            introselect(a, &mut arg, 0, n as isize - 1, kth as isize);
        }
    }
    arg
}

fn msb(mut n: usize) -> i32 {
    let mut d = 0;
    while n > 1 {
        n >>= 1;
        d += 1;
    }
    d
}

const SMALL_QUICKSORT: isize = 15;

/// `aquicksort_<float_tag>` (quicksort.cpp:219): median-of-3 quicksort on the index array with insertion sort below 16 elements.
fn aquicksort(v: &[f32], tosort: &mut [i64]) {
    let num = tosort.len() as isize;
    let (mut pl, mut pr) = (0isize, num - 1);
    let mut stack: Vec<isize> = Vec::new();
    let mut depths: Vec<i32> = Vec::new();
    let mut cdepth = msb(num as usize) * 2;
    let at = |t: &[i64], i: isize| v[t[i as usize] as usize];
    loop {
        if cdepth < 0 {
            // numpy falls back to heapsort here; unreachable for the vector sizes of the TTS head (<= 1024 elements).
            panic!("aquicksort depth limit reached (heapsort fallback is not ported)");
        }
        while pr - pl > SMALL_QUICKSORT {
            let pm = pl + ((pr - pl) >> 1);
            if less(at(tosort, pm), at(tosort, pl)) {
                tosort.swap(pm as usize, pl as usize);
            }
            if less(at(tosort, pr), at(tosort, pm)) {
                tosort.swap(pr as usize, pm as usize);
            }
            if less(at(tosort, pm), at(tosort, pl)) {
                tosort.swap(pm as usize, pl as usize);
            }
            let vp = at(tosort, pm);
            let mut pi = pl;
            let mut pj = pr - 1;
            tosort.swap(pm as usize, pj as usize);
            loop {
                loop {
                    pi += 1;
                    if !less(at(tosort, pi), vp) {
                        break;
                    }
                }
                loop {
                    pj -= 1;
                    if !less(vp, at(tosort, pj)) {
                        break;
                    }
                }
                if pi >= pj {
                    break;
                }
                tosort.swap(pi as usize, pj as usize);
            }
            let pk = pr - 1;
            tosort.swap(pi as usize, pk as usize);
            if pi - pl < pr - pi {
                stack.push(pi + 1);
                stack.push(pr);
                pr = pi - 1;
            } else {
                stack.push(pl);
                stack.push(pi - 1);
                pl = pi + 1;
            }
            cdepth -= 1;
            depths.push(cdepth);
        }
        let mut pi = pl + 1;
        while pi <= pr {
            let vi = tosort[pi as usize];
            let vp = v[vi as usize];
            let mut pj = pi;
            let mut pk = pi - 1;
            while pj > pl && less(vp, at(tosort, pk)) {
                tosort[pj as usize] = tosort[pk as usize];
                pj -= 1;
                pk -= 1;
            }
            tosort[pj as usize] = vi;
            pi += 1;
        }
        match stack.pop() {
            None => break,
            Some(r) => {
                pr = r;
                pl = stack.pop().unwrap();
                cdepth = depths.pop().unwrap();
            }
        }
    }
}

// introselect (selection.cpp), the `arg = true`, no-pivot-stack variant numpy calls from `np.argpartition` with one kth.
// `lo` and `hi` index the argument array like numpy's `low`/`high`; sub-range helpers receive the slice start explicitly.

fn median3_swap(v: &[f32], t: &mut [i64], low: isize, mid: isize, high: isize) {
    let x = |t: &[i64], i: isize| v[t[i as usize] as usize];
    if less(x(t, high), x(t, mid)) {
        t.swap(high as usize, mid as usize);
    }
    if less(x(t, high), x(t, low)) {
        t.swap(high as usize, low as usize);
    }
    if less(x(t, low), x(t, mid)) {
        t.swap(low as usize, mid as usize);
    }
    t.swap(mid as usize, (low + 1) as usize);
}

/// `median5_` on `t[off..off + 5]`.
fn median5(v: &[f32], t: &mut [i64], off: usize) -> isize {
    let x = |t: &[i64], i: usize| v[t[off + i] as usize];
    if less(x(t, 1), x(t, 0)) {
        t.swap(off + 1, off);
    }
    if less(x(t, 4), x(t, 3)) {
        t.swap(off + 4, off + 3);
    }
    if less(x(t, 3), x(t, 0)) {
        t.swap(off + 3, off);
    }
    if less(x(t, 4), x(t, 1)) {
        t.swap(off + 4, off + 1);
    }
    if less(x(t, 2), x(t, 1)) {
        t.swap(off + 2, off + 1);
    }
    if less(x(t, 3), x(t, 2)) {
        if less(x(t, 3), x(t, 1)) {
            1
        } else {
            3
        }
    } else {
        2
    }
}

/// `median_of_median5_` over `t[off..off + num]`.
fn median_of_median5(v: &[f32], t: &mut [i64], off: usize, num: usize) -> isize {
    let nmed = num / 5;
    let mut subleft = 0;
    for i in 0..nmed {
        let m = median5(v, t, off + subleft) as usize;
        t.swap(off + subleft + m, off + i);
        subleft += 5;
    }
    if nmed > 2 {
        introselect_window(v, t, off, nmed, nmed / 2);
    }
    (nmed / 2) as isize
}

/// `introselect_` on the window `t[off..off + num]` (the recursive call of `median_of_median5_`).
fn introselect_window(v: &[f32], t: &mut [i64], off: usize, num: usize, kth: usize) {
    introselect_range(v, &mut t[off..off + num], 0, num as isize - 1, kth as isize, num);
}

fn introselect(v: &[f32], t: &mut [i64], low: isize, high: isize, kth: isize) {
    introselect_range(v, t, low, high, kth, t.len());
}

fn introselect_range(v: &[f32], t: &mut [i64], mut low: isize, mut high: isize, kth: isize, num: usize) {
    let x = |t: &[i64], i: isize| v[t[i as usize] as usize];
    if kth - low < 3 {
        // dumb_select_ on t[low..=high]
        for i in 0..=(kth - low) {
            let mut minidx = low + i;
            let mut minval = x(t, low + i);
            for k in (low + i + 1)..=high {
                if less(x(t, k), minval) {
                    minidx = k;
                    minval = x(t, k);
                }
            }
            t.swap((low + i) as usize, minidx as usize);
        }
        return;
    } else if kth == num as isize - 1 {
        let mut maxidx = low;
        let mut maxval = x(t, low);
        for k in (low + 1)..num as isize {
            if !less(x(t, k), maxval) {
                maxidx = k;
                maxval = x(t, k);
            }
        }
        t.swap(kth as usize, maxidx as usize);
        return;
    }
    let mut depth_limit = msb(num) * 2;
    while low + 1 < high {
        let mut ll = low + 1;
        let mut hh = high;
        if depth_limit > 0 || hh - ll < 5 {
            let mid = low + (high - low) / 2;
            median3_swap(v, t, low, mid, high);
        } else {
            let mid = ll + median_of_median5(v, t, ll as usize, (hh - ll) as usize);
            t.swap(mid as usize, low as usize);
            ll -= 1;
            hh += 1;
        }
        depth_limit -= 1;
        let pivot = x(t, low);
        loop {
            loop {
                ll += 1;
                if !less(x(t, ll), pivot) {
                    break;
                }
            }
            loop {
                hh -= 1;
                if !less(pivot, x(t, hh)) {
                    break;
                }
            }
            if hh < ll {
                break;
            }
            t.swap(ll as usize, hh as usize);
        }
        t.swap(low as usize, hh as usize);
        if hh >= kth {
            high = hh - 1;
        }
        if hh <= kth {
            low = ll;
        }
    }
    if high == low + 1 && less(x(t, high), x(t, low)) {
        t.swap(high as usize, low as usize);
    }
}
