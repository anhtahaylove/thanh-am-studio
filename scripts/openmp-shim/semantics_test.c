/* ABI check for the vcomp shim. Built with cl /openmp so MSVC emits the same five _vcomp_* calls torch_cpu.dll
 * makes, then linked against the shim instead of vcomp.lib. setup-runtime.ps1 runs it and compares stdout with
 * semantics_expected.txt, which is this program's output when linked against Microsoft's vcomp140.dll (Intel's
 * libiomp5md.dll printed the same). To regenerate it, link the object without /NODEFAULTLIB:vcomp.lib and run it
 * next to vcomp140.dll. Covers int64 loops (bounds, steps, empty and one-iteration), num_threads, if(0), barrier,
 * nesting and by-value double/int captures. */
#include <omp.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>

/* cl /openmp references this symbol so objects link only against an OpenMP library; the shim does not export it. */
void _You_must_link_with_Microsoft_OpenMP_library(void) {}

#define N 100003
static long long hits[N];

static unsigned long long fnv(const long long *a, long long n) {
    unsigned long long h = 1469598103934665603ULL;
    for (long long i = 0; i < n; i++) { h ^= (unsigned long long)a[i]; h *= 1099511628211ULL; }
    return h;
}

static void loop_case(long long lo, long long hi, long long step, int nt) {
    long long i;
    memset(hits, 0, sizeof hits);
    if (step > 0) {
#pragma omp parallel for schedule(static) num_threads(nt)
        for (i = lo; i < hi; i += step) hits[i] += 1 + omp_get_thread_num() * 0;
    } else {
#pragma omp parallel for schedule(static) num_threads(nt)
        for (i = lo; i > hi; i += step) hits[i] += 1;
    }
    long long total = 0;
    for (i = 0; i < N; i++) total += hits[i];
    printf("loop lo=%lld hi=%lld step=%lld nt=%d total=%lld hash=%llx\n", lo, hi, step, nt, total, fnv(hits, N));
}

int main(void) {
    long long cases[][3] = {{0, N, 1}, {0, N, 7}, {5, 6, 1}, {0, 0, 1}, {0, 3, 1}, {N - 1, -1, -1}, {N - 1, 10, -13}, {3, 2, -1}};
    int nts[] = {1, 2, 3, 8, 16};
    for (int c = 0; c < 8; c++)
        for (int t = 0; t < 5; t++) loop_case(cases[c][0], cases[c][1], cases[c][2], nts[t]);

    /* team size, ids, barrier phases */
    int seen[64] = {0}, team = 0, phase_ok = 1, counter = 0;
#pragma omp parallel num_threads(6)
    {
        int id = omp_get_thread_num();

        InterlockedIncrement((volatile LONG *)&counter);
#pragma omp barrier
        if (counter != omp_get_num_threads()) phase_ok = 0;
        seen[id] = 1;
        if (id == 0) team = omp_get_num_threads();
    }
    int ids = 0;
    for (int i = 0; i < 64; i++) ids += seen[i];
    printf("team=%d ids=%d barrier_ok=%d\n", team, ids, phase_ok);

    /* if(0) serializes: one thread, id 0 */
    int cond = 0, t_if = -1, id_if = -1;
#pragma omp parallel if(cond) num_threads(4)
    { t_if = omp_get_num_threads(); id_if = omp_get_thread_num(); }
    printf("if0 team=%d id=%d\n", t_if, id_if);

    /* by-value captures of double and int (firstprivate), many arguments */
    double scale = 1.5, offset = -0.25; int k = 3; long long acc[8] = {0};
    double a = 1, b = 2, c = 3, d = 4, e = 5, f = 6;
#pragma omp parallel num_threads(8) firstprivate(scale, offset, k, a, b, c, d, e, f)
    {
        int id = omp_get_thread_num();
        acc[id] = (long long)((id * scale + offset) * 1000) + k + (long long)(a + b + c + d + e + f);
    }
    printf("firstprivate acc=%lld,%lld,%lld,%lld,%lld,%lld,%lld,%lld\n", acc[0], acc[1], acc[2], acc[3], acc[4], acc[5], acc[6], acc[7]);

    /* nested: inner region inside an outer team */
    int inner_sizes[4] = {0}, inner_ids_ok = 1;
    omp_set_nested(1);
#pragma omp parallel num_threads(4)
    {
        int o = omp_get_thread_num();
#pragma omp parallel num_threads(2)
        {
            if (omp_get_thread_num() >= omp_get_num_threads()) inner_ids_ok = 0;
            if (omp_get_thread_num() == 0) inner_sizes[o] = omp_get_num_threads();
        }
    }
    printf("nested inner=%d,%d,%d,%d ids_ok=%d\n", inner_sizes[0], inner_sizes[1], inner_sizes[2], inner_sizes[3], inner_ids_ok);
    return 0;
}
