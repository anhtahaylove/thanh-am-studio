//! numpy 2.4.6 float32 reductions as the engine's head uses them (`np.sum`, `.mean()`, `.var()`, `np.max`, `argmax`, `cumsum`).
//!
//! `pairwise_sum` follows `loops_utils.h.src` (`@TYPE@_pairwise_sum`); the same algorithm is what the reference harness of spike S5
//! (`wav::pairwise_sum`) mirrors. `mean` and `var` divide in float64 and round to float32, because numpy divides the float32 sum by a
//! `numpy.intp` scalar (`_methods.py`: `ret.dtype.type(ret / rcount)` promotes float32 / int64 to float64).

/// numpy's float32 pairwise summation of a contiguous array (what `np.add.reduce` calls for the whole axis).
pub fn pairwise_sum(a: &[f32]) -> f32 {
    let n = a.len();
    if n < 8 {
        let mut res = -0.0f32;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - (n % 8) {
            for (j, rj) in r.iter_mut().enumerate() {
                *rj += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pairwise_sum(&a[..n2]) + pairwise_sum(&a[n2..])
    }
}

/// `np.sum(a)` for a float32 vector: the reduction starts from the additive identity and adds the pairwise sum of all elements.
pub fn sum(a: &[f32]) -> f32 {
    0.0f32 + pairwise_sum(a)
}

/// `a.mean()` for a float32 vector.
pub fn mean(a: &[f32]) -> f32 {
    ((sum(a) as f64) / (a.len() as f64)) as f32
}

/// `a.var()` for a float32 vector.
pub fn var(a: &[f32]) -> f32 {
    let m = mean(a);
    let sq: Vec<f32> = a.iter().map(|&v| (v - m) * (v - m)).collect();
    ((sum(&sq) as f64) / (a.len() as f64)) as f32
}

/// `np.max(a)` (no NaNs expected).
pub fn max(a: &[f32]) -> f32 {
    let mut m = a[0];
    for &v in &a[1..] {
        if v > m || v != v {
            m = v;
        }
    }
    m
}

/// `a.argmax()`: the first index of the maximum.
pub fn argmax(a: &[f32]) -> usize {
    let mut best = 0;
    for (i, &v) in a.iter().enumerate().skip(1) {
        if v > a[best] {
            best = i;
        }
    }
    best
}

/// `np.cumsum(a)` for float32: sequential addition.
pub fn cumsum(a: &[f32]) -> Vec<f32> {
    let mut acc = 0.0f32;
    a.iter()
        .enumerate()
        .map(|(i, &v)| {
            acc = if i == 0 { v } else { acc + v };
            acc
        })
        .collect()
}

/// The engine's `_softmax`: `x = x - np.max(x); e = np.exp(x); return e / np.sum(e)`.
pub fn softmax(x: &[f32]) -> Vec<f32> {
    let m = max(x);
    let shifted: Vec<f32> = x.iter().map(|&v| v - m).collect();
    let mut e = vec![0.0f32; x.len()];
    crate::exp::exp_f32(&shifted, &mut e);
    let s = sum(&e);
    e.iter().map(|&v| v / s).collect()
}
