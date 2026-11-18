//! `exp_chunks <out.json> <all | start:stop:step> [--ucrt]`: the Rust `exp` over float32 bit patterns in chunks of 2**24, hashed as
//! `scripts/exp_chunks.py` hashes `np.exp`. `--ucrt` uses the baseline (system `expf`) path instead of the AVX2/FMA3 port.

use s3_tts::exp::{exp_f32, exp_f32_avx2, exp_f32_ucrt};
use sha2::{Digest, Sha256};

const CH: u64 = 1 << 24;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let chunks: Vec<u64> = if args[2] == "all" {
        (0..256).collect()
    } else {
        let p: Vec<u64> = args[2].split(':').map(|x| x.parse().unwrap()).collect();
        (p[0]..p[1]).step_by(p[2] as usize).collect()
    };
    let ucrt = args.iter().any(|a| a == "--ucrt");
    let dispatch = args.iter().any(|a| a == "--dispatch");
    let mut out = String::from("{");
    for (n, &i) in chunks.iter().enumerate() {
        let src: Vec<f32> = (i * CH..(i + 1) * CH).map(|b| f32::from_bits(b as u32)).collect();
        let mut dst = vec![0.0f32; src.len()];
        if ucrt {
            for (d, &s) in dst.iter_mut().zip(&src) {
                *d = exp_f32_ucrt(s);
            }
        } else if dispatch {
            exp_f32(&src, &mut dst);
        } else {
            exp_f32_avx2(&src, &mut dst);
        }
        let bytes: Vec<u8> = dst.iter().flat_map(|v| v.to_le_bytes()).collect();
        if let Some(d) = args.iter().position(|a| a == "--dump").map(|i| &args[i + 1]) {
            std::fs::write(format!("{d}/chunk{i}.bin"), &bytes).unwrap();
        }
        let h = Sha256::digest(&bytes);
        let hex: String = h[..8].iter().map(|b| format!("{b:02x}")).collect();
        if n > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!("\"{i}\": \"{hex}\""));
    }
    out.push('}');
    std::fs::write(&args[1], out).unwrap();
    println!("done {}", chunks.len());
}
