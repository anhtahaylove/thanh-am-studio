# Implementation record

Pattern: independent local desktop core with job-oriented engine adapters, informed by VieNeu SDK / AI Audio Studio workflows and evidence-driven investigation of the supplied packaged applications.

## Observable seams under test
- Rust project repository: persistence, revision conflict, validation and asset integrity.
- Rust job queue: claim/cancel/retry/restart, worker process boundaries, immutable takes.
- Python JSON-lines worker: structured failure, real audio rendering, offline model path enforcement.
- UI text/subtitle/edit recipe functions and complete user interactions.

## Release gates
M0 evidence and engine feasibility; M1 usable TTS; M2 TTS+STT; M3 resilience and 60-minute/500-segment fixture; M4 public release from verified revision.

No gate is satisfied by a mock alone. Runtime/model downloads, real synthesis, listening quality, clean-machine installation, licensing and publication are reported separately. Public release waits for these gates; no API keys or personal samples are committed.
