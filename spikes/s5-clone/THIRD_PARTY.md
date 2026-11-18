# Third-party sources used by the S5 spike (all pinned, none downloaded by the build)

| Item | Pin | SHA-256 of the archive | Licence | Used for |
|---|---|---|---|---|
| csukuangfj/kaldi-native-fbank | tag v1.23.0, commit 018d7bc92c3d4ac1a44c8c0e5c7d5c8e489ca509 | 58ca5ce20c8687ba5ac24137ed7aec93b6e338ec1545216f1766dea46fd2ad0f | Apache-2.0 | Kaldi fbank of the speaker encoder (the Python wheel is 1.23.0) |
| mborgerding/kissfft | febd4caeed32e33ad8b2e0bb5ea77542c40f18ec (the commit knf's cmake pins) | 497103e664168ebe39580b757adbe616f6cf85a16572af581ca7bc42d0ab13fd | BSD-3-Clause | FFT inside knf |
| dofuuz/soxr | a66f3eeeeb62a32403ff143b756eed92b1ec6b62 (python-soxr v1.1.0's submodule; `libsoxr 0.1.3-14-ga66f3ee`) | d72cf79f82b4bc56d853c8e166bef994f0bbf9a1ca90ae6f81a3847081f48b96 | LGPL-2.1 | `soxr.dll` (fallback resampler), built as a DLL, never linked statically |
| numpy 2.4.6 sdist (`numpy/fft/pocketfft/pocketfft_hdronly.h`, `numpy/fft/_pocketfft_umath.cpp`) | PyPI `numpy-2.4.6.tar.gz` (https://files.pythonhosted.org/packages/d0/ad/fed0499ce6a338d2a03ebae59cd15093910c8875328855781952abf6c2fe/numpy-2.4.6.tar.gz); the vendored pocketfft is the git submodule mreineck/pocketfft commit 33ae5dc94c9cdc7f1c78346504a85de87cadaa12 (gitlink at numpy tag v2.4.6); header SHA-256 50f4ddbe60432325f560c706b6f1c49f9e0949fc7f20ae6499f2299e37d9790c, `_pocketfft_umath.cpp` SHA-256 424f47e975d8ebb28173ddc37f4a90dd647355b9fb7f8f4ea10eec22984990a2 | f3a3570c4a2a16746ac2c31a7c7c7b0c186b95ce902e33db6f28094ed7387dda (equals the digest PyPI lists) | BSD-3-Clause (pocketfft), numpy BSD-3-Clause | the denoiser's forward real FFT and inverse real FFT, bitwise equal to numpy 2.4.6 (the reference runtime) |

Archives are fetched from `https://github.com/<owner>/<repo>/archive/<commit>` and unpacked under
`work/rm/s5-clone/third_party/`. `soxr.dll` is built with `cmake -G "Visual Studio 17 2022" -A x64 -DBUILD_SHARED_LIBS=ON
-DBUILD_TESTS=OFF -DWITH_OPENMP=OFF -DWITH_LSR_BINDINGS=OFF` (python-soxr's options except static linking), Release.

The numpy sdist is unpacked (only `numpy/fft`, `numpy/meson.build` and the files read for the S5b analysis) under `work/rm/s5-clone/third_party/numpy-sdist/src/`; `build.rs` compiles `native/pocketfft_shim.cc` against that header with MSVC C++17 /O2 and no `/arch`, like numpy's own build (MSVC has no GCC vector types, so pocketfft takes its scalar path, as in the wheel).
