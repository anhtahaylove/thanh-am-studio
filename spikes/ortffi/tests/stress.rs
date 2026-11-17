//! Drop order and leaks under repeated create / run / release (plan §3: 10,000 cycles, no handle
//! growth). One test function, so nothing else in this process creates handles or threads.

mod common;

use common::*;
use ortffi::{Env, Session, SessionOptions};
use std::ffi::c_void;
use std::time::Instant;

#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set: usize,
    working_set: usize,
    quota_peak_paged_pool: usize,
    quota_paged_pool: usize,
    quota_peak_non_paged_pool: usize,
    quota_non_paged_pool: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn GetProcessHandleCount(process: *mut c_void, count: *mut u32) -> i32;
    fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
}

/// (open handles, private commit in bytes) of this process.
fn usage() -> (u32, usize) {
    let mut handles = 0u32;
    let mut mem =
        ProcessMemoryCounters { cb: std::mem::size_of::<ProcessMemoryCounters>() as u32, ..Default::default() };
    // SAFETY: the pseudo-handle of the current process is always valid; both out-pointers are valid
    // and `mem.cb` is its size.
    unsafe {
        assert_ne!(GetProcessHandleCount(GetCurrentProcess(), &mut handles), 0);
        assert_ne!(K32GetProcessMemoryInfo(GetCurrentProcess(), &mut mem, mem.cb), 0);
    }
    (handles, mem.pagefile_usage)
}

const CYCLES: usize = 10_000;

/// Full session create/run/drop cycles cost ~7 ms each; the default keeps `cargo test` quick.
/// `ORTFFI_SESSION_CYCLES=10000` runs the plan's full count.
fn session_cycle_count() -> usize {
    std::env::var("ORTFFI_SESSION_CYCLES").ok().and_then(|v| v.parse().ok()).unwrap_or(1_000)
}

/// One session, many tensors: create three tensors, run, read an output, drop everything.
fn run_cycles(env: &Env, session: &Session, n: usize) {
    let (frames, state) = (vec![0.02f32; 576 * 4], vec![0.0f32; 128]);
    for i in 0..n {
        let frames_t = env.tensor(&frames, &[4, 576]).unwrap();
        let h = env.tensor(&state, &[1, 1, 128]).unwrap();
        let c = env.tensor(&state, &[1, 1, 128]).unwrap();
        let out = session.run(&[("input", &frames_t), ("h", &h), ("c", &c)], &["speech_probs", "hn"]).unwrap();
        assert_eq!(out[0].as_slice::<f32>().unwrap().len(), 4, "cycle {i}");
    }
}

/// Everything per cycle: options, session, run, drop (the Env stays, as in the worker).
fn session_cycles(env: &Env, n: usize) {
    for _ in 0..n {
        let session = Session::from_file(env, &silero_model(), &silero_options(env)).unwrap();
        run_cycles(env, &session, 1);
    }
}

#[test]
fn ten_thousand_cycles_do_not_grow_handles_or_memory() {
    let env = env();
    let session = silero_session(&env);

    // Warm up: lazy initialisation (thread pool, allocator arenas, kernel caches) happens here.
    run_cycles(&env, &session, 200);
    session_cycles(&env, 50);

    let (handles0, commit0) = usage();
    let t = Instant::now();
    run_cycles(&env, &session, CYCLES);
    let (handles1, commit1) = usage();
    println!(
        "run cycles:     {CYCLES} in {:.1?}; handles {handles0} -> {handles1}; private commit {} KiB -> {} KiB",
        t.elapsed(),
        commit0 / 1024,
        commit1 / 1024
    );
    assert!(handles1 <= handles0 + 2, "handle growth {handles0} -> {handles1}");
    assert!(commit1 <= commit0 + (4 << 20), "private commit grew by {} KiB", commit1.saturating_sub(commit0) / 1024);

    let n = session_cycle_count();
    let t = Instant::now();
    session_cycles(&env, n);
    let (handles2, commit2) = usage();
    println!(
        "session cycles: {n} in {:.1?}; handles {handles1} -> {handles2}; private commit {} KiB -> {} KiB",
        t.elapsed(),
        commit1 / 1024,
        commit2 / 1024
    );
    assert!(handles2 <= handles1 + 2, "handle growth {handles1} -> {handles2}");
    assert!(commit2 <= commit1 + (8 << 20), "private commit grew by {} KiB", commit2.saturating_sub(commit1) / 1024);

    // Whole runtime cycles: the last `Env` drop releases the OrtEnv (the DLL itself stays loaded).
    let t = Instant::now();
    for _ in 0..200 {
        let env = Env::load(&ort_dll(), "cycle").unwrap();
        let options = SessionOptions::new(&env).unwrap();
        let session = Session::from_file(&env, &silero_model(), &options).unwrap();
        run_cycles(&env, &session, 1);
    }
    let (handles3, commit3) = usage();
    println!(
        "env cycles:     200 in {:.1?}; handles {handles2} -> {handles3}; private commit {} KiB -> {} KiB",
        t.elapsed(),
        commit2 / 1024,
        commit3 / 1024
    );
    assert!(handles3 <= handles2 + 2, "handle growth {handles2} -> {handles3}");
}
