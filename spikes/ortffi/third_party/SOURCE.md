# Provenance of the vendored ONNX Runtime headers

- Upstream: https://github.com/microsoft/onnxruntime (MIT, see `LICENSE-onnxruntime`)
- Tag: `v1.31.1`
- Tag commit: `6af1a932e2286d5c58166085d24c68783033edee` (resolved with `gh api repos/microsoft/onnxruntime/git/ref/tags/v1.31.1`)
- Files (fetched from `raw.githubusercontent.com/microsoft/onnxruntime/<commit>/...`):
  - `include/onnxruntime/core/session/onnxruntime_c_api.h`
    SHA-256 `43d584f596ef66820421317df32a79a95fc1d39ee46cb3971a870c08d8ba4baa`
  - `include/onnxruntime/core/session/onnxruntime_error_code.h`
    SHA-256 `5ce3b054e798eced8d14f5b86e98692fd33470463f96194ce0700a2d53dd8721`
  - `LICENSE` (saved as `LICENSE-onnxruntime`)
- `ORT_API_VERSION` in the header: 31.

The headers are used only as the layout reference: `tools/gen_api_table.py` reads the `OrtApi`
member order and `tests/table_layout.rs` re-checks it. Nothing here is compiled.
