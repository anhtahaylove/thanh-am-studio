"""Generates src/raw/table.rs from third_party/onnxruntime_c_api.h.

Usage (from the crate root; stdlib only):
    python -I tools/gen_api_table.py > src/raw/table.rs
    python -I tools/gen_api_table.py --list      # "<index> <name>" for every OrtApi member

The `OrtApi` struct is a table of function pointers in declaration order. This script finds
the slot of each entry the crate calls (USED below, with its hand-written Rust signature),
and emits a `#[repr(C)]` struct that covers the slots up to the last used one. Unused slots
are `usize` placeholders. The struct is only ever read through the pointer that
`OrtApiBase::GetApi(31)` returns, so truncating it is sound.

On an ORT bump: replace third_party/*.h, rerun this script, review the diff, run `cargo test`
(tests/table_layout.rs re-parses the header independently).
"""
import re
import sys

HEADER = "third_party/onnxruntime_c_api.h"

# name -> Rust parameter list and return type. `S` = *mut OrtStatus (null means success).
S = "*mut OrtStatus"
USED = {
    "GetErrorCode": "(status: *const OrtStatus) -> i32",
    "GetErrorMessage": "(status: *const OrtStatus) -> *const c_char",
    "CreateEnv": f"(level: i32, logid: *const c_char, out: *mut *mut OrtEnv) -> {S}",
    "CreateSession": f"(env: *const OrtEnv, model_path: *const u16, options: *const OrtSessionOptions, out: *mut *mut OrtSession) -> {S}",
    "Run": f"(session: *mut OrtSession, run_options: *const OrtRunOptions, input_names: *const *const c_char, inputs: *const *const OrtValue, input_len: usize, output_names: *const *const c_char, output_names_len: usize, outputs: *mut *mut OrtValue) -> {S}",
    "CreateSessionOptions": f"(out: *mut *mut OrtSessionOptions) -> {S}",
    "SetSessionExecutionMode": f"(options: *mut OrtSessionOptions, mode: i32) -> {S}",
    "EnableCpuMemArena": f"(options: *mut OrtSessionOptions) -> {S}",
    "DisableCpuMemArena": f"(options: *mut OrtSessionOptions) -> {S}",
    "SetSessionLogSeverityLevel": f"(options: *mut OrtSessionOptions, level: i32) -> {S}",
    "SetSessionGraphOptimizationLevel": f"(options: *mut OrtSessionOptions, level: i32) -> {S}",
    "SetIntraOpNumThreads": f"(options: *mut OrtSessionOptions, threads: i32) -> {S}",
    "SetInterOpNumThreads": f"(options: *mut OrtSessionOptions, threads: i32) -> {S}",
    "SessionGetInputCount": f"(session: *const OrtSession, out: *mut usize) -> {S}",
    "SessionGetOutputCount": f"(session: *const OrtSession, out: *mut usize) -> {S}",
    "SessionGetInputTypeInfo": f"(session: *const OrtSession, index: usize, out: *mut *mut OrtTypeInfo) -> {S}",
    "SessionGetOutputTypeInfo": f"(session: *const OrtSession, index: usize, out: *mut *mut OrtTypeInfo) -> {S}",
    "SessionGetInputName": f"(session: *const OrtSession, index: usize, allocator: *mut OrtAllocator, out: *mut *mut c_char) -> {S}",
    "SessionGetOutputName": f"(session: *const OrtSession, index: usize, allocator: *mut OrtAllocator, out: *mut *mut c_char) -> {S}",
    "CreateTensorWithDataAsOrtValue": f"(info: *const OrtMemoryInfo, data: *mut c_void, data_len: usize, shape: *const i64, shape_len: usize, elem_type: i32, out: *mut *mut OrtValue) -> {S}",
    "IsTensor": f"(value: *const OrtValue, out: *mut i32) -> {S}",
    "GetTensorMutableData": f"(value: *mut OrtValue, out: *mut *mut c_void) -> {S}",
    "CastTypeInfoToTensorInfo": f"(type_info: *const OrtTypeInfo, out: *mut *const OrtTensorTypeAndShapeInfo) -> {S}",
    "GetTensorElementType": f"(info: *const OrtTensorTypeAndShapeInfo, out: *mut i32) -> {S}",
    "GetDimensionsCount": f"(info: *const OrtTensorTypeAndShapeInfo, out: *mut usize) -> {S}",
    "GetDimensions": f"(info: *const OrtTensorTypeAndShapeInfo, dims: *mut i64, dims_len: usize) -> {S}",
    "GetTensorShapeElementCount": f"(info: *const OrtTensorTypeAndShapeInfo, out: *mut usize) -> {S}",
    "GetTensorTypeAndShape": f"(value: *const OrtValue, out: *mut *mut OrtTensorTypeAndShapeInfo) -> {S}",
    "CreateCpuMemoryInfo": f"(alloc_type: i32, mem_type: i32, out: *mut *mut OrtMemoryInfo) -> {S}",
    "AllocatorFree": f"(allocator: *mut OrtAllocator, p: *mut c_void) -> {S}",
    "GetAllocatorWithDefaultOptions": f"(out: *mut *mut OrtAllocator) -> {S}",
    "ReleaseEnv": "(env: *mut OrtEnv)",
    "ReleaseStatus": "(status: *mut OrtStatus)",
    "ReleaseMemoryInfo": "(info: *mut OrtMemoryInfo)",
    "ReleaseSession": "(session: *mut OrtSession)",
    "ReleaseValue": "(value: *mut OrtValue)",
    "ReleaseTypeInfo": "(type_info: *mut OrtTypeInfo)",
    "ReleaseTensorTypeAndShapeInfo": "(info: *mut OrtTensorTypeAndShapeInfo)",
    "ReleaseSessionOptions": "(options: *mut OrtSessionOptions)",
    "AddSessionConfigEntry": f"(options: *mut OrtSessionOptions, key: *const c_char, value: *const c_char) -> {S}",
}


def api_members(path):
    src = open(path, encoding="utf-8").read()
    start = src.index("\nstruct OrtApi {") + 1
    body_start = src.index("{", start) + 1
    depth, i = 1, body_start
    while depth:
        depth += (src[i] == "{") - (src[i] == "}")
        i += 1
    body = src[body_start : i - 1]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    body = re.sub(r"//[^\n]*", "", body)
    names = []
    for stmt in body.split(";"):
        s = " ".join(stmt.split())
        if not s:
            continue
        m = re.match(r"ORT_API2_STATUS\(\s*(\w+)", s)
        if m:
            names.append(m.group(1))
            continue
        m = re.match(r"ORT_CLASS_RELEASE\(\s*(\w+)\s*\)", s)
        if m:
            names.append("Release" + m.group(1))
            continue
        m = re.match(r"ORT_API_T\(\s*[^,]+,\s*(\w+)", s)
        if m:
            names.append(m.group(1))
            continue
        m = re.search(r"\(\s*ORT_API_CALL\s*\*\s*(\w+)\s*\)", s)
        if m:
            names.append(m.group(1))
            continue
        raise SystemExit("unparsed OrtApi member: " + s[:120])
    return names


def main():
    names = api_members(HEADER)
    if "--list" in sys.argv:
        for n, name in enumerate(names):
            print(n, name)
        return
    index = {name: n for n, name in enumerate(names)}
    missing = [n for n in USED if n not in index]
    if missing:
        raise SystemExit("not in header: " + ", ".join(missing))
    last = max(index[n] for n in USED)
    out = [
        "//! The `OrtApi` function table up to the last slot this crate uses.",
        "//!",
        "//! GENERATED by `tools/gen_api_table.py` from `third_party/onnxruntime_c_api.h` (ORT v1.31.1).",
        "//! Do not edit by hand: change `USED` in the script and regenerate.",
        "",
        "#![allow(non_snake_case, missing_docs, dead_code)]",
        "",
        "use super::sys::*;",
        "use std::ffi::{c_char, c_void};",
        "",
        "/// Slots of the `OrtApi` table that are typed here: `(name, index)`.",
        "pub const USED_SLOTS: &[(&str, usize)] = &[",
    ]
    for name in sorted(USED, key=index.get):
        out.append(f'    ("{name}", {index[name]}),')
    out += [
        "];",
        "",
        f"/// Number of slots covered by [`OrtApi`] (index of the last used slot + 1).",
        f"pub const SLOT_COUNT: usize = {last + 1};",
        "",
        "/// Prefix of `struct OrtApi`. Only ever used behind a pointer returned by ORT.",
        "#[repr(C)]",
        "pub struct OrtApi {",
    ]
    for n in range(last + 1):
        name = names[n]
        if name in USED:
            out.append(f'    pub {name}: unsafe extern "system" fn{USED[name]},')
        else:
            out.append(f"    _slot_{n}: usize, // {name}")
    out += [
        "}",
        "",
        "#[cfg(test)]",
        "mod layout {",
        "    use super::*;",
        "    use std::mem::{offset_of, size_of};",
        "",
        "    #[test]",
        "    fn used_slots_sit_at_their_header_offsets() {",
        "        let word = size_of::<usize>();",
        "        assert_eq!(size_of::<OrtApi>(), SLOT_COUNT * word);",
    ]
    for name in sorted(USED, key=index.get):
        offset = "word" if index[name] == 1 else f"{index[name]} * word"
        out.append(f"        assert_eq!(offset_of!(OrtApi, {name}), {offset}, \"{name}\");")
    out += ["    }", "}", ""]
    sys.stdout.write("\n".join(out))


main()
