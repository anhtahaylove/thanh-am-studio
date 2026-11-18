//! Minimal `.npy` / stored `.npz` reader for the model heads.

use std::io;

/// A loaded array: raw little-endian bytes plus the numpy descriptor and shape (C order only).
pub struct Npy {
    /// numpy dtype descriptor, e.g. `<f4`.
    pub descr: String,
    /// Array shape.
    pub shape: Vec<usize>,
    /// Raw data.
    pub data: Vec<u8>,
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

impl Npy {
    /// Parses the bytes of an `.npy` file.
    pub fn parse(raw: &[u8]) -> io::Result<Npy> {
        if raw.len() < 10 || &raw[..6] != b"\x93NUMPY" {
            return Err(bad("not an npy file"));
        }
        let (hlen, start) = match raw[6] {
            1 => (u16::from_le_bytes([raw[8], raw[9]]) as usize, 10),
            _ => (u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize, 12),
        };
        let header = std::str::from_utf8(raw.get(start..start + hlen).ok_or_else(|| bad("short header"))?)
            .map_err(|_| bad("header is not utf-8"))?;
        if header.contains("'fortran_order': True") {
            return Err(bad("fortran order is not supported"));
        }
        let descr = header
            .split("'descr':")
            .nth(1)
            .and_then(|s| s.split('\'').nth(1))
            .ok_or_else(|| bad("no descr"))?
            .to_string();
        let shape_text = header
            .split("'shape':")
            .nth(1)
            .and_then(|s| s.split('(').nth(1))
            .and_then(|s| s.split(')').next())
            .ok_or_else(|| bad("no shape"))?;
        let shape = shape_text
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().parse::<usize>().map_err(|_| bad("bad shape")))
            .collect::<io::Result<Vec<_>>>()?;
        Ok(Npy { descr, shape, data: raw[start + hlen..].to_vec() })
    }

    /// The data as `f32` (descriptor `<f4`).
    pub fn f32s(&self) -> io::Result<Vec<f32>> {
        if self.descr != "<f4" {
            return Err(bad("expected <f4"));
        }
        Ok(self.data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
    }
}

/// Reads one member of a stored (uncompressed) `.npz` archive, as `numpy.savez` writes it.
pub fn npz_member(npz: &[u8], name: &str) -> io::Result<Npy> {
    // Walk the central directory from the end-of-central-directory record.
    let eocd = (0..npz.len().saturating_sub(21))
        .rev()
        .find(|&i| npz[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| bad("no zip end record"))?;
    let u16at = |o: usize| u16::from_le_bytes([npz[o], npz[o + 1]]) as usize;
    let u32at = |o: usize| u32::from_le_bytes([npz[o], npz[o + 1], npz[o + 2], npz[o + 3]]) as usize;
    let (count, mut cd) = (u16at(eocd + 10), u32at(eocd + 16));
    for _ in 0..count {
        if npz.get(cd..cd + 4) != Some(&[0x50, 0x4b, 0x01, 0x02]) {
            return Err(bad("bad central directory"));
        }
        let (method, csize, nlen, xlen, clen, local) =
            (u16at(cd + 10), u32at(cd + 20), u16at(cd + 28), u16at(cd + 30), u16at(cd + 32), u32at(cd + 42));
        let entry = std::str::from_utf8(&npz[cd + 46..cd + 46 + nlen]).map_err(|_| bad("bad member name"))?;
        if entry == format!("{name}.npy") {
            if method != 0 {
                return Err(bad("compressed npz members are not supported"));
            }
            let data = local + 30 + u16at(local + 26) + u16at(local + 28);
            return Npy::parse(npz.get(data..data + csize).ok_or_else(|| bad("member out of range"))?);
        }
        cd += 46 + nlen + xlen + clen;
    }
    Err(bad(&format!("{name} is not in the archive")))
}
