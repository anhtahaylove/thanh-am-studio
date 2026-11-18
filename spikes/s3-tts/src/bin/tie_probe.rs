//! `tie_probe <vecs.npy> <out_dir>`: Rust `argpartition(l, -25)[-25:]` and `argsort(l[cand])[::-1]` on the vectors `scripts/tie_probe.py` made,
//! written as `cand.npy` and `order.npy` for a bitwise comparison with numpy on the same ISA (N5).

use s3_tts::exp::isa;
use s3_tts::npy::{self, Npy};
use s3_tts::sort;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let vecs = Npy::read(&PathBuf::from(&args[1]))?;
    let (n, v) = (vecs.shape[0], vecs.shape[1]);
    let data = vecs.f32s()?;
    let (mut cand_all, mut order_all) = (Vec::<u8>::new(), Vec::<u8>::new());
    for i in 0..n {
        let mut l = data[i * v..(i + 1) * v].to_vec();
        let part = sort::argpartition(&mut l, v - 25);
        let cand: Vec<i64> = part[v - 25..].to_vec();
        let mut cs: Vec<f32> = cand.iter().map(|&c| l[c as usize]).collect();
        let order = sort::argsort(&mut cs);
        // numpy's `[::-1]`
        let rev: Vec<i64> = order.iter().rev().copied().collect();
        cand_all.extend(cand.iter().flat_map(|c| c.to_le_bytes()));
        order_all.extend(rev.iter().flat_map(|c| c.to_le_bytes()));
    }
    let out = PathBuf::from(&args[2]);
    std::fs::create_dir_all(&out)?;
    npy::write(&out.join("cand.npy"), "<i8", &[n, 25], &cand_all)?;
    npy::write(&out.join("order.npy"), "<i8", &[n, 25], &order_all)?;
    eprintln!("isa={:?} done {n} vectors", isa());
    Ok(())
}
