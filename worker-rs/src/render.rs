//! `render`: per-clip FFmpeg passes, the concat/mix/normalise pass and the final file, as `render()` in `worker/main.py`.

use crate::error::{Result, WorkerError};
use crate::media::{executable, loudness, probe, run_process, wav_frames};
use crate::paths::{replace_with_retry, resolve};
use crate::pyfmt::{float_repr, round_half_even, truthy};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Codec arguments per export format (`EXPORT_CODECS`); the order is the order the format list is reported in.
const EXPORT_CODECS: &[(&str, &[&str])] = &[
    ("wav", &["-c:a", "pcm_s24le"]),
    ("mp3", &["-c:a", "libmp3lame", "-b:a", "192k"]),
    ("m4a", &["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
    ("flac", &["-c:a", "flac", "-sample_fmt", "s32"]), // s32 = 24-bit FLAC
    ("opus", &["-c:a", "libopus", "-b:a", "128k"]),
];

/// `number()`: a finite JSON number (not a boolean) inside `[low, high]`.
pub fn number(value: Option<&Value>, name: &str, low: f64, high: f64) -> Result<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite() && low <= *x && *x <= high),
        _ => None,
    }
    .ok_or_else(|| WorkerError::new("INVALID_RECIPE", format!("{name} is outside the supported range.")))
}

const DAY_MS: f64 = 86_400_000.0;

/// What one clip asks for after validation against its source duration (`clip_recipe`).
pub struct ClipRecipe {
    start_ms: f64,
    duration_ms: f64,
    fade_in_ms: f64,
    fade_out_ms: f64,
    gain_db: f64,
    gap_ms: f64,
}

/// Validates a clip's trim, fades, gain and gap against the source length.
pub fn clip_recipe(clip: &Map<String, Value>, source_duration: f64) -> Result<ClipRecipe> {
    let duration = number(Some(&Value::from(source_duration)), "duration", 0.001, DAY_MS)?;
    let start = number(Some(clip.get("trim_start_ms").unwrap_or(&Value::from(0))), "trim_start_ms", 0.0, DAY_MS)?;
    let end = match clip.get("trim_end_ms") {
        None | Some(Value::Null) => duration,
        Some(v) => number(Some(v), "trim_end_ms", 0.0, DAY_MS)?,
    };
    if end > duration + 2.0 || end <= start {
        return Err(WorkerError::new("INVALID_RECIPE", "Trim end must be after start and inside source duration."));
    }
    let length = end.min(duration) - start;
    let get = |key: &str, low: f64, high: f64| number(Some(clip.get(key).unwrap_or(&Value::from(0))), key, low, high);
    Ok(ClipRecipe {
        start_ms: start,
        duration_ms: length,
        fade_in_ms: get("fade_in_ms", 0.0, DAY_MS)?.min(length),
        fade_out_ms: get("fade_out_ms", 0.0, DAY_MS)?.min(length),
        gain_db: get("gain_db", -60.0, 24.0)?,
        gap_ms: get("gap_ms", 0.0, 600_000.0)?,
    })
}

fn ffmpeg_args(ffmpeg: &str, head: &[&str]) -> Vec<String> {
    std::iter::once(ffmpeg).chain(head.iter().copied()).map(str::to_string).collect()
}

fn py_type_error(what: &str) -> WorkerError {
    WorkerError::py("TypeError", what.to_string())
}

fn str_field<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    match obj.get(key) {
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(py_type_error("argument should be a str or an os.PathLike object")),
        None => Err(WorkerError::py("KeyError", format!("'{key}'"))),
    }
}

/// Removes the temp folder when dropped (the `TemporaryDirectory` of the Python worker).
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs a render request and returns `{path, duration_ms, sample_rate, channels}` of the finished file.
pub fn render(payload: &Map<String, Value>, output_dir: &Path, progress: &dyn Fn(f64, &str)) -> Result<Value> {
    let invalid = |msg: &str| WorkerError::new("INVALID_RECIPE", msg);
    let clips = match payload.get("clips") {
        Some(Value::Array(c)) if (1..=10_000).contains(&c.len()) => c,
        _ => return Err(invalid("Select at least one audio take to export.")),
    };
    let fmt = payload.get("format").map_or("wav", |f| f.as_str().unwrap_or(""));
    let Some((_, codec)) = EXPORT_CODECS.iter().find(|(name, _)| *name == fmt) else {
        let names: Vec<&str> = EXPORT_CODECS.iter().map(|(n, _)| *n).collect();
        return Err(invalid(&format!("Supported export formats: {}.", names.join(", "))));
    };
    let ffmpeg = executable("ffmpeg", payload.get("ffmpeg_path").and_then(Value::as_str))?;
    // Subtitle timeline: each clip starts at its at_ms (silence fills the wait), sped up by its rate, and the output runs at least
    // to pad_to_ms; the gaps are not used. The places come from the app's dub plan; this only applies them.
    let timeline = payload.get("timeline") == Some(&Value::Bool(true));
    let pad_to = if timeline {
        round_half_even(
            number(Some(payload.get("pad_to_ms").unwrap_or(&Value::from(0))), "pad_to_ms", 0.0, DAY_MS)? * 48.0,
        )
    } else {
        0
    };
    // The source's background (a separate job's stem) under the dub: both start at sample 0 of the same media.
    let background = payload.get("background_path").filter(|v| truthy(v)).and_then(Value::as_str);
    if background.is_some() && !timeline {
        return Err(WorkerError::new("INVALID_BACKGROUND", "A background is mixed only under the subtitle timeline."));
    }
    if let Some(background) = background {
        probe(background, Some(&ffmpeg))?; // a missing stem fails before the clips are rendered
    }
    let normalize = payload.get("normalize").is_some_and(truthy);
    std::fs::create_dir_all(output_dir).map_err(|e| WorkerError::py("OSError", e))?;
    let id = uuid::Uuid::new_v4();
    let final_path = output_dir.join(format!("{id}.{fmt}"));
    let partial = output_dir.join(format!("{id}.partial.{fmt}"));
    let outcome = render_into(
        clips,
        &ffmpeg,
        output_dir,
        &final_path,
        &partial,
        (timeline, pad_to, background, normalize, codec),
        progress,
    );
    let _ = std::fs::remove_file(&partial);
    outcome
}

fn render_into(
    clips: &[Value],
    ffmpeg: &str,
    output_dir: &Path,
    final_path: &Path,
    partial: &Path,
    (timeline, pad_to, background, normalize, codec): (bool, i64, Option<&str>, bool, &&[&str]),
    progress: &dyn Fn(f64, &str),
) -> Result<Value> {
    let temp = TempDir(output_dir.join(format!("render-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])));
    std::fs::create_dir_all(&temp.0).map_err(|e| WorkerError::py("OSError", e))?;
    let mut written: i64 = 0; // samples of the clips rendered so far, at 48 kHz
    for (i, clip) in clips.iter().enumerate() {
        let clip =
            clip.as_object().ok_or_else(|| WorkerError::py("AttributeError", "'str' object has no attribute 'get'"))?;
        let clip_path = str_field(clip, "path")?;
        let info = probe(clip_path, Some(ffmpeg))?;
        let recipe = clip_recipe(clip, info["duration_ms"].as_f64().unwrap_or(0.0))?;
        let rate =
            if timeline { number(Some(clip.get("rate").unwrap_or(&Value::from(1))), "rate", 1.0, 2.0)? } else { 1.0 };
        // A take read at another speed fits its cue from its reading before the speed change: one stretch, not two.
        let (source, scale) = match clip.get("raw_path").filter(|v| truthy(v)) {
            Some(raw) if rate != 1.0 => {
                let speed = number(clip.get("speed"), "speed", 0.5, 2.0)?;
                (raw.as_str().ok_or_else(|| py_type_error("argument should be a str or an os.PathLike object"))?, speed)
            }
            _ => (clip_path, 1.0),
        };
        let length = recipe.duration_ms / 1000.0 * scale;
        let mut filters = vec![
            format!("atrim=start={}:duration={}", float_repr(recipe.start_ms / 1000.0 * scale), float_repr(length)),
            "asetpts=PTS-STARTPTS".to_string(),
            "aresample=48000".to_string(),
            "aformat=sample_fmts=flt:channel_layouts=mono".to_string(),
            format!("volume={}dB", float_repr(recipe.gain_db)),
        ];
        if recipe.fade_in_ms != 0.0 {
            filters.push(format!("afade=t=in:st=0:d={}", float_repr(recipe.fade_in_ms / 1000.0 * scale)));
        }
        if recipe.fade_out_ms != 0.0 {
            let fade = recipe.fade_out_ms / 1000.0 * scale;
            filters.push(format!("afade=t=out:st={}:d={}", float_repr((length - fade).max(0.0)), float_repr(fade)));
        }
        if timeline {
            let at = number(clip.get("at_ms"), "at_ms", 0.0, DAY_MS)?;
            let wait = (round_half_even(at * 48.0) - written).max(0);
            if rate * scale != 1.0 {
                filters.push(format!("atempo={}", float_repr(rate * scale)));
            }
            if wait > 0 {
                filters.push(format!("adelay=delays={wait}S:all=1"));
            }
            if i == clips.len() - 1 && pad_to > written {
                filters.push(format!("apad=whole_len={}", pad_to - written));
            }
        } else if recipe.gap_ms != 0.0 {
            filters.push(format!("apad=pad_dur={}", float_repr(recipe.gap_ms / 1000.0)));
        }
        let clip_wav = temp.0.join(format!("{i:06}.wav"));
        let mut args =
            ffmpeg_args(ffmpeg, &["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-af"]);
        args.extend([filters.join(","), "-c:a".into(), "pcm_f32le".into(), clip_wav.to_string_lossy().into_owned()]);
        run_process(&args)?;
        if timeline {
            written += wav_frames(&clip_wav)?;
        }
        progress((i + 1) as f64 / (clips.len() + 1) as f64, &format!("Rendered {}/{} segments", i + 1, clips.len()));
    }
    let listing = temp.0.join("concat.txt");
    let list: String = (0..clips.len()).map(|i| format!("file '{i:06}.wav'\n")).collect();
    std::fs::write(&listing, list).map_err(|e| WorkerError::py("OSError", e))?;
    let mut inputs: Vec<String> = ["-f", "concat", "-safe", "1", "-i"].iter().map(|s| s.to_string()).collect();
    inputs.push(listing.to_string_lossy().into_owned());
    if let Some(background) = background {
        inputs.extend(["-i".into(), background.into()]);
    }
    let mut args = ffmpeg_args(ffmpeg, &["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    args.extend(inputs.iter().cloned());
    if background.is_some() {
        // pan, not aformat: aformat's stereo upmix lowers each channel by 3 dB. amix at 0 dB each (normalize=0), as long as
        // the longer input; no loop, stretch or fade.
        let mix = "[0:a]pan=stereo|c0=c0|c1=c0[v];[1:a]aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo[b];[v][b]amix=inputs=2:duration=longest:normalize=0";
        // Normalising applies one gain to -16 LUFS measured over the whole mix: loudnorm's single pass is dynamic and would
        // swell the bed between lines (its linear mode turns dynamic when the true-peak target cannot be met).
        let lufs = if normalize { loudness(ffmpeg, &inputs, mix)? } else { -16.0 };
        let gain = if lufs.is_finite() { -16.0 - lufs } else { 0.0 };
        // A latency-compensated limiter keeps the sum below full scale without moving the takes.
        args.extend([
            "-filter_complex".into(),
            format!("{mix},volume={gain:.3}dB,alimiter=limit=0.98:level=0:latency=1"),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
        ]);
    } else {
        if normalize {
            // asetpts: loudnorm emits 100 ms frames, so M4A and Opus would report a length rounded up to them
            args.extend(["-af".into(), "loudnorm=I=-16:TP=-1.5:LRA=11,asetpts=N/SR/TB".into()]);
        }
        args.extend(["-ar".into(), "48000".into(), "-ac".into(), "1".into()]);
    }
    args.extend(codec.iter().map(|s| s.to_string()));
    args.push(partial.to_string_lossy().into_owned());
    run_process(&args)?;
    let mut info = probe(&partial.to_string_lossy(), Some(ffmpeg))?;
    replace_with_retry(partial, final_path).map_err(|e| WorkerError::py("OSError", e))?;
    info["path"] = Value::from(resolve(final_path).to_string_lossy().into_owned());
    Ok(info)
}
