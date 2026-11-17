/* libiomp5md.dll replacement: the LLVM OpenMP runtime (libomp.dll) plus five MSVC OpenMP entry points.
 *
 * Why it exists: the torch and ctranslate2 wheels ship Intel's OpenMP runtime (libiomp5md.dll), which is under the
 * Intel End User License Agreement for Developer Tools. LLVM's libomp.dll is a drop-in replacement for everything they
 * import from it except five MSVC /openmp ("vcomp") entry points, which no LLVM build exports. Without them
 * torch_cpu.dll and ctranslate2.dll fail to load (WinError 127).
 *
 * This DLL keeps the name libiomp5md.dll so the importers bind to it. setup-runtime.ps1 builds it against the
 * conda-forge llvm-openmp package pinned there ($LlvmOpenmpUrl, 23.1.5 h49e36cd_0 when this was written) and puts
 * libomp.dll next to every copy. Every other export is a forwarder to libomp.dll, written into a .def at build time
 * from the package's import library (libomp.lib), so a new pin re-forwards automatically. On every build
 * setup-runtime.ps1 runs semantics_test.c against this DLL and checks that every libiomp5md.dll import in the runtime
 * is exported here, so a torch or ctranslate2 bump that needs another vcomp entry point fails the build, not the app.
 *
 * Mapping onto libomp's public __kmpc_* API, following the call sequence MSVC emits:
 *   _vcomp_fork(if, nargs, fn, args...)    __kmpc_fork_call, through a microtask that calls fn(args...) via
 *                                          vcomp_call.asm; if(0) runs fn inside __kmpc_serialized_parallel
 *   _vcomp_set_num_threads(n)              __kmpc_push_num_threads (for the next fork only, like num_threads(n))
 *   _vcomp_barrier()                       __kmpc_barrier
 *   _vcomp_for_static_simple_init_i8(...)  __kmpc_for_static_init_8 with kmp_sch_static (inclusive bounds)
 *   _vcomp_for_static_end()                __kmpc_for_static_fini
 * Written from libomp's API and the MSVC call sequence; no Intel, Microsoft or Wine code was copied. */
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct { int32_t r1, flags, r2, r3; const char *psource; } ident_t;
typedef void (*kmpc_micro)(int32_t *, int32_t *, ...);
__declspec(dllimport) void __kmpc_fork_call(ident_t *, int32_t, kmpc_micro, ...);
__declspec(dllimport) void __kmpc_serialized_parallel(ident_t *, int32_t);
__declspec(dllimport) void __kmpc_end_serialized_parallel(ident_t *, int32_t);
__declspec(dllimport) int32_t __kmpc_global_thread_num(ident_t *);
__declspec(dllimport) void __kmpc_push_num_threads(ident_t *, int32_t, int32_t);
__declspec(dllimport) void __kmpc_barrier(ident_t *, int32_t);
__declspec(dllimport) void __kmpc_for_static_init_8(ident_t *, int32_t, int32_t, int32_t *, int64_t *, int64_t *, int64_t *, int64_t, int64_t);
__declspec(dllimport) void __kmpc_for_static_fini(ident_t *, int32_t);

void vcomp_call(void *fn, int nargs, void **argv); /* vcomp_call.asm */

static ident_t loc = {0, 2 /* KMP_IDENT_KMPC */, 0, 0, ";vcomp_shim;unknown;0;0;;"};
enum { MAX_ARGS = 64 }; /* one per captured variable; the largest call passes 9 in torch_cpu.dll, 5 in ctranslate2.dll */

static void micro(int32_t *gtid, int32_t *btid, void *fn, intptr_t nargs, void **argv) {
    (void)gtid; (void)btid;
    vcomp_call(fn, (int)nargs, argv);
}

__declspec(dllexport) void _vcomp_fork(int ifval, int nargs, void *fn, ...) {
    void *argv[MAX_ARGS];
    va_list ap;
    int i;
    if (nargs < 0 || nargs > MAX_ARGS) abort();
    va_start(ap, fn);
    for (i = 0; i < nargs; i++) argv[i] = va_arg(ap, void *); /* raw 8-byte slots; doubles keep their bits */
    va_end(ap);
    if (ifval) {
        __kmpc_fork_call(&loc, 3, (kmpc_micro)micro, fn, (intptr_t)nargs, argv);
    } else {
        int32_t gtid = __kmpc_global_thread_num(&loc), zero = 0;
        __kmpc_serialized_parallel(&loc, gtid);
        micro(&gtid, &zero, fn, nargs, argv);
        __kmpc_end_serialized_parallel(&loc, gtid);
    }
}

__declspec(dllexport) void _vcomp_set_num_threads(int n) {
    if (n > 0) __kmpc_push_num_threads(&loc, __kmpc_global_thread_num(&loc), n);
}

__declspec(dllexport) void _vcomp_barrier(void) {
    __kmpc_barrier(&loc, __kmpc_global_thread_num(&loc));
}

/* Inclusive [first, last] with a positive step magnitude; increment selects the direction. */
__declspec(dllexport) void _vcomp_for_static_simple_init_i8(int64_t first, int64_t last, int64_t step, int increment,
                                                            int64_t *begin, int64_t *end) {
    int32_t lastiter = 0;
    int64_t lo = first, hi = last, stride = 0, incr = increment ? step : -step;
    /* MSVC never passes step <= 0; give this thread an empty range, as Wine's vcomp does, rather than call libomp. */
    if (step <= 0) { *begin = 0; *end = increment ? -1 : 1; return; }
    __kmpc_for_static_init_8(&loc, __kmpc_global_thread_num(&loc), 34 /* kmp_sch_static */, &lastiter, &lo, &hi, &stride, incr, 1);
    *begin = lo; *end = hi;
}

__declspec(dllexport) void _vcomp_for_static_end(void) {
    __kmpc_for_static_fini(&loc, __kmpc_global_thread_num(&loc));
}
