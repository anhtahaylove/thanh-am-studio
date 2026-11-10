# Measured local smoke results

Captured 2026-11-10 on Windows 11 x64, CPU path, private Python 3.11.18, FFmpeg 9.0.2.

| Operation | Input | Observed result |
|---|---|---|
| `health` | Installed CPU environment | Python 3.11.18; numpy, soundfile, VieNeu, faster-whisper and Hugging Face Hub imported; FFmpeg discovered; `ready: true`. |
| `download` | VieNeu v3 pinned revision `61b85e3d937fbbacb387714180e8182823512523` | 16 artifacts verified, approximately 637 MB, atomic `installed.json` written. |
| `tts` | Vietnamese sentence fixture, VieNeu v3 ONNX FP32 | Result WAV at 48 kHz, 4,160 ms. Output was non-empty and finite; file finalized atomically. |
| `download` | faster-whisper small pinned revision `536b0662742c02347bc0e980a01041f333bce120` | 4 artifacts verified, approximately 486 MB, atomic `installed.json` written. |
| `stt` | Generated TTS WAV, `language=vi` | One segment returned from 0.0–4.16s, language `vi`; transcript is an engine output and not a reference-quality score. |
| `render` | 1 kHz WAV fixture, 100–600 ms trim, 50 ms fades, 250 ms gap | 750 ms 48 kHz output; no partial output remained. |

The smoke validates the worker process and CPU inference path only. It does not establish CUDA support, quality benchmarks, long-file throughput, installer packaging, or model redistribution rights. HF requests were unauthenticated; no token was printed or stored.
