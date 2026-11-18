# Third-party sources used by the S5 spike (all pinned, none downloaded by the build)

| Item | Pin | SHA-256 of the archive | Licence | Used for |
|---|---|---|---|---|
| csukuangfj/kaldi-native-fbank | tag v1.23.0, commit 018d7bc92c3d4ac1a44c8c0e5c7d5c8e489ca509 | 58ca5ce20c8687ba5ac24137ed7aec93b6e338ec1545216f1766dea46fd2ad0f | Apache-2.0 | Kaldi fbank of the speaker encoder (the Python wheel is 1.23.0) |
| mborgerding/kissfft | febd4caeed32e33ad8b2e0bb5ea77542c40f18ec (the commit knf's cmake pins) | 497103e664168ebe39580b757adbe616f6cf85a16572af581ca7bc42d0ab13fd | BSD-3-Clause | FFT inside knf |
| dofuuz/soxr | a66f3eeeeb62a32403ff143b756eed92b1ec6b62 (python-soxr v1.1.0's submodule; `libsoxr 0.1.3-14-ga66f3ee`) | d72cf79f82b4bc56d853c8e166bef994f0bbf9a1ca90ae6f81a3847081f48b96 | LGPL-2.1 | `soxr.dll` (fallback resampler), built as a DLL, never linked statically |

Archives are fetched from `https://github.com/<owner>/<repo>/archive/<commit>` and unpacked under
`work/rm/s5-clone/third_party/`. `soxr.dll` is built with `cmake -G "Visual Studio 17 2022" -A x64 -DBUILD_SHARED_LIBS=ON
-DBUILD_TESTS=OFF -DWITH_OPENMP=OFF -DWITH_LSR_BINDINGS=OFF` (python-soxr's options except static linking), Release.
