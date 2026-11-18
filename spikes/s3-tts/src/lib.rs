//! Thanh Am Studio Rust migration, spike S3: the VieNeu v3 Turbo preset TTS engine in Rust, E0 (bitwise identical to Python).
//!
//! The engine's numpy head (`onnx_runtime_lite.py`) is reused rather than re-implemented where numpy itself delegates:
//! the matrix-vector products call the OpenBLAS DLL numpy ships (`blas`), `np.exp` is numpy's own AVX2/FMA3 algorithm or the system `expf`
//! on older CPUs (`exp`), the sorts are numpy's x86-simd-sort compiled from numpy's sources or its generic introsort (`sort`), and the
//! legacy global `RandomState` is the same Mersenne Twister (`mt19937`).

#![cfg(windows)]

pub mod audio;
pub mod blas;
pub mod engine;
pub mod exp;
pub mod front;
pub mod head;
pub mod mt19937;
pub mod np;
pub mod npy;
pub mod sort;
