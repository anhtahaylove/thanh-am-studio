//! Spike S1 skeleton: `thanham-diarize.exe`.
//!
//! Loads its own folder (sherpa-onnx 2.0.1 `sherpa-onnx-c-api.dll` + sherpa's ONNX Runtime 1.28.2 `onnxruntime.dll`, both next to
//! the exe), builds the offline speaker-diarization pipeline from the two models of `models.json` (pyannote segmentation 3.0 and
//! 3D-Speaker CAM++) and runs it once on two seconds of silence.
//!
//! usage: thanham-diarize <model-dir with segmentation/model.onnx and embedding/model.onnx>
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::process::ExitCode;

#[repr(C)]
struct PyannoteCfg {
    model: *const c_char,
    window_shift_ratio: f32,
}
#[repr(C)]
struct SegmentationCfg {
    pyannote: PyannoteCfg,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}
#[repr(C)]
struct EmbeddingCfg {
    model: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}
#[repr(C)]
struct ClusteringCfg {
    num_clusters: i32,
    threshold: f32,
    compute_confidence: i32,
}
#[repr(C)]
struct DiarizationCfg {
    segmentation: SegmentationCfg,
    embedding: EmbeddingCfg,
    clustering: ClusteringCfg,
    min_duration_on: f32,
    min_duration_off: f32,
}

extern "C" {
    fn SherpaOnnxGetVersionStr() -> *const c_char;
    fn SherpaOnnxCreateOfflineSpeakerDiarization(config: *const DiarizationCfg) -> *const c_void;
    fn SherpaOnnxDestroyOfflineSpeakerDiarization(sd: *const c_void);
    fn SherpaOnnxOfflineSpeakerDiarizationGetSampleRate(sd: *const c_void) -> i32;
    fn SherpaOnnxOfflineSpeakerDiarizationProcess(sd: *const c_void, samples: *const f32, n: i32) -> *const c_void;
    fn SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(r: *const c_void) -> i32;
    fn SherpaOnnxOfflineSpeakerDiarizationDestroyResult(r: *const c_void);
}

fn main() -> ExitCode {
    // SAFETY: returns a static NUL-terminated string.
    let version = unsafe { CStr::from_ptr(SherpaOnnxGetVersionStr()) }.to_string_lossy().into_owned();
    println!("{{\"step\":\"load\",\"ok\":true,\"sherpa_version\":\"{version}\"}}");
    let Some(dir) = std::env::args().nth(1) else {
        // Load-only mode: the folder's DLLs resolved, which is all a clean-machine smoke check needs without models.
        println!("{{\"event\":\"health\",\"ok\":true,\"models\":false}}");
        return ExitCode::SUCCESS;
    };
    let seg = CString::new(Path::new(&dir).join("segmentation").join("model.onnx").to_string_lossy().as_bytes()).unwrap();
    let emb = CString::new(Path::new(&dir).join("embedding").join("model.onnx").to_string_lossy().as_bytes()).unwrap();
    let cpu = CString::new("cpu").unwrap();
    let config = DiarizationCfg {
        segmentation: SegmentationCfg { pyannote: PyannoteCfg { model: seg.as_ptr(), window_shift_ratio: 0.1 }, num_threads: 1, debug: 0, provider: cpu.as_ptr() },
        embedding: EmbeddingCfg { model: emb.as_ptr(), num_threads: 1, debug: 0, provider: cpu.as_ptr() },
        clustering: ClusteringCfg { num_clusters: -1, threshold: 0.5, compute_confidence: 0 },
        min_duration_on: 0.3,
        min_duration_off: 0.5,
    };
    // SAFETY: `config` and the CStrings it points to outlive the call; the returned handle is destroyed below.
    let sd = unsafe { SherpaOnnxCreateOfflineSpeakerDiarization(&config) };
    if sd.is_null() {
        println!("{{\"event\":\"health\",\"ok\":false,\"error\":\"create diarization failed\"}}");
        return ExitCode::from(1);
    }
    // SAFETY: `sd` is a live handle; `samples` holds `n` floats.
    let (rate, segments) = unsafe {
        let rate = SherpaOnnxOfflineSpeakerDiarizationGetSampleRate(sd);
        let samples = vec![0f32; rate as usize * 2];
        let result = SherpaOnnxOfflineSpeakerDiarizationProcess(sd, samples.as_ptr(), samples.len() as i32);
        let n = if result.is_null() { -1 } else { SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result) };
        if !result.is_null() {
            SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
        }
        SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
        (rate, n)
    };
    println!("{{\"step\":\"process\",\"ok\":{},\"sample_rate\":{rate},\"segments_on_silence\":{segments}}}", segments >= 0);
    println!("{{\"event\":\"health\",\"ok\":{}}}", segments >= 0);
    if segments >= 0 { ExitCode::SUCCESS } else { ExitCode::from(1) }
}
