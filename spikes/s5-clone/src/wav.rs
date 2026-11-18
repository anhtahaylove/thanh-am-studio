//! WAV reading (PCM 16/24/32 and float32, plain or extensible) with libsndfile's float conversion, the libsndfile-compatible
//! float to PCM quantisation used when the Python path writes the trimmed clip, and the numpy-compatible channel mean.

use std::fs;
use std::io;
use std::path::Path;

/// Decoded WAV: interleaved float32 frames.
pub struct Wav {
    /// Sample rate in Hz.
    pub sample_rate: u32,
    /// Channel count.
    pub channels: usize,
    /// Interleaved samples, `frames * channels` long.
    pub samples: Vec<f32>,
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

/// Reads a WAV file the way `soundfile.read(dtype="float32")` does for the formats the app's references use.
pub fn read(path: &Path) -> io::Result<Wav> {
    let raw = fs::read(path).map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
    if raw.len() < 12 || &raw[..4] != b"RIFF" || &raw[8..12] != b"WAVE" {
        return Err(bad("not a RIFF/WAVE file"));
    }
    let (mut format, mut channels, mut rate, mut bits) = (0u16, 0usize, 0u32, 0u16);
    let mut data: Option<&[u8]> = None;
    let mut pos = 12;
    while pos + 8 <= raw.len() {
        let size = u32::from_le_bytes(raw[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &raw[pos + 8..(pos + 8 + size).min(raw.len())];
        match &raw[pos..pos + 4] {
            b"fmt " if body.len() >= 16 => {
                format = u16::from_le_bytes([body[0], body[1]]);
                channels = u16::from_le_bytes([body[2], body[3]]) as usize;
                rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                bits = u16::from_le_bytes([body[14], body[15]]);
                if format == 0xFFFE && body.len() >= 26 {
                    format = u16::from_le_bytes([body[24], body[25]]);
                }
            }
            b"data" => data = Some(body),
            _ => {}
        }
        pos += 8 + size + (size & 1);
    }
    let data = data.ok_or_else(|| bad("no data chunk"))?;
    if channels == 0 {
        return Err(bad("no fmt chunk"));
    }
    let samples: Vec<f32> = match (format, bits) {
        (1, 16) => data.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect(),
        (1, 24) => data
            .chunks_exact(3)
            .map(|b| (((i32::from_le_bytes([0, b[0], b[1], b[2]])) >> 8) as f32) / 8_388_608.0)
            .collect(),
        (1, 32) => data
            .chunks_exact(4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 * (1.0 / 2_147_483_648.0))
            .collect(),
        (3, 32) => data.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
        _ => return Err(bad(&format!("unsupported WAV format {format} / {bits} bits"))),
    };
    let whole = samples.len() / channels * channels;
    Ok(Wav { sample_rate: rate, channels, samples: samples[..whole].to_vec() })
}

/// numpy's pairwise float32 summation (`add.reduce` over a contiguous axis).
pub fn pairwise_sum(a: &[f32]) -> f32 {
    let n = a.len();
    if n < 8 {
        let mut res = 0.0f32;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - (n % 8) {
            for j in 0..8 {
                r[j] += a[i + j];
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

/// `frames.mean(axis=1)` for interleaved float32 data (numpy: float32 sum, then divide by the channel count).
pub fn mean_channels(samples: &[f32], channels: usize) -> Vec<f32> {
    samples.chunks_exact(channels).map(|c| pairwise_sum(c) / channels as f32).collect()
}

/// Float to int16 as the libsndfile inside python-soundfile writes it (clipping on): `floor(x * scale)` clipped to the int16
/// range. Measured against soundfile, not assumed: the conversion floors (it is not round-to-nearest) and uses the read scale.
pub fn quantize_i16(x: f32, scale: f32) -> i16 {
    let v = (x * scale).floor();
    if v >= 32767.0 {
        32767
    } else if v <= -32768.0 {
        -32768
    } else {
        v as i16
    }
}

/// Float to int24 (as an `i32` in -8388608..=8388607), same convention.
pub fn quantize_i24(x: f32, scale: f32) -> i32 {
    let v = (x * scale).floor();
    if v >= 8_388_607.0 {
        8_388_607
    } else if v <= -8_388_608.0 {
        -8_388_608
    } else {
        v as i32
    }
}

/// Reads any audio file: RIFF/WAVE natively (libsndfile-compatible conversion), everything else through the FFmpeg CLI
/// (`-map 0:a:0 -f f32le`, native rate and channels; `ffprobe` supplies rate and channels).
pub fn read_any(path: &Path, ffmpeg: &Path, ffprobe: &Path) -> io::Result<Wav> {
    let head = fs::read(path).map(|b| b.get(..4).map(<[u8]>::to_vec))?;
    if head.as_deref() == Some(b"RIFF") {
        return read(path);
    }
    let probe = std::process::Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()?;
    let text = String::from_utf8_lossy(&probe.stdout).trim().to_string();
    let mut parts = text.split(',');
    let sample_rate: u32 =
        parts.next().and_then(|v| v.trim().parse().ok()).ok_or_else(|| bad("ffprobe: no sample rate"))?;
    let channels: usize =
        parts.next().and_then(|v| v.trim().parse().ok()).ok_or_else(|| bad("ffprobe: no channels"))?;
    let out = std::process::Command::new(ffmpeg)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"])
        .output()?;
    if !out.status.success() {
        return Err(bad(&format!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    let samples: Vec<f32> = out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let whole = samples.len() / channels * channels;
    Ok(Wav { sample_rate, channels, samples: samples[..whole].to_vec() })
}
