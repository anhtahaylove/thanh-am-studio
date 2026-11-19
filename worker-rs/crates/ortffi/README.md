# ortffi

Hand-written bindings to the ONNX Runtime C API, pinned to **ONNX Runtime 1.31.1 (C API version 31)**
and loaded at run time from one DLL path. Spike for the Thanh Am Studio Rust worker migration
(owner decision Q11: own bindings instead of the `ort` crate). Windows only, no dependencies.

## ABI pin

| What | Value |
|---|---|
| Runtime | `onnxruntime.dll` **1.31.1** (the wheel the Python runtime ships, `capi\onnxruntime.dll`, 19,288,888 bytes) |
| C API version | **31** (`ORT_API_VERSION`) |
| Header | `third_party/onnxruntime_c_api.h` + `onnxruntime_error_code.h` at tag `v1.31.1`, commit `6af1a932e2286d5c58166085d24c68783033edee` (MIT, see `third_party/SOURCE.md`) |

`Api::load` (and so `Env::load`) refuses anything else:

1. The path must be absolute (`LoadError::NotAbsolute`). The DLL is loaded with
   `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)`: the DLL's own
   folder, then System32. Never `PATH`, the current directory or the application directory. The call
   runs inside `without_error_dialogs` (which the worker's other DLL loads use too), so Windows fails it
   instead of showing a modal box such as "Bad Image".
2. `LoadFailed { os_error }`: missing file, not a PE file, missing dependency.
3. `MissingExport`: no `OrtGetApiBase`, so not an ONNX Runtime.
4. `BadApiBase`: `OrtGetApiBase()` or `GetVersionString()` returned null.
5. `VersionMismatch { found, expected }`: `GetVersionString() != "1.31.1"`.
6. `ApiUnavailable`: `GetApi(31)` returned null.

Every `LoadError` has `worker_code() == "RUNTIME_MISSING"` (`ortffi::RUNTIME_MISSING`); `Error::worker_code()`
returns it for `Error::Load` and `WORKER_ERROR` for `Error::Ort`.
The DLL is never unloaded (ORT owns thread pools that must not outlive their code).

## Layout

```
src/lib.rs        re-exports
src/error.rs      Error, LoadError, OrtError (ORT's code + message), ErrorCode; no unsafe
src/raw/          ALL unsafe code
  sys.rs          opaque types, enum values, OrtApiBase
  table.rs        GENERATED: prefix of struct OrtApi (slots 0..=130), USED_SLOTS, offset test
  loader.rs       LoadLibraryExW + the ABI pin checks
  mod.rs          Api (one safe method per C call), Handle<K> (RAII, Drop releases), Element
src/safe.rs       Env, SessionOptions, Session, Value; #![forbid(unsafe_code)]
tools/gen_api_table.py   header -> src/raw/table.rs
tools/gen_fixtures.py    records Python onnxruntime 1.31.1 inputs and outputs (row F)
fixtures/         recorded .npy files + PROVENANCE.txt (model SHA-256, versions)
tests/            table_layout, load, errors, fixtures, stress
```

Soundness rests on the handle types: a `Handle<'a, K>` is a non-null owned pointer released exactly
once, tensors made from host memory carry the lifetime of the borrowed slice, and `Element` is an
`unsafe trait` implemented only for `f32`, `i32`, `i64`. The raw `Api` methods are therefore safe to
call; the safe layer adds ergonomics (names as `&str`, option builders, cached input/output
descriptions, `Arc` so a `Session` keeps the environment alive).

## API surface

Safe layer (`ortffi::*`):

```rust
let env = Env::load(Path::new(r"C:\...\onnxruntime.dll"), "logid")?;     // Error::Load -> RUNTIME_MISSING
let mut o = SessionOptions::new(&env)?;
o.graph_optimization_level(GraphOptimizationLevel::All)?   // also: execution_mode, intra_op_threads,
 .inter_op_threads(1)?                                      //       inter_op_threads, cpu_mem_arena,
 .config_entry("session.intra_op.allow_spinning", "0")?;    //       log_severity_level, config_entry
let session = Session::from_file(&env, Path::new(r"...\model.onnx"), &o)?;   // UTF-16 path
session.inputs() / session.outputs()       // &[IoInfo { name, tensor: Option<TensorInfo{element, shape}> }]
let x = env.tensor(&samples_f32, &[n, 576])?;          // f32, i64, i32; borrows the slice, no copy
let outs = session.run(&[("input", &x), ("h", &h)], &["speech_probs", "hn"])?;   // Vec<Value<'static>>
outs[0].as_slice::<f32>()? / to_vec::<f32>()? / info()? / element_type()?
```

`Env`, `Session` are `Send + Sync` (ORT allows concurrent `Run`); `Value` and `SessionOptions` are `Send`.

Raw layer entries bound (`OrtApi` slot in brackets): `GetErrorCode` [1], `GetErrorMessage` [2], `CreateEnv` [3],
`CreateSession` [7], `Run` [9], `CreateSessionOptions` [10], `SetSessionExecutionMode` [13],
`EnableCpuMemArena` [18], `DisableCpuMemArena` [19], `SetSessionLogSeverityLevel` [22],
`SetSessionGraphOptimizationLevel` [23], `SetIntraOpNumThreads` [24], `SetInterOpNumThreads` [25],
`SessionGetInputCount` [30], `SessionGetOutputCount` [31], `SessionGetInputTypeInfo` [33],
`SessionGetOutputTypeInfo` [34], `SessionGetInputName` [36], `SessionGetOutputName` [37],
`CreateTensorWithDataAsOrtValue` [49], `IsTensor` [50], `GetTensorMutableData` [51],
`CastTypeInfoToTensorInfo` [55], `GetTensorElementType` [60], `GetDimensionsCount` [61], `GetDimensions` [62],
`GetTensorShapeElementCount` [64], `GetTensorTypeAndShape` [65], `CreateCpuMemoryInfo` [69],
`AllocatorFree` [76], `GetAllocatorWithDefaultOptions` [78], `ReleaseEnv/Status/MemoryInfo/Session/Value`
[92-96], `ReleaseTypeInfo` [98], `ReleaseTensorTypeAndShapeInfo` [99], `ReleaseSessionOptions` [100],
`AddSessionConfigEntry` [130]. Plus `OrtGetApiBase` / `OrtApiBase::{GetApi, GetVersionString}`.

Notes on ORT behaviour surfaced as is (not papered over):
`Run` with a missing input fails inside the first kernel that reads it with `ORT_FAIL`
("Missing Input: ..."), not `ORT_INVALID_ARGUMENT`; unknown names, wrong dtype and wrong rank are
`ORT_INVALID_ARGUMENT`; a missing model is `ORT_NO_SUCHFILE`; a corrupt model is `ORT_INVALID_PROTOBUF`.

## Tests

```
cargo test                                   # all; needs the repo runtime, see below
ORTFFI_SESSION_CYCLES=10000 cargo test --release --test stress -- --nocapture   # the plan's full count (~75 s)
cargo clippy --all-targets -- -D warnings
```

Paths default to the repo layout (`outputs\wt\rust-ortffi\spikes\ortffi` inside the checkout's
`outputs\`) and can be overridden with `ORTFFI_RUNTIME` (`...\runtime\python`), `ORTFFI_DLL`,
`ORTFFI_SHERPA_DLL` (an ORT 1.28.2 DLL for the wrong-version test), `ORTFFI_SILERO`, `ORTFFI_VIENEU`
(the `vieneu-v3` model folder). A missing path fails the test; nothing is skipped silently.

Regenerate the fixtures (they are committed, 3.7 MB; the models are not):

```
runtime\python\python.exe -I tools\gen_fixtures.py
```

`fixtures.rs` replays each recording through `ortffi` with the same `SessionOptions` as the app's Python
code (Silero: `faster_whisper/vad.py`; VieNeu: `onnx_runtime_lite.py`) and demands byte-identical outputs.
`comparison_detects_a_perturbed_input` is the negative control.

## Upkeep: what to change on an ORT bump

1. Get the new DLL and header: `onnxruntime_c_api.h` and `onnxruntime_error_code.h` at the new tag, update
   `third_party/SOURCE.md` (tag, commit, SHA-256).
2. `src/raw/sys.rs`: `ORT_VERSION` and `ORT_API_VERSION` (the loader check, the error text, the tests and
   `tests/load.rs` expectations follow from these two constants; `README` and the fake-DLL version strings in
   `tests/support/fake_ort.rs`, `tests/load.rs` mention "1.31.1"/"1.30.0" literally).
3. `python -I tools/gen_api_table.py > src/raw/table.rs`. Review the diff: slot numbers of used entries must
   not move silently. ORT only appends to `OrtApi`, so within one major line they should not; a changed
   signature in the header means editing `USED` in the script.
4. `cargo test --test table_layout` re-parses the header on its own and must agree with the generated table;
   the member count assertion (`428`) changes whenever ORT appends entries: update it.
5. Regenerate the fixtures with the **new** Python wheel (`tools/gen_fixtures.py` asserts the version) and
   rerun `cargo test`. Any byte difference is a finding (row F is E0).
6. Rerun the ORT-using rows (STT VAD, TTS engine, clone conditioning).
7. Check the session options the Python code uses (`faster_whisper/vad.py`, `vieneu/.../onnx_runtime_lite.py`)
   still match `tests/common/mod.rs` and `tools/gen_fixtures.py`.

If a ported component needs another C API entry: add it to `USED` in `tools/gen_api_table.py` (name and
Rust signature from the header), regenerate, add one method to `raw::Api` with a `// SAFETY:` comment, and
expose it from `safe.rs` only if the worker needs it. Expected cost per bump: 0.5-1.5 person-days.
