/* ABI check for the vcomp shim. Built with cl /openmp so MSVC emits the same five _vcomp_* calls torch_cpu.dll
 * makes, then linked against the shim instead of vcomp.lib. setup-runtime.ps1 runs it and compares stdout with
 * semantics_expected.txt, which is this program's output when linked against Microsoft's vcomp140.dll (Intel's
 * libiomp5md.dll printed the same). To regenerate it, link the object without /NODEFAULTLIB:vcomp.lib and run it
 * next to vcomp140.dll. Covers int64 loops (bounds, steps, empty and one-iteration; each index counted atomically,
 * so an index run twice shows), num_threads (and that it applies to the next region only, also after if(0)), if(0),
 * barrier, nesting, by-value double/int captures, lastprivate with fewer iterations than threads, descending and
 * on the loop variable, orphaned omp for from serial code and inside a region, and which thread runs each iteration. */
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
        for (i = lo; i < hi; i += step) InterlockedIncrement64(&hits[i]);
    } else {
#pragma omp parallel for schedule(static) num_threads(nt)
        for (i = lo; i > hi; i += step) InterlockedIncrement64(&hits[i]);
    }
    long long total = 0;
    for (i = 0; i < N; i++) total += hits[i];
    printf("loop lo=%lld hi=%lld step=%lld nt=%d total=%lld hash=%llx\n", lo, hi, step, nt, total, fnv(hits, N));
}

static void orphan_for(long long n, long long *out) {
    long long i;
#pragma omp for schedule(static)
    for (i = 0; i < n; i++) out[i] = omp_get_thread_num() + 1;
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

    /* lastprivate: trip count below the team size, descending, stride 3, and on the int64 loop variable */
    long long i, lp = -7, lp2 = -7, lp3 = -7, lpi = -7;
#pragma omp parallel for schedule(static) num_threads(8) lastprivate(lp)
    for (i = 0; i < 3; i++) lp = i * 10 + 1;
#pragma omp parallel for schedule(static) num_threads(8) lastprivate(lp2)
    for (i = 2; i > -1; i--) lp2 = i * 10 + 1;
#pragma omp parallel for schedule(static) num_threads(4) lastprivate(lp3)
    for (i = 0; i < 11; i += 3) lp3 = i;
#pragma omp parallel for schedule(static) num_threads(8) lastprivate(i)
    for (i = 0; i < 3; i++) lpi = i;
    printf("lastprivate small=%lld descending=%lld step3=%lld loop_var=%lld\n", lp, lp2, lp3, i);

    /* num_threads applies to the next region only, and an if(0) region does not leave it set */
    int max = omp_get_max_threads(), t1 = 0, t2 = 0, t3 = 0;
#pragma omp parallel num_threads(3)
    { if (omp_get_thread_num() == 0) t1 = omp_get_num_threads(); }
#pragma omp parallel
    { if (omp_get_thread_num() == 0) t2 = omp_get_num_threads(); }
#pragma omp parallel if(cond) num_threads(3)
    { }
#pragma omp parallel
    { if (omp_get_thread_num() == 0) t3 = omp_get_num_threads(); }
    printf("num_threads(3)=%d next_is_max=%d after_if0_is_max=%d\n", t1, t2 == max, t3 == max);

    /* orphaned omp for, from serial code and inside a region */
    long long out[5] = {0}, out2[7] = {0};
    orphan_for(5, out);
#pragma omp parallel num_threads(3)
    orphan_for(7, out2);
    printf("orphan serial: %lld %lld %lld %lld %lld\n", out[0], out[1], out[2], out[3], out[4]);
    printf("orphan in region: %lld %lld %lld %lld %lld %lld %lld\n", out2[0], out2[1], out2[2], out2[3], out2[4], out2[5], out2[6]);

    /* which thread runs each iteration of a static loop */
    long long owner[10];
#pragma omp parallel for schedule(static) num_threads(4)
    for (i = 0; i < 10; i++) owner[i] = omp_get_thread_num();
    printf("owners:");
    for (i = 0; i < 10; i++) printf(" %lld", owner[i]);
    printf("\n");
    return 0;
}
