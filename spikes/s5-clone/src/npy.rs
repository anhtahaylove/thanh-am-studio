//! Minimal `.npy` (format 1.0 to 3.0) reader and writer for the dumps shared with the Python recorder.

use std::fs;
use std::io;
use std::path::Path;

/// A loaded array: raw little-endian bytes plus the numpy descriptor and shape.
pub struct Npy {
    /// numpy dtype descriptor, e.g. `<f4`.
    pub descr: String,
    /// Array shape.
    pub shape: Vec<usize>,
    /// Raw data, C order.
    pub data: Vec<u8>,
}

fn descr_size(descr: &str) -> io::Result<usize> {
    descr
        .trim_start_matches(['<', '>', '|', '='])
        .get(1..)
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| bad("unknown dtype size"))
}

/// Reorders a Fortran-ordered array of `shape` to C order.
fn fortran_to_c(data: &[u8], shape: &[usize], size: usize) -> Vec<u8> {
    let total: usize = shape.iter().product();
    let mut out = vec![0u8; data.len()];
    let mut idx = vec![0usize; shape.len()];
    for c_pos in 0..total {
        // the multi-index of C position `c_pos`
        let mut rem = c_pos;
        for d in (0..shape.len()).rev() {
            idx[d] = rem % shape[d];
            rem /= shape[d];
        }
        let mut f_pos = 0;
        let mut stride = 1;
        for d in 0..shape.len() {
            f_pos += idx[d] * stride;
            stride *= shape[d];
        }
        out[c_pos * size..(c_pos + 1) * size].copy_from_slice(&data[f_pos * size..(f_pos + 1) * size]);
    }
    out
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

impl Npy {
    /// Reads `path`.
    pub fn read(path: &Path) -> io::Result<Npy> {
        let raw = fs::read(path).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
        if raw.len() < 10 || &raw[..6] != b"\x93NUMPY" {
            return Err(bad("not an npy file"));
        }
        let (hlen, start) = match raw[6] {
            1 => (u16::from_le_bytes([raw[8], raw[9]]) as usize, 10),
            _ => (u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize, 12),
        };
        let header = std::str::from_utf8(&raw[start..start + hlen]).map_err(|_| bad("header is not utf-8"))?;
        let fortran = header.contains("'fortran_order': True");
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
        let mut data = raw[start + hlen..].to_vec();
        if fortran && shape.len() > 1 {
            data = fortran_to_c(&data, &shape, descr_size(&descr)?);
        }
        Ok(Npy { descr, shape, data })
    }

    /// Number of elements.
    pub fn len(&self) -> usize {
        self.shape.iter().product()
    }

    /// True when the array has no elements.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn expect(&self, descr: &str) -> io::Result<()> {
        if self.descr == descr {
            Ok(())
        } else {
            Err(bad(&format!("expected dtype {descr}, found {}", self.descr)))
        }
    }

    /// `<f4` as `Vec<f32>`.
    pub fn f32s(&self) -> io::Result<Vec<f32>> {
        self.expect("<f4")?;
        Ok(self.data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
    }

    /// `<f8` as `Vec<f64>`.
    pub fn f64s(&self) -> io::Result<Vec<f64>> {
        self.expect("<f8")?;
        Ok(self.data.chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect())
    }

    /// `<i8` as `Vec<i64>`.
    pub fn i64s(&self) -> io::Result<Vec<i64>> {
        self.expect("<i8")?;
        Ok(self.data.chunks_exact(8).map(|b| i64::from_le_bytes(b.try_into().unwrap())).collect())
    }

    /// `|u1` as bytes.
    pub fn u8s(&self) -> io::Result<&[u8]> {
        self.expect("|u1")?;
        Ok(&self.data)
    }
}

fn write(path: &Path, descr: &str, shape: &[usize], payload: Vec<u8>) -> io::Result<()> {
    let shape_text = match shape.len() {
        1 => format!("({},)", shape[0]),
        _ => format!("({})", shape.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(", ")),
    };
    let mut header = format!("{{'descr': '{descr}', 'fortran_order': False, 'shape': {shape_text}, }}");
    while (10 + header.len() + 1) % 64 != 0 {
        header.push(' ');
    }
    header.push('\n');
    let mut out = Vec::with_capacity(10 + header.len() + payload.len());
    out.extend_from_slice(b"\x93NUMPY\x01\x00");
    out.extend_from_slice(&(header.len() as u16).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&payload);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, out)
}

/// Writes an `<f4` array.
pub fn write_f32(path: &Path, shape: &[usize], data: &[f32]) -> io::Result<()> {
    write(path, "<f4", shape, data.iter().flat_map(|v| v.to_le_bytes()).collect())
}

/// Writes an `<i8` array.
pub fn write_i64(path: &Path, shape: &[usize], data: &[i64]) -> io::Result<()> {
    write(path, "<i8", shape, data.iter().flat_map(|v| v.to_le_bytes()).collect())
}
