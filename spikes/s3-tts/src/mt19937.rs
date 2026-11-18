//! numpy's legacy global `RandomState`: MT19937 seeded by `np.random.seed(int)` (`init_genrand`), `random_sample` as
//! `(a >> 5, b >> 6)` 53-bit doubles, and `np.random.choice(n, p=p)` for a 1-D probability vector.

const N: usize = 624;
const M: usize = 397;

/// The Mersenne Twister state, bit-compatible with `numpy.random.RandomState`.
pub struct Mt19937 {
    key: [u32; N],
    pos: usize,
}

impl Mt19937 {
    /// `np.random.seed(seed)` for an integer `0 <= seed < 2**32` (`mt19937_seed`).
    pub fn seed(seed: u32) -> Mt19937 {
        let mut key = [0u32; N];
        let mut s = seed;
        for (i, k) in key.iter_mut().enumerate() {
            *k = s;
            s = 1812433253u32.wrapping_mul(s ^ (s >> 30)).wrapping_add(i as u32 + 1);
        }
        Mt19937 { key, pos: N }
    }

    /// `RandomState.get_state()[2]`: the position in the key array.
    pub fn pos(&self) -> usize {
        self.pos
    }

    fn generate(&mut self) {
        for i in 0..N {
            let y = (self.key[i] & 0x8000_0000) | (self.key[(i + 1) % N] & 0x7fff_ffff);
            let mut v = self.key[(i + M) % N] ^ (y >> 1);
            if y & 1 != 0 {
                v ^= 0x9908_b0df;
            }
            self.key[i] = v;
        }
        self.pos = 0;
    }

    /// `mt19937_next32`.
    pub fn next_u32(&mut self) -> u32 {
        if self.pos == N {
            self.generate();
        }
        let mut y = self.key[self.pos];
        self.pos += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^ (y >> 18)
    }

    /// `RandomState.random_sample()` (`mt19937_next_double`).
    pub fn random_sample(&mut self) -> f64 {
        let a = (self.next_u32() >> 5) as f64;
        let b = (self.next_u32() >> 6) as f64;
        (a * 67108864.0 + b) / 9007199254740992.0
    }

    /// `np.random.choice(p.len(), p=p)` for float32 probabilities (numpy converts `p` to float64 exactly, then
    /// `cdf = p.cumsum(); cdf /= cdf[-1]; cdf.searchsorted(random_sample(), side='right')`).
    pub fn choice(&mut self, p: &[f32]) -> usize {
        let mut cdf: Vec<f64> = Vec::with_capacity(p.len());
        let mut acc = 0.0f64;
        for &x in p {
            acc += x as f64;
            cdf.push(acc);
        }
        let last = cdf[cdf.len() - 1];
        for c in cdf.iter_mut() {
            *c /= last;
        }
        let u = self.random_sample();
        // searchsorted(side='right'): the number of elements <= u (binary search over a sorted array).
        let (mut lo, mut hi) = (0usize, cdf.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if cdf[mid] <= u {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_reference_mt19937_outputs() {
        // init_genrand(5489): the first outputs of the reference implementation.
        let mut m = Mt19937::seed(5489);
        assert_eq!(m.next_u32(), 3_499_211_612);
        assert_eq!(m.next_u32(), 581_869_302);
    }
}
